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
 * GF-1: independent analytical references for open-loop recovery.
 *
 * Gyroflight recovers L from the measured closed loop via L = T / (1 - T).
 * That identity holds only for unity feedback T = L / (1 + L). Betaflight's
 * rate PID uses P/I on the error, D on the gyro, and feedforward on the
 * setpoint, so the stability loop is not that L. These tests build known
 * continuous-time models, form T analytically, and compare:
 *   - true gain crossover and phase margin of the stability loop
 *   - values recovered by openLoopResponse() / recommendGains()
 */

import { describe, expect, it } from "vitest";
import {
    openLoopResponse,
    recommendGains,
    type TransferFunction,
} from "../../src/js/blackbox/spectral_analysis";

type Complex = { re: number; im: number };

const add = (a: Complex, b: Complex): Complex => ({ re: a.re + b.re, im: a.im + b.im });
const sub = (a: Complex, b: Complex): Complex => ({ re: a.re - b.re, im: a.im - b.im });
const mul = (a: Complex, b: Complex): Complex => ({
    re: a.re * b.re - a.im * b.im,
    im: a.re * b.im + a.im * b.re,
});
const div = (a: Complex, b: Complex): Complex => {
    const d = b.re * b.re + b.im * b.im;
    return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
};
const scale = (a: Complex, s: number): Complex => ({ re: a.re * s, im: a.im * s });
const mag = (a: Complex) => Math.hypot(a.re, a.im);
const phaseDeg = (a: Complex) => (Math.atan2(a.im, a.re) * 180) / Math.PI;

/**
 * Rate-loop plant: integrator + first-order motor lag + transport delay.
 *   G = K / (s (s/ωm + 1)) · e^{-s τ}
 * Without the motor pole, D-on-measurement makes |G·Kd·s| → K·Kd (constant),
 * so |L| need not cross unity — that is not a realistic Betaflight plant.
 */
function plantG(w: number, K: number, delayS: number, motorHz = 80): Complex {
    let g = div({ re: K, im: 0 }, { re: 0, im: w }); // K/(jw)
    const wm = 2 * Math.PI * motorHz;
    g = div(g, { re: 1, im: w / wm });
    const dRe = Math.cos(-w * delayS);
    const dIm = Math.sin(-w * delayS);
    return mul(g, { re: dRe, im: dIm });
}

/** First-order low-pass PT1: H = ωc / (ωc + jw). */
function pt1(w: number, cutoffHz: number): Complex {
    const wc = 2 * Math.PI * cutoffHz;
    return div({ re: wc, im: 0 }, { re: wc, im: w });
}

interface Controller {
    /** Proportional on error. */
    kp: number;
    /** Integral on error (Ki in 1/s units of the continuous model). */
    ki: number;
    /** Derivative on measurement (gyro). */
    kd: number;
    /** Feedforward on setpoint. */
    kff: number;
    /** Optional D-term filter cutoff (Hz); infinity = none. */
    dFilterHz?: number;
    /** Optional gyro filter cutoff (Hz) applied to y before the loop; infinity = none. */
    gyroFilterHz?: number;
}

function controllerParts(w: number, c: Controller): { Ce: Complex; Cd: Complex; Cff: Complex } {
    const Ce: Complex = { re: c.kp, im: -c.ki / w }; // Kp + Ki/(jw)
    let Cd: Complex = { re: 0, im: c.kd * w }; // Kd * jw
    if (c.dFilterHz && Number.isFinite(c.dFilterHz)) {
        Cd = mul(Cd, pt1(w, c.dFilterHz));
    }
    const Cff: Complex = { re: c.kff, im: 0 };
    return { Ce, Cd, Cff };
}

/**
 * Betaflight-like closed loop from setpoint to gyro:
 *   T = G_f * (Ce + Cff) / (1 + G_f * (Ce + Cd))
 * where G_f includes an optional gyro filter on the measurement path that also
 * scales the plant seen by the actuators for this linear model.
 */
function closedLoopT(w: number, K: number, delayS: number, c: Controller): Complex {
    let G = plantG(w, K, delayS);
    if (c.gyroFilterHz && Number.isFinite(c.gyroFilterHz)) {
        // Gyro filter on y: equivalent plant to the controller is G * Hgyro when
        // the filter sits on the measurement (and D already uses filtered gyro).
        G = mul(G, pt1(w, c.gyroFilterHz));
    }
    const { Ce, Cd, Cff } = controllerParts(w, c);
    const num = mul(G, add(Ce, Cff));
    const den = add({ re: 1, im: 0 }, mul(G, add(Ce, Cd)));
    return div(num, den);
}

/** Stability loop L_stab = G_f * (Ce + Cd); PM is defined on this. */
function stabilityLoop(w: number, K: number, delayS: number, c: Controller): Complex {
    let G = plantG(w, K, delayS);
    if (c.gyroFilterHz && Number.isFinite(c.gyroFilterHz)) {
        G = mul(G, pt1(w, c.gyroFilterHz));
    }
    const { Ce, Cd } = controllerParts(w, c);
    return mul(G, add(Ce, Cd));
}

