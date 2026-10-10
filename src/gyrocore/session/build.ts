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
 * Building and editing Tune Sessions in memory. Pure functions over plain data;
 * storage.ts persists the result.
 */

import { checkIndependentFlights, flightRefProblems, type FlightRef } from "@/gyrocore/flight/identity";
import type { ChirpMeasurement, ChirpQualificationReport } from "../chirp/qualification";
import { refreshReasons } from "../chirp/qualityV2/analyze";
import { CHIRP_QUALITY_V2_ANALYSIS_VERSION, QV2_REASONS, type ChirpQualityV2 } from "../chirp/qualityV2/contract";
import {
    KNOWN_QUALITY_V2_ANALYSIS_VERSIONS,
    SESSION_AUTHORIZATION,
    SESSION_REASONS as R,
    TUNE_SESSION_SCHEMA,
    TUNE_SESSION_SCHEMA_VERSION,
    type AnalysisVersionStatus,
    type FirmwareIdentity,
    type FlightPairEvidence,
    type MatchStatus,
    type StoredChirp,
    type StoredFlight,
    type TuneSession,
} from "./contract";
import { firmwareInconsistencies, loggedApiVersion, plainJsonProblems } from "./validate";

/** A deep, plain-JSON copy: no typed arrays, no shared references with the analysis. */
function plain<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

/** The Quality V2 report as stored: its per-measurement authorization is never kept. */
export function storedQualityV2(v: ChirpQualityV2): ChirpQualityV2 {
    const copy = plain(v);
    copy.levels.tuningAuthorized = {
        status: "UNKNOWN",
        role: "ACTIVE_GATE",
        reasons: [QV2_REASONS.authorizationNotPersisted, QV2_REASONS.authorizationScope],
    };
    refreshReasons(copy);
    return copy;
}

function storedChirp(m: ChirpMeasurement): StoredChirp {
    return {
        measurementId: m.id,
        logIndex: m.logIndex,
        segmentIndex: m.segmentIndex,
        axis: m.axis,
        axisName: m.axisName,
        axisOccurrence: m.axisOccurrence,
        startTimeUs: m.startTimeUs,
        endTimeUs: m.endTimeUs,
        durationS: m.durationS,
        sampleCount: m.sampleCount,
        qualification: {
            state: m.state,
            failedGates: [...m.quality.failedGates],
            warningGates: [...m.quality.warningGates],
        },
        qualityV2: storedQualityV2(m.qualityV2),
    };
}

export function firmwareIdentity(ref: FlightRef, apiVersion: string | null): FirmwareIdentity {
    const f = ref.header.fields;
    const id = {
        firmwareType: f["Firmware type"],
        firmwareRevision: f["Firmware revision"],
        firmwareDate: f["Firmware date"],
        boardInformation: f["Board information"],
        craftName: f["Craft name"],
        apiVersion,
    };
    return {
        ...id,
        unknown: Object.entries(id)
            .filter(([, v]) => v === null)
            .map(([k]) => k),
    };
}

export interface FlightsFromReport {
    flights: StoredFlight[];
    /** Logs with CHIRPs that cannot be stored, with the reason. */
    skipped: { logIndex: number; reasons: string[] }[];
}

/**
 * One StoredFlight per log of the report that has CHIRP measurements. Needs the
 * WU1 identity attached (attachChirpFlightIdentity); a log without a valid
 * FlightRef is skipped, never stored under a made-up identity.
 */
