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
 * Betaflight simplified-tuning mapping, ported line for line from GyroCore
 * core/gyrocore/betaflight/simplified_tuning.py (d2e60f7). That file mirrors
 * firmware config/simplified_tuning.c (byte-identical at Betaflight master
 * 4fc1520c): PID/FF in IEEE binary32 with C truncation then clamp; filter Hz in
 * integer `default * multiplier / 100`; skip-if-zero for filter fields.
 *
 * NOT AUTHORITATIVE for absolute values on a real craft. The shipped firmware
 * is built with -flto -ffast-math -Os; the compiled STM32F405 binary, executed,
 * differs from the plain C source (and so from this port) on 243,867 of
 * 1,001,681 x 3 axis results (docs/gyrocore/SAFETY_ENGINE.md). The flight
 * controller's own MSP_CALCULATE_SIMPLIFIED_PID is the authority. Not the
 * app's src/js/simplifiedTuning.ts either: that one computes in float64.
 */

import type { SimplifiedSliders } from "@/gyrocore/tuning/merge";

export const SIMPLIFIED_TUNING_PIDS_MIN = 0;
export const SIMPLIFIED_TUNING_FILTERS_MIN = 10;
export const SIMPLIFIED_TUNING_MAX = 200;

export const PID_SIMPLIFIED_TUNING_OFF = 0;
export const PID_SIMPLIFIED_TUNING_RP = 1;
export const PID_SIMPLIFIED_TUNING_RPY = 2;

export const PID_GAIN_MAX = 250;
export const F_GAIN_MAX = 1000;
const PID_DEFAULTS = [
    [45, 80, 30, 120],
    [47, 84, 34, 125],
    [45, 80, 0, 120],
] as const;
const D_MAX_DEFAULT = [40, 46, 0] as const;
const DTERM_LPF1_DYN_MIN_HZ_DEFAULT = 75;
const DTERM_LPF1_DYN_MAX_HZ_DEFAULT = 150;
const DTERM_LPF2_HZ_DEFAULT = 150;
export const LPF_MAX_HZ = 1000;
export const DYN_LPF_MAX_HZ = 1000;
const GYRO_LPF1_DYN_MIN_HZ_DEFAULT = 250;
const GYRO_LPF1_DYN_MAX_HZ_DEFAULT = 500;
const GYRO_LPF2_HZ_DEFAULT = 500;
const FD_PITCH = 1;

export const AXES = ["roll", "pitch", "yaw"] as const;
export type Axis = (typeof AXES)[number];
export const PID_FIELDS = ["p", "i", "d", "f", "d_max"] as const;
export type PidField = (typeof PID_FIELDS)[number];
export const FILTER_FIELDS = ["lpf1_dyn_min_hz", "lpf1_dyn_max_hz", "lpf1_static_hz", "lpf2_static_hz"] as const;
export type FilterField = (typeof FILTER_FIELDS)[number];

export type AxisPid = Record<PidField, number>;
export type FilterSet = Record<FilterField, number>;

export interface PidProfileState {
    roll: AxisPid;
    pitch: AxisPid;
    yaw: AxisPid;
    dterm: FilterSet;
    sliders: SimplifiedSliders;
}

export interface GyroConfigState {
    filters: FilterSet;
    sliders: SimplifiedSliders;
}

const f32 = Math.fround;
const fmul = (a: number, b: number) => f32(f32(a) * f32(b));
const fdiv = (a: number, b: number) => f32(f32(a) / f32(b));
const fadd = (a: number, b: number) => f32(f32(a) + f32(b));
const fsub = (a: number, b: number) => f32(f32(a) - f32(b));

/** `constrain(int,int,int)` after the C float-to-int conversion (toward 0). */
export function cConstrain(amt: number, low: number, high: number): number {
    const truncated = Math.trunc(f32(amt));
    return truncated < low ? low : truncated > high ? high : truncated;
}

/** Integer `default * multiplier / 100`, then constrain to [0, max]. */
export function cScaleHz(def: number, multiplier: number, max: number): number {
    return cConstrain(Math.floor((Math.trunc(def) * Math.trunc(multiplier)) / 100), 0, max);
}

