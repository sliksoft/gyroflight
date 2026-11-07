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
 * GyroCore Safety for absolute proposals (WP6): the evaluation the Safety step of the absolute
 * route runs (safety/authorize.ts absoluteSafetyAuthorization). GyroCore's own Safety engine
 * evaluates slider composites only (evaluate.ts); this evaluates what an absolute PID / feedforward
 * / filter write needs, check by check, and names what is missing:
 *
 *   validated_starting_configuration  a Verified Tune this browser holds now, for this craft and
 *                                     firmware, measured from exactly the logged configuration and
 *                                     covering the change (verifiedTune.validatedRegionIssues)
 *   absolute_values_in_range          every written value known, writable, an integer inside the
 *                                     firmware's settings.c range; d_max ≥ D or 0; dynamic min ≤ max
 *                                     (absoluteTune.changeSetIssues on the logged values)
 *   plausible_step                    P / I / D / F / d_max move by at most the PID search's step
 *                                     (pidOptimizer MAX_STEP) from the logged value
 *   dynamic_margins                   PM / GM / |S| VALIDATED with their measurement uncertainty and
 *                                     inside the release targets on every axis the change moves (all
 *                                     three for a filter change), read here again from the evidence
 *                                     (marginEvidenceIssues), not taken from the release contract
 *   fc_identity_binding               the log names the craft (UID), board and firmware the Apply
 *                                     route checks the connected flight controller against
 *   live_recheck / human_confirmation enforced by the route itself (useTuneApply.ts: live reads and
 *   / rollback                        the authority again before the first SET; the single-use token
 *                                     bound to the preview; backup and Restore), shown with what is
 *                                     proven of them: simulator tests only
 *   hardware_validation               AUTOTUNE_V2_HARDWARE_PROCEDURE.md executed on a real craft
 *
 * Not authorized while hardware validation is NOT_EXECUTED (ABSOLUTE_SAFETY_POLICY): software
 * evidence alone, evaluated by the same software that produced it, never releases a write to a
 * flight controller. Statuses: PASS / FAIL / NOT_VALIDATED / NOT_EXECUTED.
 */

import { logIdentity } from "@/gyrocore/tuning/fcIdentity";
import { changeSetIssues, loggedAbsoluteValues, MIN_ABSOLUTE_API } from "@/gyrocore/tuning/absoluteTune";
import { RELEASE_TARGETS, type AbsoluteProposal } from "@/gyrocore/releaseGate/releaseContract";
import { marginEvidenceIssues } from "@/gyrocore/engine/loopModel";
import { validatedRegionIssues, verifiedTuneIssues, type VerifiedTune } from "@/gyrocore/releaseGate/verifiedTune";
import { MAX_STEP } from "@/gyrocore/engine/pidOptimizer";

/**
 * hardwareValidated stays false until the hardware procedure has been executed and its results
 * recorded; flipping it is a release decision, never a code change to get a demo through.
 */
export const ABSOLUTE_SAFETY_POLICY = Object.freeze({ hardwareValidated: false, maxPidStepFraction: MAX_STEP });

export const ABSOLUTE_SAFETY_NOT_HARDWARE_VALIDATED = "absolute_safety:not_hardware_validated";

export type AbsoluteSafetyCheckName =
    | "validated_starting_configuration"
    | "absolute_values_in_range"
    | "plausible_step"
    | "dynamic_margins"
    | "fc_identity_binding"
    | "live_recheck"
    | "human_confirmation"
    | "rollback"
    | "hardware_validation";

export interface AbsoluteSafetyCheck {
    name: AbsoluteSafetyCheckName;
    status: "PASS" | "FAIL" | "NOT_VALIDATED" | "NOT_EXECUTED";
    reasons: string[];
}

export interface AbsoluteSafetyEvaluation {
    checks: AbsoluteSafetyCheck[];
    /** Every reason the evaluation does not authorize, check by check (empty never: see the policy). */
    blocks: string[];
    /** The dynamic analysis (margins with uncertainty) is complete and inside the targets. */
    analysisEvidence: "available" | "not_available";
}

const PID_KEY = /^(p|i|d|f|d_max)_(roll|pitch|yaw)$/;
const AXES = ["roll", "pitch", "yaw"] as const;

