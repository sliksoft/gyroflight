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
 * WU4 Flight A/B Selector: selection logic, IndexedDB sequencing and the
 * component in Expert Mode. SYNTHETIC logs only: they exercise selection,
 * identity and error handling and are never flight evidence.
 */

import { IDBFactory } from "fake-indexeddb";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp, h, nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
};

const expert = vi.hoisted(() => ({ on: true }));
vi.mock("../../src/js/utils/isExpertModeEnabled", () => ({ isExpertModeEnabled: () => expert.on }));
vi.mock("../../src/js/localization", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/js/localization")>()),
    i18n: { getMessage: (key: string, args?: string[]) => (args?.length ? `${key}|${args.join("|")}` : key) },
}));

import UApp from "@nuxt/ui/components/App.vue";
import { EventBus } from "../../src/components/eventBus.js";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { CHIRP_QUALITY_V2_ANALYSIS_VERSION } from "../../src/gyrocore/chirp/qualityV2/contract";
import { attachChirpFlightIdentity } from "../../src/gyrocore/chirp/qualityV2/identity";
import FlightAbSelector from "../../src/gyrocore/components/FlightAbSelector.vue";
import { useFlightAbSelector } from "../../src/gyrocore/composables/useFlightAbSelector";
import { PRODUCT_APPLY_PENDING, productApplyBlocks } from "../../src/gyrocore/productLock/productApply";
import { addFlights, flightsFromReport, newTuneSession, removeFlight } from "../../src/gyrocore/session/build";
import type { LoadResult, StoredFlight, TuneSession } from "../../src/gyrocore/session/contract";
import {
    AB_REASONS,
    AB_SELECTION_AUTHORIZATION,
    abVerification,
    EMPTY_SELECTION,
    reconcileSelection,
    selectFlight,
    selectionForSession,
    sessionFlights,
    type AbSelection,
} from "../../src/gyrocore/session/selection";
import {
    openTuneSessionStore,
    TUNE_SESSION_DB_NAME,
    TUNE_SESSION_STORE,
    type TuneSessionStore,
} from "../../src/gyrocore/session/storage";
import { useChirpQualificationStore } from "../../src/gyrocore/stores/chirpQualification";
import { concatLogs, encodeChirpLog, FULL_TUNE_HEADERS, simulateChirp } from "./harness/chirpSim";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const T0 = "2026-10-10T20:00:00.000Z";
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** SYNTHETIC firmware identity, every field logged. */
const FW_HEADERS = [
    "Board information:SYNT SYNTHETIC",
    "Craft name:SYNTHETIC",
    "Firmware date:Jun  1 2026 12:00:00",
    "Firmware API version:1.48.0",
];

/** SYNTHETIC: one CHIRP log; `crossoverHz` makes its frame data, and so its Flight, distinct. */
function log(crossoverHz: number, extra: string[] = FW_HEADERS, start = "2026-10-10T12:00:00.000+00:00") {
    return encodeChirpLog(simulateChirp({ seconds: 6, firmwareDebug: true, crossoverHz }), [
        ...FULL_TUNE_HEADERS,
        ...extra,
        `Log start datetime:${start}`,
    ]);
}

