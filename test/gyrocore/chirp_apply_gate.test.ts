/*
 * This file is part of Gyroflight, a derivative of the Betaflight App.
 *
 * Gyroflight is free software. You can redistribute this software
 * and/or modify this software under the terms of the GNU General
 * Public License as published by the Free Software Foundation,
 * either version 3 of the License, or (at your option) any later
 * version.
 *
 * Gyroflight is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 *
 * See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public
 * License along with this software.
 *
 * If not, see <http://www.gnu.org/licenses/>.
 */

/*
 * Apply Gains hard gate v2 (WU3, extending WU2): Apply writes one validated
 * COMPOSITE (global) recommendation, never a single axis's, and the gate lives
 * in the Apply action itself (useAutotune().applyGains), not only in the
 * button. Every call here goes straight to the action, as a bypass of the UI
 * would. MSP is mocked: no test talks to a flight controller, and a blocked
 * call must not even read, except the live-state checks, which read once and
 * must then not write. A missing, refused or failed live read must never write.
 */

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const LOGGED_LIVE = {
    slider_pids_mode: 2,
    slider_master_multiplier: 100,
    slider_roll_pitch_ratio: 100,
    slider_i_gain: 100,
    slider_d_gain: 100,
    slider_pi_gain: 100,
    slider_dmax_gain: 100,
    slider_feedforward_gain: 100,
    slider_pitch_pi_gain: 100,
    slider_dterm_filter: 1,
    slider_dterm_filter_multiplier: 100,
    slider_gyro_filter: 1,
    slider_gyro_filter_multiplier: 100,
};
const LIVE_FILTERS = {
    dterm_lowpass_hz: 75,
    dterm_lowpass2_hz: 150,
    dterm_lowpass_dyn_min_hz: 75,
    dterm_lowpass_dyn_max_hz: 150,
    gyro_lowpass_hz: 250,
    gyro_lowpass2_hz: 500,
    gyro_lowpass_dyn_min_hz: 250,
    gyro_lowpass_dyn_max_hz: 500,
};

const msp = vi.hoisted(() => ({
    calls: [] as { code: number; data: number[] | undefined }[],
    live: {} as Record<string, number>,
    // How the craft answers MSP_SIMPLIFIED_TUNING.
    readback: "ok" as "ok" | "none" | "crc" | "unsupported" | "timeout",
}));
const picked = vi.hoisted(() => ({ bytes: new Uint8Array() as Uint8Array }));

vi.mock("../../src/js/FileSystem", () => ({
    default: {
        pickOpenFile: async () => ({ name: "apply.bbl" }),
        readFileAsBlob: async () => ({ arrayBuffer: async () => picked.bytes.slice().buffer }),
    },
}));

vi.mock("../../src/js/localization", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/js/localization")>()),
    i18n: { getMessage: (key: string) => key },
}));

vi.mock("../../src/js/msp", () => ({
    default: {
        promise: vi.fn(async (code: number, data?: number[]) => {
            msp.calls.push({ code, data: data ? Array.from(data) : undefined });
            const { useFlightControllerStore } = await import("../../src/stores/fc");
            const { default: MSPCodes } = await import("../../src/js/msp/MSPCodes");
            if (code === MSPCodes.MSP_SIMPLIFIED_TUNING) {
                if (msp.readback === "timeout") {
                    throw new Error("MSP timeout");
                }
                if (msp.readback === "none") {
                    return undefined;
                }
                const reply = { command: code, crcError: msp.readback === "crc", unsupported: 0 };
                if (msp.readback === "unsupported") {
                    return { ...reply, unsupported: 1 };
                }
                if (!reply.crcError) {
                    // What MSPHelper's read handler fills in from the craft.
                    Object.assign(useFlightControllerStore().tuningSliders, msp.live);
                }
                return reply;
            }
            return null;
        }),
    },
}));

// Test-only release of the product Apply lock, so the write path behind it can be
// tested with mocked MSP. product_apply_lock.test.ts tests the lock itself.
vi.mock("@/gyrocore/productLock/productApply", async () =>
    (await import("./harness/productRelease")).releasedProductApply(),
);
// Test-only release of GyroCore Safety (WU4: it blocks every tune without analysis evidence), so the
// composite gate, live recheck and payload behind it stay tested. safety_pipeline.test.ts tests Safety.
vi.mock("@/gyrocore/safety/authorize", async () => (await import("./harness/safetyRelease")).releasedSafety());

