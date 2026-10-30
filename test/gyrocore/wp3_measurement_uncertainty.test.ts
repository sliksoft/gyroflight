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
 * WP3 (audit F-02): measurement uncertainty and the checks of the phase the margins are read on
 * (loopModel UNCERTAINTY, PHASE_CHECKS). Every plant here is an analytic SIMULATION; the reference
 * values are the Bendat & Piersol formulas evaluated by hand, not the code under test.
 */

import { describe, expect, it } from "vitest";
import { declaredSupport, declaredMeasurement } from "./harness/frequencySupport";
import { declaredResolution } from "./harness/resolutionConvergence";
import {
    air65RollConfig,
    cmul,
    evaluateControllerFrf,
    type Complex,
} from "../../src/js/blackbox/betaflight_digital_controller";
import {
    closedLoopFromPlant,
    plantFrf,
    syntheticTransferFunction,
    syntheticTransferFunctionWithCoherence,
} from "../../src/js/blackbox/betaflight_open_loop";
import {
    binsDroppedForUncertainty,
    buildAxisLoop,
    loopMargins,
    loopUncertainty,
    marginEvidenceIssues,
    sectorDistanceToMinusOne,
    sweepAverages,
    sweepDwellSamples,
    UNCERTAINTY,
} from "../../src/gyrocore/engine/loopModel";
import type { EffectiveChain } from "../../src/gyrocore/engine/gyroChain";
import { evaluateRelease, type AbsoluteProposal } from "../../src/gyrocore/releaseGate/releaseContract";
import { simulatedQualifiedEvidence } from "./harness/marginEvidenceFixture";

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
const marginsAt = (coherence: number, segments = 32) => {
    const tf = syntheticTransferFunctionWithCoherence(uniform(200, 0.5), T(smooth), () => coherence);
    tf.numSegments = segments;
    return loopMargins(
        buildAxisLoop(0, tf, cfg, UNITY_CHAIN, true, true, null, {
            support: declaredSupport(tf),
            ...declaredResolution(),
            ...declaredMeasurement(),
        }),
    );
};

