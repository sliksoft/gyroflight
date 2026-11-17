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
 * Step response setpoint → gyro from ordinary Acro flights (WU "Staprespons uit gewone vluchten" v3).
 * Pure computation: no decoding, no store, no UI. Method, decision rules and limits:
 * docs/gyrocore/STEP_RESPONSE.md.
 *
 * Method references (method only; this is an independent TypeScript implementation, no code copied):
 *   - PIDscope v26.10.1 (github.com/dzikus/PIDscope, tag 83cdd17d), src/core/PSstepcalc.m
 *     (Brian White, PIDtoolbox lineage): 2 s segments every 0.4 s, Hann, zero padding,
 *     H = Y·conj(X) / (|X|² + ε), cumulative sum of the impulse response, 500 ms, 40–500 deg/s.
 *   - OpenPID PR #143 (github.com/Rufics/OpenPID/pull/143, head 47bb38d8, closed unmerged),
 *     crates/openpid-analysis/src/step.rs and openpid-dsp/src/deconv.rs: 80 deg/s threshold and a
 *     0.5–1.5 settle range as a window check.
 *
 * Deliberate differences: the final value is never scaled to 1 (no Y correction); a final value
 * outside 0.5–1.5 is flagged and kept in the primary result; windows are grouped into manoeuvres and
 * every manoeuvre weighs the same; ε is relative to the window's own AC input power.
 */

import { ComplexFFT } from "@/js/blackbox/fft";

export const STEP_METHOD = Object.freeze({
    version: "step-response-v3.0",
    /** Analysis window and hop (s). */
    windowS: 2,
    hopS: 0.4,
    /** Length of the step curve (ms), from lag 0. */
    responseMs: 500,
    /** The final value is the mean of the curve over this span (ms, both ends included). */
    finalFromMs: 200,
    finalToMs: 500,
    /**
     * Regularisation: ε = epsilonRel × mean |X(f)|² over the non-DC bins of the padded window
     * spectrum (the window's own AC input power), so ε does not depend on the FFT length, the
     * setpoint units or a setpoint offset (see the ε tests in test/gyrocore/step_response.test.ts).
     */
    epsilonRel: 1e-3,
    /** Lower bounds for the peak of |setpoint| in a window (deg/s); every result is given for both. */
    thresholdsDegS: Object.freeze([40, 80] as const),
    /** Upper bound for the peak of |setpoint| in a window (deg/s). */
    maxPeakDegS: 500,
    /**
     * Excitation: the largest change of the setpoint within any `changeSpanMs` stretch of the
     * window must reach the same threshold. A constant or slowly drifting input above the
     * threshold carries no information about the first 500 ms of the response.
     */
    changeSpanMs: 100,
    /**
     * The sample of largest |setpoint| must lie in this part of the window (fraction of the window
     * length). Hann on both signals is exact only where the taper is nearly flat over the response:
     * an event in the outer quarter of the window biases overshoot and final value by 0.03–0.12
     * (Grok r1 SHOULD-FIX-1, reproduced; test "edge bias"). The band (0.6 s at 2 s) is wider than the
     * hop (0.4 s), so every sample away from the ends of a usable stretch lies in the band of at least
     * one window: an isolated flick away from those ends keeps a window. A smaller flick within about 1–1.4 s of a larger one is never a window's peak in the
     * band and is not counted (Grok r2 SHOULD-FIX-A; test "a smaller flick next to a larger one").
     */
    centreBand: Object.freeze([0.4, 0.7] as const),
    /** A window's final value outside this range is flagged (kept in the primary result). */
    finalValueRange: Object.freeze([0.5, 1.5] as const),
    /** Fewer manoeuvres than this: INSUFFICIENT. */
    minManoeuvres: 5,
    /** Activity runs (|setpoint| ≥ threshold) closer than this are one manoeuvre (s). */
    manoeuvreMergeS: 0.2,
    /** A longer activity run is split into manoeuvres of at most this length (s). */
    manoeuvreMaxS: 2,
    /** Below this sample rate the analysis is BLOCKED (Hz). */
    minSampleRateHz: 500,
});

export type StepThreshold = (typeof STEP_METHOD.thresholdsDegS)[number];
export type StepStatus = "MEASURED" | "INSUFFICIENT" | "BLOCKED";

