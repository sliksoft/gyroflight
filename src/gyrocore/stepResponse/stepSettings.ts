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
 * The tune settings a step-response A/B compares, grouped as the user changes them
 * (docs/gyrocore/STEP_RESPONSE.md §5). Values are compared as logged header text; a setting
 * missing from one or both logs is UNKNOWN ("not logged"), and UNKNOWN never counts as MATCH. The
 * only exception is a setting the firmware source shows the logged build does not have
 * (STEP_FIRMWARE_ABSENT).
 *
 * The simplified_* slider keys are not compared: the firmware logs the PID, D Max, feedforward and
 * filter values the sliders produce, and those are compared here, so a slider move shows up in
 * the group whose values it changed.
 */

export type SettingGroup =
    "p" | "i" | "d" | "dMax" | "feedforward" | "dtermFilter" | "gyroFilter" | "tpa" | "itermRelax" | "rates";

export const SETTING_GROUPS: readonly SettingGroup[] = [
    "p",
    "i",
    "d",
    "dMax",
    "feedforward",
    "dtermFilter",
    "gyroFilter",
    "tpa",
    "itermRelax",
    "rates",
];

/** A setting: header key, or one element of a comma list (`rollPID` element 0 = roll P). */
interface SettingDef {
    id: string;
    key: string;
    /** Header keys that mean the same setting in other firmware versions (e.g. d_min / d_max). */
    aliases?: string[];
    element?: number;
}

const pid = (term: 0 | 1 | 2, name: string): SettingDef[] =>
    (["roll", "pitch", "yaw"] as const).map((axis) => ({ id: `${axis}_${name}`, key: `${axis}PID`, element: term }));

const keys = (...k: string[]): SettingDef[] => k.map((key) => ({ id: key, key }));

export const GROUP_SETTINGS: Readonly<Record<SettingGroup | "other", readonly SettingDef[]>> = {
    p: pid(0, "p"),
    i: pid(1, "i"),
    d: pid(2, "d"),
    dMax: [{ id: "d_max", key: "d_max", aliases: ["d_min"] }, ...keys("d_max_gain", "d_max_advance")],
    feedforward: keys(
        "ff_weight",
        "feedforward_transition",
        "feedforward_averaging",
        "feedforward_smooth_factor",
        "feedforward_jitter_factor",
        "feedforward_boost",
        "feedforward_max_rate_limit",
        "feedforward_yaw_hold_gain",
        "feedforward_yaw_hold_time",
    ),
    dtermFilter: keys(
        "dterm_lpf1_type",
        "dterm_lpf1_static_hz",
        "dterm_lpf1_dyn_hz",
        "dterm_lpf1_dyn_expo",
        "dterm_lpf2_type",
        "dterm_lpf2_static_hz",
        "dterm_notch_hz",
        "dterm_notch_cutoff",
        "yaw_lowpass_hz",
    ),
    gyroFilter: keys(
        "gyro_lpf1_type",
        "gyro_lpf1_static_hz",
        "gyro_lpf1_dyn_hz",
        "gyro_lpf1_dyn_expo",
        "gyro_lpf2_type",
        "gyro_lpf2_static_hz",
        "gyro_notch_hz",
        "gyro_notch_cutoff",
        "dyn_notch_count",
        "dyn_notch_q",
        "dyn_notch_min_hz",
        "dyn_notch_max_hz",
        "rpm_filter_harmonics",
        "rpm_filter_weights",
        "rpm_filter_q",
        "rpm_filter_min_hz",
        "rpm_filter_fade_range_hz",
        "rpm_filter_lpf_hz",
        "gyro_hardware_lpf",
    ),
    tpa: keys("tpa_mode", "tpa_rate", "tpa_breakpoint", "tpa_low_rate", "tpa_low_breakpoint", "tpa_low_always"),
    itermRelax: keys("iterm_relax", "iterm_relax_type", "iterm_relax_cutoff"),
    rates: keys("rates_type", "rc_rates", "rc_expo", "rates", "rate_limits"),
    /**
     * Not a selectable change, but read by the loop during the flight: must MATCH in every A/B.
     * Named here for the report; every other logged key not excluded below is compared as well.
     */
    other: [
        ...keys(
            "looptime",
            "pid_process_denom",
            "gyro_sync_denom",
            "iterm_windup",
            "anti_gravity_gain",
            "anti_gravity_cutoff_hz",
            "anti_gravity_p_gain",
            "pidsum_limit",
            "pidsum_limit_yaw",
            "use_integrated_yaw",
            "abs_control_gain",
            "motor_output_limit",
            "thrust_linear",
            "vbat_sag_compensation",
            "throttle_boost",
            "throttle_boost_cutoff",
            "mixer_type",
            "motor_pwm_protocol",
            "dyn_idle_min_rpm",
            "dyn_idle_p_gain",
            "dyn_idle_i_gain",
            "dyn_idle_d_gain",
            "dyn_idle_max_increase",
            "rc_smoothing",
            "rc_smoothing_auto_factor",
            "rc_smoothing_setpoint_cutoff",
            "rc_smoothing_feedforward_cutoff",
            "deadband",
            "yaw_deadband",
            "throttle_limit_type",
            "throttle_limit_percent",
            "pid_at_min_throttle",
        ),
        // renamed from dshot_idle_value in firmware 5ffeea6ab (#13936), first released in 2026.6.0: same
        // range and unit for DShot. With analog PWM the old key had no effect, so a MATCH across the
        // rename would mean less there; such a pair already fails same_firmware (Grok r9).
        { id: "motor_idle", key: "motor_idle", aliases: ["dshot_idle_value"] },
    ],
};

