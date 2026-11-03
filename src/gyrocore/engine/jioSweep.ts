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
 * CHIRP + JIO (joint input-output) plant estimate from the firmware's own sweep — EXPERIMENTAL.
 *
 * Reference: Aagren et al. 2024, "In-flight System Identification of the Ingenuity Mars Helicopter"
 * (NTRS 20240014856), §IV.C Eq. 8–9, adapted to Betaflight's CHIRP: the reference r is the chirp the
 * firmware adds to the rate setpoint (pid.c: currentPidSetpoint += chirpAmplitude[axis] ·
 * phaseComp(exc), exc logged as DEBUG_CHIRP debug[3]/1000), the controller output u is pidSum =
 * axisP + axisI + axisD + axisF before the mixer limit, and the plant output y is gyroADC. With
 * H_ru = S_ru / S_rr and H_ry = S_ry / S_rr the plant the PID sees is G = H_ry / H_ru on the swept
 * axis, without a controller model and without the pilot's setpoint (which is not correlated with r).
 *
 * Estimator (prototype 2026-11-02, chirp-jio-feasibility): one FFT over the whole sweep record,
 * cross-spectra smoothed over 2m+1 adjacent bins (Daniell), evaluation points on non-overlapping
 * smoothing windows. Welch segments are unsuitable for a sweep (most segments hold no energy at a
 * given frequency). The effective number of independent products per evaluation point is taken as
 * n_eff = 2m+1; that is an ASSUMPTION the prototype did not calibrate (12 trials gave intervals
 * 2–4× wider than the errors), so nothing here produces a quantified uncertainty the release
 * contract may use: the transfer function it hands to the engine declares numSegments = 1 and the
 * engine's loopUncertainty leaves the averages unknown (MEASURED, never a bound).
 *
 * Support rules are explicit refusal reasons per evaluation point; repeated sweeps of one axis are
 * grouped only when compatible and compared (repeatability z); a single sweep cannot show that the
 * plant stayed the same during the measurement (the prototype's gain-step case was accepted by one
 * sweep 12/12 times), so its repeatability is UNKNOWN. Nothing here writes to a flight controller
 * and nothing here changes the release contract: every result is diagnostic.
 */

import {
    phaseCompCoeffs,
    type Complex,
    type DigitalControllerConfig,
} from "@/js/blackbox/betaflight_digital_controller";
import { extractPlantFromClosedLoop, type IdentifiedPlant, type PlantBin } from "@/js/blackbox/betaflight_open_loop";
import { ComplexFFT } from "@/js/blackbox/fft";
import type { TransferFunction } from "@/js/blackbox/spectral_analysis";
import { highResolutionScale, parseLoggedHeaders, validateChirpDebugMode } from "@/gyrocore/chirp/headers";
import type { AxisName } from "./safetyEvidence";
import type { SweepInfo } from "./loopModel";

export const JIO_METHOD = "chirp_jio_sweep_fft_daniell" as const;

export const JIO_SWEEP = Object.freeze({
    /** Daniell half-width in bins: 2m+1 = 25 products per evaluation point (prototype; not calibrated). */
    daniellHalfWidthBins: 12,
    /** Relative sd √((1−γ²)/(2·n_eff·γ²)) of the own-axis r→u and r→y responses above this: unsupported. */
    maxRelativeSd: 0.35,
    minEffectiveAverages: 4,
    /** S_rr below this fraction of its in-band maximum: no excitation at the point. */
    excitationFloorRel: 1e-6,
    /**
     * S_rr more than this many dB below the median S_rr of the in-band points within one octave on
     * either side (f/2 … 2f): a hole in the excitation. Leakage of the sweep into a hole stays
     * coherent (it is the same deterministic signal), so coherence alone accepts such points; the
     * exponential sweep's own 1/f trend falls only ≈ 3 dB per octave and never trips this.
     */
    excitationLocalDropDb: 10,
    /** Frobenius condition estimate ‖U_r‖_F·‖U_r⁻¹‖_F above this (stricter than the 2-norm): ill-conditioned. */
    maxCondition: 20,
    /**
     * A run of fewer consecutive passing points than this is noise that happened to pass the
     * coherence rule (γ² ≥ 0.14 on both responses at n_eff 25), not support: `isolated_point`.
     */
    minSupportedRun: 3,
    /** Repeatability z (median |ΔH_ry| / (√2·sd)) above this between repeats: nonstationary (experimental). */
    repeatZThreshold: 2.0,
    /** A sweep record shorter than this is not analysed. */
    minSweepS: 5,
    /**
     * A record whose excitation (debug[3] ≠ 0 on its axis) covers less than this fraction of the
     * header's chirp_time_seconds is incomplete: the registration ended (CHIRP mode off, log stopped)
     * or the generator stopped before the header's end frequency. Its axis is analysed only up to
     * the frequency the sweep reached (the firmware's law f0·(f1/f0)^(t/T)).
     */
    completeSweepFraction: 0.98,
    /**
     * debug[2] against the reconstructed firmware law (chirp.c fchirp = f0·β^(count·Ts), logged as
     * lrintf(10·fchirp)): a sample is in tolerance within max(this fraction, debug2ToleranceHz).
     * pow_approx and the 0.05 Hz quantisation stay well inside; more samples out than
     * debug2MaxOutOfToleranceFraction is a mismatch (the record is not analysed).
     */
    debug2ToleranceRel: 0.01,
    debug2ToleranceHz: 0.1,
    debug2MaxOutOfToleranceFraction: 0.02,
    /**
     * Grids of two columns (axes of one flight, or two flights) are matched point by point when
     * their steps differ by at most this ratio; never interpolated.
     */
    gridMaxStepRatio: 2,
    /** Settle tail appended to each sweep record. */
    tailS: 0.5,
    /** The log must be sampled on the PID grid (phaseComp runs there); tolerance on the rate. */
    maxRateMismatch: 0.02,
    /** Fraction of samples in a sweep window that must carry the sweep's axis in debug[1]. */
    minAxisFraction: 0.9,
    /** |pidSum| at the header limit in more than this fraction of samples: u is not the plant input. */
    maxLimitHitFraction: 0.001,
    /** Motor at max in more than this fraction of samples: the actuator clipped. */
    maxMotorSaturationFraction: 0.01,
    /** rms(setpoint − r) above this (°/s): the pilot was flying during the sweep (informative). */
    pilotInputRmsDegS: 20,
    lowestHz: 2,
    /** Highest analysed frequency as a fraction of the sample rate. */
    nyquistFraction: 0.45,
    /** Cross-flight comparison: fewer common supported points than this gives no verdict. */
    crossFlightMinPoints: 5,
    /** Cross-flight comparison: evaluation grids whose steps differ by more than this are not matched. */
    crossFlightMaxStepRatio: 2,
});

/**
 * The firmware's chirp generator as the log's revision has it: settable ranges from betaflight
 * `src/main/cli/settings.c` (minmax of chirp_frequency_start_deci_hz 1–1000, chirp_frequency_end_deci_hz
 * 1–10000, chirp_time_seconds 1–255, chirp_amplitude_* 0–500; checked at 43875a55a, the revision the
 * AIR65 logs name), and the sweep law from `src/main/common/chirp.c`: f(t) = f0·β^t with
 * β = (f1/f0)^(1/T) — exponential, so each octave gets the same time T / log2(f1/f0). A linear sweep
 * is not a setting of this firmware and is never suggested.
 */
export const FIRMWARE_CHIRP = Object.freeze({
    startDeciHz: [1, 1000] as const,
    endDeciHz: [1, 10000] as const,
    timeS: [1, 255] as const,
    amplitudeDegS: [0, 500] as const,
    /** Suggested end frequency: this many times the top of the supported band (room for the coherence to fall). */
    endMarginFactor: 1.5,
    /** The suggested end frequency is rounded up to a multiple of this (Hz). */
    endRoundHz: 10,
    sweepLaw: "exponential:chirp.c" as const,
    /** No "/" here: the basis is shown through i18n arguments, which HTML-escape slashes. */
    settingsSource: "betaflight_settings.c@43875a55a" as const,
});

/**
 * What the next sweep of this axis should look like so that less of its time goes to the band the
 * coherence does not reach: the same generator (exponential, same duration and amplitude), a lower
 * end frequency. Experimental: a narrower sweep raises the excitation per octave and may widen
 * the supported band, so the advice is to be re-evaluated on the new log, not a calibration.
 */
export interface JioSweepAdvice {
    current: { f0Hz: number; f1Hz: number; durationS: number; secondsPerOctave: number; octavesAboveSupport: number };
    /** The band the tuning goals need measured (the planner's primary band; null without a plan). */
    tuningBandHz: [number, number] | null;
    /**
     * Whether the supported band reaches the tuning band's top. false: the advice keeps the sweep
     * end at that top (never lowers the requirement) and the coherence there has to improve on the
     * new log; null without a tuning band.
     */
    bandSufficientForTuning: boolean | null;
    suggested: {
        chirp_frequency_start_deci_hz: number;
        chirp_frequency_end_deci_hz: number;
        chirp_time_seconds: number;
        secondsPerOctave: number;
        /** 10·log10 of the excitation-per-octave gain against the current sweep (same T and amplitude). */
        excitationGainDb: number;
    } | null;
    basis: string[];
}

/** The channels the JIO estimate needs beside gyroADC (logInput.ts). Absent: the route is blocked, named. */
export interface JioChannels {
    setpoint: [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>] | null;
    axisP: [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>] | null;
    axisI: [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>] | null;
    axisF: [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>] | null;
    /** DEBUG_CHIRP debug[1]: the swept axis (−1 inactive). */
    debugAxis: ArrayLike<number> | null;
    /** DEBUG_CHIRP debug[3]: the generator's excitation × 1000 before phaseComp. */
    excitation: ArrayLike<number> | null;
    /** DEBUG_CHIRP debug[2]: the generator's instantaneous frequency in deci-Hz (verification only). */
    frequencyDeciHz?: ArrayLike<number> | null;
}

