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
 * WP3 measurement planner (engine/measurementPlan.ts): the next CHIRP flight's band, resolution,
 * segment length and averages follow from the loop this flight identified, by the rules the
 * margin evidence applies. Analytic SIMULATION plants; reference values recomputed here from the
 * stated formulas.
 */

import { describe, expect, it } from "vitest";
import { declaredSupport } from "./harness/frequencySupport";
import { declaredResolution } from "./harness/resolutionConvergence";
import {
    air65RollConfig,
    cdiv,
    cmul,
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
    loopMargins,
    LOOP_RESOLUTION,
    QUALIFICATION_BAND_EXTENSION,
    RESOLVED_FEATURE_BINS,
    UNCERTAINTY,
    type AnalysisProvenance,
} from "../../src/gyrocore/engine/loopModel";
import { PLAN, planMeasurement } from "../../src/gyrocore/engine/measurementPlan";
import { runAutotuneV2 } from "../../src/gyrocore/engine/autotuneV2";
import type { EffectiveChain } from "../../src/gyrocore/engine/gyroChain";
import { syntheticLogInput } from "./harness/syntheticLog";

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
const SWEEP = { f0Hz: 1, f1Hz: 400, durationS: 20 };
const pow2 = (x: number) => 2 ** Math.ceil(Math.log2(x));
/** The standard analysis of the synthetic bins (0.5 Hz: a segment of 8192 at 4 kHz). */
const ANALYSIS = { segmentSamples: 8192, sampleRateHz: 4000, windowSamples: 80000, segments: 18 };
function plan(
    g: G,
    coherence: (f: number) => number,
    freqs = uniform(200, 0.5),
    analysis: AnalysisProvenance | null = ANALYSIS,
) {
    const tf = syntheticTransferFunctionWithCoherence(freqs, T(g), coherence);
    const loop = buildAxisLoop(0, tf, cfg, UNITY_CHAIN, true, true, null, {
        sweep: SWEEP,
        support: declaredSupport(tf),
        ...declaredResolution(),
    });
    const m = loopMargins(loop);
    return { p: planMeasurement("roll", loop, m, 4000, SWEEP, analysis), m, loop };
}

describe("the plan follows the evidence rules", () => {
    const { p, m, loop } = plan(smooth, () => 0.995);

    it("band: from a quarter of the crossover up to |L| ≤ −12 dB; a qualification 1.5× further", () => {
        expect(p.crossoverHz).toBeCloseTo(m.crossoverHz!, 9);
        expect(p.bandHz.primary![0]).toBeCloseTo(m.crossoverHz! / 4, 9);
        const fc = m.crossoverHz!;
        const L = (f: number) => cmul(smooth(f), evaluateControllerFrf(cfg, f).cFeedback);
        const db = (f: number) => 20 * Math.log10(Math.hypot(L(f).re, L(f).im));
        expect(db(p.bandHz.primary![1])).toBeLessThanOrEqual(PLAN.bandEndDb + 1e-9);
        expect(db(p.bandHz.primary![1] - 0.5)).toBeGreaterThan(PLAN.bandEndDb);
        expect(p.bandHz.primary![1]).toBeGreaterThan(fc);
        expect(p.bandHz.qualification![1]).toBeCloseTo(QUALIFICATION_BAND_EXTENSION * 200, 6);
    });

    it("resolution: the steepest phase step within the step limit; a qualification RESOLVED_FEATURE_BINS × finer", () => {
        expect(p.resolutionHz.now).toBeCloseTo(0.5, 9);
        expect(p.resolutionHz.primary!).toBeLessThanOrEqual(LOOP_RESOLUTION.maxRelativeSpacing * (m.crossoverHz! / 2));
        expect(p.resolutionHz.qualification!).toBeCloseTo(
            Math.min(p.resolutionHz.primary!, 0.5) / RESOLVED_FEATURE_BINS,
            9,
        );
        // The qualification: the power-of-two Welch segment at 4 kHz that gives at least its resolution.
        const nq = p.segmentSamples.qualification!;
        expect(Math.log2(nq) % 1).toBe(0);
        expect(4000 / nq).toBeLessThanOrEqual(p.resolutionHz.qualification! + 1e-9);
        expect(4000 / (nq / 2)).toBeGreaterThan(p.resolutionHz.qualification!);
        // The primary: the standard analysis's own segment (finer than needed here), never a shorter one
        // the import would not use (its dwell would be planned 16× too short at 512 against 2048).
        expect(p.segmentSamples.primary).toBe(ANALYSIS.segmentSamples);
        expect(4000 / p.segmentSamples.primary!).toBeLessThanOrEqual(p.resolutionHz.primary! + 1e-9);
    });

    it("averages: n ≥ (1 − γ²) κ² / (2 γ² σ²) at the crossover, σ = 2.5° / 2", () => {
        const fc = m.crossoverHz!;
        const at = loop.plant.bins
            .filter((b) => b.status === "ok")
            .reduce((a, b) => (Math.abs(b.frequencyHz - fc) < Math.abs(a.frequencyHz - fc) ? b : a));
        const c = evaluateControllerFrf(cfg, at.frequencyHz);
        const t = T(smooth)(at.frequencyHz);
        const kappa =
            Math.hypot(c.cReference.re, c.cReference.im) /
            Math.hypot(
                ...((d) => [d.re, d.im])({
                    re: c.cReference.re - cmul(t, c.cFeedback).re,
                    im: c.cReference.im - cmul(t, c.cFeedback).im,
                }),
            );
        const g2 = 0.995;
        const sigma = ((PLAN.pmUncertaintyDeg / UNCERTAINTY.coverage) * Math.PI) / 180;
        expect(p.averages.needed).toBe(Math.max(1, Math.ceil(((1 - g2) * kappa * kappa) / (2 * g2 * sigma * sigma))));
        expect(p.averages.now).toBe(1);
        expect(p.requiredMeasurements).toContain("required_measurement:chirp_longer_sweep_for_averages");
        // One sweep over the planned band giving n averages at fc: T = n · Ts² · fc · ln(f1/f0)
        // (the analysis does not combine repeated sweeps, so the plan never asks for repeats).
        const Ts = p.segmentSamples.primary! / 4000;
        expect(p.sweep!.f0Hz).toBeCloseTo(p.bandHz.primary![0], 9);
        expect(p.sweep!.f1Hz).toBeCloseTo(p.bandHz.primary![1], 9);
        expect(p.sweep!.durationS).toBeCloseTo(
            Math.max(
                p.averages.needed! * Ts * Ts * fc * Math.log(p.sweep!.f1Hz / p.sweep!.f0Hz),
                (Ts * (UNCERTAINTY.minWelchSegments + 1)) / 2,
            ),
            6,
        );
        expect("repeats" in p.sweep!).toBe(false);
        const TsQ = p.segmentSamples.qualification! / 4000;
        expect(p.qualificationSweep!.durationS).toBeGreaterThanOrEqual((TsQ * (UNCERTAINTY.minWelchSegments + 1)) / 2);
        expect(p.qualificationSweep!.f1Hz).toBeCloseTo(p.bandHz.qualification![1], 9);
    });

    it("always asks for the model-class qualification flight; no change to any analysis", () => {
        expect(p.requiredMeasurements).toContain(
            "required_measurement:chirp_finer_resolution_model_class_qualification",
        );
        expect(loopMargins(loop)).toEqual(m);
    });
});

