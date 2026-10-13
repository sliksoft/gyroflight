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
 * Chart geometry for the cross-flight comparison view: line series over the
 * shared frequency bins on a log-frequency axis. A null value is a gap in the
 * line, never a zero and never bridged. Display only.
 */

export interface LineSeries {
    id: string;
    values: (number | null)[];
}

export interface LineChart {
    paths: { id: string; d: string; points: number }[];
    ticksX: { x: number; label: string }[];
    ticksY: { y: number; label: string }[];
    /** Where y = 0 is, when 0 is inside the range (difference charts). */
    zeroY: number | null;
}

const HZ_TICKS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];

function label(v: number, digits: number): string {
    const s = v.toFixed(digits);
    return s === `-${(0).toFixed(digits)}` ? (0).toFixed(digits) : s;
}

/**
 * `range` fixes the y range (coherence 0..1, coherence difference -1..1);
 * otherwise it spans the values, and always includes 0 when `includeZero`.
 */
export function lineChart(
    frequencyHz: number[],
    series: LineSeries[],
    width: number,
    height: number,
    opts: { range?: [number, number]; includeZero?: boolean; digits?: number } = {},
): LineChart | null {
    const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null && Number.isFinite(v)));
    if (!frequencyHz.length || !all.length) {
        return null;
    }
    let [lo, hi] = opts.range ?? [Math.min(...all), Math.max(...all)];
    if (opts.includeZero) {
        lo = Math.min(lo, 0);
        hi = Math.max(hi, 0);
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(lo <= hi)) {
        return null;
    }
    if (!(hi - lo >= 1e-9 * Math.max(1, Math.abs(lo), Math.abs(hi)))) {
        // A flat range gets padding; at the float limit the side that would overflow stays put
        // and the other side takes both pads, so the bounds stay finite and still contain the data.
        const pad = Math.max(1, Math.abs(lo) * 1e-6, Math.abs(hi) * 1e-6);
        if (!Number.isFinite(hi + pad)) {
            lo -= 2 * pad;
        } else if (!Number.isFinite(lo - pad)) {
            hi += 2 * pad;
        } else {
            lo -= pad;
            hi += pad;
        }
    }
    // Scaled so that hi − lo cannot overflow for magnitudes near the float limit.
    const scale = Math.max(1, Math.abs(lo), Math.abs(hi));
    const sLo = lo / scale;
    const sSpan = hi / scale - sLo;
    if (!Number.isFinite(scale) || !(sSpan > 0) || !Number.isFinite(sSpan)) {
        return null;
    }
    const fLo = frequencyHz[0];
    const fHi = frequencyHz[frequencyHz.length - 1];
    const span = Math.log10(fHi / fLo) || 1;
    const x = (f: number) => (Math.log10(f / fLo) / span) * width;
    const y = (v: number) => height - ((Math.max(lo, Math.min(hi, v)) / scale - sLo) / sSpan) * height;
    const paths = series.map((s) => {
        let d = "";
        let pen = false;
        let points = 0;
        s.values.forEach((v, i) => {
            if (v === null || !Number.isFinite(v) || i >= frequencyHz.length) {
                pen = false;
                return;
            }
            const px = x(frequencyHz[i]).toFixed(1);
            const py = y(v).toFixed(1);
            // A lone point is drawn as a zero-length segment (a dot with round caps).
            d += pen ? ` L${px} ${py}` : ` M${px} ${py} l0 0`;
            pen = true;
            points++;
        });
        return { id: s.id, d: d.trim(), points };
    });
    const digits = opts.digits ?? 1;
    return {
        paths,
        ticksX: HZ_TICKS.filter((t) => t >= fLo && t <= fHi).map((t) => ({
            x: x(t),
            label: t >= 1000 ? `${t / 1000}k` : String(t),
        })),
        ticksY: [hi, lo / 2 + hi / 2, lo].map((v) => ({ y: y(v), label: label(v, digits) })),
        zeroY: lo < 0 && hi > 0 ? y(0) : null,
    };
}