/** One sweep the qualification found (chirp/qualification.ts measurement), all occurrences of every axis. */
export interface JioSweepRecord {
    id: string;
    axis: AxisName;
    axisIndex: 0 | 1 | 2;
    occurrence: number;
    /** Sample index range of the active sweep in the channel arrays. */
    start: number;
    end: number;
    boundSource: "firmware_debug_chirp" | "mode_flag_only";
    /** The qualification's state of this measurement (informative: the JIO route judges its own support). */
    state: string;
    timestampGapFraction: number;
}

export interface JioEvalPoints {
    frequencyHz: Float64Array;
    /** Own-axis plant G = H_ry / H_ru. */
    gRe: Float64Array;
    gIm: Float64Array;
    /** Own-axis closed loop T = H_ry (reference: the reconstructed chirp, not the logged setpoint). */
    tRe: Float64Array;
    tIm: Float64Array;
    /** Own-axis controller path H_ru. */
    uRe: Float64Array;
    uIm: Float64Array;
    coherenceRu: Float64Array;
    coherenceRy: Float64Array;
    /** Relative sd of G from the coherences under the n_eff assumption (experimental). */
    relativeSd: Float64Array;
    /** Excitation power S_rr at the point relative to the in-band median (dB). */
    excitationRelDb: Float64Array;
    supported: Uint8Array;
    /** Why a point is unsupported (empty string when supported). */
    reason: string[];
}

export interface JioRecordResult {
    id: string;
    occurrence: number;
    start: number;
    end: number;
    recordS: number;
    /** Data flags that exclude the record from the estimate (pidsum limit, motor saturation, …). */
    flags: string[];
    /** Informative notes (pilot input, incomplete sweep, clipped record). */
    notes: string[];
    /** Seconds of the record in which the generator excited this axis (debug[3] ≠ 0 on debug[1] = axis). */
    excitedS: number;
    /** Highest frequency the sweep reached by the firmware's law over excitedS (≤ the header's end). */
    reachedHz: number | null;
    /**
     * How the sweep ended short of the header's chirp_time_seconds: excitation up to the record's
     * last samples means the registration ended (CHIRP mode off, log stopped); zero excitation
     * before the end means the generator stopped. null: complete.
     */
    incomplete: "registration_ended_early" | "generator_stopped_early" | null;
    /**
     * debug[2] against the firmware law over the excited samples of this record: `ok`, `mismatch`
     * (record not analysed), or `missing` (no channel: the frequency is not verified, which is a
     * limitation, never a pass).
     */
    frequencyCheck: {
        status: "ok" | "mismatch" | "missing";
        samples: number;
        outOfTolerance: number;
        medianRelError: number | null;
        maxAbsErrorHz: number | null;
        /** Samples inside the record with debug[2] > 0 while debug[3] = 0 (generator output held). */
        heldWhileSilent: number;
    };
    used: boolean;
    rPeakDegS: number;
    uRms: number;
    column: Column | null;
}

export interface JioAxisResult {
    axis: AxisName;
    method: typeof JIO_METHOD;
    records: JioRecordResult[];
    /**
     * The measurement set of this axis: sweeps present in the log, complete ones (excitation reached
     * the header's end frequency), usable ones (a column was estimated), the excluded ones with their
     * flags, and the lowest frequency a usable sweep's window reached (the analysed band ends there).
     */
    sweeps: {
        present: number;
        complete: number;
        /** Usable sweeps that are complete: only these count as repeats for stationarity. */
        usableComplete: number;
        usable: number;
        excluded: string[];
        /** The lowest frequency a usable sweep's transformed window reached: the analysed band ends there. */
        reachedHz: number | null;
    };
    repeats: {
        count: number;
        consistency: "unknown" | "consistent" | "inconsistent";
        /** Largest pairwise repeatability z over the compatible repeats; null without a pair. */
        z: number | null;
        reasons: string[];
    };
    grid: { stepHz: number; nEval: number; nEff: number } | null;
    band: {
        analysedHz: [number, number];
        supportedHz: [number, number] | null;
        supportedFraction: number;
        /** Unsupported evaluation points strictly inside the supported range. */
        gapPoints: number;
        largestGapPoints: number;
        /** The longest run of consecutive supported points: the band one estimate covers without a gap. */
        longestRunHz: [number, number] | null;
    } | null;
    /** Count of unsupported in-band evaluation points per reason. */
    reasons: Record<string, number>;
    points: JioEvalPoints | null;
    /** Why no plant could be handed to the tuning chain (empty: it was). */
    blockers: string[];
    limitations: string[];
    /** The engine-shaped measurement for buildAxisLoop: T on the evaluation grid (numSegments 1) and G. */
    engineInput: { tf: TransferFunction; plant: IdentifiedPlant } | null;
    /**
     * The plant the engine's controller model would give from the same T (extractPlantFromClosedLoop)
     * against the JIO plant: median |20·log10|G_jio / G_model|| and median |∠| over the supported
     * points. Large: the controller in force differed from the header model (anti-gravity, I relax, …).
     */
    controllerModelAgreement: { points: number; medianAbsDb: number; medianAbsDeg: number } | null;
    /** The next sweep this axis would need (null without a supported band). */
    sweepAdvice: JioSweepAdvice | null;
}

export interface JioMimoResult {
    /** Evaluation points where all three columns are supported and U_r is well conditioned. */
    pointsWellConditioned: number;
    pointsCommonSupported: number;
    bandHz: [number, number] | null;
    conditionMedian: number | null;
    /** Diagonal |G| (dB) at the first and last well-conditioned point, per axis. */
    diagonalDbFirstLast: [number, number][] | null;
    /** Step of the coarsest axis grid the others were matched to (nearest point, no interpolation). */
    gridStepHz: number | null;
    notes: string[];
}

export interface JioSweepAnalysis {
    method: typeof JIO_METHOD;
    firmwareRevision: string | null;
    /** Why the route could not run at all (headers, channels, rate); empty when axes were analysed. */
    blockers: string[];
    limitations: string[];
    sweep: SweepInfo | null;
    amplitudesDegS: [number, number, number] | null;
    axes: Partial<Record<AxisName, JioAxisResult>>;
    mimo: JioMimoResult | null;
}

export interface Column {
    f: Float64Array;
    /** (nf × 3) row-major: response on axis a at point k = [k * 3 + a]. */
    hruRe: Float64Array;
    hruIm: Float64Array;
    hryRe: Float64Array;
    hryIm: Float64Array;
    g2u: Float64Array;
    g2y: Float64Array;
    srr: Float64Array;
    nEff: number;
}

const AXES: readonly AxisName[] = ["roll", "pitch", "yaw"];

export const JIO_LIMITATIONS: readonly string[] = [
    "experimental_method_not_validated",
    "uncertainty_n_eff_assumption_not_calibrated",
    "single_sweep_cannot_show_stationarity",
    "sequential_sweeps_not_one_stationary_plant_without_consistent_repeats",
    "no_release_evidence:diagnostic_only",
];

/** Largest 5-smooth integer ≤ n (the mixed-radix FFT stays fast and the record keeps its own bins). */
export function smoothLength(n: number): number {
    for (let L = n; L > 0; L--) {
        let x = L;
        for (const p of [2, 3, 5]) while (x % p === 0) x /= p;
        if (x === 1) return L;
    }
    return 0;
}

function num(h: Record<string, string>, key: string): number | null {
    const raw = h[key];
    if (raw === undefined) return null;
    const v = Number(raw.split(",")[0].trim());
    return Number.isFinite(v) ? v : null;
}

/**
 * The chirp the firmware added to the rate setpoint over one record: amplitude · phaseComp(exc),
 * phaseComp as filter.c computes it on the PID grid (betaflight_digital_controller phaseCompCoeffs),
 * exc = debug[3] / 1000 on the samples where debug[1] names this axis (the record's settle tail may
 * already hold the next axis's sweep: that excitation is not this axis's reference). The filter
 * starts at rest: before the sweep exc is 0.
 */
export function reconstructChirpReference(
    excitationMilli: ArrayLike<number>,
    debugAxis: ArrayLike<number> | null,
    axis: number,
    start: number,
    end: number,
    amplitudeDegS: number,
    lagHz: number,
    leadHz: number,
    pidDtUs: number,
): Float64Array | null {
    const pc = phaseCompCoeffs(lagHz, leadHz, pidDtUs);
    if (!pc) return null;
    const n = end - start;
    const r = new Float64Array(n);
    let x1 = 0;
    let y1 = 0;
    for (let k = 0; k < n; k++) {
        const raw = excitationMilli[start + k];
        const own = !debugAxis || debugAxis[start + k] === axis;
        const x = own && Number.isFinite(raw) ? raw / 1000 : 0;
        const y = pc.b0 * x + pc.b1 * x1 - pc.a1 * y1;
        x1 = x;
        y1 = y;
        r[k] = amplitudeDegS * y;
    }
    return r;
}

function rfft(x: Float64Array): { re: Float64Array; im: Float64Array } {
    const n = x.length;
    let mean = 0;
    for (let k = 0; k < n; k++) mean += x[k];
    mean /= n;
    const input = new Float64Array(n);
    for (let k = 0; k < n; k++) input[k] = x[k] - mean;
    const out = new Float64Array(2 * n);
    new ComplexFFT(n, false).simple(out, input, "real");
    const half = Math.floor(n / 2) + 1;
    const re = new Float64Array(half);
    const im = new Float64Array(half);
    for (let k = 0; k < half; k++) {
        re[k] = out[2 * k];
        im[k] = out[2 * k + 1];
    }
    return { re, im };
}

