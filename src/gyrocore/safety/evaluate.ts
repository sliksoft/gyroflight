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
 * GyroCore Safety for the global (composite) recommendation: the one Safety
 * result the product shows and the Apply action enforces (WU4A).
 *
 * Input: the FINAL composite of WU3/WU3.1 (merge + axis coverage, with its
 * provenance) and the raw header lines of its log, from which the current
 * absolute tune is read. Safety never runs on a single axis's proposal, and
 * never on a composite already blocked upstream (NOT_EVALUATED).
 *
 * No analysis evidence exists in Gyroflight, so the reference pipeline's
 * missing-analysis branch decides: every evaluated tune is BLOCK
 * `missing_required_analysis`. That is the reference's fail-closed verdict,
 * not a Gyroflight rule.
 */

import { SLIDER_KEYS, type SimplifiedSliders } from "@/gyrocore/tuning/merge";
import type { CompositeRecommendation } from "@/gyrocore/tuning/composite";
import {
    GYROFLIGHT_EXTRACT,
    GYROFLIGHT_PROPOSE,
    extractAbsoluteTune,
    proposeAbsoluteTune,
    type AbsoluteTune,
    type Delta,
} from "./absolute";
import { runSafetyPipeline, type PipelineResult, type SafetyCheck } from "./pipeline";

export type SafetyStatus = "PASS" | "WARN" | "BLOCK" | "NOT_EVALUATED";

export interface SafetyResult {
    status: SafetyStatus;
    /** The composite this result is bound to; a different composite needs a new evaluation. */
    compositeId: string | null;
    /** The exact slider payload evaluated (composite.final). */
    sliders: Record<string, number> | null;
    reportToken: string | null;
    logIndex: number | null;
    firmwareRevision: string | null;
    blocks: string[];
    warnings: string[];
    checks: SafetyCheck[];
    currentSliders: SimplifiedSliders | null;
    proposedSliders: SimplifiedSliders | null;
    current: AbsoluteTune | null;
    proposed: AbsoluteTune | null;
    deltas: Record<string, Delta>;
    /** Analysis evidence the reference requires; none is available in Gyroflight. */
    analysisEvidence: "not_available";
    pipeline: PipelineResult | null;
    authorized: boolean;
}

export const SAFETY_NOT_EVALUATED_NO_COMPOSITE = "safety_not_evaluated:no_global_recommendation";
export const SAFETY_NOT_EVALUATED_UPSTREAM = "safety_not_evaluated:blocked_upstream";
export const SAFETY_INPUT_MISSING_HEADERS = "safety_input_missing:log_headers";
export const SAFETY_INPUT_SLIDERS_DIFFER = "safety_input_inconsistent:current_sliders";

/** What Safety needs of the analysed log. */
export interface SafetyLogInput {
    headerPairs: [string, string][];
    firmwareRevision: string | null;
}

function empty(status: SafetyStatus, blocks: string[], composite: CompositeRecommendation | null): SafetyResult {
    return {
        status,
        compositeId: composite?.id ?? null,
        sliders: composite?.final ? { ...composite.final } : null,
        reportToken: composite?.reportToken ?? null,
        logIndex: composite?.logIndex ?? null,
        firmwareRevision: composite?.firmwareRevision ?? null,
        blocks,
        warnings: [],
        checks: [],
        currentSliders: composite?.current ?? null,
        proposedSliders: composite?.merge.simplified ?? null,
        current: null,
        proposed: null,
        deltas: {},
        analysisEvidence: "not_available",
        pipeline: null,
        authorized: false,
    };
}

const sameSliders = (a: SimplifiedSliders, b: SimplifiedSliders) =>
    (Object.keys(a) as (keyof SimplifiedSliders)[]).every((k) => a[k] === b[k]);

export function evaluateSafety(composite: CompositeRecommendation | null, log: SafetyLogInput | null): SafetyResult {
    if (!composite) {
        return empty("NOT_EVALUATED", [SAFETY_NOT_EVALUATED_NO_COMPOSITE], null);
    }
    if (!composite.authorized || !composite.final || !composite.merge.simplified) {
        return empty("NOT_EVALUATED", [SAFETY_NOT_EVALUATED_UPSTREAM], composite);
    }
    if (!log?.headerPairs.length) {
        return empty("BLOCK", [SAFETY_INPUT_MISSING_HEADERS], composite);
    }
    const current = extractAbsoluteTune(log.headerPairs, GYROFLIGHT_EXTRACT);
    // The composite merged against the logged sliders; Safety must see the same
    // baseline. Nothing is reconstructed: a difference blocks.
    if (!sameSliders(current.sliders, composite.current)) {
        return { ...empty("BLOCK", [SAFETY_INPUT_SLIDERS_DIFFER], composite), current };
    }
    const proposal = proposeAbsoluteTune(
        current,
        composite.merge,
        { blockedReasons: [...composite.blocked], warnings: [...composite.warnings], withWarnings: false },
        GYROFLIGHT_PROPOSE,
    );
    const pipeline = runSafetyPipeline(proposal);
    const status: SafetyStatus =
        pipeline.final.status === "block" ? "BLOCK" : pipeline.final.status === "warn" ? "WARN" : "PASS";
    return {
        status,
        compositeId: composite.id,
        sliders: Object.fromEntries(SLIDER_KEYS.map((k) => [k, composite.final![k]])),
        reportToken: composite.reportToken,
        logIndex: composite.logIndex,
        firmwareRevision: log.firmwareRevision,
        blocks: [...pipeline.final.blocked_reasons],
        warnings: [...pipeline.final.warnings],
        checks: [...pipeline.mechanical.checks, ...pipeline.candidate.checks],
        currentSliders: current.sliders,
        proposedSliders: composite.merge.simplified,
        current,
        proposed: proposal.proposed,
        deltas: proposal.deltas,
        analysisEvidence: "not_available",
        pipeline,
        // The reference treats WARN as preview only; only PASS may authorize.
        authorized: status === "PASS",
    };
}
