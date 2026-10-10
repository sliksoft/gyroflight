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

// Blind adversarial suite for the WU3 review fixes (CHIRP identity, firmware vs FlightRef).

/*
 * Every log here is SYNTHETIC (harness/chirpSim, harness/bblWriter): closed-loop
 * sweeps with made-up header lines. The suite checks the stored structure only,
 * not real flight quality.
 */

import { IDBFactory } from "fake-indexeddb";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { attachChirpFlightIdentity } from "../../src/gyrocore/chirp/qualityV2/identity";
import { addFlights, flightPairEvidence, flightsFromReport, newTuneSession } from "../../src/gyrocore/session/build";
import {
    SESSION_AUTHORIZATION,
    type FirmwareIdentity,
    type StoredFlight,
    type TuneSession,
} from "../../src/gyrocore/session/contract";
import { openTuneSessionStore, readRecord } from "../../src/gyrocore/session/storage";
import { DURATION_TOLERANCE_S, validateTuneSession } from "../../src/gyrocore/session/validate";
import { FULL_TUNE_HEADERS, encodeChirpLog, simulateChirp, simulateChirpSequence } from "./harness/chirpSim";

vi.mock("../../src/js/localization", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/js/localization")>()),
    i18n: { getMessage: (key: string) => key },
}));

const NOW = "2026-01-01T00:00:00.000Z";
const AXIS_NAMES = ["roll", "pitch", "yaw"] as const;
const HEADER_FIELDS = [
    ["firmwareType", "Firmware type"],
    ["firmwareRevision", "Firmware revision"],
    ["firmwareDate", "Firmware date"],
    ["boardInformation", "Board information"],
    ["craftName", "Craft name"],
] as const;
type HeaderField = (typeof HEADER_FIELDS)[number][0];
type FirmwareField = Exclude<keyof FirmwareIdentity, "unknown">;
const FIRMWARE_FIELDS: FirmwareField[] = [...HEADER_FIELDS.map(([f]) => f), "apiVersion"];

/** SYNTHETIC header lines: every firmware identity line logged, API version included. */
function syntheticHeaders(craft: string): string[] {
    return [
        ...FULL_TUNE_HEADERS,
        "Firmware date:Jan  1 2026 00:00:00",
        "Board information:SYNT SYNTHETICF7",
        `Craft name:${craft}`,
        "Firmware API version:1.49.0",
    ];
}

async function buildFlight(bytes: Uint8Array, fileName: string): Promise<StoredFlight> {
    const report = qualifyChirpFile(bytes, fileName, 60, AUTOTUNE_MATH);
    await attachChirpFlightIdentity(report, bytes);
    const { flights, skipped } = flightsFromReport(report, { fileName, analyzedAt: NOW });
    expect(skipped).toEqual([]);
    expect(flights).toHaveLength(1);
    return flights[0];
}

function clone<T>(x: T): T {
    return JSON.parse(JSON.stringify(x)) as T;
}

type Path = (string | number)[];
type Bag = Record<string | number, unknown>;

/** Write `value` at `path`, whatever the declared type (tampering on purpose). */
function put(root: unknown, path: Path, value: unknown): void {
    let o = root as Bag;
    for (const k of path.slice(0, -1)) {
        o = o[k] as Bag;
    }
    o[path[path.length - 1]] = value;
}

// SYNTHETIC flights:
// A: one log, three CHIRPs (roll, pitch, yaw), craft "Alpha".
// B: another file, one roll CHIRP of a different recording, same firmware lines as A.
// C: another file, one roll CHIRP, craft "Bravo" (one firmware field differs from A).
// N: one roll CHIRP, no date/board/craft/API lines (those stay unknown).
let A: StoredFlight;
let B: StoredFlight;
let C: StoredFlight;
let N: StoredFlight;
/** Session [A, B, C]. */
let base: TuneSession;

beforeAll(async () => {
    A = await buildFlight(
        encodeChirpLog(
            simulateChirpSequence([
                { axis: 0, seconds: 6, firmwareDebug: true },
                { axis: 1, seconds: 6, firmwareDebug: true },
                { axis: 2, seconds: 6, firmwareDebug: true },
            ]),
            syntheticHeaders("Alpha"),
        ),
        "synthetic-a.bbl",
    );
    B = await buildFlight(
        encodeChirpLog(simulateChirp({ seconds: 6, firmwareDebug: true, amplitude: 150 }), syntheticHeaders("Alpha")),
        "synthetic-b.bbl",
    );
    C = await buildFlight(
        encodeChirpLog(simulateChirp({ seconds: 6, firmwareDebug: true, amplitude: 170 }), syntheticHeaders("Bravo")),
        "synthetic-c.bbl",
    );
    N = await buildFlight(
        encodeChirpLog(simulateChirp({ seconds: 6, firmwareDebug: true, amplitude: 130 })),
        "synthetic-n.bbl",
    );
    base = addFlights(newTuneSession({ id: "synthetic-session", name: "synthetic", now: NOW }), [A, B, C], NOW).session;
}, 120_000);

/** The `Firmware API version` header line as logged: trimmed, and null when absent or 0.0.0. */
function loggedApiVersion(f: StoredFlight): string | null {
    const line = (f.logHeaders ?? []).find(([k]) => k === "Firmware API version");
    const v = line ? line[1].trim() : null;
    return v && v !== "0.0.0" ? v : null;
}

/** Every rule of the review spec, checked on a session that validation accepted. */
function expectSpecConsistent(s: TuneSession): void {
    expect(s.authorization).toEqual(SESSION_AUTHORIZATION);
    for (const f of s.flights) {
        for (const [field, header] of HEADER_FIELDS) {
            expect(f.firmware[field], `${f.key} firmware.${field}`).toBe(f.ref.header.fields[header]);
        }
        const apis = new Set(f.chirps.map((c) => c.qualityV2.provenance.apiVersion));
        expect(apis.size, `${f.key} CHIRP API versions`).toBeLessThanOrEqual(1);
        const logged = loggedApiVersion(f);
        expect(f.firmware.apiVersion, `${f.key} firmware.apiVersion is the logged value`).toBe(logged);
        if (logged !== null) {
            for (const api of apis) {
                expect(api, `${f.key} CHIRP provenance.apiVersion`).toBe(logged);
            }
        }
        const nulls = FIRMWARE_FIELDS.filter((k) => f.firmware[k] === null).sort();
        expect([...f.firmware.unknown].sort(), `${f.key} firmware.unknown`).toEqual(nulls);
        for (const c of f.chirps) {
            const id = c.qualityV2.identity;
            expect(id.chirpIndex).toBe(c.segmentIndex);
            expect([0, 1, 2]).toContain(c.axis);
            expect(id.axis).toBe(c.axis);
            expect(c.axisName).toBe(AXIS_NAMES[c.axis]);
            expect(id.axisName).toBe(c.axisName);
            expect(Number.isFinite(c.startTimeUs) && Number.isFinite(c.endTimeUs)).toBe(true);
            expect(c.startTimeUs).toBeLessThan(c.endTimeUs);
            expect(c.durationS).toBeGreaterThan(0);
            expect(Math.abs(c.durationS - (c.endTimeUs - c.startTimeUs) / 1e6)).toBeLessThanOrEqual(
                DURATION_TOLERANCE_S,
            );
            for (const k of [
                "measurementId",
                "logIndex",
                "axisOccurrence",
                "sampleCount",
                "startTimeUs",
                "endTimeUs",
                "durationS",
            ] as const) {
                expect(id[k], `identity.${k}`).toBe(c[k]);
            }
            expect(c.measurementId).toBe(`log${c.logIndex + 1}-seg${c.segmentIndex + 1}`);
            expect(c.qualityV2.levels.tuningAuthorized.status).not.toBe("YES");
        }
    }
}

