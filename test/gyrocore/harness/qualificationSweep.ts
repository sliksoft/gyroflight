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

import { sweepAverages, type SweepInfo } from "../../../src/gyrocore/engine/loopModel";

/**
 * The shortest exponential sweep f0Hz → f1Hz (whole seconds) whose dwell gives at least `averages`
 * whole segments of `segmentSamples` at `sampleRateHz` in every bin of the grid up to `topHz`.
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
        const a = { segmentSamples: N, sampleRateHz: o.sampleRateHz, segments: Number.MAX_SAFE_INTEGER };
        return bins.every((f) => sweepAverages(f, a, sweep) >= averages);
    };
    // The highest bin binds (the dwell per bin falls as 1/f); start there and grow until every bin has it.
    const f = bins[bins.length - 1];
    const L = Math.log(o.f1Hz / o.f0Hz);
    let T = Math.ceil(((averages * N + 2) / o.sampleRateHz) * (L / Math.log((f + df / 2) / (f - df / 2))));
    while (!enough(T)) T = Math.ceil(T * 1.01) + 1;
    return { f0Hz: o.f0Hz, f1Hz: o.f1Hz, durationS: T };
}