describe("the random error of the identified loop (Bendat & Piersol 9.90 / 9.91)", () => {
    it("per bin: √(1 − γ²) / (|γ| √(2 n)) on T, times |C_ref / (C_ref − T·C_fb)| on L", () => {
        const f = 20;
        const g2 = 0.99;
        const tf = syntheticTransferFunctionWithCoherence([f, f + 0.5], T(smooth), () => g2);
        const u = loopUncertainty(tf, cfg);
        const t = T(smooth)(f);
        const c = evaluateControllerFrf(cfg, f);
        const den = { re: c.cReference.re - cmul(t, c.cFeedback).re, im: c.cReference.im - cmul(t, c.cFeedback).im };
        const kappa = Math.hypot(c.cReference.re, c.cReference.im) / Math.hypot(den.re, den.im);
        // No sweep declared: classical Welch n = floor((numSegments+1)/2) (not invent n=1).
        const n = Math.floor((tf.numSegments + 1) / 2);
        const expected = (Math.sqrt(1 - g2) / (Math.sqrt(g2) * Math.sqrt(2 * n))) * kappa;
        expect(u.relErr!.get(f)).toBeCloseTo(expected, 12);
    });

    it("averages for an exponential sweep: whole segments in the bin's dwell, counted in whole samples; 0 is unknown, never 1", () => {
        const sweep = { f0Hz: 1, f1Hz: 400, durationS: 20 };
        // AIR65-like: 512-sample segments at 1 kHz (1.953 Hz bins), 77 of them.
        const a = { segmentSamples: 512, sampleRateHz: 1000, segments: 77 };
        const dwell = (f: number) => sweepDwellSamples(f, 1000 / 512, 1000, sweep);
        // The dwell is the integer difference of the sweep's sample indices at the bin's edges.
        const L = Math.log(400);
        const t = (f: number) => (20 * Math.log(f)) / L;
        expect(dwell(2)).toBe(Math.floor(1000 * t(2 + 1000 / 1024)) - Math.floor(1000 * t(2 - 1000 / 1024)));
        expect(sweepAverages(2, a, sweep)).toBe(Math.floor(dwell(2) / 512));
        expect(sweepAverages(2, a, sweep)).toBe(6);
        // 40 Hz: 163 samples of dwell, less than one 512-sample segment: unknown (was rounded up to 1).
        expect(dwell(40)).toBeLessThan(512);
        expect(sweepAverages(40, a, sweep)).toBe(0);
        // Below the sweep's start nothing was excited (was 39 by the continuous formula's cap).
        expect(sweepAverages(0.01, a, sweep)).toBe(0);
        // Without the sweep or the analysis: unknown (was 1).
        expect(sweepAverages(40, a, null)).toBe(0);
        expect(sweepAverages(40, null, sweep)).toBe(0);
        // At most the window's non-overlapping segments.
        expect(sweepAverages(1.5, { ...a, segments: 3 }, { ...sweep, durationS: 2000 })).toBe(2);
        // Observed window only: a day-long header's first 20 s barely leave 1 Hz, so the 2 Hz and
        // 40 Hz bins have no dwell in that window — never invent averages from unobserved time
        // (Codex review 2026-10-28, P2).
        const longHeader = { f0Hz: 1, f1Hz: 400, durationS: 86_400 };
        expect(sweepAverages(2, a, longHeader)).toBeGreaterThan(0);
        expect(sweepAverages(2, a, longHeader, 20_000)).toBe(0);
        expect(sweepAverages(40, a, longHeader, 20_000)).toBe(0);
        // A matching 20 s sweep does observe 2 Hz.
        expect(sweepAverages(2, a, { f0Hz: 1, f1Hz: 400, durationS: 20 }, 20_000)).toBeGreaterThan(0);
    });

    it("loopUncertainty clips dwell to the analysis window and rejects a header with no observed window", () => {
        const sweep = { f0Hz: 1, f1Hz: 400, durationS: 86_400 };
        const tf = syntheticTransferFunctionWithCoherence([2, 40], T(smooth), () => 0.995);
        tf.numSegments = 18;
        // Ambiguous: sweep header without an analysed window → no averages on either path.
        const noWindow = loopUncertainty(tf, cfg, {
            sweep,
            analysis: { segmentSamples: 512, sampleRateHz: 1000, windowSamples: 0, segments: 18 },
        });
        expect(noWindow.averagesByHz!.get(2)).toBe(0);
        expect(noWindow.averagesByHz!.get(40)).toBe(0);
        expect(noWindow.reasons).toContain("uncertainty_unknown:sweep_without_observed_window");
        expect(noWindow.subSegmentBinsCountedAsOne).toBe(0);
        // Same when analysis is omitted or null: never invent COUNTED_AS_ONE averages (Codex Gate 1).
        for (const m of [{ sweep }, { sweep, analysis: null }] as const) {
            const u = loopUncertainty(tf, cfg, m);
            expect(u.averagesByHz!.get(2)).toBe(0);
            expect(u.averagesByHz!.get(40)).toBe(0);
            expect(u.reasons).toContain("uncertainty_unknown:sweep_without_observed_window");
            expect(u.subSegmentBinsCountedAsOne).toBe(0);
        }
        // Observed 20 s of a day-long exponential: still below 2 Hz → both bins unknown.
        const clipped = loopUncertainty(
            tf,
            cfg,
            { sweep, analysis: { segmentSamples: 512, sampleRateHz: 1000, windowSamples: 20_000, segments: 18 } },
            "qualification",
        );
        expect(clipped.averagesByHz!.get(2)).toBe(0);
        expect(clipped.averagesByHz!.get(40)).toBe(0);
        expect(clipped.reasons.some((r) => r.startsWith("uncertainty_unknown:dwell_below_one_segment:"))).toBe(true);
    });

    it("the count never exceeds what the continuous dwell allows (property)", () => {
        const sweep = { f0Hz: 2, f1Hz: 300, durationS: 37.3 };
        for (const [N, fs] of [
            [512, 1000],
            [2048, 4000],
            [4096, 4032.258],
            [1024, 1000],
        ] as const) {
            const L = Math.log(300 / 2);
            for (let f = 2.2; f < 300; f *= 1.07) {
                const df = fs / N;
                const lo = Math.max(f - df / 2, 2);
                const hi = Math.min(f + df / 2, 300);
                const continuous = (fs * 37.3 * Math.log(hi / lo)) / L;
                const n = sweepAverages(f, { segmentSamples: N, sampleRateHz: fs, segments: 10_000 }, sweep);
                expect(Number.isInteger(n)).toBe(true);
                expect(n * N).toBeLessThanOrEqual(continuous + 1);
            }
        }
    });

    it("fewer than the minimum Welch segments: the uncertainty is unknown (one segment has γ² ≡ 1)", () => {
        const one = syntheticTransferFunction(uniform(200, 0.5), T(smooth));
        one.numSegments = 1;
        expect(loopUncertainty(one, cfg).relErr).toBeNull();
        const m = loopMargins(
            buildAxisLoop(0, one, cfg, UNITY_CHAIN, true, true, null, {
                support: declaredSupport(one),
                ...declaredResolution(),
                ...declaredMeasurement(),
            }),
        );
        expect(m.evidence.level).toBe("MEASURED");
        expect(m.gainMarginDb).toBeNull();
        expect(m.reasons).toContain("uncertainty_unknown:welch_segments:1");
        expect(UNCERTAINTY.minWelchSegments).toBeGreaterThan(1);
    });
});

