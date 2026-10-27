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
 * Autotune engine v2: Analyze → Calculate (pure; no MSP, no store).
 *
 * From decoded blackbox channels and the qualified CHIRP transfer functions of one log
 * (plus other logs of the same tune for cross-log checks) it:
 *   1. simulates the notch-aware gyro chain and validates it against the logged gyroADC;
 *   2. runs the M5-B D path and validates it against the logged axisD;
 *   3. identifies the plant per axis (M3) with the controller in force during the sweep;
 *   4. computes current margins, then absolute PID, filter and feedforward proposals;
 *   5. assembles the release evidence and one AbsoluteProposal for Compare / Apply.
 * Margin bounds stay MODEL_CONDITIONAL unless `modelClassQualification` (a finer CHIRP log of
 * another flight with the same craft and configuration) qualifies them (loopModel MarginEvidence).
 * Every part reports VALIDATED / PARTIAL / BLOCKED with its reasons, and every missing
 * measurement as `required_measurement:*`. Nothing here writes to a flight controller.
 */

import type { DigitalControllerConfig } from "@/js/blackbox/betaflight_digital_controller";
import {
    dtermConfigFromHeaders,
    dtermFitAccepted,
    effectiveDtermOverWindow,
    fitDterm,
    simulateDterm,
    withEffectiveDterm,
    type DtermDynamicConfig,
} from "@/js/blackbox/betaflight_dterm_dynamic";
import { assessCrossLogPlantReproducibility } from "@/js/blackbox/betaflight_open_loop";
import type { TransferFunction } from "@/js/blackbox/spectral_analysis";
import { logIdentity } from "@/gyrocore/tuning/fcIdentity";
import {
    axisKeys,
    validatedRegionIssues,
    verifiedTuneIssues,
    type VerifiedTune,
} from "@/gyrocore/releaseGate/verifiedTune";
import { loggedAbsoluteValues } from "@/gyrocore/tuning/absoluteTune";
import type {
    AbsoluteProposal,
    AbsoluteReleaseEvidence,
    AxisMargins,
    PartStatus,
    ProposalItem,
    ProposalPart,
} from "@/gyrocore/releaseGate/releaseContract";
import {
    chainConfigFromHeaders,
    effectiveChainFrf,
    simulateGyroChain,
    type ChainInput,
    type ChainSimulation,
    type GyroChainConfig,
} from "./gyroChain";
import {
    buildAxisLoop,
    loopMargins,
    validateChain,
    type AnalysisProvenance,
    type AxisLoop,
    type ChainValidation,
    type FrequencySupport,
    type LoopMargins,
    type ResolutionConvergence,
    type SweepInfo,
} from "./loopModel";
import { chooseAnalysis, resolutionConvergence, type AnalysisOption } from "./adaptiveResolution";
import { optimizeAxisPid, type AxisPidProposal, type PidValues } from "./pidOptimizer";
import { optimizeFilters, type FilterGroupResult } from "./filterOptimizer";
import { optimizeFeedforward, type FeedforwardProposal } from "./feedforwardOptimizer";
import { absoluteSafetyEvidence, type AxisName } from "./safetyEvidence";
import { planMeasurement, type AxisMeasurementPlan } from "./measurementPlan";
import { crossLogReferenceIssues, sameFlight } from "./logInput";

export const AXES: readonly AxisName[] = ["roll", "pitch", "yaw"];
/** rcCommand[3] below this: on the ground / idle; the PID terms are not representative. */
export const FLIGHT_THROTTLE = 1150;

export interface ChirpAxisInput {
    tf: TransferFunction;
    /** Sample index range of the sweep in the channel arrays. */
    start: number;
    end: number;
    /** chirp/qualification.ts measurement state; "rejected" axes are diagnostics only. */
    state: string;
    /** The qualification's measurement:* reasons (why it was rejected or warned). */
    qualificationReasons?: string[];
    /** Where `tf`'s resolution comes from: Welch segment, sample rate, window and segment count. */
    analysis?: AnalysisProvenance;
    /**
     * Per-bin frequency support of `tf` (loopModel FREQUENCY_SUPPORT: observed generator range,
     * input power, γ²(excitation → setpoint)); absent: unknown, and the margins stay MEASURED.
     */
    support?: FrequencySupport;
    /**
     * The same window analysed with the longest Welch segment that still gives
     * UNCERTAINTY.minWelchSegments segments (logInput.ts finestWelchSegment): the finer
     * identification a model-class qualification can use (modelQualification.ts). Never `tf`.
     */
    fine?: { tf: TransferFunction; analysis: AnalysisProvenance; support?: FrequencySupport };
    /**
     * The resolution ladder of this window (logInput.ts): the same samples analysed from the standard
     * Welch segment (first rung, `tf`) up to the finest that still averages enough, ascending. The
     * engine reads the margins on the rung the crossover needs and checks it against the next one
     * (adaptiveResolution.ts). Absent: the standard analysis, with its convergence unknown.
     */
    analyses?: AnalysisOption[];
}