/** Daniell-smoothed cross-spectrum conj(X)·Y over 2m+1 bins, at the evaluation bins `sel`. */
function crossSmoothed(
    X: { re: Float64Array; im: Float64Array },
    Y: { re: Float64Array; im: Float64Array },
    m: number,
    sel: Int32Array,
): { re: Float64Array; im: Float64Array } {
    const re = new Float64Array(sel.length);
    const im = new Float64Array(sel.length);
    const w = 1 / (2 * m + 1);
    for (let i = 0; i < sel.length; i++) {
        let sr = 0;
        let si = 0;
        for (let k = sel[i] - m; k <= sel[i] + m; k++) {
            // conj(X) · Y
            sr += X.re[k] * Y.re[k] + X.im[k] * Y.im[k];
            si += X.re[k] * Y.im[k] - X.im[k] * Y.re[k];
        }
        re[i] = sr * w;
        im[i] = si * w;
    }
    return { re, im };
}

/**
 * One excited axis over one record: r (n), u (3 × n), y (3 × n) → H_ru, H_ry, coherences and S_rr
 * at evaluation points on non-overlapping Daniell windows (n_eff = 2m+1 products each).
 */
export function estimateSweepColumn(
    r: Float64Array,
    u: [Float64Array, Float64Array, Float64Array],
    y: [Float64Array, Float64Array, Float64Array],
    sampleRateHz: number,
    m: number = JIO_SWEEP.daniellHalfWidthBins,
): Column {
    const n = r.length;
    const half = Math.floor(n / 2) + 1;
    const step = 2 * m + 1;
    const nEval = Math.max(0, Math.floor((half - 2 * m - 1) / step) + 1);
    const sel = new Int32Array(nEval);
    for (let i = 0; i < nEval; i++) sel[i] = m + i * step;
    const R = rfft(r);
    const U = u.map(rfft);
    const Y = y.map(rfft);
    const Srr = crossSmoothed(R, R, m, sel).re;
    const col: Column = {
        f: Float64Array.from(sel, (k) => (k * sampleRateHz) / n),
        hruRe: new Float64Array(nEval * 3),
        hruIm: new Float64Array(nEval * 3),
        hryRe: new Float64Array(nEval * 3),
        hryIm: new Float64Array(nEval * 3),
        g2u: new Float64Array(nEval * 3),
        g2y: new Float64Array(nEval * 3),
        srr: Srr,
        nEff: step,
    };
    for (let a = 0; a < 3; a++) {
        const Sru = crossSmoothed(R, U[a], m, sel);
        const Suu = crossSmoothed(U[a], U[a], m, sel).re;
        const Sry = crossSmoothed(R, Y[a], m, sel);
        const Syy = crossSmoothed(Y[a], Y[a], m, sel).re;
        for (let i = 0; i < nEval; i++) {
            const s = Srr[i];
            const j = i * 3 + a;
            col.hruRe[j] = Sru.re[i] / s;
            col.hruIm[j] = Sru.im[i] / s;
            col.hryRe[j] = Sry.re[i] / s;
            col.hryIm[j] = Sry.im[i] / s;
            col.g2u[j] = (Sru.re[i] ** 2 + Sru.im[i] ** 2) / (s * Suu[i] + 1e-300);
            col.g2y[j] = (Sry.re[i] ** 2 + Sry.im[i] ** 2) / (s * Syy[i] + 1e-300);
        }
    }
    return col;
}

/** √((1−γ²)/(2·n_eff·γ²)): relative random error of an H1-type estimate (Bendat & Piersol). */
export function relativeSd(g2: number, nEff: number): number {
    if (!(g2 > 0)) return Infinity;
    const c = Math.min(g2, 1);
    return Math.sqrt((1 - c) / (2 * nEff * c));
}

function cdivRaw(aRe: number, aIm: number, bRe: number, bIm: number): Complex {
    const d = bRe * bRe + bIm * bIm;
    return { re: (aRe * bRe + aIm * bIm) / d, im: (aIm * bRe - aRe * bIm) / d };
}

/** Average of the cross-spectral ratios of compatible repeats (equal grids); n_eff adds up. */
function combineColumns(cols: Column[]): Column {
    const first = cols[0];
    const out: Column = {
        f: first.f,
        hruRe: new Float64Array(first.hruRe.length),
        hruIm: new Float64Array(first.hruRe.length),
        hryRe: new Float64Array(first.hruRe.length),
        hryIm: new Float64Array(first.hruRe.length),
        g2u: new Float64Array(first.hruRe.length),
        g2y: new Float64Array(first.hruRe.length),
        srr: new Float64Array(first.srr.length),
        nEff: first.nEff * cols.length,
    };
    const w = 1 / cols.length;
    for (const c of cols) {
        for (let j = 0; j < out.hruRe.length; j++) {
            out.hruRe[j] += c.hruRe[j] * w;
            out.hruIm[j] += c.hruIm[j] * w;
            out.hryRe[j] += c.hryRe[j] * w;
            out.hryIm[j] += c.hryIm[j] * w;
            out.g2u[j] += c.g2u[j] * w;
            out.g2y[j] += c.g2y[j] * w;
        }
        for (let i = 0; i < out.srr.length; i++) out.srr[i] += c.srr[i] * w;
    }
    return out;
}

/**
 * Repeatability of two records of the same axis: median over the in-band points supported in both
 * of |H_ry,1 − H_ry,2| / (√2 · sd_rel · |H_ry,mean|), sd_rel from the mean own-axis coherence and
 * one record's n_eff. ≈ 1 for the same plant twice; the prototype's gain step gave 3–4.
 */
export function repeatabilityZ(a: Column, b: Column, axis: number, inBand: Uint8Array): number | null {
    const zs: number[] = [];
    for (let i = 0; i < a.f.length; i++) {
        if (!inBand[i]) continue;
        const j = i * 3 + axis;
        const g2 = Math.min(1, Math.max(1e-6, (a.g2y[j] + b.g2y[j]) / 2));
        const sd = relativeSd(g2, a.nEff);
        if (!(sd < JIO_SWEEP.maxRelativeSd)) continue;
        const mRe = (a.hryRe[j] + b.hryRe[j]) / 2;
        const mIm = (a.hryIm[j] + b.hryIm[j]) / 2;
        const mag = Math.hypot(mRe, mIm);
        const d = Math.hypot(a.hryRe[j] - b.hryRe[j], a.hryIm[j] - b.hryIm[j]);
        zs.push(d / (Math.SQRT2 * sd * mag + 1e-12));
    }
    if (!zs.length) return null;
    zs.sort((x, y) => x - y);
    return zs[Math.floor(zs.length / 2)];
}

/**
 * Repeatability between two flights (two analyses, possibly on different grids), the same statistic
 * as repeatabilityZ within a log: median over the points supported in both of
 * |T_a − T_b| / (√(relsd_a² + relsd_b²) · |T_mean|) on the closed-loop response T = H_ry, each
 * flight's relsd from its own-axis r→y coherence and n_eff (uncalibrated assumption). T is the
 * sensitive quantity (near crossover |ΔT/T| ≈ |ΔL/L| / |1 + L|) and the logged configuration is the
 * same by the identity rules, but a controller behaviour that differs per flight (TPA at another
 * throttle, anti-gravity) shows up in T as well — the plant's own z on G is computed on the same
 * points (`plant_z`) and votes too. The coarser grid's points are matched to the nearest point of the finer grid within
 * half a coarse step (the Daniell window already averages over that width). ≈ 1 for the same loop
 * twice (experimental); null with fewer than crossFlightMinPoints common points or incomparable grids.
 * The caller lets either statistic above the threshold decide (autotuneV2.ts jioCrossFlight).
 */
export function crossFlightRepeatabilityZ(
    a: JioEvalPoints,
    b: JioEvalPoints,
    nEffA: number,
    nEffB: number,
    lo: number,
    hi: number,
): { z: number | null; zPlant: number | null; matched: number; reasons: string[] } {
    const reasons: string[] = ["compared:closed_loop_T_and_plant_G"];
    const step = (p: JioEvalPoints) => (p.frequencyHz.length > 1 ? p.frequencyHz[1] - p.frequencyHz[0] : NaN);
    const sa = step(a);
    const sb = step(b);
    if (!(sa > 0) || !(sb > 0)) return { z: null, zPlant: null, matched: 0, reasons: ["grid_missing"] };
    const ratio = Math.max(sa, sb) / Math.min(sa, sb);
    if (ratio > JIO_SWEEP.crossFlightMaxStepRatio)
        return { z: null, zPlant: null, matched: 0, reasons: [`grids_incomparable:step_ratio:${ratio.toFixed(2)}`] };
    const [coarse, fine, nC, nF] = sa >= sb ? [a, b, nEffA, nEffB] : [b, a, nEffB, nEffA];
    const half = Math.max(sa, sb) / 2;
    if (ratio > 1.0001) reasons.push(`grid_matched_nearest:step_ratio:${ratio.toFixed(2)}`);
    const zs: number[] = [];
    const zg: number[] = [];
    let j = 0;
    for (let i = 0; i < coarse.frequencyHz.length; i++) {
        const f = coarse.frequencyHz[i];
        if (f < lo || f > hi || !coarse.supported[i]) continue;
        while (j + 1 < fine.frequencyHz.length && fine.frequencyHz[j + 1] <= f) j++;
        const cand = [j, j + 1].filter((k) => k < fine.frequencyHz.length);
        let best = -1;
        // Half-open acceptance (−half, +half]: a fine point exactly half a step below f belongs to
        // the previous coarse point, so no fine point is matched twice.
        for (const k of cand) {
            const d = fine.frequencyHz[k] - f;
            if (d > half || d <= -half) continue;
            if (best < 0 || Math.abs(d) < Math.abs(fine.frequencyHz[best] - f)) best = k;
        }
        if (best < 0 || !fine.supported[best]) continue;
        const sdT = Math.hypot(relativeSd(coarse.coherenceRy[i], nC), relativeSd(fine.coherenceRy[best], nF));
        const sdG = Math.hypot(coarse.relativeSd[i], fine.relativeSd[best]);
        if (!(sdT > 0) || !Number.isFinite(sdT) || !(sdG > 0) || !Number.isFinite(sdG)) continue;
        const ratioZ = (aRe: number, aIm: number, bRe: number, bIm: number, sd: number) =>
            Math.hypot(aRe - bRe, aIm - bIm) / (sd * Math.hypot((aRe + bRe) / 2, (aIm + bIm) / 2) + 1e-12);
        zs.push(ratioZ(coarse.tRe[i], coarse.tIm[i], fine.tRe[best], fine.tIm[best], sdT));
        zg.push(ratioZ(coarse.gRe[i], coarse.gIm[i], fine.gRe[best], fine.gIm[best], sdG));
    }
    if (zs.length < JIO_SWEEP.crossFlightMinPoints)
        return {
            z: null,
            zPlant: null,
            matched: zs.length,
            reasons: [...reasons, `too_few_common_supported_points:${zs.length}`],
        };
    const zPlant = median(zg);
    return { z: median(zs), zPlant, matched: zs.length, reasons: [...reasons, `plant_z:${zPlant.toFixed(2)}`] };
}

