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
 * Multi-recording average aggregation (completion program 2026-10-28, phase 4).
 *
 * Independent CHIRP recordings of the same craft / firmware / configuration may contribute
 * whole-segment averages at the same decision frequencies. They are never concatenated across
 * discontinuities: each recording keeps its own sweep, window and noise assessment; only the
 * integer average counts are summed. A duplicated recording (same content) must not increase the
 * count. Mismatched identity or configuration fails closed and improves nothing.
 */

import type { TransferFunction } from "@/js/blackbox/spectral_analysis";
import type { AutotuneLogInput } from "./autotuneV2";
import { crossLogReferenceIssues, flightRelation, sameFlight } from "./logInput";
import { sweepAverages, type AnalysisProvenance, type SweepInfo } from "./loopModel";

/**
 * Same published closed-loop FRF (same object, bit-equal bins, or equal after float32 round-trip).
 * Used to refuse a duplicated measurement that flight-window identity missed (re-scaled gyro,
 * restarted clock, or a sub-ulp H rescale that is not a new identification).
 *
 * Float32 equality is serialization / round-trip identity — not a scientific plant-similarity
 * tolerance and not proof of flight independence (flightRelation / sameFlight remain primary).
 */
export function transferFunctionValuesIdentical(a: TransferFunction, b: TransferFunction): boolean {
    if (a === b) return true;
    const n = a.frequencies.length;
    if (b.frequencies.length !== n) return false;
    for (let i = 0; i < n; i++) {
        if (a.frequencies[i] !== b.frequencies[i]) return false;
        const ar = a.hReal[i]!;
        const br = b.hReal[i]!;
        const ai = a.hImag[i]!;
        const bi = b.hImag[i]!;
        if (ar === br && ai === bi) continue;
        // Sub-ulp / re-export noise: IEEE float32 collapses 1+1e-12 rescales of typical H bins.
        if (Math.fround(ar) === Math.fround(br) && Math.fround(ai) === Math.fround(bi)) continue;
        return false;
    }
    return true;
}

export interface RecordingAverageClaim {
    /** Stable id for this recording (sha256 + logIndex). */
    id: string;
    sha256: string;
    logIndex: number;
    hz: number;
    averages: number;
    /** Content fingerprint: duplicate claims with the same fingerprint do not stack. */
    contentKey: string;
}

export interface AggregateAveragesResult {
    hz: number;
    /** Sum of unique recordings' whole-segment averages. */
    averages: number;
    contributors: string[];
    rejected: string[];
}

/**
 * Sample-identity key for a claim. Acquisition settings alone must not collide independent
 * flights that happen to share the same sweep parameters (Codex final 2026-10-28, P2).
 * Identical bytes share sha256; that is the duplicate detector.
 */
export function claimContentKey(sha256: string): string {
    return sha256;
}

/**
 * Build a claim from one recording's analysis at `hz`. Returns null when the count is zero.
 */
export function averageClaimAt(
    log: AutotuneLogInput,
    hz: number,
    analysis: AnalysisProvenance,
    sweep: SweepInfo,
): RecordingAverageClaim | null {
    const n = sweepAverages(hz, analysis, sweep, analysis.windowSamples);
    if (n < 1) return null;
    return {
        id: `${log.sha256}:${log.logIndex}`,
        sha256: log.sha256,
        logIndex: log.logIndex,
        hz,
        averages: n,
        contentKey: claimContentKey(log.sha256),
    };
}

/**
 * Sum whole-segment averages at one frequency across claims. Duplicate sample identity (sha256)
 * is counted once. Independent recordings with identical acquisition settings still sum.
 * Callers must only pass claims that already passed identity / config checks.
 */
export function aggregateAverageClaims(hz: number, claims: RecordingAverageClaim[]): AggregateAveragesResult {
    const rejected: string[] = [];
    const seenSha = new Set<string>();
    let sum = 0;
    const contributors: string[] = [];
    for (const c of claims) {
        if (c.hz !== hz) {
            rejected.push(`frequency_mismatch:${c.id}:${c.hz}`);
            continue;
        }
        if (seenSha.has(c.sha256)) {
            rejected.push(`duplicate_sha256:${c.id}`);
            continue;
        }
        if (!(Number.isInteger(c.averages) && c.averages >= 1)) {
            rejected.push(`non_positive_averages:${c.id}`);
            continue;
        }
        seenSha.add(c.sha256);
        sum += c.averages;
        contributors.push(c.id);
    }
    return { hz, averages: sum, contributors, rejected };
}

/**
 * Whether `other` may contribute averages toward the same craft measurement as `primary`.
 * Uses the production cross-log identity rules; returns reasons when not.
 * `pool` is the full set of candidate others so peer duplicates linked through overlapping
 * fragments are visible to `crossLogReferenceIssues` (Grokbot local review P1, 2026-10-30).
 */
export function multiRecordingIssues(
    primary: AutotuneLogInput,
    other: AutotuneLogInput,
    pool: readonly AutotuneLogInput[] = [],
): string[] {
    if (primary.sha256 === other.sha256 && primary.logIndex === other.logIndex) {
        return ["multi_recording_same_log"];
    }
    const rel = flightRelation(primary, other);
    if (rel.relation !== "INDEPENDENT") {
        return rel.reasons.map((r) => `multi_recording_not_independent:${r}`);
    }
    return crossLogReferenceIssues(primary, other, pool).map((r) => `multi_recording_rejected:${r}`);
}

