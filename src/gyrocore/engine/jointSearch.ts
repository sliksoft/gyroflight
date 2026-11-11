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
 * Joint PID + filter search (block 12, 2026-11-11): a bounded search over the gyro lowpass group,
 * the D-term lowpass group and the ±MAX_STEP PID grid together, read on the same measured in-band
 * margins as the experimental PID search (candidateDecision.ts decideAxis), with a predicted noise
 * and motor-load cost per candidate.
 *
 * Where each filter sits, and why nothing is counted twice:
 *   gyro chain   gyroUnfilt → lpf2 → RPM notches → lpf1 (throttle-scheduled) → dynamic notch → gyroADC
 *                The identified plant G = H1(pidSum → gyroADC) contains the chain in force during the
 *                sweep. A candidate chain enters only as the ratio candidate/current of the chain FRF
 *                over the sweep window (loopModel candidateLoop: cand.chain / loop.chain), simulated on
 *                this log's own gyroUnfilt (gyroChain.ts). Needs gyroUnfilt logged and the chain
 *                validated against the logged gyroADC on this log (loopModel validateChain, control band).
 *   D-term path  gyroADC → Kd·Δ → dterm lpf1 (throttle-scheduled) → dterm lpf2 → axisD
 *                Part of the controller C_fb, which the plant excludes (G is read from pidSum, the
 *                controller's output). A candidate D-LPF enters through the controller FRF alone
 *                (betaflight_digital_controller evaluateControllerFrf, cfg.dtermLpf1Hz / dtermLpf2Hz),
 *                as the release route's filter proposals already do (autotuneV2 build). Needs the D path
 *                reproduced on the logged axisD (dtermFitAccepted) for the axis.
 *   Not searched RPM filter (harmonics / Q) and dynamic notch (count / Q): their centres over the sweep
 *                are reconstructed by the firmware replica from eRPM and the SDFT state, not logged
 *                (optimizeFilters keeps them as single-group PARTIAL advice with required measurements);
 *                static gyro and D-term notches, lowpass types other than PT1 and dyn-LPF expo: not
 *                modelled. Each is named in `parameters` with the evidence it lacks.
 *
 * Noise and motor load (predicted, on logged data): the power above NOISE_BAND_HZ of the controller
 * output noise the gyro noise causes, u = Kp·g + d, with g the candidate chain's gyroADC (simulated on
 * the logged gyroUnfilt) and d the candidate D path's output on it (simulateDterm), in flight and over
 * the samples both simulations hold. Kp scales with P, d with D (the D path is linear in Kd; d_max keeps
 * its ratio), so per (gyro scale, D-LPF scale) three band powers suffice: P(g), P(d) and the cross
 * power P(g, d) = (P(g + d) − P(g − d)) / 4. The ratio against the current tune is the candidate's
 * noiseRatio: the controller-output noise of that axis above the band, not the mixer's motor load. The
 * gyro lowpass is one setting for every axis, so a gyro filter change also moves the noise of the axes this
 * search did not analyse (no sweep, PID unchanged): their noise is not assessed here and is named as such
 * (`noiseNotAssessedAxes`, limitation `filter_change_noise_not_assessed_on:<axes>`); the SITL proof of
 * 2026-11-11 showed the motor band rising ×1.45 while the roll controller noise fell ×0.92. The PID-only
 * comparison point (decideAxis's candidate) is read with its noise for information but is not subjected
 * to the noise and bandwidth rules: a filter change must beat it as it is (conservative asymmetry).
 * I is left out of the noise (negligible there).
 *
 * Budget: every filter combination is screened on the coarse PID grid (P ×0.7…1.3 in 0.1 steps, I and
 * D each ×0.7, ×1, ×1.3, with the noise model); the three best (axes with an eligible point, then the sum of their highest
 * crossover gains, then meeting points and PM) get the full 0.1 grid. A combination without an eligible
 * coarse point is refined only when fewer than three have one (JOINT_SEARCH.screenScales / screenKeep);
 * the screen summary of every combination is kept.
 *
 * Selection (fixed before the SITL proof): a candidate is usable on the same rule as the PID grid
 * (readableValues); eligible when it meets PM / GM / |S| (PID_TARGETS), its noiseRatio ≤
 * 1 + NOISE_ALLOWANCE, and its crossover keeps at least MIN_CROSSOVER_KEEP of the current one
 * (tracking / bandwidth, so a slower tune does not win on margins alone); per filter combination and
 * axis the eligible candidate with the highest crossover is its best. The gyro and D-term lowpass are
 * one setting for every axis, so a combination is judged over all analysed axes: more axes meeting the
 * targets wins; at equal count the higher mean crossover gain wins, and a filter change must beat the
 * PID-only best (the grid's own candidate, decideAxis) by MIN_CROSSOVER_GAIN there, else the PID-only
 * candidate stands. The chosen candidate is offered as experimental items (measured margins, never
 * VALIDATED) through the existing experimental route and its write bounds (±MAX_STEP per PID term,
 * firmware ranges); everything else here is information.
 */

import { PTERM_SCALE, type DigitalControllerConfig } from "@/js/blackbox/betaflight_digital_controller";
import { simulateDterm, type DtermDynamicConfig } from "@/js/blackbox/betaflight_dterm_dynamic";
import {
    effectiveChainFrf,
    simulateGyroChain,
    type ChainInput,
    type ChainSimulation,
    type EffectiveChain,
    type GyroChainConfig,
} from "./gyroChain";
import { maskedBandPower, NOISE_ALLOWANCE, NOISE_BAND_HZ } from "./filterOptimizer";
import { loopMargins, type AxisLoop, type LoopMargins } from "./loopModel";
import {
    candidateCfg,
    MAX_STEP,
    MIN_CROSSOVER_GAIN,
    PID_TARGETS,
    type AxisPidProposal,
    type PidValues,
} from "./pidOptimizer";
import { meetsMeasured, readableValues, scaledPid, scalesOf, type RouteDecision } from "./candidateDecision";

export type JointAxisName = "roll" | "pitch" | "yaw";

/** Bounds and budget of the joint search (pre-registered; the SITL proof reads them from here). */
export const JOINT_SEARCH = Object.freeze({
    /** Scale applied to every cutoff of the gyro lowpass group (lpf1 static, dyn min, dyn max, lpf2). */
    gyroLpfScales: [0.8, 1, 1.25, 1.5] as readonly number[],
    /** Scale applied to every cutoff of the D-term lowpass group (lpf1 static, dyn min, dyn max, lpf2). */
    dtermLpfScales: [0.8, 1, 1.25, 1.5] as readonly number[],
    /** PID step of the joint grid: P, I and D each on 1 ± MAX_STEP at this step (a subset of SCALES). */
    pidStep: 0.1,
    /**
     * Budget: every filter combination is first screened on the coarse PID grid (P, I, D each on
     * screenScales, with the noise model); the screenKeep best combinations (axes with an eligible
     * point, then the sum of their highest crossover gains, then meeting points and PM) are then
     * searched on the full grid. 15 × 63 + 3 × 343 = 1974 reads per axis instead of 15 × 343 = 5145.
     */
    screenScales: [1 - MAX_STEP, 1, 1 + MAX_STEP] as readonly number[],
    /** P on the screen at the full step (the term that moves crossover and noise most); I and D on screenScales. */
    screenPStep: 0.1,
    screenKeep: 3,
    /** Predicted controller-output noise above NOISE_BAND_HZ may not grow by more than this. */
    maxNoiseRatio: 1 + NOISE_ALLOWANCE,
    /** The candidate's crossover keeps at least this fraction of the current one. */
    minCrossoverKeep: 0.8,
    /** A filter change must beat the PID-only best by this crossover factor at equal axes meeting. */
    minGainOverPidOnly: MIN_CROSSOVER_GAIN,
    cutoffMinHz: 0,
    cutoffMaxHz: 1000,
});

/** Eligible candidates kept per combination and axis (information; the best is always among them). */
export const ELIGIBLE_KEPT = 25;

export const GYRO_LPF_KEYS = [
    "gyro_lpf1_static_hz",
    "gyro_lpf1_dyn_min_hz",
    "gyro_lpf1_dyn_max_hz",
    "gyro_lpf2_static_hz",
] as const;
export const DTERM_LPF_KEYS = [
    "dterm_lpf1_static_hz",
    "dterm_lpf1_dyn_min_hz",
    "dterm_lpf1_dyn_max_hz",
    "dterm_lpf2_static_hz",
] as const;

export interface JointAxisInput {
    axis: JointAxisName;
    /** The loop the experimental decision reads (autotuneV2 experimentalLoop). */
    loop: AxisLoop;
    current: PidValues;
    /** The primary route's decision (the PID-only search on the same loop). */
    decision: RouteDecision;
    /** CHIRP sweep sample range [start, end) of this axis. */
    window: [number, number];
    /** D path of this axis (M5-B); null without D. */
    dterm: DtermDynamicConfig | null;
    /** The D path reproduced the logged axisD (dtermFitAccepted). */
    dtermValidated: boolean;
    /** The gyro chain reproduced the logged gyroADC of this axis (control band PASS). */
    chainValidated: boolean;
    /** Logged gyroADC of this axis (the D path's input where the chain is not simulated). */
    gyroAdc: ArrayLike<number>;
}

export interface JointSearchInput {
    axes: JointAxisInput[];
    chainCfg: GyroChainConfig | null;
    /** Null: gyroUnfilt not logged (no chain simulation, no gyro lowpass search). */
    chainInput: ChainInput | null;
    /** The chain simulation of the current configuration (autotuneV2); null without one. */
    baseSim: ChainSimulation | null;
    sampleRateHz: number;
    flightMask: Uint8Array;
    /** Every axis the log holds a gyro for (default roll, pitch, yaw): the ones not analysed are named when a gyro filter changes. */
    allAxes?: JointAxisName[];
}

export interface JointNoise {
    /** Predicted controller-output noise power above the band against the current tune (null: not computable). */
    ratio: number | null;
    /** Its P-term part (Kp² · gyro noise) and D-term part (D path output) against the current tune. */
    gyroTermRatio: number | null;
    dtermRatio: number | null;
    bandHz: [number, number];
}

export interface JointCandidateRead {
    pid: PidValues;
    gyroScale: number;
    dtermScale: number;
    crossoverHz: number | null;
    pmDeg: number | null;
    gmDb: number | null;
    sDb: number | null;
    meetsTargets: boolean;
    /** Crossover against the current tune. */
    crossoverGain: number | null;
    noise: JointNoise;
}

export interface JointParameterEvidence {
    key: string;
    group: "gyro_filter" | "dterm_filter" | "rpm_filter" | "dynamic_notch" | "gyro_notch" | "dterm_notch";
    searched: boolean;
    /** Where the parameter acts and how the model sees it. */
    model: string;
    /** What the data lacks for this parameter (empty when searched). */
    missing: string[];
}

export interface JointComboAxis {
    axis: JointAxisName;
    tried: number;
    usable: number;
    /** Usable candidates that met the targets but were turned down for noise or bandwidth. */
    excludedForNoise: number;
    excludedForBandwidth: number;
    /** The eligible candidate with the highest crossover; null: none meets the targets within the rules. */
    best: JointCandidateRead | null;
    /** Every eligible candidate (meets the targets within the noise and bandwidth rules), highest crossover first; at most ELIGIBLE_KEPT. */
    eligible: JointCandidateRead[];
    /** Without a best: the usable candidate with the highest PM (information). */
    safest: JointCandidateRead | null;
    /**
     * Coarse screen of this combination and axis: points meeting the targets, points eligible (targets,
     * noise and bandwidth rules), the highest PM read and the highest crossover gain among the eligible.
     */
    screen: {
        tried: number;
        usable: number;
        meeting: number;
        eligible: number;
        maxPmDeg: number | null;
        maxCrossoverGain: number | null;
    };
}

export interface JointCombo {
    gyroScale: number;
    dtermScale: number;
    /** Proposed filter values (every searched key, changed or not). */
    filters: Record<string, number>;
    axes: JointComboAxis[];
    axesMeeting: number;
    /** Mean crossover gain of the axes' bests over the axes meeting (null when none). */
    meanCrossoverGain: number | null;
    /** The full grid and the noise model ran on this combination (the screen kept it). */
    searched: boolean;
}

export interface JointChosen {
    gyroScale: number;
    dtermScale: number;
    /** Filter items: current → proposed (only keys whose value changes). */
    filters: Record<string, { from: number; to: number }>;
    axes: Partial<Record<JointAxisName, { read: JointCandidateRead; proposal: AxisPidProposal }>>;
    /** Why it was chosen over the PID-only best. */
    reason: "more_axes_meet_targets" | "higher_crossover_at_equal_axes";
    pidOnly: { axesMeeting: number; meanCrossoverGain: number | null };
    /** Axes whose noise this candidate's gyro filter change moves but which the search did not analyse (no sweep). */
    noiseNotAssessedAxes: JointAxisName[];
}

export type JointSearchStatus =
    "not_run" | "candidate_found" | "pid_only_stands" | "no_candidate_meets_targets_within_rules";

export interface JointSearchResult {
    status: JointSearchStatus;
    /** Why the search did not run, or what limited it. */
    reasons: string[];
    searched: {
        gyroLpfScales: number[];
        dtermLpfScales: number[];
        pidScales: number[];
        screenScales: number[];
        screenPStep: number;
        screenKeep: number;
        maxNoiseRatio: number;
        minCrossoverKeep: number;
        minGainOverPidOnly: number;
        noiseBandHz: [number, number];
    };
    parameters: JointParameterEvidence[];
    current: {
        filters: Record<string, number>;
        axes: Partial<
            Record<
                JointAxisName,
                {
                    pid: PidValues;
                    crossoverHz: number | null;
                    pmDeg: number | null;
                    gmDb: number | null;
                    sDb: number | null;
                }
            >
        >;
    };
    /** The PID-only best per axis (decideAxis's offered candidate) read with its noise, for the comparison. */
    pidOnly: Partial<Record<JointAxisName, JointCandidateRead | null>>;
    combos: JointCombo[];
    chosen: JointChosen | null;
    candidatesTried: number;
    candidatesUsable: number;
    /** Wall time (diagnostic, not deterministic: strip before comparing). */
    searchMs: number;
}

const clampHz = (v: number) => Math.min(JOINT_SEARCH.cutoffMaxHz, Math.max(JOINT_SEARCH.cutoffMinHz, Math.round(v)));

function gyroFilterValues(c: GyroChainConfig): Record<string, number> {
    return {
        gyro_lpf1_static_hz: c.lpf1StaticHz,
        gyro_lpf1_dyn_min_hz: c.lpf1DynMinHz,
        gyro_lpf1_dyn_max_hz: c.lpf1DynMaxHz,
        gyro_lpf2_static_hz: c.lpf2StaticHz,
    };
}

/** The gyro chain with every lowpass cutoff scaled (as filterOptimizer's gyro_filter group forms it). */
export function scaledChain(c: GyroChainConfig, s: number): GyroChainConfig {
    return {
        ...c,
        lpf1StaticHz: clampHz(c.lpf1StaticHz * s),
        lpf1DynMinHz: clampHz(c.lpf1DynMinHz * s),
        lpf1DynMaxHz: clampHz(c.lpf1DynMaxHz * s),
        lpf2StaticHz: clampHz(c.lpf2StaticHz * s),
    };
}

function dtermFilterValues(d: DtermDynamicConfig): Record<string, number> {
    return {
        dterm_lpf1_static_hz: d.dtermLpf1StaticHz,
        dterm_lpf1_dyn_min_hz: d.dtermLpf1DynMinHz,
        dterm_lpf1_dyn_max_hz: d.dtermLpf1DynMaxHz,
        dterm_lpf2_static_hz: d.dtermLpf2StaticHz,
    };
}

/** The D path with every lowpass cutoff scaled (as optimizeDterm forms it). */
export function scaledDterm(d: DtermDynamicConfig, s: number): DtermDynamicConfig {
    return {
        ...d,
        dtermLpf1StaticHz: clampHz(d.dtermLpf1StaticHz * s),
        dtermLpf1DynMinHz: clampHz(d.dtermLpf1DynMinHz * s),
        dtermLpf1DynMaxHz: clampHz(d.dtermLpf1DynMaxHz * s),
        dtermLpf2StaticHz: clampHz(d.dtermLpf2StaticHz * s),
    };
}

/** The controller of a candidate: PID values (effective D ratio kept) and the D-LPF cutoffs scaled as autotuneV2 build does. */
export function jointCandidateCfg(
    base: DigitalControllerConfig,
    v: PidValues,
    kdRatio: number,
    dtermScale: number,
): DigitalControllerConfig {
    const cfg = candidateCfg(base, { ...v, d: v.d * kdRatio });
    return {
        ...cfg,
        dtermLpf1Hz: base.dtermLpf1Hz ? base.dtermLpf1Hz * dtermScale : base.dtermLpf1Hz,
        dtermLpf2Hz: base.dtermLpf2Hz ? base.dtermLpf2Hz * dtermScale : base.dtermLpf2Hz,
    };
}

/** The joint PID grid: P, I and D each on 1 ± MAX_STEP at JOINT_SEARCH.pidStep, deduplicated after rounding. */
export function* jointPidGrid(current: PidValues): Generator<PidValues> {
    const scales = scalesOf([1 - MAX_STEP, 1 + MAX_STEP], JOINT_SEARCH.pidStep);
    const iScales = current.i > 0 ? scales : [1];
    const dScales = current.d > 0 ? scales : [1];
    const seen = new Set<string>();
    for (const ps of scales)
        for (const is of iScales)
            for (const ds of dScales) {
                const v = scaledPid(current, ps, is, ds);
                if ([v.p, v.i, v.d].some((x) => x < 0 || x > 250) || v.dMax > 250) continue;
                const key = `${v.p}|${v.i}|${v.d}|${v.dMax}`;
                if (seen.has(key)) continue;
                seen.add(key);
                yield v;
            }
}

/** Band powers of the noise model per (gyro scale, D-LPF scale) and axis: P(g), P(d) and P(g, d). */
interface NoiseBasis {
    pgg: number;
    pdd: number;
    pgd: number;
}

/** Exported for its test. */
export function noiseBasis(
    g: Float64Array,
    d: Float64Array,
    valid: Uint8Array,
    mask: Uint8Array,
    fs: number,
): NoiseBasis | null {
    const n = g.length;
    const sum = new Float64Array(n);
    const diff = new Float64Array(n);
    for (let k = 0; k < n; k++) {
        sum[k] = g[k] + d[k];
        diff[k] = g[k] - d[k];
    }
    const pgg = maskedBandPower(g, valid, mask, fs);
    const pdd = maskedBandPower(d, valid, mask, fs);
    const psum = maskedBandPower(sum, valid, mask, fs);
    const pdiff = maskedBandPower(diff, valid, mask, fs);
    if (pgg === null || pdd === null || psum === null || pdiff === null) return null;
    return { pgg, pdd, pgd: (psum - pdiff) / 4 };
}

/** Controller-output noise power above the band for P gain `kp` (PID units) and D scale `ds` on a basis. */
export const noisePower = (b: NoiseBasis, kp: number, ds: number) =>
    kp * kp * b.pgg + 2 * kp * ds * b.pgd + ds * ds * b.pdd;
export type { NoiseBasis };

const PARAMETER_MODELS: Record<JointParameterEvidence["group"], string> = {
    gyro_filter:
        "gyroUnfilt → lpf2 → RPM → lpf1 → dyn notch → gyroADC; inside the identified plant G = H1(pidSum → gyroADC); a candidate enters as the chain FRF ratio candidate/current simulated on the logged gyroUnfilt (no double count)",
    dterm_filter:
        "gyroADC → Kd·Δ → dterm lpf1 → dterm lpf2 → axisD; inside the controller C_fb, which the plant excludes; a candidate enters through the controller FRF (evaluateControllerFrf) and the D path simulation on the logged gyroADC",
    rpm_filter:
        "per-motor notches at eRPM harmonics inside the gyro chain; centres reconstructed by the firmware replica from the logged eRPM, not logged",
    dynamic_notch:
        "SDFT peak-tracking notches inside the gyro chain; centres reconstructed by the firmware replica, not logged",
    gyro_notch: "static notch inside the gyro chain; not modelled by the chain replica",
    dterm_notch: "static notch inside the D path; not modelled by the D path replica",
};

export function jointSearch(input: JointSearchInput): JointSearchResult {
    const t0 = performance.now();
    const reasons: string[] = [];
    const parameters: JointParameterEvidence[] = [];
    const searched = {
        gyroLpfScales: [...JOINT_SEARCH.gyroLpfScales],
        dtermLpfScales: [...JOINT_SEARCH.dtermLpfScales],
        pidScales: scalesOf([1 - MAX_STEP, 1 + MAX_STEP], JOINT_SEARCH.pidStep),
        screenScales: [...JOINT_SEARCH.screenScales],
        screenPStep: JOINT_SEARCH.screenPStep,
        screenKeep: JOINT_SEARCH.screenKeep,
        maxNoiseRatio: JOINT_SEARCH.maxNoiseRatio,
        minCrossoverKeep: JOINT_SEARCH.minCrossoverKeep,
        minGainOverPidOnly: JOINT_SEARCH.minGainOverPidOnly,
        noiseBandHz: [NOISE_BAND_HZ[0], NOISE_BAND_HZ[1]] as [number, number],
    };
    // Axes the PID-only search could read at all (a plant, a current tune and a search that ran).
    const axes = input.axes.filter((a) => a.decision.searchRan && a.decision.current && a.decision.measurementUsable);
    const chainCfg = input.chainCfg;
    const currentFilters: Record<string, number> = {};
    const result = (status: JointSearchStatus, extra: Partial<JointSearchResult> = {}): JointSearchResult => ({
        status,
        reasons,
        searched,
        parameters,
        current: {
            filters: currentFilters,
            axes: Object.fromEntries(
                axes.map((a) => [
                    a.axis,
                    {
                        pid: a.current,
                        ...(a.decision.current ?? { crossoverHz: null, pmDeg: null, gmDb: null, sDb: null }),
                    },
                ]),
            ),
        },
        pidOnly: {},
        combos: [],
        chosen: null,
        candidatesTried: 0,
        candidatesUsable: 0,
        searchMs: Math.round(performance.now() - t0),
        ...extra,
    });

    // Evidence per filter parameter.
    const gyroMissing: string[] = [];
    if (!chainCfg) gyroMissing.push("chain_headers_missing");
    if (!input.chainInput) gyroMissing.push("gyro_unfilt_not_logged", "required_measurement:log_gyro_unfilt");
    for (const a of axes) {
        if (!a.chainValidated) gyroMissing.push(`chain_model_not_validated_on_this_log:${a.axis}`);
        if (!a.loop.chain) gyroMissing.push(`chain_response_missing:${a.axis}`);
    }
    if (input.chainInput && input.chainInput.erpm.length === 0 && chainCfg && chainCfg.rpmHarmonics > 0)
        gyroMissing.push("erpm_not_logged_rpm_filter_in_force_not_simulated");
    const gyroSearched = axes.length > 0 && !gyroMissing.length;
    if (chainCfg) Object.assign(currentFilters, gyroFilterValues(chainCfg));
    for (const key of GYRO_LPF_KEYS)
        parameters.push({
            key,
            group: "gyro_filter",
            searched: gyroSearched,
            model: PARAMETER_MODELS.gyro_filter,
            missing: [...gyroMissing],
        });

    const dtermAxes = axes.filter((a) => a.dterm && a.dterm.d > 0);
    const dtermMissing: string[] = [];
    if (!dtermAxes.length) dtermMissing.push("no_axis_with_d_term");
    for (const a of dtermAxes) {
        if (!a.dtermValidated) dtermMissing.push(`dterm_model_not_validated_on_this_log:${a.axis}`);
        if (!(a.dterm!.dtermLpf1StaticHz > 0)) dtermMissing.push(`dterm_lpf1_static_zero_not_supported:${a.axis}`);
        if (!a.loop.cfg.dtermLpf1Hz) dtermMissing.push(`dterm_lpf1_not_in_controller:${a.axis}`);
    }
    const dtermSearched = !dtermMissing.length;
    if (dtermAxes[0]?.dterm) Object.assign(currentFilters, dtermFilterValues(dtermAxes[0].dterm));
    for (const key of DTERM_LPF_KEYS)
        parameters.push({
            key,
            group: "dterm_filter",
            searched: dtermSearched,
            model: PARAMETER_MODELS.dterm_filter,
            missing: [...dtermMissing],
        });
    for (const key of ["rpm_filter_harmonics", "rpm_filter_q", "rpm_filter_min_hz"])
        parameters.push({
            key,
            group: "rpm_filter",
            searched: false,
            model: PARAMETER_MODELS.rpm_filter,
            missing: [
                "notch_centres_not_logged",
                "required_measurement:bidirectional_dshot_erpm_logging",
                "single_group_advice_only:optimizeFilters",
            ],
        });
    for (const key of ["dyn_notch_count", "dyn_notch_q"])
        parameters.push({
            key,
            group: "dynamic_notch",
            searched: false,
            model: PARAMETER_MODELS.dynamic_notch,
            missing: [
                "notch_centres_not_logged",
                "required_measurement:fft_freq_debug_flight_for_direct_centre_check",
                "single_group_advice_only:optimizeFilters",
            ],
        });
    parameters.push(
        {
            key: "gyro_notch_hz",
            group: "gyro_notch",
            searched: false,
            model: PARAMETER_MODELS.gyro_notch,
            missing: ["not_modelled"],
        },
        {
            key: "dterm_notch_hz",
            group: "dterm_notch",
            searched: false,
            model: PARAMETER_MODELS.dterm_notch,
            missing: ["not_modelled"],
        },
    );

    if (!axes.length) {
        reasons.push("no_axis_with_a_readable_pid_search");
        return result("not_run");
    }
    if (!gyroSearched && !dtermSearched) {
        reasons.push("no_filter_parameter_supported_by_this_log", ...new Set([...gyroMissing, ...dtermMissing]));
        return result("not_run");
    }
    if (!gyroSearched) reasons.push("gyro_lowpass_not_searched", ...new Set(gyroMissing));
    if (!dtermSearched) reasons.push("dterm_lowpass_not_searched", ...new Set(dtermMissing));

    const gyroScales = gyroSearched ? JOINT_SEARCH.gyroLpfScales : [1];
    const dtermScales = dtermSearched ? JOINT_SEARCH.dtermLpfScales : [1];
    const fs = input.sampleRateHz;

    // Chain simulation and effective FRF per gyro scale (and axis); the current one is the engine's own.
    const sims = new Map<number, { cfg: GyroChainConfig; sim: ChainSimulation }>();
    const simFor = (sg: number) => {
        let s = sims.get(sg);
        if (!s && chainCfg && input.chainInput) {
            const cfg = sg === 1 ? chainCfg : scaledChain(chainCfg, sg);
            const sim = sg === 1 && input.baseSim ? input.baseSim : simulateGyroChain(input.chainInput, cfg);
            s = { cfg, sim };
            sims.set(sg, s);
        }
        return s ?? null;
    };
    const effCache = new Map<string, EffectiveChain | null>();
    const effFor = (sg: number, a: JointAxisInput) => {
        const key = `${sg}|${a.axis}`;
        if (!effCache.has(key)) {
            const s = simFor(sg);
            effCache.set(key, s ? effectiveChainFrf(s.sim, s.cfg, a.loop.axis, a.window[0], a.window[1]) : null);
        }
        return effCache.get(key) ?? null;
    };

    // Noise basis per (gyro scale, D-LPF scale, axis): the candidate chain's gyroADC and the D path on it.
    const basisCache = new Map<string, NoiseBasis | null>();
    const basisFor = (sg: number, sd: number, a: JointAxisInput): NoiseBasis | null => {
        const key = `${sg}|${sd}|${a.axis}`;
        if (basisCache.has(key)) return basisCache.get(key)!;
        let out: NoiseBasis | null = null;
        const s = gyroSearched ? simFor(sg) : null;
        const n = a.gyroAdc.length;
        // The candidate chain's output where simulated, the logged gyroADC elsewhere (and when the chain
        // is not searched); the noise is read only where the chain simulation is valid.
        const g = new Float64Array(n);
        const valid = new Uint8Array(n);
        for (let k = 0; k < n; k++) {
            const simmed = s && s.sim.valid[k] && Number.isFinite(s.sim.out[a.loop.axis][k]);
            g[k] = simmed ? s!.sim.out[a.loop.axis][k] : Number(a.gyroAdc[k]);
            valid[k] = s ? (simmed ? 1 : 0) : 1;
        }
        let d: ArrayLike<number> = new Float64Array(n);
        if (a.dterm && a.dterm.d > 0 && input.chainInput) {
            const cfg = sd === 1 ? a.dterm : scaledDterm(a.dterm, sd);
            const dsim = simulateDterm(
                { timeUs: input.chainInput.timeUs, gyro: g, rcThrottle: input.chainInput.rcThrottle },
                cfg,
            );
            d = dsim.d;
            for (let k = 0; k < n; k++) if (!dsim.valid[k] || !Number.isFinite(d[k])) valid[k] = 0;
        } else if (a.dterm && a.dterm.d > 0) {
            out = null;
            basisCache.set(key, out);
            return out;
        }
        out = noiseBasis(g, Float64Array.from(d), valid, input.flightMask, fs);
        basisCache.set(key, out);
        return out;
    };

    const kpOf = (p: number) => PTERM_SCALE * p;
    const noiseOf = (a: JointAxisInput, v: PidValues, sg: number, sd: number): JointNoise => {
        const band: [number, number] = [NOISE_BAND_HZ[0], NOISE_BAND_HZ[1]];
        const b = basisFor(sg, sd, a);
        const b0 = basisFor(1, 1, a);
        if (!b || !b0) return { ratio: null, gyroTermRatio: null, dtermRatio: null, bandHz: band };
        const ds = a.current.d > 0 ? v.d / a.current.d : 1;
        const kp = kpOf(v.p);
        const kp0 = kpOf(a.current.p);
        const cur = noisePower(b0, kp0, 1);
        const cand = noisePower(b, kp, ds);
        const g0 = kp0 * kp0 * b0.pgg;
        return {
            ratio: cur > 0 ? cand / cur : null,
            gyroTermRatio: g0 > 0 ? (kp * kp * b.pgg) / g0 : null,
            dtermRatio: b0.pdd > 0 ? (ds * ds * b.pdd) / b0.pdd : null,
            bandHz: band,
        };
    };

    const read = (
        a: JointAxisInput,
        v: PidValues,
        sg: number,
        sd: number,
    ): { read: JointCandidateRead; margins: LoopMargins } | null => {
        const kdRatio = a.current.d > 0 ? a.loop.cfg.axis.d / a.current.d : 1;
        const chain = sg === 1 ? undefined : effFor(sg, a);
        if (sg !== 1 && !chain) return null;
        const m = loopMargins(a.loop, {
            cfg: jointCandidateCfg(a.loop.cfg, v, kdRatio, sd),
            ...(chain ? { chain } : {}),
        });
        const val = readableValues(m);
        if (!val) return null;
        const fc0 = a.decision.current?.crossoverHz ?? null;
        return {
            margins: m,
            read: {
                pid: v,
                gyroScale: sg,
                dtermScale: sd,
                ...val,
                meetsTargets: meetsMeasured(val),
                crossoverGain: fc0 && val.crossoverHz ? val.crossoverHz / fc0 : null,
                noise: noiseOf(a, v, sg, sd),
            },
        };
    };

    /** The coarse PID grid of the screen: P at screenPStep, I and D on screenScales (deduplicated, 0–250 guard). */
    function* screenGrid(current: PidValues): Generator<PidValues> {
        const scales = JOINT_SEARCH.screenScales;
        const pScales = scalesOf([1 - MAX_STEP, 1 + MAX_STEP], JOINT_SEARCH.screenPStep);
        const seen = new Set<string>();
        for (const ps of pScales)
            for (const is of current.i > 0 ? scales : [1])
                for (const ds of current.d > 0 ? scales : [1]) {
                    const v = scaledPid(current, ps, is, ds);
                    if ([v.p, v.i, v.d].some((x) => x < 0 || x > 250) || v.dMax > 250) continue;
                    const key = `${v.p}|${v.i}|${v.d}|${v.dMax}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    yield v;
                }
    }

    const eligible = (r: JointCandidateRead) =>
        r.meetsTargets &&
        r.noise.ratio !== null &&
        r.noise.ratio <= JOINT_SEARCH.maxNoiseRatio &&
        r.crossoverGain !== null &&
        r.crossoverGain >= JOINT_SEARCH.minCrossoverKeep;

    // The PID-only best per axis: the grid's offered candidate (decideAxis), read here with its noise.
    const pidOnly: JointSearchResult["pidOnly"] = {};
    for (const a of axes) {
        const c = a.decision.status === "candidate_found" ? a.decision.candidate : null;
        pidOnly[a.axis] = c ? (read(a, c.proposed, 1, 1)?.read ?? null) : null;
    }
    const pidOnlyMeeting = axes.filter((a) => pidOnly[a.axis]?.meetsTargets).length;
    const pidOnlyGains = axes.map((a) => pidOnly[a.axis]?.crossoverGain ?? null).filter((x): x is number => x !== null);
    const pidOnlyMean = pidOnlyGains.length ? pidOnlyGains.reduce((x, y) => x + y, 0) / pidOnlyGains.length : null;

    let tried = 0;
    let usableN = 0;
    const combos: JointCombo[] = [];
    const marginsOf = new Map<string, LoopMargins>();
    // Stage 1: screen every combination on the coarse grid (with the noise model: the bases are cached per combination).
    for (const sg of gyroScales)
        for (const sd of dtermScales) {
            if (sg === 1 && sd === 1) continue;
            const filters: Record<string, number> = {};
            if (gyroSearched && chainCfg) Object.assign(filters, gyroFilterValues(scaledChain(chainCfg, sg)));
            if (dtermSearched && dtermAxes[0]?.dterm)
                Object.assign(filters, dtermFilterValues(scaledDterm(dtermAxes[0].dterm, sd)));
            const comboAxes: JointComboAxis[] = [];
            for (const a of axes) {
                const screen = {
                    tried: 0,
                    usable: 0,
                    meeting: 0,
                    eligible: 0,
                    maxPmDeg: null as number | null,
                    maxCrossoverGain: null as number | null,
                };
                for (const v of screenGrid(a.current)) {
                    screen.tried++;
                    tried++;
                    const r = read(a, v, sg, sd);
                    if (!r) continue;
                    screen.usable++;
                    usableN++;
                    const c = r.read;
                    if (c.meetsTargets) screen.meeting++;
                    if (screen.maxPmDeg === null || c.pmDeg! > screen.maxPmDeg) screen.maxPmDeg = c.pmDeg;
                    if (eligible(c)) {
                        screen.eligible++;
                        if (screen.maxCrossoverGain === null || c.crossoverGain! > screen.maxCrossoverGain)
                            screen.maxCrossoverGain = c.crossoverGain;
                    }
                }
                comboAxes.push({
                    axis: a.axis,
                    tried: 0,
                    usable: 0,
                    excludedForNoise: 0,
                    excludedForBandwidth: 0,
                    best: null,
                    eligible: [],
                    safest: null,
                    screen,
                });
            }
            combos.push({
                gyroScale: sg,
                dtermScale: sd,
                filters,
                axes: comboAxes,
                axesMeeting: 0,
                meanCrossoverGain: null,
                searched: false,
            });
        }
    // The combinations kept: axes with an eligible point on the screen, then the sum of their highest
    // crossover gains, then axes with a meeting point, the sum of the highest PM, the smaller change
    // (deterministic order).
    const screenScore = (c: JointCombo) => [
        c.axes.filter((x) => x.screen.eligible > 0).length,
        c.axes.reduce((acc, x) => acc + (x.screen.maxCrossoverGain ?? 0), 0),
        c.axes.filter((x) => x.screen.meeting > 0).length,
        c.axes.reduce((acc, x) => acc + (x.screen.maxPmDeg ?? -1e9), 0),
        -((c.gyroScale !== 1 ? 1 : 0) + (c.dtermScale !== 1 ? 1 : 0)),
        -(Math.abs(c.gyroScale - 1) + Math.abs(c.dtermScale - 1)),
    ];
    const kept = [...combos]
        .sort((x, y) => {
            const a = screenScore(x);
            const b = screenScore(y);
            for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return b[k] - a[k];
            return 0;
        })
        .slice(0, JOINT_SEARCH.screenKeep);
    // Stage 2: the full grid with the noise model on the kept combinations.
    for (const combo of kept) {
        const { gyroScale: sg, dtermScale: sd } = combo;
        combo.searched = true;
        for (const ca of combo.axes) {
            const a = axes.find((x) => x.axis === ca.axis)!;
            for (const v of jointPidGrid(a.current)) {
                ca.tried++;
                tried++;
                const r = read(a, v, sg, sd);
                if (!r) continue;
                ca.usable++;
                usableN++;
                const c = r.read;
                if (!ca.safest || c.pmDeg! > ca.safest.pmDeg!) ca.safest = c;
                if (!c.meetsTargets) continue;
                if (c.noise.ratio === null || c.noise.ratio > JOINT_SEARCH.maxNoiseRatio) {
                    ca.excludedForNoise++;
                    continue;
                }
                if (c.crossoverGain === null || c.crossoverGain < JOINT_SEARCH.minCrossoverKeep) {
                    ca.excludedForBandwidth++;
                    continue;
                }
                if (!ca.best || c.crossoverHz! > ca.best.crossoverHz!) {
                    ca.best = c;
                    marginsOf.set(`${sg}|${sd}|${a.axis}`, r.margins);
                }
                ca.eligible.push(c);
            }
            ca.eligible.sort((x, y) => y.crossoverHz! - x.crossoverHz!);
            ca.eligible = ca.eligible.slice(0, ELIGIBLE_KEPT);
        }
        combo.axesMeeting = combo.axes.filter((x) => x.best).length;
        const gains = combo.axes.map((x) => x.best?.crossoverGain ?? null).filter((x): x is number => x !== null);
        combo.meanCrossoverGain = gains.length ? gains.reduce((x, y) => x + y, 0) / gains.length : null;
    }

    // Choice over the combinations with a filter change; the PID-only best is the bar to clear. Ties
    // (same axes meeting, same mean crossover gain) go to the smaller change: fewer groups moved, then
    // the smaller scale step, so a filter is never moved for nothing.
    const changeCost = (c: JointCombo) => [
        (c.gyroScale !== 1 ? 1 : 0) + (c.dtermScale !== 1 ? 1 : 0),
        Math.abs(c.gyroScale - 1) + Math.abs(c.dtermScale - 1),
    ];
    const better = (c: JointCombo, b: JointCombo) => {
        if (c.axesMeeting !== b.axesMeeting) return c.axesMeeting > b.axesMeeting;
        const gc = c.meanCrossoverGain ?? 0;
        const gb = b.meanCrossoverGain ?? 0;
        if (Math.abs(gc - gb) > 1e-9) return gc > gb;
        const [nc, dc] = changeCost(c);
        const [nb, db] = changeCost(b);
        return nc !== nb ? nc < nb : dc < db;
    };
    let bestCombo: JointCombo | null = null;
    for (const c of combos) {
        if (!c.axesMeeting) continue;
        if (!bestCombo || better(c, bestCombo)) bestCombo = c;
    }
    const base = { pidOnly, combos, candidatesTried: tried, candidatesUsable: usableN };
    if (!bestCombo) {
        reasons.push(
            pidOnlyMeeting
                ? "no_filter_combination_meets_the_targets_within_rules; the PID-only candidate stands"
                : "no_candidate_meets_all_targets_within_rules_in_any_filter_combination",
        );
        return result(pidOnlyMeeting ? "pid_only_stands" : "no_candidate_meets_targets_within_rules", base);
    }
    let reason: JointChosen["reason"] | null = null;
    if (bestCombo.axesMeeting > pidOnlyMeeting) reason = "more_axes_meet_targets";
    else if (
        bestCombo.axesMeeting === pidOnlyMeeting &&
        pidOnlyMean !== null &&
        bestCombo.meanCrossoverGain !== null &&
        bestCombo.meanCrossoverGain >= pidOnlyMean * JOINT_SEARCH.minGainOverPidOnly
    )
        reason = "higher_crossover_at_equal_axes";
    if (!reason) {
        reasons.push(
            `pid_only_candidate_stands: filters add no axis meeting the targets and no ${JOINT_SEARCH.minGainOverPidOnly}× crossover gain (best combination gyro ×${bestCombo.gyroScale}, D-LPF ×${bestCombo.dtermScale})`,
        );
        return result("pid_only_stands", base);
    }
    const filters: JointChosen["filters"] = {};
    for (const [k, to] of Object.entries(bestCombo.filters)) {
        const from = currentFilters[k];
        if (from !== undefined && from !== to) filters[k] = { from, to };
    }
    const chosenAxes: JointChosen["axes"] = {};
    for (const ca of bestCombo.axes) {
        if (!ca.best) continue;
        const a = axes.find((x) => x.axis === ca.axis)!;
        const m = marginsOf.get(`${bestCombo.gyroScale}|${bestCombo.dtermScale}|${ca.axis}`)!;
        const cur = a.decision.candidate?.currentMargins ?? loopMargins(a.loop);
        const curMeets = a.decision.current ? meetsMeasured(a.decision.current) : false;
        const same =
            ca.best.pid.p === a.current.p &&
            ca.best.pid.i === a.current.i &&
            ca.best.pid.d === a.current.d &&
            ca.best.pid.dMax === a.current.dMax;
        chosenAxes[ca.axis] = {
            read: ca.best,
            proposal: {
                axis: ca.axis,
                current: a.current,
                proposed: ca.best.pid,
                changed: !same,
                currentMargins: cur,
                proposedMargins: m,
                outcome: curMeets ? "improved" : "restores_margins",
                // Never VALIDATED: measured margins, a chain ratio and a noise simulation on logged data.
                status: "BLOCKED",
                reasons: [
                    "joint_pid_filter_search_on_measured_margins",
                    `margin_evidence:${m.evidence?.level ?? "unknown"}`,
                    `filters:gyro_lpf_x${bestCombo.gyroScale}:dterm_lpf_x${bestCombo.dtermScale}`,
                    `predicted_noise_ratio:${ca.best.noise.ratio === null ? "unknown" : ca.best.noise.ratio.toFixed(2)}`,
                    "noise_simulated_on_logged_data",
                    ...(bestCombo.gyroScale !== 1 &&
                    (input.allAxes ?? ["roll", "pitch", "yaw"]).some((x) => !axes.some((a) => a.axis === x))
                        ? [
                              `filter_change_noise_not_assessed_on:${(input.allAxes ?? ["roll", "pitch", "yaw"]).filter((x) => !axes.some((a) => a.axis === x)).join(",")}`,
                          ]
                        : []),
                    "required_measurement:ab_flight_with_proposal",
                    ...m.reasons.map((r) => `margins:${r}`),
                ],
            },
        };
    }
    return result("candidate_found", {
        ...base,
        chosen: {
            gyroScale: bestCombo.gyroScale,
            dtermScale: bestCombo.dtermScale,
            filters,
            axes: chosenAxes,
            reason,
            pidOnly: { axesMeeting: pidOnlyMeeting, meanCrossoverGain: pidOnlyMean },
            noiseNotAssessedAxes:
                bestCombo.gyroScale !== 1
                    ? (input.allAxes ?? ["roll", "pitch", "yaw"]).filter((x) => !axes.some((a) => a.axis === x))
                    : [],
        },
    });
}

/** The targets a read still misses, named (empty: meets all three). */
export function jointOpenTargets(r: { pmDeg: number | null; gmDb: number | null; sDb: number | null }): string[] {
    const out: string[] = [];
    if (r.pmDeg === null || r.pmDeg < PID_TARGETS.minPhaseMarginDeg)
        out.push(`PM ${r.pmDeg === null ? "unknown" : `${r.pmDeg.toFixed(0)}°`} < ${PID_TARGETS.minPhaseMarginDeg}°`);
    if (r.gmDb === null || r.gmDb < PID_TARGETS.minGainMarginDb)
        out.push(`GM ${r.gmDb === null ? "unknown" : `${r.gmDb.toFixed(1)} dB`} < ${PID_TARGETS.minGainMarginDb} dB`);
    if (r.sDb === null || r.sDb > PID_TARGETS.maxSensitivityPeakDb)
        out.push(
            `|S| ${r.sDb === null ? "unknown" : `${r.sDb.toFixed(1)} dB`} > ${PID_TARGETS.maxSensitivityPeakDb} dB`,
        );
    return out;
}
