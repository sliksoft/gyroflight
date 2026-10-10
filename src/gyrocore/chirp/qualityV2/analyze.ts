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
 * Builds the CHIRP Quality V2 report for one CHIRP segment.
 *
 * Spectral values come from Betaflight: the transfer function the gates
 * already use, and computeSpectrogram() framed exactly like that Welch
 * estimate (same window, segment size and hop), whose mean per bin is the
 * Welch input and output power. Everything else is counting and simple
 * statistics on the Viewer's samples. Pure and deterministic.
 */

import { computeSpectrogram, type TransferFunction } from "@/js/blackbox/spectral_analysis";
import type { ChirpAxisName } from "../constants";
import { npMean, npRint } from "../numeric";
import {
    MEAN_COHERENCE_BAND_HZ,
    MIN_MEAN_BAND_COHERENCE,
    MIN_USABLE_BINS,
    USABLE_COHERENCE_MIN,
    type QualityReport,
} from "../quality";
import { SPACING_GAP_FACTOR, type SampleRateEvidence, type TimestampSpacing } from "../sampleRate";
import {
    CHIRP_QUALITY_V2_ANALYSIS_VERSION,
    CHIRP_QUALITY_V2_SCHEMA,
    QV2_REASONS as R,
    type Availability,
    type BinStatus,
    type ChirpQualityV2,
    type CoherenceRegionV2,
    type CoherenceV2,
    type EvidenceLevels,
    type ExcitationV2,
    type Level,
    type Metric,
    type MetricRole,
    type QualityTopic,
    type RelativePowerScaleV2,
    type TopicVerdictV2,
    type SampleGapsV2,
    type SaturationV2,
    type SweepV2,
} from "./contract";

/** Betaflight's input-power floor: below it welchTransferFunction zeroes the bin. */
export const BETAFLIGHT_INPUT_POWER_FLOOR = 1e-20;
/** At most this many gaps are listed; counts always cover all of them. */
export const MAX_LISTED_GAPS = 32;
/**
 * Interpretation guard for the firmware frequency channel, not a quality gate:
 * a channel that falls back on more than 1 % of its steps is not a sweep.
 */
const MAX_FREQUENCY_DECREASE_FRACTION = 0.01;

export interface QualityV2Input {
    measurementId: string;
    logIndex: number;
    chirpIndex: number;
    axisOccurrence: number;
    axis: number;
    axisName: ChirpAxisName;
    startTimeUs: number;
    endTimeUs: number;
    durationS: number;
    /** CHIRP samples of this segment (subarrays, never copies of the log). */
    setpoint: ArrayLike<number>;
    gyro: ArrayLike<number>;
    timeUs: ArrayLike<number>;
    chirpFrequencyDeciHz: ArrayLike<number> | null;
    chirpExcitationMilli: ArrayLike<number> | null;
    motorMax: ArrayLike<number> | null;
    motorMin: ArrayLike<number> | null;
    rate: SampleRateEvidence;
    spacing: TimestampSpacing;
    segmentSize: number | null;
    welchOverlap: number;
    transferFunction: TransferFunction | null;
    quality: QualityReport;
    requestedRangeHz: [number, number] | null;
    requestedDurationS: number | null;
    requestedAmplitude: number | null;
    /** Viewer sysConfig motorOutput [min, max]; null when not logged. */
    motorOutputRange: [number, number] | null;
    firmwareRevision: string | null;
    apiVersion: string | null;
    flagGating: "none" | "flight_mode_flags" | "debug_axis_only";
    highResolutionScale: number;
    qualified: boolean;
    applyAllowed: boolean;
}

function metric<T>(
    availability: Availability,
    value: NoInfer<T> | null,
    unit: string | null,
    reasons: string[] = [],
    role: MetricRole = "DIAGNOSTIC",
): Metric<T> {
    return { availability, role, value: availability === "MEASURED" ? value : null, unit, reasons };
}

function finiteOrNull(v: number): number | null {
    return Number.isFinite(v) ? v : null;
}

function level(status: boolean | null, reasons: string[], role: MetricRole = "DIAGNOSTIC"): Level {
    return { status: status === null ? "UNKNOWN" : status ? "YES" : "NO", role, reasons };
}

