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
 * Adversarial tests for File and Flight identity (docs/gyrocore/FLIGHT_IDENTITY.md),
 * written against the spec without reading the implementation. All data is
 * SYNTHETIC: committed synthetic fixtures and logs generated in memory. Ground
 * truth for section offsets and readability is the Blackbox Viewer
 * (FlightLogIndex / FlightLog) and node:crypto.
 */

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FlightLog } from "../../src/blackbox-viewer/flightlog.js";
import { FlightLogIndex } from "../../src/blackbox-viewer/flightlog_index.js";
import {
    BODY_PREFIX_BYTES,
    catalogBbl,
    checkIndependentFlights,
    FLIGHT_IDENTITY_SCHEMA,
    flightForLog,
    IDENTITY_HEADER_KEYS,
    relateFlights,
    type BblCatalog,
    type FlightRef,
} from "../../src/gyrocore/flight/identity";
import { Sha256UnavailableError, sha256Hex } from "../../src/gyrocore/flight/sha256";
import { concatLogs, encodeChirpLog, simulateChirp } from "./harness/chirpSim";
import { readFixtureBytes, readFixtureJson } from "./harness/fixtures";

const MARKER = "H Product:Blackbox flight data recorder by Nicholas Sherlock\n";
const enc = (s: string) => new TextEncoder().encode(s);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const EMPTY_SHA = sha(new Uint8Array());

interface Case {
    case_id: string;
    bbl: string;
    bbl_sha256: string;
}
const cases = readFixtureJson<{ cases: Case[] }>("chirp/cases.json").cases;
const fixture = (id: string) => {
    const c = cases.find((x) => x.case_id === id)!;
    return { bytes: readFixtureBytes(`chirp/${c.bbl}`), sha: c.bbl_sha256 };
};

/** A synthetic log; `startTimeUs` makes the first I-frame differ between recordings. */
function log(startTimeUs = 1_000_000, seconds = 1, headers?: string[]) {
    return encodeChirpLog(simulateChirp({ seconds, startTimeUs }), headers);
}

/** Length of the leading run of lines that start with "H " (independent header scan). */
function headerLength(section: Uint8Array): number {
    let at = 0;
    while (at + 1 < section.length && section[at] === 0x48 && section[at + 1] === 0x20) {
        const nl = section.indexOf(0x0a, at);
        if (nl < 0) {
            return section.length;
        }
        at = nl + 1;
    }
    return at;
}

/** Replace a log's header with raw header bytes, keeping its frame data. */
function withRawHeader(logBytes: Uint8Array, header: Uint8Array): Uint8Array {
    return concatLogs(header, logBytes.subarray(headerLength(logBytes)));
}

/** The synthetic log's header lines as text, with extra raw lines inserted before the field definitions. */
function headerWith(logBytes: Uint8Array, extra: Uint8Array[]): Uint8Array {
    const head = logBytes.subarray(0, headerLength(logBytes));
    const text = new TextDecoder("latin1").decode(head);
    const cut = text.indexOf("H Field I name:");
    return concatLogs(head.subarray(0, cut), ...extra, head.subarray(cut));
}

function viewerTruth(bytes: Uint8Array) {
    const index = new FlightLogIndex(bytes);
    const count = index.getLogCount();
    const begins = Array.from({ length: count + 1 }, (_, i) => index.getLogBeginOffset(i));
    const fl = new FlightLog(bytes);
    const errors = Array.from({ length: count }, (_, i) => fl.getLogError(i));
    return { count, begins, errors, fl };
}

