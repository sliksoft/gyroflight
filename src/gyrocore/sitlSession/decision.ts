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
 * Measurement summary and the re-measurement decision of the AutoTune session (block 14, protocol session_v1).
 *
 * A measurement is three runs of one tune. Per axis every quantity is the median of the runs with its spread
 * (max − min). GM: lower bound = median − 2·max σ over the runs (σ = 20·log10(1 + ε), the engine's relative loop error
 * at the phase crossing), assessable when every run has a crossing in 5–85 Hz with σ ≤ 1.5 dB.
 *
 * Decision of a candidate measurement C against the last accepted measurement A (and the session's start S), for the
 * changed axis x:
 *   INVALID  C is not a valid measurement (readback, runs, envelope, hover samples, clip, spreads, missing quantities).
 *   ACCEPT   every guard G1–G6 holds on both axes and the changed axis improves (V1 or V2) beyond the uncertainty.
 *   RESTORE  otherwise; the reasons name the guards that failed or the missing improvement.
 * The uncertainty of a quantity is u = max(spread in A, spread in C).
 */

import { SESSION_PROTOCOL as P, type SessionAxis } from "./protocol";
import type { StepMetrics } from "./metrics";

export interface Stat {
    median: number;
    spread: number;
}

export interface RunRead {
    /** The engine's current margins of this run's log (sessionMarginsOf); null: not readable in band. */
    margins: Partial<
        Record<
            SessionAxis,
            {
                crossoverHz: number;
                pmDeg: number;
                gmDb: number;
                sDb: number;
                gmHz: number | null;
                gmSigmaDb: number | null;
            } | null
        >
    >;
    steps: Partial<Record<SessionAxis, StepMetrics>>;
    motors: { bandPower: (number | null)[]; hoverSamples: number; clip: number | null } | null;
    /** Bench and app checks that made this run unusable (readback mismatch, envelope, missing data, …). */
    issues: string[];
}

export interface AxisSummary {
    fc: Stat;
    pm: Stat;
    gm: Stat;
    gmLow: number;
    gmMaxSigma: number;
    gmAssessable: boolean;
    s: Stat;
    tracking: Stat;
    overshoot: Stat;
    riseMs: Stat;
    oscillation: Stat;
}

export interface MeasurementSummary {
    valid: boolean;
    issues: string[];
    axes: Partial<Record<SessionAxis, AxisSummary>>;
    motors: Stat[] | null;
}

function stat(xs: number[]): Stat {
    const s = [...xs].sort((a, b) => a - b);
    const mid = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
    return { median: mid, spread: s[s.length - 1] - s[0] };
}

export function summarize(runs: RunRead[]): MeasurementSummary {
    const issues: string[] = [];
    if (runs.length !== P.measurement.runs) issues.push(`runs:${runs.length}`);
    runs.forEach((r, k) => r.issues.forEach((x) => issues.push(`run${k + 1}:${x}`)));
    const axes: MeasurementSummary["axes"] = {};
    for (const axis of P.axes) {
        const m = runs.map((r) => r.margins[axis] ?? null);
        const st = runs.map((r) => r.steps[axis] ?? null);
        if (m.some((x) => !x)) {
            issues.push(`margins_not_readable:${axis}`);
            continue;
        }
        if (st.some((x) => !x)) {
            issues.push(`step_metrics_missing:${axis}`);
            continue;
        }
        const mm = m as NonNullable<(typeof m)[number]>[];
        const ss = st as StepMetrics[];
        const sig = mm.map((x) => x.gmSigmaDb);
        const gmAssessable = mm.every(
            (x) =>
                x.gmHz !== null &&
                x.gmHz >= P.validity.gmBandHz[0] &&
                x.gmHz <= P.validity.gmBandHz[1] &&
                x.gmSigmaDb !== null &&
                x.gmSigmaDb <= P.validity.gmMaxSigmaDb,
        );
        const gm = stat(mm.map((x) => x.gmDb));
        // A run without a known σ counts with the largest σ the rule allows (conservative; it also makes GM unassessable).
        const gmMaxSigma = Math.max(...sig.map((x) => x ?? P.validity.gmMaxSigmaDb));
        const a: AxisSummary = {
            fc: stat(mm.map((x) => x.crossoverHz)),
            pm: stat(mm.map((x) => x.pmDeg)),
            gm,
            gmLow: gm.median - 2 * gmMaxSigma,
            gmMaxSigma,
            gmAssessable,
            s: stat(mm.map((x) => x.sDb)),
            tracking: stat(ss.map((x) => x.trackingRel)),
            overshoot: stat(ss.map((x) => x.overshoot)),
            riseMs: stat(ss.map((x) => x.riseMs)),
            oscillation: stat(ss.map((x) => x.oscillation)),
        };
        if (a.pm.spread > P.validity.pmSpreadDeg) issues.push(`pm_spread:${axis}:${a.pm.spread.toFixed(2)}`);
        if (a.s.spread > P.validity.sSpreadDb) issues.push(`s_spread:${axis}:${a.s.spread.toFixed(2)}`);
        if (a.fc.spread > P.validity.fcSpreadRel * a.fc.median)
            issues.push(`fc_spread:${axis}:${a.fc.spread.toFixed(2)}`);
        if (a.tracking.spread > P.validity.trackingSpreadRel * a.tracking.median)
            issues.push(`tracking_spread:${axis}:${a.tracking.spread.toFixed(4)}`);
        axes[axis] = a;
    }
    let motors: Stat[] | null = null;
    if (runs.some((r) => !r.motors || r.motors.bandPower.some((x) => x === null))) issues.push("motor_band_missing");
    else {
        runs.forEach((r, k) => {
            if (r.motors!.hoverSamples < P.validity.minHoverSamples)
                issues.push(`run${k + 1}:hover_samples:${r.motors!.hoverSamples}`);
            if ((r.motors!.clip ?? 1) > 0) issues.push(`run${k + 1}:motor_clip:${r.motors!.clip}`);
        });
        motors = [0, 1, 2, 3].map((m) => stat(runs.map((r) => r.motors!.bandPower[m] as number)));
        motors.forEach((s, m) => {
            if (s.spread > P.validity.motorSpreadRel * s.median)
                issues.push(`motor_spread:m${m + 1}:${(s.spread / s.median).toFixed(3)}`);
        });
    }
    return { valid: !issues.length, issues, axes, motors };
}

/** Shortfall on measured values (GM as its lower bound); see sessionSearch shortfallOf for the units. */
export function measuredShortfall(a: AxisSummary): number {
    return (
        Math.max(0, P.targets.pmDeg - a.pm.median) / P.tolerance.pmDeg +
        Math.max(0, P.targets.gmDb - a.gmLow) / P.tolerance.gmDb +
        Math.max(0, a.s.median - P.targets.sDb) / P.tolerance.sDb
    );
}

export function measuredMeets(a: AxisSummary) {
    return {
        pm: a.pm.median >= P.targets.pmDeg,
        gm: a.gmAssessable && a.gmLow >= P.targets.gmDb,
        s: a.s.median <= P.targets.sDb,
    };
}

export type Verdict = "ACCEPT" | "RESTORE" | "INVALID";

export interface Check {
    rule: string;
    pass: boolean;
    detail: string;
}

export interface Decision {
    verdict: Verdict;
    checks: Check[];
    /** The failing rules (RESTORE / INVALID) or the improvement rule that held (ACCEPT). */
    reasons: string[];
}

const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : String(x));

