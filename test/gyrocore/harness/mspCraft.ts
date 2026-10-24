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
 * TEST ONLY: a simulated Betaflight flight controller behind the MSP mock, for the
 * Apply / Verify / Restore route (useTuneApply.ts). It answers the codes that route
 * uses the way MSPHelper's handlers fill the FC store, decodes the real write
 * payloads, keeps RAM and EEPROM apart, and injects the faults a real link has.
 *
 * Its simplified-tuning "firmware" is a small deterministic stand-in (not the real
 * simplified_tuning.c): what matters here is that CALCULATE and SET agree unless a
 * fault says otherwise, and that sliders at 100 give the logged PIDs.
 */

import MSPCodes from "../../../src/js/msp/MSPCodes";
import { useFlightControllerStore } from "../../../src/stores/fc";

export type Fault = "none" | "noreply" | "crc" | "unsupported" | "timeout" | "disconnect";

export interface Craft {
    uid: [number, number, number];
    manufacturerId: string;
    boardName: string;
    variant: string;
    version: string;
    apiVersion: string;
    armed: boolean;
    /** RAM. */
    sliders: Record<string, number>;
    filters: Record<string, number>;
    pids: number[][];
    advanced: Record<string, number>;
    /** What MSP_EEPROM_WRITE last saved (null: never). */
    eeprom: { sliders: Record<string, number>; pids: number[][]; advanced: Record<string, number> } | null;
    /** Fault per code, before any write was accepted. */
    faults: Partial<Record<number, Fault>>;
    /** Fault per code, only once a write was accepted (a read-back failure after writing). */
    faultsAfterWrite: Partial<Record<number, Fault>>;
    written: boolean;
    /** The FC acknowledges MSP_SET_SIMPLIFIED_TUNING but keeps its values. */
    ignoreWrites: boolean;
    /** After a write, roll P comes out one higher than MSP_CALCULATE said (a partial or wrong write). */
    skewAfterWrite: boolean;
    /** MSP_VALIDATE_SIMPLIFIED_TUNING reports the written PID sliders invalid. */
    validateInvalid: boolean;
    calls: { code: number; data: number[] | undefined }[];
}

const BASE = {
    pids: [
        [45, 80, 30],
        [47, 84, 34],
        [45, 80, 0],
    ],
    ff: { roll: 120, pitch: 125, yaw: 120 },
    dmax: { roll: 40, pitch: 46, yaw: 0 },
};

export const CRAFT_SLIDERS = {
    slider_pids_mode: 2,
    slider_master_multiplier: 100,
    slider_roll_pitch_ratio: 100,
    slider_i_gain: 100,
    slider_d_gain: 100,
    slider_pi_gain: 100,
    slider_dmax_gain: 100,
    slider_feedforward_gain: 100,
    slider_pitch_pi_gain: 100,
    slider_dterm_filter: 1,
    slider_dterm_filter_multiplier: 100,
    slider_gyro_filter: 1,
    slider_gyro_filter_multiplier: 100,
};
export const CRAFT_FILTERS = {
    dterm_lowpass_hz: 75,
    dterm_lowpass2_hz: 150,
    dterm_lowpass_dyn_min_hz: 75,
    dterm_lowpass_dyn_max_hz: 150,
    gyro_lowpass_hz: 250,
    gyro_lowpass2_hz: 500,
    gyro_lowpass_dyn_min_hz: 250,
    gyro_lowpass_dyn_max_hz: 500,
};

