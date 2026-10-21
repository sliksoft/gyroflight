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
 * WU4 FIX 3: adding Flights to a stored Tune Session is one IndexedDB
 * readwrite transaction. Two independent store instances (two windows) on one
 * database stand in for real concurrency. SYNTHETIC logs only.
 */

import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../src/js/localization", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/js/localization")>()),
    i18n: { getMessage: (key: string) => key },
}));

import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { attachChirpFlightIdentity } from "../../src/gyrocore/chirp/qualityV2/identity";
import { useFlightAbSelector } from "../../src/gyrocore/composables/useFlightAbSelector";
import { PRODUCT_APPLY_PENDING, productApplyBlocks } from "../../src/gyrocore/productLock/productApply";
import { addFlights, flightsFromReport } from "../../src/gyrocore/session/build";
import { SESSION_AUTHORIZATION, type StoredFlight } from "../../src/gyrocore/session/contract";
import {
    openTuneSessionStore,
    TUNE_SESSION_DB_NAME,
    TUNE_SESSION_STORE,
    TuneSessionStorageError,
    type TuneSessionStore,
} from "../../src/gyrocore/session/storage";
import { concatLogs, encodeChirpLog, FULL_TUNE_HEADERS, simulateChirp } from "./harness/chirpSim";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** SYNTHETIC firmware identity, every field logged. */
const FW_HEADERS = [
    "Board information:SYNT SYNTHETIC",
    "Craft name:SYNTHETIC",
    "Firmware date:Jun  1 2026 12:00:00",
    "Firmware API version:1.48.0",
];

/** SYNTHETIC: one CHIRP log; `crossoverHz` makes its Flight distinct. */
function log(crossoverHz: number) {
    return encodeChirpLog(simulateChirp({ seconds: 6, firmwareDebug: true, crossoverHz }), [
        ...FULL_TUNE_HEADERS,
        ...FW_HEADERS,
    ]);
}

async function report(bytes: Uint8Array, fileName: string) {
    const r = qualifyChirpFile(bytes, fileName, 60, AUTOTUNE_MATH);
    await attachChirpFlightIdentity(r, bytes);
    return r;
}

async function flightsOf(bytes: Uint8Array, fileName: string): Promise<StoredFlight[]> {
    return flightsFromReport(await report(bytes, fileName), { fileName, analyzedAt: "2026-10-13T10:00:00.000Z" })
        .flights;
}

let baseFlight: StoredFlight;
let flightX: StoredFlight;
let flightY: StoredFlight;
let pair: StoredFlight[];

beforeAll(async () => {
    [baseFlight] = await flightsOf(log(40), "base.bbl");
    [flightX] = await flightsOf(log(30), "x.bbl");
    [flightY] = await flightsOf(log(35), "y.bbl");
    pair = await flightsOf(concatLogs(log(45), log(25)), "pair.bbl");
}, 60_000);

let ids = 0;
/** One window: its own store instance and its own database connection. */
function window(factory: IDBFactory, clock: string) {
    return openTuneSessionStore({ indexedDB: factory, now: () => new Date(clock), newId: () => `s${++ids}` });
}

/** The record exactly as it is in IndexedDB, read without the store. */
function rawRecord(factory: IDBFactory, id: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const req = factory.open(TUNE_SESSION_DB_NAME);
        req.onsuccess = () => {
            const get = req.result.transaction(TUNE_SESSION_STORE, "readonly").objectStore(TUNE_SESSION_STORE).get(id);
            get.onsuccess = () => (req.result.close(), resolve(get.result));
            get.onerror = () => reject(get.error);
        };
        req.onerror = () => reject(req.error);
    });
}

