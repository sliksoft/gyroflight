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
 * The logged header facts GyroCore's gates need, read from the raw `H key:value`
 * lines of one embedded log. Port of GyroCore sysconfig.ts / debug_modes.py
 * (d2e60f7) plus the current-tune keys of autotune/current_tune.py.
 *
 * The Blackbox Viewer's sysConfig fills defaults for absent keys (looptime,
 * P interval, sliders), so it cannot say whether a value was actually logged.
 * The gates must know that: a missing rate header or slider is a reason to
 * block, never something to substitute silently.
 */

export const API_VERSION_MAX_SUPPORTED = "1.49.0";

const CHIRP_DEBUG_INDEX_BY_TABLE_VERSION: [string, number][] = [
    ["1.44.0", -1],
    ["1.45.0", -1],
    ["1.46.0", -1],
    ["1.47.0", 97],
    ["1.48.0", 96],
    ["1.49.0", 96],
];

const UPSTREAM_DEFAULTS: Record<string, number> = {
    data_version: 2,
    looptime: 125,
    pid_process_denom: 1,
    debug_mode: -1,
    blackbox_high_resolution: 0,
    i_interval: 32,
    p_interval_num: 1,
    p_interval_denom: 1,
};

/** Slider headers in the order Betaflight's extractCurrentSliders reads them. */
export const SLIDER_HEADER_KEYS = [
    "simplified_master_multiplier",
    "simplified_pi_gain",
    "simplified_i_gain",
    "simplified_d_gain",
    "simplified_feedforward_gain",
    "simplified_dterm_filter_multiplier",
] as const;
export type SliderHeaderKey = (typeof SLIDER_HEADER_KEYS)[number];

const INT_KEYS = [
    "data_version",
    "looptime",
    "pid_process_denom",
    "debug_mode",
    "blackbox_high_resolution",
    "i_interval",
    "chirp_lag_freq_hz",
    "chirp_lead_freq_hz",
    "chirp_amplitude_roll",
    "chirp_amplitude_pitch",
    "chirp_amplitude_yaw",
    "chirp_frequency_start_deci_hz",
    "chirp_frequency_end_deci_hz",
    "chirp_time_seconds",
    "simplified_pids_mode",
    "simplified_dterm_filter",
    ...SLIDER_HEADER_KEYS,
] as const;
export type IntKey = (typeof INT_KEYS)[number] | "p_interval_num" | "p_interval_denom";

export interface LoggedHeaders {
    /** Integer header values (Number.parseInt semantics, null where unparseable). Absent keys are absent. */
    ints: Partial<Record<IntKey, number | null>>;
    pIntervalSeen: boolean;
    firmwareRevision: string | null;
    firmwareApiVersion: string | null;
    fieldINames: string[];
    presentKeys: Set<string>;
}

/** `Number.parseInt(value, 10)`; null where JS yields NaN. */
export function jsParseInt(value: string): number | null {
    const m = /^\s*([+-]?\d+)/.exec(value);
    return m ? Number.parseInt(m[1], 10) : null;
}

/** GyroCore `_normalize_field_key`: "Data version" -> "data_version". */
export function normalizeFieldKey(raw: string): string {
    return raw.trim().toLowerCase().replace(/^_+/, "").trim().replace(/\s+/g, "_");
}

/** Ordered `H` header pairs (raw key, raw value) of the log starting at `start`. */
export function readHeaderPairs(bytes: Uint8Array, start: number, end: number): [string, string][] {
    const pairs: [string, string][] = [];
    let pos = start;
    while (pos + 1 < end && bytes[pos] === 0x48 && bytes[pos + 1] === 0x20) {
        let stop = pos;
        while (stop < end && bytes[stop] !== 0x0a) {
            stop++;
        }
        // Byte-for-byte latin-1 (TextDecoder("latin1") is windows-1252 and remaps 0x80-0x9f).
        let line = "";
        for (let i = pos + 2; i < stop && bytes[i] !== 0x0d; i++) {
            line += String.fromCharCode(bytes[i]);
        }
        const colon = line.indexOf(":");
        if (colon >= 0) {
            pairs.push([line.slice(0, colon), line.slice(colon + 1)]);
        }
        pos = stop + 1;
    }
    return pairs;
}

