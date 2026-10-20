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
 * GF-1 M2 / M3: structure-aware open-loop / plant-fixed what-if (offline).
 *
 *   L(z) = C_feedback(z) · T(z) / (C_reference(z) − T(z) · C_feedback(z))
 *   G(z) = T(z) / (C_reference(z) − T(z) · C_feedback(z))   (M3 plant extract)
 *   T_candidate = (C_ref_c · G) / (1 + C_fb_c · G)           (M3 plant-fixed)
 *
 * T is the measured closed-loop FRF y/r from Welch on Blackbox setpoint→gyroADCf.
 * Blackbox setpoint already includes chirp phaseComp — do not fold H_phase into
 * C_reference again (C_reference = Ce from M1).
 *
 * Not wired into recommendGains / Apply. Product path stays NOT_VALIDATED until
 * a separate ack promotes a validated openLoopModel. Algebraic self-consistency
 * of G↔T is NOT independent gain-change validation.
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
    /**
     * True when phase unwrap was reset because one or more non-ok bins interrupted
     * the ok-bin sequence (missing / low-coherence / singular gaps).
     */
    phaseUnwrapInterrupted: boolean;
}

export interface GainCrossoverResult {
    frequencyHz: number;
    phaseMarginDeg: number;
    /** Coherence on the two bins that bracket |L|=1. */
    coherenceLow: number;
    coherenceHigh: number;
    status: "ok" | "no_crossing" | "unreliable_neighbourhood" | "ambiguous_multiple";
    reason?: string;
}

export type PhaseMarginValidationStatus = "VALIDATED" | "NOT_VALIDATED" | "UNAVAILABLE";

export interface StructureAwarePhaseMargin {
    /** Primary (lowest-frequency downward) crossing, or null when none. */
    crossover: GainCrossoverResult | null;
    /** Every downward |L|=1 crossing on ok bins (diagnostic; may be >1). */
    crossovers: GainCrossoverResult[];
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
    let sawOkBin = false;
    let phaseUnwrapInterrupted = false;
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
            // Gap in the ok sequence: do not continue unwrap across unreliable bins.
            if (sawOkBin && previousRaw !== null) {
                phaseUnwrapInterrupted = true;
                previousRaw = null;
                offset = 0;
            }
            continue;
        }

        const T = tAt(tf, k);
        if (!Number.isFinite(T.re) || !Number.isFinite(T.im)) {
            base.status = "non_finite_T";
            bins[k] = base;
            if (sawOkBin && previousRaw !== null) {
                phaseUnwrapInterrupted = true;
                previousRaw = null;
                offset = 0;
            }
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
            if (sawOkBin && previousRaw !== null) {
                phaseUnwrapInterrupted = true;
                previousRaw = null;
                offset = 0;
            }
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
        sawOkBin = true;

        base.L = L;
        base.magnitude = cmag(L);
        base.phaseDeg = raw + offset;
        bins[k] = base;
    }

    return {
        bins,
        startIndex,
        unityFeedbackEquivalent: unityChecks > 0 && unityOk,
        phaseUnwrapInterrupted,
    };
}