describe("the uncertainty widens the bounds, never the measured values", () => {
    /** Long sweep (whole-segment dwell) but few Welch segments so ε stays large enough for adversarial cases. */
    const fewAverages = () => declaredMeasurement({ segments: UNCERTAINTY.minWelchSegments });

    it("lower coherence: lower PM and GM bounds, higher |S| bound; the bins' own values unchanged", () => {
        const exact = marginsAt(1);
        const noisy = marginsAt(0.999);
        expect(exact.evidence.uncertainty!.maxRelErr).toBe(0);
        expect(noisy.evidence.uncertainty!.maxRelErr).toBeGreaterThan(0);
        expect(noisy.measured).toEqual(exact.measured);
        expect(noisy.phaseMarginDeg!).toBeLessThan(exact.phaseMarginDeg! - 0.5);
        expect(noisy.gainMarginDb!).toBeLessThan(exact.gainMarginDb!);
        expect(noisy.sensitivityPeakDb!).toBeGreaterThan(exact.sensitivityPeakDb!);
        // The nominal reading is the same; even without error the bound includes the between-bin allowance.
        expect(noisy.evidence.uncertainty!.nominal.phaseMarginDeg).toBeCloseTo(
            exact.evidence.uncertainty!.nominal.phaseMarginDeg!,
            9,
        );
        expect(exact.phaseMarginDeg!).toBeLessThanOrEqual(exact.measured.phaseMarginDeg!);
    });

    it("a bin whose ±2ε reaches half its value is not identified: left out, counted", () => {
        const tf = syntheticTransferFunctionWithCoherence(uniform(200, 0.5), T(smooth), () => 0.97);
        tf.numSegments = UNCERTAINTY.minWelchSegments;
        const loop = buildAxisLoop(0, tf, cfg, UNITY_CHAIN, true, true, null, {
            support: declaredSupport(tf),
            ...declaredResolution(),
            ...fewAverages(),
        });
        const m = loopMargins(loop);
        expect(binsDroppedForUncertainty(loop).length).toBeGreaterThan(0);
        expect(m.evidence.bandHz![0]).toBeGreaterThan(2);
        // At this ε the admitted loops between the bins can reach −180° near unity: no bounds, named.
        expect(m.evidence.level).toBe("MEASURED");
        expect(m.reasons).toContain("margin_uncertainty_changes_what_the_bins_show:phase_crossover");
    });

    it("an unidentified bin inside the band (a poorly measured resonance would vanish there) leaves no bounds", () => {
        // One bin at 40 Hz with low coherence: used, but its ±2ε is too large: left out.
        // (F2: with whole-segment dwell + min Welch averages, γ²=0.81 no longer drops; 0.7 does.)
        const tf = syntheticTransferFunctionWithCoherence(uniform(200, 0.5), T(smooth), (f) => (f === 40 ? 0.7 : 1));
        tf.numSegments = UNCERTAINTY.minWelchSegments;
        const m = loopMargins(
            buildAxisLoop(0, tf, cfg, UNITY_CHAIN, true, true, null, {
                support: declaredSupport(tf),
                ...declaredResolution(),
                ...fewAverages(),
            }),
        );
        expect(m.reasons).toContain("unidentified_bins_inside_band:1");
        expect(m.evidence.level).toBe("MEASURED");
        expect(m.gainMarginDb).toBeNull();
    });

    it("an error that changes what the bins show (the crossings) leaves no bounds, named", () => {
        const hot = { ...cfg, axis: { ...cfg.axis, p: cfg.axis.p * 3.5 } };
        const tf = syntheticTransferFunctionWithCoherence(uniform(200, 0.5), T(smooth), () => 0.9);
        tf.numSegments = UNCERTAINTY.minWelchSegments;
        const m = loopMargins(
            buildAxisLoop(0, tf, cfg, UNITY_CHAIN, true, true, null, {
                support: declaredSupport(tf),
                ...declaredResolution(),
                ...fewAverages(),
            }),
            { cfg: hot },
        );
        expect(m.evidence.level).toBe("MEASURED");
        expect(m.gainMarginDb).toBeNull();
        expect(m.reasons.some((r) => r.startsWith("margin_uncertainty_changes_what_the_bins_show:"))).toBe(true);
    });

    it("the release contract requires the uncertainty with the bounds (fail-closed)", () => {
        const good = simulatedQualifiedEvidence(50, 10, 4);
        expect(marginEvidenceIssues(good)).toEqual([]);
        expect(marginEvidenceIssues({ ...good, uncertainty: undefined })).toContain(
            "margin_evidence_uncertainty_missing",
        );
        expect(marginEvidenceIssues({ ...good, uncertainty: { ...good.uncertainty!, coverage: 1 } })).toContain(
            "margin_evidence_uncertainty_missing",
        );
        expect(marginEvidenceIssues({ ...good, uncertainty: { ...good.uncertainty!, maxRelErr: 0.3 } })).toContain(
            "margin_evidence_uncertainty_missing",
        );
    });

    it("release flips on the uncertainty: a PM just above target is not released once its error is counted", () => {
        // The smooth loop with P × 3.5: nominal PM ≈ 45.5°; few averages at γ² = 0.95 widens it below 40°.
        // (F2: long chirp dwell gives whole segments; cap from minWelchSegments — never invent n=1.)
        const hot = { ...cfg, axis: { ...cfg.axis, p: cfg.axis.p * 3.5 } };
        const at = (g2: number) => {
            const tf = syntheticTransferFunctionWithCoherence(uniform(200, 0.5), T(smooth), () => g2);
            tf.numSegments = UNCERTAINTY.minWelchSegments;
            return loopMargins(
                buildAxisLoop(0, tf, cfg, UNITY_CHAIN, true, true, null, {
                    support: declaredSupport(tf),
                    ...declaredResolution(),
                    ...fewAverages(),
                }),
                { cfg: hot },
            );
        };
        const exact = at(1);
        const noisy = at(0.995);
        expect(exact.phaseMarginDeg!).toBeGreaterThan(40);
        expect(noisy.phaseMarginDeg!).toBeLessThan(40);
        expect(noisy.evidence.level).toBe("MODEL_CONDITIONAL");
        const proposalWith = (m: typeof exact): AbsoluteProposal => ({
            id: "p",
            createdAt: "2026-10-24T00:00:00Z",
            log: { sha256: "d".repeat(64), logIndex: 0, headerPairs: [] },
            change: { p_roll: 1 },
            items: [{ key: "p_roll", part: "pid", from: 0, to: 1, status: "VALIDATED", reasons: [] }],
            release: {
                measurement: { valid: true, reasons: [] },
                model: { status: "VALIDATED", reasons: [] },
                margins: [
                    {
                        axis: "roll",
                        status: "VALIDATED",
                        phaseMarginDeg: m.phaseMarginDeg,
                        gainMarginDb: 10,
                        sensitivityPeakDb: 4,
                        measured: m.measured,
                        evidence: simulatedQualifiedEvidence(m.phaseMarginDeg!, 10, 4),
                        reasons: [],
                    },
                ],
                independentValidation: null,
                safetyAnalysisEvidence: "available",
                safetyReasons: [],
            },
        });
        const pm = (m: typeof exact) =>
            evaluateRelease(proposalWith(m)).conditions.find((c) => c.name === "phase_margin")!;
        expect(pm(exact).passed).toBe(true);
        expect(pm(noisy).passed).toBe(false);
        expect(pm(noisy).reasons).toContain(`pm_below_target:roll:${noisy.phaseMarginDeg}`);
    });
});

