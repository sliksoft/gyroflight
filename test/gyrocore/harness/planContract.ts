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
 * The measurement plan's contract, checked with an independent count (planner safety repair
 * 2026-10-28; Codex review P2): the samples of the planned sweep, taken from its forward definition
 * f(t) = f0 · (f1 / f0)^(t / T) at every sample instant and kept when strictly inside the bin, in
 * whole Welch segments, capped at the window's non-overlapping count. Not the production
 * sweepAverages: an error shared by planner and analysis would not show against it.
 */

import { expect } from "vitest";
import type { AxisMeasurementPlan } from "../../../src/gyrocore/engine/measurementPlan";
import { UNCERTAINTY } from "../../../src/gyrocore/engine/loopModel";

type Sweep = { f0Hz: number; f1Hz: number; durationS: number };

/** Whole segments of N samples the sweep spends strictly inside the bin of width fs / N around hz. */
export function oracleAverages(sweep: Sweep, N: number, fs: number, hz: number): number {
    const df = fs / N;
    const centre = Math.max(1, Math.round(hz / df)) * df;
    const lo = centre - df / 2;
    const hi = centre + df / 2;
    const T = sweep.durationS;
    const L = Math.log(sweep.f1Hz / sweep.f0Hz);
    const f = (k: number) => sweep.f0Hz * Math.exp((L * k) / (fs * T));
    const kOf = (x: number) => (fs * T * Math.log(Math.min(Math.max(x, sweep.f0Hz), sweep.f1Hz) / sweep.f0Hz)) / L;
    const last = Math.floor(fs * T);
    let n = 0;
    for (let k = Math.max(0, Math.floor(kOf(lo)) - 2); k <= Math.min(last, Math.ceil(kOf(hi)) + 2); k++) {
        const fk = f(k);
        if (fk > lo && fk < hi) n++;
    }
    // The analysed window, one sample short of the sweep as on real logs.
    const W = Math.floor(fs * T) - 1;
    const K = W >= N ? Math.floor((W - N) / (N / 2)) + 1 : 0;
    return Math.min(Math.floor((K + 1) / 2), Math.floor(n / N));
}

const onSweep = (hz: number, s: Sweep, N: number, fs: number) => {
    const c = Math.max(1, Math.round(hz / (fs / N))) * (fs / N);
    return c > s.f0Hz && c < s.f1Hz;
};

/** Every decision gets its averages from the planned primary sweep, which is minimal in whole seconds. */
export function expectPrimaryPlanDelivers(p: AxisMeasurementPlan, fs: number): void {
    const N = p.segmentSamples.primary!;
    const s = p.sweep!;
    // The firmware's units: 0.1 Hz band edges, whole seconds.
    expect(Number.isInteger(s.durationS)).toBe(true);
    expect(Math.abs(s.f0Hz * 10 - Math.round(s.f0Hz * 10))).toBeLessThan(1e-9);
    expect(Math.abs(s.f1Hz * 10 - Math.round(s.f1Hz * 10))).toBeLessThan(1e-9);
    const targets = p.averagesAt.filter((a) => a.needed !== null && onSweep(a.hz, s, N, fs));
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.some((a) => a.purpose === "gain_crossover")).toBe(true);
    for (const a of targets) {
        const delivered = oracleAverages(s, N, fs, a.hz);
        expect(delivered, `${a.purpose} at ${a.hz.toFixed(1)} Hz`).toBeGreaterThanOrEqual(a.needed!);
        // The plan never reports more than the sweep delivers.
        expect(a.primary!).toBeLessThanOrEqual(delivered);
        expect(a.primary!).toBeGreaterThanOrEqual(a.needed!);
    }
    // Decisions the sweep does not cover are named, not silently dropped.
    for (const a of p.averagesAt.filter((x) => x.needed !== null && !onSweep(x.hz, s, N, fs))) {
        expect(p.diagnostics.some((d) => d.startsWith(`decision_outside_planned_band:primary:${a.purpose}:`))).toBe(
            true,
        );
    }
    // The window holds the next finer rung with UNCERTAINTY.minWelchSegments segments (convergence).
    const floor = (2 * N * (UNCERTAINTY.minWelchSegments + 1)) / 2;
    expect(p.windowSamples.primary!).toBeGreaterThanOrEqual(floor);
    // Minimal: one second shorter misses a target, unless the floor sets the length.
    const shorter = { ...s, durationS: s.durationS - 1 };
    const floorBinds = shorter.durationS * fs < floor;
    expect(floorBinds || targets.some((a) => oracleAverages(shorter, N, fs, a.hz) < a.needed!)).toBe(true);
}

/** The qualification sweep gives every decision its averages and its highest bin one whole segment. */
export function expectQualificationPlanDelivers(p: AxisMeasurementPlan, fs: number): void {
    const N = p.segmentSamples.qualification!;
    const s = p.qualificationSweep!;
    expect(Number.isInteger(s.durationS)).toBe(true);
    const df = fs / N;
    for (const a of p.averagesAt.filter((x) => x.needed !== null && onSweep(x.hz, s, N, fs))) {
        const delivered = oracleAverages(s, N, fs, a.hz);
        expect(delivered, `${a.purpose} at ${a.hz.toFixed(1)} Hz`).toBeGreaterThanOrEqual(a.needed!);
        expect(a.qualification!).toBeLessThanOrEqual(delivered);
    }
    // The highest bin of the planned qualification band (the band's own top, inside the sweep).
    const top = Math.floor(p.bandHz.qualification![1] / df) * df;
    expect(oracleAverages(s, N, fs, top)).toBeGreaterThanOrEqual(1);
    expect(p.windowSamples.qualification!).toBeGreaterThanOrEqual((N * (UNCERTAINTY.minWelchSegments + 1)) / 2);
}