/** Checks every invariant the spec states for a catalog, against the Viewer and node:crypto. */
function expectConsistent(cat: BblCatalog, bytes: Uint8Array) {
    const truth = viewerTruth(bytes);
    expect(cat.schema).toBe(FLIGHT_IDENTITY_SCHEMA);
    expect(cat.file).toEqual({ sha256: sha(bytes), byteLength: bytes.length });
    expect(cat.flights).toHaveLength(truth.count);
    expect(cat.status).toBe(truth.count > 0 ? "valid" : "invalid");
    cat.flights.forEach((f, i) => {
        const { byteBegin, byteEnd } = f.section;
        expect(f.schema).toBe(FLIGHT_IDENTITY_SCHEMA);
        expect(f.logIndex).toBe(i);
        expect(f.logCount).toBe(truth.count);
        expect(f.file).toEqual(cat.file);
        expect(f.locationId).toBe(`${cat.file.sha256}#${i}`);
        expect([byteBegin, byteEnd]).toEqual([truth.begins[i], truth.begins[i + 1]]);
        const section = bytes.subarray(byteBegin, byteEnd);
        expect(f.section.sha256).toBe(sha(section));
        const hl = headerLength(section);
        expect(f.header.byteLength).toBe(hl);
        expect(f.header.sha256).toBe(sha(section.subarray(0, hl)));
        const pl = Math.min(BODY_PREFIX_BYTES, section.length - hl);
        expect(f.bodyPrefix).toEqual({ sha256: sha(section.subarray(hl, hl + pl)), byteLength: pl });
        expect(Object.keys(f.header.fields).sort()).toEqual([...IDENTITY_HEADER_KEYS].sort());
        const err = truth.errors[i];
        if (err) {
            expect(f.status).toBe("invalid");
            expect(f.reasons).toEqual([`log_unreadable:${err}`]);
            expect(f.timeRangeUs).toBeNull();
        } else {
            expect(f.status).toBe("valid");
            expect(f.reasons).toEqual([]);
            expect(f.timeRangeUs).toEqual({ min: truth.fl.getMinTime(i), max: truth.fl.getMaxTime(i) });
        }
        for (const h of [f.section.sha256, f.header.sha256, f.bodyPrefix.sha256, cat.file.sha256]) {
            expect(h).toMatch(/^[0-9a-f]{64}$/);
        }
    });
    // Every byte from the first marker on belongs to exactly one section.
    for (let i = 1; i < cat.flights.length; i++) {
        expect(cat.flights[i].section.byteBegin).toBe(cat.flights[i - 1].section.byteEnd);
    }
    if (cat.flights.length) {
        expect(cat.flights.at(-1)!.section.byteEnd).toBe(bytes.length);
    }
}

