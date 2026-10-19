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
 * GF-1 M2: structure-aware open-loop / phase-margin reconstruction (offline).
 *
 *   L(z) = C_feedback(z) · T(z) / (C_reference(z) − T(z) · C_feedback(z))
 *
 * T is the measured closed-loop FRF y/r from Welch on Blackbox setpoint→gyroADCf.
 * Blackbox setpoint already includes chirp phaseComp — do not fold H_phase into
 * C_reference again (C_reference = Ce from M1).
 *
 * Not wired into recommendGains / Apply. Product path stays NOT_VALIDATED until
 * a separate ack promotes a validated openLoopModel.
 */

import type { TransferFunction } from "./spectral_analysis";
import {
    type Complex,
    type DigitalControllerConfig,
    cadd,
    cdiv,
    cmag,
    cmul,
    cphaseDeg,
    cscale,
    csub,
    evaluateControllerFrf,
} from "./betaflight_digital_controller";

/** Same usable-bin floor as Quality V2 / existing open-loop path (do not change). */
export const OPEN_LOOP_COHERENCE_MIN = 0.5;

/** Skip DC / near-DC bins where integrator/plant make T≈1 and the denominator vanishes. */
export const MIN_OPEN_LOOP_HZ = 2;

/**
 * Relative denominator floor: skip bin when |C_ref − T·C_fb| / max(|C_ref|, |T·C_fb|, ε) < this.
 * Chosen a priori to reject numerically singular reconstructions, not to pass a test.
 */
export const DENOMINATOR_REL_MIN = 1e-4;

export type OpenLoopBinStatus =
    | "ok"
    | "low_coherence"
    | "below_min_hz"
    | "singular_denominator"
    | "non_finite_T";

export interface StabilityLoopBin {
    frequencyHz: number;
    status: OpenLoopBinStatus;
    /** Complex L when status === "ok". */
    L: Complex | null;
    magnitude: number;
    /** Unwrapped degrees when status === "ok"; NaN otherwise. */
    phaseDeg: number;
    coherence: number;
}

export interface StabilityLoopResponse {
    bins: StabilityLoopBin[];
    startIndex: number;
    /** True when C_ref ≈ C_fb over evaluated bins (yaw-style unity structure). */
    unityFeedbackEquivalent: boolean;
}

export interface GainCrossoverResult {
    frequencyHz: number;
    phaseMarginDeg: number;
    /** Coherence on the two bins that bracket |L|=1. */
    coherenceLow: number;
    coherenceHigh: number;
    status: "ok" | "no_crossing" | "unreliable_neighbourhood";
    reason?: string;
}

export type PhaseMarginValidationStatus = "VALIDATED" | "NOT_VALIDATED" | "UNAVAILABLE";

export interface StructureAwarePhaseMargin {
    crossover: GainCrossoverResult | null;
    status: PhaseMarginValidationStatus;
    blockReasons: string[];
    unityFeedbackEquivalent: boolean;
    loop: StabilityLoopResponse;
}

function tAt(tf: TransferFunction, k: number): Complex {
    return { re: tf.hReal[k], im: tf.hImag[k] };
}

/**
 * Reconstruct L(z) bin-by-bin from measured T and the M1 digital controller.
 */
