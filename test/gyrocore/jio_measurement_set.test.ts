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
 * CHIRP + JIO measurement set (block 3): sweeps that really end early in the log (CHIRP mode off,
 * log stopped, generator held, frames lost), the repeat rules they must not improve, the compatibility
 * keys between flights, and the sweep advice against the band the tuning goals need. The harness
 * shortens the record itself (channel samples, timestamps, loopIteration and segment bounds agree);
 * nothing is padded. SIMULATION ONLY: no AIR65 or other hardware evidence.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildLogInputs } from "../../src/gyrocore/engine/logInput";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { runAutotuneV2, type AutotuneLogInput } from "../../src/gyrocore/engine/autotuneV2";
import { JIO_SWEEP, sweepAdviceFor } from "../../src/gyrocore/engine/jioSweep";
import { closedLoopChirpLog, ratePlant, type ClosedLoopLogOptions, type Plant } from "./harness/closedLoopBbl";
import { BETAFLIGHT_TUNE_HEADERS } from "./harness/chirpSim";

const G: Plant = ratePlant({ K: 60, motorHz: 40, delayS: 0.002 });
const DISTURBANCE = { disturbance: { sd: 3, poleHz: 300 } };

function decodedWithQualification(o: ClosedLoopLogOptions, name: string) {
    const bytes = closedLoopChirpLog(o);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const qual = qualifyChirpFile(bytes, name, 45, AUTOTUNE_MATH);
    const [log] = buildLogInputs(bytes, sha, qual, null);
    expect(log, name).toBeDefined();
    return { log, qual, bytes };
}
const decoded = (o: ClosedLoopLogOptions, name: string): AutotuneLogInput => decodedWithQualification(o, name).log;
const run = (log: AutotuneLogInput, others: AutotuneLogInput[] = []) =>
    runAutotuneV2({ primary: log, others, verifiedTune: null });

/** The frequency the exponential sweep f0 → f1 over T reaches after t seconds (chirp.c). */
const reachedAt = (t: number, f0 = 2, f1 = 200, T = 12) => f0 * Math.pow(f1 / f0, t / T);
/** The time at which the sweep reaches f (inverse of reachedAt). */
const timeAt = (f: number, f0 = 2, f1 = 200, T = 12) => (T * Math.log(f / f0)) / Math.log(f1 / f0);

const noValidated = (r: ReturnType<typeof run>) => {
    expect(JSON.stringify(r.jio)).not.toContain('"VALIDATED"');
    expect(r.releasableProposal).toBeNull();
};

