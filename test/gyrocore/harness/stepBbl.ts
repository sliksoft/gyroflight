/*
 * Synthetic Acro blackbox logs for the step-response tests: a known second-order rate response on
 * every axis, stick flicks, armed at flight throttle, written as a real BBL (bblWriter.ts) so the
 * whole decode path (Viewer FlightLog → stepLog.ts) runs. Labelled synthetic in the header.
 */

import { CHIRP_FLAG, encodeLog, type SyntheticFrame } from "./bblWriter";
import { simulate, stickSetpoint, withNoise, rms, type SecondOrder } from "./stepSynth";

export const ARM_FLAG = 1 << 0;
export const ANGLE_FLAG = 1 << 1;
export const HORIZON_FLAG = 1 << 2;
export { CHIRP_FLAG };

/** The tune headers of the synthetic craft (the AIR65 begin tune); override per test. */
export const SYNTH_TUNE: Record<string, string> = {
    rollPID: "56,79,30",
    pitchPID: "82,117,61",
    yawPID: "56,79,0",
    d_max: "40,0,0",
    d_max_gain: "20",
    d_max_advance: "35",
    ff_weight: "22,32,22",
    feedforward_transition: "0",
    feedforward_averaging: "1",
    feedforward_smooth_factor: "35",
    feedforward_jitter_factor: "4",
    feedforward_boost: "18",
    feedforward_max_rate_limit: "90",
    dterm_lpf1_type: "0",
    dterm_lpf1_static_hz: "75",
    dterm_lpf1_dyn_hz: "75,150",
    dterm_lpf1_dyn_expo: "5",
    dterm_lpf2_type: "0",
    dterm_lpf2_static_hz: "150",
    dterm_notch_hz: "0",
    dterm_notch_cutoff: "0",
    yaw_lowpass_hz: "100",
    gyro_lpf1_type: "0",
    gyro_lpf1_static_hz: "150",
    gyro_lpf1_dyn_hz: "150,300",
    gyro_lpf1_dyn_expo: "5",
    gyro_lpf2_type: "0",
    gyro_lpf2_static_hz: "300",
    gyro_notch_hz: "0,0",
    gyro_notch_cutoff: "0,0",
    dyn_notch_count: "2",
    dyn_notch_q: "300",
    dyn_notch_min_hz: "100",
    dyn_notch_max_hz: "700",
    rpm_filter_harmonics: "2",
    rpm_filter_weights: "100,100,100",
    rpm_filter_q: "500",
    rpm_filter_min_hz: "100",
    rpm_filter_fade_range_hz: "50",
    rpm_filter_lpf_hz: "150",
    tpa_mode: "1",
    tpa_rate: "60",
    tpa_breakpoint: "1350",
    tpa_low_rate: "20",
    tpa_low_breakpoint: "1050",
    tpa_low_always: "0",
    iterm_relax: "1",
    iterm_relax_type: "1",
    iterm_relax_cutoff: "25",
    rates_type: "3",
    rc_rates: "7,7,7",
    rc_expo: "54,54,54",
    rates: "52,52,57",
    rate_limits: "1998,1998,1998",
    gyro_sync_denom: "1",
    iterm_windup: "80",
    anti_gravity_gain: "80",
    motor_output_limit: "100",
    thrust_linear: "0",
    "P ratio": "128",
};

export interface AcroLogOptions {
    seconds?: number;
    seed?: number;
    plant?: SecondOrder;
    /** Gyro noise relative to the gyro RMS (0.1 = 20 dB SNR). */
    noise?: number;
    /** Flight-mode flags throughout (default ARM only: Acro). */
    flags?: number;
    /** Further flag changes: at this sample index, these flags. */
    flagChanges?: { at: number; flags: number }[];
    /** Sample indices after which this many frames are dropped (a frame gap). */
    gapsAt?: { at: number; frames: number }[];
    /** Samples with a motor at the top of its range. */
    saturateAt?: { start: number; end: number }[];
    /** Header overrides (tune, identity, logging). */
    headers?: Record<string, string>;
    /** Logged battery voltage (vbatLatest, log units); default 400. */
    vbat?: number;
    /** Throttle (rcCommand[3]); default 1400 (flight). */
    throttle?: number;
    /** First loopIteration (0: the log holds its session start). */
    firstIteration?: number;
    /** Time of the first frame (µs since boot); distinct per independent flight. */
    startUs?: number;
    debugMode?: number;
    /** debug[] per sample (CHIRP generator evidence); default 0. */
    debug?: (i: number) => [number, number, number, number];
    /** Frame interval (µs); default 1000 (1 kHz). The header loop rate follows (looptime 125). */
    dtUs?: number;
    /** false: no flightModeFlags column. */
    slowFields?: boolean;
    /** Replaces the writer's `Betaflight 2026.6.2 (synthetic) STM32F7X2`. */
    firmwareRevision?: string;
}

