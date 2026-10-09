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
 * Apply Gains hard gate, v2: Apply writes one validated COMPOSITE (global)
 * recommendation, never a single axis's. Called by the Apply action itself
 * (useAutotune.applyGains) before any flight-controller access, and again
 * with the craft's live slider state after one read and before any write.
 */

import type { GainRecommendation } from "@/js/blackbox/spectral_analysis";
import { ApplyBlockedError } from "@/gyrocore/chirp/applyGate";
import type { ChirpQualificationReport } from "@/gyrocore/chirp/qualification";
import type { ChirpAxisName } from "@/gyrocore/chirp/constants";
import { buildComposite, type AxisSelection, type CompositeRecommendation } from "./composite";
import { SLIDER_KEYS } from "./merge";

type Proposed = GainRecommendation["proposed"];

export interface CompositeGateState {
    report: ChirpQualificationReport | null;
    logIndex: number | null;
    selection: AxisSelection;
    explicitAxes: Partial<Record<ChirpAxisName, boolean>>;
}

export interface CompositeAuthorization {
    allowed: boolean;
    blocked: string[];
    composite: CompositeRecommendation | null;
}

const MEASUREMENT_ID = /^log\d+-seg\d+$/;

/** The composite for the current state, rebuilt from scratch (never a cached copy). */
export function currentComposite(state: CompositeGateState): CompositeRecommendation | null {
    if (!state.report || state.logIndex === null) {
        return null;
    }
    return buildComposite(state.report, state.logIndex, state.selection, state.explicitAxes);
}

function sameSliders(a: Proposed, b: Proposed): boolean {
    return SLIDER_KEYS.every((k) => a[k] === b[k]) && Object.keys(a).length === SLIDER_KEYS.length;
}

export function authorizeCompositeApply(
    state: CompositeGateState,
    compositeId: string | null | undefined,
    sliders: Proposed | null | undefined,
): CompositeAuthorization {
    const deny = (blocked: string[], composite: CompositeRecommendation | null = null) => ({
        allowed: false,
        blocked,
        composite,
    });
    if (!state.report) {
        return deny(["apply:no_qualified_analysis"]);
    }
    if (!compositeId) {
        return deny(["apply:missing_composite_id"]);
    }
    if (MEASUREMENT_ID.test(compositeId)) {
        return deny(["apply:single_measurement_apply_not_allowed"]);
    }
    const composite = currentComposite(state);
    if (!composite || composite.id !== compositeId) {
        // Another analysis, another log, other sources or a changed recommendation.
        return deny(["apply:stale_composite"], composite);
    }
    if (!composite.authorized || !composite.final) {
        return deny(composite.blocked.length ? composite.blocked : ["apply:composite_not_authorized"], composite);
    }
    if (!sliders || !sameSliders(sliders, composite.final)) {
        return deny(["apply:sliders_differ_from_composite"], composite);
    }
    return { allowed: true, blocked: [], composite };
}

export function assertCompositeApplyAuthorized(
    state: CompositeGateState,
    compositeId: string | null | undefined,
    sliders: Proposed | null | undefined,
): CompositeRecommendation {
    const auth = authorizeCompositeApply(state, compositeId, sliders);
    if (!auth.allowed || !auth.composite) {
        throw new ApplyBlockedError(auth.blocked);
    }
    return auth.composite;
}

/** The parts of FC.TUNING_SLIDERS the live check reads (filled by MSP_SIMPLIFIED_TUNING). */
export interface LiveSliders {
    slider_pids_mode?: number;
    slider_dterm_filter?: number;
    slider_master_multiplier?: number;
    slider_pi_gain?: number;
    slider_i_gain?: number;
    slider_d_gain?: number;
    slider_feedforward_gain?: number;
    slider_dterm_filter_multiplier?: number;
}

/**
 * The craft must still be the one the recommendation was computed for: same
 * slider mode, same current sliders (every proposal scales the logged ones),
 * yaw under slider control when yaw contributed.
 */
export function liveCompositeBlocks(live: LiveSliders, composite: CompositeRecommendation): string[] {
    const out: string[] = [];
    const mode = live.slider_pids_mode;
    if (mode === 0) {
        out.push("fc:simplified_pids_mode_off");
    } else if (mode !== 1 && mode !== 2) {
        out.push("fc:simplified_pids_mode_unknown");
    } else {
        if (mode !== composite.current.pids_mode) {
            out.push("fc:simplified_pids_mode_changed");
        }
        if (mode === 1 && composite.merge.participating_axes.includes("yaw")) {
            out.push("fc:yaw_not_under_slider_control");
        }
    }
    const logged = composite.current;
    const pairs: [keyof LiveSliders, number | null][] = [
        ["slider_master_multiplier", logged.master_multiplier],
        ["slider_pi_gain", logged.pi_gain],
        ["slider_i_gain", logged.i_gain],
        ["slider_d_gain", logged.d_gain],
        ["slider_feedforward_gain", logged.feedforward_gain],
        ["slider_dterm_filter_multiplier", logged.dterm_filter_multiplier],
        ["slider_dterm_filter", logged.dterm_filter],
    ];
    for (const [key, value] of pairs) {
        if (live[key] !== value) {
            out.push(`fc:current_slider_changed:${key}`);
        }
    }
    return out;
}
