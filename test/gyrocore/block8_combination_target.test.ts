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
 * Block 8: independent flights combined into the experimental decision only where they measured the
 * same thing (multiRecording.ts combineRecordings), and the wider target search with a first step
 * that is read on its own margins (candidateDecision.ts targetSearch). Nothing is interpolated, a
 * contradiction fills no hole, and a farther target never widens what one Apply may write.
 * SIMULATION ONLY.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import type { TransferFunction } from "../../src/js/blackbox/spectral_analysis";
import { combineRecordings, RECORDING_AGREEMENT, type RecordingRung } from "../../src/gyrocore/engine/multiRecording";
import { sweepAverages, type FrequencySupport } from "../../src/gyrocore/engine/loopModel";
import { buildLogInputs } from "../../src/gyrocore/engine/logInput";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { runAutotuneV2, type AutotuneLogInput } from "../../src/gyrocore/engine/autotuneV2";
import { MAX_STEP, searchGrid } from "../../src/gyrocore/engine/pidOptimizer";
import { TARGET_SEARCH } from "../../src/gyrocore/engine/candidateDecision";
import { experimentalWriteDecision } from "../../src/gyrocore/releaseGate/experimentalAuthority";
import type { ExperimentalProposal } from "../../src/gyrocore/engine/experimentalProposal";
import { useAutotuneV2Store } from "../../src/gyrocore/stores/autotuneV2";
import { closedLoopChirpLog, ratePlant } from "./harness/closedLoopBbl";

// --- combineRecordings on constructed estimates -------------------------------------------------

const FS = 1000;
const N = 100; // 10 Hz bins
const SWEEP = { f0Hz: 1, f1Hz: 200, durationS: 600 }; // long dwell: every bin 10–190 Hz has averages
const ANALYSIS = { segmentSamples: N, sampleRateHz: FS, windowSamples: 600_000, segments: 11_999 };

function estimate(o: {
    gain?: (f: number) => number;
    coherence?: (f: number) => number;
    segmentSamples?: number;
}): TransferFunction {
    const n = Math.floor((o.segmentSamples ?? N) / 2) + 1;
    const step = FS / (o.segmentSamples ?? N);
    const tf: TransferFunction = {
        frequencies: new Float64Array(n),
        magnitude: new Float64Array(n),
        phase: new Float64Array(n),
        coherence: new Float64Array(n),
        hReal: new Float64Array(n),
        hImag: new Float64Array(n),
        numSegments: 11_999,
    };
    for (let k = 0; k < n; k++) {
        const f = k * step;
        // H = g / (1 + j f/30): a smooth first-order response.
        const g = o.gain?.(f) ?? 1;
        const d = 1 + (f / 30) ** 2;
        tf.frequencies[k] = f;
        tf.hReal[k] = g / d;
        tf.hImag[k] = (-g * (f / 30)) / d;
        tf.magnitude[k] = 20 * Math.log10(Math.hypot(tf.hReal[k], tf.hImag[k]));
        tf.phase[k] = (Math.atan2(tf.hImag[k], tf.hReal[k]) * 180) / Math.PI;
        tf.coherence[k] = f > 0 ? (o.coherence?.(f) ?? 0.95) : 0;
    }
    return tf;
}

function supportOf(tf: TransferFunction, unsupported: number[] = []): FrequencySupport {
    return {
        observedHz: [1, 200],
        bins: new Map(
            [...tf.frequencies].map((f) => [
                f,
                {
                    class: "COHERENT",
                    excitationCoherence: unsupported.includes(f) ? 0.1 : 0.99,
                    verdict: unsupported.includes(f) ? "UNSUPPORTED" : "SUPPORTED",
                },
            ]),
        ) as FrequencySupport["bins"],
    };
}

function rung(
    sha: string,
    tf: TransferFunction,
    unsupported: number[] = [],
    windowSamples = ANALYSIS.windowSamples,
): RecordingRung {
    return {
        log: { sha256: sha, logIndex: 0 } as AutotuneLogInput,
        tf,
        analysis: { ...ANALYSIS, segmentSamples: (tf.frequencies.length - 1) * 2, windowSamples },
        sweep: SWEEP,
        support: supportOf(tf, unsupported),
    };
}

const at = (tf: TransferFunction, hz: number) => [...tf.frequencies].indexOf(hz);

