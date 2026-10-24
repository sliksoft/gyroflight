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
 * Loop model for one axis (plan V2-C / V2-D): margins of the current and of a candidate tune.
 *
 * The CHIRP T is measured on gyroADCf, so the plant G = T / (C_ref − T·C_fb) identified by
 * M3 already contains the gyro filter chain as it behaved during the sweep. A candidate
 * changes the controller (C_fb) and/or the chain; with the notch-aware chain model the loop
 * becomes
 *
 *     L_candidate(f) = G(f) · H_chain,candidate(f) / H_chain,current(f) · C_fb,candidate(f)
 *
 * where both chain responses are the mean response over the same sweep window, simulated
 * with the logged eRPM / throttle (gyroChain.ts). Margins are read on the identified,
 * coherent bins only; anything outside them is reported as unknown, never extrapolated.
 *
 * A margin is VALIDATED only when the chain model reproduced this log's gyroADC
 * (validateChain), the chain barely moved at the crossover during the sweep, the crossover
 * lies inside the identified band, a Verified Tune for this craft attests the prediction
 * method (verifiedTune.ts), and the model class the bounds assume (no loop feature narrower than
 * the bins resolve) is qualified by an independent, finer measurement (MarginEvidence). The model
 * alone never validates.
 */

import {
    cadd,
    cdiv,
    cmag,
    cmul,
    cphaseDeg,
    evaluateControllerFrf,
    type Complex,
    type DigitalControllerConfig,
} from "@/js/blackbox/betaflight_digital_controller";
import { extractPlantFromClosedLoop, type IdentifiedPlant } from "@/js/blackbox/betaflight_open_loop";
import { fitDterm, type DtermFit } from "@/js/blackbox/betaflight_dterm_dynamic";
import type { TransferFunction } from "@/js/blackbox/spectral_analysis";
import type { ChainSimulation, EffectiveChain } from "./gyroChain";

/** Chain reproduces gyroADC: control band tight (decides PM), noise band looser (filter advice). */
export const CHAIN_ACCEPT = Object.freeze({
    controlBands: [
        [2, 20],
        [20, 80],
    ] as [number, number][],
    maxGainError: 0.05,
    maxPhaseDeg: 3,
    minCoherence: 0.9,
    noiseBands: [
        [80, 200],
        [200, 500],
    ] as [number, number][],
    noiseMaxGainError: 0.1,
    noiseMinCoherence: 0.8,
    /** The full chain must beat the chain without RPM and dynamic notch by this factor (NRMSE). */
    minAblationGain: 2,
});

/** Largest chain phase spread at the crossover over the sweep for an LTI stand-in to hold. */
export const MAX_CHAIN_SPREAD_DEG = 5;
/** Plant bins used for margins. */
export const LOOP_MIN_COHERENCE = 0.8;

export interface ChainValidation {
    axis: number;
    fit: DtermFit | null;
    ablationNrmse: number | null;
    controlBand: "PASS" | "FAIL" | "INSUFFICIENT";
    noiseBand: "PASS" | "FAIL" | "INSUFFICIENT";
    reasons: string[];
}

/**
 * Every required band must be measured with enough coherence: a band that is missing or
 * incoherent is unsupported (INSUFFICIENT), never left out. A supported band that misses the
 * gain / phase limits fails the whole set.
 */
function bandsOk(fit: DtermFit, bands: [number, number][], maxGain: number, maxPhase: number, minCoh: number) {
    const unsupported: string[] = [];
    let failed = false;
    for (const [lo, hi] of bands) {
        const b = fit.bands.find((x) => x.loHz === lo && x.hiHz === hi);
        if (!b || !((b.coherence ?? 0) >= minCoh)) {
            unsupported.push(`${lo}-${hi}Hz`);
            continue;
        }
        if (!(Math.abs((b.gainRatio ?? Infinity) - 1) <= maxGain && Math.abs(b.phaseDeg ?? Infinity) <= maxPhase)) {
            failed = true;
        }
    }
    const status = failed ? ("FAIL" as const) : unsupported.length ? ("INSUFFICIENT" as const) : ("PASS" as const);
    return { status, unsupported };
}

/** The frequency range a PASS of the control bands covers; margins outside it are not backed by the chain. */
export const CHAIN_VALIDATED_BAND_HZ: readonly [number, number] = [
    CHAIN_ACCEPT.controlBands[0][0],
    CHAIN_ACCEPT.controlBands[CHAIN_ACCEPT.controlBands.length - 1][1],
];

/**
 * What the end of the identified band must show before GM and |S| count as bounded by the
 * measurement. Above the last bin the loop is unknown; a resonance or lead just outside the band
 * can take |L| back above one (Codex re-review R-2: a 2nd-order resonance with ζ = 0.02 at
 * 1.10 × f_end still shows |L| = 0.64 at f_end, and 2.4 ten percent higher).
 *
 *   tailFraction 0.1 / minTailBins 4: the slope is judged over the top 10 % of the band, enough
 *     bins to average identification noise, short enough that a resonance up to ~20 % above the
 *     band shows: that ζ = 0.02 peak at 1.10 × f_end lifts |L| by 3.7 dB over the last 10 %, at
 *     1.20 × f_end by 1.5 dB, at 1.50 × f_end by less than 0.5 dB (it falls).
 *   maxTailRiseDb 1: the least-squares rise over the tail may not exceed 1 dB. A smooth plant
 *     (motor pole plus delay) falls or stays flat there; coherent-bin noise of the identified L
 *     is a fraction of a dB over 10 % of the band.
 *   maxBandEndDb −6: |L| at the last bin may not exceed −6 dB, the release target for the gain
 *     margin (RELEASE_TARGETS.minGainMarginDb): above it, a phase crossover just outside the band
 *     could not carry the required margin, so the band cannot prove it.
 *
 * With the band end bounded, the reported GM is the worse of the in-band phase-crossover GM and
 * the gain headroom at the band end (−20·log10 max |L| over the tail): a crossover above the
 * band, if any, cannot be better than that.
 */
export const BAND_END = Object.freeze({ tailFraction: 0.1, minTailBins: 4, maxTailRiseDb: 1, maxBandEndDb: -6 });

/**
 * What the identified bins must show before PM, GM and |S| read on them count as bounds of the
 * continuous loop (Codex final review F-02). Margins are read on measured bins only; between two
 * bins the loop is not measured. A pole/zero pair narrower than the bin spacing can sit between
 * two bins and leave almost no trace on either (fr = 70.25 Hz, ζ_pole = 1e-4 on a 0.5 Hz grid:
 * the bins show +1.2 dB, the loop between them reaches |L| = 4.1).
 *
 *   maxPhaseStepDeg 25 / maxGainStepDb 2: largest change of the loop between two adjacent bins
 *     (unwrapped phase, dB). A resonance whose −3 dB bandwidth is w turns the phase by at most
 *     about 2·atan(Δf / w) over one bin step Δf, so 25° means every feature the data shows spans
 *     at least ≈ 4.5 bin steps (RESOLVED_FEATURE_BINS). The 70.25 Hz example steps 55° between
 *     70.0 and 70.5 Hz. The AIR65 CHIRP logs (1.95 Hz bins) step at most 23° above the crossover.
 *   maxPhaseSlopeDegPerNeper 300 / maxGainSlopeDbPerDecade 80: a well-damped loop turns
 *     faster over a coarse relative step (integrator and PI zero at 4–10 Hz: up to 69° and
 *     6.1 dB per 1.95 Hz bin on the AIR65 logs, about 63 dB/decade; 80 leaves room for that). The allowed step is the larger of the floor and slope ×
 *     log-span of the step, so it does not depend on the grid being uniform.
 *   maxGapRatio 3: a step wider than 3× the median step of its neighbourhood (±5 steps) is a gap
 *     (a log-spaced or jittered grid is not one).
 *   maxRelativeSpacing 0.5: from half the crossover up, no step may be wider than half its
 *     frequency: a sparse band (bins at 5, 10, 20, 40 Hz around a 10 Hz crossover) cannot resolve
 *     the crossover region whatever its steps show. The AIR65 logs step 1.95 Hz from 8 Hz up (24 %).
 *
 * Validity limit, stated rather than solved: a finite set of bins cannot exclude an arbitrarily
 * narrow, unmeasured resonance. A pole/zero pair whose both bandwidths are well below the bin
 * step (fr = 70.25 Hz, ζ_zero = 5e-4, ζ_pole = 5e-5 on 0.5 Hz bins: steps of about 14°, |L(fr)| ≈ 2)
 * passes these checks. Bounds (MarginEvidence level MODEL_CONDITIONAL / VALIDATED) therefore hold for a loop
 * without features narrower than RESOLVED_FEATURE_BINS × resolutionHz; they are not an absolute
 * stability guarantee. A finer CHIRP resolution (longer FFT segments) narrows that limit.
 *
 * That assumption is therefore carried as evidence, not hidden in the status: such bounds are
 * MODEL_CONDITIONAL (MarginEvidence) until an independent finer measurement qualifies the class
 * (MODEL_CLASS_QUALIFICATION); only then are they VALIDATED.
 */
