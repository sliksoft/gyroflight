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
 * A simulated Betaflight 2026.6.2 flight controller at byte level, for the absolute route.
 *
 * The tuning blocks are encoded and decoded in the order of the firmware's own handlers
 * (src/main/msp/msp.c: MSP_PID, MSP_PID_ADVANCED, MSP_FILTER_CONFIG, MSP_SIMPLIFIED_TUNING
 * and their MSP_SET_* readers, including the sbufBytesRemaining guards and the error
 * returns of MSP_SET_FILTER_CONFIG), written from msp.c and not from MSPHelper. Replies go
 * through the real MSPHelper decoders (mspHelper.process_data), and SET payloads are the
 * real MSPHelper encoders' output, so a disagreement between the two sides shows up as a
 * failed round trip. Identity codes (API, variant, version, board, UID, status) are set in
 * the store directly, as in mspCraft.ts.
 *
 * Firmware behaviour modelled because the route depends on it:
 *   - MSP_SET_SIMPLIFIED_TUNING stores sliders and the LPF values it carries, then applies the
 *     sliders only when a mode is on (simplified_tuning.c);
 *   - MSP_SET_FILTER_CONFIG returns an error for an invalid dyn_notch_count / RPM Q / weights
 *     after having stored the fields before them (a partial write), then runs
 *     validateAndFixGyroConfig (dyn LPF min > max → min 0);
 *   - MSP_EEPROM_WRITE is refused while armed and reloads the config through
 *     validateAndFixConfig (d_max < D → 0, D-term dyn LPF min > max → min 0).
 */

import MSPCodes from "../../../src/js/msp/MSPCodes";
import { mspHelper } from "../../../src/js/msp/MSPHelper";
import { MspDataView } from "../../../src/js/msp/mspBytes";
import { useFlightControllerStore } from "../../../src/stores/fc";
import type { Fault } from "./mspCraft";

const PID_ITEM_COUNT = 5;
const RPM_FILTER_HARMONICS_MAX = 3;
const DYN_NOTCH_COUNT_MAX = 7;

export interface FirmwareState {
    pids: number[][];
    /** pidProfile / gyroConfig / dynNotchConfig / rpmFilterConfig fields, firmware names. */
    p: Record<string, number>;
    rpmWeights: number[];
    sliders: Record<string, number>;
}

export interface FirmwareFc {
    apiVersion: string;
    uid: [number, number, number];
    manufacturerId: string;
    boardName: string;
    variant: string;
    version: string;
    armed: boolean;
    rebootRequired: boolean;
    ram: FirmwareState;
    eeprom: FirmwareState;
    faults: Partial<Record<number, Fault>>;
    /** Fault per code once this many writes were accepted (counting SETs and EEPROM). */
    faultsAfterWrites: { after: number; code: number; fault: Fault }[];
    writes: number;
    calls: { code: number; data: number[] }[];
    /** The firmware acknowledges this SET code but keeps its values. */
    ignoreWrite: Set<number>;
    /** The firmware stores this SET's fields, then answers MSP_RESULT_ERROR (as msp.c does on a late check). */
    errorAfterDecode: Set<number>;
    /** Extra config fixes on the EEPROM reload (stands in for validateAndFixConfig paths not modelled). */
    adjustOnReload?: (s: FirmwareState) => void;
    /**
     * A CRC-valid reply that is shorter than the firmware's: this many trailing payload bytes of
     * the code's reply are dropped (the frame itself is intact, so the transport accepts it).
     */
    truncate: Partial<Record<number, number>>;
}

const clone = (s: FirmwareState): FirmwareState => structuredClone(s);

