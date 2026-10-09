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
 * The Safety step of the Apply authority chain, between the composite gate
 * (tuning/authorize.ts) and the product lock (productLock/productApply.ts).
 * The result is recomputed from the current state on every call and bound to
 * the exact composite id and slider payload, so an earlier or edited result
 * can never be reused. Write-path tests replace this module explicitly
 * (test/gyrocore/harness/safetyRelease.ts); production cannot.
 */

import { ApplyBlockedError } from "@/gyrocore/chirp/applyGate";
import type { CompositeGateState } from "@/gyrocore/tuning/authorize";
import type { CompositeRecommendation } from "@/gyrocore/tuning/composite";
import { SLIDER_KEYS } from "@/gyrocore/tuning/merge";
import { evaluateSafety, type SafetyResult } from "./evaluate";

export function safetyForComposite(state: CompositeGateState, composite: CompositeRecommendation | null): SafetyResult {
    const log = state.report?.logs.find((l) => l.logIndex === composite?.logIndex) ?? null;
    return evaluateSafety(
        composite,
        log ? { headerPairs: log.headerPairs ?? [], firmwareRevision: log.firmwareRevision } : null,
    );
}

/** Throws unless Safety passes for exactly this composite and these sliders. */
export function assertSafetyAuthorized(
    state: CompositeGateState,
    composite: CompositeRecommendation,
    sliders: Record<string, number>,
): SafetyResult {
    const safety = safetyForComposite(state, composite);
    const bound =
        safety.compositeId === composite.id &&
        safety.sliders !== null &&
        SLIDER_KEYS.every((k) => safety.sliders![k] === sliders[k]);
    if (!safety.authorized || !bound) {
        const reasons = safety.blocks.length ? safety.blocks : [`status_${safety.status.toLowerCase()}`];
        throw new ApplyBlockedError(reasons.map((r) => `safety:${r}`));
    }
    return safety;
}