function stats(x: ArrayLike<number>) {
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < x.length; i++) {
        sum += x[i];
        peak = Math.max(peak, Math.abs(x[i]));
    }
    const mean = x.length ? sum / x.length : 0;
    let sq = 0;
    for (let i = 0; i < x.length; i++) {
        sq += (x[i] - mean) * (x[i] - mean);
    }
    const meanSquare = x.length ? sq / x.length : 0;
    return { rms: Math.sqrt(meanSquare), meanSquare, peak };
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

interface ObservedSweep {
    sweep: SweepV2["observed"];
    /** The channel in Hz, only when the observed sweep is MEASURED. */
    hz: ArrayLike<number> | null;
}

export function observedSweep(channel: ArrayLike<number> | null, requested: [number, number] | null): ObservedSweep {
    const none = (availability: Availability, reason: string): ObservedSweep => ({
        sweep: {
            availability,
            startHz: null,
            endHz: null,
            minHz: null,
            maxHz: null,
            runs: null,
            reasons: [reason],
        },
        hz: null,
    });
    if (!channel?.length) {
        return none("UNAVAILABLE", R.observedChannelMissing);
    }
    let min = Infinity;
    let max = -Infinity;
    let decreases = 0;
    for (let i = 0; i < channel.length; i++) {
        const v = channel[i];
        if (!Number.isFinite(v) || v < 0) {
            return none("UNKNOWN", R.observedChannelNegative);
        }
        min = Math.min(min, v);
        max = Math.max(max, v);
        if (i > 0 && v < channel[i - 1]) {
            decreases++;
        }
    }
    if (max === min) {
        return none("UNKNOWN", R.observedChannelConstant);
    }
    // One 0.1 Hz count of rounding above the requested end is still the firmware's sweep.
    if (requested && max > requested[1] * 10 + 1) {
        return none("UNKNOWN", R.observedChannelOutOfRange);
    }
    if (decreases > MAX_FREQUENCY_DECREASE_FRACTION * (channel.length - 1)) {
        return none("UNKNOWN", R.observedChannelNotMonotonic);
    }
    const reasons: string[] = [];
    if (decreases) {
        reasons.push(R.observedRestarted);
    }
    if (requested && max < requested[1] * 10 - 1) {
        reasons.push(R.observedBelowRequestedEnd);
    }
    const hz = Float64Array.from(channel, (v) => v / 10);
    return {
        sweep: {
            availability: "MEASURED",
            startHz: hz[0],
            endHz: hz[hz.length - 1],
            minHz: min / 10,
            maxHz: max / 10,
            runs: decreases + 1,
            reasons,
        },
        hz,
    };
}

function sweepReport(inp: QualityV2Input, observed: SweepV2["observed"], bins: BinTable | null): SweepV2 {
    const req = inp.requestedRangeHz;
    const requested: SweepV2["requested"] = {
        availability: req ? "MEASURED" : "UNKNOWN",
        startHz: req?.[0] ?? null,
        endHz: req?.[1] ?? null,
        durationS: inp.requestedDurationS !== null && inp.requestedDurationS > 0 ? inp.requestedDurationS : null,
        amplitude: inp.requestedAmplitude,
        reasons: req ? [] : [R.requestedHeadersMissing],
    };
    const q = inp.quality;
    const usable: SweepV2["usable"] = inp.transferFunction
        ? {
              availability: "MEASURED",
              role: "ACTIVE_GATE",
              startHz: q.usableRangeHz?.[0] ?? null,
              endHz: q.usableRangeHz?.[1] ?? null,
              binCount: q.usableBinCount,
              reasons: q.usableBinCount ? [] : [R.noUsableBins],
          }
        : {
              availability: "UNAVAILABLE",
              role: "ACTIVE_GATE",
              startHz: null,
              endHz: null,
              binCount: null,
              reasons: [R.noTransferFunction],
          };

    let observedOfRequested: Metric<number>;
    if (!req) {
        observedOfRequested = metric("UNKNOWN", null, "fraction", [R.coverageNeedsRequested]);
    } else if (observed.availability !== "MEASURED" || observed.minHz === null || observed.maxHz === null) {
        observedOfRequested = metric("UNKNOWN", null, "fraction", [R.coverageNeedsObserved]);
    } else {
        const overlap = Math.max(0, Math.min(observed.maxHz, req[1]) - Math.max(observed.minHz, req[0]));
        observedOfRequested = metric("MEASURED", overlap / (req[1] - req[0]), "fraction");
    }

    const durationOfRequested: Metric<number> =
        requested.durationS === null
            ? metric("UNKNOWN", null, "fraction", [R.requestedDurationMissing])
            : metric("MEASURED", inp.durationS / requested.durationS, "fraction");

    let usableOfAnalysisBand: Metric<number>;
    if (!bins) {
        usableOfAnalysisBand = metric("UNAVAILABLE", null, "fraction", [R.noTransferFunction]);
    } else {
        const inBand = bins.status.filter((s) => s !== "OUTSIDE_ANALYSIS_BAND").length;
        usableOfAnalysisBand = inBand
            ? metric("MEASURED", q.usableBinCount / inBand, "fraction")
            : metric("UNKNOWN", null, "fraction", [R.noUsableBins]);
    }

    return {
        requested,
        observed,
        usable,
        analysisBandHz: inp.rate.effectiveRateHz ? [q.analysisBandHz[0], q.analysisBandHz[1]] : null,
        observedOfRequested,
        durationOfRequested,
        usableOfAnalysisBand,
    };
}