/** AIR65 (BTFL_BLACKBOX_LOG_AIR65_C_20261018_231421 headers) as the default craft. */
export function air65FirmwareState(): FirmwareState {
    return {
        pids: [
            [56, 79, 30],
            [82, 117, 61],
            [56, 79, 0],
            [90, 75, 75],
            [40, 0, 0],
        ],
        p: {
            feedforward_transition: 0,
            rateAccelLimit: 0,
            yawRateAccelLimit: 0,
            angle_limit: 60,
            anti_gravity_gain: 80,
            iterm_rotation: 0,
            iterm_relax: 1,
            iterm_relax_type: 1,
            throttle_boost: 5,
            acro_trainer_angle_limit: 20,
            f_roll: 22,
            f_pitch: 32,
            f_yaw: 22,
            d_max_roll: 40,
            d_max_pitch: 0,
            d_max_yaw: 0,
            d_max_gain: 20,
            d_max_advance: 35,
            use_integrated_yaw: 0,
            integrated_yaw_relax: 200,
            iterm_relax_cutoff: 15,
            motor_output_limit: 100,
            auto_profile_cell_count: 0,
            dyn_idle_min_rpm: 40,
            feedforward_averaging: 1,
            feedforward_smooth_factor: 35,
            feedforward_boost: 18,
            feedforward_max_rate_limit: 90,
            feedforward_jitter_factor: 4,
            vbat_sag_compensation: 0,
            thrust_linear: 0,
            tpa_mode: 1,
            tpa_rate: 60,
            tpa_breakpoint: 1350,
            gyro_lpf1_static_hz: 150,
            dterm_lpf1_static_hz: 75,
            yaw_lowpass_hz: 100,
            gyro_soft_notch_hz_1: 0,
            gyro_soft_notch_cutoff_1: 0,
            dterm_notch_hz: 0,
            dterm_notch_cutoff: 0,
            gyro_soft_notch_hz_2: 0,
            gyro_soft_notch_cutoff_2: 0,
            dterm_lpf1_type: 0,
            gyro_hardware_lpf: 0,
            gyro_lpf2_static_hz: 300,
            gyro_lpf1_type: 0,
            gyro_lpf2_type: 0,
            dterm_lpf2_static_hz: 150,
            dterm_lpf2_type: 0,
            gyro_lpf1_dyn_min_hz: 150,
            gyro_lpf1_dyn_max_hz: 300,
            dterm_lpf1_dyn_min_hz: 75,
            dterm_lpf1_dyn_max_hz: 150,
            dyn_notch_q: 300,
            dyn_notch_min_hz: 100,
            rpm_filter_harmonics: 2,
            rpm_filter_min_hz: 100,
            dyn_notch_max_hz: 700,
            dterm_lpf1_dyn_expo: 5,
            dyn_notch_count: 2,
            rpm_filter_fade_range_hz: 50,
            rpm_filter_q: 500,
        },
        rpmWeights: [100, 100, 100],
        sliders: {
            slider_pids_mode: 0,
            slider_master_multiplier: 125,
            slider_roll_pitch_ratio: 100,
            slider_i_gain: 100,
            slider_d_gain: 100,
            slider_pi_gain: 100,
            slider_dmax_gain: 100,
            slider_feedforward_gain: 100,
            slider_pitch_pi_gain: 100,
            slider_dterm_filter: 0,
            slider_dterm_filter_multiplier: 100,
            slider_gyro_filter: 0,
            slider_gyro_filter_multiplier: 100,
        },
    };
}

export function createFirmwareFc(overrides: Partial<FirmwareFc> = {}): FirmwareFc {
    const ram = overrides.ram ?? air65FirmwareState();
    return {
        apiVersion: "1.48.0",
        uid: [0x0a1b2c3d, 0x4e5f6071, 0x12233445],
        manufacturerId: "BEFH",
        boardName: "BETAFPVG473",
        variant: "BTFL",
        version: "2026.6.2",
        armed: false,
        rebootRequired: false,
        eeprom: clone(ram),
        faults: {},
        faultsAfterWrites: [],
        writes: 0,
        calls: [],
        ignoreWrite: new Set(),
        errorAfterDecode: new Set(),
        truncate: {},
        ...overrides,
        ram,
    };
}

// --- byte helpers -----------------------------------------------------------