describe("CHIRP + JIO incomplete sweeps (harness records that really end early)", () => {
    it("CHIRP mode switched off early: the record ends there, the axis is analysed to the reached frequency only", () => {
        const { log, qual } = decodedWithQualification(
            { plants: [G, G, null], sweepS: 12, seed: 41, jio: DISTURBANCE, ending: { 0: { modeOffAtHz: 30 } } },
            "mode_off.bbl",
        );
        // The harness shortened the registration itself: the qualification's roll measurement is the
        // 7.1 s the sweep ran, bounded by the mode flag (the generator never logged a zero), samples agree.
        const rollM = qual.logs[0].measurements.find((m) => m.axisName === "roll")!;
        expect(rollM.boundSource).toBe("mode_flag_only");
        expect(rollM.sampleCount).toBeGreaterThan(timeAt(30) * 1000 - 5);
        expect(rollM.sampleCount).toBeLessThan(timeAt(30) * 1000 + 5);
        expect((rollM.endTimeUs - rollM.startTimeUs) / 1e6).toBeCloseTo(rollM.sampleCount / 1000, 1);
        const r = run(log);
        const roll = r.jio.analysis.axes.roll!;
        const pitch = r.jio.analysis.axes.pitch!;
        expect(roll.records).toHaveLength(1);
        expect(roll.records[0].incomplete).toBe("registration_ended_early");
        expect(roll.records[0].reachedHz!).toBeGreaterThan(28);
        expect(roll.records[0].reachedHz!).toBeLessThan(31);
        expect(roll.records[0].notes.some((n) => n.startsWith("sweep_incomplete:registration_ended_early:"))).toBe(
            true,
        );
        expect(roll.records[0].used).toBe(true);
        expect(roll.sweeps).toMatchObject({ present: 1, complete: 0, usable: 1, excluded: [] });
        expect(roll.sweeps.reachedHz).toBe(roll.records[0].reachedHz);
        // Analysed band ends where the sweep ended; the points above are named, not "no excitation".
        expect(roll.band!.analysedHz[1]).toBeLessThanOrEqual(roll.records[0].reachedHz!);
        expect(roll.band!.supportedHz![1]).toBeLessThanOrEqual(roll.band!.analysedHz[1]);
        expect(roll.reasons["not_swept:incomplete_sweep"]).toBeGreaterThan(0);
        // The complete pitch sweep is complete, clipped to the common record length (named).
        expect(pitch.records[0].incomplete).toBeNull();
        expect(pitch.sweeps).toMatchObject({ present: 1, complete: 1, usable: 1 });
        expect(pitch.records[0].notes.some((n) => n.startsWith("record_clipped_to_common_length"))).toBe(true);
        expect(pitch.band!.analysedHz[1]).toBeGreaterThan(80);
        // The route asks for a complete roll sweep, not a complete pitch sweep; stationarity stays unknown.
        expect(r.jio.requiredMeasurements).toContain("required_measurement:chirp_roll_complete_sweep");
        expect(r.jio.requiredMeasurements).not.toContain("required_measurement:chirp_pitch_complete_sweep");
        expect(r.jio.requiredMeasurements).toContain("required_measurement:chirp_roll_repeated_sweep_for_stationarity");
        expect(r.jio.progress.roll).toMatchObject({
            sweeps: { present: 1, complete: 0, usable: 1 },
            withinFlight: { repeats: 1, consistency: "unknown" },
            acrossFlights: { flights: 0, offered: 0, consistency: "unknown" },
        });
        expect(r.jio.progress.roll!.bandHz.reached).toBe(roll.records[0].reachedHz);
        expect(r.jio.progress.pitch!.bandHz.reached).toBeNull();
        expect(r.jio.progress.roll!.nextSteps).toContain("required_measurement:chirp_roll_complete_sweep");
        expect(r.jio.progress.roll!.nextSteps.every((n) => n.includes("chirp_roll_"))).toBe(true);
        noValidated(r);
    }, 120_000);

    it("an incomplete repeat beside a complete sweep is no repeat: excluded, band and support unchanged", () => {
        const alone = run(decoded({ plants: [G, null, null], sweepS: 12, seed: 42, jio: DISTURBANCE }, "alone.bbl")).jio
            .analysis.axes.roll!;
        const r = run(
            decoded(
                {
                    plants: [G, null, null],
                    sweepS: 12,
                    seed: 42,
                    jio: { ...DISTURBANCE, repeats: 2 },
                    ending: { 0: { modeOffAtHz: 30, repeat: 1 } },
                },
                "complete_plus_incomplete.bbl",
            ),
        );
        const roll = r.jio.analysis.axes.roll!;
        expect(roll.records).toHaveLength(2);
        expect(roll.records[0].incomplete).toBeNull();
        expect(roll.records[1].incomplete).toBe("registration_ended_early");
        expect(roll.records[1].used).toBe(false);
        expect(roll.records[1].flags.some((f) => f.startsWith("incomplete_sweep_beside_complete:reached_"))).toBe(true);
        expect(roll.sweeps).toMatchObject({ present: 2, complete: 1, usable: 1 });
        expect(roll.sweeps.excluded).toHaveLength(1);
        expect(roll.sweeps.excluded[0]).toContain(roll.records[1].id);
        // One usable sweep: repeatability unknown, the stationarity need stays, no complete-sweep need.
        expect(roll.repeats).toMatchObject({ count: 1, consistency: "unknown" });
        expect(r.jio.requiredMeasurements).toContain("required_measurement:chirp_roll_repeated_sweep_for_stationarity");
        expect(r.jio.requiredMeasurements).not.toContain("required_measurement:chirp_roll_complete_sweep");
        // The band and support are those of the complete sweep alone, to the point.
        expect(roll.band!.analysedHz).toEqual(alone.band!.analysedHz);
        expect(roll.band!.supportedHz).toEqual(alone.band!.supportedHz);
        expect(Array.from(roll.points!.gRe)).toEqual(Array.from(alone.points!.gRe));
        noValidated(r);
    }, 120_000);

    it("two incomplete sweeps are compared only over the band both reached and still ask for a complete sweep", () => {
        const r = run(
            decoded(
                {
                    plants: [G, null, null],
                    sweepS: 12,
                    seed: 43,
                    jio: { ...DISTURBANCE, repeats: 2 },
                    ending: { 0: { modeOffAtHz: 40 } },
                },
                "two_incomplete.bbl",
            ),
        );
        const roll = r.jio.analysis.axes.roll!;
        expect(roll.sweeps).toMatchObject({ present: 2, complete: 0, usable: 2 });
        expect(roll.repeats.count).toBe(2);
        expect(roll.repeats.consistency).toBe("consistent");
        expect(roll.band!.analysedHz[1]).toBeLessThanOrEqual(reachedAt(timeAt(40)) + 0.01);
        expect(r.jio.requiredMeasurements).toContain("required_measurement:chirp_roll_complete_sweep");
        expect(r.jio.requiredMeasurements).not.toContain(
            "required_measurement:chirp_roll_repeated_sweep_for_stationarity",
        );
        noValidated(r);
    }, 120_000);

    it("the log stops inside the last axis: that sweep is incomplete, the others stay analysed", () => {
        const { log, qual, bytes } = decodedWithQualification(
            { plants: [G, G, null], sweepS: 12, seed: 44, jio: DISTURBANCE, ending: { 1: { logEndsAtHz: 50 } } },
            "log_ends.bbl",
        );
        // No idle frames after the cut: the log's last frame is the pitch sweep's last sample.
        const pitchM = qual.logs[0].measurements.find((m) => m.axisName === "pitch")!;
        expect(pitchM.boundSource).toBe("mode_flag_only");
        expect(pitchM.sampleCount).toBeLessThan(timeAt(50) * 1000 + 5);
        expect(bytes.length).toBeLessThan(
            closedLoopChirpLog({ plants: [G, G, null], sweepS: 12, seed: 44, jio: DISTURBANCE }).length,
        );
        const r = run(log);
        const pitch = r.jio.analysis.axes.pitch!;
        expect(pitch.records[0].incomplete).toBe("registration_ended_early");
        expect(pitch.records[0].reachedHz!).toBeLessThan(51);
        expect(pitch.records[0].used).toBe(true);
        expect(pitch.band!.analysedHz[1]).toBeLessThanOrEqual(pitch.records[0].reachedHz!);
        expect(r.jio.analysis.axes.roll!.records[0].incomplete).toBeNull();
        expect(r.jio.analysis.axes.roll!.records[0].used).toBe(true);
        expect(r.jio.requiredMeasurements).toContain("required_measurement:chirp_pitch_complete_sweep");
        noValidated(r);
    }, 120_000);

    it("CHIRP mode held after completion: the firmware's zeroed generator is trimmed and the sweep is complete", () => {
        const { log, qual } = decodedWithQualification(
            { plants: [G, null, null], sweepS: 12, seed: 45, jio: DISTURBANCE, ending: { holdModeS: 1.0 } },
            "hold_mode.bbl",
        );
        const m = qual.logs[0].measurements.find((x) => x.axisName === "roll")!;
        expect(m.boundSource).toBe("firmware_debug_chirp");
        expect(m.sampleCount).toBeGreaterThan(12_000 - 5);
        expect(m.sampleCount).toBeLessThan(12_000 + 5);
        const roll = run(log).jio.analysis.axes.roll!;
        expect(roll.records[0].incomplete).toBeNull();
        expect(roll.records[0].excitedS).toBeCloseTo(12, 1);
        expect(roll.records[0].notes.some((n) => n.startsWith("sweep_incomplete"))).toBe(false);
        expect(roll.sweeps).toMatchObject({ present: 1, complete: 1, usable: 1 });
    }, 120_000);

    it("the generator held at zero while the registration goes on is a generator stop, analysed to the stop frequency", () => {
        const r = run(
            decoded({ plants: [G, null, null], sweepS: 12, seed: 46, jio: DISTURBANCE, abortAtHz: 60 }, "abort.bbl"),
        );
        const roll = r.jio.analysis.axes.roll!;
        expect(roll.records[0].incomplete).toBe("generator_stopped_early");
        expect(roll.records[0].reachedHz!).toBeGreaterThan(58);
        expect(roll.records[0].reachedHz!).toBeLessThan(61);
        expect(roll.band!.analysedHz[1]).toBeLessThanOrEqual(roll.records[0].reachedHz!);
        expect(r.jio.requiredMeasurements).toContain("required_measurement:chirp_roll_complete_sweep");
        noValidated(r);
    }, 120_000);

    it("lost frames: time and loopIteration jump, the record is flagged and never padded", () => {
        const { log, qual } = decodedWithQualification(
            {
                plants: [G, null, null],
                sweepS: 12,
                seed: 47,
                jio: DISTURBANCE,
                ending: { 0: { lostSamples: { fromS: 4, toS: 5 } } },
            },
            "lost.bbl",
        );
        const m = qual.logs[0].measurements.find((x) => x.axisName === "roll")!;
        // 1 s of 12 s lost: the samples are fewer, the timestamps span the whole sweep.
        expect(m.sampleCount).toBeGreaterThan(11_000 - 5);
        expect(m.sampleCount).toBeLessThan(11_000 + 5);
        expect((m.endTimeUs - m.startTimeUs) / 1e6).toBeCloseTo(12, 1);
        expect(m.spacing.missingFraction).toBeGreaterThan(0.07);
        expect(m.spacing.missingFraction).toBeLessThan(0.1);
        const r = run(log);
        const roll = r.jio.analysis.axes.roll!;
        expect(roll.records[0].used).toBe(false);
        expect(roll.records[0].flags.some((f) => f.startsWith("timestamp_gaps:"))).toBe(true);
        expect(roll.sweeps).toMatchObject({ present: 1, complete: 1, usable: 0 });
        expect(roll.sweeps.excluded).toHaveLength(1);
        expect(roll.blockers).toContain("jio_no_usable_record");
        expect(roll.points).toBeNull();
        expect(r.jio.status).toBe("BLOCKED");
        noValidated(r);
    }, 120_000);

    it("a short idle gap shortens the settle tail so no record window reaches into the next sweep", () => {
        const r = run(
            decoded(
                { plants: [G, G, null], sweepS: 12, seed: 48, jio: { ...DISTURBANCE, gapS: 0.2 } },
                "short_gap.bbl",
            ),
        );
        for (const axis of ["roll", "pitch"] as const) {
            const rec = r.jio.analysis.axes[axis]!.records[0];
            expect(rec.notes.some((n) => /^tail_shortened_to_gap:0\.(19|20|21)s$/.test(n))).toBe(true);
            expect(rec.recordS).toBeLessThanOrEqual((rec.end - rec.start) / 1000 + 0.21);
            expect(rec.used).toBe(true);
        }
    }, 120_000);
});