/** The stand-in firmware: PIDs, FF, d_max of the slider-driven axes for these sliders. */
export function firmwarePids(s: Record<string, number>, current: number[][], adv: Record<string, number>) {
    const pids = current.map((r) => [...r]);
    const advanced = { ...adv };
    const axes = s.slider_pids_mode >= 2 ? [0, 1, 2] : s.slider_pids_mode === 1 ? [0, 1] : [];
    const m = s.slider_master_multiplier / 100;
    const names = ["Roll", "Pitch", "Yaw"] as const;
    for (const i of axes) {
        const [p, ii, d] = BASE.pids[i];
        pids[i] = [
            Math.round(p * m * (s.slider_pi_gain / 100)),
            Math.round(ii * m * (s.slider_pi_gain / 100) * (s.slider_i_gain / 100)),
            Math.round(d * m * (s.slider_d_gain / 100)),
        ];
        const key = names[i].toLowerCase() as "roll" | "pitch" | "yaw";
        advanced[`feedforward${names[i]}`] = Math.round(BASE.ff[key] * m * (s.slider_feedforward_gain / 100));
        advanced[`dMax${names[i]}`] = Math.round(BASE.dmax[key] * m * (s.slider_d_gain / 100));
    }
    return { pids, advanced };
}

export function firmwareDterm(s: Record<string, number>, f: Record<string, number>) {
    if (!s.slider_dterm_filter) {
        return { ...f };
    }
    const k = s.slider_dterm_filter_multiplier / 100;
    return {
        ...f,
        dterm_lowpass_hz: Math.round(75 * k),
        dterm_lowpass2_hz: Math.round(150 * k),
        dterm_lowpass_dyn_min_hz: Math.round(75 * k),
        dterm_lowpass_dyn_max_hz: Math.round(150 * k),
    };
}

export function firmwareGyro(s: Record<string, number>, f: Record<string, number>) {
    if (!s.slider_gyro_filter) {
        return { ...f };
    }
    const k = s.slider_gyro_filter_multiplier / 100;
    return {
        ...f,
        gyro_lowpass_hz: Math.round(250 * k),
        gyro_lowpass2_hz: Math.round(500 * k),
        gyro_lowpass_dyn_min_hz: Math.round(250 * k),
        gyro_lowpass_dyn_max_hz: Math.round(500 * k),
    };
}

export function createCraft(overrides: Partial<Craft> = {}): Craft {
    const sliders = { ...CRAFT_SLIDERS };
    const pidsInit = [...BASE.pids.map((r) => [...r]), ...Array.from({ length: 7 }, () => [0, 0, 0])];
    const advInit = {
        feedforwardRoll: 0,
        feedforwardPitch: 0,
        feedforwardYaw: 0,
        dMaxRoll: 0,
        dMaxPitch: 0,
        dMaxYaw: 0,
    };
    const { pids, advanced } = firmwarePids(sliders, pidsInit, advInit);
    return {
        uid: [0x003e0021, 0x38415012, 0x20343141],
        manufacturerId: "BEFH",
        boardName: "BETAFPVG473",
        variant: "BTFL",
        version: "2026.6.2",
        apiVersion: "1.48.0",
        armed: false,
        sliders,
        filters: firmwareGyro(sliders, firmwareDterm(sliders, { ...CRAFT_FILTERS })),
        pids,
        advanced,
        eeprom: null,
        faults: {},
        faultsAfterWrite: {},
        written: false,
        ignoreWrites: false,
        skewAfterWrite: false,
        validateInvalid: false,
        calls: [],
        ...overrides,
    };
}

const u16 = (d: number[], at: number) => d[at] | (d[at + 1] << 8);

/** MSP_SET/CALCULATE payloads (MSPHelper write*SliderSettings). */
function decodePidSliders(d: number[]) {
    const keys = [
        "slider_pids_mode",
        "slider_master_multiplier",
        "slider_roll_pitch_ratio",
        "slider_i_gain",
        "slider_d_gain",
        "slider_pi_gain",
        "slider_dmax_gain",
        "slider_feedforward_gain",
        "slider_pitch_pi_gain",
    ];
    return Object.fromEntries(keys.map((k, i) => [k, d[i]]));
}
function decodeDterm(d: number[], at: number) {
    return {
        sliders: { slider_dterm_filter: d[at], slider_dterm_filter_multiplier: d[at + 1] },
        filters: {
            dterm_lowpass_hz: u16(d, at + 2),
            dterm_lowpass2_hz: u16(d, at + 4),
            dterm_lowpass_dyn_min_hz: u16(d, at + 6),
            dterm_lowpass_dyn_max_hz: u16(d, at + 8),
        },
    };
}