vi.mock("../../src/composables/useTuningSliders", () => ({
    validateTuningSliders: vi.fn(async () => {
        const { useFlightControllerStore } = await import("../../src/stores/fc");
        useFlightControllerStore().tuningSliders.slider_pids_valid = 1;
        useFlightControllerStore().tuningSliders.slider_dterm_valid = 1;
    }),
}));

import { useFlightControllerStore } from "../../src/stores/fc";
import MSPCodes from "../../src/js/msp/MSPCodes";
import { useAutotune } from "../../src/composables/useAutotune";
import { PHASE_MARGIN_PRESETS } from "../../src/js/blackbox/spectral_analysis";
import { ApplyBlockedError } from "../../src/gyrocore/chirp/applyGate";
import { useChirpQualificationStore } from "../../src/gyrocore/stores/chirpQualification";
import { encodeChirpLog, FULL_TUNE_HEADERS, simulateChirpSequence, withHeader } from "./harness/chirpSim";
import { MERGE_E2E_CASES } from "./harness/mergeE2eCases";
import { readFixtureBytes } from "./harness/fixtures";
import { clearPhaseMarginForGate } from "./harness/clearPhaseMarginBlock";

const WRITES = new Set([MSPCodes.MSP_SET_SIMPLIFIED_TUNING, MSPCodes.MSP_EEPROM_WRITE]);
const GOOD = { crossoverHz: 40, delaySamples: 2, seconds: 8 };
const UNSTABLE = { crossoverHz: 80, delaySamples: 4, seconds: 8 };

async function load(bytes: Uint8Array) {
    picked.bytes = bytes;
    await useAutotune().importAndAnalyze();
    const gate = useChirpQualificationStore();
    return { gate, composite: gate.composite! };
}

