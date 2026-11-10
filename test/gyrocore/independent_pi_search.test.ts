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
 * Block 11: P and I searched independently. The ±MAX_STEP grid (pidOptimizer searchGrid) and the
 * wider target search (candidateDecision targetGrid / targetSearch) scale P, I and D each on their
 * own; the former coupled grid (I on P's scale) is kept inside the new one, candidates equal after
 * rounding are read once, and the step limit holds per term after rounding. The decision is checked
 * on a stand-in loop model whose margins meet the targets only when I moves away from P's scale.
 */

import { describe, expect, it, vi } from "vitest";
import type { AxisLoop, LoopMargins } from "../../src/gyrocore/engine/loopModel";
import type { DigitalControllerConfig } from "../../src/js/blackbox/betaflight_digital_controller";

// Stand-in margins: a function of the candidate's P and I only, read through loopMargins as the
// decision does. Both shapes (within one step / beyond it) are set per test through `model`.
let model: (
    ps: number,
    is: number,
    ds: number,
) => { pm: number; gm: number; s: number; fc: number; reasons?: string[] } = () => ({
    pm: 0,
    gm: 0,
    s: 0,
    fc: 0,
});
const P0 = 45;
const I0 = 80;
const D0 = 30;

vi.mock("../../src/gyrocore/engine/loopModel", async (importOriginal) => {
    const orig = await importOriginal<typeof import("../../src/gyrocore/engine/loopModel")>();
    const margins = (cfg: DigitalControllerConfig): LoopMargins => {
        const m = model(cfg.axis.p / P0, cfg.axis.i / I0, cfg.axis.d / D0);
        return {
            status: "NOT_VALIDATED",
            crossoverHz: m.fc,
            phaseMarginDeg: m.pm,
            gainMarginDb: null,
            sensitivityPeakDb: null,
            delayMarginMs: null,
            chainSpreadDeg: null,
            okBins: 20,
            evidence: {
                level: "MEASURED",
                resolutionHz: 1.95,
                bandHz: [7.8, 50.8],
                minFeatureWidthHz: null,
                assumptions: [],
                qualification: null,
            },
            measured: { phaseMarginDeg: m.pm, gainMarginDb: m.gm, sensitivityPeakDb: m.s },
            reasons: m.reasons ?? [],
        } as unknown as LoopMargins;
    };
    return {
        ...orig,
        loopMargins: (loop: AxisLoop, cand?: { cfg: DigitalControllerConfig }) => margins(cand?.cfg ?? loop.cfg),
        candidateLoop: () => [],
        missingBandBins: () => [],
    };
});

const { MAX_STEP, SCALES, searchGrid } = await import("../../src/gyrocore/engine/pidOptimizer");
const { TARGET_SEARCH, decideAxis, scalesOf, targetGrid } = await import("../../src/gyrocore/engine/candidateDecision");

const CURRENT = { p: P0, i: I0, d: D0, dMax: 40 };
const loop = {
    axis: 0,
    plant: { bins: [] },
    cfg: { axis: { p: P0, i: I0, d: 30 } },
    chain: null,
    chainValidated: false,
    attested: false,
    uncertainty: { relErr: new Map() },
    support: null,
    sweep: null,
    resolution: null,
} as unknown as AxisLoop;

const key = (v: { p: number; i: number; d: number; dMax: number }) => `${v.p}|${v.i}|${v.d}|${v.dMax}`;

/** The former coupled ±MAX_STEP grid: I on P's scale, D on its own; d_max as the grid forms it. */
function coupledGrid(cur: typeof CURRENT) {
    const out = [];
    for (const ps of SCALES)
        for (const ds of cur.d > 0 ? SCALES : [1])
            out.push({
                p: Math.round(cur.p * ps),
                i: Math.round(cur.i * ps),
                d: Math.round(cur.d * ds),
                dMax: cur.dMax > 0 ? Math.max(Math.round(cur.dMax * ds), Math.round(cur.d * ds)) : 0,
            });
    return out;
}

/** The former coupled wider grid: P and I on pScale together, D on dScale. */
function coupledTargetGrid(cur: typeof CURRENT) {
    const out = [];
    for (const ps of scalesOf(TARGET_SEARCH.pScale, TARGET_SEARCH.step))
        for (const ds of cur.d > 0 ? scalesOf(TARGET_SEARCH.dScale, TARGET_SEARCH.step) : [1]) {
            const d = Math.round(cur.d * ds);
            out.push({
                p: Math.round(cur.p * ps),
                i: Math.round(cur.i * ps),
                d,
                dMax: cur.dMax > 0 ? Math.max(Math.round(cur.dMax * ds), d) : 0,
            });
        }
    return out;
}

const CURRENTS = [
    CURRENT,
    { p: 56, i: 79, d: 30, dMax: 40 },
    { p: 82, i: 117, d: 61, dMax: 0 },
    { p: 7, i: 9, d: 3, dMax: 4 },
];

describe("±MAX_STEP grid with P and I independent (searchGrid)", () => {
    it("keeps every point of the former coupled grid, and reads each candidate once after rounding", () => {
        for (const cur of CURRENTS) {
            const grid = [...searchGrid(cur, null)];
            const keys = grid.map(key);
            expect(new Set(keys).size).toBe(keys.length);
            for (const v of coupledGrid(cur)) expect(keys).toContain(key(v));
            // Wider than the coupled grid: P and I on different scales appear.
            expect(grid.some((v) => v.p === Math.round(cur.p * 1.0) && v.i === Math.round(cur.i * 0.7))).toBe(true);
            // Before deduplication: one point per (P, I, D) scale; the AIR65 values round apart everywhere.
            if (cur.p >= 40) expect(grid.length).toBe(SCALES.length * SCALES.length * SCALES.length);
        }
    });

    it("holds the step limit per term after rounding, and every term is a point of SCALES", () => {
        for (const cur of CURRENTS) {
            const lo = (c: number) => Math.round(c * (1 - MAX_STEP));
            const hi = (c: number) => Math.round(c * (1 + MAX_STEP));
            const onScale = (x: number, c: number) => SCALES.some((s) => Math.round(c * s) === x);
            for (const v of searchGrid(cur, null)) {
                for (const k of ["p", "i", "d"] as const) {
                    expect(v[k]).toBeGreaterThanOrEqual(lo(cur[k]));
                    expect(v[k]).toBeLessThanOrEqual(hi(cur[k]));
                    expect(onScale(v[k], cur[k])).toBe(true);
                }
                // d_max keeps its ratio to D (on D's scale), never below D; 0 stays 0.
                if (cur.dMax > 0) {
                    expect(v.dMax).toBeGreaterThanOrEqual(v.d);
                    expect(
                        SCALES.some((s) => Math.max(Math.round(cur.dMax * s), Math.round(cur.d * s)) === v.dMax),
                    ).toBe(true);
                } else expect(v.dMax).toBe(0);
            }
        }
    });

    it("small values that round together are read once; the current tune itself is one point", () => {
        const cur = { p: 7, i: 9, d: 3, dMax: 4 };
        const grid = [...searchGrid(cur, null)];
        expect(grid.length).toBeLessThan(SCALES.length ** 3);
        expect(grid.filter((v) => key(v) === key(cur)).length).toBe(1);
    });
});

describe("wider target grid with P and I independent (targetGrid)", () => {
    it("keeps every point of the former coupled wider grid, with I on its own bounds, each point once", () => {
        expect(TARGET_SEARCH.iScale).toEqual(TARGET_SEARCH.pScale);
        for (const cur of CURRENTS) {
            const pts = [...targetGrid(cur)];
            const keys = pts.map((x) => key(x.v));
            expect(new Set(keys).size).toBe(keys.length);
            for (const v of coupledTargetGrid(cur)) expect(keys).toContain(key(v));
            for (const { v, ps, is, ds } of pts) {
                expect(v.p).toBe(Math.round(cur.p * ps));
                expect(v.i).toBe(Math.round(cur.i * is));
                expect(v.d).toBe(Math.round(cur.d * ds));
                expect(is).toBeGreaterThanOrEqual(TARGET_SEARCH.iScale[0]);
                expect(is).toBeLessThanOrEqual(TARGET_SEARCH.iScale[1]);
            }
            // The one-step range stays apart from the wider search: the wider grid reaches below ×0.7 on I alone.
            expect(pts.some((x) => x.v.p === cur.p && x.v.i < Math.round(cur.i * (1 - MAX_STEP)))).toBe(true);
        }
    });
});

describe("decideAxis finds what only independent P/I scaling reaches (stand-in loop model)", () => {
    const meets = (m: { pm: number; gm: number; s: number }) => m.pm >= 45 && m.gm >= 6 && m.s <= 6;

    it("within one step: a candidate with I lowered and P kept is offered; no coupled point meets the targets", () => {
        // Margins improve as I falls, and fall away as P leaves its value: only I alone reaches the targets.
        model = (ps, is) => ({
            pm: 20 + 90 * (1 - is) - 400 * Math.abs(1 - ps),
            gm: 3 + 12 * (1 - is) - 5 * Math.abs(1 - ps),
            s: 12 - 22 * (1 - is) + 10 * Math.abs(1 - ps),
            fc: 25 * ps,
        });
        for (const v of coupledGrid(CURRENT)) expect(meets(model(v.p / P0, v.i / I0, v.d / D0))).toBe(false);
        const d = decideAxis({ route: "primary", loop, current: CURRENT });
        expect(d.status).toBe("candidate_found");
        expect(d.searchRan).toBe(true);
        expect(d.candidatesTried).toBe(SCALES.length ** 3);
        expect(d.target ?? null).toBeNull();
        const v = d.candidate!.proposed;
        expect(v.p).toBe(P0);
        expect(v.i).toBeLessThanOrEqual(Math.round(I0 * 0.7));
        expect(v.i).toBeGreaterThanOrEqual(Math.round(I0 * (1 - MAX_STEP)));
        expect(d.candidate!.changed).toBe(true);
        expect(meets(model(v.p / P0, v.i / I0, v.d / D0))).toBe(true);
        // Offered as the highest crossover among those meeting the targets: P unchanged.
        expect(d.candidate!.proposedMargins.crossoverHz).toBeCloseTo(25, 6);
        expect(typeof d.searchMs).toBe("number");
    });

    it("beyond one step: the wider search finds the target with I alone; the first step is a point of the ±MAX_STEP grid", () => {
        model = (ps, is) => ({
            pm: 20 + 60 * (1 - is) - 400 * Math.abs(1 - ps),
            gm: 3 + 8 * (1 - is) - 5 * Math.abs(1 - ps),
            s: 12 - 14 * (1 - is) + 10 * Math.abs(1 - ps),
            fc: 25 * ps,
        });
        for (const v of searchGrid(CURRENT, null)) expect(meets(model(v.p / P0, v.i / I0, v.d / D0))).toBe(false);
        for (const v of coupledTargetGrid(CURRENT)) expect(meets(model(v.p / P0, v.i / I0, v.d / D0))).toBe(false);
        const d = decideAxis({ route: "primary", loop, current: CURRENT });
        expect(d.status).toBe("target_beyond_max_step");
        const t = d.target!;
        expect(t.iScale).toEqual(TARGET_SEARCH.iScale);
        expect(t.target!.values.p).toBe(P0);
        expect(t.target!.values.i).toBeLessThan(Math.round(I0 * (1 - MAX_STEP)));
        expect(t.target!.meetsTargets).toBe(true);
        // The step: I clipped to −30 %, P unchanged; D follows the target (the stand-in margins do not see
        // D, so the first point in grid order, D ×0.5, wins the crossover tie) clipped to −30 %, and d_max is
        // formed on that same scale as the grid forms it — a grid point.
        expect(t.target!.values.d).toBe(Math.round(D0 * TARGET_SEARCH.dScale[0]));
        expect(t.step!.values).toEqual({
            p: P0,
            i: Math.round(I0 * (1 - MAX_STEP)),
            d: Math.round(D0 * (1 - MAX_STEP)),
            dMax: Math.max(Math.round(40 * (1 - MAX_STEP)), Math.round(D0 * (1 - MAX_STEP))),
        });
        expect([...searchGrid(CURRENT, null)]).toContainEqual(t.step!.values);
        expect(t.step!.meetsTargets).toBe(false);
        expect(d.candidate!.reasons).toContain("target_beyond_max_step");
        expect(d.checks.find((c) => c.rule === "target_search_wider_bounds")!.threshold).toContain(
            `I ×${TARGET_SEARCH.iScale[0]}–${TARGET_SEARCH.iScale[1]}`,
        );
    });

    it("a read whose phase branch is unverified (PM off by 360°) is neither ranked nor counted usable", () => {
        // The AIR65 JIO roll shape: at a high I/P ratio the loop model cannot verify the phase branch and
        // reads PM ≈ 400° with GM < 0; without the guard such a read would be the "safest" (highest PM).
        model = (ps, is) => {
            const wrapped = (is * I0) / (ps * P0) > 2.5;
            return {
                pm: wrapped ? 400 : 20 + 10 * (1 - is),
                gm: wrapped ? -20 : 3,
                s: wrapped ? 7 : 12,
                fc: 25 * ps,
                reasons: wrapped ? ["phase_branch_unverified:loop_phase_not_plant_plus_controller"] : [],
            };
        };
        const d = decideAxis({ route: "primary", loop, current: CURRENT });
        expect(["targets_not_reachable", "target_search_limit"]).toContain(d.status);
        const grid = [...searchGrid(CURRENT, null)];
        const wrappedInGrid = grid.filter((v) => v.i / v.p > 2.5).length;
        expect(wrappedInGrid).toBeGreaterThan(0);
        expect(d.candidatesUsable).toBe(grid.length - wrappedInGrid);
        expect(d.candidate!.proposedMargins.phaseMarginDeg).toBeLessThan(180);
        expect(d.candidate!.proposed.i / d.candidate!.proposed.p).toBeLessThanOrEqual(2.5);
        const t = d.target!;
        expect(t.target).toBeNull();
        expect(t.best!.pmDeg).toBeLessThan(180);
        expect(t.best!.values.i / t.best!.values.p).toBeLessThanOrEqual(2.5);
        expect(t.usable).toBeLessThan(t.tried);
    });

    it("the current tune's own read on an unverified phase branch stops the search, as it would a candidate", () => {
        model = (ps, is) => ({
            pm: ps === 1 && is === 1 ? 395 : 50,
            gm: ps === 1 && is === 1 ? -15 : 8,
            s: 5,
            fc: 25 * ps,
            reasons: ps === 1 && is === 1 ? ["phase_branch_unverified:loop_phase_not_plant_plus_controller"] : [],
        });
        const d = decideAxis({ route: "primary", loop, current: CURRENT });
        expect(d.status).toBe("plant_band_insufficient");
        expect(d.searchRan).toBe(false);
        expect(d.candidate).toBeNull();
        expect(d.firstCause).toMatchObject({
            rule: "decision_band_phase_branch",
            value: "phase_branch_unverified:loop_phase_not_plant_plus_controller",
            result: "fail",
        });
        // The wrapped read is not shown as the current margins either.
        expect(d.current).toBeNull();
        expect(d.metrics).not.toBeNull();
    });

    it("the step's d_max follows D's clipped scale when the target moves D inside one step", () => {
        // Target at D ×0.75 (not on the ±30 % edge; it wins the crossover ranking there): the step keeps
        // that D and forms d_max on the same scale, as the grid does (40 × 0.75 = 30, not 40 × 23 / 30 = 31).
        model = (ps, is, ds) => ({
            pm: 20 + 60 * (1 - is) - 400 * Math.abs(1 - ps),
            gm: 3 + 8 * (1 - is) - 5 * Math.abs(1 - ps),
            s: 12 - 14 * (1 - is) + 10 * Math.abs(1 - ps),
            fc: 25 * ps + (Math.abs(ds - 0.75) < 0.02 ? 0.5 : 0),
        });
        const d = decideAxis({ route: "primary", loop, current: CURRENT });
        expect(d.status).toBe("target_beyond_max_step");
        expect(d.target!.target!.values.d).toBe(Math.round(D0 * 0.75));
        expect(d.target!.step!.values).toEqual({ p: P0, i: Math.round(I0 * (1 - MAX_STEP)), d: 23, dMax: 30 });
        const grid = [...searchGrid(CURRENT, null)];
        expect(grid).toContainEqual(d.target!.step!.values);
        // And for any target D on a wider-grid scale inside ±30 %, the grid's d_max rule gives the same d_max.
        for (const ds of [0.75, 0.8, 1.1, 1.25]) {
            const dv = Math.round(CURRENT.d * ds);
            const dMax = Math.max(Math.round(CURRENT.dMax * ds), dv);
            expect(grid.some((v) => v.d === dv && v.dMax === dMax)).toBe(true);
        }
    });
});
