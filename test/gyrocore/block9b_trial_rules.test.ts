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
 * The AIR65 roll trial's pre-registered rules (support/air65RollTrial.ts), on synthetic headers and
 * a synthetic roll comparison: the exact change P56 → P45 and nothing else, the R reference
 * settings, the ANGLE and one-log-per-file rules, compareAxis's per-bin trace, and the peak rule.
 */

import { describe, expect, it } from "vitest";
import { air65RollConfig, evaluateControllerFrf } from "../../src/js/blackbox/betaflight_digital_controller";
import {
    closedLoopFromPlant,
    extractPlantFromClosedLoop,
    plantFrf,
    syntheticTransferFunctionWithCoherence,
} from "../../src/js/blackbox/betaflight_open_loop";
import { compareAxis, type AxisBinTrace } from "../../src/gyrocore/releaseGate/verifiedTune";
import {
    angleThroughSweep,
    coverage,
    peakAssessment,
    traceMatches,
    TRIAL,
    trialHeaderCheck,
    trialLogIssues,
    type BinCoverage,
} from "./support/air65RollTrial";

// The keys the AIR65 logs carry that matter here (one per kind), with the reference values.
const REF: [string, string][] = [
    ["Firmware revision", "Betaflight 2026.6.2 (43875a55a) STM32G474"],
    ["P interval", "1"],
    ["debug_mode", "96"],
    ["rollPID", "56,79,30"],
    ["pitchPID", "82,117,61"],
    ["yawPID", "56,79,0"],
    ["levelPID", "90,75,75"],
    ["d_max", "40,0,0"],
    ["ff_weight", "22,32,22"],
    ["angle_limit", "60"],
    ["iterm_relax", "1"],
    ["iterm_relax_type", "1"],
    ["iterm_relax_cutoff", "25"],
    ["chirp_amplitude_roll", "230"],
    ["chirp_amplitude_yaw", "180"],
    ["chirp_frequency_start_deci_hz", "20"],
    ["chirp_frequency_end_deci_hz", "2400"],
    ["chirp_time_seconds", "20"],
    ["vbatref", "423"],
    ["rc_smoothing_rx_smoothed", "125"],
];
const withValues = (over: Record<string, string | null>): [string, string][] =>
    [...REF.filter(([k]) => !(k in over)), ...Object.entries(over).filter(([, v]) => v !== null)] as [string, string][];

describe("AIR65 roll trial: the exact change in A and B", () => {
    it("P45 as the only change passes; run-time keys may differ", () => {
        const a = withValues({ rollPID: "45,79,30", vbatref: "399", rc_smoothing_rx_smoothed: "250" });
        expect(trialHeaderCheck(REF, a, TRIAL.rollPidTrial).issues).toEqual([]);
    });
    it.each([
        ["44,79,30", "roll_p_expected_45:44"],
        ["46,79,30", "roll_p_expected_45:46"],
        ["56,79,30", "roll_p_expected_45:56"],
    ])("a wrong roll P (%s) is named", (pid, reason) => {
        expect(trialHeaderCheck(REF, withValues({ rollPID: pid }), TRIAL.rollPidTrial).issues).toEqual([reason]);
    });
    it("P45 plus a second changed PID value is refused, per value", () => {
        expect(trialHeaderCheck(REF, withValues({ rollPID: "45,80,30" }), TRIAL.rollPidTrial).issues).toEqual([
            "pid_changed:rollPID_i_d:79,30:80,30",
        ]);
        expect(
            trialHeaderCheck(REF, withValues({ rollPID: "45,79,30", pitchPID: "82,117,62" }), TRIAL.rollPidTrial)
                .issues,
        ).toEqual(["pid_changed:pitchPID:82,117,61:82,117,62"]);
        expect(
            trialHeaderCheck(REF, withValues({ rollPID: "45,79,30", d_max: "41,0,0" }), TRIAL.rollPidTrial).issues,
        ).toEqual(["pid_changed:d_max:40,0,0:41,0,0"]);
    });
    it("a non-PID change the app does not see (CHIRP, angle, I relax, debug) is refused", () => {
        for (const [k, v] of [
            ["chirp_amplitude_roll", "250"],
            ["chirp_frequency_end_deci_hz", "1900"],
            ["chirp_time_seconds", "25"],
            ["angle_limit", "55"],
            ["iterm_relax_cutoff", "15"],
            ["debug_mode", "0"],
        ]) {
            expect(
                trialHeaderCheck(REF, withValues({ rollPID: "45,79,30", [k]: v }), TRIAL.rollPidTrial).issues,
            ).toEqual([`header_changed:${k}:${new Map(REF).get(k)}:${v}`]);
        }
    });
    it("a key logged twice with different values is ambiguous", () => {
        const dup: [string, string][] = [...withValues({ rollPID: "45,79,30" }), ["chirp_time_seconds", "25"]];
        expect(trialHeaderCheck(REF, dup, TRIAL.rollPidTrial).issues).toContain(
            "header_duplicate:log:chirp_time_seconds",
        );
    });
    it("missing evidence is never a match", () => {
        expect(trialHeaderCheck(REF, withValues({ rollPID: null }), TRIAL.rollPidTrial).issues).toEqual([
            "header_missing:rollPID",
        ]);
        expect(
            trialHeaderCheck(REF, withValues({ rollPID: "45,79,30", chirp_time_seconds: null }), TRIAL.rollPidTrial)
                .issues,
        ).toEqual(["header_missing:chirp_time_seconds"]);
    });
    it("the baseline must be the registered P56", () => {
        const base = withValues({ rollPID: "50,79,30" });
        expect(trialHeaderCheck(base, withValues({ rollPID: "45,79,30" }), TRIAL.rollPidTrial).issues).toContain(
            "baseline_roll_pid_not_registered:50,79,30",
        );
    });
});

