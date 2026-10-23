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
 * The first step of the absolute write authority (writeAuthority.ts), in the place the composite
 * gate holds for the slider route: the proposal must be the one the current analysis produced.
 *
 * A proposal carries its own release evidence; on its own that evidence proves nothing, since any
 * object of the right shape carries some. So the proposal must equal, field for field, the
 * releasable proposal of the analysis in the store (an older, edited or hand-built proposal
 * differs), and at the write point the engine runs again on the current inputs and the current
 * Verified Tune store (as currentComposite rebuilds the composite: never a cached copy) and must
 * reproduce it.
 */

import { pickPrimary } from "@/gyrocore/engine/logInput";
import { runAutotuneV2, type AutotuneV2Input } from "@/gyrocore/engine/autotuneV2";
import { loggedAbsoluteValues } from "@/gyrocore/tuning/absoluteTune";
import { logIdentity } from "@/gyrocore/tuning/fcIdentity";
import { useAutotuneV2Store } from "@/gyrocore/stores/autotuneV2";
import { useVerifiedTuneStore } from "@/gyrocore/stores/verifiedTunes";
import type { AbsoluteProposal } from "@/gyrocore/releaseGate/releaseContract";

/**
 * The engine input for the decoded logs in the store: the one definition Calculate and the write
 * authority share, so a recomputation sees exactly what the analysis saw. null without inputs or CHIRP.
 */
export function currentAnalysisInput(): AutotuneV2Input | null {
    const inputs = useAutotuneV2Store().inputs;
    const picked = inputs ? pickPrimary(inputs) : null;
    if (!picked) return null;
    const id = logIdentity(picked.primary.headerPairs);
    const firmware = id.firmwareRevision?.split(/\s+/)[1] ?? null;
    return {
        ...picked,
        verifiedTune: useVerifiedTuneStore().forCraft(
            id.uid,
            firmware,
            loggedAbsoluteValues(picked.primary.headerPairs),
        ),
    };
}

/**
 * Exact text of a value: object keys sorted, and undefined, NaN and ±Infinity kept apart from null
 * (JSON.stringify would drop or merge them).
 */
export function canonicalText(value: unknown): string {
    return JSON.stringify(value === undefined ? "\u0000undefined" : value, (_key, v: unknown) => {
        if (v === undefined) return "\u0000undefined";
        if (typeof v === "number" && !Number.isFinite(v)) return `\u0000number:${v}`;
        if (v && typeof v === "object" && !Array.isArray(v)) {
            const o = v as Record<string, unknown>;
            return Object.fromEntries(
                Object.keys(o)
                    .sort()
                    .map((k) => [k, o[k]]),
            );
        }
        return v;
    });
}

/**
 * Why `proposal` is not the current analysis's releasable proposal; empty when it is.
 * `recompute`: run the engine again on the current inputs (the write point); without it the
 * proposal is compared with the stored result only (the interface, and the recheck right before
 * the first SET, which follows a recomputation in the same Apply).
 */
export function analysisBindingIssues(proposal: AbsoluteProposal, { recompute }: { recompute: boolean }): string[] {
    const store = useAutotuneV2Store();
    if (store.state !== "done") return [`analysis_not_done:${store.state}`];
    const current = store.result?.releasableProposal ?? null;
    if (!current) return ["no_releasable_proposal"];
    if (canonicalText(proposal) !== canonicalText(current)) return ["proposal_differs_from_analysis"];
    if (!recompute) return [];
    const input = currentAnalysisInput();
    if (!input) return ["analysis_inputs_missing"];
    let fresh: AbsoluteProposal | null;
    try {
        fresh = runAutotuneV2({ ...input, createdAt: proposal.createdAt }).releasableProposal;
    } catch {
        return ["analysis_recompute_failed"];
    }
    return fresh && canonicalText(fresh) === canonicalText(proposal) ? [] : ["analysis_not_reproduced"];
}
