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
 * Validation of a stored Tune Session, and schema migrations. Everything read
 * from storage is untrusted: it is migrated, then checked field by field.
 * Damage in one Flight or CHIRP leaves that part out; damage to the session
 * itself makes the whole record corrupt. Nothing here repairs data.
 */

import { flightRefProblems } from "@/gyrocore/flight/identity";
import { parseLoggedHeaders } from "../chirp/headers";
import { CHIRP_QUALITY_V2_SCHEMA, QV2_REASONS } from "../chirp/qualityV2/contract";
import { flightRefShape, STORED_QUALITY_V2_SHAPES } from "./shape";
import {
    SESSION_AUTHORIZATION,
    TUNE_SESSION_SCHEMA,
    TUNE_SESSION_SCHEMA_VERSION,
    type RejectedPart,
    type StoredChirp,
    type StoredFlight,
    type TuneSession,
} from "./contract";

/** Largest stored session accepted, as JSON characters. A real session is far smaller. */
export const MAX_SESSION_JSON_CHARS = 16 * 1024 * 1024;
/** Per stored CHIRP and per FlightRef: a Quality V2 report is tens of kB, a FlightRef under 2 kB. */
export const MAX_CHIRP_JSON_CHARS = 1024 * 1024;
export const MAX_FLIGHT_REF_JSON_CHARS = 16 * 1024;
const MAX_LABEL_CHARS = 256;
const MAX_HEADER_LINES = 4096;
const MAX_HEADER_VALUE_CHARS = 4096;

const AXIS_NAMES = ["roll", "pitch", "yaw"];
/**
 * durationS is (endTimeUs - startTimeUs) / 1e6 unrounded (chirp/extraction.ts); the
 * tolerance only absorbs floating-point error, never a different duration.
 */
export const DURATION_TOLERANCE_S = 1e-6;
/** Quality V2 identity field → the stored CHIRP field it must equal. */
const IDENTITY_FIELDS: Record<string, string> = {
    measurementId: "measurementId",
    logIndex: "logIndex",
    chirpIndex: "segmentIndex",
    axis: "axis",
    axisName: "axisName",
    axisOccurrence: "axisOccurrence",
    startTimeUs: "startTimeUs",
    endTimeUs: "endTimeUs",
    durationS: "durationS",
    sampleCount: "sampleCount",
};
/** Stored firmware field → the WU1 FlightRef header line it is copied from (build.ts firmwareIdentity). */
const FIRMWARE_HEADER_FIELDS = {
    firmwareType: "Firmware type",
    firmwareRevision: "Firmware revision",
    firmwareDate: "Firmware date",
    boardInformation: "Board information",
    craftName: "Craft name",
} as const;
const STATES = ["rejected", "usable_with_warnings", "usable"];
const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?Z$/;

type Raw = Record<string, unknown>;

const SESSION_KEYS = ["schema", "schemaVersion", "id", "name", "createdAt", "updatedAt", "flights", "authorization"];
const FLIGHT_KEYS = ["key", "ref", "fileName", "addedAt", "firmware", "logHeaders", "analysis", "chirps"];
const CHIRP_KEYS = [
    "measurementId",
    "logIndex",
    "segmentIndex",
    "axis",
    "axisName",
    "axisOccurrence",
    "startTimeUs",
    "endTimeUs",
    "durationS",
    "sampleCount",
    "qualification",
    "qualityV2",
];

/** Only known fields: anything else (for example stashed file bytes) is not part of a session. */
const onlyKeys = (o: Raw, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));

