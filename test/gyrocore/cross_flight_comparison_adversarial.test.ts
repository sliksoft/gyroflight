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
 * WU5 Cross-flight Comparison, adversarial suite. SYNTHETIC logs only.
 * Written against docs/gyrocore/CROSS_FLIGHT_COMPARISON.md and compare/contract.ts
 * without reading the engine (compare.ts, config.ts, view.ts). Every expected
 * value is computed here from the stored arrays and the edits made to them.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { attachChirpFlightIdentity } from "../../src/gyrocore/chirp/qualityV2/identity";
import { compareFlights } from "../../src/gyrocore/compare/compare";
import { compareConfig, configBlockers } from "../../src/gyrocore/compare/config";
import type { ChirpPairComparison, CrossFlightComparison } from "../../src/gyrocore/compare/contract";
import { lineChart } from "../../src/gyrocore/compare/view";
import { addFlights, flightsFromReport, newTuneSession } from "../../src/gyrocore/session/build";
import type { LoadResult, StoredChirp, StoredFlight, TuneSession } from "../../src/gyrocore/session/contract";
import type { AbSelection } from "../../src/gyrocore/session/selection";
import { encodeChirpLog, FULL_TUNE_HEADERS, simulateChirpSequence, type SimOptions } from "./harness/chirpSim";

const T0 = "2026-10-13T12:00:00.000Z";
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** SYNTHETIC headers: firmware fields and the three CHIRP amplitudes logged. */
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

function log(crossoverHz: number, start: string) {
    const sweeps: SimOptions[] = ([0, 1, 2, 0] as const).map((axis) => ({
        seconds: 6,
        firmwareDebug: true,
        axis,
        crossoverHz,
    }));
    return encodeChirpLog(simulateChirpSequence(sweeps), [...HEADERS, `Log start datetime:${start}`]);
}