describe("the bounds cover the whole uncertainty set, not a few samples of it (Codex WP8 P0-3)", () => {
    it("Codex's counterexample: L = 0.98∠−176° with ±2ε = ±10 % can reach −1, so the distance bound is 0", () => {
        const e = 0.1;
        const th = (-176 * Math.PI) / 180;
        expect(sectorDistanceToMinusOne(0.98 * (1 - e), 0.98 * (1 + e), th - e, th + e)).toBe(0);
        // The four corners alone stay away from −1: they were no bound.
        const corners = [1 - e, 1 + e].flatMap((g) =>
            [-e, e].map((a) => Math.hypot(0.98 * g * Math.cos(th + a) + 1, 0.98 * g * Math.sin(th + a))),
        );
        expect(Math.min(...corners)).toBeGreaterThan(0.01);
    });

    it("the sector distance is exact on simple geometry", () => {
        // A sector straddling angle π: radial distance; one beside it: the nearest boundary ray.
        expect(sectorDistanceToMinusOne(1.5, 2, Math.PI - 0.1, Math.PI + 0.1)).toBeCloseTo(0.5, 12);
        expect(sectorDistanceToMinusOne(1, 1, Math.PI / 2, Math.PI / 2)).toBeCloseTo(Math.SQRT2, 12);
        // Unwrapped angles: −180° is the same point as 180°.
        expect(sectorDistanceToMinusOne(0.5, 0.5, -Math.PI - 0.01, -Math.PI + 0.01)).toBeCloseTo(0.5, 12);
    });
});

