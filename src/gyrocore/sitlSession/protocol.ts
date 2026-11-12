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
 * The AutoTune session's pre-registered numbers (block 14, protocol session_v1; SITL only). The same values are in
 * scripts/sim/e2e/protocols/session_protocol_v1.json, committed before the final runs; a test checks they agree.
 */

export const SESSION_PROTOCOL = Object.freeze({
    version: "session_v1",
    axes: ["roll", "pitch"] as const,
    targets: { pmDeg: 45, gmDb: 6, sDb: 6 },
    /** One shortfall unit per target (the prediction tolerances of the earlier proofs). */
    tolerance: { pmDeg: 5, gmDb: 1.5, sDb: 1 },
    measurement: {
        runs: 3,
        /** Step block of every run (scripts/sim/session/schedule.py). */
        stepAmplitudeDps: 100,
        stepHalfTicks: 10,
        stepGapTicks: 60,
        /** Acro lead before the block and tail after it, cut from the hover samples with the CHIRP guard. */
        acroLeadS: 0.6,
        acroTailS: 0.2,
        chirpGuardS: 0.5,
        hoverMinRunS: 1.0,
        motorBandHz: [100, 500] as [number, number],
    },
    validity: {
        pmSpreadDeg: 1,
        sSpreadDb: 0.3,
        fcSpreadRel: 0.02,
        motorSpreadRel: 0.15,
        trackingSpreadRel: 0.05,
        minHoverSamples: 3072,
        maxAbsAttitudeDeg: 45,
        minZ: 0.3,
        gmBandHz: [5, 85] as [number, number],
        gmMaxSigmaDb: 1.5,
    },
    guards: {
        motorMaxRatio: 1.1,
        overshootAbs: 0.02,
        trackingRel: 1.05,
        riseRel: 1.15,
        riseAbsMs: 2,
        fcMinRel: 0.9,
        oscillationMax: 0.08,
        sMaxDb: 10,
    },
    improvement: { v1MinShortfallDrop: 0.5, v2MarginUncertainties: 2 },
    policy: {
        rhoStart: 0.2,
        rhoMax: 0.2,
        rhoFloor: 0.05,
        predictedMinShortfallDrop: 0.5,
        /** Selection margin on the predicted crossover (G5 is 0.9; the engine's fc prediction error was 1–2 %). */
        predictedFcMinRel: 0.92,
        exclusionRadiusShare: 0.5,
        maxTrialSteps: 5,
        maxRuns: 18,
        maxConsecutiveInvalid: 2,
    },
});

export type SessionAxis = (typeof SESSION_PROTOCOL.axes)[number];