// ---------------------------------------------------------------------------
// Per-bin coherence and power
// ---------------------------------------------------------------------------

interface BinTable {
    frequencyHz: number[];
    coherence: number[];
    magnitudeDb: (number | null)[];
    inputRelativePowerDb: (number | null)[];
    outputRelativePowerDb: (number | null)[];
    snrDb: (number | null)[];
    status: BinStatus[];
    omitted: number;
    segmentSize: number;
    reasons: string[];
}

/** computeSpectrogram stores 10 log10(|X|^2 + 1e-20) per segment and bin. */
export const SPECTROGRAM_POWER_FLOOR = 1e-20;

/**
 * Relative spectral power per bin in dB: the mean over the Welch segments of
 * Betaflight's spectrogram |X|^2, with its floor removed. That equals the Welch
 * Sxx / numSegments of welchTransferFunction (same Hann window, segment size and
 * hop, no detrend). Null per bin where nothing is left above the floor; null
 * overall when the framing does not match the transfer function.
 */
function relativePowerDb(
    signal: ArrayLike<number>,
    fs: number,
    segmentSize: number,
    overlap: number,
    tf: TransferFunction,
) {
    const sg = computeSpectrogram(signal, fs, segmentSize, overlap);
    if (sg.numSegments !== tf.numSegments || sg.numBins !== tf.frequencies.length) {
        return null;
    }
    const out: (number | null)[] = [];
    for (let k = 0; k < sg.numBins; k++) {
        let sum = 0;
        for (let s = 0; s < sg.numSegments; s++) {
            sum += 10 ** (sg.power[s * sg.numBins + k] / 10);
        }
        const mean = sum / sg.numSegments - SPECTROGRAM_POWER_FLOOR;
        out.push(mean > 0 ? 10 * Math.log10(mean) : null);
    }
    return out;
}

function binTable(inp: QualityV2Input, fs: number, tf: TransferFunction): BinTable {
    // The segment welchTransferFunction actually used (it may clamp the requested one).
    const segmentSize = 2 * (tf.frequencies.length - 1);
    const band = inp.quality.analysisBandHz;
    const nyquist = fs / 2;
    const top = Math.min(Math.max(band[1], inp.requestedRangeHz?.[1] ?? 0), nyquist);
    const reasons: string[] = [];
    const inPow = relativePowerDb(inp.setpoint, fs, segmentSize, inp.welchOverlap, tf);
    const outPow = relativePowerDb(inp.gyro, fs, segmentSize, inp.welchOverlap, tf);
    if (!inPow || !outPow) {
        reasons.push(R.powerSpectrumMismatch);
    }
    const t: BinTable = {
        frequencyHz: [],
        coherence: [],
        magnitudeDb: [],
        inputRelativePowerDb: [],
        outputRelativePowerDb: [],
        snrDb: [],
        status: [],
        omitted: 0,
        segmentSize,
        reasons,
    };
    const f = tf.frequencies;
    for (let k = 0; k < f.length; k++) {
        const fk = f[k];
        // The DC bin and Nyquist are never usable (quality.ts) and carry no sweep.
        if (fk <= 0 || fk >= nyquist) {
            continue;
        }
        if (fk > top) {
            t.omitted++;
            continue;
        }
        const c = tf.coherence[k];
        const mag = finiteOrNull(tf.magnitude[k]);
        let status: BinStatus;
        if (fk < band[0] || fk > band[1]) {
            status = "OUTSIDE_ANALYSIS_BAND";
        } else if (mag === null) {
            status = "NO_INPUT_POWER";
        } else {
            status = c >= USABLE_COHERENCE_MIN ? "USABLE" : "WEAK_COHERENCE";
        }
        t.frequencyHz.push(fk);
        t.coherence.push(c);
        t.magnitudeDb.push(mag);
        t.inputRelativePowerDb.push(mag === null || !inPow ? null : inPow[k]);
        const out = outPow ? outPow[k] : null;
        if (outPow && out === null && !reasons.includes(R.outputPowerAtFloor)) {
            reasons.push(R.outputPowerAtFloor);
        }
        t.outputRelativePowerDb.push(out);
        t.snrDb.push(c > 0 && c < 1 ? 10 * Math.log10(c / (1 - c)) : null);
        t.status.push(status);
    }
    return t;
}