function fault(craft: Craft, code: number): Fault {
    return (craft.written ? craft.faultsAfterWrite[code] : undefined) ?? craft.faults[code] ?? "none";
}

/** The MSP.promise mock body: answers like the FC and fills the store like MSPHelper. */
export async function craftPromise(craft: Craft, code: number, data?: number[]) {
    craft.calls.push({ code, data: data ? Array.from(data) : undefined });
    const f = fault(craft, code);
    if (f === "timeout") {
        throw new Error("MSP timeout");
    }
    if (f === "disconnect") {
        throw new Error("MSP disconnected");
    }
    if (f === "noreply") {
        return undefined;
    }
    const reply = { command: code, crcError: f === "crc", unsupported: f === "unsupported" ? 1 : 0 };
    if (f === "crc" || f === "unsupported") {
        return reply;
    }
    const fc = useFlightControllerStore();
    const d = data ? Array.from(data) : [];
    switch (code) {
        case MSPCodes.MSP_API_VERSION:
            fc.config.apiVersion = craft.apiVersion;
            break;
        case MSPCodes.MSP_FC_VARIANT:
            fc.config.flightControllerIdentifier = craft.variant;
            break;
        case MSPCodes.MSP_FC_VERSION:
            fc.config.flightControllerVersion = craft.version;
            break;
        case MSPCodes.MSP_BOARD_INFO:
            fc.config.manufacturerId = craft.manufacturerId;
            fc.config.boardName = craft.boardName;
            break;
        case MSPCodes.MSP_UID:
            fc.config.uid = [...craft.uid];
            break;
        case MSPCodes.MSP_STATUS_EX:
            fc.config.mode = craft.armed ? 1 : 0;
            break;
        case MSPCodes.MSP_SIMPLIFIED_TUNING:
            Object.assign(fc.tuningSliders, craft.sliders);
            Object.assign(fc.filterConfig, craft.filters);
            break;
        case MSPCodes.MSP_PID:
            craft.pids.forEach((row, i) => fc.pids[i]?.splice(0, 3, ...row));
            break;
        case MSPCodes.MSP_PID_ADVANCED:
            Object.assign(fc.advancedTuning, craft.advanced);
            break;
        case MSPCodes.MSP_CALCULATE_SIMPLIFIED_PID: {
            const s = { ...craft.sliders, ...decodePidSliders(d) };
            const { pids, advanced } = firmwarePids(s, craft.pids, craft.advanced);
            const axes = s.slider_pids_mode >= 2 ? [0, 1, 2] : s.slider_pids_mode === 1 ? [0, 1] : [];
            for (const i of axes) {
                fc.pids[i].splice(0, 3, ...pids[i]);
            }
            Object.assign(fc.advancedTuning, advanced);
            break;
        }
        case MSPCodes.MSP_CALCULATE_SIMPLIFIED_DTERM: {
            const dt = decodeDterm(d, 0);
            Object.assign(fc.filterConfig, firmwareDterm({ ...craft.sliders, ...dt.sliders }, dt.filters));
            break;
        }
        case MSPCodes.MSP_CALCULATE_SIMPLIFIED_GYRO: {
            const g = { slider_gyro_filter: d[0], slider_gyro_filter_multiplier: d[1] };
            const gf = {
                gyro_lowpass_hz: u16(d, 2),
                gyro_lowpass2_hz: u16(d, 4),
                gyro_lowpass_dyn_min_hz: u16(d, 6),
                gyro_lowpass_dyn_max_hz: u16(d, 8),
            };
            Object.assign(fc.filterConfig, firmwareGyro({ ...craft.sliders, ...g }, gf));
            break;
        }
        case MSPCodes.MSP_SET_SIMPLIFIED_TUNING: {
            craft.written = true;
            if (craft.ignoreWrites) {
                break;
            }
            const dt = decodeDterm(d, 17);
            craft.sliders = {
                ...craft.sliders,
                ...decodePidSliders(d),
                ...dt.sliders,
                slider_gyro_filter: d[35],
                slider_gyro_filter_multiplier: d[36],
            };
            const { pids, advanced } = firmwarePids(craft.sliders, craft.pids, craft.advanced);
            craft.pids = pids;
            craft.advanced = advanced;
            craft.filters = firmwareGyro(
                craft.sliders,
                firmwareDterm(craft.sliders, { ...craft.filters, ...dt.filters }),
            );
            if (craft.skewAfterWrite) {
                craft.pids[0][0] += 1;
            }
            break;
        }
        case MSPCodes.MSP_SET_PID: {
            craft.written = true;
            const rows: number[][] = [];
            for (let i = 0; i + 2 < d.length; i += 3) {
                rows.push([d[i], d[i + 1], d[i + 2]]);
            }
            craft.pids = rows.map((r, i) => r ?? craft.pids[i]);
            break;
        }
        case MSPCodes.MSP_SET_PID_ADVANCED: {
            craft.written = true;
            for (const k of Object.keys(craft.advanced)) {
                craft.advanced[k] = Number((fc.advancedTuning as unknown as Record<string, number>)[k]);
            }
            break;
        }
        case MSPCodes.MSP_VALIDATE_SIMPLIFIED_TUNING:
            fc.tuningSliders.slider_pids_valid = craft.validateInvalid ? 0 : 1;
            fc.tuningSliders.slider_dterm_valid = 1;
            fc.tuningSliders.slider_gyro_valid = 1;
            break;
        case MSPCodes.MSP_EEPROM_WRITE:
            craft.eeprom = {
                sliders: { ...craft.sliders },
                pids: craft.pids.map((r) => [...r]),
                advanced: { ...craft.advanced },
            };
            break;
        default:
            return null;
    }
    return reply;
}

