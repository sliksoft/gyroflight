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
 * Axis-coverage authorization: a Gyroflight rule applied AFTER GyroCore's
 * merge, which itself requires no axis (merge.ts is unchanged).
 *
 * The sliders are global: the firmware recomputes the PIDs of every axis the
 * simplified PID mode covers. Betaflight firmware (master 4fc1520c),
 * config/simplified_tuning.h pidSimplifiedTuningMode_e: OFF = 0, RP = 1,
 * RPY = 2; config/simplified_tuning.c calculateNewPidValues loops
 * `for (axis = FD_ROLL; axis <= simplified_pids_mode; ++axis)`, so RP drives
 * roll and pitch, RPY roll, pitch and yaw, OFF none. A global tune may be
 * applied only when a qualified, selected measurement covers each of those
 * axes. Merge validity is not apply authorization.
 *
 * An axis is covered only by a source that takes part in the merge: never by
 * a rejected sweep, an unselected repeat, an axis-gated sweep or another axis.
 */

import { AXIS_NAMES, type ChirpAxisName } from "@/gyrocore/chirp/constants";
import type { CompositeSource } from "./composite";

export type PidsModeName = "OFF" | "RP" | "RPY" | "UNKNOWN";

export interface AxisCoverage {
    /** The simplified PID mode the decision used (logged, or live at Apply). */
    pidsMode: number | null;
    modeName: PidsModeName;
    requiredAxes: ChirpAxisName[];
    coveredAxes: ChirpAxisName[];
    missingAxes: ChirpAxisName[];
    /** The selected measurement covering each covered axis. */
    sourceByAxis: Partial<Record<ChirpAxisName, string>>;
    blocked: string[];
}

export function pidsModeName(mode: number | null | undefined): PidsModeName {
    return mode === 0 ? "OFF" : mode === 1 ? "RP" : mode === 2 ? "RPY" : "UNKNOWN";
}

/** Axes whose PIDs the firmware derives from the sliders in this mode; null when Apply cannot be authorized at all. */
export function requiredAxesForMode(mode: number | null | undefined): ChirpAxisName[] | null {
    return mode === 1 || mode === 2 ? AXIS_NAMES.slice(0, mode + 1) : null;
}

export function axisCoverage(mode: number | null | undefined, sources: CompositeSource[]): AxisCoverage {
    const modeName = pidsModeName(mode);
    const required = requiredAxesForMode(mode);
    const sourceByAxis: AxisCoverage["sourceByAxis"] = {};
    for (const s of sources) {
        if (s.role === "participating" && required?.includes(s.axisName)) {
            sourceByAxis[s.axisName] = s.measurementId;
        }
    }
    const requiredAxes = required ?? [];
    const coveredAxes = requiredAxes.filter((a) => sourceByAxis[a] !== undefined);
    const missingAxes = requiredAxes.filter((a) => sourceByAxis[a] === undefined);
    const blocked =
        required === null
            ? [modeName === "OFF" ? "axis_coverage_mode_off" : "axis_coverage_mode_unknown"]
            : missingAxes.map((a) => `missing_axis_evidence:${a}`);
    return {
        pidsMode: mode ?? null,
        modeName,
        requiredAxes,
        coveredAxes,
        missingAxes,
        sourceByAxis,
        blocked,
    };
}
