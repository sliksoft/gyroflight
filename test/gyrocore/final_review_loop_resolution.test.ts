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
 * Codex final review F-02: a narrow pole/zero resonance between two 0.5 Hz bins (70.25, 100.25 or
 * 150.25 Hz) took the loop above unity while loopMargins reported VALIDATED PM / GM / |S| from the
 * bins alone. The bins now have to resolve the loop (loopModel.ts LOOP_RESOLUTION) before margins
 * count as bounds; the resolution is reported and the basis named (evidence.resolutionHz /
 * evidence.level). Bounds the bins resolve are MODEL_CONDITIONAL until a finer, independent log
 * qualifies the model class (final_review_f02_evidence.test.ts): here that qualification is
 * absent, so "would be VALIDATED" means MODEL_CONDITIONAL with the model-class reasons as the only
 * blockers (conditionalOnly).
 *
 * References are independent of the code under test: the exact analytic |L| at the resonance, and
 * PM / GM / |S| of the analytic loop on a 0.002 Hz grid with this file's own crossing search.
 * The plant is the review's (K = 30, motor pole 40 Hz, 2 ms delay) under the AIR65 roll controller.
 */

import { describe, expect, it } from "vitest";
import { declaredSupport, declaredMeasurement } from "./harness/frequencySupport";
import { declaredResolution } from "./harness/resolutionConvergence";
import {
    air65RollConfig,
    cadd,
    cdiv,
    cmag,
    cmul,
    cphaseDeg,
    evaluateControllerFrf,
    type Complex,
} from "../../src/js/blackbox/betaflight_digital_controller";
import { closedLoopFromPlant, plantFrf, syntheticTransferFunction } from "../../src/js/blackbox/betaflight_open_loop";
import {
    BIN_SAGITTA,
    buildAxisLoop,
    LOOP_RESOLUTION,
    loopMargins,
    RESOLVED_FEATURE_BINS,
} from "../../src/gyrocore/engine/loopModel";
import type { EffectiveChain } from "../../src/gyrocore/engine/gyroChain";
import { optimizeAxisPid } from "../../src/gyrocore/engine/pidOptimizer";

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
/** Stable 2nd-order pole/zero pair at fr: peak |R(fr)| = zZero / zPole. */
const poleZero =
    (fr: number, zZero: number, zPole: number, base: G = smooth): G =>
    (f) => {
        const x = f / fr;
        return cmul(base(f), cdiv({ re: 1 - x * x, im: 2 * zZero * x }, { re: 1 - x * x, im: 2 * zPole * x }));
    };

const loopOf = (G: G) => (f: number) => cmul(G(f), evaluateControllerFrf(cfg, f).cFeedback);
const db = (x: number) => 20 * Math.log10(x);

/** The blockers of bounds without a model-class qualification (and nothing else open). */
const MODEL_CLASS_REASONS = [
    "model_class_not_qualified",
    "model_class_qualification_missing",
    "required_measurement:chirp_finer_resolution_model_class_qualification",
];
const conditionalOnly = (m: { reasons: string[] }) => JSON.stringify(m.reasons) === JSON.stringify(MODEL_CLASS_REASONS);

function margins(freqs: number[], G: G) {
    const tf = syntheticTransferFunction(freqs, (f) => {
        const c = evaluateControllerFrf(cfg, f);
        return closedLoopFromPlant(G(f), c.cReference, c.cFeedback);
    });
    const steps = freqs.slice(1).map((f, i) => f - freqs[i]);
    const minStep = Math.min(...steps);
    const sampleRateHz = 4000;
    // Matching analysed window for the sweep (Codex Gate 1). Convergence remains the declared
    // 0.5 Hz SIMULATION verdict (declaredResolution); analysis segment matches the TF grid for dwell.
    return loopMargins(
        buildAxisLoop(0, tf, cfg, UNITY_CHAIN, true, true, null, {
            support: declaredSupport(tf),
            ...declaredResolution(),
            ...declaredMeasurement({
                sampleRateHz,
                segmentSamples: Math.round(sampleRateHz / minStep),
                segments: Math.max(tf.numSegments, 8),
            }),
        }),
    );
}