describe("combineRecordings: the other flight's values only where it measured the same thing", () => {
    it("agreeing flights are pooled: values weighted by averages, averages summed, nothing else changed", () => {
        const a = rung("a", estimate({}));
        const b = rung("b", estimate({ gain: () => 1.0005 }));
        const c = combineRecordings("roll", a, [b], 0.8);
        expect(c.consistent).toBe(true);
        expect(c.medianZ!).toBeLessThan(RECORDING_AGREEMENT.maxAxisMedianZ);
        expect(c.contributors).toEqual(["b:0"]);
        const k = at(a.tf, 50);
        expect(c.bins.find((x) => x.frequencyHz === 50)!.use).toBe("pooled");
        // Equal dwell on both: the mean of the two.
        expect(c.tf!.hReal[k]).toBeCloseTo((a.tf.hReal[k] + b.tf.hReal[k]) / 2, 12);
        const own = sweepAverages(50, a.analysis, SWEEP, a.analysis.windowSamples);
        expect(own).toBeGreaterThan(1);
        expect(c.averagesByHz.get(50)).toBe(2 * own);
        // The primary's own arrays are not touched.
        expect(a.tf.hReal[k]).not.toBe(c.tf!.hReal[k]);
    });

    it("a bin where the flights disagree keeps the primary's value and averages, and is named", () => {
        const a = rung("a", estimate({}));
        const b = rung("b", estimate({ gain: (f) => (f === 50 ? 1.1 : 1.0005) }));
        const c = combineRecordings("roll", a, [b], 0.8);
        expect(c.consistent).toBe(true);
        const bin = c.bins.find((x) => x.frequencyHz === 50)!;
        expect(bin.use).toBe("disagree_primary_kept");
        expect(bin.z!).toBeGreaterThan(RECORDING_AGREEMENT.maxBinZ);
        expect(c.tf!.hReal[at(a.tf, 50)]).toBe(a.tf.hReal[at(a.tf, 50)]);
        expect(c.averagesByHz.has(50)).toBe(false);
    });

    it("a hole of the primary is filled only by a flight that identifies the bin itself, with its support", () => {
        const a = rung("a", estimate({ coherence: (f) => (f === 70 || f === 80 ? 0.5 : 0.95) }));
        const b = rung("b", estimate({ gain: () => 1.0005, coherence: (f) => (f === 80 ? 0.6 : 0.95) }));
        const c = combineRecordings("roll", a, [b], 0.8);
        expect(c.bins.find((x) => x.frequencyHz === 70)!.use).toBe("other_flight");
        expect(c.tf!.coherence[at(a.tf, 70)]).toBe(0.95);
        expect(c.tf!.hReal[at(a.tf, 70)]).toBe(b.tf.hReal[at(b.tf, 70)]);
        expect(c.support!.bins.get(70)).toBe(b.support!.bins.get(70));
        // Neither identifies 80 Hz: it stays a hole, nothing interpolated.
        expect(c.bins.find((x) => x.frequencyHz === 80)!.use).toBe("not_filled");
        expect(c.tf!.coherence[at(a.tf, 80)]).toBe(0.5);
        expect(c.tf!.hReal[at(a.tf, 80)]).toBe(a.tf.hReal[at(a.tf, 80)]);
    });

    it("the other flight's unsupported bin fills nothing", () => {
        const a = rung("a", estimate({ coherence: (f) => (f === 70 ? 0.5 : 0.95) }));
        const b = rung("b", estimate({ gain: () => 1.0005 }), [70]);
        const c = combineRecordings("roll", a, [b], 0.8);
        expect(c.bins.find((x) => x.frequencyHz === 70)!.use).toBe("not_filled");
        expect(c.tf!.coherence[at(a.tf, 70)]).toBe(0.5);
    });

    it("flights that disagree over the axis are not combined at all", () => {
        const a = rung("a", estimate({ coherence: (f) => (f === 70 ? 0.5 : 0.95) }));
        const b = rung("b", estimate({ gain: () => 1.1 }));
        const c = combineRecordings("roll", a, [b], 0.8);
        expect(c.consistent).toBe(false);
        expect(c.medianZ!).toBeGreaterThan(RECORDING_AGREEMENT.maxAxisMedianZ);
        expect(c.tf).toBeNull();
        expect(c.contributors).toEqual([]);
        expect(c.rejected[0]).toMatch(/^multi_recording_flights_disagree:roll:median_z:/);
    });

    it("another analysis grid, or too few bins both identify: no combination, named", () => {
        const a = rung("a", estimate({}));
        const g = combineRecordings("roll", a, [rung("b", estimate({ segmentSamples: 200 }))], 0.8);
        expect(g.tf).toBeNull();
        expect(g.rejected[0]).toMatch(/^multi_recording_grid_differs:roll:b:0$/);
        const few = combineRecordings(
            "roll",
            a,
            [rung("b", estimate({ coherence: (f) => (f <= 30 ? 0.95 : 0.3) }))],
            0.8,
        );
        expect(few.consistent).toBeNull();
        expect(few.tf).toBeNull();
        expect(few.rejected[0]).toMatch(/^multi_recording_too_few_common_bins:roll:3:/);
    });

    it("order symmetry: complementary holes give the same identified bins and the same values there", () => {
        const A = estimate({ coherence: (f) => (f === 70 ? 0.5 : 0.95) });
        const B = estimate({ gain: () => 1.0005, coherence: (f) => (f === 30 ? 0.5 : 0.95) });
        const ab = combineRecordings("roll", rung("a", A), [rung("b", B)], 0.8);
        const ba = combineRecordings("roll", rung("b", B), [rung("a", A)], 0.8);
        const identified = (tf: TransferFunction) => [...tf.frequencies].filter((_, k) => tf.coherence[k] >= 0.8);
        expect(identified(ab.tf!)).toEqual(identified(ba.tf!));
        for (const hz of [30, 70]) {
            expect(ab.tf!.hReal[at(A, hz)]).toBe(ba.tf!.hReal[at(B, hz)]);
            expect(ab.tf!.hImag[at(A, hz)]).toBe(ba.tf!.hImag[at(B, hz)]);
        }
        // Pooled bins: the same weighted mean either way.
        expect(ab.tf!.hReal[at(A, 50)]).toBeCloseTo(ba.tf!.hReal[at(B, 50)], 12);
    });
});

