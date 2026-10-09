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
 * store by hand: one measurement on each of roll, pitch and yaw, all with the
 * same proposal and clean evidence (or carrying the given block codes), in a
 * log with a complete logged slider tune at 100, slider mode RPY. The sliders
 * drive all three axes there, so each needs its own evidence (axis coverage).
 * Only the fields the gates and views read. Its global (composite)
 * recommendation is the proposal, authorized when `blocked` is empty.
 */

import type { GainRecommendation } from "../../../src/js/blackbox/spectral_analysis";
import type { QualifiedReport } from "../../../src/gyrocore/stores/chirpQualification";

/** Betaflight 2026.6.2 header lines for that tune (blackbox.c writeHeader names). */
const BF_HEADER_PAIRS: [string, string][] = [
    ["Firmware revision", "Betaflight 2026.6.2 (seeded) STM32F7X2"],
    ["rollPID", "45,80,30"],
    ["pitchPID", "47,84,34"],
    ["yawPID", "45,80,0"],
    ["d_max", "40,46,0"],
    ["ff_weight", "120,125,120"],
    ["dterm_lpf1_static_hz", "75"],
    ["dterm_lpf1_dyn_hz", "75,150"],
    ["dterm_lpf2_static_hz", "150"],
    ["gyro_lpf1_static_hz", "250"],
    ["gyro_lpf1_dyn_hz", "250,500"],
    ["gyro_lpf2_static_hz", "500"],
    ["simplified_pids_mode", "2"],
    ["simplified_master_multiplier", "100"],
    ["simplified_i_gain", "100"],
    ["simplified_d_gain", "100"],
    ["simplified_pi_gain", "100"],
    ["simplified_d_max_gain", "100"],
    ["simplified_feedforward_gain", "100"],
    ["simplified_pitch_d_gain", "100"],
    ["simplified_pitch_pi_gain", "100"],
    ["simplified_dterm_filter", "1"],
    ["simplified_dterm_filter_multiplier", "100"],
    ["simplified_gyro_filter", "1"],
    ["simplified_gyro_filter_multiplier", "100"],
];

export function qualifiedReportFor(proposed: GainRecommendation["proposed"], blocked: string[] = []): QualifiedReport {
    const measurements = (["roll", "pitch", "yaw"] as const).map((axisName, axis) => ({
        id: `log1-seg${axis + 1}`,
        logIndex: 0,
        segmentIndex: axis,
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
            guard: {
                blocked: [],
                warnings: [],
                sliders: Object.entries(proposed).map(([slider, value]) => ({ slider, requested: value })),
            },
        },
        tune: { blocked: [], warnings: [] },
        apply: { allowed: blocked.length === 0, blocked, warnings: [] },
    }));
    return {
        token: "seeded",
        filename: "seeded.bbl",
        decoder: "betaflight-blackbox-viewer",
        logCount: 1,
        logs: [
            {
                logIndex: 0,
                error: null,
                firmwareRevision: "seeded",
                loggedSliders: {
                    pids_mode: 2,
                    master_multiplier: 100,
                    i_gain: 100,
                    d_gain: 100,
                    pi_gain: 100,
                    d_max_gain: 100,
                    feedforward_gain: 100,
                    pitch_d_gain: 100,
                    pitch_pi_gain: 100,
                    dterm_filter: 1,
                    dterm_filter_multiplier: 100,
                    gyro_filter: 1,
                    gyro_filter_multiplier: 100,
                },
                headerPairs: BF_HEADER_PAIRS,
                measurements,
            },
        ],
        measurements,
        state: "usable",
        targetPhaseMarginDeg: 60,
    } as unknown as QualifiedReport;
}