/**
 * A setting missing from one log, or from both, is UNKNOWN: its effective value in that flight is
 * not known, and UNKNOWN never counts as MATCH (two missing values are not two equal values).
 * NOT_IN_FIRMWARE is the one exception: both logs name a build that STEP_FIRMWARE_ABSENT lists as
 * not having the setting, so it has no effect in either flight.
 */
export type SettingMatch = "MATCH" | "DIFF" | "UNKNOWN" | "NOT_IN_FIRMWARE";

export interface SettingRow {
    group: SettingGroup | "other";
    id: string;
    a: string | null;
    b: string | null;
    status: SettingMatch;
    /** Which log lacks the value (UNKNOWN only); null when both have one (a conflicting duplicate). */
    missing: "a" | "b" | "both" | null;
    /** NOT_IN_FIRMWARE only: the build and the firmware change that shows the setting is absent. */
    firmware?: { build: string; source: string };
}

/** A key logged more than once with different values: never a value (fail closed, Grok r4). */
const CONFLICT = Symbol("conflicting duplicate header key");
type HeaderValue = string | null | typeof CONFLICT;

/** The trimmed value of `key`, null when absent, CONFLICT when repeated with different values. */
function headerValue(pairs: readonly (readonly [string, string])[], key: string): HeaderValue {
    const values = new Set(pairs.filter(([k]) => k === key).map(([, v]) => v.trim()));
    if (!values.size) return null;
    if (values.size > 1) return CONFLICT;
    const v = [...values][0];
    // An empty value is a missing value, not one equal to another empty value.
    return v === "" ? null : v;
}

function lookup(pairs: readonly (readonly [string, string])[], def: SettingDef): HeaderValue {
    // A log carrying both a key and its alias (d_max and d_min) is ambiguous: never a value (Grok r5).
    const names = [def.key, ...(def.aliases ?? [])];
    if (names.filter((k) => pairs.some(([p]) => p === k)).length > 1) return CONFLICT;
    for (const key of names) {
        const v = headerValue(pairs, key);
        if (v === null) continue;
        if (v === CONFLICT || def.element === undefined) return v;
        const part = v.split(",")[def.element]?.trim();
        return part ? part : null;
    }
    return null;
}

/**
 * Values the firmware computes from the measured RX frame rate (not set by the user). They jitter
 * between two logs on the same link (AIR65 20261106_011849: 106 and 107 Hz), so each element is
 * compared with this relative tolerance; a link change (125 → 250 Hz, a factor 2) stays a DIFF.
 * The tolerance was chosen after seeing that jitter on the AIR65 logs.
 */
export const LINK_DERIVED_TOLERANCE = 0.05;
const LINK_DERIVED_KEYS = [/^rc_smoothing_active_cutoffs/, /^rc_smoothing_rx_smoothed$/];

const DECIMAL = /^-?\d+(\.\d+)?$/;

function sameWithin(a: string, b: string, rel: number): boolean {
    const ea = a.split(",").map((x) => x.trim());
    const eb = b.split(",").map((x) => x.trim());
    // Only plain decimals are compared numerically; an empty, hex or exponent element falls back to
    // exact text (Number("") is 0, which would match "0": fail open, Grok r6).
    if (ea.length !== eb.length || [...ea, ...eb].some((x) => !DECIMAL.test(x))) return a === b;
    const pa = ea.map(Number);
    const pb = eb.map(Number);
    return pa.every((x, i) => Math.abs(x - pb[i]) <= rel * Math.max(Math.abs(x), Math.abs(pb[i])));
}

