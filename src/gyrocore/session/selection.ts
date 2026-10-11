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
 * Flight A/B selection over a loaded Tune Session (docs/gyrocore/FLIGHT_AB_SELECTOR.md).
 * Pure functions: which stored Flights may be chosen, the selection state, and
 * the A/B verification status, read from WU3 flightPairEvidence (which uses
 * WU1 checkIndependentFlights). Nothing here decides more than that: a pair
 * that passes is input for a later comparison, never a tune or an Apply.
 */

import { AXIS_NAMES, type ChirpAxisName } from "../chirp/constants";
import { PRODUCT_APPLY_PENDING } from "../productLock/productApply";
import { flightAnalysisStatus, flightPairEvidence } from "./build";
import type {
    AnalysisVersionStatus,
    FirmwareIdentity,
    FlightPairEvidence,
    LoadResult,
    MatchStatus,
    RejectedPart,
    StoredFlight,
    TuneSession,
} from "./contract";

export const AB_REASONS = {
    sameFlight: "ab_same_flight_selected",
    flightUnreadable: "flight_unreadable",
    noChirps: "flight_no_valid_chirps",
    flightRejected: "flight_record_rejected",
    selectionNotInSession: "selection_flight_not_in_session",
    selectionNotSelectable: "selection_flight_not_selectable",
    sessionChanged: "selection_session_changed",
} as const;

/** What a valid A/B selection is not: no tune, no repeatability, no Safety release, no Apply. */
export const AB_SELECTION_AUTHORIZATION = Object.freeze({
    status: "NOT_AUTHORIZED",
    reasons: Object.freeze(["ab_selection_is_not_a_verified_tune", PRODUCT_APPLY_PENDING] as const),
} as const);

/** A copy per result, so a caller that edits one result cannot widen the next. */
function notAuthorized(): typeof AB_SELECTION_AUTHORIZATION {
    return { status: AB_SELECTION_AUTHORIZATION.status, reasons: [...AB_SELECTION_AUTHORIZATION.reasons] } as never;
}

/** One stored Flight as the selector shows it. */
export interface FlightOption {
    /** WU1 FlightRef locationId; unique within a session. */
    key: string;
    fileName: string | null;
    /** 1-based, as the Blackbox Viewer numbers logs. */
    logNumber: number;
    logCount: number;
    /** `H Log start datetime` verbatim, or null when not logged. */
    logStart: string | null;
    firmware: FirmwareIdentity;
    chirpCount: number;
    /** CHIRPs of this Flight that failed validation and were left out of the session. */
    rejectedChirpCount: number;
    /** Axes with at least one stored CHIRP, in roll/pitch/yaw order. */
    axes: ChirpAxisName[];
    analysisVersions: string[];
    analysisStatus: AnalysisVersionStatus;
    selectable: boolean;
    /** Why the Flight cannot be chosen; empty when selectable. */
    reasons: string[];
}

/** A stored Flight record that failed validation: shown, never selectable. */
export interface RejectedFlight {
    path: string;
    problems: string[];
}

export interface SessionFlights {
    options: FlightOption[];
    rejected: RejectedFlight[];
}

const FLIGHT_PATH = /^flights\[(\d+)\]$/;
const CHIRP_PATH = /^flights\[(\d+)\]\.chirps\[\d+\]$/;

/**
 * The raw index of each loaded Flight. validateTuneSession keeps Flights in
 * stored order and leaves rejected ones out, so the n-th loaded Flight is the
 * n-th stored index that was not rejected.
 */
function rawIndices(flightCount: number, rejected: RejectedPart[]): number[] {
    const gone = new Set(
        rejected.flatMap((r) => {
            const m = FLIGHT_PATH.exec(r.path);
            return m ? [Number(m[1])] : [];
        }),
    );
    const out: number[] = [];
    for (let i = 0; out.length < flightCount; i++) {
        if (!gone.has(i)) {
            out.push(i);
        }
    }
    return out;
}

