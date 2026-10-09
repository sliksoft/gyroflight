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
 * GyroCore staged safety pipeline (core/gyrocore/safety/pipeline.py,
 * mechanical_eval.py, safe_tune.py, output.py at d2e60f7), WU4A subset:
 *
 *   mechanical safety  -> only the missing-analysis branch (M18). The evidence
 *                         rules (M1-M17) need analysis evidence Gyroflight does
 *                         not have; they are not ported (BLOCKED_BY_ANALYSIS).
 *   safe-tune clamps   -> the structural blocks (S1-S5) only. With mechanical
 *                         BLOCK the reference never reaches the clamps either.
 *   output safety      -> every check that reads no analysis field (O1-O7,
 *                         O9-O11, O15), in the reference's order.
 *   finalize           -> as the reference; never actionable.
 *
 * There is no analysis parameter: nothing here can be fed placeholder
 * evidence, and the reference's fail-open paths (`{}` / `{ok: true}` treated
 * as clean, `require_analysis=False`, `score or 1.0`) do not exist. Every tune
 * that reaches this pipeline is BLOCK `missing_required_analysis` until a
 * qualified Safety-evidence contract exists (docs/gyrocore/SAFETY_ENGINE.md).
 */

import { MERGE_REQUIRES_REVIEW } from "@/gyrocore/tuning/merge";
import { AXES, DYN_LPF_MAX_HZ, F_GAIN_MAX, LPF_MAX_HZ, PID_GAIN_MAX } from "./simplifiedTuning";
import { absoluteTuneToConfig, isPresent, type AbsoluteTuneProposal, type TuneConfig } from "./absolute";

export type Verdict = "pass" | "warn" | "block";

export interface SafetyCheck {
    rule_id: string;
    verdict: Verdict;
    before: unknown;
    after: unknown;
}

export const BLOCK_MECHANICAL = "mechanical_hard_block";
export const BLOCK_MISSING_ANALYSIS = "missing_required_analysis";
export const BLOCK_MISSING_BASELINE = "missing_required_pid_or_filter_baseline";
export const BLOCK_MERGE_REVIEW = "unresolved_merge_requires_review";
export const BLOCK_SYSID = "system_id_unusable";
export const BLOCK_INVALID_SIMPLIFIED = "invalid_simplified_tuning_state";
export const BLOCK_SLIDER_INCONSISTENT = "slider_inconsistency";
export const BLOCK_MALFORMED = "malformed_proposal";
export const BLOCK_VALUES = "resulting_values_invalid";
export const BLOCK_CANDIDATE = "safe_tune_candidate_blocked";

/** clamps.DEFAULT_MAX_DELTA (donor step caps; recorded in the candidate as max_delta_used). */
export const DEFAULT_MAX_DELTA = {
    filters: {
        gyro_lpf1_static_hz: 44,
        gyro_lpf1_dyn_min_hz: 50,
        gyro_lpf1_dyn_max_hz: 60,
        gyro_lpf2_static_hz: 40,
        dterm_lpf1_dyn_min_hz: 20,
        dterm_lpf1_dyn_max_hz: 30,
        dterm_lpf2_static_hz: 30,
        dyn_notch_count: 1,
        dyn_notch_min_hz: 40,
        dyn_notch_max_hz: 80,
        dyn_notch_width_percent: 5,
        rpm_filter_harmonics: 1,
        rpm_filter_min_hz: 20,
        rpm_filter_max_hz: 100,
        rpm_filter_fade_range_hz: 20,
        feedforward_boost: 5,
        feedforward_smooth_factor: 5,
        feedforward_jitter_factor: 5,
        feedforward_transition: 5,
        rc_smoothing: 1,
        rc_smoothing_feedforward: 5,
        dyn_idle_min_rpm: 10,
        anti_gravity_gain: 1000,
        anti_gravity_cutoff: 2,
        anti_gravity_p_gain: 10,
        iterm_relax: 1,
        iterm_rotation: 1,
        tpa_rate: 5,
        tpa_breakpoint: 50,
        throttle_boost: 5,
        motor_output_limit: 5,
    },
    pid: {
        roll: { p: 4, i: 8, d: 6, ff: 8, d_max: 6 },
        pitch: { p: 4, i: 8, d: 6, ff: 8, d_max: 6 },
        yaw: { p: 4, i: 8, d: 6, ff: 8, d_max: 6 },
    },
} as const;

