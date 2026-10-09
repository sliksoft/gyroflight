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
 * Generated CHIRP flights for end-to-end merge parity (WU3): each is run
 * through GyroCore's Python engine + merge (tools/gc_merge_e2e.py) and through
 * Gyroflight's pipeline. Deterministic: the bytes are pinned by sha256 in the
 * reference, so the logs themselves need not be committed.
 */

import { encodeChirpLog, FULL_TUNE_HEADERS, simulateChirpSequence, withHeader } from "./chirpSim";

const GOOD = { crossoverHz: 40, delaySamples: 2, seconds: 8 };
const STIFF = { crossoverHz: 60, delaySamples: 3, seconds: 8 };
const UNSTABLE = { crossoverHz: 80, delaySamples: 4, seconds: 8 };

export const MERGE_E2E_CASES: Record<string, () => Uint8Array> = {
    three_axis_agree: () =>
        encodeChirpLog(
            simulateChirpSequence([
                { ...GOOD, axis: 0 },
                { ...GOOD, axis: 1 },
                { ...GOOD, axis: 2 },
            ]),
        ),
    roll_pitch_conflict: () =>
        encodeChirpLog(
            simulateChirpSequence([
                { ...GOOD, axis: 0 },
                { ...STIFF, axis: 1 },
            ]),
        ),
    rp_mode_yaw_excluded: () =>
        encodeChirpLog(
            simulateChirpSequence([
                { ...GOOD, axis: 0 },
                { ...GOOD, axis: 1 },
                { ...GOOD, axis: 2 },
            ]),
            withHeader(FULL_TUNE_HEADERS, "simplified_pids_mode:1"),
        ),
    single_roll: () => encodeChirpLog(simulateChirpSequence([{ ...GOOD, axis: 0 }])),
    roll_ok_pitch_rejected: () =>
        encodeChirpLog(
            simulateChirpSequence([
                { ...GOOD, axis: 0 },
                { ...UNSTABLE, axis: 1 },
            ]),
        ),
    pids_mode_off: () =>
        encodeChirpLog(
            simulateChirpSequence([
                { ...GOOD, axis: 0 },
                { ...GOOD, axis: 1 },
            ]),
            withHeader(FULL_TUNE_HEADERS, "simplified_pids_mode:0"),
        ),
    ff_floor_three_axis: () =>
        encodeChirpLog(
            simulateChirpSequence([
                { ...STIFF, axis: 0 },
                { ...STIFF, axis: 1 },
                { ...STIFF, axis: 2 },
            ]),
            withHeader(FULL_TUNE_HEADERS, "simplified_feedforward_gain:15"),
        ),
};
