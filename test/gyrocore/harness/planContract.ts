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
 * The measurement plan's contract, checked with the analysis's own count (planner safety repair
 * 2026-10-28): the planned sweeps give every stability decision its averages on the planned
 * segments, counted in whole samples (loopModel sweepAverages), and are no longer than that.
 */

import { expect } from "vitest";
import type { AxisMeasurementPlan } from "../../../src/gyrocore/engine/measurementPlan";
import { sweepAverages, UNCERTAINTY } from "../../../src/gyrocore/engine/loopModel";

const segmentsOf = (T: number, fs: number, N: number) =>
    Math.max(1, Math.floor((Math.floor(T * fs) - N) / (N / 2)) + 1);
const grid = (hz: number, df: number) => Math.max(1, Math.round(hz / df)) * df;

function deliveredAt(
    sweep: { f0Hz: number; f1Hz: number; durationS: number },
    N: number,
    fs: number,
    hz: number,
): number {
    return sweepAverages(
        grid(hz, fs / N),
        { segmentSamples: N, sampleRateHz: fs, segments: segmentsOf(sweep.durationS, fs, N) },
        sweep,
    );
}

/** Every decision gets its averages from the planned primary sweep, which is minimal for them. */
export function expectPrimaryPlanDelivers(p: AxisMeasurementPlan, fs: number): void {
    const N = p.segmentSamples.primary!;
    const s = p.sweep!;
    const inBand = (hz: number) => grid(hz, fs / N) >= s.f0Hz && grid(hz, fs / N) <= s.f1Hz;
    const targets = p.averagesAt.filter((a) => a.needed !== null && inBand(a.hz));
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.some((a) => a.purpose === "gain_crossover")).toBe(true);
    for (const a of targets) {
        expect(deliveredAt(s, N, fs, a.hz), `${a.purpose} at ${a.hz.toFixed(1)} Hz`).toBeGreaterThanOrEqual(a.needed!);
        expect(a.primary).toBe(deliveredAt(s, N, fs, a.hz));
    }
    // The window holds the next finer rung with UNCERTAINTY.minWelchSegments segments (convergence).
    const floor = (2 * N * (UNCERTAINTY.minWelchSegments + 1)) / 2;
    expect(p.windowSamples.primary!).toBeGreaterThanOrEqual(floor);
    // Minimal: 1 % shorter misses a target, unless the floor sets the length.
    const shorter = { ...s, durationS: s.durationS * 0.99 };
    const floorBinds = shorter.durationS * fs < floor;
    expect(floorBinds || targets.some((a) => deliveredAt(shorter, N, fs, a.hz) < a.needed!)).toBe(true);
}

/** The qualification sweep gives every decision its averages and its highest bin one whole segment. */
export function expectQualificationPlanDelivers(p: AxisMeasurementPlan, fs: number): void {
    const N = p.segmentSamples.qualification!;
    const s = p.qualificationSweep!;
    const df = fs / N;
    for (const a of p.averagesAt.filter((x) => x.needed !== null)) {
        expect(deliveredAt(s, N, fs, a.hz), `${a.purpose} at ${a.hz.toFixed(1)} Hz`).toBeGreaterThanOrEqual(a.needed!);
    }
    const top = Math.floor(s.f1Hz / df) * df;
    expect(deliveredAt(s, N, fs, top)).toBeGreaterThanOrEqual(1);
    expect(p.windowSamples.qualification!).toBeGreaterThanOrEqual((N * (UNCERTAINTY.minWelchSegments + 1)) / 2);
}