function validateJson(raw: unknown) {
    return validateTuneSession(JSON.parse(JSON.stringify(raw)));
}

function okResult(raw: unknown) {
    const v = validateJson(raw);
    if (!v.ok) {
        throw new Error(`expected ok, got problems ${JSON.stringify(v.problems)}`);
    }
    return v;
}

function tamper(change: (s: TuneSession) => void): TuneSession {
    const s = clone(base);
    change(s);
    return s;
}

/** A's CHIRP j, both copies of a field: the stored CHIRP and its Quality V2 identity. */
const chirpPath = (j: number): Path => ["flights", 0, "chirps", j];
const idPath = (j: number): Path => [...chirpPath(j), "qualityV2", "identity"];

function setBoth(s: TuneSession, j: number, field: string, value: unknown, idField = field): void {
    put(s, [...chirpPath(j), field], value);
    put(s, [...idPath(j), idField], value);
}

/** Only CHIRP j of Flight 0 is left out; every other part is loaded unchanged. */
function expectOnlyChirpRejected(raw: unknown, j: number, result = okResult(raw)): void {
    const path = `flights[0].chirps[${j}]`;
    const hit = result.rejected.find((r) => r.path === path);
    expect(hit, `rejected ${path}`).toBeDefined();
    expect(hit!.problems.length).toBeGreaterThan(0);
    expect(hit!.problems.every((p) => typeof p === "string" && p.length > 0)).toBe(true);
    expect(result.rejected.map((r) => r.path)).toEqual([path]);
    const s = result.session;
    expect(s.flights.map((f) => f.key)).toEqual(base.flights.map((f) => f.key));
    expect(s.flights[0].chirps).toEqual(base.flights[0].chirps.filter((_, k) => k !== j));
    expect(s.flights.slice(1)).toEqual(base.flights.slice(1));
    expectSpecConsistent(s);
}

/** Flight i is left out (`flights[i]`); the other Flights load unchanged. */
function expectOnlyFlightRejected(raw: unknown, i: number, result = okResult(raw)): void {
    const path = `flights[${i}]`;
    const hit = result.rejected.find((r) => r.path === path);
    expect(hit, `rejected ${path}, got ${JSON.stringify(result.rejected)}`).toBeDefined();
    expect(hit!.problems.length).toBeGreaterThan(0);
    const keys = (raw as TuneSession).flights.map((f) => f.key);
    expect(result.session.flights.map((f) => f.key)).toEqual(keys.filter((_, k) => k !== i));
    for (const f of result.session.flights) {
        expect(f).toEqual(base.flights.find((b) => b.key === f.key));
    }
    expectSpecConsistent(result.session);
}

/** Lenient fail-closed check: something in Flight i is rejected, and nothing inconsistent survives. */
function expectFlightNotAcceptedAsIs(raw: unknown, i: number): void {
    const result = okResult(raw);
    expect(
        result.rejected.some((r) => r.path === `flights[${i}]` || r.path.startsWith(`flights[${i}].chirps[`)),
        JSON.stringify(result.rejected),
    ).toBe(true);
    expectSpecConsistent(result.session);
    for (const f of result.session.flights) {
        if (f.key !== (raw as TuneSession).flights[i].key) {
            expect(f).toEqual(base.flights.find((b) => b.key === f.key));
        }
    }
}

describe("SYNTHETIC baseline", () => {
    it("builds consistent Flights that validate with nothing rejected", () => {
        const v = okResult(base);
        expect(v.rejected).toEqual([]);
        expect(v.session).toEqual(base);
        expectSpecConsistent(v.session);
        expect(A.chirps.map((c) => [c.segmentIndex, c.axisName])).toEqual([
            [0, "roll"],
            [1, "pitch"],
            [2, "yaw"],
        ]);
        expect(A.firmware).toEqual({
            firmwareType: "Cleanflight",
            firmwareRevision: "Betaflight 2026.6.2 (synthetic) STM32F7X2",
            firmwareDate: "Jan  1 2026 00:00:00",
            boardInformation: "SYNT SYNTHETICF7",
            craftName: "Alpha",
            apiVersion: "1.49.0",
            unknown: [],
        });
    });

    it("documents a tolerance that only absorbs floating-point error", () => {
        expect(DURATION_TOLERANCE_S).toBeGreaterThan(0);
        expect(DURATION_TOLERANCE_S).toBeLessThan(1e-3);
    });

    it("A and B are a clean pair; A and C differ only in craft name", () => {
        const ab = flightPairEvidence(base, A.key, B.key);
        expect(ab.firmware).toEqual(Object.fromEntries(FIRMWARE_FIELDS.map((f) => [f, "MATCH"])));
        expect(ab.blockers).toEqual([]);
        const ac = flightPairEvidence(base, A.key, C.key);
        expect(ac.firmware.craftName).toBe("MISMATCH");
        expect(ac.blockers.length).toBeGreaterThan(0);
    });
});