export interface AutotuneLogInput {
    sha256: string;
    logIndex: number;
    headerPairs: readonly (readonly [string, string])[];
    sampleRateHz: number;
    channels: {
        timeUs: ArrayLike<number>;
        gyroAdc: [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>];
        gyroUnfilt: [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>] | null;
        erpm: ArrayLike<number>[];
        rcThrottle: ArrayLike<number>;
        axisD: [ArrayLike<number> | null, ArrayLike<number> | null, ArrayLike<number> | null] | null;
        motors: ArrayLike<number>[] | null;
    };
    chirp: Partial<Record<AxisName, ChirpAxisInput>>;
    /** M4 stick analysis (acro, CHIRP-free). */
    stick: { acroSeconds: number; latencyMs: Partial<Record<AxisName, number | null>> };
    /** M4 noise floor known on every axis. */
    noiseFloorKnown: boolean;
    /** Import order (higher = imported later). The blackbox header carries no usable date. */
    order?: number;
    /**
     * Recording-session evidence (logInput.ts flightRelation): the first decoded loopIteration (0:
     * the log holds its session's first frame, as the firmware starts every log; > 0 or null: an
     * export from inside a session, or unknown) and the header's `Log start datetime` (null without
     * an RTC). Absent: independence from other logs is unproven.
     */
    session?: { firstIteration: number | null; startDatetime: string | null };
    /**
     * Set by uniqueFlights on the file kept for a flight carried by several files: the identity of
     * every one of them (this file included), so a later comparison still sees the files dropped
     * as copies, and the fragments that linked them.
     */
    flightGroup?: readonly FlightFragment[];
}

/**
 * What identifies one file's flight (logInput.ts flightRelation): file, sample fingerprint, gyro
 * windows, and the evidence of the recording session it comes from.
 */
export interface FlightFragment {
    sha256: string;
    logIndex: number;
    fingerprint: string;
    windows: ReadonlySet<string>;
    session?: AutotuneLogInput["session"];
    /** Logged time of the first sample (µs since the flight controller booted). */
    firstTimeUs?: number | null;
}

export interface AutotuneV2Input {
    primary: AutotuneLogInput;
    /** Further logs flown with the same tune (cross-log plant reproducibility). */
    others: AutotuneLogInput[];
    verifiedTune: VerifiedTune | null;
    /**
     * A CHIRP log of another flight with this craft, firmware and configuration, identified at a
     * finer frequency resolution: qualifies the model class of the margin bounds
     * (loopModel MODEL_CLASS_QUALIFICATION). Absent or null: the bounds stay MODEL_CONDITIONAL.
     */
    modelClassQualification?: AutotuneLogInput | null;
    createdAt?: string;
}

export type ReportStatus = "IMPLEMENTED" | "VALIDATED" | "PARTIAL" | "BLOCKED";

export interface PartReport {
    part:
        | "absolute_pid"
        | "feedforward"
        | "gyro_filter"
        | "dterm_filter"
        | "rpm_filter"
        | "dynamic_notch"
        | "plant_identification"
        | "phase_margin_robustness"
        | "independent_gain_prediction";
    status: Exclude<ReportStatus, "IMPLEMENTED">;
    reasons: string[];
    requiredMeasurements: string[];
}

export interface AutotuneV2Result {
    chain: { config: GyroChainConfig | null; validation: ChainValidation[]; notes: string[] };
    dterm: { axis: AxisName; accepted: boolean; nrmse: number | null }[];
    margins: Partial<Record<AxisName, { current: LoopMargins; proposed: LoopMargins }>>;
    pid: AxisPidProposal[];
    filters: FilterGroupResult[];
    feedforward: FeedforwardProposal[];
    crossLogPlant: Partial<Record<AxisName, { status: string; meanAbsGRel: number; n: number }>>;
    /** Why other logs were not used as independent repeats (duplicate flight, other craft / firmware / config). */
    crossLogRejected: string[];
    safety: { analysisEvidence: string; reasons: string[] };
    parts: PartReport[];
    /** Every recommended change, with its status: what Compare shows. */
    proposal: AbsoluteProposal | null;
    /** The VALIDATED items only, with their own margins and evidence: the only thing Apply may write. */
    releasableProposal: AbsoluteProposal | null;
    /** What the next CHIRP flight must measure per axis (measurementPlan.ts; informative only). */
    measurementPlan: AxisMeasurementPlan[];
}

function headerMap(pairs: readonly (readonly [string, string])[]): Record<string, string> {
    return Object.fromEntries(pairs.map(([k, v]) => [k, v]));
}

function nums(h: Record<string, string>, key: string): number[] | null {
    const raw = h[key];
    if (raw === undefined) return null;
    const v = raw.split(",").map((x) => Number(x.trim()));
    return v.every(Number.isFinite) ? v : null;
}