export function flightsFromReport(
    report: ChirpQualificationReport,
    opts: { fileName: string | null; analyzedAt: string },
): FlightsFromReport {
    const out: FlightsFromReport = { flights: [], skipped: [] };
    const logs = [...new Set(report.measurements.map((m) => m.logIndex))];
    for (const logIndex of logs) {
        const ms = report.measurements.filter((m) => m.logIndex === logIndex);
        const ref = ms[0].qualityV2.identity.flight.ref;
        if (!ref || ms.some((m) => m.qualityV2.identity.flight.ref?.locationId !== ref.locationId)) {
            out.skipped.push({ logIndex, reasons: [R.identityUnknown] });
            continue;
        }
        const problems = flightRefProblems(ref);
        if (problems.length) {
            out.skipped.push({
                logIndex,
                reasons: [R.identityInvalid, ...problems.map((p) => `${R.identityInvalid}:${p}`)],
            });
            continue;
        }
        const log = report.logs.find((l) => l.logIndex === logIndex);
        const logHeaders = log?.headerPairs.length ? plain(log.headerPairs) : null;
        out.flights.push({
            key: ref.locationId,
            ref: plain(ref),
            fileName: opts.fileName,
            addedAt: opts.analyzedAt,
            // The logged API version only: provenance falls back to an assumed version when none is logged.
            firmware: firmwareIdentity(ref, loggedApiVersion(logHeaders)),
            logHeaders,
            analysis: {
                decoder: report.decoder,
                analyzedAt: opts.analyzedAt,
                targetPhaseMarginDeg: report.targetPhaseMarginDeg,
            },
            chirps: ms.map(storedChirp),
        });
    }
    return out;
}

/** Data that cannot go into a session (file bytes, non-finite numbers, non-JSON values). */
export class TuneSessionDataError extends Error {
    constructor(readonly problems: string[]) {
        super(`not storable in a tune session: ${problems.join(", ")}`);
        this.name = "TuneSessionDataError";
    }
}

export function newTuneSession(opts: { id: string; name: string; now: string }): TuneSession {
    return {
        schema: TUNE_SESSION_SCHEMA,
        schemaVersion: TUNE_SESSION_SCHEMA_VERSION,
        id: opts.id,
        name: opts.name,
        createdAt: opts.now,
        updatedAt: opts.now,
        flights: [],
        authorization: plain(SESSION_AUTHORIZATION) as TuneSession["authorization"],
    };
}

export interface AddFlightsResult {
    session: TuneSession;
    added: string[];
    /** Flights already in the session at the same location, replaced by the new analysis. */
    replaced: string[];
    /** Stored, but the same recording as a Flight already in the session (copy or repackaged). */
    notIndependent: { key: string; otherKey: string; reasons: string[] }[];
}

/**
 * Add Flights to a copy of the session. The same location (file and log index)
 * is one Flight: it replaces the earlier entry instead of being counted twice.
 * A copy of a stored Flight from another file is kept, but reported.
 */
export function addFlights(session: TuneSession, flights: StoredFlight[], now: string): AddFlightsResult {
    // Checked before the JSON copy below, which would turn file bytes into an object of numbers.
    const problems = plainJsonProblems([session, flights]);
    if (problems.length) {
        throw new TuneSessionDataError(problems);
    }
    const next = plain(session);
    const result: AddFlightsResult = { session: next, added: [], replaced: [], notIndependent: [] };
    for (const f of flights) {
        const i = next.flights.findIndex((x) => x.key === f.key);
        if (i >= 0) {
            next.flights[i] = plain(f);
            result.replaced.push(f.key);
        } else {
            for (const other of next.flights) {
                const check = checkIndependentFlights(other.ref, f.ref);
                if (!check.independent) {
                    result.notIndependent.push({ key: f.key, otherKey: other.key, reasons: check.reasons });
                }
            }
            next.flights.push(plain(f));
            result.added.push(f.key);
        }
    }
    next.updatedAt = now;
    return result;
}

export function removeFlight(session: TuneSession, key: string, now: string): TuneSession {
    const next = plain(session);
    next.flights = next.flights.filter((f) => f.key !== key);
    next.updatedAt = now;
    return next;
}

export function analysisVersionStatus(version: unknown): AnalysisVersionStatus {
    if (version === CHIRP_QUALITY_V2_ANALYSIS_VERSION) {
        return "CURRENT";
    }
    return (KNOWN_QUALITY_V2_ANALYSIS_VERSIONS as readonly unknown[]).includes(version)
        ? "OUTDATED"
        : "UNKNOWN_VERSION";
}