const isObject = (v: unknown): v is Raw => !!v && typeof v === "object" && !Array.isArray(v);
const isLabel = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= MAX_LABEL_CHARS;
/** ISO 8601 UTC of a real calendar instant: Date.parse would roll 2026-02-30 over to March. */
function isTime(v: unknown): boolean {
    const m = typeof v === "string" ? ISO_TIME.exec(v) : null;
    if (!m) {
        return false;
    }
    const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
    const t = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
    return (
        t.getUTCFullYear() === y &&
        t.getUTCMonth() === mo - 1 &&
        t.getUTCDate() === d &&
        t.getUTCHours() === h &&
        t.getUTCMinutes() === mi &&
        t.getUTCSeconds() === s
    );
}
const isInt = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isFiniteNumber = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const isStringList = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * Problems that make any value unfit for storage: binary data (file bytes
 * never belong in a session), non-finite numbers, or anything JSON cannot hold.
 */
export function plainJsonProblems(value: unknown): string[] {
    const problems = new Set<string>();
    const seen = new Set<unknown>();
    const walk = (v: unknown) => {
        if (v === null || typeof v === "string" || typeof v === "boolean") {
            return;
        }
        if (typeof v === "number") {
            if (!Number.isFinite(v)) {
                problems.add("non_finite_number");
            }
            return;
        }
        if (typeof v !== "object") {
            problems.add("not_json");
            return;
        }
        if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer || (typeof Blob !== "undefined" && v instanceof Blob)) {
            problems.add("binary_data");
            return;
        }
        if (seen.has(v)) {
            problems.add("not_json");
            return;
        }
        seen.add(v);
        if (Array.isArray(v)) {
            v.forEach(walk);
        } else if (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null) {
            Object.values(v).forEach(walk);
        } else {
            problems.add("not_json");
        }
        seen.delete(v);
    };
    walk(value);
    return [...problems];
}

function chirpProblems(c: unknown, flight: Raw): string[] {
    if (!isObject(c)) {
        return ["not_an_object"];
    }
    const p: string[] = onlyKeys(c, CHIRP_KEYS) ? [] : ["unknown_field"];
    if (JSON.stringify(c).length > MAX_CHIRP_JSON_CHARS) {
        p.push("too_large");
    }
    const ref = flight.ref as Raw;
    if (c.logIndex !== ref.logIndex) {
        p.push("log_index");
    }
    if (!isInt(c.segmentIndex) || !isInt(c.axisOccurrence) || !isInt(c.sampleCount)) {
        p.push("indices");
    }
    if (c.measurementId !== `log${(c.logIndex as number) + 1}-seg${(c.segmentIndex as number) + 1}`) {
        p.push("measurement_id");
    }
    if (!(c.axis === 0 || c.axis === 1 || c.axis === 2)) {
        p.push("axis");
    } else if (c.axisName !== AXIS_NAMES[c.axis]) {
        p.push("axis_name");
    }
    if (![c.startTimeUs, c.endTimeUs, c.durationS].every(isFiniteNumber)) {
        p.push("time");
    } else if ((c.startTimeUs as number) >= (c.endTimeUs as number)) {
        p.push("time_order");
    } else if (
        (c.durationS as number) <= 0 ||
        Math.abs((c.durationS as number) - ((c.endTimeUs as number) - (c.startTimeUs as number)) / 1e6) >
            DURATION_TOLERANCE_S
    ) {
        p.push("duration");
    }
    const q = c.qualification as Raw | undefined;
    if (
        !isObject(q) ||
        !onlyKeys(q, ["state", "failedGates", "warningGates"]) ||
        !STATES.includes(q.state as string) ||
        !isStringList(q.failedGates) ||
        !isStringList(q.warningGates)
    ) {
        p.push("qualification");
    }
    const v = c.qualityV2 as Raw | undefined;
    if (!isObject(v) || v.schema !== CHIRP_QUALITY_V2_SCHEMA || typeof v.analysisVersion !== "string") {
        p.push("quality_v2_schema");
        return p;
    }
    const levels = v.levels as Raw | undefined;
    const auth = isObject(levels) ? (levels.tuningAuthorized as Raw | undefined) : undefined;
    // A stored report may never carry an authorization verdict.
    if (
        !isObject(auth) ||
        auth.status !== "UNKNOWN" ||
        !isStringList(auth.reasons) ||
        !(auth.reasons as string[]).includes(QV2_REASONS.authorizationNotPersisted)
    ) {
        p.push("stored_authorization");
    }
    const shape = STORED_QUALITY_V2_SHAPES[v.analysisVersion];
    if (!shape) {
        p.push("quality_v2_version_not_storable");
        return p;
    }
    if (!shape(v)) {
        p.push("quality_v2_shape");
        return p;
    }
    const identity = v.identity as Raw;
    const fileIdentity = identity.file as Raw;
    const flightIdentity = identity.flight as Raw;
    // The report's identity is the CHIRP's own: chirpIndex is the segment index (both seg.index).
    const mismatched = Object.entries(IDENTITY_FIELDS)
        .filter(([q, own]) => identity[q] !== c[own])
        .map(([q]) => `quality_v2_identity:${q}`);
    if (mismatched.length) {
        p.push(...mismatched);
    } else if (
        fileIdentity.sha256 !== (ref.file as Raw).sha256 ||
        fileIdentity.byteLength !== (ref.file as Raw).byteLength ||
        JSON.stringify(flightIdentity.ref) !== JSON.stringify(ref)
    ) {
        p.push("quality_v2_flight");
    }
    // A logged API version is every CHIRP's (provenance takes the logged value first): one log, one header.
    const fwApi = (flight.firmware as Raw | undefined)?.apiVersion ?? null;
    if (fwApi !== null && (v.provenance as Raw).apiVersion !== fwApi) {
        p.push("firmware_api_version");
    }
    return p;
}