describe("CHIRP + JIO compatibility keys between flights (c1569ca99 and block 3)", () => {
    const base = [...BETAFLIGHT_TUNE_HEADERS, "anti_gravity_gain:80", "tpa_rate:65", "tpa_curve_type:0"];
    const flight = (seed: number, headers: string[], startTimeUs: number) =>
        decoded({ plants: [G, null, null], sweepS: 8, seed, startTimeUs, headers, jio: DISTURBANCE }, `k${seed}.bbl`);
    const primary = flight(51, base, 2_000_000);

    it("equal headers: comparable; keys neither flight logs are named as not compared, not as a difference", () => {
        const r = run(primary, [flight(52, base, 9_000_000)]);
        const c = r.jio.crossFlight.candidates[0];
        expect(c.issues).toEqual([]);
        expect(c.usable).toBe(true);
        expect(c.notes).toContain("setting_not_logged_in_either:anti_gravity_mode");
        expect(c.notes).toContain("setting_not_logged_in_either:iterm_relax");
        expect(c.notes).not.toContain("setting_not_logged_in_either:anti_gravity_gain");
        expect(c.axes.roll!.z).not.toBeNull();
    }, 120_000);

    it("a differing value, a header on one side only, and a differing TPA curve each make the flight incomparable", () => {
        const differs = (headers: string[]) =>
            run(primary, [flight(53, headers, 9_000_000)]).jio.crossFlight.candidates[0];
        const gain = differs(base.map((h) => (h.startsWith("anti_gravity_gain:") ? "anti_gravity_gain:120" : h)));
        expect(gain.issues).toContain("jio_cross_flight_setting_differs:anti_gravity_gain");
        expect(gain.usable).toBe(false);
        const oneSide = differs([...base, "tpa_curve_expo:20"]);
        expect(oneSide.issues).toContain("jio_cross_flight_setting_differs:tpa_curve_expo");
        expect(oneSide.usable).toBe(false);
        const curve = differs(base.map((h) => (h.startsWith("tpa_curve_type:") ? "tpa_curve_type:1" : h)));
        expect(curve.issues).toContain("jio_cross_flight_setting_differs:tpa_curve_type");
        const missingHere = run(
            flight(
                54,
                base.filter((h) => !h.startsWith("anti_gravity_gain:")),
                2_000_000,
            ),
            [flight(55, base, 9_000_000)],
        ).jio.crossFlight.candidates[0];
        expect(missingHere.issues).toContain("jio_cross_flight_setting_differs:anti_gravity_gain");
    }, 180_000);
});