/**
 * Settings the firmware source shows a build does not have, keyed by the build hash that the log's
 * "Firmware revision" names. Each entry was checked in src/main/cli/settings.c, parameter_names.h
 * and blackbox.c at that hash, and against the AIR65 headers of that build. A setting missing from
 * both logs is NOT_IN_FIRMWARE only when both logs name the same listed build; any other build, or
 * a setting not listed, stays UNKNOWN. A build is added only after the same source check.
 */
const BF_2026_6_ABSENT = [
    { id: "abs_control_gain", source: "19ddd692c Remove absolute control (#15023)" },
    {
        id: "rc_smoothing_feedforward_cutoff",
        source:
            "67abb0d1e (#14411): feedforward is smoothed with the setpoint cutoff, compared as " +
            "rc_smoothing_setpoint_cutoff and rc_smoothing_active_cutoffs_ff_sp_thr",
    },
] as const;

export const STEP_FIRMWARE_ABSENT: Readonly<Record<string, readonly { id: string; source: string }[]>> = {
    // Betaflight 2026.6.2 builds of the AIR65 (VliegAI fork)
    "43875a55a": BF_2026_6_ABSENT,
    "3356aeb02": BF_2026_6_ABSENT,
    // Betaflight 4.5.1: feedforward yaw hold was added in f2bd6e69b (#13576), first in 2026.6.0
    "77d01ba3b": [
        { id: "feedforward_yaw_hold_gain", source: "f2bd6e69b (#13576), not in 4.5.x" },
        { id: "feedforward_yaw_hold_time", source: "f2bd6e69b (#13576), not in 4.5.x" },
    ],
};

/**
 * The listed build both revisions name in the Betaflight form "Betaflight <x.y.z> (<hash>) <target>":
 * the hash only in parentheses right after the version (Grok r9). A longer hex string is another build.
 */
function sharedBuild(revA: HeaderValue, revB: HeaderValue): string | null {
    if (typeof revA !== "string" || typeof revB !== "string") return null;
    const has = (rev: string, hash: string) =>
        new RegExp(`^Betaflight \\d+\\.\\d+\\.\\d+ \\(${hash}\\)( |$)`).test(rev);
    return Object.keys(STEP_FIRMWARE_ABSENT).find((h) => has(revA, h) && has(revB, h)) ?? null;
}

function row(
    group: SettingGroup | "other",
    id: string,
    va: HeaderValue,
    vb: HeaderValue,
    build: string | null,
): SettingRow {
    const shown = (v: HeaderValue) => (v === CONFLICT ? "duplicate_key_conflict" : v);
    const base = { group, id, a: shown(va), b: shown(vb) };
    if (va === CONFLICT || vb === CONFLICT) return { ...base, status: "UNKNOWN", missing: null };
    if (va === null && vb === null) {
        const absent = build ? STEP_FIRMWARE_ABSENT[build].find((e) => e.id === id) : undefined;
        return absent
            ? { ...base, status: "NOT_IN_FIRMWARE", missing: null, firmware: { build: build!, source: absent.source } }
            : { ...base, status: "UNKNOWN", missing: "both" };
    }
    if (va === null || vb === null) return { ...base, status: "UNKNOWN", missing: va === null ? "a" : "b" };
    const same = va === vb || (LINK_DERIVED_KEYS.some((k) => k.test(id)) && sameWithin(va, vb, LINK_DERIVED_TOLERANCE));
    return { ...base, status: same ? "MATCH" : "DIFF", missing: null };
}

/**
 * Header keys that are not tune settings, or have no effect on the Acro windows used, and are
 * therefore not compared. Everything else in either log is (fail closed: an unlisted key that
 * differs is a change in "other").
 */
