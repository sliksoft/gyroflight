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
 * SIMULATION ONLY: a CHIRP flight of a closed rate loop as Blackbox bytes, for end-to-end tests of
 * the whole software chain (decoder → CHIRP qualification → buildLogInputs → engine). Each axis
 * gets the firmware's exponential sweep (chirp.c), its setpoint and DEBUG_CHIRP channels as pid.c
 * logs them; the gyro is the setpoint filtered through the closed loop T = G·C_ref / (1 + G·C_fb)
 * of a chosen plant G and the controller the log's headers describe (the engine's own controller
 * model), plus deterministic noise. It is no real flight and never AIR65 or other hardware evidence.
 */

import {
    cadd,
    cdiv,
    cmul,
    evaluateControllerFrf,
    type Complex,
} from "../../../src/js/blackbox/betaflight_digital_controller";
import { ComplexFFT } from "../../../src/js/blackbox/fft";
import { controllerConfigFromHeaders } from "../../../src/gyrocore/engine/autotuneV2";
import { CHIRP_FLAG, encodeLog, type SyntheticFrame } from "./bblWriter";
import { BETAFLIGHT_TUNE_HEADERS, SIM_IDENTITY_HEADERS } from "./chirpSim";

export type Plant = (f: number) => Complex;

/** A rate plant: K / (s (s/ωm + 1)) e^{−sτ}, optionally with a 2nd-order resonance (gain peak at fr). */
export function ratePlant(o: {
    K: number;
    motorHz: number;
    delayS: number;
    resonance?: { hz: number; zeta: number };
}): Plant {
    return (f) => {
        const w = 2 * Math.PI * f;
        const s = { re: 0, im: w };
        const motor = { re: 1, im: f / o.motorHz };
        let G = cdiv({ re: o.K, im: 0 }, cmul(s, motor));
        G = cmul(G, { re: Math.cos(-w * o.delayS), im: Math.sin(-w * o.delayS) });
        if (o.resonance) {
            const x = f / o.resonance.hz;
            G = cdiv(G, { re: 1 - x * x, im: 2 * o.resonance.zeta * x });
        }
        return G;
    };
}

export interface ClosedLoopLogOptions {
    /** Per axis the plant, or null for an axis that is not swept. */
    plants: [Plant | null, Plant | null, Plant | null];
    /** Header lines (default BETAFLIGHT_TUNE_HEADERS); the chirp lines set the sweep. */
    headers?: string[];
    /** Sweep seconds per axis (also written as chirp_time_seconds). */
    sweepS?: number;
    startHz?: number;
    endHz?: number;
    amplitude?: number;
    /** Standard deviation of the gyro noise (log units). */
    noise?: number;
    /** A gyro that does not follow the setpoint at all (coherence ≈ 0). */
    uncorrelated?: boolean;
    seed?: number;
    /** loopIteration of the first frame (an export from inside a session when > 0). */
    firstIteration?: number;
    /** Arming time since boot (µs) of the first frame. */
    startTimeUs?: number;
    /**
     * Excitation amplitude factor as a function of the instantaneous sweep frequency (default 1): a
     * hole or attenuation in the excitation (T3 audit, unexcited bins).
     */
    envelope?: (fHz: number) => number;
    /**
     * The generator stops at this frequency while the header still claims the full range (T3 audit,
     * the 19 October generator stop): from there on the setpoint and debug[3] are 0 and debug[2]
     * stays at the stop frequency.
     */
    abortAtHz?: number;
}

const RATE_HZ = 1000; // looptime 125 µs × pid_process_denom 8: the encoder's defaults.

/** y = real(IFFT(H · FFT(x))), zero-padded so the response is a linear (not circular) convolution. */
function filter(x: number[], H: (f: number) => Complex): Float64Array {
    let n = 1;
    while (n < 2 * x.length) n <<= 1;
    const X = new Float64Array(2 * n);
    new ComplexFFT(n, false).simple(
        X,
        Float64Array.from({ length: n }, (_, i) => x[i] ?? 0),
        "real",
    );
    for (let k = 0; k <= n / 2; k++) {
        const h = H((k * RATE_HZ) / n);
        const re = X[2 * k] * h.re - X[2 * k + 1] * h.im;
        const im = X[2 * k] * h.im + X[2 * k + 1] * h.re;
        X[2 * k] = re;
        X[2 * k + 1] = im;
        if (k > 0 && k < n / 2) {
            X[2 * (n - k)] = re;
            X[2 * (n - k) + 1] = -im;
        }
    }
    const y = new Float64Array(2 * n);
    new ComplexFFT(n, true).simple(y, X);
    return Float64Array.from({ length: x.length }, (_, i) => y[2 * i] / n);
}

