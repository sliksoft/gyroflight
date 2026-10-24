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
 * A synthetic AIR65-like flight for the engine (CI has no real logs): the header values of
 * the AIR65 Oct-18 log (as in mspFirmware.air65FirmwareState), broadband gyro noise with a
 * motor tone and a frame resonance, constant hover throttle and eRPM. The logged gyroADC and
 * axisD are produced by the firmware-order chain and D path themselves, so the chain and D
 * validations pass by construction, and each axis gets a CHIRP transfer function from a known
 * plant. It exercises the code path, not the physics: physical claims rest on the AIR65 logs.
 */

import {
    evaluateControllerFrf,
    type DigitalControllerConfig,
} from "../../../src/js/blackbox/betaflight_digital_controller";
import {
    closedLoopFromPlant,
    plantFrf,
    syntheticTransferFunction,
} from "../../../src/js/blackbox/betaflight_open_loop";
import { dtermConfigFromHeaders, simulateDterm } from "../../../src/js/blackbox/betaflight_dterm_dynamic";
import { chainConfigFromHeaders, simulateGyroChain } from "../../../src/gyrocore/engine/gyroChain";
import {
    analyzeAxisController,
    controllerConfigFromHeaders,
    flightMask,
    type AutotuneLogInput,
} from "../../../src/gyrocore/engine/autotuneV2";

export const SYNTH_HEADERS: [string, string][] = [
    ["Firmware revision", "Betaflight 2026.6.2 (43875a55a) STM32G474"],
    ["Board information", "BEFH BETAFPVG473"],
    ["DeviceUID", "003e00213841501220343141"],
    ["looptime", "125"],
    ["pid_process_denom", "2"],
    ["maxthrottle", "2000"],
    ["rollPID", "56,79,30"],
    ["pitchPID", "82,117,61"],
    ["yawPID", "56,79,0"],
    ["ff_weight", "22,32,22"],
    ["d_max", "40,0,0"],
    ["d_max_gain", "20"],
    ["d_max_advance", "35"],
    ["tpa_mode", "1"],
    ["tpa_rate", "60"],
    ["tpa_breakpoint", "1350"],
    ["tpa_low_rate", "20"],
    ["tpa_low_breakpoint", "1050"],
    ["tpa_low_always", "0"],
    ["throttle_limit_type", "0"],
    ["dterm_lpf1_type", "0"],
    ["dterm_lpf1_static_hz", "75"],
    ["dterm_lpf1_dyn_hz", "75,150"],
    ["dterm_lpf1_dyn_expo", "5"],
    ["dterm_lpf2_type", "0"],
    ["dterm_lpf2_static_hz", "150"],
    ["dterm_notch_hz", "0"],
    ["yaw_lowpass_hz", "100"],
    ["gyro_lpf1_type", "0"],
    ["gyro_lpf1_static_hz", "150"],
    ["gyro_lpf1_dyn_hz", "150,300"],
    ["gyro_lpf1_dyn_expo", "5"],
    ["gyro_lpf2_type", "0"],
    ["gyro_lpf2_static_hz", "300"],
    ["gyro_notch_hz", "0,0"],
    ["dyn_notch_max_hz", "700"],
    ["dyn_notch_count", "2"],
    ["dyn_notch_q", "300"],
    ["dyn_notch_min_hz", "100"],
    ["motor_poles", "12"],
    ["rpm_filter_harmonics", "2"],
    ["rpm_filter_weights", "100,100,100"],
    ["rpm_filter_q", "500"],
    ["rpm_filter_min_hz", "100"],
    ["rpm_filter_fade_range_hz", "50"],
    ["rpm_filter_lpf_hz", "150"],
    ["chirp_lag_freq_hz", "3"],
    ["chirp_lead_freq_hz", "30"],
    ["rc_smoothing_active_cutoffs_ff_sp_thr", "53,53"],
    ["simplified_pids_mode", "0"],
];

const FS = 4000;
const PLANT_SCALE = [1, 0.5, 1];

export interface SyntheticLogOptions {
    seconds?: number;
    /** Logged P/I/D per axis (default: the AIR65 values). */
    pids?: Partial<Record<"roll" | "pitch" | "yaw", [number, number, number]>>;
    /** Plant gain factor of this flight (≠ 1: the craft behaved differently than predicted). */
    plantScale?: number;
    /** Step of the identified CHIRP bins, 1–100 Hz (default 0.5 Hz). */
    binStepHz?: number;
}

