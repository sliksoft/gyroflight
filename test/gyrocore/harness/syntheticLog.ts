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
import { declaredSupport } from "./frequencySupport";
import { declaredQualificationSweep } from "./qualificationSweep";
import {
    analyzeAxisController,
    controllerConfigFromHeaders,
    flightMask,
    type AutotuneLogInput,
} from "../../../src/gyrocore/engine/autotuneV2";

export const SYNTH_HEADERS: [string, string][] = [
    ["Firmware revision", "Betaflight 2026.6.2 (43875a55a) STM32G474"],
    ["Board information", "BEFH BETAFPVG473"],
    ["DeviceUID", "0a1b2c3d4e5f607112233445"],
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
    // SIMULATION: the sweep the synthetic windows stand for (loopModel generator-stop check).
    // Default: 4 Hz bins + 120 s sweep so 2 Hz fine-rung whole-segment dwell holds through ~100 Hz (F2).
    ["chirp_frequency_start_deci_hz", "20"],
    ["chirp_frequency_end_deci_hz", "2000"],
    ["chirp_time_seconds", "120"],
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
    /**
     * Step of the identified CHIRP bins (default 4 Hz). Finer grids need a longer declared sweep
     * and window so every bin has whole-segment dwell (Grokbot F2).
     */
    binStepHz?: number;
    /** Highest identified bin (default 100 Hz). */
    maxHz?: number;
    /**
     * SIMULATION: the Welch analysis the bins claim to come from (segment samples follow from the
     * bin step; every axis' sweep window then spans `windowS` seconds, the axes' windows
     * overlapping); without it the transfer function carries no analysis provenance.
     */
    welch?: { segments: number; windowS: number };
    /**
     * SIMULATION: the CHIRP sweep the log's headers declare (chirp_frequency_start / end, chirp_time
     * _seconds). Omit for Welch-only averages from segment count (no invented sub-segment n=1).
     */
    sweep?: { f0Hz: number; f1Hz: number; durationS: number };
    /**
     * Stagger per-axis chirp slices inside a short buffer (identity / multi-segment export tests).
     * Full-chain dwell logs keep one window that matches `welch.windowS`.
     */
    staggerAxes?: boolean;
}

/**
 * Short-buffer identity / fragment tests: 11 s channels, staggered CHIRP slices, Welch window that
 * fits the buffer. Does not claim long observed dwell (Grokbot P2).
 */
export function syntheticIdentityLog(
    sha256: string,
    opts: Omit<SyntheticLogOptions, "welch" | "sweep" | "staggerAxes"> = {},
): AutotuneLogInput {
    return syntheticLogInput(sha256, {
        ...opts,
        seconds: opts.seconds ?? 11,
        welch: { segments: 8, windowS: 9 },
        sweep: { f0Hz: 2, f1Hz: 200, durationS: 9 },
        staggerAxes: true,
    });
}

