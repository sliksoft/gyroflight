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
 * Tune Session: the locally stored record of CHIRP results and where they came
 * from (docs/gyrocore/TUNE_SESSION.md). Plain JSON, no file bytes. A stored
 * session is evidence only: it never carries a tuning or Apply authorization.
 */

import type { FlightRef, IndependenceCheck } from "@/gyrocore/flight/identity";
import type { ChirpAxisName } from "../chirp/constants";
import type { MeasurementState } from "../chirp/qualification";
import type { ChirpQualityV2 } from "../chirp/qualityV2/contract";

export const TUNE_SESSION_SCHEMA = "gyrocore.tune-session";
/** Bump with a migration in validate.ts (TUNE_SESSION_MIGRATIONS) whenever the stored shape changes. */
export const TUNE_SESSION_SCHEMA_VERSION = 1;

/** Quality V2 analysis versions this code knows; anything else is UNKNOWN_VERSION. */
export const KNOWN_QUALITY_V2_ANALYSIS_VERSIONS = ["2.0.0", "2.1.0"] as const;

/** Header lines kept as firmware identity (WU1 FlightRef header fields plus the API version). */
export interface FirmwareIdentity {
    firmwareType: string | null;
    firmwareRevision: string | null;
    firmwareDate: string | null;
    boardInformation: string | null;
    craftName: string | null;
    apiVersion: string | null;
    /** The names of the fields above that are null: not logged, never guessed. */
    unknown: string[];
}

export interface StoredChirp {
    measurementId: string;
    logIndex: number;
    segmentIndex: number;
    axis: number;
    axisName: ChirpAxisName;
    axisOccurrence: number;
    startTimeUs: number;
    endTimeUs: number;
    durationS: number;
    sampleCount: number;
    /** The existing qualification outcome at analysis time, under qualityV2.analysisVersion. */
    qualification: { state: MeasurementState; failedGates: string[]; warningGates: string[] };
    /**
     * The Quality V2 report as analysed, except levels.tuningAuthorized: it is
     * stored as UNKNOWN (authorization_unknown:not_persisted), never as a decision.
     */
    qualityV2: ChirpQualityV2;
}

export interface StoredFlight {
    /** The WU1 locationId: one entry per file and log section. */
    key: string;
    ref: FlightRef;
    /** The file name at import; a label only, never part of the identity. */
    fileName: string | null;
    addedAt: string;
    firmware: FirmwareIdentity;
    /** The log's `H key:value` lines as decoded at analysis time; null when not available. */
    logHeaders: [string, string][] | null;
    analysis: {
        decoder: "betaflight-blackbox-viewer";
        analyzedAt: string;
        targetPhaseMarginDeg: number | null;
    };
    chirps: StoredChirp[];
}

/** What every stored session says about authorization: nothing is carried over. */
export const SESSION_AUTHORIZATION = {
    status: "NOT_STORED",
    reasons: ["authorization_not_persisted", "live_fc_recheck_required"],
} as const;

export interface TuneSession {
    schema: typeof TUNE_SESSION_SCHEMA;
    schemaVersion: typeof TUNE_SESSION_SCHEMA_VERSION;
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    flights: StoredFlight[];
    /** A stored session never authorizes tuning or Apply; the FC is re-read before any future Apply. */
    authorization: typeof SESSION_AUTHORIZATION;
}

export type AnalysisVersionStatus = "CURRENT" | "OUTDATED" | "UNKNOWN_VERSION";

export type MatchStatus = "MATCH" | "MISMATCH" | "UNKNOWN";

/** Evidence for a future Flight A/B choice. WU3 records it; selecting and comparing are WU4/WU5. */
export interface FlightPairEvidence {
    keyA: string;
    keyB: string;
    independence: IndependenceCheck;
    /** CURRENT only when every CHIRP of both Flights has the current analysis version. */
    analysisVersions: { a: AnalysisVersionStatus; b: AnalysisVersionStatus; same: boolean };
    firmware: Record<Exclude<keyof FirmwareIdentity, "unknown">, MatchStatus>;
    /** Why the pair may not be treated as a comparable A/B pair; empty only when nothing blocks. */
    blockers: string[];
}

/** A part of a stored session that failed validation and was left out of the loaded session. */
export interface RejectedPart {
    path: string;
    problems: string[];
}

export type LoadResult =
    | {
          status: "ok";
          session: TuneSession;
          /** Flights or CHIRPs left out because they failed validation. */
          rejected: RejectedPart[];
          /** The stored schema version before migration, or null when it was current. */
          migratedFrom: number | null;
      }
    | { status: "corrupt"; id: string; problems: string[] }
    | { status: "unsupported_version"; id: string; schemaVersion: unknown }
    | { status: "not_found"; id: string };

export interface SessionSummary {
    id: string;
    status: "ok" | "corrupt" | "unsupported_version";
    name: string | null;
    updatedAt: string | null;
    flightCount: number | null;
    chirpCount: number | null;
}

/** Stable reason codes of this module. */
export const SESSION_REASONS = {
    identityUnknown: "flight_identity_unknown",
    identityInvalid: "flight_identity_invalid",
    analysisOutdated: "analysis_version_outdated",
    analysisUnknown: "analysis_version_unknown",
    analysisDiffers: "analysis_version_differs",
    firmwareMismatch: "firmware_mismatch",
    firmwareUnknown: "firmware_unknown",
    flightMissing: "flight_not_in_session",
} as const;
