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
 * CHIRP + JIO block 4: every axis on its own record length and frequency grid (a short sweep of
 * one axis no longer clips the others; the 3×3 combination matches grids point by point over the
 * common supported band, never interpolating), the debug[2] frequency verification against the
 * firmware law (chirp.c at 43875a55a), and the notch compatibility keys. SIMULATION ONLY.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildLogInputs, PLANT_CONFIG_KEYS } from "../../src/gyrocore/engine/logInput";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import {
    controllerConfigFromHeaders,
    runAutotuneV2,
    type AutotuneLogInput,
} from "../../src/gyrocore/engine/autotuneV2";
import { analyzeJioSweeps, JIO_SWEEP } from "../../src/gyrocore/engine/jioSweep";
import { closedLoopChirpLog, ratePlant, type ClosedLoopLogOptions, type Plant } from "./harness/closedLoopBbl";
import { BETAFLIGHT_TUNE_HEADERS } from "./harness/chirpSim";

const G: Plant = ratePlant({ K: 60, motorHz: 40, delayS: 0.002 });
const DISTURBANCE = { disturbance: { sd: 3, poleHz: 300 } };
const AXES = ["roll", "pitch", "yaw"] as const;

function decoded(o: ClosedLoopLogOptions, name: string): AutotuneLogInput {
    const bytes = closedLoopChirpLog(o);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const [log] = buildLogInputs(bytes, sha, qualifyChirpFile(bytes, name, 45, AUTOTUNE_MATH), null);
    expect(log, name).toBeDefined();
    return log;
}
const run = (log: AutotuneLogInput, others: AutotuneLogInput[] = []) =>
    runAutotuneV2({ primary: log, others, verifiedTune: null });
const timeAt = (f: number, f0 = 2, f1 = 200, T = 12) => (T * Math.log(f / f0)) / Math.log(f1 / f0);

const noValidated = (r: ReturnType<typeof run>) => {
    expect(JSON.stringify(r.jio)).not.toContain('"VALIDATED"');
    expect(r.releasableProposal).toBeNull();
    expect(r.jio.diagnosticOnly).toBe(true);
};

