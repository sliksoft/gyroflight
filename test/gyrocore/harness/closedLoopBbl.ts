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
    phaseCompCoeffs,
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
    /**
     * How a sweep's registration really ends (firmware pid.c / chirp.c at 43875a55a), for one axis
     * or for every swept axis. Unlike `abortAtHz` (the generator's output held at zero while the
     * log goes on), these shorten the record itself: channel samples, timestamps, loopIteration,
     * segment bounds and the record the qualification finds all agree, and nothing is padded.
     * - modeOffAtHz: CHIRP mode switched off when the sweep reaches this frequency: the frames of
     *   this axis stop there, the idle gap (debug[1] −1) and any later axis follow.
     * - logEndsAtHz: the log stops at this frequency: no idle frames, no later axis.
     * - holdModeS: CHIRP mode kept on this long after the sweep completed: the finished generator logs
     *   fchirp 0 and exc 0 with debug[1] still the axis (chirpResetSignals); the gyro and pidSum are
     *   logged as 0 there (a settled loop, simplified).
     * - lostSamples: frames the log lost between these sweep seconds: time and loopIteration jump.
     */
    ending?: SweepEnding | Partial<Record<0 | 1 | 2, SweepEnding>>;
    /**
     * CHIRP + JIO fixture (jioSweep.ts tests): the firmware's phaseComp shaping of the chirp before
     * it is added to the setpoint (lag 3 / lead 30 Hz headers), the logged controller terms
     * (axisP carries pidSum = C_ref·r − C_fb·y; axisI/F/D logged as 0), the chirp amplitude and
     * pidsum_limit headers, and an idle gap of `gapS` between sweeps (default 0.6 s).
     */
    jio?: {
        /** Output disturbance fed back through the loop: coloured noise (PT1 at poleHz) through S = 1/(1+G·C_fb). */
        disturbance?: { sd: number; poleHz: number };
        /** Sweep every axis this many times (each the full sweepS). */
        repeats?: number;
        /** Plants for the second and later repeats (a change during the measurement); default: the same. */
        plantsAfter?: [Plant | null, Plant | null, Plant | null];
        /** Log the first repeat's samples again as the second (an exact copy, same noise). */
        duplicateRepeat?: boolean;
        /** Omit these logged fields (missing-channel tests): any of axisP, axisI, axisF, axisD, debug1. */
        omit?: ("axisP" | "axisI" | "axisF" | "axisD" | "debug1")[];
        /** Header pid_process_denom to write instead of the encoder's (a log not on the PID grid). */
        pidProcessDenomHeader?: number;
        /** Scale on the logged debug[2] frequency (a firmware/decoder mismatch fixture); default 1. */
        debug2Scale?: number;
        gapS?: number;
    };
}