/** The sweep advice of one axis from its supported band (see JioSweepAdvice). */
export function sweepAdviceFor(
    sweep: SweepInfo,
    band: JioAxisResult["band"],
    tuningBandHz: [number, number] | null = null,
): JioSweepAdvice | null {
    if (!band?.supportedHz) return null;
    const { f0Hz, f1Hz, durationS } = sweep;
    const octaves = Math.log2(f1Hz / f0Hz);
    const [supLo, supHi] = band.supportedHz;
    const current = {
        f0Hz,
        f1Hz,
        durationS,
        secondsPerOctave: durationS / octaves,
        octavesAboveSupport: Math.max(0, Math.log2(f1Hz / supHi)),
    };
    const basis = [
        `supported_band:${supLo.toFixed(1)}-${supHi.toFixed(1)}Hz`,
        `end_target:${FIRMWARE_CHIRP.endMarginFactor}x_supported_top`,
        `end_rounded_up_to:${FIRMWARE_CHIRP.endRoundHz}Hz`,
        `sweep_law:${FIRMWARE_CHIRP.sweepLaw}`,
        `settable_ranges:${FIRMWARE_CHIRP.settingsSource}`,
        "same_duration_and_amplitude",
        "amplitude_unchanged:not_raised_for_coherence",
        "experimental_not_validated:re_evaluate_on_the_new_log",
    ];
    const round = FIRMWARE_CHIRP.endRoundHz;
    let f0New = Math.max(f0Hz, JIO_SWEEP.lowestHz);
    if (f0New > f0Hz) basis.push(`start_raised_to_lowest_analysed:${JIO_SWEEP.lowestHz}Hz`);
    f0New = Math.min(Math.max(f0New, FIRMWARE_CHIRP.startDeciHz[0] / 10), FIRMWARE_CHIRP.startDeciHz[1] / 10);
    // The end never drops below the band the tuning goals need: a narrower sweep buys excitation per
    // octave only where the goals do not need the frequencies it drops.
    let endTarget = FIRMWARE_CHIRP.endMarginFactor * supHi;
    let bandSufficientForTuning: boolean | null = null;
    if (tuningBandHz) {
        bandSufficientForTuning = supHi >= tuningBandHz[1] && supLo <= tuningBandHz[0];
        basis.push(`tuning_band:${tuningBandHz[0].toFixed(1)}-${tuningBandHz[1].toFixed(1)}Hz`);
        if (!bandSufficientForTuning)
            basis.push(
                `supported_band_short_of_tuning_band:${supLo.toFixed(1)}-${supHi.toFixed(1)}Hz:requirement_not_lowered`,
            );
        if (tuningBandHz[1] > endTarget) {
            endTarget = tuningBandHz[1];
            basis.push(`end_kept_at_tuning_band_top:${tuningBandHz[1].toFixed(0)}Hz`);
        }
        if (tuningBandHz[0] < f0New) basis.push(`start_above_tuning_band_low:${tuningBandHz[0].toFixed(1)}Hz`);
    }
    let f1New = Math.ceil(endTarget / round) * round;
    f1New = Math.min(Math.max(f1New, 2 * f0New), FIRMWARE_CHIRP.endDeciHz[1] / 10);
    if (tuningBandHz && f1New < tuningBandHz[1])
        basis.push(
            `end_capped_by_firmware_max:${FIRMWARE_CHIRP.endDeciHz[1] / 10}Hz_below_tuning_band_top:requirement_in_force`,
        );
    if (f1New >= f1Hz && f0New <= f0Hz) {
        basis.push("current_sweep_already_band_matched");
        return { current, tuningBandHz, bandSufficientForTuning, suggested: null, basis };
    }
    const T = Math.min(Math.max(Math.round(durationS), FIRMWARE_CHIRP.timeS[0]), FIRMWARE_CHIRP.timeS[1]);
    const octavesNew = Math.log2(f1New / f0New);
    return {
        current,
        tuningBandHz,
        bandSufficientForTuning,
        suggested: {
            chirp_frequency_start_deci_hz: Math.round(10 * f0New),
            chirp_frequency_end_deci_hz: Math.round(10 * f1New),
            chirp_time_seconds: T,
            secondsPerOctave: T / octavesNew,
            excitationGainDb: 10 * Math.log10((Math.log(f1Hz / f0Hz) * T) / (Math.log(f1New / f0New) * durationS)),
        },
        basis,
    };
}

/** Median of S_rr (dB re the in-band median) over the in-band points within one octave of point i. */
function localMedianDb(col: Column, i: number, lo: number, hi: number, ref: number): number {
    const f = col.f[i];
    const v: number[] = [];
    for (let k = 0; k < col.f.length; k++) {
        const g = col.f[k];
        if (g < lo || g > hi || g < f / 2 || g > 2 * f) continue;
        v.push(10 * Math.log10(col.srr[k] / ref));
    }
    return v.length ? median(v) : -Infinity;
}

function median(v: number[]): number {
    const s = [...v].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : NaN;
}

function sameSamples(a: ArrayLike<number>, b: ArrayLike<number>, n: number, offA: number, offB: number): boolean {
    for (let k = 0; k < n; k++) if (a[offA + k] !== b[offB + k]) return false;
    return true;
}

export interface JioLogView {
    headerPairs: readonly (readonly [string, string])[];
    sampleRateHz: number;
    gyroAdc: [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>];
    axisD: [ArrayLike<number> | null, ArrayLike<number> | null, ArrayLike<number> | null] | null;
    motors: ArrayLike<number>[] | null;
    jio: JioChannels | null;
    sweeps: readonly JioSweepRecord[];
}

/**
 * The JIO analysis of one log: every sweep the qualification found, grouped per axis, with the
 * engine-shaped plant per axis when the route is not blocked. Pure; runs in the engine worker.
 */
