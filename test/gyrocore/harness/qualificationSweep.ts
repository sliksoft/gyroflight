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
 * SIMULATION ONLY: the exponential sweep a synthetic model-class qualification fixture must declare
 * for the bins it claims (planner safety repair 2026-10-28). The qualification path counts averages
 * in whole samples and whole segments and leaves a bin with less than one segment of dwell UNKNOWN
 * (loopModel SUB_SEGMENT_DWELL): a fine qualification grid over a wide band takes a long sweep
 * (every 0.1 Hz bin needs a 10 s segment of the sweep's time). A fixture that identifies such a grid
 * declares the sweep that would have given it, computed here with the production count
 * (sweepAverages); it is a declaration about a simulated flight, never flight evidence.
 */

import { sweepAverages, type AnalysisProvenance, type SweepInfo } from "../../../src/gyrocore/engine/loopModel";

/**
 * The shortest exponential sweep f0Hz → f1Hz (whole seconds) whose dwell gives at least `averages`
 * whole segments of `segmentSamples` at `sampleRateHz` in every bin of the grid up to `topHz`,
 * counted inside a window that holds the whole sweep (Codex review 2026-10-28, P2).
 */
export function declaredQualificationSweep(
    o: { segmentSamples: number; sampleRateHz: number; f0Hz: number; f1Hz: number; topHz: number },
    averages = 1,
): SweepInfo {
    const N = o.segmentSamples;
    const df = o.sampleRateHz / N;
    const bins: number[] = [];
    for (let k = Math.ceil(o.f0Hz / df); k * df <= o.topHz; k++) if (k * df >= o.f0Hz) bins.push(k * df);
    const enough = (T: number) => {
        const sweep = { f0Hz: o.f0Hz, f1Hz: o.f1Hz, durationS: T };
        const windowSamples = Math.floor(T * o.sampleRateHz);
        const a = { segmentSamples: N, sampleRateHz: o.sampleRateHz, segments: Number.MAX_SAFE_INTEGER };
        return bins.every((f) => sweepAverages(f, a, sweep, windowSamples) >= averages);
    };
    // The highest bin binds (the dwell per bin falls as 1/f); start there and grow until every bin has it.
    const f = bins[bins.length - 1];
    const L = Math.log(o.f1Hz / o.f0Hz);
    let T = Math.ceil(((averages * N + 2) / o.sampleRateHz) * (L / Math.log((f + df / 2) / (f - df / 2))));
    while (!enough(T)) T = Math.ceil(T * 1.01) + 1;
    return { f0Hz: o.f0Hz, f1Hz: o.f1Hz, durationS: T };
}

/**
 * Welch provenance whose window holds `sweep` (so dwell claims are observed) and whose segment
 * count matches the transfer function it will be paired with (`tf.numSegments` / `segments`).
 * Analytic fixtures that declare a long qualification sweep must use this (or equivalent) so the
 * engine's window clip sees the same samples the dwell claim needs — never a short window with a
 * long header. The window may be longer than the minimum for `segments` (provenance allows that).
 */
export function analysisForDeclaredSweep(
    sweep: SweepInfo,
    o: { segmentSamples: number; sampleRateHz: number; segments?: number },
): AnalysisProvenance {
    const N = o.segmentSamples;
    const segments = o.segments ?? 8;
    const minWindow = (N * (segments + 1)) / 2;
    const windowSamples = Math.max(minWindow, Math.floor(sweep.durationS * o.sampleRateHz));
    return { segmentSamples: N, sampleRateHz: o.sampleRateHz, windowSamples, segments };
}
