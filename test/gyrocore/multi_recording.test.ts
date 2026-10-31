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
 * Multi-recording average aggregation: independent claims sum; duplicates and mismatches do not.
 * SIMULATION only.
 */

import { describe, expect, it } from "vitest";
import {
    aggregateAverageClaims,
    averageClaimAt,
    collectMultiRecordingAverages,
    multiRecordingIssues,
    transferFunctionValuesIdentical,
    type RecordingAverageClaim,
} from "../../src/gyrocore/engine/multiRecording";
import { syntheticIdentityLog, syntheticLogInput } from "./harness/syntheticLog";

const ANALYSIS = { segmentSamples: 512, sampleRateHz: 4000, windowSamples: 80_000, segments: 18 };
const SWEEP = { f0Hz: 1, f1Hz: 200, durationS: 20 };

describe("aggregateAverageClaims", () => {
    it("sums independent recordings with identical settings; rejects duplicate sha only", () => {
        const a: RecordingAverageClaim = {
            id: "a:0",
            sha256: "a".repeat(64),
            logIndex: 0,
            hz: 26,
            averages: 9,
            contentKey: "a".repeat(64),
        };
        // Same acquisition settings / average count as `a`, different sample identity.
        const b: RecordingAverageClaim = {
            id: "b:0",
            sha256: "b".repeat(64),
            logIndex: 0,
            hz: 26,
            averages: 9,
            contentKey: "b".repeat(64),
        };
        const dupSha: RecordingAverageClaim = { ...a, id: "a:1", logIndex: 1, averages: 9 };
        const r = aggregateAverageClaims(26, [a, b, dupSha]);
        expect(r.averages).toBe(18);
        expect(r.contributors).toEqual(["a:0", "b:0"]);
        expect(r.rejected).toEqual(["duplicate_sha256:a:1"]);
    });

    it("averageClaimAt returns null when the window holds no whole segment at hz", () => {
        // Identity fixture: only the claim window matters; no full-chain dwell needed.
        const log = syntheticIdentityLog("d".repeat(64));
        // Short window on a long header: high-frequency dwell never observed.
        const short = { ...ANALYSIS, windowSamples: 2_000 };
        expect(averageClaimAt(log, 100, short, { f0Hz: 1, f1Hz: 200, durationS: 86_400 })).toBeNull();
    });
});

describe("multiRecordingIssues", () => {
    it("the same log cannot contribute twice; an independent synthetic flight is accepted by identity rules", () => {
        // Identity helpers: flightRelation / same-log rules, not Welch dwell.
        const a = syntheticIdentityLog("e".repeat(64));
        const b = syntheticIdentityLog("f".repeat(64));
        expect(multiRecordingIssues(a, a)).toContain("multi_recording_same_log");
        // Distinct hashes and sessions: the synthetic logs are independent under flightRelation.
        expect(multiRecordingIssues(a, b)).toEqual([]);
    });
});

const DWELL = {
    seconds: 31,
    welch: { segments: 16, windowS: 30 },
    sweep: { f0Hz: 2, f1Hz: 200, durationS: 30 },
} as const;
const SW = DWELL.sweep;
const sumExtra = (m: Map<number, number>) => [...m.values()].reduce((a, b) => a + b, 0);
const ledgerOf = (p: ReturnType<typeof syntheticLogInput>, others: ReturnType<typeof syntheticLogInput>[]) =>
    collectMultiRecordingAverages(p, others, "roll", p.chirp.roll!.tf.frequencies, p.chirp.roll!.analysis!, SW);

/** Re-export of `src` under another hash; optional closed-loop FRF scale (1 = bit-identical). */
function reexport(
    src: ReturnType<typeof syntheticLogInput>,
    sha: string,
    scale = 1,
): ReturnType<typeof syntheticLogInput> {
    const tf = src.chirp.roll!.tf;
    const tf2 =
        scale === 1
            ? tf
            : {
                  ...tf,
                  hReal: Float64Array.from(tf.hReal, (v) => v * scale),
                  hImag: Float64Array.from(tf.hImag, (v) => v * scale),
              };
    return {
        ...src,
        sha256: sha,
        chirp: { ...src.chirp, roll: { ...src.chirp.roll!, tf: tf2 } },
    };
}

