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
 * WU3 Tune Session storage: contract, validation, migrations and IndexedDB
 * persistence (fake-indexeddb). SYNTHETIC logs only.
 */

import { IDBFactory } from "fake-indexeddb";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { CHIRP_QUALITY_V2_ANALYSIS_VERSION, QV2_REASONS } from "../../src/gyrocore/chirp/qualityV2/contract";
import { attachChirpFlightIdentity } from "../../src/gyrocore/chirp/qualityV2/identity";
import { catalogBbl, type FlightRef } from "../../src/gyrocore/flight/identity";
import {
    addFlights,
    analysisVersionStatus,
    flightPairEvidence,
    flightsFromReport,
    newTuneSession,
    removeFlight,
} from "../../src/gyrocore/session/build";
import {
    SESSION_AUTHORIZATION,
    TUNE_SESSION_SCHEMA_VERSION,
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
import { migrateTuneSession, plainJsonProblems, validateTuneSession } from "../../src/gyrocore/session/validate";
import { concatLogs, encodeChirpLog, simulateChirp } from "./harness/chirpSim";
import { readFixtureBytes, readFixtureJson } from "./harness/fixtures";

vi.mock("../../src/js/localization", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/js/localization")>()),
    i18n: { getMessage: (key: string) => key },
}));

const CASES = new Map(
    readFixtureJson<{ cases: { case_id: string; bbl: string }[] }>("chirp/cases.json").cases.map(
        (c) => [c.case_id, c.bbl] as const,
    ),
);
const fixture = (id: string) => readFixtureBytes(`chirp/${CASES.get(id)!}`);
const clean = fixture("clean_single_axis");
const noisy = fixture("noisy");
const threeAxis = fixture("three_axis_sequence");
const T0 = "2026-10-10T20:00:00.000Z";

async function analyze(bytes: Uint8Array, fileName = "synthetic.bbl") {
    const report = qualifyChirpFile(bytes, fileName, 60, AUTOTUNE_MATH);
    await attachChirpFlightIdentity(report, bytes);
    return flightsFromReport(report, { fileName, analyzedAt: T0 });
}

function editHeader(bytes: Uint8Array, from: string, to: string): Uint8Array {
    const text = new TextDecoder("latin1").decode(bytes);
    const at = text.indexOf(from);
    expect(at).toBeGreaterThan(0);
    const out = new Uint8Array(bytes.length - from.length + to.length);
    out.set(bytes.subarray(0, at));
    out.set(
        Uint8Array.from(to, (c) => c.charCodeAt(0)),
        at,
    );
    out.set(bytes.subarray(at + from.length), at + to.length);
    return out;
}

let ids = 0;
function store(factory = new IDBFactory(), extra: Parameters<typeof openTuneSessionStore>[0] = {}) {
    return openTuneSessionStore({
        indexedDB: factory,
        now: () => new Date(T0),
        newId: () => `session-${++ids}`,
        ...extra,
    });
}