/**
 * The firmware API version as logged (`H Firmware API version`), read with the
 * qualification's own header parser. Not logged, or logged as 0.0.0, is null:
 * Quality V2 provenance then holds the analysis fallback, which is no evidence.
 */
export function loggedApiVersion(logHeaders: [string, string][] | null): string | null {
    const v = logHeaders ? parseLoggedHeaders(logHeaders).firmwareApiVersion : null;
    return v && v !== "0.0.0" ? v : null;
}

/** Problems of the firmware block; with `flight` (its ref and headers already valid) also against their sources. */
function firmwareProblems(fw: unknown, flight: Raw | null): string[] {
    if (!isObject(fw)) {
        return ["firmware"];
    }
    const keys = ["firmwareType", "firmwareRevision", "firmwareDate", "boardInformation", "craftName", "apiVersion"];
    const fieldsOk =
        onlyKeys(fw, [...keys, "unknown"]) && keys.every((k) => fw[k] === null || typeof fw[k] === "string");
    const unknownOk =
        isStringList(fw.unknown) &&
        JSON.stringify([...(fw.unknown as string[])].sort()) ===
            JSON.stringify(keys.filter((k) => fw[k] === null).sort());
    if (!fieldsOk || !unknownOk) {
        return ["firmware"];
    }
    if (!flight) {
        return [];
    }
    // Copied from the FlightRef header and the logged API version: equal, null included, or contradictory.
    const fields = (flight.ref as Raw & { header: { fields: Raw } }).header.fields;
    const p = Object.entries(FIRMWARE_HEADER_FIELDS)
        .filter(([k, h]) => fw[k] !== fields[h])
        .map(([k]) => `firmware:${k}`);
    if (fw.apiVersion !== loggedApiVersion(flight.logHeaders as [string, string][] | null)) {
        p.push("firmware:apiVersion");
    }
    return p;
}

/**
 * Stored firmware fields that do not follow from their sources: the FlightRef
 * header lines, and for apiVersion the logged header line, carried by the
 * Quality V2 provenance of every CHIRP (no CHIRP, no MATCH). Such a field is
 * never evidence of a firmware MATCH.
 */
