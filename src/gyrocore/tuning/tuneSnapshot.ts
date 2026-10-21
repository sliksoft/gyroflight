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
 * The flight-controller values a simplified-tuning write can change, as read back
 * over MSP: the slider block and the filter Hz the firmware derived from it
 * (MSP_SIMPLIFIED_TUNING), the PIDs (MSP_PID) and feedforward / d_max
 * (MSP_PID_ADVANCED). A backup is one snapshot; verification compares a fresh
 * snapshot with what the firmware itself said it would produce
 * (MSP_CALCULATE_SIMPLIFIED_PID / _DTERM), never with values Gyroflight computed.
 */

export const SNAPSHOT_SLIDER_KEYS = [
    "slider_pids_mode",
    "slider_master_multiplier",
    "slider_roll_pitch_ratio",
    "slider_i_gain",
    "slider_d_gain",
    "slider_pi_gain",
    "slider_dmax_gain",
    "slider_feedforward_gain",
    "slider_pitch_pi_gain",
    "slider_dterm_filter",
    "slider_dterm_filter_multiplier",
    "slider_gyro_filter",
    "slider_gyro_filter_multiplier",
] as const;

export const DTERM_FILTER_KEYS = [
    "dterm_lowpass_hz",
    "dterm_lowpass2_hz",
    "dterm_lowpass_dyn_min_hz",
    "dterm_lowpass_dyn_max_hz",
] as const;
export const GYRO_FILTER_KEYS = [
    "gyro_lowpass_hz",
    "gyro_lowpass2_hz",
    "gyro_lowpass_dyn_min_hz",
    "gyro_lowpass_dyn_max_hz",
] as const;
export const SNAPSHOT_FILTER_KEYS = [...DTERM_FILTER_KEYS, ...GYRO_FILTER_KEYS] as const;

export const AXES = ["roll", "pitch", "yaw"] as const;
export type Axis = (typeof AXES)[number];
const FF_KEY: Record<Axis, string> = { roll: "feedforwardRoll", pitch: "feedforwardPitch", yaw: "feedforwardYaw" };
const DMAX_KEY: Record<Axis, string> = { roll: "dMaxRoll", pitch: "dMaxPitch", yaw: "dMaxYaw" };
export const SNAPSHOT_ADVANCED_KEYS = [...AXES.map((a) => FF_KEY[a]), ...AXES.map((a) => DMAX_KEY[a])];

export interface TuneSnapshot {
    sliders: Record<string, number>;
    filters: Record<string, number>;
    /** Every MSP_PID row as [P, I, D]; rows 0-2 are roll, pitch, yaw. */
    pids: number[][];
    advanced: Record<string, number>;
}

/** What the firmware said a write would produce (MSP_CALCULATE_SIMPLIFIED_PID / _DTERM / _GYRO). */
export interface FirmwareCalculation {
    pids: Partial<Record<Axis, [number, number, number]>>;
    advanced: Record<string, number>;
    dtermFilters: Record<string, number>;
    /** Absent: the gyro filters are expected unchanged. */
    gyroFilters?: Record<string, number>;
}

/** Axes the slider mode drives: 1 = roll+pitch, 2 = roll+pitch+yaw, 0 = none. */
export function sliderAxes(pidsMode: number): Axis[] {
    return pidsMode >= 2 ? ["roll", "pitch", "yaw"] : pidsMode === 1 ? ["roll", "pitch"] : [];
}

export function pick(src: Record<string, unknown>, keys: readonly string[]): Record<string, number> {
    return Object.fromEntries(keys.map((k) => [k, Number(src[k])]));
}

/** The snapshot expected after writing `proposed` over `before`: driven axes from the firmware, the rest unchanged. */
export function expectedAfterWrite(
    before: TuneSnapshot,
    proposed: Record<string, number>,
    calc: FirmwareCalculation,
): TuneSnapshot {
    const sliders = { ...before.sliders };
    for (const [k, v] of Object.entries(proposed)) {
        if (k in sliders) {
            sliders[k] = v;
        }
    }
    const axes = sliderAxes(sliders.slider_pids_mode);
    const pids = before.pids.map((row) => [...row]);
    const advanced = { ...before.advanced };
    for (const [i, axis] of AXES.entries()) {
        if (axes.includes(axis)) {
            const p = calc.pids[axis];
            if (p) {
                pids[i] = [...p];
            }
            for (const key of [FF_KEY[axis], DMAX_KEY[axis]]) {
                if (key in calc.advanced) {
                    advanced[key] = calc.advanced[key];
                }
            }
        }
    }
    const filters = {
        ...before.filters,
        ...pick(calc.dtermFilters, DTERM_FILTER_KEYS),
        ...(calc.gyroFilters ? pick(calc.gyroFilters, GYRO_FILTER_KEYS) : {}),
    };
    return { sliders, filters, pids, advanced };
}

