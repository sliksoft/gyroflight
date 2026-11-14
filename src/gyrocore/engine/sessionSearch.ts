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
 * Bounded PID step search for the AutoTune session (block 14; SITL only).
 *
 * Filters stay as logged. Per analysed axis every point of the box "each of P, I and D within ±ρ of the current value"
 * (relative resolution 0.05; d_max keeps its ratio to D and is never below D, as Betaflight requires) is read on the
 * same measured loop as every other search (readPidCandidate: the margins must be readable in band), and its motor load
 * is predicted with the every-motor model of block 13 (jointMotorNoise, filter combination "1|1": the logged filters).
 * The search chooses nothing: the session's step policy (src/gyrocore/sitlSession/stepPolicy.ts) selects from these
 * reads and the session's re-measurement decides.
 */

import { readPidCandidate, readableValues, scaledPid, scalesOf } from "@/gyrocore/engine/candidateDecision";
import { loopMargins, loopPhaseCrossing, type AxisLoop } from "@/gyrocore/engine/loopModel";
import { motorNoiseModel, MOTOR_AXES, type MotorNoiseInput } from "@/gyrocore/engine/jointMotorNoise";
import { PID_TARGETS, type PidValues } from "@/gyrocore/engine/pidOptimizer";

export type SessionAxisName = "roll" | "pitch";

export interface SessionSearchInput {
    /** The axes the session may change. */
    axes: SessionAxisName[];
    /** Largest relative change of each of P, I and D against the current value, per axis (the trust region ρ). */
    maxStepRel: Partial<Record<SessionAxisName, number>>;
}

/** The margins as read, with the GM's own uncertainty (loopPhaseCrossing). */
export interface SessionMargins {
    crossoverHz: number;
    pmDeg: number;
    gmDb: number;
    sDb: number;
    gmHz: number | null;
    /** GM uncertainty at the phase crossing (gmSigmaFromCoherence); null: coherence unknown there. */
    gmSigmaDb: number | null;
}

export interface SessionCandidate {
    values: PidValues;
    /** Relative change per term against the current tune. */
    change: { p: number; i: number; d: number };
    predicted: { crossoverHz: number; pmDeg: number; gmDb: number; sDb: number };
    /** Shortfall against the targets on the predicted values (shortfallOf). */
    shortfall: number;
    meets: { pm: boolean; gm: boolean; s: boolean };
    /** Predicted per-motor band power ratio against the current tune; null: the motor model cannot assess it. */
    motorRatios: number[] | null;
}

export interface SessionAxisSearch {
    axis: SessionAxisName;
    status: "searched" | "not_analysed" | "current_unreadable";
    reasons: string[];
    current: PidValues | null;
    currentRead: SessionMargins | null;
    rho: number;
    tried: number;
    readable: number;
    candidates: SessionCandidate[];
}

export interface SessionSearchResult {
    axes: SessionAxisSearch[];
    motorModel: { assessable: boolean; reasons: string[]; limitations: string[] };
}

/** Grid resolution of the relative step. */
export const SESSION_STEP_RESOLUTION = 0.05;

/**
 * Target shortfall D = max(0, 45 − PM)/5 + max(0, 6 − GM)/1.5 + max(0, |S| − 6)/1 (one unit = one tolerance of the
 * prediction rules: 5°, 1.5 dB, 1 dB). 0 when every target is met.
 */
export function shortfallOf(pmDeg: number, gmDb: number, sDb: number): number {
    return (
        Math.max(0, PID_TARGETS.minPhaseMarginDeg - pmDeg) / 5 +
        Math.max(0, PID_TARGETS.minGainMarginDb - gmDb) / 1.5 +
        Math.max(0, sDb - PID_TARGETS.maxSensitivityPeakDb) / 1
    );
}

export function meetsOf(pmDeg: number, gmDb: number, sDb: number) {
    return {
        pm: pmDeg >= PID_TARGETS.minPhaseMarginDeg,
        gm: gmDb >= PID_TARGETS.minGainMarginDb,
        s: sDb <= PID_TARGETS.maxSensitivityPeakDb,
    };
}

/**
 * GM uncertainty of protocol joint3 v4 (Bendat–Piersol random error of the H1 estimate with one independent average,
 * n_d = 1, at the phase crossing): σ = 20·log10(1 + ε), ε = √(1 − γ²)/(|γ|·√2). Null without a coherence in (0, 1].
 */
export function gmSigmaFromCoherence(coh: number | null): number | null {
    if (coh === null || !(coh > 0 && coh <= 1)) return null;
    return 20 * Math.log10(1 + Math.sqrt(1 - coh) / (Math.sqrt(coh) * Math.SQRT2));
}