export const LOOP_RESOLUTION = Object.freeze({
    maxPhaseStepDeg: 25,
    maxGainStepDb: 2,
    maxPhaseSlopeDegPerNeper: 300,
    maxGainSlopeDbPerDecade: 80,
    maxGapRatio: 3,
    maxRelativeSpacing: 0.5,
});

/** Narrowest feature, in bin steps, the step limit shows: −3 dB bandwidth ≈ Δf / tan(maxPhaseStepDeg / 2). */
export const RESOLVED_FEATURE_BINS = 1 / Math.tan(((LOOP_RESOLUTION.maxPhaseStepDeg / 2) * Math.PI) / 180);

/**
 * How far the loop can leave the chord between two adjacent bins, per unit of chord length, when
 * the step between them is resolved: a 2nd-order section traces a circle, and a phase step φ of the
 * section spans 2φ of that circle, whose sagitta is chord/2 · tan(2φ/4). With φ ≤ maxPhaseStepDeg
 * that is tan(12.5°)/2 ≈ 0.11. The bounded GM and |S| add it to what the bins show (Codex final
 * review F-02: at the edge of the resolved class the bins alone under-read |S| by ≈ 0.5 dB).
 */
export const BIN_SAGITTA = Math.tan(((LOOP_RESOLUTION.maxPhaseStepDeg / 2) * Math.PI) / 180) / 2;

/**
 * What qualifies the model class of bounded margins (Codex final acceptance review, F-02). The bounds
 * assume a loop without features narrower than RESOLVED_FEATURE_BINS × resolutionHz; the bins
 * themselves cannot show that. A second CHIRP log of the same craft and configuration, from another
 * flight (logInput.crossLogReferenceIssues), identified at a resolution fine enough to resolve every
 * such feature — RESOLVED_FEATURE_BINS × its resolution ≤ the primary's resolution, so it resolves
 * anything at least one primary bin step wide — over the same band, qualifies it when, with the
 * same candidate controller:
 *
 *   - its own loop is resolved and its band end bounded (LOOP_RESOLUTION, BAND_END), with no
 *     unity re-entry: otherwise it shows what the primary bins could not (verdict FAIL);
 *   - its PM / GM / |S| bounds are not worse than the primary's by more than the log-to-log scatter
 *     (maxPmDeficitDeg / maxGainDeficitDb: the M5-A reproducibility band, verifiedTune.ts
 *     toleranceFloor) (FAIL beyond it).
 *
 * A qualification that is too coarse, does not cover the band or cannot read margins is
 * INSUFFICIENT: the margins stay MODEL_CONDITIONAL. With PASS the reported margins are the worse of
 * both logs. What remains is the finer log's own class (features narrower than RESOLVED_FEATURE_BINS
 * × its resolution), stated in MarginEvidence.assumptions: no finite measurement removes it.
 */
export const MODEL_CLASS_QUALIFICATION = Object.freeze({ maxPmDeficitDeg: 5, maxGainDeficitDb: 1.5 });

/**
 * How far a qualification's band must reach above the primary's band end before it may stand for
 * the loop there (audit P1-2). The primary's tail check (BAND_END) sees a ζ = 0.02 resonance at
 * 1.1 × f_end (+3.7 dB) and still at 1.2 × (+1.5 dB), but not from about 1.5 × f_end up (< 0.5 dB):
 * a qualification over the same band tests nothing of that blind range. With its band reaching
 * 1.5 × f_end (and its own end bounded), the remaining assumption moves to above the
 * qualification's band end. Derived from the BAND_END figures for one resonance shape; not calibrated.
 */
export const QUALIFICATION_BAND_EXTENSION = 1.5;

/**
 * Measurement uncertainty of the identified loop (WP3). Per bin, the random error of the H1
 * estimate from coherence γ² and the number of independent averages n_d (Bendat & Piersol, Random
 * Data, 4th ed., eq. 9.90 / 9.91): ε[|H|] ≈ √(1 − γ²) / (|γ| √(2 n_d)), and σ[φ] ≈ ε rad. They
 * hold for stationary random data; for a sweep they are an approximation, which n_d keeps
 * conservative (sweepAverages). The plant G = T / (C_ref − T·C_fb) and so L inherit T's relative
 * error times |C_ref / (C_ref − T·C_fb)| (first order), which grows where |T·C_fb| ≈ |C_ref|.
 *
 *   coverage 2           bounds at ±2 ε (≈ 95 % for a normal error; the formula's own premise).
 *   minWelchSegments 8   with fewer Welch segments the coherence estimate itself is too biased (with
 *                        one segment γ² ≡ 1): the uncertainty is then unknown and the margins
 *                        unbounded. Design parameter, not calibrated.
 *   maxCoverageRelErr 0.5  a ±2 ε of half the loop gain or more leaves no meaningful bound.
 *
 * The bounds hold for every loop inside the per-bin uncertainty set (uncertainBounds: each bin's L
 * within ±2 ε in gain and phase, independently and in either direction, and the resolved-class
 * allowance between bins): PM over every step where |L| can cross unity, GM over every step whose
 * phase can reach −180°, |S| from the closest approach of that set to −1. Model-dependent: the
 * formula is not validated against repeated flights.
 */
export const UNCERTAINTY = Object.freeze({ coverage: 2, minWelchSegments: 8, maxCoverageRelErr: 0.5 });

/**
 * Checks of the phase the margins are read on (WP3).
 *   maxUnwrapStepDeg 90  unwrapping picks the step of least magnitude, so it is unambiguous only while
 *     a step and its uncertainty (± 2 σ at both bins) stay well inside ±180°; above 90° a different
 *     branch is no longer excluded and the margins stay unbounded.
 *   The absolute branch: the identified rate plant (motor command → gyro rate: an integrator, the
 *     motor lag and a delay) has a phase in (−180°, 0°] at the lowest identified bin, and the
 *     controller's phase is continuous from there; their sum must equal the unwrapped loop phase at
 *     every bin, or the branch is unverified. An assumption of the model class, stated in the evidence.
 *   octaveBins 3  at least three identified bins within one octave around the crossover
 *     (fc/√2 … fc·√2): the crossing is bracketed and its slope is read from two steps.
 */
export const PHASE_CHECKS = Object.freeze({
    maxUnwrapStepDeg: 90,
    plantPhaseMinDeg: -180,
    plantPhaseMaxDeg: 0,
    octaveBins: 3,
});

/** Sweep of a CHIRP measurement (Betaflight chirp.c: exponential, f(t) = f0 · (f1 / f0)^(t / T)). */
export interface SweepInfo {
    f0Hz: number;
    f1Hz: number;
    durationS: number;
}

/**
 * Where a transfer function's resolution comes from: the Welch segment length in samples, the
 * sample rate, the samples of the analysed window and the segment count. A finer resolution than
 * the samples can give (zero padding, interpolation) is no resolution.
 */
export interface AnalysisProvenance {
    segmentSamples: number;
    sampleRateHz: number;
    windowSamples: number;
    segments: number;
}

/**
 * Independent averages at `fHz` in a Welch estimate of an exponential sweep: the sweep dwells
 * T / (f · ln(f1 / f0)) per hertz, so one bin of width 1/Ts is excited for T / (Ts · f · ln(f1/f0))
 * seconds, i.e. that many / Ts non-overlapping segments; at least 1, at most the non-overlapping
 * count of the whole window. Without the sweep: 1 (each frequency excited once).
 */
export function sweepAverages(fHz: number, segmentS: number, segments: number, sweep: SweepInfo | null): number {
    const cap = Math.max(1, Math.floor((segments + 1) / 2));
    if (!sweep || !(sweep.f1Hz > sweep.f0Hz && sweep.f0Hz > 0 && sweep.durationS > 0 && segmentS > 0 && fHz > 0)) {
        return 1;
    }
    const n = Math.floor(sweep.durationS / (segmentS * segmentS * fHz * Math.log(sweep.f1Hz / sweep.f0Hz)));
    return Math.min(cap, Math.max(1, n));
}

/** Per identified bin, the relative error of L (UNCERTAINTY); `relErr` null when it cannot be known. */
export interface LoopUncertainty {
    relErr: Map<number, number> | null;
    /** Independent averages per bin used (lowest and highest over the identified bins). */
    averages: [number, number] | null;
    /** Independent averages used at each bin. */
    averagesByHz?: Map<number, number>;
    reasons: string[];
}