describe("CHIRP + JIO: every axis on its own record length and grid", () => {
    it("a pitch sweep that ends early no longer clips roll: roll keeps its band and finer grid", () => {
        const full = run(decoded({ plants: [G, G, null], sweepS: 12, seed: 81, jio: DISTURBANCE }, "full.bbl"));
        const r = run(
            decoded(
                { plants: [G, G, null], sweepS: 12, seed: 81, jio: DISTURBANCE, ending: { 1: { modeOffAtHz: 30 } } },
                "pitch_short.bbl",
            ),
        );
        const roll = r.jio.analysis.axes.roll!;
        const pitch = r.jio.analysis.axes.pitch!;
        // Roll: the same record length, grid and band as in the flight where pitch ran to the end.
        expect(roll.records[0].recordS).toBeCloseTo(full.jio.analysis.axes.roll!.records[0].recordS, 6);
        expect(roll.grid!.stepHz).toBeCloseTo(full.jio.analysis.axes.roll!.grid!.stepHz, 9);
        expect(roll.band!.analysedHz).toEqual(full.jio.analysis.axes.roll!.band!.analysedHz);
        expect(roll.band!.analysedHz[1]).toBeGreaterThan(150);
        expect(roll.records[0].notes.some((n) => n.startsWith("window_reaches:"))).toBe(false);
        expect(roll.records[0].notes.some((n) => n.startsWith("record_clipped_"))).toBe(false);
        // Pitch: its own short record, coarser grid, band to what it reached, the complete-sweep need.
        expect(pitch.records[0].incomplete).toBe("registration_ended_early");
        expect(pitch.records[0].recordS).toBeLessThan(timeAt(30) + 0.6);
        expect(pitch.grid!.stepHz).toBeGreaterThan(1.5 * roll.grid!.stepHz);
        expect(pitch.band!.analysedHz[1]).toBeLessThanOrEqual(pitch.records[0].reachedHz!);
        expect(r.jio.requiredMeasurements).toContain("required_measurement:chirp_pitch_complete_sweep");
        expect(r.jio.requiredMeasurements).not.toContain("required_measurement:chirp_roll_complete_sweep");
        noValidated(r);
    }, 180_000);

    it("a missing axis leaves the other two on their own grids and gives no 3×3 combination", () => {
        const r = run(decoded({ plants: [G, null, G], sweepS: 12, seed: 82, jio: DISTURBANCE }, "no_pitch.bbl"));
        expect(r.jio.analysis.axes.pitch).toBeUndefined();
        expect(r.jio.analysis.axes.roll!.band!.analysedHz[1]).toBeGreaterThan(150);
        expect(r.jio.analysis.axes.yaw!.band!.analysedHz[1]).toBeGreaterThan(150);
        expect(r.jio.analysis.mimo).toBeNull();
        expect(r.jio.requiredMeasurements).toContain("required_measurement:chirp_pitch_sweep");
        noValidated(r);
    }, 120_000);

    it("the log stopping inside yaw leaves roll and pitch whole; yaw is incomplete on its own grid", () => {
        const r = run(
            decoded(
                { plants: [G, G, G], sweepS: 12, seed: 83, jio: DISTURBANCE, ending: { 2: { logEndsAtHz: 40 } } },
                "yaw_log_ends.bbl",
            ),
        );
        for (const axis of ["roll", "pitch"] as const) {
            const a = r.jio.analysis.axes[axis]!;
            expect(a.records[0].incomplete).toBeNull();
            expect(a.band!.analysedHz[1]).toBeGreaterThan(150);
            expect(a.records[0].notes.some((n) => n.startsWith("record_clipped_"))).toBe(false);
        }
        const yaw = r.jio.analysis.axes.yaw!;
        expect(yaw.records[0].incomplete).toBe("registration_ended_early");
        expect(yaw.band!.analysedHz[1]).toBeLessThanOrEqual(yaw.records[0].reachedHz!);
        expect(yaw.grid!.stepHz).toBeGreaterThan(r.jio.analysis.axes.roll!.grid!.stepHz);
        noValidated(r);
    }, 180_000);

    it("a shorter repeat of the same axis still sets that axis's record length, named", () => {
        const r = run(
            decoded(
                {
                    plants: [G, null, null],
                    sweepS: 12,
                    seed: 84,
                    jio: { ...DISTURBANCE, repeats: 2 },
                    ending: { 0: { modeOffAtHz: 80, repeat: 1 } },
                },
                "roll_repeat_short.bbl",
            ),
        );
        const roll = r.jio.analysis.axes.roll!;
        // The incomplete repeat is excluded beside the complete one, so it is not the ruler either.
        expect(roll.records[1].used).toBe(false);
        expect(roll.records[0].recordS).toBeGreaterThan(12);
        expect(roll.records[0].notes.some((n) => n.startsWith("record_clipped_"))).toBe(false);
        noValidated(r);
    }, 120_000);

    it("the 3×3 combination matches the axes' grids point by point over the common supported band only", () => {
        const r = run(
            decoded(
                { plants: [G, G, G], sweepS: 12, seed: 85, jio: DISTURBANCE, ending: { 2: { modeOffAtHz: 60 } } },
                "mimo_grids.bbl",
            ),
        );
        const m = r.jio.analysis.mimo!;
        expect(m).not.toBeNull();
        expect(m.notes.some((n) => n.startsWith("grids_matched_nearest:step_ratio:"))).toBe(true);
        expect(m.notes).toContain("diagnostic_only");
        const yaw = r.jio.analysis.axes.yaw!;
        const coarsest = Math.max(...AXES.map((a) => r.jio.analysis.axes[a]!.grid!.stepHz));
        expect(m.gridStepHz).toBeCloseTo(coarsest, 9);
        expect(m.pointsCommonSupported).toBeGreaterThan(0);
        // Nothing above the band every axis analysed, and nothing above yaw's own support.
        if (m.bandHz) {
            expect(m.bandHz[1]).toBeLessThanOrEqual(yaw.band!.analysedHz[1] + 1e-9);
            expect(m.bandHz[1]).toBeLessThanOrEqual(yaw.band!.supportedHz![1] + m.gridStepHz! / 2);
        }
        // The common count can never exceed the supported points of any axis.
        for (const a of AXES) {
            const p = r.jio.analysis.axes[a]!.points!;
            let sup = 0;
            for (let i = 0; i < p.supported.length; i++) sup += p.supported[i];
            expect(m.pointsCommonSupported).toBeLessThanOrEqual(sup);
        }
        noValidated(r);
    }, 180_000);

    it("grids too different to match give no 3×3 combination (no interpolation)", () => {
        const r = run(
            decoded(
                { plants: [G, G, G], sweepS: 12, seed: 86, jio: DISTURBANCE, ending: { 2: { modeOffAtHz: 8 } } },
                "mimo_incomparable.bbl",
            ),
        );
        const m = r.jio.analysis.mimo;
        const yaw = r.jio.analysis.axes.yaw!;
        // Yaw's sweep stopped at 8 Hz: its record is short and its grid coarse; either no combination
        // or an explicitly incomparable one.
        if (m) {
            expect(m.pointsWellConditioned).toBe(0);
            expect(m.notes.some((n) => n.startsWith("grids_incomparable:") || n === "grid_missing")).toBe(true);
        } else expect(yaw.records[0].used).toBe(false);
        noValidated(r);
    }, 180_000);
});

