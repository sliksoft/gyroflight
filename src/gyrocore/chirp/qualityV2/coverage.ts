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
 * WU6-S1 diagnostic measurement coverage and frequency-dependent support.
 * Reaching a frequency is not spectral identification. Never a qualification gate.
 */

import { npMean } from "../numeric";
import { USABLE_COHERENCE_MIN } from "../quality";
import {
    QV2_REASONS as R,
    type Availability,
    type BinStatus,
    type ChirpQualityV2,
    type FrequencyQualityV2,
    type MeasurementCoverageV2,
    type Metric,
    type MissingBandV2,
    type SupportClass,
    type SupportRegionV2,
    type SweepV2,
} from "./contract";

export interface SupportBinInput {
    frequencyHz: number[];
    coherence: number[];
    magnitudeDb: (number | null)[];
    inputRelativePowerDb: (number | null)[];
    status: BinStatus[];
}

function metric<T>(
    availability: Availability,
    value: NoInfer<T> | null,
    unit: string | null,
    reasons: string[] = [],
): Metric<T> {
    return { availability, role: "DIAGNOSTIC", value: availability === "MEASURED" ? value : null, unit, reasons };
}

function dbMean(values: (number | null)[]): number | null {
    const finite = values.filter((v): v is number => v !== null);
    if (!finite.length) {
        return null;
    }
    return 10 * Math.log10(npMean(finite.map((v) => 10 ** (v / 10))));
}

/**
 * Classify one Welch bin. Inside the observed sweep + input above Betaflight's
 * floor is the only path to COHERENT / WEAK_COHERENCE. Residual spectrum beyond
 * the observed end is OUTSIDE_OBSERVED_SWEEP, never support.
 */
export function classifyBinSupport(
    frequencyHz: number,
    status: BinStatus,
    coherence: number,
    magnitudeDb: number | null,
    observed: SweepV2["observed"],
): SupportClass {
    if (status === "OUTSIDE_ANALYSIS_BAND") {
        return "OUTSIDE_ANALYSIS_BAND";
    }
    if (observed.availability !== "MEASURED" || observed.minHz === null || observed.maxHz === null) {
        return "UNKNOWN";
    }
    if (frequencyHz < observed.minHz || frequencyHz > observed.maxHz) {
        return "OUTSIDE_OBSERVED_SWEEP";
    }
    // magnitudeDb null means welchTransferFunction zeroed the bin (no input power).
    if (magnitudeDb === null || status === "NO_INPUT_POWER") {
        return "INSUFFICIENT_SPECTRAL_SUPPORT";
    }
    return coherence >= USABLE_COHERENCE_MIN ? "COHERENT" : "WEAK_COHERENCE";
}

export function summarizeSupportRegions(
    frequencyHz: number[],
    coherence: number[],
    inputRelativePowerDb: (number | null)[],
    supportClass: SupportClass[],
): SupportRegionV2[] {
    const items: SupportRegionV2[] = [];
    let i = 0;
    while (i < supportClass.length) {
        let j = i;
        while (j + 1 < supportClass.length && supportClass[j + 1] === supportClass[i]) {
            j++;
        }
        const coh = coherence.slice(i, j + 1);
        items.push({
            fromHz: frequencyHz[i],
            toHz: frequencyHz[j],
            binCount: j - i + 1,
            supportClass: supportClass[i],
            meanCoherence: npMean(coh),
            minCoherence: Math.min(...coh),
            maxCoherence: Math.max(...coh),
            meanInputRelativePowerDb: dbMean(inputRelativePowerDb.slice(i, j + 1)),
        });
        i = j + 1;
    }
    return items;
}

function missingAnalysisBands(analysisBand: [number, number] | null, observed: SweepV2["observed"]): MissingBandV2[] {
    if (!analysisBand || observed.availability !== "MEASURED" || observed.minHz === null || observed.maxHz === null) {
        return [];
    }
    const [lo, hi] = analysisBand;
    const oLo = Math.max(observed.minHz, lo);
    const oHi = Math.min(observed.maxHz, hi);
    const missing: MissingBandV2[] = [];
    if (oHi <= oLo) {
        // Observed range does not overlap the analysis band at all.
        missing.push({ fromHz: lo, toHz: hi });
        return missing;
    }
    if (oLo > lo) {
        missing.push({ fromHz: lo, toHz: oLo });
    }
    if (oHi < hi) {
        missing.push({ fromHz: oHi, toHz: hi });
    }
    return missing;
}

