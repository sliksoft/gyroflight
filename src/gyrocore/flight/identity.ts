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
 * File and Flight identity for a blackbox file (docs/gyrocore/FLIGHT_IDENTITY.md).
 *
 * A Flight is one embedded log section, exactly as the Blackbox Viewer splits the
 * file (FlightLogIndex, on the "H Product:" start marker). The Viewer is the only
 * decoder: this module hashes bytes at the Viewer's offsets and asks the Viewer
 * whether each section opens. It decodes nothing itself.
 *
 * The result is plain JSON with no file bytes, so a Tune Session can store it and
 * still recognise the file and its Flights when the BBL is gone.
 */

import { FlightLog } from "@/blackbox-viewer/flightlog.js";
import { FlightLogIndex } from "@/blackbox-viewer/flightlog_index.js";
import { readHeaderPairs } from "@/gyrocore/chirp/headers";
import { sha256Hex } from "./sha256";

export const FLIGHT_IDENTITY_SCHEMA = "gyrocore.flight-identity.v1";

/**
 * Bytes of frame data, right after the header, hashed as the Flight's content
 * fingerprint. They hold the first I-frame (boot time, loop iteration, sensor
 * values), which no other flight repeats, so two copies of one flight match on it
 * even when one copy has extra or missing bytes at its end.
 */
export const BODY_PREFIX_BYTES = 4096;

/** Header lines kept as metadata, verbatim; absent lines are null, never guessed. */
export const IDENTITY_HEADER_KEYS = [
    "Firmware type",
    "Firmware revision",
    "Firmware date",
    "Board information",
    "Craft name",
    "Log start datetime",
] as const;
export type IdentityHeaderKey = (typeof IDENTITY_HEADER_KEYS)[number];

export type BblStatus = "valid" | "invalid";
export type FlightStatus = "valid" | "invalid";

export interface FileIdentity {
    sha256: string;
    byteLength: number;
}

export interface FlightRef {
    schema: typeof FLIGHT_IDENTITY_SCHEMA;
    /** Where the Flight was read: file hash plus 0-based log index. Unique per location, not per flight. */
    locationId: string;
    file: FileIdentity;
    /** 0-based, as FlightLog numbers logs; the Viewer shows it 1-based. */
    logIndex: number;
    logCount: number;
    /** Exact bytes of the log section [byteBegin, byteEnd). Equal hash = the same recorded flight. */
    section: { sha256: string; byteBegin: number; byteEnd: number };
    /** The contiguous `H` header lines at the start of the section. */
    header: { sha256: string; byteLength: number; fields: Record<IdentityHeaderKey, string | null> };
    /** First frame-data bytes after the header (see BODY_PREFIX_BYTES). */
    bodyPrefix: { sha256: string; byteLength: number };
    /** FLIGHT VALID: the Viewer opens this section. */
    status: FlightStatus;
    reasons: string[];
    /** Viewer time range of the section's frames, or null when it has none. */
    timeRangeUs: { min: number; max: number } | null;
}

export interface BblCatalog {
    schema: typeof FLIGHT_IDENTITY_SCHEMA;
    file: FileIdentity;
    /** BBL VALID: at least one log section. Never depends on CHIRP content. */
    status: BblStatus;
    reasons: string[];
    flights: FlightRef[];
}

/** The parts of the Viewer FlightLog/FlightLogIndex used here (untyped upstream JS). */
interface ViewerIndex {
    getLogCount(): number;
    getLogBeginOffset(i: number): number;
}
interface ViewerLog {
    getLogError(i: number): unknown;
    getMinTime(i: number): number | false | undefined;
    getMaxTime(i: number): number | false | undefined;
}

/** End offset of the contiguous `H ` lines starting at `start` (readHeaderPairs' scan). */
function headerEnd(bytes: Uint8Array, start: number, end: number): number {
    let pos = start;
    while (pos + 1 < end && bytes[pos] === 0x48 && bytes[pos + 1] === 0x20) {
        while (pos < end && bytes[pos] !== 0x0a) {
            pos++;
        }
        pos = Math.min(pos + 1, end);
    }
    return pos;
}

function identityFields(bytes: Uint8Array, start: number, end: number): Record<IdentityHeaderKey, string | null> {
    const fields = Object.fromEntries(IDENTITY_HEADER_KEYS.map((k) => [k, null])) as Record<
        IdentityHeaderKey,
        string | null
    >;
    for (const [key, value] of readHeaderPairs(bytes, start, end)) {
        if ((IDENTITY_HEADER_KEYS as readonly string[]).includes(key) && fields[key as IdentityHeaderKey] === null) {
            fields[key as IdentityHeaderKey] = value;
        }
    }
    return fields;
}

function viewerError(log: ViewerLog, i: number): string | null {
    try {
        const err = log.getLogError(i);
        return err ? String(err) : null;
    } catch (err) {
        return String(err instanceof Error ? err.message : err);
    }
}

