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
 * Text for the global (composite) recommendation's reason codes. Codes that
 * come from a source measurement are described with that measurement's values.
 */

import { i18n } from "@/js/localization";
import { describeReason } from "@/gyrocore/chirp/reasons";
import type { ChirpMeasurement } from "@/gyrocore/chirp/qualification";

function message(key: string, args: string[], fallback: string): string {
    const text = i18n.getMessage(key, args);
    return text && text !== key ? text : fallback;
}

const COMPOSITE_HEADS = [
    "unresolved_merge_requires_review",
    "slider_disagreement",
    "no_participating_axes",
    "system_id_unusable",
    "repeated_axis_requires_selection",
    "axis_excluded",
    "rejected_repeat_not_used",
    "proposed_pid_sliders_incomplete",
    "proposed_dterm_sliders_incomplete",
    "proposed_sliders_outside_cli_minmax",
    "dterm_filter_off_multiplier_has_no_effect",
    "composite_clamp_changes_direction",
    "composite_clamp_material",
    "composite_slider_unverifiable",
    "missing_axis_evidence",
    "axis_coverage_mode_off",
    "axis_coverage_mode_unknown",
    "apply",
    "fc",
];

/**
 * One composite code as a sentence. `m` is the source measurement when the code is one of its own
 * gate codes (`measurement:*`, `sample_rate_contract:*`), so the sentence carries its values.
 */
export function describeCompositeReason(code: string, m?: ChirpMeasurement | null): string {
    const colon = code.indexOf(":");
    const head = colon >= 0 ? code.slice(0, colon) : code;
    const tail = colon >= 0 ? code.slice(colon + 1) : "";
    if (head === "apply" || head === "fc") {
        const sub = tail.includes(":") ? tail.slice(0, tail.indexOf(":")) : tail;
        const arg = tail.includes(":") ? tail.slice(tail.indexOf(":") + 1) : "";
        return message(`gyrocoreReason_${head}_${sub}`, [arg], describeReason(code));
    }
    if (COMPOSITE_HEADS.includes(head)) {
        // The merge also lists the bare code (GyroCore safety/output.py) ahead of one entry per measurement.
        if (head === "system_id_unusable" && !tail) {
            return message("gyrocoreGlobal_system_id_unusable_any", [], code);
        }
        return message(`gyrocoreGlobal_${head}`, [tail], code);
    }
    // A source measurement's own code; axis-prefixed warnings keep their axis.
    const axisPrefix = /^(roll|pitch|yaw):(.*)$/.exec(code);
    return axisPrefix ? `${axisPrefix[1]}: ${describeReason(axisPrefix[2], m)}` : describeReason(code, m);
}

const MEASUREMENT_CODE = /^(measurement|sample_rate_contract|recommendation):/;

/**
 * A composite's blocked or warning list. composite.ts lists each failed measurement as
 * `system_id_unusable:<id>` followed by that measurement's own gate codes, so those codes are
 * described with its values (looked up by id) instead of "--".
 */
export function describeCompositeReasons(
    codes: readonly string[],
    measurementById?: (id: string) => ChirpMeasurement | null | undefined,
): string[] {
    let source: ChirpMeasurement | null = null;
    return codes.map((code) => {
        if (code.startsWith("system_id_unusable:")) {
            source = measurementById?.(code.slice("system_id_unusable:".length)) ?? null;
        } else if (!MEASUREMENT_CODE.test(code)) {
            source = null;
        }
        return describeCompositeReason(code, source);
    });
}