function dbMean(values: (number | null)[]): number | null {
    const finite = values.filter((v): v is number => v !== null);
    if (!finite.length) {
        return null;
    }
    return 10 * Math.log10(npMean(finite.map((v) => 10 ** (v / 10))));
}

export function summarizeRegions(
    t: Pick<BinTable, "frequencyHz" | "coherence" | "inputRelativePowerDb" | "outputRelativePowerDb" | "status">,
) {
    const items: CoherenceRegionV2[] = [];
    let i = 0;
    while (i < t.status.length) {
        let j = i;
        while (j + 1 < t.status.length && t.status[j + 1] === t.status[i]) {
            j++;
        }
        const coh = t.coherence.slice(i, j + 1);
        items.push({
            fromHz: t.frequencyHz[i],
            toHz: t.frequencyHz[j],
            binCount: j - i + 1,
            status: t.status[i],
            meanCoherence: npMean(coh),
            minCoherence: Math.min(...coh),
            maxCoherence: Math.max(...coh),
            meanInputRelativePowerDb: dbMean(t.inputRelativePowerDb.slice(i, j + 1)),
            meanOutputRelativePowerDb: dbMean(t.outputRelativePowerDb.slice(i, j + 1)),
        });
        i = j + 1;
    }
    return items;
}

function powerScale(segmentSize: number | null, numSegments: number | null): RelativePowerScaleV2 {
    return {
        quantity: "RELATIVE_SPECTRAL_POWER",
        isPsd: false,
        definition: "mean_over_welch_segments_of_abs_fft_hann_squared",
        unit: "dB re 1 (signal unit)^2",
        window: "hann (betaflight hanningWindow), unnormalised",
        segmentSize,
        numSegments,
        spectrogramFloorRemoved: SPECTROGRAM_POWER_FLOOR,
    };
}

