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
 * CHIRP samples and segments from Blackbox Viewer frames.
 *
 * The frames come from the Viewer's FlightLog (src/blackbox-viewer, unmodified),
 * proven bit-exact against GyroCore's reference decode in WU1. Autotune's own
 * decoder (chirp_bbl_parser.ts) is not used: it mis-decodes predicted fields
 * after every I-frame (docs/gyrocore/BLACKBOX_CHIRP_PARITY.md).
 *
 * Segment detection follows Betaflight's rule (BOXCHIRP set in the merged
 * S-frame flags, axis in debug[1]) as ported by GyroCore (frames.ts /
 * extraction.ts at d2e60f7). Unlike both, every segment is kept: a later
 * segment on the same axis does not replace an earlier one.
 */

import { BOXCHIRP_BIT } from "./constants";
import { chirpFrequencyRangeHz, highResolutionScale, validateChirpDebugMode, type LoggedHeaders } from "./headers";

export const SETPOINT_FIELDS = ["setpoint[0]", "setpoint[1]", "setpoint[2]"] as const;
export const GYRO_ADC_FIELDS = ["gyroADC[0]", "gyroADC[1]", "gyroADC[2]"] as const;
export const DEBUG_FIELDS = ["debug[0]", "debug[1]", "debug[2]", "debug[3]"] as const;
export const REQUIRED_FIELDS: readonly string[] = [...SETPOINT_FIELDS, ...GYRO_ADC_FIELDS, ...DEBUG_FIELDS];

const FLIGHT_MODE_FLAGS_ALIASES = ["flightmodeflags", "flight_mode_flags", "flightmodestate", "flight_mode"];

/** The parts of the Blackbox Viewer FlightLog (untyped JS) read here, after openLog(). */
export interface FlightLogFrames {
    getMainFieldNames(): string[];
    getMinTime(): number;
    getMaxTime(): number;
    getChunksInTimeRange(min: number, max: number): { frames: ArrayLike<number | null | undefined>[] }[];
}

/** Columnar view of every valid main frame of one log (no subsampling). */
export interface ChirpFrames {
    timeUs: Float64Array;
    setpoint: [Float64Array, Float64Array, Float64Array];
    gyroAdc: [Float64Array, Float64Array, Float64Array];
    debug: [Float64Array, Float64Array, Float64Array, Float64Array];
    /** Integer flags per row, -1 before the first S-frame; null when the column is absent. */
    flightModeFlags: Int32Array | null;
    malformedRows: number;
    warnings: string[];
}

export class ChirpFramesError extends Error {}

function findField(names: string[], name: string): number | undefined {
    // Exact name or bracket-less alias, case-insensitive (GyroCore frames.py).
    const want = [name.toLowerCase(), name.replaceAll(/[[\]]/g, "").toLowerCase()];
    for (const w of want) {
        const i = names.findIndex((n) => n.trim().toLowerCase() === w);
        if (i >= 0) {
            return i;
        }
    }
    return undefined;
}

