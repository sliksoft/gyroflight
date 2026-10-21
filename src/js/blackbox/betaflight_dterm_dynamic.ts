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
 * GF-1 M5-B: dynamic D-term path of Betaflight 2026.6.2 (offline).
 *
 * M1 models dterm_lpf1 at its static cutoff. With dterm_lpf1_dyn_min_hz > 0 the
 * firmware moves that cutoff with throttle, and on axes with d_max > D it scales
 * Kd with the D_max boost. This module reproduces that path sample by sample
 * from logged signals only, so it can be checked against the logged axisD:
 *
 *   mixer.c   throttle = clamp((rcCommand[3] - 1000 + throttleAngleCorrection) / 1000, 0, 1)
 *             updateDynLpfCutoffs: quantized to 1/100, at most every 5 ms, only on change
 *   pid.c     dynLpfDTermUpdate / dynLpfCutoffFreq / dynThrottle (gyro.c)
 *             gyroRateDterm = lpf2(lpf1(notch(gyroADCf)))
 *             delta = -(gyroRateDterm[n] - gyroRateDterm[n-1]) * pidFrequency
 *             D = Kd * delta * dMaxMultiplier * tpaFactor
 *   pid_init.c D_MAX_RANGE_HZ 85, D_MAX_LOWPASS_HZ 35, gain factors 0.00008
 *
 * The mixer runs after the PID controller in the same loop, so a cutoff or TPA
 * change computed from sample n first acts on sample n+1.
 *
 * Supported: PT1 dterm_lpf1/lpf2, no dterm notch, throttle_limit_type OFF.
 * Anything else returns `unsupported` instead of an approximate model.
 * Not logged and assumed at the firmware default: throttle_correction_value 0
 * (no angle throttle correction). In ANGLE mode pidSetpointDelta is 0
 * (pid.c), so D_max boosts on gyro only; in acro the setpoint (feedforward)
 * part is not modelled and the result is marked `setpoint_boost_not_modelled`.
 *
 * Offline only: no MSP, no recommendation, no Apply path.
 */

import { DTERM_SCALE, pt1Gain, pt2Gain } from "./betaflight_digital_controller";
import type { DigitalControllerConfig } from "./betaflight_digital_controller";
import { welchTransferFunction } from "./spectral_analysis";

const PWM_RANGE_MIN = 1000;
const PWM_RANGE = 1000;
const DYN_LPF_THROTTLE_STEPS = 100;
const DYN_LPF_THROTTLE_UPDATE_DELAY_US = 5000;
const D_MAX_RANGE_HZ = 85;
const D_MAX_LOWPASS_HZ = 35;
const D_MAX_GYRO_GAIN_FACTOR = 0.00008;
/** Firmware filter type 0 = PT1 (dterm_lpf1_type / dterm_lpf2_type). */
const FILTER_PT1 = 0;

export interface DtermDynamicConfig {
    /** PID sample period (s). AIR65: 250 µs. */
    pidDt: number;
    /** Raw D gain (pidProfile pid[axis].D). */
    d: number;
    /** d_max[axis]; boost is active only when > d. */
    dMax: number;
    dMaxGain: number;
    dMaxAdvance: number;
    dtermLpf1Type: number;
    dtermLpf1StaticHz: number;
    /** dterm_lpf1_dyn_hz min,max; min 0 = static lpf1. */
    dtermLpf1DynMinHz: number;
    dtermLpf1DynMaxHz: number;
    dtermLpf1DynExpo: number;
    dtermLpf2Type: number;
    dtermLpf2StaticHz: number;
    dtermNotchHz: number;
    tpaRate: number;
    tpaBreakpoint: number;
    tpaLowRate: number;
    tpaLowBreakpoint: number;
    tpaLowAlways: boolean;
    throttleLimitType: number;
}

/** Variant used for the lpf1 cutoff: what the firmware does, or a fixed cutoff for comparison. */
export type DtermLpf1Variant = { kind: "dynamic" } | { kind: "fixed"; hz: number };