export function syntheticLogInput(sha256: string, opts: SyntheticLogOptions | number = {}): AutotuneLogInput {
    const o = typeof opts === "number" ? { seconds: opts } : opts;
    // Full-chain honesty (Grokbot P2): channel length covers the Welch window unless the caller
    // passes an explicit short `seconds` (identity helpers). Default 120 s matches the historical
    // declared dwell so pitch/yaw keep MODEL_CONDITIONAL bounds; channels actually hold that window.
    const welch = o.welch ?? { segments: 32, windowS: 120 };
    const seconds = o.seconds ?? welch.windowS + 1;
    const n = Math.round(seconds * FS);
    const sweepHeader: Record<string, string> = o.sweep
        ? {
              chirp_frequency_start_deci_hz: String(Math.round(o.sweep.f0Hz * 10)),
              chirp_frequency_end_deci_hz: String(Math.round(o.sweep.f1Hz * 10)),
              chirp_time_seconds: String(o.sweep.durationS),
          }
        : {
              // Match the analysed window when the caller did not override sweep headers.
              chirp_time_seconds: String(welch.windowS),
          };
    const headerPairs: [string, string][] = SYNTH_HEADERS.map(([k, v]) => {
        const axis = k.replace("PID", "") as "roll" | "pitch" | "yaw";
        if (k in sweepHeader) return [k, sweepHeader[k]];
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
    const step = o.binStepHz ?? 4;
    const maxHz = o.maxHz ?? 100;
    // Start at `step` (not 1 Hz): the default chirp starts at 2 Hz; a 1 Hz bin has no dwell (F2).
    const freqs = Array.from({ length: Math.floor(maxHz / step) }, (_, i) => (i + 1) * step);
    const declaredWindowSamples = Math.round(welch.windowS * FS);
    // Identity helpers set staggerAxes; full-chain logs use one window matching welch.windowS.
    const sweep = (k: number) =>
        o.staggerAxes
            ? {
                  start: Math.round((1 + 3.3 * k) * FS),
                  end: Math.min(n, Math.round((4 + 3.3 * k) * FS)),
              }
            : {
                  start: Math.round(0.5 * FS),
                  end: Math.min(n, Math.round((0.5 + welch.windowS) * FS)),
              };
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
        const measuredT = (fr: number[]) =>
            syntheticTransferFunction(fr, (f) => {
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
        const tf = measuredT(freqs);
        // Analysis window = chirp end−start (production contract). Never claim more than held.
        const availableWindowSamples = Math.max(0, w.end - w.start);
        const windowSamples = Math.min(declaredWindowSamples, availableWindowSamples);
        // SIMULATION: ascending ladder of at most three rungs (step, step/2, step/4) whose Welch
        // segment fits the window for minWelchSegments at 50 % overlap. Axes that need step/2 still
        // have a finer neighbour for H1 when the window allows it (Grokbot F2).
        const maxSeg = Math.floor((2 * windowSamples) / (8 + 1)); // UNCERTAINTY.minWelchSegments = 8
        const rungSteps = [step, step / 2, step / 4].filter((binStep) => Math.round(FS / binStep) <= maxSeg);
        const uniqueSteps = [...new Set(rungSteps.length ? rungSteps : [step])];
        const rungOf = (binStep: number) => {
            const fr = Array.from({ length: Math.floor(maxHz / binStep) }, (_, i) => (i + 1) * binStep);
            const t = measuredT(fr);
            t.numSegments = welch.segments;
            return {
                tf: t,
                support: declaredSupport(t, { observedHz: [step, 200] }),
                analysis: {
                    segmentSamples: Math.round(FS / binStep),
                    sampleRateHz: FS,
                    windowSamples,
                    segments: welch.segments,
                },
            };
        };
        const analyses = uniqueSteps.map(rungOf);
        tf.numSegments = welch.segments;
        log.chirp[name] = {
            tf: analyses[0]!.tf,
            // SIMULATION: every bin declared supported, as a full DEBUG_CHIRP sweep would show.
            support: analyses[0]!.support,
            analyses,
            ...w,
            state: "usable",
            analysis: analyses[0]!.analysis,
        };
    });
    return log;
}

/**
 * SIMULATION ONLY: a synthetic second flight of the same craft and tune, identified on 0.1 Hz bins
 * over a 45 s window that the log actually holds. Sweep header and analysed window match (45 s):
 * no unobserved dwell is claimed (Codex review 2026-10-28, P2).
 *
 * On the qualification path those fine bins have less than one whole Welch segment of dwell, so
 * averages are UNKNOWN and this log cannot produce VALIDATED evidence through the production
 * pipeline — a negative control for fixture realism. Write-authority / Safety suites that need a
 * VALIDATED proposal use `runSoftwareQualifiedAutotuneV2` (simulatedQualifiedEvidence), not this log.
 *
 * For a deliberate mismatch (long header, short window) see `mismatchedQualificationLog`.
 */
export const SIMULATED_QUALIFICATION_SWEEP = { f0Hz: 1, f1Hz: 200, durationS: 45 };

/** Day-long header in a 45 s window: the engine must not count dwell past the analysed window. */
export const MISMATCHED_QUALIFICATION_SWEEP = declaredQualificationSweep({
    segmentSamples: Math.round(FS / 0.1),
    sampleRateHz: FS,
    f0Hz: 1,
    f1Hz: 200,
    topHz: 160,
});

export function simulatedQualificationLog(
    opts: Omit<SyntheticLogOptions, "binStepHz" | "maxHz" | "welch" | "sweep"> = {},
): AutotuneLogInput {
    return syntheticLogInput("5a".repeat(32), {
        seconds: 46,
        ...opts,
        binStepHz: 0.1,
        maxHz: 160,
        welch: { segments: 8, windowS: 45 },
        sweep: SIMULATED_QUALIFICATION_SWEEP,
    });
}

/**
 * SIMULATION: a qualification flight whose ladder includes the contract segment for a 4 Hz primary
 * (8192 samples ≈ 0.488 Hz bins) inside a 120 s window with whole-segment dwell. Use for WP5 gate
 * tests that must select a candidate and then refuse it for a named reason (D path, coherence,
 * band coverage). Not flight evidence — still fail-closed on real AIR65 CHIRP (Grokbot F5).
 */
export function selectableQualificationLog(
    opts: Omit<SyntheticLogOptions, "binStepHz" | "welch" | "sweep"> = {},
): AutotuneLogInput {
    return syntheticLogInput("5c".repeat(32), {
        seconds: 121,
        ...opts,
        binStepHz: 4000 / 8192,
        maxHz: opts.maxHz ?? 100,
        welch: { segments: 16, windowS: 120 },
        sweep: { f0Hz: 2, f1Hz: 200, durationS: 120 },
    });
}

/** Negative control: declares the long sweep 0.1 Hz→160 Hz needs, inside a 45 s window. */
export function mismatchedQualificationLog(
    opts: Omit<SyntheticLogOptions, "binStepHz" | "maxHz" | "welch" | "sweep"> = {},
): AutotuneLogInput {
    return syntheticLogInput("5b".repeat(32), {
        seconds: 46,
        ...opts,
        binStepHz: 0.1,
        maxHz: 160,
        welch: { segments: 8, windowS: 45 },
        sweep: MISMATCHED_QUALIFICATION_SWEEP,
    });
}