export function parseLoggedHeaders(pairs: [string, string][]): LoggedHeaders {
    const ints: LoggedHeaders["ints"] = {};
    const present = new Set<string>();
    let pIntervalSeen = false;
    let pRatio: number | null = null;
    let firmwareRevision: string | null = null;
    let firmwareApiVersion: string | null = null;
    let fieldINames: string[] = [];
    for (const [rawKey, raw] of pairs) {
        const key = normalizeFieldKey(rawKey);
        if ((INT_KEYS as readonly string[]).includes(key)) {
            ints[key as IntKey] = jsParseInt(raw);
            present.add(key);
        } else if (key === "p_interval") {
            pIntervalSeen = true;
            present.add(key);
            const slash = raw.indexOf("/");
            if (slash >= 0) {
                ints.p_interval_num = jsParseInt(raw.slice(0, slash));
                ints.p_interval_denom = jsParseInt(raw.slice(slash + 1));
            } else {
                ints.p_interval_num = 1;
                ints.p_interval_denom = jsParseInt(raw);
            }
        } else if (key === "p_interval_num" || key === "p_interval_denom") {
            pIntervalSeen = true;
            present.add("p_interval");
            ints[key] = jsParseInt(raw);
        } else if (key === "p_ratio") {
            pRatio = jsParseInt(raw);
            present.add(key);
        } else if (key === "firmware_revision") {
            firmwareRevision = raw.trim();
            present.add(key);
        } else if (key === "firmware_api_version") {
            firmwareApiVersion = raw.trim();
            present.add(key);
        } else if (key === "field_i_name") {
            fieldINames = raw.split(",");
            present.add(key);
        }
    }
    if (!pIntervalSeen && pRatio !== null && pRatio > 0) {
        ints.p_interval_num = 1;
        ints.p_interval_denom = pRatio;
        pIntervalSeen = true;
    }
    return { ints, pIntervalSeen, firmwareRevision, firmwareApiVersion, fieldINames, presentKeys: present };
}

/** The logged integer, or null when absent or unparseable. */
export function loggedInt(h: LoggedHeaders, key: IntKey): number | null {
    const v = h.ints[key];
    return v === undefined ? null : v;
}

/** The value Betaflight's own parser would use: its default when absent, 0 when unparseable. */
export function upstreamValue(h: LoggedHeaders, key: IntKey): number {
    const v = loggedInt(h, key);
    if (v === null) {
        return h.presentKeys.has(key) ? 0 : (UPSTREAM_DEFAULTS[key] ?? 0);
    }
    return v;
}

export function highResolutionScale(h: LoggedHeaders): number {
    return upstreamValue(h, "blackbox_high_resolution") ? 0.1 : 1;
}

export function chirpFrequencyRangeHz(h: LoggedHeaders): [number, number] | null {
    const start = loggedInt(h, "chirp_frequency_start_deci_hz");
    const end = loggedInt(h, "chirp_frequency_end_deci_hz");
    if (start === null || end === null || start <= 0 || end <= start) {
        return null;
    }
    return [start / 10, end / 10];
}

export interface SampleRateInputs {
    looptimeUs: number | null;
    pidProcessDenom: number | null;
    frameIntervalPNum: number | null;
    frameIntervalPDenom: number | null;
}

/** Only logged, positive values; nothing defaulted. */
export function sampleRateInputs(h: LoggedHeaders): SampleRateInputs {
    const lt = loggedInt(h, "looptime");
    const pd = loggedInt(h, "pid_process_denom");
    return {
        looptimeUs: lt && lt > 0 ? lt : null,
        pidProcessDenom: pd && pd > 0 ? pd : null,
        frameIntervalPNum: h.pIntervalSeen ? loggedInt(h, "p_interval_num") : null,
        frameIntervalPDenom: h.pIntervalSeen ? loggedInt(h, "p_interval_denom") : null,
    };
}

function semver(v: string | null | undefined): [number, number, number] | null {
    if (typeof v !== "string") {
        return null;
    }
    const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function semverGte(a: [number, number, number], b: [number, number, number]): boolean {
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) {
            return a[i] > b[i];
        }
    }
    return true;
}

export function chirpDebugModeIndex(apiVersion: string | null): number {
    const parsed = semver(apiVersion);
    let resolved = CHIRP_DEBUG_INDEX_BY_TABLE_VERSION[0];
    if (parsed) {
        for (const entry of CHIRP_DEBUG_INDEX_BY_TABLE_VERSION) {
            const v = semver(entry[0]);
            if (v && semverGte(parsed, v)) {
                resolved = entry;
            }
        }
    }
    return resolved[1];
}

export function effectiveChirpApiVersion(logApi: string | null, callerApi: string | null): string {
    if (logApi && logApi !== "0.0.0") {
        return logApi;
    }
    if (callerApi && callerApi !== "0.0.0") {
        return callerApi;
    }
    return API_VERSION_MAX_SUPPORTED;
}

/** [apiVersionUsed, chirpDebugModeIndex, errorCode]. */
export function validateChirpDebugMode(
    h: LoggedHeaders,
    apiVersion: string | null = null,
): [string, number, string | null] {
    const api = effectiveChirpApiVersion(h.firmwareApiVersion, apiVersion);
    const index = chirpDebugModeIndex(api);
    if (index < 0) {
        return [api, index, "chirp_debug_mode_unsupported_api"];
    }
    if (upstreamValue(h, "debug_mode") !== index) {
        return [api, index, "not_chirp_debug_mode"];
    }
    return [api, index, null];
}
