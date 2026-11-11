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
 * Every-axis noise and per-motor load of a filter change (block 13, 2026-11-11).
 *
 * The gyro and D-term lowpass are one setting for all three axes, so a candidate moves the noise of
 * every axis, also of the axes the joint search does not tune (no sweep; their PID stays). This module
 * predicts, on the log's own data, the controller-output noise above the noise band per axis and the
 * band power each motor receives from it through the mixer:
 *
 *   per axis a   u_a = Kp_a · gP_a + d_a   (as the firmware forms the PID sum: P on the error, D on −Δgyro)
 *                g_a  = gyroADC under the candidate gyro chain (simulated on the logged gyroUnfilt; the
 *                       logged gyroADC when the gyro chain is not searched),
 *                gP_a = −g_a (the error: the setpoint has no content in the noise band), through the yaw lowpass
 *                       (PT1 at yaw_lowpass_hz) on yaw,
 *                d_a  = the firmware D path (M5-B: d_max, TPA, dynamic D-LPF) under the candidate D-term
 *                       lowpass, run on g_a; 0 on an axis without D.
 *   per motor m  y_m = Σ_a s(m, a) · u_a with s the QUAD X mixer signs (Betaflight mixerQuadX, yaw
 *                negated as the mixer does unless yaw_motors_reversed), so correlation between the axes'
 *                noise, real on a craft whose motors shake every axis at once, is kept, not summed away.
 *
 * Band power: Welch (NOISE_WELCH_SEGMENT) over NOISE_BAND_HZ (capped at Nyquist), on the samples of the
 * noise mask (in flight, outside every CHIRP window: the sweep's own response must not count as noise)
 * where every simulation holds (maskedBandPower: per contiguous run, weighted by segments).
 *
 * Varying one axis x with gain kp and D scale ds (d_max keeps its ratio, so d is linear in ds), each
 * motor's power is a quadratic form
 *
 *   P_m = kp²·A + ds²·B + 2·kp·ds·C + R_m + 2·s·kp·E_m + 2·s·ds·F_m
 *
 * with A = P(gP_x), B = P(d_x), C = X(gP_x, d_x), R_m = P(r_m), E_m = X(gP_x, r_m), F_m = X(d_x, r_m),
 * r_m = Σ_{a≠x} s(m, a)·u_a at the other axes' current PID, and X(a, b) = (P(a + b) − P(a − b)) / 4
 * (exact for Welch power, a quadratic form). The ratio per motor is against the current tune and filters.
 * A combination that changes several axes is computed directly on the summed series.
 *
 * Not modelled (named in `limitations`): the I term and feedforward (no band power above the noise band
 * in hover), motor and ESC dynamics, mixer saturation, airmode; the motor channel itself is not
 * predicted, only what the controller adds to it. Assessable only with the chain simulation when the gyro
 * lowpass changes, and with a validated D path on every axis with D (otherwise the axis's noise is
 * unknown and so is every motor's).
 */

import { pt1Gain, PTERM_SCALE } from "@/js/blackbox/betaflight_digital_controller";
import { simulateDterm, type DtermDynamicConfig } from "@/js/blackbox/betaflight_dterm_dynamic";
import type { ChainSimulation } from "./gyroChain";
import { maskedBandPower } from "./filterOptimizer";
import type { PidValues } from "./pidOptimizer";

export type MotorAxisName = "roll" | "pitch" | "yaw";
export const MOTOR_AXES: readonly MotorAxisName[] = ["roll", "pitch", "yaw"];

/** Betaflight mixer.c mixerQuadX (roll, pitch, yaw per motor 1–4). */
export const QUADX_MIX: readonly (readonly [number, number, number])[] = [
    [-1, 1, -1],
    [-1, -1, 1],
    [1, 1, 1],
    [1, -1, -1],
];

export interface MotorNoiseAxis {
    axis: MotorAxisName;
    /** The logged tune of this axis. */
    current: PidValues;
    /** D path from the headers; null without D. */
    dterm: DtermDynamicConfig | null;
    /** The D path reproduced the logged axisD; null: axisD not logged for this axis. */
    dtermValidated: boolean | null;
    /** The gyro chain reproduced the logged gyroADC of this axis in the noise bands (80–500 Hz; validateChain noiseBand PASS). */
    chainNoiseValidated: boolean;
    /** Logged gyroADC (used when the gyro chain is not searched). */
    gyroAdc: ArrayLike<number>;
    /** yaw_lowpass_hz on the P term (yaw only); 0 / undefined: none. */
    yawLowpassHz?: number;
    /** Logged axisP and axisD of this axis (the reproduction check); null: not logged. */
    loggedP?: ArrayLike<number> | null;
    loggedD?: ArrayLike<number> | null;
}

/**
 * Reproduction check per axis (block 13): at the current tune and filters, the model's band power of
 * −Kp·gP + d against the logged axisP + axisD on the same samples. Reproduced within ±1 dB in power
 * (the logged terms are integers: their quantization adds about 1/12 per term, which this tolerance
 * absorbs at the noise levels seen). An axis that is not reproduced has no noise prediction of its own; it
 * may still enter the motor sums only while its logged share of the summed axis power stays below
 * MAX_UNREPRODUCED_SHARE (named as a limitation), otherwise the motor rule cannot be assessed.
 */
export const REPRODUCTION = Object.freeze({
    minRatio: 10 ** (-1 / 10),
    maxRatio: 10 ** (1 / 10),
    maxUnreproducedShare: 0.05,
});

export interface AxisReproduction {
    axis: MotorAxisName;
    modelPower: number | null;
    loggedPower: number | null;
    ratio: number | null;
    reproduced: boolean | null;
    /** The axis's logged power as a share of the summed logged power of all axes. */
    share: number | null;
}

export interface MotorNoiseInput {
    axes: MotorNoiseAxis[];
    timeUs: ArrayLike<number>;
    rcThrottle: ArrayLike<number>;
    sampleRateHz: number;
    pidDt: number;
    /** In flight, outside every CHIRP window. */
    noiseMask: Uint8Array;
    /** Mixer assumption: "quadx" (LEGACY mixer with four motors) or the reason none can be made. */
    mixer: { kind: "quadx"; yawReversed: boolean } | { kind: "unknown"; reason: string };
    /** Logged motor outputs (for the measured current per-motor band power; information only). */
    motors: ArrayLike<number>[] | null;
}

/** The candidate filter simulations the module reads per (gyro scale, D-LPF scale). */
export interface FilterSignals {
    /** Chain simulation for this gyro scale; null: the logged gyroADC is used (gyro lowpass not searched). */
    sim: ChainSimulation | null;
    /** The D path config per axis under this D-LPF scale (null without D). */
    dterm: (DtermDynamicConfig | null)[];
}

export interface MotorQuadratic {
    a: number;
    b: number;
    c: number;
    r: number;
    e: number;
    f: number;
    s: number;
}

export interface MotorBasis {
    /** Per motor, the quadratic coefficients for varying axis x. */
    motors: MotorQuadratic[];
    /** Per motor, the power at the current tune and filters. */
    current: number[];
    /** The varied axis's own noise at the current tune and filters (Kp0·gP + d), for its ratio. */
    axisCurrent: number;
}

export interface MotorAssessment {
    assessed: boolean;
    reasons: string[];
    /** Predicted per-motor band power ratios against the current tune; null: not assessed. */
    motorRatios: number[] | null;
    maxMotorRatio: number | null;
    /** Predicted controller-output noise ratio per axis (null: not assessed for that axis). */
    axisRatios: Partial<Record<MotorAxisName, number | null>>;
    /** What the assessment leaves out although it is made (e.g. an unreproduced axis below the share limit). */
    limitations?: string[];
}

function pt1Series(x: Float64Array, hz: number, dt: number): Float64Array {
    const k = pt1Gain(hz, dt);
    const out = new Float64Array(x.length);
    let s = x.length ? x[0] : 0;
    for (let i = 0; i < x.length; i++) {
        const v = Number.isFinite(x[i]) ? x[i] : s;
        s += k * (v - s);
        out[i] = s;
    }
    return out;
}

const add = (a: Float64Array, b: Float64Array, sb = 1) => {
    const out = new Float64Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i] + sb * b[i];
    return out;
};

export function motorNoiseModel(input: MotorNoiseInput) {
    const n = input.timeUs.length;
    const fs = input.sampleRateHz;
    const staticReasons: string[] = [];
    if (input.mixer.kind !== "quadx") staticReasons.push(`mixer_not_modelled:${input.mixer.reason}`);
    for (const a of input.axes) {
        if (a.dterm && a.dterm.d > 0 && a.dtermValidated !== true)
            staticReasons.push(
                a.dtermValidated === null
                    ? `dterm_not_logged_noise_unknown:${a.axis}`
                    : `dterm_path_not_validated:${a.axis}`,
            );
        if (a.current.d > 0 && !a.dterm) staticReasons.push(`dterm_config_missing:${a.axis}`);
    }
    const mix = (m: number, ai: number) => {
        const s = QUADX_MIX[m][ai];
        return ai === 2 && input.mixer.kind === "quadx" && !input.mixer.yawReversed ? -s : s;
    };
    const motors = QUADX_MIX.length;

    /** Per (gyro scale, D-LPF scale): gP, d per axis and the common valid mask. */
    const seriesCache = new Map<string, { gp: Float64Array[]; d: Float64Array[]; valid: Uint8Array } | null>();
    /** Why a gyro lowpass change cannot be assessed on this log (the chain must reproduce gyroADC in the noise band on every axis). */
    let reproductionCache: AxisReproduction[] | null = null;
    const gyroReasons = input.axes
        .filter((a) => !a.chainNoiseValidated)
        .map((a) => `gyro_chain_noise_band_not_validated:${a.axis}`);
    const series = (key: string, sig: FilterSignals, gyroChanged: boolean) => {
        if (seriesCache.has(key)) return seriesCache.get(key)!;
        const valid = new Uint8Array(n).fill(1);
        const gp: Float64Array[] = [];
        const d: Float64Array[] = [];
        let ok = true;
        input.axes.forEach((a, ai) => {
            const g = new Float64Array(n);
            for (let k = 0; k < n; k++) {
                if (sig.sim) {
                    const v = sig.sim.out[ai][k];
                    const good = sig.sim.valid[k] && Number.isFinite(v);
                    g[k] = good ? v : 0;
                    if (!good) valid[k] = 0;
                } else g[k] = Number(a.gyroAdc[k]);
            }
            if (gyroChanged && !sig.sim) ok = false;
            // The P term acts on the error, setpoint − gyro; the setpoint carries nothing in the noise band, so the
            // P input there is −gyro (the sign matters: it sets the cross term with the D path, which acts on −Δgyro
            // and is simulated with the logged axisD's sign).
            const neg = Float64Array.from(g, (x) => -x);
            gp.push(a.axis === "yaw" && a.yawLowpassHz ? pt1Series(neg, a.yawLowpassHz, input.pidDt) : neg);
            const cfg = sig.dterm[ai];
            if (cfg && cfg.d > 0) {
                const sim = simulateDterm({ timeUs: input.timeUs, gyro: g, rcThrottle: input.rcThrottle }, cfg);
                const dd = new Float64Array(n);
                for (let k = 0; k < n; k++) {
                    const v = sim.d[k];
                    if (!sim.valid[k] || !Number.isFinite(v)) valid[k] = 0;
                    dd[k] = Number.isFinite(v) ? v : 0;
                }
                d.push(dd);
            } else d.push(new Float64Array(n));
        });
        const out = ok ? { gp, d, valid } : null;
        seriesCache.set(key, out);
        return out;
    };
    const P = (x: Float64Array, valid: Uint8Array) => maskedBandPower(x, valid, input.noiseMask, fs);
    const X = (x: Float64Array, y: Float64Array, valid: Uint8Array) => {
        const p1 = P(add(x, y), valid);
        const p2 = P(add(x, y, -1), valid);
        return p1 === null || p2 === null ? null : (p1 - p2) / 4;
    };
    const kp = (ai: number, p: number) => PTERM_SCALE * p;
    const dScale = (ai: number, d: number) => {
        const c = input.axes[ai].current.d;
        return c > 0 ? d / c : 1;
    };
    /** u_a for given PID values (P gain and D scale) on a series set. */
    const axisOutput = (s: { gp: Float64Array[]; d: Float64Array[] }, ai: number, v: PidValues) => {
        const out = new Float64Array(n);
        const k = kp(ai, v.p);
        const ds = dScale(ai, v.d);
        for (let i = 0; i < n; i++) out[i] = k * s.gp[ai][i] + ds * s.d[ai][i];
        return out;
    };

    // Current tune and filters: per-motor and per-axis powers (the denominators of every ratio).
    let baseline: { motors: number[]; axes: (number | null)[] } | null = null;
    const baselineOf = (sig: FilterSignals) => {
        if (baseline) return baseline;
        const s = series("1|1", sig, false);
        if (!s) return null;
        const u = input.axes.map((a, ai) => axisOutput(s, ai, a.current));
        const motorsP: number[] = [];
        for (let m = 0; m < motors; m++) {
            const y = new Float64Array(n);
            for (let ai = 0; ai < input.axes.length; ai++) {
                const sg = mix(m, ai);
                for (let i = 0; i < n; i++) y[i] += sg * u[ai][i];
            }
            motorsP.push(P(y, s.valid) ?? Number.NaN);
        }
        baseline = { motors: motorsP, axes: u.map((x) => P(x, s.valid)) };
        return baseline;
    };

    const basisCache = new Map<string, MotorBasis | null>();
    /** Quadratic coefficients per motor for varying axis `xi` under one filter combination. */
    const basis = (
        key: string,
        sig: FilterSignals,
        base: FilterSignals,
        gyroChanged: boolean,
        xi: number,
    ): MotorBasis | null => {
        const bk = `${key}|${xi}`;
        if (basisCache.has(bk)) return basisCache.get(bk)!;
        const s = series(key, sig, gyroChanged);
        const b0 = baselineOf(base);
        let out: MotorBasis | null = null;
        if (s && b0) {
            const valid = s.valid;
            const gpx = s.gp[xi];
            const dx = s.d[xi];
            const A = P(gpx, valid);
            const B = P(dx, valid);
            const C = X(gpx, dx, valid);
            const others = input.axes.map((a, ai) => (ai === xi ? null : axisOutput(s, ai, a.current)));
            const ms: MotorQuadratic[] = [];
            let ok = A !== null && B !== null && C !== null;
            for (let m = 0; m < motors && ok; m++) {
                const r = new Float64Array(n);
                others.forEach((u, ai) => {
                    if (!u) return;
                    const sg = mix(m, ai);
                    for (let i = 0; i < n; i++) r[i] += sg * u[i];
                });
                const R = P(r, valid);
                const E = X(gpx, r, valid);
                const F = X(dx, r, valid);
                if (R === null || E === null || F === null) ok = false;
                else ms.push({ a: A!, b: B!, c: C!, r: R, e: E, f: F, s: mix(m, xi) });
            }
            out = ok ? { motors: ms, current: b0.motors, axisCurrent: b0.axes[xi] ?? Number.NaN } : null;
        }
        basisCache.set(bk, out);
        return out;
    };

    /** Model against the logged P + D per axis at the current tune and filters (needs the base signals). */
    const reproduction = (base: FilterSignals): AxisReproduction[] => {
        if (reproductionCache) return reproductionCache;
        const s = series("1|1", base, false);
        const rows: AxisReproduction[] = input.axes.map((a, ai) => {
            if (!s || !a.loggedP)
                return {
                    axis: a.axis,
                    modelPower: null,
                    loggedPower: null,
                    ratio: null,
                    reproduced: null,
                    share: null,
                };
            const model = P(axisOutput(s, ai, a.current), s.valid);
            const logged = new Float64Array(n);
            for (let k = 0; k < n; k++) logged[k] = Number(a.loggedP![k]) + (a.loggedD ? Number(a.loggedD[k]) || 0 : 0);
            const lp = P(logged, s.valid);
            const ratio = model !== null && lp !== null && lp > 0 ? model / lp : null;
            return {
                axis: a.axis,
                modelPower: model,
                loggedPower: lp,
                ratio,
                reproduced: ratio === null ? null : ratio >= REPRODUCTION.minRatio && ratio <= REPRODUCTION.maxRatio,
                share: null,
            };
        });
        const total = rows.reduce((acc, r) => acc + (r.loggedPower ?? 0), 0);
        for (const r of rows) r.share = total > 0 && r.loggedPower !== null ? r.loggedPower / total : null;
        reproductionCache = rows;
        return rows;
    };
    /** Reasons the motor rule cannot be assessed from the reproduction check, and the limitations it leaves. */
    const reproductionGate = (base: FilterSignals) => {
        const rows = reproduction(base);
        const blocking: string[] = [];
        const limits: string[] = [];
        for (const r of rows) {
            if (r.reproduced === true) continue;
            const what = r.reproduced === null ? "noise_reproduction_unknown" : "noise_not_reproduced";
            if (r.share !== null && r.share < REPRODUCTION.maxUnreproducedShare)
                limits.push(
                    `${what}:${r.axis}:share_${(r.share * 100).toFixed(1)}pct_below_${REPRODUCTION.maxUnreproducedShare * 100}pct`,
                );
            else blocking.push(`${what}:${r.axis}${r.ratio === null ? "" : `:model/logged_${r.ratio.toFixed(2)}`}`);
        }
        return { blocking, limits };
    };

    const evalQuadratic = (q: MotorQuadratic, k: number, ds: number) =>
        k * k * q.a + ds * ds * q.b + 2 * k * ds * q.c + q.r + 2 * q.s * k * q.e + 2 * q.s * ds * q.f;

    return {
        staticReasons,
        gyroReasons,
        /** The per-axis reproduction check at the current tune (base signals of the search). */
        reproduction,
        /** The predicted per-motor ratios for varying axis `xi` to `v` under a filter combination. */
        ratiosFor(
            key: string,
            sig: FilterSignals,
            base: FilterSignals,
            gyroChanged: boolean,
            xi: number,
            v: PidValues,
        ): { motorRatios: number[]; axisRatio: number | null } | null {
            if (staticReasons.length || (gyroChanged && gyroReasons.length)) return null;
            if (reproductionGate(base).blocking.length) return null;
            const b = basis(key, sig, base, gyroChanged, xi);
            if (!b) return null;
            const k = kp(xi, v.p);
            const ds = dScale(xi, v.d);
            const motorRatios = b.motors.map((q, m) => evalQuadratic(q, k, ds) / b.current[m]);
            const q0 = b.motors[0];
            const own = k * k * q0.a + ds * ds * q0.b + 2 * k * ds * q0.c;
            return { motorRatios, axisRatio: b.axisCurrent > 0 ? own / b.axisCurrent : null };
        },
        /** Direct assessment of a full combination: per-axis PID (absent: current) under one filter combination. */
        assess(
            key: string,
            sig: FilterSignals,
            base: FilterSignals,
            gyroChanged: boolean,
            pids: Partial<Record<MotorAxisName, PidValues>>,
        ): MotorAssessment {
            const gate = staticReasons.length ? { blocking: [], limits: [] } : reproductionGate(base);
            const reasons = [...staticReasons, ...(gyroChanged ? gyroReasons : []), ...gate.blocking];
            // The per-axis noise is still predicted for every axis the model reproduces (and, for a gyro change, whose chain
            // is validated in the noise band), even when another axis keeps the motor sums from being assessed.
            const s = staticReasons.length ? null : series(key, sig, gyroChanged);
            const b0 = staticReasons.length ? null : baselineOf(base);
            if (!s || !b0) {
                if (!staticReasons.length) reasons.push("noise_signals_not_computable");
                return { assessed: false, reasons, motorRatios: null, maxMotorRatio: null, axisRatios: {} };
            }
            const u = input.axes.map((a, ai) => axisOutput(s, ai, pids[a.axis] ?? a.current));
            const axisRatios: MotorAssessment["axisRatios"] = {};
            const repro = reproduction(base);
            input.axes.forEach((a, ai) => {
                const p = P(u[ai], s.valid);
                const p0 = b0.axes[ai];
                const chainOk = !gyroChanged || a.chainNoiseValidated;
                // An axis the model does not reproduce has no noise prediction of its own.
                axisRatios[a.axis] =
                    chainOk && repro[ai]?.reproduced === true && p !== null && p0 !== null && p0 > 0 ? p / p0 : null;
            });
            if (reasons.length)
                return {
                    assessed: false,
                    reasons,
                    motorRatios: null,
                    maxMotorRatio: null,
                    axisRatios,
                    limitations: gate.limits,
                };
            const motorRatios: number[] = [];
            for (let m = 0; m < motors; m++) {
                const y = new Float64Array(n);
                for (let ai = 0; ai < input.axes.length; ai++) {
                    const sg = mix(m, ai);
                    for (let i = 0; i < n; i++) y[i] += sg * u[ai][i];
                }
                const p = P(y, s.valid);
                motorRatios.push(p !== null && b0.motors[m] > 0 ? p / b0.motors[m] : Number.NaN);
            }
            const finite = motorRatios.every(Number.isFinite);
            return {
                assessed: finite,
                reasons: finite ? [] : ["motor_band_power_not_computable"],
                motorRatios: finite ? motorRatios : null,
                maxMotorRatio: finite ? Math.max(...motorRatios) : null,
                axisRatios,
                limitations: gate.limits,
            };
        },
        /** Measured band power of the logged motors in the noise mask (current tune; information only). */
        loggedMotorBandPower(): number[] | null {
            if (!input.motors || input.motors.length < motors) return null;
            const all = new Uint8Array(n).fill(1);
            const out = input.motors
                .slice(0, motors)
                .map((c) => maskedBandPower(Float64Array.from(c, Number), all, input.noiseMask, fs));
            return out.every((x): x is number => x !== null) ? out : null;
        },
    };
}

export type MotorNoiseModel = ReturnType<typeof motorNoiseModel>;