/** The uncertainty of a loop identified from `tf` under the controller `cfg` (UNCERTAINTY). */
export function loopUncertainty(
    tf: TransferFunction,
    cfg: DigitalControllerConfig,
    measurement: { sweep?: SweepInfo | null; analysis?: AnalysisProvenance | null } = {},
): LoopUncertainty {
    const K = tf.numSegments;
    if (!(Number.isInteger(K) && K >= UNCERTAINTY.minWelchSegments)) {
        return { relErr: null, averages: null, reasons: [`uncertainty_unknown:welch_segments:${K}`] };
    }
    const step = tf.frequencies.length > 1 ? tf.frequencies[1] - tf.frequencies[0] : 0;
    const segmentS = measurement.analysis
        ? measurement.analysis.segmentSamples / measurement.analysis.sampleRateHz
        : step > 0
          ? 1 / step
          : 0;
    const relErr = new Map<number, number>();
    const averagesByHz = new Map<number, number>();
    let lo = Infinity;
    let hi = 0;
    for (let k = 0; k < tf.frequencies.length; k++) {
        const f = tf.frequencies[k];
        const g2 = tf.coherence[k];
        if (!(g2 > 0 && g2 <= 1) || !(f > 0)) continue;
        const n = sweepAverages(f, segmentS, K, measurement.sweep ?? null);
        averagesByHz.set(f, n);
        lo = Math.min(lo, n);
        hi = Math.max(hi, n);
        const eT = Math.sqrt(1 - g2) / (Math.sqrt(g2) * Math.sqrt(2 * n));
        const T = { re: tf.hReal[k], im: tf.hImag[k] };
        const frf = evaluateControllerFrf(cfg, f);
        const den = cmag({
            re: frf.cReference.re - (T.re * frf.cFeedback.re - T.im * frf.cFeedback.im),
            im: frf.cReference.im - (T.re * frf.cFeedback.im + T.im * frf.cFeedback.re),
        });
        const kappa = den > 1e-12 ? cmag(frf.cReference) / den : Infinity;
        relErr.set(f, eT * kappa);
    }
    return { relErr, averages: Number.isFinite(lo) ? [lo, hi] : null, averagesByHz, reasons: [] };
}

/**
 * What the margins rest on (one level per result; LoopMargins.status is VALIDATED only with level
 * VALIDATED and no other reason):
 *
 *   MEASURED           read on the identified bins only (interpolated between them); GM and |S|
 *                      bounds unknown. A research result, never a bound.
 *   MODEL_CONDITIONAL  bounds of the continuous loop under stated assumptions (no feature narrower
 *                      than minFeatureWidthHz, the loop between bins within BIN_SAGITTA of the
 *                      chord, the band end bounded), the assumptions not independently qualified.
 *   VALIDATED          those bounds with the model class qualified (MODEL_CLASS_QUALIFICATION).
 *   INSUFFICIENT       no margins could be read.
 */
export type MarginEvidenceLevel = "MEASURED" | "MODEL_CONDITIONAL" | "VALIDATED" | "INSUFFICIENT";
export const MARGIN_EVIDENCE_LEVELS: readonly MarginEvidenceLevel[] = [
    "MEASURED",
    "MODEL_CONDITIONAL",
    "VALIDATED",
    "INSUFFICIENT",
];

export interface ModelClassQualification {
    /** The independent log whose finer identification was checked against the bounds. */
    source: { sha256: string; logIndex: number };
    /** Largest bin step of that identification (Hz). */
    resolutionHz: number | null;
    bandHz: [number, number] | null;
    verdict: "PASS" | "FAIL" | "INSUFFICIENT";
    /** The candidate's margins read on the finer bins (bounds when its own loop is resolved). */
    phaseMarginDeg: number | null;
    gainMarginDb: number | null;
    sensitivityPeakDb: number | null;
    reasons: string[];
}

/** The measurement uncertainty folded into the bounds (UNCERTAINTY). */
export interface MarginUncertainty {
    /** Coverage factor k of the ± k ε corners. */
    coverage: number;
    /** Independent averages per bin used (lowest, highest). */
    averages: [number, number] | null;
    /** Largest relative error ε of L over the bins the margins are read on. */
    maxRelErr: number;
    /** Identified bins left out because their ±k ε reached half their value (not identified). */
    droppedBins?: number;
    /** The nominal values read on the bins, before the uncertainty widened them. */
    nominal: { phaseMarginDeg: number; gainMarginDb: number | null; sensitivityPeakDb: number | null };
}

export interface MarginEvidence {
    level: MarginEvidenceLevel;
    /** Largest step between two adjacent identified bins (Hz): the frequency resolution of the margins. */
    resolutionHz: number | null;
    /** Identified band the margins are read on (first, last bin): the range of validity. */
    bandHz: [number, number] | null;
    /** Narrowest loop feature the bounds account for (RESOLVED_FEATURE_BINS × resolutionHz); null: no bounds. */
    minFeatureWidthHz: number | null;
    /** What the margins assume, as codes (shown with the margins). */
    assumptions: string[];
    qualification: ModelClassQualification | null;
    /** The uncertainty the bounds include; null: not known (no bounds then). */
    uncertainty?: MarginUncertainty | null;
}

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const validBand = (b: unknown): b is [number, number] =>
    Array.isArray(b) && b.length === 2 && finite(b[0]) && finite(b[1]) && b[0] >= 0 && b[0] < b[1];

/**
 * Why `evidence` does not carry VALIDATED margins: the one check that promotes bounds to VALIDATED
 * (loopMargins) and that the release contract repeats on whatever reaches it. Fail-closed: missing,
 * malformed or inconsistent metadata is an issue, never a pass.
 */
export function marginEvidenceIssues(evidence: unknown): string[] {
    if (!evidence || typeof evidence !== "object") return ["margin_evidence_missing"];
    const e = evidence as Partial<MarginEvidence>;
    const out: string[] = [];
    if (e.level !== "VALIDATED") {
        out.push(
            MARGIN_EVIDENCE_LEVELS.includes(e.level as MarginEvidenceLevel)
                ? `margin_evidence_${(e.level as string).toLowerCase()}`
                : "margin_evidence_level_invalid",
        );
    }
    const r = e.resolutionHz;
    const rOk = finite(r) && r > 0;
    if (!rOk) out.push("margin_evidence_resolution_invalid");
    if (!validBand(e.bandHz)) out.push("margin_evidence_band_invalid");
    if (
        !rOk ||
        !finite(e.minFeatureWidthHz) ||
        Math.abs(e.minFeatureWidthHz - RESOLVED_FEATURE_BINS * r) > 1e-9 * RESOLVED_FEATURE_BINS * r
    ) {
        out.push("margin_evidence_feature_width_invalid");
    }
    if (!Array.isArray(e.assumptions) || !e.assumptions.length) out.push("margin_evidence_assumptions_missing");
    // The bounds must carry the measurement uncertainty they include (fail-closed when absent).
    const u = e.uncertainty as Partial<MarginUncertainty> | null | undefined;
    if (
        !u ||
        typeof u !== "object" ||
        !finite(u.coverage) ||
        u.coverage < UNCERTAINTY.coverage ||
        !finite(u.maxRelErr) ||
        u.maxRelErr < 0 ||
        u.coverage * u.maxRelErr >= UNCERTAINTY.maxCoverageRelErr
    ) {
        out.push("margin_evidence_uncertainty_missing");
    }
    const q = e.qualification as Partial<ModelClassQualification> | null | undefined;
    if (!q || typeof q !== "object") {
        out.push("model_class_qualification_missing");
        return out;
    }
    if (q.verdict !== "PASS") {
        out.push(
            q.verdict === "FAIL" || q.verdict === "INSUFFICIENT"
                ? `model_class_qualification_${q.verdict.toLowerCase()}`
                : "model_class_qualification_verdict_invalid",
        );
    }
    if (!q.source || typeof q.source.sha256 !== "string" || !q.source.sha256 || !Number.isInteger(q.source.logIndex)) {
        out.push("model_class_qualification_source_invalid");
    }
    if (!(
        finite(q.resolutionHz) &&
        q.resolutionHz > 0 &&
        rOk &&
        q.resolutionHz * RESOLVED_FEATURE_BINS <= r * (1 + 1e-9)
    )) {
        out.push("model_class_qualification_not_finer");
    }
    if (
        !validBand(q.bandHz) ||
        !validBand(e.bandHz) ||
        !rOk ||
        q.bandHz[0] > e.bandHz[0] + r ||
        q.bandHz[1] < e.bandHz[1] - r
    ) {
        out.push("model_class_qualification_band_not_covered");
    } else if (q.bandHz[1] < e.bandHz[1] * QUALIFICATION_BAND_EXTENSION - r) {
        // A qualification over the same band does not test the loop above it (audit P1-2).
        out.push("model_class_qualification_band_not_extended");
    }
    if (!finite(q.phaseMarginDeg) || !finite(q.gainMarginDb) || !finite(q.sensitivityPeakDb)) {
        out.push("model_class_qualification_margins_missing");
    }
    if (!Array.isArray(q.reasons) || q.reasons.length) out.push("model_class_qualification_has_reasons");
    return out;
}

/**
 * Rise (dB) of the least-squares line through (f, dB) from the first to the last point. Each point
 * weighs the frequency span it stands for, so a cluster of bins does not outweigh the rest of the
 * tail (a uniform grid weighs every point equally).
 */
function lsqRiseDb(tail: { f: number; db: number }[]): number {
    const n = tail.length;
    if (n < 2) return 0;
    const w = tail.map((_, j) =>
        j === 0
            ? tail[1].f - tail[0].f
            : j === n - 1
              ? tail[n - 1].f - tail[n - 2].f
              : (tail[j + 1].f - tail[j - 1].f) / 2,
    );
    const sw = w.reduce((s, x) => s + x, 0);
    if (!(sw > 0)) return 0;
    const mf = tail.reduce((s, t, j) => s + w[j] * t.f, 0) / sw;
    const md = tail.reduce((s, t, j) => s + w[j] * t.db, 0) / sw;
    let num = 0;
    let den = 0;
    for (const [j, t] of tail.entries()) {
        num += w[j] * (t.f - mf) * (t.db - md);
        den += w[j] * (t.f - mf) * (t.f - mf);
    }
    return den > 0 ? (num / den) * (tail[n - 1].f - tail[0].f) : 0;
}

