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
 * Synthetic CHIRP flights for the qualification tests: a rate loop
 * L(s) = K e^{-s tau} / s (P controller on an integrating plant with transport
 * delay) driven by a logarithmic sine sweep, encoded with bblWriter as the
 * firmware would log it. Deterministic, no randomness.
 */

import { CHIRP_FLAG, encodeLog, type SyntheticFrame } from "./bblWriter";

export interface SimOptions {
    /** Log rate in Hz (looptime 125 us x pid_process_denom). */
    rateHz?: number;
    seconds?: number;
    axis?: 0 | 1 | 2;
    amplitude?: number;
    startHz?: number;
    endHz?: number;
    /** Open-loop crossover of the simulated loop, Hz. */
    crossoverHz?: number;
    delaySamples?: number;
    startTimeUs?: number;
}

export function simulateChirp(o: SimOptions = {}): SyntheticFrame[] {
    const fs = o.rateHz ?? 1000;
    const n = Math.round((o.seconds ?? 20) * fs);
    const axis = o.axis ?? 0;
    const amp = o.amplitude ?? 200;
    const f0 = o.startHz ?? 2;
    const f1 = o.endHz ?? 200;
    const k = 2 * Math.PI * (o.crossoverHz ?? 40);
    const d = o.delaySamples ?? 2;
    const t0 = o.startTimeUs ?? 1_000_000;
    const dt = 1e6 / fs;
    const sweepT = n / fs;
    const ratio = Math.log(f1 / f0);
    const sp: number[] = [];
    const gy: number[] = [];
    const u: number[] = [];
    let y = 0;
    const frames: SyntheticFrame[] = [];
    for (let i = 0; i < n; i++) {
        const t = i / fs;
        // Logarithmic sweep f0 -> f1 over the whole run.
        const phase = ((2 * Math.PI * f0 * sweepT) / ratio) * (Math.exp((ratio * t) / sweepT) - 1);
        const r = Math.round(amp * Math.sin(phase));
        sp.push(r);
        y += (i >= d ? u[i - d] : 0) / fs;
        const yi = Math.round(y);
        gy.push(yi);
        u.push(k * (r - y));
        const setpoint: [number, number, number] = [0, 0, 0];
        const gyro: [number, number, number] = [0, 0, 0];
        setpoint[axis] = r;
        gyro[axis] = yi;
        frames.push({ time: Math.round(t0 + i * dt), setpoint, gyro, debug: [0, axis, 0, 0] });
    }
    return frames;
}

export const FULL_TUNE_HEADERS = [
    "chirp_frequency_start_deci_hz:20",
    "chirp_frequency_end_deci_hz:2000",
    "chirp_time_seconds:20",
    "rollPID:45,80,30",
    "pitchPID:47,84,34",
    "yawPID:45,80,0",
    "simplified_pids_mode:2",
    "simplified_master_multiplier:100",
    "simplified_pi_gain:100",
    "simplified_i_gain:100",
    "simplified_d_gain:100",
    "simplified_feedforward_gain:100",
    "simplified_dterm_filter:1",
    "simplified_dterm_filter_multiplier:100",
];

/** Replace one `key:value` header line. */
export function withHeader(headers: string[], line: string): string[] {
    const key = line.slice(0, line.indexOf(":") + 1);
    return [...headers.filter((h) => !h.startsWith(key)), line];
}

export function encodeChirpLog(frames: SyntheticFrame[], headers: string[] = FULL_TUNE_HEADERS, iInterval = 32) {
    // 1 kHz = looptime 125 us x pid_process_denom 8 (the encoder's defaults).
    return encodeLog(frames, { iInterval, flightModeFlags: CHIRP_FLAG, extraHeaders: headers });
}

export function concatLogs(...logs: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(logs.reduce((s, l) => s + l.length, 0));
    let at = 0;
    for (const l of logs) {
        out.set(l, at);
        at += l.length;
    }
    return out;
}
