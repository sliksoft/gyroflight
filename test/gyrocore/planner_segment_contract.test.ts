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
 * The qualification segment contract (planner safety repair 2026-10-28; qualificationRung.ts).
 *
 * The planner sized the qualification sweep for the smallest power-of-two segment resolving
 * RESOLVED_FEATURE_BINS × finer than the primary, but the engine read the qualification flight with
 * the LONGEST segment its window allows: on the planned 5-inch-like qualification flight (922 s)
 * that was 131 072 samples, swept through each bin in a thousandth of its length. Planner and engine
 * now use one rule, and the engine reads the qualification on that rung only.
 *
 * SIMULATION: rate plants and the synthetic Blackbox harness; software-contract evidence only.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
    coherentShare,
    QUALIFICATION_COHERENT_SHARE,
    qualificationSegmentSamples,
    selectQualificationRung,
} from "../../src/gyrocore/engine/qualificationRung";
import { RESOLVED_FEATURE_BINS } from "../../src/gyrocore/engine/loopModel";
import type { AnalysisOption } from "../../src/gyrocore/engine/adaptiveResolution";
import { buildLogInputs, finestWelchSegment } from "../../src/gyrocore/engine/logInput";
import { runAutotuneV2, type AutotuneLogInput } from "../../src/gyrocore/engine/autotuneV2";
import { assessModelQualification } from "../../src/gyrocore/engine/modelQualification";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { closedLoopChirpLog, ratePlant, type ClosedLoopLogOptions } from "./harness/closedLoopBbl";

const rung = (segment: number, fs: number, coherence = 0.99): AnalysisOption => {
    const bins = segment / 2 + 1;
    const frequencies = Float64Array.from({ length: bins }, (_, k) => (k * fs) / segment);
    const z = () => new Float64Array(bins);
    return {
        tf: {
            frequencies,
            magnitude: z(),
            phase: z(),
            coherence: Float64Array.from({ length: bins }, () => coherence),
            hReal: z(),
            hImag: z(),
            numSegments: 8,
        },
        analysis: { segmentSamples: segment, sampleRateHz: fs, windowSamples: segment * 5, segments: 8 },
    };
};
const SWEEP = { f0Hz: 1, f1Hz: 200, durationS: 20 };

describe("one rule for planner and engine", () => {
    it("the smallest power of two resolving RESOLVED_FEATURE_BINS × finer than the primary rung", () => {
        // 1 kHz, primary 1024 (0.977 Hz): needs ≤ 0.2165 Hz → 8192 (0.122 Hz); 4096 (0.244 Hz) is not enough.
        expect(qualificationSegmentSamples(1000 / 1024, 1000)).toBe(8192);
        expect(1000 / 8192).toBeLessThanOrEqual(1000 / 1024 / RESOLVED_FEATURE_BINS);
        expect(1000 / 4096).toBeGreaterThan(1000 / 1024 / RESOLVED_FEATURE_BINS);
        // A primary at 4 kHz, qualification logged at 1 kHz: judged in Hz, not in samples.
        expect(qualificationSegmentSamples(4000 / 2048, 1000)).toBe(4096);
        expect(qualificationSegmentSamples(0, 1000)).toBeNull();
        expect(qualificationSegmentSamples(Number.NaN, 1000)).toBeNull();
    });

    it("the engine takes that rung from the ladder, never a longer one", () => {
        const primary = rung(1024, 1000).analysis;
        const ladder = [512, 1024, 2048, 4096, 8192, 16384, 131072].map((n) => rung(n, 1000));
        const sel = selectQualificationRung(ladder, primary, SWEEP);
        expect(sel.reasons).toEqual([]);
        expect(sel.rung!.analysis.segmentSamples).toBe(8192);
        expect(sel.segmentSamples).toBe(8192);
    });

    it("a ladder without that rung, or with it incoherent, is named and leaves the qualification out", () => {
        const primary = rung(1024, 1000).analysis;
        const short = selectQualificationRung(
            [512, 1024, 2048, 4096].map((n) => rung(n, 1000)),
            primary,
            SWEEP,
        );
        expect(short.rung).toBeNull();
        expect(short.reasons).toEqual(["qualification_segment_not_available:needs:8192:finest:4096"]);
        const incoherent = selectQualificationRung([rung(8192, 1000, 0.5)], primary, SWEEP);
        expect(incoherent.rung).toBeNull();
        expect(incoherent.reasons[0]).toBe("qualification_rung_not_coherent:8192:0pct");
        expect(coherentShare(rung(8192, 1000, 0.5).tf, SWEEP)).toBeLessThan(QUALIFICATION_COHERENT_SHARE);
        expect(selectQualificationRung(undefined, primary, SWEEP).reasons).toEqual([
            "qualification_resolution_ladder_missing",
        ]);
        expect(selectQualificationRung([rung(8192, 1000)], null, SWEEP).reasons).toEqual([
            "qualification_primary_analysis_unknown",
        ]);
    });
});