const WRITER_REVISION = "Betaflight 2026.6.2 (synthetic) STM32F7X2";

function replaceRevision(bytes: Uint8Array, revision: string): Uint8Array {
    const enc = new TextEncoder();
    const from = enc.encode(WRITER_REVISION);
    const to = enc.encode(revision);
    for (let i = 0; i + from.length <= bytes.length; i++) {
        if (from.every((b, k) => bytes[i + k] === b)) {
            const out = new Uint8Array(bytes.length - from.length + to.length);
            out.set(bytes.subarray(0, i));
            out.set(to, i);
            out.set(bytes.subarray(i + from.length), i + to.length);
            return out;
        }
    }
    throw new Error("revision not found");
}

/** One synthetic Acro log, 1 kHz by default (looptime 125, pid_process_denom dtUs/125, P interval 1/1). */
export function acroLog(o: AcroLogOptions = {}): Uint8Array {
    const dtUs = o.dtUs ?? 1000;
    const fs = 1e6 / dtUs;
    const seconds = o.seconds ?? 20;
    const seed = o.seed ?? 1;
    const plant = o.plant ?? { fnHz: 20, zeta: 0.5, delayMs: 5, gain: 1 };
    const axes = [0, 1, 2].map((a) => {
        const sp = stickSetpoint({ seconds, fs, seed: seed * 31 + a * 7 });
        const g0 = simulate(sp, fs, plant);
        const gy = o.noise ? withNoise(g0, rms(g0) * o.noise, seed * 13 + a) : g0;
        return { sp, gy };
    });
    const n = axes[0].sp.length;
    const dropAfter = new Map((o.gapsAt ?? []).map((g) => [g.at, g.frames]));
    const frames: SyntheticFrame[] = [];
    let skip = 0;
    for (let i = 0; i < n; i++) {
        if (skip > 0) {
            skip--;
            continue;
        }
        const sat = (o.saturateAt ?? []).some((r) => i >= r.start && i < r.end);
        frames.push({
            time: (o.startUs ?? 5_000_000) + i * dtUs,
            iteration: (o.firstIteration ?? 0) + i,
            setpoint: [Math.round(axes[0].sp[i]), Math.round(axes[1].sp[i]), Math.round(axes[2].sp[i])],
            gyro: [Math.round(axes[0].gy[i]), Math.round(axes[1].gy[i]), Math.round(axes[2].gy[i])],
            debug: o.debug ? o.debug(i) : [0, 0, 0, 0],
            motors: sat ? [2047, 900, 900, 900] : [900, 900, 900, 900],
            extra: [o.throttle ?? 1400, o.vbat ?? 400],
        });
        if (dropAfter.has(i)) skip = dropAfter.get(i)!;
    }
    const headers: Record<string, string> = {
        "Board information": "SYNT SYNTHETIC",
        "Craft name": "SYNTHETIC",
        DeviceUID: "0000000000000000000000aa",
        motorOutput: "48,2047",
        maxthrottle: "2000",
        "Log start datetime": "0000-01-01T00:00:00.000+00:00",
        ...SYNTH_TUNE,
        ...(o.headers ?? {}),
    };
    // flag changes are written as S-frames before the frame at that (pre-gap) sample index
    const frameIndexOf = (sample: number) => frames.findIndex((f) => f.iteration! - (o.firstIteration ?? 0) >= sample);
    const bytes = encodeLog(frames, {
        iInterval: 32,
        flightModeFlags: o.flags ?? ARM_FLAG,
        looptime: 125,
        pidProcessDenom: Math.round(dtUs / 125),
        slowFields: o.slowFields,
        motorCount: 4,
        extraFields: ["rcCommand[3]", "vbatLatest"],
        debugMode: o.debugMode ?? 0,
        firstIteration: o.firstIteration ?? 0,
        sFrames: (o.flagChanges ?? []).map((c) => ({ atFrame: frameIndexOf(c.at), flightModeFlags: c.flags })),
        extraHeaders: Object.entries(headers).map(([k, v]) => `${k}:${v}`),
    });
    return o.firmwareRevision ? replaceRevision(bytes, o.firmwareRevision) : bytes;
}