export interface DtermSimulationInput {
    timeUs: ArrayLike<number>;
    /** Logged gyroADC (°/s) of the axis: gyroADCf rounded to integers by the blackbox. */
    gyro: ArrayLike<number>;
    /** Logged rcCommand[3] (µs-style 1000…2000). */
    rcThrottle: ArrayLike<number>;
    /** Per-sample ANGLE/HORIZON flag; false (acro) marks the setpoint boost as not modelled. */
    selfLevel?: ArrayLike<boolean>;
}

export interface DtermSimulation {
    /** Predicted axisD (before the blackbox rounding). NaN where not simulated. */
    d: Float64Array;
    /** lpf1 cutoff in force at each sample (Hz). */
    cutoffHz: Float64Array;
    /** D_max multiplier at each sample (1 when inactive). */
    dMaxMultiplier: Float64Array;
    tpaFactor: Float64Array;
    /** Samples excluded as filter warm-up after the start or a gap. */
    valid: Uint8Array;
    runs: number;
    notes: string[];
}

export function supportIssues(cfg: DtermDynamicConfig): string[] {
    const issues: string[] = [];
    if (cfg.dtermLpf1Type !== FILTER_PT1) issues.push("dterm_lpf1_type_not_pt1");
    if (cfg.dtermLpf2StaticHz > 0 && cfg.dtermLpf2Type !== FILTER_PT1) issues.push("dterm_lpf2_type_not_pt1");
    if (cfg.dtermNotchHz > 0) issues.push("dterm_notch_not_modelled");
    if (cfg.throttleLimitType !== 0) issues.push("throttle_limit_not_modelled");
    if (!(cfg.pidDt > 0)) issues.push("pid_dt_unknown");
    return issues;
}

/** gyro.c dynThrottle(). */
export function dynThrottle(throttle: number): number {
    return throttle * (1 - (throttle * throttle) / 3) * 1.5;
}

/** pid.c dynLpfDTermUpdate cutoff selection (both expo branches). */
export function dynLpfCutoffHz(throttle: number, minHz: number, maxHz: number, expo: number): number {
    if (expo > 0) {
        const expof = expo / 10;
        const curve = throttle * (1 - throttle) * expof + throttle;
        return (maxHz - minHz) * curve + minHz;
    }
    return Math.max(dynThrottle(throttle) * maxHz, minHz);
}

/** mixer.c normal (non-3D) throttle, without angle throttle correction (not logged; default 0). */
export function mixerThrottle(rcThrottle: number): number {
    return Math.min(Math.max((rcThrottle - PWM_RANGE_MIN) / PWM_RANGE, 0), 1);
}

/** lpf1 cutoff the firmware sets for a (quantized) mixer throttle. */
export function dtermLpf1CutoffForThrottle(cfg: DtermDynamicConfig, throttle: number): number {
    if (!(cfg.dtermLpf1DynMinHz > 0)) {
        return cfg.dtermLpf1StaticHz;
    }
    const q = Math.round(throttle * DYN_LPF_THROTTLE_STEPS) / DYN_LPF_THROTTLE_STEPS;
    return dynLpfCutoffHz(q, cfg.dtermLpf1DynMinHz, cfg.dtermLpf1DynMaxHz, cfg.dtermLpf1DynExpo);
}

class Pt1State {
    state = 0;
    constructor(public k: number) {}
    apply(x: number) {
        this.state += this.k * (x - this.state);
        return this.state;
    }
}

class Pt2State {
    s1 = 0;
    s2 = 0;
    constructor(public k: number) {}
    apply(x: number) {
        this.s1 += this.k * (x - this.s1);
        this.s2 += this.k * (this.s1 - this.s2);
        return this.s2;
    }
}