describe("combineRecordings with several flights and unequal averages (block 8 review)", () => {
    it("each flight is judged against the primary's own measurement; a later disagreeing flight does not hide an earlier one", () => {
        const a = rung("a", estimate({ coherence: (f) => (f === 70 ? 0.5 : 0.95) }));
        const agree = estimate({ gain: () => 1.0005 });
        const contra = estimate({ gain: () => 1.6 });
        // Sorted by id: the agreeing flight first, then the contradicting one, and the other way round.
        const one = combineRecordings("roll", a, [rung("b", agree), rung("c", contra)], 0.8);
        const two = combineRecordings("roll", a, [rung("0", contra), rung("b", agree)], 0.8);
        for (const c of [one, two]) {
            expect(c.contributors).toEqual(["b:0"]);
            expect(c.consistent).toBe(true);
            expect(c.flights.find((x) => x.id === "b:0")!.verdict).toBe("used");
            expect(c.flights.find((x) => x.id !== "b:0")!.verdict).toBe("disagrees");
            expect(c.rejected.some((x) => x.startsWith("multi_recording_flights_disagree:roll"))).toBe(true);
            expect(c.bins.find((x) => x.frequencyHz === 70)!.use).toBe("other_flight");
            // The median shown is the used flight's, not the rejected one's.
            expect(c.medianZ!).toBeLessThan(RECORDING_AGREEMENT.maxAxisMedianZ);
        }
        // The order of the other flights does not change the combined estimate.
        expect([...one.tf!.hReal]).toEqual([...two.tf!.hReal]);
        expect([...one.tf!.coherence]).toEqual([...two.tf!.coherence]);
    });

    it("a bin both identify but only one with whole-segment averages takes that flight's estimate, in either order", () => {
        // 1 Hz bins; the short window has no whole-segment dwell above ≈ 14 Hz (the sweep is past it).
        const fine = 1000;
        const full = estimate({ segmentSamples: fine });
        const short = estimate({ segmentSamples: fine, gain: () => 1.0005 });
        const A = rung("a", full);
        const B = rung("b", short, [], 300_000);
        const k50 = at(full, 50);
        expect(sweepAverages(50, A.analysis, SWEEP, A.analysis.windowSamples)).toBeGreaterThan(0);
        expect(sweepAverages(50, B.analysis, SWEEP, B.analysis.windowSamples)).toBe(0);
        const ab = combineRecordings("roll", A, [B], 0.8);
        const ba = combineRecordings("roll", B, [A], 0.8);
        expect(ab.consistent).toBe(true);
        expect(ba.consistent).toBe(true);
        // Both ways the 50 Hz bin carries the long flight's value and its averages.
        const valueAt50 = (c: typeof ab, prim: TransferFunction) => (c.tf ?? prim).hReal[k50];
        expect(valueAt50(ab, full)).toBe(full.hReal[k50]);
        expect(valueAt50(ba, short)).toBe(full.hReal[k50]);
        expect(ba.bins.find((x) => x.frequencyHz === 50)!.use).toBe("other_flight");
        expect(ba.averagesByHz.get(50)).toBe(sweepAverages(50, A.analysis, SWEEP, A.analysis.windowSamples));
    });
});

