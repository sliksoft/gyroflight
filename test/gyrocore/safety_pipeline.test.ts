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
 * WU4A: GyroCore Safety on the global recommendation.
 *
 *  - Product-path parity: the reference pipeline with no analysis evidence
 *    (run_safety_pipeline(analysis=None), require_analysis=True) against
 *    safety_product_path_reference.json, stage by stage.
 *  - The Gyroflight adaptations of absolute.py, each against the reference
 *    behaviour it replaces.
 *  - The product entry: bound to the exact composite, NOT_EVALUATED when the
 *    composite is blocked upstream, BLOCK `missing_required_analysis` otherwise.
 */

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const picked = vi.hoisted(() => ({ bytes: new Uint8Array() as Uint8Array }));

vi.mock("../../src/js/FileSystem", () => ({
    default: {
        pickOpenFile: async () => ({ name: "safety.bbl" }),
        readFileAsBlob: async () => ({ arrayBuffer: async () => picked.bytes.slice().buffer }),
    },
}));

vi.mock("../../src/js/localization", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/js/localization")>()),
    i18n: { getMessage: (key: string) => key },
}));

import { useAutotune } from "../../src/composables/useAutotune";
import { PHASE_MARGIN_PRESETS } from "../../src/js/blackbox/spectral_analysis";
import { readHeaderPairs } from "../../src/gyrocore/chirp/headers";
import { useChirpQualificationStore } from "../../src/gyrocore/stores/chirpQualification";
import { mergeAutotuneSliders, type SimplifiedSliders } from "../../src/gyrocore/tuning/merge";
import {
    GYROFLIGHT_EXTRACT,
    GYROFLIGHT_PROPOSE,
    REFERENCE_EXTRACT,
    REFERENCE_PROPOSE,
    extractAbsoluteTune,
    proposeAbsoluteTune,
    type AbsoluteTune,
    type TuneValue,
} from "../../src/gyrocore/safety/absolute";
import { runSafetyPipeline } from "../../src/gyrocore/safety/pipeline";
import {
    SAFETY_INPUT_MISSING_HEADERS,
    SAFETY_INPUT_SLIDERS_DIFFER,
    SAFETY_NOT_EVALUATED_UPSTREAM,
    evaluateSafety,
} from "../../src/gyrocore/safety/evaluate";
import { assertSafetyAuthorized, safetyForComposite } from "../../src/gyrocore/safety/authorize";
import { ApplyBlockedError } from "../../src/gyrocore/chirp/applyGate";
import { BETAFLIGHT_TUNE_HEADERS, encodeChirpLog, simulateChirpSequence, withHeader } from "./harness/chirpSim";
import { MERGE_E2E_CASES } from "./harness/mergeE2eCases";
import { readFixtureJson } from "./harness/fixtures";

// Fixture JSON from the Python generator: shape checked by the assertions themselves.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const productRef = readFixtureJson<Json>("safety/safety_product_path_reference.json");
const foundation = readFixtureJson<Json>("safety/safety_foundation_reference.json").foundation;

const AXES = ["roll", "pitch", "yaw"] as const;
const PID = ["p", "i", "d", "f", "d_max"] as const;
const FILT = ["lpf1_dyn_min_hz", "lpf1_dyn_max_hz", "lpf1_static_hz", "lpf2_static_hz"] as const;
const GOOD = { crossoverHz: 40, delaySamples: 2, seconds: 8 };
const WU3_POSITIVE = {
    slider_master_multiplier: 100,
    slider_pi_gain: 138,
    slider_i_gain: 100,
    slider_d_gain: 100,
    slider_feedforward_gain: 138,
    slider_dterm_filter_multiplier: 100,
};
const ANALYSIS_BLOCKS = ["mechanical_hard_block", "missing_required_analysis", "safe_tune_candidate_blocked"];

const pairsOf = (text: string) => readHeaderPairs(new TextEncoder().encode(text), 0, text.length);
const absCase = (id: string) => (foundation.absolute as Json[]).find((c) => c.case_id === id)!;

function injectCurrent(p: Json): AbsoluteTune {
    const full = p.current_full as Record<string, Json>;
    const tv = (k: string) => ({ ...full[k] }) as TuneValue;
    return {
        sliders: p.current_sliders as SimplifiedSliders,
        roll: Object.fromEntries(PID.map((c) => [c, tv(`roll.${c}`)])),
        pitch: Object.fromEntries(PID.map((c) => [c, tv(`pitch.${c}`)])),
        yaw: Object.fromEntries(PID.map((c) => [c, tv(`yaw.${c}`)])),
        dterm: Object.fromEntries(FILT.map((c) => [c, tv(`dterm.${c}`)])),
        gyro: Object.fromEntries(FILT.map((c) => [c, tv(`gyro.${c}`)])),
        warnings: p.current_warnings,
        sourcesUsed: ["reference"],
    } as unknown as AbsoluteTune;
}

