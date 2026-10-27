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
 * Measurement audit B3: the Bendat & Piersol interval the bounds fold in (loopModel UNCERTAINTY) had
 * never been checked for coverage. Monte Carlo on an analytic closed loop: each bin's T is perturbed
 * by a random relative error drawn with the very σ the engine assumes for that bin (coherence 0.995,
 * the sweep's independent averages), many seeds; wherever the engine gives bounds, the PM bound must
 * lie at or below the true phase margin and the GM bound at or below the true gain margin in at
 * least 95 % of the seeds (the interval's own 2 σ premise), and the nominal readings must scatter
 * around the truth. SIMULATION: this checks the propagation of the assumed error through G = T /
 * (C_ref − T·C_fb) to the bounds, under the error model's own premise; it is not evidence that real
 * sweeps follow that model (the AIR65 sweeps have too few averages for bounds at all).
 */

import { describe, expect, it } from "vitest";
import type { TransferFunction } from "../../src/js/blackbox/spectral_analysis";
import {
    cadd,
    cdiv,
    cmag,
    cmul,
    cphaseDeg,
    evaluateControllerFrf,
    type DigitalControllerConfig,
} from "../../src/js/blackbox/betaflight_digital_controller";
import { controllerConfigFromHeaders } from "../../src/gyrocore/engine/autotuneV2";
import { buildAxisLoop, loopMargins, sweepAverages, UNCERTAINTY } from "../../src/gyrocore/engine/loopModel";
import type { EffectiveChain } from "../../src/gyrocore/engine/gyroChain";
import { ratePlant, type Plant } from "./harness/closedLoopBbl";
import { BETAFLIGHT_TUNE_HEADERS, SIM_IDENTITY_HEADERS } from "./harness/chirpSim";
import { declaredSupport } from "./harness/frequencySupport";
import { declaredConvergence } from "./harness/resolutionConvergence";

const HEADERS = Object.fromEntries([
    ...[...SIM_IDENTITY_HEADERS, ...BETAFLIGHT_TUNE_HEADERS].map((l) => [
        l.slice(0, l.indexOf(":")),
        l.slice(l.indexOf(":") + 1),
    ]),
    ["looptime", "125"],
    ["pid_process_denom", "8"],
]);
const cfg: DigitalControllerConfig = controllerConfigFromHeaders(HEADERS, 0)!;
const UNITY_CHAIN: EffectiveChain = {
    samples: 1,
    frf: () => ({ re: 1, im: 0 }),
    spread: () => ({ phaseDeg: 0, gainDb: 0 }),
    medianLpf1Hz: 0,
    dynNotchHz: [],
};
const FS = 1000;
const N = 512;
const SWEEP = { f0Hz: 1, f1Hz: 400, durationS: 60 };
const SEGMENTS = 233;
const PRIMARY = { segmentSamples: N, sampleRateHz: FS, windowSamples: 60000, segments: SEGMENTS };
const COHERENCE = 0.995;
const PLANT = ratePlant({ K: 60, motorHz: 40, delayS: 0.002 });

/** Deterministic standard normal draws per seed. */
function gaussian(seed: number): () => number {
    let s = seed >>> 0;
    const u = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    return () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
}

/** T on the Welch grid, each bin perturbed by the relative error the engine assumes there (gain and phase). */
function perturbedTF(G: Plant, seed: number | null): TransferFunction {
    const bins = N / 2 + 1;
    const fr = new Float64Array(bins);
    const mag = new Float64Array(bins);
    const ph = new Float64Array(bins);
    const co = new Float64Array(bins);
    const re = new Float64Array(bins);
    const im = new Float64Array(bins);
    const g = seed === null ? null : gaussian(seed);
    for (let k = 0; k < bins; k++) {
        const f = (k * FS) / N;
        fr[k] = f;
        const ff = Math.max(f, 1e-3);
        const c = evaluateControllerFrf(cfg, ff);
        const plant = G(ff);
        let T = cdiv(cmul(plant, c.cReference), cadd({ re: 1, im: 0 }, cmul(plant, c.cFeedback)));
        if (g) {
            const n = sweepAverages(ff, N / FS, SEGMENTS, SWEEP);
            const eps = Math.sqrt(1 - COHERENCE) / (Math.sqrt(COHERENCE) * Math.sqrt(2 * n));
            const gain = 1 + eps * g();
            const phase = eps * g();
            T = cmul(T, { re: gain * Math.cos(phase), im: gain * Math.sin(phase) });
        }
        re[k] = T.re;
        im[k] = T.im;
        mag[k] = 20 * Math.log10(cmag(T));
        ph[k] = cphaseDeg(T);
        co[k] = k === 0 || f < 2 || f > 138 ? 0 : COHERENCE;
    }
    return { frequencies: fr, magnitude: mag, phase: ph, coherence: co, hReal: re, hImag: im, numSegments: SEGMENTS };
}

/** True PM at the first unity crossing and true GM at the first −180° crossing of L = G · C_fb. */
function truth(G: Plant) {
    const L = (f: number) => cmul(G(f), evaluateControllerFrf(cfg, f).cFeedback);
    let prev = L(0.5);
    let un = Math.atan2(prev.im, prev.re);
    let pm: number | null = null;
    let gm: number | null = null;
    for (let f = 0.501; f < 450; f += 0.001) {
        const l = L(f);
        let d = Math.atan2(l.im, l.re) - Math.atan2(prev.im, prev.re);
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        const unNext = un + d;
        if (pm === null && cmag(prev) >= 1 && cmag(l) < 1) pm = 180 + (unNext * 180) / Math.PI;
        if (gm === null && un > -Math.PI && unNext <= -Math.PI) gm = -20 * Math.log10(cmag(l));
        un = unNext;
        prev = l;
    }
    return { pm: pm!, gm: gm! };
}

function margins(tf: TransferFunction) {
    return loopMargins(
        buildAxisLoop(0, tf, cfg, UNITY_CHAIN, true, true, null, {
            sweep: SWEEP,
            analysis: PRIMARY,
            support: declaredSupport(tf, { observedHz: [2, 400] }),
            resolution: declaredConvergence(FS / N, FS),
        }),
    );
}

describe("coverage of the uncertainty bounds over random errors of the assumed size (SIMULATION)", () => {
    const t = truth(PLANT);
    const exact = margins(perturbedTF(PLANT, null));
    const seeds = Array.from({ length: 40 }, (_, i) => 1000 + i);
    const runs = seeds.map((seed) => margins(perturbedTF(PLANT, seed)));

    it("the unperturbed loop has bounds, and they lie below the truth by the assumed error", () => {
        expect(exact.evidence.level).toBe("MODEL_CONDITIONAL");
        expect(exact.phaseMarginDeg!).toBeLessThanOrEqual(t.pm);
        expect(exact.gainMarginDb!).toBeLessThanOrEqual(t.gm);
        expect(Math.abs(exact.measured.phaseMarginDeg! - t.pm)).toBeLessThan(1);
        expect(UNCERTAINTY.coverage).toBe(2);
    });

    it("the nominal readings scatter around the truth", () => {
        const pms = runs.map((m) => m.measured.phaseMarginDeg).filter((x): x is number => x !== null);
        expect(pms.length).toBe(runs.length);
        const mean = pms.reduce((s, x) => s + x, 0) / pms.length;
        expect(Math.abs(mean - t.pm)).toBeLessThan(2);
        const sd = Math.sqrt(pms.reduce((s, x) => s + (x - mean) ** 2, 0) / pms.length);
        expect(sd).toBeGreaterThan(0.2); // the perturbation is not a no-op
    });

    it("wherever bounds are given, PM and GM bounds hold against the truth in at least 95 % of the seeds", () => {
        const bounded = runs.filter((m) => m.evidence.level === "MODEL_CONDITIONAL");
        expect(bounded.length).toBeGreaterThanOrEqual(0.5 * runs.length);
        const pmOk = bounded.filter((m) => m.phaseMarginDeg! <= t.pm + 1e-9).length;
        // GM coverage over the runs that carry a GM bound (an absent bound is not a success).
        const withGm = bounded.filter((m) => m.gainMarginDb !== null);
        expect(withGm.length).toBeGreaterThanOrEqual(0.5 * bounded.length);
        const gmOk = withGm.filter((m) => m.gainMarginDb! <= t.gm + 1e-9).length;
        expect(pmOk / bounded.length).toBeGreaterThanOrEqual(0.95);
        expect(gmOk / withGm.length).toBeGreaterThanOrEqual(0.95);
        for (const m of bounded) expect(m.phaseMarginDeg!).toBeLessThanOrEqual(m.measured.phaseMarginDeg! + 1e-9);
        // Seeds without bounds say why, and are MEASURED only.
        for (const m of runs.filter((x) => x.evidence.level !== "MODEL_CONDITIONAL")) {
            expect(m.evidence.level).toBe("MEASURED");
            expect(m.gainMarginDb).toBeNull();
            expect(m.reasons.length).toBeGreaterThan(0);
        }
    });

    it("no seed is VALIDATED without a qualification", () => {
        for (const m of runs) expect(m.evidence.level).not.toBe("VALIDATED");
    });
});
