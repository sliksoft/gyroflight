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
 *                         Both rest on the same margin evidence (engine/loopModel MarginEvidence) and
 *                         both require it VALIDATED: bounds that are only MODEL_CONDITIONAL (the
 *                         model class not qualified by a finer, independent CHIRP log), MEASURED, or
 *                         carried with missing / malformed / inconsistent metadata pass neither.
 *   independent_validation a Verified Tune for this craft/firmware whose measured baseline is
 *                         this log's configuration and whose measured segment covers the change
 *   safety_evidence       the absolute-route Safety evidence contract is complete
 *   items_validated       every value to write is itself VALIDATED (a simulated-only or
 *                         partial recommendation stays visible but is never written)
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
import { loggedAbsoluteValues, type AbsoluteValues } from "@/gyrocore/tuning/absoluteTune";
import { validatedRegionIssues, verifiedTuneIssues, type VerifiedTune } from "@/gyrocore/releaseGate/verifiedTune";
import { marginEvidenceIssues, type LoopMargins, type MarginEvidence } from "@/gyrocore/engine/loopModel";

export const RELEASE_TARGETS = Object.freeze({
    minPhaseMarginDeg: 40,
    minGainMarginDb: 6,
    /** |S| peak ≤ 2 (6 dB). */
    maxSensitivityPeakDb: 6,
});

export type ReleaseConditionName =
    | "measurement"
    | "model_quality"
    | "phase_margin"
    | "robustness"
    | "independent_validation"
    | "safety_evidence"
    | "items_validated";

export type LiveConditionName = "fc_identity" | "current_config" | "readback";

export const LIVE_CONDITIONS: readonly LiveConditionName[] = ["fc_identity", "current_config", "readback"];

export type PartStatus = "VALIDATED" | "PARTIAL" | "BLOCKED";

export interface AxisMargins {
    axis: "roll" | "pitch" | "yaw";
    /** "VALIDATED" only when the loop model has no open blocker (engine/loopModel.ts). */
    status: "VALIDATED" | "NOT_VALIDATED" | "UNAVAILABLE";
    /** Bounds: the values the targets are checked on. */
    phaseMarginDeg: number | null;
    gainMarginDb: number | null;
    sensitivityPeakDb: number | null;
    /** Values read on the bins (research result); never checked against the targets. */
    measured: LoopMargins["measured"];
    /** Level, resolution, band, assumptions and qualification of the bounds (marginEvidenceIssues). */
    evidence: MarginEvidence;
    reasons: string[];
}

/**
 * Why one axis' margins are not release evidence, for phase_margin and robustness alike. Fail-closed
 * on anything missing or malformed. Beyond the evidence itself: the qualification must come from
 * another log than the proposal's, and the bounds may not be better than what it measured (the
 * engine reports the worse of both).
 */
function marginReleaseIssues(m: AxisMargins, log: AbsoluteProposal["log"]): string[] {
    const out: string[] = [];
    if (m.status !== "VALIDATED") out.push(`margins_${String(m.status).toLowerCase()}`);
    out.push(...marginEvidenceIssues(m.evidence));
    const q = m.evidence?.qualification;
    if (q && typeof q === "object") {
        if (q.source?.sha256 === log.sha256 && q.source?.logIndex === log.logIndex) {
            out.push("model_class_qualification_is_proposal_log");
        }
        const eps = 1e-9;
        if (
            !(
                typeof m.phaseMarginDeg === "number" &&
                typeof q.phaseMarginDeg === "number" &&
                m.phaseMarginDeg <= q.phaseMarginDeg + eps
            ) ||
            !(
                typeof m.gainMarginDb === "number" &&
                typeof q.gainMarginDb === "number" &&
                m.gainMarginDb <= q.gainMarginDb + eps
            ) ||
            !(
                typeof m.sensitivityPeakDb === "number" &&
                typeof q.sensitivityPeakDb === "number" &&
                m.sensitivityPeakDb >= q.sensitivityPeakDb - eps
            )
        ) {
            out.push("margins_better_than_qualification");
        }
    }
    return out;
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
        // One evidence check for both conditions: unqualified evidence passes neither.
        const evidence = marginReleaseIssues(m, proposal.log).map((r) => `${r}:${axis}`);
        pm.push(...evidence);
        rob.push(...evidence);
        if (m.status !== "VALIDATED")
            pm.push(`pm_${String(m.status).toLowerCase()}:${axis}`, ...(m.reasons ?? []).map((r) => `${axis}:${r}`));
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
        iv.push(
            ...validatedRegionIssues(
                e.independentValidation,
                loggedAbsoluteValues(proposal.log.headerPairs),
                proposal.change,
            ),
        );
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

    const itemReasons: string[] = [];
    for (const key of Object.keys(proposal.change)) {
        const item = proposal.items.find((i) => i.key === key);
        if (!item) itemReasons.push(`change_without_item:${key}`);
        else if (item.to !== proposal.change[key]) itemReasons.push(`item_value_differs:${key}`);
        else if (item.status !== "VALIDATED")
            itemReasons.push(`item_not_validated:${key}:${item.status.toLowerCase()}`);
    }
    add("items_validated", itemReasons);

    const blocks = conditions.flatMap((c) => c.reasons.map((r) => `${c.name}:${r}`));
    return { released: blocks.length === 0, conditions, blocks };
}

export function assertAbsoluteReleased(proposal: AbsoluteProposal): void {
    const decision = evaluateRelease(proposal);
    if (!decision.released) {
        throw new ApplyBlockedError(decision.blocks);
    }
}