/** pid.c getTpaFactorClassic(), stateful because of the low-breakpoint fade. */
class Tpa {
    private lowFaded = false;
    private readonly breakpoint: number;
    private readonly multiplier: number;
    private readonly lowBreakpoint: number;
    private readonly lowMultiplier: number;
    constructor(private readonly cfg: DtermDynamicConfig) {
        this.breakpoint = Math.min(Math.max((cfg.tpaBreakpoint - PWM_RANGE_MIN) / 1000, 0), 0.99);
        this.multiplier = cfg.tpaRate / 100 / (1 - this.breakpoint);
        const low = Math.min(Math.max((cfg.tpaLowBreakpoint - PWM_RANGE_MIN) / 1000, 0.01), 1);
        this.lowBreakpoint = Math.min(low, this.breakpoint);
        this.lowMultiplier = cfg.tpaLowRate / (100 * this.lowBreakpoint);
    }
    factor(throttle: number): number {
        const past = throttle >= this.lowBreakpoint || this.lowBreakpoint <= 0.01;
        let rate: number;
        if (past || this.lowFaded) {
            rate = this.multiplier * Math.max(throttle - this.breakpoint, 0);
            if (!this.cfg.tpaLowAlways && !this.lowFaded) {
                this.lowFaded = true;
            }
        } else {
            rate = this.lowMultiplier * (this.lowBreakpoint - throttle);
        }
        return 1 - rate;
    }
}

/** Samples discarded after the start and after every gap while the filters settle. */
export const DTERM_WARMUP_S = 0.1;
/** A spacing above this multiple of the nominal PID period breaks the run (dropped frame). */
export const DTERM_GAP_FACTOR = 1.5;

/**
 * Run the firmware D path over a logged trace. Every dropped frame restarts the
 * filters (their state across the gap is unknown) and the warm-up is discarded.
 */
