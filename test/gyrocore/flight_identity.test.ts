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
 * File and Flight identity (docs/gyrocore/FLIGHT_IDENTITY.md).
 *
 * SYNTHETIC: every BBL here is synthetic. The multi-flight files are the committed,
 * sha-pinned single-log fixtures (fixtures/PROVENANCE.md) concatenated in memory,
 * which is how one file holds several logs. They test parsing, selection, identity
 * and error handling only; they are not flight evidence.
 */

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { FlightLog } from "../../src/blackbox-viewer/flightlog.js";
import { chirpFramesFromFlightLog, type FlightLogFrames } from "../../src/gyrocore/chirp/extraction";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import {
    BODY_PREFIX_BYTES,
    catalogBbl,
    checkIndependentFlights,
    FLIGHT_IDENTITY_SCHEMA,
    flightForLog,
    relateFlights,
    type FlightRef,
} from "../../src/gyrocore/flight/identity";
import { sha256Hex, Sha256UnavailableError } from "../../src/gyrocore/flight/sha256";
import { concatLogs, encodeChirpLog, simulateChirp } from "./harness/chirpSim";
import { readFixtureBytes, readFixtureJson } from "./harness/fixtures";

vi.mock("../../src/js/localization", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/js/localization")>()),
    i18n: { getMessage: (key: string) => key },
}));

interface Case {
    case_id: string;
    bbl: string;
    bbl_sha256: string;
    headers: Record<string, string>;
}
const CASES = new Map(readFixtureJson<{ cases: Case[] }>("chirp/cases.json").cases.map((c) => [c.case_id, c] as const));

function fixture(caseId: string): Uint8Array {
    return readFixtureBytes(`chirp/${CASES.get(caseId)!.bbl}`);
}

const nodeSha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

const clean = fixture("clean_single_axis");
const noisy = fixture("noisy");
const threeAxis = fixture("three_axis_sequence");

/** SYNTHETIC session.bbl: Flight 1 = A candidate, Flight 2 = another flight, Flight 3 = B candidate. */
const session = concatLogs(clean, noisy, threeAxis);

function decodedFrames(bytes: Uint8Array, logIndex: number) {
    const log = new FlightLog(bytes) as unknown as FlightLogFrames & { openLog(i: number): boolean };
    expect(log.openLog(logIndex)).toBe(true);
    return chirpFramesFromFlightLog(log);
}

describe("sha256Hex", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("is SHA-256 of exactly the bytes of a view, not its whole buffer", async () => {
        const buf = new TextEncoder().encode("xxabcxx");
        expect(await sha256Hex(buf.subarray(2, 5))).toBe(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        );
        expect(await sha256Hex(session)).toBe(nodeSha(session));
    });

    it("refuses to produce an identity without Web Crypto", async () => {
        vi.stubGlobal("crypto", undefined);
        await expect(sha256Hex(new Uint8Array([1]))).rejects.toBeInstanceOf(Sha256UnavailableError);
        await expect(catalogBbl(clean)).rejects.toBeInstanceOf(Sha256UnavailableError);
    });
});

