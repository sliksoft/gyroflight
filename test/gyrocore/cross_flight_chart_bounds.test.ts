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
 * WU5 chart boundary fix: lineChart() at the float limit. Every bound, divisor,
 * coordinate and label must stay finite, the data must stay inside the plot, and
 * a range that cannot be drawn is null. Expected positions are worked out here
 * from the plot size (top = max, bottom = min), not taken from the chart code.
 */

import { describe, expect, it } from "vitest";
import { lineChart } from "../../src/gyrocore/compare/view";

const M = Number.MAX_VALUE;
const W = 520;
const H = 110;
const F = [10, 20, 40, 80];

type Chart = NonNullable<ReturnType<typeof lineChart>>;

/** Every number in the SVG path strings, in order. */
function pathNumbers(c: Chart): number[] {
    return c.paths.flatMap((p) =>
        p.d
            .split(/[\sML]+/)
            .filter((t) => t !== "" && t !== "l0" && t !== "0")
            .map(Number),
    );
}

/** y coordinates of the drawn points (the second number after each M or L). */
function pointYs(c: Chart): number[] {
    return c.paths.flatMap((p) => [...p.d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => Number(m[2])));
}

function expectFinite(c: Chart) {
    for (const n of pathNumbers(c)) {
        expect(Number.isFinite(n)).toBe(true);
    }
    expect(JSON.stringify(c)).not.toMatch(/NaN|Infinity|null(?!\})/);
    for (const t of [...c.ticksX, ...c.ticksY]) {
        expect(Number.isFinite("x" in t ? t.x : t.y)).toBe(true);
    }
    for (const t of c.ticksY) {
        expect(Number.isFinite(Number(t.label))).toBe(true);
        expect(t.y).toBeGreaterThanOrEqual(0);
        expect(t.y).toBeLessThanOrEqual(H);
    }
    if (c.zeroY !== null) {
        expect(Number.isFinite(c.zeroY)).toBe(true);
    }
    for (const y of pointYs(c)) {
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(H);
    }
}

function chart(values: (number | null)[], opts: Parameters<typeof lineChart>[4] = {}): Chart {
    const c = lineChart(F, [{ id: "s", values }], W, H, opts);
    expect(c).not.toBeNull();
    return c!;
}

describe("lineChart at the float limit", () => {
    it("constant +MAX_VALUE: finite bounds, the line sits on the top edge, labels are real numbers", () => {
        const c = chart([M, M, M, M]);
        expectFinite(c);
        // The data is the maximum of the range, so it is drawn at y = 0.
        expect(pointYs(c)).toEqual([0, 0, 0, 0]);
        // Top label is the measured value itself, not a clamped or invented one.
        expect(Number(c.ticksY[0].label)).toBe(M);
        expect(Number(c.ticksY[2].label)).toBeLessThan(M);
    });

    it("constant −MAX_VALUE: finite bounds, the line sits on the bottom edge", () => {
        const c = chart([-M, -M, -M, -M]);
        expectFinite(c);
        expect(pointYs(c)).toEqual([H, H, H, H]);
        expect(Number(c.ticksY[2].label)).toBe(-M);
        expect(Number(c.ticksY[0].label)).toBeGreaterThan(-M);
    });

    it("a single +MAX_VALUE or −MAX_VALUE point among gaps is drawn finitely", () => {
        for (const v of [M, -M]) {
            const c = chart([null, v, null, null]);
            expectFinite(c);
            expect(c.paths[0].points).toBe(1);
        }
    });

    it("nearly constant values next to the limit (MAX and its predecessor) stay finite and ordered", () => {
        const below = M - 2 ** 970; // one ulp under MAX_VALUE
        expect(below).toBeLessThan(M);
        const c = chart([M, below, M, below]);
        expectFinite(c);
        const [hiY, , loY] = c.ticksY.map((t) => Number(t.label));
        expect(hiY).toBeGreaterThanOrEqual(M - 2 ** 970);
        expect(loY).toBeLessThanOrEqual(below);
    });

    it("mixed extremes −MAX, 0, +MAX: top, middle and bottom of the plot", () => {
        const c = chart([-M, 0, M, null]);
        expectFinite(c);
        expect(pointYs(c)).toEqual([H, H / 2, 0]);
        expect(c.ticksY.map((t) => Number(t.label))).toEqual([M, 0, -M]);
        expect(c.zeroY).toBe(H / 2);
    });

    it("mixed extremes with includeZero, as the difference charts use it", () => {
        const c = chart([M, -M, 1, -1], { includeZero: true, digits: 2 });
        expectFinite(c);
        expect(pointYs(c).slice(0, 2)).toEqual([0, H]);
        expect(c.zeroY).toBe(H / 2);
    });

    it("constant ±MAX with includeZero spans 0..±MAX without padding past the limit", () => {
        const up = chart([M, M], { includeZero: true });
        expectFinite(up);
        expect(up.ticksY.map((t) => Number(t.label))).toEqual([M, M / 2, 0]);
        const down = chart([-M, -M], { includeZero: true });
        expectFinite(down);
        expect(down.ticksY.map((t) => Number(t.label))).toEqual([0, -M / 2, -M]);
    });

    it("non-finite values are gaps; only non-finite values means no chart", () => {
        const c = chart([Infinity, M, NaN, -Infinity]);
        expectFinite(c);
        expect(c.paths[0].points).toBe(1);
        expect(lineChart(F, [{ id: "s", values: [Infinity, -Infinity, NaN, null] }], W, H)).toBeNull();
    });

    it("a fixed range that is not finite or not ordered gives no chart instead of NaN coordinates", () => {
        expect(lineChart(F, [{ id: "s", values: [0.5] }], W, H, { range: [0, Infinity] })).toBeNull();
        expect(lineChart(F, [{ id: "s", values: [0.5] }], W, H, { range: [NaN, 1] })).toBeNull();
        expect(lineChart(F, [{ id: "s", values: [0.5] }], W, H, { range: [1, 0] })).toBeNull();
    });

    it("ordinary values keep their earlier geometry: a flat 5 gets ±1 and sits in the middle", () => {
        const c = chart([5, 5, 5, 5]);
        expectFinite(c);
        expect(c.ticksY.map((t) => t.label)).toEqual(["6.0", "5.0", "4.0"]);
        expect(pointYs(c)).toEqual([H / 2, H / 2, H / 2, H / 2]);
        const fixed = chart([0, 0.5, 1, null], { range: [0, 1], digits: 2 });
        expect(pointYs(fixed)).toEqual([H, H / 2, 0]);
    });
});
