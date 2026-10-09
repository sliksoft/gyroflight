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
 * A minimal GyroCore qualification report for UI tests that seed the Autotune
 * store by hand: one measurement on one axis, authorized (or blocked) for
 * exactly the given sliders. Only the fields the gate and the views read.
 */

import type { GainRecommendation } from "../../../src/js/blackbox/spectral_analysis";
import type { QualifiedReport } from "../../../src/gyrocore/stores/chirpQualification";

export function qualifiedReportFor(
    axisName: "roll" | "pitch" | "yaw",
    proposed: GainRecommendation["proposed"],
    blocked: string[] = [],
): QualifiedReport {
    const axis = ["roll", "pitch", "yaw"].indexOf(axisName);
    const measurement = {
        id: "log1-seg1",
        logIndex: 0,
        segmentIndex: 0,
        axis,
        axisName,
        axisOccurrence: 1,
        startTimeUs: 0,
        endTimeUs: 1e6,
        durationS: 1,
        sampleCount: 1000,
        sampleRate: { effectiveRateHz: 1000, status: "ok" },
        spacing: { gapCount: 0 },
        betaflightRateHz: 1000,
        segmentSize: 512,
        quality: { usable: true, failedGates: [], warningGates: [], gates: [], meanBandCoherence: 0.99 },
        logWarnings: [],
        state: "usable",
        diagnostics: {},
        recommendation: {
            result: { proposed },
            gains: { proposed },
            guard: { blocked: [], warnings: [], sliders: [] },
        },
        tune: { blocked: [], warnings: [] },
        apply: { allowed: blocked.length === 0, blocked, warnings: [] },
    };
    return {
        filename: "seeded.bbl",
        decoder: "betaflight-blackbox-viewer",
        logCount: 1,
        logs: [{ logIndex: 0, error: null, measurements: [measurement] }],
        measurements: [measurement],
        state: "usable",
        targetPhaseMarginDeg: 60,
    } as unknown as QualifiedReport;
}