export function reconstructStabilityLoop(
    tf: TransferFunction,
    cfg: DigitalControllerConfig,
    opts: { coherenceMin?: number; minHz?: number; denomRelMin?: number } = {},
): StabilityLoopResponse {
    const coherenceMin = opts.coherenceMin ?? OPEN_LOOP_COHERENCE_MIN;
    const minHz = opts.minHz ?? MIN_OPEN_LOOP_HZ;
    const denomRelMin = opts.denomRelMin ?? DENOMINATOR_REL_MIN;
    const n = tf.frequencies.length;
    const bins: StabilityLoopBin[] = new Array(n);

    let startIndex = 0;
    for (let k = 1; k < n; k++) {
        if (tf.frequencies[k] >= minHz) {
            startIndex = k;
            break;
        }
    }

    let offset = 0;
    let previousRaw: number | null = null;
    let unityOk = true;
    let unityChecks = 0;

    for (let k = 0; k < n; k++) {
        const frequencyHz = tf.frequencies[k];
        const coherence = tf.coherence[k];
        const base: StabilityLoopBin = {
            frequencyHz,
            status: "ok",
            L: null,
            magnitude: Number.NaN,
            phaseDeg: Number.NaN,
            coherence,
        };

        if (k < startIndex || frequencyHz < minHz) {
            base.status = "below_min_hz";
            bins[k] = base;
            continue;
        }
        if (!(coherence >= coherenceMin)) {
            base.status = "low_coherence";
            bins[k] = base;
            continue;
        }

        const T = tAt(tf, k);
        if (!Number.isFinite(T.re) || !Number.isFinite(T.im)) {
            base.status = "non_finite_T";
            bins[k] = base;
            continue;
        }

        const frf = evaluateControllerFrf(cfg, frequencyHz);
        const Cref = frf.cReference;
        const Cfb = frf.cFeedback;

        // Track whether Ce ≈ Cfb (no D path) — yaw unity-feedback equivalence.
        const relDiff = cmag(csub(Cref, Cfb)) / Math.max(cmag(Cref), cmag(Cfb), 1e-12);
        unityChecks++;
        if (relDiff > 1e-6) unityOk = false;

        const TCfb = cmul(T, Cfb);
        const denom = csub(Cref, TCfb);
        const denomMag = cmag(denom);
        const scale = Math.max(cmag(Cref), cmag(TCfb), 1e-12);
        if (!(denomMag / scale >= denomRelMin)) {
            base.status = "singular_denominator";
            bins[k] = base;
            continue;
        }

        const L = cmul(Cfb, cdiv(T, denom));
        const raw = cphaseDeg(L);
        if (previousRaw !== null) {
            const delta = raw - previousRaw;
            if (delta > 180) offset -= 360;
            else if (delta < -180) offset += 360;
        }
        previousRaw = raw;

        base.L = L;
        base.magnitude = cmag(L);
        base.phaseDeg = raw + offset;
        bins[k] = base;
    }

    return {
        bins,
        startIndex,
        unityFeedbackEquivalent: unityChecks > 0 && unityOk,
    };
}

/**
 * Gain crossover: first downward crossing of |L| through 1 on coherent OK bins.
 * Neighbourhood reliability: both bracket bins ok + coherent (already enforced).
 */
export function findGainCrossover(loop: StabilityLoopResponse): GainCrossoverResult {
    const { bins, startIndex } = loop;
    for (let k = startIndex + 1; k < bins.length; k++) {
        const a = bins[k - 1];
        const b = bins[k];
        if (a.status !== "ok" || b.status !== "ok") continue;
        if (!(a.magnitude > 1 && b.magnitude <= 1)) continue;

        // Require a small coherent neighbourhood (one bin either side when present).
        const left = bins[k - 2];
        const right = bins[k + 1];
        if (left && left.frequencyHz >= MIN_OPEN_LOOP_HZ && left.status !== "ok" && left.status !== "below_min_hz") {
            return {
                frequencyHz: Number.NaN,
                phaseMarginDeg: Number.NaN,
                coherenceLow: a.coherence,
                coherenceHigh: b.coherence,
                status: "unreliable_neighbourhood",
                reason: `neighbour_bin_status:${left.status}`,
            };
        }
        if (right && right.status !== "ok" && right.status !== "low_coherence") {
            // trailing low_coherence after crossing is common at high f — only fail hard statuses
            if (right.status === "singular_denominator" || right.status === "non_finite_T") {
                return {
                    frequencyHz: Number.NaN,
                    phaseMarginDeg: Number.NaN,
                    coherenceLow: a.coherence,
                    coherenceHigh: b.coherence,
                    status: "unreliable_neighbourhood",
                    reason: `neighbour_bin_status:${right.status}`,
                };
            }
        }

        const frac = (1 - a.magnitude) / (b.magnitude - a.magnitude);
        const frequencyHz = a.frequencyHz + frac * (b.frequencyHz - a.frequencyHz);
        const phaseDeg = a.phaseDeg + frac * (b.phaseDeg - a.phaseDeg);
        return {
            frequencyHz,
            phaseMarginDeg: 180 + phaseDeg,
            coherenceLow: a.coherence,
            coherenceHigh: b.coherence,
            status: "ok",
        };
    }
    return {
        frequencyHz: Number.NaN,
        phaseMarginDeg: Number.NaN,
        coherenceLow: Number.NaN,
        coherenceHigh: Number.NaN,
        status: "no_crossing",
        reason: "no_downward_|L|_crossing_on_ok_bins",
    };
}

export interface PhaseMarginPolicy {
    /** Extra block reasons (dyn_notch unknown, etc.). */
    externalBlockReasons?: string[];
    /** If true, unity-feedback equivalence is required for VALIDATED. */
    requireUnityFeedbackEquivalent?: boolean;
}

/**
 * Offline phase-margin verdict. Never promotes VALIDATED when external blockers
 * (unknown dyn filters, D_max, …) are present.
 */
