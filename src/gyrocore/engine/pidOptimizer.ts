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
 * Absolute P / I / D (and d_max) per axis (plan V2-D): a bounded grid search on the loop
 * model of loopModel.ts. It maximises the crossover frequency (bandwidth) subject to phase
 * margin, gain margin and |S| peak targets, inside the identified band, with each term
 * changing by at most MAX_STEP per proposal. I keeps its ratio to P; d_max keeps its ratio
 * to D (so the D_max boost the sweep measured stays the same) and never drops below D.
 *
 * The result is a prediction. Its status follows the margins: BLOCKED while they are not
 * VALIDATED (loopModel.ts), so the release contract keeps it from being written.
 */

import type { DigitalControllerConfig } from "@/js/blackbox/betaflight_digital_controller";
import { loopMargins, type AxisLoop, type LoopMargins } from "./loopModel";

export const PID_TARGETS = Object.freeze({
    /** Design target; the release contract needs ≥ 40°. */
    minPhaseMarginDeg: 45,
    minGainMarginDb: 6,
    maxSensitivityPeakDb: 6,
});
/** Largest relative change of P, I or D in one proposal. */
export const MAX_STEP = 0.3;
const SCALES = [0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3];
/** Proposals that move the crossover by less than this are not worth a flight. */
const MIN_CROSSOVER_GAIN = 1.03;

export interface PidValues {
    p: number;
    i: number;
    d: number;
    dMax: number;
}

export interface AxisPidProposal {
    axis: "roll" | "pitch" | "yaw";
    current: PidValues;
    proposed: PidValues;
    changed: boolean;
    currentMargins: LoopMargins;
    proposedMargins: LoopMargins;
    /** Search outcome: why this candidate (or no change). */
    outcome: "improved" | "no_change_needed" | "restores_margins" | "targets_not_reachable" | "not_computable";
    status: "VALIDATED" | "PARTIAL" | "BLOCKED";
    reasons: string[];
}

const NAMES = ["roll", "pitch", "yaw"] as const;

/**
 * Every known margin meets its target. GM / |S| outside the identified band are unknown: the
 * search still respects PM, and the unknowns are reported as required measurements (the
 * release contract refuses unknown robustness).
 */
function meets(m: LoopMargins): boolean {
    return (
        m.phaseMarginDeg !== null &&
        m.phaseMarginDeg >= PID_TARGETS.minPhaseMarginDeg &&
        (m.gainMarginDb === null || m.gainMarginDb >= PID_TARGETS.minGainMarginDb) &&
        (m.sensitivityPeakDb === null || m.sensitivityPeakDb <= PID_TARGETS.maxSensitivityPeakDb)
    );
}

/** Margins computable at all (PM and crossover inside the band); GM / |S| may be unknown. */
function pmKnown(m: LoopMargins): boolean {
    return m.phaseMarginDeg !== null && m.crossoverHz !== null;
}

function candidateCfg(cfg: DigitalControllerConfig, v: PidValues): DigitalControllerConfig {
    return { ...cfg, axis: { ...cfg.axis, p: v.p, i: v.i, d: v.d } };
}

/**
 * `cfg` is the controller as it acted during the sweep (effective D-term lpf1 / Kd scale from
 * M5-B); `current` the absolute values on the FC. Scaling keeps the effective/absolute ratio.
 */
export function optimizeAxisPid(loop: AxisLoop, current: PidValues): AxisPidProposal {
    const axis = NAMES[loop.axis];
    const curMargins = loopMargins(loop);
    const reasons: string[] = [];
    const kdRatio = current.d > 0 ? loop.cfg.axis.d / current.d : 1;
    const base: Omit<AxisPidProposal, "proposed" | "proposedMargins" | "outcome" | "status" | "changed"> = {
        axis,
        current,
        currentMargins: curMargins,
        reasons,
    };
    if (!pmKnown(curMargins)) {
        reasons.push("current_loop_margins_not_computable", ...curMargins.reasons);
        return {
            ...base,
            proposed: current,
            proposedMargins: curMargins,
            outcome: "not_computable",
            changed: false,
            status: "BLOCKED",
        };
    }
    const dScales = current.d > 0 ? SCALES : [1];
    let best: { v: PidValues; m: LoopMargins } | null = null;
    let safest: { v: PidValues; m: LoopMargins } | null = null;
    for (const ps of SCALES) {
        for (const ds of dScales) {
            const v: PidValues = {
                p: Math.round(current.p * ps),
                i: Math.round(current.i * ps),
                d: Math.round(current.d * ds),
                dMax: current.dMax > 0 ? Math.max(Math.round(current.dMax * ds), Math.round(current.d * ds)) : 0,
            };
            if ([v.p, v.i, v.d].some((x) => x < 0 || x > 250) || v.dMax > 250) continue;
            const m = loopMargins(loop, { cfg: candidateCfg(loop.cfg, { ...v, d: v.d * kdRatio }) });
            if (!pmKnown(m)) continue;
            if (!safest || m.phaseMarginDeg! > safest.m.phaseMarginDeg!) safest = { v, m };
            if (meets(m) && (!best || m.crossoverHz! > best.m.crossoverHz!)) best = { v, m };
        }
    }
    const same = (v: PidValues) =>
        v.p === current.p && v.i === current.i && v.d === current.d && v.dMax === current.dMax;
    let pick: { v: PidValues; m: LoopMargins };
    let outcome: AxisPidProposal["outcome"];
    if (best && meets(curMargins) && best.m.crossoverHz! < curMargins.crossoverHz! * MIN_CROSSOVER_GAIN) {
        pick = { v: current, m: curMargins };
        outcome = "no_change_needed";
    } else if (best) {
        pick = best;
        outcome = meets(curMargins) ? "improved" : "restores_margins";
    } else {
        pick = safest ?? { v: current, m: curMargins };
        outcome = "targets_not_reachable";
        reasons.push("no_candidate_meets_all_targets");
    }
    if (pick.m.gainMarginDb === null) reasons.push("required_measurement:chirp_to_higher_frequency_for_gain_margin");
    if (pick.m.sensitivityPeakDb === null)
        reasons.push("required_measurement:chirp_to_higher_frequency_for_sensitivity_peak");
    const changed = !same(pick.v);
    if (changed && pick.m.status !== "VALIDATED") reasons.push(...pick.m.reasons.map((r) => `margins:${r}`));
    // A candidate that misses a target is shown, never recommended: BLOCKED whatever its margins.
    const status: AxisPidProposal["status"] =
        outcome === "targets_not_reachable"
            ? "BLOCKED"
            : !changed
              ? pick.m.status === "VALIDATED"
                  ? "VALIDATED"
                  : "PARTIAL"
              : pick.m.status === "VALIDATED"
                ? "VALIDATED"
                : "BLOCKED";
    return { ...base, proposed: pick.v, proposedMargins: pick.m, outcome, changed, status };
}
