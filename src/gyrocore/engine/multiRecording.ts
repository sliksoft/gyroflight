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

import type { AutotuneLogInput } from "./autotuneV2";
import { crossLogReferenceIssues, flightRelation } from "./logInput";
import { sweepAverages, type AnalysisProvenance, type SweepInfo } from "./loopModel";

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
 */
export function multiRecordingIssues(primary: AutotuneLogInput, other: AutotuneLogInput): string[] {
    if (primary.sha256 === other.sha256 && primary.logIndex === other.logIndex) {
        return ["multi_recording_same_log"];
    }
    const rel = flightRelation(primary, other);
    if (rel.relation !== "INDEPENDENT") {
        return rel.reasons.map((r) => `multi_recording_not_independent:${r}`);
    }
    return crossLogReferenceIssues(primary, other, []).map((r) => `multi_recording_rejected:${r}`);
}