/**
 * Whether the bins resolve the loop (LOOP_RESOLUTION): gaps, a band too coarse around the
 * crossover, and steps larger than a resolved loop makes. `ph` is the unwrapped phase.
 */
function resolutionIssues(f: number[], magDb: number[], ph: number[], fc: number): string[] {
    const R = LOOP_RESOLUTION;
    const steps = f.slice(1).map((x, i) => x - f[i]);
    const span = (i: number) => `${f[i].toFixed(1)}-${f[i + 1].toFixed(1)}Hz`;
    const gaps: string[] = [];
    const coarse: string[] = [];
    const unresolved: string[] = [];
    steps.forEach((s, i) => {
        // The ±5 neighbouring steps (a local slice: the search over all steps was quadratic).
        const near = [...steps.slice(Math.max(0, i - 5), i), ...steps.slice(i + 1, i + 6)].sort((a, b) => a - b);
        if (near.length && s > R.maxGapRatio * near[Math.floor(near.length / 2)]) gaps.push(span(i));
        if (f[i] >= fc / 2 && s > R.maxRelativeSpacing * f[i]) coarse.push(span(i));
        const phaseLimit = Math.max(R.maxPhaseStepDeg, R.maxPhaseSlopeDegPerNeper * Math.log(f[i + 1] / f[i]));
        const gainLimit = Math.max(R.maxGainStepDb, R.maxGainSlopeDbPerDecade * Math.log10(f[i + 1] / f[i]));
        if (Math.abs(ph[i + 1] - ph[i]) > phaseLimit || Math.abs(magDb[i + 1] - magDb[i]) > gainLimit) {
            unresolved.push(span(i));
        }
    });
    const list = (name: string, xs: string[]) =>
        xs.length ? [`${name}:${xs.slice(0, 3).join(",")}${xs.length > 3 ? `,+${xs.length - 3}` : ""}`] : [];
    return [
        ...(gaps.length ? ["identified_band_has_gaps"] : []),
        ...list("identified_band_too_coarse", coarse),
        ...list("loop_unresolved_between_bins", unresolved),
    ];
}

/**
 * Compare the simulated chain with the logged gyroADC of one axis over `mask` (in-flight
 * samples). `ablation` is the same simulation without RPM filter and dynamic notch.
 */
export function validateChain(
    axis: number,
    sim: ChainSimulation,
    ablation: ChainSimulation | null,
    loggedGyroAdc: ArrayLike<number>,
    sampleRateHz: number,
    mask: Uint8Array,
): ChainValidation {
    const valid = sim.valid.map((v, k) => (v && mask[k] ? 1 : 0));
    const bands = [...CHAIN_ACCEPT.controlBands, ...CHAIN_ACCEPT.noiseBands];
    const fit = fitDterm({ d: sim.out[axis], valid } as never, loggedGyroAdc, sampleRateHz, 1024, bands);
    const reasons: string[] = [...sim.notes];
    if (!fit) {
        return {
            axis,
            fit,
            ablationNrmse: null,
            controlBand: "INSUFFICIENT",
            noiseBand: "INSUFFICIENT",
            reasons: [...reasons, "chain_fit_insufficient_data"],
        };
    }
    const control = bandsOk(
        fit,
        CHAIN_ACCEPT.controlBands,
        CHAIN_ACCEPT.maxGainError,
        CHAIN_ACCEPT.maxPhaseDeg,
        CHAIN_ACCEPT.minCoherence,
    );
    let controlBand = control.status;
    reasons.push(...control.unsupported.map((b) => `chain_band_unsupported:${b}`));
    const noiseBand = bandsOk(
        fit,
        CHAIN_ACCEPT.noiseBands,
        CHAIN_ACCEPT.noiseMaxGainError,
        10,
        CHAIN_ACCEPT.noiseMinCoherence,
    ).status;
    let ablationNrmse: number | null = null;
    if (ablation) {
        const abValid = ablation.valid.map((v, k) => (v && mask[k] ? 1 : 0));
        ablationNrmse =
            fitDterm({ d: ablation.out[axis], valid: abValid } as never, loggedGyroAdc, sampleRateHz, 1024, bands)
                ?.nrmse ?? null;
        if (
            ablationNrmse !== null &&
            !(ablationNrmse > 0 && fit.nrmse * CHAIN_ACCEPT.minAblationGain <= ablationNrmse)
        ) {
            reasons.push("chain_notches_not_shown_to_matter");
            if (controlBand === "PASS") controlBand = "FAIL";
        }
    }
    if (controlBand !== "PASS") reasons.push(`chain_control_band_${controlBand.toLowerCase()}`);
    if (noiseBand !== "PASS") reasons.push(`chain_noise_band_${noiseBand.toLowerCase()}`);
    return { axis, fit, ablationNrmse, controlBand, noiseBand, reasons };
}

export interface AxisLoop {
    axis: 0 | 1 | 2;
    plant: IdentifiedPlant;
    cfg: DigitalControllerConfig;
    chain: EffectiveChain | null;
    chainValidated: boolean;
    /** A Verified Tune for this craft / firmware passed (the only attestation). */
    attested: boolean;
    /** Relative error of the identified L per bin (UNCERTAINTY). */
    uncertainty: LoopUncertainty;
    /**
     * The plant identified at a finer resolution from another flight of the same craft and
     * configuration (MODEL_CLASS_QUALIFICATION), its uncertainty and where its resolution comes
     * from, or null.
     */
    qualification: {
        plant: IdentifiedPlant;
        source: { sha256: string; logIndex: number };
        uncertainty: LoopUncertainty;
        /** Why its resolution is not shown to come from its samples (empty: it is). */
        provenanceIssues: string[];
    } | null;
}

export interface LoopCandidate {
    cfg: DigitalControllerConfig;
    /** Mean chain response of the candidate's gyro filters over the same window; null: unchanged. */
    chain?: EffectiveChain | null;
}

export interface LoopMargins {
    status: "VALIDATED" | "NOT_VALIDATED" | "UNAVAILABLE";
    crossoverHz: number | null;
    phaseMarginDeg: number | null;
    gainMarginDb: number | null;
    sensitivityPeakDb: number | null;
    delayMarginMs: number | null;
    /** Chain phase spread at the crossover over the sweep (°). */
    chainSpreadDeg: number | null;
    okBins: number;
    /**
     * What the values above rest on: level, resolution, band, model-class assumptions and their
     * qualification. MEASURED leaves GM and |S| unknown; MODEL_CONDITIONAL and VALIDATED make PM /
     * GM / |S| bounds (with a PASS qualification: the worse of both logs).
     */
    evidence: MarginEvidence;
    /**
     * PM, GM and |S| as read on the primary's bins (interpolated between them), whatever the
     * evidence: the measured values, a research result. The top-level values are the bounds.
     */
    measured: { phaseMarginDeg: number | null; gainMarginDb: number | null; sensitivityPeakDb: number | null };
    reasons: string[];
}

/** Plant from the CHIRP T and the controller in force during the sweep. */
export function buildAxisLoop(
    axis: 0 | 1 | 2,
    tf: TransferFunction,
    cfg: DigitalControllerConfig,
    chain: EffectiveChain | null,
    chainValidated: boolean,
    attested: boolean,
    /**
     * A finer CHIRP T of the same axis from another flight with the same configuration, and the
     * controller in force during that sweep (default: `cfg`).
     */
    qualification: {
        tf: TransferFunction;
        cfg?: DigitalControllerConfig;
        source: { sha256: string; logIndex: number };
        sweep?: SweepInfo | null;
        /** Where the finer resolution comes from; without it the qualification is not shown finer. */
        analysis?: AnalysisProvenance | null;
    } | null = null,
    /** The primary measurement's sweep and analysis (UNCERTAINTY averages). */
    measurement: { sweep?: SweepInfo | null; analysis?: AnalysisProvenance | null } = {},
): AxisLoop {
    const missing = chainValidated ? [] : ["dyn_notch_centres_unknown", "rpm_filter_schedule_unknown"];
    const opts = { missingFilterInfo: missing, coherenceMin: LOOP_MIN_COHERENCE };
    const plant = extractPlantFromClosedLoop(tf, cfg, opts);
    return {
        axis,
        plant,
        cfg,
        chain,
        chainValidated,
        attested,
        uncertainty: loopUncertainty(tf, cfg, measurement),
        qualification: qualification
            ? {
                  plant: extractPlantFromClosedLoop(qualification.tf, qualification.cfg ?? cfg, opts),
                  source: { ...qualification.source },
                  uncertainty: loopUncertainty(qualification.tf, qualification.cfg ?? cfg, qualification),
                  provenanceIssues: provenanceIssues(qualification.tf, qualification.analysis ?? null),
              }
            : null,
    };
}

/**
 * Why a transfer function's resolution is not shown to come from its own samples (WP3): the bins
 * may be no denser than the Welch segment gives (fs / segment samples), the window must hold that
 * many segments at 50 % overlap, and there must be enough of them for the coherence to mean
 * something (UNCERTAINTY.minWelchSegments).
 */
