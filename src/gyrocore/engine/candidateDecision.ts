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
 * Per-axis candidate decision for the EXPERIMENTAL route (block 6): why a route (primary CHIRP loop
 * or CHIRP + JIO) does or does not give a tuning candidate, as an ordered list of checks with the
 * measured value, unit, threshold, result and consequence, and a candidate search on the MEASURED
 * margins where only their qualification (bounds) is missing.
 *
 * The release route is untouched: optimizeAxisPid still needs bounded GM / |S| (MODEL_CONDITIONAL
 * or VALIDATED evidence). Here a margin read inside the identified band counts; one that the band
 * cannot show (phase crossing outside it, |S| peak at its edge, loop gain still near unity at its
 * end) does not, and is named as band insufficient. A missing plant, an insufficient band and a real
 * search failure are separate statuses: `targets_not_reachable` only when usable in-band margins
 * exist and no grid candidate meets the targets.
 */

import type { AxisLoop, LoopMargins } from "@/gyrocore/engine/loopModel";
import { LOOP_MIN_COHERENCE, loopMargins, UNCERTAINTY } from "@/gyrocore/engine/loopModel";
import {
    candidateCfg,
    MAX_STEP,
    MIN_CROSSOVER_GAIN,
    PID_TARGETS,
    SCALES,
    searchGrid,
    type AxisPidProposal,
    type PidValues,
} from "@/gyrocore/engine/pidOptimizer";

export type MetricState =
    | "bounded"
    | "measured_in_band"
    | "crossing_outside_band"
    | "peak_outside_band"
    | "band_end_near_unity"
    | "not_computable";

export interface DecisionCheck {
    rule: string;
    /** Code reference of the rule (file:symbol). */
    ref: string;
    /** The measured value; null = unknown (never a stand-in zero). */
    value: number | string | null;
    unit: string;
    threshold: string;
    result: "pass" | "fail" | "unknown" | "waived";
    /** What does not run (or is not offered) because of this result. */
    consequence: string;
}

export type DecisionStatus =
    | "measurement_rejected_by_quality_gate"
    | "plant_not_identified"
    | "plant_band_insufficient"
    | "targets_not_reachable"
    | "search_limit_max_step"
    | "no_change_needed"
    | "candidate_found";

export interface RouteDecision {
    route: "primary" | "jio";
    plant: "present" | "present_with_limitation" | "absent";
    /** The identified band the margins are read on. */
    bandHz: [number, number] | null;
    metrics: { pm: MetricState; gm: MetricState; s: MetricState } | null;
    /** Current tune: crossover (Hz), PM (°), GM (dB), |S| peak (dB) as read (bound or in-band measured). */
    current: { crossoverHz: number | null; pmDeg: number | null; gmDb: number | null; sDb: number | null } | null;
    checks: DecisionCheck[];
    searchRan: boolean;
    candidatesTried: number;
    candidatesUsable: number;
    status: DecisionStatus;
    /** The first failing check (null when a candidate was found or none is needed). */
    firstCause: DecisionCheck | null;
    /** Measured-margin candidate (experimental; evidence MEASURED; status never VALIDATED). */
    candidate: AxisPidProposal | null;
    /** The measurement this route rests on may be used by the experimental route. */
    measurementUsable: boolean;
    /** Qualification gates this route waived for the experimental route (named, not hidden). */
    waived: string[];
}

const REF_LOOP = "src/gyrocore/engine/loopModel.ts:loopMargins";
const REF_SEARCH = "src/gyrocore/engine/candidateDecision.ts:decideAxis";
const DATA_BLOCKERS =
    /^(crossover_band_unsupported|crossover_neighbour_bins_missing|sweep_generator_stopped_early|model_class_qualification_failed)/;
const BAND_END = /^loop_gain_(rising|near_unity|above_one)_at_band_end/;

function has(m: LoopMargins, re: RegExp): string | null {
    return m.reasons.find((r) => re.test(r)) ?? null;
}