/** Every MSP read the Apply route makes before its first write, in order. */
export const APPLY_IDENTITY_READS = [
    MSPCodes.MSP_API_VERSION,
    MSPCodes.MSP_FC_VARIANT,
    MSPCodes.MSP_FC_VERSION,
    MSPCodes.MSP_BOARD_INFO,
    MSPCodes.MSP_UID,
    MSPCodes.MSP_STATUS_EX,
];

/** A verified, saved Apply: identity, live sliders, backup reads, firmware calculation, write, validation, read-back, save. */
export const APPLY_SUCCESS_SEQUENCE = [
    ...APPLY_IDENTITY_READS,
    MSPCodes.MSP_SIMPLIFIED_TUNING,
    MSPCodes.MSP_PID,
    MSPCodes.MSP_PID_ADVANCED,
    MSPCodes.MSP_CALCULATE_SIMPLIFIED_PID,
    MSPCodes.MSP_CALCULATE_SIMPLIFIED_DTERM,
    MSPCodes.MSP_CALCULATE_SIMPLIFIED_GYRO,
    MSPCodes.MSP_SET_SIMPLIFIED_TUNING,
    MSPCodes.MSP_VALIDATE_SIMPLIFIED_TUNING,
    MSPCodes.MSP_SIMPLIFIED_TUNING,
    MSPCodes.MSP_PID,
    MSPCodes.MSP_PID_ADVANCED,
    MSPCodes.MSP_EEPROM_WRITE,
    // Read again after the save: the firmware reloads and validates its config there.
    MSPCodes.MSP_SIMPLIFIED_TUNING,
    MSPCodes.MSP_PID,
    MSPCodes.MSP_PID_ADVANCED,
];

export const WRITE_CODES = new Set([
    MSPCodes.MSP_SET_SIMPLIFIED_TUNING,
    MSPCodes.MSP_SET_PID,
    MSPCodes.MSP_SET_PID_ADVANCED,
    MSPCodes.MSP_EEPROM_WRITE,
]);