function coherenceReport(inp: QualityV2Input, bins: BinTable | null, binWidthHz: number | null): CoherenceV2 {
    const q = inp.quality;
    const criteria = {
        usableBinCoherenceMin: USABLE_COHERENCE_MIN,
        meanBandCoherenceMin: MIN_MEAN_BAND_COHERENCE,
        meanBandHz: [MEAN_COHERENCE_BAND_HZ[0], MEAN_COHERENCE_BAND_HZ[1]] as [number, number],
        minUsableBins: MIN_USABLE_BINS,
        inputPowerFloor: BETAFLIGHT_INPUT_POWER_FLOOR,
    };
    if (!bins) {
        const missing = [R.noTransferFunction];
        return {
            meanBandCoherence: metric("UNAVAILABLE", null, "coherence", missing, "ACTIVE_GATE"),
            usableBinCount: metric("UNAVAILABLE", null, "bins", missing, "ACTIVE_GATE"),
            criteria,
            bins: {
                availability: "UNAVAILABLE",
                kind: "MEASURED_BINS",
                binWidthHz: null,
                frequencyHz: [],
                coherence: [],
                magnitudeDb: [],
                inputRelativePowerDb: [],
                outputRelativePowerDb: [],
                powerScale: powerScale(null, null),
                snrDb: [],
                status: [],
                omittedBinCount: 0,
                reasons: missing,
            },
            regions: { kind: "SUMMARY", items: [] },
        };
    }
    return {
        meanBandCoherence:
            q.meanBandCoherence === null
                ? metric("UNKNOWN", null, "coherence", [R.noUsableBins], "ACTIVE_GATE")
                : metric("MEASURED", q.meanBandCoherence, "coherence", [], "ACTIVE_GATE"),
        usableBinCount: metric("MEASURED", q.usableBinCount, "bins", [], "ACTIVE_GATE"),
        criteria,
        bins: {
            availability: "MEASURED",
            kind: "MEASURED_BINS",
            binWidthHz,
            frequencyHz: bins.frequencyHz,
            coherence: bins.coherence,
            magnitudeDb: bins.magnitudeDb,
            inputRelativePowerDb: bins.inputRelativePowerDb,
            outputRelativePowerDb: bins.outputRelativePowerDb,
            powerScale: powerScale(bins.segmentSize, inp.transferFunction?.numSegments ?? null),
            snrDb: bins.snrDb,
            status: bins.status,
            omittedBinCount: bins.omitted,
            reasons: bins.reasons,
        },
        regions: { kind: "SUMMARY", items: summarizeRegions(bins) },
    };
}

// ---------------------------------------------------------------------------
// Excitation
// ---------------------------------------------------------------------------

function excitationReport(inp: QualityV2Input, bins: BinTable | null): ExcitationV2 {
    const sp = stats(inp.setpoint);
    const gy = stats(inp.gyro);
    const unit = "deg/s";
    let firmwareExcitation: ExcitationV2["firmwareExcitation"];
    const ch = inp.chirpExcitationMilli;
    if (!ch?.length) {
        firmwareExcitation = metric("UNAVAILABLE", null, "normalized", [R.excitationChannelMissing]);
    } else {
        const s = stats(ch);
        let min = Infinity;
        let max = -Infinity;
        for (let i = 0; i < ch.length; i++) {
            min = Math.min(min, ch[i]);
            max = Math.max(max, ch[i]);
        }
        if (min === max) {
            firmwareExcitation = metric("UNKNOWN", null, "normalized", [R.excitationChannelConstant]);
        } else if (min < -1000 || max > 1000) {
            // debug[3] is a sine or cosine x 1000 (pid.c); anything wider is another signal.
            firmwareExcitation = metric("UNKNOWN", null, "normalized", [R.excitationChannelOutOfRange]);
        } else {
            firmwareExcitation = metric("MEASURED", { rms: s.rms / 1000, peakAbs: s.peak / 1000 }, "normalized");
        }
    }
    let inputRelativePowerPeakDb: Metric<number>;
    let noInputPowerBins: Metric<number>;
    if (!bins) {
        inputRelativePowerPeakDb = metric("UNAVAILABLE", null, "dB rel", [R.noTransferFunction]);
        noInputPowerBins = metric("UNAVAILABLE", null, "bins", [R.noTransferFunction]);
    } else {
        const inBand = bins.inputRelativePowerDb.filter(
            (v, k): v is number => v !== null && bins.status[k] !== "OUTSIDE_ANALYSIS_BAND",
        );
        inputRelativePowerPeakDb = inBand.length
            ? metric("MEASURED", Math.max(...inBand), "dB rel")
            : metric("UNKNOWN", null, "dB rel", bins.reasons.length ? bins.reasons : [R.noUsableBins]);
        noInputPowerBins = metric("MEASURED", bins.status.filter((s) => s === "NO_INPUT_POWER").length, "bins");
    }
    return {
        setpointRms: metric("MEASURED", inp.quality.inputRms, unit, [], "ACTIVE_GATE"),
        setpointPeakAbs: metric("MEASURED", sp.peak, unit),
        setpointMeanSquare: metric("MEASURED", sp.meanSquare, "(deg/s)^2"),
        setpointEnergy: metric("MEASURED", sp.meanSquare * inp.durationS, "(deg/s)^2*s"),
        gyroRms: metric("MEASURED", gy.rms, unit),
        gyroPeakAbs: metric("MEASURED", gy.peak, unit),
        requestedAmplitude:
            inp.requestedAmplitude === null
                ? metric("UNKNOWN", null, "header", [R.requestedAmplitudeMissing])
                : metric("MEASURED", inp.requestedAmplitude, "header"),
        firmwareExcitation,
        inputRelativePowerPeakDb,
        noInputPowerBins,
    };
}