class Writer {
    bytes: number[] = [];
    u8(v: number) {
        this.bytes.push(v & 0xff);
        return this;
    }
    u16(v: number) {
        this.bytes.push(v & 0xff, (v >> 8) & 0xff);
        return this;
    }
    u32(v: number) {
        this.u16(v & 0xffff).u16((v >>> 16) & 0xffff);
        return this;
    }
}

class Reader {
    i = 0;
    constructor(readonly d: number[]) {}
    remaining() {
        return this.d.length - this.i;
    }
    u8() {
        return this.d[this.i++] ?? 0;
    }
    s8() {
        const v = this.u8();
        return v > 127 ? v - 256 : v;
    }
    u16() {
        return this.u8() | (this.u8() << 8);
    }
    u32() {
        return (this.u16() | (this.u16() << 16)) >>> 0;
    }
}

const apiGte = (api: string, min: string) => {
    const a = api.split(".").map(Number);
    const b = min.split(".").map(Number);
    for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
    return true;
};

// --- encoders (msp.c order) ---------------------------------------------------

function encodePid(s: FirmwareState): number[] {
    const w = new Writer();
    for (let i = 0; i < PID_ITEM_COUNT; i++) w.u8(s.pids[i][0]).u8(s.pids[i][1]).u8(s.pids[i][2]);
    return w.bytes;
}

function encodePidAdvanced(s: FirmwareState): number[] {
    const p = s.p;
    const w = new Writer();
    w.u16(0).u16(0).u16(0).u8(0).u8(0).u8(p.feedforward_transition).u8(0).u8(0).u8(0).u8(0);
    w.u16(p.rateAccelLimit).u16(p.yawRateAccelLimit).u8(p.angle_limit).u8(0).u16(0).u16(p.anti_gravity_gain);
    w.u16(0).u8(p.iterm_rotation).u8(0).u8(p.iterm_relax).u8(p.iterm_relax_type).u8(0);
    w.u8(p.throttle_boost).u8(p.acro_trainer_angle_limit).u16(p.f_roll).u16(p.f_pitch).u16(p.f_yaw).u8(0);
    w.u8(p.d_max_roll).u8(p.d_max_pitch).u8(p.d_max_yaw).u8(p.d_max_gain).u8(p.d_max_advance);
    w.u8(p.use_integrated_yaw).u8(p.integrated_yaw_relax).u8(p.iterm_relax_cutoff);
    w.u8(p.motor_output_limit).u8(p.auto_profile_cell_count).u8(p.dyn_idle_min_rpm);
    w.u8(p.feedforward_averaging).u8(p.feedforward_smooth_factor).u8(p.feedforward_boost);
    w.u8(p.feedforward_max_rate_limit).u8(p.feedforward_jitter_factor).u8(p.vbat_sag_compensation).u8(p.thrust_linear);
    w.u8(p.tpa_mode).u8(p.tpa_rate).u16(p.tpa_breakpoint);
    return w.bytes;
}

function encodeFilterConfig(s: FirmwareState, api: string): number[] {
    const p = s.p;
    const w = new Writer();
    w.u8(p.gyro_lpf1_static_hz).u16(p.dterm_lpf1_static_hz).u16(p.yaw_lowpass_hz);
    w.u16(p.gyro_soft_notch_hz_1).u16(p.gyro_soft_notch_cutoff_1).u16(p.dterm_notch_hz).u16(p.dterm_notch_cutoff);
    w.u16(p.gyro_soft_notch_hz_2).u16(p.gyro_soft_notch_cutoff_2).u8(p.dterm_lpf1_type).u8(p.gyro_hardware_lpf).u8(0);
    w.u16(p.gyro_lpf1_static_hz).u16(p.gyro_lpf2_static_hz).u8(p.gyro_lpf1_type).u8(p.gyro_lpf2_type);
    w.u16(p.dterm_lpf2_static_hz).u8(p.dterm_lpf2_type);
    w.u16(p.gyro_lpf1_dyn_min_hz).u16(p.gyro_lpf1_dyn_max_hz).u16(p.dterm_lpf1_dyn_min_hz).u16(p.dterm_lpf1_dyn_max_hz);
    w.u8(0).u8(0).u16(p.dyn_notch_q).u16(p.dyn_notch_min_hz).u8(p.rpm_filter_harmonics).u8(p.rpm_filter_min_hz);
    w.u16(p.dyn_notch_max_hz).u8(p.dterm_lpf1_dyn_expo).u8(p.dyn_notch_count);
    if (apiGte(api, "1.48.0")) {
        w.u16(p.rpm_filter_fade_range_hz).u16(p.rpm_filter_q);
        for (let i = 0; i < RPM_FILTER_HARMONICS_MAX; i++) w.u8(s.rpmWeights[i]);
    }
    return w.bytes;
}