export function provenanceIssues(tf: TransferFunction, a: AnalysisProvenance | null): string[] {
    if (!a) return ["resolution_provenance_missing"];
    const out: string[] = [];
    const ok = (x: number) => Number.isFinite(x) && x > 0;
    if (!ok(a.segmentSamples) || !ok(a.sampleRateHz) || !ok(a.windowSamples) || !ok(a.segments)) {
        return ["resolution_provenance_invalid"];
    }
    const steps = Array.from(tf.frequencies)
        .slice(1)
        .map((f, i) => f - tf.frequencies[i]);
    const finest = steps.length ? Math.min(...steps) : Infinity;
    if (finest < (a.sampleRateHz / a.segmentSamples) * (1 - 1e-9)) out.push("bins_denser_than_segment_resolution");
    if (a.windowSamples < (a.segmentSamples * (a.segments + 1)) / 2) out.push("window_shorter_than_its_segments");
    if (a.segments < UNCERTAINTY.minWelchSegments || tf.numSegments !== a.segments) {
        out.push(`too_few_welch_segments:${a.segments}`);
    }
    return out;
}

function unwrap(phases: number[]): number[] {
    const out: number[] = [];
    let offset = 0;
    for (let i = 0; i < phases.length; i++) {
        if (i > 0) {
            const d = phases[i] + offset - out[i - 1];
            if (d > 180) offset -= 360;
            else if (d < -180) offset += 360;
        }
        out.push(phases[i] + offset);
    }
    return out;
}

/** One identified bin of a candidate loop: L = G · C, and the relative error of L there (UNCERTAINTY). */
export interface LoopPoint {
    f: number;
    L: Complex;
    /** The plant term (with the candidate's chain ratio) and the controller term of L. */
    G?: Complex;
    C?: Complex;
    /** Relative error ε of L; undefined: not known. */
    err?: number;
}

/** Loop response of a candidate on the identified bins. */
export function candidateLoop(loop: AxisLoop, cand: LoopCandidate): LoopPoint[] {
    const out: LoopPoint[] = [];
    for (const b of loop.plant.bins) {
        if (b.status !== "ok" || !b.G || !(b.coherence >= LOOP_MIN_COHERENCE)) continue;
        let G = b.G;
        if (cand.chain && loop.chain) {
            G = cmul(G, cdiv(cand.chain.frf(b.frequencyHz), loop.chain.frf(b.frequencyHz)));
        }
        const err = loop.uncertainty?.relErr?.get(b.frequencyHz);
        // A bin whose ±k ε reaches half its own value is not identified (UNCERTAINTY): typically at
        // low frequency, where |T·C_fb| ≈ |C_ref| amplifies T's error into G.
        if (err !== undefined && UNCERTAINTY.coverage * err >= UNCERTAINTY.maxCoverageRelErr) continue;
        const C = evaluateControllerFrf(cand.cfg, b.frequencyHz).cFeedback;
        out.push({ f: b.frequencyHz, L: cmul(G, C), G, C, err });
    }
    return out;
}

/** Frequencies of the identified bins candidateLoop leaves out because their uncertainty is too large. */
function binsDroppedForUncertainty(loop: AxisLoop): number[] {
    const relErr = loop.uncertainty?.relErr;
    if (!relErr) return [];
    const out: number[] = [];
    for (const b of loop.plant.bins) {
        if (b.status !== "ok" || !b.G || !(b.coherence >= LOOP_MIN_COHERENCE)) continue;
        const err = relErr.get(b.frequencyHz);
        if (err !== undefined && UNCERTAINTY.coverage * err >= UNCERTAINTY.maxCoverageRelErr) out.push(b.frequencyHz);
    }
    return out;
}

/**
 * Bins left out above the lowest kept one: an unresolved interval inside the band (a poorly
 * identified resonance would vanish with them), or a band end that moved down. Only the low edge,
 * where |T·C_fb| ≈ |C_ref| amplifies the error, may drop out.
 */
function unidentifiedInsideBand(loop: AxisLoop, pts: LoopPoint[]): string[] {
    const inside = binsDroppedForUncertainty(loop).filter((f) => pts.length > 0 && f > pts[0].f);
    return inside.length ? [`unidentified_bins_inside_band:${inside.length}`] : [];
}

/**
 * The phase checks (PHASE_CHECKS) on the unwrapped loop phase `ph`: steps that leave the branch
 * ambiguous, the absolute branch against the plant and controller phases, and the bins around the
 * crossover. Any issue leaves the margins unbounded.
 */
function phaseIssues(pts: LoopPoint[], ph: number[], fc: number): string[] {
    const P = PHASE_CHECKS;
    const out: string[] = [];
    const sigmaDeg = (p: LoopPoint) => ((p.err ?? 0) * 180) / Math.PI;
    const ambiguous: string[] = [];
    for (let i = 1; i < pts.length; i++) {
        const margin = UNCERTAINTY.coverage * (sigmaDeg(pts[i - 1]) + sigmaDeg(pts[i]));
        if (Math.abs(ph[i] - ph[i - 1]) + margin > P.maxUnwrapStepDeg) {
            ambiguous.push(`${pts[i - 1].f.toFixed(1)}-${pts[i].f.toFixed(1)}Hz`);
        }
    }
    if (ambiguous.length) out.push(`phase_unwrap_ambiguous:${ambiguous.slice(0, 3).join(",")}`);
    // The absolute branch: the rate plant's phase at the lowest bin in (−180°, 0°], then the plant and
    // controller phases each unwrapped on their own; their sum must be the unwrapped loop phase.
    if (pts.every((p) => p.G && p.C)) {
        const g = unwrap(pts.map((p) => cphaseDeg(p.G!)));
        const c = unwrap(pts.map((p) => cphaseDeg(p.C!)));
        if (!(g[0] > P.plantPhaseMinDeg && g[0] <= P.plantPhaseMaxDeg)) {
            out.push(`phase_branch_unverified:plant_phase_at_lowest_bin:${g[0].toFixed(0)}deg`);
        } else if (pts.some((_, i) => Math.abs(g[i] + c[i] - ph[i]) > P.maxUnwrapStepDeg)) {
            // Most often the sum is below −180° at the lowest bin: the loop phase was then unwrapped
            // from the wrong branch, and a PM read on it would be off by 360°.
            out.push("phase_branch_unverified:loop_phase_not_plant_plus_controller");
        }
    } else {
        out.push("phase_branch_unverified:plant_and_controller_terms_missing");
    }
    const near = pts.filter((p) => p.f >= fc / Math.SQRT2 && p.f <= fc * Math.SQRT2).length;
    if (near < P.octaveBins) out.push(`crossover_insufficiently_resolved:${near}_bins_in_octave`);
    return out;
}

/** What the bins of one loop show (loopMargins): margins, their basis and the reasons on the way. */
interface LoopRead {
    /** A downward unity crossing was found: PM and the rest were read. */
    ok: boolean;
    fc: number | null;
    pm: number | null;
    /** GM / |S| bounds (null when not bounded) and the values read on the bins. */
    gm: number | null;
    gmRead: number | null;
    gmHz: number | null;
    sPeak: number | null;
    sRead: number | null;
    sPeakHz: number | null;
    /** The bins resolve the loop (LOOP_RESOLUTION) and the band end is bounded (BAND_END). */
    bounded: boolean;
    resolutionHz: number | null;
    bandHz: [number, number] | null;
    reasons: string[];
}

