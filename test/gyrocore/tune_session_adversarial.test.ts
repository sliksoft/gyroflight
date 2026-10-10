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

// Blind adversarial suite written from docs/gyrocore/TUNE_SESSION.md, without reading the session implementation.

import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { qualifyChirpFile, type ChirpQualificationReport } from "../../src/gyrocore/chirp/qualification";
import { attachChirpFlightIdentity } from "../../src/gyrocore/chirp/qualityV2/identity";
import {
    addFlights,
    analysisVersionStatus,
    firmwareIdentity,
    flightAnalysisStatus,
    flightPairEvidence,
    flightsFromReport,
    newTuneSession,
    removeFlight,
    storedQualityV2,
    TuneSessionDataError,
} from "../../src/gyrocore/session/build";
import {
    SESSION_AUTHORIZATION,
    TUNE_SESSION_SCHEMA,
    type StoredFlight,
    type TuneSession,
} from "../../src/gyrocore/session/contract";
import {
    openTuneSessionStore,
    readRecord,
    TUNE_SESSION_DB_NAME,
    TUNE_SESSION_STORE,
    TuneSessionStorageError,
} from "../../src/gyrocore/session/storage";
import {
    migrateTuneSession,
    plainJsonProblems,
    TUNE_SESSION_MIGRATIONS,
    validateTuneSession,
} from "../../src/gyrocore/session/validate";
import {
    concatLogs,
    encodeChirpLog,
    FULL_TUNE_HEADERS,
    simulateChirp,
    simulateChirpSequence,
} from "./harness/chirpSim";

vi.mock("../../src/js/localization", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/js/localization")>()),
    i18n: { getMessage: (key: string) => key },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;

const NOW = "2026-10-10T12:00:00.000Z";
const LATER = "2026-10-11T08:30:00.000Z";
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const MIB = 1024 * 1024;

/** SYNTHETIC firmware lines, so every firmware field is logged. */
const FW_HEADERS = [
    ...FULL_TUNE_HEADERS,
    "Firmware date:Jun 1 2026 00:00:00",
    "Board information:SYNT SYNTHETIC",
    "Craft name:SYN",
];

/** Replace one header line's bytes (latin-1) without touching the frame data. */
function editHeader(bytes: Uint8Array, from: string, to: string): Uint8Array {
    const text = new TextDecoder("latin1").decode(bytes);
    const at = text.indexOf(from);
    if (at <= 0) {
        throw new Error(`header ${from} not found`);
    }
    const out = new Uint8Array(bytes.length - from.length + to.length);
    out.set(bytes.subarray(0, at));
    out.set(
        Uint8Array.from(to, (c) => c.charCodeAt(0)),
        at,
    );
    out.set(bytes.subarray(at + from.length), at + to.length);
    return out;
}

async function analyze(bytes: Uint8Array, name: string, attach = true): Promise<ChirpQualificationReport> {
    const report = qualifyChirpFile(bytes, name, 60, AUTOTUNE_MATH);
    if (attach) {
        await attachChirpFlightIdentity(report, bytes);
    }
    return report;
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const loose = (x: unknown) => x as Loose;

/** Every value in a tree, with its path. */
function walk(value: unknown, fn: (v: unknown, path: string) => void, path = "$", seen = new Set<unknown>()): void {
    fn(value, path);
    if (value && typeof value === "object" && !seen.has(value)) {
        seen.add(value);
        if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
            return;
        }
        for (const [k, v] of Object.entries(value)) {
            walk(v, fn, `${path}.${k}`, seen);
        }
    }
}

/** Typed arrays as plain arrays, so records read back from IndexedDB compare by content. */
function plain(value: unknown): unknown {
    if (ArrayBuffer.isView(value)) {
        return {
            typed: value.constructor.name,
            bytes: Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
        };
    }
    if (Array.isArray(value)) {
        return value.map(plain);
    }
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
    }
    return value;
}

function binaryPaths(value: unknown): string[] {
    const out: string[] = [];
    walk(value, (v, p) => {
        if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer || (typeof Blob !== "undefined" && v instanceof Blob)) {
            out.push(p);
        }
    });
    return out;
}

/** A window of frame bytes as JSON would spell an array or a number-keyed object of them. */
function frameByteSignatures(bytes: Uint8Array, headerLength: number): string[] {
    const win = Array.from(bytes.subarray(headerLength + 64, headerLength + 96));
    return [win.join(","), win.map((b, i) => `"${i}":${b}`).join(",")];
}

function tuningLevels(value: unknown): unknown[] {
    const out: unknown[] = [];
    walk(value, (v, p) => {
        if (p.endsWith(".tuningAuthorized")) {
            out.push(v);
        }
    });
    return out;
}

const STORED_AUTH_REASONS = ["authorization_unknown:not_persisted", "authorization_scope:measurement_only"];

function expectNotAuthorized(level: unknown) {
    const l = loose(level);
    expect(l.status).toBe("UNKNOWN");
    expect(l.reasons).toEqual(expect.arrayContaining(STORED_AUTH_REASONS));
}

// --- synthetic data ------------------------------------------------------------------------------------------------

/** Flight A candidate. */
let simA: Uint8Array;
/** The same simulation 250 us later: a different recording, same firmware. */
let simB: Uint8Array;
/** Three CHIRPs (roll, pitch, yaw) in one log: one Flight. */
let simSeq: Uint8Array;
/** One file, three Flights: simA, simB, simSeq. */
let multi: Uint8Array;
/** simA with an edited craft name: the same recording, repackaged. */
let repack: Uint8Array;

let flightsA: StoredFlight[];
let flightsB: StoredFlight[];
let flightsSeq: StoredFlight[];
let flightsMulti: StoredFlight[];
let flightsRepack: StoredFlight[];
let reportA: ChirpQualificationReport;
let reportMulti: ChirpQualificationReport;

const opts = (fileName: string | null = "x.bbl") => ({ fileName, analyzedAt: NOW });

beforeAll(async () => {
    simA = encodeChirpLog(simulateChirp({ axis: 0, seconds: 6, startTimeUs: 1_000_000 }), FW_HEADERS);
    simB = encodeChirpLog(simulateChirp({ axis: 0, seconds: 6, startTimeUs: 1_000_250 }), FW_HEADERS);
    simSeq = encodeChirpLog(
        simulateChirpSequence(
            [
                { axis: 0, seconds: 6 },
                { axis: 1, seconds: 6 },
                { axis: 2, seconds: 6 },
            ],
            // Not simA's start time: the first frames must differ, or simSeq would be simA's content.
            3_000_000,
        ),
        FW_HEADERS,
    );
    multi = concatLogs(simA, simB, simSeq);
    repack = editHeader(simA, "H Craft name:SYN", "H Craft name:REPACKAGED COPY");

    reportA = await analyze(simA, "a.bbl");
    reportMulti = await analyze(multi, "multi.bbl");
    flightsA = flightsFromReport(reportA, opts("a.bbl")).flights;
    flightsB = flightsFromReport(await analyze(simB, "b.bbl"), opts("b.bbl")).flights;
    flightsSeq = flightsFromReport(await analyze(simSeq, "seq.bbl"), opts("seq.bbl")).flights;
    flightsMulti = flightsFromReport(reportMulti, opts("multi.bbl")).flights;
    flightsRepack = flightsFromReport(await analyze(repack, "repack.bbl"), opts("repack.bbl")).flights;
});

function sessionWith(...flights: StoredFlight[]): TuneSession {
    return addFlights(newTuneSession({ id: ID(1), name: "s", now: NOW }), flights, NOW).session;
}

// --- harness sanity ------------------------------------------------------------------------------------------------

describe("synthetic harness", () => {
    it("builds the files the suite relies on", () => {
        expect(flightsA).toHaveLength(1);
        expect(flightsB).toHaveLength(1);
        expect(flightsSeq).toHaveLength(1);
        expect(flightsSeq[0].chirps.length).toBe(3);
        expect(flightsMulti).toHaveLength(3);
        expect(flightsRepack).toHaveLength(1);
        expect(flightsA[0].chirps.length).toBeGreaterThan(0);
    });
});

// --- flightsFromReport ---------------------------------------------------------------------------------------------