describe("FIX 1: chirpIndex and segmentIndex", () => {
    it.each([
        ["identity.chirpIndex off by one down", (s: TuneSession) => put(s, [...idPath(1), "chirpIndex"], 0)],
        ["identity.chirpIndex off by one up", (s: TuneSession) => put(s, [...idPath(1), "chirpIndex"], 2)],
        ["stored segmentIndex off by one", (s: TuneSession) => put(s, [...chirpPath(1), "segmentIndex"], 2)],
        ["stored segmentIndex as a string", (s: TuneSession) => put(s, [...chirpPath(1), "segmentIndex"], "1")],
        ["identity.chirpIndex as a string", (s: TuneSession) => put(s, [...idPath(1), "chirpIndex"], "1")],
        ["identity.chirpIndex null", (s: TuneSession) => put(s, [...idPath(1), "chirpIndex"], null)],
        [
            "both indices moved, measurementId left at seg2",
            (s: TuneSession) => setBoth(s, 1, "segmentIndex", 5, "chirpIndex"),
        ],
        [
            "both indices negative, measurementId recomputed",
            (s: TuneSession) => {
                setBoth(s, 1, "segmentIndex", -1, "chirpIndex");
                setBoth(s, 1, "measurementId", "log1-seg0");
            },
        ],
        [
            "both indices fractional, measurementId recomputed",
            (s: TuneSession) => {
                setBoth(s, 1, "segmentIndex", 1.5, "chirpIndex");
                setBoth(s, 1, "measurementId", "log1-seg2.5");
            },
        ],
        [
            "segmentIndex and chirpIndex swapped with the neighbour on one side",
            (s: TuneSession) => {
                put(s, [...idPath(1), "chirpIndex"], 2);
                put(s, [...idPath(2), "chirpIndex"], 1);
            },
        ],
    ])("rejects only the CHIRP: %s", (_name, change) => {
        const raw = tamper(change);
        if (_name.includes("swapped")) {
            const r = okResult(raw);
            expect(r.rejected.map((x) => x.path).sort()).toEqual(["flights[0].chirps[1]", "flights[0].chirps[2]"]);
            expect(r.session.flights[0].chirps).toEqual([base.flights[0].chirps[0]]);
            expect(r.session.flights.slice(1)).toEqual(base.flights.slice(1));
            return;
        }
        expectOnlyChirpRejected(raw, 1);
    });
});

describe("FIX 1: axis and axisName", () => {
    it.each([
        ["stored axis only", (s: TuneSession) => put(s, [...chirpPath(1), "axis"], 0)],
        ["identity axis only", (s: TuneSession) => put(s, [...idPath(1), "axis"], 2)],
        [
            "axis 3 on both sides",
            (s: TuneSession) => {
                setBoth(s, 1, "axis", 3);
            },
        ],
        ["axis -1 on both sides", (s: TuneSession) => setBoth(s, 1, "axis", -1)],
        ["axis 1.5 on both sides", (s: TuneSession) => setBoth(s, 1, "axis", 1.5)],
        ["axis '1' (string) on both sides", (s: TuneSession) => setBoth(s, 1, "axis", "1")],
        ["axis null on both sides", (s: TuneSession) => setBoth(s, 1, "axis", null)],
        ["stored axisName only", (s: TuneSession) => put(s, [...chirpPath(1), "axisName"], "roll")],
        ["identity axisName only", (s: TuneSession) => put(s, [...idPath(1), "axisName"], "yaw")],
        ["axisName 'roll' on both sides for axis 1", (s: TuneSession) => setBoth(s, 1, "axisName", "roll")],
        ["axisName 'Pitch' (case) on both sides", (s: TuneSession) => setBoth(s, 1, "axisName", "Pitch")],
        ["axisName 'pitch ' (whitespace) on both sides", (s: TuneSession) => setBoth(s, 1, "axisName", "pitch ")],
        ["axisName unknown word on both sides", (s: TuneSession) => setBoth(s, 1, "axisName", "throttle")],
        [
            "axis 2 with axisName 'pitch' on both sides",
            (s: TuneSession) => {
                setBoth(s, 1, "axis", 2);
            },
        ],
        [
            "axis 1 roll on the stored side, axis 0 roll in the identity",
            (s: TuneSession) => {
                put(s, [...chirpPath(1), "axisName"], "roll");
                put(s, [...idPath(1), "axis"], 0);
                put(s, [...idPath(1), "axisName"], "roll");
            },
        ],
    ])("rejects only the CHIRP: %s", (_name, change) => {
        expectOnlyChirpRejected(tamper(change), 1);
    });
});

describe("FIX 1: timing", () => {
    const c1 = () => base.flights[0].chirps[1];
    const durationOf = (start: number, end: number) => (end - start) / 1e6;

    it.each([
        [
            "stored startTimeUs +1 only",
            (s: TuneSession) => put(s, [...chirpPath(1), "startTimeUs"], c1().startTimeUs + 1),
        ],
        ["identity endTimeUs +1 only", (s: TuneSession) => put(s, [...idPath(1), "endTimeUs"], c1().endTimeUs + 1)],
        [
            "identity startTimeUs -1 only",
            (s: TuneSession) => put(s, [...idPath(1), "startTimeUs"], c1().startTimeUs - 1),
        ],
        [
            "start equals end on both sides, duration 0",
            (s: TuneSession) => {
                setBoth(s, 1, "endTimeUs", c1().startTimeUs);
                setBoth(s, 1, "durationS", 0);
            },
        ],
        [
            "start equals end on both sides, duration left positive",
            (s: TuneSession) => setBoth(s, 1, "endTimeUs", c1().startTimeUs),
        ],
        [
            "reversed times on both sides, consistent negative duration",
            (s: TuneSession) => {
                setBoth(s, 1, "startTimeUs", c1().endTimeUs);
                setBoth(s, 1, "endTimeUs", c1().startTimeUs);
                setBoth(s, 1, "durationS", durationOf(c1().endTimeUs, c1().startTimeUs));
            },
        ],
        [
            "reversed times on both sides, positive duration",
            (s: TuneSession) => {
                setBoth(s, 1, "startTimeUs", c1().endTimeUs);
                setBoth(s, 1, "endTimeUs", c1().startTimeUs);
            },
        ],
        ["durationS doubled on both sides", (s: TuneSession) => setBoth(s, 1, "durationS", c1().durationS * 2)],
        [
            "durationS beyond tolerance (+2x) on both sides",
            (s: TuneSession) => setBoth(s, 1, "durationS", c1().durationS + 2 * DURATION_TOLERANCE_S),
        ],
        [
            "durationS beyond tolerance (-2x) on both sides",
            (s: TuneSession) => setBoth(s, 1, "durationS", c1().durationS - 2 * DURATION_TOLERANCE_S),
        ],
        ["durationS 0 on both sides", (s: TuneSession) => setBoth(s, 1, "durationS", 0)],
        ["durationS negative on both sides", (s: TuneSession) => setBoth(s, 1, "durationS", -c1().durationS)],
        [
            "durationS stored side only +1 ms",
            (s: TuneSession) => put(s, [...chirpPath(1), "durationS"], c1().durationS + 0.001),
        ],
        [
            "durationS identity side only, within tolerance of the times",
            (s: TuneSession) => put(s, [...idPath(1), "durationS"], c1().durationS + DURATION_TOLERANCE_S / 2),
        ],
        [
            "startTimeUs as a string on both sides",
            (s: TuneSession) => setBoth(s, 1, "startTimeUs", String(c1().startTimeUs)),
        ],
        ["endTimeUs null on both sides", (s: TuneSession) => setBoth(s, 1, "endTimeUs", null)],
        ["durationS as a string on both sides", (s: TuneSession) => setBoth(s, 1, "durationS", String(c1().durationS))],
        [
            "both times shifted by 1 s on the stored side only",
            (s: TuneSession) => {
                put(s, [...chirpPath(1), "startTimeUs"], c1().startTimeUs + 1e6);
                put(s, [...chirpPath(1), "endTimeUs"], c1().endTimeUs + 1e6);
            },
        ],
    ])("rejects only the CHIRP: %s", (_name, change) => {
        expectOnlyChirpRejected(tamper(change), 1);
    });

    it.each([
        ["+half tolerance", 0.5],
        ["-half tolerance", -0.5],
    ])("accepts durationS %s on both sides (floating-point slack)", (_name, k) => {
        const raw = tamper((s) => setBoth(s, 1, "durationS", c1().durationS + k * DURATION_TOLERANCE_S));
        const v = okResult(raw);
        expect(v.rejected).toEqual([]);
        expect(v.session.flights[0].chirps).toHaveLength(3);
        expect(v.session.flights[0].chirps[1].durationS).toBe(c1().durationS + k * DURATION_TOLERANCE_S);
        expectSpecConsistent(v.session);
    });

    it("never accepts an infinite time read from JSON text (1e400)", () => {
        const text = JSON.stringify(base).replace(`"endTimeUs":${c1().endTimeUs}`, `"endTimeUs":1e400`);
        expect(text).toContain("1e400");
        const raw = JSON.parse(text) as TuneSession;
        expect(raw.flights[0].chirps[1].endTimeUs).toBe(Infinity);
        const v = validateTuneSession(raw);
        if (v.ok) {
            expect(v.rejected.map((r) => r.path)).toContain("flights[0].chirps[1]");
            expectSpecConsistent(v.session);
        } else {
            expect(v.problems.length).toBeGreaterThan(0);
        }
    });
});