/** Independent reference: PM (every unity crossing), GM (every phase crossing) and max |S| of the analytic loop. */
function oracle(G: G, from: number, to: number, step = 0.002) {
    const L = loopOf(G);
    let pm = Infinity;
    let gm = Infinity;
    let s = -Infinity;
    let prev: { m: number; ph: number } | null = null;
    let offset = 0;
    for (let f = from; f <= to; f += step) {
        const l = L(f);
        const m = cmag(l);
        let ph = cphaseDeg(l) + offset;
        const turn = prev && ph - prev.ph > 180 ? -360 : prev && ph - prev.ph < -180 ? 360 : 0;
        offset += turn;
        ph += turn;
        s = Math.max(s, -db(cmag(cadd({ re: 1, im: 0 }, l))));
        if (prev) {
            if ((prev.m - 1) * (m - 1) <= 0) pm = Math.min(pm, 180 + ph);
            for (let n = Math.ceil((Math.min(prev.ph, ph) + 180) / 360); n * 360 - 180 <= Math.max(prev.ph, ph); n++) {
                gm = Math.min(gm, -db(m));
            }
        }
        prev = { m, ph };
    }
    return { pm, gm, s };
}

const uniform = (end: number, step: number) => Array.from({ length: Math.round(end / step) }, (_, i) => (i + 1) * step);
/** 0.5 Hz bins plus 0.002 Hz bins over fr ± 0.1 Hz (a non-uniform grid that resolves the pair). */
const refined = (fr: number) =>
    [
        ...uniform(200, 0.5).filter((f) => Math.abs(f - fr) > 0.1),
        ...Array.from({ length: 101 }, (_, i) => fr - 0.1 + i * 0.002),
    ].sort((a, b) => a - b);
const logGrid = (lo: number, hi: number, perDecade: number) => {
    const n = Math.floor(perDecade * Math.log10(hi / lo));
    return Array.from({ length: n + 1 }, (_, k) => lo * 10 ** (k / perDecade));
};
const jittered = (end: number, step: number) => uniform(end, step).map((f, i) => f + 0.3 * step * Math.sin(i * 1.7));

const REVIEW_CASES = [
    { fr: 70.25, zZero: 0.002, zPole: 0.0001 },
    { fr: 100.25, zZero: 0.005, zPole: 0.0001 },
    { fr: 150.25, zZero: 0.01, zPole: 0.0002 },
];