/** Every field where `actual` differs from `expected`, e.g. "pid:roll:P expected 45 read 46". */
export function snapshotMismatches(expected: TuneSnapshot, actual: TuneSnapshot): string[] {
    const out: string[] = [];
    const cmp = (group: string, e: Record<string, number>, a: Record<string, number>) => {
        for (const k of Object.keys(e)) {
            if (e[k] !== a[k]) {
                out.push(`${group}:${k} expected ${e[k]} read ${a[k]}`);
            }
        }
    };
    cmp("slider", expected.sliders, actual.sliders);
    cmp("filter", expected.filters, actual.filters);
    cmp("advanced", expected.advanced, actual.advanced);
    const rows = Math.max(expected.pids.length, actual.pids.length);
    for (let i = 0; i < rows; i++) {
        const name = AXES[i] ?? `row${i}`;
        ["P", "I", "D"].forEach((term, j) => {
            const e = expected.pids[i]?.[j];
            const a = actual.pids[i]?.[j];
            if (e !== a) {
                out.push(`pid:${name}:${term} expected ${e} read ${a}`);
            }
        });
    }
    return out;
}

/** Live PIDs against the log's rollPID/pitchPID/yawPID: the tune must still be the logged one. */
export function pidsDifferFromLog(headerPairs: readonly (readonly [string, string])[], pids: number[][]): string[] {
    const keys: Record<Axis, string> = { roll: "rollPID", pitch: "pitchPID", yaw: "yawPID" };
    const out: string[] = [];
    for (const [i, axis] of AXES.entries()) {
        const raw = headerPairs.find(([k]) => k === keys[axis])?.[1];
        const logged = raw?.split(",").map((v) => Number(v.trim()));
        if (!logged || logged.length < 3 || logged.slice(0, 3).some((v, j) => v !== pids[i]?.[j])) {
            out.push(`fc:pids_differ_from_log:${axis}`);
        }
    }
    return out;
}

/** A stable identity of a snapshot (key order does not matter): binds a confirmation to what was shown. */
export function snapshotHash(s: TuneSnapshot): string {
    const sorted = (o: Record<string, number>) =>
        Object.keys(o)
            .sort()
            .map((k) => [k, o[k]]);
    const text = JSON.stringify([sorted(s.sliders), sorted(s.filters), s.pids, sorted(s.advanced)]);
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
}

const U8 = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 255;
const U16 = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 65535;

/** Why a stored snapshot cannot be written back as-is (missing or out-of-range values); empty when sound. */
export function snapshotIssues(s: TuneSnapshot | null | undefined): string[] {
    if (!s || typeof s !== "object") {
        return ["snapshot_missing"];
    }
    const out: string[] = [];
    for (const k of SNAPSHOT_SLIDER_KEYS) {
        if (!U8(s.sliders?.[k])) out.push(`slider:${k}`);
    }
    for (const k of SNAPSHOT_FILTER_KEYS) {
        if (!U16(s.filters?.[k])) out.push(`filter:${k}`);
    }
    for (const k of SNAPSHOT_ADVANCED_KEYS) {
        const ok = k.startsWith("feedforward") ? U16(s.advanced?.[k]) : U8(s.advanced?.[k]);
        if (!ok) out.push(`advanced:${k}`);
    }
    if (!Array.isArray(s.pids) || s.pids.length < 3) {
        out.push("pids:rows");
    } else {
        s.pids.forEach((row, i) => {
            if (!Array.isArray(row) || row.length !== 3 || !row.every(U8)) out.push(`pids:row${i}`);
        });
    }
    return out;
}

export interface SnapshotDiffRow {
    key: string;
    from: number | undefined;
    to: number | undefined;
}

/** Every field that differs between two snapshots, for showing a Restore before it happens. */
export function snapshotDiff(from: TuneSnapshot, to: TuneSnapshot): SnapshotDiffRow[] {
    const rows: SnapshotDiffRow[] = [];
    const cmp = (group: string, a: Record<string, number>, b: Record<string, number>) => {
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
            if (a[k] !== b[k]) rows.push({ key: `${group}:${k}`, from: a[k], to: b[k] });
        }
    };
    cmp("slider", from.sliders, to.sliders);
    cmp("filter", from.filters, to.filters);
    cmp("advanced", from.advanced, to.advanced);
    const n = Math.max(from.pids.length, to.pids.length);
    for (let i = 0; i < n; i++) {
        ["P", "I", "D"].forEach((t, j) => {
            if (from.pids[i]?.[j] !== to.pids[i]?.[j]) {
                rows.push({ key: `pid:${AXES[i] ?? `row${i}`}:${t}`, from: from.pids[i]?.[j], to: to.pids[i]?.[j] });
            }
        });
    }
    return rows;
}