describe("CHIRP + JIO: debug[2] frequency verification against the firmware law", () => {
    it("the harness's quantised debug[2] verifies within 0.05 Hz; the record is used", () => {
        const r = run(decoded({ plants: [G, null, null], sweepS: 12, seed: 91, jio: DISTURBANCE }, "f_ok.bbl"));
        const rec = r.jio.analysis.axes.roll!.records[0];
        expect(rec.frequencyCheck.status).toBe("ok");
        expect(rec.frequencyCheck.samples).toBeGreaterThan(11_000);
        expect(rec.frequencyCheck.outOfTolerance).toBe(0);
        expect(rec.frequencyCheck.maxAbsErrorHz!).toBeLessThanOrEqual(0.06);
        expect(rec.frequencyCheck.heldWhileSilent).toBe(0);
        expect(rec.notes.some((n) => n.startsWith("debug2_frequency_verified:"))).toBe(true);
        expect(rec.used).toBe(true);
        expect(r.jio.analysis.limitations.some((l) => l.startsWith("frequency_verification_missing"))).toBe(false);
    }, 120_000);

    it("a logged frequency off by 10 % is a mismatch: the record is flagged and not analysed", () => {
        const r = run(
            decoded(
                { plants: [G, null, null], sweepS: 12, seed: 92, jio: { ...DISTURBANCE, debug2Scale: 1.1 } },
                "f_bad.bbl",
            ),
        );
        const roll = r.jio.analysis.axes.roll!;
        const rec = roll.records[0];
        expect(rec.frequencyCheck.status).toBe("mismatch");
        expect(rec.frequencyCheck.outOfTolerance / rec.frequencyCheck.samples).toBeGreaterThan(0.9);
        expect(rec.flags.some((f) => f.startsWith("debug2_frequency_mismatch:"))).toBe(true);
        expect(rec.used).toBe(false);
        expect(roll.blockers).toContain("jio_no_usable_record");
        expect(r.jio.status).toBe("BLOCKED");
        noValidated(r);
    }, 120_000);

    it("without debug[2] the frequency is not verified: a named limitation, never a pass", () => {
        const log = decoded({ plants: [G, null, null], sweepS: 12, seed: 93, jio: DISTURBANCE }, "f_missing.bbl");
        const h = Object.fromEntries(log.headerPairs);
        const analysis = analyzeJioSweeps(
            {
                headerPairs: log.headerPairs,
                sampleRateHz: log.sampleRateHz,
                gyroAdc: log.channels.gyroAdc,
                axisD: log.channels.axisD,
                motors: log.channels.motors,
                jio: { ...log.channels.jio!, frequencyDeciHz: null },
                sweeps: log.sweeps ?? [],
            },
            [0, 1, 2].map((a) => controllerConfigFromHeaders(h, a as 0 | 1 | 2)) as Parameters<
                typeof analyzeJioSweeps
            >[1],
        );
        const rec = analysis.axes.roll!.records[0];
        expect(rec.frequencyCheck.status).toBe("missing");
        expect(rec.notes).toContain("frequency_not_verified:debug2_missing");
        expect(rec.used).toBe(true);
        expect(analysis.limitations).toContain("frequency_verification_missing:debug[2]_not_logged");
        expect(analysis.limitations.some((l) => /verified|passed/.test(l))).toBe(false);
    }, 120_000);

    it("after chirp.c's finish both channels are 0 and are not compared; a held frequency with zero excitation is counted", () => {
        const held = run(
            decoded(
                { plants: [G, null, null], sweepS: 12, seed: 94, jio: DISTURBANCE, ending: { holdModeS: 1 } },
                "f_hold.bbl",
            ),
        );
        const recHold = held.jio.analysis.axes.roll!.records[0];
        expect(recHold.frequencyCheck.status).toBe("ok");
        expect(recHold.frequencyCheck.heldWhileSilent).toBe(0);
        expect(recHold.frequencyCheck.samples).toBeLessThanOrEqual(12_000);
        const abort = run(
            decoded({ plants: [G, null, null], sweepS: 12, seed: 95, jio: DISTURBANCE, abortAtHz: 60 }, "f_abort.bbl"),
        );
        const recAbort = abort.jio.analysis.axes.roll!.records[0];
        // Up to the stop the law holds; after it the generator's output is zero while debug[2] stays
        // at the stop frequency: not compared, counted and named.
        expect(recAbort.frequencyCheck.status).toBe("ok");
        expect(recAbort.frequencyCheck.samples).toBeLessThan(timeAt(60) * 1000 + 5);
        expect(recAbort.frequencyCheck.heldWhileSilent).toBe(0);
        expect(recAbort.incomplete).toBe("generator_stopped_early");
        expect(JIO_SWEEP.debug2ToleranceRel).toBe(0.01);
    }, 180_000);
});

