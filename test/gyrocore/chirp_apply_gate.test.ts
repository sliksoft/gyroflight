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
 * WU2: the Apply Gains hard gate lives in the Apply action itself
 * (useAutotune().applyGains), not only in the disabled button. Every call here
 * goes straight to the action, as a bypass of the UI would. MSP is mocked: no
 * test talks to a flight controller, and a blocked call must not even read.
 */

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const msp = vi.hoisted(() => ({ calls: [] as number[], liveMode: 2 }));
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
        promise: vi.fn(async (code: number) => {
            msp.calls.push(code);
            const { default: FC } = await import("../../src/js/fc");
            const { default: MSPCodes } = await import("../../src/js/msp/MSPCodes");
            if (code === MSPCodes.MSP_SIMPLIFIED_TUNING) {
                FC.TUNING_SLIDERS.slider_pids_mode = msp.liveMode;
            }
            return null;
        }),
    },
}));

vi.mock("../../src/composables/useTuningSliders", () => ({
    validateTuningSliders: vi.fn(async () => {
        const { default: FC } = await import("../../src/js/fc");
        FC.TUNING_SLIDERS.slider_pids_valid = 1;
        FC.TUNING_SLIDERS.slider_dterm_valid = 1;
    }),
}));

import FC from "../../src/js/fc";
import MSPCodes from "../../src/js/msp/MSPCodes";
import { useAutotune } from "../../src/composables/useAutotune";
import { ApplyBlockedError } from "../../src/gyrocore/chirp/applyGate";
import { useChirpQualificationStore } from "../../src/gyrocore/stores/chirpQualification";
import { encodeChirpLog, FULL_TUNE_HEADERS, simulateChirp, withHeader } from "./harness/chirpSim";
import { readFixtureBytes } from "./harness/fixtures";

const WRITES = new Set([MSPCodes.MSP_SET_SIMPLIFIED_TUNING, MSPCodes.MSP_EEPROM_WRITE]);

async function load(bytes: Uint8Array) {
    picked.bytes = bytes;
    await useAutotune().importAndAnalyze();
    const gate = useChirpQualificationStore();
    const m = gate.report!.measurements[0];
    return { gate, m, proposed: m.recommendation?.result.proposed ?? null };
}