export interface SweepEnding {
    /** Apply only to this repeat of the axis (jio.repeats); default: every repeat. */
    repeat?: number;
    modeOffAtHz?: number;
    logEndsAtHz?: number;
    holdModeS?: number;
    lostSamples?: { fromS: number; toS: number };
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
    const jio = o.jio;
    const headers = [
        ...SIM_IDENTITY_HEADERS,
        ...(o.headers ?? BETAFLIGHT_TUNE_HEADERS).filter((h) => !/^chirp_(frequency_start|frequency_end|time)/.test(h)),
        `chirp_frequency_start_deci_hz:${Math.round(f0 * 10)}`,
        `chirp_frequency_end_deci_hz:${Math.round(f1 * 10)}`,
        `chirp_time_seconds:${sweepS}`,
        ...(jio
            ? [
                  "chirp_lag_freq_hz:3",
                  "chirp_lead_freq_hz:30",
                  `chirp_amplitude_roll:${amp}`,
                  `chirp_amplitude_pitch:${amp}`,
                  `chirp_amplitude_yaw:${amp}`,
                  "pidsum_limit:500",
                  "pidsum_limit_yaw:400",
                  "use_integrated_yaw:0",
              ]
            : []),
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
    // loopIteration of the next frame (every PID loop counts, logged or lost).
    let loop = o.firstIteration ?? 0;
    const endingOf = (axis: number): SweepEnding | undefined => {
        const e = o.ending;
        if (!e) return undefined;
        if ("modeOffAtHz" in e || "logEndsAtHz" in e || "holdModeS" in e || "lostSamples" in e || "repeat" in e)
            return e as SweepEnding;
        return (e as Partial<Record<0 | 1 | 2, SweepEnding>>)[axis as 0 | 1 | 2];
    };
    let logEnded = false;
    // Logged controller terms: pidSum in axisP, the others 0 (the JIO estimate reads their sum).
    const pidFields = jio
        ? [
              "axisP[0]",
              "axisP[1]",
              "axisP[2]",
              "axisI[0]",
              "axisI[1]",
              "axisI[2]",
              "axisF[0]",
              "axisF[1]",
              "axisF[2]",
              "axisD[0]",
              "axisD[1]",
              "axisD[2]",
          ]
        : [];
    const omitted = (f: string) => (jio?.omit ?? []).some((o2) => f.startsWith(o2));
    const extraFields = ["rcCommand[3]", ...pidFields.filter((f) => !omitted(f))];
    const extraFor = (throttle: number, u: [number, number, number]) => [
        throttle,
        ...pidFields.filter((f) => !omitted(f)).map((f) => (f.startsWith("axisP") ? u[Number(f[6])] : 0)),
    ];
    const idle = (n: number) => {
        for (let k = 0; k < n; k++, t += dt, loop++) {
            frames.push({
                time: Math.round(t),
                iteration: loop,
                setpoint: [0, 0, 0],
                gyro: [0, 0, 0],
                debug: [0, -1, 0, 0],
                extra: extraFor(1400, [0, 0, 0]),
            });
        }
    };
    idle(200);
    const pc = jio ? phaseCompCoeffs(3, 30, Math.round(1e6 / RATE_HZ)) : null;
    const repeats = jio?.repeats ?? 1;
    const sweptAxes: { axis: number; G: Plant; rep: number }[] = [];
    for (let rep = 0; rep < repeats; rep++)
        o.plants.forEach((G, axis) => {
            const Gr = rep > 0 && jio?.plantsAfter ? jio.plantsAfter[axis] : G;
            if (Gr) sweptAxes.push({ axis, G: Gr, rep });
        });
    const firstRepeat = new Map<number, { sp: number[]; y: Float64Array; u: Float64Array }>();
    for (const { axis, G, rep } of sweptAxes) {
        if (logEnded) break;
        const endingAll = endingOf(axis);
        const ending =
            endingAll && (endingAll.repeat === undefined || endingAll.repeat === rep) ? endingAll : undefined;
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
        // Firmware-faithful chirp: amplitude · phaseComp(exc) is what pid.c adds to the setpoint.
        if (pc) {
            let x1 = 0;
            let y1 = 0;
            for (let i = 0; i < n; i++) {
                const x = sp[i] / amp;
                const yy = pc.b0 * x + pc.b1 * x1 - pc.a1 * y1;
                x1 = x;
                y1 = yy;
                sp[i] = Math.round(amp * yy);
            }
        }
        let y: Float64Array = o.uncorrelated
            ? Float64Array.from({ length: n }, (_, i) => amp * Math.sin(2 * Math.PI * 37 * (i / RATE_HZ)))
            : filter(sp, T);
        let u: Float64Array = new Float64Array(n);
        if (jio) {
            // Output disturbance through the loop: d → S·d = d / (1 + G·C_fb), seen by the controller.
            if (jio.disturbance) {
                const p = Math.exp((-2 * Math.PI * jio.disturbance.poleHz) / RATE_HZ);
                const d: number[] = [];
                let prev = 0;
                for (let i = 0; i < n; i++) {
                    prev = p * prev + (1 - p) * gauss();
                    d.push(prev);
                }
                let sd = 0;
                for (const v of d) sd += v * v;
                sd = Math.sqrt(sd / n) || 1;
                const S = (f: number) => {
                    const c = evaluateControllerFrf(cfg, Math.max(f, 1e-3));
                    return cdiv({ re: 1, im: 0 }, cadd({ re: 1, im: 0 }, cmul(G(Math.max(f, 1e-3)), c.cFeedback)));
                };
                const sd_ = filter(
                    d.map((v) => (v * jio.disturbance!.sd) / sd),
                    S,
                );
                y = Float64Array.from(y, (v, i) => v + sd_[i]);
            }
            // pidSum = C_ref·r − C_fb·y on the samples the log holds (frequency-domain filters).
            const ur = filter(sp, (f) => evaluateControllerFrf(cfg, Math.max(f, 1e-3)).cReference);
            const uy = filter(Array.from(y), (f) => evaluateControllerFrf(cfg, Math.max(f, 1e-3)).cFeedback);
            u = Float64Array.from(ur, (v, i) => v - uy[i]);
            if (rep === 0) firstRepeat.set(axis, { sp, y, u });
            else if (jio.duplicateRepeat) {
                const first = firstRepeat.get(axis)!;
                y = first.y;
                u = first.u;
                for (let i = 0; i < n; i++) sp[i] = first.sp[i];
            }
        }
        const cutHz = ending?.modeOffAtHz ?? ending?.logEndsAtHz;
        let cut = false;
        for (let i = 0; i < n; i++, t += dt, loop++) {
            const m = meta[i];
            if (cutHz !== undefined && m.f > cutHz) {
                cut = true;
                break;
            }
            const tt = i / RATE_HZ;
            // A lost frame: the loop ran (time and iteration advance) but the log holds nothing.
            if (ending?.lostSamples && tt >= ending.lostSamples.fromS && tt < ending.lostSamples.toS) continue;
            const setpoint: [number, number, number] = [0, 0, 0];
            const gyro: [number, number, number] = [0, 0, 0];
            const uu: [number, number, number] = [0, 0, 0];
            setpoint[axis] = sp[i];
            gyro[axis] = Math.round(y[i] + (o.noise && !(jio?.duplicateRepeat && rep > 0) ? o.noise * gauss() : 0));
            uu[axis] = Math.round(u[i]);
            frames.push({
                time: Math.round(t),
                iteration: loop,
                setpoint,
                gyro,
                debug: [
                    Math.round(5000 * (m.phase % (2 * Math.PI))),
                    omitted("debug1") ? -1 : axis,
                    Math.round(10 * m.f * (jio?.debug2Scale ?? 1)),
                    Math.round(1000 * m.exc),
                ],
                extra: extraFor(1400, uu),
            });
        }
        if (cut && ending?.logEndsAtHz !== undefined && ending.modeOffAtHz === undefined) {
            logEnded = true;
            break;
        }
        if (!cut && ending?.holdModeS) {
            // chirp.c after count == N: isFinished, exc = fchirp = sinarg = 0; pid.c keeps debug[1] = axis.
            for (let k = 0; k < Math.round(ending.holdModeS * RATE_HZ); k++, t += dt, loop++) {
                const setpoint: [number, number, number] = [0, 0, 0];
                frames.push({
                    time: Math.round(t),
                    iteration: loop,
                    setpoint,
                    gyro: [0, 0, 0],
                    debug: [0, omitted("debug1") ? -1 : axis, 0, 0],
                    extra: extraFor(1400, [0, 0, 0]),
                });
            }
        }
        idle(jio ? Math.round((jio.gapS ?? 0.6) * RATE_HZ) : 100);
    }
    return encodeLog(frames, {
        iInterval: 32,
        flightModeFlags: CHIRP_FLAG,
        extraHeaders: headers,
        extraFields,
        firstIteration: o.firstIteration,
        ...(jio?.pidProcessDenomHeader ? { pidProcessDenom: jio.pidProcessDenomHeader } : {}),
    });
}
