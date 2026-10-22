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
 * Absolute tune values for the v2 write route (pure; no MSP, no store).
 *
 * Every value the firmware holds in MSP_PID, MSP_PID_ADVANCED and MSP_FILTER_CONFIG is
 * named here by its CLI name, with the configurator store field it decodes into. The
 * write route reads all three blocks fresh, replaces only proposed fields, writes them
 * back and compares the read-back of every firmware-held field. Fields MSPHelper decodes
 * but the firmware does not hold (deprecated slots it sends as 0 and ignores on write)
 * are not listed, so they can neither fail nor pass a verification.
 *
 * Ranges are those of Betaflight 2026.6.2 src/main/cli/settings.c; MSP itself does not
 * clamp, so a proposal outside them never reaches the write.
 */

import { apiAtLeast } from "@/gyrocore/tuning/fcIdentity";

export type AbsoluteGroup = "pid" | "advanced" | "filter";

export interface AbsoluteField {
    /** Betaflight CLI name; the key in AbsoluteValues. */
    key: string;
    group: AbsoluteGroup;
    /** Field in fcStore.advancedTuning / fcStore.filterConfig (pid: "row:term"). */
    store: string;
    /** Proposals may change it. Every listed field is verified either way. */
    proposable: boolean;
    min: number;
    max: number;
    /** Only present from this MSP API on. */
    minApi?: string;
}

const AXIS_NAMES = ["roll", "pitch", "yaw"] as const;
export type AbsoluteAxis = (typeof AXIS_NAMES)[number];
const TERMS = ["p", "i", "d"] as const;

/** MSP_PID rows 0-2 (roll, pitch, yaw): P/I/D 0..PID_GAIN_MAX (250). */
const PID_FIELDS: AbsoluteField[] = AXIS_NAMES.flatMap((axis, row) =>
    TERMS.map((t, term) => ({
        key: `${t}_${axis}`,
        group: "pid" as const,
        store: `${row}:${term}`,
        proposable: true,
        min: 0,
        max: 250,
    })),
);

function adv(key: string, store: string, max: number, proposable = false, min = 0): AbsoluteField {
    return { key, group: "advanced", store, proposable, min, max };
}
function flt(key: string, store: string, max: number, proposable = false, min = 0, minApi?: string): AbsoluteField {
    return { key, group: "filter", store, proposable, min, max, ...(minApi ? { minApi } : {}) };
}

/** Firmware-held MSP_PID_ADVANCED fields, in firmware order (msp.c MSP_PID_ADVANCED). */
const ADVANCED_FIELDS: AbsoluteField[] = [
    adv("feedforward_transition", "feedforwardTransition", 100),
    adv("rate_accel_limit", "pidMaxVelocity", 65535),
    adv("yaw_rate_accel_limit", "pidMaxVelocityYaw", 65535),
    adv("angle_limit", "levelAngleLimit", 255),
    adv("anti_gravity_gain", "antiGravityGain", 65535),
    adv("iterm_rotation", "itermRotation", 1),
    adv("iterm_relax", "itermRelax", 255),
    adv("iterm_relax_type", "itermRelaxType", 255),
    adv("throttle_boost", "throttleBoost", 255),
    adv("acro_trainer_angle_limit", "acroTrainerAngleLimit", 255),
    adv("f_roll", "feedforwardRoll", 1000, true),
    adv("f_pitch", "feedforwardPitch", 1000, true),
    adv("f_yaw", "feedforwardYaw", 1000, true),
    adv("d_max_roll", "dMaxRoll", 250, true),
    adv("d_max_pitch", "dMaxPitch", 250, true),
    adv("d_max_yaw", "dMaxYaw", 250, true),
    adv("d_max_gain", "dMaxGain", 100),
    adv("d_max_advance", "dMaxAdvance", 200),
    adv("use_integrated_yaw", "useIntegratedYaw", 255),
    adv("integrated_yaw_relax", "integratedYawRelax", 255),
    adv("iterm_relax_cutoff", "itermRelaxCutoff", 255),
    adv("motor_output_limit", "motorOutputLimit", 255),
    // Signed (read8): -1 is valid; only compared, never proposed.
    adv("auto_profile_cell_count", "autoProfileCellCount", 127, false, -128),
    adv("dyn_idle_min_rpm", "idleMinRpm", 255),
    adv("feedforward_averaging", "feedforward_averaging", 3),
    adv("feedforward_smooth_factor", "feedforward_smooth_factor", 95, true),
    adv("feedforward_boost", "feedforward_boost", 50, true),
    adv("feedforward_max_rate_limit", "feedforward_max_rate_limit", 200),
    adv("feedforward_jitter_factor", "feedforward_jitter_factor", 20, true),
    adv("vbat_sag_compensation", "vbat_sag_compensation", 150),
    adv("thrust_linear", "thrustLinearization", 150),
    adv("tpa_mode", "tpaMode", 255),
    // MSPHelper stores tpa_rate / 100; AbsoluteValues hold the firmware's raw U8.
    adv("tpa_rate", "tpaRate", 100),
    adv("tpa_breakpoint", "tpaBreakpoint", 65535),
];