function flightOption(f: StoredFlight, rejectedChirps: number): FlightOption {
    const reasons: string[] = [];
    if (f.ref.status !== "valid") {
        reasons.push(AB_REASONS.flightUnreadable, ...f.ref.reasons);
    }
    if (!f.chirps.length) {
        reasons.push(AB_REASONS.noChirps);
    }
    const measured = new Set(f.chirps.map((c) => c.axisName));
    return {
        key: f.key,
        fileName: f.fileName,
        logNumber: f.ref.logIndex + 1,
        logCount: f.ref.logCount,
        logStart: f.ref.header.fields["Log start datetime"],
        firmware: f.firmware,
        chirpCount: f.chirps.length,
        rejectedChirpCount: rejectedChirps,
        axes: AXIS_NAMES.filter((a) => measured.has(a)),
        analysisVersions: [...new Set(f.chirps.map((c) => String(c.qualityV2.analysisVersion)))],
        analysisStatus: flightAnalysisStatus(f),
        selectable: reasons.length === 0,
        reasons,
    };
}

/** The Flights of a loaded session; empty for anything but an `ok` load. */
export function sessionFlights(load: LoadResult | null): SessionFlights {
    if (load?.status !== "ok") {
        return { options: [], rejected: [] };
    }
    const raw = rawIndices(load.session.flights.length, load.rejected);
    const rejectedChirps = new Map<number, number>();
    for (const r of load.rejected) {
        const m = CHIRP_PATH.exec(r.path);
        if (m) {
            rejectedChirps.set(Number(m[1]), (rejectedChirps.get(Number(m[1])) ?? 0) + 1);
        }
    }
    return {
        options: load.session.flights.map((f, i) => flightOption(f, rejectedChirps.get(raw[i]) ?? 0)),
        rejected: load.rejected.filter((r) => FLIGHT_PATH.test(r.path)),
    };
}

/** UI state of the selector. A choice belongs to one session: Session ID plus FlightRef locationId. */
export interface AbSelection {
    sessionId: string | null;
    a: string | null;
    b: string | null;
    /** Why an earlier choice was cleared, for the user; replaced on the next change. */
    cleared: string[];
}

export const EMPTY_SELECTION: AbSelection = { sessionId: null, a: null, b: null, cleared: [] };

export type AbSide = "a" | "b";

/** A selection for another session; any choice for the previous one is dropped. */
export function selectionForSession(prev: AbSelection, sessionId: string | null): AbSelection {
    if (prev.sessionId === sessionId) {
        return prev;
    }
    const hadChoice = prev.a !== null || prev.b !== null;
    return { sessionId, a: null, b: null, cleared: hadChoice ? [AB_REASONS.sessionChanged] : [] };
}

/**
 * Choose one side. Only that side changes. A key that is not a selectable
 * Flight of the selection's own session is refused (the selection is returned unchanged).
 */
export function selectFlight(
    prev: AbSelection,
    sessionId: string | null,
    flights: SessionFlights,
    side: AbSide,
    key: string | null,
): AbSelection {
    if (sessionId === null || prev.sessionId !== sessionId) {
        return prev;
    }
    if (key !== null && !flights.options.some((o) => o.key === key && o.selectable)) {
        return prev;
    }
    return { ...prev, [side]: key, cleared: [] };
}

/**
 * Re-check a selection against the session as loaded now (after a reload, or
 * when the session was changed elsewhere): a chosen Flight that is gone or no
 * longer selectable is cleared, with the reason; the other side is kept.
 */
export function reconcileSelection(prev: AbSelection, sessionId: string, flights: SessionFlights): AbSelection {
    const next = selectionForSession(prev, sessionId);
    const cleared = [...next.cleared];
    const keep = (side: AbSide): string | null => {
        const key = next[side];
        if (key === null) {
            return null;
        }
        const o = flights.options.find((x) => x.key === key);
        if (!o) {
            cleared.push(`${AB_REASONS.selectionNotInSession}:${side}`);
            return null;
        }
        if (!o.selectable) {
            cleared.push(`${AB_REASONS.selectionNotSelectable}:${side}`);
            return null;
        }
        return key;
    };
    const a = keep("a");
    const b = keep("b");
    if (a === next.a && b === next.b && cleared.length === next.cleared.length) {
        return next;
    }
    return { sessionId, a, b, cleared };
}

export type IndependenceStatus = "INDEPENDENT" | "NOT_INDEPENDENT" | "UNKNOWN";

