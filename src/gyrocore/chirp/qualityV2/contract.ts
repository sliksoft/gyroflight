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
 * CHIRP Quality V2: the per-CHIRP quality report (docs/gyrocore/CHIRP_QUALITY_V2.md).
 *
 * Plain JSON with no file bytes, so a Tune Session can store it. Every value
 * says whether it was measured (`availability`) and whether an existing gate
 * already decides with it (`role`). Nothing in this report changes a gate:
 * ACTIVE_GATE values only mirror what `quality.ts` already enforces.
 */

import type { FlightRef } from "@/gyrocore/flight/identity";
import type { ChirpAxisName } from "../constants";

export const CHIRP_QUALITY_V2_SCHEMA = "gyrocore.chirp-quality.v2";
/** Bump when any computed value or rule changes, so stored reports can be told apart. */
export const CHIRP_QUALITY_V2_ANALYSIS_VERSION = "2.0.0";

/**
 * MEASURED: derived from this log's data or headers.
 * UNKNOWN: the data is there, but it does not support a defensible value.
 * UNAVAILABLE: the source is not in the log, or could not be computed.
 * NOT_APPLICABLE: the question does not apply to this measurement.
 */
export type Availability = "MEASURED" | "UNKNOWN" | "UNAVAILABLE" | "NOT_APPLICABLE";

/** ACTIVE_GATE: an existing qualification gate already uses this value. DIAGNOSTIC: shown only, never authorizes. */
export type MetricRole = "DIAGNOSTIC" | "ACTIVE_GATE";

export interface Metric<T> {
    availability: Availability;
    role: MetricRole;
    /** Null unless availability is MEASURED. */
    value: T | null;
    unit: string | null;
    reasons: string[];
}

export type LevelStatus = "YES" | "NO" | "UNKNOWN";

export interface Level {
    status: LevelStatus;
    role: MetricRole;
    reasons: string[];
}

/** The evidence ladder, kept strictly separate: a lower level never implies a higher one. */
export interface EvidenceLevels {
    bblValid: Level;
    flightValid: Level;
    blackboxDataUsable: Level;
    chirpDetected: Level;
    chirpQualityAvailable: Level;
    chirpQualified: Level;
    tuningAuthorized: Level;
}

export interface ChirpIdentityV2 {
    /** "log<N>-seg<M>", as in the qualification report. */
    measurementId: string;
    logIndex: number;
    /** 0-based order of this CHIRP within its Flight. */
    chirpIndex: number;
    /** 1-based count of this axis's CHIRPs within the Flight. */
    axisOccurrence: number;
    axis: number;
    axisName: ChirpAxisName;
    startTimeUs: number;
    endTimeUs: number;
    durationS: number;
    sampleCount: number;
    /** WU1 file identity; UNKNOWN until attachChirpFlightIdentity() has run. */
    file: { availability: Availability; sha256: string | null; byteLength: number | null; reasons: string[] };
    /** WU1 FlightRef of the log section. CHIRPs of one Flight share it, so they are never independent flights. */
    flight: { availability: Availability; ref: FlightRef | null; reasons: string[] };
}

export interface ChirpProvenanceV2 {
    decoder: "betaflight-blackbox-viewer";
    transferFunction: "betaflight spectral_analysis.welchTransferFunction";
    powerSpectrum: "betaflight spectral_analysis.computeSpectrogram";
    sweepFrequencySource: "firmware DEBUG_CHIRP debug[2] (0.1 Hz)";
    excitationSource: "firmware DEBUG_CHIRP debug[3] (x1000)";
    inputField: string;
    outputField: string;
    firmwareRevision: string | null;
    apiVersion: string | null;
    flagGating: "none" | "flight_mode_flags" | "debug_axis_only";
    highResolutionScale: number;
    sampleRateHz: number | null;
    sampleRateSource: string;
    sampleRateStatus: string;
    segmentSize: number | null;
    welchOverlap: number;
    welchSegments: number | null;
    binWidthHz: number | null;
}

