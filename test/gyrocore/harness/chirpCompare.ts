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
 * Compares one Betaflight Autotune segment analysis with GyroCore's reference
 * result for the same axis (GyroCore identify_chirp_system_from_bbl, as stored in
 * its goldens: non-finite numbers are null there).
 */

import type { SegmentAnalysis } from "./betaflightAutotune";

export interface GyroCoreAxis {
    axis: number;
    effective_rate_hz: number;
    segment_size: number;
    num_segments: number;
    segment: { start_idx: number; end_idx: number; sample_count: number; duration_s: number };
    transfer_function: {
        frequencies_hz: (number | null)[];
        h_real: (number | null)[];
        h_imag: (number | null)[];
        magnitude_db: (number | null)[];
        phase_deg: (number | null)[];
        coherence: (number | null)[];
    };
    sensitivity_peak_db: number | null;
    step_response: {
        overshoot_pct: number | null;
        rise_time_ms: number | null;
        settling_time_ms: number | null;
        response: (number | null)[];
        time_ms: (number | null)[];
    } | null;
    quality: {
        usable: boolean;
        failed_gates: string[];
        warning_gates: string[];
        mean_band_coherence: number | null;
        usable_bin_count: number;
        usable_range_hz: (number | null)[];
        analysis_band_hz: number[];
    };
    usable: boolean;
}

export interface ArrayDiff {
    length: [number, number];
    maxAbs: number;
    /** Index of the largest difference. */
    at: number;
    /** Bins where exactly one side is non-finite. */
    finitenessMismatch: number;
}

function num(v: number | null | undefined) {
    return v === null || v === undefined ? Number.NaN : v;
}

export function diffArrays(
    a: ArrayLike<number>,
    b: ArrayLike<number | null>,
    metric: (x: number, y: number) => number = (x, y) => Math.abs(x - y),
): ArrayDiff {
    const n = Math.min(a.length, b.length);
    let maxAbs = 0;
    let at = -1;
    let finitenessMismatch = 0;
    for (let i = 0; i < n; i++) {
        const x = a[i];
        const y = num(b[i]);
        const fx = Number.isFinite(x);
        const fy = Number.isFinite(y);
        if (!fx || !fy) {
            if (fx !== fy) {
                finitenessMismatch++;
            }
            continue;
        }
        const d = metric(x, y);
        if (d > maxAbs) {
            maxAbs = d;
            at = i;
        }
    }
    return { length: [a.length, b.length], maxAbs, at, finitenessMismatch };
}

/** Difference of two angles in degrees, wrapped into [0, 180]. */
export function phaseDistance(x: number, y: number) {
    const d = Math.abs(((((x - y) % 360) + 540) % 360) - 180);
    return d;
}

export function scalarDiff(a: number | null | undefined, b: number | null | undefined) {
    const x = num(a);
    const y = num(b);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return Number.isFinite(x) === Number.isFinite(y) ? 0 : Number.POSITIVE_INFINITY;
    }
    return Math.abs(x - y);
}

export function compareSegment(bf: SegmentAnalysis, gc: GyroCoreAxis, sampleRate: number, segmentSize: number) {
    const tf = bf.transferFunction;
    const gtf = gc.transfer_function;
    const out = {
        axis: bf.axisName,
        segment: {
            betaflight: [bf.startIdx, bf.endIdx, bf.length],
            gyrocore: [gc.segment.start_idx, gc.segment.end_idx, gc.segment.sample_count],
            same: bf.startIdx === gc.segment.start_idx && bf.endIdx === gc.segment.end_idx,
        },
        sampleRate: { betaflight: sampleRate, gyrocore: gc.effective_rate_hz },
        segmentSize: { betaflight: segmentSize, gyrocore: gc.segment_size },
        welchSegments: { betaflight: tf?.numSegments ?? null, gyrocore: gc.num_segments },
        frequencies: null as ArrayDiff | null,
        hRelative: null as ArrayDiff | null,
        magnitudeDb: null as ArrayDiff | null,
        phaseDeg: null as ArrayDiff | null,
        coherence: null as ArrayDiff | null,
        sensitivityPeakDb: { betaflight: bf.sensitivity?.peakDb ?? null, gyrocore: gc.sensitivity_peak_db, diff: 0 },
        step: null as null | {
            response: ArrayDiff;
            overshootPct: [number, number | null];
            riseTimeMs: [number, number | null];
            settlingTimeMs: [number, number | null];
            maxMetricDiff: number;
        },
    };
    if (!tf) {
        return out;
    }
    out.frequencies = diffArrays(tf.frequencies, gtf.frequencies_hz);
    const hMag = Array.from(gtf.h_real, (re, i) => Math.hypot(num(re), num(gtf.h_imag[i])));
    const relH = Array.from(tf.hReal, (re, i) => {
        const dr = re - num(gtf.h_real[i]);
        const di = tf.hImag[i] - num(gtf.h_imag[i]);
        return Math.hypot(dr, di) / Math.max(hMag[i], 1e-12);
    });
    out.hRelative = diffArrays(
        relH,
        relH.map(() => 0),
    );
    out.magnitudeDb = diffArrays(tf.magnitude, gtf.magnitude_db);
    out.phaseDeg = diffArrays(tf.phase, gtf.phase_deg, phaseDistance);
    out.coherence = diffArrays(tf.coherence, gtf.coherence);
    out.sensitivityPeakDb.diff = scalarDiff(bf.sensitivity?.peakDb, gc.sensitivity_peak_db);
    if (bf.stepResponse && gc.step_response) {
        const s = bf.stepResponse;
        const g = gc.step_response;
        out.step = {
            response: diffArrays(s.response, g.response),
            overshootPct: [s.overshootPct, g.overshoot_pct],
            riseTimeMs: [s.riseTimeMs, g.rise_time_ms],
            settlingTimeMs: [s.settlingTimeMs, g.settling_time_ms],
            maxMetricDiff: Math.max(
                scalarDiff(s.overshootPct, g.overshoot_pct),
                scalarDiff(s.riseTimeMs, g.rise_time_ms),
                scalarDiff(s.settlingTimeMs, g.settling_time_ms),
            ),
        };
    }
    return out;
}

/** What each side would tell the user about one axis. */
export function judgment(bf: SegmentAnalysis | undefined, gc: GyroCoreAxis | undefined) {
    const rec = bf?.recommendation;
    return {
        betaflight: bf
            ? {
                  producesRecommendation: !bf.skipped && Boolean(rec),
                  skipped: bf.skipped,
                  proposed: rec?.proposed ?? null,
                  meanCoherence5to100Hz: rec?.analysis.meanCoherence ?? null,
                  gainClamped: rec?.analysis.gainClamped ?? null,
                  sensitivityUnreachable: rec?.analysis.sensitivityUnreachable ?? null,
                  targetUnreachable: rec ? !Number.isFinite(rec.analysis.targetCrossoverHz) : null,
                  phaseMarginDeg: rec?.analysis.phaseMarginDeg ?? null,
                  crossoverHz: rec?.analysis.openLoopCrossoverHz ?? null,
              }
            : null,
        gyrocore: gc
            ? {
                  usable: gc.usable && gc.quality.usable,
                  failedGates: gc.quality.failed_gates,
                  warningGates: gc.quality.warning_gates,
                  meanBandCoherence: gc.quality.mean_band_coherence,
                  usableRangeHz: gc.quality.usable_range_hz,
              }
            : null,
    };
}