describe("combineRecordings: the same result whatever the order of the other flights (block 8 review round 2)", () => {
    // `others` is sorted by recording id inside, so the order is flipped through the ids, never the array.
    const same = (x: ReturnType<typeof combineRecordings>, y: ReturnType<typeof combineRecordings>) => {
        expect(x.tf && [...x.tf.hReal]).toEqual(y.tf && [...y.tf.hReal]);
        expect(x.tf && [...x.tf.hImag]).toEqual(y.tf && [...y.tf.hImag]);
        expect(x.tf && [...x.tf.coherence]).toEqual(y.tf && [...y.tf.coherence]);
        expect([...x.averagesByHz].sort()).toEqual([...y.averagesByHz].sort());
        expect(x.support && [...x.support.bins].sort()).toEqual(y.support && [...y.support.bins].sort());
        const ids = (b: (typeof x.bins)[number]) => ({
            ...b,
            flights: b.flights.length,
            disagreeing: b.disagreeing.length,
        });
        expect(x.bins.map(ids)).toEqual(y.bins.map(ids));
    };

    it("a hole two consistent flights disagree on is not filled, in either order (probe A)", () => {
        const a = rung("a", estimate({ coherence: (f) => (f === 70 ? 0.5 : 0.95) }));
        const b = estimate({ gain: () => 1.0005 });
        const c = estimate({ gain: (f) => (f === 70 ? 1.6 : 1.0005) });
        const one = combineRecordings("roll", a, [rung("b", b), rung("c", c)], 0.8);
        const two = combineRecordings("roll", a, [rung("b", b), rung("0", c)], 0.8);
        same(one, two);
        for (const r of [one, two]) {
            // Both pass the axis gate; at 70 Hz neither is preferred: the primary's (unidentified) value stays.
            expect(r.flights.map((x) => x.verdict)).toEqual(["used", "used"]);
            const bin = r.bins.find((x) => x.frequencyHz === 70)!;
            expect(bin.use).toBe("others_disagree");
            expect(bin.z!).toBeGreaterThan(RECORDING_AGREEMENT.maxBinZ);
            expect(bin.disagreeing).toHaveLength(2);
            expect(r.tf!.hReal[at(a.tf, 70)]).toBe(a.tf.hReal[at(a.tf, 70)]);
            expect(r.tf!.coherence[at(a.tf, 70)]).toBe(0.5);
            expect(r.averagesByHz.has(70)).toBe(false);
        }
    });

    it("a hole two agreeing flights identify is filled with both, pooled by their averages (probe A, agreeing)", () => {
        const a = rung("a", estimate({ coherence: (f) => (f === 70 ? 0.5 : 0.95) }));
        const b = estimate({ gain: () => 1.0005 });
        const c = estimate({ gain: () => 1.001 });
        const one = combineRecordings("roll", a, [rung("b", b), rung("c", c)], 0.8);
        const two = combineRecordings("roll", a, [rung("b", b), rung("0", c)], 0.8);
        same(one, two);
        const k = at(a.tf, 70);
        const bin = one.bins.find((x) => x.frequencyHz === 70)!;
        expect(bin.use).toBe("other_flight");
        expect(bin.flights).toHaveLength(2);
        // Equal averages: the mean of both, and their averages summed.
        expect(one.tf!.hReal[k]).toBeCloseTo((b.hReal[k] + c.hReal[k]) / 2, 12);
        const n70 = sweepAverages(70, a.analysis, SWEEP, a.analysis.windowSamples);
        expect(one.averagesByHz.get(70)).toBe(2 * n70);
    });

    it("a bin the primary has without averages takes both agreeing flights, in either order (probe B)", () => {
        const fine = 1000;
        const short = estimate({ segmentSamples: fine });
        const A1 = estimate({ segmentSamples: fine, gain: () => 1.0005 });
        const A2 = estimate({ segmentSamples: fine, gain: () => 1.001 });
        const P = rung("p", short, [], 300_000);
        const one = combineRecordings("roll", P, [rung("x1", A1), rung("x2", A2)], 0.8);
        const two = combineRecordings("roll", P, [rung("x2", A1), rung("x1", A2)], 0.8);
        same(one, two);
        const k = at(short, 50);
        const n50 = sweepAverages(50, rung("x", A1).analysis, SWEEP, ANALYSIS.windowSamples);
        expect(one.bins.find((x) => x.frequencyHz === 50)!.use).toBe("other_flight");
        expect(one.averagesByHz.get(50)).toBe(2 * n50);
        expect(one.tf!.hReal[k]).toBeCloseTo((A1.hReal[k] + A2.hReal[k]) / 2, 12);
    });

    it("a bin the primary identifies is pooled with the agreeing flight and names the disagreeing one, in either order", () => {
        const a = rung("a", estimate({}));
        const b = estimate({ gain: () => 1.0005 });
        const c = estimate({ gain: (f) => (f === 70 ? 1.6 : 1.0005) });
        const one = combineRecordings("roll", a, [rung("b", b), rung("c", c)], 0.8);
        const two = combineRecordings("roll", a, [rung("b", b), rung("0", c)], 0.8);
        same(one, two);
        for (const [r, cId] of [
            [one, "c:0"],
            [two, "0:0"],
        ] as const) {
            const bin = r.bins.find((x) => x.frequencyHz === 70)!;
            expect(bin.use).toBe("pooled");
            expect(bin.flights).toEqual(["b:0"]);
            expect(bin.disagreeing).toEqual([cId]);
            const k = at(a.tf, 70);
            expect(r.tf!.hReal[k]).toBeCloseTo((a.tf.hReal[k] + b.hReal[k]) / 2, 12);
        }
    });
});