/** clamps.scale_max_delta: every cap times the mechanical scale (clamped to 0..1; non-finite -> 1). */
export function scaleMaxDelta(scale: number) {
    const s = Number.isFinite(scale) ? Math.max(0, Math.min(1, scale)) : 1;
    const filters: Record<string, number> = {};
    for (const [k, v] of Object.entries(DEFAULT_MAX_DELTA.filters)) {
        filters[k] = v * s;
    }
    const pid: Record<string, Record<string, number>> = {};
    for (const [axis, block] of Object.entries(DEFAULT_MAX_DELTA.pid)) {
        pid[axis] = Object.fromEntries(Object.entries(block).map(([k, v]) => [k, v * s]));
    }
    return { filters, pid };
}

export interface MechanicalResult {
    status: Verdict;
    mechanical_block: boolean;
    mechanical_limited: boolean;
    mechanical_caution: boolean;
    mechanical_outcome: string;
    recommended_action: string;
    reasons: string[];
    blocking_reasons: string[];
    limited_reasons: string[];
    caution_reasons: string[];
    max_delta_scale: number;
    limited_tier: string;
    checks: SafetyCheck[];
}

/** mechanical_eval.evaluate_mechanical_safety(None, require_analysis=True): the only reachable branch. */
export function mechanicalWithoutAnalysis(): MechanicalResult {
    return {
        status: "block",
        mechanical_block: true,
        mechanical_limited: false,
        mechanical_caution: false,
        mechanical_outcome: "mechanical_block",
        recommended_action: "guidance_only",
        reasons: [BLOCK_MISSING_ANALYSIS],
        blocking_reasons: [BLOCK_MISSING_ANALYSIS],
        limited_reasons: [],
        caution_reasons: [],
        max_delta_scale: 0,
        limited_tier: "blocked",
        checks: [
            { rule_id: "mechanical.missing_required_analysis", verdict: "block", before: null, after: null },
            { rule_id: `mechanical.block.${BLOCK_MISSING_ANALYSIS}`, verdict: "block", before: null, after: null },
        ],
    };
}

export interface SafeTuneCandidate {
    status: Verdict;
    clamp_ids: string[];
    blocked_reasons: string[];
    warnings: string[];
    max_delta_used: ReturnType<typeof scaleMaxDelta>;
    current_config: TuneConfig;
    proposed_config: TuneConfig | null;
    clamped_config: null;
    clamped_tune: null;
    checks: SafetyCheck[];
}

/**
 * safe_tune.clamp_safe_tune up to its blocked return. A non-BLOCK mechanical
 * result needs analysis evidence, which this pipeline never has, so the clamp
 * path is unreachable and not ported.
 */
export function safeTuneCandidate(proposal: AbsoluteTuneProposal, mechanical: MechanicalResult): SafeTuneCandidate {
    if (mechanical.status !== "block") {
        throw new Error("safe-tune clamps need analysis evidence; not available in Gyroflight (WU4A)");
    }
    const blocked: string[] = [];
    const current = absoluteTuneToConfig(proposal.current);
    const critical = current.missing.filter((m) => !m.endsWith(".d_max"));
    if (critical.length) {
        blocked.push(`${BLOCK_MISSING_BASELINE}:${critical.join(",")}`);
    }
    let proposedConfig: TuneConfig | null = null;
    if (proposal.proposed) {
        proposedConfig = absoluteTuneToConfig(proposal.proposed).config;
    } else {
        blocked.push("malformed_or_empty_proposal");
    }
    if (proposal.status === MERGE_REQUIRES_REVIEW || proposal.reviewReasons.length) {
        blocked.push(BLOCK_MERGE_REVIEW);
    }
    if (proposal.status === "blocked" || proposal.blockedReasons.length) {
        blocked.push(...proposal.blockedReasons);
        if (!blocked.includes("proposal_blocked")) {
            blocked.push("proposal_blocked");
        }
    }
    blocked.push(BLOCK_MECHANICAL);
    const scale = mechanical.max_delta_scale;
    return {
        status: "block",
        clamp_ids: [],
        blocked_reasons: [...new Set(blocked)],
        warnings: [...new Set(proposal.warnings)],
        max_delta_used: scaleMaxDelta(scale),
        current_config: current.config,
        proposed_config: proposedConfig,
        clamped_config: null,
        clamped_tune: null,
        checks: [
            {
                rule_id: "safe_tune.max_delta_scale",
                verdict: scale <= 0 ? "block" : "pass",
                before: 1,
                after: scale,
            },
        ],
    };
}