describe("sha256Hex", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("matches the standard vectors and node:crypto", async () => {
        expect(await sha256Hex(new Uint8Array())).toBe(EMPTY_SHA);
        expect(await sha256Hex(enc("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        const big = fixture("noisy").bytes;
        expect(await sha256Hex(big)).toBe(sha(big));
    });

    it("hashes only the bytes of a subarray view, not its whole backing buffer", async () => {
        const buf = enc("0123456789abcdefghij");
        const view = buf.subarray(5, 12);
        expect(await sha256Hex(view)).toBe(sha(view));
    });

    it("throws Sha256UnavailableError without crypto.subtle, and catalogBbl has no fallback", async () => {
        vi.stubGlobal("crypto", {});
        await expect(sha256Hex(enc("abc"))).rejects.toBeInstanceOf(Sha256UnavailableError);
        await expect(catalogBbl(log())).rejects.toBeInstanceOf(Sha256UnavailableError);
        vi.stubGlobal("crypto", undefined);
        await expect(sha256Hex(enc("abc"))).rejects.toBeInstanceOf(Sha256UnavailableError);
    });
});

describe("catalogBbl sections", () => {
    it("names a committed single-log fixture by its published hash, section = whole file", async () => {
        const { bytes, sha: published } = fixture("clean_single_axis");
        const cat = await catalogBbl(bytes);
        expectConsistent(cat, bytes);
        expect(cat.file.sha256).toBe(published);
        expect(cat.flights).toHaveLength(1);
        expect(cat.flights[0].section).toEqual({ sha256: published, byteBegin: 0, byteEnd: bytes.length });
        expect(cat.flights[0].status).toBe("valid");
    });

    it("splits concatenated fixtures exactly at each marker", async () => {
        const parts = ["clean_single_axis", "noisy", "known_gain"].map(fixture);
        const bytes = concatLogs(...parts.map((p) => p.bytes));
        const cat = await catalogBbl(bytes);
        expectConsistent(cat, bytes);
        expect(cat.flights.map((f) => f.section.sha256)).toEqual(parts.map((p) => p.sha));
    });

    it("leaves junk before the first marker outside every section", async () => {
        const one = log();
        const bytes = concatLogs(enc("garbage\nH not a marker\n"), one);
        const cat = await catalogBbl(bytes);
        expectConsistent(cat, bytes);
        expect(cat.flights).toHaveLength(1);
        expect(cat.flights[0].section.byteBegin).toBe(23);
        expect(cat.flights[0].section.sha256).toBe(sha(one));
    });

    it("puts trailing garbage and a marker without newline into the last section", async () => {
        const bytes = concatLogs(log(), log(5_000_000), enc("\x00\xffjunk"), enc(MARKER.trimEnd()));
        const cat = await catalogBbl(bytes);
        expectConsistent(cat, bytes);
        expect(cat.flights).toHaveLength(2);
    });

    it("follows the Viewer when the marker string appears inside frame data", async () => {
        const a = log();
        const mid = 2000;
        const bytes = concatLogs(a.subarray(0, mid), enc(MARKER), a.subarray(mid));
        const cat = await catalogBbl(bytes);
        expectConsistent(cat, bytes);
        expect(cat.flights).toHaveLength(2);
    });

    it("handles a header-only section (no frame data) and a section shorter than the body prefix", async () => {
        const full = log();
        const hl = headerLength(full);
        const headerOnly = full.subarray(0, hl);
        const short = full.subarray(0, hl + 100);
        const bytes = concatLogs(headerOnly, short, log(7_000_000));
        const cat = await catalogBbl(bytes);
        expectConsistent(cat, bytes);
        expect(cat.flights[0].bodyPrefix).toEqual({ sha256: EMPTY_SHA, byteLength: 0 });
        expect(cat.flights[1].bodyPrefix.byteLength).toBe(100);
        expect(cat.status).toBe("valid");
        expect(cat.flights[2].status).toBe("valid");
    });

    it("detects the header of CRLF-terminated lines up to the first frame byte", async () => {
        const a = log();
        const text = new TextDecoder("latin1").decode(a.subarray(0, headerLength(a)));
        const crlf = text.replace(/\n/g, "\r\n").replace(`${MARKER.trimEnd()}\r\n`, MARKER);
        const bytes = withRawHeader(
            a,
            Uint8Array.from(crlf, (c) => c.charCodeAt(0)),
        );
        const cat = await catalogBbl(bytes);
        expectConsistent(cat, bytes);
        expect(bytes[cat.flights[0].header.byteLength]).toBe("S".charCodeAt(0));
        expect(cat.flights[0].header.fields["Firmware type"]?.replace(/\r$/, "")).toBe("Cleanflight");
    });

    it("works on a Uint8Array view with a non-zero byteOffset", async () => {
        const inner = concatLogs(log(), log(3_000_000));
        const backing = concatLogs(enc("PREFIXPREFIX"), inner, enc("SUFFIX"));
        const view = backing.subarray(12, 12 + inner.length);
        const cat = await catalogBbl(view);
        expectConsistent(cat, inner);
        expect(cat).toEqual(await catalogBbl(inner.slice()));
    });
});

describe("validity levels", () => {
    it.each([
        ["empty", new Uint8Array()],
        ["foreign", enc("PK\x03\x04 not a blackbox log at all")],
        ["marker without newline", enc(MARKER.trimEnd())],
    ])("a %s file is invalid with no_log_sections, not an exception", async (_n, bytes) => {
        const cat = await catalogBbl(bytes);
        expect(cat.status).toBe("invalid");
        expect(cat.reasons).toEqual(["no_log_sections"]);
        expect(cat.flights).toEqual([]);
        expect(cat.file).toEqual({ sha256: sha(bytes), byteLength: bytes.length });
    });

    it("an unreadable Flight leaves the file and the other Flights valid", async () => {
        const broken = concatLogs(enc(MARKER), enc("H Data version:2\n"), new Uint8Array(500).fill(0x49));
        const bytes = concatLogs(log(), broken, log(9_000_000));
        const cat = await catalogBbl(bytes);
        expectConsistent(cat, bytes);
        expect(cat.status).toBe("valid");
        expect(cat.reasons).toEqual([]);
        expect(cat.flights.map((f) => f.status)).toEqual(["valid", "invalid", "valid"]);
        expect(cat.flights[1].reasons).toHaveLength(1);
        expect(cat.flights[1].reasons[0]).toMatch(/^log_unreadable:./);
    });

    it("a file whose sections are all unreadable is still BBL VALID", async () => {
        const bytes = concatLogs(enc(MARKER), enc("H junk\n"), enc(MARKER));
        const cat = await catalogBbl(bytes);
        expectConsistent(cat, bytes);
        expect(cat.flights.length).toBeGreaterThan(0);
        expect(cat.flights.every((f) => f.status === "invalid")).toBe(true);
        expect(cat.status).toBe("valid");
        expect(cat.reasons).toEqual([]);
    });

    it("a valid Flight with wrong debug mode and no CHIRP is still valid", async () => {
        const plain = withRawHeader(log(), headerWith(log(), []).slice());
        const text = new TextDecoder("latin1").decode(plain).replace("H debug_mode:96", "H debug_mode:0\x20");
        const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0));
        const cat = await catalogBbl(bytes);
        expectConsistent(cat, bytes);
        expect(cat.flights[0].status).toBe("valid");
    });
});