/**
 * Why a window is not used, in precedence order: a window is counted under the first reason that
 * applies, so the counts per reason plus the used windows add up to the windows examined.
 */
export const STEP_WINDOW_REASONS = [
    "not_airborne",
    "frame_gap",
    "non_finite",
    "chirp_active",
    "mode_change",
    "self_level_or_automation",
    "saturation",
    "input_below_threshold",
    "input_above_max",
    "insufficient_change",
    "peak_off_centre",
    "deconvolution_failed",
] as const;
export type StepWindowReason = (typeof STEP_WINDOW_REASONS)[number];

/** Per-sample evidence for one log, all arrays aligned with the setpoint and gyro. */
export interface StepSampleEvidence {
    /** 1 where the sample is not inside a flight run (disarmed, ground, low throttle, failsafe, edges). */
    notAirborne: Uint8Array;
    /** 1 where the timestamp step before this sample is a frame gap. */
    gapBefore: Uint8Array;
    /** 1 where a CHIRP sweep is active (or its guard band). */
    chirp: Uint8Array;
    /** 1 where a self-levelling or automation mode is active (ANGLE, HORIZON, …). */
    selfLevel: Uint8Array;
    /** Flight-relevant mode bits per sample; a change inside a window is a mode switch. */
    modeWord: Int32Array;
    /** 1 where a motor is at the end of its output range; null: saturation not known. */
    saturated: Uint8Array | null;
}

export interface StepAxisInput {
    sampleRateHz: number;
    /** deg/s */
    setpoint: ArrayLike<number>;
    /** deg/s, the same units as the setpoint */
    gyro: ArrayLike<number>;
    evidence: StepSampleEvidence;
    /** Override of STEP_METHOD.epsilonRel (tests of the ε choice only). */
    epsilonRel?: number;
    /** Logged battery voltage (vbatLatest, log units), aligned; absent: not logged. */
    battery?: ArrayLike<number> | null;
}

export interface StepMetrics {
    /** Peak of the curve over 0–500 ms minus 1 (the commanded step), not relative to the final value. */
    overshoot: number;
    /** Time of that peak (ms). */
    peakTimeMs: number;
    /** First time the curve reaches 0.5 (half the commanded step), linear interpolation; null if never. */
    t50Ms: number | null;
    /** Mean of the curve over 200–500 ms; the estimated steady-state gain, never scaled to 1. */
    finalValue: number;
}

export interface StepCurve {
    timeMs: number[];
    mean: number[];
    p25: number[];
    p75: number[];
}

export interface Quartiles {
    p25: number;
    median: number;
    p75: number;
}

export interface StepAggregate {
    status: Exclude<StepStatus, "BLOCKED">;
    reasons: string[];
    windowsUsed: number;
    manoeuvres: number;
    curve: StepCurve | null;
    /** Metrics of the mean curve (the primary numbers). */
    metrics: StepMetrics | null;
    /** Spread of the metrics of the per-manoeuvre curves. */
    manoeuvreSpread: {
        overshoot: Quartiles;
        peakTimeMs: Quartiles;
        t50Ms: Quartiles | null;
        finalValue: Quartiles;
        /** Manoeuvres whose curve never reaches 0.5. */
        t50Missing: number;
    } | null;
}

export interface StepThresholdResult extends StepAggregate {
    thresholdDegS: StepThreshold;
    windowsTotal: number;
    rejected: Record<StepWindowReason, number>;
    /** Used windows whose final value lies outside STEP_METHOD.finalValueRange (kept above). */
    finalValueOutliers: number;
    /** The same aggregation without those windows (manoeuvres may disappear). */
    withoutOutliers: StepAggregate;
    /** Over the manoeuvres used: median of the peak |setpoint| and of the 100 ms change (deg/s). */
    excitation: { medianPeakDegS: number; medianChangeDegS: number; positive: number; negative: number } | null;
    /** Flight-relevant mode words seen in the used windows. */
    modeWords: number[];
    /**
     * Median logged battery voltage over the samples of the used windows (log units); null when
     * not logged or no window was used. The A/B covariate (Grok r7): the voltage the loop saw
     * during the measured manoeuvres, not over the whole flight.
     */
    batteryMedian: number | null;
}

