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
 * Minimal blackbox log encoder for synthetic regression logs, written from the
 * firmware encoder (betaflight/betaflight src/main/blackbox/blackbox.c):
 *   - I-frames: every field absolute (predictor 0);
 *   - P-frames: loopIteration INC (6, not written), time STRAIGHT_LINE (2),
 *     setpoint and debug PREVIOUS (1), gyroADC AVERAGE_2 (3), all signed VB;
 *   - after an I-frame both history slots hold the I-frame ("since we have no
 *     other history, we also use it for the 'before, before' state",
 *     blackbox.c writeIntraframe), after a P-frame the history rotates.
 */

export const CHIRP_FLAG = 1 << 6;

const FIELDS = [
    "loopIteration",
    "time",
    "setpoint[0]",
    "setpoint[1]",
    "setpoint[2]",
    "gyroADC[0]",
    "gyroADC[1]",
    "gyroADC[2]",
    "debug[0]",
    "debug[1]",
    "debug[2]",
    "debug[3]",
];
const P_PREDICTOR = [6, 2, 1, 1, 1, 3, 3, 3, 1, 1, 1, 1];

export interface SyntheticFrame {
    time: number;
    setpoint: [number, number, number];
    gyro: [number, number, number];
    debug: [number, number, number, number];
}

function unsignedVB(out: number[], value: number) {
    let v = value >>> 0;
    while (v > 127) {
        out.push((v & 127) | 128);
        v >>>= 7;
    }
    out.push(v);
}

function signedVB(out: number[], value: number) {
    unsignedVB(out, ((value << 1) ^ (value >> 31)) >>> 0);
}

function values(iteration: number, f: SyntheticFrame) {
    return [iteration, f.time, ...f.setpoint, ...f.gyro, ...f.debug];
}

/** One log: header, an S-frame with the given flight-mode flags, then I/P frames, then LOG_END. */
export function encodeLog(frames: SyntheticFrame[], opts: { iInterval: number; flightModeFlags: number }) {
    const n = FIELDS.length;
    const header = [
        "H Product:Blackbox flight data recorder by Nicholas Sherlock",
        "H Data version:2",
        `H I interval:${opts.iInterval}`,
        "H P interval:1/1",
        "H Firmware type:Cleanflight",
        "H Firmware revision:Betaflight 2026.6.2 (synthetic) STM32F7X2",
        "H looptime:125",
        "H pid_process_denom:8",
        "H debug_mode:96",
        `H Field I name:${FIELDS.join(",")}`,
        `H Field I signed:0,0,${Array(n - 2)
            .fill(1)
            .join(",")}`,
        `H Field I predictor:${Array(n).fill(0).join(",")}`,
        `H Field I encoding:1,1,${Array(n - 2)
            .fill(0)
            .join(",")}`,
        `H Field P predictor:${P_PREDICTOR.join(",")}`,
        `H Field P encoding:9,${Array(n - 1)
            .fill(0)
            .join(",")}`,
        "H Field S name:flightModeFlags,stateFlags,failsafePhase",
        "H Field S signed:0,0,0",
        "H Field S predictor:0,0,0",
        "H Field S encoding:1,1,1",
    ];
    const out: number[] = Array.from(new TextEncoder().encode(`${header.join("\n")}\n`));

    out.push("S".charCodeAt(0));
    unsignedVB(out, opts.flightModeFlags);
    unsignedVB(out, 0);
    unsignedVB(out, 0);

    let prev: number[] = [];
    let prev2: number[] = [];
    frames.forEach((frame, iteration) => {
        const cur = values(iteration, frame);
        if (iteration % opts.iInterval === 0) {
            out.push("I".charCodeAt(0));
            unsignedVB(out, cur[0]);
            unsignedVB(out, cur[1]);
            for (let i = 2; i < n; i++) {
                signedVB(out, cur[i]);
            }
            prev = cur;
            prev2 = cur;
            return;
        }
        out.push("P".charCodeAt(0));
        for (let i = 1; i < n; i++) {
            let predicted: number;
            switch (P_PREDICTOR[i]) {
                case 2:
                    predicted = 2 * prev[i] - prev2[i];
                    break;
                case 3:
                    predicted = Math.trunc((prev[i] + prev2[i]) / 2);
                    break;
                default:
                    predicted = prev[i];
            }
            signedVB(out, cur[i] - predicted);
        }
        prev2 = prev;
        prev = cur;
    });

    out.push("E".charCodeAt(0), 255, ...new TextEncoder().encode("End of log"), 0);
    return new Uint8Array(out);
}