const API_RPM_EXT = "1.48.0";

/** Firmware-held MSP_FILTER_CONFIG fields, in firmware order (msp.c MSP_FILTER_CONFIG). */
const FILTER_FIELDS: AbsoluteField[] = [
    flt("gyro_lpf1_static_hz", "gyro_lowpass_hz", 1000, true),
    flt("dterm_lpf1_static_hz", "dterm_lowpass_hz", 1000, true),
    flt("yaw_lowpass_hz", "yaw_lowpass_hz", 65535),
    flt("gyro_notch1_hz", "gyro_notch_hz", 1000),
    flt("gyro_notch1_cutoff", "gyro_notch_cutoff", 1000),
    flt("dterm_notch_hz", "dterm_notch_hz", 1000),
    flt("dterm_notch_cutoff", "dterm_notch_cutoff", 1000),
    flt("gyro_notch2_hz", "gyro_notch2_hz", 1000),
    flt("gyro_notch2_cutoff", "gyro_notch2_cutoff", 1000),
    flt("dterm_lpf1_type", "dterm_lowpass_type", 3),
    flt("gyro_hardware_lpf", "gyro_hardware_lpf", 255),
    flt("gyro_lpf2_static_hz", "gyro_lowpass2_hz", 1000, true),
    flt("gyro_lpf1_type", "gyro_lowpass_type", 3),
    flt("gyro_lpf2_type", "gyro_lowpass2_type", 3),
    flt("dterm_lpf2_static_hz", "dterm_lowpass2_hz", 1000, true),
    flt("dterm_lpf2_type", "dterm_lowpass2_type", 3),
    flt("gyro_lpf1_dyn_min_hz", "gyro_lowpass_dyn_min_hz", 1000, true),
    flt("gyro_lpf1_dyn_max_hz", "gyro_lowpass_dyn_max_hz", 1000, true),
    flt("dterm_lpf1_dyn_min_hz", "dterm_lowpass_dyn_min_hz", 1000, true),
    flt("dterm_lpf1_dyn_max_hz", "dterm_lowpass_dyn_max_hz", 1000, true),
    flt("dyn_notch_q", "dyn_notch_q", 1000, true, 1),
    flt("dyn_notch_min_hz", "dyn_notch_min_hz", 250, true, 20),
    flt("rpm_filter_harmonics", "gyro_rpm_notch_harmonics", 3, true),
    flt("rpm_filter_min_hz", "gyro_rpm_notch_min_hz", 200, true, 30),
    flt("dyn_notch_max_hz", "dyn_notch_max_hz", 1000, true, 200),
    flt("dterm_lpf1_dyn_expo", "dyn_lpf_curve_expo", 10, true),
    flt("dyn_notch_count", "dyn_notch_count", 7, true),
    flt("rpm_filter_fade_range_hz", "gyro_rpm_notch_fade_range_hz", 1000, true, 0, API_RPM_EXT),
    flt("rpm_filter_q", "gyro_rpm_notch_q", 3000, true, 250, API_RPM_EXT),
    flt("rpm_filter_weights_1", "gyro_rpm_notch_weights:0", 100, true, 0, API_RPM_EXT),
    flt("rpm_filter_weights_2", "gyro_rpm_notch_weights:1", 100, true, 0, API_RPM_EXT),
    flt("rpm_filter_weights_3", "gyro_rpm_notch_weights:2", 100, true, 0, API_RPM_EXT),
];

export const ABSOLUTE_FIELDS: readonly AbsoluteField[] = [...PID_FIELDS, ...ADVANCED_FIELDS, ...FILTER_FIELDS];
const BY_KEY = new Map(ABSOLUTE_FIELDS.map((f) => [f.key, f]));