export function simulateDterm(
    input: DtermSimulationInput,
    cfg: DtermDynamicConfig,
    variant: DtermLpf1Variant = { kind: "dynamic" },
): DtermSimulation {
    const n = input.gyro.length;
    const d = new Float64Array(n).fill(NaN);
    const cutoffHz = new Float64Array(n).fill(NaN);
    const dMaxMultiplier = new Float64Array(n).fill(NaN);
    const tpaFactor = new Float64Array(n).fill(NaN);
    const valid = new Uint8Array(n);
    const notes: string[] = [];
    const issues = supportIssues(cfg);
    if (issues.length || n < 2 || input.timeUs.length !== n || input.rcThrottle.length !== n) {
        return {
            d,
            cutoffHz,
            dMaxMultiplier,
            tpaFactor,
            valid,
            runs: 0,
            notes: issues.length ? issues : ["input_mismatch"],
        };
    }

    const Kd = DTERM_SCALE * cfg.d;
    const pidFrequency = 1 / cfg.pidDt;
    const dMaxPercent = cfg.d > 0 && cfg.dMax > cfg.d ? cfg.dMax / cfg.d : 1;
    const dMaxGyroGain = (D_MAX_GYRO_GAIN_FACTOR * cfg.dMaxGain) / D_MAX_LOWPASS_HZ;
    const nominalUs = cfg.pidDt * 1e6;
    const warmup = Math.ceil(DTERM_WARMUP_S / cfg.pidDt);
    let setpointBoostMissing = false;
    let runs = 0;

    let i = 0;
    while (i < n) {
        // One run: consecutive samples without a dropped frame.
        let end = i + 1;
        while (end < n && input.timeUs[end] - input.timeUs[end - 1] <= nominalUs * DTERM_GAP_FACTOR) end++;
        if (end - i > warmup + 1) {
            runs++;
            const throttle0 = mixerThrottle(input.rcThrottle[i]);
            let cutoff = variant.kind === "fixed" ? variant.hz : dtermLpf1CutoffForThrottle(cfg, throttle0);
            const lpf1 = new Pt1State(pt1Gain(cutoff, cfg.pidDt));
            const lpf2 = cfg.dtermLpf2StaticHz > 0 ? new Pt1State(pt1Gain(cfg.dtermLpf2StaticHz, cfg.pidDt)) : null;
            const dMaxRange = new Pt2State(pt2Gain(D_MAX_RANGE_HZ, cfg.pidDt));
            const dMaxLowpass = new Pt2State(pt2Gain(D_MAX_LOWPASS_HZ, cfg.pidDt));
            dMaxLowpass.s1 = dMaxLowpass.s2 = 1;
            const tpa = new Tpa(cfg);
            let tpaNow = tpa.factor(throttle0);
            let lastQuantized = Math.round(throttle0 * DYN_LPF_THROTTLE_STEPS);
            let lastUpdateUs = input.timeUs[i];
            const g0 = input.gyro[i];
            lpf1.state = g0;
            if (lpf2) lpf2.state = g0;
            let prev = g0;

            for (let k = i; k < end; k++) {
                let g = lpf1.apply(input.gyro[k]);
                if (lpf2) g = lpf2.apply(g);
                const delta = -(g - prev) * pidFrequency;
                prev = g;
                let mult = 1;
                if (dMaxPercent > 1) {
                    const gyroFactor = Math.abs(dMaxRange.apply(delta)) * dMaxGyroGain;
                    if (input.selfLevel && !input.selfLevel[k]) setpointBoostMissing = true;
                    mult = 1 + (dMaxPercent - 1) * gyroFactor;
                    mult = Math.min(dMaxLowpass.apply(mult), dMaxPercent);
                }
                cutoffHz[k] = cutoff;
                dMaxMultiplier[k] = mult;
                tpaFactor[k] = tpaNow;
                d[k] = Kd * delta * mult * tpaNow;
                if (k - i >= warmup) valid[k] = 1;

                // Mixer of the same loop: TPA every loop, lpf1 cutoff quantized and rate-limited.
                const throttle = mixerThrottle(input.rcThrottle[k]);
                tpaNow = tpa.factor(throttle);
                if (variant.kind === "dynamic" && cfg.dtermLpf1DynMinHz > 0) {
                    const t = input.timeUs[k];
                    if (t - lastUpdateUs >= DYN_LPF_THROTTLE_UPDATE_DELAY_US) {
                        const q = Math.round(throttle * DYN_LPF_THROTTLE_STEPS);
                        if (q !== lastQuantized) {
                            cutoff = dynLpfCutoffHz(
                                q / DYN_LPF_THROTTLE_STEPS,
                                cfg.dtermLpf1DynMinHz,
                                cfg.dtermLpf1DynMaxHz,
                                cfg.dtermLpf1DynExpo,
                            );
                            lpf1.k = pt1Gain(cutoff, cfg.pidDt);
                            lastQuantized = q;
                            lastUpdateUs = t;
                        }
                    }
                }
            }
        }
        i = end;
    }
    if (setpointBoostMissing) notes.push("setpoint_boost_not_modelled");
    return { d, cutoffHz, dMaxMultiplier, tpaFactor, valid, runs, notes };
}

export interface DtermBandFit {
    loHz: number;
    hiHz: number;
    bins: number;
    /** Mean |H| of logged axisD over predicted axisD (1 = model gain right). */
    gainRatio: number | null;
    /** Mean phase of that ratio (°; 0 = model phase right). */
    phaseDeg: number | null;
    coherence: number | null;
}

export interface DtermFit {
    samples: number;
    /** rms(logged − predicted) / rms(logged) over valid samples. */
    nrmse: number;
    bands: DtermBandFit[];
}

export const DTERM_FIT_BANDS: readonly [number, number][] = [
    [2, 20],
    [20, 80],
    [80, 200],
];

