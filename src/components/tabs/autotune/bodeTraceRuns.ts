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
 * Gaps in a Bode trace (measurement audit B7). The plot shows the coherent bins only; between two
 * coherent bins that are not adjacent on the analysis grid the loop was not measured, so no line is
 * drawn there and the phase unwrap restarts: a line across the gap would invent a response, and an
 * unwrap step over it could pick the wrong branch.
 */

/** Largest ratio of a frequency step to the grid step before the trace is broken there. */
export const GAP_STEP_RATIO = 1.5;

/**
 * The smallest step between consecutive surviving points: a fallback for the analysis grid's bin
 * spacing (0 when unknown). Callers that know the grid pass its step: when every other bin was
 * rejected, the surviving points alone would suggest a grid twice as coarse and hide the gaps.
 */
export function binStepHz(points: readonly { freq: number }[]): number {
    let step = Infinity;
    for (let i = 1; i < points.length; i++) step = Math.min(step, points[i].freq - points[i - 1].freq);
    return Number.isFinite(step) && step > 0 ? step : 0;
}

/** Whether the bins between `a` and `b` were left out (incoherent or missing): a gap, not a line. */
export function isGap(a: number, b: number, step: number): boolean {
    return step > 0 && b - a > GAP_STEP_RATIO * step;
}

/**
 * The runs of consecutive points that are adjacent on the analysis grid: between two runs the
 * coherence dropped below the threshold (or bins are missing), and nothing is drawn there.
 */
export function contiguousRuns<P extends { freq: number }>(points: readonly P[], gridStepHz?: number): P[][] {
    const step = gridStepHz && gridStepHz > 0 ? gridStepHz : binStepHz(points);
    const runs: P[][] = [];
    let run: P[] = [];
    for (let i = 0; i < points.length; i++) {
        if (i > 0 && isGap(points[i - 1].freq, points[i].freq, step)) {
            runs.push(run);
            run = [];
        }
        run.push(points[i]);
    }
    if (run.length) runs.push(run);
    return runs;
}

/**
 * Unwrap `phase` (degrees) along the points, restarting at every gap: within a run each step is taken
 * modulo 360° towards the smallest change; the first point of a run keeps its wrapped value.
 */
export function unwrapPhaseByRun<P extends { freq: number; phase: number }>(
    points: readonly P[],
    gridStepHz?: number,
): P[] {
    const step = gridStepHz && gridStepHz > 0 ? gridStepHz : binStepHz(points);
    const out: P[] = [];
    for (let i = 0; i < points.length; i++) {
        if (i === 0 || isGap(points[i - 1].freq, points[i].freq, step)) {
            out.push({ ...points[i] });
            continue;
        }
        let diff = points[i].phase - points[i - 1].phase;
        while (diff > 180) diff -= 360;
        while (diff < -180) diff += 360;
        out.push({ ...points[i], phase: out[i - 1].phase + diff });
    }
    return out;
}