export function absoluteField(key: string): AbsoluteField | undefined {
    return BY_KEY.get(key);
}

/** The fields this MSP API carries. */
export function fieldsForApi(apiVersion: string): AbsoluteField[] {
    return ABSOLUTE_FIELDS.filter((f) => !f.minApi || apiAtLeast(apiVersion, f.minApi));
}

/** The simplified-tuning modes that make the firmware recompute PIDs / filters from sliders. */
export const SLIDER_MODE_KEYS = ["slider_pids_mode", "slider_dterm_filter", "slider_gyro_filter"] as const;

/** The oldest MSP API whose PID_ADVANCED / FILTER_CONFIG layout the absolute route writes. */
export const MIN_ABSOLUTE_API = "1.45.0";

/** Every firmware-held value of MSP_PID (all rows), MSP_PID_ADVANCED and MSP_FILTER_CONFIG. */
export type AbsoluteValues = Record<string, number>;

export interface AbsoluteSnapshot {
    apiVersion: string;
    /** MSP_SIMPLIFIED_TUNING: the modes and sliders (written back by Restore). */
    sliders: Record<string, number>;
    values: AbsoluteValues;
}

/** Plain-object views of the store blocks, so the conversion stays testable without Pinia. */
export interface StoreBlocks {
    pids: number[][];
    advancedTuning: Record<string, unknown>;
    filterConfig: Record<string, unknown>;
}

function pidRowKey(row: number, term: number): string {
    return row < 3 ? `${TERMS[term]}_${AXIS_NAMES[row]}` : `pid_row${row}_${TERMS[term]}`;
}

function readStoreField(blocks: StoreBlocks, f: AbsoluteField): number {
    if (f.group === "advanced") {
        const v = Number(blocks.advancedTuning[f.store]);
        return f.key === "tpa_rate" ? Math.round(v * 100) : v;
    }
    const [name, idx] = f.store.split(":");
    const raw = blocks.filterConfig[name];
    return Number(idx === undefined ? raw : Array.isArray(raw) ? raw[Number(idx)] : Number.NaN);
}

/** AbsoluteValues from the decoded store blocks (after fresh MSP_PID / _PID_ADVANCED / _FILTER_CONFIG reads). */
export function valuesFromStore(blocks: StoreBlocks, apiVersion: string): AbsoluteValues {
    const out: AbsoluteValues = {};
    // The store keeps 10 rows; the firmware sends PID_ITEM_COUNT (5) and the rest stay unset.
    blocks.pids.forEach((row, i) => {
        row.slice(0, 3).forEach((v, j) => {
            if (v !== undefined && v !== null && Number.isFinite(Number(v))) {
                out[pidRowKey(i, j)] = Number(v);
            }
        });
    });
    for (const f of fieldsForApi(apiVersion)) {
        if (f.group !== "pid") {
            out[f.key] = readStoreField(blocks, f);
        }
    }
    return out;
}

/** Writes `values` into the store blocks, so MSPHelper.crunch(MSP_SET_*) encodes exactly them. */
export function valuesToStore(values: AbsoluteValues, blocks: StoreBlocks, apiVersion: string): void {
    blocks.pids.forEach((row, i) => {
        for (let j = 0; j < 3; j++) {
            const v = values[pidRowKey(i, j)];
            if (v !== undefined) {
                row[j] = v;
            }
        }
    });
    for (const f of fieldsForApi(apiVersion)) {
        const v = values[f.key];
        if (f.group === "pid" || v === undefined) {
            continue;
        }
        if (f.group === "advanced") {
            blocks.advancedTuning[f.store] = f.key === "tpa_rate" ? v / 100 : v;
            continue;
        }
        const [name, idx] = f.store.split(":");
        if (idx === undefined) {
            blocks.filterConfig[name] = v;
        } else {
            const arr = Array.isArray(blocks.filterConfig[name]) ? [...(blocks.filterConfig[name] as number[])] : [];
            arr[Number(idx)] = v;
            blocks.filterConfig[name] = arr;
        }
    }
}

export function groupOf(key: string): AbsoluteGroup | null {
    if (/^pid_row\d+_[pid]$/.test(key)) {
        return "pid";
    }
    return BY_KEY.get(key)?.group ?? null;
}