function decoded(o: ClosedLoopLogOptions, name: string): AutotuneLogInput {
    const bytes = closedLoopChirpLog(o);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const [log] = buildLogInputs(bytes, sha, qualifyChirpFile(bytes, name, 45, AUTOTUNE_MATH), null);
    expect(log, name).toBeDefined();
    return log;
}

describe("regression: the planned 5-inch-like qualification flight (922 s) is read on the contract rung", () => {
    // SIMULATION: the 5-inch-like rate plant (assumption) and the qualification sweep the planner asked
    // for before this contract (3.906 … 240.234 Hz, 922.155 s).
    const G = ratePlant({ K: 45, motorHz: 25, delayS: 0.003 });
    const QSWEEP = { startHz: 3.906, endHz: 240.234, sweepS: 922.155 };

    it("the engine reads it on 8 × the primary's rung, not on the finest segment its window allows", () => {
        const primary = decoded({ plants: [G, null, null], noise: 0.3, seed: 11 }, "five-primary");
        const qual = decoded(
            { plants: [G, null, null], noise: 0.3, seed: 302, ...QSWEEP, startTimeUs: 9_000_000 },
            "five-q",
        );
        const primaryRun = runAutotuneV2({
            primary,
            others: [],
            verifiedTune: null,
            createdAt: "2026-10-28T00:00:00Z",
        });
        const primaryRung = primaryRun.margins.roll!.current.evidence.convergence!.usedSegmentSamples;
        const expected = qualificationSegmentSamples(1000 / primaryRung, 1000)!;
        // The planner names the same segment for the qualification of this primary.
        expect(primaryRun.measurementPlan.find((p) => p.axis === "roll")!.segmentSamples.qualification).toBe(expected);
        // The finest segment of this window is far longer: the old behaviour.
        const finest = finestWelchSegment(qual.chirp.roll!.end - qual.chirp.roll!.start)!;
        expect(finest).toBeGreaterThanOrEqual(16 * expected);
        expect(qual.chirp.roll!.analyses!.some((r) => r.analysis.segmentSamples === expected)).toBe(true);

        const { result, report } = assessModelQualification({
            primary,
            others: [qual],
            verifiedTune: null,
            createdAt: "2026-10-28T00:00:00Z",
        });
        const q = result!.margins.roll!.current.evidence.qualification;
        const rejected = report.candidates.flatMap((c) => c.rejected);
        // This planned flight is refused, by name, on the contract rung: at 8192 samples its bins are only
        // ~76 % coherent over the sweep (QUALIFICATION_COHERENT_SHARE 80 %). The rung named is the rung
        // judged; the finest segment is never examined.
        expect(q).toBeNull();
        expect(report.source).toBeNull();
        expect(rejected.some((r) => r.startsWith(`qualification_rung_not_coherent:${expected}:`))).toBe(true);
        expect(rejected.some((r) => r.includes(`:${finest}:`))).toBe(false);
        // Whatever the qualification, nothing is released: no Verified Tune, and the qualification run
        // is informative only (never the analysis Apply binds to).
        expect(report.connectedToApply).toBe(false);
        expect(result!.releasableProposal).toBeNull();
    }, 600_000);
});
