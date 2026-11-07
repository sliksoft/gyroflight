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
 * Measurement audit B7: the Bode plot drew one continuous line through the coherent bins and unwrapped
 * the phase across the bins it had left out. A trace is now split into runs of grid-adjacent bins,
 * and the unwrap restarts at every gap (bodeTraceRuns.ts, used by BodePlot.vue).
 */

import { describe, expect, it } from "vitest";
import {
    binStepHz,
    contiguousRuns,
    GAP_STEP_RATIO,
    isGap,
    unwrapPhaseByRun,
} from "../../src/components/tabs/autotune/bodeTraceRuns";

const grid = (hz: number[]) => hz.map((freq) => ({ freq, phase: 0 }));

describe("gaps between coherent bins", () => {
    it("the grid step is the smallest step; a step above 1.5× it is a gap", () => {
        const pts = grid([2, 4, 6, 8, 14, 16]);
        expect(binStepHz(pts)).toBe(2);
        expect(GAP_STEP_RATIO).toBe(1.5);
        expect(isGap(6, 8, 2)).toBe(false);
        expect(isGap(8, 14, 2)).toBe(true);
        expect(isGap(8, 14, 0)).toBe(false); // an unknown grid breaks nothing
    });

    it("a trace with two incoherent bins in the middle is two runs, never one line", () => {
        const pts = grid([2, 4, 6, 8, 14, 16, 18]);
        expect(contiguousRuns(pts).map((r) => r.map((p) => p.freq))).toEqual([
            [2, 4, 6, 8],
            [14, 16, 18],
        ]);
    });

    it("with the grid step given, surviving points two bins apart are gaps, not a coarser grid (Codex review)", () => {
        // On a 2 Hz grid every other bin was rejected: the survivors alone look like a 4 Hz grid.
        const pts = grid([2, 6, 10, 14]);
        expect(contiguousRuns(pts).length).toBe(1); // the fallback cannot know
        expect(contiguousRuns(pts, 2).map((r) => r.map((p) => p.freq))).toEqual([[2], [6], [10], [14]]);
        expect(
            unwrapPhaseByRun(
                [
                    { freq: 2, phase: 170 },
                    { freq: 6, phase: -170 },
                ],
                2,
            ).map((p) => p.phase),
        ).toEqual([170, -170]);
        // Two surviving adjacent points: one run of two.
        expect(contiguousRuns(grid([2, 4]), 2).map((r) => r.length)).toEqual([2]);
    });

    it("a contiguous trace is one run; a lone coherent bin is a run of one", () => {
        expect(contiguousRuns(grid([2, 4, 6, 8])).length).toBe(1);
        expect(contiguousRuns(grid([2, 4, 6, 20, 30, 32])).map((r) => r.length)).toEqual([3, 1, 2]);
        expect(contiguousRuns([])).toEqual([]);
    });

    it("the AIR65 Oct-19 roll case: one bin missing at ≈ 43 Hz on 1.95 Hz bins breaks the trace there", () => {
        const step = 4000 / 2048;
        const hz = Array.from({ length: 24 }, (_, i) => (i + 5) * step).filter((f) => Math.abs(f - 42.97) > 0.5);
        const runs = contiguousRuns(grid(hz));
        expect(runs.length).toBe(2);
        expect(runs[0][runs[0].length - 1].freq).toBeCloseTo(41.02, 2);
        expect(runs[1][0].freq).toBeCloseTo(44.92, 2);
    });
});

describe("phase unwrap restarts at a gap", () => {
    it("inside a run the phase is continuous; across a gap no step is taken", () => {
        // A loop whose phase falls from −100° to −260° (wrapped +100°) over a gap: the old unwrap took
        // the −160° step as if the loop had been measured there.
        const pts = [
            { freq: 2, phase: -100 },
            { freq: 4, phase: -170 },
            { freq: 6, phase: 175 }, // wrapped: really −185°
            { freq: 14, phase: 100 }, // after a gap of three bins
            { freq: 16, phase: 90 },
        ];
        const out = unwrapPhaseByRun(pts).map((p) => p.phase);
        expect(out.slice(0, 3)).toEqual([-100, -170, -185]);
        // The new run keeps its own wrapped start and unwraps from there.
        expect(out.slice(3)).toEqual([100, 90]);
    });

    it("without a gap it is the ordinary unwrap", () => {
        const pts = [
            { freq: 2, phase: 170 },
            { freq: 4, phase: -170 },
            { freq: 6, phase: -150 },
        ];
        expect(unwrapPhaseByRun(pts).map((p) => p.phase)).toEqual([170, 190, 210]);
    });
});