function findCrossoverAndMargin(
    evalL: (w: number) => Complex,
    fMin = 2,
    fMax = 200,
    steps = 8000,
): { frequencyHz: number; phaseMarginDeg: number } | null {
    let prevF = fMin;
    let prevMag = mag(evalL(2 * Math.PI * fMin));
    for (let i = 1; i <= steps; i++) {
        const f = fMin + ((fMax - fMin) * i) / steps;
        const L = evalL(2 * Math.PI * f);
        const m = mag(L);
        if (prevMag > 1 && m <= 1) {
            const frac = (1 - prevMag) / (m - prevMag);
            const frequencyHz = prevF + frac * (f - prevF);
            const Lx = evalL(2 * Math.PI * frequencyHz);
            // Unwrap-ish: atan2 already in (-180,180]; for these plants phase is
            // near -90…-180 around crossover.
            let ph = phaseDeg(Lx);
            while (ph > 0) ph -= 360;
            while (ph <= -360) ph += 360;
            return { frequencyHz, phaseMarginDeg: 180 + ph };
        }
        prevF = f;
        prevMag = m;
    }
    return null;
}

function tfFromModel(
    K: number,
    delayS: number,
    c: Controller,
    opts: { maxHz?: number; binHz?: number; coherence?: number | ((f: number) => number) } = {},
): TransferFunction {
    const maxHz = opts.maxHz ?? 250;
    const binHz = opts.binHz ?? 0.5;
    const n = Math.floor(maxHz / binHz) + 1;
    const frequencies = new Float64Array(n);
    const magnitude = new Float64Array(n);
    const phase = new Float64Array(n);
    const coherence = new Float64Array(n);
    const hReal = new Float64Array(n);
    const hImag = new Float64Array(n);
    for (let k = 0; k < n; k++) {
        const f = k * binHz;
        frequencies[k] = f;
        const coh = typeof opts.coherence === "function" ? opts.coherence(f) : (opts.coherence ?? 1);
        coherence[k] = coh;
        if (k === 0) {
            hReal[k] = 1;
            hImag[k] = 0;
            continue;
        }
        const T = closedLoopT(2 * Math.PI * f, K, delayS, c);
        hReal[k] = T.re;
        hImag[k] = T.im;
        magnitude[k] = 20 * Math.log10(Math.max(mag(T), 1e-15));
        phase[k] = phaseDeg(T);
    }
    return { frequencies, magnitude, phase, coherence, hReal, hImag, numSegments: 32 };
}

function recoveredCrossover(tf: TransferFunction) {
    const { analysis } = recommendGains(
        tf,
        {
            masterMultiplier: 1,
            piGain: 1,
            iGain: 1,
            dGain: 1,
            feedforwardGain: 1,
            dtermFilterMultiplier: 1,
        },
        60,
    );
    return {
        frequencyHz: analysis.openLoopCrossoverHz,
        phaseMarginDeg: analysis.phaseMarginDeg,
    };
}

const SLIDERS = {
    masterMultiplier: 1,
    piGain: 1,
    iGain: 1,
    dGain: 1,
    feedforwardGain: 1,
    dtermFilterMultiplier: 1,
};