export interface StepAxisResult {
    status: StepStatus;
    /** BLOCKED reasons (empty otherwise). */
    reasons: string[];
    sampleRateHz: number;
    windowSamples: number;
    hopSamples: number;
    fftLength: number;
    saturationKnown: boolean;
    thresholds: StepThresholdResult[];
}

function zeroCounts(): Record<StepWindowReason, number> {
    return Object.fromEntries(STEP_WINDOW_REASONS.map((r) => [r, 0])) as Record<StepWindowReason, number>;
}

function nextPow2(n: number): number {
    let p = 1;
    while (p < n) p *= 2;
    return p;
}

/** Symmetric Hann window of length n (as MATLAB/Octave `hann(n)`). */
export function hann(n: number): Float64Array {
    const w = new Float64Array(n);
    if (n === 1) {
        w[0] = 1;
        return w;
    }
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    return w;
}

const fftCache = new Map<string, ComplexFFT>();
function fftOf(n: number, inverse: boolean): ComplexFFT {
    const key = `${n}:${inverse}`;
    let f = fftCache.get(key);
    if (!f) {
        f = new ComplexFFT(n, inverse);
        fftCache.set(key, f);
    }
    return f;
}

/** Samples in the step curve: lag 0 … responseMs inclusive. */
export function responseSamples(sampleRateHz: number): number {
    return Math.floor((STEP_METHOD.responseMs / 1000) * sampleRateHz) + 1;
}

/** FFT length for a window: a power of two ≥ window + response, so the response never wraps. */
export function fftLengthFor(windowSamples: number, sampleRateHz: number): number {
    return nextPow2(windowSamples + responseSamples(sampleRateHz));
}

/**
 * Step response of one window by regularised deconvolution.
 *
 *   x = Hann · setpoint, y = Hann · gyro, both zero-padded at the end to `fftLength` samples;
 *   X, Y = unnormalised DFTs (the normalisation cancels in H; ε is relative, see STEP_METHOD);
 *   H = Y·conj(X) / (|X|² + ε), ε = epsilonRel · mean_{k≠0} |X_k|²;
 *   h = real(IDFT(H)) / fftLength: h[0] is lag 0 (t = 0), h[k] lag k/fs; the upper half of the
 *   circular result is negative lag and is not summed;
 *   step[k] = Σ_{j ≤ k} h[j], k = 0 … responseSamples − 1.
 * No detrending: the DC bin is part of H like every other bin, so the curve keeps the estimated
 * steady-state gain. Returns null when the result is not finite.
 */
export function deconvolveStep(
    setpoint: ArrayLike<number>,
    gyro: ArrayLike<number>,
    sampleRateHz: number,
    epsilonRel: number = STEP_METHOD.epsilonRel,
): Float64Array | null {
    const n = setpoint.length;
    if (n < 2 || gyro.length !== n) return null;
    const L = responseSamples(sampleRateHz);
    const N = fftLengthFor(n, sampleRateHz);
    const w = hann(n);
    // One complex transform for both real signals: z = x + i·y.
    const z = new Float64Array(2 * N);
    for (let i = 0; i < n; i++) {
        z[2 * i] = w[i] * setpoint[i];
        z[2 * i + 1] = w[i] * gyro[i];
    }
    const Z = new Float64Array(2 * N);
    fftOf(N, false).simple(Z, z);
    const H = new Float64Array(2 * N);
    const xr = new Float64Array(N);
    const xi = new Float64Array(N);
    const yr = new Float64Array(N);
    const yi = new Float64Array(N);
    let acPower = 0;
    for (let k = 0; k < N; k++) {
        const m = (N - k) % N;
        const ar = Z[2 * k];
        const ai = Z[2 * k + 1];
        const br = Z[2 * m];
        const bi = -Z[2 * m + 1]; // conj(Z[N-k])
        xr[k] = (ar + br) / 2;
        xi[k] = (ai + bi) / 2;
        // Y = (Z - conj(Z[N-k])) / (2i)
        yr[k] = (ai - bi) / 2;
        yi[k] = -(ar - br) / 2;
        if (k !== 0) acPower += xr[k] * xr[k] + xi[k] * xi[k];
    }
    acPower /= N - 1;
    const eps = epsilonRel * acPower;
    for (let k = 0; k < N; k++) {
        const p = xr[k] * xr[k] + xi[k] * xi[k];
        const d = p + eps;
        if (!(d > 0)) {
            H[2 * k] = 0;
            H[2 * k + 1] = 0;
            continue;
        }
        // Y · conj(X)
        H[2 * k] = (yr[k] * xr[k] + yi[k] * xi[k]) / d;
        H[2 * k + 1] = (yi[k] * xr[k] - yr[k] * xi[k]) / d;
    }
    const h = new Float64Array(2 * N);
    fftOf(N, true).simple(h, H);
    const step = new Float64Array(L);
    let acc = 0;
    for (let k = 0; k < L; k++) {
        acc += h[2 * k] / N;
        step[k] = acc;
    }
    for (let k = 0; k < L; k++) if (!Number.isFinite(step[k])) return null;
    return step;
}