function putRaw(factory: IDBFactory, record: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
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

const keys = (r: unknown) => (r as Loose).flights.map((f: StoredFlight) => f.key);

async function setup() {
    const factory = new IDBFactory();
    const w1 = window(factory, "2026-10-13T11:00:00.000Z");
    const w2 = window(factory, "2026-10-13T12:00:00.000Z");
    // Created earlier by a third window, so a stale updatedAt is told apart from a fresh one.
    const creator = window(factory, "2026-10-13T10:00:00.000Z");
    const session = await creator.create("shared", [baseFlight]);
    creator.close();
    // Both connections open before the race.
    await Promise.all([w1.list(), w2.list()]);
    return { factory, w1, w2, session };
}

/** Records which connection issues each get/put, in the order IndexedDB runs them. */
function traceRequests(labels: Map<IDBDatabase, string>) {
    const order: string[] = [];
    const proto = IDBObjectStore.prototype as Loose;
    for (const op of ["get", "put"] as const) {
        const original = proto[op];
        vi.spyOn(proto, op).mockImplementation(function (this: Loose, ...args: unknown[]) {
            const req = original.apply(this, args);
            const label = labels.get(this.transaction.db) ?? "other";
            req.addEventListener("success", () => order.push(`${label}:${op}`));
            return req;
        });
    }
    return order;
}

/** The connection of a store instance, found by tracing one request through it. */
async function connectionOf(s: TuneSessionStore): Promise<IDBDatabase> {
    const proto = IDBObjectStore.prototype as Loose;
    let db: IDBDatabase | null = null;
    const original = proto.getAll;
    const spy = vi.spyOn(proto, "getAll").mockImplementation(function (this: Loose, ...args: unknown[]) {
        db = this.transaction.db;
        return original.apply(this, args);
    });
    await s.list();
    spy.mockRestore();
    return db!;
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("two windows add to one session at the same time", () => {
    it("different Flights: both are kept, and the transactions run one after the other", async () => {
        const { factory, w1, w2, session } = await setup();
        const labels = new Map([
            [await connectionOf(w1), "w1"],
            [await connectionOf(w2), "w2"],
        ]);
        const order = traceRequests(labels);
        const [r1, r2] = await Promise.all([
            w1.addFlightsAtomic(session.id, [flightX]),
            w2.addFlightsAtomic(session.id, [flightY]),
        ]);
        expect(order).toEqual(["w1:get", "w1:put", "w2:get", "w2:put"]);
        expect(r1.added).toEqual([flightX.key]);
        expect(r2.added).toEqual([flightY.key]);
        const stored = await rawRecord(factory, session.id);
        expect(keys(stored)).toEqual([baseFlight.key, flightX.key, flightY.key]);
        expect((stored as Loose).updatedAt).toBe("2026-10-13T12:00:00.000Z");
    });

    it("control: the old load → addFlights → save route loses one of the two in the same race", async () => {
        const { factory, w1, w2, session } = await setup();
        const [l1, l2] = await Promise.all([w1.load(session.id), w2.load(session.id)]);
        if (l1.status !== "ok" || l2.status !== "ok") {
            throw new Error("load");
        }
        await Promise.all([
            w1.save(addFlights(l1.session, [flightX], "2026-10-13T11:00:00.000Z").session),
            w2.save(addFlights(l2.session, [flightY], "2026-10-13T12:00:00.000Z").session),
        ]);
        expect(keys(await rawRecord(factory, session.id))).toEqual([baseFlight.key, flightY.key]);
    });

    it("the same Flight: one succeeds, the other is refused, and it is stored once", async () => {
        const { factory, w1, w2, session } = await setup();
        const results = await Promise.allSettled([
            w1.addFlightsAtomic(session.id, [flightX]),
            w2.addFlightsAtomic(session.id, [flightX]),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
        const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
        expect(refused.reason).toBeInstanceOf(TuneSessionStorageError);
        expect(refused.reason).toMatchObject({ code: "flight_already_in_session", problems: [flightX.key] });
        expect(keys(await rawRecord(factory, session.id))).toEqual([baseFlight.key, flightX.key]);
    });

    it("a window with an old copy never writes that copy's Flight list or updatedAt back", async () => {
        const { factory, w1, w2, session } = await setup();
        const stale = await w1.load(session.id); // w1's view, before w2 writes
        await w2.addFlightsAtomic(session.id, [flightY]);
        await w1.addFlightsAtomic(session.id, [flightX]);
        const stored = await rawRecord(factory, session.id);
        expect(stale.status === "ok" && stale.session.flights.map((f) => f.key)).toEqual([baseFlight.key]);
        expect(keys(stored)).toEqual([baseFlight.key, flightY.key, flightX.key]);
        expect((stored as Loose).updatedAt).toBe("2026-10-13T11:00:00.000Z");
        expect(stale.status === "ok" && stale.session.updatedAt).toBe("2026-10-13T10:00:00.000Z");
    });

    it("through the selector: Add analysis keeps a Flight another window stored after this one opened the session", async () => {
        const { factory, w1, w2, session } = await setup();
        const sel = useFlightAbSelector({ store: w1 });
        await sel.openSession(session.id);
        await w2.addFlightsAtomic(session.id, [flightY]);
        const out = await sel.saveAnalysis(await report(log(30), "x.bbl"), { intoOpenSession: true, name: "" });
        expect(out.status).toBe("saved");
        expect(keys(await rawRecord(factory, session.id))).toEqual([baseFlight.key, flightY.key, flightX.key]);
        expect(sel.flights.value.options.map((o) => o.key)).toEqual([baseFlight.key, flightY.key, flightX.key]);
    });
});

describe("all or nothing", () => {
    it("a batch with one Flight already stored is refused whole", async () => {
        const factory = new IDBFactory();
        const w = window(factory, "2026-10-13T11:00:00.000Z");
        const session = await w.create("s", [pair[0]]);
        const before = await rawRecord(factory, session.id);
        await expect(w.addFlightsAtomic(session.id, [flightX, pair[0], pair[1]])).rejects.toMatchObject({
            code: "flight_already_in_session",
            problems: [pair[0].key],
        });
        expect(await rawRecord(factory, session.id)).toEqual(before);
    });

    it("data that cannot be stored is refused and nothing is written", async () => {
        const factory = new IDBFactory();
        const w = window(factory, "2026-10-13T11:00:00.000Z");
        const session = await w.create("s", [baseFlight]);
        const before = await rawRecord(factory, session.id);
        const bad = { ...json(flightX), fileName: new Uint8Array(4) } as unknown as StoredFlight;
        await expect(w.addFlightsAtomic(session.id, [bad])).rejects.toMatchObject({ code: "invalid_session" });
        expect(await rawRecord(factory, session.id)).toEqual(before);
    });
});

describe("the record changed before the transaction", () => {
    it("deleted by another window: not_found, and it is not created again", async () => {
        const { factory, w1, w2, session } = await setup();
        const results = await Promise.allSettled([w2.remove(session.id), w1.addFlightsAtomic(session.id, [flightX])]);
        expect(results[0].status).toBe("fulfilled");
        expect((results[1] as PromiseRejectedResult).reason).toMatchObject({ code: "not_found" });
        expect(await rawRecord(factory, session.id)).toBeUndefined();
        expect(await w1.list()).toEqual([]);
    });

    it("damaged by another window: damaged_record, and the damaged record is left exactly as it is", async () => {
        const { factory, w1, session } = await setup();
        const damaged = json(session) as Loose;
        damaged.flights[0].chirps[0].durationS = -1;
        await putRaw(factory, damaged);
        await expect(w1.addFlightsAtomic(session.id, [flightX])).rejects.toMatchObject({ code: "damaged_record" });
        expect(await rawRecord(factory, session.id)).toEqual(damaged);
    });

    it("corrupt or of an unsupported version: damaged_record, never written", async () => {
        const { factory, w1, session } = await setup();
        for (const record of [
            { ...json(session), authorization: { status: "GRANTED" } },
            { ...json(session), schemaVersion: 99 },
        ]) {
            await putRaw(factory, record);
            const err = await w1.addFlightsAtomic(session.id, [flightX]).catch((e: unknown) => e);
            expect(err).toMatchObject({ code: "damaged_record" });
            expect(await rawRecord(factory, session.id)).toEqual(record);
        }
    });
});

describe("transaction failures", () => {
    it("an abort after the write rolls it back and is reported as a failure, never as saved", async () => {
        const factory = new IDBFactory();
        const w = window(factory, "2026-10-13T11:00:00.000Z");
        const session = await w.create("s", [baseFlight]);
        await w.list();
        const before = await rawRecord(factory, session.id);
        const proto = IDBObjectStore.prototype as Loose;
        const put = proto.put;
        vi.spyOn(proto, "put").mockImplementation(function (this: Loose, ...args: unknown[]) {
            const req = put.apply(this, args);
            this.transaction.abort();
            return req;
        });
        await expect(w.addFlightsAtomic(session.id, [flightX])).rejects.toBeInstanceOf(TuneSessionStorageError);
        vi.restoreAllMocks();
        expect(await rawRecord(factory, session.id)).toEqual(before);
    });

    it("a quota error is reported as quota_exceeded; the selector shows an error, not a save", async () => {
        const factory = new IDBFactory();
        const w = window(factory, "2026-10-13T11:00:00.000Z");
        const session = await w.create("s", [baseFlight]);
        const before = await rawRecord(factory, session.id);
        const sel = useFlightAbSelector({ store: w });
        await sel.openSession(session.id);
        const proto = IDBObjectStore.prototype as Loose;
        vi.spyOn(proto, "put").mockImplementation(() => {
            throw new DOMException("full", "QuotaExceededError");
        });
        await expect(w.addFlightsAtomic(session.id, [flightX])).rejects.toMatchObject({ code: "quota_exceeded" });
        const out = await sel.saveAnalysis(await report(log(30), "x.bbl"), { intoOpenSession: true, name: "" });
        expect(out).toMatchObject({ status: "error", error: "quota_exceeded", sessionId: null });
        vi.restoreAllMocks();
        expect(await rawRecord(factory, session.id)).toEqual(before);
    });

    it("no IndexedDB: unavailable", async () => {
        const w = openTuneSessionStore({ indexedDB: null });
        await expect(w.addFlightsAtomic("x", [flightX])).rejects.toMatchObject({ code: "unavailable" });
    });
});

describe("a successful add authorizes nothing", () => {
    it("the stored session and its CHIRPs carry no tuning or Apply authorization; the product lock stays", async () => {
        const factory = new IDBFactory();
        const w = window(factory, "2026-10-13T11:00:00.000Z");
        const session = await w.create("s", [baseFlight]);
        const r = await w.addFlightsAtomic(session.id, [flightX]);
        const stored = (await rawRecord(factory, session.id)) as Loose;
        for (const s of [r.session, stored]) {
            expect(s.authorization).toEqual(SESSION_AUTHORIZATION);
            for (const f of s.flights) {
                for (const c of f.chirps) {
                    expect(c.qualityV2.levels.tuningAuthorized.status).toBe("UNKNOWN");
                }
            }
        }
        expect(productApplyBlocks()).toEqual([PRODUCT_APPLY_PENDING, "independent_pid_validation_missing"]);
    });
});