function crossingAt(
    bins: StabilityLoopBin[],
    k: number,
): GainCrossoverResult | null {
    const a = bins[k - 1];
    const b = bins[k];
    if (a.status !== "ok" || b.status !== "ok") return null;
    if (!(a.magnitude > 1 && b.magnitude <= 1)) return null;

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

/**
 * Every downward |L|=1 crossing on coherent OK bins (diagnostic for ambiguity).
 */
export function findAllGainCrossovers(loop: StabilityLoopResponse): GainCrossoverResult[] {
    const { bins, startIndex } = loop;
    const out: GainCrossoverResult[] = [];
    for (let k = startIndex + 1; k < bins.length; k++) {
        const xo = crossingAt(bins, k);
        if (xo) out.push(xo);
    }
    return out;
}

/**
 * Gain crossover: first downward crossing of |L| through 1 on coherent OK bins.
 * When multiple ok crossings exist, returns ambiguous_multiple (fail-closed).
 */
export function findGainCrossover(loop: StabilityLoopResponse): GainCrossoverResult {
    const all = findAllGainCrossovers(loop);
    const ok = all.filter((c) => c.status === "ok");
    if (ok.length > 1) {
        return {
            frequencyHz: ok[0].frequencyHz,
            phaseMarginDeg: ok[0].phaseMarginDeg,
            coherenceLow: ok[0].coherenceLow,
            coherenceHigh: ok[0].coherenceHigh,
            status: "ambiguous_multiple",
            reason: `multiple_gain_crossovers:${ok.length}`,
        };
    }
    if (ok.length === 1) return ok[0];
    if (all.length) return all[0];
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
    /**
     * Opt-in only: allow status VALIDATED when every other gate passes.
     * Default false — M2 stays fail-closed until an explicit, reviewable attestation.
     */
    attestValidated?: boolean;
}

/**
 * Offline phase-margin verdict. Fail-closed: defaults to NOT_VALIDATED.
 * VALIDATED only when policy.attestValidated is set and no blockers remain.
 */
export function evaluateStructureAwarePhaseMargin(
    tf: TransferFunction,
    cfg: DigitalControllerConfig,
    policy: PhaseMarginPolicy = {},
): StructureAwarePhaseMargin {
    const loop = reconstructStabilityLoop(tf, cfg);
    const crossovers = findAllGainCrossovers(loop);
    const crossover = findGainCrossover(loop);
    const blockReasons = [...(policy.externalBlockReasons ?? [])];

    if (policy.requireUnityFeedbackEquivalent && !loop.unityFeedbackEquivalent) {
        blockReasons.push("controller_not_unity_feedback_equivalent");
    }
    if (loop.phaseUnwrapInterrupted) {
        blockReasons.push("phase_unwrap_interrupted_by_bin_gaps");
    }
    const okCount = crossovers.filter((c) => c.status === "ok").length;
    if (okCount > 1) {
        blockReasons.push(`ambiguous_multiple_gain_crossovers:${okCount}`);
    }

    if (crossover.status !== "ok") {
        blockReasons.push(`crossover:${crossover.status}${crossover.reason ? `:${crossover.reason}` : ""}`);
        return {
            crossover,
            crossovers,
            status: "NOT_VALIDATED",
            blockReasons,
            unityFeedbackEquivalent: loop.unityFeedbackEquivalent,
            loop,
        };
    }

    if (blockReasons.length) {
        return {
            crossover,
            crossovers,
            status: "NOT_VALIDATED",
            blockReasons,
            unityFeedbackEquivalent: loop.unityFeedbackEquivalent,
            loop,
        };
    }

    // Clean math alone is not product validation — require explicit attestation.
    if (!policy.attestValidated) {
        return {
            crossover,
            crossovers,
            status: "NOT_VALIDATED",
            blockReasons: ["validation_not_attested"],
            unityFeedbackEquivalent: loop.unityFeedbackEquivalent,
            loop,
        };
    }

    return {
        crossover,
        crossovers,
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

// ---------------------------------------------------------------------------
// GF-1 M3: plant extraction + plant-fixed what-if (offline; no Apply)
// ---------------------------------------------------------------------------

/** Distinct validation kinds — never conflate algebraic identity with flight proof. */
export type PlantValidationKind =
    | "ALGEBRAIC_CONSISTENCY"
    | "CONTROLLER_PARITY"
    | "CROSS_LOG_REPRODUCIBILITY"
    | "INDEPENDENT_GAIN_CHANGE_VALIDATION";

export type PlantValidationVerdict = "PASS" | "PARTIAL" | "FAIL" | "BLOCKED" | "UNTESTED";

export interface PlantValidationReport {
    ALGEBRAIC_CONSISTENCY: PlantValidationVerdict;
    /** M1 discrete BF model used; not full stock parity (notches / TPA / …). */
    CONTROLLER_PARITY: PlantValidationVerdict;
    /** Set by caller when two logs are compared; default UNTESTED. */
    CROSS_LOG_REPRODUCIBILITY: PlantValidationVerdict;
    /** Stays BLOCKED until a real CHIRP with known changed PIDs is compared. */
    INDEPENDENT_GAIN_CHANGE_VALIDATION: "BLOCKED";
}

export type PlantBinStatus =
    | "ok"
    | "low_coherence"
    | "below_min_hz"
    | "above_max_hz"
    | "singular_denominator"
    | "non_finite_T";

export interface PlantBin {
    frequencyHz: number;
    status: PlantBinStatus;
    coherence: number;
    /** Measured closed-loop T when status is evaluable. */
    T: Complex | null;
    /** Plant G = T / (C_ref − T·C_fb) when status === "ok". */
    G: Complex | null;
    /** |C_ref − T·C_fb| / max(|C_ref|, |T·C_fb|, ε). */
    denomRel: number;
    /** |T − closedLoopFromPlant(G, C_ref, C_fb)| when status === "ok". */
    algebraicAbsErr: number;
}

export interface SampleRateChecks {
    gyroDt: number;
    pidDt: number;
    ok: boolean;
    reasons: string[];
}

export interface IdentifiedPlant {
    bins: PlantBin[];
    okCount: number;
    measurementCfg: DigitalControllerConfig;
    missingFilterInfo: readonly string[];
    sampleRateChecks: SampleRateChecks;
    algebraicMeanAbsErr: number;
    algebraicRmsAbsErr: number;
    validation: PlantValidationReport;
    /** Always false — M3 never enables automatic PID recommendations. */
    recommendationsEnabled: false;
    /** Always false — Apply stays locked. */
    applyAllowed: false;
}

export interface ExtractPlantOptions {
    coherenceMin?: number;
    minHz?: number;
    maxHz?: number;
    denomRelMin?: number;
    /**
     * Explicit unknown / time-varying filter schedules (dyn_notch, rpm, …).
     * Defaults to AIR65_EXTERNAL_BLOCKERS. Pass [] only when schedules are known.
     */
    missingFilterInfo?: readonly string[];
    /**
     * Optional CONTROLLER_PARITY override. Default PARTIAL (M1 discrete model,
     * not independently flight-proven).
     */
    controllerParity?: PlantValidationVerdict;
    crossLogReproducibility?: PlantValidationVerdict;
}

function checkSampleRates(cfg: DigitalControllerConfig): SampleRateChecks {
    const reasons: string[] = [];
    if (!(cfg.gyroDt > 0) || !Number.isFinite(cfg.gyroDt)) {
        reasons.push("gyroDt_invalid");
    }
    if (!(cfg.pidDt > 0) || !Number.isFinite(cfg.pidDt)) {
        reasons.push("pidDt_invalid");
    }
    if (cfg.gyroDt > 0 && cfg.pidDt > 0 && cfg.pidDt + 1e-12 < cfg.gyroDt) {
        reasons.push("pidDt_faster_than_gyroDt");
    }
    // AIR65 / common BF: PID rate is an integer multiple of gyro period.
    if (cfg.gyroDt > 0 && cfg.pidDt > 0) {
        const ratio = cfg.pidDt / cfg.gyroDt;
        if (Math.abs(ratio - Math.round(ratio)) > 1e-6) {
            reasons.push("pidDt_not_integer_multiple_of_gyroDt");
        }
    }
    return { gyroDt: cfg.gyroDt, pidDt: cfg.pidDt, ok: reasons.length === 0, reasons };
}

function meanAbs(xs: number[]): number {
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN;
}

function rmsAbs(xs: number[]): number {
    return xs.length ? Math.sqrt(xs.reduce((a, b) => a + b * b, 0) / xs.length) : Number.NaN;
}

/**
 * Extract nonparametric plant G from measured closed-loop T and the M1 discrete
 * controller. Uses Ce / (Ce+Cd) only — never a continuous ideal PID fallback.
 *
 * Algebraic residual ≈ 0 on ok bins proves consistency of the invert, not
 * independent predictive accuracy.
 */
export function extractPlantFromClosedLoop(
    tf: TransferFunction,
    cfg: DigitalControllerConfig,
    opts: ExtractPlantOptions = {},
): IdentifiedPlant {
    const coherenceMin = opts.coherenceMin ?? OPEN_LOOP_COHERENCE_MIN;
    const minHz = opts.minHz ?? MIN_OPEN_LOOP_HZ;
    const maxHz = opts.maxHz ?? Number.POSITIVE_INFINITY;
    const denomRelMin = opts.denomRelMin ?? DENOMINATOR_REL_MIN;
    const missingFilterInfo = opts.missingFilterInfo ?? AIR65_EXTERNAL_BLOCKERS;
    const sampleRateChecks = checkSampleRates(cfg);

    const n = tf.frequencies.length;
    const bins: PlantBin[] = new Array(n);
    const algErrs: number[] = [];

    for (let k = 0; k < n; k++) {
        const frequencyHz = tf.frequencies[k];
        const coherence = tf.coherence[k];
        const base: PlantBin = {
            frequencyHz,
            status: "ok",
            coherence,
            T: null,
            G: null,
            denomRel: Number.NaN,
            algebraicAbsErr: Number.NaN,
        };

        if (frequencyHz < minHz) {
            base.status = "below_min_hz";
            bins[k] = base;
            continue;
        }
        if (!(frequencyHz <= maxHz)) {
            base.status = "above_max_hz";
            bins[k] = base;
            continue;
        }
        if (!(coherence >= coherenceMin)) {
            base.status = "low_coherence";
            bins[k] = base;
            continue;
        }

        const T = tAt(tf, k);
        base.T = T;
        if (!Number.isFinite(T.re) || !Number.isFinite(T.im)) {
            base.status = "non_finite_T";
            bins[k] = base;
            continue;
        }

        // Discrete M1 controller only (no continuous-PID branch).
        const frf = evaluateControllerFrf(cfg, frequencyHz);
        const Cref = frf.cReference;
        const Cfb = frf.cFeedback;
        const TCfb = cmul(T, Cfb);
        const denom = csub(Cref, TCfb);
        const denomMag = cmag(denom);
        const scale = Math.max(cmag(Cref), cmag(TCfb), 1e-12);
        const denomRel = denomMag / scale;
        base.denomRel = denomRel;

        if (!(denomRel >= denomRelMin)) {
            base.status = "singular_denominator";
            bins[k] = base;
            continue;
        }

        const G = cdiv(T, denom);
        const Trecon = closedLoopFromPlant(G, Cref, Cfb);
        const algebraicAbsErr = cmag(csub(T, Trecon));
        base.G = G;
        base.algebraicAbsErr = algebraicAbsErr;
        bins[k] = base;
        algErrs.push(algebraicAbsErr);
    }

    const algebraicMeanAbsErr = meanAbs(algErrs);
    const algebraicRmsAbsErr = rmsAbs(algErrs);
    const okCount = algErrs.length;

    let algebraic: PlantValidationVerdict = "FAIL";
    if (okCount === 0) algebraic = "FAIL";
    else if (algebraicMeanAbsErr < 1e-9) algebraic = "PASS";
    else if (algebraicMeanAbsErr < 1e-3) algebraic = "PARTIAL";
    else algebraic = "FAIL";

    return {
        bins,
        okCount,
        measurementCfg: cfg,
        missingFilterInfo,
        sampleRateChecks,
        algebraicMeanAbsErr,
        algebraicRmsAbsErr,
        validation: {
            ALGEBRAIC_CONSISTENCY: algebraic,
            CONTROLLER_PARITY: opts.controllerParity ?? "PARTIAL",
            CROSS_LOG_REPRODUCIBILITY: opts.crossLogReproducibility ?? "UNTESTED",
            INDEPENDENT_GAIN_CHANGE_VALIDATION: "BLOCKED",
        },
        recommendationsEnabled: false,
        applyAllowed: false,
    };
}

export interface PlantWhatIfBin {
    frequencyHz: number;
    status: PlantBinStatus;
    coherence: number;
    T_measured: Complex | null;
    G: Complex | null;
    T_current: Complex | null;
    T_candidate: Complex | null;
    /** |T_measured − T_current| (algebraic identity when currentCfg matches extract). */
    currentAbsErr: number;
    /** |T_candidate − T_current| magnitude delta (not a validation metric). */
    candidateDeltaMag: number;
}

export interface PlantWhatIfResult {
    plant: IdentifiedPlant;
    currentCfg: DigitalControllerConfig;
    candidateCfg: DigitalControllerConfig;
    bins: PlantWhatIfBin[];
    okCount: number;
    /** Diagnostic PM from plant-fixed predicted T — still subject to M2 blockers. */
    currentPhaseMargin: StructureAwarePhaseMargin;
    candidatePhaseMargin: StructureAwarePhaseMargin;
    validation: PlantValidationReport;
    limitations: string[];
    recommendationsEnabled: false;
    applyAllowed: false;
}

export interface PlantWhatIfOptions {
    externalBlockReasons?: string[];
    maxHz?: number;
}

function predictedTfFromPlant(
    plant: IdentifiedPlant,
    cfg: DigitalControllerConfig,
    maxHz: number,
): TransferFunction {
    const ok = plant.bins.filter((b) => b.status === "ok" && b.G && b.frequencyHz <= maxHz);
    // Leading DC pad so reconstructStabilityLoop startIndex / minHz gating works.
    const n = ok.length + 1;
    const frequencies = new Float64Array(n);
    const magnitude = new Float64Array(n);
    const phase = new Float64Array(n);
    const coherence = new Float64Array(n);
    const hReal = new Float64Array(n);
    const hImag = new Float64Array(n);
    frequencies[0] = 0;
    hReal[0] = 1;
    hImag[0] = 0;
    magnitude[0] = 0;
    phase[0] = 0;
    coherence[0] = 1;
    for (let i = 0; i < ok.length; i++) {
        const b = ok[i];
        const frf = evaluateControllerFrf(cfg, b.frequencyHz);
        const T = closedLoopFromPlant(b.G!, frf.cReference, frf.cFeedback);
        const k = i + 1;
        frequencies[k] = b.frequencyHz;
        hReal[k] = T.re;
        hImag[k] = T.im;
        magnitude[k] = 20 * Math.log10(Math.max(cmag(T), 1e-15));
        phase[k] = cphaseDeg(T);
        coherence[k] = b.coherence;
    }
    return { frequencies, magnitude, phase, coherence, hReal, hImag, numSegments: 32 };
}

/**
 * Hold identified plant G fixed; predict closed-loop T for current and candidate
 * discrete controllers (P/I/D only — FF/filters unchanged by caller).
 *
 * Does not enable recommendations or Apply. Independent gain-change validation
 * remains BLOCKED.
 */
export function plantFixedWhatIf(
    plant: IdentifiedPlant,
    currentCfg: DigitalControllerConfig,
    candidateCfg: DigitalControllerConfig,
    opts: PlantWhatIfOptions = {},
): PlantWhatIfResult {
    const maxHz = opts.maxHz ?? Number.POSITIVE_INFINITY;
    const external = [...(opts.externalBlockReasons ?? plant.missingFilterInfo)];

    const bins: PlantWhatIfBin[] = plant.bins.map((b) => {
        if (b.status !== "ok" || !b.G || b.frequencyHz > maxHz) {
            return {
                frequencyHz: b.frequencyHz,
                status: b.status === "ok" && b.frequencyHz > maxHz ? "above_max_hz" : b.status,
                coherence: b.coherence,
                T_measured: b.T,
                G: b.G,
                T_current: null,
                T_candidate: null,
                currentAbsErr: Number.NaN,
                candidateDeltaMag: Number.NaN,
            };
        }
        const cur = evaluateControllerFrf(currentCfg, b.frequencyHz);
        const cand = evaluateControllerFrf(candidateCfg, b.frequencyHz);
        const T_current = closedLoopFromPlant(b.G, cur.cReference, cur.cFeedback);
        const T_candidate = closedLoopFromPlant(b.G, cand.cReference, cand.cFeedback);
        return {
            frequencyHz: b.frequencyHz,
            status: "ok",
            coherence: b.coherence,
            T_measured: b.T,
            G: b.G,
            T_current,
            T_candidate,
            currentAbsErr: b.T ? cmag(csub(b.T, T_current)) : Number.NaN,
            candidateDeltaMag: cmag(csub(T_candidate, T_current)),
        };
    });

    const okCount = bins.filter((b) => b.status === "ok").length;
    const currentTf = predictedTfFromPlant(plant, currentCfg, maxHz);
    const candidateTf = predictedTfFromPlant(plant, candidateCfg, maxHz);

    const currentPhaseMargin = evaluateStructureAwarePhaseMargin(currentTf, currentCfg, {
        externalBlockReasons: external,
    });
    const candidatePhaseMargin = evaluateStructureAwarePhaseMargin(candidateTf, candidateCfg, {
        externalBlockReasons: external,
    });

    const limitations = [
        "INDEPENDENT_GAIN_CHANGE_VALIDATION=BLOCKED",
        "algebraic_T_recon_is_not_predictive_proof",
        "feedforward_and_filters_unchanged_in_this_phase",
        ...plant.missingFilterInfo,
        ...(!plant.sampleRateChecks.ok ? plant.sampleRateChecks.reasons : []),
    ];

    return {
        plant,
        currentCfg,
        candidateCfg,
        bins,
        okCount,
        currentPhaseMargin,
        candidatePhaseMargin,
        validation: {
            ...plant.validation,
            INDEPENDENT_GAIN_CHANGE_VALIDATION: "BLOCKED",
        },
        limitations,
        recommendationsEnabled: false,
        applyAllowed: false,
    };
}

/**
 * Compare two identified plants on shared ok frequencies (cross-log reproducibility).
 * Does not lift INDEPENDENT_GAIN_CHANGE_VALIDATION.
 */
export function assessCrossLogPlantReproducibility(
    a: IdentifiedPlant,
    b: IdentifiedPlant,
    opts: { maxMeanAbsGRel?: number } = {},
): { status: PlantValidationVerdict; meanAbsGRel: number; n: number } {
    const maxMean = opts.maxMeanAbsGRel ?? 0.35;
    const mapB = new Map<number, PlantBin>();
    for (const bin of b.bins) {
        if (bin.status === "ok" && bin.G) mapB.set(bin.frequencyHz, bin);
    }
    const rels: number[] = [];
    for (const bin of a.bins) {
        if (bin.status !== "ok" || !bin.G) continue;
        const other = mapB.get(bin.frequencyHz);
        if (!other?.G) continue;
        const scale = Math.max(cmag(bin.G), cmag(other.G), 1e-12);
        rels.push(cmag(csub(bin.G, other.G)) / scale);
    }
    const meanAbsGRel = meanAbs(rels);
    if (rels.length < 4) return { status: "FAIL", meanAbsGRel, n: rels.length };
    if (meanAbsGRel <= maxMean) return { status: "PASS", meanAbsGRel, n: rels.length };
    if (meanAbsGRel <= maxMean * 2) return { status: "PARTIAL", meanAbsGRel, n: rels.length };
    return { status: "FAIL", meanAbsGRel, n: rels.length };
}