describe("AIR65 roll trial: the R reference", () => {
    it("R with the reference settings passes and reports them", () => {
        const c = trialHeaderCheck(REF, withValues({ vbatref: "377" }), TRIAL.rollPidReference);
        expect(c.issues).toEqual([]);
        expect(c.settings.chirp_amplitude_roll).toEqual({ reference: "230", log: "230" });
        expect(c.settings.rollPID).toEqual({ reference: "56,79,30", log: "56,79,30" });
    });
    it("R already at P45, or with another CHIRP band, is named", () => {
        expect(trialHeaderCheck(REF, withValues({ rollPID: "45,79,30" }), TRIAL.rollPidReference).issues).toEqual([
            "roll_p_expected_56:45",
        ]);
        expect(
            trialHeaderCheck(REF, withValues({ chirp_frequency_start_deci_hz: "30" }), TRIAL.rollPidReference).issues,
        ).toEqual(["header_changed:chirp_frequency_start_deci_hz:20:30"]);
    });
    it("ANGLE must be active over the whole roll sweep", () => {
        const mask = new Array(100).fill(2 | 64);
        expect(angleThroughSweep(mask, { start: 10, end: 90 })).toEqual([]);
        mask[50] = 64;
        expect(angleThroughSweep(mask, { start: 10, end: 90 })).toEqual([
            "angle_not_active_during_roll_sweep:1_of_80_samples",
        ]);
        expect(angleThroughSweep(null, { start: 10, end: 90 })).toEqual(["flight_mode_not_logged"]);
        expect(angleThroughSweep(mask, null)).toEqual(["roll_sweep_missing"]);
    });
    it("a file holds one swept log and is no reference log", () => {
        const one = [{ sha256: "r".repeat(64), logIndex: 0, hasRollSweep: true }];
        expect(trialLogIssues(one, [TRIAL.baseline.sha256])).toEqual([]);
        expect(trialLogIssues([...one, { ...one[0], logIndex: 1 }], [])).toEqual([
            "file_holds_2_logs_with_a_roll_sweep:erase_the_flash_first",
        ]);
        expect(trialLogIssues([{ ...one[0], sha256: TRIAL.baseline.sha256 }], [TRIAL.baseline.sha256])).toEqual([
            "file_is_a_reference_or_other_trial_log",
        ]);
        expect(trialLogIssues([{ ...one[0], hasRollSweep: false }], [])).toEqual(["roll_sweep_missing"]);
        expect(trialLogIssues([], [])).toEqual(["log_missing"]);
    });
});

// A synthetic roll comparison on the 1.953 Hz grid of the AIR65 logs: P 56 → 45 on a known plant.
const GRID = Array.from({ length: 30 }, (_, i) => (i + 1) * 1.953125);
const PLANT = { K: 80, motorHz: 40, delayS: 0.002 };
function rollInput(coh: (f: number) => number, repCoh: (f: number) => number = () => 0.99) {
    const base = air65RollConfig();
    const cand = { ...base, axis: { ...base.axis, p: 45 } };
    const T = (cfg: typeof base, c: (f: number) => number) =>
        syntheticTransferFunctionWithCoherence(
            GRID,
            (f) => {
                const frf = evaluateControllerFrf(cfg, f);
                return closedLoopFromPlant(plantFrf(f, PLANT), frf.cReference, frf.cFeedback);
            },
            c,
        );
    return {
        plant: extractPlantFromClosedLoop(
            T(base, () => 0.99),
            base,
            { missingFilterInfo: [] },
        ),
        baselineCfg: base,
        candidateCfg: cand,
        candidateT: T(cand, coh),
        baselineRepeatT: T(base, repCoh),
    };
}