function encodeSimplified(s: FirmwareState): number[] {
    const sl = s.sliders;
    const p = s.p;
    const w = new Writer();
    w.u8(sl.slider_pids_mode).u8(sl.slider_master_multiplier).u8(sl.slider_roll_pitch_ratio).u8(sl.slider_i_gain);
    w.u8(sl.slider_d_gain).u8(sl.slider_pi_gain).u8(sl.slider_dmax_gain).u8(sl.slider_feedforward_gain);
    w.u8(sl.slider_pitch_pi_gain).u32(0).u32(0);
    w.u8(sl.slider_dterm_filter).u8(sl.slider_dterm_filter_multiplier).u16(p.dterm_lpf1_static_hz);
    w.u16(p.dterm_lpf2_static_hz).u16(p.dterm_lpf1_dyn_min_hz).u16(p.dterm_lpf1_dyn_max_hz).u32(0).u32(0);
    w.u8(sl.slider_gyro_filter).u8(sl.slider_gyro_filter_multiplier).u16(p.gyro_lpf1_static_hz);
    w.u16(p.gyro_lpf2_static_hz).u16(p.gyro_lpf1_dyn_min_hz).u16(p.gyro_lpf1_dyn_max_hz).u32(0).u32(0);
    return w.bytes;
}

// --- decoders (msp.c MSP_SET_* order) ----------------------------------------

/** Returns false for MSP_RESULT_ERROR (fields read before the error stay stored, as in msp.c). */
function decodeSetPid(s: FirmwareState, d: number[]): boolean {
    const r = new Reader(d);
    for (let i = 0; i < PID_ITEM_COUNT; i++) s.pids[i] = [r.u8(), r.u8(), r.u8()];
    return true;
}

function decodeSetPidAdvanced(s: FirmwareState, d: number[]): boolean {
    const p = s.p;
    const r = new Reader(d);
    r.u16();
    r.u16();
    r.u16();
    r.u8();
    r.u8();
    p.feedforward_transition = r.u8();
    r.u8();
    r.u8();
    r.u8();
    r.u8();
    p.rateAccelLimit = r.u16();
    p.yawRateAccelLimit = r.u16();
    if (r.remaining() >= 2) {
        p.angle_limit = r.u8();
        r.u8();
    }
    if (r.remaining() >= 4) {
        r.u16();
        p.anti_gravity_gain = r.u16();
    }
    if (r.remaining() >= 2) r.u16();
    if (r.remaining() >= 14) {
        p.iterm_rotation = r.u8();
        r.u8();
        p.iterm_relax = r.u8();
        p.iterm_relax_type = r.u8();
        r.u8();
        p.throttle_boost = r.u8();
        p.acro_trainer_angle_limit = r.u8();
        p.f_roll = r.u16();
        p.f_pitch = r.u16();
        p.f_yaw = r.u16();
        r.u8();
    }
    if (r.remaining() >= 7) {
        p.d_max_roll = r.u8();
        p.d_max_pitch = r.u8();
        p.d_max_yaw = r.u8();
        p.d_max_gain = r.u8();
        p.d_max_advance = r.u8();
        p.use_integrated_yaw = r.u8();
        p.integrated_yaw_relax = r.u8();
    }
    if (r.remaining() >= 1) p.iterm_relax_cutoff = r.u8();
    if (r.remaining() >= 3) {
        p.motor_output_limit = r.u8();
        p.auto_profile_cell_count = r.s8();
        p.dyn_idle_min_rpm = r.u8();
    }
    if (r.remaining() >= 5) {
        p.feedforward_averaging = r.u8();
        p.feedforward_smooth_factor = r.u8();
        p.feedforward_boost = r.u8();
        p.feedforward_max_rate_limit = r.u8();
        p.feedforward_jitter_factor = r.u8();
    }
    if (r.remaining() >= 2) {
        p.vbat_sag_compensation = r.u8();
        p.thrust_linear = r.u8();
    }
    if (r.remaining() >= 4) {
        p.tpa_mode = r.u8();
        p.tpa_rate = r.u8();
        p.tpa_breakpoint = r.u16();
    }
    return true;
}

