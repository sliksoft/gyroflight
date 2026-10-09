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
 * Current-tune eligibility: can a slider recommendation computed from this log
 * be represented on the craft at all? Port of GyroCore autotune/engine.py
 * `_tune_gates` and current_tune.py (d2e60f7), reading the log's own header.
 *
 * Betaflight's extractCurrentSliders substitutes 100 for a missing, unparseable
 * or zero slider (`|| 100`) and never looks at simplified_pids_mode. With the
 * mode OFF the sliders do not drive the PIDs, so the proposal would not reach
 * the gains it was computed for (WU1, AIR65).
 */

import { SLIDER_HEADER_KEYS, loggedInt, type LoggedHeaders } from "./headers";

/** Betaflight TUNING_SLIDERS_MODE lookup (cli/settings.c). */
export const SIMPLIFIED_PIDS_MODES: Record<number, string> = { 0: "OFF", 1: "RP", 2: "RPY" };

export interface TuneGateResult {
    blocked: string[];
    warnings: string[];
    /** The six slider integers as logged (null where not usable). */
    sliders: Record<(typeof SLIDER_HEADER_KEYS)[number], number | null>;
    simplifiedPidsMode: number | null;
    simplifiedDtermFilter: number | null;
}

export function currentTuneGates(headers: LoggedHeaders, axis: number): TuneGateResult {
    const blocked: string[] = [];
    const warnings: string[] = [];
    const sliders = {} as TuneGateResult["sliders"];
    for (const key of SLIDER_HEADER_KEYS) {
        const name = key.replace("simplified_", "");
        const value = loggedInt(headers, key);
        sliders[key] = value === null || value === 0 ? null : value;
        if (!headers.presentKeys.has(key)) {
            blocked.push(`current_tune_missing:${name}`);
        } else if (value === null) {
            blocked.push(`current_tune_unparseable:${name}`);
        } else if (value === 0) {
            blocked.push(`current_tune_zero:${name}`);
        }
    }
    const mode = headers.presentKeys.has("simplified_pids_mode") ? loggedInt(headers, "simplified_pids_mode") : null;
    if (mode === null || !(mode in SIMPLIFIED_PIDS_MODES)) {
        // GyroCore warns here; a recommendation that assumes sliders cannot be
        // shown to reach the PIDs without knowing the mode, so Apply blocks.
        blocked.push("simplified_pids_mode_unknown");
    } else if (mode === 0) {
        blocked.push("simplified_pids_mode_off");
    } else if (mode === 1 && axis === 2) {
        blocked.push("yaw_not_under_slider_control");
    }
    const dterm = headers.presentKeys.has("simplified_dterm_filter")
        ? loggedInt(headers, "simplified_dterm_filter")
        : null;
    if (dterm === null) {
        warnings.push("simplified_dterm_filter_unknown");
    } else if (dterm === 0) {
        warnings.push("simplified_dterm_filter_off");
    }
    return { blocked, warnings, sliders, simplifiedPidsMode: mode, simplifiedDtermFilter: dterm };
}
