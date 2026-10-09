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
 * GyroCore safety check around Betaflight's recommendGains() output. The
 * recommendation math is Betaflight's and is not changed here.
 *
 * buildProposedSliders() clamps every slider to 25..250 after scaling. WU1
 * (AIR65) showed a requested feed-forward cut (15 -> 8..12) leaving the clamp
 * as 25: a +67 % increase, shown with no warning. This guard reconstructs the
 * value each slider was asked to take, compares direction and size with what
 * the clamp produced, and blocks Apply when they disagree.
 */

import type { CurrentSliders, GainRecommendation } from "@/js/blackbox/spectral_analysis";

export const SLIDER_MIN = 25;
export const SLIDER_MAX = 250;
/** A clamp that moves a slider further than this from its requested value changes the recommendation. */
export const MATERIAL_CLAMP_POINTS = 5;

export type ProposedSliderKey = keyof GainRecommendation["proposed"];
export type Direction = "increase" | "decrease" | "hold";

export interface SliderTranslation {
    slider: ProposedSliderKey;
    current: number;
    scale: number;
    /** current * scale * 100 before the 25..250 clamp and rounding. */
    requested: number;
    proposed: number;
    clampedBySliderLimit: boolean;
    requestedDirection: Direction;
    proposedDirection: Direction;
    directionChanged: boolean;
    /** Blocking code, or null when the proposal carries the request faithfully. */
    reason: string | null;
}

export interface RecommendationGuard {
    blocked: string[];
    warnings: string[];
    sliders: SliderTranslation[];
}

function direction(target: number, current: number, tolerance: number): Direction {
    if (target > current + tolerance) {
        return "increase";
    }
    if (target < current - tolerance) {
        return "decrease";
    }
    return "hold";
}

export function guardRecommendation(
    currentSliders: Required<CurrentSliders>,
    rec: GainRecommendation,
): RecommendationGuard {
    const a = rec.analysis;
    const inputs: [ProposedSliderKey, number, number][] = [
        ["slider_master_multiplier", currentSliders.masterMultiplier, 1],
        ["slider_pi_gain", currentSliders.piGain, a.piScale],
        ["slider_i_gain", currentSliders.iGain, a.iScale],
        ["slider_d_gain", currentSliders.dGain, a.dScale],
        ["slider_feedforward_gain", currentSliders.feedforwardGain, a.ffScale],
        ["slider_dterm_filter_multiplier", currentSliders.dtermFilterMultiplier, a.filterScale],
    ];
    const blocked: string[] = [];
    const warnings: string[] = [];
    const sliders = inputs.map(([slider, cur, scale]): SliderTranslation => {
        const current = cur * 100;
        const requested = current * scale;
        const proposed = rec.proposed[slider];
        const clampedBySliderLimit = requested < SLIDER_MIN || requested > SLIDER_MAX;
        // Rounding to an integer slider is not a change of intent.
        const requestedDirection = direction(requested, current, 0.5);
        const proposedDirection = direction(proposed, Math.round(current), 0);
        const directionChanged = requestedDirection !== proposedDirection;
        let reason: string | null = null;
        if (![current, scale, requested, proposed].every(Number.isFinite)) {
            reason = `slider_non_finite:${slider}`;
        } else if (directionChanged) {
            reason = `slider_clamp_changes_direction:${slider}`;
        } else if (Math.abs(proposed - requested) > MATERIAL_CLAMP_POINTS) {
            reason = `slider_clamp_material:${slider}`;
        }
        if (reason) {
            blocked.push(reason);
        } else if (clampedBySliderLimit) {
            warnings.push(`slider_clamped:${slider}`);
        }
        return {
            slider,
            current,
            scale,
            requested,
            proposed,
            clampedBySliderLimit,
            requestedDirection,
            proposedDirection,
            directionChanged,
            reason,
        };
    });

    // Betaflight's own flags: a craft no slider value can make robust is not a
    // safe target for an automatic change; the others are reported.
    if (a.sensitivityUnreachable) {
        blocked.push("autotune_sensitivity_bound_unreachable");
    } else if (a.sensitivityBinds) {
        warnings.push("autotune_sensitivity_bound_binds");
    }
    if (!Number.isFinite(a.targetCrossoverHz)) {
        warnings.push("autotune_target_margin_unreachable_gain_held");
    }
    if (!Number.isFinite(a.openLoopCrossoverHz)) {
        warnings.push("autotune_no_open_loop_crossover");
    }
    if (a.gainClamped) {
        warnings.push("autotune_gain_clamped_per_pass");
    }
    return { blocked, warnings, sliders };
}