export function analyzeJioSweeps(
    log: JioLogView,
    controllers: [DigitalControllerConfig | null, DigitalControllerConfig | null, DigitalControllerConfig | null],
): JioSweepAnalysis {
    const h = Object.fromEntries(log.headerPairs.map(([k, v]) => [k, v])) as Record<string, string>;
    const logged = parseLoggedHeaders(log.headerPairs.map(([k, v]) => [k, v] as [string, string]));
    const blockers: string[] = [];
    const limitations = [...JIO_LIMITATIONS];
    const firmwareRevision = logged.firmwareRevision;
    const [, , debugErr] = validateChirpDebugMode(logged);
    if (debugErr) blockers.push(`jio_debug_mode:${debugErr}`);
    const need = (key: string) => {
        const v = num(h, key);
        if (v === null) blockers.push(`jio_header_missing:${key}`);
        return v;
    };
    const looptime = need("looptime");
    const denom = need("pid_process_denom");
    const lag = need("chirp_lag_freq_hz");
    const lead = need("chirp_lead_freq_hz");
    const ampRoll = need("chirp_amplitude_roll");
    const ampPitch = need("chirp_amplitude_pitch");
    const ampYaw = need("chirp_amplitude_yaw");
    const f0 = need("chirp_frequency_start_deci_hz");
    const f1 = need("chirp_frequency_end_deci_hz");
    const T = need("chirp_time_seconds");
    const pidsumLimit = num(h, "pidsum_limit");
    const pidsumLimitYaw = num(h, "pidsum_limit_yaw");
    if (pidsumLimit === null) blockers.push("jio_header_missing:pidsum_limit");
    if (pidsumLimitYaw === null) blockers.push("jio_header_missing:pidsum_limit_yaw");
    if ((num(h, "use_integrated_yaw") ?? 0) !== 0) blockers.push("jio_integrated_yaw_unsupported");
    const ch = log.jio;
    if (!ch) blockers.push("jio_channels_missing");
    else {
        if (!ch.setpoint) blockers.push("jio_channel_missing:setpoint");
        if (!ch.axisP) blockers.push("jio_channel_missing:axisP");
        if (!ch.axisI) blockers.push("jio_channel_missing:axisI");
        if (!ch.axisF) blockers.push("jio_channel_missing:axisF");
        if (!ch.debugAxis) blockers.push("jio_channel_missing:debug[1]");
        if (!ch.excitation) blockers.push("jio_channel_missing:debug[3]");
    }
    const pidDtUs = looptime && denom ? looptime * denom : null;
    if (pidDtUs) {
        const pidRate = 1e6 / pidDtUs;
        if (Math.abs(log.sampleRateHz - pidRate) > JIO_SWEEP.maxRateMismatch * pidRate)
            blockers.push(`jio_log_rate_not_pid_rate:${log.sampleRateHz.toFixed(1)}Hz_vs_${pidRate.toFixed(1)}Hz`);
    }
    if (!log.sweeps.length) blockers.push("jio_no_sweeps");
    const sweep: SweepInfo | null =
        f0 && f1 && T && f1 > f0 && f0 > 0 && T > 0 ? { f0Hz: f0 / 10, f1Hz: f1 / 10, durationS: T } : null;
    if (!sweep) blockers.push("jio_sweep_headers_invalid");
    const amplitudes: [number, number, number] | null =
        ampRoll !== null && ampPitch !== null && ampYaw !== null ? [ampRoll, ampPitch, ampYaw] : null;
    const base: JioSweepAnalysis = {
        method: JIO_METHOD,
        firmwareRevision,
        blockers,
        limitations,
        sweep,
        amplitudesDegS: amplitudes,
        axes: {},
        mimo: null,
    };
    if (blockers.length || !ch || !pidDtUs || !sweep || !amplitudes || !lag || !lead) return base;
    const fs = log.sampleRateHz;
    const scale = highResolutionScale(logged);
    const n = log.gyroAdc[0].length;
    const sweepSamples = Math.round(sweep.durationS * fs);
    // The settle tail never reaches into the next sweep record: a record's window would otherwise
    // hold the start of another sweep (of the same axis: not an independent repeat).
    // Each sweep's tail is capped by its own successor (the next sweep of any axis, or the log's end).
    const tailMax = Math.round(JIO_SWEEP.tailS * fs);
    const byStart = [...log.sweeps].sort((a, b) => a.start - b.start);
    const tailOf = new Map<string, number>();
    byStart.forEach((s, k) => tailOf.set(s.id, Math.min(tailMax, Math.max(0, (byStart[k + 1]?.start ?? n) - s.end))));
    // Excitation of a record: the last sample on which the generator excited its axis (firmware
    // chirp.c zeroes exc when finished; a mode switch-off ends the registration instead).
    const excitedSamples = (s: JioSweepRecord): number => {
        let last = -1;
        for (let k = s.start; k < s.end; k++)
            if (ch.debugAxis![k] === s.axisIndex && ch.excitation![k] !== 0 && Number.isFinite(ch.excitation![k]))
                last = k;
        return last < 0 ? 0 : last + 1 - s.start;
    };
    const reachedHzOf = (excitedS: number): number =>
        Math.min(sweep.f1Hz, sweep.f0Hz * Math.pow(sweep.f1Hz / sweep.f0Hz, excitedS / sweep.durationS));
    // Completeness per record, before the common record length: an incomplete sweep beside a complete
    // one of its axis is excluded below and must not set the grid of the others. The excited time is
    // corrected for samples the log lost (the generator ran on through a timestamp gap).
    const completeness = new Map<
        string,
        Pick<JioRecordResult, "excitedS" | "reachedHz" | "incomplete"> & { excited: number }
    >();
    for (const s of log.sweeps) {
        const excited = excitedSamples(s);
        const excitedS = excited / fs / Math.max(1e-9, 1 - Math.min(0.99, s.timestampGapFraction));
        let incomplete: JioRecordResult["incomplete"] = null;
        if (excitedS < JIO_SWEEP.completeSweepFraction * sweep.durationS)
            incomplete =
                s.end - (s.start + excited) <= Math.round(0.1 * fs)
                    ? "registration_ended_early"
                    : "generator_stopped_early";
        // Reached by the law over the excited time, complete or not: a complete sweep that stopped
        // exciting at 99 % of T was not swept over its last frequencies either (named, not claimed).
        const reachedHz = excited > 0 ? reachedHzOf(excitedS) : null;
        completeness.set(s.id, { excitedS, reachedHz, incomplete, excited });
    }
    const besideComplete = (s: JioSweepRecord) =>
        completeness.get(s.id)!.incomplete !== null &&
        log.sweeps.some((o) => o.axisIndex === s.axisIndex && completeness.get(o.id)!.incomplete === null);
    // D-term channels: with D > 0 the logged axisD is part of pidSum; absent, u is unknown.
    const dNeeded = AXES.map((_, a) => (controllers[a]?.axis.d ?? 0) > 0);
    const dMissing = AXES.filter((_, a) => dNeeded[a] && !log.axisD?.[a]);
    if (dMissing.length) blockers.push(...dMissing.map((a) => `jio_channel_missing:axisD:${a}`));
    if (blockers.length) return base;

    // Record length per axis (block 4): the shortest usable sweep of that axis, at most the header's
    // sweep, plus the settle tail as far as the log holds it. Another axis's short sweep no longer
    // clips this one; the 3×3 combination matches the axes' grids point by point (mimo).
    // A sweep shorter than minSweepS is a flagged record, not the ruler for its axis.
    const active = log.sweeps.map((s) => Math.min(s.end - s.start, sweepSamples));
    const eligible = (s: JioSweepRecord, k: number) => active[k] / fs >= JIO_SWEEP.minSweepS && !besideComplete(s);
    if (!log.sweeps.some(eligible)) {
        blockers.push(`jio_sweep_too_short:${(Math.max(...active) / fs).toFixed(1)}s`);
        return base;
    }
    const minRecord = 2 * (2 * JIO_SWEEP.daniellHalfWidthBins + 1) * 4;
    const bandLo = Math.max(JIO_SWEEP.lowestHz, sweep.f0Hz);
    const bandHi = Math.min(sweep.f1Hz, JIO_SWEEP.nyquistFraction * fs);
    const m = JIO_SWEEP.daniellHalfWidthBins;

    // u = P + I + D + F per axis over a record (D only when logged; yaw D is usually 0).
    const pidSum = (a: number, start: number, L: number): Float64Array => {
        const out = new Float64Array(L);
        const P = ch.axisP![a];
        const I = ch.axisI![a];
        const F = ch.axisF![a];
        const D = log.axisD?.[a] ?? null;
        for (let k = 0; k < L; k++) {
            const i = start + k;
            const v = P[i] + I[i] + F[i] + (D ? D[i] : 0);
            out[k] = Number.isFinite(v) ? v : 0;
        }
        return out;
    };
    const gyro = (a: number, start: number, L: number): Float64Array => {
        const out = new Float64Array(L);
        const Y = log.gyroAdc[a];
        for (let k = 0; k < L; k++) {
            const v = Y[start + k] * scale;
            out[k] = Number.isFinite(v) ? v : 0;
        }
        return out;
    };

    // debug[2] against the law: fchirp = f0·β^(k·Ts) from the first excited sample (count 0), logged
    // as lrintf(10·fchirp); compared only while the generator excites this axis (debug[3] ≠ 0 on
    // debug[1] = axis): after chirp.c's finish both are 0, a held frequency with zero excitation is
    // counted separately. Without the channel the frequency is not verified (a limitation).
    const frequencyCheckOf = (s: JioSweepRecord, excited: number): JioRecordResult["frequencyCheck"] => {
        const fq = ch.frequencyDeciHz;
        if (!fq)
            return {
                status: "missing",
                samples: 0,
                outOfTolerance: 0,
                medianRelError: null,
                maxAbsErrorHz: null,
                heldWhileSilent: 0,
            };
        const beta = Math.pow(sweep.f1Hz / sweep.f0Hz, 1 / sweep.durationS);
        const Ts = pidDtUs * 1e-6;
        let first = -1;
        for (let k = s.start; k < s.end; k++)
            if (ch.debugAxis![k] === s.axisIndex && ch.excitation![k] !== 0) {
                first = k;
                break;
            }
        const errs: number[] = [];
        let out = 0;
        let maxAbs = 0;
        let held = 0;
        // A zero crossing of the excitation rounds debug[3] to 0 for a sample or two; only a run of
        // silent samples with a logged frequency counts as the generator's output being held.
        const minHeldRun = 10;
        let silentRun = 0;
        if (first >= 0)
            for (let k = first; k < s.start + excited && k < s.end; k++) {
                const silent = ch.excitation![k] === 0;
                const logged = fq[k];
                if (!Number.isFinite(logged)) {
                    // A non-finite logged frequency during excitation fails the sample, never passes it.
                    if (!silent && ch.debugAxis![k] === s.axisIndex) {
                        errs.push(1);
                        out++;
                    }
                    continue;
                }
                if (silent) {
                    if (logged > 0 && ch.debugAxis![k] === s.axisIndex) {
                        silentRun++;
                        if (silentRun === minHeldRun) held += minHeldRun;
                        else if (silentRun > minHeldRun) held++;
                    } else silentRun = 0;
                    continue;
                }
                silentRun = 0;
                if (ch.debugAxis![k] !== s.axisIndex) continue;
                const expected = sweep.f0Hz * Math.pow(beta, (k - first) * Ts);
                const err = Math.abs(logged / 10 - expected);
                const tol = Math.max(JIO_SWEEP.debug2ToleranceHz, JIO_SWEEP.debug2ToleranceRel * expected);
                errs.push(err / expected);
                maxAbs = Math.max(maxAbs, err);
                if (err > tol) out++;
            }
        // After the excitation: a run of samples with the generator's frequency still logged while
        // the excitation is zero (output held, not chirp.c's finish, which zeroes both).
        silentRun = 0;
        for (let k = Math.max(first, s.start + excited); k < s.end; k++) {
            const logged = fq[k];
            if (ch.excitation![k] === 0 && Number.isFinite(logged) && logged > 0 && ch.debugAxis![k] === s.axisIndex) {
                silentRun++;
                if (silentRun === minHeldRun) held += minHeldRun;
                else if (silentRun > minHeldRun) held++;
            } else silentRun = 0;
        }
        if (!errs.length)
            return {
                status: "mismatch",
                samples: 0,
                outOfTolerance: 0,
                medianRelError: null,
                maxAbsErrorHz: null,
                heldWhileSilent: held,
            };
        const status = out / errs.length > JIO_SWEEP.debug2MaxOutOfToleranceFraction ? "mismatch" : "ok";
        return {
            status,
            samples: errs.length,
            outOfTolerance: out,
            medianRelError: median(errs),
            maxAbsErrorHz: maxAbs,
            heldWhileSilent: held,
        };
    };
    if (!ch.frequencyDeciHz) limitations.push("frequency_verification_missing:debug[2]_not_logged");

    const axes: Partial<Record<AxisName, JioAxisResult>> = {};
    const combined: Partial<Record<number, Column>> = {};
    // The frequency the transformed window of a record really holds: its excitation clipped to the
    // axis's record length (a shorter repeat of the same axis, or the log's end, clips it).
    const windowReached = new Map<string, number>();
    for (const name of AXES) {
        const ai = AXES.indexOf(name) as 0 | 1 | 2;
        const recs = log.sweeps.filter((s) => s.axisIndex === ai);
        if (!recs.length) continue;
        const limit = ai === 2 ? pidsumLimitYaw! : pidsumLimit!;
        const results: JioRecordResult[] = [];
        const rulers = recs.filter((s) => eligible(s, log.sweeps.indexOf(s)));
        const minActive = rulers.length ? Math.min(...rulers.map((s) => Math.min(s.end - s.start, sweepSamples))) : 0;
        const L = rulers.length
            ? smoothLength(
                  Math.min(
                      ...rulers.map((s) => Math.min(s.end - s.start, sweepSamples) + tailOf.get(s.id)!),
                      ...rulers.map((s) => n - s.start),
                  ),
              )
            : 0;
        const recordS = L / fs;
        for (const s of recs) {
            const flags: string[] = [];
            const tail = tailOf.get(s.id)!;
            const notes: string[] = tail < tailMax ? [`tail_shortened_to_gap:${(tail / fs).toFixed(2)}s`] : [];
            const { excitedS, reachedHz, incomplete, excited } = completeness.get(s.id)!;
            // The transformed window is [start, start + L): the excitation it holds is min(excited, L)
            // (the settle tail, not the excitation, absorbs the 5-smooth shortening of L); the same
            // gap correction as reachedHz, so the two differ only when L really clips the excitation.
            windowReached.set(
                s.id,
                L < excited
                    ? reachedHzOf(L / fs / Math.max(1e-9, 1 - Math.min(0.99, s.timestampGapFraction)))
                    : (reachedHz ?? 0),
            );
            const frequencyCheck = frequencyCheckOf(s, excited);
            if (frequencyCheck.status === "mismatch")
                flags.push(
                    `debug2_frequency_mismatch:${frequencyCheck.outOfTolerance}_of_${frequencyCheck.samples}_samples:median_rel_err_${((frequencyCheck.medianRelError ?? NaN) * 100).toFixed(2)}pct`,
                );
            else if (frequencyCheck.status === "missing") notes.push("frequency_not_verified:debug2_missing");
            else
                notes.push(
                    `debug2_frequency_verified:${frequencyCheck.samples}_samples:max_abs_err_${frequencyCheck.maxAbsErrorHz!.toFixed(2)}Hz`,
                );
            if (frequencyCheck.heldWhileSilent > 0)
                notes.push(`debug2_frequency_held_while_excitation_zero:${frequencyCheck.heldWhileSilent}_samples`);
            if (L < minRecord) flags.push(`axis_record_too_short:${recordS.toFixed(1)}s`);
            if (incomplete)
                notes.push(
                    `sweep_incomplete:${incomplete}:${excitedS.toFixed(1)}s_of_${sweep.durationS}s:reached_${(reachedHz ?? 0).toFixed(0)}Hz_of_${sweep.f1Hz}Hz`,
                );
            if (besideComplete(s))
                flags.push(`incomplete_sweep_beside_complete:reached_${(reachedHz ?? 0).toFixed(0)}Hz`);
            if ((s.end - s.start) / fs < JIO_SWEEP.minSweepS)
                flags.push(`sweep_too_short:${((s.end - s.start) / fs).toFixed(1)}s`);
            else if (excitedS < JIO_SWEEP.minSweepS) flags.push(`excitation_too_short:${excitedS.toFixed(1)}s`);
            // mode_flag_only: the generator ran the whole BOXCHIRP window (nothing to trim); the axis and
            // excitation are still checked below on debug[1] and debug[3].
            if (s.boundSource !== "firmware_debug_chirp") notes.push("sweep_bounds_from_mode_flag");
            if (s.timestampGapFraction > 0.01)
                flags.push(`timestamp_gaps:${(100 * s.timestampGapFraction).toFixed(1)}pct`);
            if (flags.length) {
                results.push({
                    id: s.id,
                    occurrence: s.occurrence,
                    start: s.start,
                    end: s.end,
                    recordS,
                    flags,
                    notes,
                    excitedS,
                    reachedHz,
                    incomplete,
                    frequencyCheck,
                    used: false,
                    rPeakDegS: NaN,
                    uRms: NaN,
                    column: null,
                });
                continue;
            }
            const end = s.start + L;
            let axisHits = 0;
            const activeEnd = Math.min(s.start + minActive, end);
            for (let k = s.start; k < activeEnd; k++) if (ch.debugAxis![k] === ai) axisHits++;
            if (axisHits < JIO_SWEEP.minAxisFraction * (activeEnd - s.start)) flags.push("sweep_axis_mismatch_debug1");
            if (s.end - s.start > L + Math.round(0.1 * fs))
                notes.push(
                    `record_clipped_to_axis_record_length:${(L / fs).toFixed(1)}s_of_${((s.end - s.start) / fs).toFixed(1)}s`,
                );
            const r = reconstructChirpReference(
                ch.excitation!,
                ch.debugAxis!,
                ai,
                s.start,
                end,
                amplitudes[ai],
                lag,
                lead,
                pidDtUs,
            )!;
            const u: [Float64Array, Float64Array, Float64Array] = [
                pidSum(0, s.start, L),
                pidSum(1, s.start, L),
                pidSum(2, s.start, L),
            ];
            const y: [Float64Array, Float64Array, Float64Array] = [
                gyro(0, s.start, L),
                gyro(1, s.start, L),
                gyro(2, s.start, L),
            ];
            let limitHits = 0;
            let uSq = 0;
            let rPeak = 0;
            let spDiffSq = 0;
            const sp = ch.setpoint![ai];
            for (let k = 0; k < L; k++) {
                if (Math.abs(u[ai][k]) >= limit) limitHits++;
                uSq += u[ai][k] ** 2;
                rPeak = Math.max(rPeak, Math.abs(r[k]));
                const d = sp[s.start + k] * scale - r[k];
                spDiffSq += Number.isFinite(d) ? d * d : 0;
            }
            if (limitHits / L > JIO_SWEEP.maxLimitHitFraction) flags.push(`pidsum_limit_active:${limitHits}`);
            if (log.motors?.length) {
                const max = num(h, "maxthrottle") ?? 2000;
                let sat = 0;
                for (let k = s.start; k < end; k++) if (log.motors.some((mo) => mo[k] >= max - 1)) sat++;
                if (sat / L > JIO_SWEEP.maxMotorSaturationFraction)
                    flags.push(`motor_saturation:${((100 * sat) / L).toFixed(1)}pct`);
            }
            if (!(rPeak > 0)) flags.push("no_excitation_in_debug3");
            if (Math.sqrt(spDiffSq / L) > JIO_SWEEP.pilotInputRmsDegS)
                notes.push(`pilot_input_present:${Math.sqrt(spDiffSq / L).toFixed(0)}deg_s_rms`);
            // A record whose u and y samples equal an earlier record's is the same measurement again.
            for (const prev of results) {
                if (!prev.column) continue;
                if (
                    sameSamples(log.gyroAdc[ai], log.gyroAdc[ai], L, prev.start, s.start) &&
                    sameSamples(ch.axisP![ai], ch.axisP![ai], L, prev.start, s.start)
                ) {
                    flags.push(`duplicate_recording:${prev.id}`);
                    break;
                }
            }
            const column = flags.length ? null : estimateSweepColumn(r, u, y, fs, m);
            results.push({
                id: s.id,
                occurrence: s.occurrence,
                start: s.start,
                end: s.end,
                recordS,
                flags,
                notes,
                excitedS,
                reachedHz,
                incomplete,
                frequencyCheck,
                used: !!column,
                rPeakDegS: rPeak,
                uRms: Math.sqrt(uSq / L),
                column,
            });
        }
        // Beside a complete sweep an incomplete one was flagged above (no independent repeat: above
        // the frequency it reached it holds no excitation, below it would only narrow the band of the
        // complete one). Without any complete sweep the incomplete ones are what there is.
        const used = results.filter((x) => x.column);
        // The axis is analysed only up to the frequency every usable sweep's window reached: above it
        // the window holds no excitation (sweep ended, or clipped to the common length), and a repeat
        // or combination there would be noise.
        const reachedAxis = used.length ? Math.min(...used.map((x) => windowReached.get(x.id) ?? bandHi)) : null;
        const axisBandHi = reachedAxis !== null ? Math.min(bandHi, reachedAxis) : bandHi;
        for (const x of used) {
            const w = windowReached.get(x.id)!;
            if (x.reachedHz !== null && w < x.reachedHz - 1e-9)
                x.notes.push(`window_reaches:${w.toFixed(0)}Hz_of_${x.reachedHz.toFixed(0)}Hz:axis_record_length`);
        }
        const allComplete = used.length > 0 && used.every((x) => x.incomplete === null);
        const sweepsSummary: JioAxisResult["sweeps"] = {
            present: results.length,
            complete: results.filter((x) => x.incomplete === null && x.excitedS > 0).length,
            usableComplete: used.filter((x) => x.incomplete === null).length,
            usable: used.length,
            excluded: results.filter((x) => !x.column).map((x) => `${x.id}:${x.flags.join(",") || "no_column"}`),
            reachedHz: reachedAxis,
        };
        const repeats: JioAxisResult["repeats"] = { count: used.length, consistency: "unknown", z: null, reasons: [] };
        let col: Column | null = null;
        const axisBlockers: string[] = [];
        if (!used.length) {
            axisBlockers.push(
                "jio_no_usable_record",
                ...results.flatMap((x) => x.flags.map((f) => `record:${x.id}:${f}`)),
            );
        } else if (used.length === 1) {
            col = used[0].column;
            repeats.reasons.push("single_sweep:repeatability_unknown");
        } else {
            const inBand = Uint8Array.from(used[0].column!.f, (f) => (f >= bandLo && f <= axisBandHi ? 1 : 0));
            let zMax = -Infinity;
            for (let i = 0; i < used.length; i++)
                for (let j = i + 1; j < used.length; j++) {
                    const z = repeatabilityZ(used[i].column!, used[j].column!, ai, inBand);
                    if (z !== null) zMax = Math.max(zMax, z);
                }
            repeats.z = Number.isFinite(zMax) ? zMax : null;
            if (repeats.z === null) {
                repeats.reasons.push("repeat_comparison_no_common_supported_points:first_record_used");
                col = used[0].column;
            } else if (repeats.z > JIO_SWEEP.repeatZThreshold) {
                repeats.consistency = "inconsistent";
                repeats.reasons.push(`nonstationary_repeat:z:${repeats.z.toFixed(2)}>${JIO_SWEEP.repeatZThreshold}`);
                axisBlockers.push("jio_repeats_inconsistent");
            } else if (!allComplete) {
                // Incomplete sweeps that agree over the band they reached are no stationarity
                // evidence and are not combined (no extra averages from them): first record used.
                repeats.reasons.push(
                    `repeats_agree_over_reached_band:z:${repeats.z.toFixed(2)}:incomplete_sweeps_no_stationarity_evidence`,
                );
                col = used[0].column;
            } else {
                repeats.consistency = "consistent";
                repeats.reasons.push(`repeats_consistent:z:${repeats.z.toFixed(2)}`);
                col = combineColumns(used.map((x) => x.column!));
            }
        }
        const axisResult: JioAxisResult = {
            axis: name,
            method: JIO_METHOD,
            records: results,
            sweeps: sweepsSummary,
            repeats,
            grid: null,
            band: null,
            reasons: {},
            points: null,
            blockers: axisBlockers,
            limitations: [...JIO_LIMITATIONS],
            engineInput: null,
            controllerModelAgreement: null,
            sweepAdvice: null,
        };
        // Points and support also for an inconsistent pair (the individual responses stay visible),
        // read on the first usable record; the tuning chain gets nothing then.
        const show = col ?? used[0]?.column ?? null;
        if (show) {
            const nf = show.f.length;
            const pts: JioEvalPoints = {
                frequencyHz: show.f,
                gRe: new Float64Array(nf),
                gIm: new Float64Array(nf),
                tRe: new Float64Array(nf),
                tIm: new Float64Array(nf),
                uRe: new Float64Array(nf),
                uIm: new Float64Array(nf),
                coherenceRu: new Float64Array(nf),
                coherenceRy: new Float64Array(nf),
                relativeSd: new Float64Array(nf),
                excitationRelDb: new Float64Array(nf),
                supported: new Uint8Array(nf),
                reason: new Array<string>(nf).fill(""),
            };
            let srrMax = 0;
            const srrIn: number[] = [];
            for (let i = 0; i < nf; i++)
                if (show.f[i] >= bandLo && show.f[i] <= axisBandHi) {
                    srrMax = Math.max(srrMax, show.srr[i]);
                    srrIn.push(show.srr[i]);
                }
            const srrMedian = median(srrIn);
            const reasons: Record<string, number> = {};
            const count = (k: string) => (reasons[k] = (reasons[k] ?? 0) + 1);
            for (let i = 0; i < nf; i++) {
                const j = i * 3 + ai;
                pts.uRe[i] = show.hruRe[j];
                pts.uIm[i] = show.hruIm[j];
                pts.tRe[i] = show.hryRe[j];
                pts.tIm[i] = show.hryIm[j];
                const g = cdivRaw(show.hryRe[j], show.hryIm[j], show.hruRe[j], show.hruIm[j]);
                pts.gRe[i] = g.re;
                pts.gIm[i] = g.im;
                pts.coherenceRu[i] = show.g2u[j];
                pts.coherenceRy[i] = show.g2y[j];
                const sdU = relativeSd(show.g2u[j], show.nEff);
                const sdY = relativeSd(show.g2y[j], show.nEff);
                pts.relativeSd[i] = Math.hypot(sdU, sdY);
                pts.excitationRelDb[i] = 10 * Math.log10(show.srr[i] / srrMedian);
                let reason = "";
                if (!(show.f[i] >= bandLo && show.f[i] <= bandHi)) reason = "out_of_band";
                else if (show.f[i] > axisBandHi) reason = "not_swept:above_reached_frequency";
                else if (show.nEff < JIO_SWEEP.minEffectiveAverages) reason = "too_few_averages";
                else if (!(show.srr[i] >= JIO_SWEEP.excitationFloorRel * srrMax)) reason = "no_excitation";
                else if (
                    pts.excitationRelDb[i] <
                    localMedianDb(show, i, bandLo, axisBandHi, srrMedian) - JIO_SWEEP.excitationLocalDropDb
                )
                    reason = "excitation_hole";
                else if (!(Math.max(sdU, sdY) <= JIO_SWEEP.maxRelativeSd)) reason = "uncertainty_too_large";
                else if (!Number.isFinite(g.re) || !Number.isFinite(g.im)) reason = "non_finite";
                pts.reason[i] = reason;
                pts.supported[i] = reason ? 0 : 1;
            }
            // Runs of passing points shorter than minSupportedRun are chance passes, not support.
            for (let i = 0; i < nf;) {
                if (!pts.supported[i]) {
                    i++;
                    continue;
                }
                let j = i;
                while (j < nf && pts.supported[j]) j++;
                if (j - i < JIO_SWEEP.minSupportedRun)
                    for (let k = i; k < j; k++) {
                        pts.supported[k] = 0;
                        pts.reason[k] = "isolated_point";
                    }
                i = j;
            }
            for (let i = 0; i < nf; i++) if (pts.reason[i] && pts.reason[i] !== "out_of_band") count(pts.reason[i]);
            axisResult.points = pts;
            axisResult.reasons = reasons;
            axisResult.grid = {
                stepHz: nf > 1 ? show.f[1] - show.f[0] : fs / Math.max(1, L),
                nEval: nf,
                nEff: show.nEff,
            };
            const inBandIdx: number[] = [];
            for (let i = 0; i < nf; i++)
                if (pts.reason[i] !== "out_of_band" && pts.reason[i] !== "not_swept:above_reached_frequency")
                    inBandIdx.push(i);
            const supIdx = inBandIdx.filter((i) => pts.supported[i]);
            let gaps = 0;
            let largest = 0;
            let longestRun: [number, number] | null = null;
            if (supIdx.length) {
                let run = 0;
                let runStart = supIdx[0];
                let best = 0;
                for (let i = supIdx[0]; i <= supIdx[supIdx.length - 1]; i++) {
                    if (pts.supported[i]) {
                        largest = Math.max(largest, run);
                        if (run) runStart = i;
                        run = 0;
                        if (i - runStart + 1 > best) {
                            best = i - runStart + 1;
                            longestRun = [pts.frequencyHz[runStart], pts.frequencyHz[i]];
                        }
                    } else {
                        gaps++;
                        run++;
                    }
                }
            }
            axisResult.band = {
                analysedHz: [bandLo, axisBandHi],
                supportedHz: supIdx.length
                    ? [pts.frequencyHz[supIdx[0]], pts.frequencyHz[supIdx[supIdx.length - 1]]]
                    : null,
                supportedFraction: inBandIdx.length ? supIdx.length / inBandIdx.length : 0,
                gapPoints: gaps,
                largestGapPoints: largest,
                longestRunHz: longestRun,
            };
            axisResult.sweepAdvice = sweepAdviceFor(sweep, axisResult.band);
            if (!supIdx.length) axisBlockers.push("jio_no_supported_points");
            const cfg = controllers[ai];
            if (!cfg) axisBlockers.push("jio_controller_headers_missing");
            if (col && cfg && supIdx.length) {
                axisResult.engineInput = engineInputFrom(pts, cfg);
                axisResult.controllerModelAgreement = agreement(pts, axisResult.engineInput.plant);
                combined[ai] = col;
            }
        }
        axes[name] = axisResult;
    }
    base.axes = axes;
    // The 3×3 combination only over the band every axis analysed (the lowest reached frequency).
    const mimoHi = Math.min(bandHi, ...AXES.map((a) => axes[a]?.band?.analysedHz[1] ?? bandHi));
    base.mimo = mimo(combined, axes, bandLo, mimoHi);
    return base;
}