/** Write a raw record straight into the store, bypassing validation (simulated damage). */
async function putRaw(factory: IDBFactory, record: unknown) {
    const s = store(factory);
    await s.list(); // opens and creates the database
    s.close();
    await new Promise<void>((resolve, reject) => {
        const req = factory.open(TUNE_SESSION_DB_NAME);
        req.onsuccess = () => {
            const tx = req.result.transaction(TUNE_SESSION_STORE, "readwrite");
            tx.objectStore(TUNE_SESSION_STORE).put(record);
            tx.oncomplete = () => (req.result.close(), resolve());
            tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
    });
}

const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("building a session from an analysis", () => {
    it("stores one Flight per log with all its CHIRPs, under the WU1 FlightRef", async () => {
        const bytes = concatLogs(clean, noisy, threeAxis);
        const { flights, skipped } = await analyze(bytes);
        const catalog = await catalogBbl(bytes);
        expect(skipped).toEqual([]);
        expect(flights.map((f) => f.key)).toEqual(catalog.flights.map((f) => f.locationId));
        expect(flights.map((f) => f.ref)).toEqual(json(catalog.flights));
        expect(flights.map((f) => f.chirps.length)).toEqual([1, 1, 3]);
        const multi = flights[2];
        expect(new Set(multi.chirps.map((c) => c.measurementId)).size).toBe(3);
        for (const c of multi.chirps) {
            expect(c.logIndex).toBe(2);
            expect(c.qualityV2.identity.flight.ref?.locationId).toBe(multi.key);
            expect(c.qualityV2.analysisVersion).toBe(CHIRP_QUALITY_V2_ANALYSIS_VERSION);
        }
    });

    it("never stores a tuning authorization, even for an authorized CHIRP", async () => {
        const bytes = encodeChirpLog(simulateChirp({ firmwareDebug: true }));
        const report = qualifyChirpFile(bytes, "a.bbl", 60, AUTOTUNE_MATH);
        await attachChirpFlightIdentity(report, bytes);
        expect(report.measurements[0].apply.allowed).toBe(true);
        expect(report.measurements[0].qualityV2.levels.tuningAuthorized.status).toBe("YES");
        const [f] = flightsFromReport(report, { fileName: "a.bbl", analyzedAt: T0 }).flights;
        const stored = f.chirps[0].qualityV2;
        expect(stored.levels.tuningAuthorized).toEqual({
            status: "UNKNOWN",
            role: "ACTIVE_GATE",
            reasons: [QV2_REASONS.authorizationNotPersisted, QV2_REASONS.authorizationScope],
        });
        expect(stored.reasons).toContain(QV2_REASONS.authorizationNotPersisted);
        // The live analysis is untouched.
        expect(report.measurements[0].qualityV2.levels.tuningAuthorized.status).toBe("YES");
        expect(newTuneSession({ id: "x", name: "", now: T0 }).authorization).toEqual(SESSION_AUTHORIZATION);
    });

    it("skips a log without a WU1 identity instead of inventing one", async () => {
        const report = qualifyChirpFile(clean, "a.bbl", 60, AUTOTUNE_MATH);
        expect(flightsFromReport(report, { fileName: null, analyzedAt: T0 })).toEqual({
            flights: [],
            skipped: [{ logIndex: 0, reasons: ["flight_identity_unknown"] }],
        });
    });

    it("keeps missing firmware evidence as UNKNOWN, named", async () => {
        const [f] = (await analyze(encodeChirpLog(simulateChirp({ firmwareDebug: true })))).flights;
        expect(f.firmware.firmwareRevision).toBe("Betaflight 2026.6.2 (synthetic) STM32F7X2");
        for (const k of f.firmware.unknown) {
            expect(f.firmware[k as keyof typeof f.firmware]).toBeNull();
        }
        expect(f.firmware.unknown).toContain("craftName");
    });

    it("holds no file bytes: plain JSON, far smaller than the log, no frame data", async () => {
        const bytes = concatLogs(clean, noisy, threeAxis);
        const { flights } = await analyze(bytes);
        const session = addFlights(newTuneSession({ id: "s", name: "n", now: T0 }), flights, T0).session;
        expect(plainJsonProblems(session)).toEqual([]);
        const text = JSON.stringify(session);
        const latin1 = new TextDecoder("latin1").decode(bytes);
        for (const f of flights) {
            const body = f.ref.section.byteBegin + f.ref.header.byteLength;
            expect(text.includes(latin1.slice(body + 100, body + 164))).toBe(false);
        }
    });
});

describe("Flights in a session", () => {
    it("several Flights of one BBL are separate and independent", async () => {
        const { flights } = await analyze(concatLogs(clean, noisy));
        const s = addFlights(newTuneSession({ id: "s", name: "", now: T0 }), flights, T0).session;
        expect(s.flights).toHaveLength(2);
        const e = flightPairEvidence(s, flights[0].key, flights[1].key);
        expect(e.independence).toMatchObject({ independent: true, relation: "distinct" });
        expect(e.analysisVersions).toEqual({ a: "CURRENT", b: "CURRENT", same: true });
    });

    it("Flights from different BBL files", async () => {
        const a = (await analyze(clean, "a.bbl")).flights;
        const b = (await analyze(noisy, "b.bbl")).flights;
        const r = addFlights(addFlights(newTuneSession({ id: "s", name: "", now: T0 }), a, T0).session, b, T0);
        expect(r.added).toEqual([b[0].key]);
        expect(r.notIndependent).toEqual([]);
        expect(r.session.flights.map((f) => f.ref.file.sha256)).toEqual([a[0].ref.file.sha256, b[0].ref.file.sha256]);
        expect(flightPairEvidence(r.session, a[0].key, b[0].key).independence.independent).toBe(true);
    });

    it("the same Flight added twice is one entry, and never an A/B pair with itself", async () => {
        const { flights } = await analyze(threeAxis);
        const once = addFlights(newTuneSession({ id: "s", name: "", now: T0 }), flights, T0).session;
        const twice = addFlights(once, flights, T0);
        expect(twice.replaced).toEqual([flights[0].key]);
        expect(twice.session.flights).toHaveLength(1);
        const e = flightPairEvidence(twice.session, flights[0].key, flights[0].key);
        expect(e.independence).toMatchObject({ independent: false, relation: "same_section" });
        expect(e.blockers).toContain("same_flight_section");
    });

    it("two CHIRPs of one Flight are never two flights", async () => {
        const { flights } = await analyze(threeAxis);
        expect(flights).toHaveLength(1);
        expect(new Set(flights[0].chirps.map((c) => c.qualityV2.identity.flight.ref?.locationId))).toEqual(
            new Set([flights[0].key]),
        );
    });

    it("a repackaged copy in another file is stored but reported as the same recording", async () => {
        const copy = editHeader(clean, "H Board information:SYNT SYNTHETIC", "H Board information:ELSEWHERE");
        const a = (await analyze(clean, "a.bbl")).flights;
        const b = (await analyze(copy, "copy.bbl")).flights;
        const r = addFlights(addFlights(newTuneSession({ id: "s", name: "", now: T0 }), a, T0).session, b, T0);
        expect(r.added).toEqual([b[0].key]);
        expect(r.notIndependent).toEqual([{ key: b[0].key, otherKey: a[0].key, reasons: ["same_flight_content"] }]);
        const e = flightPairEvidence(r.session, a[0].key, b[0].key);
        expect(e.blockers).toEqual(
            expect.arrayContaining(["same_flight_content", "firmware_mismatch:boardInformation"]),
        );
    });

    it("an unknown or outdated analysis version is never silently comparable", async () => {
        const { flights } = await analyze(concatLogs(clean, noisy));
        const old = json(flights);
        old[1].chirps[0].qualityV2.analysisVersion = "2.0.0" as never;
        const s = addFlights(newTuneSession({ id: "s", name: "", now: T0 }), old, T0).session;
        const e = flightPairEvidence(s, old[0].key, old[1].key);
        expect(e.analysisVersions).toEqual({ a: "CURRENT", b: "OUTDATED", same: false });
        expect(e.blockers).toEqual(expect.arrayContaining(["analysis_version_outdated:b", "analysis_version_differs"]));
        expect(analysisVersionStatus("9.9.9")).toBe("UNKNOWN_VERSION");
        expect(analysisVersionStatus(undefined)).toBe("UNKNOWN_VERSION");
        expect(analysisVersionStatus("2.1.0")).toBe("CURRENT");
    });

    it("firmware differences and unknowns block a pair; MATCH needs both values", async () => {
        const { flights } = await analyze(concatLogs(clean, noisy));
        const s = addFlights(newTuneSession({ id: "s", name: "", now: T0 }), flights, T0).session;
        const e = flightPairEvidence(s, flights[0].key, flights[1].key);
        for (const [k, status] of Object.entries(e.firmware)) {
            const a = flights[0].firmware[k as keyof typeof e.firmware];
            const b = flights[1].firmware[k as keyof typeof e.firmware];
            expect(status).toBe(a === null || b === null ? "UNKNOWN" : a === b ? "MATCH" : "MISMATCH");
            expect(e.blockers.some((x) => x.endsWith(`:${k}`))).toBe(status !== "MATCH");
        }
        expect(flightPairEvidence(s, flights[0].key, "nope").blockers).toEqual(
            expect.arrayContaining(["flight_not_in_session:b", "flight_b_identity_incomplete"]),
        );
    });

    it("removes a Flight by key", async () => {
        const { flights } = await analyze(concatLogs(clean, noisy));
        const s = addFlights(newTuneSession({ id: "s", name: "", now: T0 }), flights, T0).session;
        expect(removeFlight(s, flights[0].key, T0).flights.map((f) => f.key)).toEqual([flights[1].key]);
    });
});

describe("IndexedDB persistence", () => {
    it("creates, reloads in a new connection, lists, updates and removes", async () => {
        const factory = new IDBFactory();
        const { flights } = await analyze(concatLogs(clean, threeAxis));
        const s1 = store(factory);
        const created = await s1.create("Bench session", flights);
        s1.close();
        const s2 = store(factory);
        const loaded = await s2.load(created.id);
        expect(loaded).toEqual({ status: "ok", session: created, rejected: [], migratedFrom: null });
        expect(await s2.list()).toEqual([
            { id: created.id, status: "ok", name: "Bench session", updatedAt: T0, flightCount: 2, chirpCount: 4 },
        ]);
        const fewer = removeFlight(created, flights[0].key, T0);
        await s2.save({ ...fewer, name: "renamed" });
        const again = await s2.load(created.id);
        expect(again.status === "ok" && again.session.name).toBe("renamed");
        expect(again.status === "ok" && again.session.flights.length).toBe(1);
        await s2.remove(created.id);
        expect(await s2.load(created.id)).toEqual({ status: "not_found", id: created.id });
        await expect(s2.save(created)).rejects.toMatchObject({ code: "not_found" });
    });

    it("refuses a duplicate id, an invalid session and binary data", async () => {
        const factory = new IDBFactory();
        const fixed = store(factory, { newId: () => "same" });
        await fixed.create("a");
        await expect(fixed.create("b")).rejects.toMatchObject({ code: "already_exists" });
        const { flights } = await analyze(clean);
        const withBytes = json(flights);
        (withBytes[0] as unknown as { bbl: Uint8Array }).bbl = clean;
        await expect(store(factory).create("x", withBytes)).rejects.toMatchObject({
            code: "invalid_session",
            problems: ["binary_data"],
        });
        const badRef = json(flights);
        badRef[0].ref.section.sha256 = "0".repeat(63);
        await expect(store(factory).create("x", badRef)).rejects.toMatchObject({ code: "invalid_session" });
    });

    it("stored records are plain objects without typed arrays", async () => {
        const factory = new IDBFactory();
        const { flights } = await analyze(concatLogs(clean, noisy, threeAxis));
        const created = await store(factory).create("s", flights);
        const raw = await new Promise<unknown>((resolve) => {
            const req = factory.open(TUNE_SESSION_DB_NAME);
            req.onsuccess = () => {
                const get = req.result.transaction(TUNE_SESSION_STORE).objectStore(TUNE_SESSION_STORE).get(created.id);
                get.onsuccess = () => (req.result.close(), resolve(get.result));
            };
        });
        expect(plainJsonProblems(raw)).toEqual([]);
        expect(raw).toEqual(json(created));
    });
});

describe("damaged and old records", () => {
    async function goodSession(): Promise<TuneSession> {
        const { flights } = await analyze(concatLogs(clean, threeAxis));
        return addFlights(newTuneSession({ id: "rec", name: "r", now: T0 }), flights, T0).session;
    }

    it("a damaged FlightRef leaves that Flight out, and the record is not overwritten unasked", async () => {
        const factory = new IDBFactory();
        const s = await goodSession();
        const bad = json(s);
        (bad.flights[0].ref as FlightRef).section.byteEnd = 10 ** 12;
        await putRaw(factory, bad);
        const st = store(factory);
        const r = await st.load("rec");
        expect(r.status).toBe("ok");
        if (r.status !== "ok") return;
        expect(r.rejected).toEqual([{ path: "flights[0]", problems: ["identity:section"] }]);
        expect(r.session.flights.map((f) => f.key)).toEqual([s.flights[1].key]);
        await expect(st.save(r.session)).rejects.toMatchObject({ code: "damaged_record" });
        await st.save(r.session, { replaceDamaged: true });
        expect(await st.load("rec")).toMatchObject({ status: "ok", rejected: [] });
    });

    it.each([
        ["no schema", (r: Record<string, unknown>) => delete r.schema, ["schema"]],
        ["bad timestamps", (r: Record<string, unknown>) => (r.createdAt = "yesterday"), ["timestamps"]],
        [
            "stored authorization",
            (r: Record<string, unknown>) => (r.authorization = { status: "YES" }),
            ["authorization"],
        ],
        ["flights not a list", (r: Record<string, unknown>) => (r.flights = {}), ["flights"]],
        [
            "NaN",
            (r: Record<string, unknown>) => ((r.flights as StoredFlight[])[0].chirps[0].durationS = NaN),
            ["non_finite_number"],
        ],
        ["file bytes", (r: Record<string, unknown>) => (r.bbl = new Uint8Array(8)), ["binary_data"]],
    ])("a session with %s is corrupt as a whole", async (_, damage, problems) => {
        const factory = new IDBFactory();
        const raw = json(await goodSession()) as unknown as Record<string, unknown>;
        damage(raw);
        await putRaw(factory, raw);
        const st = store(factory);
        expect(await st.load("rec")).toEqual({ status: "corrupt", id: "rec", problems });
        expect((await st.list())[0]).toMatchObject({ id: "rec", status: "corrupt", name: null });
        await expect(st.save(await goodSession())).rejects.toMatchObject({ code: "damaged_record" });
    });

    it("damaged CHIRP results are left out one by one", async () => {
        const raw = json(await goodSession());
        const f = raw.flights[1];
        f.chirps[0].qualityV2.schema = "something.else" as never;
        f.chirps[1].qualityV2.levels.tuningAuthorized = { status: "YES", role: "ACTIVE_GATE", reasons: [] };
        f.chirps[2].logIndex = 0;
        const r = readRecord("rec", raw);
        expect(r.status === "ok" && r.rejected).toEqual([
            { path: "flights[1].chirps[0]", problems: ["quality_v2_schema"] },
            { path: "flights[1].chirps[1]", problems: ["stored_authorization"] },
            {
                path: "flights[1].chirps[2]",
                problems: ["log_index", "measurement_id", "quality_v2_identity:logIndex"],
            },
        ]);
        expect(r.status === "ok" && r.session.flights[1].chirps).toEqual([]);
    });

    it("duplicate Flight keys and CHIRP ids are rejected", async () => {
        const raw = json(await goodSession());
        raw.flights.push(json(raw.flights[0]));
        raw.flights[1].chirps.push(json(raw.flights[1].chirps[0]));
        const r = validateTuneSession(raw);
        expect(r.ok && r.rejected).toEqual([
            { path: "flights[1].chirps[3]", problems: ["duplicate_measurement_id"] },
            { path: "flights[2]", problems: ["duplicate_key"] },
        ]);
    });

    it("migrates an older schema step by step, and refuses unknown versions", async () => {
        const v1 = json(await goodSession()) as unknown as Record<string, unknown>;
        const v0: Record<string, unknown> = { ...v1, schemaVersion: 0, title: v1.name };
        delete v0.name;
        const migrations = {
            0: (r: Record<string, unknown>) => ({ ...r, schemaVersion: 1, name: r.title, title: undefined }),
        };
        const up = migrateTuneSession(v0, migrations);
        expect(up.status).toBe("migrated");
        // JSON drops the undefined helper field when it is stored.
        expect(up.status === "migrated" && validateTuneSession(json(up.raw)).ok).toBe(true);
        expect(migrateTuneSession(v1).status).toBe("current");
        expect(migrateTuneSession({ ...v1, schemaVersion: TUNE_SESSION_SCHEMA_VERSION + 1 })).toEqual({
            status: "unsupported_version",
            schemaVersion: TUNE_SESSION_SCHEMA_VERSION + 1,
        });
        expect(migrateTuneSession(v0).status).toBe("unsupported_version"); // no migration registered
        expect(migrateTuneSession({ ...v1, schemaVersion: "1" }).status).toBe("unsupported_version");
        expect(migrateTuneSession(v0, { 0: (r) => r }).status).toBe("unsupported_version"); // step must advance

        const factory = new IDBFactory();
        await putRaw(factory, json(v0));
        const st = store(factory, {
            migrations: {
                0: (r) => {
                    const { title, ...rest } = r;
                    return { ...rest, schemaVersion: 1, name: title };
                },
            },
        });
        const loaded = await st.load("rec");
        expect(loaded).toMatchObject({ status: "ok", migratedFrom: 0 });
        // A future version is reported, not rewritten.
        await putRaw(factory, { ...v1, id: "future", schemaVersion: 99 });
        expect(await store(factory).load("future")).toEqual({
            status: "unsupported_version",
            id: "future",
            schemaVersion: 99,
        });
        await expect(store(factory).save({ ...(v1 as unknown as TuneSession), id: "future" })).rejects.toMatchObject({
            code: "damaged_record",
        });
    });
});

describe("storage errors", () => {
    it("no IndexedDB is a clear error, not a crash", async () => {
        const st = openTuneSessionStore({ indexedDB: null });
        await expect(st.list()).rejects.toMatchObject({ code: "unavailable" });
        await expect(st.create("x")).rejects.toBeInstanceOf(TuneSessionStorageError);
    });

    it("an open that throws (private mode) or is blocked is reported", async () => {
        const throwing = {
            open: () => {
                throw new DOMException("denied", "SecurityError");
            },
        } as unknown as IDBFactory;
        await expect(openTuneSessionStore({ indexedDB: throwing }).load("x")).rejects.toMatchObject({
            code: "unavailable",
        });
        const blocked = {
            open: () => {
                const req = {} as IDBOpenDBRequest & { onblocked: () => void };
                setTimeout(() => req.onblocked());
                return req;
            },
        } as unknown as IDBFactory;
        await expect(openTuneSessionStore({ indexedDB: blocked }).load("x")).rejects.toMatchObject({ code: "blocked" });
    });

    it("a full disk is quota_exceeded, and nothing half-written remains", async () => {
        const factory = new IDBFactory();
        const st = store(factory);
        await st.list();
        const proto = Object.getPrototypeOf(
            await new Promise<IDBObjectStore>((resolve) => {
                const req = factory.open(TUNE_SESSION_DB_NAME);
                req.onsuccess = () =>
                    resolve(req.result.transaction(TUNE_SESSION_STORE).objectStore(TUNE_SESSION_STORE));
            }),
        ) as IDBObjectStore;
        const add = vi.spyOn(proto, "add").mockImplementation(() => {
            throw new DOMException("full", "QuotaExceededError");
        });
        await expect(st.create("x")).rejects.toMatchObject({ code: "quota_exceeded" });
        add.mockRestore();
        expect(await st.list()).toEqual([]);
    });
});

describe("scope", () => {
    it("no gate, tuning, Safety or Apply code reads stored sessions", () => {
        const roots = ["src/gyrocore/tuning", "src/gyrocore/safety", "src/gyrocore/productLock", "src/composables"];
        const files = [
            ...roots.flatMap((d) => readdirSync(d, { recursive: true }).map((f) => join(d, String(f)))),
            "src/gyrocore/chirp/quality.ts",
            "src/gyrocore/chirp/applyGate.ts",
            "src/gyrocore/chirp/qualification.ts",
        ].filter((f) => /\.(ts|js|vue)$/.test(f));
        for (const f of files) {
            expect(readFileSync(f, "utf8"), f).not.toMatch(/gyrocore\/session|\.\.\/session\//);
        }
    });
});