// ---------------------------------------------------------------------------
// Sample gaps
// ---------------------------------------------------------------------------

function gapReport(inp: QualityV2Input, sweepHz: ArrayLike<number> | null): SampleGapsV2 {
    const s = inp.spacing;
    const fs = inp.rate.effectiveRateHz;
    const expectedDtUs = fs ? 1e6 / fs : null;
    if (s.medianDtUs === null) {
        return {
            status: "UNKNOWN",
            availability: "UNKNOWN",
            role: "ACTIVE_GATE",
            expectedDtUs,
            medianDtUs: null,
            gapCount: null,
            missingSamplesEstimate: null,
            missingFraction: null,
            maxGapSamples: null,
            nonPositiveDeltas: s.nonPositiveDeltas,
            gaps: [],
            gapsTruncated: false,
            reasons: [R.gapsUnknown],
        };
    }
    // Same rule as sampleRate.analyzeTimestampSpacing, here with positions.
    const median = s.medianDtUs;
    const ts = inp.timeUs;
    const gaps: SampleGapsV2["gaps"] = [];
    let found = 0;
    for (let i = 1; i < ts.length; i++) {
        const d = ts[i] - ts[i - 1];
        if (Number.isFinite(d) && d > SPACING_GAP_FACTOR * median) {
            found++;
            if (gaps.length < MAX_LISTED_GAPS) {
                gaps.push({
                    atTimeUs: ts[i - 1],
                    afterSampleIndex: i - 1,
                    gapUs: d,
                    missingSamples: Math.max(npRint(d / median) - 1, 0),
                    sweepFrequencyHz: sweepHz ? sweepHz[i - 1] : null,
                });
            }
        }
    }
    const reasons: string[] = [];
    if (s.gapCount) {
        reasons.push(R.gapsDetected);
    }
    if (s.nonPositiveDeltas) {
        reasons.push(R.timestampsNotIncreasing);
    }
    return {
        status: s.gapCount || s.nonPositiveDeltas ? "DETECTED" : "NONE",
        availability: "MEASURED",
        role: "ACTIVE_GATE",
        expectedDtUs,
        medianDtUs: median,
        gapCount: s.gapCount,
        missingSamplesEstimate: s.missingSamplesEstimate,
        missingFraction: s.missingFraction,
        maxGapSamples: s.maxGapSamples,
        nonPositiveDeltas: s.nonPositiveDeltas,
        gaps,
        gapsTruncated: found > gaps.length,
        reasons,
    };
}

// ---------------------------------------------------------------------------
// Saturation
// ---------------------------------------------------------------------------