describe("header fields", () => {
    const fieldsOf = async (extra: Uint8Array[]) => {
        const a = log();
        const bytes = withRawHeader(a, headerWith(a, extra));
        const cat = await catalogBbl(bytes);
        expectConsistent(cat, bytes);
        return cat.flights[0].header.fields;
    };
    const latin1 = (bytes: number[]) => String.fromCharCode(...bytes);

    it("absent lines are null, never a default; present lines are kept", async () => {
        const f = await fieldsOf([]);
        expect(f["Firmware type"]).toBe("Cleanflight");
        expect(f["Firmware revision"]).toBe("Betaflight 2026.6.2 (synthetic) STM32F7X2");
        expect(f["Firmware date"]).toBeNull();
        expect(f["Board information"]).toBeNull();
        expect(f["Craft name"]).toBeNull();
        expect(f["Log start datetime"]).toBeNull();
    });

    it("keeps values verbatim: inner colons, trailing spaces, empty values", async () => {
        const f = await fieldsOf([
            enc("H Log start datetime:2026-01-02T03:04:05.678+00:00\n"),
            enc("H Craft name:  my quad  \n"),
            enc("H Board information:\n"),
        ]);
        expect(f["Log start datetime"]).toBe("2026-01-02T03:04:05.678+00:00");
        expect(f["Craft name"]).toBe("  my quad  ");
        expect(f["Board information"]).toBe("");
    });

    it("keeps high bytes 0x80-0x9f distinct (no UTF-8 replacement, no windows-1252 remap)", async () => {
        const raw = [0x80, 0x81, 0x8d, 0x9f, 0xa0, 0xe9, 0xff];
        const f = await fieldsOf([concatLogs(enc("H Craft name:"), Uint8Array.from(raw), enc("\n"))]);
        expect(f["Craft name"]).not.toContain("�");
        expect(f["Craft name"]).toBe(latin1(raw));
    });

    it("a duplicated Craft name line takes one of its values, deterministically", async () => {
        const dup = [enc("H Craft name:first\n"), enc("H Craft name:second\n")];
        const f1 = await fieldsOf(dup);
        const f2 = await fieldsOf(dup);
        expect(["first", "second"]).toContain(f1["Craft name"]);
        expect(f2["Craft name"]).toBe(f1["Craft name"]);
    });

    it("an H line that only starts with a key name is not that key", async () => {
        const f = await fieldsOf([enc("H Craft names:nope\n"), enc("H craft name:nope\n")]);
        expect(f["Craft name"]).toBeNull();
    });
});