/** Evaluate an absolute proposal against the record this browser holds now (`verifiedTune`). Pure. */
export function evaluateAbsoluteSafety(
    proposal: AbsoluteProposal,
    { verifiedTune }: { verifiedTune: VerifiedTune | null },
): AbsoluteSafetyEvaluation {
    const checks: AbsoluteSafetyCheck[] = [];
    const add = (name: AbsoluteSafetyCheckName, status: AbsoluteSafetyCheck["status"], reasons: string[]) =>
        checks.push({ name, status, reasons });
    const pass = (name: AbsoluteSafetyCheckName, reasons: string[]) =>
        add(name, reasons.length ? "FAIL" : "PASS", reasons);
    const id = logIdentity(proposal.log.headerPairs);
    const firmware = id.firmwareRevision?.split(/\s+/)[1] ?? null;
    const logged = loggedAbsoluteValues(proposal.log.headerPairs);

    const record = verifiedTune ? verifiedTuneIssues(verifiedTune, { uid: id.uid, firmware }) : ["no_verified_tune"];
    pass(
        "validated_starting_configuration",
        record.length ? record : validatedRegionIssues(verifiedTune!, logged, proposal.change),
    );

    // Against the logged values; the complete live snapshot (every field read from the craft) is
    // the route's own check on the click (readLiveAbsolute), which a log cannot stand in for.
    pass(
        "absolute_values_in_range",
        changeSetIssues(proposal.change, logged, MIN_ABSOLUTE_API).filter((r) => r !== "absolute:snapshot_incomplete"),
    );

    const steps: string[] = [];
    for (const [key, to] of Object.entries(proposal.change)) {
        if (!PID_KEY.test(key)) continue;
        const from = logged[key];
        if (!Number.isFinite(from)) steps.push(`step_from_unknown:${key}`);
        else if (Math.abs(to - from) > ABSOLUTE_SAFETY_POLICY.maxPidStepFraction * Math.abs(from) + 0.5) {
            steps.push(`step_too_large:${key}:${from}->${to}`);
        }
    }
    pass("plausible_step", steps);

    // Its own reading of the margin evidence, not the release contract's verdict: a second check.
    const filterChange = Object.keys(proposal.change).some((k) => !PID_KEY.test(k));
    const axes = filterChange
        ? AXES
        : AXES.filter((a) => Object.keys(proposal.change).some((k) => PID_KEY.test(k) && k.endsWith(`_${a}`)));
    const dyn: string[] = [];
    for (const axis of axes) {
        const m = proposal.release.margins.find((x) => x.axis === axis);
        if (!m) {
            dyn.push(`margins_missing:${axis}`);
            continue;
        }
        if (m.status !== "VALIDATED") dyn.push(`margins_${String(m.status).toLowerCase()}:${axis}`);
        dyn.push(...marginEvidenceIssues(m.evidence).map((r) => `${r}:${axis}`));
        const T = RELEASE_TARGETS;
        if (!(typeof m.phaseMarginDeg === "number" && m.phaseMarginDeg >= T.minPhaseMarginDeg))
            dyn.push(`pm_below_target:${axis}`);
        if (!(typeof m.gainMarginDb === "number" && m.gainMarginDb >= T.minGainMarginDb))
            dyn.push(`gm_below_target:${axis}`);
        if (!(typeof m.sensitivityPeakDb === "number" && m.sensitivityPeakDb <= T.maxSensitivityPeakDb)) {
            dyn.push(`sensitivity_above_target:${axis}`);
        }
    }
    if (!axes.length) dyn.push("no_axis_changed");
    pass("dynamic_margins", dyn);

    pass("fc_identity_binding", [
        ...(id.uid ? [] : ["log_uid_missing"]),
        ...(id.board ? [] : ["log_board_missing"]),
        ...(firmware ? [] : ["log_firmware_missing"]),
    ]);

    // Properties of the write route, not of the proposal: implemented, tested on the simulator only.
    add("live_recheck", "PASS", ["route:useTuneApply_reads_and_rechecks_before_the_first_set"]);
    add("human_confirmation", "PASS", ["route:single_use_token_bound_to_the_preview"]);
    add("rollback", "NOT_VALIDATED", ["route:backup_and_restore_verified_on_the_simulator_only"]);
    add(
        "hardware_validation",
        ABSOLUTE_SAFETY_POLICY.hardwareValidated ? "PASS" : "NOT_EXECUTED",
        ABSOLUTE_SAFETY_POLICY.hardwareValidated ? [] : ["AUTOTUNE_V2_HARDWARE_PROCEDURE_not_executed"],
    );

    const blocks = [
        ...checks
            .filter((c) => c.status === "FAIL")
            .flatMap((c) => c.reasons.map((r) => `absolute_safety:${c.name}:${r}`)),
        ...(ABSOLUTE_SAFETY_POLICY.hardwareValidated ? [] : [ABSOLUTE_SAFETY_NOT_HARDWARE_VALIDATED]),
    ];
    const dynamic = checks.find((c) => c.name === "dynamic_margins")!;
    return { checks, blocks, analysisEvidence: dynamic.status === "PASS" ? "available" : "not_available" };
}