describe("one BBL, several Flights", () => {
    it("finds every log section, at the Viewer's offsets, with each section's own hash", async () => {
        const cat = await catalogBbl(session);
        expect(cat.schema).toBe(FLIGHT_IDENTITY_SCHEMA);
        expect(cat.status).toBe("valid");
        expect(cat.file).toEqual({ sha256: nodeSha(session), byteLength: session.length });
        expect(cat.flights.map((f) => f.logIndex)).toEqual([0, 1, 2]);
        expect(cat.flights.every((f) => f.logCount === 3 && f.status === "valid")).toBe(true);

        // Sections tile the file exactly.
        expect(cat.flights.map((f) => [f.section.byteBegin, f.section.byteEnd])).toEqual([
            [0, clean.length],
            [clean.length, clean.length + noisy.length],
            [clean.length + noisy.length, session.length],
        ]);
        // Each section's hash is the published hash of the standalone fixture it came from.
        expect(cat.flights.map((f) => f.section.sha256)).toEqual(
            ["clean_single_axis", "noisy", "three_axis_sequence"].map((id) => CASES.get(id)!.bbl_sha256),
        );
        expect(cat.flights.map((f) => f.locationId)).toEqual([0, 1, 2].map((i) => `${nodeSha(session)}#${i}`));
    });

    it("records header metadata verbatim and leaves absent lines null", async () => {
        const [f] = (await catalogBbl(session)).flights;
        const logged = CASES.get("clean_single_axis")!.headers;
        expect(f.header.fields["Firmware revision"]).toBe(logged["Firmware revision"]);
        expect(f.header.fields["Board information"]).toBe(logged["Board information"]);
        expect(f.header.fields["Firmware type"]).toBe(logged["Firmware type"]);
        expect(f.header.fields["Craft name"]).toBeNull();
        expect(f.header.fields["Log start datetime"]).toBeNull();
        expect(f.header.byteLength).toBeGreaterThan(0);
        expect(f.bodyPrefix.byteLength).toBe(BODY_PREFIX_BYTES);
    });

    it("decodes every Flight of the multi-flight file exactly as the standalone file (Viewer parity)", () => {
        const sources = [clean, noisy, threeAxis];
        sources.forEach((single, i) => {
            expect(decodedFrames(session, i)).toEqual(decodedFrames(single, 0));
        });
    });

    it("the CHIRP qualification sees the same measurements per Flight as in the standalone files", () => {
        const multi = qualifyChirpFile(session, "session.bbl", 60, AUTOTUNE_MATH);
        const strip = (r: ReturnType<typeof qualifyChirpFile>) =>
            r.measurements.map((m) => [m.axisName, m.sampleCount, m.state, m.quality.meanBandCoherence]);
        [clean, noisy, threeAxis].forEach((single, i) => {
            const alone = qualifyChirpFile(single, "single.bbl", 60, AUTOTUNE_MATH);
            const fromMulti = multi.measurements.filter((m) => m.logIndex === i);
            expect(strip({ ...multi, measurements: fromMulti })).toEqual(strip(alone));
        });
    });
});

describe("Flight A and Flight B", () => {
    it("Flight 1 and Flight 3 of one file are independent recordings", async () => {
        const cat = await catalogBbl(session);
        const check = checkIndependentFlights(cat.flights[0], cat.flights[2]);
        expect(check).toEqual({ independent: true, relation: "distinct", reasons: [] });
    });

    it("the same Flight chosen twice is never independent", async () => {
        const [f] = (await catalogBbl(session)).flights;
        expect(checkIndependentFlights(f, f)).toMatchObject({
            independent: false,
            relation: "same_section",
            reasons: ["same_flight_section"],
        });
    });

    it("two CHIRPs inside one Flight belong to one Flight and cannot be A and B", async () => {
        const report = qualifyChirpFile(threeAxis, "three.bbl", 60, AUTOTUNE_MATH);
        expect(report.measurements.length).toBeGreaterThan(1);
        const cat = await catalogBbl(threeAxis);
        const refs = report.measurements.map((m) => flightForLog(cat, m.logIndex));
        expect(new Set(refs.map((r) => r?.locationId)).size).toBe(1);
        expect(checkIndependentFlights(refs[0], refs[1]).independent).toBe(false);
    });

    it("identical bytes at two different positions of one file are the same flight", async () => {
        const cat = await catalogBbl(concatLogs(clean, noisy, clean));
        expect(cat.flights[0].locationId).not.toBe(cat.flights[2].locationId);
        expect(checkIndependentFlights(cat.flights[0], cat.flights[2]).reasons).toEqual(["same_flight_section"]);
    });

    it("the same flight in two different files is recognised by its section, not by file or name", async () => {
        const x = await catalogBbl(concatLogs(clean, noisy));
        const y = await catalogBbl(concatLogs(threeAxis, clean));
        expect(x.file.sha256).not.toBe(y.file.sha256);
        expect(relateFlights(x.flights[0], y.flights[1])).toBe("same_section");
        expect(checkIndependentFlights(x.flights[0], y.flights[1]).independent).toBe(false);
        expect(checkIndependentFlights(x.flights[1], y.flights[0]).independent).toBe(true);
    });

    it("a copy with missing bytes at the end is still the same flight", async () => {
        const truncated = clean.slice(0, clean.length - 500);
        const [orig] = (await catalogBbl(clean)).flights;
        const [copy] = (await catalogBbl(truncated)).flights;
        expect(copy.section.sha256).not.toBe(orig.section.sha256);
        expect(checkIndependentFlights(orig, copy)).toMatchObject({
            independent: false,
            relation: "same_flight_content",
            reasons: ["same_flight_content"],
        });
    });

    it("two flights with identical headers but different data are distinct", async () => {
        const a = encodeChirpLog(simulateChirp({ axis: 0, seconds: 6, crossoverHz: 40 }));
        const b = encodeChirpLog(simulateChirp({ axis: 0, seconds: 6, crossoverHz: 55 }));
        const cat = await catalogBbl(concatLogs(a, b));
        const [fa, fb] = cat.flights;
        expect(fa.header.sha256).toBe(fb.header.sha256);
        expect(checkIndependentFlights(fa, fb)).toEqual({ independent: true, relation: "distinct", reasons: [] });
    });

    it("is fail-closed on incomplete or foreign identities", async () => {
        const [a, b] = (await catalogBbl(concatLogs(clean, noisy))).flights;
        expect(checkIndependentFlights(null, b)).toEqual({
            independent: false,
            relation: null,
            reasons: ["flight_a_identity_incomplete"],
        });
        expect(checkIndependentFlights(a, undefined).reasons).toEqual(["flight_b_identity_incomplete"]);
        const foreign = { ...b, schema: "something.else" } as unknown as FlightRef;
        expect(checkIndependentFlights(a, foreign).independent).toBe(false);
        const noSection = { ...b, section: undefined } as unknown as FlightRef;
        expect(checkIndependentFlights(a, noSection).independent).toBe(false);
    });
});