describe("relations and independence", () => {
    it("same flight in two files with different names: same_section, different locationId", async () => {
        const a = log();
        const other = log(4_000_000);
        const alone = await catalogBbl(a);
        const inside = await catalogBbl(concatLogs(other, a));
        const fa = alone.flights[0];
        const fb = inside.flights[1];
        expect(fa.locationId).not.toBe(fb.locationId);
        expect(relateFlights(fa, fb)).toBe("same_section");
        const r = checkIndependentFlights(fa, fb);
        expect(r.independent).toBe(false);
        expect(r.relation).toBe("same_section");
        expect(r.reasons).toContain("same_flight_section");
    });

    it("the same flight appended twice is one recording", async () => {
        const cat = await catalogBbl(concatLogs(log(), log()));
        const [x, y] = cat.flights;
        expect(x.section.sha256).toBe(y.section.sha256);
        expect(checkIndependentFlights(x, y)).toMatchObject({ independent: false, relation: "same_section" });
        expect(checkIndependentFlights(x, x).reasons).toContain("same_flight_section");
    });

    it("a copy with extra trailing bytes or cut short after the prefix is same_flight_content", async () => {
        const a = log(1_000_000, 2);
        const hl = headerLength(a);
        const orig = (await catalogBbl(a)).flights[0];
        const longer = (await catalogBbl(concatLogs(a, enc("trailing")))).flights[0];
        const cut = (await catalogBbl(a.subarray(0, hl + BODY_PREFIX_BYTES + 1))).flights[0];
        for (const copy of [longer, cut]) {
            expect(copy.section.sha256).not.toBe(orig.section.sha256);
            expect(relateFlights(orig, copy)).toBe("same_flight_content");
            expect(relateFlights(copy, orig)).toBe("same_flight_content");
            const r = checkIndependentFlights(orig, copy);
            if (copy.status === "valid") {
                expect(r).toMatchObject({ independent: false, relation: "same_flight_content" });
                expect(r.reasons).toContain("same_flight_content");
            } else {
                expect(r.independent).toBe(false);
            }
        }
    });

    it("documents the known limit: a copy cut inside the body prefix is distinct", async () => {
        const a = log();
        const hl = headerLength(a);
        const orig = (await catalogBbl(a)).flights[0];
        const cut = (await catalogBbl(a.subarray(0, hl + BODY_PREFIX_BYTES - 1))).flights[0];
        expect(relateFlights(orig, cut)).toBe("distinct");
    });

    it("two flights on one configuration (identical headers, different first frames) are independent", async () => {
        const cat = await catalogBbl(concatLogs(log(1_000_000), log(60_000_000)));
        const [x, y] = cat.flights;
        expect(x.header.sha256).toBe(y.header.sha256);
        expect(x.bodyPrefix.sha256).not.toBe(y.bodyPrefix.sha256);
        expect(checkIndependentFlights(x, y)).toEqual({ independent: true, relation: "distinct", reasons: [] });
    });

    it("equal header and equal first 4096 frame bytes count as same_flight_content (spec rule)", async () => {
        const a = log(1_000_000, 2);
        const hl = headerLength(a);
        const b = a.slice();
        b[hl + BODY_PREFIX_BYTES + 500] ^= 0x01;
        const cat = await catalogBbl(concatLogs(a, b));
        expect(relateFlights(cat.flights[0], cat.flights[1])).toBe("same_flight_content");
        expect(checkIndependentFlights(cat.flights[0], cat.flights[1]).independent).toBe(false);
    });

    it("a difference inside the body prefix makes flights distinct", async () => {
        const a = log();
        const hl = headerLength(a);
        const b = a.slice();
        b[hl + BODY_PREFIX_BYTES - 1] ^= 0x01;
        const cat = await catalogBbl(concatLogs(a, b));
        expect(relateFlights(cat.flights[0], cat.flights[1])).toBe("distinct");
    });

    // PR #3 review: the same recording repackaged with an edited header used to count as independent.
    it("the same frame data under an edited header is the same flight", async () => {
        const a = log();
        const c = withRawHeader(a, headerWith(a, [enc("H Craft name:x\n")]));
        const cat = await catalogBbl(concatLogs(a, c));
        const [fa, fc] = cat.flights;
        expect(fa.header.sha256).not.toBe(fc.header.sha256);
        expect(relateFlights(fa, fc)).toBe("same_flight_content");
        expect(checkIndependentFlights(fa, fc).reasons).toEqual(["same_flight_content"]);
    });

    it("survives a JSON round trip: plain JSON, deterministic, same relations", async () => {
        const bytes = concatLogs(log(), log(), log(30_000_000));
        const cat = await catalogBbl(bytes);
        const json = JSON.stringify(cat);
        const back = JSON.parse(json) as BblCatalog;
        expect(back).toEqual(cat);
        expect(json.length).toBeLessThan(bytes.length / 4);
        expect(await catalogBbl(bytes.slice())).toEqual(cat);
        expect(checkIndependentFlights(back.flights[0], cat.flights[1]).relation).toBe("same_section");
        expect(checkIndependentFlights(back.flights[0], back.flights[2]).independent).toBe(true);
        expect(flightForLog(back, 2)).toEqual(cat.flights[2]);
    });

    it("flightForLog returns the Flight of that index and nothing for an index out of range", async () => {
        const cat = await catalogBbl(concatLogs(log(), log(2_000_000)));
        expect(flightForLog(cat, 0)).toBe(cat.flights[0]);
        expect(flightForLog(cat, 1)).toBe(cat.flights[1]);
        for (const bad of [-1, 2, 0.5, Number.NaN]) {
            expect(flightForLog(cat, bad)).toBeFalsy();
        }
    });
});

