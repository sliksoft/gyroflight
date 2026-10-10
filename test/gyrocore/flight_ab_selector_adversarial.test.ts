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
 * WU4 Flight A/B Selector, adversarial pass written from
 * docs/gyrocore/FLIGHT_AB_SELECTOR.md alone (blind to the implementation).
 * SYNTHETIC logs only: every BBL here comes from harness/chirpSim, every stored
 * session from the real WU1/WU3 pipeline, and damage is written raw into a
 * fake IndexedDB.
 */

import { IDBFactory } from "fake-indexeddb";
import { createApp, effectScope, h, nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
};

const expert = vi.hoisted(() => ({ on: false }));
vi.mock("../../src/js/utils/isExpertModeEnabled", () => ({ isExpertModeEnabled: () => expert.on }));

vi.mock("../../src/js/localization", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/js/localization")>()),
    i18n: { getMessage: (key: string, args?: string[]) => (args?.length ? `${key}|${args.join("|")}` : key) },
}));

import UApp from "@nuxt/ui/components/App.vue";
import { EventBus } from "../../src/components/eventBus.js";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { qualifyChirpFile, type ChirpQualificationReport } from "../../src/gyrocore/chirp/qualification";
import { attachChirpFlightIdentity } from "../../src/gyrocore/chirp/qualityV2/identity";
import FlightAbSelector from "../../src/gyrocore/components/FlightAbSelector.vue";
import { useFlightAbSelector } from "../../src/gyrocore/composables/useFlightAbSelector";
import { checkIndependentFlights } from "../../src/gyrocore/flight/identity";
import { productApplyBlocks } from "../../src/gyrocore/productLock/productApply";
import {
    addFlights,
    flightPairEvidence,
    flightsFromReport,
    newTuneSession,
    removeFlight,
} from "../../src/gyrocore/session/build";
import type {
    FlightPairEvidence,
    LoadResult,
    SessionSummary,
    StoredFlight,
    TuneSession,
} from "../../src/gyrocore/session/contract";
import {
    AB_REASONS,
    AB_SELECTION_AUTHORIZATION,
    abVerification,
    EMPTY_SELECTION,
    independenceStatus,
    reconcileSelection,
    selectFlight,
    selectionForSession,
    sessionFlights,
    type AbSelection,
    type SessionFlights,
} from "../../src/gyrocore/session/selection";
import {
    openTuneSessionStore,
    TUNE_SESSION_DB_NAME,
    TUNE_SESSION_STORE,
    type TuneSessionStore,
} from "../../src/gyrocore/session/storage";
import {
    concatLogs,
    encodeChirpLog,
    FULL_TUNE_HEADERS,
    simulateChirp,
    simulateChirpSequence,
} from "./harness/chirpSim";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const T0 = "2026-10-10T20:00:00.000Z";
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const NOT_AUTHORIZED = {
    status: "NOT_AUTHORIZED",
    reasons: ["ab_selection_is_not_a_verified_tune", "full_safety_engine_pending"],
};

/** SYNTHETIC firmware lines: every firmware field logged, plus a start time. */
const FW_LINES: Record<string, string> = {
    date: "Firmware date:Jun 1 2026 00:00:00",
    board: "Board information:SYNT SYNTHETIC",
    craft: "Craft name:SYN",
    api: "Firmware API version:1.49.0",
};
function headers(opts: { omit?: string[]; start?: string } = {}): string[] {
    return [
        ...FULL_TUNE_HEADERS,
        ...Object.entries(FW_LINES)
            .filter(([k]) => !opts.omit?.includes(k))
            .map(([, v]) => v),
        `Log start datetime:${opts.start ?? "2026-10-01T10:00:00.000+00:00"}`,
    ];
}

/** SYNTHETIC log: one sweep; `t0` makes the first I-frame (and so the Flight) distinct. */
function log(t0: number, axis: 0 | 1 | 2 = 0, opts: { omit?: string[]; start?: string } = {}): Uint8Array {
    return encodeChirpLog(simulateChirp({ firmwareDebug: true, seconds: 6, axis, startTimeUs: t0 }), headers(opts));
}