describe("the phase the margins are read on", () => {
    it("an absolute branch the plant cannot have: unverified, no bounds", () => {
        // The same loop with its plant rotated by −180° at every bin: the rate plant's phase at the
        // lowest bin would lie below −180°, a branch the model class excludes.
        const rotated: G = (f) => cmul(smooth(f), { re: -1, im: 0 });
        const tf = syntheticTransferFunction(uniform(200, 0.5), T(rotated));
        const m = loopMargins(
            buildAxisLoop(0, tf, cfg, UNITY_CHAIN, true, true, null, {
                support: declaredSupport(tf),
                ...declaredResolution(),
                ...declaredMeasurement(),
            }),
        );
        expect(m.reasons.some((r) => r.startsWith("phase_branch_unverified:"))).toBe(true);
        expect(m.gainMarginDb).toBeNull();
        expect(m.evidence.level).not.toBe("MODEL_CONDITIONAL");
    });

    it("a crossover with too few bins around it: insufficiently resolved, no bounds", () => {
        // A coarse grid near the crossover (≈ 9.6 Hz): bins every 8 Hz.
        const coarse = [1, 2, 3, 4, 5, ...Array.from({ length: 24 }, (_, i) => 6 + i * 8)];
        const tf = syntheticTransferFunction(coarse, T(smooth));
        const m = loopMargins(
            buildAxisLoop(0, tf, cfg, UNITY_CHAIN, true, true, null, {
                support: declaredSupport(tf),
                ...declaredResolution(),
                ...declaredMeasurement(),
            }),
        );
        expect(m.reasons.some((r) => r.startsWith("crossover_insufficiently_resolved:"))).toBe(true);
        expect(m.gainMarginDb).toBeNull();
    });

    it("control: the smooth loop on a fine grid passes every phase check", () => {
        const m = marginsAt(1);
        expect(m.reasons.filter((r) => /^(phase_|crossover_insufficiently)/.test(r))).toEqual([]);
        expect(m.evidence.level).toBe("MODEL_CONDITIONAL");
        expect(m.evidence.assumptions).toContain("rate_plant_phase_in_minus180_0_at_lowest_bin");
    });
});
