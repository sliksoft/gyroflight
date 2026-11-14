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
 * WP8 review round 2: the uncertainty bounds of PM, GM and the band end must hold for every loop
 * the evidence admits: each bin's L inside its uncertainty set, and between two bins any curve
 * within the sagitta allowance of the chord (BIN_SAGITTA, the resolved model class). Each case is
 * an independent reviewer's counterexample, evaluated here on its analytic loop, not on the code.
 */

import { describe, expect, it } from "vitest";
import {
    BAND_END,
    capsulePmBound,
    distanceToNegativeRealAxis,
    uncertainBounds,
    type LoopPoint,
} from "../../src/gyrocore/engine/loopModel";

const polar = (m: number, deg: number) => ({
    re: m * Math.cos((deg * Math.PI) / 180),
    im: m * Math.sin((deg * Math.PI) / 180),
});
const uncertainty = { relErr: new Map<number, number>(), averages: [8, 8] as [number, number], reasons: [] };
/** What readLoop read on the bins (only the fields the bounds widen). */
const read = (pm: number, gm: number | null, sPeak: number | null = null) =>
    ({ pm, gm, sPeak }) as Parameters<typeof uncertainBounds>[1];

describe("PM: a lower bound over the curvature the model class admits between two bins", () => {
    // L(jw) = √2 / (jw (1 + jw)): |L(1)| = 1 exactly, phase −135°: the true PM is 45°.
    const L = (w: number) => {
        const den = { re: -w * w, im: w };
        const d = den.re * den.re + den.im * den.im;
        return { re: (Math.SQRT2 * den.re) / d, im: (-Math.SQRT2 * den.im) / d };
    };
    const pts: LoopPoint[] = Array.from({ length: 80 }, (_, i) => 0.1 + 0.2 * i).map((w) => ({
        f: w,
        L: L(w),
        err: 1e-4,
    }));

    it("the bins at 0.9 and 1.1 interpolate to 45.047°; the bound must not exceed the true 45°", () => {
        const b = uncertainBounds(pts, read(45.047385588, 20), uncertainty);
        expect(b.uncertainty).not.toBeNull();
        expect(b.pm).toBeLessThanOrEqual(45);
        // And it stays a usable bound (not collapsed to zero).
        expect(b.pm).toBeGreaterThan(30);
    });
});

describe("GM: every step whose admitted curve can reach the negative real axis is a phase crossover", () => {
    // Unity crossing between 3 and 4; at 5 and 6 the loop sits just above −180° (0.65 and 0.55 ∠ −179°),
    // its admitted curve between them reaches −0.6; a later crossover at 12 shows only 0.1.
    const shape: [number, number, number][] = [
        [1, 5, -100],
        [2, 2, -120],
        [3, 1.2, -140],
        [4, 0.8, -160],
        [5, 0.65, -179],
        [6, 0.55, -179],
        [7, 0.3, -170],
        [8, 0.25, -172],
        [9, 0.2, -175],
        [10, 0.15, -178],
        [11, 0.12, -179.5],
        [12, 0.1, -182],
        [13, 0.08, -186],
        [14, 0.06, -190],
        ...Array.from({ length: 30 }, (_, i) => [15 + i, 0.05 * 0.95 ** i, -192 - i] as [number, number, number]),
    ];
    const pts: LoopPoint[] = shape.map(([f, m, deg]) => ({ f, L: polar(m, deg), err: 1e-4 }));

    it("the step at 5–6 bounds GM: at most −20 log10(0.65) dB, never the later crossover's 20 dB", () => {
        const b = uncertainBounds(pts, read(30, 20), uncertainty);
        expect(b.uncertainty).not.toBeNull();
        expect(b.gm!).toBeLessThanOrEqual(-20 * Math.log10(0.65));
    });
});

describe("band end: the tail must stay bounded for every gain error the uncertainty admits", () => {
    // Flat −12 dB tail, ±10 % gain error per bin: −10 % at its start and +10 % at its end rises
    // 20 log10(1.1 / 0.9) = 1.743 dB, beyond BAND_END.maxTailRiseDb, although the end itself passes.
    const pts: LoopPoint[] = [
        { f: 1, L: polar(4, -100), err: 1e-4 },
        { f: 2, L: polar(1.5, -120), err: 1e-4 },
        { f: 3, L: polar(0.8, -140), err: 1e-4 },
        ...Array.from({ length: 37 }, (_, i) => ({ f: 4 + i, L: polar(10 ** (-12 / 20), -150), err: 0.05 })),
    ];

    it("is not bounded", () => {
        expect(20 * Math.log10(1.1 / 0.9)).toBeGreaterThan(BAND_END.maxTailRiseDb);
        const b = uncertainBounds(pts, read(40, null), uncertainty);
        expect(b.uncertainty).toBeNull();
        expect(b.reasons).toContain("margin_uncertainty_band_end_not_bounded:tail_rise");
    });

    it("the same tail with ±1 % stays bounded", () => {
        const tight = pts.map((p) => ({ ...p, err: Math.min(p.err!, 0.005) }));
        expect(uncertainBounds(tight, read(40, null), uncertainty).uncertainty).not.toBeNull();
    });
});

describe("the geometry the bounds rest on (hand-computed)", () => {
    it("distance from a chord to the negative real half-axis", () => {
        const c = (re: number, im: number) => ({ re, im });
        expect(distanceToNegativeRealAxis(c(-2, 0.1), c(-1, 0.1))).toBeCloseTo(0.1, 12);
        expect(distanceToNegativeRealAxis(c(-2, 0.1), c(-1, -0.1))).toBe(0);
        // Crossing the real axis on the positive side: the half-axis is as far as the origin.
        expect(distanceToNegativeRealAxis(c(3, 4), c(3, -4))).toBeCloseTo(3, 12);
        expect(distanceToNegativeRealAxis(c(0.5, 1), c(2, 1))).toBeCloseTo(Math.hypot(0.5, 1), 12);
    });

    it("lowest PM within reach of a chord: e^{j(−135°)} itself, and rho widening it by asin(rho)", () => {
        const at = (deg: number) => ({ re: Math.cos((deg * Math.PI) / 180), im: Math.sin((deg * Math.PI) / 180) });
        // A chord through e^{−j135°}, tangent there: PM 45° at rho 0, 45° − asin(rho) for rho > 0
        // (the circle within rho of the tangent point).
        const t = (deg: number, s: number) => ({
            re: at(deg).re + s * Math.sin((deg * Math.PI) / 180),
            im: at(deg).im - s * Math.cos((deg * Math.PI) / 180),
        });
        const a = t(-135, -0.001);
        const b = t(-135, 0.001);
        expect(capsulePmBound(a, b, -135, -135, 0)).toBeLessThanOrEqual(45);
        expect(capsulePmBound(a, b, -135, -135, 0)).toBeGreaterThan(44.9);
        const pm = capsulePmBound(a, b, -135, -135, 0.1)!;
        const exact = 45 - (2 * Math.asin(0.05) * 180) / Math.PI;
        expect(pm).toBeLessThanOrEqual(exact + 0.02);
        expect(pm).toBeGreaterThan(exact - 0.1);
        expect(capsulePmBound({ re: 0.1, im: 0 }, { re: 0.2, im: 0 }, 0, 0, 0.1)).toBeNull();
    });
});