export function firmwareInconsistencies(f: StoredFlight): string[] {
    const out = Object.entries(FIRMWARE_HEADER_FIELDS)
        .filter(([k, h]) => f.firmware[k as keyof typeof FIRMWARE_HEADER_FIELDS] !== f.ref.header.fields[h])
        .map(([k]) => k);
    const api = f.firmware.apiVersion;
    if (
        api !== loggedApiVersion(f.logHeaders) ||
        (api !== null && (!f.chirps.length || f.chirps.some((c) => c.qualityV2.provenance.apiVersion !== api)))
    ) {
        out.push("apiVersion");
    }
    return out;
}

function flightProblems(f: unknown): string[] {
    if (!isObject(f)) {
        return ["not_an_object"];
    }
    const p = flightRefProblems(f.ref).map((x) => `identity:${x}`);
    if (!onlyKeys(f, FLIGHT_KEYS)) {
        p.push("unknown_field");
    }
    if (JSON.stringify(f.ref ?? null).length > MAX_FLIGHT_REF_JSON_CHARS) {
        p.push("identity:too_large");
    } else if (!p.length && !flightRefShape(f.ref)) {
        p.push("identity:shape");
    }
    if (!p.length && f.key !== (f.ref as Raw).locationId) {
        p.push("key");
    }
    if (f.fileName !== null && !isLabel(f.fileName)) {
        p.push("file_name");
    }
    if (!isTime(f.addedAt)) {
        p.push("added_at");
    }
    const h = f.logHeaders;
    if (
        h !== null &&
        !(
            Array.isArray(h) &&
            h.length <= MAX_HEADER_LINES &&
            h.every(
                (x) =>
                    Array.isArray(x) &&
                    x.length === 2 &&
                    x.every((s) => typeof s === "string" && s.length <= MAX_HEADER_VALUE_CHARS),
            )
        )
    ) {
        p.push("log_headers");
    }
    p.push(...firmwareProblems(f.firmware, p.length ? null : (f as Raw)));
    const a = f.analysis as Raw | undefined;
    if (
        !isObject(a) ||
        !onlyKeys(a, ["decoder", "analyzedAt", "targetPhaseMarginDeg"]) ||
        a.decoder !== "betaflight-blackbox-viewer" ||
        !isTime(a.analyzedAt) ||
        !(a.targetPhaseMarginDeg === null || isFiniteNumber(a.targetPhaseMarginDeg))
    ) {
        p.push("analysis");
    }
    if (!Array.isArray(f.chirps)) {
        p.push("chirps");
    }
    return p;
}

export type ValidationResult =
    { ok: true; session: TuneSession; rejected: RejectedPart[] } | { ok: false; problems: string[] };

/**
 * Validate a session at the current schema version. Session-level problems fail
 * the whole record; a damaged Flight or CHIRP is left out and listed in `rejected`.
 */