/** Problems with a proposed change set against this firmware: unknown, read-only, out of range, inconsistent. */
export function changeSetIssues(change: AbsoluteValues, before: AbsoluteValues, apiVersion: string): string[] {
    const out: string[] = [];
    if (!apiAtLeast(apiVersion, MIN_ABSOLUTE_API)) {
        return ["absolute:api_version_unsupported"];
    }
    const keys = Object.keys(change);
    if (!keys.length) {
        out.push("absolute:empty_change");
    }
    for (const key of keys) {
        const f = BY_KEY.get(key);
        const v = change[key];
        if (!f) {
            out.push(`absolute:unknown_field:${key}`);
        } else if (!f.proposable) {
            out.push(`absolute:read_only_field:${key}`);
        } else if (f.minApi && !apiAtLeast(apiVersion, f.minApi)) {
            out.push(`absolute:field_needs_api:${key}:${f.minApi}`);
        } else if (!Number.isInteger(v) || v < f.min || v > f.max) {
            out.push(`absolute:out_of_range:${key}:${v}:${f.min}-${f.max}`);
        }
    }
    const after = { ...before, ...change };
    // validateAndFixConfig on the next EEPROM load would silently undo these: refuse them instead.
    for (const axis of AXIS_NAMES) {
        const dMax = after[`d_max_${axis}`];
        if (dMax !== undefined && dMax !== 0 && dMax < after[`d_${axis}`]) {
            out.push(`absolute:d_max_below_d:${axis}`);
        }
    }
    for (const [lo, hi] of [
        ["gyro_lpf1_dyn_min_hz", "gyro_lpf1_dyn_max_hz"],
        ["dterm_lpf1_dyn_min_hz", "dterm_lpf1_dyn_max_hz"],
        ["dyn_notch_min_hz", "dyn_notch_max_hz"],
    ]) {
        if (after[lo] > after[hi] && (lo in change || hi in change)) {
            out.push(`absolute:min_above_max:${lo}`);
        }
    }
    return out;
}

/** `before` with the change applied: what every firmware-held field must read back as. */
export function expectedValues(before: AbsoluteValues, change: AbsoluteValues): AbsoluteValues {
    return { ...before, ...change };
}

export function changedGroups(before: AbsoluteValues, after: AbsoluteValues): Set<AbsoluteGroup> {
    const groups = new Set<AbsoluteGroup>();
    for (const key of Object.keys(after)) {
        if (before[key] !== after[key]) {
            const g = groupOf(key);
            if (g) {
                groups.add(g);
            }
        }
    }
    return groups;
}

export interface AbsoluteDiffRow {
    key: string;
    group: AbsoluteGroup | "slider";
    from: number | undefined;
    to: number | undefined;
}

/** Every value that differs, with the slider modes first (switching them off is a change too). */
export function absoluteDiff(from: AbsoluteSnapshot, to: AbsoluteSnapshot): AbsoluteDiffRow[] {
    const rows: AbsoluteDiffRow[] = [];
    for (const k of new Set([...Object.keys(from.sliders), ...Object.keys(to.sliders)])) {
        if (from.sliders[k] !== to.sliders[k]) {
            rows.push({ key: k, group: "slider", from: from.sliders[k], to: to.sliders[k] });
        }
    }
    for (const k of new Set([...Object.keys(from.values), ...Object.keys(to.values)])) {
        if (from.values[k] !== to.values[k]) {
            rows.push({ key: k, group: groupOf(k) ?? "advanced", from: from.values[k], to: to.values[k] });
        }
    }
    return rows;
}

/** Fields of `expected` that `actual` does not hold. */
export function absoluteMismatches(expected: AbsoluteSnapshot, actual: AbsoluteSnapshot): string[] {
    return absoluteDiff(actual, expected)
        .filter((r) => r.to !== undefined)
        .map((r) => `${r.group}:${r.key} expected ${r.to} read ${r.from}`);
}

/** The modes switched off; sliders and LPF values otherwise as read. */
export function slidersOff(sliders: Record<string, number>): Record<string, number> {
    const out = { ...sliders };
    for (const k of SLIDER_MODE_KEYS) {
        out[k] = 0;
    }
    return out;
}

export function slidersActive(sliders: Record<string, number>): boolean {
    return SLIDER_MODE_KEYS.some((k) => Number(sliders[k]) !== 0);
}

export function absoluteHash(s: AbsoluteSnapshot): string {
    const sorted = (o: Record<string, number>) =>
        Object.keys(o)
            .sort()
            .map((k) => [k, o[k]]);
    const text = JSON.stringify([s.apiVersion, sorted(s.sliders), sorted(s.values)]);
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
}