// --- the engine on simulated flights ------------------------------------------------------------

function decoded(o: Parameters<typeof closedLoopChirpLog>[0], name: string): AutotuneLogInput {
    const bytes = closedLoopChirpLog(o);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const [log] = buildLogInputs(bytes, sha, qualifyChirpFile(bytes, name, 45, AUTOTUNE_MATH), null);
    return log;
}

describe("the experimental decision with a second flight (engine, simulated)", () => {
    const G = ratePlant({ K: 60, motorHz: 40, delayS: 0.002 });
    // The block 6 fixture: an excitation hole at 10–20 Hz leaves three unsupported decision-band bins.
    // 40 s sweeps: enough whole-segment dwell that the flights can be compared on ≥ 5 bins.
    const holed = decoded(
        { plants: [G, null, null], sweepS: 40, seed: 141, noise: 0.3, envelope: (f) => (f >= 10 && f <= 20 ? 0 : 1) },
        "holed.bbl",
    );
    const clean = decoded(
        {
            plants: [G, null, null],
            sweepS: 40,
            seed: 142,
            noise: 0.3,
            startTimeUs: 9_000_000,
            envelope: (f) => (f >= 30 && f <= 34 ? 0 : 1),
        },
        "clean.bbl",
    );
    const run = (primary: AutotuneLogInput, others: AutotuneLogInput[]) =>
        runAutotuneV2({ primary, others, verifiedTune: null, createdAt: "2026-11-08T00:00:00Z" });

    it("alone the holed flight stops at its holes; with an agreeing flight they are filled from it, in either order", () => {
        const aloneRun = run(holed, []);
        const alone = aloneRun.candidateDecisions.roll!.primary!;
        expect(alone.status).toBe("plant_band_insufficient");
        expect(alone.checks.find((c) => c.rule === "decision_band_gaps")!.result).toBe("fail");

        const abRun = run(holed, [clean]);
        const ab = abRun.candidateDecisions.roll!.primary!;
        // The release route rests on the primary's own measurement only (block 8): another flight
        // changes neither its margins, their uncertainty and averages, nor what it releases. It is
        // used there only as a between-flight repeatability check (crossLogPlant), never as data.
        const ownOnly = (m: unknown) =>
            JSON.parse(
                JSON.stringify(m, (k, v) =>
                    k === "repeatability"
                        ? undefined
                        : k === "unknown" && Array.isArray(v)
                          ? v.filter((x) => x !== "repeatability_between_flights")
                          : v,
                ),
            );
        expect(ownOnly(abRun.margins.roll)).toEqual(ownOnly(aloneRun.margins.roll));
        expect(abRun.releasableProposal).toEqual(aloneRun.releasableProposal);
        expect(abRun.multiRecording.contributors).toEqual(ab.combination!.flights);
        // The result names the flight it rests on and the measurement it read (the overview shows that one).
        expect(holed.chirp.roll!.measurementId).toBeTruthy();
        expect(abRun.primarySource).toEqual({
            sha256: holed.sha256,
            logIndex: holed.logIndex,
            measurementIds: { roll: holed.chirp.roll!.measurementId },
        });
        const ba = run(clean, [holed]).candidateDecisions.roll!.primary!;
        expect(ab.combination!.consistent).toBe(true);
        // The holed flight's unsupported bins come from the clean flight, with its support.
        expect(ab.combination!.otherFlightHz).toEqual(expect.arrayContaining([13.671875, 15.625, 17.578125]));
        expect(ab.checks.find((c) => c.rule === "decision_band_gaps")).toMatchObject({ value: 0, result: "pass" });
        expect(ab.checks.find((c) => c.rule === "decision_band_support")!.result).toBe("pass");
        // The same decision whichever flight is the primary.
        expect(ab.status).toBe(ba.status);
        expect(ab.checks.find((c) => c.rule === "multi_recording_combination")!.result).toBe("pass");
        // The combination never becomes the first cause, and the release route stays untouched by it.
        expect(ab.firstCause?.rule ?? null).not.toBe("multi_recording_combination");
    }, 240_000);

    it("a flight of another plant contradicts: no combination, the holes stay, the reason is named", () => {
        const other = decoded(
            {
                plants: [ratePlant({ K: 90, motorHz: 40, delayS: 0.002 }), null, null],
                sweepS: 40,
                seed: 143,
                noise: 0.3,
                startTimeUs: 9_000_000,
            },
            "other.bbl",
        );
        const r = run(holed, [other]);
        const d = r.candidateDecisions.roll!.primary!;
        expect(d.combination!.consistent).toBe(false);
        expect(d.combination!.rejected.some((x) => x.startsWith("multi_recording_flights_disagree:roll"))).toBe(true);
        expect(d.status).toBe("plant_band_insufficient");
        expect(d.checks.find((c) => c.rule === "decision_band_gaps")!.result).toBe("fail");
        const roll = r.recordingPlan.axes.find((a) => a.axis === "roll")!;
        expect(roll.kind).toBe("record");
        expect(roll.note).toContain("Other flights not combined on this axis: multi_recording_flights_disagree:roll");
    }, 240_000);
});