describe("checkIndependentFlights is fail-closed", () => {
    let good: [FlightRef, FlightRef];
    const ready = (async () => {
        const cat = await catalogBbl(concatLogs(log(1_000_000), log(50_000_000)));
        good = [cat.flights[0], cat.flights[1]];
    })();
    // Loose shape for deliberately malformed references.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type Loose = Record<string, any>;
    const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
    const mutate = (f: FlightRef, fn: (x: Loose) => void) => {
        const c = clone(f) as unknown as Loose;
        fn(c);
        return c as unknown as FlightRef;
    };

    it("sanity: the two good flights are independent", async () => {
        await ready;
        expect(checkIndependentFlights(good[0], good[1]).independent).toBe(true);
    });

    const incomplete: [string, (x: Loose) => void][] = [
        ["schema", (x) => (x.schema = "gyroflight.flight_identity.v0")],
        ["no schema", (x) => delete x.schema],
        ["section hash", (x) => delete x.section.sha256],
        ["numeric section hash", (x) => (x.section.sha256 = 0)],
        ["no section", (x) => delete x.section],
        ["header hash", (x) => delete x.header.sha256],
        ["no header", (x) => delete x.header],
        ["body prefix hash", (x) => delete x.bodyPrefix.sha256],
        ["no body prefix", (x) => delete x.bodyPrefix],
        ["null section hash", (x) => (x.section.sha256 = null)],
    ];

    it.each(incomplete)("rejects a reference with broken %s", async (_n, fn) => {
        await ready;
        const bad = mutate(good[0], fn);
        let r = checkIndependentFlights(bad, good[1]);
        expect(r.independent).toBe(false);
        expect(r.reasons).toContain("flight_a_identity_incomplete");
        r = checkIndependentFlights(good[1], bad);
        expect(r.independent).toBe(false);
        expect(r.reasons).toContain("flight_b_identity_incomplete");
    });

    it.each([null, undefined, {}, "x", 42, []])("rejects a missing or non-object reference %j", async (bad) => {
        await ready;
        const r = checkIndependentFlights(bad as unknown as FlightRef, good[1]);
        expect(r.independent).toBe(false);
        expect(r.reasons).toContain("flight_a_identity_incomplete");
    });

    it("rejects a Flight that is not FLIGHT VALID, naming the side", async () => {
        await ready;
        for (const status of ["invalid", "VALID", undefined, true]) {
            const bad = mutate(good[1], (x) => (x.status = status));
            const r = checkIndependentFlights(good[0], bad);
            expect(r.independent).toBe(false);
            expect(r.reasons.join()).toMatch(/flight_b_(invalid|identity_incomplete)/);
        }
    });

    // A stored reference saying "valid" while carrying a reason is contradictory; fail-closed rejects it.
    it("rejects a 'valid' reference that carries reasons", async () => {
        await ready;
        const bad = mutate(good[0], (x) => (x.reasons = ["log_unreadable:x"]));
        expect(checkIndependentFlights(bad, good[1]).independent).toBe(false);
    });

    it("reports both sides when both are invalid, a before b", async () => {
        await ready;
        const r = checkIndependentFlights(
            mutate(good[0], (x) => {
                x.status = "invalid";
                x.reasons = ["log_unreadable:x"];
                x.timeRangeUs = null;
            }),
            mutate(good[1], (x) => {
                x.status = "invalid";
                x.reasons = ["log_unreadable:x"];
                x.timeRangeUs = null;
            }),
        );
        expect(r.independent).toBe(false);
        expect(r.reasons.indexOf("flight_a_invalid")).toBeGreaterThanOrEqual(0);
        expect(r.reasons.indexOf("flight_b_invalid")).toBeGreaterThan(r.reasons.indexOf("flight_a_invalid"));
    });

    // Found by this suite: any string used to pass as a hash.
    it.each(["", "x", "z".repeat(64)])("rejects a reference whose hashes are not SHA-256 hex (%j)", async (v) => {
        await ready;
        for (const key of ["section", "header", "bodyPrefix"]) {
            const bad = mutate(good[0], (x) => (x[key].sha256 = v));
            const r = checkIndependentFlights(bad, good[1]);
            expect(r.independent).toBe(false);
            expect(r.reasons).toContain("flight_a_identity_incomplete");
        }
    });

    // Found by this suite: upper-cased stored hashes made one flight look independent of itself.
    it("never calls one flight independent of itself because its hashes changed case", async () => {
        await ready;
        const upper = mutate(good[0], (x) => {
            for (const key of ["section", "header", "bodyPrefix"]) {
                x[key].sha256 = x[key].sha256.toUpperCase();
            }
        });
        expect(checkIndependentFlights(upper, good[0]).independent).toBe(false);
    });

    it("an invalid copy of the same flight is still reported as the same section", async () => {
        await ready;
        const bad = mutate(good[0], (x) => {
            x.status = "invalid";
            x.reasons = ["log_unreadable:x"];
            x.timeRangeUs = null;
        });
        const r = checkIndependentFlights(bad, good[0]);
        expect(r.independent).toBe(false);
        expect(r.reasons).toContain("flight_a_invalid");
    });
});