/** M1 controller config from the log header for one axis (absolute values as logged). */
export function controllerConfigFromHeaders(
    h: Record<string, string>,
    axis: 0 | 1 | 2,
): DigitalControllerConfig | null {
    const looptime = nums(h, "looptime")?.[0];
    const denom = nums(h, "pid_process_denom")?.[0];
    const pid = nums(h, `${AXES[axis]}PID`);
    if (!looptime || !denom || !pid || pid.length < 3) return null;
    const ff = nums(h, "ff_weight") ?? [0, 0, 0];
    return {
        gyroDt: looptime * 1e-6,
        pidDt: looptime * denom * 1e-6,
        axis: { p: pid[0], i: pid[1], d: pid[2], f: ff[axis] ?? 0 },
        yawKiBoost: axis === 2,
        yawLowpassHz: axis === 2 ? (nums(h, "yaw_lowpass_hz")?.[0] ?? 0) : undefined,
        gyroLpf1Hz: nums(h, "gyro_lpf1_static_hz")?.[0],
        gyroLpf2Hz: nums(h, "gyro_lpf2_static_hz")?.[0],
        dtermLpf1Hz: pid[2] > 0 ? nums(h, "dterm_lpf1_static_hz")?.[0] : undefined,
        dtermLpf2Hz: pid[2] > 0 ? nums(h, "dterm_lpf2_static_hz")?.[0] : undefined,
        chirpLagHz: nums(h, "chirp_lag_freq_hz")?.[0],
        chirpLeadHz: nums(h, "chirp_lead_freq_hz")?.[0],
    };
}

/**
 * The CHIRP sweep the log's headers describe (Betaflight chirp.c: exponential from
 * chirp_frequency_start to _end over chirp_time_seconds), or null when any is missing.
 */
export function sweepFromHeaders(h: Record<string, string>): SweepInfo | null {
    const f0 = nums(h, "chirp_frequency_start_deci_hz")?.[0];
    const f1 = nums(h, "chirp_frequency_end_deci_hz")?.[0];
    const t = nums(h, "chirp_time_seconds")?.[0];
    return f0 && f1 && t && f1 > f0 && f0 > 0 && t > 0 ? { f0Hz: f0 / 10, f1Hz: f1 / 10, durationS: t } : null;
}

export function flightMask(rc: ArrayLike<number>): Uint8Array {
    return Uint8Array.from({ length: rc.length }, (_, k) => (rc[k] >= FLIGHT_THROTTLE ? 1 : 0));
}

function motorSaturation(
    motors: ArrayLike<number>[] | null,
    mask: Uint8Array,
    h: Record<string, string>,
): number | null {
    if (!motors?.length) return null;
    const max = nums(h, "maxthrottle")?.[0] ?? 2000;
    let n = 0;
    let sat = 0;
    for (let k = 0; k < mask.length; k++) {
        if (!mask[k]) continue;
        n++;
        if (motors.some((m) => m[k] >= max - 1)) sat++;
    }
    return n ? sat / n : null;
}

interface AxisAnalysis {
    loop: AxisLoop;
    dterm: DtermDynamicConfig | null;
    dtermAccepted: boolean;
    window: [number, number];
    /** The analysis the loop is read on (the adaptive rung; adaptiveResolution.ts). */
    analysis: AnalysisProvenance | null;
}

/** D path (M5-B) and controller-in-force for one axis of one log. */
export function analyzeAxisController(
    log: AutotuneLogInput,
    h: Record<string, string>,
    axis: 0 | 1 | 2,
    chirp: ChirpAxisInput,
    mask: Uint8Array,
): { cfg: DigitalControllerConfig; dterm: DtermDynamicConfig | null; accepted: boolean; nrmse: number | null } | null {
    const base = controllerConfigFromHeaders(h, axis);
    if (!base) return null;
    let cfg = base;
    const dterm = base.axis.d > 0 ? dtermConfigFromHeaders(h, axis, base.pidDt) : null;
    let accepted = false;
    let nrmse: number | null = null;
    const loggedD = log.channels.axisD?.[axis] ?? null;
    if (dterm) {
        const input = {
            timeUs: log.channels.timeUs,
            gyro: log.channels.gyroAdc[axis],
            rcThrottle: log.channels.rcThrottle,
        };
        const sim = simulateDterm(input, dterm, { kind: "dynamic" });
        const stat = simulateDterm(input, dterm, { kind: "fixed", hz: dterm.dtermLpf1StaticHz });
        for (const s of [sim, stat]) for (let k = 0; k < s.valid.length; k++) if (!mask[k]) s.valid[k] = 0;
        if (loggedD) {
            const fit = fitDterm(sim, loggedD, log.sampleRateHz);
            nrmse = fit?.nrmse ?? null;
            accepted = dtermFitAccepted(fit, fitDterm(stat, loggedD, log.sampleRateHz));
        }
        const eff = effectiveDtermOverWindow(sim, chirp.start, chirp.end);
        if (eff) cfg = withEffectiveDterm(cfg, eff);
    }
    return { cfg, dterm, accepted, nrmse };
}

function statusOf(items: { status: PartStatus }[]): Exclude<ReportStatus, "IMPLEMENTED"> {
    if (!items.length) return "BLOCKED";
    if (items.some((i) => i.status === "BLOCKED")) return "BLOCKED";
    if (items.some((i) => i.status === "PARTIAL")) return "PARTIAL";
    return "VALIDATED";
}

const required = (reasons: string[]) => [
    ...new Set(
        reasons
            .filter((r) => r.includes("required_measurement:"))
            .map((r) => r.slice(r.indexOf("required_measurement:"))),
    ),
];

function proposalHash(text: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(16).padStart(8, "0");
}