function saturationReport(inp: QualityV2Input): SaturationV2 {
    const gyroClipping: SaturationV2["gyroClipping"] = metric("UNKNOWN", null, "samples", [R.gyroClippingUnknown]);
    const unknown = (reason: string): SaturationV2 => ({
        status: "UNKNOWN",
        role: "DIAGNOSTIC",
        motorUpper: metric("UNKNOWN", null, "samples", [reason]),
        motorLower: metric("UNKNOWN", null, "samples", [reason]),
        gyroClipping,
        reasons: [reason, R.gyroClippingUnknown],
    });
    const hi = inp.motorMax;
    const lo = inp.motorMin;
    if (!hi || !lo || !hi.length) {
        return unknown(R.motorFieldsMissing);
    }
    const range = inp.motorOutputRange;
    if (!range || !Number.isFinite(range[0]) || !Number.isFinite(range[1]) || range[1] <= range[0]) {
        return unknown(R.motorRangeUnknown);
    }
    let upper = 0;
    let lower = 0;
    for (let i = 0; i < hi.length; i++) {
        if (!Number.isFinite(hi[i]) || !Number.isFinite(lo[i])) {
            return unknown(R.motorValuesMissing);
        }
        if (hi[i] >= range[1]) {
            upper++;
        }
        if (lo[i] <= range[0]) {
            lower++;
        }
    }
    const n = hi.length;
    const reasons: string[] = [];
    if (upper) {
        reasons.push(R.motorUpperDetected);
    }
    if (lower) {
        reasons.push(R.motorLowerDetected);
    }
    reasons.push(R.saturationMotorsOnly, R.gyroClippingUnknown);
    return {
        status: upper || lower ? "DETECTED" : "NOT_DETECTED",
        role: "DIAGNOSTIC",
        motorUpper: metric("MEASURED", { samples: upper, fraction: upper / n }, "samples"),
        motorLower: metric("MEASURED", { samples: lower, fraction: lower / n }, "samples"),
        gyroClipping,
        reasons,
    };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function levels(inp: QualityV2Input): EvidenceLevels {
    const fs = inp.rate.effectiveRateHz;
    const notAttached = [R.identityNotAttached];
    return {
        bblValid: level(null, notAttached),
        flightValid: level(null, notAttached),
        blackboxDataUsable: level(fs !== null && fs > 0, fs ? [] : [R.noSampleRate]),
        chirpDetected: level(true, []),
        chirpQualityAvailable: level(inp.transferFunction !== null, inp.transferFunction ? [] : [R.noTransferFunction]),
        chirpQualified: level(inp.qualified, inp.qualified ? [] : [R.chirpRejected], "ACTIVE_GATE"),
        tuningAuthorized: tuningAuthorizedLevel(inp.applyAllowed),
    };
}

/** The per-measurement Apply verdict, always labelled with its scope. */
export function tuningAuthorizedLevel(allowed: boolean): Level {
    return level(allowed, allowed ? [R.authorizationScope] : [R.tuningBlocked, R.authorizationScope], "ACTIVE_GATE");
}

/** Gates whose rule is value <= threshold; every other mapped gate is value >= threshold. */
const MAX_GATES = new Set(["excessive_gaps", "timestamp_gaps_present"]);

/** Existing quality.ts gates per card topic. A topic without gates is never judged. */
const TOPIC_GATES: Record<QualityTopic, string[]> = {
    detection: [],
    sweep: ["chirp_band_unknown_default_used", "chirp_band_near_nyquist"],
    coverage: [],
    excitation: ["insufficient_excitation"],
    coherence: ["low_coherence"],
    usableBins: ["unusable_frequency_range"],
    sampleGaps: ["excessive_gaps", "timestamp_gaps_present"],
    contamination: [],
    saturation: [],
};

const notEvaluated = (): TopicVerdictV2 => ({
    verdict: "NOT_EVALUATED",
    basis: "NONE",
    codes: [],
    value: null,
    threshold: null,
    comparator: null,
});

/** The worst existing gate outcome for each topic; NOT_EVALUATED when no gate ran. */
function verdicts(q: QualityReport, saturation: SaturationV2): Record<QualityTopic, TopicVerdictV2> {
    const rank = { PASS: 0, WARNING: 1, FAIL: 2 } as const;
    const out = {} as Record<QualityTopic, TopicVerdictV2>;
    for (const [topic, codes] of Object.entries(TOPIC_GATES) as [QualityTopic, string[]][]) {
        const ran = q.gates.filter((g) => codes.includes(g.code));
        if (!ran.length) {
            out[topic] = notEvaluated();
            continue;
        }
        const graded = ran.map((g) => ({
            g,
            verdict: (g.passed ? "PASS" : g.severity === "blocking" ? "FAIL" : "WARNING") as keyof typeof rank,
        }));
        const worst = graded.reduce((a, b) => (rank[b.verdict] > rank[a.verdict] ? b : a));
        out[topic] = {
            verdict: worst.verdict,
            basis: "EXISTING_GATE",
            codes: [...new Set(ran.map((g) => g.code))],
            value: Number.isFinite(worst.g.value) ? worst.g.value : null,
            threshold: worst.g.threshold,
            comparator: worst.g.threshold === null ? null : MAX_GATES.has(worst.g.code) ? "MAX" : "MIN",
        };
    }
    // Motor saturation has no gate; a detection is a documented diagnostic finding, never a PASS.
    if (saturation.status === "DETECTED") {
        out.saturation = {
            ...notEvaluated(),
            verdict: "WARNING",
            basis: "DOCUMENTED_DIAGNOSTIC",
            codes: saturation.reasons.filter((r) => r.startsWith("saturation_detected:")),
        };
    }
    return out;
}

function collectReasons(r: Omit<ChirpQualityV2, "reasons">): string[] {
    const all: string[] = [];
    const add = (codes: string[]) => all.push(...codes);
    add(r.identity.file.reasons);
    add(r.identity.flight.reasons);
    for (const l of Object.values(r.levels)) {
        add(l.reasons);
    }
    add(r.sweep.requested.reasons);
    add(r.sweep.observed.reasons);
    add(r.sweep.usable.reasons);
    add(r.sweep.observedOfRequested.reasons);
    add(r.sweep.durationOfRequested.reasons);
    add(r.sweep.usableOfAnalysisBand.reasons);
    for (const m of Object.values(r.excitation)) {
        add(m.reasons);
    }
    add(r.coherence.meanBandCoherence.reasons);
    add(r.coherence.usableBinCount.reasons);
    add(r.coherence.bins.reasons);
    add(r.sampleGaps.reasons);
    add(r.contamination.reasons);
    add(r.saturation.reasons);
    return [...new Set(all)];
}

/** The reasons list after identity or levels change (attach, recompute). */
export function refreshReasons(r: ChirpQualityV2): void {
    r.reasons = collectReasons(r);
}

export function buildChirpQualityV2(inp: QualityV2Input): ChirpQualityV2 {
    const fs = inp.rate.effectiveRateHz;
    const tf = inp.transferFunction;
    const bins = tf && fs && inp.segmentSize ? binTable(inp, fs, tf) : null;
    const binWidthHz = tf && tf.frequencies.length > 1 ? tf.frequencies[1] - tf.frequencies[0] : null;
    const { sweep: observed, hz } = observedSweep(inp.chirpFrequencyDeciHz, inp.requestedRangeHz);
    const notAttached = [R.identityNotAttached];
    const saturation = saturationReport(inp);

    const report: Omit<ChirpQualityV2, "reasons"> = {
        schema: CHIRP_QUALITY_V2_SCHEMA,
        analysisVersion: CHIRP_QUALITY_V2_ANALYSIS_VERSION,
        identity: {
            measurementId: inp.measurementId,
            logIndex: inp.logIndex,
            chirpIndex: inp.chirpIndex,
            axisOccurrence: inp.axisOccurrence,
            axis: inp.axis,
            axisName: inp.axisName,
            startTimeUs: inp.startTimeUs,
            endTimeUs: inp.endTimeUs,
            durationS: inp.durationS,
            sampleCount: inp.setpoint.length,
            file: { availability: "UNKNOWN", sha256: null, byteLength: null, reasons: notAttached },
            flight: { availability: "UNKNOWN", ref: null, reasons: notAttached },
        },
        provenance: {
            decoder: "betaflight-blackbox-viewer",
            transferFunction: "betaflight spectral_analysis.welchTransferFunction",
            relativePowerSpectrum: "betaflight spectral_analysis.computeSpectrogram",
            sweepFrequencySource: "firmware DEBUG_CHIRP debug[2] (0.1 Hz)",
            excitationSource: "firmware DEBUG_CHIRP debug[3] (x1000)",
            inputField: `setpoint[${inp.axis}]`,
            outputField: `gyroADC[${inp.axis}]`,
            firmwareRevision: inp.firmwareRevision,
            apiVersion: inp.apiVersion,
            flagGating: inp.flagGating,
            highResolutionScale: inp.highResolutionScale,
            sampleRateHz: fs,
            sampleRateSource: inp.rate.source,
            sampleRateStatus: inp.rate.status,
            segmentSize: inp.segmentSize,
            welchOverlap: inp.welchOverlap,
            welchSegments: tf?.numSegments ?? null,
            binWidthHz,
        },
        levels: levels(inp),
        verdicts: verdicts(inp.quality, saturation),
        sweep: sweepReport(inp, observed, bins),
        excitation: excitationReport(inp, bins),
        coherence: coherenceReport(inp, bins, binWidthHz),
        sampleGaps: gapReport(inp, hz),
        contamination: {
            status: "UNKNOWN",
            availability: "UNKNOWN",
            role: "DIAGNOSTIC",
            reasons: [R.contaminationUnknown],
        },
        saturation,
    };
    return { ...report, reasons: collectReasons(report) };
}