/** Python `int(x)` on a slider: `int(None)` raises TypeError, `int(nan)` ValueError. */
function sliderInt(v: number | null, name: string): number {
    if (v === null) {
        throw new TypeError(`TypeError: slider ${name} is None`);
    }
    if (!Number.isFinite(v)) {
        throw new RangeError(`ValueError: slider ${name} is not finite`);
    }
    return Math.trunc(v);
}

const ratio = (slider: number) => fdiv(f32(slider), f32(100));

export function defaultSliders(): SimplifiedSliders {
    return {
        pids_mode: PID_SIMPLIFIED_TUNING_RPY,
        master_multiplier: 100,
        i_gain: 100,
        d_gain: 100,
        pi_gain: 100,
        d_max_gain: 100,
        feedforward_gain: 100,
        pitch_d_gain: 100,
        pitch_pi_gain: 100,
        dterm_filter: 1,
        dterm_filter_multiplier: 100,
        gyro_filter: 1,
        gyro_filter_multiplier: 100,
    };
}

const PIDS_SLIDERS = [
    "pids_mode",
    "master_multiplier",
    "i_gain",
    "d_gain",
    "pi_gain",
    "d_max_gain",
    "feedforward_gain",
    "pitch_d_gain",
    "pitch_pi_gain",
] as const;

export const missingForPids = (s: SimplifiedSliders) => PIDS_SLIDERS.filter((n) => s[n] === null);
export const missingForDterm = (s: SimplifiedSliders) =>
    (["dterm_filter", "dterm_filter_multiplier"] as const).filter((n) => s[n] === null);
export const missingForGyro = (s: SimplifiedSliders) =>
    (["gyro_filter", "gyro_filter_multiplier"] as const).filter((n) => s[n] === null);

export function firmwareDefaultPidProfile(): PidProfileState {
    const axis = (i: number): AxisPid => ({
        p: PID_DEFAULTS[i][0],
        i: PID_DEFAULTS[i][1],
        d: PID_DEFAULTS[i][2],
        f: PID_DEFAULTS[i][3],
        d_max: D_MAX_DEFAULT[i],
    });
    return {
        roll: axis(0),
        pitch: axis(1),
        yaw: axis(2),
        dterm: {
            lpf1_dyn_min_hz: DTERM_LPF1_DYN_MIN_HZ_DEFAULT,
            lpf1_dyn_max_hz: DTERM_LPF1_DYN_MAX_HZ_DEFAULT,
            lpf1_static_hz: DTERM_LPF1_DYN_MIN_HZ_DEFAULT,
            lpf2_static_hz: DTERM_LPF2_HZ_DEFAULT,
        },
        sliders: defaultSliders(),
    };
}

export function firmwareDefaultGyro(): GyroConfigState {
    return {
        filters: {
            lpf1_dyn_min_hz: GYRO_LPF1_DYN_MIN_HZ_DEFAULT,
            lpf1_dyn_max_hz: GYRO_LPF1_DYN_MAX_HZ_DEFAULT,
            lpf1_static_hz: GYRO_LPF1_DYN_MIN_HZ_DEFAULT,
            lpf2_static_hz: GYRO_LPF2_HZ_DEFAULT,
        },
        sliders: defaultSliders(),
    };
}