function decodeSetFilterConfig(s: FirmwareState, d: number[]): boolean {
    const p = s.p;
    const r = new Reader(d);
    p.gyro_lpf1_static_hz = r.u8();
    p.dterm_lpf1_static_hz = r.u16();
    p.yaw_lowpass_hz = r.u16();
    if (r.remaining() >= 8) {
        p.gyro_soft_notch_hz_1 = r.u16();
        p.gyro_soft_notch_cutoff_1 = r.u16();
        p.dterm_notch_hz = r.u16();
        p.dterm_notch_cutoff = r.u16();
    }
    if (r.remaining() >= 4) {
        p.gyro_soft_notch_hz_2 = r.u16();
        p.gyro_soft_notch_cutoff_2 = r.u16();
    }
    if (r.remaining() >= 1) p.dterm_lpf1_type = r.u8();
    if (r.remaining() >= 10) {
        p.gyro_hardware_lpf = r.u8();
        r.u8();
        p.gyro_lpf1_static_hz = r.u16();
        p.gyro_lpf2_static_hz = r.u16();
        p.gyro_lpf1_type = r.u8();
        p.gyro_lpf2_type = r.u8();
        p.dterm_lpf2_static_hz = r.u16();
    }
    if (r.remaining() >= 9) {
        p.dterm_lpf2_type = r.u8();
        p.gyro_lpf1_dyn_min_hz = r.u16();
        p.gyro_lpf1_dyn_max_hz = r.u16();
        p.dterm_lpf1_dyn_min_hz = r.u16();
        p.dterm_lpf1_dyn_max_hz = r.u16();
    }
    if (r.remaining() >= 8) {
        r.u8();
        r.u8();
        p.dyn_notch_q = r.u16();
        p.dyn_notch_min_hz = r.u16();
        p.rpm_filter_harmonics = r.u8();
        p.rpm_filter_min_hz = r.u8();
    }
    if (r.remaining() >= 2) p.dyn_notch_max_hz = r.u16();
    if (r.remaining() >= 2) {
        p.dterm_lpf1_dyn_expo = r.u8();
        const count = r.u8();
        if (count > DYN_NOTCH_COUNT_MAX) return false;
        p.dyn_notch_count = count;
    }
    if (r.remaining() >= 7) {
        const fade = r.u16();
        const q = r.u16();
        const weights = [r.u8(), r.u8(), r.u8()];
        if (q < 250 || q > 3000 || fade > 1000 || weights.some((w) => w > 100)) return false;
        p.rpm_filter_fade_range_hz = fade;
        p.rpm_filter_q = q;
        s.rpmWeights = weights;
    }
    // validateAndFixGyroConfig() runs right here in msp.c.
    if (p.gyro_lpf1_dyn_min_hz > p.gyro_lpf1_dyn_max_hz) p.gyro_lpf1_dyn_min_hz = 0;
    return true;
}