describe("FIX 1: the other identity fields", () => {
    const c1 = () => base.flights[0].chirps[1];

    it.each([
        [
            "stored measurementId duplicates CHIRP 2",
            (s: TuneSession) => put(s, [...chirpPath(1), "measurementId"], "log1-seg3"),
        ],
        ["identity measurementId only", (s: TuneSession) => put(s, [...idPath(1), "measurementId"], "log1-seg1")],
        ["measurementId zero padded on both sides", (s: TuneSession) => setBoth(s, 1, "measurementId", "log1-seg02")],
        ["measurementId 0-based on both sides", (s: TuneSession) => setBoth(s, 1, "measurementId", "log0-seg1")],
        ["measurementId upper case on both sides", (s: TuneSession) => setBoth(s, 1, "measurementId", "LOG1-SEG2")],
        [
            "measurementId trailing space on both sides",
            (s: TuneSession) => setBoth(s, 1, "measurementId", "log1-seg2 "),
        ],
        ["measurementId free text on both sides", (s: TuneSession) => setBoth(s, 1, "measurementId", "pitch-sweep")],
        ["stored logIndex only", (s: TuneSession) => put(s, [...chirpPath(1), "logIndex"], 1)],
        ["identity logIndex only", (s: TuneSession) => put(s, [...idPath(1), "logIndex"], 1)],
        [
            "logIndex 1 on both sides with a matching measurementId",
            (s: TuneSession) => {
                setBoth(s, 1, "logIndex", 1);
                setBoth(s, 1, "measurementId", "log2-seg2");
            },
        ],
        ["stored axisOccurrence only", (s: TuneSession) => put(s, [...chirpPath(1), "axisOccurrence"], 2)],
        ["identity axisOccurrence only", (s: TuneSession) => put(s, [...idPath(1), "axisOccurrence"], 0)],
        ["axisOccurrence as a string on both sides", (s: TuneSession) => setBoth(s, 1, "axisOccurrence", "1")],
        [
            "stored sampleCount +1 only",
            (s: TuneSession) => put(s, [...chirpPath(1), "sampleCount"], c1().sampleCount + 1),
        ],
        [
            "identity sampleCount -1 only",
            (s: TuneSession) => put(s, [...idPath(1), "sampleCount"], c1().sampleCount - 1),
        ],
        [
            "sampleCount as a string on both sides",
            (s: TuneSession) => setBoth(s, 1, "sampleCount", String(c1().sampleCount)),
        ],
        ["sampleCount negative on both sides", (s: TuneSession) => setBoth(s, 1, "sampleCount", -1)],
        [
            "tuningAuthorized stored as YES",
            (s: TuneSession) => put(s, [...chirpPath(1), "qualityV2", "levels", "tuningAuthorized", "status"], "YES"),
        ],
    ])("rejects only the CHIRP: %s", (_name, change) => {
        expectOnlyChirpRejected(tamper(change), 1);
    });

    it("rejects two damaged CHIRPs separately and keeps the third", () => {
        const raw = tamper((s) => {
            put(s, [...idPath(0), "axis"], 1);
            setBoth(s, 2, "durationS", base.flights[0].chirps[2].durationS * 3);
        });
        const v = okResult(raw);
        expect(v.rejected.map((r) => r.path).sort()).toEqual(["flights[0].chirps[0]", "flights[0].chirps[2]"]);
        expect(v.session.flights[0].chirps).toEqual([base.flights[0].chirps[1]]);
        expect(v.session.flights.slice(1)).toEqual(base.flights.slice(1));
        expectSpecConsistent(v.session);
    });

    it("keeps a mixed session: one bad CHIRP in A, the good Flights B and C untouched", () => {
        const raw = tamper((s) => put(s, [...idPath(0), "chirpIndex"], 1));
        expectOnlyChirpRejected(raw, 0);
        const v = okResult(raw);
        const ab = flightPairEvidence(v.session, A.key, B.key);
        expect(ab.firmware.craftName).toBe("MATCH");
    });

    it("rejects the same damage through readRecord (JSON round trip)", () => {
        const raw = JSON.parse(JSON.stringify(tamper((s) => put(s, [...idPath(1), "axis"], 0))));
        const r = readRecord(base.id, raw);
        expect(r.status).toBe("ok");
        if (r.status === "ok") {
            expect(r.rejected.map((x) => x.path)).toEqual(["flights[0].chirps[1]"]);
            expect(r.session.flights[0].chirps.map((c) => c.measurementId)).toEqual(["log1-seg1", "log1-seg3"]);
            expectSpecConsistent(r.session);
        }
    });
});