describe("the plan asks only for what a flight can deliver", () => {
    it("a finer primary resolution than the standard analysis's segment is not asked of the next flight", () => {
        // The import analyses 4 kHz with 2048-sample segments, whatever the sweep: 1.95 Hz bins.
        const fixed = { ...ANALYSIS, segmentSamples: 2048 };
        const { p } = plan(smooth, () => 0.995, uniform(200, 0.5), fixed);
        expect(4000 / p.resolutionHz.primary!).toBeGreaterThan(2048);
        expect(p.segmentSamples).toMatchObject({ primary: 2048, executable: 2048 });
        expect(p.diagnostics).toContain(
            `primary_resolution_needs_finer_analysis:2048<${pow2(4000 / p.resolutionHz.primary!)}`,
        );
        expect(p.requiredMeasurements).not.toContain("required_measurement:chirp_with_finer_frequency_resolution");
        // The finer resolution is the qualification's (its own finer analysis); the sweep is planned at 2048.
        expect(p.requiredMeasurements).toContain(
            "required_measurement:chirp_finer_resolution_model_class_qualification",
        );
        const Ts = 2048 / 4000;
        expect(p.sweep!.durationS).toBeGreaterThanOrEqual((Ts * (UNCERTAINTY.minWelchSegments + 1)) / 2);
    });

    it("without the standard analysis's segment, no primary segment or sweep is planned", () => {
        const { p } = plan(smooth, () => 0.995, uniform(200, 0.5), null);
        expect(p.segmentSamples.primary).toBeNull();
        expect(p.sweep).toBeNull();
        expect(p.diagnostics).toContain("primary_analysis_segment_unknown");
    });
});

describe("what the data show", () => {
    it("a coherence dip inside the band is named", () => {
        const { p } = plan(smooth, (f) => (f > 50 && f < 55 ? 0.5 : 0.999));
        expect(p.diagnostics.some((d) => /^coherence_dip:5[0-5]\.\d-5[0-5]\.\dHz$/.test(d))).toBe(true);
    });

    it("a step near the limit marks a possible narrow feature", () => {
        const x = (f: number) => f / 20;
        const resonant: G = (f) =>
            cmul(
                smooth(f),
                cdiv({ re: 1 - x(f) ** 2, im: 2 * 0.2 * x(f) }, { re: 1 - x(f) ** 2, im: 2 * 0.02 * x(f) }),
            );
        const { p } = plan(resonant, () => 0.999);
        expect(p.diagnostics.some((d) => d.startsWith("possible_narrow_feature:"))).toBe(true);
    });

    it("noise near the crossover is named", () => {
        const { p } = plan(smooth, () => 0.97);
        expect(p.diagnostics.some((d) => d.startsWith("measurement_noise_high_near_crossover:"))).toBe(true);
    });
});

describe("in the engine result", () => {
    it("every analysed axis has a plan, and its needs reach the margins part", () => {
        const r = runAutotuneV2({ primary: syntheticLogInput("1".repeat(64)), others: [], verifiedTune: null });
        expect(r.measurementPlan.map((p) => p.axis)).toEqual(["roll", "pitch", "yaw"]);
        const part = r.parts.find((x) => x.part === "phase_margin_robustness")!;
        for (const p of r.measurementPlan)
            for (const need of p.requiredMeasurements) expect(part.requiredMeasurements).toContain(need);
    }, 600_000);
});