/** The worst analysis status over a Flight's CHIRPs; UNKNOWN_VERSION without CHIRPs. */
export function flightAnalysisStatus(f: StoredFlight): AnalysisVersionStatus {
    const all = f.chirps.map((c) => analysisVersionStatus(c.qualityV2.analysisVersion));
    if (!all.length || all.includes("UNKNOWN_VERSION")) {
        return "UNKNOWN_VERSION";
    }
    return all.includes("OUTDATED") ? "OUTDATED" : "CURRENT";
}

const FIRMWARE_FIELDS = [
    "firmwareType",
    "firmwareRevision",
    "firmwareDate",
    "boardInformation",
    "craftName",
    "apiVersion",
] as const;

function match(a: string | null, b: string | null): MatchStatus {
    return a === null || b === null ? "UNKNOWN" : a === b ? "MATCH" : "MISMATCH";
}

/**
 * Evidence for using two stored Flights as Flight A and B. Fail-closed: anything
 * not proven the same (firmware, analysis version) blocks, and independence is
 * WU1's checkIndependentFlights on the stored references.
 */
export function flightPairEvidence(session: TuneSession, keyA: string, keyB: string): FlightPairEvidence {
    const a = session.flights.find((f) => f.key === keyA);
    const b = session.flights.find((f) => f.key === keyB);
    const independence = checkIndependentFlights(a?.ref, b?.ref);
    const sa = a ? flightAnalysisStatus(a) : "UNKNOWN_VERSION";
    const sb = b ? flightAnalysisStatus(b) : "UNKNOWN_VERSION";
    const versions = (f: StoredFlight | undefined) => [...new Set(f?.chirps.map((c) => c.qualityV2.analysisVersion))];
    const va = versions(a);
    const vb = versions(b);
    // A missing version is unknown, and unknown never equals unknown.
    const same = va.length === 1 && vb.length === 1 && typeof va[0] === "string" && va[0] === vb[0];
    // A stored field that does not follow from its source (FlightRef header, CHIRP provenance) is UNKNOWN.
    const inconsistentA = a ? firmwareInconsistencies(a) : [];
    const inconsistentB = b ? firmwareInconsistencies(b) : [];
    const firmware = Object.fromEntries(
        FIRMWARE_FIELDS.map((k) => [
            k,
            a && b && !inconsistentA.includes(k) && !inconsistentB.includes(k)
                ? match(a.firmware[k], b.firmware[k])
                : "UNKNOWN",
        ]),
    ) as FlightPairEvidence["firmware"];
    const blockers: string[] = [];
    if (!a) {
        blockers.push(`${R.flightMissing}:a`);
    }
    if (!b) {
        blockers.push(`${R.flightMissing}:b`);
    }
    blockers.push(...independence.reasons);
    for (const [side, s] of [
        ["a", sa],
        ["b", sb],
    ] as const) {
        if (s === "OUTDATED") {
            blockers.push(`${R.analysisOutdated}:${side}`);
        } else if (s === "UNKNOWN_VERSION") {
            blockers.push(`${R.analysisUnknown}:${side}`);
        }
    }
    if (!same) {
        blockers.push(R.analysisDiffers);
    }
    blockers.push(
        ...inconsistentA.map((k) => `${R.firmwareInconsistent}:${k}:a`),
        ...inconsistentB.map((k) => `${R.firmwareInconsistent}:${k}:b`),
    );
    for (const k of FIRMWARE_FIELDS) {
        if (firmware[k] === "MISMATCH") {
            blockers.push(`${R.firmwareMismatch}:${k}`);
        } else if (firmware[k] === "UNKNOWN") {
            blockers.push(`${R.firmwareUnknown}:${k}`);
        }
    }
    return {
        keyA,
        keyB,
        independence,
        analysisVersions: { a: sa, b: sb, same },
        firmware,
        blockers: [...new Set(blockers)],
    };
}