export function chirpFramesFromFlightLog(log: FlightLogFrames): ChirpFrames {
    const names = log.getMainFieldNames();
    const cols: number[] = [];
    const missing: string[] = [];
    for (const f of REQUIRED_FIELDS) {
        const i = findField(names, f);
        if (i === undefined) {
            missing.push(f);
        } else {
            cols.push(i);
        }
    }
    if (missing.length) {
        throw new ChirpFramesError(`missing_required_field:${missing.join(",")}`);
    }
    const timeIdx = findField(names, "time");
    if (timeIdx === undefined) {
        throw new ChirpFramesError("missing_required_field:time");
    }
    const lower = names.map((n) => n.trim().toLowerCase());
    const flagsIdx = FLIGHT_MODE_FLAGS_ALIASES.map((a) => lower.indexOf(a)).find((i) => i >= 0);

    const min = log.getMinTime();
    const max = log.getMaxTime();
    const chunks = Number.isFinite(min) && Number.isFinite(max) && max >= min ? log.getChunksInTimeRange(min, max) : [];
    const total = chunks.reduce((sum, c) => sum + c.frames.length, 0);

    const time = new Float64Array(total);
    const vals = REQUIRED_FIELDS.map(() => new Float64Array(total));
    const flags = flagsIdx === undefined ? null : new Int32Array(total);
    let n = 0;
    let malformed = 0;
    for (const chunk of chunks) {
        for (const frame of chunk.frames) {
            const t = frame[timeIdx];
            let ok = typeof t === "number" && Number.isFinite(t);
            for (let k = 0; ok && k < cols.length; k++) {
                const v = frame[cols[k]];
                ok = typeof v === "number" && Number.isFinite(v);
            }
            if (!ok) {
                malformed++;
                continue;
            }
            time[n] = t as number;
            for (let k = 0; k < cols.length; k++) {
                vals[k][n] = frame[cols[k]] as number;
            }
            if (flags && flagsIdx !== undefined) {
                // The Viewer yields null before the first S-frame: "keep previous state".
                const f = frame[flagsIdx];
                flags[n] = typeof f === "number" && Number.isFinite(f) ? Math.trunc(f) : -1;
            }
            n++;
        }
    }
    const warnings: string[] = [];
    if (malformed) {
        warnings.push("malformed_rows_skipped");
    }
    if (flagsIdx === undefined) {
        warnings.push("flight_mode_flags_column_missing");
    }
    const cut = (a: Float64Array) => (n === total ? a : a.slice(0, n));
    return {
        timeUs: cut(time),
        setpoint: [cut(vals[0]), cut(vals[1]), cut(vals[2])],
        gyroAdc: [cut(vals[3]), cut(vals[4]), cut(vals[5])],
        debug: [cut(vals[6]), cut(vals[7]), cut(vals[8]), cut(vals[9])],
        flightModeFlags: flags && n !== total ? flags.slice(0, n) : flags,
        malformedRows: malformed,
        warnings,
    };
}

/** One contiguous run of CHIRP excitation on one axis. Indices are into the log's CHIRP sample arrays. */
export interface ChirpSegmentInfo {
    /** Order of the segment within its log. */
    index: number;
    axis: number;
    startIdx: number;
    endIdx: number;
    sampleCount: number;
    startTimeUs: number;
    endTimeUs: number;
    durationS: number;
}

export interface ChirpExtraction {
    detected: boolean;
    segments: ChirpSegmentInfo[];
    /** Concatenated CHIRP-active samples, `value * highResolutionScale` in float32 as Betaflight stores them. */
    setpoint: [Float32Array, Float32Array, Float32Array];
    gyro: [Float32Array, Float32Array, Float32Array];
    timeUs: Float64Array;
    totalFrames: number;
    droppedAxisFrames: number;
    highResolutionScale: number;
    flagGating: "none" | "flight_mode_flags" | "debug_axis_only";
    apiVersion: string | null;
    chirpDebugModeIndex: number | null;
    frequencyRangeHz: [number, number] | null;
    warnings: string[];
    errors: string[];
}

function emptyExtraction(frames: ChirpFrames, kw: Partial<ChirpExtraction>): ChirpExtraction {
    const z = () => new Float32Array(0);
    return {
        detected: false,
        segments: [],
        setpoint: [z(), z(), z()],
        gyro: [z(), z(), z()],
        timeUs: new Float64Array(0),
        totalFrames: frames.timeUs.length,
        droppedAxisFrames: 0,
        highResolutionScale: 1,
        flagGating: "none",
        apiVersion: null,
        chirpDebugModeIndex: null,
        frequencyRangeHz: null,
        warnings: [],
        errors: [],
        ...kw,
    };
}