describe("the wider search without a target: its bounds named only when they limit it (engine, simulated)", () => {
    const decide = (K: number, delayS: number, name: string) => {
        const log = decoded(
            {
                plants: [ratePlant({ K, motorHz: 40, delayS }), null, null],
                sweepS: 12,
                seed: 141,
                noise: 0.3,
                envelope: (f) => (f >= 30 && f <= 34 ? 0 : 1),
            },
            name,
        );
        return runAutotuneV2({ primary: log, others: [], verifiedTune: null, createdAt: "2026-11-08T00:00:00Z" })
            .candidateDecisions.roll!.primary!;
    };

    it("best on the edge of the wider bounds: target_search_limit, the bounds and why P/I stop at ×0.4 are named", () => {
        const d = decide(60, 0.004, "edge.bbl");
        expect(d.status).toBe("target_search_limit");
        expect(d.target!.target).toBeNull();
        expect(d.target!.bestOnEdge).toBe(true);
        expect(d.target!.best!.values.p).toBe(Math.round(d.candidate!.current.p * TARGET_SEARCH.pScale[0]));
        expect(d.candidate!.reasons).toContain("search_limit:target_search_bounds");
        expect(d.checks.find((c) => c.rule === "target_search_wider_bounds")!.consequence).toContain(
            "the bounds limit the search",
        );
    }, 240_000);

    it("best inside the wider bounds: targets_not_reachable, a larger step is not what is missing", () => {
        const d = decide(150, 0.004, "inside.bbl");
        expect(d.status).toBe("targets_not_reachable");
        expect(d.target!.target).toBeNull();
        expect(d.target!.bestOnEdge).toBe(false);
        expect(d.candidate!.reasons).toContain("no_candidate_meets_all_targets");
    }, 240_000);
});

