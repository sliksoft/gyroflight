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
 * GyroCore global-slider merge, ported line for line from GyroCore
 * core/gyrocore/autotune/merge.py (merge_autotune_sliders, policy
 * gyrocore.autotune.global_slider.merge.v1) at d2e60f7. Not Betaflight
 * behaviour: upstream Autotune applies one selected axis with no merge.
 *
 * Rule: the six Autotune slider integers of every participating (not blocked)
 * axis must be identical. Then they are the global set; any disagreement is
 * MERGE_REQUIRES_REVIEW. No averaging, min/max, weighting or tolerance. No
 * axis is required; one participating axis "matches upstream apply". Sliders
 * Autotune never proposes keep their current values. Clamping (25..250) and
 * rounding happen before, in Betaflight's buildProposedSliders.
 *
 * The output mirrors GlobalSliderMerge.to_dict() key for key, so it is
 * compared with the Python reference directly (global_merge_parity.test.ts).
 */

export const POLICY_ID = "gyrocore.autotune.global_slider.merge.v1";
export const POLICY_KIND = "gyrocore";
export const MERGE_REQUIRES_REVIEW = "MERGE_REQUIRES_REVIEW";

/** recommend.py SLIDER_KEYS order (the Autotune proposal keys). */
export const SLIDER_KEYS = [
    "slider_master_multiplier",
    "slider_pi_gain",
    "slider_i_gain",
    "slider_d_gain",
    "slider_feedforward_gain",
    "slider_dterm_filter_multiplier",
] as const;
export type SliderKey = (typeof SLIDER_KEYS)[number];

const AXIS_ORDER = ["roll", "pitch", "yaw"] as const;
export type MergeAxisName = (typeof AXIS_ORDER)[number];

/** Firmware simplified sliders (gyrocore.betaflight.simplified_tuning.SimplifiedSliders); null = not supplied. */
export interface SimplifiedSliders {
    pids_mode: number | null;
    master_multiplier: number | null;
    i_gain: number | null;
    d_gain: number | null;
    pi_gain: number | null;
    d_max_gain: number | null;
    feedforward_gain: number | null;
    pitch_d_gain: number | null;
    pitch_pi_gain: number | null;
    dterm_filter: number | null;
    dterm_filter_multiplier: number | null;
    gyro_filter: number | null;
    gyro_filter_multiplier: number | null;
}

/** One axis as the merge sees it (engine.AxisRecommendation: axis, blocked, proposed_sliders_unvalidated). */
export interface MergeAxisInput {
    axis: number;
    blocked: boolean;
    proposed: Readonly<Record<string, number>> | null;
}

export interface SliderMergeField {
    key: SliderKey;
    values_by_axis: Partial<Record<MergeAxisName, number>>;
    agreed: boolean;
    chosen: number | null;
    constrained_by: MergeAxisName[];
    reason: string;
}

export interface GlobalSliderMerge {
    status: "merged" | typeof MERGE_REQUIRES_REVIEW;
    policy_id: string;
    policy_kind: string;
    upstream_or_gyrocore: "gyrocore";
    participating_axes: MergeAxisName[];
    fields: Partial<Record<SliderKey, SliderMergeField>>;
    proposed_sliders: Record<SliderKey, number> | null;
    simplified: SimplifiedSliders | null;
    review_reasons: string[];
    notes: string[];
}

export const MERGE_NOTES = [
    "GyroCore merge; upstream Autotune applies one selected axis with no merge.",
    "Autotune does not propose d_max / pitch_pi / pitch_d / gyro-filter sliders; those stay at current.",
];

/** Python int(): truncates; raises on NaN/inf (ValueError/OverflowError). */
function pyInt(v: number): number {
    if (!Number.isFinite(v)) {
        throw new Error(`ValueError: cannot convert ${v} to integer`);
    }
    return Math.trunc(v);
}

function axisProposals(axes: readonly MergeAxisInput[]): Map<MergeAxisName, Readonly<Record<string, number>>> {
    const out = new Map<MergeAxisName, Readonly<Record<string, number>>>();
    for (const rec of axes) {
        if (rec.blocked || rec.proposed === null) {
            continue;
        }
        // proposed_sliders_unvalidated: {k: int(v)}
        const p: Record<string, number> = {};
        for (const [k, v] of Object.entries(rec.proposed)) {
            p[k] = pyInt(v);
        }
        out.set(AXIS_ORDER[rec.axis], p);
    }
    return out;
}

function result(partial: Partial<GlobalSliderMerge> & Pick<GlobalSliderMerge, "status">): GlobalSliderMerge {
    return {
        policy_id: POLICY_ID,
        policy_kind: POLICY_KIND,
        upstream_or_gyrocore: "gyrocore",
        participating_axes: [],
        fields: {},
        proposed_sliders: null,
        simplified: null,
        review_reasons: [],
        notes: [...MERGE_NOTES],
        ...partial,
    };
}

/** Resolve per-axis Autotune slider integers into one global set, or review. */
export function mergeAutotuneSliders(axes: readonly MergeAxisInput[], current: SimplifiedSliders): GlobalSliderMerge {
    const proposals = axisProposals(axes);
    if (proposals.size === 0) {
        return result({ status: MERGE_REQUIRES_REVIEW, review_reasons: ["no_participating_axes"] });
    }

    const names = AXIS_ORDER.filter((a) => proposals.has(a));
    const fields: Partial<Record<SliderKey, SliderMergeField>> = {};
    const disagreements: SliderKey[] = [];
    const chosen: Partial<Record<SliderKey, number>> = {};

    for (const key of SLIDER_KEYS) {
        const values: Partial<Record<MergeAxisName, number>> = {};
        for (const axis of names) {
            const v = proposals.get(axis)?.[key];
            if (v === undefined) {
                throw new Error(`KeyError: ${key}`);
            }
            values[axis] = v;
        }
        const unique = [...new Set(Object.values(values))].sort((a, b) => a - b);
        if (unique.length === 1) {
            fields[key] = {
                key,
                values_by_axis: values,
                agreed: true,
                chosen: unique[0],
                constrained_by: [...names],
                reason: names.length > 1 ? "unanimous" : "single_axis_matches_upstream_apply",
            };
            chosen[key] = unique[0];
        } else {
            fields[key] = {
                key,
                values_by_axis: values,
                agreed: false,
                chosen: null,
                constrained_by: [],
                reason: MERGE_REQUIRES_REVIEW,
            };
            disagreements.push(key);
        }
    }

    if (disagreements.length) {
        return result({
            status: MERGE_REQUIRES_REVIEW,
            participating_axes: [...names],
            fields,
            review_reasons: disagreements.map((k) => `slider_disagreement:${k}`),
        });
    }

    const proposed = chosen as Record<SliderKey, number>;
    return result({
        status: "merged",
        participating_axes: [...names],
        fields,
        proposed_sliders: proposed,
        simplified: {
            pids_mode: current.pids_mode,
            master_multiplier: proposed.slider_master_multiplier,
            i_gain: proposed.slider_i_gain,
            d_gain: proposed.slider_d_gain,
            pi_gain: proposed.slider_pi_gain,
            d_max_gain: current.d_max_gain,
            feedforward_gain: proposed.slider_feedforward_gain,
            pitch_d_gain: current.pitch_d_gain,
            pitch_pi_gain: current.pitch_pi_gain,
            dterm_filter: current.dterm_filter,
            dterm_filter_multiplier: proposed.slider_dterm_filter_multiplier,
            gyro_filter: current.gyro_filter,
            gyro_filter_multiplier: current.gyro_filter_multiplier,
        },
    });
}
