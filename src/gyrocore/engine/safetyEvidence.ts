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
 * Safety analysis evidence for absolute proposals (plan V2-B).
 *
 * Every field is required; a missing one is a reason, never a default (SAFETY_ENGINE.md:
 * no fail-open). Each comes from a measurement Gyroflight already qualifies. Only when all
 * pass is the evidence "available"; GyroCore Safety's slider path is not touched.
 */

export type AxisName = "roll" | "pitch" | "yaw";

export interface SafetyEvidenceInputs {
    /** CHIRP qualification state per changed axis (chirp/qualification.ts). */
    measurementState: Partial<Record<AxisName, string | null>>;
    /** Plant coherence at the predicted crossover per changed axis. */
    coherenceAtCrossover: Partial<Record<AxisName, number | null>>;
    chainValidated: Partial<Record<AxisName, boolean>>;
    dtermValidated: Partial<Record<AxisName, boolean>>;
    /** M3 cross-log plant reproducibility per changed axis (assessCrossLogPlantReproducibility). */
    crossLogPlant: Partial<Record<AxisName, string | null>>;
    /** Share of in-flight samples with a motor at its output limit; null when motors were not logged. */
    motorSaturationFraction: number | null;
    /** M4 gyro noise floor present for every axis. */
    noiseFloorKnown: boolean;
}

export const SAFETY_EVIDENCE_LIMITS = Object.freeze({
    minCoherence: 0.9,
    maxMotorSaturation: 0.01,
});

export function absoluteSafetyEvidence(
    i: SafetyEvidenceInputs,
    axes: readonly AxisName[],
    dtermInvolved: boolean,
): { analysisEvidence: "available" | "not_available"; reasons: string[] } {
    const reasons: string[] = [];
    for (const a of axes) {
        const state = i.measurementState[a];
        if (state !== "usable") reasons.push(`chirp_measurement_${state ?? "missing"}:${a}`);
        const coh = i.coherenceAtCrossover[a];
        if (coh === null || coh === undefined) reasons.push(`coherence_at_crossover_unknown:${a}`);
        else if (coh < SAFETY_EVIDENCE_LIMITS.minCoherence)
            reasons.push(`coherence_at_crossover_low:${a}:${coh.toFixed(2)}`);
        if (!i.chainValidated[a]) reasons.push(`gyro_chain_not_validated:${a}`);
        if (dtermInvolved && a !== "yaw" && !i.dtermValidated[a]) reasons.push(`dterm_path_not_validated:${a}`);
        const xl = i.crossLogPlant[a];
        if (xl !== "PASS") reasons.push(`cross_log_plant_${(xl ?? "untested").toLowerCase()}:${a}`);
    }
    if (i.motorSaturationFraction === null) reasons.push("motor_saturation_unknown");
    else if (i.motorSaturationFraction > SAFETY_EVIDENCE_LIMITS.maxMotorSaturation) {
        reasons.push(`motor_saturation_high:${(i.motorSaturationFraction * 100).toFixed(1)}%`);
    }
    if (!i.noiseFloorKnown) reasons.push("noise_floor_unknown");
    if (!axes.length) reasons.push("no_axis_in_scope");
    return { analysisEvidence: reasons.length ? "not_available" : "available", reasons };
}
