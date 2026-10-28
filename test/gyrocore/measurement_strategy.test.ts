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
 * Practical measurement strategy: coverage ledger, narrow-band split, design comparison.
 * SIMULATION: planner-shaped inputs only; never flight evidence.
 */

import { describe, expect, it } from "vitest";
import type { AxisMeasurementPlan } from "../../src/gyrocore/engine/measurementPlan";
import {
    buildMeasurementStrategy,
    narrowBandAround,
    narrowSweepDurationS,
    SESSION,
} from "../../src/gyrocore/engine/measurementStrategy";

function stubPlan(over: Partial<AxisMeasurementPlan> = {}): AxisMeasurementPlan {
    return {
        axis: "roll",
        crossoverHz: 26,
        bandHz: { primary: [7.8, 97], qualification: [7.8, 150] },
        resolutionHz: { now: 7.8, primary: 7.8, qualification: 0.98 },
        segmentSamples: { primary: 512, qualification: 4096, executable: 512 },
        averages: { now: 1, needed: 9 },
        sweep: { f0Hz: 7.8, f1Hz: 97.4, durationS: 400 },
        qualificationSweep: { f0Hz: 7.8, f1Hz: 150, durationS: 30_000 },
        diagnostics: [],
        requiredMeasurements: ["required_measurement:chirp_longer_sweep_for_averages"],
        averagesAt: [
            { purpose: "gain_crossover", hz: 26, needed: 9, now: 1, primary: 9, qualification: 1 },
            { purpose: "phase_crossover", hz: 55, needed: 12, now: 0, primary: 4, qualification: 1 },
            { purpose: "sensitivity_peak", hz: 40, needed: 6, now: 1, primary: 6, qualification: 1 },
        ],
        windowSamples: { primary: 1_600_000, qualification: 120_000_000 },
        ...over,
    };
}

describe("narrow-band helpers", () => {
    it("clips a half-octave band to the parent band", () => {
        expect(narrowBandAround(26, [7.8, 97])).toEqual([26 / Math.SQRT2, 26 * Math.SQRT2]);
        expect(narrowBandAround(10, [7.8, 97])[0]).toBe(7.8);
    });

    it("a narrow sweep at the decision frequency is shorter than a full-band sweep for the same n", () => {
        const full = 400;
        const narrow = narrowSweepDurationS(26, 9, 512, 4000, [18, 37])!;
        expect(narrow).toBeLessThan(full);
        expect(narrow).toBeGreaterThan(0);
    });
});

describe("buildMeasurementStrategy", () => {
    it("marks adequate vs uncertain decisions and compares full vs narrow designs", () => {
        const s = buildMeasurementStrategy(stubPlan(), { sampleRateHz: 4000 });
        expect(s.decisions.find((d) => d.purpose === "gain_crossover")!.status).toBe("UNCERTAIN");
        expect(s.decisions.find((d) => d.purpose === "phase_crossover")!.status).toBe("MISSING");
        expect(s.sessions.some((x) => x.kind === "primary_full_band")).toBe(true);
        expect(s.sessions.some((x) => x.kind === "narrow_band_followup")).toBe(true);
        expect(s.sessions.some((x) => x.kind === "qualification_full_band")).toBe(true);
        expect(s.sessions.some((x) => x.kind === "repeat_independence")).toBe(true);
        expect(s.exceedsPracticalBudget).toBe(true);
        expect(s.blockedWithout.some((b) => b.startsWith("practical_qualification_needs_multi_session"))).toBe(true);
        expect(s.designNotes.some((n) => n.startsWith("design_B_narrow_followups_total:"))).toBe(true);
        expect(s.totalDurationS).toBeGreaterThan(SESSION.maxPracticalFlightS);
    });

    it("does not invent narrow sessions when the primary sweep already fits the practical budget", () => {
        const s = buildMeasurementStrategy(
            stubPlan({
                sweep: { f0Hz: 8, f1Hz: 80, durationS: 90 },
                qualificationSweep: null,
                windowSamples: { primary: 360_000, qualification: null },
            }),
            { sampleRateHz: 4000 },
        );
        expect(s.sessions.every((x) => x.kind !== "narrow_band_followup")).toBe(true);
        expect(s.exceedsPracticalBudget).toBe(false);
    });
});