export function decide(o: {
    base: MeasurementSummary;
    cand: MeasurementSummary;
    start: MeasurementSummary;
    axis: SessionAxis;
}): Decision {
    const { base, cand, start, axis } = o;
    if (!cand.valid) return { verdict: "INVALID", checks: [], reasons: cand.issues.map((x) => `invalid:${x}`) };
    const checks: Check[] = [];
    const add = (rule: string, pass: boolean, detail: string) => checks.push({ rule, pass, detail });
    const G = P.guards;
    // G1 motors, against the last accepted measurement and against the start.
    const bm = base.motors!;
    const cm = cand.motors!;
    const sm = start.motors!;
    cm.forEach((c, m) => {
        const rb = c.median / bm[m].median;
        const rs = c.median / sm[m].median;
        add(`G1_motor_vs_accepted:m${m + 1}`, rb <= G.motorMaxRatio, `${f(rb, 3)} ≤ ${G.motorMaxRatio}`);
        add(`G1_motor_vs_start:m${m + 1}`, rs <= G.motorMaxRatio, `${f(rs, 3)} ≤ ${G.motorMaxRatio}`);
    });
    for (const ax of P.axes) {
        const A = base.axes[ax]!;
        const C = cand.axes[ax]!;
        const u = (k: "pm" | "s" | "fc" | "tracking" | "overshoot" | "riseMs" | "gm") =>
            Math.max(A[k].spread, C[k].spread);
        // G2 targets met stay met; no margin worse than its tolerance.
        const mA = measuredMeets(A);
        const mC = measuredMeets(C);
        if (mA.pm) add(`G2_pm_stays_met:${ax}`, mC.pm, `${f(C.pm.median, 1)}° ≥ 45°`);
        if (mA.gm) add(`G2_gm_stays_met:${ax}`, mC.gm, `GM lower bound ${f(C.gmLow, 1)} ≥ 6 dB`);
        if (mA.s) add(`G2_s_stays_met:${ax}`, mC.s, `|S| ${f(C.s.median)} ≤ 6 dB`);
        add(
            `G2_pm_not_worse:${ax}`,
            C.pm.median >= A.pm.median - P.tolerance.pmDeg,
            `${f(C.pm.median, 1)}° ≥ ${f(A.pm.median, 1)}° − 5°`,
        );
        add(
            `G2_gm_not_worse:${ax}`,
            C.gmLow >= A.gmLow - P.tolerance.gmDb,
            `${f(C.gmLow, 1)} ≥ ${f(A.gmLow, 1)} − 1.5 dB`,
        );
        add(
            `G2_s_not_worse:${ax}`,
            C.s.median <= A.s.median + P.tolerance.sDb,
            `${f(C.s.median)} ≤ ${f(A.s.median)} + 1 dB`,
        );
        // G3–G5 step response.
        add(
            `G3_overshoot:${ax}`,
            C.overshoot.median <= A.overshoot.median + G.overshootAbs + u("overshoot"),
            `${f(C.overshoot.median, 3)} ≤ ${f(A.overshoot.median, 3)} + 0.02 + ${f(u("overshoot"), 3)}`,
        );
        add(
            `G4_tracking:${ax}`,
            C.tracking.median <= G.trackingRel * A.tracking.median + u("tracking"),
            `${f(C.tracking.median, 4)} ≤ 1.05·${f(A.tracking.median, 4)} + ${f(u("tracking"), 4)}`,
        );
        add(
            `G5_rise:${ax}`,
            C.riseMs.median <= G.riseRel * A.riseMs.median + G.riseAbsMs + u("riseMs"),
            `${f(C.riseMs.median, 1)} ms ≤ 1.15·${f(A.riseMs.median, 1)} + 2 + ${f(u("riseMs"), 1)} ms`,
        );
        add(
            `G5_crossover:${ax}`,
            C.fc.median >= G.fcMinRel * A.fc.median - u("fc"),
            `${f(C.fc.median, 1)} Hz ≥ 0.9·${f(A.fc.median, 1)} Hz`,
        );
        // G6 stability.
        // An axis that already oscillates more than the limit may not get worse (pilot, start tune B pitch 0.12).
        const oscLimit = Math.max(
            G.oscillationMax,
            A.oscillation.median + Math.max(A.oscillation.spread, C.oscillation.spread),
        );
        add(
            `G6_oscillation:${ax}`,
            C.oscillation.median <= oscLimit,
            `${f(C.oscillation.median, 3)} ≤ ${f(oscLimit, 3)}`,
        );
        const sLimit = Math.max(G.sMaxDb, A.s.median + u("s"));
        add(`G6_s_peak:${ax}`, C.s.median <= sLimit, `${f(C.s.median)} ≤ ${f(sLimit)} dB`);
        if (A.gmAssessable) add(`G6_gm_assessable:${ax}`, C.gmAssessable, `σ ≤ 1.5 dB, crossing in 5–85 Hz`);
    }
    // Improvement on the changed axis.
    const A = base.axes[axis]!;
    const C = cand.axes[axis]!;
    const u = {
        pm: Math.max(A.pm.spread, C.pm.spread),
        gm: Math.max(A.gm.spread, C.gm.spread),
        s: Math.max(A.s.spread, C.s.spread),
    };
    const dA = measuredShortfall(A);
    const dC = measuredShortfall(C);
    const uD = u.pm / P.tolerance.pmDeg + u.gm / P.tolerance.gmDb + u.s / P.tolerance.sDb;
    const v1 = dA - dC >= P.improvement.v1MinShortfallDrop && dA - dC > uD;
    add(`V1_shortfall_drop:${axis}`, v1, `D ${f(dA)} → ${f(dC)} (drop ≥ 0.5 and > ${f(uD, 3)})`);
    const k = P.improvement.v2MarginUncertainties;
    const mA = measuredMeets(A);
    const v2parts: string[] = [];
    if (!mA.pm && C.pm.median - P.targets.pmDeg >= k * u.pm) v2parts.push("pm");
    if (!mA.gm && C.gmAssessable && C.gmLow - P.targets.gmDb >= k * u.gm) v2parts.push("gm");
    if (!mA.s && P.targets.sDb - C.s.median >= k * u.s) v2parts.push("s");
    const v2 = v2parts.length > 0;
    add(
        `V2_target_newly_met:${axis}`,
        v2,
        v2 ? `newly met with margin ≥ 2u: ${v2parts.join(",")}` : "no missed target newly met with margin ≥ 2u",
    );
    const guardsFailed = checks.filter((c) => c.rule.startsWith("G") && !c.pass).map((c) => c.rule);
    if (guardsFailed.length) return { verdict: "RESTORE", checks, reasons: guardsFailed };
    if (!v1 && !v2) return { verdict: "RESTORE", checks, reasons: [`no_improvement:${axis}`] };
    return { verdict: "ACCEPT", checks, reasons: [v1 ? `V1_shortfall_drop:${axis}` : `V2_target_newly_met:${axis}`] };
}