function proposalFor(input: Json, expectedProposal: Json, mode: "reference" | "gyroflight" = "reference") {
    const current = input.headers
        ? extractAbsoluteTune(pairsOf(input.headers), mode === "reference" ? REFERENCE_EXTRACT : GYROFLIGHT_EXTRACT)
        : injectCurrent(expectedProposal);
    const axes = (input.axes as Json[]).map((a) => ({ axis: a.axis, blocked: a.blocked, proposed: a.proposed }));
    const merge = mergeAutotuneSliders(axes, current.sliders);
    return proposeAbsoluteTune(
        current,
        merge,
        { blockedReasons: [], warnings: [], withWarnings: false },
        mode === "reference" ? REFERENCE_PROPOSE : GYROFLIGHT_PROPOSE,
    );
}

const plain = (x: unknown) => JSON.parse(JSON.stringify(x));

describe("product path vs Python: run_safety_pipeline(analysis=None, require_analysis=True)", () => {
    expect(productRef.gyrocore_commit).toBe("d2e60f7");
    for (const c of productRef.product_path as Json[]) {
        it(c.case_id, () => {
            const e = c.expected;
            const r = runSafetyPipeline(proposalFor(c.input, e.proposal));
            expect(plain(r.mechanical)).toEqual(e.mechanical);
            expect(plain(r.candidate)).toEqual(e.candidate);
            const { legacy: _legacy, ...tos } = e.tuning_output_safety;
            expect(plain(r.outputSafety)).toEqual(tos);
            expect(plain(r.final)).toEqual(e.final);
            expect(r.final.status).toBe("block");
            expect(r.final.blocked_reasons).toEqual(expect.arrayContaining(ANALYSIS_BLOCKS));
        });
    }
});