describe("GF-1 phase-margin model references", () => {
    it("1. unity feedback without D-term: L=T/(1-T) matches the true stability loop", () => {
        // Pure P on error, no D, no FF → classical T = L/(1+L).
        const K = 2 * Math.PI * 25; // |G*Kp|=1 at 25 Hz when Kp=1
        const delayS = 0.003;
        const c: Controller = { kp: 1, ki: 0, kd: 0, kff: 0 };
        const truth = findCrossoverAndMargin((w) => stabilityLoop(w, K, delayS, c));
        expect(truth).not.toBeNull();
        const tf = tfFromModel(K, delayS, c);
        const got = recoveredCrossover(tf);
        expect(got.frequencyHz).toBeCloseTo(truth!.frequencyHz, 0);
        expect(got.phaseMarginDeg).toBeCloseTo(truth!.phaseMarginDeg, 0);
        // Analytic check on openLoopResponse magnitude at the true crossover.
        const L = openLoopResponse(tf);
        const k = Math.round(truth!.frequencyHz / 0.5);
        expect(L.magnitude[k]).toBeCloseTo(1, 1);
    });

    it("2. Betaflight-like P/I on error and D on gyro: recovered PM is biased", () => {
        // Healthy true margin (~104°); L=T/(1-T) under-reports badly.
        const K = 2 * Math.PI * 20;
        const delayS = 0.0015;
        const c: Controller = { kp: 1.0, ki: 20, kd: 0.006, kff: 0 };
        const truth = findCrossoverAndMargin((w) => stabilityLoop(w, K, delayS, c));
        expect(truth).not.toBeNull();
        expect(truth!.phaseMarginDeg).toBeGreaterThan(40);
        const got = recoveredCrossover(tfFromModel(K, delayS, c));
        const freqBiasHz = got.frequencyHz - truth!.frequencyHz;
        const pmBiasDeg = got.phaseMarginDeg - truth!.phaseMarginDeg;
        expect(pmBiasDeg).toBeLessThan(-20);
        expect(freqBiasHz).toBeLessThan(-5);
    });

    it("3. feedforward on the setpoint biases L=T/(1-T) even without D", () => {
        const K = 2 * Math.PI * 25;
        const delayS = 0.003;
        const c: Controller = { kp: 1, ki: 0, kd: 0, kff: 0.4 };
        const truth = findCrossoverAndMargin((w) => stabilityLoop(w, K, delayS, c));
        expect(truth).not.toBeNull();
        const got = recoveredCrossover(tfFromModel(K, delayS, c));
        // Stability loop ignores FF, so true PM matches the P-only plant; recovery does not.
        expect(got.phaseMarginDeg - truth!.phaseMarginDeg).toBeLessThan(-10);
    });

    it("4. D-term filter, gyro filter and transport delay keep a material PM bias under L=T/(1-T)", () => {
        const K = 2 * Math.PI * 22;
        const delayS = 0.002;
        const c: Controller = {
            kp: 1.0,
            ki: 25,
            kd: 0.007,
            kff: 0.25,
            dFilterHz: 150,
            gyroFilterHz: 250,
        };
        const truth = findCrossoverAndMargin((w) => stabilityLoop(w, K, delayS, c));
        expect(truth).not.toBeNull();
        expect(truth!.phaseMarginDeg).toBeGreaterThan(40);
        const got = recoveredCrossover(tfFromModel(K, delayS, c));
        expect(Math.abs(got.phaseMarginDeg - truth!.phaseMarginDeg)).toBeGreaterThan(8);
        expect(Math.abs(got.frequencyHz - truth!.frequencyHz)).toBeGreaterThan(10);
    });

    it("5. unreliable frequency data yields no finite crossover / phase margin", () => {
        const K = 2 * Math.PI * 25;
        const c: Controller = { kp: 1, ki: 0, kd: 0, kff: 0 };
        const tf = tfFromModel(K, 0.003, c, { coherence: 0.2 });
        const { analysis, proposed } = recommendGains(tf, SLIDERS, 60);
        expect(Number.isNaN(analysis.openLoopCrossoverHz)).toBe(true);
        expect(Number.isNaN(analysis.phaseMarginDeg)).toBe(true);
        // Existing hold behaviour: no invented gain from a bad measurement.
        expect(proposed.slider_pi_gain).toBe(100);
    });
});

describe("GF-1 product path: unvalidated open-loop model", () => {
    it("marks phase margin NOT_VALIDATED and holds every slider when openLoopModel is unvalidated", () => {
        const K = 2 * Math.PI * 25;
        const tf = tfFromModel(K, 0.003, { kp: 1, ki: 0, kd: 0, kff: 0 });
        const { analysis, proposed } = recommendGains(tf, SLIDERS, 60, { openLoopModel: "unvalidated" });
        expect(analysis.phaseMarginStatus).toBe("NOT_VALIDATED");
        expect(analysis.openLoopModel).toBe("unvalidated");
        expect(Number.isNaN(analysis.phaseMarginDeg)).toBe(true);
        expect(Number.isNaN(analysis.openLoopCrossoverHz)).toBe(true);
        expect(analysis.piScale).toBe(1);
        expect(proposed.slider_pi_gain).toBe(100);
        expect(proposed.slider_i_gain).toBe(100);
        expect(proposed.slider_feedforward_gain).toBe(100);
    });
});

describe("GF-1 structure-aware recovery availability", () => {
    it("proves corrected L_stab can be recovered when Ce/Cd/Cff are known exactly", () => {
        // G = T / ((Ce+Cff) - T*(Ce+Cd)); Lstab = G*(Ce+Cd).
        // This is the identity that would be needed to correct PM — but only when
        // the continuous controller (including filters) is known. Gyroflight's
        // blackbox path does not currently pass a validated digital+filter model
        // into recommendGains, so product code must not pretend this is applied.
        const K = 2 * Math.PI * 30;
        const delayS = 0.0025;
        const c: Controller = { kp: 1.0, ki: 40, kd: 0.012, kff: 0.15, dFilterHz: 150 };
        const truth = findCrossoverAndMargin((w) => stabilityLoop(w, K, delayS, c))!;

        const corrected = findCrossoverAndMargin((w) => {
            const T = closedLoopT(w, K, delayS, c);
            const { Ce, Cd, Cff } = controllerParts(w, c);
            const denom = sub(add(Ce, Cff), mul(T, add(Ce, Cd)));
            const G = div(T, denom);
            return mul(G, add(Ce, Cd));
        });
        expect(corrected).not.toBeNull();
        expect(corrected!.frequencyHz).toBeCloseTo(truth.frequencyHz, 1);
        expect(corrected!.phaseMarginDeg).toBeCloseTo(truth.phaseMarginDeg, 1);

        // And the naive recovery remains wrong on the same T.
        const naive = recoveredCrossover(tfFromModel(K, delayS, c));
        expect(Math.abs(naive.phaseMarginDeg - truth.phaseMarginDeg)).toBeGreaterThan(5);
    });
});
