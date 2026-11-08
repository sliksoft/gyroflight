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
 * Block 9: the I term in force during a CHIRP sweep (Betaflight 2026.6.2 @ 43875a55a, offline).
 *
 * pid.c adds the chirp to the rate setpoint before applyItermRelax, so the relax sees the sweep:
 *
 *   setpointLpf  = pt1(windupLpf, setpoint)            cutoff iterm_relax_cutoff, at pidDt
 *   setpointHpf  = |setpoint − setpointLpf|
 *   threshold    = 40 °/s (ITERM_RELAX_SETPOINT_THRESHOLD), × 0.2 with ANGLE_MODE active
 *   factor       = max(0, 1 − setpointHpf / threshold)    (iterm_relax_type SETPOINT)
 *   I[n]         = I[n−1] + Ki · dT · factor · (setpoint − gyroADCf)
 *
 * on roll and pitch (iterm_relax RP) or all axes (RPY). With a sweep of tens of °/s the I term is
 * frozen most of the time, so the controller in force during the sweep is not the one the headers
 * describe. This module reproduces the recurrence from logged signals only and checks it against the
 * logged axisI; the LTI stand-in is Ki × mean(factor) over the window (as M5-B does for D_max/TPA).
 *
 * Supported: iterm_relax OFF / RP / RPY with iterm_relax_type SETPOINT. The *_INC variants and the
 * GYRO type follow other rules: `unsupported`, never an approximation. Not modelled: the anti-gravity
 * iterm accelerator (throttle derivative; small at the steady throttle of a sweep, and the logged-I
 * check below would show it). ANGLE_MODE comes from the logged rcModeActivationMask (BBL field
 * "flightModeFlags", bit BOXANGLE = 1): without it the threshold is unknown.
 *
 * Offline only: no MSP, no recommendation, no Apply path.
 */

import { ITERM_SCALE, pt1Gain } from "./betaflight_digital_controller";

/** pid.h ITERM_RELAX_SETPOINT_THRESHOLD (°/s); × ANGLE_THRESHOLD_SCALE in ANGLE_MODE (pid.c). */
export const ITERM_RELAX_SETPOINT_THRESHOLD = 40;
export const ITERM_RELAX_ANGLE_THRESHOLD_SCALE = 0.2;
/** Logged rcModeActivationMask bit of BOXANGLE (rc_modes.h boxId_e; blackbox.c logs the mask). */
export const BOX_ANGLE_BIT = 1 << 1;
/** pid.h itermRelax_e / itermRelaxType_e. */
const ITERM_RELAX_OFF = 0;
const ITERM_RELAX_RP = 1;
const ITERM_RELAX_RPY = 2;
const ITERM_RELAX_TYPE_SETPOINT = 1;

/**
 * Acceptance of the reconstruction against the logged axisI over the window:
 *   - it must decide between the two hypotheses: rms(I_relax − I_logged) at most `maxRmsOfUnrelaxed`
 *     × rms(I_unrelaxed − I_logged) (the headers' I, which the engine used before block 9);
 *   - what it leaves unexplained must be small next to the controller's activity at the same samples:
 *     at most `maxRmsOfLoggedP` × rms(logged P) (P dominates C_ref and C_fb over the sweep).
 * The logged I's own variation is not the yardstick: a relaxed I barely moves, so its variation is near
 * the lrintf rounding of the log (block 9: 011849 roll, rms 0.79 against a variation of 1.12 and an
 * unrelaxed error of 20.9).
 */
export const ITERM_RELAX_ACCEPT = Object.freeze({ maxRmsOfUnrelaxed: 0.1, maxRmsOfLoggedP: 0.05 });
// Set after seeing the AIR65 data (block 9; Grok review SHOULD-FIX 1): with the firmware parameters
// the six real sweeps give ≤ 0.038 of the unrelaxed error and ≤ 0.022 of rms P (≥ 2.2× margin). The
// negative control on the same logs (block9_iterm_relax_negative.local.test.ts) rejects 16 of 18
// wrong hypotheses — all 6 ACRO thresholds, all 6 100 Hz cutoffs, 4 of 6 5 Hz cutoffs — but accepts a
// 5 Hz instead of 25 Hz cutoff on 2 of 6 sweeps (factor 0.06 instead of 0.11). The cutoff is read
// from the log header, not estimated, so the rule decides the relax hypothesis, not the cutoff.

/**
 * Pooling across flights (multi-recording): a flight's T is combined with the primary's only when its
 * I was in force the same way — same status, mean relax factor within this absolute tolerance. Design
 * parameter: 0.05 of Ki changes C_ref by ≤ 2 % at 4 Hz on the AIR65 roll (Ki/ω ≈ 0.8 against Kp ≈ 1.8);
 * the three AIR65 flights lie within 0.003.
 */