describe("F-02: margins count only where the bins resolve the loop", () => {
    it("the limits are the documented ones; the resolved feature width follows from the phase step", () => {
        expect(LOOP_RESOLUTION).toEqual({
            maxPhaseStepDeg: 25,
            maxGainStepDb: 2,
            maxPhaseSlopeDegPerNeper: 300,
            maxGainSlopeDbPerDecade: 80,
            maxGapRatio: 3,
            maxRelativeSpacing: 0.5,
        });
        // A resonance of −3 dB bandwidth w turns the phase by 2·atan(Δf / w) over a step Δf.
        const w = RESOLVED_FEATURE_BINS;
        expect(2 * Math.atan(1 / w) * (180 / Math.PI)).toBeCloseTo(LOOP_RESOLUTION.maxPhaseStepDeg, 6);
        expect(w).toBeGreaterThan(4.4);
        expect(w).toBeLessThan(4.6);
        expect(BIN_SAGITTA).toBeCloseTo(Math.tan((12.5 * Math.PI) / 180) / 2, 12);
    });

    for (const { fr, zZero, zPole } of REVIEW_CASES) {
        it(`review counterexample ${fr} Hz on 0.5 Hz bins: NOT_VALIDATED, GM and |S| unknown, the step named`, () => {
            // Independent: the analytic loop really leaves unity between the two bins.
            expect(cmag(loopOf(poleZero(fr, zZero, zPole))(fr))).toBeGreaterThan(1);
            const m = margins(uniform(200, 0.5), poleZero(fr, zZero, zPole));
            expect(m.status).toBe("NOT_VALIDATED");
            expect(m.evidence.level).toBe("MEASURED");
            expect(m.gainMarginDb).toBeNull();
            expect(m.sensitivityPeakDb).toBeNull();
            expect(m.evidence.resolutionHz).toBeCloseTo(0.5, 9);
            const lo = (Math.floor(fr * 2) / 2).toFixed(1);
            const hi = (Math.floor(fr * 2) / 2 + 0.5).toFixed(1);
            const step = m.reasons.find((r) => r.startsWith("loop_unresolved_between_bins:"));
            expect(step?.split(":")[1].split(",")).toContain(`${lo}-${hi}Hz`);
        });

        it(`${fr} Hz on a non-uniform grid that resolves the pair: the crossings are seen, NOT_VALIDATED`, () => {
            const m = margins(refined(fr), poleZero(fr, zZero, zPole));
            const ref = oracle(poleZero(fr, zZero, zPole), 0.5, 200);
            expect(ref.pm).toBeLessThan(0); // the reference loop is unstable at the re-entry
            expect(m.status).toBe("NOT_VALIDATED");
            expect(m.reasons.some((r) => r.startsWith("loop_gain_reenters_unity:"))).toBe(true);
            expect(m.phaseMarginDeg!).toBeLessThan(0);
            expect(m.gainMarginDb).toBeNull();
            expect(m.evidence.resolutionHz).toBeCloseTo(0.5, 6);
        });
    }

    it("a gap or a sparse band around the crossover is not a resolved band", () => {
        const holes = uniform(200, 0.5).filter((f) => f < 40 || f > 42.5);
        const gap = margins(holes, smooth);
        expect(gap.status).toBe("NOT_VALIDATED");
        expect(gap.reasons).toContain("identified_band_has_gaps");
        expect(gap.evidence.level).toBe("MEASURED");
        expect(gap.evidence.resolutionHz).toBeCloseTo(3.5, 9); // 39.5 → 43.0 Hz
        const sparse = margins([1, 5, 10, 20, 40, 60, 80, 100], smooth);
        expect(sparse.status).toBe("NOT_VALIDATED");
        expect(sparse.reasons.some((r) => r.startsWith("identified_band_too_coarse:5.0-10.0Hz"))).toBe(true);
        expect([sparse.gainMarginDb, sparse.sensitivityPeakDb]).toEqual([null, null]);
    });

    it("the top 10 % of the band is a frequency span: a cluster of bins at the end does not hide a rise", () => {
        // Codex's grid: 1..98 Hz in 1 Hz steps plus 200 bins between 99 and 100 Hz, resonance at 120 Hz.
        const freqs = [...uniform(98, 1), ...Array.from({ length: 200 }, (_, i) => 99 + i / 200)];
        const m = margins(freqs, poleZero(120, 1, 0.02));
        expect(m.status).toBe("NOT_VALIDATED");
        expect(m.reasons.some((r) => r.startsWith("loop_gain_rising_at_band_end:+"))).toBe(true);
        expect([m.gainMarginDb, m.sensitivityPeakDb]).toEqual([null, null]);
    });

    it("the band-end thresholds hold on both sides with a continuous loop", () => {
        // |L| follows the smooth loop up to 150 Hz, blends into a straight dB line ending at endDb
        // with the given rise over 180.5–200 Hz (the top 10 % of a 0.5–200 Hz band), phase unchanged.
        const shaped =
            (rise: number, endDb: number): G =>
            (f) => {
                const g = smooth(f);
                if (f < 150) return g;
                const base = db(cmag(loopOf(smooth)(f)));
                const line = endDb - rise + (rise * (f - 180.5)) / 19.5;
                const u = Math.min(1, (f - 150) / 30.5);
                const w = (1 - Math.cos(Math.PI * u)) / 2;
                const k = 10 ** (((1 - w) * base + w * line - base) / 20);
                return { re: g.re * k, im: g.im * k };
            };
        for (const [rise, endDb, ok] of [
            [0.999, -7, true],
            [1.001, -7, false],
            [0, -6.001, true],
            [0, -5.999, false],
        ] as const) {
            const m = margins(uniform(200, 0.5), shaped(rise, endDb));
            expect(m.reasons.filter((r) => r.startsWith("loop_unresolved"))).toEqual([]);
            expect(m.status).toBe("NOT_VALIDATED");
            expect(conditionalOnly(m)).toBe(ok);
            expect(m.evidence.level).toBe(ok ? "MODEL_CONDITIONAL" : "MEASURED");
        }
    });
});