/** How each margin of `m` is known: as a bound, read inside the band, or not shown by the band. */
export function metricStates(m: LoopMargins): { pm: MetricState; gm: MetricState; s: MetricState } {
    const fin = (x: number | null | undefined) => typeof x === "number" && Number.isFinite(x);
    const bandEnd = has(m, BAND_END);
    const pm: MetricState = fin(m.phaseMarginDeg) && fin(m.crossoverHz) ? "bounded" : "not_computable";
    let gm: MetricState;
    if (fin(m.gainMarginDb)) gm = "bounded";
    else if (has(m, /^phase_crossover_outside_identified_band/)) gm = "crossing_outside_band";
    else if (bandEnd) gm = "band_end_near_unity";
    else if (fin(m.measured.gainMarginDb)) gm = "measured_in_band";
    else gm = "not_computable";
    let s: MetricState;
    if (fin(m.sensitivityPeakDb)) s = "bounded";
    else if (has(m, /^sensitivity_peak_outside_identified_band/)) s = "peak_outside_band";
    else if (bandEnd) s = "band_end_near_unity";
    else if (fin(m.measured.sensitivityPeakDb)) s = "measured_in_band";
    else s = "not_computable";
    return { pm: m.evidence?.level === "MEASURED" && pm === "bounded" ? "measured_in_band" : pm, gm, s };
}

const usable = (x: MetricState) => x === "bounded" || x === "measured_in_band";

/**
 * Why the identified band ends where it does: the first plant bin above its top and the rule that
 * left it out of the margins (loopModel candidateLoop: coherence ≥ LOOP_MIN_COHERENCE, supported,
 * ±UNCERTAINTY.coverage·ε below UNCERTAINTY.maxCoverageRelErr), against the band the planner needs.
 */
function bandTopCheck(loop: AxisLoop, band: [number, number] | null, required: [number, number] | null): DecisionCheck {
    const top = band ? band[1] : null;
    const next = top === null ? null : (loop.plant.bins.find((b) => b.frequencyHz > top + 1e-9) ?? null);
    let why = "no bin above the band (analysis band end)";
    if (next) {
        const err = loop.uncertainty?.relErr?.get(next.frequencyHz);
        if (next.status !== "ok" || !next.G)
            why = `next bin ${next.frequencyHz.toFixed(1)} Hz: plant status ${next.status} (γ² ${Number.isFinite(next.coherence) ? next.coherence.toFixed(3) : "unknown"})`;
        else if (!(next.coherence >= LOOP_MIN_COHERENCE))
            why = `next bin ${next.frequencyHz.toFixed(1)} Hz: γ² ${next.coherence.toFixed(3)} < LOOP_MIN_COHERENCE ${LOOP_MIN_COHERENCE}`;
        else if (loop.support?.bins.get(next.frequencyHz)?.verdict === "UNSUPPORTED")
            why = `next bin ${next.frequencyHz.toFixed(1)} Hz: excitation support UNSUPPORTED`;
        else if (err !== undefined && UNCERTAINTY.coverage * err >= UNCERTAINTY.maxCoverageRelErr)
            why = `next bin ${next.frequencyHz.toFixed(1)} Hz: ±${UNCERTAINTY.coverage}ε = ${(UNCERTAINTY.coverage * err).toFixed(2)} ≥ ${UNCERTAINTY.maxCoverageRelErr}`;
        else why = `next bin ${next.frequencyHz.toFixed(1)} Hz: excluded`;
    }
    return {
        rule: "identified_band_top",
        ref: "src/gyrocore/engine/loopModel.ts:candidateLoop (LOOP_MIN_COHERENCE)",
        value: top,
        unit: "Hz",
        threshold: required
            ? `≥ ${required[1].toFixed(1)} Hz (planner band ${required[0].toFixed(1)}–${required[1].toFixed(1)} Hz); ${why}`
            : `planner band unknown; ${why}`,
        result: "fail",
        consequence:
            "phase crossing and |S| peak not inside the identified band; record a sweep whose coherence reaches the planner band",
    };
}