/**
 * The engine-shaped measurement: T = H_ry on the evaluation grid as a TransferFunction with
 * numSegments 1 (one FFT per record: the engine's uncertainty stays unknown, MEASURED only) and
 * coherence = min(γ²_ru, γ²_ry); the plant with G from the JIO ratio on the supported points.
 */
function engineInputFrom(
    pts: JioEvalPoints,
    cfg: DigitalControllerConfig,
): { tf: TransferFunction; plant: IdentifiedPlant } {
    const nf = pts.frequencyHz.length;
    const tf: TransferFunction = {
        frequencies: Float64Array.from(pts.frequencyHz),
        magnitude: new Float64Array(nf),
        phase: new Float64Array(nf),
        coherence: new Float64Array(nf),
        hReal: Float64Array.from(pts.tRe),
        hImag: Float64Array.from(pts.tIm),
        numSegments: 1,
    };
    for (let i = 0; i < nf; i++) {
        const mag = Math.hypot(pts.tRe[i], pts.tIm[i]);
        tf.magnitude[i] = mag > 0 ? 20 * Math.log10(mag) : -Infinity;
        tf.phase[i] = (Math.atan2(pts.tIm[i], pts.tRe[i]) * 180) / Math.PI;
        tf.coherence[i] = Math.min(pts.coherenceRu[i], pts.coherenceRy[i]);
    }
    // The controller-model plant from the same T gives the record its shape (sample-rate checks,
    // missing filter info); every bin's G is then replaced by the JIO ratio or left unsupported.
    const model = extractPlantFromClosedLoop(tf, cfg, { missingFilterInfo: [] });
    const bins: PlantBin[] = model.bins.map((b, i) => {
        const supported = pts.supported[i] === 1;
        return {
            frequencyHz: b.frequencyHz,
            status: supported ? "ok" : pts.reason[i] === "non_finite" ? "non_finite_T" : "low_coherence",
            coherence: tf.coherence[i],
            T: { re: pts.tRe[i], im: pts.tIm[i] },
            G: supported ? { re: pts.gRe[i], im: pts.gIm[i] } : null,
            denomRel: Math.hypot(pts.uRe[i], pts.uIm[i]),
            algebraicAbsErr: NaN,
        };
    });
    const plant: IdentifiedPlant = {
        ...model,
        bins,
        okCount: bins.filter((b) => b.status === "ok").length,
        algebraicMeanAbsErr: NaN,
        algebraicRmsAbsErr: NaN,
        validation: { ...model.validation, ALGEBRAIC_CONSISTENCY: "UNTESTED", CONTROLLER_PARITY: "UNTESTED" },
    };
    return { tf, plant };
}