/** `calculateNewPidValues`: overwrites axes 0 .. simplified_pids_mode. */
export function calculateNewPidValues(profile: PidProfileState): PidProfileState {
    const s = profile.sliders;
    const mode = Math.trunc(s.pids_mode || 0);
    const master = ratio(sliderInt(s.master_multiplier, "master_multiplier"));
    const piGain = ratio(sliderInt(s.pi_gain, "pi_gain"));
    const dGain = ratio(sliderInt(s.d_gain, "d_gain"));
    const ffGain = ratio(sliderInt(s.feedforward_gain, "feedforward_gain"));
    const iGain = ratio(sliderInt(s.i_gain, "i_gain"));
    const axes = [profile.roll, profile.pitch, profile.yaw];
    const out: AxisPid[] = [];
    for (let axis = 0; axis < 3; axis++) {
        if (axis > mode) {
            out.push(axes[axis]);
            continue;
        }
        const pitchD = axis === FD_PITCH ? ratio(sliderInt(s.pitch_d_gain, "pitch_d_gain")) : f32(1);
        const pitchPi = axis === FD_PITCH ? ratio(sliderInt(s.pitch_pi_gain, "pitch_pi_gain")) : f32(1);
        const def = PID_DEFAULTS[axis];
        const p = cConstrain(fmul(fmul(fmul(f32(def[0]), master), piGain), pitchPi), 0, PID_GAIN_MAX);
        const i = cConstrain(fmul(fmul(fmul(fmul(f32(def[1]), master), piGain), iGain), pitchPi), 0, PID_GAIN_MAX);
        const d = cConstrain(fmul(fmul(fmul(f32(def[2]), master), dGain), pitchD), 0, PID_GAIN_MAX);
        const f = cConstrain(fmul(fmul(fmul(f32(def[3]), master), pitchPi), ffGain), 0, F_GAIN_MAX);
        const dMaxDefault = D_MAX_DEFAULT[axis];
        let dMaxGain = f32(1);
        if (dMaxDefault > 0) {
            const slider = ratio(sliderInt(s.d_max_gain, "d_max_gain"));
            // firmware: slider/100 + (1 - slider/100) * D / dMax   (* and / left to right)
            dMaxGain = fadd(slider, fdiv(fmul(fsub(f32(1), slider), f32(def[2])), f32(dMaxDefault)));
        }
        const dMax = cConstrain(
            fmul(fmul(fmul(fmul(f32(dMaxDefault), master), dGain), pitchD), dMaxGain),
            0,
            PID_GAIN_MAX,
        );
        out.push({ p, i, d, f, d_max: dMax });
    }
    return { ...profile, roll: out[0], pitch: out[1], yaw: out[2] };
}

export function applySimplifiedTuningPids(profile: PidProfileState): PidProfileState {
    const mode = profile.sliders.pids_mode;
    if (mode === null || mode === PID_SIMPLIFIED_TUNING_OFF) {
        return profile;
    }
    return calculateNewPidValues(profile);
}

function scaleFilters(f: FilterSet, m: number, dynMin: number, dynMax: number, lpf2: number): FilterSet {
    const out = { ...f };
    if (f.lpf1_dyn_min_hz) {
        out.lpf1_dyn_min_hz = cScaleHz(dynMin, m, DYN_LPF_MAX_HZ);
        out.lpf1_dyn_max_hz = cScaleHz(dynMax, m, DYN_LPF_MAX_HZ);
    }
    if (f.lpf1_static_hz) {
        out.lpf1_static_hz = cScaleHz(dynMin, m, DYN_LPF_MAX_HZ);
    }
    if (f.lpf2_static_hz) {
        out.lpf2_static_hz = cScaleHz(lpf2, m, LPF_MAX_HZ);
    }
    return out;
}

export function applySimplifiedTuningDtermFilters(profile: PidProfileState): PidProfileState {
    if (!profile.sliders.dterm_filter) {
        return profile;
    }
    const m = sliderInt(profile.sliders.dterm_filter_multiplier, "dterm_filter_multiplier");
    return {
        ...profile,
        dterm: scaleFilters(
            profile.dterm,
            m,
            DTERM_LPF1_DYN_MIN_HZ_DEFAULT,
            DTERM_LPF1_DYN_MAX_HZ_DEFAULT,
            DTERM_LPF2_HZ_DEFAULT,
        ),
    };
}

export function applySimplifiedTuningGyroFilters(gyro: GyroConfigState): GyroConfigState {
    if (!gyro.sliders.gyro_filter) {
        return gyro;
    }
    const m = sliderInt(gyro.sliders.gyro_filter_multiplier, "gyro_filter_multiplier");
    return {
        ...gyro,
        filters: scaleFilters(
            gyro.filters,
            m,
            GYRO_LPF1_DYN_MIN_HZ_DEFAULT,
            GYRO_LPF1_DYN_MAX_HZ_DEFAULT,
            GYRO_LPF2_HZ_DEFAULT,
        ),
    };
}