/** Compare a prediction with the logged axisD over the valid samples of each run. */
export function fitDterm(
    sim: DtermSimulation,
    loggedD: ArrayLike<number>,
    sampleRateHz: number,
    segmentSize = 1024,
    bands: readonly [number, number][] = DTERM_FIT_BANDS,
): DtermFit | null {
    const pred: number[] = [];
    const meas: number[] = [];
    let se = 0;
    let ss = 0;
    for (let k = 0; k < sim.d.length; k++) {
        if (!sim.valid[k] || !Number.isFinite(sim.d[k]) || !Number.isFinite(loggedD[k])) continue;
        pred.push(sim.d[k]);
        meas.push(loggedD[k]);
        se += (loggedD[k] - sim.d[k]) ** 2;
        ss += loggedD[k] ** 2;
    }
    if (pred.length < segmentSize || ss === 0) {
        return null;
    }
    // Runs are concatenated; the joins add a little leakage, the same for every variant.
    const tf = welchTransferFunction(Float64Array.from(pred), Float64Array.from(meas), sampleRateHz, segmentSize, 0.5);
    const out: DtermBandFit[] = bands.map(([lo, hi]) => {
        let re = 0;
        let im = 0;
        let mag = 0;
        let coh = 0;
        let bins = 0;
        for (let k = 0; k < tf.frequencies.length; k++) {
            const f = tf.frequencies[k];
            if (f < lo || f >= hi) continue;
            const h = { re: tf.hReal[k], im: tf.hImag[k] };
            const m = Math.hypot(h.re, h.im);
            mag += m;
            re += h.re / (m || 1);
            im += h.im / (m || 1);
            coh += tf.coherence[k];
            bins++;
        }
        return bins
            ? {
                  loHz: lo,
                  hiHz: hi,
                  bins,
                  gainRatio: mag / bins,
                  phaseDeg: (Math.atan2(im, re) * 180) / Math.PI,
                  coherence: coh / bins,
              }
            : { loHz: lo, hiHz: hi, bins: 0, gainRatio: null, phaseDeg: null, coherence: null };
    });
    return { samples: pred.length, nrmse: Math.sqrt(se / ss), bands: out };
}

export interface DtermCutoffSummary {
    minHz: number;
    medianHz: number;
    maxHz: number;
}

export function summarizeCutoff(sim: DtermSimulation): DtermCutoffSummary | null {
    const v: number[] = [];
    for (let k = 0; k < sim.cutoffHz.length; k++) if (sim.valid[k]) v.push(sim.cutoffHz[k]);
    if (!v.length) return null;
    v.sort((a, b) => a - b);
    return { minHz: v[0], medianHz: v[Math.floor(v.length / 2)], maxHz: v[v.length - 1] };
}

/** LTI stand-in for the dynamic D path over one window (e.g. a CHIRP sweep), for M1–M3 FRFs. */
export interface EffectiveDterm {
    samples: number;
    /** Median lpf1 cutoff in force over the window (Hz). */
    lpf1Hz: number;
    cutoff: DtermCutoffSummary;
    /** Mean D_max multiplier × TPA factor: the Kd scale the firmware applied. */
    kdScale: number;
    /** 5th / 95th percentile of that scale; a wide range means D_max is far from linear here. */
    kdScaleP5: number;
    kdScaleP95: number;
}

export function effectiveDtermOverWindow(sim: DtermSimulation, start: number, end: number): EffectiveDterm | null {
    const cut: number[] = [];
    const scale: number[] = [];
    for (let k = Math.max(0, start); k < Math.min(end, sim.d.length); k++) {
        if (!sim.valid[k]) continue;
        cut.push(sim.cutoffHz[k]);
        scale.push(sim.dMaxMultiplier[k] * sim.tpaFactor[k]);
    }
    if (!cut.length) return null;
    cut.sort((a, b) => a - b);
    const sorted = [...scale].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    return {
        samples: cut.length,
        lpf1Hz: cut[Math.floor(cut.length / 2)],
        cutoff: { minHz: cut[0], medianHz: cut[Math.floor(cut.length / 2)], maxHz: cut[cut.length - 1] },
        kdScale: scale.reduce((a, b) => a + b, 0) / scale.length,
        kdScaleP5: at(0.05),
        kdScaleP95: at(0.95),
    };
}