export interface SweepV2 {
    requested: {
        availability: Availability;
        startHz: number | null;
        endHz: number | null;
        durationS: number | null;
        /** chirp_amplitude_<axis> header, as logged. */
        amplitude: number | null;
        reasons: string[];
    };
    observed: {
        availability: Availability;
        startHz: number | null;
        endHz: number | null;
        minHz: number | null;
        maxHz: number | null;
        /** Non-decreasing runs of the firmware frequency channel; above 1 the sweep restarted. */
        runs: number | null;
        reasons: string[];
    };
    /** Existing usable range: in-band bins with coherence >= 0.5 above Betaflight's input floor. */
    usable: {
        availability: Availability;
        role: MetricRole;
        startHz: number | null;
        endHz: number | null;
        binCount: number | null;
        reasons: string[];
    };
    /** Existing analysis band (quality.ts analysisBand). */
    analysisBandHz: [number, number] | null;
    /** Overlap of the observed sweep with the requested range, as a fraction of the requested range. */
    observedOfRequested: Metric<number>;
    /** Observed CHIRP duration over chirp_time_seconds. */
    durationOfRequested: Metric<number>;
    /** Usable bins over all bins of the analysis band. */
    usableOfAnalysisBand: Metric<number>;
}

export interface ExcitationV2 {
    /** Setpoint RMS: the existing insufficient_excitation gate. */
    setpointRms: Metric<number>;
    setpointPeakAbs: Metric<number>;
    setpointMeanSquare: Metric<number>;
    setpointEnergy: Metric<number>;
    gyroRms: Metric<number>;
    gyroPeakAbs: Metric<number>;
    requestedAmplitude: Metric<number>;
    /** The firmware's own excitation signal (debug[3] / 1000) during this CHIRP. */
    firmwareExcitation: Metric<{ rms: number; peakAbs: number }>;
    /** Highest in-band input power, dB in Betaflight spectrogram units (relative). */
    inputPowerPeakDb: Metric<number>;
    /** In-band bins below Betaflight's input-power floor (Sxx < 1e-20): no excitation there. */
    noInputPowerBins: Metric<number>;
}

export type BinStatus = "USABLE" | "WEAK_COHERENCE" | "NO_INPUT_POWER" | "OUTSIDE_ANALYSIS_BAND";

/** Parallel arrays, one entry per Betaflight transfer-function bin. Real bins, not summaries. */
export interface CoherenceBinsV2 {
    availability: Availability;
    kind: "MEASURED_BINS";
    binWidthHz: number | null;
    frequencyHz: number[];
    coherence: number[];
    /** Null where Betaflight marks the bin below its input floor (-Infinity). */
    magnitudeDb: (number | null)[];
    inputPowerDb: (number | null)[];
    outputPowerDb: (number | null)[];
    /** Coherent-to-incoherent output power, 10 log10(c / (1 - c)); null where c is 0 or 1. */
    snrDb: (number | null)[];
    status: BinStatus[];
    /** Bins above the stored range (beyond the requested and analysis band). */
    omittedBinCount: number;
    reasons: string[];
}

/** A run of consecutive bins with the same status: a summary of real bins, never an invented range. */
export interface CoherenceRegionV2 {
    fromHz: number;
    toHz: number;
    binCount: number;
    status: BinStatus;
    meanCoherence: number;
    minCoherence: number;
    maxCoherence: number;
    meanInputPowerDb: number | null;
    meanOutputPowerDb: number | null;
}

export interface CoherenceV2 {
    /** Mean coherence over the existing 5–100 Hz window: the existing low_coherence gate. */
    meanBandCoherence: Metric<number>;
    /** In-band bins with coherence >= 0.5: the existing unusable_frequency_range gate. */
    usableBinCount: Metric<number>;
    /** The existing criteria, quoted for the reader; this report never applies new ones. */
    criteria: {
        usableBinCoherenceMin: number;
        meanBandCoherenceMin: number;
        meanBandHz: [number, number];
        minUsableBins: number;
        inputPowerFloor: number;
    };
    bins: CoherenceBinsV2;
    regions: { kind: "SUMMARY"; items: CoherenceRegionV2[] };
}

export type GapStatus = "NONE" | "DETECTED" | "UNKNOWN";

export interface SampleGapV2 {
    /** Time of the last sample before the gap. */
    atTimeUs: number;
    afterSampleIndex: number;
    gapUs: number;
    missingSamples: number;
    /** Sweep frequency at the gap from the firmware channel, when the observed sweep is MEASURED. */
    sweepFrequencyHz: number | null;
}

export interface SampleGapsV2 {
    status: GapStatus;
    availability: Availability;
    role: MetricRole;
    expectedDtUs: number | null;
    medianDtUs: number | null;
    gapCount: number | null;
    missingSamplesEstimate: number | null;
    missingFraction: number | null;
    maxGapSamples: number | null;
    nonPositiveDeltas: number | null;
    gaps: SampleGapV2[];
    gapsTruncated: boolean;
    reasons: string[];
}