describe("CHIRP + JIO sweep advice against the band the tuning goals need", () => {
    const sweep = { f0Hz: 0.2, f1Hz: 600, durationS: 20 };
    const band = {
        analysedHz: [2, 450] as [number, number],
        supportedHz: [3.1, 67] as [number, number],
        supportedFraction: 0.3,
        gapPoints: 0,
        largestGapPoints: 0,
        longestRunHz: [3.1, 67] as [number, number],
    };

    it("keeps the suggested end at the tuning band's top and names a supported band that falls short", () => {
        const adv = sweepAdviceFor(sweep, band, [10, 150])!;
        expect(adv.bandSufficientForTuning).toBe(false);
        expect(adv.tuningBandHz).toEqual([10, 150]);
        expect(adv.suggested!.chirp_frequency_end_deci_hz).toBe(1500);
        expect(adv.basis).toContain("end_kept_at_tuning_band_top:150Hz");
        expect(adv.basis).toContain("supported_band_short_of_tuning_band:3.1-67.0Hz:requirement_not_lowered");
        expect(adv.basis).toContain("amplitude_unchanged:not_raised_for_coherence");
        // Less gain than the 1.5× rule would claim: the band kept for the goals costs excitation per octave.
        const free = sweepAdviceFor(sweep, band, null)!;
        expect(free.suggested!.chirp_frequency_end_deci_hz).toBe(1100);
        expect(adv.suggested!.excitationGainDb).toBeLessThan(free.suggested!.excitationGainDb);
    });

    it("a tuning band inside the supported band is covered and leaves the 1.5× rule in force", () => {
        const adv = sweepAdviceFor(sweep, band, [5, 50])!;
        expect(adv.bandSufficientForTuning).toBe(true);
        expect(adv.suggested!.chirp_frequency_end_deci_hz).toBe(1100);
        expect(adv.basis.some((b) => b.startsWith("end_kept_at_tuning_band_top"))).toBe(false);
        expect(sweepAdviceFor(sweep, band, null)!.bandSufficientForTuning).toBeNull();
    });

    it("through the chain the advice carries the planner's band and the need follows it", () => {
        const r = run(decoded({ plants: [G, G, null], sweepS: 12, seed: 61, jio: DISTURBANCE }, "chain.bbl"));
        for (const axis of ["roll", "pitch"] as const) {
            const a = r.jio.analysis.axes[axis]!;
            const plan = r.jio.chain[axis]!.plan!;
            expect(a.sweepAdvice!.tuningBandHz).toEqual(plan.bandHz.primary);
            const need = `required_measurement:chirp_${axis}_supported_to_tuning_band`;
            if (a.sweepAdvice!.bandSufficientForTuning === false) {
                expect(r.jio.requiredMeasurements).toContain(need);
                expect(r.jio.progress[axis]!.bandHz.sufficientForTuning).toBe(false);
            } else expect(r.jio.requiredMeasurements).not.toContain(need);
            expect(r.jio.progress[axis]!.bandHz.tuningGoal).toEqual(plan.bandHz.primary);
            if (a.sweepAdvice!.suggested && plan.bandHz.primary)
                expect(a.sweepAdvice!.suggested.chirp_frequency_end_deci_hz / 10).toBeGreaterThanOrEqual(
                    plan.bandHz.primary[1] - 1e-9,
                );
        }
        expect(JIO_SWEEP.completeSweepFraction).toBe(0.98);
        noValidated(r);
    }, 120_000);
});