/** PM, GM and |S| on the identified bins of a loop, with the basis they have (unchanged math). */
function readLoop(pts: LoopPoint[]): LoopRead {
    const reasons: string[] = [];
    const read: LoopRead = {
        ok: false,
        fc: null,
        pm: null,
        gm: null,
        gmRead: null,
        gmHz: null,
        sPeak: null,
        sRead: null,
        sPeakHz: null,
        bounded: false,
        resolutionHz: pts.length > 1 ? Math.max(...pts.slice(1).map((p, i) => p.f - pts[i].f)) : null,
        bandHz: pts.length > 1 ? [pts[0].f, pts[pts.length - 1].f] : null,
        reasons,
    };
    if (pts.length < 4) {
        reasons.push("too_few_identified_bins");
        return read;
    }
    const mag = pts.map((p) => cmag(p.L));
    const ph = unwrap(pts.map((p) => cphaseDeg(p.L)));

    // Unity crossings in both directions: a resonance can lift |L| above one again after the
    // first crossover, and every crossing then has its own phase margin.
    const crossings: { i: number; down: boolean }[] = [];
    for (let i = 1; i < pts.length; i++) {
        if (mag[i - 1] >= 1 && mag[i] < 1) crossings.push({ i, down: true });
        else if (mag[i - 1] < 1 && mag[i] >= 1) crossings.push({ i, down: false });
    }
    const lastBin = pts.length - 1;
    if (!crossings.some((c) => c.down)) {
        reasons.push(mag[0] < 1 ? "loop_gain_below_one_in_band" : "crossover_outside_identified_band");
        return read;
    }
    if (crossings.length > 1) reasons.push(`ambiguous_crossovers:${crossings.length}`);
    const at = (c: { i: number }) => {
        const i = c.i;
        const t = (0 - 20 * Math.log10(mag[i - 1])) / (20 * Math.log10(mag[i]) - 20 * Math.log10(mag[i - 1]));
        return { f: pts[i - 1].f + t * (pts[i].f - pts[i - 1].f), pm: 180 + ph[i - 1] + t * (ph[i] - ph[i - 1]) };
    };
    const first = at(crossings.find((c) => c.down)!);
    for (const c of crossings.filter((x) => !x.down)) reasons.push(`loop_gain_reenters_unity:${at(c).f.toFixed(1)}Hz`);
    // Still above unity where the measurement stops: the next crossover lies outside the band.
    if (mag[lastBin] >= 1) reasons.push("loop_gain_above_one_at_band_end");
    const fc = first.f;
    const pm = Math.min(...crossings.map((c) => at(c).pm));
    const lastCrossHz = at(crossings[crossings.length - 1]).f;

    // Between bins the loop is not measured: the bins must be contiguous and resolve it
    // (LOOP_RESOLUTION), or no margin read on them bounds the loop between them.
    const resolution = [
        ...resolutionIssues(
            pts.map((p) => p.f),
            mag.map((m) => 20 * Math.log10(m)),
            ph,
            fc,
        ),
        ...phaseIssues(pts, ph, fc),
    ];
    reasons.push(...resolution);

    // The loop is unknown above the last bin: the band end must be safely below unity and not
    // heading back up (BAND_END), or a crossover just outside the band is not excluded. The tail
    // is the top tailFraction of the band in frequency, whatever the spacing of its bins.
    const tailFrom = pts[lastBin].f - BAND_END.tailFraction * (pts[lastBin].f - pts[0].f);
    const tailStart = Math.min(
        pts.findIndex((p) => p.f >= tailFrom),
        pts.length - BAND_END.minTailBins,
    );
    const tail = pts.slice(tailStart).map((p, j) => ({ f: p.f, db: 20 * Math.log10(mag[tailStart + j]) }));
    const tailRiseDb = lsqRiseDb(tail);
    const tailMaxDb = Math.max(...tail.map((t) => t.db));
    const bandEndDb = 20 * Math.log10(mag[lastBin]);
    const bandEndOk = mag[lastBin] < 1 && tailRiseDb <= BAND_END.maxTailRiseDb && bandEndDb <= BAND_END.maxBandEndDb;
    if (mag[lastBin] < 1 && tailRiseDb > BAND_END.maxTailRiseDb) {
        reasons.push(`loop_gain_rising_at_band_end:+${tailRiseDb.toFixed(1)}dB`);
    }
    if (mag[lastBin] < 1 && bandEndDb > BAND_END.maxBandEndDb) {
        reasons.push(`loop_gain_near_unity_at_band_end:${bandEndDb.toFixed(1)}dB`);
    }

    // Every phase crossover (−180° − k·360° of the unwrapped phase, either direction). `gmRead` is
    // the value read on the bins (interpolated); `gm` the bound: the larger |L| of the two bins
    // around the crossover plus the between-bin allowance (BIN_SAGITTA).
    let gmRead: number | null = null;
    let gm: number | null = null;
    let gmHz: number | null = null;
    const chord = (k: number) => cmag({ re: pts[k].L.re - pts[k - 1].L.re, im: pts[k].L.im - pts[k - 1].L.im });
    for (let k = 1; k < pts.length; k++) {
        const lo = Math.min(ph[k - 1], ph[k]);
        const hi = Math.max(ph[k - 1], ph[k]);
        for (let n = Math.ceil((lo + 180) / 360); n * 360 - 180 <= hi; n++) {
            const target = n * 360 - 180;
            if (ph[k] === ph[k - 1] || target === ph[k - 1]) continue;
            const u = (target - ph[k - 1]) / (ph[k] - ph[k - 1]);
            const m = -20 * Math.log10(mag[k - 1] + u * (mag[k] - mag[k - 1]));
            const bound = -20 * Math.log10(Math.max(mag[k - 1], mag[k]) + BIN_SAGITTA * chord(k));
            if (gmRead === null || m < gmRead) gmRead = m;
            if (gm === null || bound < gm) {
                gm = bound;
                gmHz = pts[k - 1].f + u * (pts[k].f - pts[k - 1].f);
            }
        }
    }
    if (gm === null) reasons.push("phase_crossover_outside_identified_band");
    // The next phase crossover, if it lies above the band, cannot carry more margin than the gain
    // headroom the band end still shows: GM is the worse of the two, and unknown while the band
    // end is not bounded.
    const bounded = bandEndOk && !resolution.length;
    if (gm !== null) {
        if (!bounded) gm = null;
        else if (-tailMaxDb < gm) gm = -tailMaxDb;
    }

    // |S| peak is only meaningful when the band reaches well past the last crossing, the band end
    // is bounded and the peak is not still rising at the band edge; a band-limited value is
    // unknown, not a bound. `sRead` is the peak on the bins; the bound takes the closest approach
    // of every chord between adjacent bins to −1, less the between-bin allowance.
    let sPeak: number | null = null;
    let sPeakHz: number | null = null;
    const sDb = pts.map((p) => 20 * Math.log10(1 / Math.max(cmag(cadd({ re: 1, im: 0 }, p.L)), 1e-12)));
    const peakAt = sDb.indexOf(Math.max(...sDb));
    const sRead = sDb[peakAt];
    if (!(pts[lastBin].f >= 1.5 * lastCrossHz && bandEndOk && peakAt < lastBin)) {
        reasons.push("sensitivity_peak_outside_identified_band");
    } else if (bounded) {
        // An unresolved band (resolution reasons above) leaves |S| unknown: the peak read on the
        // bins is not the peak between them.
        let closest = Infinity;
        for (let k = 1; k < pts.length; k++) {
            const a = { re: pts[k - 1].L.re + 1, im: pts[k - 1].L.im };
            const d = { re: pts[k].L.re - pts[k - 1].L.re, im: pts[k].L.im - pts[k - 1].L.im };
            const dd = d.re * d.re + d.im * d.im;
            const t = dd > 0 ? Math.min(1, Math.max(0, -(a.re * d.re + a.im * d.im) / dd)) : 0;
            const dist = Math.hypot(a.re + t * d.re, a.im + t * d.im) - BIN_SAGITTA * Math.sqrt(dd);
            if (dist < closest) {
                closest = dist;
                sPeakHz = pts[k - 1].f + t * (pts[k].f - pts[k - 1].f);
            }
        }
        sPeak = 20 * Math.log10(1 / Math.max(closest, 1e-12));
    }
    return { ...read, ok: true, fc, pm, gm, gmRead, gmHz, sPeak, sRead, sPeakHz, bounded };
}

/** Reasons of a finer loop that show what the primary bins could not: they contradict its model class. */
const CONTRADICTS_CLASS =
    /^(ambiguous_crossovers|loop_gain_reenters_unity|loop_unresolved_between_bins|identified_band_has_gaps|identified_band_too_coarse|loop_gain_above_one_at_band_end)/;

/**
 * Distance from −1 to the annular sector {ρ e^{jθ} : ρ ∈ [rhoLo, rhoHi], θ ∈ [thLo, thHi]} (radians,
 * unwrapped). −1 sits at angle π + 2πm.
 */
export function sectorDistanceToMinusOne(rhoLo: number, rhoHi: number, thLo: number, thHi: number): number {
    const m = Math.round((thLo + thHi) / 2 / (2 * Math.PI) - 0.5);
    let gap = Infinity;
    for (const k of [m - 1, m, m + 1]) {
        const at = Math.PI + 2 * Math.PI * k;
        gap = Math.min(gap, at < thLo ? thLo - at : at > thHi ? at - thHi : 0);
    }
    if (gap === 0) return 1 < rhoLo ? rhoLo - 1 : 1 > rhoHi ? 1 - rhoHi : 0;
    // Nearest boundary ray, at angle `gap` from −1: the closest point on it within [rhoLo, rhoHi].
    const g = Math.min(gap, Math.PI);
    const t = Math.min(rhoHi, Math.max(rhoLo, Math.cos(g)));
    return Math.sqrt(1 + t * t - 2 * t * Math.cos(g));
}

/** Bounds of a loop with its measurement uncertainty folded in (UNCERTAINTY); `uncertainty` null: unknown. */
interface UncertainBounds {
    pm: number;
    gm: number | null;
    sPeak: number | null;
    uncertainty: MarginUncertainty | null;
    reasons: string[];
}

/**
 * The bounds `read` gives, widened by the measurement uncertainty: the worst of the nominal loop
 * and four corners with every bin's L moved by the same ±k ε in gain and phase. Unknown (null
 * uncertainty, with reasons) when ε is not known, too large, or a corner changes what the bins show.
 */
