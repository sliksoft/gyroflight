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
 * SIMULATION ONLY. Synthetic margin evidence for checking the release contract's software logic
 * (loopModel MarginEvidence / releaseContract). It describes no real flight, no real craft and
 * is never AIR65 or any other hardware evidence.
 */

import { RESOLVED_FEATURE_BINS, type MarginEvidence } from "../../../src/gyrocore/engine/loopModel";
import { declaredConvergence } from "./resolutionConvergence";

export const SIMULATED_QUALIFICATION_SHA = "5".repeat(64);

/** A VALIDATED evidence record whose (simulated) qualification measured exactly these margins. */
export function simulatedQualifiedEvidence(pm: number, gm: number, s: number, resolutionHz = 0.5): MarginEvidence {
    const fine = resolutionHz / 5;
    return {
        level: "VALIDATED",
        resolutionHz,
        bandHz: [1, 100],
        minFeatureWidthHz: RESOLVED_FEATURE_BINS * resolutionHz,
        assumptions: ["simulation_only_not_flight_evidence"],
        // The bounds include a (simulated) measurement uncertainty, as the release contract requires.
        uncertainty: {
            coverage: 2,
            averages: [1, 1],
            maxRelErr: 0.01,
            nominal: { phaseMarginDeg: pm, gainMarginDb: gm, sensitivityPeakDb: s },
        },
        // The (simulated) analysis is declared converged in resolution, as the release contract requires.
        convergence: declaredConvergence(resolutionHz),
        qualification: {
            source: { sha256: SIMULATED_QUALIFICATION_SHA, logIndex: 0 },
            resolutionHz: fine,
            // QUALIFICATION_BAND_EXTENSION × the band end and more (audit P1-2).
            bandHz: [1, 160],
            verdict: "PASS",
            phaseMarginDeg: pm,
            gainMarginDb: gm,
            sensitivityPeakDb: s,
            reasons: [],
        },
    };
}