/** simplified_tuning.c, enough for the route: modes on recompute from the sliders. */
function applySimplified(s: FirmwareState) {
    const sl = s.sliders;
    const m = sl.slider_master_multiplier / 100;
    if (sl.slider_pids_mode > 0) {
        const axes = sl.slider_pids_mode >= 2 ? [0, 1, 2] : [0, 1];
        const base = [
            [45, 80, 30],
            [47, 84, 34],
            [45, 80, 0],
        ];
        for (const i of axes) {
            s.pids[i] = base[i].map((v, j) =>
                Math.round(v * m * (j === 2 ? sl.slider_d_gain / 100 : sl.slider_pi_gain / 100)),
            );
        }
    }
    if (sl.slider_dterm_filter) {
        const k = sl.slider_dterm_filter_multiplier / 100;
        s.p.dterm_lpf1_static_hz = Math.round(75 * k);
        s.p.dterm_lpf2_static_hz = Math.round(150 * k);
    }
    if (sl.slider_gyro_filter) {
        const k = sl.slider_gyro_filter_multiplier / 100;
        s.p.gyro_lpf1_static_hz = Math.round(250 * k);
        s.p.gyro_lpf2_static_hz = Math.round(500 * k);
    }
}

function decodeSetSimplified(s: FirmwareState, d: number[]): boolean {
    const r = new Reader(d);
    const sl = s.sliders;
    for (const k of [
        "slider_pids_mode",
        "slider_master_multiplier",
        "slider_roll_pitch_ratio",
        "slider_i_gain",
        "slider_d_gain",
        "slider_pi_gain",
        "slider_dmax_gain",
        "slider_feedforward_gain",
        "slider_pitch_pi_gain",
    ]) {
        sl[k] = r.u8();
    }
    r.u32();
    r.u32();
    sl.slider_dterm_filter = r.u8();
    sl.slider_dterm_filter_multiplier = r.u8();
    s.p.dterm_lpf1_static_hz = r.u16();
    s.p.dterm_lpf2_static_hz = r.u16();
    s.p.dterm_lpf1_dyn_min_hz = r.u16();
    s.p.dterm_lpf1_dyn_max_hz = r.u16();
    r.u32();
    r.u32();
    sl.slider_gyro_filter = r.u8();
    sl.slider_gyro_filter_multiplier = r.u8();
    s.p.gyro_lpf1_static_hz = r.u16();
    s.p.gyro_lpf2_static_hz = r.u16();
    s.p.gyro_lpf1_dyn_min_hz = r.u16();
    s.p.gyro_lpf1_dyn_max_hz = r.u16();
    applySimplified(s);
    return true;
}

/** config.c validateAndFixConfig on reload, the parts the absolute fields can trigger. */
function validateAndFixConfig(s: FirmwareState) {
    for (let axis = 0; axis < 3; axis++) {
        const key = ["d_max_roll", "d_max_pitch", "d_max_yaw"][axis];
        if (s.p[key] < s.pids[axis][2]) s.p[key] = 0;
    }
    if (s.p.dterm_lpf1_dyn_min_hz > s.p.dterm_lpf1_dyn_max_hz) s.p.dterm_lpf1_dyn_min_hz = 0;
    if (s.p.gyro_lpf1_dyn_min_hz > s.p.gyro_lpf1_dyn_max_hz) s.p.gyro_lpf1_dyn_min_hz = 0;
}

// --- the MSP.promise stand-in --------------------------------------------------

/** Decode a reply through the real MSPHelper; the resolved response carries its length, as msp.ts does. */
function deliver(fc: FirmwareFc, code: number, full: number[]) {
    const bytes = full.slice(0, Math.max(0, full.length - (fc.truncate[code] ?? 0)));
    const view = new MspDataView(Uint8Array.from(bytes).buffer);
    mspHelper.process_data({ code, dataView: view, crcError: false, unsupported: 0, callbacks: [] });
    return { command: code, crcError: false, unsupported: 0, length: bytes.length };
}

function currentFault(fc: FirmwareFc, code: number): Fault {
    for (const f of fc.faultsAfterWrites) {
        if (f.code === code && fc.writes >= f.after) return f.fault;
    }
    return fc.faults[code] ?? "none";
}