describe("F-02: well-supported smooth loops keep their margins", () => {
    const ref = oracle(smooth, 0.5, 200);
    const grids: [string, number[]][] = [
        ["uniform 0.5 Hz", uniform(200, 0.5)],
        ["uniform 1.95 Hz (AIR65 Welch bins)", uniform(200, 1.953125)],
        ["log-spaced, 60 per decade", logGrid(1, 200, 60)],
        ["jittered 0.5 Hz", jittered(200, 0.5)],
    ];
    for (const [name, freqs] of grids) {
        it(`smooth plant on a ${name} grid: model-conditional bounds that match the independent reference`, () => {
            const m = margins(freqs, smooth);
            expect(m.reasons).toEqual(MODEL_CLASS_REASONS);
            expect(m.status).toBe("NOT_VALIDATED");
            expect(m.evidence.level).toBe("MODEL_CONDITIONAL");
            const steps = freqs.slice(1).map((f, i) => f - freqs[i]);
            expect(m.evidence.resolutionHz).toBeCloseTo(Math.max(...steps), 9);
            // PM bounded like GM and |S|: never better than the reference, and only the between-bin
            // allowance worse (largest on the coarsest grid).
            expect(m.phaseMarginDeg!).toBeLessThanOrEqual(ref.pm + 0.05);
            expect(ref.pm - m.phaseMarginDeg!).toBeLessThan(2);
            // Measured: read on the bins, close to the reference. Bounded: never better than the
            // reference, and only the between-bin allowance worse.
            expect(Math.abs(m.measured.sensitivityPeakDb! - ref.s)).toBeLessThan(0.2);
            expect(m.gainMarginDb!).toBeLessThanOrEqual(ref.gm + 0.05);
            expect(m.sensitivityPeakDb!).toBeGreaterThanOrEqual(ref.s - 0.05);
            expect(m.sensitivityPeakDb! - ref.s).toBeLessThan(1);
        });
    }

    it("a resonance the bins resolve (ζ 0.05 / 0.1 at 70 Hz, 7 Hz wide) keeps model-conditional reference margins", () => {
        const G = poleZero(70, 0.1, 0.05);
        const r = oracle(G, 0.5, 200);
        const m = margins(uniform(200, 0.5), G);
        expect(conditionalOnly(m)).toBe(true);
        expect(m.evidence.level).toBe("MODEL_CONDITIONAL");
        expect(Math.abs(m.phaseMarginDeg! - r.pm)).toBeLessThan(1);
        expect(m.gainMarginDb!).toBeLessThanOrEqual(r.gm + 0.05);
        expect(Math.abs(m.measured.sensitivityPeakDb! - r.s)).toBeLessThan(0.2);
        expect(m.sensitivityPeakDb!).toBeGreaterThanOrEqual(r.s - 0.05);
    });
});