/** The BBL bytes of one flight: the swept axes one after another, 100 idle frames between them. */
export function closedLoopChirpLog(o: ClosedLoopLogOptions): Uint8Array {
    const sweepS = o.sweepS ?? 20;
    const f0 = o.startHz ?? 2;
    const f1 = o.endHz ?? 200;
    const amp = o.amplitude ?? 200;
    const headers = [
        ...SIM_IDENTITY_HEADERS,
        ...(o.headers ?? BETAFLIGHT_TUNE_HEADERS).filter((h) => !/^chirp_(frequency_start|frequency_end|time)/.test(h)),
        `chirp_frequency_start_deci_hz:${Math.round(f0 * 10)}`,
        `chirp_frequency_end_deci_hz:${Math.round(f1 * 10)}`,
        `chirp_time_seconds:${sweepS}`,
    ];
    // The encoder writes looptime and pid_process_denom itself (its defaults: 1 kHz).
    const h = Object.fromEntries([
        ...headers.map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1)]),
        ["looptime", "125"],
        ["pid_process_denom", "8"],
    ]);
    let seed = o.seed ?? 7;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    const frames: SyntheticFrame[] = [];
    let t = o.startTimeUs ?? 2_000_000;
    const dt = 1e6 / RATE_HZ;
    const idle = (n: number) => {
        for (let k = 0; k < n; k++, t += dt) {
            frames.push({
                time: Math.round(t),
                setpoint: [0, 0, 0],
                gyro: [0, 0, 0],
                debug: [0, -1, 0, 0],
                extra: [1400],
            });
        }
    };
    idle(200);
    o.plants.forEach((G, axis) => {
        if (!G) return;
        const cfg = controllerConfigFromHeaders(h, axis as 0 | 1 | 2)!;
        const n = Math.round(sweepS * RATE_HZ);
        const beta = Math.pow(f1 / f0, 1 / sweepS);
        const sp: number[] = [];
        const meta: { phase: number; f: number; exc: number }[] = [];
        for (let i = 0; i < n; i++) {
            const tt = i / RATE_HZ;
            // chirp.c: fchirp = f0 β^t, sinarg = k0 fchirp − k1 with k0 = 2π / ln β.
            let fchirp = f0 * Math.pow(beta, tt);
            const phase = ((2 * Math.PI) / Math.log(beta)) * (fchirp - f0);
            let exc = Math.cos(phase) * (o.envelope ? o.envelope(fchirp) : 1);
            if (o.abortAtHz !== undefined && fchirp > o.abortAtHz) {
                fchirp = o.abortAtHz;
                exc = 0;
            }
            sp.push(Math.round(amp * exc));
            meta.push({ phase, f: fchirp, exc });
        }
        const T = (f: number) => {
            const c = evaluateControllerFrf(cfg, Math.max(f, 1e-3));
            const g = G(Math.max(f, 1e-3));
            return cdiv(cmul(g, c.cReference), cadd({ re: 1, im: 0 }, cmul(g, c.cFeedback)));
        };
        const y = o.uncorrelated
            ? Float64Array.from({ length: n }, (_, i) => amp * Math.sin(2 * Math.PI * 37 * (i / RATE_HZ)))
            : filter(sp, T);
        for (let i = 0; i < n; i++, t += dt) {
            const setpoint: [number, number, number] = [0, 0, 0];
            const gyro: [number, number, number] = [0, 0, 0];
            setpoint[axis] = sp[i];
            gyro[axis] = Math.round(y[i] + (o.noise ? o.noise * gauss() : 0));
            const m = meta[i];
            frames.push({
                time: Math.round(t),
                setpoint,
                gyro,
                debug: [
                    Math.round(5000 * (m.phase % (2 * Math.PI))),
                    axis,
                    Math.round(10 * m.f),
                    Math.round(1000 * m.exc),
                ],
                extra: [1400],
            });
        }
        idle(100);
    });
    return encodeLog(frames, {
        iInterval: 32,
        flightModeFlags: CHIRP_FLAG,
        extraHeaders: headers,
        extraFields: ["rcCommand[3]"],
        firstIteration: o.firstIteration,
    });
}