export function applySimplifiedTuning(
    profile: PidProfileState,
    gyro: GyroConfigState,
): [PidProfileState, GyroConfigState] {
    return [
        applySimplifiedTuningDtermFilters(applySimplifiedTuningPids(profile)),
        applySimplifiedTuningGyroFilters(gyro),
    ];
}

export interface FieldMismatch {
    field: string;
    current: number;
    expected_from_sliders: number;
}

/** SliderValidity.to_dict() keys. */
export interface SliderValidity {
    slider_pids_valid: boolean;
    slider_gyro_valid: boolean;
    slider_dterm_valid: boolean;
    pid_mismatches: FieldMismatch[];
    gyro_mismatches: FieldMismatch[];
    dterm_mismatches: FieldMismatch[];
    skipped_reasons: string[];
}

function pidMismatches(current: PidProfileState, applied: PidProfileState): FieldMismatch[] {
    const out: FieldMismatch[] = [];
    for (const name of AXES) {
        for (const f of PID_FIELDS) {
            if (current[name][f] !== applied[name][f]) {
                out.push({ field: `${name}.${f}`, current: current[name][f], expected_from_sliders: applied[name][f] });
            }
        }
    }
    return out;
}

function filterMismatches(prefix: string, current: FilterSet, applied: FilterSet): FieldMismatch[] {
    return FILTER_FIELDS.filter((f) => current[f] !== applied[f]).map((f) => ({
        field: `${prefix}.${f}`,
        current: current[f],
        expected_from_sliders: applied[f],
    }));
}

/** Recompute from the sliders and compare (MSP_VALIDATE_SIMPLIFIED_TUNING), with evidence. */
export function validateSimplifiedTuning(profile: PidProfileState, gyro: GyroConfigState): SliderValidity {
    const skipped: string[] = [];
    let pid: FieldMismatch[] = [];
    let pidsValid = false;
    const missingPids = missingForPids(profile.sliders);
    if (missingPids.length) {
        skipped.push(`pids_sliders_incomplete:${missingPids.join(",")}`);
    } else {
        pid = pidMismatches(profile, applySimplifiedTuningPids(profile));
        pidsValid = pid.length === 0;
    }
    let gyroMis: FieldMismatch[] = [];
    let gyroValid = false;
    const missingGyro = missingForGyro(gyro.sliders);
    if (missingGyro.length) {
        skipped.push(`gyro_sliders_incomplete:${missingGyro.join(",")}`);
    } else {
        gyroMis = filterMismatches("gyro", gyro.filters, applySimplifiedTuningGyroFilters(gyro).filters);
        gyroValid = gyroMis.length === 0;
    }
    let dterm: FieldMismatch[] = [];
    let dtermValid = false;
    const missingDterm = missingForDterm(profile.sliders);
    if (missingDterm.length) {
        skipped.push(`dterm_sliders_incomplete:${missingDterm.join(",")}`);
    } else {
        dterm = filterMismatches("dterm", profile.dterm, applySimplifiedTuningDtermFilters(profile).dterm);
        dtermValid = dterm.length === 0;
    }
    return {
        slider_pids_valid: pidsValid,
        slider_gyro_valid: gyroValid,
        slider_dterm_valid: dtermValid,
        pid_mismatches: pid,
        gyro_mismatches: gyroMis,
        dterm_mismatches: dterm,
        skipped_reasons: skipped,
    };
}

/** Sliders that fit uint8 / Autotune 25..250 but not the CLI minmax (0 or 10 .. 200). */
export function slidersOutsideCliRange(s: SimplifiedSliders): string[] {
    const out: string[] = [];
    const check = (names: readonly (keyof SimplifiedSliders)[], lo: number) => {
        for (const n of names) {
            const v = s[n];
            if (v !== null && !(v >= lo && v <= SIMPLIFIED_TUNING_MAX)) {
                out.push(n);
            }
        }
    };
    check(
        ["master_multiplier", "i_gain", "d_gain", "pi_gain", "pitch_d_gain", "pitch_pi_gain"],
        SIMPLIFIED_TUNING_PIDS_MIN,
    );
    check(["d_max_gain", "feedforward_gain"], 0);
    check(["dterm_filter_multiplier", "gyro_filter_multiplier"], SIMPLIFIED_TUNING_FILTERS_MIN);
    return out;
}