/** Stable order so contributor selection does not depend on import order. */
function byRecordingId(a: AutotuneLogInput, b: AutotuneLogInput): number {
    return a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : a.logIndex - b.logIndex;
}

export interface MultiRecordingLedger {
    /** Extra whole-segment averages at each Hz (beyond the primary's own count). */
    extraAveragesByHz: Map<number, number>;
    contributors: string[];
    rejected: string[];
}

/**
 * Collect independent recordings' whole-segment averages at the primary's decision frequencies.
 * Does not concatenate time series. Only adds counts when `multiRecordingIssues` is empty and the
 * other log has a usable chirp + analysis on `axis`. Primary bins with no whole-segment dwell stay
 * at zero extras (never invent support).
 */
export function collectMultiRecordingAverages(
    primary: AutotuneLogInput,
    others: readonly AutotuneLogInput[],
    axis: "roll" | "pitch" | "yaw",
    frequenciesHz: ArrayLike<number>,
    primaryAnalysis: AnalysisProvenance | null,
    primarySweep: SweepInfo | null,
): MultiRecordingLedger {
    const extraAveragesByHz = new Map<number, number>();
    const contributors: string[] = [];
    const rejected: string[] = [];
    if (!primaryAnalysis || !primarySweep || !frequenciesHz.length) {
        return { extraAveragesByHz, contributors, rejected };
    }
    // Same underlying measurement support counts at most once: peer sameFlight / bit-identical FRF
    // against primary or an already-kept peer (Grokbot P1: B + B′ must not double averages).
    const eligible: AutotuneLogInput[] = [];
    const pool = others;
    for (const other of [...others].sort(byRecordingId)) {
        const issues = multiRecordingIssues(primary, other, pool);
        if (issues.length) {
            rejected.push(...issues.map((r) => `${r}:${other.sha256}:${other.logIndex}`));
            continue;
        }
        const chirp = other.chirp[axis];
        if (!chirp || chirp.state === "rejected" || !chirp.analysis) {
            rejected.push(`multi_recording_axis_unusable:${axis}:${other.sha256}:${other.logIndex}`);
            continue;
        }
        const primaryChirp = primary.chirp[axis];
        if (primaryChirp && transferFunctionValuesIdentical(primaryChirp.tf, chirp.tf)) {
            rejected.push(`multi_recording_identical_measurement:${other.sha256}:${other.logIndex}`);
            continue;
        }
        const peerFlight = eligible.find((kept) => sameFlight(kept, other));
        if (peerFlight) {
            rejected.push(
                `multi_recording_duplicate_peer:${other.sha256}:${other.logIndex}:of:${peerFlight.sha256}:${peerFlight.logIndex}`,
            );
            continue;
        }
        const peerTf = eligible.find((kept) => {
            const kc = kept.chirp[axis];
            return !!kc && transferFunctionValuesIdentical(kc.tf, chirp.tf);
        });
        if (peerTf) {
            rejected.push(
                `multi_recording_identical_peer_measurement:${other.sha256}:${other.logIndex}:of:${peerTf.sha256}:${peerTf.logIndex}`,
            );
            continue;
        }
        eligible.push(other);
    }
    for (let i = 0; i < frequenciesHz.length; i++) {
        const hz = frequenciesHz[i]!;
        if (!(hz > 0)) continue;
        const primaryClaim = averageClaimAt(primary, hz, primaryAnalysis, primarySweep);
        if (!primaryClaim) continue; // no whole-segment primary dwell: do not invent extras alone
        const claims: RecordingAverageClaim[] = [primaryClaim];
        for (const other of eligible) {
            const chirp = other.chirp[axis]!;
            const sweep = otherSweep(other);
            if (!sweep) {
                rejected.push(`multi_recording_sweep_unknown:${other.sha256}:${other.logIndex}`);
                continue;
            }
            const claim = averageClaimAt(other, hz, chirp.analysis!, sweep);
            if (claim) claims.push(claim);
        }
        const agg = aggregateAverageClaims(hz, claims);
        rejected.push(...agg.rejected);
        const extra = Math.max(0, agg.averages - primaryClaim.averages);
        if (extra > 0) {
            extraAveragesByHz.set(hz, extra);
            for (const id of agg.contributors) {
                if (id !== primaryClaim.id && !contributors.includes(id)) contributors.push(id);
            }
        }
    }
    return { extraAveragesByHz, contributors, rejected: [...new Set(rejected)] };
}

/** Sweep from Betaflight chirp headers (deci-Hz start/end + duration), same contract as the engine. */
function otherSweep(log: AutotuneLogInput): SweepInfo | null {
    const h = new Map(log.headerPairs);
    const f0 = Number(h.get("chirp_frequency_start_deci_hz"));
    const f1 = Number(h.get("chirp_frequency_end_deci_hz"));
    const durationS = Number(h.get("chirp_time_seconds"));
    if (!(Number.isFinite(f0) && Number.isFinite(f1) && Number.isFinite(durationS))) return null;
    if (!(f1 > f0 && f0 > 0 && durationS > 0)) return null;
    return { f0Hz: f0 / 10, f1Hz: f1 / 10, durationS };
}