describe("Gyroflight adaptations of absolute.py (each against the reference behaviour)", () => {
    const BF = absCase("hdr_bf_wu3_positive").input;

    it("D2: reads the Betaflight CSV header lines the reference ignores", () => {
        const ref = extractAbsoluteTune(pairsOf(BF.headers), REFERENCE_EXTRACT);
        const gf = extractAbsoluteTune(pairsOf(BF.headers), GYROFLIGHT_EXTRACT);
        expect([ref.roll.f.source, ref.pitch.d_max.source, ref.dterm.lpf1_dyn_min_hz.source]).toEqual([
            "missing",
            "missing",
            "missing",
        ]);
        expect(AXES.map((a) => [gf[a].f.value, gf[a].d_max.value])).toEqual([
            [120, 40],
            [125, 46],
            [120, 0],
        ]);
        expect(gf.roll.f.origin).toBe("bbl_header:ff_weight[0]");
        expect([gf.dterm.lpf1_dyn_min_hz.value, gf.dterm.lpf1_dyn_max_hz.value]).toEqual([75, 150]);
        expect([gf.gyro.lpf1_dyn_min_hz.value, gf.gyro.lpf1_dyn_max_hz.value]).toEqual([250, 500]);
        // Values the reference does find are identical.
        for (const a of AXES) {
            for (const c of ["p", "i", "d"] as const) {
                expect(gf[a][c]).toEqual(ref[a][c]);
            }
        }
        expect(gf.dterm.lpf1_static_hz).toEqual(ref.dterm.lpf1_static_hz);
        expect(gf.sliders).toEqual(ref.sliders);
    });

    it("D2: with the full baseline only the missing-analysis blocks remain", () => {
        const p = proposalFor(BF, absCase("hdr_bf_wu3_positive").expected, "gyroflight");
        expect(p.status).toBe("proposed");
        expect(p.warnings).toEqual([]);
        expect(p.currentValidity.skipped_reasons).toEqual([]);
        expect(p.currentValidity.slider_pids_valid && p.currentValidity.slider_dterm_valid).toBe(true);
        expect(p.deltas["roll.f"]).toEqual({ current: 120, proposed: 165, delta: 45 });
        expect(p.deltas["dterm.lpf1_dyn_min_hz"]).toEqual({ current: 75, proposed: 75, delta: 0 });
        expect(runSafetyPipeline(p).final.blocked_reasons).toEqual(ANALYSIS_BLOCKS);
    });

    it("D3: RP mode leaves yaw as logged; the reference proposes yaw P/I/F = 0", () => {
        const c = absCase("hdr_bf_rp_mode");
        expect(c.expected.proposed["yaw.p"]).toBe(0);
        expect(c.expected.deltas["yaw.p"]).toEqual({ current: 45, proposed: 0, delta: -45 });
        const p = proposalFor(c.input, c.expected, "gyroflight");
        expect(PID.map((f) => p.proposed!.yaw[f].value)).toEqual([45, 80, 0, 120, 0]);
        expect(p.proposed!.yaw.p.note).toBe("unchanged: axis not driven by simplified_pids_mode");
        expect(p.deltas["yaw.p"]).toEqual({ current: 45, proposed: 45, delta: 0 });
        expect(p.proposed!.roll.p.value).toBe(c.expected.proposed["roll.p"]);
        expect(p.proposedValidity!.slider_pids_valid).toBe(true);
    });

    it("E1: a non-numeric rollPID element is missing, not a crash", () => {
        const c = absCase("hdr_bf_nan_pid");
        expect(c.error).toBe("ValueError");
        expect(() => extractAbsoluteTune(pairsOf(c.input.headers), REFERENCE_EXTRACT)).toThrow("ValueError");
        const t = extractAbsoluteTune(pairsOf(c.input.headers), GYROFLIGHT_EXTRACT);
        expect([t.roll.i.source, t.roll.i.note]).toEqual(["missing", "unparseable"]);
        const p = proposalFor(c.input, {}, "gyroflight");
        expect(runSafetyPipeline(p).final.blocked_reasons).toEqual(
            expect.arrayContaining(["missing_required_pid_or_filter_baseline:roll.i"]),
        );
    });

    it("E2: gyro filter ON with no multiplier blocks; the reference raises TypeError", () => {
        const c = absCase("hdr_bf_gyro_multiplier_missing");
        expect(c.error).toBe("TypeError");
        expect(() => proposalFor(c.input, {}, "reference")).toThrow("TypeError");
        const p = proposalFor(c.input, {}, "gyroflight");
        expect(p.status).toBe("blocked");
        expect(p.blockedReasons).toEqual(["proposed_gyro_sliders_incomplete:gyro_filter_multiplier"]);
        expect(runSafetyPipeline(p).final.blocked_reasons).toEqual(
            expect.arrayContaining(["proposed_gyro_sliders_incomplete:gyro_filter_multiplier", "malformed_proposal"]),
        );
    });

    it("D1: a pre-2025.12 `d_min` line is never read as d_max", () => {
        const c = absCase("hdr_bf45_dmin");
        const t = extractAbsoluteTune(pairsOf(c.input.headers), GYROFLIGHT_EXTRACT);
        expect(AXES.map((a) => t[a].d_max.source)).toEqual(["missing", "missing", "missing"]);
        expect(t.sliders.d_max_gain).toBeNull();
        expect(proposalFor(c.input, {}, "gyroflight").blockedReasons).toEqual([
            "proposed_pid_sliders_incomplete:d_max_gain",
        ]);
    });
});

async function load(bytes: Uint8Array) {
    picked.bytes = bytes;
    await useAutotune().importAndAnalyze();
    const gate = useChirpQualificationStore();
    return { gate, composite: gate.composite! };
}

const bfLog = (axes: (0 | 1 | 2)[], headers = BETAFLIGHT_TUNE_HEADERS) =>
    encodeChirpLog(simulateChirpSequence(axes.map((axis) => ({ ...GOOD, axis }))), headers);

beforeEach(() => setActivePinia(createPinia()));

