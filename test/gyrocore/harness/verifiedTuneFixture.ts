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
 * Verified Tune records produced by the real producer (buildVerifiedTune) from synthetic
 * CHIRP measurements: a known plant G, a baseline and a candidate controller, and the T each
 * would measure. `truePlantScale` != 1 makes the candidate flight see a different plant than
 * the baseline identified, which is what a wrong prediction looks like.
 */

import {
    air65PitchConfig,
    air65RollConfig,
    evaluateControllerFrf,
    type DigitalControllerConfig,
} from "../../../src/js/blackbox/betaflight_digital_controller";
import {
    closedLoopFromPlant,
    extractPlantFromClosedLoop,
    plantFrf,
    syntheticTransferFunction,
} from "../../../src/js/blackbox/betaflight_open_loop";
import { buildVerifiedTune, type VerifiedTune } from "../../../src/gyrocore/releaseGate/verifiedTune";

export const FIXTURE_UID: [number, number, number] = [0x0a1b2c3d, 0x4e5f6071, 0x12233445];
export const FIXTURE_FIRMWARE = "2026.6.2";
// K = 80: roll crossover near 42 Hz with ~42° PM on the AIR65 roll controller.
const PLANT = { K: 80, motorHz: 40, delayS: 0.002 };
const FREQS = Array.from({ length: 79 }, (_, i) => 2 + i);

/** T a CHIRP would measure; `extraDelayS` is loop delay the controller model does not know about. */
function measured(cfg: DigitalControllerConfig, scale = 1, extraDelayS = 0) {
    return syntheticTransferFunction(FREQS, (f) => {
        const frf = evaluateControllerFrf(cfg, f);
        const G = plantFrf(f, { ...PLANT, K: PLANT.K * scale, delayS: PLANT.delayS + extraDelayS });
        return closedLoopFromPlant(G, frf.cReference, frf.cFeedback);
    });
}

export function verifiedTuneFixture(
    opts: {
        truePlantScale?: number;
        candidateExtraDelayS?: number;
        candidateP?: number;
        sameLog?: boolean;
        firmware?: string;
    } = {},
): VerifiedTune {
    const base = { roll: air65RollConfig(), pitch: air65PitchConfig() };
    const pids = (cfg: DigitalControllerConfig) => ({ p: cfg.axis.p, i: cfg.axis.i, d: cfg.axis.d, f: cfg.axis.f });
    const cand = {
        roll: { ...base.roll, axis: { ...base.roll.axis, p: opts.candidateP ?? Math.round(base.roll.axis.p * 1.3) } },
        pitch: base.pitch,
    };
    const yaw = { p: 56, i: 79, d: 0, f: 22 };
    const plant = extractPlantFromClosedLoop(measured(base.roll), base.roll, { missingFilterInfo: [] });
    return buildVerifiedTune({
        craft: { uid: FIXTURE_UID, board: "BEFH BETAFPVG473", firmware: opts.firmware ?? FIXTURE_FIRMWARE },
        baseline: {
            sha256: "b".repeat(64),
            logIndex: 0,
            pids: { roll: pids(base.roll), pitch: pids(base.pitch), yaw },
        },
        candidate: {
            sha256: opts.sameLog ? "b".repeat(64) : "c".repeat(64),
            logIndex: 0,
            pids: { roll: pids(cand.roll), pitch: pids(cand.pitch), yaw },
        },
        axes: {
            roll: {
                plant,
                baselineCfg: base.roll,
                candidateCfg: cand.roll,
                candidateT: measured(cand.roll, opts.truePlantScale ?? 1, opts.candidateExtraDelayS ?? 0),
            },
        },
        createdAt: "2026-10-22T00:00:00Z",
    });
}
