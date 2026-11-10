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

import type { AxisLoop, LoopMargins, MissingBin } from "@/gyrocore/engine/loopModel";
import {
    candidateLoop,
    LOOP_MIN_COHERENCE,
    loopMargins,
    missingBandBins,
    missingBinOf,
    UNCERTAINTY,
} from "@/gyrocore/engine/loopModel";
import { MEAN_COHERENCE_BAND_HZ } from "@/gyrocore/chirp/quality";
import { RECORDING_AGREEMENT, type RecordingCombination } from "@/gyrocore/engine/multiRecording";
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
    | "target_beyond_max_step"
    | "target_search_limit"
    | "search_constrained_by_verified_tune"
    | "no_change_needed"
    | "candidate_found";

/**
 * A frequency interval this route's data does not show, with the rule, the measured value and the
 * threshold. Adjacent grid bins with the same reason form one interval (from / to are bin centres).
 *   - decision_band_hole: bins inside the decision band left out of the loop (decision_band_gaps).
 *   - below_identified_band / above_identified_band: the part of the planner band the identified
 *     band does not reach (identified_band_top), with the rule of the first bin outside it.
 *   - quality_gate_band: the primary gate's fixed band when its mean coherence failed and was not waived.
 */
export interface MissingInterval {
    kind: "decision_band_hole" | "below_identified_band" | "above_identified_band" | "quality_gate_band";
    fromHz: number;
    toHz: number;
    /** Grid bins in the interval; null for an interval that is a band, not bins. */
    bins: number | null;
    reason: MissingBin["reason"] | "low_mean_coherence";
    /** The worst value over the interval (lowest γ², largest ±kε); null: the rule has no number or it is unknown. */
    value: number | null;
    unit: string;
    threshold: string;
}

/** Adjacent missing bins (one grid step apart) with the same reason, as intervals. */
export function missingIntervals(bins: MissingBin[], stepHz: number | null): MissingInterval[] {
    const out: MissingInterval[] = [];
    const worse = (r: MissingBin["reason"], a: number | null, b: number | null) =>
        a === null ? b : b === null ? a : r === "coherence" ? Math.min(a, b) : Math.max(a, b);
    for (const b of bins) {
        const last = out[out.length - 1];
        const adjacent =
            last && last.reason === b.reason && stepHz !== null && b.frequencyHz - last.toHz <= 1.5 * stepHz;
        if (adjacent) {
            last.toHz = b.frequencyHz;
            last.bins = (last.bins ?? 0) + 1;
            last.value = worse(b.reason, last.value, b.value);
            continue;
        }
        out.push({
            kind: "decision_band_hole",
            fromHz: b.frequencyHz,
            toHz: b.frequencyHz,
            bins: 1,
            reason: b.reason,
            value: b.value,
            unit: b.reason === "coherence" ? "γ²" : b.reason === "uncertainty" ? "±kε" : "",
            threshold: b.threshold,
        });
    }
    return out;
}

/** The planner band's parts outside the identified band, with the rule of the first bin outside it. */
export function bandShortfall(
    loop: AxisLoop,
    band: [number, number] | null,
    required: [number, number] | null,
): MissingInterval[] {
    if (!required) return [];
    const bins = loop.plant.bins;
    const iv = (
        kind: MissingInterval["kind"],
        from: number,
        to: number,
        b: (typeof bins)[number] | null,
    ): MissingInterval => {
        const m = b ? missingBinOf(loop, b) : null;
        return {
            kind,
            fromHz: from,
            toHz: to,
            bins: null,
            reason: m?.reason ?? "plantStatus",
            value: m?.value ?? null,
            unit: m?.reason === "coherence" ? "γ²" : m?.reason === "uncertainty" ? "±kε" : "",
            threshold: m
                ? `${m.threshold} (first bin outside the identified band: ${b!.frequencyHz.toFixed(1)} Hz)`
                : "an identified band",
        };
    };
    if (!band) return [iv("above_identified_band", required[0], required[1], null)];
    const out: MissingInterval[] = [];
    if (band[0] > required[0] + 1e-9) {
        const below = [...bins].reverse().find((b) => b.frequencyHz < band[0] - 1e-9) ?? null;
        out.push(
            iv(
                "below_identified_band",
                required[0],
                below && below.frequencyHz >= required[0] ? below.frequencyHz : band[0],
                below,
            ),
        );
    }
    if (band[1] < required[1] - 1e-9) {
        const above = bins.find((b) => b.frequencyHz > band[1] + 1e-9) ?? null;
        // The first bin outside may lie past the planner top already: the interval then starts at the band end.
        const from = above && above.frequencyHz <= required[1] ? above.frequencyHz : band[1];
        out.push(iv("above_identified_band", from, required[1], above));
    }
    return out;
}

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
    /** The frequencies this route's data does not show (empty: none found, or no plant to look at). */
    missing: MissingInterval[];
    /** Qualification gates this route waived for the experimental route (named, not hidden). */
    waived: string[];
    /** Independent flights combined into this route's loop (block 8); null: none offered. */
    combination?: CombinationSummary | null;
    /**
     * The wider target search (TARGET_SEARCH), run when no candidate within one Apply's ±MAX_STEP
     * meets the targets: where a final tune would lie, and the first step towards it, each read on
     * its own margins. Information only: neither is offered unless it meets the targets itself.
     */
    target?: TargetSearch | null;
}