export function extractChirp(
    frames: ChirpFrames,
    headers: LoggedHeaders,
    opts: { apiVersion?: string | null } = {},
): ChirpExtraction {
    const warnings = frames.warnings.slice();
    const [api, index, err] = validateChirpDebugMode(headers, opts.apiVersion ?? null);
    if (err) {
        return emptyExtraction(frames, { apiVersion: api, chirpDebugModeIndex: index, errors: [err], warnings });
    }
    if (headers.fieldINames.length) {
        const missing = REQUIRED_FIELDS.filter((f) => !headers.fieldINames.includes(f));
        if (missing.length) {
            return emptyExtraction(frames, {
                apiVersion: api,
                chirpDebugModeIndex: index,
                errors: [`missing_required_field:${missing.join(",")}`],
                warnings,
            });
        }
    }
    const scale = highResolutionScale(headers);
    const frequencyRangeHz = chirpFrequencyRangeHz(headers);
    if (frequencyRangeHz === null) {
        warnings.push("chirp_frequency_range_missing");
    }

    const flags = frames.flightModeFlags;
    let flagGating: ChirpExtraction["flagGating"] = "flight_mode_flags";
    if (flags === null) {
        warnings.push("chirp_mode_flag_unavailable_debug_axis_only");
        flagGating = "debug_axis_only";
    }

    const axisCol = frames.debug[1];
    const n = frames.timeUs.length;
    const rows: number[] = [];
    const bounds: [number, number, number][] = [];
    let active = flags === null;
    let currentAxis = -1;
    let dropped = 0;
    const chirpBit = 1 << BOXCHIRP_BIT;
    const closeSegment = (endIdx: number, axis: number) => {
        const last = bounds.at(-1);
        if (last?.[0] === axis) {
            last[2] = endIdx;
        }
    };

    for (let r = 0; r < n; r++) {
        if (flags !== null) {
            const f = flags[r];
            const now = f < 0 ? active : Boolean(f & chirpBit);
            if (now && !active) {
                currentAxis = -1;
            }
            if (!now && active) {
                closeSegment(rows.length - 1, currentAxis);
                currentAxis = -1;
            }
            active = now;
        }
        if (!active) {
            continue;
        }
        const a = axisCol[r];
        if (!Number.isFinite(a) || a !== Math.trunc(a) || a < -1 || a > 2) {
            dropped++;
            continue;
        }
        rows.push(r);
        const sampleIdx = rows.length - 1;
        if (a < 0) {
            if (currentAxis >= 0) {
                closeSegment(sampleIdx - 1, currentAxis);
            }
        } else if (a !== currentAxis) {
            if (currentAxis >= 0) {
                closeSegment(sampleIdx - 1, currentAxis);
            }
            bounds.push([a, sampleIdx, sampleIdx]);
        }
        currentAxis = a;
    }
    if (currentAxis >= 0) {
        closeSegment(rows.length - 1, currentAxis);
    }

    const m = rows.length;
    const pick = (src: Float64Array) => {
        const out = new Float32Array(m);
        for (let i = 0; i < m; i++) {
            out[i] = src[rows[i]] * scale;
        }
        return out;
    };
    const timeUs = new Float64Array(m);
    for (let i = 0; i < m; i++) {
        timeUs[i] = frames.timeUs[rows[i]];
    }

    const segments = bounds.map(([axis, start, end], i): ChirpSegmentInfo => {
        const startTimeUs = timeUs[start];
        const endTimeUs = timeUs[end];
        return {
            index: i,
            axis,
            startIdx: start,
            endIdx: end,
            sampleCount: end - start + 1,
            startTimeUs,
            endTimeUs,
            durationS: Math.max(0, (endTimeUs - startTimeUs) / 1e6),
        };
    });
    if (dropped) {
        warnings.push("chirp_axis_out_of_range_frames_dropped");
    }
    if (new Set(segments.map((s) => s.axis)).size < segments.length) {
        warnings.push("repeated_axis_segments_all_kept");
    }

    return {
        detected: segments.length > 0,
        segments,
        setpoint: [pick(frames.setpoint[0]), pick(frames.setpoint[1]), pick(frames.setpoint[2])],
        gyro: [pick(frames.gyroAdc[0]), pick(frames.gyroAdc[1]), pick(frames.gyroAdc[2])],
        timeUs,
        totalFrames: n,
        droppedAxisFrames: dropped,
        highResolutionScale: scale,
        flagGating,
        apiVersion: api,
        chirpDebugModeIndex: index,
        frequencyRangeHz,
        warnings,
        errors: [],
    };
}