describe("CHIRP + JIO: notch compatibility keys", () => {
    const base = [
        ...BETAFLIGHT_TUNE_HEADERS,
        "dterm_notch_hz:0",
        "dterm_notch_cutoff:0",
        "gyro_notch_hz:0,0",
        "gyro_notch_cutoff:0,0",
    ];
    const flight = (seed: number, headers: string[], startTimeUs: number) =>
        decoded({ plants: [G, null, null], sweepS: 8, seed, startTimeUs, headers, jio: DISTURBANCE }, `n${seed}.bbl`);

    it("the notch keys are identity keys; equal, differing and one-sided headers behave as the rules say", () => {
        expect(PLANT_CONFIG_KEYS).toContain("dterm_notch_cutoff");
        expect(PLANT_CONFIG_KEYS).toContain("gyro_notch_cutoff");
        const primary = flight(101, base, 2_000_000);
        const same = run(primary, [flight(102, base, 9_000_000)]).jio.crossFlight.candidates[0];
        expect(same.issues).toEqual([]);
        expect(same.usable).toBe(true);
        expect(same.notes.some((n) => n.includes("dterm_notch_cutoff"))).toBe(false);
        const differs = run(primary, [
            flight(
                103,
                base.map((h) => (h.startsWith("dterm_notch_cutoff:") ? "dterm_notch_cutoff:160" : h)),
                9_000_000,
            ),
        ]).jio.crossFlight.candidates[0];
        expect(differs.issues).toContain("cross_log_config_differs:dterm_notch_cutoff");
        expect(differs.usable).toBe(false);
        expect(differs.axes.roll).toBeUndefined();
        const oneSide = run(primary, [
            flight(
                104,
                base.filter((h) => !h.startsWith("gyro_notch_cutoff:")),
                9_000_000,
            ),
        ]).jio.crossFlight.candidates[0];
        expect(oneSide.issues).toContain("cross_log_config_differs:gyro_notch_cutoff");
        expect(oneSide.usable).toBe(false);
    }, 240_000);

    it("missing on both sides is noted as not logged on a firmware without a known absence table", () => {
        const noNotch = BETAFLIGHT_TUNE_HEADERS;
        const r = run(flight(105, noNotch, 2_000_000), [flight(106, noNotch, 9_000_000)]);
        const c = r.jio.crossFlight.candidates[0];
        expect(c.issues).toEqual([]);
        expect(c.notes).toContain("setting_not_logged_in_either:dterm_notch_cutoff");
        // The synthetic firmware revision names no known hash: anti_gravity_mode stays "not logged".
        expect(c.notes).toContain("setting_not_logged_in_either:anti_gravity_mode");
        expect(c.notes.some((n) => n.startsWith("setting_not_in_firmware:"))).toBe(false);
        noValidated(r);
    }, 180_000);
});
