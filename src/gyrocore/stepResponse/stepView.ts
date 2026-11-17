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
 * Chart geometry for the step-response card: mean curves and their 25–75 % band over 0–500 ms on
 * a linear time axis, with the y = 1 (commanded step) and y = 0.5 (t50) reference lines.
 * Display only.
 */

import type { StepCurve } from "./stepResponse";

export interface StepChartSeries {
    id: string;
    curve: StepCurve;
}

export interface StepChart {
    lines: { id: string; d: string }[];
    bands: { id: string; d: string }[];
    ticksX: { x: number; label: string }[];
    ticksY: { y: number; label: string }[];
    oneY: number;
    halfY: number;
}

const TIME_TICKS = [0, 100, 200, 300, 400, 500];

/** Points thinned to at most ~400 per line; the y range covers every series and 0…1.2. */
export function stepChart(series: StepChartSeries[], width: number, height: number): StepChart | null {
    const usable = series.filter((s) => s.curve.timeMs.length > 1);
    if (!usable.length) return null;
    let lo = 0;
    let hi = 1.2;
    for (const s of usable) {
        for (const arr of [s.curve.mean, s.curve.p25, s.curve.p75]) {
            for (const v of arr) {
                if (!Number.isFinite(v)) continue;
                if (v < lo) lo = v;
                if (v > hi) hi = v;
            }
        }
    }
    lo = Math.max(lo, -1);
    hi = Math.min(hi, 3);
    const tMax = 500;
    const x = (t: number) => (Math.min(tMax, Math.max(0, t)) / tMax) * width;
    const y = (v: number) => height - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * height;
    const lines: StepChart["lines"] = [];
    const bands: StepChart["bands"] = [];
    for (const s of usable) {
        const { timeMs, mean, p25, p75 } = s.curve;
        const step = Math.max(1, Math.floor(timeMs.length / 400));
        const idx: number[] = [];
        for (let k = 0; k < timeMs.length; k += step) idx.push(k);
        if (idx[idx.length - 1] !== timeMs.length - 1) idx.push(timeMs.length - 1);
        lines.push({
            id: s.id,
            d: idx.map((k, j) => `${j ? "L" : "M"}${x(timeMs[k]).toFixed(1)} ${y(mean[k]).toFixed(1)}`).join(" "),
        });
        const upper = idx.map((k, j) => `${j ? "L" : "M"}${x(timeMs[k]).toFixed(1)} ${y(p75[k]).toFixed(1)}`);
        const lower = [...idx].reverse().map((k) => `L${x(timeMs[k]).toFixed(1)} ${y(p25[k]).toFixed(1)}`);
        bands.push({ id: s.id, d: `${upper.join(" ")} ${lower.join(" ")} Z` });
    }
    // The fixed references 0, 0.5 and 1, plus the range ends where they are not too close to one.
    const yTicks = [0, 0.5, 1, ...[lo, hi].filter((e) => [0, 0.5, 1].every((r) => Math.abs(e - r) >= 0.15))];
    return {
        lines,
        bands,
        ticksX: TIME_TICKS.map((t) => ({ x: x(t), label: String(t) })),
        ticksY: yTicks.map((v) => ({ y: y(v), label: v.toFixed(1) })),
        oneY: y(1),
        halfY: y(0.5),
    };
}