describe("target search beyond one Apply (engine, simulated)", () => {
    // A loop with too much gain for its delay: nothing within ±30 % meets the targets, a farther P does.
    const log = decoded(
        {
            plants: [ratePlant({ K: 120, motorHz: 40, delayS: 0.0012 }), null, null],
            sweepS: 12,
            seed: 141,
            noise: 0.3,
            envelope: (f) => (f >= 30 && f <= 34 ? 0 : 1),
        },
        "far.bbl",
    );
    const r = runAutotuneV2({ primary: log, others: [], verifiedTune: null, createdAt: "2026-11-08T00:00:00Z" });
    const d = r.candidateDecisions.roll!.primary!;

    it("the target lies beyond ±30 %; the first step is read on its own margins and not offered when it misses", () => {
        expect(d.status).toBe("target_beyond_max_step");
        const t = d.target!;
        expect(t.pScale).toEqual(TARGET_SEARCH.pScale);
        expect(t.target!.meetsTargets).toBe(true);
        // Farther than one Apply on at least one term.
        expect(Math.max(...Object.values(t.target!.change).map(Math.abs))).toBeGreaterThan(MAX_STEP + 0.01);
        // The step: every term within ±30 % of the current value, on the way to the target.
        const cur = d.candidate!.current;
        for (const k of ["p", "i", "d"] as const) {
            expect(Math.abs(t.step!.values[k] - cur[k])).toBeLessThanOrEqual(MAX_STEP * cur[k] + 0.5);
            expect(Math.sign(t.step!.values[k] - cur[k])).toBe(Math.sign(t.target!.values[k] - cur[k]));
        }
        expect(t.step!.meetsTargets).toBe(false);
        // The step is a point of the ±30 % grid (P, I and D each clipped to its edges on their own scale,
        // d_max on D's scale; block 11): a step meeting the targets would have been the grid's candidate,
        // so this status always means the step misses them.
        expect([...searchGrid(cur, null)]).toContainEqual(t.step!.values);
        expect(d.checks.find((c) => c.rule === "target_search_wider_bounds")!.result).toBe("fail");
        // Nothing for roll in the experimental proposal: neither the target nor the step.
        expect(r.experimental?.items.some((i) => i.key.endsWith("_roll")) ?? false).toBe(false);
        expect(r.recordingPlan.axes.find((a) => a.axis === "roll")!.note).toContain("lies beyond one Apply");
    }, 240_000);

    it("an experimental proposal changed to the target values is refused by the write authority (step too large)", () => {
        // A real experimental proposal (a clean flight with a candidate) whose P is set to a value
        // farther than one Apply, as a target would be: the write authority's own step check refuses it.
        const clean = decoded(
            {
                plants: [ratePlant({ K: 60, motorHz: 40, delayS: 0.002 }), null, null],
                sweepS: 12,
                seed: 141,
                noise: 0.3,
                envelope: (f) => (f >= 30 && f <= 34 ? 0 : 1),
            },
            "clean12.bbl",
        );
        const rc = runAutotuneV2({ primary: clean, others: [], verifiedTune: null, createdAt: "2026-11-08T00:00:00Z" });
        setActivePinia(createPinia());
        const store = useAutotuneV2Store();
        store.state = "done";
        store.result = rc;
        const x = rc.experimental!;
        const from = x.items.find((i) => i.key === "p_roll")!.from as number;
        const far = Math.round(from * (1 - (MAX_STEP + 0.26)));
        const tampered = {
            ...x,
            items: x.items.map((i) => (i.key === "p_roll" ? { ...i, to: far } : i)),
            proposal: {
                ...x.proposal,
                change: { ...x.proposal.change, p_roll: far },
                items: x.proposal.items.map((i) => (i.key === "p_roll" ? { ...i, to: far } : i)),
            },
        } as ExperimentalProposal;
        const decision = experimentalWriteDecision(tampered, { recompute: false });
        expect(decision.verdict).toBe("EXPERIMENTAL_APPLY_DENIED");
        expect(decision.steps.find((st) => st.name === "values_technical")!.reasons).toContain(
            `plausible_step:step_too_large:p_roll:${from}->${far}`,
        );
    }, 240_000);
});