/** Overshoot, peak time, t50 and final value of a step curve sampled at `sampleRateHz` from lag 0. */
export function stepMetrics(curve: ArrayLike<number>, sampleRateHz: number): StepMetrics {
    const ms = (k: number) => (k * 1000) / sampleRateHz;
    let peak = -Infinity;
    let peakK = 0;
    for (let k = 0; k < curve.length; k++) {
        if (curve[k] > peak) {
            peak = curve[k];
            peakK = k;
        }
    }
    let t50: number | null = null;
    for (let k = 0; k < curve.length; k++) {
        if (curve[k] >= 0.5) {
            if (k === 0) t50 = 0;
            else {
                const a = curve[k - 1];
                const b = curve[k];
                t50 = ms(k - 1 + (b === a ? 0 : (0.5 - a) / (b - a)));
            }
            break;
        }
    }
    let sum = 0;
    let cnt = 0;
    for (let k = 0; k < curve.length; k++) {
        const t = ms(k);
        if (t >= STEP_METHOD.finalFromMs - 1e-9 && t <= STEP_METHOD.finalToMs + 1e-9) {
            sum += curve[k];
            cnt++;
        }
    }
    return { overshoot: peak - 1, peakTimeMs: ms(peakK), t50Ms: t50, finalValue: cnt ? sum / cnt : NaN };
}

/** Linear-interpolation percentile (type 7) of sorted values. */
function percentileSorted(v: readonly number[], p: number): number {
    if (!v.length) return NaN;
    const h = (v.length - 1) * p;
    const lo = Math.floor(h);
    const hi = Math.ceil(h);
    return v[lo] + (h - lo) * (v[hi] - v[lo]);
}

function quartiles(values: number[]): Quartiles {
    const s = [...values].sort((a, b) => a - b);
    return { p25: percentileSorted(s, 0.25), median: percentileSorted(s, 0.5), p75: percentileSorted(s, 0.75) };
}

/**
 * The activity runs of one threshold: |setpoint| ≥ threshold, runs closer than manoeuvreMergeS
 * merged, runs longer than manoeuvreMaxS split. Returns the manoeuvre id of every sample (−1 outside).
 */
export function manoeuvreIds(setpoint: ArrayLike<number>, thresholdDegS: number, sampleRateHz: number): Int32Array {
    const n = setpoint.length;
    const ids = new Int32Array(n).fill(-1);
    const runs: [number, number][] = [];
    let s = -1;
    for (let i = 0; i <= n; i++) {
        const on = i < n && Math.abs(setpoint[i]) >= thresholdDegS;
        if (on && s < 0) s = i;
        if (!on && s >= 0) {
            runs.push([s, i]);
            s = -1;
        }
    }
    const merge = Math.round(STEP_METHOD.manoeuvreMergeS * sampleRateHz);
    const merged: [number, number][] = [];
    for (const r of runs) {
        const last = merged[merged.length - 1];
        if (last && r[0] - last[1] < merge) last[1] = r[1];
        else merged.push([r[0], r[1]]);
    }
    const maxLen = Math.max(1, Math.round(STEP_METHOD.manoeuvreMaxS * sampleRateHz));
    let id = 0;
    for (const [a, b] of merged) {
        for (let start = a; start < b; start += maxLen) {
            const end = Math.min(b, start + maxLen);
            for (let i = start; i < end; i++) ids[i] = id;
            id++;
        }
    }
    return ids;
}

