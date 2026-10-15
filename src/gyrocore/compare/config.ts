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
 * Configuration comparison of two stored Flights, from their logged `H key:value`
 * lines (StoredFlight.logHeaders). Values are compared as logged text: nothing
 * is parsed into a firmware default, and a value that was not logged stays
 * UNKNOWN. Every logged difference keeps the numeric CHIRP difference closed:
 * the response of a changed configuration is a different system, so a
 * difference there is not measurement noise (and not proven to be its cause).
 */

import { AXIS_NAMES, type ChirpAxisName } from "../chirp/constants";
import { SLIDER_HEADER_KEYS } from "../chirp/headers";
import type { MatchStatus, StoredFlight } from "../session/contract";
import { CMP_REASONS as R, type ConfigCategory, type ConfigComparison, type ConfigItem } from "./contract";

/**
 * Settings that define the CHIRP measurement itself: loop and logging rate and
 * the CHIRP sweep (the keys headers.ts and sampleRate.ts already read).
 */
const MEASUREMENT_KEYS = [
    "looptime",
    "pid_process_denom",
    "I interval",
    "P interval",
    "debug_mode",
    "blackbox_high_resolution",
    "chirp_frequency_start_deci_hz",
    "chirp_frequency_end_deci_hz",
    "chirp_time_seconds",
    "chirp_lag_freq_hz",
    "chirp_lead_freq_hz",
    ...AXIS_NAMES.map((a) => `chirp_amplitude_${a}`),
];

/** Tune settings GyroCore already reads from headers (headers.ts, safety/absolute.ts). */
const TUNING_KEYS = [
    "rollPID",
    "pitchPID",
    "yawPID",
    "d_max",
    "ff_weight",
    "simplified_pids_mode",
    ...SLIDER_HEADER_KEYS,
    "simplified_d_max_gain",
    "simplified_pitch_d_gain",
    "simplified_pitch_pi_gain",
    "simplified_dterm_filter",
    "simplified_gyro_filter",
    "simplified_gyro_filter_multiplier",
    "dterm_lpf1_static_hz",
    "dterm_lpf1_dyn_hz",
    "dterm_lpf2_static_hz",
    "gyro_lpf1_static_hz",
    "gyro_lpf1_dyn_hz",
    "gyro_lpf2_static_hz",
];

/**
 * Keys a CHIRP difference cannot do without: the logging rate, the requested
 * sweep and the PID gains. Not logged in either Flight is UNKNOWN and closes the
 * difference too; other known keys that neither Flight logged are only listed.
 */
const REQUIRED_KEYS = new Set([
    "looptime",
    "pid_process_denom",
    "chirp_frequency_start_deci_hz",
    "chirp_frequency_end_deci_hz",
    "chirp_time_seconds",
    ...AXIS_NAMES.map((a) => `chirp_amplitude_${a}`),
    "rollPID",
    "pitchPID",
    "yawPID",
]);

/**
 * Not compared here: the firmware identity (WU4 checks it), the recording time,
 * the frame definitions, and `vbatref`, the battery voltage Betaflight measured
 * when the battery was connected (it differs from pack to pack, not by setting).
 */
const NOT_CONFIGURATION = new Set([
    "Product",
    "Data version",
    "Firmware type",
    "Firmware revision",
    "Firmware date",
    "Firmware API version",
    "Board information",
    "Craft name",
    "Log start datetime",
    "vbatref",
]);

const isNotConfiguration = (key: string) => NOT_CONFIGURATION.has(key) || key.startsWith("Field ");

function category(key: string): ConfigCategory {
    if (MEASUREMENT_KEYS.includes(key)) {
        return "MEASUREMENT";
    }
    return TUNING_KEYS.includes(key) ? "TUNING" : "OTHER";
}

function axisOf(key: string): ChirpAxisName | null {
    const m = /^chirp_amplitude_(roll|pitch|yaw)$/.exec(key);
    return m ? (m[1] as ChirpAxisName) : null;
}

interface HeaderBlock {
    values: Map<string, string>;
    /** Keys logged more than once with different values: not a value at all. */
    contradictory: Set<string>;
    available: boolean;
}

