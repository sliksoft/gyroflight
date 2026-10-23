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
 * The one write authority for every route that writes a Gyroflight tune proposal to a flight
 * controller (useTuneApply.ts calls it before any MSP and again right before the first SET).
 * The order is the project's: composite → Safety → product lock, then the route's own live
 * readback and live recheck. Every step is recomputed on each call from the stores; nothing a
 * proposal carries is taken as authorization on its own.
 *
 *   slider route   (applyTune)          composite gate, GyroCore Safety, product lock: the three
 *                                       existing assertions, unchanged and in that order.
 *   absolute route (applyAbsoluteTune)  analysis_binding (the proposal is the current analysis's,
 *                                       recomputed at the write point; analysisBinding.ts), the
 *                                       release contract (releaseContract.ts), GyroCore Safety for
 *                                       absolute values (safety/authorize.ts) and the product lock
 *                                       with the Verified Tune this browser holds now
 *                                       (productLock/productApply.ts).
 *
 * Restore (restoreTune, restoreAbsoluteTune) is not a proposal: it puts back a backup of the same
 * craft and is deliberately outside this authority, with its own confirmation and identity checks.
 */

import { ApplyBlockedError } from "@/gyrocore/chirp/applyGate";
import type { ProposedSliders } from "@/composables/useAutotune";
import { assertCompositeApplyAuthorized, type CompositeGateState } from "@/gyrocore/tuning/authorize";
import type { CompositeRecommendation } from "@/gyrocore/tuning/composite";
import { absoluteSafetyAuthorization, assertSafetyAuthorized } from "@/gyrocore/safety/authorize";
import { assertProductApplyReleased, productApplyBlocks } from "@/gyrocore/productLock/productApply";
import { evaluateRelease, type AbsoluteProposal } from "@/gyrocore/releaseGate/releaseContract";
import { analysisBindingIssues, canonicalText, type AnalysisPin } from "@/gyrocore/releaseGate/analysisBinding";
import { loggedAbsoluteValues } from "@/gyrocore/tuning/absoluteTune";
import { logIdentity } from "@/gyrocore/tuning/fcIdentity";
import { useChirpQualificationStore } from "@/gyrocore/stores/chirpQualification";
import { useVerifiedTuneStore } from "@/gyrocore/stores/verifiedTunes";

export type WriteAuthorityStepName = "analysis_binding" | "release_contract" | "gyrocore_safety" | "product_lock";

export interface WriteAuthorityStep {
    name: WriteAuthorityStepName;
    passed: boolean;
    reasons: string[];
}

export interface WriteAuthorityDecision {
    verdict: "APPLY_ALLOWED" | "APPLY_DENIED";
    steps: WriteAuthorityStep[];
    /** Every step's reasons, in step order; empty only when allowed. */
    blocks: string[];
}

/** The slider route: the three existing gates, in order. Throws ApplyBlockedError at the first that blocks. */
export function assertSliderWriteAuthorized(
    proposed: ProposedSliders,
    compositeId: string | null | undefined,
): { gateState: CompositeGateState; composite: CompositeRecommendation } {
    const gateState = useChirpQualificationStore().gateState();
    const composite = assertCompositeApplyAuthorized(gateState, compositeId, proposed);
    const safety = assertSafetyAuthorized(gateState, composite, { ...proposed });
    const log = gateState.report?.logs.find((l) => l.logIndex === composite.logIndex);
    const logged = logIdentity(log?.headerPairs ?? []);
    const loggedFirmware = logged.firmwareRevision?.split(/\s+/)[1] ?? null;
    assertProductApplyReleased({
        safetyAnalysisEvidence: safety.analysisEvidence,
        independentPidValidation: useVerifiedTuneStore().forCraft(logged.uid, loggedFirmware),
        craft: { uid: logged.uid, firmware: loggedFirmware },
    });
    return { gateState, composite };
}

/**
 * Every step for an absolute proposal, each evaluated (so the interface can name all that is
 * missing). `recompute`: run the engine again for the binding step (the write point does);
 * `since`: the analysis the Apply was first authorized against (the rechecks).
 */
export function absoluteWriteDecision(
    proposal: AbsoluteProposal,
    { recompute, since }: { recompute: boolean; since?: AnalysisPin },
): WriteAuthorityDecision {
    const steps: WriteAuthorityStep[] = [];
    // A step that cannot be evaluated (a malformed proposal, a failing store) blocks; it never passes.
    const add = (name: WriteAuthorityStepName, reasons: () => string[]) => {
        let r: string[];
        try {
            r = reasons();
        } catch {
            r = [`${name}:evaluation_failed`];
        }
        steps.push({ name, passed: !r.length, reasons: r });
    };

    add("analysis_binding", () => analysisBindingIssues(proposal, { recompute, since }).map((r) => `binding:${r}`));
    add("release_contract", () => evaluateRelease(proposal).blocks);

    let safetyEvidence = "not_available";
    add("gyrocore_safety", () => {
        const safety = absoluteSafetyAuthorization(proposal);
        // Bound to exactly this proposal and change, as the slider route binds Safety to its sliders.
        const bound =
            safety.proposalId === proposal.id && canonicalText(safety.change) === canonicalText(proposal.change);
        if (safety.authorized && bound) {
            safetyEvidence = safety.analysisEvidence;
            return [];
        }
        if (!bound) return ["safety:result_not_bound_to_proposal"];
        return (safety.blocks.length ? safety.blocks : [`status_${safety.status.toLowerCase()}`]).map(
            (r) => `safety:${r}`,
        );
    });

    add("product_lock", () => {
        const id = logIdentity(proposal.log.headerPairs);
        const firmware = id.firmwareRevision?.split(/\s+/)[1] ?? null;
        return productApplyBlocks({
            safetyAnalysisEvidence: safetyEvidence,
            // The record this browser holds now, never the copy the proposal carries.
            independentPidValidation: useVerifiedTuneStore().forCraft(
                id.uid,
                firmware,
                loggedAbsoluteValues(proposal.log.headerPairs),
            ),
            craft: { uid: id.uid, firmware },
            carriedPidValidation: proposal.release.independentValidation ?? null,
        });
    });

    const blocks = steps.flatMap((s) => s.reasons);
    return { verdict: blocks.length ? "APPLY_DENIED" : "APPLY_ALLOWED", steps, blocks };
}

/** Throws ApplyBlockedError with every step's reasons unless the absolute write is allowed. */
export function assertAbsoluteWriteAuthorized(
    proposal: AbsoluteProposal,
    opts: { recompute: boolean; since?: AnalysisPin },
): void {
    const decision = absoluteWriteDecision(proposal, opts);
    if (decision.verdict !== "APPLY_ALLOWED") {
        throw new ApplyBlockedError(decision.blocks);
    }
}
