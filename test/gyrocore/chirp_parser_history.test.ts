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
 * CHARACTERIZATION OF A KNOWN UPSTREAM BUG (WU1, docs/gyrocore/BLACKBOX_CHIRP_PARITY.md).
 *
 * After an I-frame the firmware encoder sets both prediction-history slots to
 * that I-frame (blackbox.c writeIntraframe). The Blackbox Viewer parser and
 * blackbox_decode do the same. Autotune's own decoder (chirp_bbl_parser.ts,
 * handleIFrame) instead keeps the previous P-frame as "previous2", so every
 * AVERAGE_2- or STRAIGHT_LINE-predicted field (gyroADC in real logs) is
 * mis-decoded from the first P-frame after an I-frame until the next one.
 * On the real AIR65 flight this changes ~38 % of gyro samples by up to 49 °/s.
 *
 * This test pins the current upstream behaviour. When upstream fixes it, the
 * "Autotune parser" expectation flips: replace it with the Viewer values and
 * update BLACKBOX_CHIRP_PARITY.md and MIGRATION_MAP.md.
 */

import { describe, expect, it } from "vitest";
import { findLogBoundaries, parseChirpLog } from "../../src/js/blackbox/chirp_bbl_parser";
import { CHIRP_FLAG, encodeLog } from "./harness/bblWriter";
import type { SyntheticFrame } from "./harness/bblWriter";
import { decodeWithViewer } from "./harness/viewerDecode";

const I_INTERVAL = 4;
const frames: SyntheticFrame[] = Array.from({ length: 12 }, (_, n) => ({
    time: 1_000_000 + n * 1000,
    setpoint: [100 + n, 0, 0],
    // A curving signal, so the average of two different predecessors is not the I-frame value.
    gyro: [10 * n * n, -7 * n * n, 3 * n],
    debug: [0, 0, 0, 0],
}));
const truth = frames.map((f) => f.gyro[0]);

/** The values Autotune's parser reconstructs: its history keeps the old P-frame after an I-frame. */
function autotuneParserReconstruction() {
    const decoded: number[] = [];
    let prev = Number.NaN;
    let prev2: number | null = null;
    frames.forEach((_, n) => {
        if (n % I_INTERVAL === 0) {
            prev2 = Number.isNaN(prev) ? null : prev;
            prev = truth[n];
            decoded.push(prev);
            return;
        }
        const firmwarePrev = truth[n - 1];
        const firmwarePrev2 = (n - 1) % I_INTERVAL === 0 ? truth[n - 1] : truth[n - 2];
        const residual = truth[n] - Math.trunc((firmwarePrev + firmwarePrev2) / 2);
        const value = residual + (prev2 === null ? prev : Math.trunc((prev + prev2) / 2));
        prev2 = prev;
        prev = value;
        decoded.push(value);
    });
    return decoded;
}

describe("Autotune parser prediction history after I-frames (known upstream bug)", () => {
    const bytes = encodeLog(frames, { iInterval: I_INTERVAL, flightModeFlags: CHIRP_FLAG });

    it("Blackbox Viewer parser decodes the firmware encoding exactly", () => {
        const [log] = decodeWithViewer(bytes).logs;
        expect(log.error).toBeNull();
        expect(log.validI + log.validP).toBe(frames.length);
        const gyroIdx = log.mainFieldNames.indexOf("gyroADC[0]");
        expect(log.rows.map((row) => row[gyroIdx])).toEqual(truth);
    });

    it("Autotune parser mis-decodes AVERAGE_2 fields after every I-frame but the first", () => {
        const [boundary] = findLogBoundaries(bytes);
        const { chirpData } = parseChirpLog(bytes, boundary.start, boundary.end, "1.49.0");
        expect(chirpData.totalFrames).toBe(frames.length);
        expect(chirpData.corruptFrames).toBe(0);
        expect(Array.from(chirpData.setpoint[0])).toEqual(frames.map((f) => f.setpoint[0]));

        const decoded = Array.from(chirpData.gyro[0]);
        const expectedBug = autotuneParserReconstruction();
        expect(decoded).toEqual(expectedBug);
        // Correct through the first I-interval, wrong from the first P-frame after the second I-frame.
        expect(decoded.slice(0, I_INTERVAL + 1)).toEqual(truth.slice(0, I_INTERVAL + 1));
        expect(decoded[I_INTERVAL + 1]).not.toBe(truth[I_INTERVAL + 1]);
    });
});