/** Largest max−min of x over any span of `span` samples, for every start (sliding, O(n)). */
function slidingRange(x: ArrayLike<number>, span: number): Float64Array {
    const n = x.length;
    const out = new Float64Array(Math.max(0, n - span + 1));
    const maxQ: number[] = [];
    const minQ: number[] = [];
    let mh = 0;
    let nh = 0;
    for (let i = 0; i < n; i++) {
        while (maxQ.length > mh && x[maxQ[maxQ.length - 1]] <= x[i]) maxQ.pop();
        maxQ.push(i);
        while (minQ.length > nh && x[minQ[minQ.length - 1]] >= x[i]) minQ.pop();
        minQ.push(i);
        const start = i - span + 1;
        if (start < 0) continue;
        while (maxQ[mh] < start) mh++;
        while (minQ[nh] < start) nh++;
        out[start] = x[maxQ[mh]] - x[minQ[nh]];
    }
    return out;
}

interface WindowRecord {
    start: number;
    /** First reason that applies regardless of threshold, or null. */
    common: StepWindowReason | null;
    peak: number;
    argmax: number;
    change: number;
    /** The peak lies in STEP_METHOD.centreBand. */
    centred: boolean;
    curve: Float64Array | null;
    deconvFailed: boolean;
    finalValue: number;
    modeWord: number;
}

function prefix(a: Uint8Array): Int32Array {
    const p = new Int32Array(a.length + 1);
    for (let i = 0; i < a.length; i++) p[i + 1] = p[i] + (a[i] ? 1 : 0);
    return p;
}

/** Aggregate windows (already assigned to manoeuvres) into the per-threshold result. */
function aggregate(windows: { manoeuvre: number; curve: Float64Array }[], sampleRateHz: number): StepAggregate {
    const byManoeuvre = new Map<number, Float64Array[]>();
    for (const w of windows) byManoeuvre.set(w.manoeuvre, [...(byManoeuvre.get(w.manoeuvre) ?? []), w.curve]);
    const curves: Float64Array[] = [];
    for (const list of byManoeuvre.values()) {
        const L = list[0].length;
        const m = new Float64Array(L);
        for (const c of list) for (let k = 0; k < L; k++) m[k] += c[k] / list.length;
        curves.push(m);
    }
    const manoeuvres = curves.length;
    const reasons: string[] = [];
    if (manoeuvres < STEP_METHOD.minManoeuvres)
        reasons.push(`manoeuvres_below_minimum:${manoeuvres}<${STEP_METHOD.minManoeuvres}`);
    if (!manoeuvres) {
        return {
            status: "INSUFFICIENT",
            reasons,
            windowsUsed: windows.length,
            manoeuvres,
            curve: null,
            metrics: null,
            manoeuvreSpread: null,
        };
    }
    const L = curves[0].length;
    const timeMs: number[] = [];
    const mean: number[] = [];
    const p25: number[] = [];
    const p75: number[] = [];
    const col: number[] = new Array(manoeuvres);
    for (let k = 0; k < L; k++) {
        let s = 0;
        for (let j = 0; j < manoeuvres; j++) {
            col[j] = curves[j][k];
            s += col[j];
        }
        const sorted = [...col].sort((a, b) => a - b);
        timeMs.push((k * 1000) / sampleRateHz);
        mean.push(s / manoeuvres);
        p25.push(percentileSorted(sorted, 0.25));
        p75.push(percentileSorted(sorted, 0.75));
    }
    const per = curves.map((c) => stepMetrics(c, sampleRateHz));
    const t50s = per.map((m) => m.t50Ms).filter((v): v is number => v !== null);
    return {
        status: reasons.length ? "INSUFFICIENT" : "MEASURED",
        reasons,
        windowsUsed: windows.length,
        manoeuvres,
        curve: { timeMs, mean, p25, p75 },
        metrics: stepMetrics(mean, sampleRateHz),
        manoeuvreSpread: {
            overshoot: quartiles(per.map((m) => m.overshoot)),
            peakTimeMs: quartiles(per.map((m) => m.peakTimeMs)),
            t50Ms: t50s.length ? quartiles(t50s) : null,
            finalValue: quartiles(per.map((m) => m.finalValue)),
            t50Missing: per.length - t50s.length,
        },
    };
}