export function measurementCoverageReport(
    sweep: SweepV2,
    supportClass: SupportClass[] | null,
    binStatus: BinStatus[] | null,
): MeasurementCoverageV2 {
    const reasons: string[] = [R.coverageDiagnosticOnly];
    const observed = sweep.observed;
    const metadataReliable = observed.availability === "MEASURED";
    if (!metadataReliable) {
        reasons.push(R.supportNeedsObserved);
    }

    const analysisBand = sweep.analysisBandHz;
    let sweptOfAnalysisBand: Metric<number>;
    if (!analysisBand) {
        sweptOfAnalysisBand = metric("UNKNOWN", null, "fraction", [R.noSampleRate]);
    } else if (!metadataReliable || observed.minHz === null || observed.maxHz === null) {
        sweptOfAnalysisBand = metric("UNKNOWN", null, "fraction", [R.supportNeedsObserved]);
    } else {
        const width = analysisBand[1] - analysisBand[0];
        const overlap = Math.max(
            0,
            Math.min(observed.maxHz, analysisBand[1]) - Math.max(observed.minHz, analysisBand[0]),
        );
        sweptOfAnalysisBand = metric("MEASURED", width > 0 ? overlap / width : 0, "fraction");
    }

    let spectrallySupportedOfAnalysisBand: Metric<number>;
    if (!supportClass || !binStatus) {
        spectrallySupportedOfAnalysisBand = metric("UNAVAILABLE", null, "fraction", [R.supportNeedsBins]);
    } else if (!metadataReliable) {
        spectrallySupportedOfAnalysisBand = metric("UNKNOWN", null, "fraction", [R.supportNeedsObserved]);
    } else {
        const inBand = supportClass.filter((_, k) => binStatus[k] !== "OUTSIDE_ANALYSIS_BAND");
        const supported = inBand.filter((c) => c === "COHERENT" || c === "WEAK_COHERENCE").length;
        spectrallySupportedOfAnalysisBand = inBand.length
            ? metric("MEASURED", supported / inBand.length, "fraction")
            : metric("UNKNOWN", null, "fraction", [R.supportNoSupportedBins]);
    }

    const observedRangeHz: [number, number] | null =
        metadataReliable && observed.minHz !== null && observed.maxHz !== null
            ? [observed.minHz, observed.maxHz]
            : null;

    return {
        role: "DIAGNOSTIC",
        metadataReliable,
        analysisBandHz: analysisBand,
        requestedRangeHz:
            sweep.requested.startHz !== null && sweep.requested.endHz !== null
                ? [sweep.requested.startHz, sweep.requested.endHz]
                : null,
        observedRangeHz,
        durationOfRequested: { ...sweep.durationOfRequested, role: "DIAGNOSTIC" },
        sweptOfAnalysisBand,
        spectrallySupportedOfAnalysisBand,
        missingAnalysisBand: missingAnalysisBands(analysisBand, observed),
        sweepRestarts: metadataReliable ? observed.runs : null,
        reasons: [...new Set(reasons)],
    };
}

/**
 * Display/normalize helper for stored 2.1.0 reports that lack WU6-S1 sections.
 * Does not mutate the stored object; never invents a PASS.
 */
export function displayQualityV2(v: ChirpQualityV2): ChirpQualityV2 {
    if (v.measurementCoverage && v.frequencyQuality) {
        return v;
    }
    const unavailableFq: FrequencyQualityV2 = {
        role: "DIAGNOSTIC",
        availability: "UNAVAILABLE",
        supportClass: [],
        regions: { kind: "SUMMARY", items: [] },
        meanSupportedCoherence: metric("UNAVAILABLE", null, "coherence", [R.supportNeedsBins]),
        supportedBinCount: metric("UNAVAILABLE", null, "bins", [R.supportNeedsBins]),
        coherentSupportedBinCount: metric("UNAVAILABLE", null, "bins", [R.supportNeedsBins]),
        peakSupportedMagnitude: metric("UNAVAILABLE", null, "dB", [R.supportNeedsBins]),
        reasons: [R.coverageDiagnosticOnly, R.supportNeedsBins],
    };
    const unavailableMc: MeasurementCoverageV2 = {
        role: "DIAGNOSTIC",
        metadataReliable: false,
        analysisBandHz: v.sweep?.analysisBandHz ?? null,
        requestedRangeHz:
            v.sweep?.requested.startHz != null && v.sweep?.requested.endHz != null
                ? [v.sweep.requested.startHz, v.sweep.requested.endHz]
                : null,
        observedRangeHz: null,
        durationOfRequested: v.sweep?.durationOfRequested
            ? { ...v.sweep.durationOfRequested, role: "DIAGNOSTIC" }
            : metric("UNKNOWN", null, "fraction", [R.requestedDurationMissing]),
        sweptOfAnalysisBand: metric("UNKNOWN", null, "fraction", [R.supportNeedsObserved]),
        spectrallySupportedOfAnalysisBand: metric("UNAVAILABLE", null, "fraction", [R.supportNeedsBins]),
        missingAnalysisBand: [],
        sweepRestarts: null,
        reasons: [R.coverageDiagnosticOnly, R.supportNeedsObserved],
    };
    return {
        ...v,
        measurementCoverage: v.measurementCoverage ?? unavailableMc,
        frequencyQuality: v.frequencyQuality ?? unavailableFq,
    };
}