async function flightOf(bytes: Uint8Array, fileName: string): Promise<StoredFlight> {
    const r = qualifyChirpFile(bytes, fileName, 60, AUTOTUNE_MATH);
    await attachChirpFlightIdentity(r, bytes);
    return flightsFromReport(r, { fileName, analyzedAt: T0 }).flights[0];
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

let flightA: StoredFlight;
let flightB: StoredFlight;

beforeAll(async () => {
    flightA = await flightOf(log(40, "2026-10-13T10:00:00.000+00:00"), "a.bbl");
    flightB = await flightOf(log(30, "2026-10-13T10:10:00.000+00:00"), "b.bbl");
}, 120_000);

type Bins = StoredChirp["qualityV2"]["coherence"]["bins"];

interface Fixture {
    s: TuneSession;
    A: StoredFlight;
    B: StoredFlight;
}

/** A fresh deep copy of the eligible pair, in one in-memory session. */
function fixture(): Fixture {
    const s = json(addFlights(newTuneSession({ id: "adv", name: "adv", now: T0 }), [flightA, flightB], T0).session);
    const A = s.flights.find((f) => f.key === flightA.key)!;
    const B = s.flights.find((f) => f.key === flightB.key)!;
    return { s, A, B };
}

function run(
    edit?: (A: StoredFlight, B: StoredFlight, s: TuneSession) => void,
): Fixture & { r: CrossFlightComparison } {
    const fx = fixture();
    edit?.(fx.A, fx.B, fx.s);
    return { ...fx, r: compareFlights(ok(fx.s), pick(fx.s, fx.A.key, fx.B.key)) };
}

const chirp = (f: StoredFlight, axisName: string, occ: number): StoredChirp =>
    f.chirps.find((c) => c.axisName === axisName && c.axisOccurrence === occ)!;
const bins = (f: StoredFlight, axisName: string, occ: number): Bins => chirp(f, axisName, occ).qualityV2.coherence.bins;

const allPairs = (r: CrossFlightComparison): ChirpPairComparison[] => r.axes.flatMap((x) => x.pairs);
const pairsOf = (r: CrossFlightComparison, id: string) => allPairs(r).filter((p) => p.id === id);
function pairOf(r: CrossFlightComparison, id: string): ChirpPairComparison {
    const ps = pairsOf(r, id);
    expect(ps, `pair ${id}`).toHaveLength(1);
    return ps[0];
}

const ARRAYS = [
    "frequencyHz",
    "coherence",
    "magnitudeDb",
    "inputRelativePowerDb",
    "outputRelativePowerDb",
    "snrDb",
    "status",
] as const;

function sliceBins(b: Bins, n: number) {
    for (const k of ARRAYS) {
        (b as unknown as Record<string, unknown[]>)[k] = (b[k] as unknown[]).slice(0, n);
    }
}

/** Every number anywhere in the result is finite, and the result survives a JSON round trip unchanged. */
function expectJsonSafe(r: unknown) {
    const bad: string[] = [];
    const walk = (v: unknown, path: string) => {
        if (typeof v === "number" && !Number.isFinite(v)) {
            bad.push(`${path}=${v}`);
        } else if (v && typeof v === "object") {
            for (const [k, x] of Object.entries(v)) {
                walk(x, `${path}.${k}`);
            }
        }
    };
    walk(r, "r");
    expect(bad).toEqual([]);
    expect(JSON.parse(JSON.stringify(r))).toStrictEqual(json(r));
    expect(json(r)).toEqual(r);
}

/** The invariants every result must hold, whatever the input. */
function expectInvariants(r: CrossFlightComparison) {
    expect(r.authorization).toEqual({
        status: "NOT_AUTHORIZED",
        reasons: ["cross_flight_comparison_is_not_a_verified_tune", "full_safety_engine_pending"],
    });
    expect(r.repeatability.status).toBe("NOT_ESTABLISHED");
    const compared = allPairs(r).filter((p) => p.status === "COMPARED");
    expect(r.status === "COMPARED").toBe(compared.length > 0 && r.abStatus === "ELIGIBLE");
    if (r.status === "INCOMPLETE" || r.status === "BLOCKED") {
        expect(r.config).toBeNull();
        expect(compared).toEqual([]);
        expect(allPairs(r).every((p) => p.bins === null)).toBe(true);
    }
    for (const p of allPairs(r)) {
        if (p.status !== "COMPARED") {
            expect(p.bins, p.id).toBeNull();
            expect(p.reasons.length, p.id).toBeGreaterThan(0);
        } else {
            expect(p.reasons, p.id).toEqual([]);
            const b = p.bins!;
            const n = b.frequencyHz.length;
            for (const k of [
                "magnitudeDbA",
                "magnitudeDbB",
                "magnitudeDeltaDb",
                "coherenceA",
                "coherenceB",
                "coherenceDelta",
                "statusA",
                "statusB",
            ] as const) {
                expect(b[k], `${p.id}.${k}`).toHaveLength(n);
            }
            for (let i = 0; i < n; i++) {
                const both = b.statusA[i] === "USABLE" && b.statusB[i] === "USABLE";
                if (!both) {
                    expect(b.magnitudeDeltaDb[i], `${p.id} mag@${i}`).toBeNull();
                }
                const power = (s: string) => s === "USABLE" || s === "WEAK_COHERENCE";
                if (!power(b.statusA[i]) || !power(b.statusB[i])) {
                    expect(b.coherenceDelta[i], `${p.id} coh@${i}`).toBeNull();
                }
            }
        }
    }
    expectJsonSafe(r);
}

const hasReason = (p: ChirpPairComparison, prefix: string, suffix = "") =>
    p.reasons.some((x) => x.startsWith(prefix) && x.endsWith(suffix));

function expectBinsInvalid(r: CrossFlightComparison, id: string, side: "a" | "b") {
    const p = pairOf(r, id);
    expect(p.status).toBe("NOT_COMPARABLE");
    expect(p.bins).toBeNull();
    expect(p.reasons.filter((x) => x.startsWith("quality_v2_bins_invalid:"))).not.toEqual([]);
    expect(hasReason(p, "quality_v2_bins_invalid:", `:${side}`), JSON.stringify(p.reasons)).toBe(true);
    // The damage stays with this pair: the others are still compared.
    for (const other of ["roll-1", "roll-2", "pitch-1", "yaw-1"].filter((x) => x !== id)) {
        expect(pairOf(r, other).status, other).toBe("COMPARED");
    }
    expect(r.status).toBe("COMPARED");
    expectInvariants(r);
}

/** Expected per-bin differences, computed here from the stored arrays (identical grids). */
function expectedDeltas(a: Bins, b: Bins, n = Math.min(a.frequencyHz.length, b.frequencyHz.length)) {
    const mag: (number | null)[] = [];
    const coh: (number | null)[] = [];
    const power = (s: string) => s === "USABLE" || s === "WEAK_COHERENCE";
    for (let i = 0; i < n; i++) {
        const ma = a.magnitudeDb[i];
        const mb = b.magnitudeDb[i];
        mag.push(a.status[i] === "USABLE" && b.status[i] === "USABLE" && ma !== null && mb !== null ? mb - ma : null);
        coh.push(power(a.status[i]) && power(b.status[i]) ? b.coherence[i] - a.coherence[i] : null);
    }
    return { mag, coh };
}

function summary(freq: number[], d: (number | null)[]) {
    const idx = d.flatMap((v, i) => (v === null ? [] : [i]));
    const vals = idx.map((i) => d[i]!);
    if (!idx.length) {
        return { binCount: 0 };
    }
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    return {
        binCount: idx.length,
        fromHz: freq[idx[0]],
        toHz: freq[idx[idx.length - 1]],
        min,
        max,
        minAtHz: freq[idx[vals.indexOf(min)]],
        maxAtHz: freq[idx[vals.indexOf(max)]],
        meanAbs: vals.reduce((s, v) => s + Math.abs(v), 0) / vals.length,
        tie: vals.filter((v) => v === min).length > 1 || vals.filter((v) => v === max).length > 1,
    };
}

function deepFreeze<T>(o: T): T {
    if (o && typeof o === "object" && !Object.isFrozen(o)) {
        Object.freeze(o);
        Object.values(o).forEach(deepFreeze);
    }
    return o;
}

const PAIR_IDS = ["roll-1", "roll-2", "pitch-1", "yaw-1"];

describe("baseline (an ELIGIBLE pair of SYNTHETIC Flights)", () => {
    it("is compared on every pair, and every difference is exactly B − A on the right bins", () => {
        const { A, B, r } = run();
        expect(r.abStatus).toBe("ELIGIBLE");
        expect(r.status).toBe("COMPARED");
        expect(r.axes.map((x) => x.axisName)).toEqual(["roll", "pitch", "yaw"]);
        for (const id of PAIR_IDS) {
            const [axis, occ] = id.split("-");
            const p = pairOf(r, id);
            expect(p.status).toBe("COMPARED");
            const a = bins(A, axis, Number(occ));
            const b = bins(B, axis, Number(occ));
            const e = expectedDeltas(a, b);
            expect(p.bins!.frequencyHz).toEqual(a.frequencyHz);
            expect(p.bins!.magnitudeDeltaDb).toEqual(e.mag);
            expect(p.bins!.coherenceDelta).toEqual(e.coh);
            expect(p.bins!.unmatchedBinsA).toBe(0);
            expect(p.bins!.unmatchedBinsB).toBe(0);
            for (const [got, d] of [
                [p.magnitudeDelta, e.mag],
                [p.coherenceDelta, e.coh],
            ] as const) {
                const want = summary(a.frequencyHz, d);
                expect(got!.binCount).toBe(want.binCount);
                expect(got!.min).toBe(want.min);
                expect(got!.max).toBe(want.max);
                expect(got!.fromHz).toBe(want.fromHz);
                expect(got!.toHz).toBe(want.toHz);
                expect(got!.meanAbs).toBeCloseTo(want.meanAbs!, 12);
                if (!want.tie) {
                    expect(got!.minAtHz).toBe(want.minAtHz);
                    expect(got!.maxAtHz).toBe(want.maxAtHz);
                }
            }
        }
        expectInvariants(r);
    });

    it("swapping A and B negates every difference exactly and keeps every null", () => {
        const fx = fixture();
        const fwd = compareFlights(ok(fx.s), pick(fx.s, fx.A.key, fx.B.key));
        const rev = compareFlights(ok(fx.s), pick(fx.s, fx.B.key, fx.A.key));
        for (const id of PAIR_IDS) {
            const f = pairOf(fwd, id).bins!;
            const b = pairOf(rev, id).bins!;
            expect(b.magnitudeDeltaDb).toEqual(f.magnitudeDeltaDb.map((v) => (v === null ? null : -v)));
            expect(b.coherenceDelta).toEqual(f.coherenceDelta.map((v) => (v === null ? null : -v)));
            expect(b.magnitudeDbA).toEqual(f.magnitudeDbB);
        }
    });

    it("the stored order of B's CHIRPs does not change any pair", () => {
        const plain = run().r;
        const reversed = run((_A, B) => B.chirps.reverse()).r;
        for (const id of PAIR_IDS) {
            expect(pairOf(reversed, id).bins).toEqual(pairOf(plain, id).bins);
            expect(pairOf(reversed, id).b!.measurementId).toBe(pairOf(plain, id).b!.measurementId);
        }
    });

    it("relative power and SNR arrays are never compared: garbage there changes nothing", () => {
        const plain = run().r;
        const { r } = run((_A, B) => {
            const b = bins(B, "pitch", 1);
            b.inputRelativePowerDb = b.inputRelativePowerDb.map(() => Number.NaN);
            b.outputRelativePowerDb = b.outputRelativePowerDb.map(() => Number.POSITIVE_INFINITY);
            b.snrDb = b.snrDb.map(() => Number.NaN);
        });
        expect(pairOf(r, "pitch-1").status).toBe("COMPARED");
        expect(pairOf(r, "pitch-1").bins).toEqual(pairOf(plain, "pitch-1").bins);
        expectInvariants(r);
    });
});

describe("invalid and missing bin arrays (quality_v2_bins_invalid:<problem>:<side>)", () => {
    const cases: [string, (b: Bins) => void][] = [
        ["frequencyHz is not an array", (b) => ((b as unknown as Record<string, unknown>).frequencyHz = "1,2,3")],
        ["frequencyHz is missing", (b) => delete (b as unknown as Record<string, unknown>).frequencyHz],
        ["coherence is null", (b) => ((b as unknown as Record<string, unknown>).coherence = null)],
        ["magnitudeDb is an object", (b) => ((b as unknown as Record<string, unknown>).magnitudeDb = { length: 102 })],
        ["status is missing", (b) => delete (b as unknown as Record<string, unknown>).status],
        ["magnitudeDb is one shorter", (b) => b.magnitudeDb.pop()],
        ["coherence is one longer", (b) => b.coherence.push(0.9)],
        ["status is one shorter", (b) => b.status.pop()],
        ["frequencyHz is one shorter", (b) => b.frequencyHz.pop()],
        ["a NaN frequency", (b) => (b.frequencyHz[40] = Number.NaN)],
        ["an Infinity frequency (last bin)", (b) => (b.frequencyHz[b.frequencyHz.length - 1] = Infinity)],
        ["a null frequency", (b) => ((b.frequencyHz as unknown as (number | null)[])[40] = null)],
        ["a string frequency", (b) => ((b.frequencyHz as unknown as unknown[])[40] = String(b.frequencyHz[40]))],
        ["a zero first frequency", (b) => (b.frequencyHz[0] = 0)],
        ["a negative first frequency", (b) => (b.frequencyHz[0] = -1.953125)],
        [
            "unsorted frequencies",
            (b) => ([b.frequencyHz[40], b.frequencyHz[41]] = [b.frequencyHz[41], b.frequencyHz[40]]),
        ],
        ["a duplicate frequency", (b) => (b.frequencyHz[41] = b.frequencyHz[40])],
        ["a NaN coherence", (b) => (b.coherence[40] = Number.NaN)],
        ["an Infinity coherence", (b) => (b.coherence[40] = Infinity)],
        ["a null coherence", (b) => ((b.coherence as unknown as (number | null)[])[40] = null)],
        ["a coherence above 1", (b) => (b.coherence[40] = 1.0000001)],
        ["a negative coherence", (b) => (b.coherence[40] = -0.01)],
        ["a NaN magnitude", (b) => (b.magnitudeDb[40] = Number.NaN)],
        ["a -Infinity magnitude", (b) => (b.magnitudeDb[40] = -Infinity)],
        ["a string magnitude", (b) => ((b.magnitudeDb as unknown as unknown[])[40] = "-3")],
        ["an unknown status", (b) => ((b.status as string[])[40] = "GOOD")],
        ["a lower-case status", (b) => ((b.status as string[])[40] = "usable")],
        ["a null status", (b) => ((b.status as unknown as unknown[])[40] = null)],
        ["a USABLE bin with a null magnitude", (b) => (b.magnitudeDb[40] = null)],
        ["a USABLE bin below the stored coherence criterion", (b) => (b.coherence[40] = 0.3)],
    ];

    for (const [name, edit] of cases) {
        it(`${name} on B makes only that pair NOT_COMPARABLE`, () => {
            const { r } = run((_A, B) => edit(bins(B, "pitch", 1)));
            expectBinsInvalid(r, "pitch-1", "b");
        });
    }

    for (const [name, edit] of cases.filter((_, i) => i % 3 === 0)) {
        it(`${name} on A names side a`, () => {
            const { r } = run((A) => edit(bins(A, "yaw", 1)));
            expectBinsInvalid(r, "yaw-1", "a");
        });
    }

    it("the same invalid edit on both sides is never compared, and names both sides", () => {
        const { r } = run((A, B) => {
            bins(A, "roll", 2).coherence[30] = Number.NaN;
            bins(B, "roll", 2).coherence[30] = Number.NaN;
        });
        const p = pairOf(r, "roll-2");
        expect(p.status).toBe("NOT_COMPARABLE");
        expect(hasReason(p, "quality_v2_bins_invalid:", ":a")).toBe(true);
        expect(hasReason(p, "quality_v2_bins_invalid:", ":b")).toBe(true);
        expectInvariants(r);
    });

    it("a bins object that is null is not compared and does not throw", () => {
        const { r } = run((_A, B) => {
            (chirp(B, "pitch", 1).qualityV2.coherence as unknown as Record<string, unknown>).bins = null;
        });
        const p = pairOf(r, "pitch-1");
        expect(p.status).toBe("NOT_COMPARABLE");
        expect(hasReason(p, "quality_v2_bins_")).toBe(true);
        expectInvariants(r);
    });

    it("bins not MEASURED are quality_v2_bins_unavailable, even with arrays present", () => {
        const { r } = run((_A, B) => (bins(B, "pitch", 1).availability = "UNKNOWN"));
        const p = pairOf(r, "pitch-1");
        expect(p.status).toBe("NOT_COMPARABLE");
        expect(hasReason(p, "quality_v2_bins_unavailable")).toBe(true);
        expectInvariants(r);
    });

    it("chirpQualityAvailable not YES is quality_v2_bins_unavailable", () => {
        const { r } = run(
            (A) =>
                (chirp(A, "roll", 1).qualityV2.levels.chirpQualityAvailable = {
                    status: "UNKNOWN",
                    role: "DIAGNOSTIC",
                    reasons: [],
                }),
        );
        const p = pairOf(r, "roll-1");
        expect(p.status).toBe("NOT_COMPARABLE");
        expect(hasReason(p, "quality_v2_bins_unavailable")).toBe(true);
        expectInvariants(r);
    });
});

describe("frequency grid (exact equality, no nearest bin)", () => {
    for (const offset of [1e-9, -1e-9, 1e-6]) {
        it(`every B frequency shifted by ${offset} Hz is frequency_grid_mismatch`, () => {
            const { r } = run((_A, B) => {
                const b = bins(B, "roll", 1);
                b.frequencyHz = b.frequencyHz.map((f) => f + offset);
            });
            const p = pairOf(r, "roll-1");
            expect(p.status).toBe("NOT_COMPARABLE");
            expect(hasReason(p, "frequency_grid_mismatch")).toBe(true);
            expect(p.bins).toBeNull();
            expectInvariants(r);
        });
    }

    it("one shared bin off by 1e-9 Hz is frequency_grid_mismatch", () => {
        const { r } = run((_A, B) => {
            const b = bins(B, "roll", 1);
            b.frequencyHz[50] = b.frequencyHz[50] + 1e-9;
            expect(b.frequencyHz[50]).not.toBe(b.frequencyHz[50] - 1e-9);
        });
        expect(hasReason(pairOf(r, "roll-1"), "frequency_grid_mismatch")).toBe(true);
        expect(pairOf(r, "roll-1").status).toBe("NOT_COMPARABLE");
    });

    it("one ulp of difference on the last shared bin is frequency_grid_mismatch", () => {
        const { r } = run((_A, B) => {
            const b = bins(B, "yaw", 1);
            const i = b.frequencyHz.length - 1;
            b.frequencyHz[i] = b.frequencyHz[i] * (1 + Number.EPSILON);
            expect(b.frequencyHz[i]).not.toBe(bins(flightA, "yaw", 1).frequencyHz[i]);
        });
        expect(hasReason(pairOf(r, "yaw-1"), "frequency_grid_mismatch")).toBe(true);
    });

    it("a mismatch inside a shorter shared range is still a mismatch", () => {
        const { r } = run((A, B) => {
            sliceBins(bins(B, "pitch", 1), 60);
            bins(B, "pitch", 1).frequencyHz[59] += 1e-9;
            void A;
        });
        expect(hasReason(pairOf(r, "pitch-1"), "frequency_grid_mismatch")).toBe(true);
    });

    for (const [short, n] of [
        ["b", 80],
        ["a", 37],
    ] as const) {
        it(`a strict prefix grid on ${short} (${n} bins) compares the shared bins and counts the rest`, () => {
            const fx = fixture();
            const sb = bins(short === "a" ? fx.A : fx.B, "roll", 1);
            sliceBins(sb, n);
            const r = compareFlights(ok(fx.s), pick(fx.s, fx.A.key, fx.B.key));
            const p = pairOf(r, "roll-1");
            expect(p.status, JSON.stringify(p.reasons)).toBe("COMPARED");
            const a = bins(fx.A, "roll", 1);
            const b = bins(fx.B, "roll", 1);
            const e = expectedDeltas(a, b, n);
            expect(p.bins!.frequencyHz).toEqual(a.frequencyHz.slice(0, n));
            expect(p.bins!.magnitudeDeltaDb).toEqual(e.mag);
            expect(p.bins!.coherenceDelta).toEqual(e.coh);
            expect(p.bins!.statusA).toHaveLength(n);
            expect(p.bins!.unmatchedBinsA).toBe(a.frequencyHz.length - n);
            expect(p.bins!.unmatchedBinsB).toBe(b.frequencyHz.length - n);
            expect(p.magnitudeDelta!.binCount).toBe(e.mag.filter((x) => x !== null).length);
            expectInvariants(r);
        });
    }
});

describe("deltas are null, never 0, where a side has no valid value", () => {
    it("NO_INPUT_POWER, OUTSIDE_ANALYSIS_BAND and WEAK_COHERENCE bins against identical data", () => {
        const fx = fixture();
        const a = bins(fx.A, "pitch", 1);
        chirp(fx.B, "pitch", 1).qualityV2.coherence.bins = json(a);
        const b = bins(fx.B, "pitch", 1);
        // B: no input power at 10 (magnitude null, as Betaflight stores it).
        b.status[10] = "NO_INPUT_POWER";
        b.magnitudeDb[10] = null;
        // Both: no input power at 15, with identical stored values.
        for (const x of [a, b]) {
            x.status[15] = "NO_INPUT_POWER";
            x.magnitudeDb[15] = null;
        }
        // A: the analysis band starts above bin 1, which becomes OUTSIDE_ANALYSIS_BAND but keeps its magnitude.
        chirp(fx.A, "pitch", 1).qualityV2.sweep.analysisBandHz = [4, 200];
        a.status[1] = "OUTSIDE_ANALYSIS_BAND";
        // B: weakly coherent at 30.
        b.status[30] = "WEAK_COHERENCE";
        b.coherence[30] = 0.3;
        const r = compareFlights(ok(fx.s), pick(fx.s, fx.A.key, fx.B.key));
        const p = pairOf(r, "pitch-1");
        expect(p.status, JSON.stringify(p.reasons)).toBe("COMPARED");
        expect(p.notes).toContain("analysis_band_differs");
        const e = expectedDeltas(a, b);
        expect(p.bins!.magnitudeDeltaDb).toEqual(e.mag);
        expect(p.bins!.coherenceDelta).toEqual(e.coh);
        for (const i of [0, 1, 10, 15, 30]) {
            expect(p.bins!.magnitudeDeltaDb[i], `mag@${i}`).toBeNull();
        }
        for (const i of [0, 1, 10, 15]) {
            expect(p.bins!.coherenceDelta[i], `coh@${i}`).toBeNull();
        }
        expect(p.bins!.coherenceDelta[30]).toBe(0.3 - a.coherence[30]);
        expect(p.bins!.magnitudeDbB[10]).toBeNull();
        // Identical stored values elsewhere: exactly 0, and only there.
        expect(e.mag.filter((x) => x !== null).every((x) => x === 0)).toBe(true);
        expect(p.magnitudeDelta).toMatchObject({ binCount: e.mag.filter((x) => x !== null).length, min: 0, max: 0 });
        expect(p.magnitudeDelta!.meanAbs).toBe(0);
        expectInvariants(r);
    });

    it("no shared valid bin at all is NOT_COMPARABLE (no_shared_valid_bins), never all zeros", () => {
        const { r } = run((_A, B) => {
            const b = bins(B, "yaw", 1);
            chirp(B, "yaw", 1).qualityV2.sweep.analysisBandHz = [500, 600];
            b.status = b.status.map(() => "OUTSIDE_ANALYSIS_BAND");
        });
        const p = pairOf(r, "yaw-1");
        expect(p.status).toBe("NOT_COMPARABLE");
        expect(p.reasons).toContain("no_shared_valid_bins");
        expectInvariants(r);
    });

    it("coherence differences without any magnitude difference carry no_shared_usable_magnitude_bins", () => {
        const fx = fixture();
        const b = bins(fx.B, "yaw", 1);
        b.status = b.status.map((s) => (s === "USABLE" ? "WEAK_COHERENCE" : s));
        b.coherence = b.coherence.map((c, i) => (b.status[i] === "WEAK_COHERENCE" ? Math.min(c, 0.25) : c));
        const r = compareFlights(ok(fx.s), pick(fx.s, fx.A.key, fx.B.key));
        const p = pairOf(r, "yaw-1");
        expect(p.status, JSON.stringify(p.reasons)).toBe("COMPARED");
        expect(p.notes).toContain("no_shared_usable_magnitude_bins");
        expect(p.bins!.magnitudeDeltaDb.every((x) => x === null)).toBe(true);
        expect(p.bins!.coherenceDelta).toEqual(expectedDeltas(bins(fx.A, "yaw", 1), b).coh);
        expect(p.magnitudeDelta?.binCount ?? 0).toBe(0);
        expectInvariants(r);
    });
});

describe("identity metadata and pairing", () => {
    const contradictions: [string, (c: StoredChirp) => void][] = [
        ["qualityV2.identity.axisName", (c) => (c.qualityV2.identity.axisName = "yaw")],
        ["qualityV2.identity.axisOccurrence", (c) => (c.qualityV2.identity.axisOccurrence = 2)],
        ["qualityV2.identity.axis", (c) => (c.qualityV2.identity.axis = 0)],
        ["StoredChirp.axis", (c) => (c.axis = 2)],
        ["qualityV2.identity.measurementId", (c) => (c.qualityV2.identity.measurementId = "log1-seg9")],
    ];
    for (const [field, edit] of contradictions) {
        it(`a contradicting ${field} is chirp_identity_contradiction and never pairs elsewhere`, () => {
            const { r } = run((_A, B) => edit(chirp(B, "pitch", 1)));
            const p = pairOf(r, "pitch-1");
            expect(p.status).toBe("NOT_COMPARABLE");
            expect(p.reasons).toContain("chirp_identity_contradiction:b");
            expect(pairOf(r, "yaw-1").status).toBe("COMPARED");
            expect(pairOf(r, "roll-2").status).toBe("COMPARED");
            expect(pairOf(r, "yaw-1").b!.measurementId).toBe(chirp(flightB, "yaw", 1).measurementId);
            expectInvariants(r);
        });
    }

    it("a duplicate axisOccurrence in one Flight is never compared (axis_occurrence_duplicate:b)", () => {
        const { r } = run((_A, B) => {
            const c = chirp(B, "roll", 2);
            c.axisOccurrence = 1;
            c.qualityV2.identity.axisOccurrence = 1;
        });
        const roll1 = pairsOf(r, "roll-1");
        expect(roll1.length).toBeGreaterThan(0);
        for (const p of roll1) {
            expect(p.status).toBe("NOT_COMPARABLE");
            expect(p.reasons).toContain("axis_occurrence_duplicate:b");
        }
        expect(allPairs(r).filter((p) => p.axisName === "roll" && p.status === "COMPARED")).toEqual([]);
        const roll2 = pairOf(r, "roll-2");
        expect(roll2).toMatchObject({ status: "UNPAIRED", reasons: ["chirp_only_in_flight_a"], b: null });
        expectInvariants(r);
    });

    for (const bad of ["throttle", "constructor", "__proto__", "Roll", ""]) {
        it(`a CHIRP with axisName ${JSON.stringify(bad)} is never paired or compared`, () => {
            const { r } = run((_A, B) => {
                const c = chirp(B, "yaw", 1);
                (c as unknown as Record<string, unknown>).axisName = bad;
                (c.qualityV2.identity as unknown as Record<string, unknown>).axisName = bad;
            });
            expect(r.axes.map((x) => x.axisName)).toEqual(["roll", "pitch", "yaw"]);
            expect(allPairs(r).some((p) => p.b?.axisName === bad || p.a?.axisName === bad)).toBe(false);
            expect(pairOf(r, "yaw-1").status).not.toBe("COMPARED");
            for (const id of ["roll-1", "roll-2", "pitch-1"]) {
                expect(pairOf(r, id).status).toBe("COMPARED");
            }
            expectInvariants(r);
        });
    }

    it("a NaN axisOccurrence is never compared and never echoed as NaN", () => {
        const { r } = run((_A, B) => {
            const c = chirp(B, "pitch", 1);
            c.axisOccurrence = Number.NaN;
            c.qualityV2.identity.axisOccurrence = Number.NaN;
        });
        expect(allPairs(r).filter((p) => p.axisName === "pitch" && p.status === "COMPARED")).toEqual([]);
        expectInvariants(r);
    });

    it("a non-integer or non-positive axisOccurrence is never compared", () => {
        for (const occ of [0, -1, 1.5]) {
            const { r } = run((_A, B) => {
                const c = chirp(B, "pitch", 1);
                c.axisOccurrence = occ;
                c.qualityV2.identity.axisOccurrence = occ;
            });
            expect(
                allPairs(r).filter((p) => p.axisName === "pitch" && p.status === "COMPARED"),
                String(occ),
            ).toEqual([]);
            expectInvariants(r);
        }
    });
});

describe("qualification", () => {
    it("usable_with_warnings is still qualified", () => {
        const { r } = run((_A, B) => (chirp(B, "pitch", 1).qualification.state = "usable_with_warnings"));
        expect(pairOf(r, "pitch-1").status).toBe("COMPARED");
    });

    const unqualified: [string, (c: StoredChirp) => void][] = [
        ["state rejected", (c) => ((c.qualification as { state: string }).state = "rejected")],
        ["an unknown state", (c) => ((c.qualification as { state: string }).state = "Usable")],
        [
            "chirpQualified UNKNOWN",
            (c) => (c.qualityV2.levels.chirpQualified = { status: "UNKNOWN", role: "ACTIVE_GATE", reasons: [] }),
        ],
        ["a FAIL saturation verdict", (c) => (c.qualityV2.verdicts.saturation.verdict = "FAIL")],
        ["a FAIL coherence verdict", (c) => (c.qualityV2.verdicts.coherence.verdict = "FAIL")],
    ];
    for (const [name, edit] of unqualified) {
        it(`${name} on A is chirp_not_qualified:a`, () => {
            const { r } = run((A) => edit(chirp(A, "roll", 2)));
            const p = pairOf(r, "roll-2");
            expect(p.status).toBe("NOT_COMPARABLE");
            expect(hasReason(p, "chirp_not_qualified:a")).toBe(true);
            expect(p.a).not.toBeNull();
            expect(p.b).not.toBeNull();
            expectInvariants(r);
        });
    }
});

describe("provenance", () => {
    const FIELDS = [
        "decoder",
        "transferFunction",
        "inputField",
        "outputField",
        "flagGating",
        "highResolutionScale",
        "sampleRateHz",
        "sampleRateSource",
        "sampleRateStatus",
        "segmentSize",
        "welchOverlap",
        "binWidthHz",
    ] as const;

    for (const field of FIELDS) {
        it(`${field} null on both sides is provenance_unknown:${field}`, () => {
            const { r } = run((A, B) => {
                for (const f of [A, B]) {
                    (chirp(f, "roll", 1).qualityV2.provenance as unknown as Record<string, unknown>)[field] = null;
                }
            });
            const p = pairOf(r, "roll-1");
            expect(p.status).toBe("NOT_COMPARABLE");
            expect(p.reasons).toContain(`provenance_unknown:${field}`);
            expectInvariants(r);
        });

        it(`${field} missing on B only is never compared`, () => {
            const { r } = run((_A, B) => {
                delete (chirp(B, "roll", 1).qualityV2.provenance as unknown as Record<string, unknown>)[field];
            });
            const p = pairOf(r, "roll-1");
            expect(p.status).toBe("NOT_COMPARABLE");
            expect(hasReason(p, `provenance_unknown:${field}`) || hasReason(p, `provenance_differs:${field}`)).toBe(
                true,
            );
            expectInvariants(r);
        });
    }

    it("welchSegments null on both sides is provenance_unknown:welchSegments", () => {
        const { r } = run((A, B) => {
            for (const f of [A, B]) {
                chirp(f, "roll", 1).qualityV2.provenance.welchSegments = null;
            }
        });
        const p = pairOf(r, "roll-1");
        expect(p.status).toBe("NOT_COMPARABLE");
        expect(p.reasons).toContain("provenance_unknown:welchSegments");
    });

    it("a NaN sample rate on both sides is never compared", () => {
        const { r } = run((A, B) => {
            for (const f of [A, B]) {
                chirp(f, "pitch", 1).qualityV2.provenance.sampleRateHz = Number.NaN;
            }
        });
        const p = pairOf(r, "pitch-1");
        expect(p.status).toBe("NOT_COMPARABLE");
        expect(hasReason(p, "provenance_")).toBe(true);
        expectInvariants(r);
    });

    it("a sample rate stored as text on one side is provenance_differs:sampleRateHz", () => {
        const { r } = run((_A, B) => {
            (chirp(B, "pitch", 1).qualityV2.provenance as unknown as Record<string, unknown>).sampleRateHz = "1000";
        });
        const p = pairOf(r, "pitch-1");
        expect(p.status).toBe("NOT_COMPARABLE");
        expect(hasReason(p, "provenance_")).toBe(true);
    });

    it("a logged segment size that disagrees with the transfer function's is segmentSize_inconsistent", () => {
        const { r } = run((A) => (bins(A, "yaw", 1).powerScale.segmentSize = 256));
        const p = pairOf(r, "yaw-1");
        expect(p.status).toBe("NOT_COMPARABLE");
        expect(p.reasons).toContain("provenance_differs:segmentSize_inconsistent:a");
        expectInvariants(r);
    });

    it("a different Welch segment count is only a note", () => {
        const { r } = run((_A, B) => {
            chirp(B, "pitch", 1).qualityV2.provenance.welchSegments = 30;
            bins(B, "pitch", 1).powerScale.numSegments = 30;
        });
        const p = pairOf(r, "pitch-1");
        expect(p.status).toBe("COMPARED");
        const a = chirp(flightA, "pitch", 1).qualityV2.provenance.welchSegments;
        expect(p.notes).toContain(`welch_segment_count_differs:${a}:30`);
    });

    it("another analysis version on one CHIRP is never compared", () => {
        const { r } = run((_A, B) => {
            (chirp(B, "pitch", 1).qualityV2 as unknown as Record<string, unknown>).analysisVersion = "2.0.0";
        });
        expect(r.status).not.toBe("COMPARED");
        expect(allPairs(r).filter((p) => p.status === "COMPARED")).toEqual([]);
        expectInvariants(r);
    });
});

describe("logged configuration", () => {
    const edited = (edit: (A: StoredFlight, B: StoredFlight) => void) => {
        const fx = fixture();
        edit(fx.A, fx.B);
        return { ...fx, cfg: compareConfig(fx.A, fx.B) };
    };
    const item = (cfg: ReturnType<typeof compareConfig>, key: string) => cfg.items.filter((i) => i.key === key);

    it("baseline: every logged compared key is MATCH and nothing blocks", () => {
        const { cfg } = edited(() => {});
        expect(cfg.items.filter((i) => i.status === "MISMATCH")).toEqual([]);
        expect(cfg.items.filter((i) => i.blocksDifference)).toEqual([]);
        for (const axis of ["roll", "pitch", "yaw"] as const) {
            expect(configBlockers(cfg, axis)).toEqual([]);
        }
        for (const k of ["vbatref", "Log start datetime", "Firmware type", "Craft name", "Field I name"]) {
            expect(item(cfg, k).filter((i) => i.blocksDifference)).toEqual([]);
        }
        for (const i of cfg.items.filter((x) => x.status === "MATCH")) {
            expect(typeof i.a).toBe("string");
            expect(i.a).toBe(i.b);
        }
    });

    it("the same key logged twice with contradicting values is UNKNOWN and blocks every pair", () => {
        const { s, A, B, cfg } = edited((_A, B) => B.logHeaders!.push(["rollPID", "50,80,30"]));
        const [rollPid] = item(cfg, "rollPID");
        expect(item(cfg, "rollPID")).toHaveLength(1);
        expect(rollPid).toMatchObject({ status: "UNKNOWN", b: null, blocksDifference: true });
        expect(cfg.status).not.toBe("MATCH");
        expect(cfg.problems.length).toBeGreaterThan(0);
        const r = compareFlights(ok(s), pick(s, A.key, B.key));
        expect(r.status).toBe("NOT_COMPARABLE");
        for (const id of PAIR_IDS) {
            expect(pairOf(r, id).reasons).toContain("config_unknown:rollPID");
        }
        expect(r.diagnostics!.compared).toEqual([]);
        expectInvariants(r);
    });

    it("the same contradiction in both Flights is still UNKNOWN, never MATCH", () => {
        const { cfg } = edited((A, B) => {
            for (const f of [A, B]) {
                f.logHeaders!.push(["looptime", "250"]);
            }
        });
        expect(item(cfg, "looptime")[0]).toMatchObject({ status: "UNKNOWN", blocksDifference: true });
        expect(cfg.status).toBe("UNKNOWN");
    });

    it("the same key logged twice with the same text is not a contradiction", () => {
        const { cfg } = edited((A, B) => {
            for (const f of [A, B]) {
                f.logHeaders!.push(["rollPID", "45,80,30"]);
            }
        });
        expect(item(cfg, "rollPID")[0]).toMatchObject({ status: "MATCH", a: "45,80,30", b: "45,80,30" });
    });

    it("a contradicting chirp_amplitude_yaw blocks only yaw", () => {
        const { s, A, B, cfg } = edited((A) => A.logHeaders!.push(["chirp_amplitude_yaw", "300"]));
        expect(item(cfg, "chirp_amplitude_yaw")[0]).toMatchObject({ status: "UNKNOWN", axis: "yaw" });
        expect(configBlockers(cfg, "roll")).toEqual([]);
        expect(configBlockers(cfg, "yaw")).toContain("config_unknown:chirp_amplitude_yaw");
        const r = compareFlights(ok(s), pick(s, A.key, B.key));
        expect(pairOf(r, "yaw-1").reasons).toEqual(["config_unknown:chirp_amplitude_yaw"]);
        for (const id of ["roll-1", "roll-2", "pitch-1"]) {
            expect(pairOf(r, id).status).toBe("COMPARED");
        }
    });

    it("a trailing space is a different text: MISMATCH, never trimmed", () => {
        const { cfg } = edited((_A, B) => {
            const e = B.logHeaders!.find(([k]) => k === "pitchPID")!;
            e[1] = `${e[1]} `;
        });
        expect(item(cfg, "pitchPID")[0]).toMatchObject({ status: "MISMATCH", blocksDifference: true });
        expect(configBlockers(cfg, "roll")).toContain("config_mismatch:pitchPID");
    });

    it("the order of header lines does not matter", () => {
        const { s, A, B, cfg } = edited((_A, B) => B.logHeaders!.reverse());
        expect(cfg.items.filter((i) => i.status === "MISMATCH")).toEqual([]);
        expect(compareFlights(ok(s), pick(s, A.key, B.key)).status).toBe("COMPARED");
    });

    it("a header block that is unavailable on one side blocks every pair", () => {
        const { s, A, B, cfg } = edited((_A, B) => (B.logHeaders = null));
        expect(cfg.status).toBe("UNKNOWN");
        expect(cfg.items.filter((i) => i.status === "MATCH")).toEqual([]);
        for (const axis of ["roll", "pitch", "yaw"] as const) {
            expect(configBlockers(cfg, axis)).toContain("config_unknown:rollPID");
        }
        // WU4 already blocks this pair (the stored API version no longer follows from the headers).
        const r = compareFlights(ok(s), pick(s, A.key, B.key));
        expect(r.status).not.toBe("COMPARED");
        expect(allPairs(r).filter((p) => p.status === "COMPARED")).toEqual([]);
        expectInvariants(r);
    });

    it("header blocks unavailable on both sides block every pair (required keys unknown)", () => {
        const { s, A, B, cfg } = edited((A, B) => {
            A.logHeaders = null;
            B.logHeaders = null;
        });
        expect(cfg.status).toBe("UNKNOWN");
        expect(cfg.items.filter((i) => i.status === "MATCH")).toEqual([]);
        for (const axis of ["roll", "pitch", "yaw"] as const) {
            for (const key of [
                "looptime",
                "pid_process_denom",
                "rollPID",
                "chirp_time_seconds",
                `chirp_amplitude_${axis}`,
            ]) {
                expect(configBlockers(cfg, axis)).toContain(`config_unknown:${key}`);
            }
        }
        const r = compareFlights(ok(s), pick(s, A.key, B.key));
        expect(r.status).not.toBe("COMPARED");
        expectInvariants(r);
    });

    it("a required amplitude logged by neither Flight blocks only its axis", () => {
        const { s, A, B } = edited((A, B) => {
            for (const f of [A, B]) {
                f.logHeaders = f.logHeaders!.filter(([k]) => k !== "chirp_amplitude_pitch");
            }
        });
        const r = compareFlights(ok(s), pick(s, A.key, B.key));
        expect(pairOf(r, "pitch-1").reasons).toEqual(["config_unknown:chirp_amplitude_pitch"]);
        expect(pairOf(r, "roll-1").status).toBe("COMPARED");
    });

    it("compareConfig: malformed header entries never become MATCH and never throw", () => {
        const junk = [["rollPID"], ["rollPID", null], null, "rollPID:45,80,30", [1, 2], {}, ["x", "y", "z"]];
        const { s, A, B, cfg } = edited((A, B) => {
            B.logHeaders = B.logHeaders!.filter(([k]) => k !== "rollPID");
            for (const f of [A, B]) {
                f.logHeaders!.push(...(json(junk) as unknown as [string, string][]));
            }
        });
        for (const i of cfg.items.filter((x) => x.status === "MATCH")) {
            expect(typeof i.a, i.key).toBe("string");
            expect(i.a).toBe(i.b);
        }
        expect(item(cfg, "rollPID").every((i) => i.status !== "MATCH")).toBe(true);
        expect(configBlockers(cfg, "pitch")).not.toEqual([]);
        expectJsonSafe(cfg);
        // WU3 load validation rejects such a header block, so compareFlights never sees it.
        void s;
        void A;
        void B;
    });

    it("prototype-named keys are compared like any other key", () => {
        const { cfg } = edited((A, B) => {
            A.logHeaders!.push(["__proto__", "1"], ["constructor", "x"]);
            B.logHeaders!.push(["__proto__", "2"], ["constructor", "x"]);
        });
        expect(item(cfg, "__proto__")[0]).toMatchObject({ status: "MISMATCH", a: "1", b: "2", blocksDifference: true });
        expect(item(cfg, "constructor")[0]).toMatchObject({ status: "MATCH", a: "x", b: "x" });
        expect(item(cfg, "toString")).toEqual([]);
    });

    it("firmware identity, frame definitions, log start and vbatref are not compared", () => {
        const { s, A, B, cfg } = edited((A, B) => {
            A.logHeaders!.push(["vbatref", "420"]);
            B.logHeaders!.push(["vbatref", "385"]);
            for (const [k, v] of [
                ["Craft name", "OTHER"],
                ["Product", "Other product"],
                ["Field I name", "loopIteration,time"],
            ]) {
                const e = B.logHeaders!.find(([x]) => x === k)!;
                e[1] = v;
            }
        });
        expect(cfg.items.filter((i) => i.blocksDifference)).toEqual([]);
        expect(compareFlights(ok(s), pick(s, A.key, B.key)).status).toBe("COMPARED");
    });
});

describe("the WU4 gate and the selection", () => {
    it("a selection of another session is INCOMPLETE", () => {
        const { s, A, B } = fixture();
        const r = compareFlights(ok(s), { sessionId: "other", a: A.key, b: B.key, cleared: [] });
        expect(r.status).toBe("INCOMPLETE");
        expectInvariants(r);
    });

    it("no load, or a corrupt or missing session, is INCOMPLETE (session_not_loaded)", () => {
        const { s, A, B } = fixture();
        const sel = pick(s, A.key, B.key);
        for (const load of [
            null,
            { status: "corrupt", id: s.id, problems: ["x"] } as LoadResult,
            { status: "not_found", id: s.id } as LoadResult,
            { status: "unsupported_version", id: s.id, schemaVersion: 9 } as LoadResult,
        ]) {
            const r = compareFlights(load, sel);
            expect(r.status).toBe("INCOMPLETE");
            expect(r.blockers).toContain("session_not_loaded");
            expectInvariants(r);
        }
    });

    it("a missing choice is INCOMPLETE", () => {
        const { s, A } = fixture();
        const r = compareFlights(ok(s), pick(s, A.key, null));
        expect(r.status).toBe("INCOMPLETE");
        expectInvariants(r);
    });

    it("keys not in the session are BLOCKED, never compared", () => {
        const { s, B } = fixture();
        for (const sel of [pick(s, "nope", B.key), pick(s, B.key, "nope"), pick(s, "x", "y")]) {
            const r = compareFlights(ok(s), sel);
            expect(r.status).toBe("BLOCKED");
            expect(r.blockers).toContain("ab_pair_blocked");
            expectInvariants(r);
        }
    });

    it("the same Flight twice is BLOCKED", () => {
        const { s, A } = fixture();
        const r = compareFlights(ok(s), pick(s, A.key, A.key));
        expect(r.status).toBe("BLOCKED");
        expectInvariants(r);
    });

    it("a rejected CHIRP is reported on the side of the selection, also when A and B are swapped", () => {
        const fx = fixture();
        const idx = fx.s.flights.indexOf(fx.B);
        const ci = fx.B.chirps.findIndex((c) => c.axisName === "roll" && c.axisOccurrence === 2);
        fx.B.chirps.splice(ci, 1);
        const rejected = [{ path: `flights[${idx}].chirps[${ci}]`, problems: ["damaged"] }];
        const fwd = compareFlights(ok(fx.s, rejected), pick(fx.s, fx.A.key, fx.B.key));
        expect(fwd.blockers).toContain("flight_chirps_rejected:b:1");
        expect(fwd.missingEvidence).toContain("flight_chirps_rejected:b:1");
        expect(pairOf(fwd, "roll-2")).toMatchObject({ status: "UNPAIRED", reasons: ["chirp_only_in_flight_a"] });
        expect(fwd.status).toBe("COMPARED");
        const rev = compareFlights(ok(fx.s, rejected), pick(fx.s, fx.B.key, fx.A.key));
        expect(rev.blockers).toContain("flight_chirps_rejected:a:1");
        expect(pairOf(rev, "roll-2")).toMatchObject({ status: "UNPAIRED", reasons: ["chirp_only_in_flight_b"] });
        expectInvariants(fwd);
        expectInvariants(rev);
    });
});

describe("inputs, outputs and authorization", () => {
    it("never mutates deep-frozen inputs, valid or damaged", () => {
        for (const damage of [false, true]) {
            const fx = fixture();
            if (damage) {
                bins(fx.B, "pitch", 1).coherence[5] = Number.NaN;
                fx.B.logHeaders!.push(["rollPID", "1,2,3"]);
            }
            const load = ok(fx.s);
            const sel = pick(fx.s, fx.A.key, fx.B.key);
            const before = JSON.stringify([load, sel]);
            deepFreeze(load);
            deepFreeze(sel);
            const r = compareFlights(load, sel);
            expect(JSON.stringify([load, sel])).toBe(before);
            expect(() => compareConfig(fx.A, fx.B)).not.toThrow();
            expectInvariants(r);
        }
    });

    it("results do not share arrays with the stored bins", () => {
        const fx = fixture();
        const r = compareFlights(ok(fx.s), pick(fx.s, fx.A.key, fx.B.key));
        const p = pairOf(r, "roll-1");
        expect(p.bins!.frequencyHz).not.toBe(bins(fx.A, "roll", 1).frequencyHz);
        expect(p.bins!.coherenceA).not.toBe(bins(fx.A, "roll", 1).coherence);
    });

    it("authorization and repeatability are fresh, NOT_AUTHORIZED and NOT_ESTABLISHED in every status", () => {
        const fx = fixture();
        const results = [
            compareFlights(ok(fx.s), pick(fx.s, fx.A.key, fx.B.key)),
            compareFlights(ok(fx.s), pick(fx.s, fx.A.key, fx.A.key)),
            compareFlights(null, pick(fx.s, fx.A.key, fx.B.key)),
        ];
        expect(results.map((r) => r.status)).toEqual(["COMPARED", "BLOCKED", "INCOMPLETE"]);
        for (const r of results) {
            expectInvariants(r);
            expect(r.repeatability.reasons).toEqual([
                "pairwise_comparison_only:two_flights",
                "no_validated_acceptance_criteria",
                "real_flight_validation_pending",
            ]);
        }
        try {
            (results[0].authorization.reasons as unknown as string[]).push("x");
            (results[0].repeatability.reasons as unknown as string[]).push("x");
            (results[0].authorization as unknown as { status: string }).status = "AUTHORIZED";
        } catch {
            // Frozen copies are fine too.
        }
        const again = compareFlights(ok(fx.s), pick(fx.s, fx.A.key, fx.B.key));
        expect(again.authorization.status).toBe("NOT_AUTHORIZED");
        expect(again.authorization.reasons).toHaveLength(2);
        expect(again.repeatability.reasons).toHaveLength(3);
    });

    it("every pair blocked is NOT_COMPARABLE, never COMPARED", () => {
        const { r } = run((_A, B) => {
            for (const c of B.chirps) {
                c.qualityV2.coherence.bins.coherence[3] = Number.NaN;
            }
        });
        expect(r.abStatus).toBe("ELIGIBLE");
        expect(r.status).toBe("NOT_COMPARABLE");
        expect(r.diagnostics!.compared).toEqual([]);
        expect(r.diagnostics!.notComparable.map((x) => x.id).sort()).toEqual([...PAIR_IDS].sort());
        expectInvariants(r);
    });

    it("a quality value that is not MEASURED is never shown as a number", () => {
        const { r } = run((_A, B) => {
            const m = chirp(B, "pitch", 1).qualityV2.coherence.meanBandCoherence;
            m.availability = "UNKNOWN";
            m.value = 0.9;
        });
        for (const p of allPairs(r)) {
            for (const row of p.quality) {
                for (const v of [row.a, row.b]) {
                    if (v && v.availability !== "MEASURED") {
                        expect(typeof v.value, `${p.id}.${row.id}`).not.toBe("number");
                    }
                }
            }
        }
        const row = pairOf(r, "pitch-1").quality.find((q) => q.id === "meanBandCoherence");
        expect(row?.b?.availability).toBe("UNKNOWN");
    });

    it("always lists the Quality V2 limits and what is missing", () => {
        const { r } = run();
        expect(r.diagnostics!.qualityLimits).toEqual(
            expect.arrayContaining([
                "relative_power_not_cross_flight_calibrated",
                "contamination_unknown:no_validated_detector",
                "gyro_clipping_unknown:sensor_range_not_logged",
            ]),
        );
        expect(r.diagnostics!.missingForStrongerConclusions).toEqual(
            expect.arrayContaining([
                "more_independent_repeats_needed",
                "no_validated_acceptance_criteria",
                "real_flight_validation_pending",
                "external_conditions_not_logged",
            ]),
        );
    });
});

describe("lineChart gaps", () => {
    const W = 400;
    const H = 200;
    const vertices = (d: string) => (d.match(/[ML][^A-Za-z]*/g) ?? []).map((x) => x.trim());
    const cmds = (d: string) => vertices(d).map((x) => x[0]);
    const coords = (d: string) =>
        vertices(d).flatMap((x) => (x.slice(1).match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number));

    it("a null value starts a new subpath and is never drawn", () => {
        const f = [1, 2, 4, 8, 16, 32, 64, 128];
        const values = [1, 2, null, 4, 5, null, null, 8];
        const c = lineChart(f, [{ id: "s", values }], W, H, { includeZero: true })!;
        const p = c.paths.find((x) => x.id === "s")!;
        expect(p.points).toBe(5);
        const m = cmds(p.d);
        expect(m.filter((x) => x === "M")).toHaveLength(3);
        expect(m.filter((x) => x === "M" || x === "L")).toHaveLength(5);
        const xy = coords(p.d);
        expect(xy).toHaveLength(10);
        expect(xy.every(Number.isFinite)).toBe(true);
        expect(p.d).not.toMatch(/NaN|Infinity/);
    });

    it("two runs separated by a gap are two subpaths, and the gap is not bridged", () => {
        const f = [10, 20, 30, 40, 50, 60];
        const values = [1, 2, 3, null, 5, 6];
        const c = lineChart(f, [{ id: "s", values }], W, H, { includeZero: true })!;
        const p = c.paths[0];
        expect(p.points).toBe(5);
        expect(cmds(p.d).filter((x) => x === "M")).toHaveLength(2);
        // No vertex at the y of zero for the missing bin: every x is distinct and there are only 5.
        const xy = coords(p.d);
        const xs = xy.filter((_, i) => i % 2 === 0);
        expect(new Set(xs).size).toBe(5);
        for (let i = 1; i < xs.length; i++) {
            expect(xs[i]).toBeGreaterThan(xs[i - 1]);
        }
    });

    it("all-null series draw nothing and never throw", () => {
        const c = lineChart([1, 2, 3], [{ id: "s", values: [null, null, null] }], W, H, { includeZero: true });
        if (c) {
            expect(c.paths.every((p) => p.points === 0 && !/[LM]/.test(p.d) === true)).toBe(true);
            expect(JSON.stringify(c)).not.toMatch(/NaN|Infinity|null,null/);
        }
    });

    it("degenerate input never yields NaN or Infinity in the geometry", () => {
        const inputs: [number[], (number | null)[]][] = [
            [[10], [1]],
            [
                [10, 20, 30],
                [3, 3, 3],
            ],
            [
                [10, 20, 30],
                [0, 0, 0],
            ],
            [
                [10, 20, 30],
                [1, Number.NaN, 2],
            ],
            [
                [10, 20, 30],
                [1, Infinity, 2],
            ],
            [
                [10, 20, 30],
                [1, 2],
            ],
            [[], []],
        ];
        for (const [f, values] of inputs) {
            let c: ReturnType<typeof lineChart> = null;
            expect(() => (c = lineChart(f, [{ id: "s", values }], W, H, { includeZero: true }))).not.toThrow();
            if (c) {
                const geo = c as NonNullable<ReturnType<typeof lineChart>>;
                for (const p of geo.paths) {
                    expect(p.d, JSON.stringify(values)).not.toMatch(/NaN|Infinity/);
                    expect(coords(p.d).every(Number.isFinite)).toBe(true);
                }
                if (geo.zeroY !== null) {
                    expect(Number.isFinite(geo.zeroY)).toBe(true);
                }
                const finiteVals = values.filter((v): v is number => v !== null && Number.isFinite(v));
                expect(geo.paths[0]?.points ?? 0).toBeLessThanOrEqual(finiteVals.length);
            }
        }
    });

    it("points stay inside the chart and a zero line is given when asked", () => {
        const f = [2, 5, 10, 50, 100, 200];
        const c = lineChart(f, [{ id: "s", values: [-3, -1, 0, 2, null, 4] }], W, H, { includeZero: true })!;
        expect(c.zeroY).not.toBeNull();
        expect(c.zeroY!).toBeGreaterThanOrEqual(0);
        expect(c.zeroY!).toBeLessThanOrEqual(H);
        const xy = coords(c.paths[0].d);
        for (let i = 0; i < xy.length; i += 2) {
            expect(xy[i]).toBeGreaterThanOrEqual(0);
            expect(xy[i]).toBeLessThanOrEqual(W);
            expect(xy[i + 1]).toBeGreaterThanOrEqual(0);
            expect(xy[i + 1]).toBeLessThanOrEqual(H);
        }
        // y = 0 sits on the zero line.
        expect(Math.abs(xy[5] - c.zeroY!)).toBeLessThan(0.06);
    });

    it("an explicit range is respected and values on its ends map to the top and bottom of the plot", () => {
        const f = [10, 100];
        const c = lineChart(f, [{ id: "s", values: [0, 1] }], W, H, { range: [0, 1] })!;
        const xy = coords(c.paths[0].d);
        expect(xy[1]).toBeGreaterThan(xy[3]);
    });
});