describe("FIX 2: firmware identity against the FlightRef", () => {
    const headerOf = (f: HeaderField) => HEADER_FIELDS.find(([k]) => k === f)![1];

    /** Edit a FlightRef header field on the Flight and on every CHIRP link to it, so only the firmware block disagrees. */
    function setRefField(s: TuneSession, i: number, header: string, value: string | null): void {
        const f = s.flights[i];
        f.ref.header.fields[header as keyof typeof f.ref.header.fields] = value;
        for (const c of f.chirps) {
            const ref = c.qualityV2.identity.flight.ref;
            if (ref) {
                ref.header.fields[header as keyof typeof ref.header.fields] = value;
            }
        }
    }

    function setUnknownFor(s: TuneSession, i: number): void {
        const fw = s.flights[i].firmware;
        fw.unknown = FIRMWARE_FIELDS.filter((k) => fw[k] === null);
    }

    describe.each(HEADER_FIELDS.map(([f]) => f))("%s", (field) => {
        const value = () => A.firmware[field] as string;
        const flipCase = (v: string) => (v === v.toUpperCase() ? v.toLowerCase() : v.toUpperCase());

        it.each([
            [
                "edited in the firmware block only",
                (s: TuneSession) => put(s, ["flights", 0, "firmware", field], "X-synthetic"),
            ],
            [
                "trailing whitespace in the block",
                (s: TuneSession) => put(s, ["flights", 0, "firmware", field], `${value()} `),
            ],
            [
                "leading whitespace in the block",
                (s: TuneSession) => put(s, ["flights", 0, "firmware", field], ` ${value()}`),
            ],
            [
                "case-flipped in the block",
                (s: TuneSession) => put(s, ["flights", 0, "firmware", field], flipCase(value())),
            ],
            ["empty string in the block", (s: TuneSession) => put(s, ["flights", 0, "firmware", field], "")],
            ["a number in the block", (s: TuneSession) => put(s, ["flights", 0, "firmware", field], 1)],
            [
                "C's craft name in the block",
                (s: TuneSession) => put(s, ["flights", 0, "firmware", field], C.firmware.craftName),
            ],
            [
                "null in the block (and listed unknown) while the ref has a value",
                (s: TuneSession) => {
                    put(s, ["flights", 0, "firmware", field], null);
                    setUnknownFor(s, 0);
                },
            ],
            [
                "edited in the ref only (Flight and CHIRP links)",
                (s: TuneSession) => setRefField(s, 0, headerOf(field), "X-synthetic"),
            ],
            [
                "null in the ref only: the block fills in a missing value",
                (s: TuneSession) => setRefField(s, 0, headerOf(field), null),
            ],
            [
                "empty string in the ref, null in the block",
                (s: TuneSession) => {
                    setRefField(s, 0, headerOf(field), "");
                    put(s, ["flights", 0, "firmware", field], null);
                    setUnknownFor(s, 0);
                },
            ],
        ])("rejects Flight 0 when %s", (_name, change) => {
            expectOnlyFlightRejected(tamper(change), 0);
        });

        it("accepts a consistent null on both sides, listed unknown", () => {
            const raw = tamper((s) => {
                setRefField(s, 0, headerOf(field), null);
                put(s, ["flights", 0, "firmware", field], null);
                setUnknownFor(s, 0);
            });
            const v = okResult(raw);
            expect(v.rejected).toEqual([]);
            expect(v.session.flights[0].firmware[field]).toBeNull();
            expect(v.session.flights[0].firmware.unknown).toContain(field);
            expectSpecConsistent(v.session);
        });

        it("ref edited in the Flight only (not the CHIRP links) never survives as-is", () => {
            const raw = tamper((s) => {
                s.flights[0].ref.header.fields[headerOf(field)] = "X-synthetic";
            });
            expectFlightNotAcceptedAsIs(raw, 0);
        });
    });

    describe("firmware.unknown", () => {
        it.each([
            [
                "names a field that has a value",
                (s: TuneSession) => put(s, ["flights", 0, "firmware", "unknown"], ["craftName"]),
            ],
            [
                "names a field that does not exist",
                (s: TuneSession) => put(s, ["flights", 0, "firmware", "unknown"], ["logStartDatetime"]),
            ],
            ["names 'unknown' itself", (s: TuneSession) => put(s, ["flights", 0, "firmware", "unknown"], ["unknown"])],
            [
                "misses a null field",
                (s: TuneSession) => {
                    setRefField(s, 0, "Craft name", null);
                    put(s, ["flights", 0, "firmware", "craftName"], null);
                },
            ],
            [
                "lists a null field twice",
                (s: TuneSession) => {
                    setRefField(s, 0, "Craft name", null);
                    put(s, ["flights", 0, "firmware", "craftName"], null);
                    put(s, ["flights", 0, "firmware", "unknown"], ["craftName", "craftName"]);
                },
            ],
            ["is not an array", (s: TuneSession) => put(s, ["flights", 0, "firmware", "unknown"], "craftName")],
            ["holds a non-string", (s: TuneSession) => put(s, ["flights", 0, "firmware", "unknown"], [0])],
        ])("rejects Flight 0 when it %s", (_name, change) => {
            expectOnlyFlightRejected(tamper(change), 0);
        });
    });

    describe("apiVersion", () => {
        const prov = (j: number): Path => [...chirpPath(j), "qualityV2", "provenance", "apiVersion"];

        it.each([
            [
                "edited on the Flight only",
                (s: TuneSession) => put(s, ["flights", 0, "firmware", "apiVersion"], "1.48.0"),
            ],
            [
                "trailing whitespace on the Flight",
                (s: TuneSession) => put(s, ["flights", 0, "firmware", "apiVersion"], "1.49.0 "),
            ],
            ["shortened on the Flight", (s: TuneSession) => put(s, ["flights", 0, "firmware", "apiVersion"], "1.49")],
            ["a number on the Flight", (s: TuneSession) => put(s, ["flights", 0, "firmware", "apiVersion"], 1.49)],
            [
                "null on the Flight (listed unknown) while the CHIRPs carry a version",
                (s: TuneSession) => {
                    put(s, ["flights", 0, "firmware", "apiVersion"], null);
                    setUnknownFor(s, 0);
                },
            ],
            [
                "on the Flight, matching every CHIRP but the Flight is listed unknown",
                (s: TuneSession) => put(s, ["flights", 0, "firmware", "unknown"], ["apiVersion"]),
            ],
        ])("rejects Flight 0 when %s", (_name, change) => {
            expectOnlyFlightRejected(tamper(change), 0);
        });

        /** Rewrite the logged `Firmware API version` header line of Flight i (null removes it). */
        function setLoggedApi(s: TuneSession, i: number, value: string | null): void {
            const f = s.flights[i];
            const rest = (f.logHeaders ?? []).filter(([k]) => k !== "Firmware API version");
            f.logHeaders = value === null ? rest : [...rest, ["Firmware API version", value]];
        }

        it.each([
            ["one CHIRP edited", 1, (s: TuneSession) => put(s, prov(1), "1.48.0")],
            ["one CHIRP null", 2, (s: TuneSession) => put(s, prov(2), null)],
            ["one CHIRP with trailing whitespace", 0, (s: TuneSession) => put(s, prov(0), "1.49.0 ")],
        ])("rejects only the CHIRP whose provenance differs from the logged version: %s", (_name, j, change) => {
            expectOnlyChirpRejected(tamper(change), j);
        });

        it("rejects the Flight when no CHIRP carries the logged version", () => {
            expectFlightNotAcceptedAsIs(
                tamper((s) => [0, 1, 2].forEach((j) => put(s, prov(j), "1.48.0"))),
                0,
            );
            const v = okResult(tamper((s) => [0, 1, 2].forEach((j) => put(s, prov(j), "1.48.0"))));
            expect(v.session.flights.find((f) => f.key === A.key)).toBeUndefined();
        });

        it("rejects the Flight when its block copies a CHIRP's version instead of the logged one", () => {
            const raw = tamper((s) => {
                put(s, prov(0), "1.47.0");
                put(s, ["flights", 0, "firmware", "apiVersion"], "1.47.0");
            });
            expectFlightNotAcceptedAsIs(raw, 0);
        });

        it.each([
            ["logged line removed, block keeps 1.49.0 (filled in)", (s: TuneSession) => setLoggedApi(s, 0, null)],
            ["logged 0.0.0, block keeps 1.49.0", (s: TuneSession) => setLoggedApi(s, 0, "0.0.0")],
            ["logged 1.48.0, block and CHIRPs say 1.49.0", (s: TuneSession) => setLoggedApi(s, 0, "1.48.0")],
            [
                "logged 0.0.0, block says 0.0.0",
                (s: TuneSession) => {
                    setLoggedApi(s, 0, "0.0.0");
                    put(s, ["flights", 0, "firmware", "apiVersion"], "0.0.0");
                },
            ],
        ])("never keeps Flight 0 when %s", (_name, change) => {
            expectFlightNotAcceptedAsIs(tamper(change), 0);
            const v = okResult(tamper(change));
            const a = v.session.flights.find((f) => f.key === A.key);
            if (a) {
                expect(a.firmware.apiVersion).toBe(loggedApiVersion(a));
            }
        });

        it.each([
            ["absent", null],
            ["0.0.0", "0.0.0"],
        ])("accepts a Flight whose API line is %s with apiVersion null and agreeing CHIRPs", (_name, line) => {
            const raw = tamper((s) => {
                setLoggedApi(s, 0, line);
                put(s, ["flights", 0, "firmware", "apiVersion"], null);
                setUnknownFor(s, 0);
            });
            const v = okResult(raw);
            expect(v.rejected).toEqual([]);
            expect(v.session.flights[0].firmware.apiVersion).toBeNull();
            expect(v.session.flights[0].firmware.unknown).toEqual(["apiVersion"]);
            expect(v.session.flights[0].chirps).toHaveLength(3);
            expectSpecConsistent(v.session);
        });

        it("accepts a logged line with surrounding whitespace (trimmed)", () => {
            const v = okResult(tamper((s) => setLoggedApi(s, 0, " 1.49.0 ")));
            expect(v.rejected).toEqual([]);
            expect(v.session.flights[0].firmware.apiVersion).toBe("1.49.0");
        });

        it("rejects every CHIRP of an unlogged-API Flight when they disagree (no anchor)", () => {
            const raw = tamper((s) => {
                setLoggedApi(s, 0, null);
                put(s, ["flights", 0, "firmware", "apiVersion"], null);
                setUnknownFor(s, 0);
                put(s, prov(2), "1.48.0");
            });
            const v = okResult(raw);
            const a = v.session.flights.find((f) => f.key === A.key);
            expect(a?.chirps ?? []).toEqual([]);
            const paths = v.rejected.map((r) => r.path);
            expect(
                paths.includes("flights[0]") ||
                    ["flights[0].chirps[0]", "flights[0].chirps[1]", "flights[0].chirps[2]"].every((p) =>
                        paths.includes(p),
                    ),
                JSON.stringify(paths),
            ).toBe(true);
            expect(v.session.flights.filter((f) => f.key !== A.key)).toEqual(base.flights.slice(1));
            expectSpecConsistent(v.session);
        });

        it("stores the logged API version only, never the analysis fallback (Flight N has no API line)", () => {
            expect(loggedApiVersion(N)).toBeNull();
            expect(N.chirps[0].qualityV2.provenance.apiVersion).toBe("1.49.0");
            expect(N.firmware.apiVersion).toBeNull();
            expect([...N.firmware.unknown].sort()).toEqual(
                ["apiVersion", "boardInformation", "craftName", "firmwareDate"].sort(),
            );
            const s = addFlights(newTuneSession({ id: "synthetic-n", name: "n", now: NOW }), [A, N], NOW).session;
            const v = okResult(s);
            expect(v.rejected).toEqual([]);
            expectSpecConsistent(v.session);
        });

        it("rejects Flight N when its block fills in the fallback API version", () => {
            const s = addFlights(newTuneSession({ id: "synthetic-n1", name: "n", now: NOW }), [A, N], NOW).session;
            const raw = clone(s);
            raw.flights[1].firmware.apiVersion = "1.49.0";
            raw.flights[1].firmware.unknown = raw.flights[1].firmware.unknown.filter((u) => u !== "apiVersion");
            const v = okResult(raw);
            expect(v.rejected.map((r) => r.path)).toContain("flights[1]");
            expect(v.session.flights.map((f) => f.key)).toEqual([A.key]);
        });
    });

    it("rejects a null-field Flight (N) whose block fills in a craft name", () => {
        const s = addFlights(newTuneSession({ id: "synthetic-n2", name: "n", now: NOW }), [A, N], NOW).session;
        const raw = clone(s);
        raw.flights[1].firmware.craftName = "Alpha";
        raw.flights[1].firmware.unknown = raw.flights[1].firmware.unknown.filter((u) => u !== "craftName");
        const v = okResult(raw);
        expect(v.rejected.map((r) => r.path)).toContain("flights[1]");
        expect(v.session.flights.map((f) => f.key)).toEqual([A.key]);
    });

    it("rejects a null-field Flight (N) whose block says '' for a null header", () => {
        const s = addFlights(newTuneSession({ id: "synthetic-n3", name: "n", now: NOW }), [A, N], NOW).session;
        const raw = clone(s);
        raw.flights[1].firmware.firmwareDate = "";
        raw.flights[1].firmware.unknown = raw.flights[1].firmware.unknown.filter((u) => u !== "firmwareDate");
        const v = okResult(raw);
        expect(v.rejected.map((r) => r.path)).toContain("flights[1]");
        expect(v.session.flights.map((f) => f.key)).toEqual([A.key]);
    });
});