describe("identical closed-loop measurement", () => {
    it("bit-identical FRF values are detected; a shared TF does not add multi-recording averages", () => {
        const primary = syntheticLogInput("a1".repeat(32), DWELL);
        const channels = structuredClone(primary.channels);
        for (const g of channels.gyroAdc as unknown as Float64Array[]) {
            for (let k = 0; k < g.length; k++) g[k] *= 1.37;
        }
        channels.timeUs = Float64Array.from(channels.timeUs, (v) => v + 3_000_000);
        // Same chirp TF by reference (re-identified export); different hash / clock.
        const copy = { ...primary, sha256: "b2".repeat(32), channels };
        expect(transferFunctionValuesIdentical(primary.chirp.roll!.tf, copy.chirp.roll!.tf)).toBe(true);
        expect(multiRecordingIssues(primary, copy)).toEqual([]);
        const ledger = ledgerOf(primary, [copy]);
        expect(ledger.contributors).toEqual([]);
        expect(ledger.rejected.some((r) => r.startsWith("multi_recording_identical_measurement:"))).toBe(true);
        expect(ledger.extraAveragesByHz.size).toBe(0);
    });

    it("sub-ulp H rescale of the primary TF still adds no extras (Grokbot P1b)", () => {
        // External harness: gyro ×1.37, time +3 s, TF ×(1+1e-12) under a new hash — not a new flight.
        const primary = syntheticLogInput("a1".repeat(32), DWELL);
        const channels = structuredClone(primary.channels);
        for (const g of channels.gyroAdc as unknown as Float64Array[]) {
            for (let k = 0; k < g.length; k++) g[k] *= 1.37;
        }
        channels.timeUs = Float64Array.from(channels.timeUs, (v) => v + 3_000_000);
        const tf = primary.chirp.roll!.tf;
        const scaled = {
            ...tf,
            hReal: Float64Array.from(tf.hReal, (v) => v * (1 + 1e-12)),
            hImag: Float64Array.from(tf.hImag, (v) => v * (1 + 1e-12)),
        };
        const copy = {
            ...primary,
            sha256: "c3".repeat(32),
            channels,
            chirp: { ...primary.chirp, roll: { ...primary.chirp.roll!, tf: scaled } },
        };
        expect(transferFunctionValuesIdentical(tf, scaled)).toBe(true);
        expect(multiRecordingIssues(primary, copy)).toEqual([]);
        const ledger = ledgerOf(primary, [copy]);
        expect(sumExtra(ledger.extraAveragesByHz)).toBe(0);
        expect(ledger.rejected.some((r) => r.startsWith("multi_recording_identical_measurement:"))).toBe(true);
        // A real plant change (1 %) is not float round-trip identity and may still contribute.
        const changed = {
            ...tf,
            hReal: Float64Array.from(tf.hReal, (v) => v * 1.01),
            hImag: Float64Array.from(tf.hImag, (v) => v * 1.01),
        };
        expect(transferFunctionValuesIdentical(tf, changed)).toBe(false);
    });
});

describe("P1 peer duplicates among others (Grokbot local review)", () => {
    it("A+B stacks once; A+B+B′ (same flight as B, other hash) does not double extras", () => {
        const A = syntheticLogInput("a1".repeat(32), DWELL);
        const B = syntheticLogInput("b1".repeat(32), DWELL);
        const Bp = reexport(B, "b2".repeat(32), 1);
        expect(multiRecordingIssues(A, B)).toEqual([]);
        expect(multiRecordingIssues(A, Bp)).toEqual([]);
        const onlyB = ledgerOf(A, [B]);
        const both = ledgerOf(A, [B, Bp]);
        const reversed = ledgerOf(A, [Bp, B]);
        expect(sumExtra(onlyB.extraAveragesByHz)).toBeGreaterThan(0);
        // Pre-fix defect: 229 → 458; same support must count once.
        expect(sumExtra(both.extraAveragesByHz)).toBe(sumExtra(onlyB.extraAveragesByHz));
        expect(sumExtra(reversed.extraAveragesByHz)).toBe(sumExtra(onlyB.extraAveragesByHz));
        expect(both.contributors).toHaveLength(1);
        expect(reversed.contributors).toHaveLength(1);
        expect(
            both.rejected.some(
                (r) =>
                    r.startsWith("multi_recording_duplicate_peer:") ||
                    r.startsWith("multi_recording_identical_peer_measurement:"),
            ),
        ).toBe(true);
    });

    it("two truly independent others both contribute; order does not change the extra total", () => {
        const A = syntheticLogInput("a1".repeat(32), DWELL);
        const B = syntheticLogInput("b1".repeat(32), DWELL);
        const C = syntheticLogInput("c1".repeat(32), DWELL);
        const bc = ledgerOf(A, [B, C]);
        const cb = ledgerOf(A, [C, B]);
        expect(bc.contributors).toHaveLength(2);
        expect(cb.contributors).toHaveLength(2);
        expect(sumExtra(bc.extraAveragesByHz)).toBe(sumExtra(cb.extraAveragesByHz));
        expect(sumExtra(bc.extraAveragesByHz)).toBe(2 * sumExtra(ledgerOf(A, [B]).extraAveragesByHz));
    });

    it("bit-identical peer FRFs under different hashes do not stack even when windows diverge", () => {
        const A = syntheticLogInput("a1".repeat(32), DWELL);
        const B = syntheticLogInput("b1".repeat(32), DWELL);
        const channels = structuredClone(A.channels);
        for (const g of channels.gyroAdc as unknown as Float64Array[]) {
            for (let k = 0; k < g.length; k++) g[k] *= 1.11;
        }
        channels.timeUs = Float64Array.from(channels.timeUs, (v) => v + 9_000_000);
        // Reuses B's TF bytes on another gyro stream / hash — not sameFlight with B.
        const BtfClone = {
            ...A,
            sha256: "d4".repeat(32),
            channels,
            chirp: { ...A.chirp, roll: { ...A.chirp.roll!, tf: B.chirp.roll!.tf } },
        };
        const led = ledgerOf(A, [B, BtfClone]);
        expect(led.contributors).toHaveLength(1);
        expect(led.rejected.some((r) => r.startsWith("multi_recording_identical_peer_measurement:"))).toBe(true);
    });
});