/** M1 config with the window's effective lpf1 cutoff and Kd scale in place of the static values. */
export function withEffectiveDterm(cfg: DigitalControllerConfig, eff: EffectiveDterm): DigitalControllerConfig {
    return { ...cfg, dtermLpf1Hz: eff.lpf1Hz, axis: { ...cfg.axis, d: cfg.axis.d * eff.kdScale } };
}

/**
 * Acceptance for using the dynamic D path in place of the static one: the
 * firmware-exact simulation must reproduce the logged axisD (coherent bands
 * within 5 % gain and 3° phase, NRMSE below the static model's) on every log.
 */
export const DTERM_ACCEPT = { maxGainError: 0.05, maxPhaseDeg: 3, minCoherence: 0.9 } as const;

export function dtermFitAccepted(dynamic: DtermFit | null, staticFit: DtermFit | null): boolean {
    if (!dynamic || !staticFit || !(dynamic.nrmse < staticFit.nrmse)) return false;
    const coherent = dynamic.bands.filter((b) => b.coherence !== null && b.coherence >= DTERM_ACCEPT.minCoherence);
    return (
        coherent.length > 0 &&
        coherent.every(
            (b) =>
                Math.abs((b.gainRatio ?? Infinity) - 1) <= DTERM_ACCEPT.maxGainError &&
                Math.abs(b.phaseDeg ?? Infinity) <= DTERM_ACCEPT.maxPhaseDeg,
        )
    );
}

/** Header keys (BBL "H name:value") → config; null when a required key is missing. */
export function dtermConfigFromHeaders(
    headers: Record<string, string | undefined>,
    axis: 0 | 1 | 2,
    pidDt: number,
): DtermDynamicConfig | null {
    const nums = (key: string) => {
        const raw = headers[key];
        if (raw === undefined) return null;
        const v = raw.split(",").map(Number);
        return v.every(Number.isFinite) ? v : null;
    };
    const pidKey = ["rollPID", "pitchPID", "yawPID"][axis];
    const pid = nums(pidKey);
    const dMax = nums("d_max");
    const dyn = nums("dterm_lpf1_dyn_hz");
    const need = [
        "d_max_gain",
        "d_max_advance",
        "dterm_lpf1_type",
        "dterm_lpf1_static_hz",
        "dterm_lpf1_dyn_expo",
        "dterm_lpf2_type",
        "dterm_lpf2_static_hz",
        "dterm_notch_hz",
        "tpa_rate",
        "tpa_breakpoint",
        "tpa_low_rate",
        "tpa_low_breakpoint",
        "tpa_low_always",
        "throttle_limit_type",
    ].map((k) => nums(k)?.[0] ?? null);
    if (!pid || pid.length < 3 || !dMax || dMax.length < 3 || !dyn || dyn.length < 2 || need.some((v) => v === null)) {
        return null;
    }
    const [
        dMaxGain,
        dMaxAdvance,
        lpf1Type,
        lpf1Static,
        dynExpo,
        lpf2Type,
        lpf2Static,
        notchHz,
        tpaRate,
        tpaBp,
        tpaLowRate,
        tpaLowBp,
        tpaLowAlways,
        throttleLimitType,
    ] = need as number[];
    return {
        pidDt,
        d: pid[2],
        dMax: dMax[axis],
        dMaxGain,
        dMaxAdvance,
        dtermLpf1Type: lpf1Type,
        dtermLpf1StaticHz: lpf1Static,
        dtermLpf1DynMinHz: dyn[0],
        dtermLpf1DynMaxHz: dyn[1],
        dtermLpf1DynExpo: dynExpo,
        dtermLpf2Type: lpf2Type,
        dtermLpf2StaticHz: lpf2Static,
        dtermNotchHz: notchHz,
        tpaRate,
        tpaBreakpoint: tpaBp,
        tpaLowRate,
        tpaLowBreakpoint: tpaLowBp,
        tpaLowAlways: tpaLowAlways !== 0,
        throttleLimitType,
    };
}
