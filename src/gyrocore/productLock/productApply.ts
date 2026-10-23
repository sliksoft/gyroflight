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
 * Product release procedure for writing a tune to a flight controller.
 *
 * This replaced a constant lock. Writing is released only when every condition
 * below holds; each one is computed from data and named, so a test can satisfy it
 * with real evidence and the interface can say exactly what is missing:
 *
 *  - full_safety_engine_pending: GyroCore Safety has no analysis evidence. Its
 *    evidence stages (mechanical M1-M17, safe-tune clamps) cannot run, and
 *    safety/pipeline.ts blocks every tune with missing_required_analysis. The
 *    code is kept from the old lock because the reason is the same.
 *  - independent_pid_validation_missing: no independent flight has confirmed a
 *    prediction across a known gain change. The producer is
 *    releaseGate/verifiedTune.ts (buildVerifiedTune, from a baseline and a
 *    candidate CHIRP log); the record must pass verifiedTuneIssues for the craft
 *    and firmware being written to.
 *
 * These come on top of, and never replace, the composite gate (including the M2
 * phase-margin block), GyroCore Safety, the user's confirmation, the FC identity
 * check, the backup and the live read-back in useTuneApply.ts.
 *
 * Tests that exercise the write path behind it replace this module with
 * test/gyrocore/harness/productRelease.ts, or pass evidence explicitly.
 */

import { ApplyBlockedError } from "@/gyrocore/chirp/applyGate";
import { verifiedTuneIssues, type VerifiedTune } from "@/gyrocore/releaseGate/verifiedTune";

export const PRODUCT_APPLY_PENDING = "full_safety_engine_pending";
export const RELEASE_INDEPENDENT_VALIDATION_MISSING = "independent_pid_validation_missing";
export const RELEASE_INDEPENDENT_VALIDATION_NOT_CURRENT = "independent_pid_validation_not_current";

export interface ProductReleaseEvidence {
    /** SafetyResult.analysisEvidence: "available" only when Safety ran its evidence stages. */
    safetyAnalysisEvidence: string;
    /** A Verified Tune (releaseGate/verifiedTune.ts): an independent flight that confirmed the prediction. */
    independentPidValidation: VerifiedTune | null;
    /** The craft the write goes to; the record must be about this craft and firmware. */
    craft?: { uid: readonly number[] | null; firmware: string | null };
    /**
     * Absolute route: the record the proposal was calculated with. It must be the one this browser
     * holds now (`independentPidValidation`): a record deleted or replaced since does not count.
     */
    carriedPidValidation?: VerifiedTune | null;
}

/** What production has today: neither kind of evidence. */
export const NO_RELEASE_EVIDENCE: ProductReleaseEvidence = Object.freeze({
    safetyAnalysisEvidence: "not_available",
    independentPidValidation: null,
});

/** Why the product may not write a tune to a craft; empty once every condition holds. */
export function productApplyBlocks(evidence: ProductReleaseEvidence = NO_RELEASE_EVIDENCE): string[] {
    const blocked: string[] = [];
    if (evidence.safetyAnalysisEvidence !== "available") {
        blocked.push(PRODUCT_APPLY_PENDING);
    }
    const record = evidence.independentPidValidation;
    if (!record) {
        blocked.push(RELEASE_INDEPENDENT_VALIDATION_MISSING);
    } else {
        const issues = verifiedTuneIssues(record, evidence.craft ?? { uid: null, firmware: null });
        if (issues.length) {
            blocked.push(
                RELEASE_INDEPENDENT_VALIDATION_MISSING,
                ...issues.filter((r) => r !== RELEASE_INDEPENDENT_VALIDATION_MISSING),
            );
        }
    }
    if (evidence.carriedPidValidation !== undefined && evidence.carriedPidValidation?.id !== record?.id) {
        blocked.push(RELEASE_INDEPENDENT_VALIDATION_NOT_CURRENT);
    }
    return blocked;
}

export function assertProductApplyReleased(evidence: ProductReleaseEvidence = NO_RELEASE_EVIDENCE): void {
    const blocked = productApplyBlocks(evidence);
    if (blocked.length) {
        throw new ApplyBlockedError(blocked);
    }
}