/** The current loop's margins with the GM uncertainty, or null where they are not readable in band. */
export function sessionMarginsOf(loop: AxisLoop): SessionMargins | null {
    const v = readableValues(loopMargins(loop));
    if (!v || v.crossoverHz === null || v.pmDeg === null || v.gmDb === null || v.sDb === null) return null;
    const x = loopPhaseCrossing(loop);
    return {
        crossoverHz: v.crossoverHz,
        pmDeg: v.pmDeg,
        gmDb: v.gmDb,
        sDb: v.sDb,
        gmHz: x.gmHz,
        gmSigmaDb: gmSigmaFromCoherence(x.coherence),
    };
}

export function sessionSearch(o: {
    input: SessionSearchInput;
    axes: { axis: SessionAxisName; loop: AxisLoop | null; current: PidValues | null; reasons: string[] }[];
    /** The every-motor model's input (autotuneV2 motorAxes etc.); null: no motor prediction. */
    motor: MotorNoiseInput | null;
}): SessionSearchResult {
    const model = o.motor ? motorNoiseModel(o.motor) : null;
    const sig = o.motor ? { sim: null, dterm: o.motor.axes.map((m) => m.dterm) } : null;
    // The model's own verdict at the current tune (static gates and the reproduction gate; limitations kept).
    const base = model && sig ? model.assess("1|1", sig, sig, false, {}) : null;
    const motorReasons = !model || !base ? ["motor_model_input_missing"] : base.assessed ? [] : base.reasons;
    const motorLimitations = base?.limitations ?? [];
    const axes: SessionAxisSearch[] = o.input.axes.map((name) => {
        const a = o.axes.find((x) => x.axis === name);
        const rho = o.input.maxStepRel[name] ?? 0;
        const empty = (status: SessionAxisSearch["status"], reasons: string[]): SessionAxisSearch => ({
            axis: name,
            status,
            reasons,
            current: a?.current ?? null,
            currentRead: null,
            rho,
            tried: 0,
            readable: 0,
            candidates: [],
        });
        if (!a || !a.loop || !a.current)
            return empty("not_analysed", a?.reasons.length ? a.reasons : ["axis_not_analysed"]);
        const currentRead = sessionMarginsOf(a.loop);
        if (!currentRead) return empty("current_unreadable", ["current_margins_not_readable_in_band"]);
        const cur = a.current;
        const kdRatio = cur.d > 0 ? a.loop.cfg.axis.d / cur.d : 1;
        const scales = scalesOf([1 - rho, 1 + rho], SESSION_STEP_RESOLUTION);
        const xi = MOTOR_AXES.indexOf(name);
        const seen = new Set<string>();
        const candidates: SessionCandidate[] = [];
        let tried = 0;
        for (const ps of scales)
            for (const is of cur.i > 0 ? scales : [1])
                for (const ds of cur.d > 0 ? scales : [1]) {
                    const v = scaledPid(cur, ps, is, ds);
                    const key = `${v.p}|${v.i}|${v.d}|${v.dMax}`;
                    if (seen.has(key) || (v.p === cur.p && v.i === cur.i && v.d === cur.d && v.dMax === cur.dMax))
                        continue;
                    seen.add(key);
                    tried++;
                    const r = readPidCandidate(a.loop, v, kdRatio);
                    if (!r || r.crossoverHz === null || r.pmDeg === null || r.gmDb === null || r.sDb === null) continue;
                    const m =
                        model && sig && !motorReasons.length ? model.ratiosFor("1|1", sig, sig, false, xi, v) : null;
                    const rel = (x: number, c: number) => (c > 0 ? x / c - 1 : 0);
                    candidates.push({
                        values: v,
                        change: { p: rel(v.p, cur.p), i: rel(v.i, cur.i), d: rel(v.d, cur.d) },
                        predicted: { crossoverHz: r.crossoverHz, pmDeg: r.pmDeg, gmDb: r.gmDb, sDb: r.sDb },
                        shortfall: shortfallOf(r.pmDeg, r.gmDb, r.sDb),
                        meets: meetsOf(r.pmDeg, r.gmDb, r.sDb),
                        motorRatios: m ? m.motorRatios : null,
                    });
                }
        return {
            axis: name,
            status: "searched",
            reasons: [],
            current: cur,
            currentRead,
            rho,
            tried,
            readable: candidates.length,
            candidates,
        };
    });
    return {
        axes,
        motorModel: { assessable: !motorReasons.length, reasons: motorReasons, limitations: motorLimitations },
    };
}