/** output._values_within_firmware (pure; applied by the reference to a clamped config). */
export function valuesWithinFirmware(config: TuneConfig | null | undefined): [boolean, string[]] {
    if (!config) {
        return [false, ["clamped_config_missing"]];
    }
    const bad: string[] = [];
    // Python float(v): numbers and booleans convert, numeric strings parse, anything else is non-numeric.
    const toFloat = (v: unknown): number | null => {
        if (typeof v === "number") {
            return v;
        }
        if (typeof v === "boolean") {
            return v ? 1 : 0;
        }
        if (
            typeof v === "string" &&
            /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$|^\s*[+-]?(inf|infinity|nan)\s*$/i.test(v)
        ) {
            return Number.parseFloat(v.trim().replace(/^([+-]?)inf(inity)?$/i, "$1Infinity"));
        }
        return null;
    };
    const inRange = (v: unknown, hi: number, label: string) => {
        const n = toFloat(v);
        if (n === null) {
            bad.push(`${label}_non_numeric`);
        } else if (Number.isNaN(n) || n < 0 || n > hi) {
            bad.push(`${label}_out_of_firmware_range`);
        }
    };
    for (const axis of AXES) {
        const block = (config.pid?.[axis] ?? {}) as Record<string, unknown>;
        for (const [comp, hi] of [
            ["p", PID_GAIN_MAX],
            ["i", PID_GAIN_MAX],
            ["d", PID_GAIN_MAX],
            ["d_max", PID_GAIN_MAX],
            ["ff", F_GAIN_MAX],
        ] as const) {
            if (comp in block) {
                inRange(block[comp], hi, `${axis}.${comp}`);
            }
        }
    }
    const filt = (config.filters ?? {}) as Record<string, unknown>;
    for (const [key, hi] of [
        ["gyro_lpf1_dyn_min_hz", DYN_LPF_MAX_HZ],
        ["gyro_lpf1_dyn_max_hz", DYN_LPF_MAX_HZ],
        ["gyro_lpf1_static_hz", LPF_MAX_HZ],
        ["gyro_lpf2_static_hz", LPF_MAX_HZ],
        ["dterm_lpf1_dyn_min_hz", DYN_LPF_MAX_HZ],
        ["dterm_lpf1_dyn_max_hz", DYN_LPF_MAX_HZ],
        ["dterm_lpf1_static_hz", LPF_MAX_HZ],
        ["dterm_lpf2_static_hz", LPF_MAX_HZ],
    ] as const) {
        if (key in filt) {
            inRange(filt[key], hi, key);
        }
    }
    return [bad.length === 0, bad];
}

export interface OutputSafetyResult {
    status: Verdict;
    donor_status: "blocked" | "limited" | "actionable";
    blocking_reasons: string[];
    warning_reasons: string[];
    checks: { rule_id: string; verdict: Verdict }[];
}