async function expectBlocked(promise: Promise<unknown>, ...reasons: string[]) {
    const err = await promise.then(
        () => null,
        (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApplyBlockedError);
    for (const reason of reasons) {
        expect((err as ApplyBlockedError).reasons).toContain(reason);
    }
}

const codes = () => msp.calls.map((c) => c.code);
const noWrites = () => expect(codes().some((c) => WRITES.has(c))).toBe(false);

/** MSP_SET_SIMPLIFIED_TUNING payload, written out field by field (MSPHelper write*SliderSettings). */
function expectedPayload(s: Record<string, number>, f: Record<string, number>) {
    const u16 = (v: number) => [v & 0xff, v >> 8];
    const zeros = (n: number) => Array(n).fill(0);
    return [
        s.slider_pids_mode,
        s.slider_master_multiplier,
        s.slider_roll_pitch_ratio,
        s.slider_i_gain,
        s.slider_d_gain,
        s.slider_pi_gain,
        s.slider_dmax_gain,
        s.slider_feedforward_gain,
        s.slider_pitch_pi_gain,
        ...zeros(8),
        s.slider_dterm_filter,
        s.slider_dterm_filter_multiplier,
        ...u16(f.dterm_lowpass_hz),
        ...u16(f.dterm_lowpass2_hz),
        ...u16(f.dterm_lowpass_dyn_min_hz),
        ...u16(f.dterm_lowpass_dyn_max_hz),
        ...zeros(8),
        s.slider_gyro_filter,
        s.slider_gyro_filter_multiplier,
        ...u16(f.gyro_lowpass_hz),
        ...u16(f.gyro_lowpass2_hz),
        ...u16(f.gyro_lowpass_dyn_min_hz),
        ...u16(f.gyro_lowpass_dyn_max_hz),
        ...zeros(8),
    ];
}

beforeEach(() => {
    setActivePinia(createPinia());
    msp.calls = [];
    msp.live = { ...LOGGED_LIVE };
    msp.readback = "ok";
    Object.assign(useFlightControllerStore().filterConfig, LIVE_FILTERS);
});

describe("safe positive fixture: three agreeing axes -> one global tune -> exact payload", () => {
    // GF-1: open-loop L = T/(1-T) is unvalidated; proposals are held at current
    // and phase_margin_not_validated blocks Apply (even for a no-op write).
    const EXPECTED_FINAL = {
        slider_master_multiplier: 100,
        slider_pi_gain: 100,
        slider_i_gain: 100,
        slider_d_gain: 100,
        slider_feedforward_gain: 100,
        slider_dterm_filter_multiplier: 100,
    };

    it("merges held sliders but does not authorize Apply (phase margin not validated)", async () => {
        const { gate, composite } = await load(MERGE_E2E_CASES.three_axis_agree());
        expect(gate.report!.measurements.map((m) => [m.axisName, m.state, m.apply.allowed])).toEqual([
            ["roll", "usable", false],
            ["pitch", "usable", false],
            ["yaw", "usable", false],
        ]);
        expect(composite.merge.status).toBe("merged");
        expect(composite.merge.participating_axes).toEqual(["roll", "pitch", "yaw"]);
        expect(composite.sources.map((s) => [s.measurementId, s.role])).toEqual([
            ["log1-seg1", "participating"],
            ["log1-seg2", "participating"],
            ["log1-seg3", "participating"],
        ]);
        expect(composite.blocked).toContain("phase_margin_not_validated");
        expect(composite.authorized).toBe(false);
        expect(composite.final).toEqual(EXPECTED_FINAL);

        await expectBlocked(useAutotune().applyGains(composite.final!, composite.id), "phase_margin_not_validated");
        noWrites();
        expect(msp.calls).toEqual([]);
    });

    it("roll+pitch under RP mode: merge excludes yaw; Apply still blocked by phase margin", async () => {
        msp.live = { ...LOGGED_LIVE, slider_pids_mode: 1 };
        const { composite } = await load(MERGE_E2E_CASES.rp_mode_yaw_excluded());
        expect(composite.merge.participating_axes).toEqual(["roll", "pitch"]);
        expect(composite.sources.find((s) => s.axisName === "yaw")?.role).toBe("excluded_by_axis_gate");
        expect(composite.warnings).toContain("axis_excluded:yaw:yaw_not_under_slider_control");
        expect(composite.authorized).toBe(false);
        expect(composite.blocked).toContain("phase_margin_not_validated");
        await expectBlocked(useAutotune().applyGains(composite.final!, composite.id), "phase_margin_not_validated");
        noWrites();
    });
});

describe("Apply hard gate v2 rejects (no MSP write)", () => {
    it("the old single-measurement apply", async () => {
        const { gate } = await load(MERGE_E2E_CASES.three_axis_agree());
        const m = gate.report!.measurements[0];
        expect(m.apply.allowed).toBe(false);
        expect(m.apply.blocked).toContain("phase_margin_not_validated");
        await expectBlocked(
            useAutotune().applyGains(m.recommendation!.result.proposed, m.id),
            "apply:single_measurement_apply_not_allowed",
        );
        expect(msp.calls).toEqual([]);
    });

    it("a missing composite id", async () => {
        const { composite } = await load(MERGE_E2E_CASES.three_axis_agree());
        await expectBlocked(useAutotune().applyGains(composite.final!), "apply:missing_composite_id");
        expect(msp.calls).toEqual([]);
    });

    it("a stale composite (new target, new analysis)", async () => {
        const { composite } = await load(MERGE_E2E_CASES.three_axis_agree());
        useAutotune().recomputeGains(PHASE_MARGIN_PRESETS.CONSERVATIVE);
        await expectBlocked(useAutotune().applyGains(composite.final!, composite.id), "apply:stale_composite");
        const again = await load(MERGE_E2E_CASES.three_axis_agree());
        expect(again.composite.id).not.toBe(composite.id);
        await expectBlocked(useAutotune().applyGains(composite.final!, composite.id), "apply:stale_composite");
        expect(msp.calls).toEqual([]);
    });

    it("a changed source recommendation", async () => {
        const { gate, composite } = await load(MERGE_E2E_CASES.three_axis_agree());
        const rec = gate.report!.measurements[1].recommendation!;
        rec.result.proposed.slider_i_gain += 1;
        gate.touch();
        await expectBlocked(useAutotune().applyGains(composite.final!, composite.id), "apply:stale_composite");
        expect(msp.calls).toEqual([]);
    });

    it("tampered merged sliders", async () => {
        const { gate } = await load(MERGE_E2E_CASES.three_axis_agree());
        clearPhaseMarginForGate(gate);
        const composite = gate.composite!;
        const tampered = { ...composite.final!, slider_pi_gain: composite.final!.slider_pi_gain + 1 };
        await expectBlocked(useAutotune().applyGains(tampered, composite.id), "apply:sliders_differ_from_composite");
        expect(msp.calls).toEqual([]);
    });

    it("a rejected source measurement (an axis whose system ID is unusable)", async () => {
        const { composite } = await load(MERGE_E2E_CASES.roll_ok_pitch_rejected());
        expect(composite.merge.status).toBe("merged");
        expect(composite.merge.participating_axes).toEqual(["roll"]);
        expect(composite.authorized).toBe(false);
        expect(composite.blocked).toEqual(
            expect.arrayContaining(["system_id_unusable", "system_id_unusable:log1-seg2", "measurement:low_coherence"]),
        );
        await expectBlocked(useAutotune().applyGains(composite.final!, composite.id), "system_id_unusable");
        expect(msp.calls).toEqual([]);
    });

    it("an unsafe merge conflict", async () => {
        // GF-1 hold collapses per-axis PI disagreement; roll+pitch under RPY
        // still lacks yaw evidence, so Apply stays blocked.
        const { composite } = await load(MERGE_E2E_CASES.roll_pitch_conflict());
        expect(composite.merge.status).toBe("merged");
        expect(composite.final).toEqual({
            slider_master_multiplier: 100,
            slider_pi_gain: 100,
            slider_i_gain: 100,
            slider_d_gain: 100,
            slider_feedforward_gain: 100,
            slider_dterm_filter_multiplier: 100,
        });
        expect(composite.blocked).toEqual(expect.arrayContaining(["missing_axis_evidence:yaw"]));
        await expectBlocked(useAutotune().applyGains(composite.final!, composite.id), "missing_axis_evidence:yaw");
        expect(msp.calls).toEqual([]);
    });

    it("simplified PID mode OFF in the log", async () => {
        const { composite } = await load(MERGE_E2E_CASES.pids_mode_off());
        expect(composite.merge.review_reasons).toEqual(["no_participating_axes"]);
        expect(composite.blocked).toEqual(
            expect.arrayContaining(["no_participating_axes", "simplified_pids_mode_off"]),
        );
        await expectBlocked(
            useAutotune().applyGains(composite.sources[0].proposed!, composite.id),
            "simplified_pids_mode_off",
        );
        expect(msp.calls).toEqual([]);
    });

    it("feed-forward cut reversed by the slider floor, re-checked on the global value", async () => {
        // GF-1 holds scales at 1, but buildProposedSliders still clamps FF to
        // [25,250]; a logged 15 becomes 25 and the direction guard blocks Apply.
        const { composite } = await load(MERGE_E2E_CASES.ff_floor_three_axis());
        expect(composite.merge.status).toBe("merged");
        expect(composite.final!.slider_feedforward_gain).toBe(25);
        const ff = composite.sliders.find((s) => s.key === "slider_feedforward_gain")!;
        expect(ff.current).toBe(15);
        expect(ff.finalDirection).toBe("increase");
        // Pre-clamp request matches the logged current; the [25,250] floor alone raises final to 25.
        expect(Object.values(ff.requestedByAxis).every((r) => r === 15)).toBe(true);
        expect(composite.blocked).toEqual(
            expect.arrayContaining([
                "slider_clamp_changes_direction:slider_feedforward_gain",
                "composite_clamp_changes_direction:slider_feedforward_gain",
            ]),
        );
        await expectBlocked(
            useAutotune().applyGains(composite.final!, composite.id),
            "composite_clamp_changes_direction:slider_feedforward_gain",
        );
        expect(msp.calls).toEqual([]);
    });

    it("feed-forward increase inflated by the slider floor beyond rounding", async () => {
        // Under GF-1 hold the only FF move is the [25,250] floor bump 15→25,
        // which the direction guard treats as a clamp that changes direction.
        const { composite } = await load(
            encodeChirpLog(
                simulateChirpSequence([
                    { ...GOOD, axis: 0 },
                    { ...GOOD, axis: 1 },
                ]),
                withHeader(FULL_TUNE_HEADERS, "simplified_feedforward_gain:15"),
            ),
        );
        expect(composite.final!.slider_feedforward_gain).toBe(25);
        expect(composite.blocked).toEqual(
            expect.arrayContaining([
                "slider_clamp_changes_direction:slider_feedforward_gain",
                "composite_clamp_changes_direction:slider_feedforward_gain",
            ]),
        );
        await expectBlocked(
            useAutotune().applyGains(composite.final!, composite.id),
            "composite_clamp_changes_direction:slider_feedforward_gain",
        );
        expect(msp.calls).toEqual([]);
    });

    it("every WU2 measurement block still reaches the handler", async () => {
        const cases: [string, string][] = [
            ["chirp/bbl/dropped_timestamps.bbl.gz", "measurement:excessive_gaps"],
            ["chirp/bbl/poor_coherence.bbl.gz", "measurement:low_coherence"],
            ["chirp/bbl/weak_excitation.bbl.gz", "measurement:insufficient_excitation"],
            ["chirp/bbl/poor_coherence.bbl.gz", "measurement:unusable_frequency_range"],
            ["chirp/bbl/pnum_pdenom.bbl.gz", "sample_rate_contract:mismatch"],
            ["chirp/bbl/malformed_missing_rate_headers.bbl.gz", "sample_rate_contract:timestamp_only"],
            ["chirp/bbl/clean_single_axis.bbl.gz", "current_tune_missing:pi_gain"],
        ];
        for (const [fixture, reason] of cases) {
            setActivePinia(createPinia());
            const { composite } = await load(readFixtureBytes(fixture));
            expect(composite.authorized, fixture).toBe(false);
            expect(composite.blocked, fixture).toContain(reason);
            const sliders = composite.sources[0].proposed ?? {
                slider_master_multiplier: 100,
                slider_pi_gain: 100,
                slider_i_gain: 100,
                slider_d_gain: 100,
                slider_feedforward_gain: 100,
                slider_dterm_filter_multiplier: 100,
            };
            await expectBlocked(useAutotune().applyGains(sliders, composite.id), reason);
        }
        expect(msp.calls).toEqual([]);
    });
});

describe("live flight-controller recheck (one read, then no write)", () => {
    const cases: [string, Record<string, number>, string][] = [
        ["slider mode OFF", { slider_pids_mode: 0 }, "fc:simplified_pids_mode_off"],
        ["slider mode changed after analysis", { slider_pids_mode: 1 }, "fc:simplified_pids_mode_changed"],
        ["yaw contributed but the craft is RP", { slider_pids_mode: 1 }, "fc:yaw_not_under_slider_control"],
        ["a current slider changed", { slider_pi_gain: 110 }, "fc:current_slider_changed:slider_pi_gain"],
        ["D-term filter slider changed", { slider_dterm_filter: 0 }, "fc:current_slider_changed:slider_dterm_filter"],
        ["D-max slider changed", { slider_dmax_gain: 90 }, "fc:current_slider_changed:slider_dmax_gain"],
        [
            "pitch D (roll/pitch ratio) changed",
            { slider_roll_pitch_ratio: 120 },
            "fc:current_slider_changed:slider_roll_pitch_ratio",
        ],
        ["pitch PI changed", { slider_pitch_pi_gain: 110 }, "fc:current_slider_changed:slider_pitch_pi_gain"],
        ["gyro filter slider changed", { slider_gyro_filter: 0 }, "fc:current_slider_changed:slider_gyro_filter"],
        [
            "gyro filter multiplier changed",
            { slider_gyro_filter_multiplier: 80 },
            "fc:current_slider_changed:slider_gyro_filter_multiplier",
        ],
    ];
    for (const [name, live, reason] of cases) {
        it(name, async () => {
            const { gate } = await load(MERGE_E2E_CASES.three_axis_agree());
            clearPhaseMarginForGate(gate);
            const composite = gate.composite!;
            expect(composite.authorized).toBe(true);
            msp.live = { ...LOGGED_LIVE, ...live };
            await expectBlocked(useAutotune().applyGains(composite.final!, composite.id), reason);
            expect(codes()).toEqual([MSPCodes.MSP_SIMPLIFIED_TUNING]);
            noWrites();
        });
    }
});

describe("live read-back that cannot be trusted never reaches a write", () => {
    // The store already holds the logged tune, so a check against stale store
    // values would pass: only a fresh, valid read-back may let Apply continue.
    // The GF-1 phase-margin hold is stripped so these cases reach the read-back.
    const cases: [string, typeof msp.readback][] = [
        ["no response (virtual mode or empty reply)", "none"],
        ["CRC error", "crc"],
        ["command refused as unsupported", "unsupported"],
    ];
    for (const [name, readback] of cases) {
        it(name, async () => {
            const { gate } = await load(MERGE_E2E_CASES.three_axis_agree());
            clearPhaseMarginForGate(gate);
            const composite = gate.composite!;
            expect(composite.authorized).toBe(true);
            Object.assign(useFlightControllerStore().tuningSliders, LOGGED_LIVE);
            msp.readback = readback;
            await expectBlocked(useAutotune().applyGains(composite.final!, composite.id), "fc:live_readback_missing");
            expect(codes()).toEqual([MSPCodes.MSP_SIMPLIFIED_TUNING]);
            noWrites();
        });
    }

    it("a failed read (timeout, cancellation) rejects without writing", async () => {
        const { gate } = await load(MERGE_E2E_CASES.three_axis_agree());
        clearPhaseMarginForGate(gate);
        const composite = gate.composite!;
        expect(composite.authorized).toBe(true);
        Object.assign(useFlightControllerStore().tuningSliders, LOGGED_LIVE);
        msp.readback = "timeout";
        await expect(useAutotune().applyGains(composite.final!, composite.id)).rejects.toThrow("MSP timeout");
        expect(codes()).toEqual([MSPCodes.MSP_SIMPLIFIED_TUNING]);
        noWrites();
    });

    it("control: the same call with a valid read-back writes", async () => {
        const { gate } = await load(MERGE_E2E_CASES.three_axis_agree());
        clearPhaseMarginForGate(gate);
        const composite = gate.composite!;
        expect(composite.authorized).toBe(true);
        await useAutotune().applyGains(composite.final!, composite.id);
        expect(codes()).toEqual([
            MSPCodes.MSP_SIMPLIFIED_TUNING,
            MSPCodes.MSP_SET_SIMPLIFIED_TUNING,
            MSPCodes.MSP_EEPROM_WRITE,
        ]);
    });
});

describe("repeated sweeps on one axis", () => {
    const repeated = () =>
        encodeChirpLog(
            simulateChirpSequence([
                { ...GOOD, axis: 0 },
                { ...GOOD, axis: 0, amplitude: 180 },
                { ...GOOD, axis: 1 },
                { ...GOOD, axis: 2 },
            ]),
        );

    it("two qualified roll sweeps need an explicit choice; the default display choice does not count", async () => {
        const { gate, composite } = await load(repeated());
        const rolls = gate.report!.measurements.filter((m) => m.axisName === "roll");
        expect(rolls).toHaveLength(2);
        expect(rolls.every((m) => m.state === "usable")).toBe(true);
        expect(rolls.every((m) => m.apply.blocked.includes("phase_margin_not_validated"))).toBe(true);
        expect(composite.authorized).toBe(false);
        expect(composite.blocked).toContain("repeated_axis_requires_selection:roll");
        // An unselected repeated axis is not covered.
        expect(composite.coverage.missingAxes).toEqual(["roll"]);
        expect(composite.blocked).toContain("missing_axis_evidence:roll");
        await expectBlocked(
            useAutotune().applyGains(composite.sources[0].proposed!, composite.id),
            "repeated_axis_requires_selection:roll",
        );

        gate.selectMeasurement("log1-seg2", true);
        clearPhaseMarginForGate(gate);
        const chosen = gate.composite!;
        expect(chosen.sources.map((s) => [s.measurementId, s.role])).toEqual([
            ["log1-seg1", "not_selected"],
            ["log1-seg2", "participating"],
            ["log1-seg3", "participating"],
            ["log1-seg4", "participating"],
        ]);
        // The selected repeat covers roll.
        expect(chosen.coverage.sourceByAxis).toEqual({ roll: "log1-seg2", pitch: "log1-seg3", yaw: "log1-seg4" });
        expect(chosen.authorized).toBe(true);
        await useAutotune().applyGains(chosen.final!, chosen.id);
        expect(codes()).toContain(MSPCodes.MSP_SET_SIMPLIFIED_TUNING);
    });

    it("one qualified and one rejected roll sweep: the qualified one is used, the rejected one reported", async () => {
        const { composite } = await load(
            encodeChirpLog(
                simulateChirpSequence([
                    { ...UNSTABLE, axis: 0 },
                    { ...GOOD, axis: 0 },
                    { ...GOOD, axis: 1 },
                    { ...GOOD, axis: 2 },
                ]),
            ),
        );
        expect(composite.sources.map((s) => [s.measurementId, s.role])).toEqual([
            ["log1-seg1", "rejected"],
            ["log1-seg2", "participating"],
            ["log1-seg3", "participating"],
            ["log1-seg4", "participating"],
        ]);
        expect(composite.coverage.sourceByAxis.roll).toBe("log1-seg2");
        expect(composite.warnings).toContain("rejected_repeat_not_used:log1-seg1");
        expect(composite.authorized).toBe(false);
        expect(composite.blocked).toContain("phase_margin_not_validated");
    });
});

describe("axis coverage: every axis the slider mode drives needs its own qualified, selected evidence", () => {
    const AXIS = { roll: 0, pitch: 1, yaw: 2 } as const;
    type Axis = keyof typeof AXIS;
    const flight = (axes: Axis[], mode: number | null) =>
        encodeChirpLog(
            simulateChirpSequence(axes.map((a) => ({ ...GOOD, axis: AXIS[a] }))),
            mode === null
                ? FULL_TUNE_HEADERS.filter((h) => !h.startsWith("simplified_pids_mode:"))
                : withHeader(FULL_TUNE_HEADERS, `simplified_pids_mode:${mode}`),
        );

    const matrix: [string, number, Axis[], Axis[]][] = [
        // [mode name, mode, axes flown, axes missing]
        ["RPY", 2, ["roll"], ["pitch", "yaw"]],
        ["RPY", 2, ["pitch"], ["roll", "yaw"]],
        ["RPY", 2, ["yaw"], ["roll", "pitch"]],
        ["RPY", 2, ["roll", "pitch"], ["yaw"]],
        ["RPY", 2, ["roll", "yaw"], ["pitch"]],
        ["RPY", 2, ["pitch", "yaw"], ["roll"]],
        ["RPY", 2, ["roll", "pitch", "yaw"], []],
        ["RP", 1, ["roll"], ["pitch"]],
        ["RP", 1, ["pitch"], ["roll"]],
        ["RP", 1, ["roll", "pitch"], []],
        ["RP", 1, ["yaw"], ["roll", "pitch"]],
        ["RP", 1, ["roll", "yaw"], ["pitch"]],
        ["RP", 1, ["roll", "pitch", "yaw"], []],
    ];
    for (const [modeName, mode, axes, missing] of matrix) {
        const verdict = missing.length ? "blocked" : "coverage pass";
        it(`${modeName} + ${axes.join("+")} -> ${verdict}`, async () => {
            msp.live = { ...LOGGED_LIVE, slider_pids_mode: mode };
            const { gate, composite } = await load(flight(axes, mode));
            const required: Axis[] = mode === 2 ? ["roll", "pitch", "yaw"] : ["roll", "pitch"];
            expect(composite.coverage.modeName).toBe(modeName);
            expect(composite.coverage.pidsMode).toBe(mode);
            expect(composite.coverage.requiredAxes).toEqual(required);
            expect(composite.coverage.missingAxes).toEqual(missing);
            expect(composite.coverage.coveredAxes).toEqual(required.filter((a) => !missing.includes(a)));
            for (const a of composite.coverage.coveredAxes) {
                const src = composite.sources.find((s) => s.measurementId === composite.coverage.sourceByAxis[a])!;
                expect([src.axisName, src.role]).toEqual([a, "participating"]);
            }
            const coverageCodes = missing.map((a) => `missing_axis_evidence:${a}`);
            expect(composite.coverage.blocked).toEqual(coverageCodes);
            expect(composite.blocked).toEqual(expect.arrayContaining(coverageCodes));
            if (mode === 1) {
                // Yaw is never RP authorization evidence; it stays out of the merge as before.
                expect(composite.coverage.sourceByAxis.yaw).toBeUndefined();
                expect(composite.merge.participating_axes).not.toContain("yaw");
            }
            if (missing.length) {
                expect(composite.authorized).toBe(false);
                // The merge itself may still resolve: merge validity is not apply authorization.
                if (axes.filter((a) => required.includes(a)).length) {
                    expect(composite.merge.status).toBe("merged");
                    expect(composite.final).not.toBeNull();
                }
                await expectBlocked(
                    useAutotune().applyGains(composite.final ?? composite.sources[0].proposed!, composite.id),
                    ...coverageCodes,
                );
                expect(msp.calls).toEqual([]);
            } else {
                // Strip GF-1 phase-margin hold so this matrix isolates axis coverage.
                clearPhaseMarginForGate(gate);
                const cleared = gate.composite!;
                expect(cleared.blocked).toEqual([]);
                expect(cleared.authorized).toBe(true);
                await useAutotune().applyGains(cleared.final!, cleared.id);
                expect(codes()).toContain(MSPCodes.MSP_SET_SIMPLIFIED_TUNING);
            }
        });
    }

    it("a rejected measurement does not cover its axis", async () => {
        const { composite } = await load(
            encodeChirpLog(
                simulateChirpSequence([
                    { ...GOOD, axis: 0 },
                    { ...UNSTABLE, axis: 1 },
                    { ...GOOD, axis: 2 },
                ]),
            ),
        );
        expect(composite.sources.find((s) => s.axisName === "pitch")?.role).toBe("rejected");
        expect(composite.coverage.missingAxes).toEqual(["pitch"]);
        expect(composite.blocked).toEqual(
            expect.arrayContaining(["missing_axis_evidence:pitch", "system_id_unusable"]),
        );
        await expectBlocked(useAutotune().applyGains(composite.final!, composite.id), "missing_axis_evidence:pitch");
        expect(msp.calls).toEqual([]);
    });

    it("OFF -> blocked", async () => {
        const { composite } = await load(flight(["roll", "pitch", "yaw"], 0));
        expect(composite.coverage.modeName).toBe("OFF");
        expect(composite.coverage.requiredAxes).toEqual([]);
        expect(composite.coverage.blocked).toEqual(["axis_coverage_mode_off"]);
        await expectBlocked(
            useAutotune().applyGains(composite.sources[0].proposed!, composite.id),
            "axis_coverage_mode_off",
        );
        expect(msp.calls).toEqual([]);
    });

    it("unknown (not logged) slider mode -> blocked", async () => {
        const { composite } = await load(flight(["roll", "pitch", "yaw"], null));
        expect(composite.coverage.modeName).toBe("UNKNOWN");
        expect(composite.coverage.pidsMode).toBeNull();
        expect(composite.coverage.blocked).toEqual(["axis_coverage_mode_unknown"]);
        await expectBlocked(
            useAutotune().applyGains(composite.sources[0].proposed!, composite.id),
            "axis_coverage_mode_unknown",
        );
        expect(msp.calls).toEqual([]);
    });

    it("a tampered composite is still blocked when coverage passes", async () => {
        const { gate, composite } = await load(flight(["roll", "pitch", "yaw"], 2));
        expect(composite.coverage.missingAxes).toEqual([]);
        clearPhaseMarginForGate(gate);
        const cleared = gate.composite!;
        const tampered = { ...cleared.final!, slider_d_gain: cleared.final!.slider_d_gain + 5 };
        await expectBlocked(useAutotune().applyGains(tampered, cleared.id), "apply:sliders_differ_from_composite");
        expect(msp.calls).toEqual([]);
    });

    it("the clamp guards still block when coverage passes", async () => {
        const { composite } = await load(MERGE_E2E_CASES.ff_floor_three_axis());
        expect(composite.coverage.missingAxes).toEqual([]);
        expect(composite.blocked).toContain("composite_clamp_changes_direction:slider_feedforward_gain");
        await expectBlocked(
            useAutotune().applyGains(composite.final!, composite.id),
            "composite_clamp_changes_direction:slider_feedforward_gain",
        );
        expect(msp.calls).toEqual([]);
    });

    it("live recheck: analysis RP (roll+pitch valid), craft now RPY -> blocked, yaw evidence missing", async () => {
        const { gate, composite } = await load(MERGE_E2E_CASES.rp_mode_yaw_excluded());
        clearPhaseMarginForGate(gate);
        const cleared = gate.composite!;
        expect(cleared.authorized).toBe(true);
        msp.live = { ...LOGGED_LIVE, slider_pids_mode: 2 };
        await expectBlocked(
            useAutotune().applyGains(cleared.final!, cleared.id),
            "fc:missing_axis_evidence:yaw",
            "fc:simplified_pids_mode_changed",
        );
        expect(codes()).toEqual([MSPCodes.MSP_SIMPLIFIED_TUNING]);
        noWrites();
    });

    it("live recheck: analysis RPY, craft now RP -> blocked by the current contract (mode changed, yaw contributed)", async () => {
        const { gate } = await load(MERGE_E2E_CASES.three_axis_agree());
        clearPhaseMarginForGate(gate);
        const cleared = gate.composite!;
        msp.live = { ...LOGGED_LIVE, slider_pids_mode: 1 };
        const err = await useAutotune()
            .applyGains(cleared.final!, cleared.id)
            .catch((e: ApplyBlockedError) => e);
        expect(err).toBeInstanceOf(ApplyBlockedError);
        // RP needs only roll+pitch, which are covered; the mode change itself still blocks.
        expect((err as ApplyBlockedError).reasons).toEqual([
            "fc:simplified_pids_mode_changed",
            "fc:yaw_not_under_slider_control",
        ]);
        expect(codes()).toEqual([MSPCodes.MSP_SIMPLIFIED_TUNING]);
        noWrites();
    });
});

describe("GF-1: phase_margin_not_validated blocks Apply even when proposals equal current", () => {
    it("held-at-current three-axis merge never authorizes and never MSP-writes", async () => {
        const { gate, composite } = await load(MERGE_E2E_CASES.three_axis_agree());
        expect(composite.final).toEqual({
            slider_master_multiplier: 100,
            slider_pi_gain: 100,
            slider_i_gain: 100,
            slider_d_gain: 100,
            slider_feedforward_gain: 100,
            slider_dterm_filter_multiplier: 100,
        });
        expect(gate.report!.measurements.every((m) => m.apply.blocked.includes("phase_margin_not_validated"))).toBe(
            true,
        );
        expect(composite.blocked).toContain("phase_margin_not_validated");
        expect(composite.authorized).toBe(false);
        await expectBlocked(useAutotune().applyGains(composite.final!, composite.id), "phase_margin_not_validated");
        expect(msp.calls).toEqual([]);
        noWrites();
    });
});