function uncertainBounds(pts: LoopPoint[], read: LoopRead, u: LoopUncertainty): UncertainBounds {
    const nominal = { pm: read.pm!, gm: read.gm, sPeak: read.sPeak };
    const unknown = (reasons: string[]) => ({ ...nominal, uncertainty: null, reasons });
    if (!u.relErr || pts.some((p) => !Number.isFinite(p.err))) {
        return unknown(u.reasons.length ? u.reasons : ["margin_uncertainty_unknown"]);
    }
    const k = UNCERTAINTY.coverage;
    const maxRelErr = Math.max(...pts.map((p) => p.err!));
    if (k * maxRelErr >= UNCERTAINTY.maxCoverageRelErr) {
        return unknown([`margin_uncertainty_too_large:${(k * maxRelErr).toFixed(3)}`]);
    }
    // Per bin, the true L lies in {L · g · e^{jφ} : |g − 1| ≤ e, |φ| ≤ e} with e = k ε (independent
    // per bin, any sign): inside the disc of radius |L| δ, δ = |(1 + e) e^{je} − 1| (the farthest
    // point of that set), with |L| between |L|(1 − e) and |L|(1 + e) and the phase within ±e.
    // Between two bins the loop stays within the sagitta allowance of the chord between the true
    // endpoints (the resolved model class), so of the measured chord plus both radii.
    const n = pts.length;
    const mag = pts.map((p) => cmag(p.L));
    const ph = unwrap(pts.map((p) => cphaseDeg(p.L)));
    const e = pts.map((p) => k * p.err!);
    const eDeg = e.map((x) => (x * 180) / Math.PI);
    const r = pts.map(
        (_, i) => mag[i] * cmag({ re: (1 + e[i]) * Math.cos(e[i]) - 1, im: (1 + e[i]) * Math.sin(e[i]) }),
    );
    const chord = (i: number) => cmag({ re: pts[i].L.re - pts[i - 1].L.re, im: pts[i].L.im - pts[i - 1].L.im });
    const allowance = (i: number) => BIN_SAGITTA * (chord(i) + r[i - 1] + r[i]) + Math.max(r[i - 1], r[i]);

    // The band end must stay below unity and below the gain-margin target over the whole set.
    if (mag[n - 1] * (1 + e[n - 1]) >= 10 ** (BAND_END.maxBandEndDb / 20)) {
        return unknown(["margin_uncertainty_band_end_not_bounded"]);
    }
    // PM: on every step, the stretch t ∈ [0, 1] where |L| can be at unity (between bins |L| is read
    // in dB along the step, as readLoop does, here for the low and the high end of the set); the
    // phase there, less its ±e. Those steps must form one run (one crossing).
    const db = (x: number) => 20 * Math.log10(x);
    const crossing: { i: number; phase: number }[] = [];
    for (let i = 1; i < n; i++) {
        const up = [db(mag[i - 1] * (1 + e[i - 1])), db(mag[i] * (1 + e[i]))];
        const lo = [db(mag[i - 1] * (1 - e[i - 1])), db(mag[i] * (1 - e[i]))];
        // {t : up(t) ≥ 0 and lo(t) ≤ 0} for two linear functions on [0, 1].
        let t0 = 0;
        let t1 = 1;
        for (const [g, sign] of [
            [up, 1],
            [lo, -1],
        ] as const) {
            const a0 = sign * g[0];
            const a1 = sign * g[1];
            if (a0 < 0 && a1 < 0) t1 = -1;
            else if (a0 < 0) t0 = Math.max(t0, a0 / (a0 - a1));
            else if (a1 < 0) t1 = Math.min(t1, a0 / (a0 - a1));
        }
        if (t0 > t1) continue;
        const at = (t: number) => ph[i - 1] + t * (ph[i] - ph[i - 1]);
        crossing.push({ i, phase: Math.min(at(t0), at(t1)) - Math.max(eDeg[i - 1], eDeg[i]) });
    }
    if (!crossing.length || crossing.some((c, j) => j > 0 && c.i !== crossing[j - 1].i + 1)) {
        return unknown(["margin_uncertainty_changes_what_the_bins_show:unity_crossings"]);
    }
    const pm = Math.min(nominal.pm, ...crossing.map((c) => 180 + c.phase));
    // GM: every step whose phase range (± e) reaches −180° − 360° m, and the tail's headroom.
    let gm = nominal.gm;
    if (gm !== null) {
        let worst = 0;
        for (let i = 1; i < n; i++) {
            const lo = Math.min(ph[i - 1], ph[i]) - Math.max(eDeg[i - 1], eDeg[i]);
            const hi = Math.max(ph[i - 1], ph[i]) + Math.max(eDeg[i - 1], eDeg[i]);
            if (Math.ceil((lo + 180) / 360) * 360 - 180 <= hi) {
                worst = Math.max(worst, Math.max(mag[i - 1] * (1 + e[i - 1]), mag[i] * (1 + e[i])) + allowance(i));
            }
        }
        const tailFrom = pts[n - 1].f - BAND_END.tailFraction * (pts[n - 1].f - pts[0].f);
        for (let i = 0; i < n; i++) if (pts[i].f >= tailFrom) worst = Math.max(worst, mag[i] * (1 + e[i]));
        if (!(worst < 1)) return unknown(["margin_uncertainty_changes_what_the_bins_show:phase_crossover"]);
        gm = Math.min(gm, -20 * Math.log10(worst));
    }
    // |S|: the closest any point of the set (and between the bins) can come to −1. Two lower bounds
    // of that distance per step, the larger kept (both hold): the measured chord less the discs
    // around its ends, and the annular sector that holds both ends' sets and the chord between them
    // (tighter where |L| is large and its disc wide).
    let sPeak = nominal.sPeak;
    if (sPeak !== null) {
        let closest = Infinity;
        const rad = (x: number) => (x * Math.PI) / 180;
        for (let i = 1; i < n; i++) {
            const a = { re: pts[i - 1].L.re + 1, im: pts[i - 1].L.im };
            const d = { re: pts[i].L.re - pts[i - 1].L.re, im: pts[i].L.im - pts[i - 1].L.im };
            const dd = d.re * d.re + d.im * d.im;
            const t = dd > 0 ? Math.min(1, Math.max(0, -(a.re * d.re + a.im * d.im) / dd)) : 0;
            const byDisc = Math.hypot(a.re + t * d.re, a.im + t * d.im) - allowance(i);
            const thLo = Math.min(rad(ph[i - 1]) - e[i - 1], rad(ph[i]) - e[i]);
            const thHi = Math.max(rad(ph[i - 1]) + e[i - 1], rad(ph[i]) + e[i]);
            const span = thHi - thLo;
            const rhoLo =
                span >= Math.PI ? 0 : Math.min(mag[i - 1] * (1 - e[i - 1]), mag[i] * (1 - e[i])) * Math.cos(span / 2);
            const rhoHi = Math.max(mag[i - 1] * (1 + e[i - 1]), mag[i] * (1 + e[i]));
            const bySector =
                sectorDistanceToMinusOne(rhoLo, rhoHi, thLo, thHi) - BIN_SAGITTA * (chord(i) + r[i - 1] + r[i]);
            closest = Math.min(closest, Math.max(byDisc, bySector));
        }
        if (!(closest > 0)) return unknown(["margin_uncertainty_changes_what_the_bins_show:sensitivity"]);
        sPeak = Math.max(sPeak, 20 * Math.log10(1 / closest));
    }
    return {
        pm,
        gm,
        sPeak,
        uncertainty: {
            coverage: k,
            averages: u.averages,
            maxRelErr,
            nominal: { phaseMarginDeg: nominal.pm, gainMarginDb: nominal.gm, sensitivityPeakDb: nominal.sPeak },
        },
        reasons: [],
    };
}

