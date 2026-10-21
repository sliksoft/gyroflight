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
 * WU5 Cross-flight Comparison: engine, configuration comparison, IndexedDB
 * round trip and the component. SYNTHETIC logs only, analysed through the real
 * Betaflight decode, Quality V2 and WU1 identity. They test the comparison
 * rules and are never evidence of how a real AIR65 flight behaves.
 *
 * Expected differences are computed in this file from the stored arrays and
 * from the edits made to them, never with the production helpers.
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
import { attachChirpFlightIdentity } from "../../src/gyrocore/chirp/qualityV2/identity";
import { compareFlights } from "../../src/gyrocore/compare/compare";
import type { ChirpPairComparison, CrossFlightComparison } from "../../src/gyrocore/compare/contract";
import FlightAbSelector from "../../src/gyrocore/components/FlightAbSelector.vue";
import { useFlightAbSelector } from "../../src/gyrocore/composables/useFlightAbSelector";
import { PRODUCT_APPLY_PENDING, productApplyBlocks } from "../../src/gyrocore/productLock/productApply";
import { addFlights, flightsFromReport, newTuneSession } from "../../src/gyrocore/session/build";
import {
    SESSION_AUTHORIZATION,
    TUNE_SESSION_SCHEMA_VERSION,
    type LoadResult,
    type StoredChirp,
    type StoredFlight,
    type TuneSession,
} from "../../src/gyrocore/session/contract";
import type { AbSelection } from "../../src/gyrocore/session/selection";
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
    simulateChirpSequence,
    type SimOptions,
} from "./harness/chirpSim";

const T0 = "2026-10-13T12:00:00.000Z";
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** SYNTHETIC headers: every firmware field and the CHIRP amplitudes logged. */
const HEADERS = [
    ...FULL_TUNE_HEADERS,
    "chirp_amplitude_roll:200",
    "chirp_amplitude_pitch:200",
    "chirp_amplitude_yaw:200",
    "Board information:SYNT SYNTHETIC",
    "Craft name:SYNTHETIC",
    "Firmware date:Jun  1 2026 12:00:00",
    "Firmware API version:1.48.0",
];

/** Roll, pitch, yaw, then roll again: four CHIRPs, two of them roll. */
const AXES: (0 | 1 | 2)[] = [0, 1, 2, 0];