export function runAutotuneV2(input: AutotuneV2Input): AutotuneV2Result {
    const log = input.primary;
    const h = headerMap(log.headerPairs);
    const mask = flightMask(log.channels.rcThrottle);
    const id = logIdentity(log.headerPairs);
    const firmware = id.firmwareRevision?.split(/\s+/)[1] ?? null;
    // A Verified Tune attests only for the configuration it was measured from: its baseline must
    // be exactly this log's logged configuration (a new starting point needs its own flight).
    const recordIssues = input.verifiedTune ? verifiedTuneIssues(input.verifiedTune, { uid: id.uid, firmware }) : [];
    const baselineIssues =
        input.verifiedTune && !recordIssues.length
            ? validatedRegionIssues(input.verifiedTune, loggedAbsoluteValues(log.headerPairs), {})
            : [];
    const attested = !!input.verifiedTune && !recordIssues.length && !baselineIssues.length;

    // 1. Gyro chain.
    const chainCfg = chainConfigFromHeaders(h);
    const chainNotes: string[] = [];
    let sim: ChainSimulation | null = null;
    let chainInput: ChainInput | null = null;
    const validation: ChainValidation[] = [];
    if (!chainCfg) chainNotes.push("chain_headers_missing");
    if (!log.channels.gyroUnfilt) chainNotes.push("gyro_unfilt_not_logged", "required_measurement:log_gyro_unfilt");
    if (chainCfg && log.channels.gyroUnfilt) {
        chainInput = {
            timeUs: log.channels.timeUs,
            gyroUnfilt: log.channels.gyroUnfilt,
            erpm: log.channels.erpm,
            rcThrottle: log.channels.rcThrottle,
        };
        sim = simulateGyroChain(chainInput, chainCfg);
        chainNotes.push(...sim.notes);
        const notchesOn = chainCfg.rpmHarmonics > 0 || chainCfg.dynNotchCount > 0;
        const ablation = notchesOn
            ? simulateGyroChain(chainInput, { ...chainCfg, rpmHarmonics: 0, dynNotchCount: 0 })
            : null;
        for (const a of [0, 1, 2])
            validation.push(validateChain(a, sim, ablation, log.channels.gyroAdc[a], log.sampleRateHz, mask));
    }
    const chainOk = (a: number) => validation[a]?.controlBand === "PASS";

    // The model-class qualification counts only from an independent flight of this craft, firmware
    // and configuration (the same identity rules as a cross-log reference).
    const qLog = input.modelClassQualification ?? null;
    const qualificationRejected = qLog
        ? crossLogReferenceIssues(log, qLog, input.others).map((r) => `model_class_qualification_rejected:${r}`)
        : [];
    const qualificationAxisRejected: string[] = [];
    const qualificationFor = (name: AxisName, ai: 0 | 1 | 2) => {
        const qc = qLog && !qualificationRejected.length ? qLog.chirp[name] : undefined;
        if (!qLog || !qc || qc.state !== "usable") return null;
        const qh = headerMap(qLog.headerPairs);
        const qctl = analyzeAxisController(qLog, qh, ai, qc, flightMask(qLog.channels.rcThrottle));
        // Its plant rests on the controller reconstructed for that flight: with D > 0, only when the
        // D path was reconstructed and the logged D term validated it (as the primary's model
        // quality requires); missing D headers leave no D path, which is not a validated one.
        if (qctl && qctl.cfg.axis.d > 0 && !(qctl.dterm && qctl.accepted)) {
            qualificationAxisRejected.push(`model_class_qualification_rejected:dterm_path_not_validated:${name}`);
            return null;
        }
        return qctl
            ? {
                  tf: qc.tf,
                  cfg: qctl.cfg,
                  source: { sha256: qLog.sha256, logIndex: qLog.logIndex },
                  sweep: sweepFromHeaders(qh),
                  // The window the analysis claims must lie in the qualification's own samples.
                  analysis: qc.analysis && qc.analysis.windowSamples <= qc.end - qc.start ? qc.analysis : null,
                  support: qc.support ?? null,
              }
            : null;
    };

    // 2-3. Controller in force, D path, plant per axis with a CHIRP measurement.
    const axes: Partial<Record<AxisName, AxisAnalysis>> = {};
    const dtermReport: AutotuneV2Result["dterm"] = [];
    AXES.forEach((name, ai) => {
        const axis = ai as 0 | 1 | 2;
        const c = log.chirp[name];
        if (!c) return;
        const ctl = analyzeAxisController(log, h, axis, c, mask);
        if (!ctl) return;
        if (ctl.dterm) dtermReport.push({ axis: name, accepted: ctl.accepted, nrmse: ctl.nrmse });
        const eff = sim && chainCfg ? effectiveChainFrf(sim, chainCfg, axis, c.start, c.end) : null;
        // Adaptive resolution (adaptiveResolution.ts, H1): from the standard analysis's crossover, the
        // rung of the ladder whose bin spacing suits it, checked against the next finer rung of the
        // same samples. Without a ladder the standard analysis is used and its convergence is unknown.
        const sweep = sweepFromHeaders(h);
        const ladder: AnalysisOption[] | null = c.analyses?.length
            ? c.analyses
            : c.analysis
              ? [{ tf: c.tf, analysis: c.analysis, ...(c.support ? { support: c.support } : {}) }]
              : null;
        const probe = (r: AnalysisOption) => {
            const loop = buildAxisLoop(axis, r.tf, ctl.cfg, eff, chainOk(axis), attested, null, {
                sweep,
                analysis: r.analysis,
                support: r.support ?? null,
            });
            return { loop, margins: loopMargins(loop) };
        };
        let chosen = { tf: c.tf, analysis: c.analysis ?? null, support: c.support ?? null };
        let resolution: ResolutionConvergence | null = null;
        if (ladder) {
            const pick = chooseAnalysis(ladder, probe(ladder[0]).margins.crossoverHz);
            const r = ladder[pick.index];
            chosen = { tf: r.tf, analysis: r.analysis, support: r.support ?? null };
            resolution = resolutionConvergence(ladder, pick.index, probe, pick.reasons);
        }
        axes[name] = {
            loop: buildAxisLoop(axis, chosen.tf, ctl.cfg, eff, chainOk(axis), attested, qualificationFor(name, axis), {
                sweep,
                analysis: chosen.analysis,
                support: chosen.support,
                resolution,
            }),
            dterm: ctl.dterm,
            dtermAccepted: ctl.accepted,
            window: [c.start, c.end],
            analysis: chosen.analysis,
        };
    });

    // 4a. PID per axis.
    const dmax = nums(h, "d_max") ?? [0, 0, 0];
    const pid: AxisPidProposal[] = [];
    AXES.forEach((name, ai) => {
        const ax = axes[name];
        const p = nums(h, `${name}PID`);
        if (!ax || !p) return;
        const current: PidValues = { p: p[0], i: p[1], d: p[2], dMax: dmax[ai] ?? 0 };
        const chirp = log.chirp[name]!;
        if (chirp.state === "rejected") {
            // Diagnostics only: margins on the coherent bins, never a proposal.
            const m = loopMargins(ax.loop);
            // Audit B2, diagnostic only: the quality gate judges a fixed band (5–100 Hz mean coherence);
            // when the decision band around this loop's crossover is fully kept and supported, say so
            // next to the rejection. The rejection stands: a gate changes only with H1–H8 evidence.
            const band = m.evidence.decisionBand;
            const supportDefect = m.reasons.some((r) =>
                /^(unidentified_bins_inside_band|crossover_band_unsupported|crossover_neighbour_bins_missing|frequency_support_unknown|sweep_generator_stopped_early)/.test(
                    r,
                ),
            );
            const decisionBandNote =
                band && band.keptBins === band.gridBins && !supportDefect
                    ? [
                          `fixed_band_gate_rejected_while_decision_band_supported:${band.fromHz.toFixed(1)}-${band.toHz.toFixed(1)}Hz:min_coherence:${band.minCoherence.toFixed(2)}`,
                      ]
                    : [];
            pid.push({
                axis: name,
                current,
                proposed: current,
                changed: false,
                currentMargins: m,
                proposedMargins: m,
                outcome: "not_computable",
                status: "BLOCKED",
                reasons: [
                    "chirp_measurement_rejected",
                    ...(chirp.qualificationReasons ?? []),
                    ...decisionBandNote,
                    `required_measurement:chirp_${name}_meeting_qualification`,
                ],
            });
            return;
        }
        // With a Verified Tune, stay on the segment it confirmed (the contract refuses anything else).
        const vt = input.verifiedTune;
        pid.push(
            optimizeAxisPid(
                ax.loop,
                current,
                attested && vt ? { keys: axisKeys(name), base: vt.baseline.values, cand: vt.candidate.values } : null,
            ),
        );
    });

    // 4b. Filters (needs the chain simulation).
    let filters: FilterGroupResult[] = [];
    const analysed = AXES.filter((a) => axes[a]);
    if (sim && chainCfg && chainInput && analysed.length) {
        const out = optimizeFilters({
            input: chainInput,
            cfg: chainCfg,
            sampleRateHz: log.sampleRateHz,
            flightMask: mask,
            axes: analysed.map((a) => ({
                loop: axes[a]!.loop,
                window: axes[a]!.window,
                dterm: axes[a]!.dterm,
                qualified: log.chirp[a]!.state !== "rejected",
            })),
            gyroAdc: log.channels.gyroAdc,
            chainValidated: analysed.every((a) => chainOk(AXES.indexOf(a))),
            dtermValidated: analysed.filter((a) => axes[a]!.dterm).every((a) => axes[a]!.dtermAccepted),
        });
        filters = out.groups;
    }

    // 4c. Feedforward per axis.
    const ff = nums(h, "ff_weight") ?? [0, 0, 0];
    const ffCut = nums(h, "rc_smoothing_active_cutoffs_ff_sp_thr")?.[0] ?? null;
    const feedforward = AXES.map((name, ai) =>
        optimizeFeedforward(ai as 0 | 1 | 2, {
            loop: axes[name]?.loop ?? null,
            currentF: ff[ai] ?? 0,
            acroStickSeconds: log.stick.acroSeconds,
            measuredLatencyMs: log.stick.latencyMs[name] ?? null,
            rcFeedforwardCutoffHz: ffCut,
        }),
    );

    // Cross-log plant reproducibility: only an independent flight of this craft, firmware and
    // configuration counts (never the primary itself, under any file name or hash, nor a fragment
    // of the primary's flight linked to it through another fragment among the inputs).
    const crossLogPlant: AutotuneV2Result["crossLogPlant"] = {};
    const crossLogRejected: string[] = [];
    const references = input.others.filter((other) => {
        // One flight is one piece of evidence: the model-class qualification's flight is not also
        // the plant's reproducibility reference.
        if (qLog && (other === qLog || sameFlight(other, qLog))) {
            crossLogRejected.push(`cross_log_reference_is_the_qualification:${other.sha256}:${other.logIndex}`);
            return false;
        }
        const issues = crossLogReferenceIssues(log, other, input.others);
        crossLogRejected.push(...issues);
        return !issues.length;
    });
    for (const name of analysed) {
        const ai = AXES.indexOf(name) as 0 | 1 | 2;
        // Every qualified reference counts: one that disagrees is not outvoted by one that agrees.
        const results: { status: string; meanAbsGRel: number; n: number }[] = [];
        for (const other of references) {
            const oc = other.chirp[name];
            const oh = headerMap(other.headerPairs);
            if (!oc) continue;
            // A reference measurement the qualification did not pass in full is no evidence for the
            // plant (audit P1-5): a rejected sweep, or one with warnings, never validates it.
            if (oc.state !== "usable") {
                crossLogRejected.push(
                    `cross_log_reference_not_qualified:${oc.state}:${other.sha256}:${other.logIndex}`,
                );
                continue;
            }
            const ctl = analyzeAxisController(other, oh, ai, oc, flightMask(other.channels.rcThrottle));
            if (!ctl) continue;
            const otherLoop = buildAxisLoop(ai, oc.tf, ctl.cfg, null, false, false);
            const cmp = assessCrossLogPlantReproducibility(axes[name]!.loop.plant, otherLoop.plant);
            // Two independent flights never identify the same plant to the last bit: an exact
            // match is the same measurement again (a copy the window identity did not catch).
            if (cmp.n > 0 && cmp.meanAbsGRel === 0) {
                crossLogRejected.push(`cross_log_identical_measurement:${other.sha256}:${other.logIndex}`);
                continue;
            }
            results.push(cmp);
        }
        if (!results.length) continue;
        // The worst reference decides; references that disagree with each other block (FAIL).
        const worst = [...results].sort((a, b) => b.meanAbsGRel - a.meanAbsGRel)[0];
        const statuses = new Set(results.map((r) => r.status));
        if (statuses.size > 1) crossLogRejected.push(`cross_log_references_disagree:${name}`);
        crossLogPlant[name] = {
            status: statuses.size > 1 ? "FAIL" : worst.status,
            meanAbsGRel: worst.meanAbsGRel,
            n: worst.n,
        };
    }

    // 5. Proposed tune as a whole: margins, items, evidence.
    const items: ProposalItem[] = [];
    const add = (key: string, part: ProposalPart, from: number, to: number, status: PartStatus, reasons: string[]) => {
        if (from !== to) items.push({ key, part, from, to, status, reasons });
    };
    for (const p of pid) {
        if (!p.changed) continue;
        add(`p_${p.axis}`, "pid", p.current.p, p.proposed.p, p.status, p.reasons);
        add(`i_${p.axis}`, "pid", p.current.i, p.proposed.i, p.status, p.reasons);
        add(`d_${p.axis}`, "pid", p.current.d, p.proposed.d, p.status, p.reasons);
        add(`d_max_${p.axis}`, "pid", p.current.dMax, p.proposed.dMax, p.status, p.reasons);
    }
    for (const g of filters) {
        if (!g.changed) continue;
        for (const [k, v] of Object.entries(g.proposed)) add(k, g.group, g.current[k], v, g.status, g.reasons);
    }
    for (const f of feedforward)
        if (f.changed) add(`f_${f.axis}`, "feedforward", f.current, f.proposed, f.status, f.reasons);

    const coherenceAt = (name: AxisName, fc: number | null) => {
        const bins = axes[name]?.loop.plant.bins;
        if (!fc || !bins) return null;
        const near = bins
            .filter((b) => b.status === "ok")
            .sort((a, b) => Math.abs(a.frequencyHz - fc) - Math.abs(b.frequencyHz - fc))[0];
        return near?.coherence ?? null;
    };
    const motorSat = motorSaturation(log.channels.motors, mask, h);

    /** Margins, Safety evidence and the AbsoluteProposal for a selection of items. */
    const build = (selected: ProposalItem[]) => {
        const change = Object.fromEntries(selected.map((it) => [it.key, it.to]));
        const value = (key: string, fallback: number) => (key in change ? change[key] : fallback);
        let candChain: GyroChainConfig | null = null;
        if (chainCfg) {
            candChain = {
                ...chainCfg,
                rpmHarmonics: value("rpm_filter_harmonics", chainCfg.rpmHarmonics),
                rpmQ: value("rpm_filter_q", chainCfg.rpmQ),
                rpmMinHz: value("rpm_filter_min_hz", chainCfg.rpmMinHz),
                dynNotchCount: value("dyn_notch_count", chainCfg.dynNotchCount),
                dynNotchQ: value("dyn_notch_q", chainCfg.dynNotchQ),
                lpf1StaticHz: value("gyro_lpf1_static_hz", chainCfg.lpf1StaticHz),
                lpf1DynMinHz: value("gyro_lpf1_dyn_min_hz", chainCfg.lpf1DynMinHz),
                lpf1DynMaxHz: value("gyro_lpf1_dyn_max_hz", chainCfg.lpf1DynMaxHz),
                lpf2StaticHz: value("gyro_lpf2_static_hz", chainCfg.lpf2StaticHz),
            };
        }
        const candSim =
            candChain && chainInput && JSON.stringify(candChain) !== JSON.stringify(chainCfg)
                ? simulateGyroChain(chainInput, candChain)
                : null;
        const dtermStatic = nums(h, "dterm_lpf1_static_hz")?.[0] ?? 0;
        const dScale = "dterm_lpf1_static_hz" in change && dtermStatic ? change.dterm_lpf1_static_hz / dtermStatic : 1;
        const margins: AutotuneV2Result["margins"] = {};
        const releaseMargins: AxisMargins[] = [];
        for (const name of analysed) {
            const ax = axes[name]!;
            const pp = pid.find((x) => x.axis === name);
            const cur = pp?.current ?? { p: ax.loop.cfg.axis.p, i: ax.loop.cfg.axis.i, d: ax.loop.cfg.axis.d, dMax: 0 };
            const kdRatio = cur.d > 0 ? ax.loop.cfg.axis.d / cur.d : 1;
            const cfg: DigitalControllerConfig = {
                ...ax.loop.cfg,
                axis: {
                    ...ax.loop.cfg.axis,
                    p: value(`p_${name}`, cur.p),
                    i: value(`i_${name}`, cur.i),
                    d: value(`d_${name}`, cur.d) * kdRatio,
                },
                dtermLpf1Hz: ax.loop.cfg.dtermLpf1Hz ? ax.loop.cfg.dtermLpf1Hz * dScale : ax.loop.cfg.dtermLpf1Hz,
                dtermLpf2Hz: ax.loop.cfg.dtermLpf2Hz ? ax.loop.cfg.dtermLpf2Hz * dScale : ax.loop.cfg.dtermLpf2Hz,
            };
            const chain =
                candSim && candChain
                    ? effectiveChainFrf(candSim, candChain, ax.loop.axis, ax.window[0], ax.window[1])
                    : null;
            const proposed = loopMargins(ax.loop, { cfg, chain });
            margins[name] = { current: loopMargins(ax.loop), proposed };
            releaseMargins.push({
                axis: name,
                status: proposed.status,
                phaseMarginDeg: proposed.phaseMarginDeg,
                gainMarginDb: proposed.gainMarginDb,
                sensitivityPeakDb: proposed.sensitivityPeakDb,
                measured: proposed.measured,
                evidence: proposed.evidence,
                reasons: proposed.reasons,
            });
        }
        const touchedAxes = AXES.filter((a) => Object.keys(change).some((k) => k.endsWith(`_${a}`)));
        const scope = Object.keys(change).some((k) => !/_(roll|pitch|yaw)$/.test(k)) ? analysed : touchedAxes;
        const safety = absoluteSafetyEvidence(
            {
                measurementState: Object.fromEntries(AXES.map((a) => [a, log.chirp[a]?.state ?? null])),
                coherenceAtCrossover: Object.fromEntries(
                    AXES.map((a) => [a, coherenceAt(a, margins[a]?.proposed.crossoverHz ?? null)]),
                ),
                chainValidated: Object.fromEntries(AXES.map((a, i) => [a, chainOk(i)])),
                dtermValidated: Object.fromEntries(AXES.map((a) => [a, axes[a]?.dtermAccepted ?? false])),
                crossLogPlant: Object.fromEntries(AXES.map((a) => [a, crossLogPlant[a]?.status ?? null])),
                motorSaturationFraction: motorSat,
                noiseFloorKnown: log.noiseFloorKnown,
            },
            scope.length ? scope : analysed,
            Object.keys(change).some((k) => k.startsWith("dterm_") || /^d_(roll|pitch)$/.test(k)),
        );
        const measurementReasons = scope.flatMap((a) =>
            log.chirp[a]?.state === "usable" ? [] : [`chirp_${log.chirp[a]?.state ?? "missing"}:${a}`],
        );
        const modelReasons = [
            ...scope.flatMap((a) => (chainOk(AXES.indexOf(a)) ? [] : [`gyro_chain_not_validated:${a}`])),
            ...scope.flatMap((a) =>
                axes[a]?.dterm && !axes[a]!.dtermAccepted ? [`dterm_path_not_validated:${a}`] : [],
            ),
            ...scope.flatMap((a) =>
                crossLogPlant[a]?.status === "PASS"
                    ? []
                    : [`cross_log_plant_${(crossLogPlant[a]?.status ?? "untested").toLowerCase()}:${a}`],
            ),
        ];
        const release: AbsoluteReleaseEvidence = {
            measurement: { valid: measurementReasons.length === 0 && scope.length > 0, reasons: measurementReasons },
            model: { status: modelReasons.length ? "PARTIAL" : "VALIDATED", reasons: modelReasons },
            margins: releaseMargins,
            independentValidation: attested ? input.verifiedTune : null,
            safetyAnalysisEvidence: safety.analysisEvidence,
            safetyReasons: safety.reasons,
        };
        const proposal: AbsoluteProposal | null = selected.length
            ? {
                  id: `v2-${proposalHash(`${log.sha256}|${log.logIndex}|${JSON.stringify(change)}`)}`,
                  createdAt: input.createdAt ?? new Date().toISOString(),
                  log: { sha256: log.sha256, logIndex: log.logIndex, headerPairs: log.headerPairs },
                  change,
                  items: selected,
                  release,
              }
            : null;
        return { margins, safety, proposal };
    };
    const full = build(items);
    // Only values that are themselves VALIDATED can ever be written (release contract: items_validated).
    const validatedItems = items.filter((it) => it.status === "VALIDATED");
    const releasable = validatedItems.length ? build(validatedItems).proposal : null;
    const { margins, safety, proposal } = full;
    // Informative: the band, resolution and averages the next flight needs for this craft's own loop.
    const measurementPlan = analysed.map((name) =>
        planMeasurement(
            name,
            axes[name]!.loop,
            margins[name]!.current,
            log.sampleRateHz,
            sweepFromHeaders(h),
            // The analysis the margins were read on: the plan's durations are consistent with it.
            axes[name]!.analysis,
        ),
    );

    // Part summary for the interface and the report.
    const part = (p: PartReport["part"], status: PartReport["status"], reasons: string[]): PartReport => ({
        part: p,
        status,
        reasons,
        requiredMeasurements: required(reasons),
    });
    const filterPart = (g: FilterGroupResult["group"], p: PartReport["part"]) => {
        const r = filters.find((x) => x.group === g);
        return r ? part(p, r.status, r.reasons) : part(p, "BLOCKED", chainNotes.length ? chainNotes : ["not_computed"]);
    };
    const pmAll = Object.values(margins).map((m) => m!.current);
    const parts: PartReport[] = [
        part(
            "absolute_pid",
            pid.length ? statusOf(pid) : "BLOCKED",
            pid.length
                ? [...new Set(pid.flatMap((p) => p.reasons))]
                : ["no_chirp_axis", "required_measurement:chirp_flight"],
        ),
        part("feedforward", statusOf(feedforward), [...new Set(feedforward.flatMap((f) => f.reasons))]),
        filterPart("gyro_filter", "gyro_filter"),
        filterPart("dterm_filter", "dterm_filter"),
        filterPart("rpm_filter", "rpm_filter"),
        filterPart("dynamic_notch", "dynamic_notch"),
        part(
            "plant_identification",
            analysed.length &&
                analysed.every((a) => crossLogPlant[a]?.status === "PASS" && log.chirp[a]!.state !== "rejected")
                ? "VALIDATED"
                : analysed.length
                  ? "PARTIAL"
                  : "BLOCKED",
            analysed.length
                ? analysed
                      .flatMap((a) => [
                          ...(log.chirp[a]!.state === "rejected"
                              ? [
                                    `chirp_measurement_rejected:${a}`,
                                    `required_measurement:chirp_${a}_meeting_qualification`,
                                ]
                              : []),
                          ...(crossLogPlant[a]?.status === "PASS"
                              ? []
                              : [
                                    `cross_log_${(crossLogPlant[a]?.status ?? "untested").toLowerCase()}:${a}`,
                                    "required_measurement:second_chirp_flight_same_tune",
                                ]),
                      ])
                      .concat([...new Set(crossLogRejected.map((r) => r.split(":")[0]))])
                      // A reference whose independence is unproven (an export from inside a session,
                      // missing session data): the user needs the complete log of another flight.
                      .concat(
                          crossLogRejected.some((r) => r.startsWith("cross_log_independence_unproven:"))
                              ? ["required_measurement:complete_log_of_an_independent_flight"]
                              : [],
                      )
                : ["required_measurement:chirp_flight"],
        ),
        part(
            "phase_margin_robustness",
            pmAll.length && pmAll.every((m) => m.status === "VALIDATED")
                ? "VALIDATED"
                : analysed.every((a) => chainOk(AXES.indexOf(a))) && analysed.length
                  ? "PARTIAL"
                  : "BLOCKED",
            [
                ...new Set([
                    ...pmAll.flatMap((m) => m.reasons),
                    ...measurementPlan.flatMap((p) => p.requiredMeasurements),
                ]),
                ...qualificationRejected,
                ...qualificationAxisRejected,
                ...(attested ? [] : ["required_measurement:gain_change_chirp_flight_plus_baseline_repeat"]),
            ],
        ),
        part(
            "independent_gain_prediction",
            attested ? "VALIDATED" : "BLOCKED",
            attested
                ? []
                : [
                      ...(baselineIssues.length
                          ? ["verified_tune_measured_from_another_configuration"]
                          : ["no_verified_tune_for_this_craft"]),
                      "required_measurement:gain_change_chirp_flight_plus_baseline_repeat",
                  ],
        ),
    ];

    return {
        chain: { config: chainCfg, validation, notes: chainNotes },
        dterm: dtermReport,
        margins,
        pid,
        filters,
        feedforward,
        crossLogPlant,
        crossLogRejected: [...new Set(crossLogRejected)],
        safety,
        parts,
        proposal,
        releasableProposal: releasable,
        measurementPlan,
    };
}