describe("F-02: at the edge of the resolved class (features ≈ 5 bin steps wide)", () => {
    // Pole −3 dB bandwidth 2·ζ·fr = 2.5 Hz = 5 bins of 0.5 Hz, centred between two bins. Peak ratios
    // 4 and 6 take |L| at the resonance to ≈ 0.8 (near-critical) and ≈ 1.2 (unstable).
    const fr = 70.25;
    const zPole = 2.5 / (2 * fr);
    for (const ratio of [4, 6]) {
        it(`peak ×${ratio}: refused, or bounded margins that are no better than the reference`, () => {
            const G = poleZero(fr, ratio * zPole, zPole);
            const ref = oracle(G, 0.5, 200);
            const m = margins(uniform(200, 0.5), G);
            if (ref.pm < 0 || ref.gm < 0) expect(m.status).toBe("NOT_VALIDATED");
            if (m.evidence.level === "MODEL_CONDITIONAL") {
                // The bounds hold at the class edge (the bins alone under-read |S| here).
                expect(m.gainMarginDb!).toBeLessThanOrEqual(ref.gm + 0.05);
                expect(m.sensitivityPeakDb!).toBeGreaterThanOrEqual(ref.s - 0.05);
                expect(m.phaseMarginDeg!).toBeLessThanOrEqual(ref.pm + 1);
            } else {
                expect(m.status).toBe("NOT_VALIDATED");
            }
        });
    }
});

describe("F-02: the PID search names the measurement an unresolved band needs", () => {
    it("GM / |S| unknown from a gap asks for finer resolution, not a higher CHIRP end", () => {
        const freqs = uniform(200, 0.5).filter((f) => f < 40 || f > 42.5);
        const tf = syntheticTransferFunction(freqs, (f) => {
            const c = evaluateControllerFrf(cfg, f);
            return closedLoopFromPlant(smooth(f), c.cReference, c.cFeedback);
        });
        const loop = buildAxisLoop(0, tf, cfg, UNITY_CHAIN, true, true, null, {
            support: declaredSupport(tf),
            ...declaredResolution(),
            ...declaredMeasurement(),
        });
        const r = optimizeAxisPid(loop, { p: cfg.axis.p, i: cfg.axis.i, d: cfg.axis.d, dMax: 0 }, null);
        expect(r.reasons).toContain("required_measurement:chirp_with_finer_frequency_resolution");
        expect(r.reasons).not.toContain("required_measurement:chirp_to_higher_frequency_for_gain_margin");
        expect(r.reasons).not.toContain("required_measurement:chirp_to_higher_frequency_for_sensitivity_peak");
    });
});

describe("F-02: the validity limit is stated, not removed", () => {
    it("a pair narrower than the resolved feature width leaves no trace: bounds only MODEL_CONDITIONAL, never VALIDATED", () => {
        // Both bandwidths far below RESOLVED_FEATURE_BINS × 0.5 Hz: each bin moves < 0.1 dB and
        // ~7°, yet |L(fr)| ≈ 2. No finite set of bins can exclude this, so the bounds carry that
        // model assumption explicitly and do not count as VALIDATED (Codex final acceptance F-02).
        const fr = 70.25;
        const G = poleZero(fr, 0.0005, 0.00005);
        expect(cmag(loopOf(G)(fr))).toBeGreaterThan(1);
        const m = margins(uniform(200, 0.5), G);
        expect(2 * 0.0005 * fr).toBeLessThan(RESOLVED_FEATURE_BINS * m.evidence.resolutionHz!);
        expect(m.evidence.minFeatureWidthHz).toBeCloseTo(RESOLVED_FEATURE_BINS * 0.5, 9);
        expect(m.evidence.level).toBe("MODEL_CONDITIONAL");
        expect(m.status).toBe("NOT_VALIDATED");
        expect(m.reasons).toEqual(MODEL_CLASS_REASONS);
        // The same loop on bins that resolve the pair is refused.
        expect(margins(refined(fr), G).status).toBe("NOT_VALIDATED");
    });
});
