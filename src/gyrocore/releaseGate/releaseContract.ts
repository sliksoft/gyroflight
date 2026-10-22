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
 * Release contract for absolute tunes (v2). It replaces a lock that no evidence could lift
 * with named conditions, each decided from evidence the proposal carries:
 *
 *   measurement           valid, qualified CHIRP data on every changed axis
 *   model_quality         plant identification and the notch-aware gyro chain validated
 *   phase_margin          predicted PM validated and above target on every changed axis
 *   robustness            predicted gain margin and |S| peak inside target
 *   independent_validation a Verified Tune for this craft/firmware covering the change
 *   safety_evidence       the absolute-route Safety evidence contract is complete
 *
 * Three more are checked live by the write route itself and are listed here so the
 * interface can show the whole contract: fc_identity (UID, board, firmware, disarmed),
 * current_config (the active profile still holds the logged values) and readback (every
 * firmware-held value reads back as written before and after the save).
 *
 * The user always clicks Apply; a released proposal is still only written on that click.
 */

import { ApplyBlockedError } from "@/gyrocore/chirp/applyGate";
import { logIdentity } from "@/gyrocore/tuning/fcIdentity";
import type { AbsoluteValues } from "@/gyrocore/tuning/absoluteTune";
import {
    changeWithinValidated,
    verifiedTuneIssues,
    type LoggedPids,
    type VerifiedTune,
} from "@/gyrocore/releaseGate/verifiedTune";

export const RELEASE_TARGETS = Object.freeze({
    minPhaseMarginDeg: 40,
    minGainMarginDb: 6,
    /** |S| peak ≤ 2 (6 dB). */
    maxSensitivityPeakDb: 6,
});

export type ReleaseConditionName =
    "measurement" | "model_quality" | "phase_margin" | "robustness" | "independent_validation" | "safety_evidence";

export type LiveConditionName = "fc_identity" | "current_config" | "readback";

export const LIVE_CONDITIONS: readonly LiveConditionName[] = ["fc_identity", "current_config", "readback"];

export type PartStatus = "VALIDATED" | "PARTIAL" | "BLOCKED";

export interface AxisMargins {
    axis: "roll" | "pitch" | "yaw";
    /** "VALIDATED" only when the loop model has no open blocker (see engine/phaseMarginModel). */
    status: "VALIDATED" | "NOT_VALIDATED" | "UNAVAILABLE";
    phaseMarginDeg: number | null;
    gainMarginDb: number | null;
    sensitivityPeakDb: number | null;
    reasons: string[];
}

export interface AbsoluteReleaseEvidence {
    measurement: { valid: boolean; reasons: string[] };
    model: { status: PartStatus; reasons: string[] };
    /** Predicted margins of the proposed tune, per changed axis. */
    margins: AxisMargins[];
    /** A Verified Tune record (verifiedTune.ts), or null when none exists for this craft. */
    independentValidation: VerifiedTune | null;
    /** "available" only from the absolute-route Safety evidence contract (engine/safetyEvidence). */
    safetyAnalysisEvidence: string;
    safetyReasons: string[];
}

export type ProposalPart = "pid" | "feedforward" | "gyro_filter" | "dterm_filter" | "rpm_filter" | "dynamic_notch";

export interface ProposalItem {
    key: string;
    part: ProposalPart;
    from: number;
    to: number;
    status: PartStatus;
    /** What the value is based on and what blocks it (required_measurement:* among them). */
    reasons: string[];
}

export interface AbsoluteProposal {
    id: string;
    createdAt: string;
    /** The log the proposal was computed from: identity and logged values are checked against it. */
    log: { sha256: string; logIndex: number; headerPairs: readonly (readonly [string, string])[] };
    /** Only the fields to write, by CLI name. */
    change: AbsoluteValues;
    items: ProposalItem[];
    release: AbsoluteReleaseEvidence;
}

export interface ReleaseCondition {
    name: ReleaseConditionName;
    passed: boolean;
    reasons: string[];
}

export interface ReleaseDecision {
    released: boolean;
    conditions: ReleaseCondition[];
    /** Every reason of every failed condition, prefixed with the condition name. */
    blocks: string[];
}

const AXES = ["roll", "pitch", "yaw"] as const;