describe("compareAxis trace: which bins were tested", () => {
    it("the trace changes nothing and its aggregates are the comparison", () => {
        const input = rollInput(() => 0.95);
        const trace: AxisBinTrace[] = [];
        const withTrace = compareAxis("roll", input, trace);
        expect(withTrace).toEqual(compareAxis("roll", input));
        expect(trace.length).toBeGreaterThan(0);
        expect(traceMatches(trace, withTrace)).toBe(true);
        // Any aggregate that differs from the record breaks the match.
        for (const k of ["withinShare", "loopWithinShare", "maxExcess", "comparedBins", "scatterCappedBins"] as const) {
            expect(traceMatches(trace, { ...withTrace, [k]: (withTrace[k] ?? 0) + 1 })).toBe(false);
        }
    });
    it("names why a bin was left out, and the peak bins' coverage", () => {
        // Candidate coherence below the limit at 27.3 Hz, the repeat's at 29.3 Hz.
        const input = rollInput(
            (f) => (Math.abs(f - 27.344) < 0.5 ? 0.7 : 0.95),
            (f) => (Math.abs(f - 29.297) < 0.5 ? 0.6 : 0.99),
        );
        const trace: AxisBinTrace[] = [];
        const cmp = compareAxis("roll", input, trace);
        expect(traceMatches(trace, cmp)).toBe(true);
        const cov = coverage(trace);
        const at = (hz: number) => cov.find((c) => Math.abs(c.frequencyHz - hz) < 0.5)!;
        expect(at(27.344)).toMatchObject({
            testedInT: false,
            testedInLoop: false,
            reason: "candidate_coherence_below_min",
            loopReason: "candidate_coherence_below_min",
        });
        expect(at(29.297)).toMatchObject({ testedInT: false, reason: "repeat_coherence_below_min" });
        expect(at(25.391).testedInT).toBe(true);
        expect(cov.every((c) => c.frequencyHz <= 40)).toBe(true);
        const peak = peakAssessment(
            "REPRODUCED",
            { coverage: cov, traceMatches: true },
            { coverage: cov, traceMatches: true },
        );
        expect(peak.outcome).toBe("NOT_ASSESSED");
        expect(peak.reasons).toEqual([
            "A:27.344_hz_not_tested:candidate_coherence_below_min",
            "A:29.297_hz_not_tested:repeat_coherence_below_min",
            "B:27.344_hz_not_tested:candidate_coherence_below_min",
            "B:29.297_hz_not_tested:repeat_coherence_below_min",
        ]);
    });
});

describe("AIR65 roll trial: the peak conclusion", () => {
    const row = (frequencyHz: number, tExcess: number | null, testedInT = true): BinCoverage => ({
        frequencyHz,
        testedInT,
        testedInLoop: testedInT,
        reason: testedInT ? null : "candidate_coherence_below_min",
        loopReason: testedInT ? null : "candidate_coherence_below_min",
        tExcess,
        candidateCoherence: 0.9,
        repeatCoherence: 0.9,
    });
    const cov = (e: [number, number, number]) => TRIAL.peakBinsHz.map((hz, i) => row(hz, e[i]));
    const ok = (e: [number, number, number]) => ({ coverage: cov(e), traceMatches: true });
    it("all three within in A and B: consistent", () => {
        expect(peakAssessment("REPRODUCED", ok([0.2, 0.9, 1]), ok([0.5, 0.5, 0.5])).outcome).toBe("PEAK_CONSISTENT");
    });
    it("two of three outside in A and in B: inconsistent; otherwise unresolved", () => {
        expect(peakAssessment("REPRODUCED", ok([1.5, 2, 0.5]), ok([1.1, 0.4, 3])).outcome).toBe("PEAK_INCONSISTENT");
        expect(peakAssessment("REPRODUCED", ok([1.5, 2, 0.5]), ok([0.5, 0.4, 0.3])).outcome).toBe("PEAK_UNRESOLVED");
        expect(peakAssessment("REPRODUCED", ok([1.5, 0.5, 0.5]), ok([0.5, 0.4, 0.3])).outcome).toBe("PEAK_UNRESOLVED");
    });
    it("not assessed without the condition, a valid comparison, a matching trace or coverage", () => {
        expect(peakAssessment("CHANGED", ok([0, 0, 0]), ok([0, 0, 0])).outcome).toBe("NOT_ASSESSED");
        expect(peakAssessment("REPRODUCED", { coverage: null, traceMatches: false }, ok([0, 0, 0])).reasons).toEqual([
            "A:comparison_not_valid",
        ]);
        expect(
            peakAssessment("REPRODUCED", { coverage: cov([0, 0, 0]), traceMatches: false }, ok([0, 0, 0])).reasons,
        ).toEqual(["A:trace_differs_from_record"]);
        const gap = { coverage: [row(25.391, 0.1), row(27.344, null, false), row(29.297, 0.1)], traceMatches: true };
        expect(peakAssessment("REPRODUCED", gap, ok([0, 0, 0])).reasons).toEqual([
            "A:27.344_hz_not_tested:candidate_coherence_below_min",
        ]);
    });
});
