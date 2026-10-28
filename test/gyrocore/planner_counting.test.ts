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
 * Counting averages where the decisions are (planner safety repair 2026-10-28).
 *
 * Before: the planner targeted the averages at the crossover only, read κ back from the bin's error,
 * and the analysis rounded a bin with less than one segment of dwell up to one average (1.99995 → 1
 * in the planner's own arithmetic). Now one integer count serves planner and analysis; a bin below
 * one segment is UNKNOWN on the qualification path and counted as one, named, on the primary path
 * (loopModel SUB_SEGMENT_DWELL); the planner sizes the sweeps for every gain crossing, phase crossing
 * and the |S| peak, with κ taken from T and the controller.
 *
 * SIMULATION: analytic plants; software-contract evidence only.
 */

import { describe, expect, it } from "vitest";
import { declaredSupport } from "./harness/frequencySupport";
import { declaredResolution } from "./harness/resolutionConvergence";
import { expectPrimaryPlanDelivers, expectQualificationPlanDelivers } from "./harness/planContract";
import {
    air65RollConfig,
    evaluateControllerFrf,
    type Complex,
} from "../../src/js/blackbox/betaflight_digital_controller";
import {
    closedLoopFromPlant,
    plantFrf,
    syntheticTransferFunctionWithCoherence,
} from "../../src/js/blackbox/betaflight_open_loop";
import {
    buildAxisLoop,
    loopErrorGain,
    loopMargins,
    loopUncertainty,
    SUB_SEGMENT_DWELL,
    sweepAverages,
} from "../../src/gyrocore/engine/loopModel";
import { PLAN, planMeasurement } from "../../src/gyrocore/engine/measurementPlan";
import type { EffectiveChain } from "../../src/gyrocore/engine/gyroChain";

const UNITY_CHAIN: EffectiveChain = {
    samples: 1,
    frf: () => ({ re: 1, im: 0 }),
    spread: () => ({ phaseDeg: 0, gainDb: 0 }),
    medianLpf1Hz: 0,
    dynNotchHz: [],
};
const cfg = air65RollConfig();
type G = (f: number) => Complex;
const smooth: G = (f) => plantFrf(f, { K: 30, motorHz: 40, delayS: 0.002 });
const uniform = (end: number, step: number) => Array.from({ length: Math.round(end / step) }, (_, i) => (i + 1) * step);
const T = (g: G) => (f: number) => {
    const c = evaluateControllerFrf(cfg, f);
    return closedLoopFromPlant(g(f), c.cReference, c.cFeedback);
};
const FS = 4000;
const SWEEP = { f0Hz: 1, f1Hz: 400, durationS: 20 };
const ANALYSIS = { segmentSamples: 8192, sampleRateHz: FS, windowSamples: 80000, segments: 18 };

describe("one integer count, two policies for less than one segment", () => {
    // 0.5 Hz bins (8192 at 4 kHz) on a 20 s sweep 1 → 400 Hz: above ~5 Hz a bin's dwell is shorter than
    // one 2.048 s segment.
    const tf = syntheticTransferFunctionWithCoherence(uniform(200, 0.5), T(smooth), () => 0.995);
    tf.numSegments = 18;
    const m = { sweep: SWEEP, analysis: ANALYSIS };
    const sub = uniform(200, 0.5).filter((f) => sweepAverages(f, ANALYSIS, SWEEP) < 1);

    it("the policies are fixed per path", () => {
        expect(SUB_SEGMENT_DWELL).toEqual({ primary: "COUNTED_AS_ONE", qualification: "UNKNOWN" });
        expect(Object.isFrozen(SUB_SEGMENT_DWELL)).toBe(true);
        expect(sub.length).toBeGreaterThan(300);
    });

    it("qualification: such a bin's error is unknown; it bounds nothing", () => {
        const u = loopUncertainty(tf, cfg, m, "qualification");
        expect(u.relErr).not.toBeNull();
        for (const f of sub) {
            expect(u.relErr!.has(f)).toBe(false);
            expect(u.averagesByHz!.get(f)).toBe(0);
        }
        expect(u.averages![0]).toBe(0);
        expect(u.reasons).toContain(`uncertainty_unknown:dwell_below_one_segment:${sub.length}_bins`);
        expect(u.subSegmentBinsCountedAsOne).toBe(0);
    });

    it("primary: counted as one average, and said on every margin's budget", () => {
        const u = loopUncertainty(tf, cfg, m, "primary");
        for (const f of sub) {
            expect(u.relErr!.has(f)).toBe(true);
            expect(u.averagesByHz!.get(f)).toBe(1);
        }
        expect(u.subSegmentBinsCountedAsOne).toBe(sub.length);
        expect(u.reasons).toEqual([]);
        const loop = buildAxisLoop(0, tf, cfg, UNITY_CHAIN, true, true, null, {
            ...m,
            support: declaredSupport(tf),
            ...declaredResolution(),
        });
        const budget = loopMargins(loop).evidence.uncertaintyBudget;
        expect(budget?.systematic.notQuantified).toContain(`sub_segment_dwell_counted_as_one:${sub.length}_bins`);
    });

    it("a long enough sweep needs no policy: every bin has its whole segments (positive control)", () => {
        // From 0.1 Hz: the 0.5 Hz bin lies below a 1 Hz start and would have no dwell at all (unknown).
        // 200 Hz, 0.5 Hz bins: dwell = T · ln(200.25 / 199.75) / ln 4000 ≥ 2.048 s takes T ≳ 6.8 ks.
        const long = { f0Hz: 0.1, f1Hz: 400, durationS: 8000 };
        const u = loopUncertainty(tf, cfg, { sweep: long, analysis: ANALYSIS }, "qualification");
        expect(u.reasons).toEqual([]);
        expect(u.subSegmentBinsCountedAsOne).toBe(0);
        expect(u.averages![0]).toBeGreaterThanOrEqual(1);
    });

    it("κ is one expression for analysis and planner", () => {
        const f = 30;
        const u = loopUncertainty(
            syntheticTransferFunctionWithCoherence([f, f + 0.5], T(smooth), () => 0.99),
            cfg,
        );
        const eT = Math.sqrt(1 - 0.99) / (Math.sqrt(0.99) * Math.sqrt(2));
        expect(u.relErr!.get(f)).toBeCloseTo(eT * loopErrorGain(T(smooth)(f), cfg, f), 12);
    });
});

describe("the planner counts at every decision, not at the crossover only", () => {
    const plan = (coherence: (f: number) => number) => {
        const tf = syntheticTransferFunctionWithCoherence(uniform(200, 0.5), T(smooth), coherence);
        tf.numSegments = 18;
        const loop = buildAxisLoop(0, tf, cfg, UNITY_CHAIN, true, true, null, {
            sweep: SWEEP,
            analysis: ANALYSIS,
            support: declaredSupport(tf),
            ...declaredResolution(),
        });
        return planMeasurement("roll", loop, loopMargins(loop), FS, SWEEP, ANALYSIS);
    };

    it("a poorly measured phase crossover drives the duration, not the crossover (outside the crossover)", () => {
        const fine = plan(() => 0.995);
        // Same loop, coherence low only around the phase crossover (≈ 66 Hz).
        const noisyPc = plan((f) => (f > 55 && f < 80 ? 0.9 : 0.995));
        const pc = noisyPc.averagesAt.find((a) => a.purpose === "phase_crossover")!;
        const gc = noisyPc.averagesAt.find((a) => a.purpose === "gain_crossover")!;
        expect(pc.needed!).toBeGreaterThan(fine.averagesAt.find((a) => a.purpose === "phase_crossover")!.needed!);
        expect(gc.needed).toBe(fine.averagesAt.find((a) => a.purpose === "gain_crossover")!.needed);
        expect(noisyPc.averages.needed).toBe(fine.averages.needed);
        expect(noisyPc.sweep!.durationS).toBeGreaterThan(fine.sweep!.durationS);
        expectPrimaryPlanDelivers(noisyPc, FS);
        expectQualificationPlanDelivers(noisyPc, FS);
        // The bin's own count from the planned sweep at the phase crossover, as the analysis would count it.
        expect(pc.primary!).toBeGreaterThanOrEqual(pc.needed!);
    });

    it("needed averages follow (1 − γ²) κ² / (2 γ² σ²) at each decision's bin", () => {
        const p = plan(() => 0.995);
        const sigma = ((PLAN.pmUncertaintyDeg / 2) * Math.PI) / 180;
        for (const a of p.averagesAt) {
            const bin = uniform(200, 0.5).reduce((b, f) => (Math.abs(f - a.hz) < Math.abs(b - a.hz) ? f : b));
            const k = loopErrorGain(T(smooth)(bin), cfg, bin);
            expect(a.needed).toBe(Math.max(1, Math.ceil((0.005 * k * k) / (2 * 0.995 * sigma * sigma))));
        }
    });

    it("the qualification sweep gives its highest bin a whole segment: the band end, not the crossover, sets it", () => {
        const p = plan(() => 0.995);
        expectQualificationPlanDelivers(p, FS);
        const N = p.segmentSamples.qualification!;
        const df = FS / N;
        const top = Math.floor(p.qualificationSweep!.f1Hz / df) * df;
        const shorter = { ...p.qualificationSweep!, durationS: p.qualificationSweep!.durationS * 0.99 };
        const a = { segmentSamples: N, sampleRateHz: FS, segments: Number.MAX_SAFE_INTEGER };
        const floorS = (N * 9) / 2 / FS;
        expect(shorter.durationS < floorS || sweepAverages(top, a, shorter) < 1).toBe(true);
    });

    it("unknown coherence at a decision: no qualification sweep, named; a neighbour's coherence is never borrowed", () => {
        // Coherence 0 at the phase crossover's bins (≈ 66 Hz): γ² unknown there. The crossing is still
        // read between the coherent bins either side (60 and 72 Hz), but its averages cannot be planned.
        const p = plan((f) => (f > 60 && f < 72 ? 0 : 0.995));
        const pc = p.averagesAt.find((a) => a.purpose === "phase_crossover")!;
        expect(pc.hz).toBeGreaterThan(60);
        expect(pc.hz).toBeLessThan(72);
        expect(pc.needed).toBeNull();
        expect(pc.primary).toBeNull();
        expect(p.diagnostics.some((d) => d.startsWith("averages_unknown_at:phase_crossover:"))).toBe(true);
        expect(p.qualificationSweep).toBeNull();
        expect(p.windowSamples.qualification).toBeNull();
        expect(p.diagnostics).toContain("qualification_not_planned:averages_unknown");
    });
});
