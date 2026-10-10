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
 * WU3 review fixes: a stored CHIRP's identity must agree with its Quality V2
 * identity, and the stored firmware identity with the FlightRef header and the
 * CHIRPs' API version. Every tampered record is checked in memory, after a JSON
 * round trip and after an IndexedDB round trip. SYNTHETIC logs only.
 */

import { IDBFactory } from "fake-indexeddb";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { attachChirpFlightIdentity } from "../../src/gyrocore/chirp/qualityV2/identity";
import { addFlights, flightPairEvidence, flightsFromReport, newTuneSession } from "../../src/gyrocore/session/build";
import type { StoredFlight, TuneSession } from "../../src/gyrocore/session/contract";
import {
    openTuneSessionStore,
    readRecord,
    TUNE_SESSION_DB_NAME,
    TUNE_SESSION_STORE,
} from "../../src/gyrocore/session/storage";
import { DURATION_TOLERANCE_S, validateTuneSession } from "../../src/gyrocore/session/validate";
import { readFixtureBytes, readFixtureJson } from "./harness/fixtures";

vi.mock("../../src/js/localization", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/js/localization")>()),
    i18n: { getMessage: (key: string) => key },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const CASES = new Map(
    readFixtureJson<{ cases: { case_id: string; bbl: string }[] }>("chirp/cases.json").cases.map(
        (c) => [c.case_id, c.bbl] as const,
    ),
);
const fixture = (id: string) => readFixtureBytes(`chirp/${CASES.get(id)!}`);
const T0 = "2026-10-10T20:00:00.000Z";
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

async function flightsOf(bytes: Uint8Array, fileName: string): Promise<StoredFlight[]> {
    const report = qualifyChirpFile(bytes, fileName, 60, AUTOTUNE_MATH);
    await attachChirpFlightIdentity(report, bytes);
    return flightsFromReport(report, { fileName, analyzedAt: T0 }).flights;
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

/** SYNTHETIC: a three-CHIRP Flight and a one-CHIRP Flight from another file. */
let three: StoredFlight;
let single: StoredFlight;
/** SYNTHETIC: the single-axis log with a different board, so its FlightRef header differs. */
let otherBoard: StoredFlight;

beforeAll(async () => {
    [three] = await flightsOf(fixture("three_axis_sequence"), "three.bbl");
    const clean = fixture("clean_single_axis");
    [single] = await flightsOf(clean, "single.bbl");
    [otherBoard] = await flightsOf(
        replaceText(clean, "H Board information:SYNT SYNTHETIC", "H Board information:SYNT OTHERBRD"),
        "other.bbl",
    );
});

function session(): TuneSession {
    return json(addFlights(newTuneSession({ id: "review", name: "review", now: T0 }), [three, single], T0).session);
}

async function viaIndexedDb(raw: unknown) {
    const factory = new IDBFactory();
    const store = openTuneSessionStore({ indexedDB: factory });
    await store.list();
    store.close();
    await new Promise<void>((resolve, reject) => {
        const req = factory.open(TUNE_SESSION_DB_NAME);
        req.onsuccess = () => {
            const tx = req.result.transaction(TUNE_SESSION_STORE, "readwrite");
            tx.objectStore(TUNE_SESSION_STORE).put(raw);
            tx.oncomplete = () => (req.result.close(), resolve());
            tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
    });
    const reopened = openTuneSessionStore({ indexedDB: factory });
    const loaded = await reopened.load("review");
    const listed = await reopened.list();
    reopened.close();
    return { loaded, listed };
}

/** The same verdict in memory, after JSON and after IndexedDB. */
async function everyWay(raw: TuneSession) {
    const inMemory = validateTuneSession(raw);
    const fromJson = readRecord("review", json(raw));
    const { loaded, listed } = await viaIndexedDb(json(raw));
    expect(inMemory.ok).toBe(true);
    expect(fromJson.status).toBe("ok");
    expect(loaded.status).toBe("ok");
    expect(listed[0]?.status).toBe("ok");
    if (!inMemory.ok || fromJson.status !== "ok" || loaded.status !== "ok") {
        throw new Error("unreachable");
    }
    expect(fromJson.rejected).toEqual(inMemory.rejected);
    expect(loaded.rejected).toEqual(inMemory.rejected);
    expect(loaded.session).toEqual(inMemory.session);
    return inMemory;
}

type ChirpEdit = [string, (c: Loose) => void, string[]];

/** Each edit is applied to CHIRP 1 of the three-CHIRP Flight. */
const CHIRP_EDITS: ChirpEdit[] = [
    ["identity chirpIndex", (c) => (c.qualityV2.identity.chirpIndex += 1), ["quality_v2_identity:chirpIndex"]],
    ["stored segmentIndex", (c) => (c.segmentIndex += 1), ["measurement_id", "quality_v2_identity:chirpIndex"]],
    ["stored axis only", (c) => (c.axis = (c.axis + 1) % 3), ["axis_name", "quality_v2_identity:axis"]],
    ["identity axis only", (c) => (c.qualityV2.identity.axis = (c.axis + 1) % 3), ["quality_v2_identity:axis"]],
    ["axis 3 on both sides", (c) => ((c.axis = 3), (c.qualityV2.identity.axis = 3)), ["axis"]],
    ["axis -1 on both sides", (c) => ((c.axis = -1), (c.qualityV2.identity.axis = -1)), ["axis"]],
    ["axis 1.5 on both sides", (c) => ((c.axis = 1.5), (c.qualityV2.identity.axis = 1.5)), ["axis"]],
    [
        "axis number and name disagree on both sides",
        (c) => {
            const name = ["roll", "pitch", "yaw"][(c.axis + 1) % 3];
            c.axisName = name;
            c.qualityV2.identity.axisName = name;
        },
        ["axis_name"],
    ],
    ["identity axisName only", (c) => (c.qualityV2.identity.axisName = "yaw"), ["quality_v2_identity:axisName"]],
    [
        "start equals end on both sides",
        (c) => {
            c.endTimeUs = c.startTimeUs;
            c.qualityV2.identity.endTimeUs = c.startTimeUs;
        },
        ["time_order"],
    ],
    [
        "start after end on both sides",
        (c) => {
            [c.startTimeUs, c.endTimeUs] = [c.endTimeUs, c.startTimeUs];
            c.qualityV2.identity.startTimeUs = c.startTimeUs;
            c.qualityV2.identity.endTimeUs = c.endTimeUs;
        },
        ["time_order"],
    ],
    [
        "duration off by 0.5 s on both sides",
        (c) => {
            c.durationS += 0.5;
            c.qualityV2.identity.durationS = c.durationS;
        },
        ["duration"],
    ],
    [
        "duration off by twice the tolerance on both sides",
        (c) => {
            c.durationS += 2 * DURATION_TOLERANCE_S;
            c.qualityV2.identity.durationS = c.durationS;
        },
        ["duration"],
    ],
    ["identity startTimeUs only", (c) => (c.qualityV2.identity.startTimeUs -= 1), ["quality_v2_identity:startTimeUs"]],
    ["identity endTimeUs only", (c) => (c.qualityV2.identity.endTimeUs += 1), ["quality_v2_identity:endTimeUs"]],
    ["identity durationS only", (c) => (c.qualityV2.identity.durationS += 1), ["quality_v2_identity:durationS"]],
    ["identity sampleCount only", (c) => (c.qualityV2.identity.sampleCount += 1), ["quality_v2_identity:sampleCount"]],
    [
        "identity axisOccurrence only",
        (c) => (c.qualityV2.identity.axisOccurrence += 1),
        ["quality_v2_identity:axisOccurrence"],
    ],
    [
        "measurementId renamed on both sides",
        (c) => {
            c.measurementId = "log1-seg99";
            c.qualityV2.identity.measurementId = "log1-seg99";
        },
        ["measurement_id"],
    ],
];

describe("FIX 1: a stored CHIRP's identity agrees with its Quality V2 identity", () => {
    it("the untouched session loads complete every way", async () => {
        const r = await everyWay(session());
        expect(r.rejected).toEqual([]);
        expect(r.session.flights.map((f) => f.chirps.length)).toEqual([3, 1]);
    });

    it.each(CHIRP_EDITS)("%s: only that CHIRP is rejected", async (_, edit, codes) => {
        const s = session();
        edit(s.flights[0].chirps[1]);
        const r = await everyWay(s);
        expect(r.rejected).toHaveLength(1);
        expect(r.rejected[0].path).toBe("flights[0].chirps[1]");
        expect(r.rejected[0].problems).toEqual(expect.arrayContaining(codes));
        // The other CHIRPs and the other Flight are untouched.
        const good = session();
        expect(r.session.flights[0].chirps).toEqual([good.flights[0].chirps[0], good.flights[0].chirps[2]]);
        expect(r.session.flights[1]).toEqual(good.flights[1]);
    });

    it("a duration within the floating-point tolerance is the same duration", async () => {
        const s = session();
        const c = s.flights[0].chirps[1];
        c.durationS += DURATION_TOLERANCE_S / 2;
        c.qualityV2.identity.durationS = c.durationS;
        expect((await everyWay(s)).rejected).toEqual([]);
    });

    it("every real CHIRP satisfies the identity rules (chirpIndex is the segment index)", () => {
        for (const c of [...three.chirps, ...single.chirps]) {
            expect(c.qualityV2.identity.chirpIndex).toBe(c.segmentIndex);
            expect(c.axisName).toBe(["roll", "pitch", "yaw"][c.axis]);
            expect(c.startTimeUs).toBeLessThan(c.endTimeUs);
            expect(Math.abs(c.durationS - (c.endTimeUs - c.startTimeUs) / 1e6)).toBeLessThanOrEqual(
                DURATION_TOLERANCE_S,
            );
        }
    });
});

const HEADER_OF = {
    firmwareType: "Firmware type",
    firmwareRevision: "Firmware revision",
    firmwareDate: "Firmware date",
    boardInformation: "Board information",
    craftName: "Craft name",
} as const;
type HeaderField = keyof typeof HEADER_OF;
const HEADER_FIELDS = Object.keys(HEADER_OF) as HeaderField[];

function setFirmware(f: Loose, field: string, value: string | null) {
    f.firmware[field] = value;
    f.firmware.unknown = Object.keys(f.firmware).filter((k) => k !== "unknown" && f.firmware[k] === null);
}

/** SYNTHETIC: make the Flight's log carry `H Firmware API version`, consistently everywhere. */
function logApi(f: Loose, version: string) {
    f.logHeaders = [
        ...f.logHeaders.filter(([k]: string[]) => k !== "Firmware API version"),
        ["Firmware API version", version],
    ];
    setFirmware(f, "apiVersion", version);
    for (const c of f.chirps) {
        c.qualityV2.provenance.apiVersion = version;
    }
}

describe("FIX 2: the stored firmware identity follows from the FlightRef and the CHIRPs", () => {
    it("the SYNTHETIC logs leave Craft name, Firmware date and the API version unlogged: null, never invented", () => {
        expect(three.firmware).toMatchObject({ craftName: null, firmwareDate: null, apiVersion: null });
        expect([...three.firmware.unknown].sort()).toEqual(["apiVersion", "craftName", "firmwareDate"]);
        for (const k of HEADER_FIELDS) {
            expect(three.firmware[k]).toBe(three.ref.header.fields[HEADER_OF[k]]);
        }
        // Quality V2 provenance holds the analysis fallback when nothing is logged; it is not the firmware's.
        for (const c of three.chirps) {
            expect(c.qualityV2.provenance.apiVersion).not.toBeNull();
        }
    });

    it.each(HEADER_FIELDS)("%s edited in the firmware block only: the Flight is rejected", async (field) => {
        const s = session();
        setFirmware(s.flights[1], field, "SYNTHETIC EDIT");
        const r = await everyWay(s);
        expect(r.rejected).toEqual([{ path: "flights[1]", problems: [`firmware:${field}`] }]);
        expect(r.session.flights.map((f) => f.key)).toEqual([three.key]);
    });

    it.each(HEADER_FIELDS)("%s edited in the FlightRef header only: the Flight is rejected", async (field) => {
        const s = session();
        (s.flights[1].ref.header.fields as Loose)[HEADER_OF[field]] = "SYNTHETIC EDIT";
        const r = await everyWay(s);
        expect(r.rejected).toHaveLength(1);
        expect(r.rejected[0].path).toBe("flights[1]");
        expect(r.rejected[0].problems).toContain(`firmware:${field}`);
    });

    it("a logged value dropped to null in the firmware block is rejected, not accepted as unknown", async () => {
        const s = session();
        setFirmware(s.flights[1], "boardInformation", null);
        expect((await everyWay(s)).rejected).toEqual([{ path: "flights[1]", problems: ["firmware:boardInformation"] }]);
    });

    it("an unlogged value filled in is rejected, also as an empty string", async () => {
        for (const value of ["SYN-CRAFT", ""]) {
            const s = session();
            setFirmware(s.flights[1], "craftName", value);
            expect((await everyWay(s)).rejected).toEqual([{ path: "flights[1]", problems: ["firmware:craftName"] }]);
        }
    });

    it("whitespace and case are differences", async () => {
        for (const value of [`${single.firmware.firmwareType} `, single.firmware.firmwareType!.toUpperCase()]) {
            const s = session();
            setFirmware(s.flights[1], "firmwareType", value);
            expect((await everyWay(s)).rejected[0]?.problems).toEqual(["firmware:firmwareType"]);
        }
    });

    it("an unknown list that does not name exactly the null fields is rejected", async () => {
        const s = session();
        s.flights[1].firmware.unknown = ["craftName"];
        expect((await everyWay(s)).rejected).toEqual([{ path: "flights[1]", problems: ["firmware"] }]);
    });

    it("an API version filled in on the Flight but not logged is rejected", async () => {
        const s = session();
        setFirmware(s.flights[1], "apiVersion", "1.46.0");
        expect((await everyWay(s)).rejected).toEqual([{ path: "flights[1]", problems: ["firmware:apiVersion"] }]);
    });

    it("a logged API version on Flight, headers and CHIRPs is accepted", async () => {
        const s = session();
        logApi(s.flights[0], "1.49.0");
        expect((await everyWay(s)).rejected).toEqual([]);
    });

    it("the logged API version edited in the headers only, or on the Flight only, rejects the Flight", async () => {
        const headersOnly = session();
        logApi(headersOnly.flights[0], "1.49.0");
        headersOnly.flights[0].logHeaders = headersOnly.flights[0].logHeaders!.map(([k, v]) =>
            k === "Firmware API version" ? [k, "1.50.0"] : [k, v],
        );
        const flightOnly = session();
        logApi(flightOnly.flights[0], "1.49.0");
        flightOnly.flights[0].firmware.apiVersion = "1.50.0";
        for (const s of [headersOnly, flightOnly]) {
            expect((await everyWay(s)).rejected).toEqual([{ path: "flights[0]", problems: ["firmware:apiVersion"] }]);
        }
    });

    it("Flight, headers and every CHIRP edited to another version together: the Flight is rejected", async () => {
        const s = session();
        logApi(s.flights[0], "1.49.0");
        s.flights[0].firmware.apiVersion = "1.50.0";
        s.flights[0].logHeaders = s.flights[0].logHeaders!.map(([k, v]) =>
            k === "Firmware API version" ? [k, "1.50.0"] : [k, v],
        );
        expect((await everyWay(s)).rejected).toEqual([{ path: "flights[0]", problems: ["firmware:apiVersion"] }]);
    });

    it("with a logged API version, the CHIRPs that carry another one are rejected and the rest kept", async () => {
        const s = session();
        logApi(s.flights[0], "1.49.0");
        s.flights[0].chirps[0].qualityV2.provenance.apiVersion = "1.46.0";
        s.flights[0].chirps[2].qualityV2.provenance.apiVersion = "1.47.0";
        const r = await everyWay(s);
        expect(r.rejected).toEqual([
            { path: "flights[0].chirps[0]", problems: ["firmware_api_version"] },
            { path: "flights[0].chirps[2]", problems: ["firmware_api_version"] },
        ]);
        expect(r.session.flights[0].chirps.map((c) => c.measurementId)).toEqual([three.chirps[1].measurementId]);
        expect(r.session.flights[1]).toEqual(session().flights[1]);
    });

    it("without a logged API version, CHIRPs of one Flight that disagree are all left out; the Flight stays", async () => {
        const s = session();
        s.flights[0].chirps[0].qualityV2.provenance.apiVersion = "1.46.0";
        const r = await everyWay(s);
        expect(r.rejected).toEqual(
            [0, 1, 2].map((j) => ({ path: `flights[0].chirps[${j}]`, problems: ["firmware_api_version_conflict"] })),
        );
        expect(r.session.flights.map((f) => f.chirps.length)).toEqual([0, 1]);
    });
});

describe("FIX 2: Flight A/B never reports a firmware MATCH it cannot back", () => {
    const pair = (a: StoredFlight, b: StoredFlight) =>
        flightPairEvidence(
            addFlights(newTuneSession({ id: "p", name: "p", now: T0 }), [a, b], T0).session,
            a.key,
            b.key,
        );

    it("a firmware block copied from the other Flight while its FlightRef says otherwise is not a MATCH", () => {
        expect(pair(single, otherBoard).firmware.boardInformation).toBe("MISMATCH");
        const forged = json(otherBoard);
        forged.firmware.boardInformation = single.firmware.boardInformation;
        const e = pair(single, forged);
        expect(e.firmware.boardInformation).toBe("UNKNOWN");
        expect(e.blockers).toEqual(
            expect.arrayContaining(["firmware_inconsistent:boardInformation:b", "firmware_unknown:boardInformation"]),
        );
    });

    it.each(HEADER_FIELDS)("%s made equal in both firmware blocks only is not a MATCH", (field) => {
        const a = json(single) as Loose;
        const b = json(otherBoard) as Loose;
        a.firmware[field] = "FORGED";
        b.firmware[field] = "FORGED";
        const e = pair(a, b);
        expect(e.firmware[field]).toBe("UNKNOWN");
        expect(e.blockers).toEqual(
            expect.arrayContaining([`firmware_inconsistent:${field}:a`, `firmware_inconsistent:${field}:b`]),
        );
    });

    it("two logs without a logged API version are not a MATCH, although their CHIRPs carry the same fallback", () => {
        expect(single.chirps[0].qualityV2.provenance.apiVersion).toBe(
            otherBoard.chirps[0].qualityV2.provenance.apiVersion,
        );
        const e = pair(single, otherBoard);
        expect(e.firmware.apiVersion).toBe("UNKNOWN");
        expect(e.blockers).toContain("firmware_unknown:apiVersion");
    });

    it("an API version claimed on both Flights but not logged is not a MATCH", () => {
        const a = json(single) as Loose;
        const b = json(otherBoard) as Loose;
        a.firmware.apiVersion = "1.49.0";
        b.firmware.apiVersion = "1.49.0";
        const e = pair(a, b);
        expect(e.firmware.apiVersion).toBe("UNKNOWN");
        expect(e.blockers).toEqual(
            expect.arrayContaining(["firmware_inconsistent:apiVersion:a", "firmware_inconsistent:apiVersion:b"]),
        );
    });

    it("a logged API version carried by every CHIRP on both sides is a MATCH", () => {
        const a = json(single) as Loose;
        const b = json(otherBoard) as Loose;
        logApi(a, "1.49.0");
        logApi(b, "1.49.0");
        expect(pair(a, b).firmware.apiVersion).toBe("MATCH");
    });

    it("a logged API version that one CHIRP contradicts is not a MATCH", () => {
        const a = json(single) as Loose;
        const b = json(otherBoard) as Loose;
        logApi(a, "1.49.0");
        logApi(b, "1.49.0");
        b.chirps[0].qualityV2.provenance.apiVersion = "1.46.0";
        const e = pair(a, b);
        expect(e.firmware.apiVersion).toBe("UNKNOWN");
        expect(e.blockers).toContain("firmware_inconsistent:apiVersion:b");
    });

    it("a Flight without CHIRPs cannot back its API version: UNKNOWN", () => {
        const a = json(single) as Loose;
        const b = json(otherBoard) as Loose;
        logApi(a, "1.49.0");
        logApi(b, "1.49.0");
        expect(pair(a, b).firmware.apiVersion).toBe("MATCH");
        a.chirps = [];
        expect(pair(a, b).firmware.apiVersion).toBe("UNKNOWN");
    });

    it("no forged pair ever reaches an empty blocker list", () => {
        for (const field of HEADER_FIELDS) {
            const b = json(otherBoard) as Loose;
            b.firmware[field] = single.firmware[field];
            expect(pair(single, b).blockers.length, field).toBeGreaterThan(0);
        }
    });
});