describe("flightsFromReport", () => {
    it("gives one Flight per log, keyed by the WU1 locationId", () => {
        expect(flightsMulti.map((f) => f.ref.logIndex)).toEqual([0, 1, 2]);
        for (const f of flightsMulti) {
            expect(f.key).toBe(f.ref.locationId);
            expect(f.key).toBe(`${f.ref.file.sha256}#${f.ref.logIndex}`);
            expect(new Set(f.chirps.map((c) => c.logIndex))).toEqual(new Set([f.ref.logIndex]));
        }
        expect(new Set(flightsMulti.map((f) => f.key)).size).toBe(3);
    });

    it("stores every CHIRP of a Flight under that one Flight", () => {
        const byLog = new Map<number, number>();
        for (const m of reportMulti.measurements) {
            byLog.set(m.logIndex, (byLog.get(m.logIndex) ?? 0) + 1);
        }
        expect(flightsMulti.map((f) => f.chirps.length)).toEqual([0, 1, 2].map((i) => byLog.get(i)));
        expect(flightsMulti[2].chirps.map((c) => c.axis).sort()).toEqual([0, 1, 2]);
        expect(new Set(flightsMulti[2].chirps.map((c) => c.measurementId)).size).toBe(3);
    });

    it("never makes the file name part of the identity", async () => {
        const other = flightsFromReport(await analyze(simA, "renamed-and-moved.bbl"), opts("renamed.bbl")).flights;
        expect(other[0].key).toBe(flightsA[0].key);
        expect(other[0].ref).toEqual(flightsA[0].ref);
        expect(other[0].fileName).toBe("renamed.bbl");
        const unnamed = flightsFromReport(reportA, opts(null)).flights;
        expect(unnamed[0].fileName).toBeNull();
        expect(unnamed[0].key).toBe(flightsA[0].key);
    });

    it("skips a log without an identity instead of making one up", async () => {
        const report = await analyze(simA, "a.bbl", false);
        const out = flightsFromReport(report, opts());
        expect(out.flights).toEqual([]);
        expect(out.skipped).toEqual([{ logIndex: 0, reasons: expect.arrayContaining(["flight_identity_unknown"]) }]);
    });

    it("skips a log whose FlightRef fails validation", async () => {
        const report = await analyze(multi, "multi.bbl");
        for (const m of report.measurements.filter((x) => x.logIndex === 1)) {
            loose(m.qualityV2.identity.flight.ref).section.sha256 = "not-a-hash";
        }
        const out = flightsFromReport(report, opts());
        expect(out.flights.map((f) => f.ref.logIndex)).toEqual([0, 2]);
        expect(out.skipped).toEqual([{ logIndex: 1, reasons: expect.arrayContaining(["flight_identity_invalid"]) }]);
    });

    it("skips a log whose CHIRPs disagree about their Flight", async () => {
        const report = await analyze(multi, "multi.bbl");
        const seq = report.measurements.filter((x) => x.logIndex === 2);
        // One CHIRP of log 2 claims log 0's reference: the log has no single valid identity.
        seq[1].qualityV2.identity.flight.ref = clone(report.measurements[0].qualityV2.identity.flight.ref);
        const out = flightsFromReport(report, opts());
        expect(out.flights.some((f) => f.ref.logIndex === 2 && f.chirps.length === 3)).toBe(false);
        for (const f of out.flights) {
            expect(f.chirps.every((c) => c.qualityV2.identity.flight.ref?.locationId === f.key)).toBe(true);
        }
    });

    it("never stores the live authorization, and leaves the live analysis alone", async () => {
        const report = await analyze(simA, "a.bbl");
        for (const m of report.measurements) {
            m.qualityV2.levels.tuningAuthorized = { status: "YES", role: "ACTIVE_GATE", reasons: [] };
        }
        const before = clone(report.measurements.map((m) => m.qualityV2));
        const { flights } = flightsFromReport(report, opts());
        for (const level of tuningLevels(flights)) {
            expectNotAuthorized(level);
        }
        expect(JSON.stringify(flights)).not.toMatch(/"tuningAuthorized":\{"status":"YES"/);
        expect(clone(report.measurements.map((m) => m.qualityV2))).toEqual(before);
        expect(report.measurements[0].qualityV2.levels.tuningAuthorized.status).toBe("YES");
    });

    it("storedQualityV2 strips YES and NO alike and copies its input", () => {
        for (const status of ["YES", "NO"] as const) {
            const live = clone(reportA.measurements[0].qualityV2);
            live.levels.tuningAuthorized = {
                status,
                role: "ACTIVE_GATE",
                reasons: ["authorization_scope:measurement_only"],
            };
            const snapshot = clone(live);
            const stored = storedQualityV2(live);
            expectNotAuthorized(stored.levels.tuningAuthorized);
            expect(live).toEqual(snapshot);
            expect(stored).not.toBe(live);
            stored.coherence.bins.frequencyHz.push(-1);
            expect(live).toEqual(snapshot);
            // Everything except the authorization level is kept as analysed.
            const a = clone(stored) as Loose;
            const b = clone(snapshot) as Loose;
            a.coherence.bins.frequencyHz.pop();
            delete a.levels.tuningAuthorized;
            delete b.levels.tuningAuthorized;
            delete a.reasons;
            delete b.reasons;
            expect(a).toEqual(b);
        }
    });

    it("records the firmware identity from the header and names every unlogged field", () => {
        const fw = flightsA[0].firmware;
        const fields = flightsA[0].ref.header.fields;
        expect(fw.firmwareType).toBe(fields["Firmware type"]);
        expect(fw.firmwareRevision).toBe(fields["Firmware revision"]);
        expect(fw.firmwareDate).toBe("Jun 1 2026 00:00:00");
        expect(fw.boardInformation).toBe("SYNT SYNTHETIC");
        expect(fw.craftName).toBe("SYN");

        const ref = clone(flightsA[0].ref);
        ref.header.fields["Craft name"] = null;
        ref.header.fields["Firmware date"] = null;
        const partial = firmwareIdentity(ref, null);
        expect(partial.craftName).toBeNull();
        expect(partial.firmwareDate).toBeNull();
        expect(partial.apiVersion).toBeNull();
        expect([...partial.unknown].sort()).toEqual(["apiVersion", "craftName", "firmwareDate"]);

        const nothing = clone(flightsA[0].ref);
        for (const k of Object.keys(nothing.header.fields) as (keyof typeof nothing.header.fields)[]) {
            nothing.header.fields[k] = null;
        }
        const none = firmwareIdentity(nothing, null);
        expect(Object.entries(none).filter(([k, v]) => k !== "unknown" && v !== null)).toEqual([]);
        expect(none.unknown).toHaveLength(6);
    });

    it("keeps no file bytes in what it builds", () => {
        const all = [...flightsMulti, ...flightsA];
        expect(binaryPaths(all)).toEqual([]);
        expect(plainJsonProblems(all)).toEqual([]);
        const text = JSON.stringify(all);
        for (const f of flightsMulti) {
            const section = multi.subarray(f.ref.section.byteBegin, f.ref.section.byteEnd);
            for (const sig of frameByteSignatures(section, f.ref.header.byteLength)) {
                expect(text).not.toContain(sig);
            }
        }
        // A whole file is far bigger than what is stored about it.
        expect(JSON.stringify(flightsA).length).toBeLessThan(simA.length * 4);
    });

    it("is deterministic and independent of the report token", async () => {
        const again = flightsFromReport(await analyze(multi, "multi.bbl"), opts("multi.bbl")).flights;
        expect(JSON.stringify(again)).toBe(JSON.stringify(flightsMulti));
    });

    it("does not mutate the report", async () => {
        const report = await analyze(multi, "multi.bbl");
        const before = JSON.stringify(report);
        flightsFromReport(report, opts());
        expect(JSON.stringify(report)).toBe(before);
    });
});

// --- building a session --------------------------------------------------------------------------------------------

describe("newTuneSession / addFlights / removeFlight", () => {
    it("starts empty, never authorized, and valid", () => {
        const s = newTuneSession({ id: ID(1), name: "Bench", now: NOW });
        expect(s).toEqual({
            schema: TUNE_SESSION_SCHEMA,
            schemaVersion: 1,
            id: ID(1),
            name: "Bench",
            createdAt: NOW,
            updatedAt: NOW,
            flights: [],
            authorization: SESSION_AUTHORIZATION,
        });
        expect(validateTuneSession(clone(s))).toEqual({ ok: true, session: s, rejected: [] });
    });

    it("adds to a copy and never touches its inputs", () => {
        const s = newTuneSession({ id: ID(1), name: "s", now: NOW });
        const sBefore = clone(s);
        const input = flightsMulti.map((f) => clone(f));
        const inputBefore = clone(input);
        const res = addFlights(s, input, LATER);
        expect(s).toEqual(sBefore);
        expect(input).toEqual(inputBefore);
        expect(res.session).not.toBe(s);
        expect(res.added).toEqual(flightsMulti.map((f) => f.key));
        expect(res.replaced).toEqual([]);
        expect(res.notIndependent).toEqual([]);
        expect(res.session.updatedAt).toBe(LATER);
        expect(res.session.createdAt).toBe(NOW);
        // Later edits to the inputs never reach the session.
        input[0].chirps.length = 0;
        input[0].firmware.craftName = "changed";
        expect(res.session.flights[0].chirps.length).toBe(flightsMulti[0].chirps.length);
        expect(res.session.flights[0].firmware.craftName).toBe("SYN");
        // and edits to the session never reach the inputs or the earlier session.
        res.session.flights[1].chirps.length = 0;
        expect(inputBefore[1].chirps.length).toBe(flightsMulti[1].chirps.length);
        expect(validateTuneSession(clone(res.session)).ok).toBe(true);
    });

    it("treats the same location as one Flight: re-adding replaces", () => {
        const first = sessionWith(...flightsMulti);
        const again = addFlights(first, flightsMulti, LATER);
        expect(again.session.flights).toHaveLength(3);
        expect(again.added).toEqual([]);
        expect([...again.replaced].sort()).toEqual(flightsMulti.map((f) => f.key).sort());
        // The same location is not "a copy" of itself.
        expect(again.notIndependent.filter((n) => n.key === n.otherKey)).toEqual([]);
        expect(again.notIndependent).toEqual([]);
    });

    it("replacing keeps the newer analysis", () => {
        const s = sessionWith(flightsA[0]);
        const newer = clone(flightsA[0]);
        newer.fileName = "renamed.bbl";
        newer.analysis.analyzedAt = LATER;
        const res = addFlights(s, [newer], LATER);
        expect(res.session.flights).toHaveLength(1);
        expect(res.session.flights[0].fileName).toBe("renamed.bbl");
        expect(res.session.flights[0].analysis.analyzedAt).toBe(LATER);
    });

    it("the same location twice in one call is still one Flight", () => {
        const res = addFlights(newTuneSession({ id: ID(1), name: "s", now: NOW }), [flightsA[0], flightsA[0]], NOW);
        expect(res.session.flights).toHaveLength(1);
        expect(new Set(res.session.flights.map((f) => f.key)).size).toBe(1);
        expect(res.notIndependent.filter((n) => n.key === n.otherKey)).toEqual([]);
    });

    it("a copy of a Flight in another file is stored and reported as not independent", () => {
        const s = sessionWith(...flightsMulti);
        const res = addFlights(s, flightsA, LATER);
        expect(res.added).toEqual([flightsA[0].key]);
        expect(res.session.flights).toHaveLength(4);
        expect(res.notIndependent).toEqual([
            {
                key: flightsA[0].key,
                otherKey: flightsMulti[0].key,
                reasons: expect.arrayContaining(["same_flight_section"]),
            },
        ]);
    });

    it("a repackaged copy is stored and reported as not independent", () => {
        const s = sessionWith(flightsA[0]);
        const res = addFlights(s, flightsRepack, LATER);
        expect(res.session.flights).toHaveLength(2);
        expect(res.notIndependent).toHaveLength(1);
        expect(res.notIndependent[0].key).toBe(flightsRepack[0].key);
        expect(res.notIndependent[0].otherKey).toBe(flightsA[0].key);
        expect(res.notIndependent[0].reasons).toContain("same_flight_content");
    });

    it("two copies added in the same call are reported too", () => {
        const res = addFlights(
            newTuneSession({ id: ID(1), name: "s", now: NOW }),
            [flightsA[0], flightsRepack[0]],
            NOW,
        );
        expect(res.session.flights).toHaveLength(2);
        expect(res.notIndependent.length).toBeGreaterThan(0);
    });

    it("distinct recordings are not reported", () => {
        const res = addFlights(sessionWith(flightsA[0]), flightsB, LATER);
        expect(res.notIndependent).toEqual([]);
    });

    it("removeFlight returns a copy without the Flight", () => {
        const s = sessionWith(...flightsMulti);
        const before = clone(s);
        const out = removeFlight(s, flightsMulti[1].key, LATER);
        expect(s).toEqual(before);
        expect(out).not.toBe(s);
        expect(out.flights.map((f) => f.key)).toEqual([flightsMulti[0].key, flightsMulti[2].key]);
        expect(out.updatedAt).toBe(LATER);
        out.flights[0].chirps.length = 0;
        expect(s.flights[0].chirps.length).toBe(before.flights[0].chirps.length);
    });

    it("removeFlight of a key that is not there removes nothing", () => {
        const s = sessionWith(...flightsMulti);
        let out: TuneSession | null = null;
        try {
            out = removeFlight(s, "__proto__", LATER);
        } catch {
            out = null;
        }
        if (out) {
            expect(out.flights.map((f) => f.key)).toEqual(flightsMulti.map((f) => f.key));
        }
        expect(s.flights).toHaveLength(3);
    });
});

// --- file bytes never stored ----------------------------------------------------------------------------------------

type Plant = (f: Loose) => void;
const BINARY_VALUES: [string, () => unknown][] = [
    ["Uint8Array", () => new Uint8Array([1, 2, 3])],
    ["Buffer", () => Buffer.from([1, 2, 3])],
    ["Float64Array", () => new Float64Array([1.5])],
    ["ArrayBuffer", () => new ArrayBuffer(8)],
    ["DataView", () => new DataView(new ArrayBuffer(8))],
    ["Blob", () => new Blob([new Uint8Array([1, 2, 3])])],
];
const PLANTS: [string, (v: unknown) => Plant][] = [
    ["flight field", (v) => (f) => (f.bytes = v)],
    ["fileName", (v) => (f) => (f.fileName = v)],
    ["inside ref", (v) => (f) => (f.ref.header.fields["Craft name"] = v)],
    ["inside ref, new field", (v) => (f) => (f.ref.raw = v)],
    ["inside qualityV2", (v) => (f) => (f.chirps[0].qualityV2.excitation.raw = v)],
    ["qualityV2 array element", (v) => (f) => (f.chirps[0].qualityV2.coherence.bins.frequencyHz[0] = v)],
    ["logHeaders value", (v) => (f) => (f.logHeaders = [["k", v]])],
    ["firmware", (v) => (f) => (f.firmware.craftName = v)],
];

describe("file bytes never reach a session", () => {
    for (const [what, make] of BINARY_VALUES) {
        for (const [where, plant] of PLANTS) {
            it(`addFlights refuses a ${what} at ${where} before copying`, () => {
                const f = structuredCloneFlight(flightsA[0]);
                plant(make())(f);
                expect(() =>
                    addFlights(newTuneSession({ id: ID(1), name: "s", now: NOW }), [f as StoredFlight], NOW),
                ).toThrow(TuneSessionDataError);
            });
        }
    }

    it("the error names binary_data", () => {
        const f = structuredCloneFlight(flightsA[0]);
        f.chirps[0].qualityV2.raw = new Uint8Array(4);
        try {
            addFlights(newTuneSession({ id: ID(1), name: "s", now: NOW }), [f as StoredFlight], NOW);
            expect.unreachable();
        } catch (err) {
            expect(err).toBeInstanceOf(TuneSessionDataError);
            expect((err as TuneSessionDataError).problems.join(" ")).toContain("binary_data");
        }
    });

    it("plainJsonProblems finds binary anywhere, however deep", () => {
        for (const [, make] of BINARY_VALUES) {
            let deep: Loose = { leaf: make() };
            for (let i = 0; i < 50; i++) {
                deep = { a: [deep] };
            }
            expect(plainJsonProblems(deep).join(" ")).toContain("binary_data");
            expect(plainJsonProblems([1, 2, make()]).join(" ")).toContain("binary_data");
            expect(plainJsonProblems(make()).join(" ")).toContain("binary_data");
        }
    });

    it("plainJsonProblems refuses non-JSON values", () => {
        const bad: [string, unknown][] = [
            ["NaN", NaN],
            ["Infinity", Infinity],
            ["-Infinity", -Infinity],
            ["undefined", undefined],
            ["function", () => 1],
            ["bigint", BigInt(1)],
            ["symbol", Symbol("s")],
            ["Date", new Date(0)],
            ["Map", new Map([[1, 2]])],
            ["Set", new Set([1])],
            ["RegExp", /x/],
            ["toJSON", { toJSON: () => ({}) }],
            [
                "class instance",
                new (class Bytes {
                    n = 1;
                })(),
            ],
        ];
        for (const [name, value] of bad) {
            expect(plainJsonProblems({ x: { y: value } }), name).not.toEqual([]);
        }
        expect(plainJsonProblems({ a: [1, "x", null, true, { b: -0, c: 1e308 }], s: "x".repeat(1000) })).toEqual([]);
    });

    it("plainJsonProblems survives a cycle", () => {
        const a: Loose = { b: {} };
        a.b.a = a;
        let problems: string[] = [];
        expect(() => (problems = plainJsonProblems(a))).not.toThrow();
        expect(problems).not.toEqual([]);
    });

    const bytesAsObject = () => JSON.parse(JSON.stringify(simA.subarray(0, 64))) as Loose;
    const numberKeyed: [string, (s: Loose, b: Loose) => void, "session" | "flight" | "chirp"][] = [
        ["at the session level", (s, b) => (s.bytes = b), "session"],
        ["as a CHIRP field", (s, b) => (s.flights[0].chirps[0].bytes = b), "chirp"],
        ["inside qualityV2", (s, b) => (s.flights[0].chirps[0].qualityV2.excitation.raw = b), "chirp"],
        ["inside a qualityV2 level", (s, b) => (s.flights[0].chirps[0].qualityV2.levels.bblValid.raw = b), "chirp"],
        ["as the qualityV2 report", (s, b) => (s.flights[0].chirps[0].qualityV2 = b), "chirp"],
        ["inside the FlightRef", (s, b) => (s.flights[0].ref.bytes = b), "flight"],
        ["inside the FlightRef header", (s, b) => (s.flights[0].ref.header.bytes = b), "flight"],
        ["as a Flight field", (s, b) => (s.flights[0].bytes = b), "flight"],
        ["inside the analysis block", (s, b) => (s.flights[0].analysis.bytes = b), "flight"],
        ["inside the qualification block", (s, b) => (s.flights[0].chirps[0].qualification.bytes = b), "chirp"],
    ];
    for (const [where, plant, level] of numberKeyed) {
        it(`a JSON copy of bytes (a number-keyed object) ${where} is not stored`, () => {
            const s = clone(sessionWith(flightsA[0])) as Loose;
            expect(Object.keys(bytesAsObject())[0]).toBe("0");
            plant(s, bytesAsObject());
            const r = validateTuneSession(s);
            if (level === "session") {
                expect(r.ok).toBe(false);
            } else if (level === "flight") {
                expectFlightExcluded(r, 0);
            } else {
                expectChirpExcluded(r, 0, 0);
            }
            if (r.ok) {
                expect(JSON.stringify(r.session)).not.toContain(frameByteSignatures(simA, 0)[1].slice(0, 20));
                expect(JSON.stringify(r.session)).not.toContain('"0":72,"1":32');
            }
        });
    }

    it("binary data anywhere in a stored record makes the whole record corrupt", () => {
        for (const [what, make] of BINARY_VALUES) {
            for (const [where, plant] of PLANTS) {
                const s = structuredCloneFlight(
                    sessionWith(flightsA[0]) as unknown as StoredFlight,
                ) as unknown as Loose;
                plant(make())(s.flights[0]);
                const r = readRecord(s.id, s);
                expect(r.status, `${what} at ${where}`).toBe("corrupt");
                expect(loose(r).problems.join(" "), `${what} at ${where}`).toContain("binary_data");
            }
        }
        expect(readRecord(ID(1), simA).status).toBe("corrupt");
        expect(readRecord(ID(1), simA.buffer).status).toBe("corrupt");
    });

    it("huge strings are capped at every level", () => {
        const s = clone(sessionWith(flightsA[0], flightsB[0])) as Loose;

        const bigChirp = clone(s);
        bigChirp.flights[0].chirps[0].qualification.failedGates.push("x".repeat(MIB + 10));
        expectChirpExcluded(validateTuneSession(bigChirp), 0, 0);

        const bigRef = clone(s);
        bigRef.flights[1].ref.header.fields["Craft name"] = "x".repeat(17 * 1024);
        expectFlightExcluded(validateTuneSession(bigRef), 1);

        const bigSession = clone(s);
        bigSession.flights[0].logHeaders = [["huge", "x".repeat(17 * MIB)]];
        expect(validateTuneSession(bigSession).ok).toBe(false);
        expect(readRecord(s.id, bigSession).status).toBe("corrupt");

        // Many CHIRPs each below the CHIRP cap still hit the session cap.
        const many = clone(s);
        const pad = "y".repeat(Math.floor(0.9 * MIB));
        const template = many.flights[0].chirps[0];
        many.flights[0].chirps = Array.from({ length: 20 }, (_, i) => {
            const c = clone(template);
            c.qualification.warningGates = [pad];
            c.measurementId = `${template.measurementId}-${i}`;
            return c;
        });
        expect(validateTuneSession(many).ok).toBe(false);
    });
});

/** A deep copy that keeps typed arrays and Blobs (structuredClone keeps them; JSON would not). */
function structuredCloneFlight(f: StoredFlight): Loose {
    return structuredClone(f) as unknown as Loose;
}

function expectChirpExcluded(result: ReturnType<typeof validateTuneSession>, fi: number, ci: number) {
    if (!result.ok) {
        return;
    }
    expect(result.rejected.map((r) => r.path)).toContain(`flights[${fi}].chirps[${ci}]`);
    expect(binaryPaths(result.session)).toEqual([]);
}

function expectFlightExcluded(result: ReturnType<typeof validateTuneSession>, fi: number) {
    if (!result.ok) {
        return;
    }
    expect(result.rejected.map((r) => r.path)).toContain(`flights[${fi}]`);
}

// --- authorization -------------------------------------------------------------------------------------------------

describe("authorization is never stored", () => {
    const base = () => clone(sessionWith(flightsA[0], flightsB[0])) as Loose;

    it("a session's authorization block must be exactly NOT_STORED", () => {
        const variants: ((s: Loose) => void)[] = [
            (s) => (s.authorization = { status: "ALLOWED", reasons: [] }),
            (s) => (s.authorization = { status: "YES", reasons: SESSION_AUTHORIZATION.reasons }),
            (s) => (s.authorization.reasons = [...SESSION_AUTHORIZATION.reasons].reverse()),
            (s) => (s.authorization.reasons = ["authorization_not_persisted"]),
            (s) => s.authorization.reasons.push("apply_allowed"),
            (s) => (s.authorization.allowed = true),
            (s) => (s.authorization.status = "not_stored"),
            (s) => delete s.authorization,
            (s) => (s.authorization = null),
            (s) => (s.authorized = true),
            (s) => (s.apply = { allowed: true }),
        ];
        variants.forEach((mutate, i) => {
            const s = base();
            mutate(s);
            expect(validateTuneSession(s).ok, `variant ${i}`).toBe(false);
            expect(readRecord(s.id ?? ID(1), s).status, `variant ${i}`).toBe("corrupt");
        });
    });

    it("a stored report that claims an authorization is rejected", () => {
        const variants: ((l: Loose) => void)[] = [
            (l) => (l.status = "YES"),
            (l) => (l.status = "NO"),
            (l) => (l.reasons = ["authorization_scope:measurement_only"]),
            (l) => (l.reasons = []),
            (l) => {
                l.status = "YES";
                l.reasons = STORED_AUTH_REASONS;
            },
            (l) => (l.allowed = true),
        ];
        variants.forEach((mutate, i) => {
            const s = base();
            mutate(s.flights[1].chirps[0].qualityV2.levels.tuningAuthorized);
            const r = validateTuneSession(s);
            expect(r.ok, `variant ${i}`).toBe(true);
            if (r.ok) {
                const rej = r.rejected.find((x) => x.path === "flights[1].chirps[0]");
                expect(rej, `variant ${i}`).toBeDefined();
                if (i < 5) {
                    expect(rej!.problems.join(" "), `variant ${i}`).toContain("stored_authorization");
                }
                for (const level of tuningLevels(r.session)) {
                    expectNotAuthorized(level);
                }
            }
        });
    });

    it("a stored report's own reasons list cannot smuggle in an authorization either", () => {
        const s = base();
        const lv = s.flights[0].chirps[0].qualityV2.levels;
        lv.tuningAuthorized = { status: "YES", role: "ACTIVE_GATE", reasons: [] };
        const r = validateTuneSession(s);
        if (r.ok) {
            expect(JSON.stringify(r.session)).not.toMatch(/"tuningAuthorized":\{"status":"YES"/);
        }
    });
});

// --- Flight A/B evidence -------------------------------------------------------------------------------------------

describe("flightPairEvidence", () => {
    const FW_FIELDS = [
        "firmwareType",
        "firmwareRevision",
        "firmwareDate",
        "boardInformation",
        "craftName",
        "apiVersion",
    ];

    it("two distinct recordings with fully logged, equal firmware and current analysis: nothing blocks", () => {
        const s = sessionWith(flightsA[0], flightsB[0]);
        const e = flightPairEvidence(s, flightsA[0].key, flightsB[0].key);
        expect(e.keyA).toBe(flightsA[0].key);
        expect(e.keyB).toBe(flightsB[0].key);
        expect(e.independence.independent).toBe(true);
        expect(e.analysisVersions).toEqual({ a: "CURRENT", b: "CURRENT", same: true });
        expect(Object.keys(e.firmware).sort()).toEqual([...FW_FIELDS].sort());
        expect(Object.values(e.firmware).every((x) => x === "MATCH")).toBe(true);
        expect(e.blockers).toEqual([]);
    });

    it("does not mutate the session", () => {
        const s = sessionWith(flightsA[0], flightsB[0]);
        const before = clone(s);
        flightPairEvidence(s, flightsA[0].key, flightsB[0].key);
        flightPairEvidence(s, flightsA[0].key, "missing");
        expect(s).toEqual(before);
    });

    it("the same Flight twice is never a pair", () => {
        const s = sessionWith(flightsSeq[0]);
        const e = flightPairEvidence(s, flightsSeq[0].key, flightsSeq[0].key);
        expect(e.independence.independent).toBe(false);
        expect(e.blockers).toContain("same_flight_section");
    });

    it("a copy in another file and a repackaged copy are blocked", () => {
        const s = sessionWith(...flightsMulti, flightsA[0], flightsRepack[0]);
        const copy = flightPairEvidence(s, flightsMulti[0].key, flightsA[0].key);
        expect(copy.independence.independent).toBe(false);
        expect(copy.blockers).toContain("same_flight_section");
        const rep = flightPairEvidence(s, flightsRepack[0].key, flightsMulti[0].key);
        expect(rep.independence.independent).toBe(false);
        expect(rep.blockers).toContain("same_flight_content");
        // Its craft name differs as well, and that is reported, but independence alone blocks it.
        expect(rep.firmware.craftName).toBe("MISMATCH");
    });

    it("Flights of one file are independent of each other", () => {
        const s = sessionWith(...flightsMulti);
        const e = flightPairEvidence(s, flightsMulti[0].key, flightsMulti[2].key);
        expect(e.independence.independent).toBe(true);
        expect(e.blockers).toEqual([]);
    });

    it("null never equals null: a field unlogged on both sides is UNKNOWN and blocks", () => {
        const a = clone(flightsA[0]);
        const b = clone(flightsB[0]);
        for (const f of [a, b]) {
            f.firmware.craftName = null;
            f.firmware.apiVersion = null;
            f.firmware.unknown = ["craftName", "apiVersion"];
        }
        const e = flightPairEvidence(sessionWith(a, b), a.key, b.key);
        expect(e.firmware.craftName).toBe("UNKNOWN");
        expect(e.firmware.apiVersion).toBe("UNKNOWN");
        expect(e.firmware.firmwareType).toBe("MATCH");
        expect(e.blockers).toEqual(
            expect.arrayContaining(["firmware_unknown:craftName", "firmware_unknown:apiVersion"]),
        );
        expect(e.blockers).not.toContain("firmware_unknown:firmwareType");
    });

    it("null on one side is UNKNOWN, not MISMATCH and not MATCH", () => {
        const a = clone(flightsA[0]);
        a.firmware.boardInformation = null;
        a.firmware.unknown = ["boardInformation"];
        for (const [x, y] of [
            [a, flightsB[0]],
            [flightsB[0], a],
        ]) {
            const e = flightPairEvidence(sessionWith(x, y), x.key, y.key);
            expect(e.firmware.boardInformation).toBe("UNKNOWN");
            expect(e.blockers).toContain("firmware_unknown:boardInformation");
        }
    });

    it("every firmware field that differs is a MISMATCH and blocks", () => {
        for (const field of FW_FIELDS) {
            const b = clone(flightsB[0]) as Loose;
            b.firmware[field] = `${b.firmware[field]} `;
            const e = flightPairEvidence(sessionWith(flightsA[0], b as StoredFlight), flightsA[0].key, b.key);
            expect(loose(e.firmware)[field], field).toBe("MISMATCH");
            expect(e.blockers, field).toContain(`firmware_mismatch:${field}`);
        }
    });

    it("case is not glossed over", () => {
        const b = clone(flightsB[0]);
        b.firmware.firmwareType = b.firmware.firmwareType!.toUpperCase();
        expect(flightPairEvidence(sessionWith(flightsA[0], b), flightsA[0].key, b.key).firmware.firmwareType).toBe(
            "MISMATCH",
        );
    });

    it("outdated analysis versions always block, even when both match", () => {
        const a = clone(flightsA[0]);
        const b = clone(flightsB[0]);
        for (const c of b.chirps) {
            loose(c.qualityV2).analysisVersion = "2.0.0";
        }
        let e = flightPairEvidence(sessionWith(a, b), a.key, b.key);
        expect(e.analysisVersions).toEqual({ a: "CURRENT", b: "OUTDATED", same: false });
        expect(e.blockers).toEqual(expect.arrayContaining(["analysis_version_outdated:b", "analysis_version_differs"]));
        expect(e.blockers).not.toContain("analysis_version_outdated:a");

        for (const c of a.chirps) {
            loose(c.qualityV2).analysisVersion = "2.0.0";
        }
        e = flightPairEvidence(sessionWith(a, b), a.key, b.key);
        expect(e.analysisVersions.a).toBe("OUTDATED");
        expect(e.analysisVersions.b).toBe("OUTDATED");
        expect(e.blockers).toEqual(
            expect.arrayContaining(["analysis_version_outdated:a", "analysis_version_outdated:b"]),
        );
    });

    it("unknown analysis versions block, and unknown never counts as the same version", () => {
        for (const v of ["9.9.9", null, undefined, "", 2.1, "2.1", " 2.1.0", "constructor", "__proto__"]) {
            // Versions are set after addFlights: undefined is not JSON, so addFlights would refuse it.
            const s = sessionWith(flightsA[0], flightsB[0]);
            for (const c of s.flights.flatMap((f) => f.chirps)) {
                loose(c.qualityV2).analysisVersion = v;
            }
            const e = flightPairEvidence(s, flightsA[0].key, flightsB[0].key);
            expect(e.analysisVersions.a, String(v)).toBe("UNKNOWN_VERSION");
            expect(e.analysisVersions.b, String(v)).toBe("UNKNOWN_VERSION");
            expect(e.blockers, String(v)).toEqual(
                expect.arrayContaining(["analysis_version_unknown:a", "analysis_version_unknown:b"]),
            );
            if (typeof v !== "string") {
                // No version at all on either side is not "one version".
                expect(e.analysisVersions.same, String(v)).toBe(false);
            }
        }
    });

    it("one outdated CHIRP makes its whole Flight outdated", () => {
        const seq = clone(flightsSeq[0]);
        loose(seq.chirps[2].qualityV2).analysisVersion = "2.0.0";
        expect(flightAnalysisStatus(seq)).toBe("OUTDATED");
        loose(seq.chirps[1].qualityV2).analysisVersion = "3.0.0";
        expect(flightAnalysisStatus(seq)).toBe("UNKNOWN_VERSION");
        const e = flightPairEvidence(sessionWith(flightsA[0], seq), flightsA[0].key, seq.key);
        expect(e.blockers).toContain("analysis_version_unknown:b");
    });

    it("a Flight without CHIRPs has no known analysis version", () => {
        const empty = clone(flightsB[0]);
        empty.chirps = [];
        expect(flightAnalysisStatus(empty)).toBe("UNKNOWN_VERSION");
        const e = flightPairEvidence(sessionWith(flightsA[0], empty), flightsA[0].key, empty.key);
        expect(e.analysisVersions.b).toBe("UNKNOWN_VERSION");
        expect(e.blockers).toContain("analysis_version_unknown:b");
    });

    it("analysisVersionStatus knows exactly the documented versions", () => {
        expect(analysisVersionStatus("2.1.0")).toBe("CURRENT");
        expect(analysisVersionStatus("2.0.0")).toBe("OUTDATED");
        for (const v of [
            "2.2.0",
            "1.0.0",
            "2.1.0 ",
            "v2.1.0",
            "2.1.0-beta",
            "",
            null,
            undefined,
            2.1,
            ["2.1.0"],
            { toString: () => "2.1.0" },
            "toString",
            "__proto__",
            "constructor",
            "hasOwnProperty",
        ]) {
            expect(analysisVersionStatus(v), String(v)).toBe("UNKNOWN_VERSION");
        }
    });

    it("a missing Flight blocks, including prototype keys", () => {
        const s = sessionWith(flightsA[0]);
        for (const missing of ["nope", "__proto__", "constructor", "toString", ""]) {
            const e = flightPairEvidence(s, flightsA[0].key, missing);
            expect(e.blockers, missing).toContain("flight_not_in_session:b");
            expect(e.independence.independent, missing).toBe(false);
            const e2 = flightPairEvidence(s, missing, flightsA[0].key);
            expect(e2.blockers, missing).toContain("flight_not_in_session:a");
            expect(e2.independence.independent, missing).toBe(false);
        }
        const both = flightPairEvidence(s, "x", "y");
        expect(both.blockers).toEqual(expect.arrayContaining(["flight_not_in_session:a", "flight_not_in_session:b"]));
    });

    it("a damaged stored reference blocks the pair", () => {
        const b = clone(flightsB[0]);
        b.ref.bodyPrefix.sha256 = "0".repeat(63);
        const e = flightPairEvidence(sessionWith(flightsA[0], b), flightsA[0].key, b.key);
        expect(e.independence.independent).toBe(false);
        expect(e.blockers).toContain("flight_b_identity_incomplete");
    });

    it("blockers is empty only when everything passes", () => {
        const cases: [string, StoredFlight, StoredFlight][] = [
            ["copy", flightsMulti[0], flightsA[0]],
            ["repack", flightsA[0], flightsRepack[0]],
            ["self", flightsA[0], flightsA[0]],
        ];
        for (const [name, a, b] of cases) {
            const s = sessionWith(...[a, b].filter((f, i, all) => all.findIndex((x) => x.key === f.key) === i));
            const e = flightPairEvidence(s, a.key, b.key);
            expect(e.blockers.length, name).toBeGreaterThan(0);
            for (const r of e.independence.reasons) {
                expect(e.blockers, name).toContain(r);
            }
        }
    });
});

// --- validation of stored data -------------------------------------------------------------------------------------

describe("validateTuneSession / readRecord: damage is classified, never repaired", () => {
    const base = () => clone(sessionWith(flightsA[0], flightsSeq[0])) as Loose;

    it("a clean session round-trips through JSON unchanged and deterministically", () => {
        const s = sessionWith(...flightsMulti);
        const text = JSON.stringify(s);
        const r = validateTuneSession(JSON.parse(text));
        expect(r).toEqual({ ok: true, session: s, rejected: [] });
        if (r.ok) {
            expect(JSON.stringify(r.session)).toBe(text);
            const twice = validateTuneSession(JSON.parse(JSON.stringify(r.session)));
            expect(twice.ok && JSON.stringify(twice.session)).toBe(text);
        }
        expect(JSON.stringify(sessionWith(...flightsMulti))).toBe(text);
    });

    it("does not mutate what it validates", () => {
        const s = base();
        s.flights[1].chirps[0].qualityV2.levels.tuningAuthorized.status = "YES";
        s.flights[0].key = "wrong";
        const before = clone(s);
        validateTuneSession(s);
        readRecord(s.id, s);
        expect(s).toEqual(before);
    });

    const SESSION_DAMAGE: [string, (s: Loose) => void][] = [
        ["schema", (s) => (s.schema = "gyrocore.tune-session.v2")],
        ["schema missing", (s) => delete s.schema],
        ["id empty", (s) => (s.id = "")],
        ["id number", (s) => (s.id = 5)],
        ["name number", (s) => (s.name = 5)],
        ["name null", (s) => (s.name = null)],
        ["name too long", (s) => (s.name = "n".repeat(257))],
        ["createdAt garbage", (s) => (s.createdAt = "yesterday")],
        ["createdAt not UTC", (s) => (s.createdAt = "2026-10-10T14:00:00.000+02:00")],
        ["createdAt impossible date", (s) => (s.createdAt = "2026-02-30T00:00:00.000Z")],
        ["updatedAt number", (s) => (s.updatedAt = Date.parse(NOW))],
        ["updatedAt missing", (s) => delete s.updatedAt],
        ["flights not array", (s) => (s.flights = {})],
        ["flights missing", (s) => delete s.flights],
        ["unknown field", (s) => (s.notes = "x")],
        ["NaN", (s) => (s.flights[0].analysis.targetPhaseMarginDeg = NaN)],
        ["Infinity deep", (s) => (s.flights[1].chirps[0].qualityV2.coherence.bins.frequencyHz[0] = Infinity)],
        ["undefined value", (s) => (s.flights[0].fileName = undefined)],
        ["Date object", (s) => (s.flights[0].addedAt = new Date(NOW))],
        ["Map", (s) => (s.flights[0].chirps[0].qualityV2.extra = new Map())],
        ["function", (s) => (s.flights[0].chirps[0].qualityV2.toJSON = () => ({}))],
    ];

    for (const [name, mutate] of SESSION_DAMAGE) {
        it(`session-level damage is corrupt: ${name}`, () => {
            const s = base();
            mutate(s);
            expect(validateTuneSession(s).ok).toBe(false);
            const r = readRecord(ID(1), s);
            expect(r.status).toBe("corrupt");
            expect(loose(r).problems.length).toBeGreaterThan(0);
        });
    }

    it("a name of exactly 256 characters is fine", () => {
        const s = base();
        s.name = "n".repeat(256);
        expect(validateTuneSession(s).ok).toBe(true);
    });

    it("an unknown session field is reported as unknown_field", () => {
        const s = base();
        s.extra = 1;
        const r = validateTuneSession(s);
        expect(r.ok).toBe(false);
        expect(!r.ok && r.problems.join(" ")).toContain("unknown_field");
    });

    it("non-objects are corrupt records, not exceptions", () => {
        for (const raw of [null, undefined, 0, "session", [], true, [base()]]) {
            expect(() => readRecord(ID(1), raw)).not.toThrow();
            expect(readRecord(ID(1), raw).status, JSON.stringify(raw)).not.toBe("ok");
            expect(validateTuneSession(raw).ok).toBe(false);
        }
    });

    const FLIGHT_DAMAGE: [string, (f: Loose, s: Loose) => void, string?][] = [
        ["ref section hash", (f) => (f.ref.section.sha256 = "zz"), "identity:section"],
        ["ref schema", (f) => (f.ref.schema = "gyrocore.flight-identity.v0"), "identity:schema"],
        ["ref missing", (f) => (f.ref = null), "identity:missing"],
        ["ref valid with reasons", (f) => (f.ref.reasons = ["x"]), "identity:status"],
        ["ref locationId", (f) => (f.ref.locationId = `${f.ref.file.sha256}#9`), undefined],
        ["key not locationId", (f) => (f.key = `${f.ref.file.sha256}#9`)],
        ["key missing", (f) => delete f.key],
        ["fileName number", (f) => (f.fileName = 3)],
        ["addedAt garbage", (f) => (f.addedAt = "soon")],
        ["firmware missing", (f) => delete f.firmware],
        ["firmware field number", (f) => (f.firmware.firmwareType = 4)],
        [
            "firmware unknown not listing a null",
            (f) => {
                f.firmware.craftName = null;
                f.firmware.unknown = [];
            },
        ],
        ["firmware unknown listing a present field", (f) => (f.firmware.unknown = ["firmwareType"])],
        ["firmware unknown field", (f) => (f.firmware.extra = "x")],
        ["logHeaders object", (f) => (f.logHeaders = { a: "b" })],
        ["logHeaders bad pair", (f) => (f.logHeaders = [["a", 1]])],
        ["logHeaders triple", (f) => (f.logHeaders = [["a", "b", "c"]])],
        ["analysis decoder", (f) => (f.analysis.decoder = "other")],
        ["analysis time", (f) => (f.analysis.analyzedAt = "x")],
        ["analysis target string", (f) => (f.analysis.targetPhaseMarginDeg = "60")],
        ["analysis missing", (f) => delete f.analysis],
        ["chirps not array", (f) => (f.chirps = {})],
    ];

    for (const [name, mutate, code] of FLIGHT_DAMAGE) {
        it(`a damaged Flight is left out and listed, the rest loads: ${name}`, () => {
            const s = base();
            const before = clone(s);
            mutate(s.flights[1], s);
            const r = validateTuneSession(s);
            expect(r.ok).toBe(true);
            if (!r.ok) {
                return;
            }
            expect(r.session.flights).toEqual([before.flights[0]]);
            const rej = r.rejected.find((x) => x.path === "flights[1]");
            expect(rej).toBeDefined();
            expect(rej!.problems.length).toBeGreaterThan(0);
            if (code) {
                expect(rej!.problems).toContain(code);
            }
            // Never repaired: what loads is exactly what was stored.
            expect(r.session.id).toBe(before.id);
            expect(r.session.updatedAt).toBe(before.updatedAt);
        });
    }

    it("an unknown Flight field is not kept", () => {
        const s = base();
        s.flights[0].extra = { a: 1 };
        const r = validateTuneSession(s);
        if (r.ok) {
            expect(r.session.flights.some((f) => "extra" in f)).toBe(false);
            expect(r.rejected.map((x) => x.path)).toContain("flights[0]");
        }
    });

    it("a duplicate key is left out, never merged or counted twice", () => {
        const s = base();
        s.flights.push(clone(s.flights[0]));
        const r = validateTuneSession(s);
        expect(r.ok).toBe(true);
        if (r.ok) {
            const keys = r.session.flights.map((f) => f.key);
            expect(new Set(keys).size).toBe(keys.length);
            expect(r.rejected.map((x) => x.path)).toContain("flights[2]");
        }
    });

    const CHIRP_DAMAGE: [string, (c: Loose, f: Loose, s: Loose) => void, string?][] = [
        ["qualityV2 schema", (c) => (c.qualityV2.schema = "gyrocore.chirp-quality.v1")],
        ["qualityV2 missing", (c) => delete c.qualityV2],
        ["qualityV2 null", (c) => (c.qualityV2 = null)],
        ["identity logIndex", (c) => (c.qualityV2.identity.logIndex = 5)],
        [
            "chirp logIndex vs Flight",
            (c) => {
                c.logIndex = 5;
                c.qualityV2.identity.logIndex = 5;
            },
        ],
        ["identity measurement id", (c) => (c.qualityV2.identity.measurementId = "log9-seg9")],
        ["chirp measurement id", (c) => (c.measurementId = "log9-seg9")],
        ["identity axis", (c) => (c.qualityV2.identity.axis = (c.axis + 1) % 3)],
        [
            "flight link: another location",
            (c, _f, s) => {
                c.qualityV2.identity.flight.ref = clone(s.flights[0].ref);
            },
        ],
        [
            "flight link: missing",
            (c) => {
                c.qualityV2.identity.flight = {
                    availability: "UNKNOWN",
                    ref: null,
                    reasons: ["identity_not_attached"],
                };
            },
        ],
        ["file link: another file", (c) => (c.qualityV2.identity.file.sha256 = "a".repeat(64))],
        ["stored authorization", (c) => (c.qualityV2.levels.tuningAuthorized.status = "YES"), "stored_authorization"],
        ["qualification state", (c) => (c.qualification.state = "authorized")],
        ["qualification gates", (c) => (c.qualification.failedGates = "low_coherence")],
        ["qualification missing", (c) => delete c.qualification],
        ["unknown chirp field", (c) => (c.apply = { allowed: true })],
        ["axisName", (c) => (c.axisName = "throttle")],
        ["sampleCount string", (c) => (c.sampleCount = "100")],
    ];

    for (const [name, mutate, code] of CHIRP_DAMAGE) {
        it(`a damaged CHIRP is left out and listed, its siblings load: ${name}`, () => {
            const s = base();
            const before = clone(s);
            mutate(s.flights[1].chirps[1], s.flights[1], s);
            const r = validateTuneSession(s);
            expect(r.ok).toBe(true);
            if (!r.ok) {
                return;
            }
            expect(r.rejected.map((x) => x.path)).toEqual(["flights[1].chirps[1]"]);
            if (code) {
                expect(r.rejected[0].problems).toContain(code);
            }
            expect(r.session.flights[0]).toEqual(before.flights[0]);
            expect(r.session.flights[1].chirps).toEqual([before.flights[1].chirps[0], before.flights[1].chirps[2]]);
        });
    }

    it("a duplicate CHIRP id is left out", () => {
        const s = base();
        s.flights[1].chirps.push(clone(s.flights[1].chirps[0]));
        const r = validateTuneSession(s);
        expect(r.ok).toBe(true);
        if (r.ok) {
            const ids = r.session.flights[1].chirps.map((c) => c.measurementId);
            expect(new Set(ids).size).toBe(ids.length);
            expect(r.rejected.map((x) => x.path)).toContain("flights[1].chirps[3]");
        }
    });

    // Contract change after the blind pass: a stored report must match the frozen shape of its analysis
    // version (STORED_QUALITY_V2_SHAPES), so stray fields cannot hide file bytes. 2.0.0 was never stored and
    // has no shape; OUTDATED is still reported for an in-memory Flight.
    it("a CHIRP of a version without a stored shape is rejected; OUTDATED is reported in memory", () => {
        const s = base();
        s.flights[1].chirps[0].qualityV2.analysisVersion = "2.0.0";
        const r = validateTuneSession(s);
        expect(r.ok && r.rejected).toEqual([
            { path: "flights[1].chirps[0]", problems: ["quality_v2_version_not_storable"] },
        ]);
        expect(flightAnalysisStatus(s.flights[1])).toBe("OUTDATED");
    });

    it("readRecord reports the same split", () => {
        const s = base();
        s.flights[1].chirps[0].qualityV2.levels.tuningAuthorized.status = "YES";
        const r = readRecord(s.id, s);
        expect(r.status).toBe("ok");
        if (r.status === "ok") {
            expect(r.rejected.map((x) => x.path)).toEqual(["flights[1].chirps[0]"]);
            expect(r.migratedFrom).toBeNull();
        }
    });
});

// --- migrations ----------------------------------------------------------------------------------------------------

/** SYNTHETIC version 0: `title` instead of `name`. */
function asV0(s: TuneSession): Loose {
    const raw = clone(s) as Loose;
    raw.schemaVersion = 0;
    raw.title = raw.name;
    delete raw.name;
    return raw;
}
const V0_TO_V1 = (r: Loose): Loose => {
    const { title, ...rest } = r;
    return { ...rest, name: title, schemaVersion: 1 };
};

describe("migrations", () => {
    it("ships no migrations while version 1 is the only stored shape", () => {
        expect(Object.keys(TUNE_SESSION_MIGRATIONS)).toEqual([]);
    });

    it("a current record is current", () => {
        const s = clone(sessionWith(flightsA[0])) as Loose;
        const r = migrateTuneSession(s);
        expect(r.status).toBe("current");
        expect(r.status !== "unsupported_version" && r.from).toBe(1);
    });

    it("migrates version 0 with a registered step", () => {
        const s = sessionWith(flightsA[0]);
        const r = migrateTuneSession(asV0(s), { 0: V0_TO_V1 }, 1);
        expect(r.status).toBe("migrated");
        if (r.status === "migrated") {
            expect(r.from).toBe(0);
            expect(validateTuneSession(r.raw)).toEqual({ ok: true, session: s, rejected: [] });
        }
    });

    it("runs several steps in order", () => {
        const calls: number[] = [];
        const step = (n: number) => (r: Loose) => {
            calls.push(n);
            return { ...r, schemaVersion: n + 1 };
        };
        const r = migrateTuneSession({ schemaVersion: 0 }, { 0: step(0), 1: step(1), 2: step(2) }, 3);
        expect(calls).toEqual([0, 1, 2]);
        expect(r.status).toBe("migrated");
    });

    const unsupported: [string, unknown, Record<number, (r: Loose) => Loose>][] = [
        ["future", 2, {}],
        ["far future with a step", 2, { 2: (r) => ({ ...r, schemaVersion: 1 }) }],
        ["fraction", 0.5, { 0: V0_TO_V1 }],
        ["string", "1", {}],
        ["string 0", "0", { 0: V0_TO_V1 }],
        ["NaN", NaN, {}],
        ["Infinity", Infinity, {}],
        ["null", null, {}],
        ["missing", undefined, {}],
        ["boolean", true, {}],
        ["no path", 0, {}],
        ["negative without path", -1, { 0: V0_TO_V1 }],
    ];
    for (const [name, version, migrations] of unsupported) {
        it(`is unsupported and never rewritten: ${name}`, () => {
            const raw = asV0(sessionWith(flightsA[0]));
            if (version === undefined) {
                delete raw.schemaVersion;
            } else {
                raw.schemaVersion = version;
            }
            const before = structuredClone(raw);
            const r = migrateTuneSession(raw, migrations, 1);
            expect(r.status).toBe("unsupported_version");
            expect(raw).toEqual(before);
            const rec = readRecord(ID(1), raw, migrations);
            // Non-JSON data is checked before migration, so a non-finite version is corrupt.
            expect(rec.status).toBe(
                typeof version === "number" && !Number.isFinite(version) ? "corrupt" : "unsupported_version",
            );
        });
    }

    it("a missing step in the middle is unsupported", () => {
        const step = (n: number) => (r: Loose) => ({ ...r, schemaVersion: n + 1 });
        expect(migrateTuneSession({ schemaVersion: 0 }, { 0: step(0), 2: step(2) }, 3).status).toBe(
            "unsupported_version",
        );
    });

    const badSteps: [string, (r: Loose) => Loose][] = [
        ["does not advance", (r) => r],
        ["goes back", (r) => ({ ...r, schemaVersion: -1 })],
        ["skips past the target", (r) => ({ ...r, schemaVersion: 2 })],
        ["returns a string version", (r) => ({ ...r, schemaVersion: "1" })],
        ["returns null", () => null as unknown as Loose],
        [
            "throws",
            () => {
                throw new Error("step failed");
            },
        ],
    ];
    for (const [name, step] of badSteps) {
        it(`a step that ${name} never yields a loadable session`, () => {
            const raw = asV0(sessionWith(flightsA[0]));
            let status: string;
            try {
                status = migrateTuneSession(raw, { 0: step }, 1).status;
            } catch {
                status = "threw";
            }
            expect(status).not.toBe("migrated");
            expect(status).not.toBe("current");
            let rec: string;
            try {
                rec = readRecord(ID(1), raw, { 0: step }).status;
            } catch {
                rec = "threw";
            }
            expect(rec).not.toBe("ok");
        });
    }

    it("a migration cannot introduce an authorization or bytes", () => {
        const s = sessionWith(flightsA[0]);
        const auth = (r: Loose) => ({ ...V0_TO_V1(r), authorization: { status: "ALLOWED", reasons: [] } });
        expect(readRecord(s.id, asV0(s), { 0: auth }).status).toBe("corrupt");
        const yes = (r: Loose) => {
            const out = V0_TO_V1(r);
            out.flights[0].chirps[0].qualityV2.levels.tuningAuthorized.status = "YES";
            return out;
        };
        const r = readRecord(s.id, asV0(s), { 0: yes });
        expect(r.status === "ok" ? r.rejected.map((x) => x.path) : r.status).toEqual(["flights[0].chirps[0]"]);
        const bytes = (r: Loose) => ({ ...V0_TO_V1(r), raw: new Uint8Array(8) });
        expect(readRecord(s.id, asV0(s), { 0: bytes }).status).toBe("corrupt");
    });

    it("a v0 record with binary data is corrupt before any migration runs", () => {
        const s = sessionWith(flightsA[0]);
        const raw = asV0(s);
        raw.blob = new Uint8Array(4);
        const step = vi.fn(V0_TO_V1);
        expect(readRecord(s.id, raw, { 0: step }).status).toBe("corrupt");
        expect(step).not.toHaveBeenCalled();
    });

    it("a migration step does not mutate the stored raw record", () => {
        const s = sessionWith(flightsA[0]);
        const raw = asV0(s);
        const before = clone(raw);
        const mutating = (r: Loose) => {
            r.name = r.title;
            delete r.title;
            r.schemaVersion = 1;
            return r;
        };
        const rec = readRecord(s.id, raw, { 0: mutating });
        expect(rec.status).toBe("ok");
        expect(raw).toEqual(before);
    });
});

// --- storage -------------------------------------------------------------------------------------------------------

function rawDb(factory: IDBFactory): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = factory.open(TUNE_SESSION_DB_NAME);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function rawAll(factory: IDBFactory): Promise<Loose[]> {
    const db = await rawDb(factory);
    try {
        if (!db.objectStoreNames.contains(TUNE_SESSION_STORE)) {
            throw new Error("rawAll before the store created its database");
        }
        return await new Promise((resolve, reject) => {
            const req = db.transaction(TUNE_SESSION_STORE, "readonly").objectStore(TUNE_SESSION_STORE).getAll();
            req.onsuccess = () => resolve(req.result as Loose[]);
            req.onerror = () => reject(req.error);
        });
    } finally {
        db.close();
    }
}

async function rawPut(factory: IDBFactory, record: unknown): Promise<void> {
    const db = await rawDb(factory);
    try {
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(TUNE_SESSION_STORE, "readwrite");
            tx.objectStore(TUNE_SESSION_STORE).put(record);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } finally {
        db.close();
    }
}

async function expectCode(
    p: Promise<unknown> | (() => Promise<unknown>),
    code: string,
): Promise<TuneSessionStorageError> {
    let err: unknown = null;
    try {
        await (typeof p === "function" ? p() : p);
    } catch (e) {
        err = e;
    }
    expect(err).toBeInstanceOf(TuneSessionStorageError);
    expect((err as TuneSessionStorageError).code).toBe(code);
    return err as TuneSessionStorageError;
}

function newStore(factory: IDBFactory, extra: Partial<Parameters<typeof openTuneSessionStore>[0]> = {}) {
    let n = 0;
    let t = Date.parse(NOW);
    return openTuneSessionStore({
        indexedDB: factory,
        newId: () => ID(++n),
        now: () => new Date((t += 1000)),
        ...extra,
    });
}

describe("storage", () => {
    const stores: { close(): void }[] = [];
    const track = <T extends { close(): void }>(s: T): T => {
        stores.push(s);
        return s;
    };
    afterEach(() => {
        for (const s of stores.splice(0)) {
            s.close();
        }
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it("uses the documented database, version and object store", async () => {
        const factory = new IDBFactory();
        const store = track(newStore(factory));
        await store.list();
        const db = await rawDb(factory);
        expect(TUNE_SESSION_DB_NAME).toBe("gyroflight-gyrocore");
        expect(TUNE_SESSION_STORE).toBe("tuneSessions");
        expect(db.version).toBe(1);
        expect([...db.objectStoreNames]).toEqual([TUNE_SESSION_STORE]);
        const tx = db.transaction(TUNE_SESSION_STORE, "readonly");
        expect(tx.objectStore(TUNE_SESSION_STORE).keyPath).toBe("id");
        db.close();
    });

    it("create, load, list, save and remove keep plain JSON, without bytes or authorization", async () => {
        const factory = new IDBFactory();
        const store = track(newStore(factory));
        const live = await analyze(multi, "multi.bbl");
        for (const m of live.measurements) {
            m.qualityV2.levels.tuningAuthorized = { status: "YES", role: "ACTIVE_GATE", reasons: [] };
        }
        const flights = flightsFromReport(live, opts("multi.bbl")).flights;
        const created = await store.create("Bench", flights);
        expect(created.id).toBe(ID(1));
        expect(created.name).toBe("Bench");
        expect(created.flights.map((f) => f.key)).toEqual(flightsMulti.map((f) => f.key));
        expect(created.authorization).toEqual(SESSION_AUTHORIZATION);

        const loaded = await store.load(created.id);
        expect(loaded).toEqual({ status: "ok", session: created, rejected: [], migratedFrom: null });

        const raw = await rawAll(factory);
        expect(raw).toHaveLength(1);
        expect(binaryPaths(raw)).toEqual([]);
        expect(plainJsonProblems(raw[0])).toEqual([]);
        expect(raw[0].authorization).toEqual(SESSION_AUTHORIZATION);
        for (const level of tuningLevels(raw)) {
            expectNotAuthorized(level);
        }
        const text = JSON.stringify(raw);
        for (const f of flightsMulti) {
            const section = multi.subarray(f.ref.section.byteBegin, f.ref.section.byteEnd);
            for (const sig of frameByteSignatures(section, f.ref.header.byteLength)) {
                expect(text).not.toContain(sig);
            }
        }
        // The live analysis keeps its own level.
        expect(live.measurements[0].qualityV2.levels.tuningAuthorized.status).toBe("YES");

        const list = await store.list();
        expect(list).toEqual([
            {
                id: created.id,
                status: "ok",
                name: "Bench",
                updatedAt: created.updatedAt,
                flightCount: 3,
                chirpCount: flightsMulti.reduce((n, f) => n + f.chirps.length, 0),
            },
        ]);

        const edited = removeFlight(created, flightsMulti[1].key, LATER);
        const saved = await store.save(edited);
        const again = await store.load(created.id);
        expect(again.status === "ok" && again.session).toEqual(saved);
        expect(again.status === "ok" && again.session.flights.map((f) => f.key)).toEqual([
            flightsMulti[0].key,
            flightsMulti[2].key,
        ]);

        await store.remove(created.id);
        expect(await store.load(created.id)).toEqual({ status: "not_found", id: created.id });
        expect(await store.list()).toEqual([]);
        expect(await rawAll(factory)).toEqual([]);
    });

    it("load of an unknown id is not_found", async () => {
        const store = track(newStore(new IDBFactory()));
        expect(await store.load(ID(99))).toEqual({ status: "not_found", id: ID(99) });
    });

    it("create with a taken id is already_exists and leaves the record alone", async () => {
        const factory = new IDBFactory();
        const store = track(newStore(factory, { newId: () => ID(7) }));
        const first = await store.create("first", [flightsA[0]]);
        await expectCode(store.create("second"), "already_exists");
        const raw = await rawAll(factory);
        expect(raw).toHaveLength(1);
        expect(raw[0]).toEqual(clone(first));
    });

    it("create with invalid input writes nothing", async () => {
        const factory = new IDBFactory();
        const store = track(newStore(factory));
        await store.list();
        await expectCode(store.create("n".repeat(257)), "invalid_session");
        const bad = structuredCloneFlight(flightsA[0]);
        bad.chirps[0].qualityV2.raw = new Uint8Array(16);
        let threw = false;
        try {
            await store.create("bytes", [bad as StoredFlight]);
        } catch {
            threw = true;
        }
        expect(threw).toBe(true);
        const yes = clone(flightsA[0]);
        yes.chirps[0].qualityV2.levels.tuningAuthorized.status = "YES";
        await expectCode(store.create("auth", [yes]), "invalid_session");
        expect(await rawAll(factory)).toEqual([]);
        expect(await store.list()).toEqual([]);
    });

    it("save refuses an unknown id", async () => {
        const factory = new IDBFactory();
        const store = track(newStore(factory));
        await store.list();
        const s = newTuneSession({ id: ID(42), name: "never created", now: NOW });
        await expectCode(store.save(s), "not_found");
        expect(await rawAll(factory)).toEqual([]);
    });

    const INVALID_SAVES: [string, (s: Loose) => void][] = [
        ["name too long", (s) => (s.name = "n".repeat(257))],
        ["authorization", (s) => (s.authorization = { status: "ALLOWED", reasons: [] })],
        ["unknown field", (s) => (s.extra = 1)],
        ["NaN", (s) => (s.flights[0].analysis.targetPhaseMarginDeg = NaN)],
        ["bytes in qualityV2", (s) => (s.flights[0].chirps[0].qualityV2.raw = new Uint8Array(32))],
        ["bytes in ref", (s) => (s.flights[0].ref.bytes = new ArrayBuffer(8))],
        ["DataView", (s) => (s.flights[0].logHeaders = [["k", new DataView(new ArrayBuffer(4))]])],
        ["Blob", (s) => (s.flights[0].fileName = new Blob(["x"]))],
        ["stored authorization YES", (s) => (s.flights[0].chirps[0].qualityV2.levels.tuningAuthorized.status = "YES")],
        ["damaged Flight", (s) => (s.flights[0].key = "x")],
        ["damaged CHIRP", (s) => (s.flights[0].chirps[0].qualityV2.schema = "x")],
        ["schemaVersion 2", (s) => (s.schemaVersion = 2)],
        ["schemaVersion 0", (s) => (s.schemaVersion = 0)],
    ];
    for (const [name, mutate] of INVALID_SAVES) {
        it(`save refuses an invalid session whole and writes nothing: ${name}`, async () => {
            const factory = new IDBFactory();
            const store = track(newStore(factory));
            const created = await store.create("s", [flightsA[0]]);
            const before = await rawAll(factory);
            const s = structuredClone(created) as unknown as Loose;
            mutate(s);
            const err = await expectCode(store.save(s as TuneSession), "invalid_session");
            expect(err.problems.length).toBeGreaterThan(0);
            expect(await rawAll(factory)).toEqual(before);
        });
    }

    const JSON_BYTES: [string, (s: Loose, bytes: Uint8Array) => void][] = [
        [
            "a number-keyed object inside qualityV2",
            (s, b) => (s.flights[0].chirps[0].qualityV2.excitation.raw = JSON.parse(JSON.stringify(b))),
        ],
        [
            "a number array inside qualityV2",
            (s, b) => (s.flights[0].chirps[0].qualityV2.excitation.raw = Array.from(b)),
        ],
        [
            "a number-keyed object inside the FlightRef",
            (s, b) => (s.flights[0].ref.raw = JSON.parse(JSON.stringify(b))),
        ],
        [
            "a latin-1 string inside qualityV2",
            (s, b) => (s.flights[0].chirps[0].qualityV2.provenance.raw = new TextDecoder("latin1").decode(b)),
        ],
    ];
    for (const [name, plant] of JSON_BYTES) {
        it(`file bytes as JSON never reach a stored record: ${name}`, async () => {
            const factory = new IDBFactory();
            const store = track(newStore(factory));
            const created = await store.create("s", [flightsA[0]]);
            const before = await rawAll(factory);
            const frames = simA.subarray(flightsA[0].ref.header.byteLength, flightsA[0].ref.header.byteLength + 2048);

            const direct = clone(created) as Loose;
            plant(direct, frames);
            let directResult: string;
            try {
                await store.save(direct as TuneSession);
                directResult = "saved";
            } catch (err) {
                directResult = err instanceof TuneSessionStorageError ? err.code : String(err);
            }

            // The same through addFlights: the flight is plain JSON, so its binary check cannot see it.
            const f = clone(flightsB[0]) as Loose;
            plant({ flights: [f] }, frames);
            let viaAdd: string;
            try {
                await store.save(addFlights(created, [f as StoredFlight], LATER).session);
                viaAdd = "saved";
            } catch (err) {
                viaAdd = err instanceof TuneSessionStorageError ? err.code : String(err);
            }

            const raw = await rawAll(factory);
            const text = JSON.stringify(raw);
            const win = Array.from(frames.subarray(64, 96));
            const leaked = [
                win.join(","),
                win.map((b, k) => `"${k + 64}":${b}`).join(","),
                JSON.stringify(new TextDecoder("latin1").decode(frames.subarray(64, 96))).slice(1, -1),
            ].some((sig) => text.includes(sig));
            expect({
                directResult,
                viaAdd,
                leaked,
                sizeGrew: text.length > JSON.stringify(before).length + 1000,
            }).toEqual({ directResult: "invalid_session", viaAdd: "invalid_session", leaked: false, sizeGrew: false });
        });
    }

    it("save does not mutate the session it is given", async () => {
        const store = track(newStore(new IDBFactory()));
        const created = await store.create("s", [flightsA[0]]);
        const edited = addFlights(created, [flightsB[0]], LATER).session;
        const before = clone(edited);
        const saved = await store.save(edited);
        expect(edited).toEqual(before);
        saved.flights.length = 0;
        const loaded = await store.load(created.id);
        expect(loaded.status === "ok" && loaded.session.flights).toHaveLength(2);
    });

    async function storeWithRaw(record: Loose | ((s: TuneSession) => Loose)) {
        const factory = new IDBFactory();
        const store = track(newStore(factory));
        const created = await store.create("s", [flightsA[0], flightsSeq[0]]);
        const raw = typeof record === "function" ? record(created) : record;
        await rawPut(factory, raw);
        return { factory, store, created, raw };
    }

    const DAMAGED: [string, (s: TuneSession) => Loose, string][] = [
        ["corrupt", (s) => ({ ...clone(s), authorization: { status: "ALLOWED", reasons: [] } }), "corrupt"],
        ["unsupported version", (s) => ({ ...clone(s), schemaVersion: 2 }), "unsupported_version"],
        [
            "rejected part",
            (s) => {
                const r = clone(s) as Loose;
                r.flights[1].chirps[0].qualityV2.levels.tuningAuthorized.status = "YES";
                return r;
            },
            "ok",
        ],
        ["binary", (s) => ({ ...clone(s), bytes: new Uint8Array(simA.subarray(0, 128)) }), "corrupt"],
    ];
    for (const [name, make, status] of DAMAGED) {
        it(`a damaged record (${name}) is reported, never overwritten without replaceDamaged`, async () => {
            const { factory, store, created, raw } = await storeWithRaw(make);
            const loaded = await store.load(created.id);
            expect(loaded.status).toBe(status);
            if (loaded.status === "ok") {
                expect(loaded.rejected.length).toBeGreaterThan(0);
            }
            const summary = (await store.list()).find((x) => x.id === created.id);
            expect(summary?.status).toBe(status);

            // Reading never repairs.
            expect(plain((await rawAll(factory))[0])).toEqual(plain(raw));

            const replacement = addFlights(created, [flightsB[0]], LATER).session;
            const err = await expectCode(store.save(replacement), "damaged_record");
            expect(err).toBeInstanceOf(TuneSessionStorageError);
            expect(plain((await rawAll(factory))[0])).toEqual(plain(raw));

            await store.save(replacement, { replaceDamaged: true });
            const after = await store.load(created.id);
            expect(after.status).toBe("ok");
            expect(after.status === "ok" && after.rejected).toEqual([]);
            expect(after.status === "ok" && after.session.flights.map((f) => f.key)).toEqual(
                replacement.flights.map((f) => f.key),
            );
            expect(binaryPaths(await rawAll(factory))).toEqual([]);
        });
    }

    it("replaceDamaged is not a way past validation", async () => {
        const { factory, store, created, raw } = await storeWithRaw((s) => ({ ...clone(s), schemaVersion: 7 }));
        const bad = clone(created) as Loose;
        bad.flights[0].chirps[0].qualityV2.levels.tuningAuthorized.status = "YES";
        await expectCode(store.save(bad as TuneSession, { replaceDamaged: true }), "invalid_session");
        const bytes = structuredClone(created) as unknown as Loose;
        bytes.flights[0].ref.raw = new Uint8Array(4);
        await expectCode(store.save(bytes as TuneSession, { replaceDamaged: true }), "invalid_session");
        expect(plain((await rawAll(factory))[0])).toEqual(plain(raw));
    });

    it("a raw record whose stored id differs from its key cannot be loaded as another session", async () => {
        const factory = new IDBFactory();
        const store = track(newStore(factory));
        const created = await store.create("s", [flightsA[0]]);
        const r = readRecord(ID(55), clone(created));
        expect(r.status).not.toBe("ok");
        expect((await store.load(created.id)).status).toBe("ok");
    });

    it("list shows damaged records with their status and never throws", async () => {
        const factory = new IDBFactory();
        const store = track(newStore(factory));
        const ok = await store.create("good", [flightsA[0]]);
        await rawPut(factory, { id: ID(50), schema: "nonsense", schemaVersion: 1 });
        await rawPut(factory, { ...clone(ok), id: ID(51), schemaVersion: 3 });
        await rawPut(factory, { id: ID(52), bytes: new Uint8Array(10) });
        const list = await store.list();
        const byId = new Map(list.map((x) => [x.id, x]));
        expect(list).toHaveLength(4);
        expect(byId.get(ok.id)?.status).toBe("ok");
        expect(byId.get(ID(50))?.status).toBe("corrupt");
        expect(byId.get(ID(51))?.status).toBe("unsupported_version");
        expect(byId.get(ID(52))?.status).toBe("corrupt");
        for (const id of [ID(50), ID(51), ID(52)]) {
            expect(byId.get(id)?.flightCount ?? null).toBeNull();
        }
    });

    it("migrates on load, does not rewrite on read, writes the current shape on the next save", async () => {
        const factory = new IDBFactory();
        const store = track(newStore(factory, { migrations: { 0: V0_TO_V1 } }));
        await store.list();
        const s = sessionWith(flightsA[0]);
        const v0 = asV0(s);
        await rawPut(factory, v0);
        const loaded = await store.load(s.id);
        expect(loaded).toEqual({ status: "ok", session: s, rejected: [], migratedFrom: 0 });
        expect((await rawAll(factory))[0]).toEqual(v0);
        expect((await store.list())[0].status).toBe("ok");
        await store.save(s);
        const raw = (await rawAll(factory))[0];
        expect(raw.schemaVersion).toBe(1);
        expect(raw.name).toBe(s.name);
        expect("title" in raw).toBe(false);
    });

    it("without its migration a v0 record is unsupported and protected", async () => {
        const factory = new IDBFactory();
        const store = track(newStore(factory));
        await store.list();
        const s = sessionWith(flightsA[0]);
        const v0 = asV0(s);
        await rawPut(factory, v0);
        expect(await store.load(s.id)).toEqual({ status: "unsupported_version", id: s.id, schemaVersion: 0 });
        await expectCode(store.save(s), "damaged_record");
        expect((await rawAll(factory))[0]).toEqual(v0);
    });

    const BROKEN_STEPS: [string, () => Loose][] = [
        [
            "throws",
            () => {
                throw new Error("boom");
            },
        ],
        ["returns null", () => null as unknown as Loose],
    ];
    for (const [name, step] of BROKEN_STEPS) {
        it(`a migration step that ${name} never breaks list or load`, async () => {
            const factory = new IDBFactory();
            const store = track(newStore(factory, { migrations: { 0: step } }));
            const good = await store.create("good", [flightsA[0]]);
            const s = newTuneSession({ id: ID(60), name: "old", now: NOW });
            await rawPut(factory, asV0(s));
            let loaded: string;
            try {
                loaded = (await store.load(ID(60))).status;
            } catch (err) {
                // Storage errors are TuneSessionStorageError with a code; anything else escaped.
                loaded = err instanceof TuneSessionStorageError ? `error:${err.code}` : `escaped:${String(err)}`;
            }
            expect.soft(loaded).not.toBe("ok");
            expect.soft(loaded).not.toMatch(/^escaped/);
            let list: Awaited<ReturnType<typeof store.list>> | string;
            try {
                list = await store.list();
            } catch (err) {
                list = `escaped:${String(err)}`;
            }
            // One record with a broken migration must not hide every other session.
            expect(typeof list === "string" ? list : list.find((x) => x.id === good.id)?.status).toBe("ok");
            expect(typeof list === "string" ? list : list.find((x) => x.id === ID(60))?.status).not.toBe("ok");
        });
    }

    it("no IndexedDB is unavailable", async () => {
        await expectCode(async () => {
            const s = openTuneSessionStore({ indexedDB: null });
            stores.push(s);
            return s.list();
        }, "unavailable");
        vi.stubGlobal("indexedDB", undefined);
        await expectCode(async () => {
            const s = openTuneSessionStore();
            stores.push(s);
            return s.create("x");
        }, "unavailable");
    });

    it("an open that throws or fails is unavailable", async () => {
        const throwing = {
            open() {
                throw new DOMException("denied", "SecurityError");
            },
        } as unknown as IDBFactory;
        await expectCode(async () => track(openTuneSessionStore({ indexedDB: throwing })).list(), "unavailable");

        const failing = {
            open() {
                const req = new FakeRequest();
                setTimeout(() => req.fail(new DOMException("private mode", "InvalidStateError")), 0);
                return req;
            },
        } as unknown as IDBFactory;
        await expectCode(async () => track(openTuneSessionStore({ indexedDB: failing })).load(ID(1)), "unavailable");
    });

    it("a blocked open is blocked", async () => {
        const blocking = {
            open() {
                const req = new FakeRequest();
                setTimeout(() => req.fire("blocked"), 0);
                return req;
            },
        } as unknown as IDBFactory;
        await expectCode(async () => track(openTuneSessionStore({ indexedDB: blocking })).list(), "blocked");
    }, 5000);

    it("a full disk is quota_exceeded, and the stored record is unchanged", async () => {
        const factory = new IDBFactory();
        const store = track(newStore(factory));
        const created = await store.create("s", [flightsA[0]]);
        const before = await rawAll(factory);
        const quota = () => {
            throw new DOMException("full", "QuotaExceededError");
        };
        vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(quota);
        vi.spyOn(IDBObjectStore.prototype, "add").mockImplementation(quota);
        await expectCode(store.save(addFlights(created, [flightsB[0]], LATER).session), "quota_exceeded");
        await expectCode(store.create("another"), "quota_exceeded");
        vi.restoreAllMocks();
        expect(await rawAll(factory)).toEqual(before);
    });
});

/** A minimal IDBOpenDBRequest stand-in that fires its events both ways. */
class FakeRequest extends EventTarget {
    result: unknown = undefined;
    error: DOMException | null = null;
    readyState = "pending";
    onsuccess: ((e: Event) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    onblocked: ((e: Event) => void) | null = null;
    onupgradeneeded: ((e: Event) => void) | null = null;

    fire(type: "success" | "error" | "blocked" | "upgradeneeded") {
        const e = new Event(type);
        this.dispatchEvent(e);
        (this as unknown as Record<string, ((e: Event) => void) | null>)[`on${type}`]?.(e);
    }

    fail(err: DOMException) {
        this.error = err;
        this.readyState = "done";
        this.fire("error");
    }
}