export interface CombinationSummary {
    flights: string[];
    rejected: string[];
    medianZ: number | null;
    commonBins: number;
    consistent: boolean | null;
    /** Bin centres (Hz) by how the combination formed them. */
    pooledHz: number[];
    otherFlightHz: number[];
    disagreeHz: { hz: number; z: number | null }[];
    /** Holes where the other flights disagree among themselves (or cannot be compared): nothing taken. */
    othersDisagreeHz: number[];
    notFilledHz: number[];
}

export interface CandidateRead {
    values: PidValues;
    /** Relative change per term against the current tune (P, I, D). */
    change: { p: number; i: number; d: number };
    crossoverHz: number | null;
    pmDeg: number | null;
    gmDb: number | null;
    sDb: number | null;
    meetsTargets: boolean;
}

export interface TargetSearch {
    /** The bounds searched, as scales of the current P (I with it) and D. */
    pScale: [number, number];
    dScale: [number, number];
    tried: number;
    usable: number;
    /** The candidate meeting all targets with the highest crossover; null: none in these bounds. */
    target: CandidateRead | null;
    /** Without a target: the candidate with the highest PM, and whether it lies on the bounds' edge. */
    best: CandidateRead | null;
    bestOnEdge: boolean;
    /** The target clipped term by term to ±MAX_STEP of the current tune, read on its own margins. */
    step: CandidateRead | null;
    /** step improves PM, GM and |S| against the current tune (shown; not a release or offer rule). */
    stepImprovesAll: boolean | null;
}

/**
 * Bounds of the wider target search (block 8). P and I move together (their ratio is kept, as in the
 * ±MAX_STEP grid), D on its own; d_max keeps its ratio to D. P/I down to 0.4×: the AIR65 roll search
 * finds its safest candidate on the −30 % edge, so the measured loop asks for less P than one step
 * allows; every candidate is still read only where its crossover, phase crossing and |S| peak lie
 * inside the identified band without holes. Not below 0.4×: PM, GM and the |S| peak do not measure
 * what lower P and I give up (low-frequency disturbance rejection and tracking), so a search without
 * that bound drifts to tunes that only look good on these three numbers (AIR65 011849 JIO roll: a
 * "target" at P 8, I 12). A best candidate on this edge is reported as such (target_search_limit).
 * D is never raised beyond one Apply's +30 %: D-term noise and motor heat are not in the margins.
 * Same 0.05 resolution as SCALES.
 */
export const TARGET_SEARCH = Object.freeze({
    pScale: [0.4, 1.3] as [number, number],
    dScale: [0.5, 1.3] as [number, number],
    step: 0.05,
});

function scalesOf([lo, hi]: [number, number], step: number): number[] {
    const out: number[] = [];
    for (let k = Math.round(lo / step); k <= Math.round(hi / step) + 1e-9; k++)
        out.push(Math.round(k * step * 100) / 100);
    return out;
}