export async function firmwarePromise(fc: FirmwareFc, code: number, data?: number[]) {
    const d = data ? Array.from(data) : [];
    fc.calls.push({ code, data: d });
    const f = currentFault(fc, code);
    if (f === "timeout") throw new Error("MSP timeout");
    if (f === "disconnect") throw new Error("MSP disconnected");
    if (f === "noreply") return undefined;
    const ok = { command: code, crcError: false, unsupported: 0 };
    const err = { command: code, crcError: false, unsupported: 1 };
    if (f === "crc") return { ...ok, crcError: true };
    if (f === "unsupported") return err;

    const store = useFlightControllerStore();
    switch (code) {
        case MSPCodes.MSP_API_VERSION:
            store.config.apiVersion = fc.apiVersion;
            return ok;
        case MSPCodes.MSP_FC_VARIANT:
            store.config.flightControllerIdentifier = fc.variant;
            return ok;
        case MSPCodes.MSP_FC_VERSION:
            store.config.flightControllerVersion = fc.version;
            return ok;
        case MSPCodes.MSP_BOARD_INFO:
            store.config.manufacturerId = fc.manufacturerId;
            store.config.boardName = fc.boardName;
            return ok;
        case MSPCodes.MSP_UID:
            store.config.uid = [...fc.uid];
            return ok;
        case MSPCodes.MSP_STATUS_EX:
            store.config.mode = fc.armed ? 1 : 0;
            store.config.configStateFlag = fc.rebootRequired ? 1 : 0;
            return ok;
        case MSPCodes.MSP_PID:
            return deliver(fc, code, encodePid(fc.ram));
        case MSPCodes.MSP_PID_ADVANCED:
            return deliver(fc, code, encodePidAdvanced(fc.ram));
        case MSPCodes.MSP_FILTER_CONFIG:
            return deliver(fc, code, encodeFilterConfig(fc.ram, fc.apiVersion));
        case MSPCodes.MSP_SIMPLIFIED_TUNING:
            return deliver(fc, code, encodeSimplified(fc.ram));
        case MSPCodes.MSP_SET_PID:
        case MSPCodes.MSP_SET_PID_ADVANCED:
        case MSPCodes.MSP_SET_FILTER_CONFIG:
        case MSPCodes.MSP_SET_SIMPLIFIED_TUNING: {
            fc.writes++;
            if (fc.ignoreWrite.has(code)) return ok;
            const decode = {
                [MSPCodes.MSP_SET_PID]: decodeSetPid,
                [MSPCodes.MSP_SET_PID_ADVANCED]: decodeSetPidAdvanced,
                [MSPCodes.MSP_SET_FILTER_CONFIG]: decodeSetFilterConfig,
                [MSPCodes.MSP_SET_SIMPLIFIED_TUNING]: decodeSetSimplified,
            }[code]!;
            const accepted = decode(fc.ram, d);
            return accepted && !fc.errorAfterDecode.has(code) ? ok : err;
        }
        case MSPCodes.MSP_EEPROM_WRITE:
            if (fc.armed) return err;
            fc.writes++;
            fc.eeprom = clone(fc.ram);
            // writeReadEeprom: readEEPROM → validateAndFixConfig → activateConfig.
            validateAndFixConfig(fc.ram);
            fc.adjustOnReload?.(fc.ram);
            fc.eeprom = clone(fc.ram);
            return ok;
        default:
            return null;
    }
}

/** Every MSP code that changes the flight controller. */
export const FIRMWARE_WRITE_CODES = new Set([
    MSPCodes.MSP_SET_PID,
    MSPCodes.MSP_SET_PID_ADVANCED,
    MSPCodes.MSP_SET_FILTER_CONFIG,
    MSPCodes.MSP_SET_SIMPLIFIED_TUNING,
    MSPCodes.MSP_EEPROM_WRITE,
]);

export const firmwareCodecs = { encodePid, encodePidAdvanced, encodeFilterConfig, encodeSimplified };
export const firmwareDecoders = { decodeSetPid, decodeSetPidAdvanced, decodeSetFilterConfig, decodeSetSimplified };