function headerBlock(f: StoredFlight): HeaderBlock {
    const values = new Map<string, string>();
    const contradictory = new Set<string>();
    const pairs: unknown = f.logHeaders;
    if (!Array.isArray(pairs)) {
        return { values, contradictory, available: false };
    }
    for (const p of pairs) {
        if (!Array.isArray(p) || p.length !== 2 || typeof p[0] !== "string" || typeof p[1] !== "string") {
            // A malformed line could hide any key: the whole block is not evidence.
            return { values: new Map(), contradictory: new Set(), available: false };
        }
        const [key, value] = p as [string, string];
        const seen = values.get(key);
        if (seen !== undefined && seen !== value) {
            contradictory.add(key);
        }
        values.set(key, value);
    }
    for (const k of contradictory) {
        values.delete(k);
    }
    return { values, contradictory, available: true };
}

function item(key: string, a: HeaderBlock, b: HeaderBlock): ConfigItem {
    const va = a.values.get(key) ?? null;
    const vb = b.values.get(key) ?? null;
    const reasons: string[] = [];
    let status: MatchStatus;
    let blocks: boolean;
    for (const [side, block] of [
        ["a", a],
        ["b", b],
    ] as const) {
        if (!block.available) {
            reasons.push(`${R.configHeadersUnavailable}:${side}`);
        } else if (block.contradictory.has(key)) {
            reasons.push(`${R.configContradictory}:${key}:${side}`);
        }
    }
    if (va !== null && vb !== null) {
        status = va === vb ? "MATCH" : "MISMATCH";
        blocks = status === "MISMATCH";
        if (blocks) {
            reasons.push(`${R.configMismatch}:${key}`);
        }
    } else {
        status = "UNKNOWN";
        if (va !== null || vb !== null) {
            // Logged by one Flight only: not the same, and not provably different.
            reasons.push(`${R.configLoggedInOneOnly}:${key}`);
            blocks = true;
        } else {
            if (a.available && b.available && !reasons.length) {
                reasons.push(`${R.configNotLogged}:${key}`);
            }
            blocks = REQUIRED_KEYS.has(key) || reasons.some((r) => r.startsWith(R.configContradictory));
        }
        if (blocks) {
            reasons.push(`${R.configUnknown}:${key}`);
        }
    }
    return { key, category: category(key), axis: axisOf(key), a: va, b: vb, status, reasons, blocksDifference: blocks };
}

const CATEGORY_ORDER: ConfigCategory[] = ["MEASUREMENT", "TUNING", "OTHER"];

/** The logged configuration of A and B, item by item. */
export function compareConfig(a: StoredFlight, b: StoredFlight): ConfigComparison {
    const ha = headerBlock(a);
    const hb = headerBlock(b);
    const keys = new Set<string>([...MEASUREMENT_KEYS, ...TUNING_KEYS]);
    for (const h of [ha, hb]) {
        for (const k of [...h.values.keys(), ...h.contradictory]) {
            if (!isNotConfiguration(k)) {
                keys.add(k);
            }
        }
    }
    const known = [...MEASUREMENT_KEYS, ...TUNING_KEYS];
    const ordered = [...keys].sort((x, y) => {
        const c = CATEGORY_ORDER.indexOf(category(x)) - CATEGORY_ORDER.indexOf(category(y));
        if (c) {
            return c;
        }
        const ix = known.indexOf(x);
        const iy = known.indexOf(y);
        return ix >= 0 && iy >= 0 ? ix - iy : x.localeCompare(y);
    });
    const items = ordered.map((k) => item(k, ha, hb));
    const problems = [
        ...(!ha.available ? [`${R.configHeadersUnavailable}:a`] : []),
        ...(!hb.available ? [`${R.configHeadersUnavailable}:b`] : []),
        ...[...ha.contradictory].map((k) => `${R.configContradictory}:${k}:a`),
        ...[...hb.contradictory].map((k) => `${R.configContradictory}:${k}:b`),
    ];
    const statuses = items.map((i) => i.status);
    const status: MatchStatus = statuses.includes("MISMATCH")
        ? "MISMATCH"
        : statuses.includes("UNKNOWN")
          ? "UNKNOWN"
          : "MATCH";
    return { status, items, problems };
}

/** The configuration reasons that keep CHIRP pairs of this axis from a numeric difference. */
export function configBlockers(config: ConfigComparison, axis: ChirpAxisName): string[] {
    return config.items
        .filter((i) => i.blocksDifference && (i.axis === null || i.axis === axis))
        .flatMap((i) => i.reasons.filter((r) => r.startsWith(R.configMismatch) || r.startsWith(R.configUnknown)));
}