function replaceText(bytes: Uint8Array, from: string, to: string): Uint8Array {
    const text = new TextDecoder("latin1").decode(bytes);
    const at = text.indexOf(from);
    if (at <= 0) {
        throw new Error(`text ${from} not found`);
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

async function reportOf(bytes: Uint8Array, fileName: string): Promise<ChirpQualificationReport> {
    const report = qualifyChirpFile(bytes, fileName, 60, AUTOTUNE_MATH);
    await attachChirpFlightIdentity(report, bytes);
    return report;
}

async function flightsOf(bytes: Uint8Array, fileName: string): Promise<StoredFlight[]> {
    const { flights, skipped } = flightsFromReport(await reportOf(bytes, fileName), { fileName, analyzedAt: T0 });
    expect(skipped).toEqual([]);
    return flights;
}

function sessionOf(flights: StoredFlight[], id = "mem"): TuneSession {
    return json(addFlights(newTuneSession({ id, name: id, now: T0 }), flights, T0).session);
}

function okLoad(session: TuneSession, rejected: { path: string; problems: string[] }[] = []): LoadResult {
    return { status: "ok", session, rejected, migratedFrom: null };
}

/** Select A then B through the pure API, asserting both selections were accepted. */
function pick(session: TuneSession, a: string, b: string): AbSelection {
    const flights = sessionFlights(okLoad(session));
    const s0 = selectionForSession(EMPTY_SELECTION, session.id);
    const s1 = selectFlight(s0, session.id, flights, "a", a);
    const s2 = selectFlight(s1, session.id, flights, "b", b);
    expect(s2.a).toBe(a);
    expect(s2.b).toBe(b);
    return s2;
}

/** A selection built by hand, for sessions whose Flights may not be selectable. */
const forced = (session: TuneSession, a: string | null, b: string | null): AbSelection => ({
    sessionId: session.id,
    a,
    b,
    cleared: [],
});

function deepFreeze<T>(v: T): T {
    if (v && typeof v === "object" && !Object.isFrozen(v)) {
        Object.freeze(v);
        Object.values(v).forEach(deepFreeze);
    }
    return v;
}

/** SYNTHETIC Flights, built once. */
let A: StoredFlight; // a.bbl, log 1
let B: StoredFlight; // b.bbl, log 1, another recording with the same firmware
let twoInOne: StoredFlight[]; // two distinct recordings in one BBL
let copyOfA: StoredFlight; // A's exact bytes as log 2 of another file
let repackagedA: StoredFlight; // A with an edited header line (Log start datetime)
let otherRevision: StoredFlight; // like B, another Firmware revision
let threeChirps: StoredFlight; // three sweeps in one log
const missing: Record<string, [StoredFlight, StoredFlight]> = {};
let bytesA: Uint8Array;
let bytesB: Uint8Array;

beforeAll(async () => {
    bytesA = log(1_000_000, 0);
    bytesB = log(9_000_000, 1, { start: "2026-10-01T11:00:00.000+00:00" });
    [A] = await flightsOf(bytesA, "a.bbl");
    [B] = await flightsOf(bytesB, "b.bbl");
    twoInOne = await flightsOf(concatLogs(log(2_000_000, 0), log(20_000_000, 2)), "two.bbl");
    const copied = await flightsOf(concatLogs(log(30_000_000, 1), bytesA), "copy.bbl");
    copyOfA = copied[1];
    [repackagedA] = await flightsOf(
        replaceText(bytesA, "Log start datetime:2026-10-01T10:00", "Log start datetime:2026-10-01T10:30"),
        "repack.bbl",
    );
    [otherRevision] = await flightsOf(
        replaceText(bytesB, "Betaflight 2026.6.2 (synthetic)", "Betaflight 2026.6.3 (synthetic)"),
        "rev.bbl",
    );
    [threeChirps] = await flightsOf(
        encodeChirpLog(
            simulateChirpSequence(
                [
                    { axis: 0, seconds: 6, firmwareDebug: true },
                    { axis: 1, seconds: 6, firmwareDebug: true },
                    { axis: 2, seconds: 6, firmwareDebug: true },
                ],
                40_000_000,
            ),
            headers(),
        ),
        "three.bbl",
    );
    for (const k of ["date", "board", "craft", "api"]) {
        const [a] = await flightsOf(log(50_000_000, 0, { omit: [k] }), `no-${k}-a.bbl`);
        const [b] = await flightsOf(log(60_000_000, 1, { omit: [k] }), `no-${k}-b.bbl`);
        missing[k] = [a, b];
    }
}, 120_000);

beforeEach(() => {
    setActivePinia(createPinia());
});

describe("SYNTHETIC fixtures are what the tests assume", () => {
    it("A and B carry every firmware field, logged equal, and are distinct recordings", () => {
        expect(A.firmware.unknown).toEqual([]);
        expect(B.firmware.unknown).toEqual([]);
        expect(A.ref.status).toBe("valid");
        expect(checkIndependentFlights(A.ref, B.ref)).toMatchObject({ independent: true, relation: "distinct" });
        expect(checkIndependentFlights(A.ref, copyOfA.ref).relation).toBe("same_section");
        expect(checkIndependentFlights(A.ref, repackagedA.ref).relation).toBe("same_flight_content");
        expect(twoInOne).toHaveLength(2);
        expect(threeChirps.chirps).toHaveLength(3);
        expect(missing.api[0].firmware.apiVersion).toBeNull();
    });
});

describe("sessionFlights: which Flights can be chosen", () => {
    it("no load, or a load that is not ok, has no selectable Flight", () => {
        expect(sessionFlights(null).options).toEqual([]);
        const bad: LoadResult[] = [
            { status: "corrupt", id: "x", problems: ["schema"] },
            { status: "unsupported_version", id: "x", schemaVersion: 99 },
            { status: "not_found", id: "x" },
        ];
        for (const l of bad) {
            expect(sessionFlights(l).options.filter((o) => o.selectable)).toEqual([]);
        }
    });

    it("lists every Flight with its file name, 1-based log number, start time, firmware and CHIRPs", () => {
        const s = sessionOf([...twoInOne, A]);
        const { options, rejected } = sessionFlights(okLoad(s));
        expect(rejected).toEqual([]);
        expect(options.map((o) => o.key)).toEqual([twoInOne[0].key, twoInOne[1].key, A.key]);
        const [o1, o2, oa] = options;
        expect(o1).toMatchObject({ fileName: "two.bbl", logNumber: 1, logCount: 2, selectable: true, reasons: [] });
        expect(o2).toMatchObject({ fileName: "two.bbl", logNumber: 2, logCount: 2, selectable: true });
        expect(oa).toMatchObject({ fileName: "a.bbl", logNumber: 1, logCount: 1 });
        expect(oa.logStart).toBe("2026-10-01T10:00:00.000+00:00");
        expect(oa.firmware).toEqual(A.firmware);
        expect(oa.chirpCount).toBe(1);
        expect(oa.rejectedChirpCount).toBe(0);
        expect(oa.axes).toEqual(["roll"]);
        expect(o2.axes).toEqual(["yaw"]);
        expect(oa.analysisVersions).toEqual([A.chirps[0].qualityV2.analysisVersion]);
        expect(oa.analysisStatus).toBe("CURRENT");
    });

    it("an unlogged start time is unknown (null), never invented", () => {
        const f = json(A) as Loose;
        f.ref.header.fields["Log start datetime"] = null;
        for (const c of f.chirps) {
            c.qualityV2.identity.flight.ref = f.ref;
        }
        const [o] = sessionFlights(okLoad(sessionOf([f]))).options;
        expect(o.logStart).toBeNull();
    });

    it("three CHIRPs of one log are one Flight with three axes", () => {
        const [o] = sessionFlights(okLoad(sessionOf([threeChirps]))).options;
        expect(o.chirpCount).toBe(3);
        expect([...o.axes].sort()).toEqual(["pitch", "roll", "yaw"]);
    });

    it("a Flight whose FlightRef status is not valid is not selectable: flight_unreadable plus WU1 reasons", () => {
        const f = json(B) as Loose;
        f.ref.status = "invalid";
        f.ref.reasons = ["log_unreadable:synthetic damage"];
        f.ref.timeRangeUs = null;
        const s = sessionOf([A, f]);
        const o = sessionFlights(okLoad(s)).options.find((x) => x.key === B.key)!;
        expect(o.selectable).toBe(false);
        expect(o.reasons).toContain(AB_REASONS.flightUnreadable);
        expect(o.reasons.join(" ")).toContain("log_unreadable:synthetic damage");
    });

    it("a Flight without CHIRPs is not selectable: flight_no_valid_chirps", () => {
        const f = json(B);
        f.chirps = [];
        const o = sessionFlights(okLoad(sessionOf([A, f]))).options.find((x) => x.key === B.key)!;
        expect(o.selectable).toBe(false);
        expect(o.reasons).toContain(AB_REASONS.noChirps);
    });

    it("a rejected Flight record is reported and never selectable", () => {
        const s = sessionOf([A]);
        const load = okLoad(s, [{ path: "flights[1]", problems: ["identity:section"] }]);
        const flights = sessionFlights(load);
        expect(flights.rejected).toEqual([{ path: "flights[1]", problems: ["identity:section"] }]);
        for (const o of flights.options) {
            if (o.reasons.includes(AB_REASONS.flightRejected)) {
                expect(o.selectable).toBe(false);
            }
        }
        expect(flights.options.find((o) => o.key === A.key)?.selectable).toBe(true);
    });

    it("does not mutate the load it reads", () => {
        const load = deepFreeze(okLoad(sessionOf([A, B])));
        expect(() => sessionFlights(load)).not.toThrow();
    });
});

describe("selection state", () => {
    let s: TuneSession;
    let flights: SessionFlights;
    let base: AbSelection;
    beforeAll(() => {
        s = sessionOf([...twoInOne, A, B], "S1");
        flights = sessionFlights(okLoad(s));
        base = selectionForSession(EMPTY_SELECTION, "S1");
    });

    it("EMPTY_SELECTION is empty", () => {
        expect(EMPTY_SELECTION).toEqual({ sessionId: null, a: null, b: null, cleared: [] });
    });

    it("selecting one side never changes the other", () => {
        const a = selectFlight(base, "S1", flights, "a", A.key);
        expect(a).toMatchObject({ sessionId: "S1", a: A.key, b: null });
        const ab = selectFlight(a, "S1", flights, "b", B.key);
        expect(ab).toMatchObject({ a: A.key, b: B.key });
        const changedA = selectFlight(ab, "S1", flights, "a", twoInOne[0].key);
        expect(changedA).toMatchObject({ a: twoInOne[0].key, b: B.key });
        const clearedB = selectFlight(changedA, "S1", flights, "b", null);
        expect(clearedB).toMatchObject({ a: twoInOne[0].key, b: null });
        const clearedA = selectFlight(ab, "S1", flights, "a", null);
        expect(clearedA).toMatchObject({ a: null, b: B.key });
    });

    it("does not mutate the previous selection", () => {
        const frozen = deepFreeze(selectFlight(base, "S1", flights, "a", A.key));
        const next = selectFlight(frozen, "S1", flights, "b", B.key);
        expect(frozen.b).toBeNull();
        expect(next.b).toBe(B.key);
    });

    it("refuses list indexes, log numbers and look-alike keys (same object back)", () => {
        const sel = selectFlight(base, "S1", flights, "a", A.key);
        for (const bad of ["0", "1", "2", "3", A.key.toUpperCase(), `${A.key} `, A.key.split("#")[0], "", "#0"]) {
            expect(selectFlight(sel, "S1", flights, "b", bad), bad).toBe(sel);
            expect(selectFlight(sel, "S1", flights, "a", bad), bad).toBe(sel);
        }
    });

    it("keys are locationIds, not positions: reordering the session keeps the chosen Flight", () => {
        const sel = pick(s, twoInOne[1].key, B.key);
        const reordered = sessionOf([B, A, twoInOne[1], twoInOne[0]], "S1");
        const r = reconcileSelection(sel, "S1", sessionFlights(okLoad(reordered)));
        expect(r).toMatchObject({ a: twoInOne[1].key, b: B.key, cleared: [] });
    });

    it("refuses a Flight of another session", () => {
        const other = sessionOf([copyOfA, otherRevision], "S2");
        const otherFlights = sessionFlights(okLoad(other));
        // A key that only exists in S2, offered with S1's flight list.
        expect(selectFlight(base, "S1", flights, "a", copyOfA.key)).toBe(base);
        // S2's list offered for a selection that belongs to S1.
        expect(selectFlight(base, "S2", otherFlights, "a", copyOfA.key)).toBe(base);
    });

    it("refuses a Flight that is not selectable", () => {
        const f = json(B);
        f.chirps = [];
        const s3 = sessionOf([A, f], "S3");
        const fl = sessionFlights(okLoad(s3));
        const sel = selectionForSession(EMPTY_SELECTION, "S3");
        expect(selectFlight(sel, "S3", fl, "b", B.key)).toBe(sel);
    });

    it("refuses everything for a session that did not load ok", () => {
        const sel = selectionForSession(EMPTY_SELECTION, "bad");
        const fl = sessionFlights({ status: "corrupt", id: "bad", problems: ["schema"] });
        expect(selectFlight(sel, "bad", fl, "a", A.key)).toBe(sel);
    });

    it("the same Flight may be chosen for A and B", () => {
        const sel = pick(s, A.key, A.key);
        expect(sel).toMatchObject({ a: A.key, b: A.key });
    });

    it("opening another session clears both sides with selection_session_changed", () => {
        const sel = pick(s, A.key, B.key);
        const next = selectionForSession(sel, "S2");
        expect(next).toMatchObject({ sessionId: "S2", a: null, b: null });
        expect(next.cleared).toContain(AB_REASONS.sessionChanged);
        const none = selectionForSession(sel, null);
        expect(none).toMatchObject({ sessionId: null, a: null, b: null });
    });

    it("re-opening the same session keeps the selection", () => {
        const sel = pick(s, A.key, B.key);
        expect(selectionForSession(sel, "S1")).toMatchObject({ sessionId: "S1", a: A.key, b: B.key });
    });

    it("reload: a removed Flight clears only its side, with selection_flight_not_in_session:<side>", () => {
        const sel = pick(s, A.key, B.key);
        const without = removeFlight(s, A.key, T0);
        const r = reconcileSelection(sel, "S1", sessionFlights(okLoad(without)));
        expect(r).toMatchObject({ sessionId: "S1", a: null, b: B.key });
        expect(r.cleared).toContain(`${AB_REASONS.selectionNotInSession}:a`);
        expect(r.cleared.join(" ")).not.toContain(":b");
        const withoutB = removeFlight(s, B.key, T0);
        const rb = reconcileSelection(sel, "S1", sessionFlights(okLoad(withoutB)));
        expect(rb).toMatchObject({ a: A.key, b: null });
        expect(rb.cleared).toContain(`${AB_REASONS.selectionNotInSession}:b`);
    });

    it("reload: a Flight that became unselectable clears its side with selection_flight_not_selectable:<side>", () => {
        const sel = pick(s, A.key, B.key);
        const damaged = json(s) as Loose;
        const fb = damaged.flights.find((f: StoredFlight) => f.key === B.key);
        fb.ref.status = "invalid";
        fb.ref.reasons = ["log_unreadable:synthetic"];
        fb.ref.timeRangeUs = null;
        const r = reconcileSelection(sel, "S1", sessionFlights(okLoad(damaged)));
        expect(r).toMatchObject({ a: A.key, b: null });
        expect(r.cleared).toContain(`${AB_REASONS.selectionNotSelectable}:b`);
    });

    it("reload: a Flight whose record is now rejected is not kept", () => {
        const sel = pick(s, A.key, B.key);
        const without = removeFlight(s, B.key, T0);
        const r = reconcileSelection(
            sel,
            "S1",
            sessionFlights(okLoad(without, [{ path: "flights[3]", problems: ["identity:section"] }])),
        );
        expect(r.b).toBeNull();
        expect(r.a).toBe(A.key);
    });

    it("reload of a session that is now corrupt clears both sides", () => {
        const sel = pick(s, A.key, B.key);
        const r = reconcileSelection(sel, "S1", sessionFlights({ status: "corrupt", id: "S1", problems: ["schema"] }));
        expect(r).toMatchObject({ a: null, b: null });
    });

    it("reconciling against another session id never keeps the old sides", () => {
        const sel = pick(s, A.key, B.key);
        // S2 happens to contain the same keys: a different session is still not the selection's session.
        const s2 = sessionOf([A, B], "S2");
        const r = reconcileSelection(sel, "S2", sessionFlights(okLoad(s2)));
        expect(r).toMatchObject({ sessionId: "S2", a: null, b: null });
    });
});

describe("independenceStatus", () => {
    const ev = (independence: FlightPairEvidence["independence"]) =>
        ({ ...flightPairEvidence(sessionOf([A, B]), A.key, B.key), independence }) as FlightPairEvidence;

    it("maps WU1 results exactly as the table says", () => {
        expect(independenceStatus(ev({ independent: true, relation: "distinct", reasons: [] }))).toBe("INDEPENDENT");
        expect(
            independenceStatus(ev({ independent: false, relation: "same_section", reasons: ["same_flight_section"] })),
        ).toBe("NOT_INDEPENDENT");
        expect(
            independenceStatus(
                ev({ independent: false, relation: "same_flight_content", reasons: ["same_flight_content"] }),
            ),
        ).toBe("NOT_INDEPENDENT");
        expect(
            independenceStatus(
                ev({ independent: false, relation: null, reasons: ["flight_b_identity_incomplete", "x"] }),
            ),
        ).toBe("UNKNOWN");
        expect(
            independenceStatus(ev({ independent: false, relation: null, reasons: ["flight_refs_contradict:order"] })),
        ).toBe("UNKNOWN");
        // Distinct bytes but an invalid Flight: not proven independent, not proven the same.
        expect(
            independenceStatus(ev({ independent: false, relation: "distinct", reasons: ["flight_b_invalid"] })),
        ).toBe("UNKNOWN");
    });
});

describe("abVerification", () => {
    function expectNeverEligible(v: ReturnType<typeof abVerification>) {
        expect(v.status).not.toBe("ELIGIBLE");
        expect(v.authorization).toEqual(NOT_AUTHORIZED);
    }

    it("is INCOMPLETE until A and B are chosen", () => {
        const s = sessionOf([A, B]);
        expect(abVerification(null, EMPTY_SELECTION).status).toBe("INCOMPLETE");
        expect(abVerification(s, forced(s, null, null)).status).toBe("INCOMPLETE");
        expect(abVerification(s, forced(s, A.key, null)).status).toBe("INCOMPLETE");
        expect(abVerification(s, forced(s, null, B.key)).status).toBe("INCOMPLETE");
        expect(abVerification(null, { sessionId: "x", a: A.key, b: B.key, cleared: [] }).status).not.toBe("ELIGIBLE");
        for (const v of [abVerification(null, EMPTY_SELECTION), abVerification(s, forced(s, A.key, null))]) {
            expect(v.authorization).toEqual(NOT_AUTHORIZED);
        }
    });

    it("two Flights from two BBLs, same firmware, current analysis: ELIGIBLE, and still NOT_AUTHORIZED", () => {
        const s = sessionOf([A, B]);
        const v = abVerification(s, pick(s, A.key, B.key));
        expect(v.status).toBe("ELIGIBLE");
        expect(v.independence).toBe("INDEPENDENT");
        expect(v.analysisVersion).toBe("MATCH");
        expect(v.firmware).toBe("MATCH");
        expect(Object.values(v.firmwareFields!).every((x) => x === "MATCH")).toBe(true);
        expect(v.blockers).toEqual([]);
        expect(v.missingEvidence).toEqual([]);
        expect(v.evidence).toEqual(flightPairEvidence(s, A.key, B.key));
        expect(v.authorization).toEqual(NOT_AUTHORIZED);
        expect(AB_SELECTION_AUTHORIZATION).toEqual(NOT_AUTHORIZED);
        expect(productApplyBlocks()).toEqual(["full_safety_engine_pending"]);
    });

    it("two distinct Flights of one BBL are ELIGIBLE (log index separates them)", () => {
        const s = sessionOf(twoInOne);
        const v = abVerification(s, pick(s, twoInOne[0].key, twoInOne[1].key));
        expect(v.independence).toBe("INDEPENDENT");
        expect(v.status).toBe("ELIGIBLE");
    });

    it("B as A and A as B is the same verdict", () => {
        const s = sessionOf([A, B]);
        expect(abVerification(s, pick(s, B.key, A.key)).status).toBe("ELIGIBLE");
    });

    it("the same Flight as A and B is BLOCKED: ab_same_flight_selected and same_flight_section", () => {
        const s = sessionOf([A, B]);
        const v = abVerification(s, pick(s, A.key, A.key));
        expect(v.status).toBe("BLOCKED");
        expect(v.independence).toBe("NOT_INDEPENDENT");
        expect(v.blockers).toEqual(expect.arrayContaining([AB_REASONS.sameFlight, "same_flight_section"]));
        expectNeverEligible(v);
    });

    it("a copy of A in another BBL is NOT_INDEPENDENT and BLOCKED", () => {
        const s = sessionOf([A, copyOfA]);
        expect(copyOfA.key).not.toBe(A.key);
        const v = abVerification(s, pick(s, A.key, copyOfA.key));
        expect(v.independence).toBe("NOT_INDEPENDENT");
        expect(v.blockers).toContain("same_flight_section");
        expect(v.blockers).not.toContain(AB_REASONS.sameFlight);
        expectNeverEligible(v);
        expect(v.status).toBe("BLOCKED");
    });

    it("a repackaged copy (edited header, same frames) is NOT_INDEPENDENT even though firmware matches", () => {
        const s = sessionOf([A, repackagedA]);
        const v = abVerification(s, pick(s, A.key, repackagedA.key));
        expect(v.firmware).toBe("MATCH");
        expect(v.analysisVersion).toBe("MATCH");
        expect(v.independence).toBe("NOT_INDEPENDENT");
        expect(v.blockers).toContain("same_flight_content");
        expect(v.status).toBe("BLOCKED");
    });

    it("a different firmware revision is a MISMATCH and BLOCKED", () => {
        const s = sessionOf([A, otherRevision]);
        const v = abVerification(s, pick(s, A.key, otherRevision.key));
        expect(v.independence).toBe("INDEPENDENT");
        expect(v.firmware).toBe("MISMATCH");
        expect(v.firmwareFields?.firmwareRevision).toBe("MISMATCH");
        expect(v.blockers).toContain("firmware_mismatch:firmwareRevision");
        expect(v.missingEvidence).not.toContain("firmware_mismatch:firmwareRevision");
        expect(v.status).toBe("BLOCKED");
    });

    const FIELD: Record<string, string> = {
        date: "firmwareDate",
        board: "boardInformation",
        craft: "craftName",
        api: "apiVersion",
    };
    it.each(Object.keys(FIELD))("an unlogged %s on both Flights stays UNKNOWN and is never ELIGIBLE", (k) => {
        const [a, b] = missing[k];
        const s = sessionOf([a, b]);
        const v = abVerification(s, pick(s, a.key, b.key));
        expect(v.independence).toBe("INDEPENDENT");
        expect(v.firmwareFields?.[FIELD[k] as keyof FlightPairEvidence["firmware"]]).toBe("UNKNOWN");
        expect(v.firmware).toBe("UNKNOWN");
        expect(v.missingEvidence).toContain(`firmware_unknown:${FIELD[k]}`);
        expect(v.status).toBe("BLOCKED");
        expectNeverEligible(v);
    });

    it.each(Object.keys(FIELD))("an unlogged %s on one Flight only stays UNKNOWN", (k) => {
        const [a] = missing[k];
        const s = sessionOf([a, B]);
        const v = abVerification(s, pick(s, a.key, B.key));
        expect(v.firmwareFields?.[FIELD[k] as keyof FlightPairEvidence["firmware"]]).toBe("UNKNOWN");
        expect(v.firmware).toBe("UNKNOWN");
        expect(v.status).toBe("BLOCKED");
    });

    it("a missing logged API version stays UNKNOWN although CHIRP provenance holds the same fallback", () => {
        const [a, b] = missing.api;
        const pa = a.chirps[0].qualityV2.provenance.apiVersion;
        const pb = b.chirps[0].qualityV2.provenance.apiVersion;
        expect(typeof pa).toBe("string");
        expect(pa).toBe(pb);
        const s = sessionOf([a, b]);
        const v = abVerification(s, pick(s, a.key, b.key));
        expect(v.firmwareFields?.apiVersion).toBe("UNKNOWN");
        expect(v.status).toBe("BLOCKED");
    });

    it("an API version filled in on both Flights (not logged) is not a MATCH", () => {
        const [a, b] = missing.api.map((f) => json(f) as Loose);
        for (const f of [a, b]) {
            f.firmware.apiVersion = f.chirps[0].qualityV2.provenance.apiVersion;
            f.firmware.unknown = f.firmware.unknown.filter((x: string) => x !== "apiVersion");
        }
        const s = sessionOf([a, b]);
        const v = abVerification(s, forced(s, a.key, b.key));
        expect(v.firmwareFields?.apiVersion).toBe("UNKNOWN");
        expect(v.missingEvidence.join(" ")).toMatch(/firmware_(inconsistent|unknown):apiVersion/);
        expectNeverEligible(v);
    });

    it.each(["firmwareType", "firmwareRevision", "firmwareDate", "boardInformation", "craftName"])(
        "%s set to null on both firmware blocks (in memory) is never ELIGIBLE",
        (field) => {
            const a = json(A) as Loose;
            const b = json(B) as Loose;
            a.firmware[field] = null;
            b.firmware[field] = null;
            const s = sessionOf([a, b]);
            const v = abVerification(s, forced(s, a.key, b.key));
            expect(v.firmwareFields?.[field as keyof FlightPairEvidence["firmware"]]).toBe("UNKNOWN");
            expect(v.firmware).toBe("UNKNOWN");
            expectNeverEligible(v);
        },
    );

    it("any MISMATCH outranks UNKNOWN in the firmware row", () => {
        const [a] = missing.craft;
        const s = sessionOf([a, otherRevision]);
        const v = abVerification(s, pick(s, a.key, otherRevision.key));
        expect(v.firmwareFields?.craftName).toBe("UNKNOWN");
        expect(v.firmwareFields?.firmwareRevision).toBe("MISMATCH");
        expect(v.firmware).toBe("MISMATCH");
    });

    it("both Flights on the same outdated analysis version: MATCH row, but BLOCKED", () => {
        const [a, b] = [json(A), json(B)];
        for (const f of [a, b]) {
            f.chirps.forEach((c) => ((c.qualityV2 as Loose).analysisVersion = "2.0.0"));
        }
        const s = sessionOf([a, b]);
        const v = abVerification(s, forced(s, a.key, b.key));
        expect(v.analysisVersion).toBe("MATCH");
        expect(v.blockers).toEqual(
            expect.arrayContaining(["analysis_version_outdated:a", "analysis_version_outdated:b"]),
        );
        expect(v.status).toBe("BLOCKED");
    });

    it("one Flight outdated, one current: MISMATCH, BLOCKED", () => {
        const a = json(A);
        a.chirps.forEach((c) => ((c.qualityV2 as Loose).analysisVersion = "2.0.0"));
        const s = sessionOf([a, B]);
        const v = abVerification(s, forced(s, a.key, B.key));
        expect(v.analysisVersion).toBe("MISMATCH");
        expect(v.status).toBe("BLOCKED");
    });

    it("an unknown analysis version on both Flights (the same string) is never ELIGIBLE", () => {
        const [a, b] = [json(A), json(B)];
        for (const f of [a, b]) {
            f.chirps.forEach((c) => ((c.qualityV2 as Loose).analysisVersion = "9.9.9"));
        }
        const s = sessionOf([a, b]);
        const v = abVerification(s, forced(s, a.key, b.key));
        expect(v.missingEvidence).toEqual(
            expect.arrayContaining(["analysis_version_unknown:a", "analysis_version_unknown:b"]),
        );
        expect(v.status).toBe("BLOCKED");
    });

    it("a missing (non-string) analysis version is UNKNOWN, never MATCH", () => {
        const [a, b] = [json(A) as Loose, json(B) as Loose];
        for (const f of [a, b]) {
            f.chirps.forEach((c: Loose) => delete c.qualityV2.analysisVersion);
        }
        const s = sessionOf([a, b]);
        const v = abVerification(s, forced(s, a.key, b.key));
        expect(v.analysisVersion).toBe("UNKNOWN");
        expectNeverEligible(v);
    });

    it("one Flight without a version, the other current: UNKNOWN, not MISMATCH", () => {
        const a = json(A) as Loose;
        a.chirps.forEach((c: Loose) => (c.qualityV2.analysisVersion = null));
        const s = sessionOf([a, B]);
        const v = abVerification(s, forced(s, a.key, B.key));
        expect(v.analysisVersion).toBe("UNKNOWN");
        expectNeverEligible(v);
    });

    it("a Flight without CHIRPs has no provable analysis version", () => {
        const a = json(A);
        a.chirps = [];
        const s = sessionOf([a, B]);
        const v = abVerification(s, forced(s, a.key, B.key));
        expect(v.analysisVersion).toBe("UNKNOWN");
        expectNeverEligible(v);
    });

    it("a damaged FlightRef makes independence UNKNOWN (not NOT_INDEPENDENT) and is missing evidence", () => {
        const b = json(B) as Loose;
        b.ref.section.sha256 = "not-a-hash";
        const s = sessionOf([A]);
        s.flights.push(b);
        const v = abVerification(s, forced(s, A.key, B.key));
        expect(v.independence).toBe("UNKNOWN");
        expect(v.missingEvidence).toContain("flight_b_identity_incomplete");
        expectNeverEligible(v);
        expect(v.status).toBe("BLOCKED");
    });

    it("an unreadable Flight (status invalid) makes independence UNKNOWN", () => {
        const b = json(B) as Loose;
        b.ref.status = "invalid";
        b.ref.reasons = ["log_unreadable:x"];
        b.ref.timeRangeUs = null;
        const s = sessionOf([A, b]);
        const v = abVerification(s, forced(s, A.key, B.key));
        expect(v.independence).toBe("UNKNOWN");
        expectNeverEligible(v);
    });

    it("contradictory references of one file make independence UNKNOWN", () => {
        const b = json(twoInOne[1]) as Loose;
        b.ref.section.byteBegin = 0; // overlaps log 1 of the same file
        const s = sessionOf([twoInOne[0], b]);
        const v = abVerification(s, forced(s, twoInOne[0].key, b.key));
        expect(v.evidence?.independence.reasons).toContain("flight_refs_contradict:order");
        expect(v.independence).toBe("UNKNOWN");
        expectNeverEligible(v);
    });

    it("a key that is not in the session is never ELIGIBLE", () => {
        const s = sessionOf([A, B]);
        const v = abVerification(s, forced(s, A.key, copyOfA.key));
        expect(v.blockers).toContain("flight_not_in_session:b");
        expectNeverEligible(v);
    });

    it("a selection that belongs to another session is never ELIGIBLE for this one", () => {
        const s = sessionOf([A, B], "S1");
        const v = abVerification(s, { sessionId: "S2", a: A.key, b: B.key, cleared: [] });
        expectNeverEligible(v);
    });

    it("missing evidence is a subset of the blockers, and blockers include every evidence blocker", () => {
        const cases: [TuneSession, string, string][] = [];
        const add = (fs: StoredFlight[], a: string, b: string) => cases.push([sessionOf(fs), a, b]);
        add([A, B], A.key, A.key);
        add([A, copyOfA], A.key, copyOfA.key);
        add(missing.api, missing.api[0].key, missing.api[1].key);
        add([missing.craft[0], otherRevision], missing.craft[0].key, otherRevision.key);
        for (const [s, a, b] of cases) {
            const v = abVerification(s, forced(s, a, b));
            for (const m of v.missingEvidence) {
                expect(v.blockers).toContain(m);
            }
            for (const blocker of v.evidence!.blockers) {
                expect(v.blockers).toContain(blocker);
            }
            expect(v.status).toBe("BLOCKED");
        }
    });

    it("no single in-memory corruption of a good pair is ever ELIGIBLE", () => {
        const edits: [string, (a: Loose, b: Loose) => void][] = [
            ["craft forged equal", (a, b) => ((a.firmware.craftName = "X"), (b.firmware.craftName = "X"))],
            ["api null", (a) => ((a.firmware.apiVersion = null), (a.firmware.unknown = ["apiVersion"]))],
            ["api chirp differs", (a) => (a.chirps[0].qualityV2.provenance.apiVersion = "1.46.0")],
            ["logHeaders dropped", (a) => (a.logHeaders = null)],
            ["revision differs", (a) => (a.firmware.firmwareRevision = "other")],
            ["ref schema", (a) => (a.ref.schema = "v0")],
            ["ref locationId", (a) => (a.ref.locationId = "x#0")],
            ["body prefix copied", (a, b) => (a.ref.bodyPrefix = json(b.ref.bodyPrefix))],
            ["section copied", (a, b) => (a.ref.section = json(b.ref.section))],
            ["chirps empty", (a) => (a.chirps = [])],
            ["analysis 2.0.0", (a) => (a.chirps[0].qualityV2.analysisVersion = "2.0.0")],
            ["analysis number", (a) => (a.chirps[0].qualityV2.analysisVersion = 2)],
        ];
        for (const [name, edit] of edits) {
            const a = json(A) as Loose;
            const b = json(B) as Loose;
            edit(a, b);
            const s = sessionOf([B]);
            s.flights.unshift(a);
            const v = abVerification(s, forced(s, a.key, b.key));
            expect(v.status, name).not.toBe("ELIGIBLE");
            expect(v.authorization, name).toEqual(NOT_AUTHORIZED);
        }
    });

    it("never mutates the session or the selection", () => {
        const s = deepFreeze(sessionOf([A, B]));
        const sel = deepFreeze(forced(s, A.key, B.key));
        expect(() => abVerification(s, sel)).not.toThrow();
    });

    it("a result's authorization cannot be widened by a caller", () => {
        const snapshot = json(AB_SELECTION_AUTHORIZATION);
        const restore = () => {
            try {
                Object.assign(AB_SELECTION_AUTHORIZATION as Loose, json(snapshot));
                (AB_SELECTION_AUTHORIZATION as Loose).reasons.splice(0, Infinity, ...snapshot.reasons);
            } catch {
                // frozen: nothing to restore
            }
        };
        onTestFinished(restore);
        const s = sessionOf([A, B]);
        const v1 = abVerification(s, forced(s, A.key, B.key));
        try {
            (v1.authorization as Loose).status = "AUTHORIZED";
            (v1.authorization as Loose).reasons.length = 0;
        } catch {
            // frozen: fine
        }
        expect(abVerification(s, forced(s, A.key, B.key)).authorization).toEqual(NOT_AUTHORIZED);
        expect(AB_SELECTION_AUTHORIZATION).toEqual(NOT_AUTHORIZED);
        expect(productApplyBlocks()).toEqual(["full_safety_engine_pending"]);
    });
});

/* ---------------- composable ---------------- */

let ids = 0;
function newStore(factory = new IDBFactory()): TuneSessionStore {
    return openTuneSessionStore({ indexedDB: factory, now: () => new Date(T0), newId: () => `sess-${++ids}` });
}

async function putRaw(factory: IDBFactory, record: unknown) {
    const s = newStore(factory);
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

async function getRaw(factory: IDBFactory, id: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const req = factory.open(TUNE_SESSION_DB_NAME);
        req.onsuccess = () => {
            const tx = req.result.transaction(TUNE_SESSION_STORE, "readonly");
            const g = tx.objectStore(TUNE_SESSION_STORE).get(id);
            g.onsuccess = () => (req.result.close(), resolve(g.result));
            g.onerror = () => reject(g.error);
        };
        req.onerror = () => reject(req.error);
    });
}

const tick = () => new Promise((r) => setTimeout(r, 20));

interface Pending {
    kind: "load" | "list";
    id: string | null;
    release(): Promise<void>;
    fail(err: unknown): void;
}

/** A real store whose load/list are held until the test releases them, in any order. */
function controlled(base: TuneSessionStore) {
    const pending: Pending[] = [];
    let hold = true;
    const gate = <T>(kind: Pending["kind"], id: string | null, run: () => Promise<T>): Promise<T> => {
        if (!hold) {
            return run();
        }
        return new Promise<T>((resolve, reject) => {
            pending.push({
                kind,
                id,
                release: async () => {
                    try {
                        resolve(await run());
                    } catch (err) {
                        reject(err);
                    }
                    await tick();
                },
                fail: (err) => reject(err),
            });
        });
    };
    const store: TuneSessionStore = {
        create: (name, flights) => base.create(name, flights),
        load: (id) => gate("load", id, () => base.load(id)),
        list: () => gate("list", null, () => base.list()),
        save: (s, o) => base.save(s, o),
        remove: (id) => base.remove(id),
        close: () => base.close(),
    };
    return {
        store,
        pending,
        setHold: (v: boolean) => (hold = v),
        take: (kind: Pending["kind"], id: string | null = null) => {
            const i = pending.findIndex((p) => p.kind === kind && (id === null || p.id === id));
            expect(i, `pending ${kind} ${id}`).toBeGreaterThanOrEqual(0);
            return pending.splice(i, 1)[0];
        },
    };
}

function selector(store: TuneSessionStore) {
    const scope = effectScope();
    const api = scope.run(() => useFlightAbSelector({ store, now: () => new Date(T0) }))!;
    return { ...api, stop: () => scope.stop() };
}

describe("useFlightAbSelector", () => {
    it("lists, opens and selects by key; refused selections leave state unchanged", async () => {
        const store = newStore();
        const s = await store.create("one", [A, B, ...twoInOne]);
        const sel = selector(store);
        await sel.refreshSessions();
        expect(sel.listState.value).toBe("ready");
        expect(sel.sessions.value.map((x: SessionSummary) => x.id)).toEqual([s.id]);
        await sel.openSession(s.id);
        expect(sel.sessionId.value).toBe(s.id);
        expect(sel.session.value?.id).toBe(s.id);
        expect(sel.flights.value.options.map((o) => o.key)).toEqual([A.key, B.key, twoInOne[0].key, twoInOne[1].key]);
        expect(sel.verification.value.status).toBe("INCOMPLETE");
        expect(sel.select("a", A.key)).toBe(true);
        const before = sel.selection.value;
        expect(sel.select("b", "0")).toBe(false);
        expect(sel.select("b", copyOfA.key)).toBe(false);
        expect(sel.selection.value).toEqual(before);
        expect(sel.select("b", B.key)).toBe(true);
        expect(sel.selection.value).toMatchObject({ sessionId: s.id, a: A.key, b: B.key });
        expect(sel.verification.value.status).toBe("ELIGIBLE");
        expect(sel.verification.value.authorization).toEqual(NOT_AUTHORIZED);
        expect(sel.verification.value).toEqual(abVerification(sel.session.value, sel.selection.value));
        expect(productApplyBlocks()).toEqual(["full_safety_engine_pending"]);
        sel.stop();
    });

    it("select() before any session is open is refused", async () => {
        const sel = selector(newStore());
        expect(sel.select("a", A.key)).toBe(false);
        expect(sel.selection.value.a).toBeNull();
        sel.stop();
    });

    it("opening, selecting and reloading never write to the store", async () => {
        const factory = new IDBFactory();
        const store = newStore(factory);
        const s = await store.create("one", [A, B]);
        const before = await getRaw(factory, s.id);
        const sel = selector(store);
        await sel.refreshSessions();
        await sel.openSession(s.id);
        sel.select("a", A.key);
        sel.select("b", B.key);
        await sel.reloadSession();
        await tick();
        expect(await getRaw(factory, s.id)).toEqual(before);
        expect((await store.list()).length).toBe(1);
        sel.stop();
    });

    it("switching sessions clears the selection with selection_session_changed", async () => {
        const store = newStore();
        const s1 = await store.create("one", [A, B]);
        const s2 = await store.create("two", [A, B]);
        const sel = selector(store);
        await sel.openSession(s1.id);
        sel.select("a", A.key);
        sel.select("b", B.key);
        await sel.openSession(s2.id);
        expect(sel.selection.value).toMatchObject({ sessionId: s2.id, a: null, b: null });
        expect(sel.selection.value.cleared).toContain(AB_REASONS.sessionChanged);
        // The same keys exist in s2, but nothing carried over.
        expect(sel.verification.value.status).toBe("INCOMPLETE");
        await sel.openSession(null);
        expect(sel.session.value).toBeNull();
        expect(sel.selection.value).toMatchObject({ a: null, b: null });
        sel.stop();
    });

    it("reload after the Flight was removed clears only that side", async () => {
        const store = newStore();
        const s = await store.create("one", [A, B, twoInOne[0]]);
        const sel = selector(store);
        await sel.openSession(s.id);
        sel.select("a", A.key);
        sel.select("b", B.key);
        await store.save(removeFlight(s, A.key, T0));
        await sel.reloadSession();
        expect(sel.selection.value).toMatchObject({ sessionId: s.id, a: null, b: B.key });
        expect(sel.selection.value.cleared).toContain(`${AB_REASONS.selectionNotInSession}:a`);
        expect(sel.verification.value.status).toBe("INCOMPLETE");
        sel.stop();
    });

    it("reload after the session was deleted clears both sides", async () => {
        const store = newStore();
        const s = await store.create("one", [A, B]);
        const sel = selector(store);
        await sel.openSession(s.id);
        sel.select("a", A.key);
        sel.select("b", B.key);
        await store.remove(s.id);
        await sel.reloadSession();
        expect(sel.selection.value).toMatchObject({ a: null, b: null });
        expect(sel.verification.value.status).toBe("INCOMPLETE");
        sel.stop();
    });

    it("a corrupt FlightRef written raw into IndexedDB: the Flight is rejected, not selectable", async () => {
        const factory = new IDBFactory();
        const record = json(sessionOf([A, B], "raw-ref")) as Loose;
        record.flights[1].ref.section.sha256 = `${"0".repeat(63)}z`;
        await putRaw(factory, record);
        const sel = selector(newStore(factory));
        await sel.openSession("raw-ref");
        expect(sel.loaded.value?.status).toBe("ok");
        expect(sel.flights.value.rejected.map((r) => r.path)).toEqual(["flights[1]"]);
        const optB = sel.flights.value.options.find((o) => o.key === B.key);
        expect(optB?.selectable ?? false).toBe(false);
        expect(sel.select("b", B.key)).toBe(false);
        expect(sel.select("a", A.key)).toBe(true);
        sel.stop();
    });

    it("a damaged CHIRP written raw: the Flight stays selectable and shows the left-out count", async () => {
        const factory = new IDBFactory();
        const record = json(sessionOf([threeChirps, B], "raw-chirp")) as Loose;
        record.flights[0].chirps[1].qualityV2.identity.chirpIndex += 1;
        await putRaw(factory, record);
        const sel = selector(newStore(factory));
        await sel.openSession("raw-chirp");
        const o = sel.flights.value.options.find((x) => x.key === threeChirps.key)!;
        expect(o.selectable).toBe(true);
        expect(o.rejectedChirpCount).toBe(1);
        expect(o.chirpCount + o.rejectedChirpCount).toBe(3);
        sel.stop();
    });

    it("every CHIRP of a Flight damaged raw: flight_no_valid_chirps", async () => {
        const factory = new IDBFactory();
        const record = json(sessionOf([threeChirps, B], "raw-all")) as Loose;
        for (const c of record.flights[0].chirps) {
            c.qualityV2.identity.chirpIndex += 7;
        }
        await putRaw(factory, record);
        const sel = selector(newStore(factory));
        await sel.openSession("raw-all");
        const o = sel.flights.value.options.find((x) => x.key === threeChirps.key)!;
        expect(o.selectable).toBe(false);
        expect(o.reasons).toContain(AB_REASONS.noChirps);
        expect(o.rejectedChirpCount).toBe(3);
        expect(sel.select("a", threeChirps.key)).toBe(false);
        sel.stop();
    });

    it("an unreadable FlightRef written raw stays stored and is not selectable", async () => {
        const factory = new IDBFactory();
        const record = json(sessionOf([A, B], "raw-invalid")) as Loose;
        const f = record.flights[1];
        f.ref.status = "invalid";
        f.ref.reasons = ["log_unreadable:synthetic"];
        f.ref.timeRangeUs = null;
        for (const c of f.chirps) {
            c.qualityV2.identity.flight.ref = f.ref;
        }
        await putRaw(factory, record);
        const sel = selector(newStore(factory));
        await sel.openSession("raw-invalid");
        expect(sel.loaded.value?.status).toBe("ok");
        const o = sel.flights.value.options.find((x) => x.key === B.key)!;
        expect(o).toBeDefined();
        expect(o.selectable).toBe(false);
        expect(o.reasons).toContain(AB_REASONS.flightUnreadable);
        expect(o.reasons.join(" ")).toContain("log_unreadable:synthetic");
        sel.stop();
    });

    it("a corrupt session written raw: nothing selectable, and the record is left as it is", async () => {
        const factory = new IDBFactory();
        const record = json(sessionOf([A, B], "raw-corrupt")) as Loose;
        record.authorization = { status: "AUTHORIZED", reasons: [] };
        await putRaw(factory, record);
        const store = newStore(factory);
        const sel = selector(store);
        await sel.refreshSessions();
        expect(sel.sessions.value[0]?.status).toBe("corrupt");
        await sel.openSession("raw-corrupt");
        expect(sel.loaded.value?.status).toBe("corrupt");
        expect(sel.session.value).toBeNull();
        expect(sel.flights.value.options.filter((o) => o.selectable)).toEqual([]);
        expect(sel.select("a", A.key)).toBe(false);
        expect(sel.verification.value.status).toBe("INCOMPLETE");
        expect(await getRaw(factory, "raw-corrupt")).toEqual(record);
        sel.stop();
    });

    it("a slow load of an earlier session never replaces the session opened since", async () => {
        const base = newStore();
        const s1 = await base.create("one", [A, B]);
        const s2 = await base.create("two", [twoInOne[0], twoInOne[1]]);
        const c = controlled(base);
        const sel = selector(c.store);
        const p1 = sel.openSession(s1.id);
        const p2 = sel.openSession(s2.id);
        await c.take("load", s2.id).release();
        await p2;
        sel.select("a", twoInOne[0].key);
        await c.take("load", s1.id).release();
        await p1;
        await tick();
        expect(sel.sessionId.value).toBe(s2.id);
        expect(sel.session.value?.id).toBe(s2.id);
        expect(sel.selection.value).toMatchObject({ sessionId: s2.id, a: twoInOne[0].key });
        expect(sel.flights.value.options.map((o) => o.key)).toEqual([twoInOne[0].key, twoInOne[1].key]);
        sel.stop();
    });

    it("an older load resolving first is still replaced by the newer one", async () => {
        const base = newStore();
        const s1 = await base.create("one", [A, B]);
        const s2 = await base.create("two", twoInOne);
        const c = controlled(base);
        const sel = selector(c.store);
        const p1 = sel.openSession(s1.id);
        const p2 = sel.openSession(s2.id);
        await c.take("load", s1.id).release();
        await p1;
        // Selecting into the stale session while s2 is pending must not leak into s2.
        sel.select("a", A.key);
        await c.take("load", s2.id).release();
        await p2;
        expect(sel.session.value?.id).toBe(s2.id);
        expect(sel.selection.value).toMatchObject({ sessionId: s2.id, a: null, b: null });
        sel.stop();
    });

    it("a stale load error never overrides a newer successful load", async () => {
        const base = newStore();
        const s1 = await base.create("one", [A, B]);
        const s2 = await base.create("two", twoInOne);
        const c = controlled(base);
        const sel = selector(c.store);
        const p1 = sel.openSession(s1.id);
        const p2 = sel.openSession(s2.id);
        await c.take("load", s2.id).release();
        await p2;
        c.take("load", s1.id).fail(new Error("synthetic io failure"));
        await p1.catch(() => undefined);
        await tick();
        expect(sel.loadError.value).toBeNull();
        expect(sel.loadState.value).not.toBe("error");
        expect(sel.session.value?.id).toBe(s2.id);
        sel.stop();
    });

    it("a stale reload of the old session after switching does not come back", async () => {
        const base = newStore();
        const s1 = await base.create("one", [A, B]);
        const s2 = await base.create("two", twoInOne);
        const c = controlled(base);
        c.setHold(false);
        const sel = selector(c.store);
        await sel.openSession(s1.id);
        c.setHold(true);
        const r = sel.reloadSession();
        const p2 = sel.openSession(s2.id);
        await c.take("load", s2.id).release();
        await p2;
        await c.take("load", s1.id).release();
        await r;
        await tick();
        expect(sel.sessionId.value).toBe(s2.id);
        expect(sel.session.value?.id).toBe(s2.id);
        sel.stop();
    });

    it("an older list resolving last never replaces a newer list", async () => {
        const base = newStore();
        const c = controlled(base);
        const sel = selector(c.store);
        const l1 = sel.refreshSessions(); // sees no sessions
        const old = c.take("list");
        const created = await base.create("new", [A]);
        const l2 = sel.refreshSessions();
        await c.take("list").release();
        await l2;
        expect(sel.sessions.value.map((x) => x.id)).toEqual([created.id]);
        await base.remove(created.id);
        await old.release(); // now resolves to an empty list
        await l1;
        await tick();
        expect(sel.sessions.value.map((x) => x.id)).toEqual([created.id]);
        expect(sel.listState.value).toBe("ready");
        sel.stop();
    });

    it("an older list failing after a newer one succeeded leaves no error", async () => {
        const c = controlled(newStore());
        const sel = selector(c.store);
        const l1 = sel.refreshSessions();
        const old = c.take("list");
        const l2 = sel.refreshSessions();
        await c.take("list").release();
        await l2;
        old.fail(new Error("synthetic"));
        await l1.catch(() => undefined);
        await tick();
        expect(sel.listState.value).toBe("ready");
        expect(sel.listError.value).toBeNull();
        sel.stop();
    });

    it("a load error is reported, with no session and nothing selectable", async () => {
        const base = newStore();
        const s1 = await base.create("one", [A, B]);
        const c = controlled(base);
        const sel = selector(c.store);
        const p = sel.openSession(s1.id);
        c.take("load", s1.id).fail(new Error("synthetic io failure"));
        await p.catch(() => undefined);
        expect(sel.loadState.value).toBe("error");
        expect(sel.loadError.value).toBeTruthy();
        expect(sel.session.value).toBeNull();
        expect(sel.select("a", A.key)).toBe(false);
        expect(sel.verification.value.status).toBe("INCOMPLETE");
        sel.stop();
    });

    it("a list error is reported", async () => {
        const c = controlled(newStore());
        const sel = selector(c.store);
        const p = sel.refreshSessions();
        c.take("list").fail(new Error("synthetic"));
        await p.catch(() => undefined);
        expect(sel.listState.value).toBe("error");
        expect(sel.listError.value).toBeTruthy();
        sel.stop();
    });

    it("a reload error after a selection does not keep a stale ELIGIBLE pair", async () => {
        const base = newStore();
        const s1 = await base.create("one", [A, B]);
        const c = controlled(base);
        c.setHold(false);
        const sel = selector(c.store);
        await sel.openSession(s1.id);
        sel.select("a", A.key);
        sel.select("b", B.key);
        expect(sel.verification.value.status).toBe("ELIGIBLE");
        c.setHold(true);
        const r = sel.reloadSession();
        c.take("load", s1.id).fail(new Error("synthetic"));
        await r.catch(() => undefined);
        expect(sel.loadState.value).toBe("error");
        expect(sel.verification.value.status).not.toBe("ELIGIBLE");
        sel.stop();
    });

    it("results arriving after the scope is stopped are dropped", async () => {
        const base = newStore();
        const s1 = await base.create("one", [A, B]);
        const c = controlled(base);
        const sel = selector(c.store);
        const p = sel.openSession(s1.id);
        sel.stop();
        await c.take("load", s1.id).release();
        await p.catch(() => undefined);
        expect(sel.session.value).toBeNull();
    });
});

describe("useFlightAbSelector.saveAnalysis", () => {
    it("saves as a new session only when asked, with no authorization", async () => {
        const factory = new IDBFactory();
        const store = newStore(factory);
        const sel = selector(store);
        await sel.refreshSessions();
        expect(await store.list()).toEqual([]);
        const r = await sel.saveAnalysis(await reportOf(bytesA, "a.bbl"), { intoOpenSession: false, name: "new" });
        expect(r.status).toBe("saved");
        expect(r.sessionId).toBeTruthy();
        const loaded = await store.load(r.sessionId!);
        expect(loaded.status).toBe("ok");
        if (loaded.status === "ok") {
            expect(loaded.session.flights.map((f) => f.key)).toEqual([A.key]);
            expect(loaded.session.authorization.status).toBe("NOT_STORED");
        }
        expect(productApplyBlocks()).toEqual(["full_safety_engine_pending"]);
        sel.stop();
    });

    it("adding a copy to the open session reports it as not independent", async () => {
        const store = newStore();
        const s = await store.create("one", [A]);
        const sel = selector(store);
        await sel.openSession(s.id);
        const bytes = concatLogs(log(30_000_000, 1), bytesA);
        const r = await sel.saveAnalysis(await reportOf(bytes, "copy.bbl"), { intoOpenSession: true, name: "" });
        expect(r.status).toBe("saved");
        expect(r.sessionId).toBe(s.id);
        expect(r.notIndependent).toEqual([expect.objectContaining({ key: copyOfA.key, otherKey: A.key })]);
        const loaded = await store.load(s.id);
        expect(loaded.status === "ok" && loaded.session.flights.length).toBe(3);
        sel.stop();
    });

    it("a report without WU1 identity has nothing to save and writes nothing", async () => {
        const store = newStore();
        const sel = selector(store);
        const report = qualifyChirpFile(bytesA, "a.bbl", 60, AUTOTUNE_MATH);
        const r = await sel.saveAnalysis(report, { intoOpenSession: false, name: "x" });
        expect(r.status).toBe("nothing_to_save");
        expect(r.skipped).toEqual([{ logIndex: 0, reasons: ["flight_identity_unknown"] }]);
        expect(await store.list()).toEqual([]);
        sel.stop();
    });

    it("adding to a session that loaded with rejected parts is refused and the record is untouched", async () => {
        const factory = new IDBFactory();
        const record = json(sessionOf([threeChirps], "raw-partial")) as Loose;
        record.flights[0].chirps[2].qualityV2.identity.chirpIndex += 5;
        await putRaw(factory, record);
        const store = newStore(factory);
        const sel = selector(store);
        await sel.openSession("raw-partial");
        expect(sel.loaded.value?.status === "ok" && sel.loaded.value.rejected.length).toBe(1);
        const r = await sel.saveAnalysis(await reportOf(bytesB, "b.bbl"), { intoOpenSession: true, name: "" });
        expect(r.status).not.toBe("saved");
        expect(await getRaw(factory, "raw-partial")).toEqual(record);
        sel.stop();
    });

    it("adding to the open session when none is open does not write into some other session", async () => {
        const store = newStore();
        const s = await store.create("one", [A]);
        const sel = selector(store);
        const r = await sel.saveAnalysis(await reportOf(bytesB, "b.bbl"), { intoOpenSession: true, name: "" });
        if (r.status === "saved") {
            expect(r.sessionId).not.toBe(s.id);
        }
        const loaded = await store.load(s.id);
        expect(loaded.status === "ok" && loaded.session.flights.length).toBe(1);
        sel.stop();
    });
});

/* ---------------- component ---------------- */

async function mountSelector(store: TuneSessionStore) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const app = createApp({
        render: () => h(UApp, { portal: false }, { default: () => h(FlightAbSelector, { store }) }),
    });
    app.config.globalProperties.$t = ((key: string) => key) as never;
    app.use(createPinia());
    app.mount(container);
    await tick();
    return { container, unmount: () => (app.unmount(), container.remove()) };
}