/**
 * - INCOMPLETE: no session, or A or B not chosen.
 * - BLOCKED: both chosen, and at least one reason blocks the pair.
 * - ELIGIBLE: nothing blocks; the pair may be handed to a comparison. Not a verified tune.
 */
export type AbPairStatus = "INCOMPLETE" | "BLOCKED" | "ELIGIBLE";

export interface AbVerification {
    status: AbPairStatus;
    independence: IndependenceStatus;
    analysisVersion: MatchStatus;
    /** The worst firmware field: any MISMATCH, else any UNKNOWN, else MATCH. */
    firmware: MatchStatus;
    firmwareFields: FlightPairEvidence["firmware"] | null;
    /** Reason codes that stand for missing or unprovable data (UNKNOWN), a subset of `blockers`. */
    missingEvidence: string[];
    blockers: string[];
    /** WU3 evidence as computed, for a later comparison to re-check; null until A and B are chosen. */
    evidence: FlightPairEvidence | null;
    authorization: typeof AB_SELECTION_AUTHORIZATION;
}

/** WU1's verdict in three states. UNKNOWN is never INDEPENDENT. */
export function independenceStatus(e: FlightPairEvidence): IndependenceStatus {
    if (e.independence.independent) {
        return "INDEPENDENT";
    }
    const r = e.independence.relation;
    return r === "same_section" || r === "same_flight_content" ? "NOT_INDEPENDENT" : "UNKNOWN";
}

function analysisVersionMatch(session: TuneSession, e: FlightPairEvidence): MatchStatus {
    if (e.analysisVersions.same) {
        return "MATCH";
    }
    const versions = (key: string) => {
        const f = session.flights.find((x) => x.key === key);
        return f ? f.chirps.map((c) => c.qualityV2.analysisVersion as unknown) : [];
    };
    const all = [versions(e.keyA), versions(e.keyB)];
    // Proven different only when both Flights carry versions and every one is a string.
    if (all.every((v) => v.length > 0 && v.every((x) => typeof x === "string"))) {
        return new Set(all.flat()).size > 1 ? "MISMATCH" : "UNKNOWN";
    }
    return "UNKNOWN";
}

function worst(statuses: MatchStatus[]): MatchStatus {
    return statuses.includes("MISMATCH") ? "MISMATCH" : statuses.includes("UNKNOWN") ? "UNKNOWN" : "MATCH";
}

const MISSING_EVIDENCE = [
    /^flight_[ab]_identity/,
    /^flight_refs_contradict/,
    /^flight_not_in_session/,
    /^analysis_version_unknown/,
    /^firmware_unknown/,
    /^firmware_inconsistent/,
];

const incomplete = (): AbVerification => ({
    status: "INCOMPLETE",
    independence: "UNKNOWN",
    analysisVersion: "UNKNOWN",
    firmware: "UNKNOWN",
    firmwareFields: null,
    missingEvidence: [],
    blockers: [],
    evidence: null,
    authorization: notAuthorized(),
});

/**
 * The A/B verification status of a selection. Every verdict comes from
 * flightPairEvidence; this only groups it. ELIGIBLE needs no blocker and every
 * row positive, so an UNKNOWN anywhere can never pass.
 */
export function abVerification(session: TuneSession | null, sel: AbSelection): AbVerification {
    if (!session || sel.sessionId !== session.id || sel.a === null || sel.b === null) {
        return incomplete();
    }
    const evidence = flightPairEvidence(session, sel.a, sel.b);
    const blockers = [...(sel.a === sel.b ? [AB_REASONS.sameFlight] : []), ...evidence.blockers];
    const independence = independenceStatus(evidence);
    const analysisVersion = analysisVersionMatch(session, evidence);
    const firmware = worst(Object.values(evidence.firmware));
    const pass =
        blockers.length === 0 && independence === "INDEPENDENT" && analysisVersion === "MATCH" && firmware === "MATCH";
    return {
        status: pass ? "ELIGIBLE" : "BLOCKED",
        independence,
        analysisVersion,
        firmware,
        firmwareFields: evidence.firmware,
        missingEvidence: blockers.filter((b) => MISSING_EVIDENCE.some((re) => re.test(b))),
        blockers,
        evidence,
        authorization: notAuthorized(),
    };
}