export const ITERM_RELAX_POOL_TOLERANCE = 0.05;

export interface ItermRelaxConfig {
    relax: number;
    type: number;
    cutoffHz: number;
    /** Ki as pid.c uses it (ITERM_SCALE · I, × 2.5 on yaw). */
    ki: number;
    pidDt: number;
}

export interface ItermRelaxInput {
    setpoint: ArrayLike<number>;
    gyro: ArrayLike<number>;
    loggedI: ArrayLike<number>;
    /** Logged axisP of the same axis (the activity the residual is compared with). */
    loggedP: ArrayLike<number>;
    /** Logged rcModeActivationMask per sample; null: unknown. */
    modeMask: ArrayLike<number> | null;
    start: number;
    end: number;
}

export interface ItermRelaxInForce {
    status: "reconstructed" | "not_relaxed" | "unknown";
    /** Mean relax factor over the window: Ki_sweep = Ki × meanFactor (1 when the axis is not relaxed). */
    meanFactor: number;
    /** Fraction of the window with the I term frozen (factor 0). */
    frozenFraction: number | null;
    /** rms(I_reconstructed − I_logged), rms(I_unrelaxed − I_logged), rms(I_logged − mean), rms(P_logged). */
    rmsError: number | null;
    rmsErrorUnrelaxed: number | null;
    rmsLoggedVariation: number | null;
    rmsLoggedP: number | null;
    reasons: string[];
}

/** Header keys → config for one axis; null with reasons when a key is missing or unsupported. */
export function itermRelaxConfigFromHeaders(
    headers: Record<string, string | undefined>,
    axis: 0 | 1 | 2,
    pidDt: number,
): { config: ItermRelaxConfig | null; reasons: string[] } {
    const num = (k: string) => {
        const v = Number(headers[k]?.split(",")[0]);
        return headers[k] === undefined || !Number.isFinite(v) ? null : v;
    };
    const pid = headers[["rollPID", "pitchPID", "yawPID"][axis]]?.split(",").map(Number);
    const relax = num("iterm_relax");
    const type = num("iterm_relax_type");
    const cutoffHz = num("iterm_relax_cutoff");
    if (relax === null || type === null || cutoffHz === null || !pid || !Number.isFinite(pid[1])) {
        return { config: null, reasons: ["iterm_relax_headers_missing"] };
    }
    if (relax !== ITERM_RELAX_OFF && relax !== ITERM_RELAX_RP && relax !== ITERM_RELAX_RPY) {
        return { config: null, reasons: [`iterm_relax_unsupported:${relax}`] };
    }
    if (relax !== ITERM_RELAX_OFF && type !== ITERM_RELAX_TYPE_SETPOINT) {
        return { config: null, reasons: [`iterm_relax_type_unsupported:${type}`] };
    }
    const ki = ITERM_SCALE * pid[1] * (axis === 2 ? 2.5 : 1);
    return { config: { relax, type, cutoffHz, ki, pidDt }, reasons: [] };
}

/** Whether pid.c relaxes this axis at all. */
export function itermRelaxApplies(cfg: ItermRelaxConfig, axis: 0 | 1 | 2): boolean {
    return cfg.relax !== ITERM_RELAX_OFF && (axis < 2 || cfg.relax === ITERM_RELAX_RPY);
}

/**
 * The I term in force over [start, end): the firmware recurrence from the logged setpoint and gyro,
 * started at the logged I, checked against the logged I. The setpoint low-pass is warmed up over the
 * second before the window (or what the log holds of it).
 */