export type EvidenceStatus = "DETECTED" | "NOT_DETECTED" | "UNKNOWN";

export interface ContaminationV2 {
    status: EvidenceStatus;
    availability: Availability;
    role: MetricRole;
    reasons: string[];
}

export interface SaturationV2 {
    status: EvidenceStatus;
    role: MetricRole;
    /** CHIRP samples with a motor at or above the logged maximum output. */
    motorUpper: Metric<{ samples: number; fraction: number }>;
    /** CHIRP samples with a motor at or below the logged minimum output. */
    motorLower: Metric<{ samples: number; fraction: number }>;
    gyroClipping: Metric<{ samples: number; fraction: number }>;
    reasons: string[];
}

export interface ChirpQualityV2 {
    schema: typeof CHIRP_QUALITY_V2_SCHEMA;
    analysisVersion: typeof CHIRP_QUALITY_V2_ANALYSIS_VERSION;
    identity: ChirpIdentityV2;
    provenance: ChirpProvenanceV2;
    levels: EvidenceLevels;
    sweep: SweepV2;
    excitation: ExcitationV2;
    coherence: CoherenceV2;
    sampleGaps: SampleGapsV2;
    contamination: ContaminationV2;
    saturation: SaturationV2;
    /** Every reason code in the report, in section order, without duplicates. */
    reasons: string[];
}

/** Stable reason codes. Codes are only ever added; a code's meaning never changes. */
export const QV2_REASONS = {
    identityNotAttached: "identity_unknown:not_attached",
    identityHashUnavailable: "identity_unknown:sha256_unavailable",
    identityLogCountMismatch: "identity_unknown:log_count_mismatch",
    bblInvalid: "bbl_invalid",
    flightInvalid: "flight_invalid",
    noSampleRate: "blackbox_data_unusable:no_sample_rate",
    noTransferFunction: "quality_unavailable:no_transfer_function",
    chirpRejected: "chirp_not_qualified",
    tuningBlocked: "tuning_not_authorized",
    requestedHeadersMissing: "requested_sweep_unknown:headers_missing",
    requestedDurationMissing: "requested_duration_unknown:header_missing",
    requestedAmplitudeMissing: "requested_amplitude_unknown:header_missing",
    observedChannelMissing: "observed_sweep_unavailable:frequency_channel_missing",
    observedChannelConstant: "observed_sweep_unknown:frequency_channel_constant",
    observedChannelNegative: "observed_sweep_unknown:frequency_channel_negative",
    observedChannelOutOfRange: "observed_sweep_unknown:frequency_channel_above_requested",
    observedChannelNotMonotonic: "observed_sweep_unknown:frequency_channel_not_monotonic",
    observedRestarted: "observed_sweep_restarted",
    observedBelowRequestedEnd: "observed_sweep_ended_below_requested",
    coverageNeedsRequested: "coverage_unknown:requested_sweep_unknown",
    coverageNeedsObserved: "coverage_unknown:observed_sweep_unknown",
    noUsableBins: "usable_range_none",
    excitationChannelMissing: "firmware_excitation_unavailable:channel_missing",
    excitationChannelConstant: "firmware_excitation_unknown:channel_constant",
    excitationChannelOutOfRange: "firmware_excitation_unknown:channel_out_of_range",
    powerSpectrumMismatch: "power_spectrum_unavailable:segment_mismatch",
    gapsUnknown: "sample_gaps_unknown:too_few_timestamps",
    gapsDetected: "sample_gaps_detected",
    timestampsNotIncreasing: "timestamps_not_increasing",
    contaminationUnknown: "contamination_unknown:no_validated_detector",
    motorFieldsMissing: "saturation_unknown:motor_fields_missing",
    motorRangeUnknown: "saturation_unknown:motor_output_range_unknown",
    motorValuesMissing: "saturation_unknown:motor_values_missing",
    motorUpperDetected: "saturation_detected:motor_at_maximum",
    motorLowerDetected: "saturation_detected:motor_at_minimum",
    saturationMotorsOnly: "saturation_scope:motor_outputs_only",
    gyroClippingUnknown: "gyro_clipping_unknown:sensor_range_not_logged",
} as const;