const q = (root: ParentNode, hook: string) => root.querySelector<HTMLElement>(`[data-gyrocore="${hook}"]`);

async function choose(select: HTMLSelectElement | null, value: string) {
    expect(select).not.toBeNull();
    expect([...select!.options].map((o) => o.value)).toContain(value);
    select!.value = value;
    select!.dispatchEvent(new Event("change"));
    await nextTick();
    await tick();
}

describe("FlightAbSelector.vue", () => {
    beforeEach(() => {
        expert.on = false;
    });

    it("is hidden without Expert Mode and appears when Expert Mode is switched on", async () => {
        const { container, unmount } = await mountSelector(newStore());
        expect(q(container, "flight-ab-selector")).toBeNull();
        expert.on = true;
        EventBus.$emit("expert-mode-change", true);
        await nextTick();
        await tick();
        expect(q(container, "flight-ab-selector")).not.toBeNull();
        expert.on = false;
        EventBus.$emit("expert-mode-change", false);
        await nextTick();
        expect(q(container, "flight-ab-selector")).toBeNull();
        unmount();
    });

    it("shows the empty state when no session is stored", async () => {
        expert.on = true;
        const { container, unmount } = await mountSelector(newStore());
        await vi.waitFor(() => expect(q(container, "ab-sessions-empty")).not.toBeNull());
        expect(q(container, "ab-status")?.getAttribute("data-status") ?? "INCOMPLETE").not.toBe("ELIGIBLE");
        unmount();
    });

    it("drives a full selection: ELIGIBLE for A/B, BLOCKED for the same Flight, never a Verified Tune", async () => {
        expert.on = true;
        const store = newStore();
        const s = await store.create("synthetic", [A, B, copyOfA]);
        const { container, unmount } = await mountSelector(store);
        await vi.waitFor(() =>
            expect([...q(container, "ab-session-select")!.querySelectorAll("option")].map((o) => o.value)).toContain(
                s.id,
            ),
        );
        await choose(q(container, "ab-session-select") as HTMLSelectElement, s.id);
        await vi.waitFor(() =>
            expect(container.querySelectorAll('[data-gyrocore="ab-flights"] [data-flight]').length).toBe(3),
        );
        const items = [...container.querySelectorAll('[data-gyrocore="ab-flights"] [data-flight]')];
        expect(items.map((i) => i.getAttribute("data-flight"))).toEqual([A.key, B.key, copyOfA.key]);
        expect(items.every((i) => i.getAttribute("data-selectable") === "yes")).toBe(true);
        expect(q(container, "ab-status")?.getAttribute("data-status")).toBe("INCOMPLETE");

        await choose(q(container, "ab-select-a") as HTMLSelectElement, A.key);
        expect(q(container, "ab-status")?.getAttribute("data-status")).toBe("INCOMPLETE");
        await choose(q(container, "ab-select-b") as HTMLSelectElement, B.key);
        expect((q(container, "ab-select-a") as HTMLSelectElement).value).toBe(A.key);
        expect(q(container, "ab-status")?.getAttribute("data-status")).toBe("ELIGIBLE");
        const rows = [...q(container, "ab-status-rows")!.querySelectorAll("[data-row]")];
        expect(rows.map((r) => r.getAttribute("data-row"))).toEqual(
            expect.arrayContaining(["independence", "analysisVersion", "firmware", "missing", "blockers"]),
        );
        const row = (name: string) =>
            rows.find((r) => r.getAttribute("data-row") === name)?.getAttribute("data-status");
        expect(row("independence")).toBe("INDEPENDENT");
        expect(row("analysisVersion")).toBe("MATCH");
        expect(row("firmware")).toBe("MATCH");
        expect(q(container, "ab-not-verified-tune")).not.toBeNull();

        await choose(q(container, "ab-select-b") as HTMLSelectElement, copyOfA.key);
        expect(q(container, "ab-status")?.getAttribute("data-status")).toBe("BLOCKED");
        expect(q(container, "ab-not-verified-tune")).not.toBeNull();

        await choose(q(container, "ab-select-b") as HTMLSelectElement, A.key);
        expect(q(container, "ab-status")?.getAttribute("data-status")).toBe("BLOCKED");
        expect(q(container, "ab-status-rows")!.textContent).toContain(AB_REASONS.sameFlight);
        expect(productApplyBlocks()).toEqual(["full_safety_engine_pending"]);
        unmount();
    });

    it("offers no rejected Flight as A or B, and lists it as not selectable", async () => {
        expert.on = true;
        const factory = new IDBFactory();
        const record = json(sessionOf([A, B], "raw-ui")) as Loose;
        record.flights[1].ref.section.sha256 = "zz";
        await putRaw(factory, record);
        const { container, unmount } = await mountSelector(newStore(factory));
        await vi.waitFor(() =>
            expect([...q(container, "ab-session-select")!.querySelectorAll("option")].map((o) => o.value)).toContain(
                "raw-ui",
            ),
        );
        await choose(q(container, "ab-session-select") as HTMLSelectElement, "raw-ui");
        await vi.waitFor(() =>
            expect(
                container
                    .querySelector('[data-gyrocore="ab-flights"] [data-rejected="flights[1]"]')
                    ?.getAttribute("data-selectable"),
            ).toBe("no"),
        );
        for (const side of ["ab-select-a", "ab-select-b"]) {
            const opts = [...(q(container, side) as HTMLSelectElement).options].filter((o) => !o.disabled);
            expect(opts.map((o) => o.value)).not.toContain(B.key);
        }
        unmount();
    });

    it("a corrupt session shows a problem and no selectable Flight", async () => {
        expert.on = true;
        const factory = new IDBFactory();
        const record = json(sessionOf([A, B], "raw-ui-corrupt")) as Loose;
        record.schema = "something-else";
        await putRaw(factory, record);
        const { container, unmount } = await mountSelector(newStore(factory));
        await vi.waitFor(() =>
            expect([...q(container, "ab-session-select")!.querySelectorAll("option")].map((o) => o.value)).toContain(
                "raw-ui-corrupt",
            ),
        );
        await choose(q(container, "ab-session-select") as HTMLSelectElement, "raw-ui-corrupt");
        await vi.waitFor(() => expect(q(container, "ab-session-problem")).not.toBeNull());
        expect(container.querySelectorAll('[data-gyrocore="ab-flights"] [data-selectable="yes"]').length).toBe(0);
        expect(q(container, "ab-status")?.getAttribute("data-status") ?? "INCOMPLETE").toBe("INCOMPLETE");
        unmount();
    });
});
