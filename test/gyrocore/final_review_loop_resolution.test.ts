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
 * count as bounds; the resolution is reported (resolutionHz) and the basis named (marginBasis).
 *
 * References are independent of the code under test: the exact analytic |L| at the resonance, and
 * PM / GM / |S| of the analytic loop on a 0.002 Hz grid with this file's own crossing search.
 * The plant is the review's (K = 30, motor pole 40 Hz, 2 ms delay) under the AIR65 roll controller.
 */

import { describe, expect, it } from "vitest";
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
    buildAxisLoop,
    LOOP_RESOLUTION,
    loopMargins,
    RESOLVED_FEATURE_BINS,
} from "../../src/gyrocore/engine/loopModel";
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
/** Stable 2nd-order pole/zero pair at fr: peak |R(fr)| = zZero / zPole. */
const poleZero =
    (fr: number, zZero: number, zPole: number, base: G = smooth): G =>
    (f) => {
        const x = f / fr;
        return cmul(base(f), cdiv({ re: 1 - x * x, im: 2 * zZero * x }, { re: 1 - x * x, im: 2 * zPole * x }));
    };

const loopOf = (G: G) => (f: number) => cmul(G(f), evaluateControllerFrf(cfg, f).cFeedback);
const db = (x: number) => 20 * Math.log10(x);

function margins(freqs: number[], G: G) {
    const tf = syntheticTransferFunction(freqs, (f) => {
        const c = evaluateControllerFrf(cfg, f);
        return closedLoopFromPlant(G(f), c.cReference, c.cFeedback);
    });
    return loopMargins(buildAxisLoop(0, tf, cfg, UNITY_CHAIN, true, true));
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
            maxGainSlopeDbPerDecade: 60,
            maxGapRatio: 3,
            maxRelativeSpacing: 0.5,
        });
        // A resonance of −3 dB bandwidth w turns the phase by 2·atan(Δf / w) over a step Δf.
        const w = RESOLVED_FEATURE_BINS;
        expect(2 * Math.atan(1 / w) * (180 / Math.PI)).toBeCloseTo(LOOP_RESOLUTION.maxPhaseStepDeg, 6);
        expect(w).toBeGreaterThan(4.4);
        expect(w).toBeLessThan(4.6);
    });

    for (const { fr, zZero, zPole } of REVIEW_CASES) {
        it(`review counterexample ${fr} Hz on 0.5 Hz bins: NOT_VALIDATED, GM and |S| unknown, the step named`, () => {
            // Independent: the analytic loop really leaves unity between the two bins.
            expect(cmag(loopOf(poleZero(fr, zZero, zPole))(fr))).toBeGreaterThan(1);
            const m = margins(uniform(200, 0.5), poleZero(fr, zZero, zPole));
            expect(m.status).toBe("NOT_VALIDATED");
            expect(m.marginBasis).toBe("measured_only");
            expect(m.gainMarginDb).toBeNull();
            expect(m.sensitivityPeakDb).toBeNull();
            expect(m.resolutionHz).toBeCloseTo(0.5, 9);
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
            expect(m.resolutionHz).toBeCloseTo(0.5, 6);
        });
    }

    it("a gap or a sparse band around the crossover is not a resolved band", () => {
        const holes = uniform(200, 0.5).filter((f) => f < 40 || f > 42.5);
        const gap = margins(holes, smooth);
        expect(gap.status).toBe("NOT_VALIDATED");
        expect(gap.reasons).toContain("identified_band_has_gaps");
        expect(gap.marginBasis).toBe("measured_only");
        expect(gap.resolutionHz).toBeCloseTo(3.5, 9); // 39.5 → 43.0 Hz
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
            expect(m.status).toBe(ok ? "VALIDATED" : "NOT_VALIDATED");
            expect(m.marginBasis).toBe(ok ? "bounded" : "measured_only");
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
        it(`smooth plant on a ${name} grid: VALIDATED, bounded, margins match the independent reference`, () => {
            const m = margins(freqs, smooth);
            expect(m.reasons).toEqual([]);
            expect(m.status).toBe("VALIDATED");
            expect(m.marginBasis).toBe("bounded");
            const steps = freqs.slice(1).map((f, i) => f - freqs[i]);
            expect(m.resolutionHz).toBeCloseTo(Math.max(...steps), 9);
            expect(Math.abs(m.phaseMarginDeg! - ref.pm)).toBeLessThan(1);
            // GM on the bins is capped by the band-end headroom; it never exceeds the reference.
            expect(m.gainMarginDb!).toBeLessThanOrEqual(ref.gm + 0.05);
            expect(Math.abs(m.sensitivityPeakDb! - ref.s)).toBeLessThan(0.2);
        });
    }

    it("a resonance the bins resolve (ζ 0.05 / 0.1 at 70 Hz, 7 Hz wide) stays VALIDATED with the reference margins", () => {
        const G = poleZero(70, 0.1, 0.05);
        const r = oracle(G, 0.5, 200);
        const m = margins(uniform(200, 0.5), G);
        expect(m.status).toBe("VALIDATED");
        expect(m.marginBasis).toBe("bounded");
        expect(Math.abs(m.phaseMarginDeg! - r.pm)).toBeLessThan(1);
        expect(m.gainMarginDb!).toBeLessThanOrEqual(r.gm + 0.05);
        expect(Math.abs(m.sensitivityPeakDb! - r.s)).toBeLessThan(0.2);
    });
});

describe("F-02: the validity limit is stated, not removed", () => {
    it("a pair narrower than the resolved feature width leaves no trace and still reads as bounded", () => {
        // Both bandwidths far below RESOLVED_FEATURE_BINS × 0.5 Hz: each bin moves < 0.1 dB and
        // ~7°, yet |L(fr)| ≈ 2. No finite set of bins can exclude this; the docs and the report
        // say so, and "bounded" means bounded for features at least that wide.
        const fr = 70.25;
        const G = poleZero(fr, 0.0005, 0.00005);
        expect(cmag(loopOf(G)(fr))).toBeGreaterThan(1);
        const m = margins(uniform(200, 0.5), G);
        expect(2 * 0.0005 * fr).toBeLessThan(RESOLVED_FEATURE_BINS * m.resolutionHz!);
        expect(m.marginBasis).toBe("bounded");
        expect(m.status).toBe("VALIDATED");
        // The same loop on bins that resolve the pair is refused.
        expect(margins(refined(fr), G).status).toBe("NOT_VALIDATED");
    });
});