function agreement(pts: JioEvalPoints, plant: IdentifiedPlant): JioAxisResult["controllerModelAgreement"] {
    // The engine's model plant from T under the header controller, recomputed here on the same bins.
    const model = extractPlantFromClosedLoop(
        {
            frequencies: pts.frequencyHz,
            magnitude: new Float64Array(pts.frequencyHz.length),
            phase: new Float64Array(pts.frequencyHz.length),
            coherence: Float64Array.from(pts.coherenceRy),
            hReal: pts.tRe,
            hImag: pts.tIm,
            numSegments: 1,
        },
        plant.measurementCfg,
        { missingFilterInfo: [] },
    );
    const dbs: number[] = [];
    const degs: number[] = [];
    for (let i = 0; i < pts.frequencyHz.length; i++) {
        const mb = model.bins[i];
        if (!pts.supported[i] || mb.status !== "ok" || !mb.G) continue;
        const q = cdivRaw(pts.gRe[i], pts.gIm[i], mb.G.re, mb.G.im);
        const mag = Math.hypot(q.re, q.im);
        if (!(mag > 0) || !Number.isFinite(mag)) continue;
        dbs.push(Math.abs(20 * Math.log10(mag)));
        degs.push(Math.abs((Math.atan2(q.im, q.re) * 180) / Math.PI));
    }
    return dbs.length ? { points: dbs.length, medianAbsDb: median(dbs), medianAbsDeg: median(degs) } : null;
}