describe("FIX 2: flightPairEvidence never reports a false firmware MATCH (in-memory sessions)", () => {
    function flightOf(s: TuneSession, key: string): StoredFlight {
        return s.flights.find((f) => f.key === key)!;
    }

    function expectBlocked(s: TuneSession, keyA: string, keyB: string, field: FirmwareField): void {
        const e = flightPairEvidence(s, keyA, keyB);
        expect(e.firmware[field], `${field}`).not.toBe("MATCH");
        expect(e.blockers.length).toBeGreaterThan(0);
        expect(
            e.blockers.some((b) => b.startsWith("firmware_")),
            JSON.stringify(e.blockers),
        ).toBe(true);
        const r = flightPairEvidence(s, keyB, keyA);
        expect(r.firmware[field], `${field} (reversed)`).not.toBe("MATCH");
        expect(r.blockers.length).toBeGreaterThan(0);
    }

    it("A's block claims C's craft name while A's ref says Alpha", () => {
        const s = clone(base);
        flightOf(s, A.key).firmware.craftName = "Bravo";
        expectBlocked(s, A.key, C.key, "craftName");
    });

    it("A's whole firmware block is C's while A's ref is unchanged", () => {
        const s = clone(base);
        flightOf(s, A.key).firmware = clone(C.firmware);
        expectBlocked(s, A.key, C.key, "craftName");
    });

    it("A's ref says Bravo (Flight and CHIRP links) while its block still says Alpha, compared with B (Alpha)", () => {
        const s = clone(base);
        const a = flightOf(s, A.key);
        a.ref.header.fields["Craft name"] = "Bravo";
        for (const c of a.chirps) {
            c.qualityV2.identity.flight.ref!.header.fields["Craft name"] = "Bravo";
        }
        expectBlocked(s, A.key, B.key, "craftName");
    });

    it.each(HEADER_FIELDS.map(([f, h]) => [f, h] as const))(
        "%s: both refs null while both blocks claim the same value",
        (field, header) => {
            const s = clone(base);
            for (const key of [A.key, B.key]) {
                flightOf(s, key).ref.header.fields[header] = null;
            }
            expectBlocked(s, A.key, B.key, field);
        },
    );

    it.each(HEADER_FIELDS.map(([f, h]) => [f, h] as const))(
        "%s: both sides consistently null is UNKNOWN, not MATCH",
        (field, header) => {
            const s = clone(base);
            for (const key of [A.key, B.key]) {
                const f = flightOf(s, key);
                f.ref.header.fields[header] = null;
                f.firmware[field] = null;
                f.firmware.unknown = [field];
            }
            const e = flightPairEvidence(s, A.key, B.key);
            expect(e.firmware[field]).toBe("UNKNOWN");
            expect(e.blockers).toContain(`firmware_unknown:${field}`);
        },
    );

    it.each(HEADER_FIELDS.map(([f, h]) => [f, h] as const))(
        "%s: one side's ref null while its block copies the other side's value",
        (field, header) => {
            const s = clone(base);
            flightOf(s, B.key).ref.header.fields[header] = null;
            expectBlocked(s, A.key, B.key, field);
        },
    );

    it("both refs null while both blocks say '' (empty string is not null)", () => {
        const s = clone(base);
        for (const key of [A.key, B.key]) {
            const f = flightOf(s, key);
            f.ref.header.fields["Firmware date"] = null;
            f.firmware.firmwareDate = "";
        }
        expectBlocked(s, A.key, B.key, "firmwareDate");
    });

    it("A's block differs from its ref only by trailing whitespace, B is exact", () => {
        const s = clone(base);
        const a = flightOf(s, A.key);
        a.ref.header.fields["Board information"] = "SYNT SYNTHETICF7 ";
        expectBlocked(s, A.key, B.key, "boardInformation");
    });

    it("apiVersion: A's CHIRPs say 1.48.0 while A's Flight still claims B's 1.49.0", () => {
        const s = clone(base);
        for (const c of flightOf(s, A.key).chirps) {
            c.qualityV2.provenance.apiVersion = "1.48.0";
        }
        expectBlocked(s, A.key, B.key, "apiVersion");
    });

    it("apiVersion: one of A's CHIRPs conflicts with the others", () => {
        const s = clone(base);
        flightOf(s, A.key).chirps[2].qualityV2.provenance.apiVersion = "1.48.0";
        expectBlocked(s, A.key, B.key, "apiVersion");
    });

    it("apiVersion: A's log has no API line while its block still claims 1.49.0", () => {
        const s = clone(base);
        const a = flightOf(s, A.key);
        a.logHeaders = (a.logHeaders ?? []).filter(([k]) => k !== "Firmware API version");
        expectBlocked(s, A.key, B.key, "apiVersion");
    });

    it("apiVersion: A logs 1.48.0 while block and CHIRPs claim B's 1.49.0", () => {
        const s = clone(base);
        const a = flightOf(s, A.key);
        a.logHeaders = (a.logHeaders ?? []).map(([k, v]) => [k, k === "Firmware API version" ? "1.48.0" : v]);
        expectBlocked(s, A.key, B.key, "apiVersion");
    });

    it("apiVersion: neither Flight logs it, both null with the same CHIRP fallback, is never MATCH", () => {
        const s = clone(base);
        for (const key of [A.key, B.key]) {
            const f = flightOf(s, key);
            f.logHeaders = (f.logHeaders ?? []).filter(([k]) => k !== "Firmware API version");
            f.firmware.apiVersion = null;
            f.firmware.unknown = ["apiVersion"];
        }
        const e = flightPairEvidence(s, A.key, B.key);
        expect(e.firmware.apiVersion).not.toBe("MATCH");
        expect(e.blockers.length).toBeGreaterThan(0);
    });

    it("apiVersion: neither Flight logs it, both blocks filled with the fallback", () => {
        const s = clone(base);
        for (const key of [A.key, B.key]) {
            const f = flightOf(s, key);
            f.logHeaders = (f.logHeaders ?? []).filter(([k]) => k !== "Firmware API version");
        }
        expectBlocked(s, A.key, B.key, "apiVersion");
    });

    it("apiVersion: both Flights null on the CHIRPs while both blocks claim 1.49.0", () => {
        const s = clone(base);
        for (const key of [A.key, B.key]) {
            for (const c of flightOf(s, key).chirps) {
                c.qualityV2.provenance.apiVersion = null;
            }
        }
        expectBlocked(s, A.key, B.key, "apiVersion");
    });

    it("apiVersion: a Flight without CHIRPs has no source, so it never matches", () => {
        const s = clone(base);
        flightOf(s, B.key).chirps = [];
        const e = flightPairEvidence(s, A.key, B.key);
        expect(e.firmware.apiVersion).not.toBe("MATCH");
        expect(e.blockers.length).toBeGreaterThan(0);
    });

    it("Flight N (no API line) never matches A on apiVersion", () => {
        const s = addFlights(newTuneSession({ id: "synthetic-n4", name: "n", now: NOW }), [A, N], NOW).session;
        const e = flightPairEvidence(s, A.key, N.key);
        expect(e.firmware.craftName).not.toBe("MATCH");
        expect(e.blockers.length).toBeGreaterThan(0);
        expect(e.firmware.apiVersion).not.toBe("MATCH");
    });

    it("an untouched pair still reports MATCH (the fix does not block everything)", () => {
        const s = clone(base);
        const e = flightPairEvidence(s, A.key, B.key);
        expect(FIRMWARE_FIELDS.every((f) => e.firmware[f] === "MATCH")).toBe(true);
        expect(e.blockers).toEqual([]);
    });

    it("a damaged pair does not change the evidence for a clean pair", () => {
        const s = clone(base);
        flightOf(s, C.key).firmware.craftName = "Alpha";
        expect(flightPairEvidence(s, A.key, B.key).blockers).toEqual([]);
        expect(flightPairEvidence(s, A.key, C.key).firmware.craftName).not.toBe("MATCH");
    });
});