export function syntheticLogInput(sha256: string, opts: SyntheticLogOptions | number = {}): AutotuneLogInput {
    const o = typeof opts === "number" ? { seconds: opts } : opts;
    const seconds = o.seconds ?? 11;
    const n = Math.round(seconds * FS);
    const headerPairs: [string, string][] = SYNTH_HEADERS.map(([k, v]) => {
        const axis = k.replace("PID", "") as "roll" | "pitch" | "yaw";
        return k.endsWith("PID") && o.pids?.[axis] ? [k, o.pids[axis]!.join(",")] : [k, v];
    });
    const h = Object.fromEntries(headerPairs);
    // The noise is the flight: the same hash gives the same samples (a copy), another hash another flight.
    let seed = Number.parseInt(sha256.slice(0, 8), 16) || 11;
    // Each flight is its own recording session (logInput.ts flightRelation): armed at its own time
    // since boot, the log starting at the session's first frame (loopIteration 0).
    const armedAtUs = 1_000_000 + (seed % 997) * 1000;
    const timeUs = Float64Array.from({ length: n }, (_, k) => armedAtUs + k * 250);
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5;
    // eRPM 600 (×100) with 12 poles → 166.7 Hz motor fundamental.
    const erpm = [0, 1, 2, 3].map(() => new Float64Array(n).fill(600));
    const unfilt = [0, 1, 2].map(() => {
        const x = new Float64Array(n);
        let ar = 0;
        for (let k = 0; k < n; k++) {
            ar = 0.95 * ar + 20 * rnd();
            const t = k / FS;
            x[k] =
                ar +
                30 * Math.sin(2 * Math.PI * 166.67 * t) +
                15 * Math.sin(2 * Math.PI * 333.3 * t) +
                25 * Math.sin(2 * Math.PI * 460 * t);
        }
        return x;
    }) as [Float64Array, Float64Array, Float64Array];
    const rcThrottle = new Float64Array(n).fill(1400);
    const chainCfg = chainConfigFromHeaders(h)!;
    const sim = simulateGyroChain({ timeUs, gyroUnfilt: unfilt, erpm, rcThrottle }, chainCfg);
    const gyroAdc = sim.out.map((c) => Float64Array.from(c, (v) => (Number.isFinite(v) ? v : 0))) as [
        Float64Array,
        Float64Array,
        Float64Array,
    ];
    const axisD = [0, 1].map((a) => {
        const sd = simulateDterm(
            { timeUs, gyro: gyroAdc[a], rcThrottle },
            dtermConfigFromHeaders(h, a as 0 | 1, 250e-6)!,
        );
        return Float64Array.from(sd.d, (v) => (Number.isFinite(v) ? v : 0));
    });
    const step = o.binStepHz ?? 0.5;
    const freqs = Array.from({ length: Math.round(99 / step) + 1 }, (_, i) => 1 + i * step);
    const sweep = (k: number) => ({ start: Math.round((1 + 3.3 * k) * FS), end: Math.round((4 + 3.3 * k) * FS) });
    const log: AutotuneLogInput = {
        sha256,
        logIndex: 0,
        headerPairs,
        sampleRateHz: FS,
        channels: {
            timeUs,
            gyroAdc,
            gyroUnfilt: unfilt,
            erpm,
            rcThrottle,
            axisD: [axisD[0], axisD[1], null],
            motors: [0, 1, 2, 3].map(() => new Float64Array(n).fill(1500)),
        },
        chirp: {},
        stick: { acroSeconds: 0, latencyMs: {} },
        noiseFloorKnown: true,
        session: { firstIteration: 0, startDatetime: null },
    };
    // Each sweep's T is what a plant would show under the controller the engine reconstructs
    // for this log (headers + M5-B effective D path), so baseline and candidate are consistent.
    const mask = flightMask(rcThrottle);
    (["roll", "pitch", "yaw"] as const).forEach((name, axis) => {
        const w = sweep(axis);
        const placeholder = { tf: syntheticTransferFunction([1], () => ({ re: 1, im: 0 })), ...w, state: "usable" };
        const cfg =
            analyzeAxisController(log, h, axis as 0 | 1 | 2, placeholder, mask)?.cfg ??
            (controllerConfigFromHeaders(h, axis as 0 | 1 | 2) as DigitalControllerConfig);
        const K = 80 * PLANT_SCALE[axis] * (o.plantScale ?? 1);
        // A measured T carries this flight's own estimation noise (0.1 % gain, 0.1° phase, from the
        // same seed as the gyro): two flights never identify the same plant to the last bit, and the
        // engine treats an exact match as the same measurement (cross_log_identical_measurement).
        const tf = syntheticTransferFunction(freqs, (f) => {
            const frf = evaluateControllerFrf(cfg, f);
            const T = closedLoopFromPlant(
                plantFrf(f, { K, motorHz: 40, delayS: 0.002 }),
                frf.cReference,
                frf.cFeedback,
            );
            const g = 1 + 2e-3 * rnd();
            const ph = (2e-3 * rnd() * Math.PI) / 180;
            return {
                re: g * (T.re * Math.cos(ph) - T.im * Math.sin(ph)),
                im: g * (T.re * Math.sin(ph) + T.im * Math.cos(ph)),
            };
        });
        log.chirp[name] = { tf, ...w, state: "usable" };
    });
    return log;
}

/**
 * SIMULATION ONLY: a synthetic second flight of the same craft and tune, identified on 0.1 Hz bins,
 * standing in for the model-class qualification log (autotuneV2 modelClassQualification) in
 * software-contract tests. It is no real measurement and never AIR65 or any other flight evidence.
 */
export function simulatedQualificationLog(opts: Omit<SyntheticLogOptions, "binStepHz"> = {}): AutotuneLogInput {
    return syntheticLogInput("5a".repeat(32), { ...opts, binStepHz: 0.1 });
}