function inv3(M: Complex[][]): Complex[][] | null {
    // Gauss-Jordan on a 3×3 complex matrix.
    const a = M.map((row, i) => [
        ...row.map((c) => ({ ...c })),
        ...[0, 1, 2].map((j) => ({ re: i === j ? 1 : 0, im: 0 })),
    ]);
    for (let c = 0; c < 3; c++) {
        let p = c;
        for (let r = c + 1; r < 3; r++)
            if (Math.hypot(a[r][c].re, a[r][c].im) > Math.hypot(a[p][c].re, a[p][c].im)) p = r;
        if (!(Math.hypot(a[p][c].re, a[p][c].im) > 1e-300)) return null;
        [a[c], a[p]] = [a[p], a[c]];
        const piv = a[c][c];
        for (let j = 0; j < 6; j++) a[c][j] = cdivRaw(a[c][j].re, a[c][j].im, piv.re, piv.im);
        for (let r = 0; r < 3; r++) {
            if (r === c) continue;
            const f = a[r][c];
            for (let j = 0; j < 6; j++)
                a[r][j] = {
                    re: a[r][j].re - (f.re * a[c][j].re - f.im * a[c][j].im),
                    im: a[r][j].im - (f.re * a[c][j].im + f.im * a[c][j].re),
                };
        }
    }
    return a.map((row) => row.slice(3));
}

function frob(M: Complex[][]): number {
    let s = 0;
    for (const row of M) for (const c of row) s += c.re * c.re + c.im * c.im;
    return Math.sqrt(s);
}

function mul3(A: Complex[][], B: Complex[][]): Complex[][] {
    return A.map((row) =>
        [0, 1, 2].map((j) => {
            let re = 0;
            let im = 0;
            for (let k = 0; k < 3; k++) {
                re += row[k].re * B[k][j].re - row[k].im * B[k][j].im;
                im += row[k].re * B[k][j].im + row[k].im * B[k][j].re;
            }
            return { re, im };
        }),
    );
}

/**
 * Diagnostic 3×3: with the (combined) column of every axis, G = Y_r · U_r⁻¹ at the points where all
 * three columns are supported and U_r is well conditioned (Frobenius condition estimate ≤ max).
 * Three sequential sweeps are three measurements at three times: this is one plant only if each
 * axis's repeats were consistent, which the notes say when they were not.
 */
function mimo(
    cols: Partial<Record<number, Column>>,
    axes: Partial<Record<AxisName, JioAxisResult>>,
    lo: number,
    hi: number,
): JioMimoResult | null {
    const c0 = cols[0];
    const c1 = cols[1];
    const c2 = cols[2];
    if (!c0 || !c1 || !c2) return null;
    const notes: string[] = ["diagnostic_only"];
    for (const name of AXES) {
        const a = axes[name];
        if (a && a.repeats.consistency !== "consistent")
            notes.push(`stationarity_unproven:${name}:${a.repeats.consistency}`);
    }
    // Axes on their own grids (block 4): the coarsest grid is the reference, the other two columns
    // are matched to the nearest point within half a coarse step (half-open, no point twice), never
    // interpolated; only points supported on all three axes inside the common band take part.
    const C = [c0, c1, c2];
    const steps = C.map((c) => (c.f.length > 1 ? c.f[1] - c.f[0] : NaN));
    if (steps.some((x) => !(x > 0)))
        return {
            pointsWellConditioned: 0,
            pointsCommonSupported: 0,
            bandHz: null,
            conditionMedian: null,
            diagonalDbFirstLast: null,
            gridStepHz: null,
            notes: [...notes, "grid_missing"],
        };
    const ratio = Math.max(...steps) / Math.min(...steps);
    if (ratio > JIO_SWEEP.gridMaxStepRatio)
        return {
            pointsWellConditioned: 0,
            pointsCommonSupported: 0,
            bandHz: null,
            conditionMedian: null,
            diagonalDbFirstLast: null,
            gridStepHz: null,
            notes: [...notes, `grids_incomparable:step_ratio:${ratio.toFixed(2)}`],
        };
    const ref = steps.indexOf(Math.max(...steps));
    if (ratio > 1.0001) notes.push(`grids_matched_nearest:step_ratio:${ratio.toFixed(2)}`);
    const half = steps[ref] / 2;
    const sup = [0, 1, 2].map((a) => axes[AXES[a]]!.points!.supported);
    const cursor = [0, 0, 0];
    const matchIdx = (a: number, f: number): number => {
        if (a === ref) return -2;
        const cf = C[a].f;
        while (cursor[a] + 1 < cf.length && cf[cursor[a] + 1] <= f) cursor[a]++;
        let best = -1;
        for (const k of [cursor[a], cursor[a] + 1]) {
            if (k >= cf.length) continue;
            const d = cf[k] - f;
            if (d > half || d <= -half) continue;
            if (best < 0 || Math.abs(d) < Math.abs(cf[best] - f)) best = k;
        }
        return best;
    };
    const nf = C[ref].f.length;
    const conds: number[] = [];
    const okIdx: number[] = [];
    let common = 0;
    const Gs: Complex[][][] = [];
    for (let i = 0; i < nf; i++) {
        const f = C[ref].f[i];
        if (!(f >= lo && f <= hi)) continue;
        const idx = [0, 1, 2].map((a) => (a === ref ? i : matchIdx(a, f)));
        if (idx.some((k) => k < 0)) continue;
        if (!idx.every((k, a) => sup[a][k])) continue;
        common++;
        const Ur = [0, 1, 2].map((row) =>
            [0, 1, 2].map((colIdx) => ({
                re: C[colIdx].hruRe[idx[colIdx] * 3 + row],
                im: C[colIdx].hruIm[idx[colIdx] * 3 + row],
            })),
        );
        const Yr = [0, 1, 2].map((row) =>
            [0, 1, 2].map((colIdx) => ({
                re: C[colIdx].hryRe[idx[colIdx] * 3 + row],
                im: C[colIdx].hryIm[idx[colIdx] * 3 + row],
            })),
        );
        const inv = inv3(Ur);
        if (!inv) continue;
        const cond = frob(Ur) * frob(inv);
        conds.push(cond);
        if (cond > JIO_SWEEP.maxCondition) continue;
        okIdx.push(i);
        Gs.push(mul3(Yr, inv));
    }
    const db = (c: Complex) => 20 * Math.log10(Math.hypot(c.re, c.im));
    return {
        pointsWellConditioned: okIdx.length,
        pointsCommonSupported: common,
        bandHz: okIdx.length ? [C[ref].f[okIdx[0]], C[ref].f[okIdx[okIdx.length - 1]]] : null,
        conditionMedian: conds.length ? median(conds) : null,
        diagonalDbFirstLast: Gs.length
            ? [0, 1, 2].map((a) => [db(Gs[0][a][a]), db(Gs[Gs.length - 1][a][a])] as [number, number])
            : null,
        gridStepHz: steps[ref],
        notes,
    };
}
