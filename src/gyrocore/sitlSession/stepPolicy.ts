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
 * Step policy of the AutoTune session (block 14, protocol session_v1): which bounded PID step to try next.
 *
 * Input: the engine's bounded step search (sessionSearch) on the LAST ACCEPTED measurement, that measurement's summary,
 * the measured motor band of the accepted measurement against the start (for the cumulative motor limit) and the
 * session state (trust region ρ per axis, excluded points, the axis of the last rejection).
 *
 * One axis per step. Axes with a measured shortfall (decision.ts measuredShortfall) are tried in this order: the axis
 * of the last rejection first (a next candidate on the same axis), then by measured shortfall, largest first; the next
 * axis is tried only when an axis has no eligible candidate. A candidate is eligible when
 *   - it is not excluded: farther than exclusionRadiusShare × the rejected step's size from every rejected point of
 *     that axis (distance = the largest relative change of P, I or D against the accepted tune);
 *   - its motor load is predicted (motor model assessable) and the highest predicted per-motor ratio is ≤ 1.10 both
 *     against the accepted tune and, multiplied by the measured accepted/start ratio of that motor, against the start;
 *   - the guards the engine can predict hold on its predicted margins against the current tune's predicted margins
 *     (the same limits as decision.ts): a met target stays met, PM not more than 5° lower, GM not more than 1.5 dB lower,
 *     |S| not more than 1 dB higher and ≤ max(10 dB, current), crossover ≥ 0.92 × current (G2, G6 |S|, and G5
 *     crossover with a margin for the engine's 1–2 % crossover prediction error: G5 itself is 0.9);
 *     the step-response guards (G3–G5 rise, G6 oscillation) are not predicted: the re-measurement decides them; the same
 *     predicted guards also hold against the START measurement, with the predicted change applied to the accepted
 *     measurement (session_v1.1: per-step allowances may not add up over several steps);
 *   - and (a) its predicted shortfall is at least predictedMinShortfallDrop below the current one as predicted, or
 *     (b) it is predicted to meet a target the current tune is predicted to miss (no size of the drop required: the
 *     re-measurement's V2 rule and the guards decide whether such a small step stays).
 * Ranking: (a) before (b); within (a) the largest predicted drop, then the smallest step; within (b) the smallest step,
 * then the largest drop.
 */

import type { PidValues } from "@/gyrocore/engine/pidOptimizer";
import type { SessionCandidate, SessionSearchResult } from "@/gyrocore/engine/sessionSearch";
import { meetsOf, shortfallOf } from "@/gyrocore/engine/sessionSearch";
import { measuredMeets as measuredMeetsOf, measuredShortfall, type MeasurementSummary } from "./decision";
import { SESSION_PROTOCOL as P, type SessionAxis } from "./protocol";

export interface Excluded {
    axis: SessionAxis;
    pid: PidValues;
    /** Relative step size of the rejected candidate against the tune it was tried from. */
    stepSize: number;
}

export interface PolicyState {
    rho: Record<SessionAxis, number>;
    excluded: Excluded[];
    lastRejectedAxis: SessionAxis | null;
}

export interface StepChoice {
    axis: SessionAxis;
    from: PidValues;
    to: PidValues;
    kind: "shortfall_drop" | "target_transition";
    predicted: SessionCandidate["predicted"];
    predictedShortfall: number;
    currentPredictedShortfall: number;
    predictedMotorMax: number;
    predictedMotorMaxVsStart: number;
    stepSize: number;
    /** Axes tried before this one without an eligible candidate, with why. */
    skipped: { axis: SessionAxis; reason: string }[];
}

export type PolicyOutcome =
    | { kind: "step"; choice: StepChoice }
    | { kind: "stop"; reason: "targets_met" | "no_eligible_candidate" | "step_floor"; detail: string[] };

export function stepSizeOf(from: PidValues, to: PidValues): number {
    const rel = (x: number, c: number) => (c > 0 ? Math.abs(x / c - 1) : x === c ? 0 : 1);
    return Math.max(rel(to.p, from.p), rel(to.i, from.i), rel(to.d, from.d));
}

export function initialPolicyState(): PolicyState {
    return { rho: { roll: P.policy.rhoStart, pitch: P.policy.rhoStart }, excluded: [], lastRejectedAxis: null };
}

/** The axes the next step may change, in policy order, with their measured shortfall. */
export function axisOrder(base: MeasurementSummary, state: PolicyState): { axis: SessionAxis; shortfall: number }[] {
    const open = P.axes
        .map((axis) => ({ axis, shortfall: base.axes[axis] ? measuredShortfall(base.axes[axis]!) : 0 }))
        .filter((x) => x.shortfall > 0)
        .sort((a, b) => b.shortfall - a.shortfall);
    const last = state.lastRejectedAxis;
    if (last) {
        const i = open.findIndex((x) => x.axis === last);
        if (i > 0) open.unshift(...open.splice(i, 1));
    }
    return open;
}

export function chooseStep(o: {
    search: SessionSearchResult;
    base: MeasurementSummary;
    /** Per motor: measured median of the accepted measurement / that of the start measurement. */
    acceptedVsStart: number[];
    state: PolicyState;
    /** The start measurement: the predicted guards also hold against it (session_v1.1); absent: the base is the start. */
    start?: MeasurementSummary;
}): PolicyOutcome {
    const order = axisOrder(o.base, o.state);
    if (!order.length) return { kind: "stop", reason: "targets_met", detail: [] };
    const open = order.filter((x) => o.state.rho[x.axis] >= P.policy.rhoFloor);
    if (!open.length)
        return { kind: "stop", reason: "step_floor", detail: order.map((x) => `${x.axis}:rho_${o.state.rho[x.axis]}`) };
    const skipped: StepChoice["skipped"] = [];
    for (const { axis } of open) {
        const s = o.search.axes.find((x) => x.axis === axis);
        if (!s || s.status !== "searched" || !s.current || !s.currentRead) {
            skipped.push({ axis, reason: s ? `search_${s.status}:${s.reasons.join(",")}` : "not_searched" });
            continue;
        }
        if (!o.search.motorModel.assessable) {
            skipped.push({ axis, reason: `motor_model_not_assessable:${o.search.motorModel.reasons.join(",")}` });
            continue;
        }
        const cur = s.current;
        const cr = s.currentRead;
        const d0 = shortfallOf(cr.pmDeg, cr.gmDb, cr.sDb);
        const m0 = meetsOf(cr.pmDeg, cr.gmDb, cr.sDb);
        const rho = o.state.rho[axis];
        const ex = o.state.excluded.filter((x) => x.axis === axis);
        const rows: {
            c: SessionCandidate;
            kind: StepChoice["kind"];
            drop: number;
            size: number;
            mMax: number;
            mStart: number;
        }[] = [];
        for (const c of s.candidates) {
            const size = stepSizeOf(cur, c.values);
            if (size > rho + 1e-9) continue;
            if (ex.some((x) => stepSizeOf(x.pid, c.values) < P.policy.exclusionRadiusShare * x.stepSize + 1e-9))
                continue;
            if (!c.motorRatios) continue;
            const mMax = Math.max(...c.motorRatios);
            const mStart = Math.max(...c.motorRatios.map((r, m) => r * (o.acceptedVsStart[m] ?? Number.NaN)));
            if (!(mMax <= P.guards.motorMaxRatio) || !(mStart <= P.guards.motorMaxRatio)) continue;
            const pr = c.predicted;
            const predictedGuards =
                (!m0.pm || c.meets.pm) &&
                (!m0.gm || c.meets.gm) &&
                (!m0.s || c.meets.s) &&
                pr.pmDeg >= cr.pmDeg - P.tolerance.pmDeg &&
                pr.gmDb >= cr.gmDb - P.tolerance.gmDb &&
                pr.sDb <= cr.sDb + P.tolerance.sDb &&
                pr.sDb <= Math.max(P.guards.sMaxDb, cr.sDb) &&
                pr.crossoverHz >= P.policy.predictedFcMinRel * cr.crossoverHz;
            if (!predictedGuards) continue;
            // Against the start: the predicted change applied to the accepted measurement, compared with the start measurement.
            const bA = o.base.axes[axis];
            const sA = (o.start ?? o.base).axes[axis];
            if (bA && sA) {
                const pm = bA.pm.median + (pr.pmDeg - cr.pmDeg);
                const gm = bA.gmLow + (pr.gmDb - cr.gmDb);
                const sp = bA.s.median + (pr.sDb - cr.sDb);
                const fc = bA.fc.median * (pr.crossoverHz / cr.crossoverHz);
                const sMet = measuredMeetsOf(sA);
                const vsStart =
                    (!sMet.pm || pm >= P.targets.pmDeg) &&
                    (!sMet.gm || gm >= P.targets.gmDb) &&
                    (!sMet.s || sp <= P.targets.sDb) &&
                    pm >= sA.pm.median - P.tolerance.pmDeg &&
                    gm >= sA.gmLow - P.tolerance.gmDb &&
                    sp <= sA.s.median + P.tolerance.sDb &&
                    sp <= Math.max(P.guards.sMaxDb, sA.s.median) &&
                    fc >= P.policy.predictedFcMinRel * sA.fc.median;
                if (!vsStart) continue;
            }
            const drop = d0 - c.shortfall;
            const transition = (!m0.pm && c.meets.pm) || (!m0.gm && c.meets.gm) || (!m0.s && c.meets.s);
            if (drop >= P.policy.predictedMinShortfallDrop)
                rows.push({ c, kind: "shortfall_drop", drop, size, mMax, mStart });
            else if (transition) rows.push({ c, kind: "target_transition", drop, size, mMax, mStart });
        }
        if (!rows.length) {
            skipped.push({ axis, reason: `no_eligible_candidate_within_rho_${rho}` });
            continue;
        }
        rows.sort((a, b) => {
            if (a.kind !== b.kind) return a.kind === "shortfall_drop" ? -1 : 1;
            if (a.kind === "shortfall_drop") return b.drop - a.drop || a.size - b.size;
            return a.size - b.size || b.drop - a.drop;
        });
        const best = rows[0];
        return {
            kind: "step",
            choice: {
                axis,
                from: cur,
                to: best.c.values,
                kind: best.kind,
                predicted: best.c.predicted,
                predictedShortfall: best.c.shortfall,
                currentPredictedShortfall: d0,
                predictedMotorMax: best.mMax,
                predictedMotorMaxVsStart: best.mStart,
                stepSize: best.size,
                skipped,
            },
        };
    }
    return { kind: "stop", reason: "no_eligible_candidate", detail: skipped.map((x) => `${x.axis}:${x.reason}`) };
}

/** After a RESTORE of a step on `axis`: exclude the point, halve ρ of that axis, try that axis first next time. */
export function afterRestore(state: PolicyState, choice: StepChoice): PolicyState {
    return {
        rho: { ...state.rho, [choice.axis]: state.rho[choice.axis] / 2 },
        excluded: [...state.excluded, { axis: choice.axis, pid: choice.to, stepSize: choice.stepSize }],
        lastRejectedAxis: choice.axis,
    };
}

/** After an ACCEPT: ρ of that axis back up (at most rhoMax); rejected points stay excluded (they were measured). */
export function afterAccept(state: PolicyState, choice: StepChoice): PolicyState {
    return {
        rho: { ...state.rho, [choice.axis]: Math.min(P.policy.rhoMax, state.rho[choice.axis] * 2) },
        excluded: state.excluded,
        lastRejectedAxis: null,
    };
}