function summarize(c: RecordingCombination | null | undefined): CombinationSummary | null {
    if (!c) return null;
    const of = (u: string) => c.bins.filter((b) => b.use === u);
    return {
        flights: c.contributors,
        rejected: c.rejected,
        medianZ: c.medianZ,
        commonBins: c.commonBins,
        consistent: c.consistent,
        pooledHz: of("pooled").map((b) => b.frequencyHz),
        otherFlightHz: of("other_flight").map((b) => b.frequencyHz),
        disagreeHz: of("disagree_primary_kept").map((b) => ({ hz: b.frequencyHz, z: b.z })),
        othersDisagreeHz: of("others_disagree").map((b) => b.frequencyHz),
        notFilledHz: of("not_filled").map((b) => b.frequencyHz),
    };
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

export function valuesOf(m: LoopMargins) {
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
    /** The Verified Tune segment the release search is bound to (pidOptimizer ValidatedSegment); null: none. */
    segment?: Parameters<typeof searchGrid>[1];
    gate?: QualityGateInput | null;
    noPlantReasons?: string[];
    /** The band the planner needs for this loop (measurementPlan bandHz.primary); null: unknown. */
    requiredBandHz?: [number, number] | null;
    /** Independent flights combined into `loop` (multiRecording.ts combineRecordings); null: none. */
    combination?: RecordingCombination | null;
    /** The D-path fit of this axis (autotuneV2 analyzeAxisController); null: no D term or not simulated. */
    dterm?: { accepted: boolean; applied: boolean; nrmse: number | null; fallback: string } | null;
}): RouteDecision {
    const checks: DecisionCheck[] = [];
    if (o.dterm)
        checks.push({
            rule: "dterm_path_fit",
            ref: "src/js/blackbox/betaflight_dterm_dynamic.ts:dtermFitAccepted",
            value: o.dterm.nrmse,
            unit: "NRMSE",
            threshold: "accepted: coherent bands within 5 % gain and 3°, NRMSE below the static model",
            // Not a cause: the decision runs either way, on the controller named in the consequence.
            result: o.dterm.applied ? "pass" : "waived",
            consequence: o.dterm.applied
                ? "effective D (d_max, TPA, dynamic D-LPF) from the D-path simulation used for plant and margins"
                : o.dterm.accepted
                  ? `fit accepted but no effective-D window in the sweep: fallback ${o.dterm.fallback} (the headers' D with its static D-LPF) used for plant and margins`
                  : `D-path simulation does not reproduce the logged axisD: fallback ${o.dterm.fallback} (the headers' D with its static D-LPF) used for plant and margins`,
        });
    const combination = summarize(o.combination);
    // Named next to the other checks; never the first cause (an unusable combination leaves the
    // primary's own measurement, judged by the checks that follow).
    const combinationCheck: DecisionCheck | null = combination
        ? {
              rule: "multi_recording_combination",
              ref: "src/gyrocore/engine/multiRecording.ts:combineRecordings",
              value:
                  `${combination.flights.length} flight(s) combined; median z ${combination.medianZ === null ? "unknown" : combination.medianZ.toFixed(2)} over ${combination.commonBins} common bins; ` +
                  `pooled ${combination.pooledHz.length}, from the other flight ${combination.otherFlightHz.length}, disagreeing (primary kept) ${combination.disagreeHz.length}, other flights disagreeing among themselves (not taken) ${combination.othersDisagreeHz.length}, not filled ${combination.notFilledHz.length}`,
              unit: "",
              threshold: `median z ≤ ${RECORDING_AGREEMENT.maxAxisMedianZ} over ≥ ${RECORDING_AGREEMENT.minCommonBins} bins both flights identify; a bin pooled only with z ≤ ${RECORDING_AGREEMENT.maxBinZ}; same analysis grid`,
              result: combination.consistent === true ? "pass" : combination.consistent === false ? "fail" : "unknown",
              consequence:
                  combination.consistent === true
                      ? `agreeing bins pooled; bins the primary has no testable estimate for taken from other flights only where they agree among themselves; disagreeing bins keep the primary's values and fill no hole${combination.rejected.length ? `; not combined: ${combination.rejected.join(", ")}` : ""}`
                      : "no combination: the primary's own measurement only",
          }
        : null;
    const waived: string[] = [];
    const missing: MissingInterval[] = [];
    const out = (status: DecisionStatus, extra: Partial<RouteDecision> = {}): RouteDecision => {
        const firstCause =
            checks.find(
                (c) => (c.result === "fail" || c.result === "unknown") && c.rule !== "multi_recording_combination",
            ) ?? null;
        if (combinationCheck && !checks.includes(combinationCheck)) checks.push(combinationCheck);
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
            missing,
            waived,
            combination,
            target: null,
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
    // What the data does not show: the holes supportIssues counts (same range, same bins) and the
    // planner band outside the identified band.
    const plantStep =
        loop.analysisStepHz ??
        (loop.plant.bins.length > 1 ? loop.plant.bins[1].frequencyHz - loop.plant.bins[0].frequencyHz : null);
    missing.push(
        ...missingIntervals(missingBandBins(loop, candidateLoop(loop, { cfg: loop.cfg }), cur.crossoverHz), plantStep),
        ...bandShortfall(loop, band, o.requiredBandHz ?? null),
    );

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
            if (failed && !(decisionSupported && !failedOthers.length))
                missing.push({
                    kind: "quality_gate_band",
                    fromHz: MEAN_COHERENCE_BAND_HZ[0],
                    toHz: MEAN_COHERENCE_BAND_HZ[1],
                    bins: null,
                    reason: "low_mean_coherence",
                    value: coh.value,
                    unit: "mean γ²",
                    threshold: `≥ ${coh.threshold ?? 0.6}`,
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
    // Holes inside the decision band (bins left out for coherence, support or uncertainty) can hide
    // a resonance or the |S| peak between the bins that remain (loopModel supportIssues; the T3 audit
    // case: one incoherent bin read PM 82° on a loop with 4.7°). Block 6 review: no search on them.
    const holesReason = has(cur, /^(unidentified_bins_inside_band|identified_band_has_gaps)/);
    const holeCount = (() => {
        const r = cur.reasons.find((x) => x.startsWith("unidentified_bins_inside_band:"));
        const n = r ? Number(r.split(":")[1]) : NaN;
        return Number.isFinite(n) ? n : holesReason ? null : 0;
    })();
    checks.push({
        rule: "decision_band_gaps",
        ref: "src/gyrocore/engine/loopModel.ts:supportIssues",
        value: holeCount,
        unit: "unidentified bins",
        threshold: "0 unidentified bins inside the decision band (a hole can hide a resonance or the |S| peak)",
        result: holesReason ? "fail" : "pass",
        consequence: holesReason ? "margins between the holes not shown by the data; no candidate search" : "none",
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
    if (blocker || holesReason || !usable(states.gm) || !usable(states.s))
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
    // A bound Verified Tune whose gain-change flight also moved feedforward covers no point this
    // search can propose (pidOptimizer: verified_tune_segment_moves_feedforward): no search, and no
    // claim that the band is short.
    const seg = o.segment ?? null;
    const fKey = seg?.keys[3];
    if (seg && fKey && seg.base[fKey] !== seg.cand[fKey]) {
        checks.push({
            rule: "verified_tune_segment",
            ref: "src/gyrocore/engine/pidOptimizer.ts:optimizeAxisPid",
            value: `${fKey}:${seg.base[fKey]}->${seg.cand[fKey]}`,
            unit: "",
            threshold: "the Verified Tune's gain-change flight leaves feedforward unchanged",
            result: "fail",
            consequence:
                "the search stays on that segment and finds no point on it; a gain-change flight with feedforward unchanged is needed",
        });
        return out("search_constrained_by_verified_tune", {
            plant: limitation ? "present_with_limitation" : "present",
            bandHz: band,
            metrics: states,
            current: valuesOf(cur),
            measurementUsable,
        });
    }
    const kdRatio = current.d > 0 ? loop.cfg.axis.d / current.d : 1;
    const curV = valuesOf(cur);
    let tried = 0;
    let usableN = 0;
    let best: { v: PidValues; m: LoopMargins; val: ReturnType<typeof valuesOf> } | null = null;
    let safest: { v: PidValues; m: LoopMargins; val: ReturnType<typeof valuesOf> } | null = null;
    for (const v of searchGrid(current, o.segment ?? null)) {
        if ([v.p, v.i, v.d].some((x) => x < 0 || x > 250) || v.dMax > 250) continue;
        tried++;
        const m = loopMargins(loop, { cfg: candidateCfg(loop.cfg, { ...v, d: v.d * kdRatio }) });
        const st = metricStates(m);
        if (
            !usable(st.pm) ||
            !usable(st.gm) ||
            !usable(st.s) ||
            has(m, DATA_BLOCKERS) ||
            has(m, /^(unidentified_bins_inside_band|identified_band_has_gaps)/)
        )
            continue;
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
    // The search space of a final tune is wider than one Apply (block 8): where would a tune meeting
    // the targets lie, and what does the first step towards it predict on its own margins? Neither
    // is offered: a candidate is offered only when it meets the targets itself and lies within
    // ±MAX_STEP of the current tune (a farther target never widens what one Apply may write).
    const target = o.segment ? null : targetSearch(loop, current, kdRatio, curV);
    const reached = !!target?.target;
    // The first step towards the target lies within ±MAX_STEP on every term; when it meets the targets
    // on its own margins it is a candidate like any grid point (block 8 review, NOTE 3). A guard, not
    // a path the search normally takes: the step is a point of the ±MAX_STEP grid (same 0.05 scales,
    // clipped to its edges), and d_max, the one value rounded differently, does not enter the
    // margins (candidateCfg), so a step meeting the targets would already be the grid's best (round 2, NOTE C).
    if (target?.step?.meetsTargets) {
        const sv = target.step.values;
        const m = loopMargins(loop, { cfg: candidateCfg(loop.cfg, { ...sv, d: sv.d * kdRatio }) });
        const outcome = curMeets ? "improved" : "restores_margins";
        checks.push(
            searchCheck(
                "pass",
                `${outcome}: first step towards the target, crossover ${curV.crossoverHz?.toFixed(1)}→${target.step.crossoverHz?.toFixed(1)} Hz, PM ${target.step.pmDeg?.toFixed(0)}°, GM ${target.step.gmDb?.toFixed(1)} dB, |S| ${target.step.sDb?.toFixed(1)} dB`,
                "experimental candidate offered (the first step; the target itself lies beyond one Apply)",
            ),
            targetCheck(target),
        );
        return out("candidate_found", {
            ...searched,
            target,
            candidate: candidate(sv, m, outcome, ["first_step_towards_target"]),
        });
    }
    checks.push(
        searchCheck(
            "fail",
            shortfall,
            reached
                ? `no candidate within ±${Math.round(MAX_STEP * 100)} % meets the targets; a tune meeting them lies farther (see target search)`
                : target?.bestOnEdge
                  ? `no candidate meets the targets within ±${Math.round(MAX_STEP * 100)} % nor within the wider target search, whose best candidate lies on its edge: the search bounds limit it (see target search)`
                  : target
                    ? `no candidate meets the targets within ±${Math.round(MAX_STEP * 100)} % nor within the wider target search: the step limit is not what stops a candidate on this measurement`
                    : atEdge
                      ? `search limit: the best candidate lies on the ±${Math.round(MAX_STEP * 100)} % step edge; the current search found no suitable candidate within its limits (new data can still change this)`
                      : "targets not reachable with this plant inside the search grid (the current search found no suitable candidate within its limits; new data can still change this)",
        ),
    );
    if (target) checks.push(targetCheck(target));
    // With the wider search run and no target in it, the ±MAX_STEP edge is not the limit (block 8);
    // the wider bounds are, when its best candidate lies on their edge.
    const status: DecisionStatus = reached
        ? "target_beyond_max_step"
        : target?.bestOnEdge
          ? "target_search_limit"
          : atEdge && !target
            ? "search_limit_max_step"
            : "targets_not_reachable";
    return out(status, {
        ...searched,
        target,
        candidate: candidate(safest!.v, safest!.m, "targets_not_reachable", [
            reached
                ? "target_beyond_max_step"
                : target?.bestOnEdge
                  ? "search_limit:target_search_bounds"
                  : atEdge && !target
                    ? "search_limit:max_step"
                    : "no_candidate_meets_all_targets",
        ]),
    });
}

function readOf(v: PidValues, current: PidValues, val: ReturnType<typeof valuesOf>): CandidateRead {
    const rel = (x: number, c: number) => (c > 0 ? x / c - 1 : 0);
    return {
        values: v,
        change: { p: rel(v.p, current.p), i: rel(v.i, current.i), d: rel(v.d, current.d) },
        crossoverHz: val.crossoverHz,
        pmDeg: val.pmDeg,
        gmDb: val.gmDb,
        sDb: val.sDb,
        meetsTargets: meetsMeasured(val),
    };
}

/** One candidate's in-band measured margins, or null where the band does not show them (same rule as the grid). */
function readCandidate(loop: AxisLoop, v: PidValues, kdRatio: number): ReturnType<typeof valuesOf> | null {
    if ([v.p, v.i, v.d].some((x) => x < 0 || x > 250) || v.dMax > 250) return null;
    const m = loopMargins(loop, { cfg: candidateCfg(loop.cfg, { ...v, d: v.d * kdRatio }) });
    const st = metricStates(m);
    if (
        !usable(st.pm) ||
        !usable(st.gm) ||
        !usable(st.s) ||
        has(m, DATA_BLOCKERS) ||
        has(m, /^(unidentified_bins_inside_band|identified_band_has_gaps)/)
    )
        return null;
    return valuesOf(m);
}

/** The PID values at scale `ps` of P and I and `ds` of D (d_max keeps its ratio to D, never below D). */
function scaled(current: PidValues, ps: number, ds: number): PidValues {
    const d = Math.round(current.d * ds);
    return {
        p: Math.round(current.p * ps),
        i: Math.round(current.i * ps),
        d,
        dMax: current.dMax > 0 ? Math.max(Math.round(current.dMax * ds), d) : 0,
    };
}

/** TARGET_SEARCH around `current`, and the first ±MAX_STEP step towards its target. */
export function targetSearch(
    loop: AxisLoop,
    current: PidValues,
    kdRatio: number,
    curV: ReturnType<typeof valuesOf>,
    bounds: { pScale: [number, number]; dScale: [number, number] } = TARGET_SEARCH,
): TargetSearch {
    const pScales = scalesOf(bounds.pScale, TARGET_SEARCH.step);
    const dScales = current.d > 0 ? scalesOf(bounds.dScale, TARGET_SEARCH.step) : [1];
    let tried = 0;
    let usableN = 0;
    let target: { v: PidValues; val: ReturnType<typeof valuesOf> } | null = null;
    let best: { v: PidValues; val: ReturnType<typeof valuesOf>; ps: number; ds: number } | null = null;
    for (const ps of pScales)
        for (const ds of dScales) {
            const v = scaled(current, ps, ds);
            tried++;
            const val = readCandidate(loop, v, kdRatio);
            if (!val) continue;
            usableN++;
            if (!best || val.pmDeg! > best.val.pmDeg!) best = { v, val, ps, ds };
            if (meetsMeasured(val) && (!target || val.crossoverHz! > target.val.crossoverHz!)) target = { v, val };
        }
    const onEdge =
        !!best &&
        (best.ps === pScales[0] ||
            best.ps === pScales[pScales.length - 1] ||
            (dScales.length > 1 && (best.ds === dScales[0] || best.ds === dScales[dScales.length - 1])));
    let step: CandidateRead | null = null;
    let stepImprovesAll: boolean | null = null;
    if (target) {
        // Term by term towards the target, at most MAX_STEP from the current value.
        const clip = (x: number, c: number) =>
            c > 0 ? Math.min(Math.round(c * (1 + MAX_STEP)), Math.max(Math.round(c * (1 - MAX_STEP)), x)) : x;
        const sv: PidValues = {
            p: clip(target.v.p, current.p),
            i: clip(target.v.i, current.i),
            d: clip(target.v.d, current.d),
            dMax: 0,
        };
        sv.dMax =
            current.dMax > 0 && current.d > 0
                ? Math.max(Math.round((current.dMax * sv.d) / current.d), sv.d)
                : current.dMax > 0
                  ? current.dMax
                  : 0;
        const val = readCandidate(loop, sv, kdRatio);
        if (val) {
            step = readOf(sv, current, val);
            stepImprovesAll =
                curV.pmDeg !== null &&
                curV.gmDb !== null &&
                curV.sDb !== null &&
                val.pmDeg! > curV.pmDeg &&
                val.gmDb! > curV.gmDb &&
                val.sDb! < curV.sDb;
        }
    }
    return {
        pScale: bounds.pScale,
        dScale: current.d > 0 ? bounds.dScale : [1, 1],
        tried,
        usable: usableN,
        target: target ? readOf(target.v, current, target.val) : null,
        best: target ? null : best ? readOf(best.v, current, best.val) : null,
        bestOnEdge: !target && onEdge,
        step,
        stepImprovesAll,
    };
}

function fmtRead(r: CandidateRead): string {
    const pct = (x: number) => `${x >= 0 ? "+" : ""}${Math.round(x * 100)} %`;
    return `P ${r.values.p} (${pct(r.change.p)}), I ${r.values.i} (${pct(r.change.i)}), D ${r.values.d} (${pct(r.change.d)}): crossover ${r.crossoverHz?.toFixed(1)} Hz, PM ${r.pmDeg?.toFixed(0)}°, GM ${r.gmDb?.toFixed(1)} dB, |S| ${r.sDb?.toFixed(1)} dB`;
}

function targetCheck(t: TargetSearch): DecisionCheck {
    const bounds = `P/I ×${t.pScale[0]}–${t.pScale[1]}, D ×${t.dScale[0]}–${t.dScale[1]} (${t.usable} usable of ${t.tried})`;
    if (!t.target)
        return {
            rule: "target_search_wider_bounds",
            ref: "src/gyrocore/engine/candidateDecision.ts:targetSearch",
            value: t.best
                ? `no target; best ${fmtRead(t.best)}${t.bestOnEdge ? " (on the bounds' edge)" : ""}`
                : "no usable candidate",
            unit: "",
            threshold: `PM ≥ ${PID_TARGETS.minPhaseMarginDeg}°, GM ≥ ${PID_TARGETS.minGainMarginDb} dB, |S| ≤ ${PID_TARGETS.maxSensitivityPeakDb} dB within ${bounds}`,
            result: "fail",
            consequence: t.bestOnEdge
                ? "no tune within the wider bounds meets the targets; the best lies on their edge, so the bounds limit the search (below P/I ×0.4 the targets do not measure what is given up); nothing offered"
                : "no tune within the wider bounds meets the targets on this measurement; nothing offered",
        };
    const step = t.step
        ? `first step ${fmtRead(t.step)}${t.step.meetsTargets ? "" : " — misses the targets"}${t.stepImprovesAll ? "; better than the current tune on PM, GM and |S|" : ""}`
        : "first step not readable inside the identified band";
    return {
        rule: "target_search_wider_bounds",
        ref: "src/gyrocore/engine/candidateDecision.ts:targetSearch",
        value: `target ${fmtRead(t.target)}; ${step}`,
        unit: "",
        threshold: `a candidate is offered only within ±${Math.round(MAX_STEP * 100)} % per term and meeting PM ≥ ${PID_TARGETS.minPhaseMarginDeg}°, GM ≥ ${PID_TARGETS.minGainMarginDb} dB, |S| ≤ ${PID_TARGETS.maxSensitivityPeakDb} dB itself (search ${bounds})`,
        result: t.step?.meetsTargets ? "pass" : "fail",
        consequence: t.step?.meetsTargets
            ? "the first step meets the targets on its own margins and lies within one Apply: offered as the experimental candidate; the target itself is not (a guard: the grid normally finds such a step first)"
            : "target not offered (beyond one Apply); the first step is not offered because it misses the targets itself; both are measured predictions, not flight advice",
    };
}

/**
 * Informative improvement step (block 10). The candidate the measured-margin search already holds
 * for an axis (the offered one, or the safest within ±MAX_STEP when nothing meets the targets), or
 * the first step of the wider target search, shown when its own measured margins are better than
 * the current tune on PM, GM and |S| at once (the `stepImprovesAll` rule). Shown only: it is not an
 * experimental item, so the experimental Apply route cannot write it; the targets it still misses
 * are named, as is the check that stops a step when the measurement does not support one.
 */
export interface ImprovementStep {
    route: "primary" | "jio";
    source: "candidate_within_max_step" | "target_first_step";
    current: PidValues;
    values: PidValues;
    change: { p: number; i: number; d: number };
    before: { crossoverHz: number | null; pmDeg: number | null; gmDb: number | null; sDb: number | null };
    after: { crossoverHz: number | null; pmDeg: number | null; gmDb: number | null; sDb: number | null };
    /** Margin evidence of the measurement both are read on (MEASURED on this route). */
    evidence: string;
    /** The targets the step still misses (empty: it meets all three, and is then the offered candidate). */
    openTargets: string[];
    /** The search already offers this candidate as the experimental item (status candidate_found). */
    offered: boolean;
    /** Always true: an informative read, never an item to write. */
    informative: true;
}

export interface ImprovementStepRead {
    step: ImprovementStep | null;
    /** Why there is no step: the deciding check (value and threshold) or the comparison that failed. */
    blocked: {
        reason: "no_measurement" | "no_candidate" | "not_better_on_all_three";
        check: DecisionCheck | null;
    } | null;
}

function betterOnAllThree(before: ImprovementStep["before"], after: ImprovementStep["after"]): boolean {
    return (
        before.pmDeg !== null &&
        before.gmDb !== null &&
        before.sDb !== null &&
        after.pmDeg !== null &&
        after.gmDb !== null &&
        after.sDb !== null &&
        after.pmDeg > before.pmDeg &&
        after.gmDb > before.gmDb &&
        after.sDb < before.sDb
    );
}

export function openTargetsOf(after: ImprovementStep["after"]): string[] {
    const out: string[] = [];
    if (after.pmDeg === null || after.pmDeg < PID_TARGETS.minPhaseMarginDeg)
        out.push(
            `PM ${after.pmDeg === null ? "unknown" : `${after.pmDeg.toFixed(0)}°`} < ${PID_TARGETS.minPhaseMarginDeg}°`,
        );
    if (after.gmDb === null || after.gmDb < PID_TARGETS.minGainMarginDb)
        out.push(
            `GM ${after.gmDb === null ? "unknown" : `${after.gmDb.toFixed(1)} dB`} < ${PID_TARGETS.minGainMarginDb} dB`,
        );
    if (after.sDb === null || after.sDb > PID_TARGETS.maxSensitivityPeakDb)
        out.push(
            `|S| ${after.sDb === null ? "unknown" : `${after.sDb.toFixed(1)} dB`} > ${PID_TARGETS.maxSensitivityPeakDb} dB`,
        );
    return out;
}

export function improvementStep(r: RouteDecision | null): ImprovementStepRead {
    if (!r || !r.current || !r.measurementUsable || !r.searchRan)
        return { step: null, blocked: { reason: "no_measurement", check: r?.firstCause ?? null } };
    const before = r.current;
    const rel = (x: number, c: number) => (c > 0 ? x / c - 1 : 0);
    const cand = r.candidate;
    if (cand && cand.changed) {
        // Read exactly as the decision table reads a candidate (valuesOf), so before and after compare alike.
        const after = valuesOf(cand.proposedMargins);
        if (betterOnAllThree(before, after)) {
            return {
                step: {
                    route: r.route,
                    source: "candidate_within_max_step",
                    current: cand.current,
                    values: cand.proposed,
                    change: {
                        p: rel(cand.proposed.p, cand.current.p),
                        i: rel(cand.proposed.i, cand.current.i),
                        d: rel(cand.proposed.d, cand.current.d),
                    },
                    before,
                    after,
                    evidence: cand.currentMargins.evidence?.level ?? "unknown",
                    openTargets: openTargetsOf(after),
                    offered: r.status === "candidate_found",
                    informative: true,
                },
                blocked: null,
            };
        }
    }
    const t = r.target;
    if (t?.step && t.stepImprovesAll && cand) {
        const after = { crossoverHz: t.step.crossoverHz, pmDeg: t.step.pmDeg, gmDb: t.step.gmDb, sDb: t.step.sDb };
        return {
            step: {
                route: r.route,
                source: "target_first_step",
                current: cand.current,
                values: t.step.values,
                change: t.step.change,
                before,
                after,
                evidence: cand.currentMargins.evidence?.level ?? "unknown",
                openTargets: openTargetsOf(after),
                offered: false,
                informative: true,
            },
            blocked: null,
        };
    }
    if (!cand) return { step: null, blocked: { reason: "no_candidate", check: r.firstCause } };
    return {
        step: null,
        blocked: {
            reason: "not_better_on_all_three",
            check: r.checks.find((c) => c.rule === "candidate_search_measured_margins") ?? r.firstCause,
        },
    };
}