function blocked(reasons: string[], sampleRateHz: number): StepAxisResult {
    return {
        status: "BLOCKED",
        reasons,
        sampleRateHz,
        windowSamples: 0,
        hopSamples: 0,
        fftLength: 0,
        saturationKnown: false,
        thresholds: [],
    };
}

/** Step response of one axis, for every threshold of STEP_METHOD. */
export function analyzeAxisStep(input: StepAxisInput): StepAxisResult {
    const fs = input.sampleRateHz;
    const { setpoint, gyro, evidence: ev } = input;
    const n = setpoint.length;
    if (!(fs > 0) || !Number.isFinite(fs)) return blocked(["sample_rate_unknown"], fs);
    if (fs < STEP_METHOD.minSampleRateHz)
        return blocked([`sample_rate_below_minimum:${Math.round(fs)}<${STEP_METHOD.minSampleRateHz}`], fs);
    const aligned = [
        gyro,
        ev.notAirborne,
        ev.gapBefore,
        ev.chirp,
        ev.selfLevel,
        ev.modeWord,
        ...(ev.saturated ? [ev.saturated] : []),
    ];
    if (aligned.some((a) => a.length !== n)) return blocked(["signals_not_aligned"], fs);
    const W = Math.round(STEP_METHOD.windowS * fs);
    const hop = Math.round(STEP_METHOD.hopS * fs);
    const span = Math.max(2, Math.round((STEP_METHOD.changeSpanMs / 1000) * fs));
    const centreLo = Math.round(STEP_METHOD.centreBand[0] * W);
    const centreHi = Math.round(STEP_METHOD.centreBand[1] * W);
    const minThr = Math.min(...STEP_METHOD.thresholdsDegS);
    const pAir = prefix(ev.notAirborne);
    const pGap = prefix(ev.gapBefore);
    const pChirp = prefix(ev.chirp);
    const pSelf = prefix(ev.selfLevel);
    const pSat = ev.saturated ? prefix(ev.saturated) : null;
    const finite = new Uint8Array(n);
    for (let i = 0; i < n; i++) finite[i] = Number.isFinite(setpoint[i]) && Number.isFinite(gyro[i]) ? 0 : 1;
    const pBad = prefix(finite);
    const safeSp = new Float64Array(n);
    for (let i = 0; i < n; i++) safeSp[i] = Number.isFinite(setpoint[i]) ? setpoint[i] : 0;
    const range = slidingRange(safeSp, span);
    const records: WindowRecord[] = [];
    for (let start = 0; start + W <= n; start += hop) {
        const end = start + W;
        const any = (p: Int32Array, a = start, b = end) => p[b] - p[a] > 0;
        let common: StepWindowReason | null = null;
        let mw = ev.modeWord[start];
        if (any(pAir)) common = "not_airborne";
        // A gap before sample i lies inside the window when start < i < end.
        else if (any(pGap, start + 1)) common = "frame_gap";
        else if (any(pBad)) common = "non_finite";
        else if (any(pChirp)) common = "chirp_active";
        else {
            for (let i = start + 1; i < end; i++) {
                if (ev.modeWord[i] !== mw) {
                    common = "mode_change";
                    break;
                }
            }
            if (!common && any(pSelf)) common = "self_level_or_automation";
            else if (!common && pSat && any(pSat)) common = "saturation";
        }
        let peak = 0;
        let argmax = start;
        let change = 0;
        if (!common) {
            for (let i = start; i < end; i++) {
                const a = Math.abs(setpoint[i]);
                if (a > peak) {
                    peak = a;
                    argmax = i;
                }
            }
            for (let i = start; i <= end - span; i++) if (range[i] > change) change = range[i];
        }
        let curve: Float64Array | null = null;
        let deconvFailed = false;
        let finalValue = NaN;
        const centred = argmax >= start + centreLo && argmax <= start + centreHi;
        if (!common && peak >= minThr && peak <= STEP_METHOD.maxPeakDegS && change >= minThr && centred) {
            curve = deconvolveStep(
                Array.prototype.slice.call(setpoint, start, end) as number[],
                Array.prototype.slice.call(gyro, start, end) as number[],
                fs,
                input.epsilonRel ?? STEP_METHOD.epsilonRel,
            );
            if (curve) finalValue = stepMetrics(curve, fs).finalValue;
            else deconvFailed = true;
        }
        mw = ev.modeWord[start];
        records.push({ start, common, peak, argmax, change, centred, curve, deconvFailed, finalValue, modeWord: mw });
    }
    const [lo, hi] = STEP_METHOD.finalValueRange;
    const thresholds: StepThresholdResult[] = STEP_METHOD.thresholdsDegS.map((thr) => {
        const rejected = zeroCounts();
        const ids = manoeuvreIds(safeSp, thr, fs);
        const used: { manoeuvre: number; curve: Float64Array; finalValue: number; rec: WindowRecord }[] = [];
        for (const r of records) {
            let reason: StepWindowReason | null = r.common;
            if (!reason && r.peak < thr) reason = "input_below_threshold";
            else if (!reason && r.peak > STEP_METHOD.maxPeakDegS) reason = "input_above_max";
            else if (!reason && r.change < thr) reason = "insufficient_change";
            else if (!reason && !r.centred) reason = "peak_off_centre";
            else if (!reason && (r.deconvFailed || !r.curve)) reason = "deconvolution_failed";
            if (reason) {
                rejected[reason]++;
                continue;
            }
            used.push({ manoeuvre: ids[r.argmax], curve: r.curve!, finalValue: r.finalValue, rec: r });
        }
        const primary = aggregate(used, fs);
        const outlier = (v: number) => !(v >= lo && v <= hi);
        const kept = used.filter((u) => !outlier(u.finalValue));
        const byM = new Map<number, (typeof used)[number][]>();
        for (const u of used) byM.set(u.manoeuvre, [...(byM.get(u.manoeuvre) ?? []), u]);
        const mPeaks: number[] = [];
        const mChanges: number[] = [];
        let positive = 0;
        let negative = 0;
        for (const list of byM.values()) {
            const best = list.reduce((a, b) => (b.rec.peak > a.rec.peak ? b : a));
            mPeaks.push(best.rec.peak);
            mChanges.push(Math.max(...list.map((u) => u.rec.change)));
            if (safeSp[best.rec.argmax] >= 0) positive++;
            else negative++;
        }
        return {
            ...primary,
            thresholdDegS: thr,
            windowsTotal: records.length,
            rejected,
            finalValueOutliers: used.length - kept.length,
            withoutOutliers: aggregate(kept, fs),
            excitation: byM.size
                ? {
                      medianPeakDegS: quartiles(mPeaks).median,
                      medianChangeDegS: quartiles(mChanges).median,
                      positive,
                      negative,
                  }
                : null,
            modeWords: [...new Set(used.map((u) => u.rec.modeWord))].sort((a, b) => a - b),
            batteryMedian: batteryOver(
                input.battery,
                used.map((u) => u.rec.start),
                W,
            ),
        };
    });
    return {
        status: thresholds.some((t) => t.status === "MEASURED") ? "MEASURED" : "INSUFFICIENT",
        reasons: [],
        sampleRateHz: fs,
        windowSamples: W,
        hopSamples: hop,
        fftLength: fftLengthFor(W, fs),
        saturationKnown: !!ev.saturated,
        thresholds,
    };
}

/** Median of the finite, positive battery samples inside the given windows (each sample once). */
function batteryOver(battery: ArrayLike<number> | null | undefined, starts: number[], W: number): number | null {
    if (!battery || !starts.length) return null;
    const covered = new Uint8Array(battery.length);
    for (const s of starts) covered.fill(1, s, Math.min(battery.length, s + W));
    const v: number[] = [];
    for (let i = 0; i < battery.length; i++)
        if (covered[i] && Number.isFinite(battery[i]) && battery[i] > 0) v.push(battery[i]);
    if (!v.length) return null;
    v.sort((x, y) => x - y);
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Evidence with nothing excluded (synthetic tests, and the base for stepLog.ts). */
export function cleanEvidence(n: number, saturationKnown = true): StepSampleEvidence {
    return {
        notAirborne: new Uint8Array(n),
        gapBefore: new Uint8Array(n),
        chirp: new Uint8Array(n),
        selfLevel: new Uint8Array(n),
        modeWord: new Int32Array(n),
        saturated: saturationKnown ? new Uint8Array(n) : null,
    };
}