function valuesOf(m: LoopMargins) {
    return {
        crossoverHz: m.crossoverHz,
        pmDeg: m.phaseMarginDeg,
        gmDb: m.gainMarginDb ?? m.measured.gainMarginDb,
        sDb: m.sensitivityPeakDb ?? m.measured.sensitivityPeakDb,
    };
}

function meetsMeasured(v: ReturnType<typeof valuesOf>): boolean {
    return (
        v.pmDeg !== null &&
        v.pmDeg >= PID_TARGETS.minPhaseMarginDeg &&
        v.gmDb !== null &&
        v.gmDb >= PID_TARGETS.minGainMarginDb &&
        v.sDb !== null &&
        v.sDb <= PID_TARGETS.maxSensitivityPeakDb
    );
}

export interface QualityGateInput {
    state: string;
    gates?: { code: string; passed: boolean; value: number | null; threshold: number | null; detail: string }[];
}

/**
 * The decision of one route on one axis. `gate`: the primary measurement's qualification (absent for
 * JIO, which judges its own records); `loop`: null when the route has no identified plant, with
 * `noPlantReasons` saying why.
 */
export function decideAxis(o: {
    route: "primary" | "jio";
    loop: AxisLoop | null;
    current: PidValues | null;
    gate?: QualityGateInput | null;
    noPlantReasons?: string[];
    /** The band the planner needs for this loop (measurementPlan bandHz.primary); null: unknown. */
    requiredBandHz?: [number, number] | null;
}): RouteDecision {
    const checks: DecisionCheck[] = [];
    const waived: string[] = [];
    const out = (status: DecisionStatus, extra: Partial<RouteDecision> = {}): RouteDecision => {
        const firstCause = checks.find((c) => c.result === "fail" || c.result === "unknown") ?? null;
        return {
            route: o.route,
            plant: "absent",
            bandHz: null,
            metrics: null,
            current: null,
            checks,
            searchRan: false,
            candidatesTried: 0,
            candidatesUsable: 0,
            status,
            firstCause: status === "candidate_found" || status === "no_change_needed" ? null : firstCause,
            candidate: null,
            measurementUsable: false,
            waived,
            ...extra,
        };
    };

    // 1. Plant present at all.
    if (!o.loop || !o.current) {
        checks.push({
            rule: o.route === "jio" ? "jio_engine_input" : "primary_axis_loop",
            ref:
                o.route === "jio"
                    ? "src/gyrocore/engine/jioSweep.ts:analyzeJioSweeps (engineInput)"
                    : "src/gyrocore/engine/autotuneV2.ts:runAutotuneV2 (axes)",
            value: (o.noPlantReasons ?? []).join(",") || null,
            unit: "",
            threshold: "an identified plant on this axis",
            result: "fail",
            consequence: "no loop model, no margins, no candidate search",
        });
        return out("plant_not_identified");
    }
    const loop = o.loop;
    const cur = loopMargins(loop);
    const band = cur.evidence?.bandHz ?? null;

    // 2. Primary only: the fixed-band coherence gate (chirp/quality.ts MIN_MEAN_BAND_COHERENCE).
    let measurementUsable = true;
    if (o.route === "primary" && o.gate) {
        const coh = o.gate.gates?.find((g) => g.code === "low_coherence");
        const failedOthers = (o.gate.gates ?? []).filter((g) => !g.passed && g.code !== "low_coherence");
        const decision = cur.evidence?.decisionBand ?? null;
        const decisionSupported =
            !!decision?.dropped &&
            decision.dropped.coherence === 0 &&
            decision.dropped.support === 0 &&
            decision.dropped.plantStatus === 0;
        for (const g of failedOthers) {
            checks.push({
                rule: `quality_gate:${g.code}`,
                ref: "src/gyrocore/chirp/quality.ts:assessChirpQuality",
                value: g.value,
                unit: "",
                threshold: g.threshold === null ? "see gate" : String(g.threshold),
                result: "fail",
                consequence: "measurement rejected; no candidate from the primary route",
            });
        }
        if (coh) {
            const failed = !coh.passed;
            checks.push({
                rule: "quality_gate:low_coherence (mean γ² over 5–100 Hz)",
                ref: "src/gyrocore/chirp/quality.ts:MIN_MEAN_BAND_COHERENCE",
                value: coh.value,
                unit: "γ²",
                threshold: `≥ ${coh.threshold ?? 0.6}`,
                result: !failed ? "pass" : decisionSupported && !failedOthers.length ? "waived" : "fail",
                consequence: !failed
                    ? "none"
                    : decisionSupported && !failedOthers.length
                      ? `release blocked; experimental route uses the decision band ${decision!.fromHz.toFixed(1)}–${decision!.toHz.toFixed(1)} Hz (min γ² ${decision!.minCoherence.toFixed(2)}, no bin dropped for coherence or support)`
                      : `measurement rejected; decision band ${decision ? `${decision.fromHz.toFixed(1)}–${decision.toHz.toFixed(1)} Hz drops ${decision.dropped?.coherence ?? "unknown"} bin(s) for coherence, ${decision.dropped?.support ?? "unknown"} for support` : "unknown"}`,
            });
            if (failed && decisionSupported && !failedOthers.length)
                waived.push(
                    `quality_gate:low_coherence:${(coh.value ?? NaN).toFixed(3)}<${coh.threshold ?? 0.6}:5-100Hz`,
                );
        } else if (o.gate.state === "rejected") {
            checks.push({
                rule: "quality_gate:unrecorded",
                ref: "src/gyrocore/chirp/quality.ts:assessChirpQuality",
                value: null,
                unit: "",
                threshold: "gate values recorded",
                result: "unknown",
                consequence: "measurement rejected for a reason the engine input does not carry",
            });
        }
        measurementUsable = o.gate.state !== "rejected" || waived.length > 0;
        if (!measurementUsable)
            return out("measurement_rejected_by_quality_gate", {
                plant: "present_with_limitation",
                bandHz: band,
                metrics: metricStates(cur),
                current: valuesOf(cur),
            });
    }

    // 3. Crossover and PM inside the identified band.
    const states = metricStates(cur);
    checks.push({
        rule: "crossover_in_identified_band",
        ref: REF_LOOP,
        value: cur.crossoverHz,
        unit: "Hz",
        threshold: band ? `inside ${band[0].toFixed(1)}–${band[1].toFixed(1)} Hz` : "an identified band",
        result: states.pm === "not_computable" ? "fail" : "pass",
        consequence: states.pm === "not_computable" ? "no phase margin, no candidate search" : "none",
    });
    if (states.pm === "not_computable")
        return out(cur.okBins < 4 ? "plant_not_identified" : "plant_band_insufficient", {
            plant: cur.okBins < 4 ? "absent" : "present_with_limitation",
            bandHz: band,
            metrics: states,
            measurementUsable,
        });

    // 4. Data blockers inside the decision band (support holes at the crossover, stopped generator).
    const blocker = has(cur, DATA_BLOCKERS);
    checks.push({
        rule: "decision_band_support",
        ref: REF_LOOP,
        value: blocker,
        unit: "",
        threshold: "no unsupported bin at the crossover, generator ran to the band end",
        result: blocker ? "fail" : "pass",
        consequence: blocker ? "margins at the crossover not shown by the data; no candidate search" : "none",
    });
    // 5. GM and |S| shown by the band (bounded, or read inside the band).
    const bandTop = band ? band[1] : null;
    const gmCheck: DecisionCheck = {
        rule: "gain_margin_shown_by_band",
        ref: REF_LOOP,
        value: cur.gainMarginDb ?? cur.measured.gainMarginDb,
        unit: "dB",
        threshold: `phase crossing inside the identified band (top ${bandTop === null ? "unknown" : `${bandTop.toFixed(1)} Hz`}), loop gain falling at the band end`,
        result: usable(states.gm) ? "pass" : "fail",
        consequence: usable(states.gm)
            ? "none"
            : `gain margin ${states.gm}; candidates cannot be checked against GM ≥ ${PID_TARGETS.minGainMarginDb} dB`,
    };
    const sCheck: DecisionCheck = {
        rule: "sensitivity_peak_shown_by_band",
        ref: REF_LOOP,
        value: cur.sensitivityPeakDb ?? cur.measured.sensitivityPeakDb,
        unit: "dB",
        threshold: `|S| peak inside the identified band (top ${bandTop === null ? "unknown" : `${bandTop.toFixed(1)} Hz`})`,
        result: usable(states.s) ? "pass" : "fail",
        consequence: usable(states.s)
            ? "none"
            : `|S| ${states.s}; candidates cannot be checked against |S| ≤ ${PID_TARGETS.maxSensitivityPeakDb} dB`,
    };
    checks.push(gmCheck, sCheck);
    if (!usable(states.gm) || !usable(states.s)) checks.push(bandTopCheck(loop, band, o.requiredBandHz ?? null));
    const limitation = cur.evidence?.level !== "VALIDATED";
    if (blocker || !usable(states.gm) || !usable(states.s))
        return out("plant_band_insufficient", {
            plant: "present_with_limitation",
            bandHz: band,
            metrics: states,
            current: valuesOf(cur),
            measurementUsable,
        });
    if (cur.evidence?.level === "MEASURED")
        checks.push({
            rule: "margin_bounds_established",
            ref: REF_LOOP,
            value: cur.evidence.level,
            unit: "evidence level",
            threshold: "MODEL_CONDITIONAL or VALIDATED for the release route",
            result: "waived",
            consequence: "release route unbounded; experimental search reads the in-band measured margins",
        });

    // 6. Candidate search on the in-band margins (same grid as the release route's search).
    const current = o.current;
    const kdRatio = current.d > 0 ? loop.cfg.axis.d / current.d : 1;
    const curV = valuesOf(cur);
    let tried = 0;
    let usableN = 0;
    let best: { v: PidValues; m: LoopMargins; val: ReturnType<typeof valuesOf> } | null = null;
    let safest: { v: PidValues; m: LoopMargins; val: ReturnType<typeof valuesOf> } | null = null;
    for (const v of searchGrid(current, null)) {
        if ([v.p, v.i, v.d].some((x) => x < 0 || x > 250) || v.dMax > 250) continue;
        tried++;
        const m = loopMargins(loop, { cfg: candidateCfg(loop.cfg, { ...v, d: v.d * kdRatio }) });
        const st = metricStates(m);
        if (!usable(st.pm) || !usable(st.gm) || !usable(st.s) || has(m, DATA_BLOCKERS)) continue;
        usableN++;
        const val = valuesOf(m);
        if (!safest || val.pmDeg! > safest.val.pmDeg!) safest = { v, m, val };
        if (meetsMeasured(val) && (!best || val.crossoverHz! > best.val.crossoverHz!)) best = { v, m, val };
    }
    const same = (v: PidValues) =>
        v.p === current.p && v.i === current.i && v.d === current.d && v.dMax === current.dMax;
    const curMeets = meetsMeasured(curV);
    const baseReasons = [
        "experimental_search_on_measured_margins",
        `margin_evidence:${cur.evidence?.level ?? "unknown"}`,
        ...waived.map((w) => `waived:${w}`),
    ];
    const candidate = (
        v: PidValues,
        m: LoopMargins,
        outcome: AxisPidProposal["outcome"],
        reasons: string[],
    ): AxisPidProposal => ({
        axis: (["roll", "pitch", "yaw"] as const)[loop.axis],
        current,
        proposed: v,
        changed: !same(v),
        currentMargins: cur,
        proposedMargins: m,
        outcome,
        // Never VALIDATED: these margins are measured, not bounded.
        status: "BLOCKED",
        reasons: [...baseReasons, ...reasons, ...m.reasons.map((r) => `margins:${r}`)],
    });
    const searched = {
        plant: limitation ? ("present_with_limitation" as const) : ("present" as const),
        bandHz: band,
        metrics: states,
        current: curV,
        searchRan: true,
        candidatesTried: tried,
        candidatesUsable: usableN,
        measurementUsable,
    };
    const searchCheck = (result: DecisionCheck["result"], value: string, consequence: string): DecisionCheck => ({
        rule: "candidate_search_measured_margins",
        ref: REF_SEARCH,
        value,
        unit: "",
        threshold: `PM ≥ ${PID_TARGETS.minPhaseMarginDeg}°, GM ≥ ${PID_TARGETS.minGainMarginDb} dB, |S| ≤ ${PID_TARGETS.maxSensitivityPeakDb} dB; P/I/D within ±${Math.round(MAX_STEP * 100)} %`,
        result,
        consequence,
    });
    if (best && curMeets && best.val.crossoverHz! < curV.crossoverHz! * MIN_CROSSOVER_GAIN) {
        checks.push(
            searchCheck(
                "pass",
                `current meets targets; best crossover gain < ${MIN_CROSSOVER_GAIN}×`,
                "no change needed",
            ),
        );
        return out("no_change_needed", { ...searched, candidate: candidate(current, cur, "no_change_needed", []) });
    }
    if (best) {
        const outcome = curMeets ? "improved" : "restores_margins";
        checks.push(
            searchCheck(
                "pass",
                `${outcome}: crossover ${curV.crossoverHz?.toFixed(1)}→${best.val.crossoverHz?.toFixed(1)} Hz, PM ${best.val.pmDeg?.toFixed(0)}°, GM ${best.val.gmDb?.toFixed(1)} dB, |S| ${best.val.sDb?.toFixed(1)} dB`,
                "experimental candidate offered",
            ),
        );
        return out("candidate_found", { ...searched, candidate: candidate(best.v, best.m, outcome, []) });
    }
    if (!usableN) {
        checks.push(
            searchCheck(
                "fail",
                `0 of ${tried} candidates have in-band GM and |S|`,
                "no candidate can be checked; band insufficient for the candidates",
            ),
        );
        return out("plant_band_insufficient", searched);
    }
    // A usable plant and no candidate within the targets: name the shortfall and whether the step
    // limit bounds it (the safest candidate on the edge of the ±MAX_STEP grid).
    const edge = (x: number, c: number) =>
        c > 0 && (x === Math.round(c * SCALES[0]) || x === Math.round(c * SCALES[SCALES.length - 1]));
    const atEdge = !!safest && (edge(safest.v.p, current.p) || edge(safest.v.d, current.d));
    const s = safest!.val;
    const shortfall = `best PM ${s.pmDeg?.toFixed(0)}° (P ${safest!.v.p}, I ${safest!.v.i}, D ${safest!.v.d}), GM ${s.gmDb?.toFixed(1)} dB, |S| ${s.sDb?.toFixed(1)} dB over ${usableN} usable of ${tried}`;
    checks.push(
        searchCheck(
            "fail",
            shortfall,
            atEdge
                ? `search limit: the best candidate lies on the ±${Math.round(MAX_STEP * 100)} % step edge; a larger change than one step is needed (not more data)`
                : "targets not reachable with this plant inside the search grid (not more data)",
        ),
    );
    return out(atEdge ? "search_limit_max_step" : "targets_not_reachable", {
        ...searched,
        candidate: candidate(safest!.v, safest!.m, "targets_not_reachable", [
            atEdge ? "search_limit:max_step" : "no_candidate_meets_all_targets",
        ]),
    });
}