function timeRange(log: ViewerLog, i: number): { min: number; max: number } | null {
    const min = log.getMinTime(i);
    const max = log.getMaxTime(i);
    return typeof min === "number" && typeof max === "number" && Number.isFinite(min) && Number.isFinite(max)
        ? { min, max }
        : null;
}

/**
 * Identify a blackbox file and every Flight in it. A section the Viewer cannot
 * open is an invalid Flight; it never makes the file or the other Flights invalid.
 */
export async function catalogBbl(bytes: Uint8Array): Promise<BblCatalog> {
    const file: FileIdentity = { sha256: await sha256Hex(bytes), byteLength: bytes.length };
    const index = new FlightLogIndex(bytes) as unknown as ViewerIndex;
    const logCount = index.getLogCount();
    if (logCount === 0) {
        return { schema: FLIGHT_IDENTITY_SCHEMA, file, status: "invalid", reasons: ["no_log_sections"], flights: [] };
    }
    const log = new FlightLog(bytes) as unknown as ViewerLog;
    const flights: FlightRef[] = [];
    for (let i = 0; i < logCount; i++) {
        const byteBegin = index.getLogBeginOffset(i);
        const byteEnd = index.getLogBeginOffset(i + 1);
        const hEnd = headerEnd(bytes, byteBegin, byteEnd);
        const prefixEnd = Math.min(hEnd + BODY_PREFIX_BYTES, byteEnd);
        const error = viewerError(log, i);
        flights.push({
            schema: FLIGHT_IDENTITY_SCHEMA,
            locationId: `${file.sha256}#${i}`,
            file,
            logIndex: i,
            logCount,
            section: { sha256: await sha256Hex(bytes.subarray(byteBegin, byteEnd)), byteBegin, byteEnd },
            header: {
                sha256: await sha256Hex(bytes.subarray(byteBegin, hEnd)),
                byteLength: hEnd - byteBegin,
                fields: identityFields(bytes, byteBegin, byteEnd),
            },
            bodyPrefix: { sha256: await sha256Hex(bytes.subarray(hEnd, prefixEnd)), byteLength: prefixEnd - hEnd },
            status: error ? "invalid" : "valid",
            reasons: error ? [`log_unreadable:${error}`] : [],
            timeRangeUs: error ? null : timeRange(log, i),
        });
    }
    return { schema: FLIGHT_IDENTITY_SCHEMA, file, status: "valid", reasons: [], flights };
}

/**
 * How two Flights relate, from their identities alone:
 * - `same_section`: byte-identical log sections (one flight, possibly in two files);
 * - `same_flight_content`: the first BODY_PREFIX_BYTES of frame data are identical,
 *   whatever the header. That is one recording repackaged: a copy with extra or
 *   missing bytes at the end, or with edited header lines. Both prefixes must be
 *   full length, so a few shared bytes (an empty log's end marker) never match;
 * - `distinct`: no evidence that they are the same flight.
 */
export type FlightRelation = "same_section" | "same_flight_content" | "distinct";

export function relateFlights(a: FlightRef, b: FlightRef): FlightRelation {
    if (a.section.sha256 === b.section.sha256) {
        return "same_section";
    }
    if (
        a.bodyPrefix.byteLength === BODY_PREFIX_BYTES &&
        b.bodyPrefix.byteLength === BODY_PREFIX_BYTES &&
        a.bodyPrefix.sha256 === b.bodyPrefix.sha256
    ) {
        return "same_flight_content";
    }
    return "distinct";
}