/** Structural problems with a stored absolute snapshot (a Restore refuses any). */
export function absoluteSnapshotIssues(s: AbsoluteSnapshot | null | undefined): string[] {
    if (!s || typeof s !== "object" || typeof s.apiVersion !== "string") {
        return ["absolute_snapshot_missing"];
    }
    const out: string[] = [];
    for (const k of SLIDER_MODE_KEYS) {
        if (!Number.isInteger(s.sliders?.[k])) out.push(`slider:${k}`);
    }
    for (const f of fieldsForApi(s.apiVersion)) {
        // Integers only: a backup holds what the firmware held, which may lie outside the CLI range.
        if (!Number.isInteger(s.values?.[f.key])) out.push(`value:${f.key}`);
    }
    return out;
}

/** Logged header values (BBL "H name:value") that name an absolute field, split per index. */
export function loggedAbsoluteValues(headerPairs: readonly (readonly [string, string])[]): AbsoluteValues {
    const h = new Map(headerPairs.map(([k, v]) => [k, v]));
    const nums = (k: string) =>
        h
            .get(k)
            ?.split(",")
            .map((v) => Number(v.trim()));
    const out: AbsoluteValues = {};
    const put = (key: string, v: number | undefined) => {
        if (v !== undefined && Number.isFinite(v)) out[key] = v;
    };
    AXIS_NAMES.forEach((axis) => {
        const pid = nums(`${axis}PID`);
        TERMS.forEach((t, j) => put(`${t}_${axis}`, pid?.[j]));
    });
    const ff = nums("ff_weight");
    const dmax = nums("d_max");
    AXIS_NAMES.forEach((axis, i) => {
        put(`f_${axis}`, ff?.[i]);
        put(`d_max_${axis}`, dmax?.[i]);
    });
    const pairs: [string, string, number][] = [
        ["gyro_lpf1_dyn_min_hz", "gyro_lpf1_dyn_hz", 0],
        ["gyro_lpf1_dyn_max_hz", "gyro_lpf1_dyn_hz", 1],
        ["dterm_lpf1_dyn_min_hz", "dterm_lpf1_dyn_hz", 0],
        ["dterm_lpf1_dyn_max_hz", "dterm_lpf1_dyn_hz", 1],
        ["rpm_filter_weights_1", "rpm_filter_weights", 0],
        ["rpm_filter_weights_2", "rpm_filter_weights", 1],
        ["rpm_filter_weights_3", "rpm_filter_weights", 2],
    ];
    for (const [key, header, i] of pairs) put(key, nums(header)?.[i]);
    for (const key of [
        "d_max_gain",
        "d_max_advance",
        "feedforward_averaging",
        "feedforward_smooth_factor",
        "feedforward_jitter_factor",
        "feedforward_boost",
        "feedforward_max_rate_limit",
        "feedforward_transition",
        "tpa_mode",
        "tpa_rate",
        "tpa_breakpoint",
        "gyro_lpf1_static_hz",
        "gyro_lpf2_static_hz",
        "gyro_lpf1_type",
        "gyro_lpf2_type",
        "dterm_lpf1_static_hz",
        "dterm_lpf2_static_hz",
        "dterm_lpf1_type",
        "dterm_lpf2_type",
        "dterm_lpf1_dyn_expo",
        "yaw_lowpass_hz",
        "dyn_notch_count",
        "dyn_notch_q",
        "dyn_notch_min_hz",
        "dyn_notch_max_hz",
        "rpm_filter_harmonics",
        "rpm_filter_min_hz",
        "rpm_filter_fade_range_hz",
        "rpm_filter_q",
    ]) {
        put(key, nums(key)?.[0]);
    }
    return out;
}

/**
 * The blackbox header names no PID profile index, so "the active profile is the logged one"
 * is established by value: every logged profile- or filter-scoped value must equal the live one.
 */
export function liveDiffersFromLog(logged: AbsoluteValues, live: AbsoluteValues): string[] {
    const out: string[] = [];
    for (const [k, v] of Object.entries(logged)) {
        if (k in live && live[k] !== v) {
            out.push(`fc:live_differs_from_log:${k}`);
        }
    }
    for (const key of ["p_roll", "p_pitch", "p_yaw"]) {
        if (!(key in logged)) {
            out.push(`fc:log_missing_value:${key}`);
        }
    }
    return out;
}