export function itermRelaxInForce(input: ItermRelaxInput, cfg: ItermRelaxConfig, axis: 0 | 1 | 2): ItermRelaxInForce {
    const unknown = itermRelaxUnknown;
    if (!itermRelaxApplies(cfg, axis)) return { ...itermRelaxUnknown([]), status: "not_relaxed", frozenFraction: 0 };
    const { setpoint: sp, gyro: y, loggedI: I, loggedP: P, modeMask, start, end } = input;
    const n = Math.min(sp.length, y.length, I.length, P.length);
    if (!(start >= 0 && end > start + 1 && end <= n)) return unknown(["iterm_relax_window_invalid"]);
    if (!modeMask || modeMask.length < end) return unknown(["iterm_relax_angle_mode_unknown"]);
    const k1 = pt1Gain(cfg.cutoffHz, cfg.pidDt);
    const warm = Math.max(0, start - Math.round(1 / cfg.pidDt));
    let lpf = sp[warm];
    for (let k = warm; k < start; k++) lpf += k1 * (sp[k] - lpf);
    let iRelax = I[start];
    let iFull = I[start];
    let mean = 0;
    for (let k = start; k < end; k++) mean += I[k];
    mean /= end - start;
    let sumFactor = 0;
    let frozen = 0;
    let se = 0;
    let seFull = 0;
    let ss = 0;
    let sp2 = 0;
    for (let k = start; k < end; k++) {
        const v = sp[k];
        const e = v - y[k];
        const m = modeMask[k];
        if (![v, y[k], I[k], P[k], m].every(Number.isFinite)) return unknown(["iterm_relax_non_finite_sample"]);
        sp2 += P[k] * P[k];
        // pid.c: the I change of sample k uses the error and relax factor of sample k; the logged I
        // of sample k already holds it.
        lpf += k1 * (v - lpf);
        const threshold =
            ITERM_RELAX_SETPOINT_THRESHOLD * ((m & BOX_ANGLE_BIT) !== 0 ? ITERM_RELAX_ANGLE_THRESHOLD_SCALE : 1);
        const factor = Math.max(0, 1 - Math.abs(v - lpf) / threshold);
        if (factor === 0) frozen++;
        sumFactor += factor;
        if (k > start) {
            iRelax += cfg.ki * cfg.pidDt * factor * e;
            iFull += cfg.ki * cfg.pidDt * e;
        }
        se += (iRelax - I[k]) ** 2;
        seFull += (iFull - I[k]) ** 2;
        ss += (I[k] - mean) ** 2;
    }
    const len = end - start;
    const rmsError = Math.sqrt(se / len);
    const rmsErrorUnrelaxed = Math.sqrt(seFull / len);
    const rmsLoggedVariation = Math.sqrt(ss / len);
    const rmsLoggedP = Math.sqrt(sp2 / len);
    const out = {
        meanFactor: sumFactor / len,
        frozenFraction: frozen / len,
        rmsError,
        rmsErrorUnrelaxed,
        rmsLoggedVariation,
        rmsLoggedP,
    };
    const reasons: string[] = [];
    if (!(rmsError <= ITERM_RELAX_ACCEPT.maxRmsOfUnrelaxed * rmsErrorUnrelaxed)) {
        reasons.push(
            `iterm_relax_not_distinguished:rms ${rmsError.toFixed(3)} > ${ITERM_RELAX_ACCEPT.maxRmsOfUnrelaxed} × unrelaxed ${rmsErrorUnrelaxed.toFixed(3)}`,
        );
    }
    if (!(rmsError <= ITERM_RELAX_ACCEPT.maxRmsOfLoggedP * rmsLoggedP)) {
        reasons.push(
            `iterm_relax_residual_large:rms ${rmsError.toFixed(3)} > ${ITERM_RELAX_ACCEPT.maxRmsOfLoggedP} × rms P ${rmsLoggedP.toFixed(3)}`,
        );
    }
    return reasons.length
        ? { ...out, status: "unknown", meanFactor: 1, reasons }
        : { ...out, status: "reconstructed", reasons };
}

/** Not reconstructed: the headers' I (meanFactor 1), with the reasons. */
export function itermRelaxUnknown(reasons: string[]): ItermRelaxInForce {
    return {
        status: "unknown",
        meanFactor: 1,
        frozenFraction: null,
        rmsError: null,
        rmsErrorUnrelaxed: null,
        rmsLoggedVariation: null,
        rmsLoggedP: null,
        reasons,
    };
}

/**
 * The I term in force over one sweep of one axis, from the log headers and the logged signals:
 * not relaxed on this axis, reconstructed, or unknown (headers missing or unsupported, logged terms
 * missing, mode mask missing, reconstruction off). Signals null: the logged terms are missing.
 */
export function itermRelaxForSweep(
    headers: Record<string, string | undefined>,
    axis: 0 | 1 | 2,
    pidDt: number,
    signals: Omit<ItermRelaxInput, "start" | "end"> | null,
    window: { start: number; end: number },
): ItermRelaxInForce {
    const { config, reasons } = itermRelaxConfigFromHeaders(headers, axis, pidDt);
    if (!config) return itermRelaxUnknown(reasons);
    if (!itermRelaxApplies(config, axis)) {
        return { ...itermRelaxUnknown([]), status: "not_relaxed", frozenFraction: 0 };
    }
    if (!signals) return itermRelaxUnknown(["iterm_relax_logged_terms_missing"]);
    return itermRelaxInForce({ ...signals, ...window }, config, axis);
}

/**
 * Whether two sweeps ran the same I closely enough for their T to be extracted with one controller.
 * Two unknown sweeps pool (both with the headers' I): the primary axis then already carries
 * iterm_relax_unknown and the release model is PARTIAL (Grok review round 2, NOTE 4).
 */
export function itermRelaxPoolable(a: ItermRelaxInForce, b: ItermRelaxInForce | null | undefined): boolean {
    return !!b && a.status === b.status && Math.abs(a.meanFactor - b.meanFactor) <= ITERM_RELAX_POOL_TOLERANCE;
}