describe("GyroCore Safety on the global recommendation (product entry)", () => {
    it("safe fixture with real Betaflight header lines: MERGE, COVERAGE pass; SAFETY BLOCK missing_required_analysis", async () => {
        const { gate, composite } = await load(bfLog([0, 1, 2]));
        expect(gate.report!.measurements.every((m) => m.state === "usable")).toBe(true);
        expect(composite.merge.status).toBe("merged");
        expect(composite.coverage.missingAxes).toEqual([]);
        expect(composite.authorized).toBe(true);
        expect(composite.final).toEqual(WU3_POSITIVE);

        const s = safetyForComposite(gate.gateState(), composite);
        expect(s.status).toBe("BLOCK");
        expect(s.blocks).toEqual(ANALYSIS_BLOCKS);
        expect(s.authorized).toBe(false);
        expect(s.analysisEvidence).toBe("not_available");
        expect(s.compositeId).toBe(composite.id);
        expect(s.sliders).toEqual(composite.final);
        expect(s.firmwareRevision).toBe(composite.firmwareRevision);
        // Current vs proposed absolute values (firmware mapping, not authoritative on a real craft).
        expect(AXES.map((a) => [s.current![a].p.value, s.proposed![a].p.value])).toEqual([
            [45, 62],
            [47, 64],
            [45, 62],
        ]);
        expect(s.deltas["pitch.f"]).toEqual({ current: 125, proposed: 172, delta: 47 });
        expect(s.pipeline!.mechanical.blocking_reasons).toEqual(["missing_required_analysis"]);
        expect(s.pipeline!.candidate.clamped_config).toBeNull();

        expect(() => assertSafetyAuthorized(gate.gateState(), composite, composite.final!)).toThrow(ApplyBlockedError);
    });

    it("NOT_EVALUATED when the composite is blocked upstream (no verdict manufactured from invalid input)", async () => {
        for (const bytes of [
            bfLog([0]),
            MERGE_E2E_CASES.roll_pitch_conflict(),
            MERGE_E2E_CASES.roll_ok_pitch_rejected(),
        ]) {
            setActivePinia(createPinia());
            const { gate, composite } = await load(bytes);
            expect(composite.authorized).toBe(false);
            const s = safetyForComposite(gate.gateState(), composite);
            expect(s.status).toBe("NOT_EVALUATED");
            expect(s.blocks).toEqual([SAFETY_NOT_EVALUATED_UPSTREAM]);
            expect(s.pipeline).toBeNull();
            expect(s.authorized).toBe(false);
        }
        expect(evaluateSafety(null, null).status).toBe("NOT_EVALUATED");
    });

    it("follows the composite: a new target gives a new composite and a new Safety binding", async () => {
        const { gate, composite } = await load(bfLog([0, 1, 2]));
        const before = safetyForComposite(gate.gateState(), composite);
        useAutotune().recomputeGains(PHASE_MARGIN_PRESETS.CONSERVATIVE);
        const after = safetyForComposite(gate.gateState(), gate.composite);
        expect(after.compositeId).not.toBe(before.compositeId);
        expect(after.compositeId).toBe(gate.composite!.id);
    });

    it("blocks when the log's header lines are missing or disagree with the composite's baseline", async () => {
        const { gate, composite } = await load(bfLog([0, 1, 2]));
        const log = gate.report!.logs[0];
        const pairs = log.headerPairs;
        log.headerPairs = [];
        expect(safetyForComposite(gate.gateState(), composite).blocks).toEqual([SAFETY_INPUT_MISSING_HEADERS]);
        log.headerPairs = pairs.map(([k, v]): [string, string] => (k === "simplified_pi_gain" ? [k, "120"] : [k, v]));
        const s = safetyForComposite(gate.gateState(), composite);
        expect([s.status, s.blocks]).toEqual(["BLOCK", [SAFETY_INPUT_SLIDERS_DIFFER]]);
    });

    it("the WU3 synthetic log (no ff_weight/filter lines) also fails on its incomplete baseline", async () => {
        const { gate, composite } = await load(MERGE_E2E_CASES.three_axis_agree());
        const s = safetyForComposite(gate.gateState(), composite);
        expect(s.status).toBe("BLOCK");
        expect(s.blocks).toEqual(
            expect.arrayContaining([...ANALYSIS_BLOCKS, "missing_required_pid_or_filter_baseline"]),
        );
    });

    it("a logged slider of 0 (Betaflight's `|| 100` would read it as 100) never reaches Safety", async () => {
        const { gate, composite } = await load(
            bfLog([0, 1, 2], withHeader(BETAFLIGHT_TUNE_HEADERS, "simplified_feedforward_gain:0")),
        );
        expect(
            gate.report!.measurements.every((m) => m.apply.blocked.includes("current_tune_zero:feedforward_gain")),
        ).toBe(true);
        expect(composite.authorized).toBe(false);
        expect(composite.final).toBeNull();
        expect(safetyForComposite(gate.gateState(), composite).status).toBe("NOT_EVALUATED");
    });

    it("has no analysis input anywhere", () => {
        expect(evaluateSafety.length).toBe(2);
        expect(runSafetyPipeline.length).toBe(1);
    });

    it("RP log: yaw is shown unchanged, roll+pitch mapped", async () => {
        const { gate, composite } = await load(
            bfLog([0, 1, 2], withHeader(BETAFLIGHT_TUNE_HEADERS, "simplified_pids_mode:1")),
        );
        expect(composite.authorized).toBe(true);
        const s = safetyForComposite(gate.gateState(), composite);
        expect(s.status).toBe("BLOCK");
        expect(s.blocks).toEqual(ANALYSIS_BLOCKS);
        expect(PID.map((f) => s.proposed!.yaw[f].value)).toEqual([45, 80, 0, 120, 0]);
        expect(s.proposed!.roll.p.value).toBe(62);
    });
});