function loggedPids(headers: readonly (readonly [string, string])[]): Record<(typeof AXES)[number], LoggedPids> {
    const get = (k: string) =>
        headers
            .find(([key]) => key === k)?.[1]
            ?.split(",")
            .map((v) => Number(v.trim())) ?? [];
    const ff = get("ff_weight");
    return Object.fromEntries(
        AXES.map((a, i) => {
            const [p, ii, d] = get(`${a}PID`);
            return [a, { p, i: ii, d, f: ff[i] ?? 0 }];
        }),
    ) as Record<(typeof AXES)[number], LoggedPids>;
}

function changedAxes(change: AbsoluteValues): (typeof AXES)[number][] {
    return AXES.filter((a) => [`p_${a}`, `i_${a}`, `d_${a}`, `f_${a}`, `d_max_${a}`].some((k) => k in change));
}

/** Decide every pre-write condition. Pure. */
export function evaluateRelease(proposal: AbsoluteProposal): ReleaseDecision {
    const e = proposal.release;
    const id = logIdentity(proposal.log.headerPairs);
    const firmware = id.firmwareRevision?.split(/\s+/)[1] ?? null;
    const axes = changedAxes(proposal.change);
    const filterChange = Object.keys(proposal.change).some((k) => !/^(p|i|d|f|d_max)_(roll|pitch|yaw)$/.test(k));
    // A filter change moves every axis' loop: then all three need margins.
    const marginAxes = filterChange ? [...AXES] : axes;

    const conditions: ReleaseCondition[] = [];
    const add = (name: ReleaseConditionName, reasons: string[]) =>
        conditions.push({ name, passed: reasons.length === 0, reasons });

    add(
        "measurement",
        e.measurement.valid ? [...e.measurement.reasons] : [...e.measurement.reasons, "measurement_invalid"],
    );
    add(
        "model_quality",
        e.model.status === "VALIDATED"
            ? []
            : e.model.reasons.length
              ? [...e.model.reasons]
              : [`model_${e.model.status.toLowerCase()}`],
    );

    const pm: string[] = [];
    const rob: string[] = [];
    for (const axis of marginAxes) {
        const m = e.margins.find((x) => x.axis === axis);
        if (!m) {
            pm.push(`margins_missing:${axis}`);
            rob.push(`margins_missing:${axis}`);
            continue;
        }
        if (m.status !== "VALIDATED")
            pm.push(`pm_${m.status.toLowerCase()}:${axis}`, ...m.reasons.map((r) => `${axis}:${r}`));
        else if (!(m.phaseMarginDeg !== null && m.phaseMarginDeg >= RELEASE_TARGETS.minPhaseMarginDeg)) {
            pm.push(`pm_below_target:${axis}:${m.phaseMarginDeg}`);
        }
        if (!(m.gainMarginDb !== null && m.gainMarginDb >= RELEASE_TARGETS.minGainMarginDb)) {
            rob.push(`gain_margin_below_target:${axis}:${m.gainMarginDb}`);
        }
        if (!(m.sensitivityPeakDb !== null && m.sensitivityPeakDb <= RELEASE_TARGETS.maxSensitivityPeakDb)) {
            rob.push(`sensitivity_peak_above_target:${axis}:${m.sensitivityPeakDb}`);
        }
    }
    add("phase_margin", pm);
    add("robustness", rob);

    const iv = verifiedTuneIssues(e.independentValidation, { uid: id.uid, firmware });
    if (!iv.length && e.independentValidation) {
        const from = loggedPids(proposal.log.headerPairs);
        const to = Object.fromEntries(
            AXES.map((a) => [
                a,
                { p: proposal.change[`p_${a}`], i: proposal.change[`i_${a}`], d: proposal.change[`d_${a}`] },
            ]),
        );
        iv.push(...changeWithinValidated(e.independentValidation, from, to));
    }
    add("independent_validation", iv);
    add(
        "safety_evidence",
        e.safetyAnalysisEvidence === "available"
            ? []
            : e.safetyReasons.length
              ? [...e.safetyReasons]
              : ["safety_evidence_not_available"],
    );

    const blocks = conditions.flatMap((c) => c.reasons.map((r) => `${c.name}:${r}`));
    return { released: blocks.length === 0, conditions, blocks };
}

export function assertAbsoluteReleased(proposal: AbsoluteProposal): void {
    const decision = evaluateRelease(proposal);
    if (!decision.released) {
        throw new ApplyBlockedError(decision.blocks);
    }
}
