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
 * SIMULATION ONLY: a declared resolution-convergence verdict (loopModel ResolutionConvergence) for
 * contract tests that build an AxisLoop directly from an analytic transfer function and are about
 * something else than the resolution (uncertainty, the release gate, the band end). A real
 * measurement gets its verdict from adaptiveResolution.resolutionConvergence on two analyses of the
 * same samples (autotuneV2). This is test input, never evidence about any flight.
 */

import type { ResolutionConvergence } from "../../../src/gyrocore/engine/loopModel";

/** A CONVERGED verdict for an analytic grid of `binSpacingHz` (checked against twice the segment). */
export function declaredConvergence(binSpacingHz = 0.5, sampleRateHz = 4000): ResolutionConvergence {
    const segment = Math.round(sampleRateHz / binSpacingHz);
    return {
        status: "CONVERGED",
        usedSegmentSamples: segment,
        usedBinSpacingHz: binSpacingHz,
        effectiveResolutionHz: 1.5 * binSpacingHz,
        checkedAgainstSegmentSamples: 2 * segment,
        deltaCrossoverPct: 0,
        deltaPhaseMarginDeg: 0,
        phaseMarginSigmaDeg: 0,
        reasons: [],
    };
}