export function frequencyQualityReport(
    bins: SupportBinInput | null,
    observed: SweepV2["observed"],
): FrequencyQualityV2 {
    const baseReasons: string[] = [R.coverageDiagnosticOnly];
    if (!bins) {
        return {
            role: "DIAGNOSTIC",
            availability: "UNAVAILABLE",
            supportClass: [],
            regions: { kind: "SUMMARY", items: [] },
            meanSupportedCoherence: metric("UNAVAILABLE", null, "coherence", [R.supportNeedsBins]),
            supportedBinCount: metric("UNAVAILABLE", null, "bins", [R.supportNeedsBins]),
            coherentSupportedBinCount: metric("UNAVAILABLE", null, "bins", [R.supportNeedsBins]),
            peakSupportedMagnitude: metric("UNAVAILABLE", null, "dB", [R.supportNeedsBins]),
            reasons: [...baseReasons, R.supportNeedsBins],
        };
    }

    const supportClass = bins.frequencyHz.map((f, k) =>
        classifyBinSupport(f, bins.status[k], bins.coherence[k], bins.magnitudeDb[k], observed),
    );

    const reasons: string[] = [...baseReasons];
    if (observed.availability !== "MEASURED") {
        reasons.push(R.supportNeedsObserved);
    }
    if (supportClass.some((c) => c === "OUTSIDE_OBSERVED_SWEEP")) {
        reasons.push(R.supportOutsideObserved);
    }
    if (supportClass.some((c) => c === "INSUFFICIENT_SPECTRAL_SUPPORT")) {
        reasons.push(R.supportInsufficientInput);
    }

    const supportedIdx = supportClass
        .map((c, k) => (c === "COHERENT" || c === "WEAK_COHERENCE" ? k : -1))
        .filter((k) => k >= 0);
    const coherentIdx = supportClass.map((c, k) => (c === "COHERENT" ? k : -1)).filter((k) => k >= 0);

    let meanSupportedCoherence: Metric<number>;
    if (observed.availability !== "MEASURED") {
        meanSupportedCoherence = metric("UNKNOWN", null, "coherence", [R.supportNeedsObserved]);
    } else if (!supportedIdx.length) {
        meanSupportedCoherence = metric("UNKNOWN", null, "coherence", [R.supportNoSupportedBins]);
        reasons.push(R.supportNoSupportedBins);
    } else {
        meanSupportedCoherence = metric("MEASURED", npMean(supportedIdx.map((k) => bins.coherence[k])), "coherence");
    }

    let peakSupportedMagnitude: Metric<{ frequencyHz: number; magnitudeDb: number }>;
    if (observed.availability !== "MEASURED") {
        peakSupportedMagnitude = metric("UNKNOWN", null, "dB", [R.supportNeedsObserved]);
    } else {
        let bestK = -1;
        let bestMag = -Infinity;
        for (const k of supportedIdx) {
            const mag = bins.magnitudeDb[k];
            if (mag !== null && Number.isFinite(mag) && mag > bestMag) {
                bestMag = mag;
                bestK = k;
            }
        }
        peakSupportedMagnitude =
            bestK >= 0
                ? metric("MEASURED", { frequencyHz: bins.frequencyHz[bestK], magnitudeDb: bestMag }, "dB")
                : metric("UNKNOWN", null, "dB", [R.supportNoSupportedBins]);
    }

    return {
        role: "DIAGNOSTIC",
        availability: "MEASURED",
        supportClass,
        regions: {
            kind: "SUMMARY",
            items: summarizeSupportRegions(bins.frequencyHz, bins.coherence, bins.inputRelativePowerDb, supportClass),
        },
        meanSupportedCoherence,
        supportedBinCount:
            observed.availability !== "MEASURED"
                ? metric("UNKNOWN", null, "bins", [R.supportNeedsObserved])
                : metric("MEASURED", supportedIdx.length, "bins"),
        coherentSupportedBinCount:
            observed.availability !== "MEASURED"
                ? metric("UNKNOWN", null, "bins", [R.supportNeedsObserved])
                : metric("MEASURED", coherentIdx.length, "bins"),
        peakSupportedMagnitude,
        reasons: [...new Set(reasons)],
    };
}