/** SYNTHETIC: one log with a CHIRP per entry of `axes`; `crossoverHz` makes its data, and its Flight, distinct. */
function log(crossoverHz: number, opts: { headers?: string[]; start?: string; axes?: (0 | 1 | 2)[] } = {}) {
    const sweeps: SimOptions[] = (opts.axes ?? AXES).map((axis) => ({
        seconds: 6,
        firmwareDebug: true,
        axis,
        crossoverHz,
    }));
    return encodeChirpLog(simulateChirpSequence(sweeps), [
        ...(opts.headers ?? HEADERS),
        `Log start datetime:${opts.start ?? "2026-10-13T10:00:00.000+00:00"}`,
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

async function flightsOf(bytes: Uint8Array, fileName: string): Promise<StoredFlight[]> {
    const r = qualifyChirpFile(bytes, fileName, 60, AUTOTUNE_MATH);
    await attachChirpFlightIdentity(r, bytes);
    return flightsFromReport(r, { fileName, analyzedAt: T0 }).flights;
}

function inMemory(flights: StoredFlight[], id = "mem"): TuneSession {
    return json(addFlights(newTuneSession({ id, name: id, now: T0 }), flights, T0).session);
}

const ok = (session: TuneSession, rejected: { path: string; problems: string[] }[] = []): LoadResult => ({
    status: "ok",
    session,
    rejected,
    migratedFrom: null,
});

const pick = (s: TuneSession, a: string | null, b: string | null): AbSelection => ({
    sessionId: s.id,
    a,
    b,
    cleared: [],
});

function compare(s: TuneSession, a = s.flights[0].key, b = s.flights[1].key): CrossFlightComparison {
    return compareFlights(ok(s), pick(s, a, b));
}

const pairOf = (r: CrossFlightComparison, id: string): ChirpPairComparison =>
    r.axes.flatMap((x) => x.pairs).find((p) => p.id === id)!;

const chirp = (f: StoredFlight, axisName: string, occ: number): StoredChirp =>
    f.chirps.find((c) => c.axisName === axisName && c.axisOccurrence === occ)!;

/** Replace B's bins of one CHIRP with A's, then let `edit` change them (synthetic, in memory). */
function copyBins(
    s: TuneSession,
    axisName: string,
    occ: number,
    edit?: (bins: StoredChirp["qualityV2"]["coherence"]["bins"]) => void,
) {
    const from = chirp(s.flights[0], axisName, occ).qualityV2.coherence.bins;
    const to = chirp(s.flights[1], axisName, occ).qualityV2.coherence;
    to.bins = json(from);
    edit?.(to.bins);
}

function deepFreeze<T>(o: T): T {
    if (o && typeof o === "object") {
        Object.values(o).forEach(deepFreeze);
        Object.freeze(o);
    }
    return o;
}

let ids = 0;
function store(factory = new IDBFactory()) {
    return openTuneSessionStore({ indexedDB: factory, now: () => new Date(T0), newId: () => `session-${++ids}` });
}

/** SYNTHETIC Flights, built once through the real analysis and WU1 identity. */
let base: Uint8Array;
let flightA: StoredFlight;
let flightB: StoredFlight;
let flightC: StoredFlight;
let copied: StoredFlight;
let repackaged: StoredFlight;
let noApi: StoredFlight[];

beforeAll(async () => {
    base = log(40);
    [flightA] = await flightsOf(base, "a.bbl");
    [flightB] = await flightsOf(log(30, { start: "2026-10-13T10:10:00.000+00:00" }), "b.bbl");
    [flightC] = await flightsOf(log(35, { start: "2026-10-13T10:20:00.000+00:00" }), "c.bbl");
    // The same log section appended to another recording: a copy in another file.
    [, copied] = await flightsOf(concatLogs(log(50, { axes: [0] }), base), "copy.bbl");
    [repackaged] = await flightsOf(replaceText(base, "Craft name:SYNTHETIC", "Craft name:RENAMED!"), "re.bbl");
    const noApiHeaders = HEADERS.filter((x) => !x.startsWith("Firmware API version"));
    noApi = await flightsOf(
        concatLogs(log(41, { headers: noApiHeaders }), log(31, { headers: noApiHeaders })),
        "noapi.bbl",
    );
}, 120_000);

describe("the SYNTHETIC fixtures", () => {
    it("are qualified CHIRPs of every axis, with roll measured twice, on one shared grid", () => {
        for (const f of [flightA, flightB]) {
            expect(f.chirps.map((c) => `${c.axisName}-${c.axisOccurrence}`)).toEqual([
                "roll-1",
                "pitch-1",
                "yaw-1",
                "roll-2",
            ]);
            expect(f.chirps.every((c) => c.qualification.state === "usable")).toBe(true);
            expect(f.firmware.unknown).toEqual([]);
        }
        expect(flightA.chirps[0].qualityV2.coherence.bins.frequencyHz).toEqual(
            flightB.chirps[0].qualityV2.coherence.bins.frequencyHz,
        );
    });
});

describe("1. two valid, independent Flights", () => {
    it("are compared per CHIRP pair, diagnostic only", () => {
        const r = compare(inMemory([flightA, flightB]));
        expect(r.abStatus).toBe("ELIGIBLE");
        expect(r.status).toBe("COMPARED");
        expect(r.blockers).toEqual([]);
        expect(r.axes.map((x) => [x.axisName, x.chirpsA, x.chirpsB])).toEqual([
            ["roll", 2, 2],
            ["pitch", 1, 1],
            ["yaw", 1, 1],
        ]);
        expect(r.axes.flatMap((x) => x.pairs.map((p) => [p.id, p.status]))).toEqual([
            ["roll-1", "COMPARED"],
            ["roll-2", "COMPARED"],
            ["pitch-1", "COMPARED"],
            ["yaw-1", "COMPARED"],
        ]);
        expect(r.config?.items.filter((i) => i.status === "MISMATCH")).toEqual([]);
        expect(r.diagnostics?.compared).toEqual(["roll-1", "roll-2", "pitch-1", "yaw-1"]);
    });

    it("the per-bin differences equal B − A of the stored bins, computed here independently", () => {
        const r = compare(inMemory([flightA, flightB]));
        for (const id of ["roll-1", "roll-2", "pitch-1", "yaw-1"]) {
            const [axis, occ] = id.split("-");
            const A = chirp(flightA, axis, Number(occ)).qualityV2.coherence.bins;
            const B = chirp(flightB, axis, Number(occ)).qualityV2.coherence.bins;
            const p = pairOf(r, id);
            expect(p.bins!.frequencyHz).toEqual(A.frequencyHz);
            let magBins = 0;
            for (let i = 0; i < A.frequencyHz.length; i++) {
                const both = A.status[i] === "USABLE" && B.status[i] === "USABLE";
                const expected = both ? (B.magnitudeDb[i] as number) - (A.magnitudeDb[i] as number) : null;
                expect(p.bins!.magnitudeDeltaDb[i]).toBe(expected);
                magBins += both ? 1 : 0;
                const inA = A.status[i] === "USABLE" || A.status[i] === "WEAK_COHERENCE";
                const inB = B.status[i] === "USABLE" || B.status[i] === "WEAK_COHERENCE";
                expect(p.bins!.coherenceDelta[i]).toBe(inA && inB ? B.coherence[i] - A.coherence[i] : null);
            }
            expect(p.magnitudeDelta!.binCount).toBe(magBins);
            expect(magBins).toBeGreaterThan(8);
        }
    });

    it("shows both measurements' quality side by side, from the stored reports", () => {
        const p = pairOf(compare(inMemory([flightA, flightB])), "pitch-1");
        const row = (id: string) => p.quality.find((q) => q.id === id)!;
        const a = chirp(flightA, "pitch", 1).qualityV2;
        const b = chirp(flightB, "pitch", 1).qualityV2;
        expect(row("qualification")).toMatchObject({ a: { value: "usable" }, b: { value: "usable" } });
        expect(row("analysisVersion").a?.value).toBe(a.analysisVersion);
        expect(row("meanBandCoherence").a?.value).toBe(a.coherence.meanBandCoherence.value);
        expect(row("meanBandCoherence").b?.value).toBe(b.coherence.meanBandCoherence.value);
        expect(row("meanBandCoherence").b?.verdict).toBe(b.verdicts.coherence.verdict);
        expect(row("usableBins").b?.value).toBe(b.coherence.usableBinCount.value);
        expect(row("usableStartHz").a?.value).toBe(a.sweep.usable.startHz);
        expect(row("usableEndHz").b?.value).toBe(b.sweep.usable.endHz);
        expect(row("sampleGaps").a?.value).toBe("NONE");
        expect(row("setpointRms").a?.value).toBe(a.excitation.setpointRms.value);
        // Saturation is UNKNOWN in these logs (no motor fields): shown as such, never as a pass.
        expect(row("saturation").a).toMatchObject({ value: "UNKNOWN", verdict: "NOT_EVALUATED" });
        expect(row("contamination").b).toMatchObject({ value: "UNKNOWN", availability: "UNKNOWN" });
    });
});

describe("2. and 3. known differences", () => {
    it("identical measurements give exactly zero, and only on valid bins", () => {
        const s = inMemory([flightA, flightB]);
        for (const [axis, occ] of [
            ["roll", 1],
            ["roll", 2],
            ["pitch", 1],
            ["yaw", 1],
        ] as const) {
            copyBins(s, axis, occ);
        }
        const r = compare(s);
        for (const p of r.axes.flatMap((x) => x.pairs)) {
            expect(p.status).toBe("COMPARED");
            const st = p.bins!.statusA;
            p.bins!.magnitudeDeltaDb.forEach((d, i) => expect(d).toBe(st[i] === "USABLE" ? 0 : null));
            p.bins!.coherenceDelta.forEach((d, i) =>
                expect(d).toBe(st[i] === "USABLE" || st[i] === "WEAK_COHERENCE" ? 0 : null),
            );
            expect(p.magnitudeDelta).toMatchObject({ min: 0, max: 0, meanAbs: 0 });
        }
    });

    it("+3 dB and −0.05 coherence on known bins come back as exactly those differences", () => {
        const s = inMemory([flightA, flightB]);
        const changedCoh = new Set<number>();
        copyBins(s, "yaw", 1, (bins) => {
            bins.status.forEach((st, i) => {
                if (st === "USABLE") {
                    bins.magnitudeDb[i] = (bins.magnitudeDb[i] as number) + 3;
                    if (bins.coherence[i] >= 0.6) {
                        bins.coherence[i] -= 0.05;
                        changedCoh.add(i);
                    }
                }
            });
        });
        const p = pairOf(compare(s), "yaw-1");
        const st = chirp(flightA, "yaw", 1).qualityV2.coherence.bins.status;
        expect(changedCoh.size).toBeGreaterThan(8);
        p.bins!.magnitudeDeltaDb.forEach((d, i) => {
            if (st[i] === "USABLE") {
                expect(d).toBeCloseTo(3, 12);
            } else {
                expect(d).toBeNull();
            }
        });
        p.bins!.coherenceDelta.forEach((d, i) => {
            if (changedCoh.has(i)) {
                expect(d).toBeCloseTo(-0.05, 12);
            } else if (st[i] === "USABLE" || st[i] === "WEAK_COHERENCE") {
                expect(d).toBe(0);
            } else {
                expect(d).toBeNull();
            }
        });
        expect(p.magnitudeDelta!.min).toBeCloseTo(3, 12);
        expect(p.magnitudeDelta!.max).toBeCloseTo(3, 12);
        expect(p.coherenceDelta!.min).toBeCloseTo(-0.05, 12);
        expect(p.coherenceDelta!.max).toBe(0);
    });
});

describe("4. and 5. axes and several CHIRPs per axis", () => {
    it("pairs by axis and occurrence: roll never meets pitch or yaw, and the stored order does not matter", () => {
        const s = inMemory([flightA, flightB]);
        const offsets = { "roll-1": 1, "roll-2": 4, "pitch-1": 5, "yaw-1": 2 } as Record<string, number>;
        for (const [id, off] of Object.entries(offsets)) {
            const [axis, occ] = id.split("-");
            copyBins(s, axis, Number(occ), (bins) =>
                bins.status.forEach((st, i) => {
                    if (st === "USABLE") {
                        bins.magnitudeDb[i] = (bins.magnitudeDb[i] as number) + off;
                    }
                }),
            );
        }
        s.flights[1].chirps.reverse();
        const r = compare(s);
        for (const [id, off] of Object.entries(offsets)) {
            const p = pairOf(r, id);
            expect(p.a!.measurementId).toBe(chirp(flightA, id.split("-")[0], Number(id.split("-")[1])).measurementId);
            expect(p.magnitudeDelta!.min).toBeCloseTo(off, 12);
            expect(p.magnitudeDelta!.max).toBeCloseTo(off, 12);
        }
    });

    it("two roll CHIRPs stay two pairs: nothing is averaged or picked", () => {
        const s = inMemory([flightA, flightB]);
        copyBins(s, "roll", 2, (bins) =>
            bins.status.forEach((st, i) => {
                if (st === "USABLE") {
                    bins.magnitudeDb[i] = (bins.magnitudeDb[i] as number) + 4;
                }
            }),
        );
        const roll = compare(s).axes.find((x) => x.axisName === "roll")!;
        expect(roll.pairs.map((p) => [p.id, p.a!.measurementId, p.b!.measurementId])).toEqual([
            ["roll-1", "log1-seg1", "log1-seg1"],
            ["roll-2", "log1-seg4", "log1-seg4"],
        ]);
        // roll-1 is B − A of the first roll CHIRPs as analysed; roll-2 only carries its own edit.
        const A1 = chirp(flightA, "roll", 1).qualityV2.coherence.bins;
        const B1 = chirp(flightB, "roll", 1).qualityV2.coherence.bins;
        expect(roll.pairs[0].bins!.magnitudeDbB).toEqual(B1.magnitudeDb);
        const firstUsable = A1.status.findIndex((x, i) => x === "USABLE" && B1.status[i] === "USABLE");
        expect(roll.pairs[0].bins!.magnitudeDeltaDb[firstUsable]).toBe(
            (B1.magnitudeDb[firstUsable] as number) - (A1.magnitudeDb[firstUsable] as number),
        );
        expect(roll.pairs[1].magnitudeDelta!.min).toBeCloseTo(4, 12);
        expect(roll.pairs[1].magnitudeDelta!.max).toBeCloseTo(4, 12);
    });

    it("an occurrence in one Flight only is shown unpaired, never compared", () => {
        const s = inMemory([flightA, flightB]);
        s.flights[1].chirps = s.flights[1].chirps.filter((c) => !(c.axisName === "roll" && c.axisOccurrence === 2));
        const p = pairOf(compare(s), "roll-2");
        expect(p).toMatchObject({ status: "UNPAIRED", reasons: ["chirp_only_in_flight_a"], b: null, bins: null });
        expect(p.quality.find((q) => q.id === "qualification")).toMatchObject({ a: { value: "usable" }, b: null });
    });

    it("an axis measured by one Flight only is named as missing evidence", () => {
        const s = inMemory([flightA, flightB]);
        s.flights[1].chirps = s.flights[1].chirps.filter((c) => c.axisName !== "yaw");
        const r = compare(s);
        expect(r.diagnostics!.axesMissing).toEqual([{ axisName: "yaw", reason: "axis_measured_in_one_flight_only:a" }]);
        expect(pairOf(r, "yaw-1").status).toBe("UNPAIRED");
    });
});

describe("8. sample rate, segments and analysis version", () => {
    it("a different sample rate and bin width is refused, as is any provenance difference", () => {
        const s = inMemory([flightA, flightB]);
        const q = chirp(s.flights[1], "pitch", 1).qualityV2;
        q.provenance.sampleRateHz = 2000;
        q.provenance.binWidthHz = 3.90625;
        q.coherence.bins.binWidthHz = 3.90625;
        q.coherence.bins.frequencyHz = q.coherence.bins.frequencyHz.map((f) => f * 2);
        const p = pairOf(compare(s), "pitch-1");
        expect(p.status).toBe("NOT_COMPARABLE");
        expect(p.reasons).toEqual(
            expect.arrayContaining(["provenance_differs:sampleRateHz", "provenance_differs:binWidthHz"]),
        );
        expect(p.bins).toBeNull();
        expect(pairOf(compare(s), "roll-1").status).toBe("COMPARED");
    });

    it("a different Welch segment size is refused", () => {
        const s = inMemory([flightA, flightB]);
        const q = chirp(s.flights[1], "roll", 1).qualityV2;
        q.provenance.segmentSize = 1024;
        q.coherence.bins.powerScale.segmentSize = 1024;
        expect(pairOf(compare(s), "roll-1").reasons).toContain("provenance_differs:segmentSize");
    });

    it("a different input or output field is refused", () => {
        const s = inMemory([flightA, flightB]);
        chirp(s.flights[1], "yaw", 1).qualityV2.provenance.outputField = "gyroUnfilt[2]";
        expect(pairOf(compare(s), "yaw-1").reasons).toContain("provenance_differs:outputField");
    });

    it("a different Welch segment count keeps the grid and is a note, not a block", () => {
        const s = inMemory([flightA, flightB]);
        chirp(s.flights[1], "roll", 2).qualityV2.provenance.welchSegments = 30;
        const p = pairOf(compare(s), "roll-2");
        expect(p.status).toBe("COMPARED");
        expect(p.notes).toContain("welch_segment_count_differs:22:30");
    });

    it("a Flight analysed with another Quality V2 version is blocked by WU4", () => {
        const s = inMemory([flightA, flightB]);
        for (const c of s.flights[1].chirps) {
            (c.qualityV2 as { analysisVersion: string }).analysisVersion = "2.0.0";
        }
        const r = compare(s);
        expect(r.status).toBe("BLOCKED");
        expect(r.blockers).toEqual(expect.arrayContaining(["ab_pair_blocked", "analysis_version_differs"]));
        expect(r.axes).toEqual([]);
    });
});

describe("9. qualification", () => {
    it("a rejected CHIRP is shown, but never compared", () => {
        const s = inMemory([flightA, flightB]);
        const c = chirp(s.flights[1], "roll", 1);
        c.qualification = { state: "rejected", failedGates: ["low_coherence"], warningGates: [] };
        c.qualityV2.levels.chirpQualified = { status: "NO", role: "ACTIVE_GATE", reasons: ["chirp_not_qualified"] };
        c.qualityV2.verdicts.coherence = { ...c.qualityV2.verdicts.coherence, verdict: "FAIL" };
        const r = compare(s);
        const p = pairOf(r, "roll-1");
        expect(p.status).toBe("NOT_COMPARABLE");
        expect(p.reasons).toEqual(
            expect.arrayContaining([
                "chirp_not_qualified:b",
                "chirp_not_qualified:b:quality_v2_level",
                "chirp_not_qualified:b:verdict_fail:coherence",
            ]),
        );
        expect(p.quality.find((q) => q.id === "qualification")!.b?.value).toBe("rejected");
        expect(pairOf(r, "roll-2").status).toBe("COMPARED");
    });

    it("a FAIL verdict under a usable state is contradicting metadata and is not compared", () => {
        const s = inMemory([flightA, flightB]);
        const c = chirp(s.flights[0], "pitch", 1);
        c.qualityV2.verdicts.usableBins = { ...c.qualityV2.verdicts.usableBins, verdict: "FAIL" };
        expect(pairOf(compare(s), "pitch-1").reasons).toEqual(["chirp_not_qualified:a:verdict_fail:usableBins"]);
    });

    it("when no pair can be compared the result says so, with every reason", () => {
        const s = inMemory([flightA, flightB]);
        for (const c of s.flights[0].chirps) {
            c.qualification.state = "rejected";
        }
        const r = compare(s);
        expect(r.status).toBe("NOT_COMPARABLE");
        expect(r.diagnostics!.compared).toEqual([]);
        expect(r.diagnostics!.notComparable.map((n) => n.id)).toEqual(["roll-1", "roll-2", "pitch-1", "yaw-1"]);
    });
});

describe("10. to 12. the WU4 gate is re-applied", () => {
    it("INCOMPLETE without a session or without both Flights; nothing is compared", () => {
        const s = inMemory([flightA, flightB]);
        expect(compareFlights(null, pick(s, flightA.key, flightB.key))).toMatchObject({
            status: "INCOMPLETE",
            blockers: ["session_not_loaded", "ab_selection_incomplete"],
            axes: [],
            config: null,
        });
        expect(compareFlights(ok(s), pick(s, flightA.key, null))).toMatchObject({
            status: "INCOMPLETE",
            blockers: ["ab_selection_incomplete"],
            axes: [],
        });
        // A selection made for another session is not this session's.
        expect(compareFlights(ok(s), { ...pick(s, flightA.key, flightB.key), sessionId: "other" }).status).toBe(
            "INCOMPLETE",
        );
        expect(compareFlights({ status: "corrupt", id: "x", problems: ["schema"] }, pick(s, "a", "b")).status).toBe(
            "INCOMPLETE",
        );
    });

    it("10. the same Flight twice is blocked", () => {
        const s = inMemory([flightA, flightB]);
        const r = compare(s, flightA.key, flightA.key);
        expect(r.status).toBe("BLOCKED");
        expect(r.blockers).toEqual(
            expect.arrayContaining(["ab_pair_blocked", "ab_same_flight_selected", "same_flight_section"]),
        );
        expect(r.axes).toEqual([]);
        expect(r.config).toBeNull();
    });

    it("11. a copy of a Flight in another file is rejected by WU1", () => {
        const s = inMemory([flightA, copied]);
        const r = compare(s);
        expect(r.status).toBe("BLOCKED");
        expect(r.ab.independence).toBe("NOT_INDEPENDENT");
        expect(r.axes).toEqual([]);
    });

    it("11. a repackaged copy (same frames, edited header) is rejected by WU1", () => {
        const r = compare(inMemory([flightA, repackaged]));
        expect(r.status).toBe("BLOCKED");
        expect(r.ab.independence).toBe("NOT_INDEPENDENT");
        expect(r.blockers).toContain("same_flight_content");
        expect(r.axes).toEqual([]);
    });

    it("12. a firmware field that was not logged stays UNKNOWN and blocks", () => {
        const r = compare(inMemory(noApi));
        expect(r.status).toBe("BLOCKED");
        expect(r.ab.firmware).toBe("UNKNOWN");
        expect(r.missingEvidence).toContain("firmware_unknown:apiVersion");
    });
});

describe("12. configuration comparison", () => {
    it("lists logged settings as MATCH, with known settings not logged by either Flight as UNKNOWN", () => {
        const c = compare(inMemory([flightA, flightB])).config!;
        const get = (k: string) => c.items.find((i) => i.key === k)!;
        expect(get("rollPID")).toMatchObject({ category: "TUNING", a: "45,80,30", b: "45,80,30", status: "MATCH" });
        expect(get("looptime")).toMatchObject({ category: "MEASUREMENT", status: "MATCH" });
        expect(get("chirp_amplitude_yaw")).toMatchObject({ axis: "yaw", status: "MATCH" });
        // Not logged by these SYNTHETIC logs: UNKNOWN, no default filled in, and not blocking.
        expect(get("gyro_lpf1_static_hz")).toMatchObject({
            a: null,
            b: null,
            status: "UNKNOWN",
            reasons: ["config_not_logged_in_either_flight:gyro_lpf1_static_hz"],
            blocksDifference: false,
        });
        expect(c.status).toBe("UNKNOWN");
        // Firmware identity, the recording time and frame definitions are not configuration.
        expect(c.items.map((i) => i.key)).not.toEqual(expect.arrayContaining(["Log start datetime"]));
        expect(c.items.some((i) => i.key.startsWith("Field ") || i.key === "Firmware revision")).toBe(false);
    });

    it("a tune change between A and B is named, and closes every numeric difference", () => {
        const s = inMemory([flightA, flightB]);
        s.flights[1].logHeaders = s.flights[1].logHeaders!.map(([k, v]) => [k, k === "rollPID" ? "50,80,30" : v]);
        const r = compare(s);
        expect(r.abStatus).toBe("ELIGIBLE");
        expect(r.status).toBe("NOT_COMPARABLE");
        expect(r.config!.status).toBe("MISMATCH");
        expect(r.config!.items.find((i) => i.key === "rollPID")).toMatchObject({
            status: "MISMATCH",
            a: "45,80,30",
            b: "50,80,30",
            blocksDifference: true,
        });
        for (const p of r.axes.flatMap((x) => x.pairs)) {
            expect(p.status).toBe("NOT_COMPARABLE");
            expect(p.reasons).toEqual(["config_mismatch:rollPID"]);
            // The separate measurements stay visible.
            expect(p.quality.find((q) => q.id === "meanBandCoherence")!.b?.value).toBeTypeOf("number");
        }
    });

    it("a CHIRP amplitude difference only closes that axis", () => {
        const s = inMemory([flightA, flightB]);
        s.flights[1].logHeaders = s.flights[1].logHeaders!.map(([k, v]) => [
            k,
            k === "chirp_amplitude_yaw" ? "150" : v,
        ]);
        const r = compare(s);
        expect(pairOf(r, "yaw-1").reasons).toEqual(["config_mismatch:chirp_amplitude_yaw"]);
        expect(pairOf(r, "roll-1").status).toBe("COMPARED");
        expect(pairOf(r, "pitch-1").status).toBe("COMPARED");
    });

    it("a required setting not logged by either Flight closes the difference", () => {
        const s = inMemory([flightA, flightB]);
        for (const f of s.flights) {
            f.logHeaders = f.logHeaders!.filter(([k]) => k !== "chirp_time_seconds");
        }
        const r = compare(s);
        expect(r.config!.items.find((i) => i.key === "chirp_time_seconds")).toMatchObject({
            status: "UNKNOWN",
            blocksDifference: true,
        });
        expect(pairOf(r, "roll-1").reasons).toEqual(["config_unknown:chirp_time_seconds"]);
    });

    it("a setting logged by one Flight only is UNKNOWN, never MATCH, and closes the difference", () => {
        const s = inMemory([flightA, flightB]);
        s.flights[1].logHeaders!.push(["tpa_rate", "65"]);
        const r = compare(s);
        expect(r.config!.items.find((i) => i.key === "tpa_rate")).toMatchObject({
            category: "OTHER",
            a: null,
            b: "65",
            status: "UNKNOWN",
            blocksDifference: true,
        });
        expect(pairOf(r, "pitch-1").reasons).toEqual(["config_unknown:tpa_rate"]);
    });

    it("the battery voltage at power-up (vbatref) differs by pack, not by setting, and is not compared", () => {
        const s = inMemory([flightA, flightB]);
        s.flights[0].logHeaders!.push(["vbatref", "1680"]);
        s.flights[1].logHeaders!.push(["vbatref", "1652"]);
        const r = compare(s);
        expect(r.config!.items.some((i) => i.key === "vbatref")).toBe(false);
        expect(r.status).toBe("COMPARED");
    });
});

describe("13. damaged sessions over IndexedDB are not repaired", () => {
    it("a CHIRP rejected on load is reported, its pair is unpaired, and the record is left as it was", async () => {
        const factory = new IDBFactory();
        const st = store(factory);
        const created = await st.create("damaged", [flightA, flightB]);
        // Damage one stored CHIRP of B directly in IndexedDB.
        const raw = json(created);
        (raw.flights[1].chirps[3] as unknown as { axis: number }).axis = 7;
        await new Promise<void>((resolve, reject) => {
            const req = factory.open(TUNE_SESSION_DB_NAME);
            req.onsuccess = () => {
                const tx = req.result.transaction(TUNE_SESSION_STORE, "readwrite");
                tx.objectStore(TUNE_SESSION_STORE).put(raw);
                tx.oncomplete = () => (req.result.close(), resolve());
                tx.onerror = () => reject(tx.error);
            };
        });
        const loaded = await st.load(created.id);
        expect(loaded.status).toBe("ok");
        if (loaded.status !== "ok") {
            return;
        }
        expect(loaded.rejected.map((x) => x.path)).toEqual(["flights[1].chirps[3]"]);
        const r = compareFlights(loaded, pick(loaded.session, flightA.key, flightB.key));
        expect(r.status).toBe("COMPARED");
        expect(r.blockers).toEqual(["flight_chirps_rejected:b:1"]);
        expect(r.missingEvidence).toContain("flight_chirps_rejected:b:1");
        expect(pairOf(r, "roll-2")).toMatchObject({ status: "UNPAIRED", reasons: ["chirp_only_in_flight_a"] });
        const again = await st.load(created.id);
        expect(again).toEqual(loaded);
        st.close();
    });
});

describe("14. switching sessions and choices quickly", () => {
    it("a slow load of another session never shows the previous comparison", async () => {
        const st = store();
        const one = await st.create("one", [flightA, flightB]);
        const two = await st.create("two", [flightA, flightC]);
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const slow: TuneSessionStore = {
            ...st,
            load: async (id: string) => {
                if (id === two.id) {
                    await gate;
                }
                return st.load(id);
            },
        };
        const sel = useFlightAbSelector({ store: slow });
        await sel.openSession(one.id);
        sel.select("a", flightA.key);
        sel.select("b", flightB.key);
        expect(compareFlights(sel.loaded.value, sel.selection.value)).toMatchObject({
            status: "COMPARED",
            sessionId: one.id,
        });
        const opening = sel.openSession(two.id);
        const during = compareFlights(sel.loaded.value, sel.selection.value);
        expect(during).toMatchObject({ status: "INCOMPLETE", axes: [], config: null, keyA: null, keyB: null });
        release();
        await opening;
        const after = compareFlights(sel.loaded.value, sel.selection.value);
        expect(after).toMatchObject({ status: "INCOMPLETE", sessionId: two.id, keyA: null, keyB: null });
        sel.select("a", flightA.key);
        sel.select("b", flightC.key);
        const fresh = compareFlights(sel.loaded.value, sel.selection.value);
        expect(fresh).toMatchObject({ status: "COMPARED", sessionId: two.id, keyB: flightC.key });
        st.close();
    });

    it("a Flight removed elsewhere is cleared on reload, and its comparison with it", async () => {
        const st = store();
        const one = await st.create("one", [flightA, flightB]);
        const sel = useFlightAbSelector({ store: st });
        await sel.openSession(one.id);
        sel.select("a", flightA.key);
        sel.select("b", flightB.key);
        const loaded = await st.load(one.id);
        if (loaded.status !== "ok") {
            throw new Error("load");
        }
        await st.save({ ...loaded.session, flights: [loaded.session.flights[0]] });
        await sel.reloadSession();
        expect(sel.selection.value.b).toBeNull();
        expect(compareFlights(sel.loaded.value, sel.selection.value).status).toBe("INCOMPLETE");
        st.close();
    });
});

describe("15. and 16. authorization, storage and Apply are untouched", () => {
    it("never changes its input, the stored authorization stays NOT_STORED, and nothing is authorized", () => {
        const s = deepFreeze(inMemory([flightA, flightB]));
        const r = compare(s);
        expect(r.status).toBe("COMPARED");
        expect(s.authorization).toEqual(SESSION_AUTHORIZATION);
        expect(s.authorization.status).toBe("NOT_STORED");
        expect(s.schemaVersion).toBe(TUNE_SESSION_SCHEMA_VERSION);
        expect(TUNE_SESSION_SCHEMA_VERSION).toBe(1);
        for (const c of s.flights.flatMap((f) => f.chirps)) {
            expect(c.qualityV2.levels.tuningAuthorized.status).toBe("UNKNOWN");
        }
        expect(r.authorization).toEqual({
            status: "NOT_AUTHORIZED",
            reasons: ["cross_flight_comparison_is_not_a_verified_tune", PRODUCT_APPLY_PENDING],
        });
        expect(r.repeatability.status).toBe("NOT_ESTABLISHED");
        expect(JSON.stringify(r)).not.toMatch(/"AUTHORIZED"|"VERIFIED"|"GRANTED"|"ELIGIBLE_FOR_APPLY"/);
        // A caller editing one result cannot widen the next.
        (r.authorization.reasons as unknown as string[]).length = 0;
        expect(compare(s).authorization.reasons).toHaveLength(2);
    });

    it("the product Apply lock still blocks", () => {
        compare(inMemory([flightA, flightB]));
        expect(productApplyBlocks()).toEqual([PRODUCT_APPLY_PENDING, "independent_pid_validation_missing"]);
    });

    it("the comparison imports no MSP, Apply, tuning, Safety or storage-write code", () => {
        const read = (p: string) => readFileSync(join(__dirname, "../..", p), "utf8");
        for (const f of [
            "src/gyrocore/compare/compare.ts",
            "src/gyrocore/compare/config.ts",
            "src/gyrocore/compare/contract.ts",
            "src/gyrocore/compare/view.ts",
            "src/gyrocore/components/CrossFlightComparison.vue",
            "src/gyrocore/components/CrossFlightChart.vue",
        ]) {
            const imports = [...read(f).matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
            for (const i of imports) {
                expect(i, `${f} imports ${i}`).not.toMatch(
                    /msp|MSP|applyGate|useApplyGate|tuning\/|safety\/|serial|recommendationGuard|stores\/|storage|useAutotune/,
                );
            }
        }
        for (const f of [
            "src/gyrocore/tuning/authorize.ts",
            "src/gyrocore/safety/authorize.ts",
            "src/gyrocore/productLock/productApply.ts",
            "src/gyrocore/composables/useApplyGate.ts",
            "src/gyrocore/chirp/applyGate.ts",
            "src/components/tabs/autotune/GainRecommendation.vue",
        ]) {
            expect(read(f)).not.toMatch(/gyrocore\/compare|CrossFlightComparison/);
        }
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
    const cfc = (c: HTMLElement) => q(c, '[data-gyrocore="cross-flight-comparison"]');

    it("sits under the A/B Verification Status, only in Expert Mode", async () => {
        const st = store();
        const one = await st.create("one", [flightA, flightB]);
        const { container, unmount } = await mount(st);
        await choose(container, '[data-gyrocore="ab-session-select"]', one.id);
        const status = q(container, '[data-gyrocore="ab-status"]')!;
        expect(cfc(container)).not.toBeNull();
        expect(status.compareDocumentPosition(cfc(container)!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(q(container, '[data-gyrocore="cfc-not-verified-tune"]')?.textContent).toContain(PRODUCT_APPLY_PENDING);
        expect(cfc(container)?.dataset.status).toBe("INCOMPLETE");
        expect(q(container, '[data-gyrocore="cfc-incomplete"]')).not.toBeNull();
        EventBus.$emit("expert-mode-change", false);
        await flush();
        expect(cfc(container)).toBeNull();
        unmount();
    });

    it("shows labelled A/B charts, the differences, quality, configuration and diagnostics", async () => {
        const st = store();
        const one = await st.create("one", [flightA, flightB]);
        const { container, unmount } = await mount(st);
        await choose(container, '[data-gyrocore="ab-session-select"]', one.id);
        await choose(container, '[data-gyrocore="ab-select-a"]', flightA.key);
        await choose(container, '[data-gyrocore="ab-select-b"]', flightB.key);
        const root = cfc(container)!;
        expect(root.dataset.status).toBe("COMPARED");
        expect(q(root, '[data-gyrocore="cfc-flight-a"]')?.textContent).toContain("a.bbl");
        expect(q(root, '[data-gyrocore="cfc-flight-b"]')?.textContent).toContain("b.bbl");
        const pairs = root.querySelectorAll('[data-gyrocore="cfc-pair"]');
        expect([...pairs].map((p) => (p as HTMLElement).dataset.pair)).toEqual([
            "roll-1",
            "roll-2",
            "pitch-1",
            "yaw-1",
        ]);
        const roll = q(root, '[data-pair="roll-1"]')!;
        for (const chart of ["magnitude", "magnitude-delta", "coherence", "coherence-delta"]) {
            const fig = q(roll, `[data-gyrocore="cfc-chart-roll-1-${chart}"]`)!;
            expect(fig, chart).not.toBeNull();
            expect(Number(fig.dataset.points)).toBeGreaterThan(8);
            expect(q(fig, '[data-gyrocore="cfc-chart-legend"]')).not.toBeNull();
        }
        expect(q(roll, '[data-gyrocore="cfc-chart-roll-1-magnitude"] [data-series="a"]')).not.toBeNull();
        expect(q(roll, '[data-gyrocore="cfc-chart-roll-1-magnitude"] [data-series="b"]')).not.toBeNull();
        expect(q(roll, '[data-gyrocore="cfc-magnitude-summary"]')?.textContent).toContain("gyrocoreCfcSummary|");
        expect(q(roll, '[data-row="meanBandCoherence"] [data-side="a"]')?.textContent).toMatch(
            /^\d\.\d\d\s*\(gyrocoreQv2Verdict_PASS\)$/,
        );
        expect(q(root, '[data-gyrocore="cfc-config"]')?.dataset.status).toBe("UNKNOWN");
        expect(q(root, '[data-gyrocore="cfc-config"] [data-key="gyro_lpf1_static_hz"]')?.dataset.status).toBe(
            "UNKNOWN",
        );
        expect(q(root, '[data-diag="repeatability"]')?.dataset.status).toBe("NOT_ESTABLISHED");
        expect(q(root, '[data-diag="missing"] [data-reason="more_independent_repeats_needed"]')).not.toBeNull();
        unmount();
    });

    it("shows the blocking reasons and no measurement for a blocked pair", async () => {
        const st = store();
        const one = await st.create("one", [flightA, copied]);
        const { container, unmount } = await mount(st);
        await choose(container, '[data-gyrocore="ab-session-select"]', one.id);
        await choose(container, '[data-gyrocore="ab-select-a"]', flightA.key);
        await choose(container, '[data-gyrocore="ab-select-b"]', copied.key);
        const root = cfc(container)!;
        expect(root.dataset.status).toBe("BLOCKED");
        expect(q(root, '[data-gyrocore="cfc-blocked"] [data-reason="same_flight_section"]')).not.toBeNull();
        expect(root.querySelectorAll('[data-gyrocore="cfc-pair"], svg, [data-gyrocore="cfc-config"]')).toHaveLength(0);
        unmount();
    });

    it("names a logged tune difference as a possible explanation, without differences", async () => {
        const st = store();
        const tuned = json(flightB);
        tuned.logHeaders = tuned.logHeaders!.map(([k, v]) => [k, k === "rollPID" ? "50,80,30" : v]);
        const one = await st.create("one", [flightA, tuned]);
        const { container, unmount } = await mount(st);
        await choose(container, '[data-gyrocore="ab-session-select"]', one.id);
        await choose(container, '[data-gyrocore="ab-select-a"]', flightA.key);
        await choose(container, '[data-gyrocore="ab-select-b"]', tuned.key);
        const root = cfc(container)!;
        expect(root.dataset.status).toBe("NOT_COMPARABLE");
        expect(q(root, '[data-key="rollPID"]')?.dataset.status).toBe("MISMATCH");
        expect(q(root, '[data-gyrocore="cfc-config-confounder"]')?.textContent).toContain("rollPID");
        expect(root.querySelectorAll("svg path[data-series]")).toHaveLength(0);
        expect(q(root, '[data-pair="roll-1"] [data-reason="config_mismatch:rollPID"]')).not.toBeNull();
        unmount();
    });

    it("never shows a comparison of an earlier choice after switching B, the session, or closing it", async () => {
        const st = store();
        const one = await st.create("one", [flightA, flightB, flightC]);
        const two = await st.create("two", [flightB, flightC]);
        const { container, unmount } = await mount(st);
        await choose(container, '[data-gyrocore="ab-session-select"]', one.id);
        await choose(container, '[data-gyrocore="ab-select-a"]', flightA.key);
        await choose(container, '[data-gyrocore="ab-select-b"]', flightB.key);
        expect(cfc(container)?.dataset.b).toBe(flightB.key);
        const before = q(container, '[data-pair="roll-1"] [data-gyrocore="cfc-magnitude-summary"]')!.textContent;

        await choose(container, '[data-gyrocore="ab-select-b"]', flightC.key);
        expect(cfc(container)?.dataset.b).toBe(flightC.key);
        expect(q(container, '[data-pair="roll-1"] [data-gyrocore="cfc-magnitude-summary"]')!.textContent).not.toBe(
            before,
        );

        await choose(container, '[data-gyrocore="ab-session-select"]', two.id);
        expect(cfc(container)).toMatchObject({ dataset: { status: "INCOMPLETE", session: two.id, a: "", b: "" } });
        expect(container.querySelectorAll('[data-gyrocore="cfc-pair"]')).toHaveLength(0);

        await choose(container, '[data-gyrocore="ab-session-select"]', "");
        expect(cfc(container)).toBeNull();
        unmount();
    });
});