/** output.evaluate_tuning_output_safety with require_analysis=True and no analysis. */
export function tuningOutputSafety(
    proposal: AbsoluteTuneProposal,
    mechanical: MechanicalResult,
    candidate: SafeTuneCandidate,
): OutputSafetyResult {
    const blocking: string[] = [];
    const warning: string[] = [];
    const checks: { rule_id: string; verdict: Verdict }[] = [
        { rule_id: "tos.mechanical_stage_present", verdict: "pass" },
        { rule_id: "tos.safe_tune_stage_present", verdict: "pass" },
    ];
    if (mechanical.status === "block" || mechanical.mechanical_block) {
        blocking.push(BLOCK_MECHANICAL, ...mechanical.blocking_reasons);
        checks.push({ rule_id: "tos.mechanical_not_blocked", verdict: "block" });
    }
    if (candidate.status === "block" || candidate.blocked_reasons.length) {
        blocking.push(BLOCK_CANDIDATE, ...candidate.blocked_reasons);
    }
    if (proposal.status === MERGE_REQUIRES_REVIEW || proposal.reviewReasons.length) {
        blocking.push(BLOCK_MERGE_REVIEW, ...proposal.reviewReasons);
    }
    // The reference's substring heuristic (output.py); it can only add a block.
    const sysid = proposal.blockedReasons.filter((r) => r.toLowerCase().includes("system") || r.startsWith("sysid"));
    if (sysid.length) {
        blocking.push(BLOCK_SYSID, ...sysid);
    }
    if (!proposal.proposed && proposal.status === "blocked") {
        blocking.push(BLOCK_MALFORMED);
    }
    const currentMissing = AXES.flatMap((a) =>
        (["p", "i", "d", "f"] as const).filter((c) => !isPresent(proposal.current[a][c])),
    );
    if (currentMissing.length) {
        blocking.push(BLOCK_MISSING_BASELINE);
    }
    if (proposal.proposedValidity) {
        const v = proposal.proposedValidity;
        if (v.skipped_reasons.length) {
            blocking.push(BLOCK_INVALID_SIMPLIFIED, ...v.skipped_reasons);
        }
        if (v.pid_mismatches.length || v.gyro_mismatches.length || v.dterm_mismatches.length) {
            blocking.push(BLOCK_SLIDER_INCONSISTENT);
        }
    }
    // require_analysis with no analysis.
    blocking.push(BLOCK_MISSING_ANALYSIS);
    checks.push({ rule_id: "tos.required_analysis", verdict: "block" });
    // The clamped config is null whenever the candidate is blocked, so the
    // firmware-range check (O15) does not run, exactly as in the reference.
    const uniqueBlocking = [...new Set(blocking.filter((x) => x.trim()))];
    const uniqueWarning = [...new Set(warning.filter((x) => x.trim() && !uniqueBlocking.includes(x)))];
    const status: Verdict = uniqueBlocking.length ? "block" : uniqueWarning.length ? "warn" : "pass";
    const donorStatus = status === "block" ? "blocked" : status === "warn" ? "limited" : "actionable";
    checks.push({ rule_id: "tos.cli_actionable_frozen_false", verdict: "pass" });
    checks.push({ rule_id: "tos.final_verdict", verdict: status });
    return {
        status,
        donor_status: donorStatus,
        blocking_reasons: uniqueBlocking,
        warning_reasons: uniqueWarning,
        checks,
    };
}

export interface FinalSafeTune {
    status: Verdict;
    blocked_reasons: string[];
    warnings: string[];
    actionable: false;
}

export function finalizeSafeTune(tos: OutputSafetyResult, candidate: SafeTuneCandidate): FinalSafeTune {
    return {
        status: tos.status,
        blocked_reasons: [...new Set(tos.blocking_reasons)],
        warnings: [...new Set([...tos.warning_reasons, ...candidate.warnings])],
        actionable: false,
    };
}

export interface PipelineResult {
    proposal: AbsoluteTuneProposal;
    mechanical: MechanicalResult;
    candidate: SafeTuneCandidate;
    outputSafety: OutputSafetyResult;
    final: FinalSafeTune;
}

/** pipeline.run_safety_pipeline(proposal, analysis=None, require_analysis=True). There is no skip path. */
export function runSafetyPipeline(proposal: AbsoluteTuneProposal): PipelineResult {
    const mechanical = mechanicalWithoutAnalysis();
    const candidate = safeTuneCandidate(proposal, mechanical);
    const outputSafety = tuningOutputSafety(proposal, mechanical, candidate);
    return { proposal, mechanical, candidate, outputSafety, final: finalizeSafeTune(outputSafety, candidate) };
}