export function evaluateStructureAwarePhaseMargin(
    tf: TransferFunction,
    cfg: DigitalControllerConfig,
    policy: PhaseMarginPolicy = {},
): StructureAwarePhaseMargin {
    const loop = reconstructStabilityLoop(tf, cfg);
    const crossover = findGainCrossover(loop);
    const blockReasons = [...(policy.externalBlockReasons ?? [])];

    if (policy.requireUnityFeedbackEquivalent && !loop.unityFeedbackEquivalent) {
        blockReasons.push("controller_not_unity_feedback_equivalent");
    }

    if (crossover.status !== "ok") {
        blockReasons.push(`crossover:${crossover.status}${crossover.reason ? `:${crossover.reason}` : ""}`);
        return {
            crossover,
            status: blockReasons.length ? "NOT_VALIDATED" : "UNAVAILABLE",
            blockReasons,
            unityFeedbackEquivalent: loop.unityFeedbackEquivalent,
            loop,
        };
    }

    if (blockReasons.length) {
        return {
            crossover,
            status: "NOT_VALIDATED",
            blockReasons,
            unityFeedbackEquivalent: loop.unityFeedbackEquivalent,
            loop,
        };
    }

    return {
        crossover,
        status: "VALIDATED",
        blockReasons: [],
        unityFeedbackEquivalent: loop.unityFeedbackEquivalent,
        loop,
    };
}

/** Classic L = T/(1−T) for comparison (unity structure only). */
export function unityFeedbackL(T: Complex): Complex | null {
    const denom = csub({ re: 1, im: 0 }, T);
    if (cmag(denom) < 1e-12) return null;
    return cdiv(T, denom);
}

/**
 * Analytic closed-loop T from known plant G and controller (frequency domain):
 *   T = (C_ref · G) / (1 + C_fb · G)
 */
export function closedLoopFromPlant(
    G: Complex,
    Cref: Complex,
    Cfb: Complex,
): Complex {
    const num = cmul(Cref, G);
    const den = cadd({ re: 1, im: 0 }, cmul(Cfb, G));
    return cdiv(num, den);
}

/** True stability loop L = C_fb · G. */
export function trueStabilityLoop(G: Complex, Cfb: Complex): Complex {
    return cmul(Cfb, G);
}

/** Simple continuous plant sampled on the frequency grid: G = K/(jω (jω/ωm+1)) · e^{-jωτ}. */
export function plantFrf(freqHz: number, opts: { K: number; motorHz: number; delayS: number }): Complex {
    const w = 2 * Math.PI * freqHz;
    if (w === 0) return { re: 0, im: 0 };
    const jw = { re: 0, im: w };
    const motor = cadd({ re: 1, im: 0 }, cscale(jw, 1 / (2 * Math.PI * opts.motorHz)));
    const G = cdiv({ re: opts.K, im: 0 }, cmul(jw, motor));
    const d = { re: Math.cos(-w * opts.delayS), im: Math.sin(-w * opts.delayS) };
    return cmul(G, d);
}

/**
 * Build a synthetic TransferFunction from analytic T(f) for independent tests.
 */
export function syntheticTransferFunction(
    frequenciesHz: number[],
    Tof: (f: number) => Complex,
    coherence = 1,
): TransferFunction {
    const n = frequenciesHz.length;
    const frequencies = new Float64Array(frequenciesHz);
    const magnitude = new Float64Array(n);
    const phase = new Float64Array(n);
    const coh = new Float64Array(n);
    const hReal = new Float64Array(n);
    const hImag = new Float64Array(n);
    for (let k = 0; k < n; k++) {
        const T = Tof(frequenciesHz[k]);
        hReal[k] = T.re;
        hImag[k] = T.im;
        magnitude[k] = 20 * Math.log10(Math.max(cmag(T), 1e-15));
        phase[k] = cphaseDeg(T);
        coh[k] = typeof coherence === "number" ? coherence : 1;
    }
    return { frequencies, magnitude, phase, coherence: coh, hReal, hImag, numSegments: 32 };
}

export function syntheticTransferFunctionWithCoherence(
    frequenciesHz: number[],
    Tof: (f: number) => Complex,
    cohOf: (f: number) => number,
): TransferFunction {
    const tf = syntheticTransferFunction(frequenciesHz, Tof, 1);
    for (let k = 0; k < frequenciesHz.length; k++) {
        tf.coherence[k] = cohOf(frequenciesHz[k]);
    }
    return tf;
}

/** AIR65 unknown dynamics that keep flight PM NOT_VALIDATED even if math is fine. */
export const AIR65_EXTERNAL_BLOCKERS = [
    "dyn_notch_centres_unknown",
    "rpm_filter_schedule_unknown",
] as const;