export interface IndependenceCheck {
    independent: boolean;
    relation: FlightRelation | null;
    reasons: string[];
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function isSha256(value: unknown): boolean {
    return typeof value === "string" && SHA256_HEX.test(value);
}

function isCount(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Stored references come back from storage, so a reference is checked field by
 * field and for internal consistency against how catalogBbl builds it. Returns
 * the problem codes; empty means usable.
 */
export function flightRefProblems(ref: unknown): string[] {
    if (!ref || typeof ref !== "object") {
        return ["missing"];
    }
    const r = ref as Partial<FlightRef>;
    const problems: string[] = [];
    if (r.schema !== FLIGHT_IDENTITY_SCHEMA) {
        problems.push("schema");
    }
    const fileOk = isSha256(r.file?.sha256) && isCount(r.file?.byteLength) && r.file!.byteLength > 0;
    if (!fileOk) {
        problems.push("file");
    }
    const indexOk = isCount(r.logCount) && r.logCount > 0 && isCount(r.logIndex) && r.logIndex < r.logCount;
    if (!indexOk) {
        problems.push("log_index");
    }
    if (fileOk && indexOk && r.locationId !== `${r.file!.sha256}#${r.logIndex}`) {
        problems.push("location_id");
    }
    const s = r.section;
    const sectionOk =
        isSha256(s?.sha256) &&
        isCount(s?.byteBegin) &&
        isCount(s?.byteEnd) &&
        s!.byteBegin < s!.byteEnd &&
        (!fileOk || s!.byteEnd <= r.file!.byteLength);
    if (!sectionOk) {
        problems.push("section");
    }
    const h = r.header;
    const headerOk =
        isSha256(h?.sha256) &&
        isCount(h?.byteLength) &&
        !!h?.fields &&
        typeof h.fields === "object" &&
        IDENTITY_HEADER_KEYS.every((k) => h.fields[k] === null || typeof h.fields[k] === "string") &&
        (!sectionOk || h!.byteLength <= s!.byteEnd - s!.byteBegin);
    if (!headerOk) {
        problems.push("header");
    }
    const p = r.bodyPrefix;
    const prefixOk =
        isSha256(p?.sha256) &&
        isCount(p?.byteLength) &&
        // catalogBbl always hashes the full prefix the section has room for.
        (!sectionOk ||
            !headerOk ||
            p!.byteLength === Math.min(BODY_PREFIX_BYTES, s!.byteEnd - s!.byteBegin - h!.byteLength));
    if (!prefixOk) {
        problems.push("body_prefix");
    }
    if (
        (r.status !== "valid" && r.status !== "invalid") ||
        !Array.isArray(r.reasons) ||
        !r.reasons.every((x) => typeof x === "string") ||
        (r.status === "invalid" && r.reasons.length === 0)
    ) {
        problems.push("status");
    }
    const t = r.timeRangeUs;
    if (
        t !== null &&
        !(t && Number.isFinite(t.min) && Number.isFinite(t.max) && t.min <= t.max && r.status === "valid")
    ) {
        problems.push("time_range");
    }
    return problems;
}

/**
 * Two references from one file (same file hash) must agree on that file and must
 * not contradict each other: the same log index is the same section, and a later
 * log index starts after an earlier one ends.
 */
function sameFileContradictions(a: FlightRef, b: FlightRef): string[] {
    if (a.file.sha256 !== b.file.sha256) {
        return [];
    }
    if (a.file.byteLength !== b.file.byteLength || a.logCount !== b.logCount) {
        return ["flight_refs_contradict:file"];
    }
    if (a.logIndex === b.logIndex) {
        const same =
            a.section.sha256 === b.section.sha256 &&
            a.section.byteBegin === b.section.byteBegin &&
            a.section.byteEnd === b.section.byteEnd &&
            a.header.sha256 === b.header.sha256 &&
            a.bodyPrefix.sha256 === b.bodyPrefix.sha256;
        return same ? [] : ["flight_refs_contradict:section"];
    }
    const [first, second] = a.logIndex < b.logIndex ? [a, b] : [b, a];
    return first.section.byteEnd <= second.section.byteBegin ? [] : ["flight_refs_contradict:order"];
}

function isValidFlight(ref: FlightRef): boolean {
    return ref.status === "valid" && ref.reasons.length === 0;
}

/**
 * Whether two Flights may count as two independent recordings (Flight A and B).
 * Fail-closed: an incomplete or unknown-schema identity, an invalid Flight, or any
 * evidence that both are the same flight makes them not independent. Two CHIRPs
 * of one Flight share one FlightRef, so they can never pass.
 */
export function checkIndependentFlights(
    a: FlightRef | null | undefined,
    b: FlightRef | null | undefined,
): IndependenceCheck {
    const problemsA = flightRefProblems(a);
    const problemsB = flightRefProblems(b);
    const reasons = [
        ...(problemsA.length
            ? ["flight_a_identity_incomplete", ...problemsA.map((p) => `flight_a_identity:${p}`)]
            : []),
        ...(problemsB.length
            ? ["flight_b_identity_incomplete", ...problemsB.map((p) => `flight_b_identity:${p}`)]
            : []),
    ];
    if (reasons.length) {
        return { independent: false, relation: null, reasons };
    }
    const refA = a as FlightRef;
    const refB = b as FlightRef;
    const contradictions = sameFileContradictions(refA, refB);
    if (contradictions.length) {
        return { independent: false, relation: null, reasons: contradictions };
    }
    if (!isValidFlight(refA)) {
        reasons.push("flight_a_invalid");
    }
    if (!isValidFlight(refB)) {
        reasons.push("flight_b_invalid");
    }
    const relation = relateFlights(refA, refB);
    if (relation === "same_section") {
        reasons.push("same_flight_section");
    } else if (relation === "same_flight_content") {
        reasons.push("same_flight_content");
    }
    return { independent: reasons.length === 0, relation, reasons };
}

/** The Flight of a log index (e.g. a CHIRP measurement's `logIndex`), or null. */
export function flightForLog(catalog: BblCatalog, logIndex: number): FlightRef | null {
    return catalog.flights.find((f) => f.logIndex === logIndex) ?? null;
}
