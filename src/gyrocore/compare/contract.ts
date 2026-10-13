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
 * Cross-flight comparison (WU5): the result contract
 * (docs/gyrocore/CROSS_FLIGHT_COMPARISON.md). A diagnostic, read-only view of
 * two stored Flights of one Tune Session. It never authorizes tuning, never
 * claims repeatability and is never stored.
 */

import type { ChirpAxisName } from "../chirp/constants";
import type { MeasurementState } from "../chirp/qualification";
import type { Availability, BinStatus, MetricRole, Verdict } from "../chirp/qualityV2/contract";
import type { MatchStatus } from "../session/contract";
import type { AbPairStatus, AbVerification } from "../session/selection";

/**
 * - INCOMPLETE: no session, or Flight A or B not chosen (WU4).
 * - BLOCKED: WU4 blocks the pair; no measurement of either Flight is compared.
 * - NOT_COMPARABLE: the pair is ELIGIBLE, but no CHIRP pair has a numeric difference.
 * - COMPARED: at least one CHIRP pair has a numeric difference. Diagnostic only.
 */
export type CrossFlightStatus = "INCOMPLETE" | "BLOCKED" | "NOT_COMPARABLE" | "COMPARED";

/**
 * - COMPARED: both CHIRPs qualified, same grid and provenance, configuration not
 *   blocking: per-bin differences exist.
 * - NOT_COMPARABLE: both measurements are shown, with the reasons; no difference.
 * - UNPAIRED: the occurrence exists in one Flight only; shown, never compared.
 */
export type PairStatus = "COMPARED" | "NOT_COMPARABLE" | "UNPAIRED";

export type ConfigCategory = "MEASUREMENT" | "TUNING" | "OTHER";

/** One logged header setting of both Flights, compared verbatim. */
export interface ConfigItem {
    /** The raw `H key` as logged. */
    key: string;
    category: ConfigCategory;
    /** Set when the setting only concerns CHIRPs of one axis (chirp_amplitude_<axis>). */
    axis: ChirpAxisName | null;
    /** The logged value text; null when not logged (or logged with contradicting values). */
    a: string | null;
    b: string | null;
    /** MATCH only when both Flights logged the same text. Nothing is ever filled in from a default. */
    status: MatchStatus;
    /** Why the status is not MATCH; empty for MATCH. */
    reasons: string[];
    /** Whether this item keeps CHIRP pairs (of its axis, or all) from a numeric difference. */
    blocksDifference: boolean;
}

export interface ConfigComparison {
    /** Any MISMATCH, else any UNKNOWN, else MATCH. UNKNOWN is never MATCH. */
    status: MatchStatus;
    items: ConfigItem[];
    /** Problems with the header blocks themselves (not logged, contradicting keys). */
    problems: string[];
}

/** A Quality V2 value of one CHIRP, as stored: never filled in when not MEASURED. */
export interface QualityValue {
    availability: Availability;
    role: MetricRole | null;
    value: number | string | null;
    unit: string | null;
    verdict: Verdict | null;
}

export interface QualityRowComparison {
    /** Stable id: qualification, analysisVersion, meanBandCoherence, usableBins, usableRange, ... */
    id: string;
    a: QualityValue | null;
    b: QualityValue | null;
}

/** One stored CHIRP as the comparison names it. */
export interface ChirpRef {
    measurementId: string;
    axisName: ChirpAxisName;
    axisOccurrence: number;
    qualificationState: MeasurementState;
    analysisVersion: string;
}

/**
 * Per-bin values over the bins whose frequency is identical in both CHIRPs.
 * A difference is null wherever either side is not valid for it; it is never 0
 * by default and never interpolated.
 */
export interface BinComparison {
    frequencyHz: number[];
    magnitudeDbA: (number | null)[];
    magnitudeDbB: (number | null)[];
    /** Flight B − Flight A in dB; only where both bins are USABLE with a finite magnitude. */
    magnitudeDeltaDb: (number | null)[];
    coherenceA: number[];
    coherenceB: number[];
    /** Flight B − Flight A; only where both bins are in the analysis band with input power. */
    coherenceDelta: (number | null)[];
    statusA: BinStatus[];
    statusB: BinStatus[];
    /** Stored bins beyond the shared range (one CHIRP stored a longer range). Never compared. */
    unmatchedBinsA: number;
    unmatchedBinsB: number;
}

/** Facts about one difference series: no tolerance, no score, no verdict. */
export interface DeltaSummary {
    binCount: number;
    fromHz: number | null;
    toHz: number | null;
    min: number | null;
    minAtHz: number | null;
    max: number | null;
    maxAtHz: number | null;
    meanAbs: number | null;
}

