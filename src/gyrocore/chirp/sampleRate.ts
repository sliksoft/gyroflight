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
 * CHIRP sample-rate resolution with a timestamp cross-check, and timestamp
 * spacing (gaps, non-uniform timing). Port of GyroCore sampleRate.ts /
 * sample_rate.py (d2e60f7), policy unchanged.
 *
 * Betaflight Autotune derives the rate from headers only and never looks at
 * the timestamps, so it can neither notice a wrong rate nor a gap.
 */

import type { SampleRateInputs } from "./headers";
import { npMedian, npRint } from "./numeric";

export const MISMATCH_TOLERANCE_FRACTION = 0.05;
const MIN_TIMESTAMP_DELTAS = 8;
export const SPACING_UNIFORM_TOLERANCE_FRACTION = 0.1;
export const SPACING_MIN_UNIFORM_FRACTION = 0.9;
export const SPACING_GAP_FACTOR = 1.5;

export type SampleRateSource = "header" | "timestamp" | "header_confirmed" | "unknown";
export type SampleRateStatus = "ok" | "mismatch" | "header_only" | "timestamp_only" | "unusable";

export interface SampleRateEvidence {
    pidLoopRateHz: number | null;
    headerRateHz: number | null;
    timestampRateHz: number | null;
    effectiveRateHz: number | null;
    source: SampleRateSource;
    status: SampleRateStatus;
    differencePercent: number | null;
    warnings: string[];
    usable: boolean;
}

export interface TimestampSpacing {
    deltaCount: number;
    medianDtUs: number | null;
    minDtUs: number | null;
    maxDtUs: number | null;
    uniformFraction: number;
    gapCount: number;
    missingSamplesEstimate: number;
    missingFraction: number;
    maxGapSamples: number;
    nonPositiveDeltas: number;
    uniform: boolean;
}

const finitePositive = (v: number | null): v is number => v !== null && Number.isFinite(v) && v > 0;

function headerRate(i: SampleRateInputs): number | null {
    const { looptimeUs: lt, pidProcessDenom: pd, frameIntervalPNum: num, frameIntervalPDenom: den } = i;
    if (!finitePositive(lt) || !finitePositive(pd) || !finitePositive(num) || !finitePositive(den)) {
        return null;
    }
    return (1_000_000 * num) / (lt * pd * den);
}

function pidRate(i: SampleRateInputs): number | null {
    const { looptimeUs: lt, pidProcessDenom: pd } = i;
    return finitePositive(lt) && finitePositive(pd) ? 1_000_000 / (lt * pd) : null;
}

function deltas(ts: ArrayLike<number>) {
    const n = ts.length;
    const all = new Float64Array(Math.max(0, n - 1));
    for (let i = 1; i < n; i++) {
        all[i - 1] = ts[i] - ts[i - 1];
    }
    let finite = 0;
    const positive: number[] = [];
    for (const d of all) {
        if (Number.isFinite(d)) {
            finite++;
            if (d > 0) {
                positive.push(d);
            }
        }
    }
    return { all, finite, positive: Float64Array.from(positive) };
}

export function estimateTimestampRateHz(ts: ArrayLike<number>): number | null {
    if (ts.length < 2) {
        return null;
    }
    const { positive } = deltas(ts);
    if (positive.length < MIN_TIMESTAMP_DELTAS && positive.length < 3) {
        return null;
    }
    const median = npMedian(positive);
    if (!Number.isFinite(median) || median <= 0) {
        return null;
    }
    const rate = 1_000_000 / median;
    return Number.isFinite(rate) && rate > 0 ? rate : null;
}