export const NOT_COMPARED_KEYS: readonly (string | RegExp)[] = [
    // identity, format and logging (identity and logging rate are separate A/B checks)
    "Product",
    "Data version",
    "Firmware type",
    "Firmware revision",
    "Firmware date",
    "Board information",
    "Log start datetime",
    "Craft name",
    "DeviceUID",
    /^Field /,
    "I interval",
    "P interval",
    "P ratio",
    "P denom",
    "P num",
    "blackbox_high_resolution",
    // measurement set-up: what is logged and the CHIRP generator, not the loop
    /^chirp_/,
    "debug_mode",
    "fields_disabled_mask",
    "gyro_debug_axis",
    "rc_smoothing_debug_axis",
    // sensor scales without effect on the rate loop (vbat_scale and vbatcellvoltage are compared:
    // vbat sag compensation uses them, Grok r4)
    "gyro_scale",
    "acc_1G",
    "currentSensor",
    // the battery voltage measured at arming (flight state, like the charge level), not a setting:
    // it differs between every two flights (AIR65: 377-423)
    "vbatref",
    // the slider inputs: their results (PID, D Max, feedforward, filters) are logged and compared.
    // The active rc smoothing cutoffs and the link rate are compared: the feedforward cutoff acts
    // between the logged setpoint and the motors (Grok r4).
    /^simplified_/,
    // self-levelling and autopilot only: no effect in Acro, and windows with those modes are excluded
    "levelPID",
    /^angle_/,
    /^horizon_/,
    /^ap_/,
    /^altitude_/,
];

function notCompared(key: string): boolean {
    return NOT_COMPARED_KEYS.some((k) => (typeof k === "string" ? k === key : k.test(key)));
}

/** Every setting of every group, and every other logged key, A against B. */
export function compareSettings(
    a: readonly (readonly [string, string])[],
    b: readonly (readonly [string, string])[],
): SettingRow[] {
    const rows: SettingRow[] = [];
    const build = sharedBuild(headerValue(a, "Firmware revision"), headerValue(b, "Firmware revision"));
    for (const group of [...SETTING_GROUPS, "other"] as const) {
        for (const def of GROUP_SETTINGS[group]) {
            rows.push(row(group, def.id, lookup(a, def), lookup(b, def), build));
        }
    }
    // Fail closed: every further key of either log that is not excluded counts under "other".
    const covered = new Set(
        Object.values(GROUP_SETTINGS)
            .flat()
            .flatMap((d) => [d.key, ...(d.aliases ?? [])]),
    );
    const extra = new Set([...a, ...b].map(([k]) => k).filter((k) => !covered.has(k) && !notCompared(k)));
    for (const key of [...extra].sort()) {
        rows.push(row("other", key, headerValue(a, key), headerValue(b, key), build));
    }
    return rows;
}

/** What the A/B is meant to test: no change at all (spread control), or a change in one group. */
export type AbIntent = { kind: "none" } | { kind: "group"; group: SettingGroup };

export interface IntentCheck {
    passed: boolean;
    /** Reasons it does not pass (empty when it passes). */
    reasons: string[];
    changed: SettingRow[];
    unknown: SettingRow[];
    /** Not compared because neither build has the setting (STEP_FIRMWARE_ABSENT). */
    notInFirmware: SettingRow[];
}

/**
 * "No change": every relevant setting MATCH. A group: at least one DIFF in that group and every
 * other relevant setting MATCH. UNKNOWN anywhere fails either intent (it is not a MATCH, and an
 * unknown value in the changed group leaves what changed unknown). A setting missing from both
 * logs is named apart (settings_not_logged) so the report says it was not logged at all.
 */
export function checkIntent(rows: readonly SettingRow[], intent: AbIntent): IntentCheck {
    const notInFirmware = rows.filter((r) => r.status === "NOT_IN_FIRMWARE");
    const relevant = rows.filter((r) => r.status !== "NOT_IN_FIRMWARE");
    const changed = relevant.filter((r) => r.status === "DIFF");
    const unknown = relevant.filter((r) => r.status === "UNKNOWN");
    const reasons: string[] = [];
    const notLogged = unknown.filter((r) => r.missing === "both");
    const partly = unknown.filter((r) => r.missing !== "both");
    if (notLogged.length) reasons.push(`settings_not_logged:${notLogged.map((r) => r.id).join(",")}`);
    if (partly.length) reasons.push(`settings_unknown:${partly.map((r) => r.id).join(",")}`);
    if (intent.kind === "none") {
        if (changed.length) reasons.push(`unexpected_change:${changed.map((r) => r.id).join(",")}`);
    } else {
        const inGroup = changed.filter((r) => r.group === intent.group);
        const outside = changed.filter((r) => r.group !== intent.group);
        if (!inGroup.length) reasons.push(`expected_change_missing:${intent.group}`);
        if (outside.length) reasons.push(`extra_change:${outside.map((r) => r.id).join(",")}`);
    }
    return { passed: reasons.length === 0, reasons, changed, unknown, notInFirmware };
}