export interface ChirpPairComparison {
    /** `<axis>-<occurrence>`, e.g. roll-1. */
    id: string;
    axisName: ChirpAxisName;
    axisOccurrence: number;
    status: PairStatus;
    /** Why there is no numeric difference; empty for COMPARED. */
    reasons: string[];
    /** Facts that limit what the difference says, without blocking it (e.g. different Welch segment counts). */
    notes: string[];
    a: ChirpRef | null;
    b: ChirpRef | null;
    quality: QualityRowComparison[];
    /** Null unless COMPARED. */
    bins: BinComparison | null;
    magnitudeDelta: DeltaSummary | null;
    coherenceDelta: DeltaSummary | null;
}

export interface AxisComparison {
    axisName: ChirpAxisName;
    chirpsA: number;
    chirpsB: number;
    pairs: ChirpPairComparison[];
}

/** What the pair says and does not say. Facts only; no tolerance decides "agrees". */
export interface ComparisonDiagnostics {
    /** Pair ids with a numeric difference. */
    compared: string[];
    /** Pair id with the reasons it has none. */
    notComparable: { id: string; reasons: string[] }[];
    /** Axes measured in neither Flight, or in one only. */
    axesMissing: { axisName: ChirpAxisName; reason: string }[];
    /** Quality V2 limits that apply to every comparison (contamination, gyro clipping, relative power). */
    qualityLimits: string[];
    /** What is missing for a stronger conclusion than this pairwise view. */
    missingForStrongerConclusions: string[];
}

export const REPEATABILITY_NOT_ESTABLISHED = Object.freeze({
    status: "NOT_ESTABLISHED",
    reasons: Object.freeze([
        "pairwise_comparison_only:two_flights",
        "no_validated_acceptance_criteria",
        "real_flight_validation_pending",
    ] as const),
} as const);

export const CROSS_FLIGHT_AUTHORIZATION = Object.freeze({
    status: "NOT_AUTHORIZED",
    reasons: Object.freeze(["cross_flight_comparison_is_not_a_verified_tune", "full_safety_engine_pending"] as const),
} as const);

export interface CrossFlightComparison {
    status: CrossFlightStatus;
    /** WU4's verdict, recomputed for this exact session and selection. */
    abStatus: AbPairStatus;
    /** The selection this result belongs to; a view shows it only while these are still current. */
    sessionId: string | null;
    sessionUpdatedAt: string | null;
    keyA: string | null;
    keyB: string | null;
    /** INCOMPLETE and BLOCKED: why. Otherwise problems of the loaded data (rejected CHIRPs of A or B). */
    blockers: string[];
    /** WU4 missing-evidence codes, plus this module's own. */
    missingEvidence: string[];
    ab: AbVerification;
    /** Null while INCOMPLETE or BLOCKED. */
    config: ConfigComparison | null;
    axes: AxisComparison[];
    diagnostics: ComparisonDiagnostics | null;
    repeatability: typeof REPEATABILITY_NOT_ESTABLISHED;
    authorization: typeof CROSS_FLIGHT_AUTHORIZATION;
}

/** Stable reason codes. Codes are only added; a code's meaning never changes. */
export const CMP_REASONS = {
    abIncomplete: "ab_selection_incomplete",
    abBlocked: "ab_pair_blocked",
    sessionNotLoaded: "session_not_loaded",
    chirpsRejected: "flight_chirps_rejected",
    onlyInA: "chirp_only_in_flight_a",
    onlyInB: "chirp_only_in_flight_b",
    duplicateOccurrence: "axis_occurrence_duplicate",
    identityContradiction: "chirp_identity_contradiction",
    notQualified: "chirp_not_qualified",
    qualityUnavailable: "quality_v2_bins_unavailable",
    binsInvalid: "quality_v2_bins_invalid",
    analysisVersion: "analysis_version_differs",
    provenance: "provenance_differs",
    provenanceUnknown: "provenance_unknown",
    gridMismatch: "frequency_grid_mismatch",
    noSharedBins: "no_shared_valid_bins",
    deltaNotFinite: "delta_not_finite",
    configMismatch: "config_mismatch",
    configUnknown: "config_unknown",
    configHeadersUnavailable: "config_headers_unavailable",
    configContradictory: "config_contradictory",
    configNotLogged: "config_not_logged_in_either_flight",
    configLoggedInOneOnly: "config_logged_in_one_flight_only",
    welchSegmentsDiffer: "welch_segment_count_differs",
    sampleGapsDetected: "sample_gaps_detected",
    saturationDetected: "saturation_detected",
    axisNotMeasured: "axis_not_measured_in_either_flight",
    axisOnlyInOne: "axis_measured_in_one_flight_only",
    relativePowerNotCalibrated: "relative_power_not_cross_flight_calibrated",
    contaminationUnknown: "contamination_unknown:no_validated_detector",
    gyroClippingUnknown: "gyro_clipping_unknown:sensor_range_not_logged",
    externalConditionsUnknown: "external_conditions_not_logged",
    twoFlightsOnly: "more_independent_repeats_needed",
    noAcceptanceCriteria: "no_validated_acceptance_criteria",
    realFlightValidation: "real_flight_validation_pending",
} as const;