export function analyzeTimestampSpacing(ts: ArrayLike<number>): TimestampSpacing {
    const { all, finite, positive } = deltas(ts);
    const nonPositive = finite - positive.length + (all.length - finite);
    if (positive.length === 0) {
        return {
            deltaCount: all.length,
            medianDtUs: null,
            minDtUs: null,
            maxDtUs: null,
            uniformFraction: 0,
            gapCount: 0,
            missingSamplesEstimate: 0,
            missingFraction: 0,
            maxGapSamples: 0,
            nonPositiveDeltas: nonPositive,
            uniform: false,
        };
    }
    const median = npMedian(positive);
    let within = 0;
    let gapCount = 0;
    let missing = 0;
    let maxGap = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const d of positive) {
        if (Math.abs(d - median) <= SPACING_UNIFORM_TOLERANCE_FRACTION * median) {
            within++;
        }
        if (d > SPACING_GAP_FACTOR * median) {
            gapCount++;
            const m = Math.max(npRint(d / median) - 1, 0);
            missing += m;
            maxGap = Math.max(maxGap, m);
        }
        min = Math.min(min, d);
        max = Math.max(max, d);
    }
    const uniformFraction = within / all.length;
    const expected = ts.length + missing;
    return {
        deltaCount: all.length,
        medianDtUs: median,
        minDtUs: min,
        maxDtUs: max,
        uniformFraction,
        gapCount,
        missingSamplesEstimate: missing,
        missingFraction: expected > 0 ? missing / expected : 0,
        maxGapSamples: maxGap,
        nonPositiveDeltas: nonPositive,
        uniform: uniformFraction >= SPACING_MIN_UNIFORM_FRACTION && nonPositive === 0,
    };
}

export function resolveChirpSampleRate(inputs: SampleRateInputs, timestampsUs: ArrayLike<number>): SampleRateEvidence {
    const { looptimeUs: lt, pidProcessDenom: pd, frameIntervalPNum: num, frameIntervalPDenom: den } = inputs;
    const warnings: string[] = [];
    const pid = pidRate(inputs);
    const header = headerRate(inputs);
    if (header !== null && num !== null && den !== null && num > den) {
        warnings.push("frame_interval_p_num_exceeds_denom");
    }
    const ts = estimateTimestampRateHz(timestampsUs);
    if (ts === null && timestampsUs.length >= 2) {
        warnings.push("timestamp_rate_unreliable");
    }
    if ((num === null || den === null) && lt !== null && pd !== null) {
        warnings.push("p_interval_metadata_missing");
    }
    if (lt === null) {
        warnings.push("looptime_missing");
    }
    if (pd === null) {
        warnings.push("pid_process_denom_missing");
    }

    const base = { pidLoopRateHz: pid, headerRateHz: header, timestampRateHz: ts };
    if (header === null && ts === null) {
        return {
            ...base,
            effectiveRateHz: null,
            source: "unknown",
            status: "unusable",
            differencePercent: null,
            warnings: [...warnings, "no_trustworthy_sample_rate"],
            usable: false,
        };
    }
    if (header === null) {
        return {
            ...base,
            effectiveRateHz: ts,
            source: "timestamp",
            status: "timestamp_only",
            differencePercent: null,
            warnings: [...warnings, "derived_from_timestamps_only"],
            usable: true,
        };
    }
    if (ts === null) {
        return {
            ...base,
            effectiveRateHz: header,
            source: "header",
            status: "header_only",
            differencePercent: null,
            warnings: [...warnings, "no_timestamp_crosscheck"],
            usable: true,
        };
    }
    const differencePercent = (Math.abs(header - ts) / Math.abs(ts)) * 100;
    if (Math.abs(header - ts) / ts <= MISMATCH_TOLERANCE_FRACTION) {
        return {
            ...base,
            effectiveRateHz: header,
            source: "header_confirmed",
            status: "ok",
            differencePercent,
            warnings,
            usable: true,
        };
    }
    return {
        ...base,
        effectiveRateHz: ts,
        source: "timestamp",
        status: "mismatch",
        differencePercent,
        warnings: [...warnings, "header_timestamp_rate_mismatch", "effective_rate_from_timestamps_due_to_mismatch"],
        usable: true,
    };
}