describe("validity levels", () => {
    const marker = "H Product:Blackbox flight data recorder by Nicholas Sherlock\n";
    const broken = new TextEncoder().encode(`${marker}H Data version:2\nnot a blackbox log`);

    it("an unreadable Flight is invalid; the file and the other Flights stay valid", async () => {
        const cat = await catalogBbl(concatLogs(clean, broken, noisy));
        expect(cat.status).toBe("valid");
        expect(cat.flights.map((f) => f.status)).toEqual(["valid", "invalid", "valid"]);
        expect(cat.flights[1].reasons[0]).toMatch(/^log_unreadable:/);
        expect(cat.flights[1].timeRangeUs).toBeNull();
        expect(checkIndependentFlights(cat.flights[0], cat.flights[1]).reasons).toEqual(["flight_b_invalid"]);
        expect(checkIndependentFlights(cat.flights[0], cat.flights[2]).independent).toBe(true);
    });

    it("a Flight without a usable CHIRP is still a valid Flight", async () => {
        const wrongMode = fixture("malformed_wrong_debug_mode");
        const [f] = (await catalogBbl(wrongMode)).flights;
        expect(f.status).toBe("valid");
        expect(qualifyChirpFile(wrongMode, "x.bbl", 60, AUTOTUNE_MATH).state).toBe("no_chirp");
    });

    it("a file with no log section is an invalid BBL, not an exception", async () => {
        for (const bytes of [new Uint8Array(), new TextEncoder().encode("hello, not a log")]) {
            const cat = await catalogBbl(bytes);
            expect(cat).toMatchObject({ status: "invalid", reasons: ["no_log_sections"], flights: [] });
            expect(cat.file.sha256).toBe(nodeSha(bytes));
        }
    });
});

describe("Tune Session interface", () => {
    it("is plain JSON without file bytes and works unchanged after a round trip", async () => {
        const cat = await catalogBbl(session);
        const json = JSON.stringify(cat);
        const back = JSON.parse(json);
        expect(back).toEqual(cat);
        expect(json.length).toBeLessThan(session.length / 20);
        for (const f of cat.flights) {
            for (const value of Object.values(f)) {
                expect(value).not.toBeInstanceOf(Uint8Array);
            }
        }
        expect(checkIndependentFlights(back.flights[0], back.flights[2]).independent).toBe(true);
        expect(checkIndependentFlights(back.flights[0], cat.flights[0]).independent).toBe(false);
    });

    it("does not depend on the file name or on loading the file twice", async () => {
        const first = await catalogBbl(session);
        const second = await catalogBbl(session.slice());
        expect(second).toEqual(first);
    });
});