function replaceText(bytes: Uint8Array, from: string, to: string): Uint8Array {
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

async function report(bytes: Uint8Array, fileName: string) {
    const r = qualifyChirpFile(bytes, fileName, 60, AUTOTUNE_MATH);
    await attachChirpFlightIdentity(r, bytes);
    return r;
}

async function flightsOf(bytes: Uint8Array, fileName: string): Promise<StoredFlight[]> {
    return flightsFromReport(await report(bytes, fileName), { fileName, analyzedAt: T0 }).flights;
}

let ids = 0;
function store(factory = new IDBFactory()) {
    return openTuneSessionStore({ indexedDB: factory, now: () => new Date(T0), newId: () => `session-${++ids}` });
}

/** Write a raw record straight into the store, bypassing validation (simulated damage). */
async function putRaw(factory: IDBFactory, record: unknown) {
    const s = store(factory);
    await s.list();
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

function inMemory(flights: StoredFlight[], id = "mem"): TuneSession {
    return json(addFlights(newTuneSession({ id, name: id, now: T0 }), flights, T0).session);
}

const ok = (session: TuneSession): LoadResult => ({ status: "ok", session, rejected: [], migratedFrom: null });

function pick(session: TuneSession, a: string | null, b: string | null): AbSelection {
    return { sessionId: session.id, a, b, cleared: [] };
}

/** SYNTHETIC Flights, built once through the real analysis and WU1 identity. */
let base: Uint8Array;
let flightA: StoredFlight;
let flightB: StoredFlight;
let twoInOne: StoredFlight[];
let copied: StoredFlight;
let repackaged: StoredFlight;
let noApi: StoredFlight[];
let otherRevision: StoredFlight;

beforeAll(async () => {
    base = log(40);
    [flightA] = await flightsOf(base, "a.bbl");
    [flightB] = await flightsOf(log(30, FW_HEADERS, "2026-10-10T12:10:00.000+00:00"), "b.bbl");
    twoInOne = await flightsOf(concatLogs(log(45), log(35)), "two.bbl");
    // The same log section appended to another recording: a copy in another file.
    [, copied] = await flightsOf(concatLogs(log(50), base), "copy.bbl");
    repackaged = (await flightsOf(replaceText(base, "Craft name:SYNTHETIC", "Craft name:RENAMED!"), "re.bbl"))[0];
    noApi = await flightsOf(concatLogs(log(41, FW_HEADERS.slice(0, 3)), log(31, FW_HEADERS.slice(0, 3))), "noapi.bbl");
    [otherRevision] = await flightsOf(
        replaceText(log(32), "Betaflight 2026.6.2 (synthetic)", "Betaflight 2026.6.3 (synthetic)"),
        "rev.bbl",
    );
}, 60_000);

describe("the SYNTHETIC fixtures", () => {
    it("log every firmware field, so a clean pair can be proven comparable", () => {
        expect(flightA.firmware.unknown).toEqual([]);
        expect(flightA.chirps[0].qualityV2.analysisVersion).toBe(CHIRP_QUALITY_V2_ANALYSIS_VERSION);
        expect(flightA.key).not.toBe(flightB.key);
    });
});

describe("selectable Flights", () => {
    it("lists every Flight with file, number, date, firmware, CHIRPs, axes and analysis version", () => {
        const f = sessionFlights(ok(inMemory([flightA, ...twoInOne])));
        expect(f.options.map((o) => o.key)).toEqual([flightA.key, twoInOne[0].key, twoInOne[1].key]);
        expect(f.options[2]).toMatchObject({
            fileName: "two.bbl",
            logNumber: 2,
            logCount: 2,
            logStart: "2026-10-10T12:00:00.000+00:00",
            chirpCount: 1,
            rejectedChirpCount: 0,
            axes: ["roll"],
            analysisVersions: [CHIRP_QUALITY_V2_ANALYSIS_VERSION],
            analysisStatus: "CURRENT",
            selectable: true,
            reasons: [],
        });
        expect(f.options[0].firmware.boardInformation).toBe("SYNT SYNTHETIC");
    });

    it("a session with no Flights, and a load that is not ok, offer nothing", () => {
        expect(sessionFlights(ok(inMemory([])))).toEqual({ options: [], rejected: [] });
        expect(sessionFlights({ status: "corrupt", id: "x", problems: ["schema"] })).toEqual({
            options: [],
            rejected: [],
        });
        expect(sessionFlights(null)).toEqual({ options: [], rejected: [] });
    });

    it("an unreadable Flight or one without valid CHIRPs is not selectable, with the reason", () => {
        const s = inMemory([flightA, flightB]);
        (s.flights[0].ref as Loose).status = "invalid";
        (s.flights[0].ref as Loose).reasons = ["log_unreadable:synthetic"];
        s.flights[1].chirps = [];
        const [a, b] = sessionFlights(ok(s)).options;
        expect(a).toMatchObject({
            selectable: false,
            reasons: [AB_REASONS.flightUnreadable, "log_unreadable:synthetic"],
        });
        expect(b).toMatchObject({ selectable: false, reasons: [AB_REASONS.noChirps] });
    });
});

describe("selection state", () => {
    const s = () => inMemory([flightA, flightB, ...twoInOne]);

    it("choosing A never changes B and the other way round", () => {
        const session = s();
        const f = sessionFlights(ok(session));
        let sel = selectionForSession(EMPTY_SELECTION, session.id);
        sel = selectFlight(sel, session.id, f, "b", flightB.key);
        sel = selectFlight(sel, session.id, f, "a", flightA.key);
        expect(sel).toMatchObject({ a: flightA.key, b: flightB.key });
        sel = selectFlight(sel, session.id, f, "a", twoInOne[0].key);
        expect(sel).toMatchObject({ a: twoInOne[0].key, b: flightB.key });
        sel = selectFlight(sel, session.id, f, "b", null);
        expect(sel).toMatchObject({ a: twoInOne[0].key, b: null });
    });

    it("refuses an unknown key, a key of a non-selectable Flight and a choice for another session", () => {
        const session = s();
        session.flights[3].chirps = [];
        const f = sessionFlights(ok(session));
        const sel = selectionForSession(EMPTY_SELECTION, session.id);
        expect(selectFlight(sel, session.id, f, "a", "0")).toBe(sel);
        expect(selectFlight(sel, session.id, f, "a", twoInOne[1].key)).toBe(sel);
        expect(selectFlight(sel, "other", f, "a", flightA.key)).toBe(sel);
    });

    it("keys are FlightRef locationIds: reordering the session keeps the choice on the same Flight", () => {
        const session = s();
        const f = sessionFlights(ok(session));
        const sel = selectFlight(selectionForSession(EMPTY_SELECTION, session.id), session.id, f, "a", flightB.key);
        const reordered = { ...session, flights: [...session.flights].reverse() };
        const again = reconcileSelection(sel, session.id, sessionFlights(ok(reordered)));
        expect(again.a).toBe(flightB.key);
        expect(abVerification(reordered, { ...again, b: flightA.key }).evidence?.keyA).toBe(flightB.key);
    });

    it("another session clears both choices; the same session keeps them", () => {
        const sel: AbSelection = { sessionId: "one", a: "x", b: "y", cleared: [] };
        expect(selectionForSession(sel, "one")).toBe(sel);
        expect(selectionForSession(sel, "two")).toEqual({
            sessionId: "two",
            a: null,
            b: null,
            cleared: [AB_REASONS.sessionChanged],
        });
    });

    it("a reload clears only the side whose Flight is gone or no longer selectable", () => {
        const session = s();
        const sel = pick(session, flightA.key, flightB.key);
        const gone = removeFlight(session, flightB.key, T0);
        expect(reconcileSelection(sel, session.id, sessionFlights(ok(gone)))).toEqual({
            sessionId: session.id,
            a: flightA.key,
            b: null,
            cleared: [`${AB_REASONS.selectionNotInSession}:b`],
        });
        const broken = json(session);
        broken.flights[0].chirps = [];
        expect(reconcileSelection(sel, session.id, sessionFlights(ok(broken)))).toMatchObject({
            a: null,
            b: flightB.key,
            cleared: [`${AB_REASONS.selectionNotSelectable}:a`],
        });
    });
});

describe("A/B verification status", () => {
    it("is INCOMPLETE until both sides are chosen", () => {
        const session = inMemory([flightA, flightB]);
        for (const sel of [EMPTY_SELECTION, pick(session, flightA.key, null), pick(session, null, flightB.key)]) {
            expect(abVerification(session, sel)).toMatchObject({ status: "INCOMPLETE", evidence: null });
        }
        expect(abVerification(null, pick(session, flightA.key, flightB.key)).status).toBe("INCOMPLETE");
    });

    it("two independent Flights from different BBLs with every field logged are ELIGIBLE, and nothing more", () => {
        const session = inMemory([flightA, flightB]);
        const v = abVerification(session, pick(session, flightA.key, flightB.key));
        expect(v).toMatchObject({
            status: "ELIGIBLE",
            independence: "INDEPENDENT",
            analysisVersion: "MATCH",
            firmware: "MATCH",
            missingEvidence: [],
            blockers: [],
        });
        expect(v.authorization).toEqual(AB_SELECTION_AUTHORIZATION);
        expect(v.authorization.status).toBe("NOT_AUTHORIZED");
        expect(v.authorization.reasons).toContain(PRODUCT_APPLY_PENDING);
    });

    it("two Flights of one BBL are independent when WU1 says so", () => {
        const session = inMemory(twoInOne);
        const v = abVerification(session, pick(session, twoInOne[0].key, twoInOne[1].key));
        expect(twoInOne[0].ref.file.sha256).toBe(twoInOne[1].ref.file.sha256);
        expect(v).toMatchObject({ status: "ELIGIBLE", independence: "INDEPENDENT" });
    });

    it("the same Flight as A and B is blocked", () => {
        const session = inMemory([flightA]);
        const v = abVerification(session, pick(session, flightA.key, flightA.key));
        expect(v.status).toBe("BLOCKED");
        expect(v.independence).toBe("NOT_INDEPENDENT");
        expect(v.blockers).toEqual(expect.arrayContaining([AB_REASONS.sameFlight, "same_flight_section"]));
    });

    it("a copied Flight in another file is NOT_INDEPENDENT", () => {
        const session = inMemory([flightA, copied]);
        const v = abVerification(session, pick(session, flightA.key, copied.key));
        expect(copied.ref.file.sha256).not.toBe(flightA.ref.file.sha256);
        expect(v).toMatchObject({ status: "BLOCKED", independence: "NOT_INDEPENDENT" });
        expect(v.blockers).toContain("same_flight_section");
    });

    it("a repackaged Flight (edited header) is NOT_INDEPENDENT", () => {
        const session = inMemory([flightA, repackaged]);
        const v = abVerification(session, pick(session, flightA.key, repackaged.key));
        expect(v).toMatchObject({ status: "BLOCKED", independence: "NOT_INDEPENDENT" });
        expect(v.blockers).toEqual(expect.arrayContaining(["same_flight_content", "firmware_mismatch:craftName"]));
    });

    it("a missing logged API version stays UNKNOWN, with its reason, although the CHIRPs carry a fallback", () => {
        expect(noApi[0].firmware.apiVersion).toBeNull();
        expect(noApi[0].chirps[0].qualityV2.provenance.apiVersion).not.toBeNull();
        const session = inMemory(noApi);
        const v = abVerification(session, pick(session, noApi[0].key, noApi[1].key));
        expect(v).toMatchObject({ status: "BLOCKED", independence: "INDEPENDENT", firmware: "UNKNOWN" });
        expect(v.firmwareFields?.apiVersion).toBe("UNKNOWN");
        expect(v.missingEvidence).toEqual(["firmware_unknown:apiVersion"]);
        expect(v.blockers).toEqual(["firmware_unknown:apiVersion"]);
    });

    it("different firmware versions are a MISMATCH", () => {
        const session = inMemory([flightA, otherRevision]);
        const v = abVerification(session, pick(session, flightA.key, otherRevision.key));
        expect(v).toMatchObject({ status: "BLOCKED", firmware: "MISMATCH", independence: "INDEPENDENT" });
        expect(v.firmwareFields?.firmwareRevision).toBe("MISMATCH");
        expect(v.blockers).toEqual(["firmware_mismatch:firmwareRevision"]);
    });

    it("different Quality V2 versions are a MISMATCH; a Flight without versions is UNKNOWN", () => {
        const old = json(flightB);
        (old.chirps[0].qualityV2 as Loose).analysisVersion = "2.0.0";
        const session = inMemory([flightA, old]);
        const v = abVerification(session, pick(session, flightA.key, old.key));
        expect(v).toMatchObject({ status: "BLOCKED", analysisVersion: "MISMATCH" });
        expect(v.blockers).toEqual(expect.arrayContaining(["analysis_version_outdated:b", "analysis_version_differs"]));

        const empty = json(flightB);
        empty.chirps = [];
        const s2 = inMemory([flightA, empty]);
        expect(abVerification(s2, pick(s2, flightA.key, empty.key)).analysisVersion).toBe("UNKNOWN");
    });

    it("a corrupt FlightRef in memory makes independence UNKNOWN, never INDEPENDENT", () => {
        const session = inMemory([flightA, flightB]);
        (session.flights[1].ref as Loose).bodyPrefix.sha256 = "not-a-hash";
        const v = abVerification(session, pick(session, flightA.key, flightB.key));
        expect(v).toMatchObject({ status: "BLOCKED", independence: "UNKNOWN" });
        expect(v.missingEvidence).toEqual(expect.arrayContaining(["flight_b_identity_incomplete"]));
    });

    it("a Flight removed after selection is a missing-evidence blocker", () => {
        const session = inMemory([flightA, flightB]);
        const gone = removeFlight(session, flightB.key, T0);
        const v = abVerification(gone, pick(gone, flightA.key, flightB.key));
        expect(v.status).toBe("BLOCKED");
        expect(v.blockers).toContain("flight_not_in_session:b");
        expect(v.missingEvidence).toContain("flight_not_in_session:b");
    });

    it.each(["firmwareType", "firmwareRevision", "boardInformation", "craftName", "firmwareDate"] as const)(
        "an UNKNOWN %s is never ELIGIBLE",
        async (field) => {
            const header = {
                firmwareType: "Firmware type",
                firmwareRevision: "Firmware revision",
                boardInformation: "Board information",
                craftName: "Craft name",
                firmwareDate: "Firmware date",
            }[field];
            const session = inMemory([flightA, flightB]);
            for (const f of session.flights) {
                (f.ref.header.fields as Loose)[header] = null;
                (f.firmware as Loose)[field] = null;
            }
            const v = abVerification(session, pick(session, flightA.key, flightB.key));
            expect(v.status).toBe("BLOCKED");
            expect(v.firmware).toBe("UNKNOWN");
            expect(v.missingEvidence).toContain(`firmware_unknown:${field}`);
        },
    );
});

describe("the selector over IndexedDB", () => {
    it("lists saved sessions, and an empty store as empty", async () => {
        const factory = new IDBFactory();
        const sel = useFlightAbSelector({ store: store(factory) });
        await sel.refreshSessions();
        expect(sel.listState.value).toBe("ready");
        expect(sel.sessions.value).toEqual([]);

        const s = store(factory);
        await s.create("one", [flightA]);
        await s.create("two", [flightA, flightB]);
        await sel.refreshSessions();
        expect(sel.sessions.value.map((x) => [x.name, x.flightCount, x.status])).toEqual(
            expect.arrayContaining([
                ["one", 1, "ok"],
                ["two", 2, "ok"],
            ]),
        );
    });

    it("opens a session, selects, and switching sessions clears the selection", async () => {
        const s = store();
        const one = await s.create("one", [flightA, flightB]);
        const two = await s.create("two", [flightA, flightB]);
        const sel = useFlightAbSelector({ store: s });
        await sel.openSession(one.id);
        expect(sel.select("a", flightA.key)).toBe(true);
        expect(sel.select("b", flightB.key)).toBe(true);
        expect(sel.verification.value.status).toBe("ELIGIBLE");

        await sel.openSession(two.id);
        expect(sel.selection.value).toEqual({
            sessionId: two.id,
            a: null,
            b: null,
            cleared: [AB_REASONS.sessionChanged],
        });
        expect(sel.verification.value.status).toBe("INCOMPLETE");
    });

    it("one Flight: nothing comparable can be chosen", async () => {
        const s = store();
        const one = await s.create("one", [flightA]);
        const sel = useFlightAbSelector({ store: s });
        await sel.openSession(one.id);
        expect(sel.flights.value.options.filter((o) => o.selectable)).toHaveLength(1);
        sel.select("a", flightA.key);
        expect(sel.verification.value.status).toBe("INCOMPLETE");
    });

    it("a damaged CHIRP is left out; a Flight whose only CHIRP is damaged is not selectable", async () => {
        const factory = new IDBFactory();
        const raw = inMemory([flightA, flightB], "damaged");
        (raw.flights[1].chirps[0] as Loose).durationS = -1;
        await putRaw(factory, raw);
        const sel = useFlightAbSelector({ store: store(factory) });
        await sel.openSession("damaged");
        const [a, b] = sel.flights.value.options;
        expect(a.selectable).toBe(true);
        expect(b).toMatchObject({ selectable: false, rejectedChirpCount: 1, reasons: [AB_REASONS.noChirps] });
        expect(sel.select("b", flightB.key)).toBe(false);
    });

    it("a corrupt FlightRef rejects that stored Flight: listed, never selectable; the others keep their keys", async () => {
        const factory = new IDBFactory();
        const raw = inMemory([flightA, flightB, ...twoInOne], "badref");
        (raw.flights[1].ref as Loose).section.sha256 = "zz";
        (raw.flights[2].chirps[0] as Loose).durationS = -1;
        await putRaw(factory, raw);
        const sel = useFlightAbSelector({ store: store(factory) });
        await sel.openSession("badref");
        expect(sel.flights.value.rejected).toEqual([
            { path: "flights[1]", problems: expect.arrayContaining(["identity:section"]) },
        ]);
        // The CHIRP of stored flights[2] is counted on that Flight, not on the one now at index 1.
        expect(sel.flights.value.options.map((o) => [o.key, o.rejectedChirpCount])).toEqual([
            [flightA.key, 0],
            [twoInOne[0].key, 1],
            [twoInOne[1].key, 0],
        ]);
        expect(sel.select("a", flightB.key)).toBe(false);
    });

    it("a corrupt or unsupported session opens to a clear problem and nothing selectable, unchanged in storage", async () => {
        const factory = new IDBFactory();
        const corrupt = { ...inMemory([flightA], "bad"), authorization: { status: "GRANTED" } };
        const future = { ...inMemory([flightA], "future"), schemaVersion: 99 };
        await putRaw(factory, corrupt);
        await putRaw(factory, future);
        const sel = useFlightAbSelector({ store: store(factory) });
        await sel.refreshSessions();
        expect(sel.sessions.value.map((s) => [s.id, s.status]).sort()).toEqual([
            ["bad", "corrupt"],
            ["future", "unsupported_version"],
        ]);
        await sel.openSession("bad");
        expect(sel.loaded.value).toMatchObject({ status: "corrupt", problems: ["authorization"] });
        expect(sel.flights.value.options).toEqual([]);
        await sel.openSession("future");
        expect(sel.loaded.value).toMatchObject({ status: "unsupported_version", schemaVersion: 99 });
        // Nothing repaired or removed.
        const again = await store(factory).list();
        expect(again).toHaveLength(2);
    });

    it("a Flight removed from the stored session after selection is cleared on reload", async () => {
        const s = store();
        const one = await s.create("one", [flightA, flightB]);
        const sel = useFlightAbSelector({ store: s });
        await sel.openSession(one.id);
        sel.select("a", flightA.key);
        sel.select("b", flightB.key);
        await s.save(removeFlight(one, flightB.key, T0));
        await sel.reloadSession();
        expect(sel.selection.value).toEqual({
            sessionId: one.id,
            a: flightA.key,
            b: null,
            cleared: [`${AB_REASONS.selectionNotInSession}:b`],
        });
    });

    it("a load error is reported and leaves nothing selected", async () => {
        const failing: TuneSessionStore = {
            ...store(),
            load: () => Promise.reject(new Error("disk")),
        };
        const sel = useFlightAbSelector({ store: failing });
        await sel.openSession("x");
        expect(sel.loadState.value).toBe("error");
        expect(sel.loadError.value).toBe("io");
        expect(sel.select("a", flightA.key)).toBe(false);
    });
});

describe("stale asynchronous results", () => {
    function deferredStore(real: TuneSessionStore) {
        const pending: { id: string; release: () => void }[] = [];
        const lists: (() => void)[] = [];
        const s: TuneSessionStore = {
            ...real,
            load: (id) =>
                new Promise((resolve, reject) => {
                    pending.push({ id, release: () => real.load(id).then(resolve, reject) });
                }),
            list: () =>
                new Promise((resolve, reject) => {
                    lists.push(() => real.list().then(resolve, reject));
                }),
        };
        return { s, pending, lists };
    }
    const settle = () => new Promise((r) => setTimeout(r, 20));

    it("a slow load of an earlier session never replaces the session opened since", async () => {
        const real = store();
        const one = await real.create("one", [flightA]);
        const two = await real.create("two", [flightA, flightB]);
        const { s, pending } = deferredStore(real);
        const sel = useFlightAbSelector({ store: s });
        const first = sel.openSession(one.id);
        const second = sel.openSession(two.id);
        pending[1].release();
        await second;
        await settle();
        sel.select("a", flightA.key);
        pending[0].release();
        await first;
        await settle();
        expect(sel.sessionId.value).toBe(two.id);
        expect(sel.session.value?.id).toBe(two.id);
        expect(sel.flights.value.options).toHaveLength(2);
        expect(sel.selection.value).toMatchObject({ sessionId: two.id, a: flightA.key });
    });

    it("a slow reload of the same session never overwrites a newer reload", async () => {
        const real = store();
        const one = await real.create("one", [flightA, flightB]);
        const { s, pending } = deferredStore(real);
        const sel = useFlightAbSelector({ store: s });
        const p0 = sel.openSession(one.id);
        pending[0].release();
        await p0;
        await settle();
        sel.select("b", flightB.key);
        const slow = sel.reloadSession();
        await real.save(removeFlight(one, flightB.key, T0));
        const fast = sel.reloadSession();
        pending[2].release();
        await fast;
        await settle();
        expect(sel.selection.value.b).toBeNull();
        pending[1].release();
        await slow;
        await settle();
        expect(sel.flights.value.options.map((o) => o.key)).toEqual([flightA.key]);
    });

    it("a slow list never overwrites a newer one", async () => {
        const real = store();
        const { s, lists } = deferredStore(real);
        const sel = useFlightAbSelector({ store: s });
        const old = sel.refreshSessions();
        await real.create("new", [flightA]);
        const fresh = sel.refreshSessions();
        lists[1]();
        await fresh;
        await settle();
        expect(sel.sessions.value).toHaveLength(1);
        await real.remove(sel.sessions.value[0].id);
        lists[0]();
        await old;
        await settle();
        expect(sel.sessions.value).toHaveLength(1);
    });

    it("closing a session while it loads drops the late result", async () => {
        const real = store();
        const one = await real.create("one", [flightA]);
        const { s, pending } = deferredStore(real);
        const sel = useFlightAbSelector({ store: s });
        const p = sel.openSession(one.id);
        await sel.openSession(null);
        pending[0].release();
        await p;
        await settle();
        expect(sel.session.value).toBeNull();
        expect(sel.loadState.value).toBe("idle");
    });
});

describe("saving an analysis (explicit only)", () => {
    it("stores a new session from the current report, and adds to the open one", async () => {
        const s = store();
        const sel = useFlightAbSelector({ store: s });
        const r1 = await report(base, "a.bbl");
        const out = await sel.saveAnalysis(r1, { intoOpenSession: false, name: "bench" });
        expect(out).toMatchObject({ status: "saved", skipped: [], notIndependent: [] });
        expect(sel.sessionId.value).toBe(out.sessionId);
        expect(sel.sessions.value.map((x) => x.name)).toEqual(["bench"]);

        const r2 = await report(log(30), "b.bbl");
        const out2 = await sel.saveAnalysis(r2, { intoOpenSession: true, name: "ignored" });
        expect(out2.sessionId).toBe(out.sessionId);
        expect(sel.flights.value.options).toHaveLength(2);

        const r3 = await report(replaceText(base, "Craft name:SYNTHETIC", "Craft name:RENAMED!"), "re.bbl");
        const out3 = await sel.saveAnalysis(r3, { intoOpenSession: true, name: "" });
        expect(out3.notIndependent[0]?.reasons).toEqual(["same_flight_content"]);
    });

    it("adding to the open session with none open is refused, never saved as a new session", async () => {
        const s = store();
        const sel = useFlightAbSelector({ store: s });
        const out = await sel.saveAnalysis(await report(base, "a.bbl"), { intoOpenSession: true, name: "x" });
        expect(out).toMatchObject({ status: "error", error: "no_open_session" });
        expect(await s.list()).toEqual([]);
    });

    it("a report without a Flight identity saves nothing", async () => {
        const s = store();
        const sel = useFlightAbSelector({ store: s });
        const r = qualifyChirpFile(base, "x.bbl", 60, AUTOTUNE_MATH);
        expect(await sel.saveAnalysis(r, { intoOpenSession: false, name: "x" })).toMatchObject({
            status: "nothing_to_save",
        });
        expect(await s.list()).toEqual([]);
    });

    it("never overwrites a damaged record", async () => {
        const factory = new IDBFactory();
        const raw = inMemory([flightA, flightB], "damaged");
        (raw.flights[1].chirps[0] as Loose).durationS = -1;
        await putRaw(factory, raw);
        const sel = useFlightAbSelector({ store: store(factory) });
        await sel.openSession("damaged");
        const out = await sel.saveAnalysis(await report(log(33), "c.bbl"), { intoOpenSession: true, name: "" });
        expect(out).toMatchObject({ status: "error", error: "damaged_record" });
    });
});

describe("FIX 2: adding to the open session never replaces a stored Flight", () => {
    async function stored(s: TuneSessionStore, id: string) {
        const r = await s.load(id);
        if (r.status !== "ok") {
            throw new Error(r.status);
        }
        return json(r.session);
    }

    it("the same Flight again is refused, nothing is written, and the stored result is unchanged", async () => {
        const s = store();
        const one = await s.create("one", [flightA, flightB]);
        const before = await stored(s, one.id);
        const sel = useFlightAbSelector({ store: s, now: () => new Date("2026-10-11T01:00:00.000Z") });
        await sel.openSession(one.id);
        sel.select("a", flightA.key);
        const out = await sel.saveAnalysis(await report(base, "a.bbl"), { intoOpenSession: true, name: "" });
        expect(out).toMatchObject({
            status: "error",
            error: "flight_already_in_session",
            alreadyInSession: [flightA.key],
            sessionId: null,
        });
        expect(await stored(s, one.id)).toEqual(before);
        expect(sel.selection.value.a).toBe(flightA.key);
    });

    it("one known Flight among new ones: nothing is saved (no partial save)", async () => {
        const s = store();
        const one = await s.create("one", [twoInOne[0]]);
        const before = await stored(s, one.id);
        const sel = useFlightAbSelector({ store: s });
        await sel.openSession(one.id);
        const both = await report(concatLogs(log(45), log(35)), "two.bbl");
        const out = await sel.saveAnalysis(both, { intoOpenSession: true, name: "" });
        expect(out).toMatchObject({ status: "error", alreadyInSession: [twoInOne[0].key] });
        expect(await stored(s, one.id)).toEqual(before);
        expect((await s.list()).map((x) => x.flightCount)).toEqual([1]);
    });

    it("checks the record as stored, not the copy loaded earlier", async () => {
        const s = store();
        const one = await s.create("one", [flightB]);
        const sel = useFlightAbSelector({ store: s });
        await sel.openSession(one.id);
        // Changed elsewhere after it was opened here.
        const elsewhere = addFlights(one, [flightA], T0).session;
        await s.save(elsewhere);
        const before = await stored(s, one.id);
        const out = await sel.saveAnalysis(await report(base, "a.bbl"), { intoOpenSession: true, name: "" });
        expect(out).toMatchObject({ status: "error", alreadyInSession: [flightA.key] });
        expect(await stored(s, one.id)).toEqual(before);
    });

    it("saving the same analysis as a new session still works and leaves the first session alone", async () => {
        const s = store();
        const one = await s.create("one", [flightA]);
        const before = await stored(s, one.id);
        const sel = useFlightAbSelector({ store: s });
        await sel.openSession(one.id);
        const out = await sel.saveAnalysis(await report(base, "a.bbl"), { intoOpenSession: false, name: "copy" });
        expect(out.status).toBe("saved");
        expect(out.sessionId).not.toBe(one.id);
        expect(await stored(s, one.id)).toEqual(before);
    });
});

describe("FIX 1: a slow save never overrides a newer session choice", () => {
    /** Writes (create/save) wait until released; reads go straight through. */
    function slowWrites(real: TuneSessionStore) {
        const gates: (() => void)[] = [];
        const hold = <T>(p: () => Promise<T>) =>
            new Promise<T>((resolve, reject) => gates.push(() => void p().then(resolve, reject)));
        const s: TuneSessionStore = {
            ...real,
            create: (name, flights) => hold(() => real.create(name, flights)),
            save: (session, o) => hold(() => real.save(session, o)),
        };
        return { s, release: () => gates.shift()!(), pending: () => gates.length };
    }
    const until = async (cond: () => boolean) => {
        for (let i = 0; i < 200 && !cond(); i++) {
            await new Promise((r) => setTimeout(r, 5));
        }
        expect(cond()).toBe(true);
    };

    it("without a change meanwhile, the saved session is opened", async () => {
        const { s, release, pending } = slowWrites(store());
        const sel = useFlightAbSelector({ store: s });
        const saving = sel.saveAnalysis(await report(base, "a.bbl"), { intoOpenSession: false, name: "new" });
        await until(() => pending() === 1);
        release();
        const out = await saving;
        expect(out).toMatchObject({ status: "saved", opened: true });
        expect(sel.sessionId.value).toBe(out.sessionId);
    });

    it("a new session saved while the user opened another one does not take over", async () => {
        const real = store();
        const two = await real.create("two", [flightA, flightB]);
        const { s, release, pending } = slowWrites(real);
        const sel = useFlightAbSelector({ store: s });
        const saving = sel.saveAnalysis(await report(log(33), "c.bbl"), { intoOpenSession: false, name: "new" });
        await until(() => pending() === 1);
        await sel.openSession(two.id);
        sel.select("a", flightA.key);
        sel.select("b", flightB.key);
        release();
        const out = await saving;
        expect(out).toMatchObject({ status: "saved", opened: false });
        expect(sel.sessionId.value).toBe(two.id);
        expect(sel.selection.value).toMatchObject({ sessionId: two.id, a: flightA.key, b: flightB.key });
        expect(sel.verification.value.status).toBe("ELIGIBLE");
        expect(sel.sessions.value.map((x) => x.id)).toContain(out.sessionId);
    });

    it("a save while the user closed the session leaves it closed", async () => {
        const real = store();
        const one = await real.create("one", [flightB]);
        const { s, release, pending } = slowWrites(real);
        const sel = useFlightAbSelector({ store: s });
        await sel.openSession(one.id);
        const saving = sel.saveAnalysis(await report(base, "a.bbl"), { intoOpenSession: true, name: "" });
        await until(() => pending() === 1);
        await sel.openSession(null);
        release();
        const out = await saving;
        expect(out).toMatchObject({ status: "saved", opened: false, sessionId: one.id });
        expect(sel.sessionId.value).toBeNull();
        expect(sel.session.value).toBeNull();
        // The save itself completed.
        const r = await real.load(one.id);
        expect(r.status === "ok" && r.session.flights.map((f) => f.key)).toEqual([flightB.key, flightA.key]);
    });

    it("adding to session one while the user switched to session two keeps session two", async () => {
        const real = store();
        const one = await real.create("one", [flightB]);
        const two = await real.create("two", [flightA, flightB]);
        const { s, release, pending } = slowWrites(real);
        const sel = useFlightAbSelector({ store: s });
        await sel.openSession(one.id);
        const saving = sel.saveAnalysis(await report(log(33), "c.bbl"), { intoOpenSession: true, name: "" });
        await until(() => pending() === 1);
        await sel.openSession(two.id);
        sel.select("b", flightB.key);
        release();
        const out = await saving;
        expect(out).toMatchObject({ status: "saved", opened: false, sessionId: one.id });
        expect(sel.sessionId.value).toBe(two.id);
        expect(sel.flights.value.options.map((o) => o.key)).toEqual([flightA.key, flightB.key]);
        expect(sel.selection.value).toMatchObject({ sessionId: two.id, b: flightB.key });
    });

    it("a slow read before adding cannot override a newer choice either", async () => {
        const real = store();
        const one = await real.create("one", [flightB]);
        const two = await real.create("two", [flightA]);
        let releaseLoad: (() => void) | null = null;
        const s: TuneSessionStore = {
            ...real,
            load: (id) =>
                releaseLoad === null && id === one.id && sel.saving.value
                    ? new Promise((resolve, reject) => {
                          releaseLoad = () => void real.load(id).then(resolve, reject);
                      })
                    : real.load(id),
        };
        const sel = useFlightAbSelector({ store: s });
        await sel.openSession(one.id);
        const saving = sel.saveAnalysis(await report(base, "a.bbl"), { intoOpenSession: true, name: "" });
        await until(() => releaseLoad !== null);
        await sel.openSession(two.id);
        releaseLoad!();
        const out = await saving;
        expect(out).toMatchObject({ status: "saved", opened: false });
        expect(sel.sessionId.value).toBe(two.id);
    });

    it("re-opening the same session during the save keeps the choices and shows the new Flight", async () => {
        const real = store();
        const one = await real.create("one", [flightB, twoInOne[0]]);
        const { s, release, pending } = slowWrites(real);
        const sel = useFlightAbSelector({ store: s });
        await sel.openSession(one.id);
        sel.select("a", twoInOne[0].key);
        const saving = sel.saveAnalysis(await report(base, "a.bbl"), { intoOpenSession: true, name: "" });
        await until(() => pending() === 1);
        await sel.reloadSession();
        sel.select("b", flightB.key);
        release();
        const out = await saving;
        expect(out).toMatchObject({ status: "saved", opened: false });
        expect(sel.selection.value).toMatchObject({ a: twoInOne[0].key, b: flightB.key });
        expect(sel.flights.value.options.map((o) => o.key)).toContain(flightA.key);
    });
});

describe("authorization, Safety and Apply are untouched", () => {
    const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf8");
    const NEW = [
        "src/gyrocore/session/selection.ts",
        "src/gyrocore/composables/useFlightAbSelector.ts",
        "src/gyrocore/components/FlightAbSelector.vue",
    ];

    it("the product Apply lock still blocks", () => {
        expect(productApplyBlocks()).toEqual([PRODUCT_APPLY_PENDING]);
    });

    it("the selector imports no MSP, Apply, tuning-authorization or Safety code", () => {
        for (const f of NEW) {
            const imports = [...read(f).matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
            for (const i of imports) {
                expect(i, `${f} imports ${i}`).not.toMatch(
                    /msp|MSP|applyGate|useApplyGate|tuning\/|safety\/|serial|recommendationGuard|stores\/autotune/,
                );
            }
        }
    });

    it("qualification, tuning, Safety and the product lock do not read the selection", () => {
        const gated = [
            "src/gyrocore/tuning/authorize.ts",
            "src/gyrocore/safety/authorize.ts",
            "src/gyrocore/productLock/productApply.ts",
            "src/gyrocore/composables/useApplyGate.ts",
            "src/gyrocore/chirp/applyGate.ts",
            "src/components/tabs/autotune/GainRecommendation.vue",
        ];
        for (const f of gated) {
            expect(read(f)).not.toMatch(/session\/selection|useFlightAbSelector|FlightAbSelector/);
        }
    });

    it("the selection carries no authorization of any kind", () => {
        const session = inMemory([flightA, flightB]);
        const v = abVerification(session, pick(session, flightA.key, flightB.key));
        expect(v.status).toBe("ELIGIBLE");
        expect(JSON.stringify(v)).not.toMatch(
            /"AUTHORIZED"|"PASS"|"GRANTED"|tuningAuthorized"?:\s*\{\s*"status":\s*"PASS/,
        );
    });
});

describe("the component", () => {
    let pinia = createPinia();
    beforeEach(() => {
        pinia = createPinia();
        setActivePinia(pinia);
        expert.on = true;
    });

    async function mount(s: TuneSessionStore) {
        const container = document.createElement("div");
        document.body.appendChild(container);
        const app = createApp({
            render: () => h(UApp, { portal: false }, { default: () => h(FlightAbSelector, { store: s }) }),
        });
        app.config.globalProperties.$t = ((key: string) => key) as never;
        app.use(pinia);
        app.mount(container);
        await flush();
        return { container, unmount: () => (app.unmount(), container.remove()) };
    }
    const flush = async () => {
        for (let i = 0; i < 5; i++) {
            await new Promise((r) => setTimeout(r, 10));
            await nextTick();
        }
    };
    const q = (c: HTMLElement, sel: string) => c.querySelector(sel) as HTMLElement | null;
    async function choose(c: HTMLElement, selector: string, value: string) {
        const el = q(c, selector) as HTMLSelectElement;
        el.value = value;
        el.dispatchEvent(new Event("change"));
        await flush();
    }

    it("the Autotune tab around it stays an Expert Mode tab", async () => {
        const { sidebarItems } = await import("../../src/components/sidebar/sidebar_items.js");
        expect(sidebarItems.find((i: { key: string }) => i.key === "autotune")).toMatchObject({ expert: true });
    });

    it("is hidden without Expert Mode, and appears when Expert Mode is switched on", async () => {
        expert.on = false;
        const { container, unmount } = await mount(store());
        expect(q(container, '[data-gyrocore="flight-ab-selector"]')).toBeNull();
        expert.on = true;
        EventBus.$emit("expert-mode-change", true);
        await flush();
        expect(q(container, '[data-gyrocore="flight-ab-selector"]')).not.toBeNull();
        EventBus.$emit("expert-mode-change", false);
        await flush();
        expect(q(container, '[data-gyrocore="flight-ab-selector"]')).toBeNull();
        unmount();
    });

    it("shows a clear empty state and the not-a-Verified-Tune notice", async () => {
        const { container, unmount } = await mount(store());
        expect(q(container, '[data-gyrocore="ab-sessions-empty"]')).not.toBeNull();
        expect(q(container, '[data-gyrocore="ab-not-verified-tune"]')?.textContent).toContain(PRODUCT_APPLY_PENDING);
        unmount();
    });

    it("opens a session, selects A and B and shows the status rows", async () => {
        const s = store();
        const one = await s.create("one", [flightA, flightB, copied]);
        const { container, unmount } = await mount(s);
        await choose(container, '[data-gyrocore="ab-session-select"]', one.id);
        expect(container.querySelectorAll('[data-gyrocore="ab-flights"] [data-flight]')).toHaveLength(3);
        expect(q(container, '[data-gyrocore="ab-status"]')?.dataset.status).toBe("INCOMPLETE");

        await choose(container, '[data-gyrocore="ab-select-a"]', flightA.key);
        await choose(container, '[data-gyrocore="ab-select-b"]', flightB.key);
        expect(q(container, '[data-gyrocore="ab-status"]')?.dataset.status).toBe("ELIGIBLE");
        expect(q(container, '[data-row="independence"]')?.dataset.status).toBe("INDEPENDENT");
        expect(q(container, '[data-gyrocore="ab-flight-a"] [data-field="file"]')?.textContent).toBe("a.bbl");
        expect(q(container, '[data-gyrocore="ab-flight-b"] [data-field="analysis"]')?.textContent).toContain(
            CHIRP_QUALITY_V2_ANALYSIS_VERSION,
        );

        await choose(container, '[data-gyrocore="ab-select-b"]', copied.key);
        expect(q(container, '[data-gyrocore="ab-status"]')?.dataset.status).toBe("BLOCKED");
        expect(q(container, '[data-row="independence"]')?.dataset.status).toBe("NOT_INDEPENDENT");
        expect(q(container, '[data-row="blockers"] [data-reason="same_flight_section"]')).not.toBeNull();
        expect((q(container, '[data-gyrocore="ab-select-a"]') as HTMLSelectElement).value).toBe(flightA.key);
        unmount();
    });

    it("shows UNKNOWN firmware with its reason code", async () => {
        const s = store();
        const one = await s.create("noapi", noApi);
        const { container, unmount } = await mount(s);
        await choose(container, '[data-gyrocore="ab-session-select"]', one.id);
        await choose(container, '[data-gyrocore="ab-select-a"]', noApi[0].key);
        await choose(container, '[data-gyrocore="ab-select-b"]', noApi[1].key);
        expect(q(container, '[data-row="firmware"]')?.dataset.status).toBe("UNKNOWN");
        expect(q(container, '[data-row="missing"] [data-reason="firmware_unknown:apiVersion"]')).not.toBeNull();
        expect(q(container, '[data-gyrocore="ab-status"]')?.dataset.status).toBe("BLOCKED");
        unmount();
    });

    it("shows that a Flight is already in the open session and saves nothing", async () => {
        const s = store();
        const one = await s.create("one", [flightA]);
        const gate = useChirpQualificationStore();
        gate.setReport((await report(base, "a.bbl")) as never);
        const { container, unmount } = await mount(s);
        await choose(container, '[data-gyrocore="ab-session-select"]', one.id);
        q(container, '[data-gyrocore="ab-save-into"]')!.click();
        await flush();
        const msg = q(container, '[data-gyrocore="ab-save-result"]');
        expect(msg?.dataset.reason).toBe("flight_already_in_session");
        expect(msg?.textContent).toContain("gyrocoreAbSaveAlreadyPresent");
        expect((await s.list()).map((x) => x.flightCount)).toEqual([1]);
        unmount();
    });

    it("saves the current analysis only on click", async () => {
        const s = store();
        const gate = useChirpQualificationStore();
        gate.setReport((await report(base, "a.bbl")) as never);
        const { container, unmount } = await mount(s);
        expect(await s.list()).toEqual([]);
        q(container, '[data-gyrocore="ab-save-new"]')!.click();
        await flush();
        expect((await s.list()).map((x) => x.name)).toEqual(["a.bbl"]);
        expect(q(container, '[data-gyrocore="ab-save-result"]')?.dataset.status).toBe("saved");
        unmount();
    });
});