/** Check the primary's bounds against the finer, independent identification (MODEL_CLASS_QUALIFICATION). */
function qualifyModelClass(
    loop: AxisLoop,
    cand: LoopCandidate,
    primary: LoopRead,
    bounds: UncertainBounds,
): ModelClassQualification | null {
    const q = loop.qualification;
    if (!q) return null;
    const finePts = candidateLoop({ ...loop, plant: q.plant, uncertainty: q.uncertainty }, cand);
    const fine = readLoop(finePts);
    const Q = MODEL_CLASS_QUALIFICATION;
    const fail: string[] = [];
    const insufficient: string[] = [];
    const r = primary.resolutionHz;
    if (!fine.ok) insufficient.push("qualification_margins_unavailable", ...fine.reasons);
    // The finer resolution must come from the qualification's own samples (no padded or interpolated bins).
    insufficient.push(...q.provenanceIssues.map((x) => `qualification_resolution_not_shown:${x}`));
    if (!(fine.resolutionHz !== null && r !== null && fine.resolutionHz * RESOLVED_FEATURE_BINS <= r * (1 + 1e-9))) {
        insufficient.push(
            `qualification_not_finer:${fine.resolutionHz?.toFixed(3)}Hz>${r !== null ? (r / RESOLVED_FEATURE_BINS).toFixed(3) : "?"}Hz`,
        );
    }
    if (
        !fine.bandHz ||
        !primary.bandHz ||
        r === null ||
        fine.bandHz[0] > primary.bandHz[0] + r ||
        fine.bandHz[1] < primary.bandHz[1] - r
    ) {
        insufficient.push("qualification_band_not_covered");
    } else if (fine.bandHz[1] < primary.bandHz[1] * QUALIFICATION_BAND_EXTENSION - r) {
        // The same band again does not test the loop above the primary's band end (audit P1-2).
        insufficient.push(
            `qualification_band_not_extended:${fine.bandHz[1].toFixed(1)}<${(primary.bandHz[1] * QUALIFICATION_BAND_EXTENSION).toFixed(1)}Hz`,
        );
    }
    let fb: UncertainBounds | null = null;
    if (fine.ok) {
        fail.push(...fine.reasons.filter((x) => CONTRADICTS_CLASS.test(x)).map((x) => `qualification:${x}`));
        if (!fine.bounded && !fail.length) {
            insufficient.push(...fine.reasons.map((x) => `qualification:${x}`));
        }
        // The qualification's margins carry their own uncertainty, as the primary's do.
        const qLoop = { ...loop, plant: q.plant, uncertainty: q.uncertainty };
        const fineHoles = unidentifiedInsideBand(qLoop, finePts);
        insufficient.push(...fineHoles.map((x) => `qualification:${x}`));
        fb = fine.bounded && !fineHoles.length ? uncertainBounds(finePts, fine, q.uncertainty) : null;
        if (fb && !fb.uncertainty) insufficient.push(...fb.reasons.map((x) => `qualification:${x}`));
        const fpm = fb?.pm ?? fine.pm!;
        const fgm = fb ? fb.gm : fine.gm;
        const fs = fb ? fb.sPeak : fine.sPeak;
        if (fpm < bounds.pm - Q.maxPmDeficitDeg) {
            fail.push(`qualification_pm_below_bound:${fpm.toFixed(1)}<${bounds.pm.toFixed(1)}deg`);
        }
        if (fgm !== null && bounds.gm !== null && fgm < bounds.gm - Q.maxGainDeficitDb) {
            fail.push(`qualification_gm_below_bound:${fgm.toFixed(1)}<${bounds.gm.toFixed(1)}dB`);
        }
        if (fs !== null && bounds.sPeak !== null && fs > bounds.sPeak + Q.maxGainDeficitDb) {
            fail.push(`qualification_s_above_bound:${fs.toFixed(1)}>${bounds.sPeak.toFixed(1)}dB`);
        }
        if ((fgm === null) !== (bounds.gm === null) || (fs === null) !== (bounds.sPeak === null)) {
            insufficient.push("qualification_margins_unavailable");
        }
    }
    return {
        source: { ...q.source },
        resolutionHz: fine.resolutionHz,
        bandHz: fine.bandHz,
        verdict: fail.length ? "FAIL" : insufficient.length ? "INSUFFICIENT" : "PASS",
        phaseMarginDeg: fb?.pm ?? fine.pm,
        gainMarginDb: fb ? fb.gm : fine.gm,
        sensitivityPeakDb: fb ? fb.sPeak : fine.sPeak,
        reasons: [...new Set([...fail, ...insufficient])],
    };
}

const MODEL_CLASS_NEED = "required_measurement:chirp_finer_resolution_model_class_qualification";

export function loopMargins(loop: AxisLoop, cand: LoopCandidate = { cfg: loop.cfg }): LoopMargins {
    const pts = candidateLoop(loop, cand);
    const read = readLoop(pts);
    const reasons = read.reasons;
    const evidence: MarginEvidence = {
        level: "INSUFFICIENT",
        resolutionHz: read.resolutionHz,
        bandHz: read.bandHz,
        minFeatureWidthHz: null,
        assumptions: [],
        qualification: null,
    };
    if (!read.ok) {
        return {
            status: pts.length < 4 ? "UNAVAILABLE" : "NOT_VALIDATED",
            crossoverHz: null,
            phaseMarginDeg: null,
            gainMarginDb: null,
            sensitivityPeakDb: null,
            delayMarginMs: null,
            chainSpreadDeg: null,
            okBins: pts.length,
            evidence,
            measured: { phaseMarginDeg: null, gainMarginDb: null, sensitivityPeakDb: null },
            reasons,
        };
    }
    const fc = read.fc!;
    // The chain model is validated on CHAIN_VALIDATED_BAND_HZ only: a crossover outside it, or a
    // candidate filter change judged above it, is not backed by that validation.
    const [bandLo, bandHi] = CHAIN_VALIDATED_BAND_HZ;
    if (fc < bandLo || fc > bandHi) reasons.push("crossover_outside_chain_validated_band");
    if (cand.chain && loop.chain && [read.gmHz, read.sPeakHz].some((f) => f !== null && f > bandHi)) {
        reasons.push("chain_change_judged_outside_validated_band");
    }
    const spread = loop.chain ? loop.chain.spread(fc).phaseDeg : null;
    if (!loop.chainValidated) reasons.push("chain_model_not_validated_on_this_log");
    if (spread === null) reasons.push("chain_spread_unknown");
    else if (spread > MAX_CHAIN_SPREAD_DEG) reasons.push(`chain_moves_at_crossover:${spread.toFixed(1)}deg`);
    if (!loop.attested) reasons.push("independent_validation_missing");

    // Evidence (MarginEvidence): bins that do not resolve the loop give measured values only; bins
    // that do give bounds under the model class, VALIDATED only once a finer, independent
    // identification qualifies it. A qualification that contradicts the class voids the bounds.
    let pm = read.pm!;
    let gm = read.gm;
    let sPeak = read.sPeak;
    // The measurement uncertainty widens the bounds; unknown uncertainty, or bins left out as
    // unidentified inside the band, leave no bounds.
    const holes = unidentifiedInsideBand(loop, pts);
    reasons.push(...holes);
    const ub = read.bounded && !holes.length ? uncertainBounds(pts, read, loop.uncertainty) : null;
    if (ub && !ub.uncertainty) reasons.push(...ub.reasons);
    if (!read.bounded || !ub?.uncertainty) {
        evidence.level = "MEASURED";
        evidence.assumptions = ["values_read_on_bins_only"];
        // Without a known uncertainty the bins bound nothing: GM and |S| unknown, as for unresolved bins.
        gm = null;
        sPeak = null;
    } else {
        pm = ub.pm;
        gm = ub.gm;
        sPeak = ub.sPeak;
        evidence.uncertainty = { ...ub.uncertainty, droppedBins: binsDroppedForUncertainty(loop).length };
        const width = RESOLVED_FEATURE_BINS * read.resolutionHz!;
        evidence.level = "MODEL_CONDITIONAL";
        evidence.minFeatureWidthHz = width;
        evidence.assumptions = [
            `no_loop_feature_narrower_than:${width.toFixed(2)}Hz`,
            "loop_between_bins_within_bin_sagitta",
            `loop_above_band_end_bounded_by_tail:${read.bandHz![1].toFixed(1)}Hz`,
            "rate_plant_phase_in_minus180_0_at_lowest_bin",
            `measurement_error_within:${UNCERTAINTY.coverage}x_bendat_piersol_random_error`,
        ];
        const q = qualifyModelClass(loop, cand, read, ub);
        evidence.qualification = q;
        if (q?.verdict === "PASS") {
            // The worse of both logs; a value either leaves unknown stays unknown.
            const both = (a: number | null, b: number | null, f: (x: number, y: number) => number) =>
                a === null || b === null ? null : f(a, b);
            pm = both(pm, q.phaseMarginDeg, Math.min) ?? pm;
            gm = both(gm, q.gainMarginDb, Math.min);
            sPeak = both(sPeak, q.sensitivityPeakDb, Math.max);
        }
        const issues = marginEvidenceIssues({ ...evidence, level: "VALIDATED" });
        if (!issues.length) {
            evidence.level = "VALIDATED";
            // What remains unmeasured lies above the qualification's band end, not the primary's.
            evidence.assumptions = evidence.assumptions.map((x) =>
                x.startsWith("loop_above_band_end_bounded_by_tail:")
                    ? `loop_above_band_end_bounded_by_tail:${q!.bandHz![1].toFixed(1)}Hz`
                    : x,
            );
            evidence.assumptions.push(
                `qualified_down_to_feature_width:${(RESOLVED_FEATURE_BINS * q!.resolutionHz!).toFixed(3)}Hz`,
            );
        } else if (q?.verdict === "FAIL") {
            // The finer flight shows what the bins could not: no bounds, and the worse PM.
            evidence.level = "MEASURED";
            evidence.minFeatureWidthHz = null;
            evidence.assumptions = ["values_read_on_bins_only"];
            if (q.phaseMarginDeg !== null) pm = Math.min(pm, q.phaseMarginDeg);
            gm = null;
            sPeak = null;
            reasons.push("model_class_qualification_failed", ...q.reasons, MODEL_CLASS_NEED);
        } else {
            reasons.push("model_class_not_qualified", ...issues, ...(q?.reasons ?? []), MODEL_CLASS_NEED);
        }
    }
    return {
        status: !reasons.length && evidence.level === "VALIDATED" ? "VALIDATED" : "NOT_VALIDATED",
        crossoverHz: fc,
        phaseMarginDeg: pm,
        gainMarginDb: gm,
        sensitivityPeakDb: sPeak,
        delayMarginMs: fc > 0 ? (pm / (360 * fc)) * 1000 : null,
        chainSpreadDeg: spread,
        okBins: pts.length,
        evidence,
        measured: { phaseMarginDeg: read.pm, gainMarginDb: read.gmRead, sensitivityPeakDb: read.sRead },
        reasons,
    };
}