export function validateTuneSession(raw: unknown): ValidationResult {
    const binary = plainJsonProblems(raw);
    if (binary.length) {
        return { ok: false, problems: binary };
    }
    if (!isObject(raw)) {
        return { ok: false, problems: ["not_an_object"] };
    }
    if (JSON.stringify(raw).length > MAX_SESSION_JSON_CHARS) {
        return { ok: false, problems: ["too_large"] };
    }
    const problems: string[] = onlyKeys(raw, SESSION_KEYS) ? [] : ["unknown_field"];
    if (raw.schema !== TUNE_SESSION_SCHEMA) {
        problems.push("schema");
    }
    if (raw.schemaVersion !== TUNE_SESSION_SCHEMA_VERSION) {
        problems.push("schema_version");
    }
    if (!isLabel(raw.id)) {
        problems.push("id");
    }
    if (typeof raw.name !== "string" || raw.name.length > MAX_LABEL_CHARS) {
        problems.push("name");
    }
    if (!isTime(raw.createdAt) || !isTime(raw.updatedAt)) {
        problems.push("timestamps");
    }
    if (JSON.stringify(raw.authorization) !== JSON.stringify(SESSION_AUTHORIZATION)) {
        problems.push("authorization");
    }
    if (!Array.isArray(raw.flights)) {
        problems.push("flights");
    }
    if (problems.length) {
        return { ok: false, problems };
    }
    const rejected: RejectedPart[] = [];
    const flights: StoredFlight[] = [];
    const keys = new Set<string>();
    (raw.flights as unknown[]).forEach((f, i) => {
        const fp = flightProblems(f);
        if (!fp.length && keys.has((f as Raw).key as string)) {
            fp.push("duplicate_key");
        }
        if (fp.length) {
            rejected.push({ path: `flights[${i}]`, problems: fp });
            return;
        }
        const flight = f as Raw;
        const raws = flight.chirps as unknown[];
        const cps = raws.map((c) => chirpProblems(c, flight));
        // CHIRPs that are sound apart from their API version. If none carries the Flight's logged
        // apiVersion, the Flight's field (and headers) are the contradiction, not every CHIRP.
        const fwApi = (flight.firmware as Raw).apiVersion;
        const sound = raws.flatMap((c, j) => (cps[j].every((x) => x === "firmware_api_version") ? [j] : []));
        const apiOf = (j: number) => (((raws[j] as Raw).qualityV2 as Raw).provenance as Raw).apiVersion;
        if (fwApi !== null && sound.length && !sound.some((j) => apiOf(j) === fwApi)) {
            rejected.push({ path: `flights[${i}]`, problems: ["firmware:apiVersion"] });
            return;
        }
        // Not logged: no anchor, so CHIRPs of one log that disagree are all left out.
        if (fwApi === null && new Set(sound.map(apiOf)).size > 1) {
            sound.forEach((j) => cps[j].push("firmware_api_version_conflict"));
        }
        keys.add(flight.key as string);
        const ids = new Set<string>();
        const chirps: StoredChirp[] = [];
        raws.forEach((c, j) => {
            const cp = cps[j];
            if (!cp.length && ids.has((c as Raw).measurementId as string)) {
                cp.push("duplicate_measurement_id");
            }
            if (cp.length) {
                rejected.push({ path: `flights[${i}].chirps[${j}]`, problems: cp });
                return;
            }
            ids.add((c as Raw).measurementId as string);
            chirps.push(c as unknown as StoredChirp);
        });
        flights.push({ ...(flight as unknown as StoredFlight), chirps });
    });
    return { ok: true, session: { ...(raw as unknown as TuneSession), flights }, rejected };
}

/** One step: a raw session of version N to version N + 1. */
export type Migration = (raw: Raw) => Raw;

/** Migrations by source version. Empty while version 1 is the only stored shape. */
export const TUNE_SESSION_MIGRATIONS: Readonly<Record<number, Migration>> = {};

export type MigrationResult =
    | { status: "current" | "migrated"; raw: Raw; from: number }
    | { status: "unsupported_version"; schemaVersion: unknown }
    | { status: "failed"; from: number };

/**
 * Bring a raw record to `target`, one step at a time. A version from the future
 * or without a migration path is unsupported: it is reported, never rewritten.
 * A step that throws or returns no object is `failed`.
 */
export function migrateTuneSession(
    raw: Raw,
    migrations: Readonly<Record<number, Migration>> = TUNE_SESSION_MIGRATIONS,
    target: number = TUNE_SESSION_SCHEMA_VERSION,
): MigrationResult {
    const from = raw.schemaVersion;
    if (!isInt(from) || (from as number) > target) {
        return { status: "unsupported_version", schemaVersion: from };
    }
    let current: Raw = JSON.parse(JSON.stringify(raw)) as Raw;
    for (let v = from as number; v < target; v++) {
        const step = migrations[v];
        if (!step) {
            return { status: "unsupported_version", schemaVersion: from };
        }
        try {
            current = step(current);
        } catch {
            return { status: "failed", from: from as number };
        }
        if (!isObject(current)) {
            return { status: "failed", from: from as number };
        }
        if (current.schemaVersion !== v + 1) {
            return { status: "unsupported_version", schemaVersion: from };
        }
    }
    return { status: from === target ? "current" : "migrated", raw: current, from: from as number };
}