describe("IndexedDB round trip (fake-indexeddb, SYNTHETIC records)", () => {
    const DB = "gyroflight-gyrocore";
    const STORE = "tuneSessions";

    function rawDb(factory: IDBFactory): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
            const req = factory.open(DB);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function rawPut(factory: IDBFactory, record: unknown): Promise<void> {
        const db = await rawDb(factory);
        try {
            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction(STORE, "readwrite");
                tx.objectStore(STORE).put(record);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error);
            });
        } finally {
            db.close();
        }
    }

    async function roundTrip(change: (s: TuneSession) => void) {
        const indexedDB = new IDBFactory();
        const store = openTuneSessionStore({
            indexedDB,
            now: () => new Date(NOW),
            newId: () => "synthetic-idb-session",
        });
        try {
            const created = await store.create("synthetic", clone([A, B, C]));
            const raw = clone(created);
            change(raw);
            await rawPut(indexedDB, raw);
            const loaded = await store.load(created.id);
            const list = await store.list();
            return { created, loaded, list };
        } finally {
            store.close();
        }
    }

    it("stores and loads the SYNTHETIC session unchanged", async () => {
        const { created, loaded, list } = await roundTrip(() => {});
        expect(loaded.status).toBe("ok");
        if (loaded.status === "ok") {
            expect(loaded.rejected).toEqual([]);
            expect(loaded.session).toEqual(created);
            expectSpecConsistent(loaded.session);
        }
        expect(list).toEqual([
            expect.objectContaining({ id: created.id, status: "ok", flightCount: 3, chirpCount: 5 }),
        ]);
    });

    it.each([
        ["identity axis", (s: TuneSession) => put(s, [...idPath(1), "axis"], 0)],
        ["identity chirpIndex", (s: TuneSession) => put(s, [...idPath(1), "chirpIndex"], 2)],
        ["axis 3 on both sides", (s: TuneSession) => setBoth(s, 1, "axis", 3)],
        ["axisName on both sides", (s: TuneSession) => setBoth(s, 1, "axisName", "roll")],
        [
            "durationS beyond tolerance on both sides",
            (s: TuneSession) => setBoth(s, 1, "durationS", s.flights[0].chirps[1].durationS + 1),
        ],
        [
            "reversed times on both sides",
            (s: TuneSession) => {
                const c = s.flights[0].chirps[1];
                const [start, end] = [c.startTimeUs, c.endTimeUs];
                setBoth(s, 1, "startTimeUs", end);
                setBoth(s, 1, "endTimeUs", start);
            },
        ],
        ["measurementId form on both sides", (s: TuneSession) => setBoth(s, 1, "measurementId", "log1-seg9")],
        ["stored sampleCount only", (s: TuneSession) => put(s, [...chirpPath(1), "sampleCount"], 1)],
    ])("rejects only the CHIRP after an IndexedDB write: %s", async (_name, change) => {
        const { loaded, list } = await roundTrip(change);
        expect(loaded.status).toBe("ok");
        if (loaded.status !== "ok") {
            return;
        }
        expect(loaded.rejected.map((r) => r.path)).toEqual(["flights[0].chirps[1]"]);
        expect(loaded.rejected[0].problems.length).toBeGreaterThan(0);
        expect(loaded.session.flights.map((f) => f.chirps.length)).toEqual([2, 1, 1]);
        expect(loaded.session.flights[0].chirps.map((c) => c.measurementId)).toEqual(["log1-seg1", "log1-seg3"]);
        expect(loaded.session.flights.slice(1)).toEqual(base.flights.slice(1).map((f) => ({ ...f, addedAt: NOW })));
        expectSpecConsistent(loaded.session);
        expect(list).toHaveLength(1);
        expect(list[0].status).toBe("ok");
        expect(list[0].flightCount).toBe(3);
        expect(list[0].chirpCount).toBe(4);
    });

    it("never accepts an infinite end time written straight into IndexedDB", async () => {
        const { loaded } = await roundTrip((s) => setBoth(s, 1, "endTimeUs", Infinity));
        if (loaded.status === "ok") {
            expect(loaded.rejected.map((r) => r.path)).toContain("flights[0].chirps[1]");
            expectSpecConsistent(loaded.session);
        } else {
            expect(loaded.status).toBe("corrupt");
        }
    });

    it.each([
        ["craftName in the block only", (s: TuneSession) => put(s, ["flights", 0, "firmware", "craftName"], "Bravo")],
        [
            "firmwareDate null in the block",
            (s: TuneSession) => {
                s.flights[0].firmware.firmwareDate = null;
                s.flights[0].firmware.unknown = ["firmwareDate"];
            },
        ],
        [
            "apiVersion on the Flight only",
            (s: TuneSession) => put(s, ["flights", 0, "firmware", "apiVersion"], "1.48.0"),
        ],
        [
            "unknown names a field with a value",
            (s: TuneSession) => put(s, ["flights", 0, "firmware", "unknown"], ["boardInformation"]),
        ],
    ])("rejects only Flight 0 after an IndexedDB write: %s", async (_name, change) => {
        const { loaded, list } = await roundTrip(change);
        expect(loaded.status).toBe("ok");
        if (loaded.status !== "ok") {
            return;
        }
        expect(loaded.rejected.map((r) => r.path)).toEqual(["flights[0]"]);
        expect(loaded.session.flights.map((f) => f.key)).toEqual([B.key, C.key]);
        expectSpecConsistent(loaded.session);
        expect(list[0]).toMatchObject({ status: "ok", flightCount: 2, chirpCount: 2 });
    });

    it("a loaded session never carries authorization or file bytes", async () => {
        const { loaded } = await roundTrip(() => {});
        expect(loaded.status).toBe("ok");
        if (loaded.status !== "ok") {
            return;
        }
        expect(loaded.session.authorization).toEqual(SESSION_AUTHORIZATION);
        const json = JSON.stringify(loaded.session);
        expect(json).not.toMatch(/"tuningAuthorized":\{"status":"YES"/);
        const walk = (v: unknown): void => {
            expect(ArrayBuffer.isView(v) || v instanceof ArrayBuffer).toBe(false);
            if (v && typeof v === "object") {
                Object.values(v).forEach(walk);
            }
        };
        walk(loaded.session);
        // A whole BBL would be hundreds of kB; three CHIRP reports are far smaller than the three files.
        expect(json.length).toBeLessThan(250_000 * 3);
    });
});