async function expectBlocked(promise: Promise<unknown>, reason: string) {
    const err = await promise.then(
        () => null,
        (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApplyBlockedError);
    expect((err as ApplyBlockedError).reasons).toContain(reason);
}

const usableLog = () => encodeChirpLog(simulateChirp({ crossoverHz: 40, delaySamples: 2 }));

beforeEach(() => {
    setActivePinia(createPinia());
    msp.calls = [];
    msp.liveMode = 2;
});

describe("Apply Gains hard gate (action handler)", () => {
    it("control: a qualified measurement with its own sliders reaches the (mocked) flight controller", async () => {
        const { m, proposed } = await load(usableLog());
        expect(m.state).toBe("usable");
        expect(m.apply).toEqual({ allowed: true, blocked: [], warnings: [] });
        await useAutotune().applyGains(proposed!, m.id);
        expect(msp.calls).toEqual([
            MSPCodes.MSP_SIMPLIFIED_TUNING,
            MSPCodes.MSP_SET_SIMPLIFIED_TUNING,
            MSPCodes.MSP_EEPROM_WRITE,
        ]);
        expect(FC.TUNING_SLIDERS.slider_pi_gain).toBe(proposed!.slider_pi_gain);
    });

    it("blocks a rejected measurement even when called directly with its diagnostics' sliders", async () => {
        const { m } = await load(readFixtureBytes("chirp/bbl/poor_coherence.bbl.gz"));
        expect(m.state).toBe("rejected");
        const fake = {
            slider_master_multiplier: 100,
            slider_pi_gain: 120,
            slider_i_gain: 100,
            slider_d_gain: 100,
            slider_feedforward_gain: 100,
            slider_dterm_filter_multiplier: 100,
        };
        await expectBlocked(useAutotune().applyGains(fake, m.id), "measurement:low_coherence");
        expect(msp.calls).toEqual([]);
    });

    it("blocks a call without a measurement id (the pre-WU2 signature)", async () => {
        const { proposed } = await load(usableLog());
        await expectBlocked(useAutotune().applyGains(proposed!), "apply:unknown_measurement");
        expect(msp.calls).toEqual([]);
    });

    it("blocks sliders that differ from the qualified recommendation", async () => {
        const { m, proposed } = await load(usableLog());
        const tampered = { ...proposed!, slider_pi_gain: proposed!.slider_pi_gain + 1 };
        await expectBlocked(
            useAutotune().applyGains(tampered, m.id),
            "apply:sliders_differ_from_qualified_recommendation",
        );
        expect(msp.calls).toEqual([]);
    });

    it("blocks with no analysis loaded", async () => {
        const { proposed } = await load(usableLog());
        useChirpQualificationStore().reset();
        await expectBlocked(useAutotune().applyGains(proposed!, "log1-seg1"), "apply:no_qualified_analysis");
        expect(msp.calls).toEqual([]);
    });

    it("simplified PID mode OFF in the log blocks Apply", async () => {
        const { m, proposed } = await load(
            encodeChirpLog(simulateChirp(), withHeader(FULL_TUNE_HEADERS, "simplified_pids_mode:0")),
        );
        expect(m.state).toBe("usable");
        expect(m.recommendation).not.toBeNull();
        expect(m.apply.blocked).toEqual(["simplified_pids_mode_off"]);
        await expectBlocked(useAutotune().applyGains(proposed!, m.id), "simplified_pids_mode_off");
        expect(msp.calls).toEqual([]);
    });

    it("simplified PID mode OFF on the connected craft blocks before any write", async () => {
        const { m, proposed } = await load(usableLog());
        msp.liveMode = 0;
        await expectBlocked(useAutotune().applyGains(proposed!, m.id), "fc:simplified_pids_mode_off");
        expect(msp.calls).toEqual([MSPCodes.MSP_SIMPLIFIED_TUNING]);
        expect(msp.calls.some((c) => WRITES.has(c))).toBe(false);
    });

    it("yaw is blocked when the craft's sliders cover roll and pitch only", async () => {
        const { m, proposed } = await load(encodeChirpLog(simulateChirp({ axis: 2 })));
        expect(m.axisName).toBe("yaw");
        msp.liveMode = 1;
        await expectBlocked(useAutotune().applyGains(proposed!, m.id), "fc:yaw_not_under_slider_control");
        expect(msp.calls.some((c) => WRITES.has(c))).toBe(false);
    });

    it("a feed-forward cut that the slider floor turns into an increase blocks Apply", async () => {
        // The loop needs less gain (x0.5); FF 15 x 0.5 = 7.5 is floored to 25 by buildProposedSliders.
        const { m, proposed } = await load(
            encodeChirpLog(
                simulateChirp({ crossoverHz: 60, delaySamples: 3 }),
                withHeader(FULL_TUNE_HEADERS, "simplified_feedforward_gain:15"),
            ),
        );
        expect(m.state).toBe("usable");
        expect(proposed!.slider_feedforward_gain).toBe(25);
        const ff = m.recommendation!.guard.sliders.find((s) => s.slider === "slider_feedforward_gain")!;
        expect(ff).toMatchObject({
            current: 15,
            requestedDirection: "decrease",
            proposed: 25,
            proposedDirection: "increase",
            directionChanged: true,
            clampedBySliderLimit: true,
            reason: "slider_clamp_changes_direction:slider_feedforward_gain",
        });
        expect(ff.requested).toBeCloseTo(7.5, 6);
        expect(m.apply.blocked).toEqual(["slider_clamp_changes_direction:slider_feedforward_gain"]);
        await expectBlocked(
            useAutotune().applyGains(proposed!, m.id),
            "slider_clamp_changes_direction:slider_feedforward_gain",
        );
        expect(msp.calls).toEqual([]);
    });

    it("every block reason from the WU1 list is enforced by the handler", async () => {
        const cases: [Uint8Array, string][] = [
            [readFixtureBytes("chirp/bbl/dropped_timestamps.bbl.gz"), "measurement:excessive_gaps"],
            [readFixtureBytes("chirp/bbl/poor_coherence.bbl.gz"), "measurement:low_coherence"],
            [readFixtureBytes("chirp/bbl/weak_excitation.bbl.gz"), "measurement:insufficient_excitation"],
            [readFixtureBytes("chirp/bbl/poor_coherence.bbl.gz"), "measurement:unusable_frequency_range"],
            [readFixtureBytes("chirp/bbl/pnum_pdenom.bbl.gz"), "sample_rate_contract:mismatch"],
            [
                readFixtureBytes("chirp/bbl/malformed_missing_rate_headers.bbl.gz"),
                "sample_rate_contract:timestamp_only",
            ],
            [readFixtureBytes("chirp/bbl/clean_single_axis.bbl.gz"), "current_tune_missing:pi_gain"],
            [readFixtureBytes("chirp/bbl/noisy.bbl.gz"), "autotune_sensitivity_bound_unreachable"],
        ];
        for (const [bytes, reason] of cases) {
            setActivePinia(createPinia());
            const { m, proposed } = await load(bytes);
            expect(m.apply.blocked, reason).toContain(reason);
            const sliders = proposed ?? {
                slider_master_multiplier: 100,
                slider_pi_gain: 100,
                slider_i_gain: 100,
                slider_d_gain: 100,
                slider_feedforward_gain: 100,
                slider_dterm_filter_multiplier: 100,
            };
            await expectBlocked(useAutotune().applyGains(sliders, m.id), reason);
        }
        expect(msp.calls).toEqual([]);
    });
});
