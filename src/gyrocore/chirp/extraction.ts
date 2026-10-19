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
 * Segment detection starts from Betaflight's rule (BOXCHIRP set in the merged
 * S-frame flags, axis in debug[1]) as ported by GyroCore (frames.ts /
 * extraction.ts at d2e60f7). The measurement window is then tightened with
 * DEBUG_CHIRP evidence (debug[2] frequency, debug[3] excitation): after the
 * generator finishes, firmware keeps BOXCHIRP set while fchirp/excitation are
 * zero — that post-completion tail is excluded from Welch/Bode/gates. Missing
 * or constant DEBUG_CHIRP leaves the mode-flag window unchanged. Unlike both
 * upstream ports, every segment is kept: a later segment on the same axis does
 * not replace an earlier one.
 */

import { BOXCHIRP_BIT } from "./constants";
import { chirpFrequencyRangeHz, highResolutionScale, validateChirpDebugMode, type LoggedHeaders } from "./headers";

export const SETPOINT_FIELDS = ["setpoint[0]", "setpoint[1]", "setpoint[2]"] as const;
export const GYRO_ADC_FIELDS = ["gyroADC[0]", "gyroADC[1]", "gyroADC[2]"] as const;
export const DEBUG_FIELDS = ["debug[0]", "debug[1]", "debug[2]", "debug[3]"] as const;
export const REQUIRED_FIELDS: readonly string[] = [...SETPOINT_FIELDS, ...GYRO_ADC_FIELDS, ...DEBUG_FIELDS];

const FLIGHT_MODE_FLAGS_ALIASES = ["flightmodeflags", "flight_mode_flags", "flightmodestate", "flight_mode"];
/** Optional: read for CHIRP Quality V2 motor-saturation evidence, never required. */
export const MOTOR_FIELDS = Array.from({ length: 8 }, (_, i) => `motor[${i}]`);

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
    /** Highest and lowest logged motor output per row (NaN where a motor value is missing); null without motor fields. */
    motorMax?: Float32Array | null;
    motorMin?: Float32Array | null;
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
    const motorCols = MOTOR_FIELDS.map((f) => findField(names, f)).filter((i): i is number => i !== undefined);

    const min = log.getMinTime();
    const max = log.getMaxTime();
    const chunks = Number.isFinite(min) && Number.isFinite(max) && max >= min ? log.getChunksInTimeRange(min, max) : [];
    const total = chunks.reduce((sum, c) => sum + c.frames.length, 0);

    const time = new Float64Array(total);
    const vals = REQUIRED_FIELDS.map(() => new Float64Array(total));
    const flags = flagsIdx === undefined ? null : new Int32Array(total);
    const motorMax = motorCols.length ? new Float32Array(total) : null;
    const motorMin = motorCols.length ? new Float32Array(total) : null;
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
            if (motorMax && motorMin) {
                let hi = -Infinity;
                let lo = Infinity;
                for (const c of motorCols) {
                    const v = frame[c];
                    if (typeof v !== "number" || !Number.isFinite(v)) {
                        hi = lo = NaN;
                        break;
                    }
                    hi = Math.max(hi, v);
                    lo = Math.min(lo, v);
                }
                motorMax[n] = hi;
                motorMin[n] = lo;
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
        motorMax: motorMax && n !== total ? motorMax.slice(0, n) : motorMax,
        motorMin: motorMin && n !== total ? motorMin.slice(0, n) : motorMin,
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
    /** Active generator duration (DEBUG_CHIRP-bounded when evidence allows). */
    durationS: number;
    /**
     * Full BOXCHIRP mode-flag duration before post-completion trimming.
     * Equal to durationS when firmware evidence did not justify a tighter bound.
     */
    modeDurationS: number;
    /** Samples while BOXCHIRP was set, before trimming. */
    modeSampleCount: number;
    /**
     * How the active window was chosen:
     * - firmware_debug_chirp: trimmed using DEBUG_CHIRP frequency/excitation
     * - mode_flag_only: BOXCHIRP (+ axis) only — no reliable generator evidence
     */
    boundSource: "firmware_debug_chirp" | "mode_flag_only";
}

export interface ChirpExtraction {
    detected: boolean;
    segments: ChirpSegmentInfo[];
    /** Concatenated CHIRP-active samples, `value * highResolutionScale` in float32 as Betaflight stores them. */
    setpoint: [Float32Array, Float32Array, Float32Array];
    gyro: [Float32Array, Float32Array, Float32Array];
    timeUs: Float64Array;
    /**
     * Raw firmware DEBUG_CHIRP channels on the same rows (pid.c): debug[2] is the
     * instantaneous sweep frequency in 0.1 Hz, debug[3] the excitation x 1000.
     * Read by CHIRP Quality V2 only, which checks they are plausible first.
     */
    chirpFrequencyDeciHz?: Float32Array;
    chirpExcitationMilli?: Float32Array;
    /** Motor output limits per CHIRP row (see ChirpFrames); null without motor fields. */
    motorMax?: Float32Array | null;
    motorMin?: Float32Array | null;
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

/**
 * Within one BOXCHIRP/axis segment, find the active generator sample range using
 * DEBUG_CHIRP. Returns null when the channels do not support a tighter bound
 * (missing, constant, or never active) — callers keep the mode-flag window.
 *
 * Completion (not a restart): after the sweep has progressed, frequency and
 * excitation drop to zero and stay zero until the segment end. A real restart
 * resumes with non-zero frequency/excitation after that settle, so lastActive
 * stays past the intermediate zeros and observedSweep still sees runs > 1.
 */
export function activeGeneratorRange(
    frequencyDeciHz: ArrayLike<number>,
    excitationMilli: ArrayLike<number>,
    startIdx: number,
    endIdx: number,
): { startIdx: number; endIdx: number } | null {
    if (endIdx < startIdx) {
        return null;
    }
    let minF = Infinity;
    let maxF = -Infinity;
    let firstActive = -1;
    let lastActive = -1;
    for (let i = startIdx; i <= endIdx; i++) {
        const f = frequencyDeciHz[i];
        const e = excitationMilli[i];
        if (!Number.isFinite(f) || f < 0 || !Number.isFinite(e)) {
            return null;
        }
        minF = Math.min(minF, f);
        maxF = Math.max(maxF, f);
        if (f > 0 || e !== 0) {
            if (firstActive < 0) {
                firstActive = i;
            }
            lastActive = i;
        }
    }
    // Constant or never-active channel: no firmware evidence to override BOXCHIRP.
    if (firstActive < 0 || maxF === minF) {
        return null;
    }
    if (firstActive === startIdx && lastActive === endIdx) {
        return null;
    }
    return { startIdx: firstActive, endIdx: lastActive };
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
    const pick = (src: ArrayLike<number>, factor = scale) => {
        const out = new Float32Array(m);
        for (let i = 0; i < m; i++) {
            out[i] = src[rows[i]] * factor;
        }
        return out;
    };
    const timeUs = new Float64Array(m);
    for (let i = 0; i < m; i++) {
        timeUs[i] = frames.timeUs[rows[i]];
    }

    const chirpFrequencyDeciHz = pick(frames.debug[2], 1);
    const chirpExcitationMilli = pick(frames.debug[3], 1);

    let trimmedAny = false;
    const segments = bounds.map(([axis, start, end], i): ChirpSegmentInfo => {
        const modeStart = start;
        const modeEnd = end;
        const modeStartTimeUs = timeUs[modeStart];
        const modeEndTimeUs = timeUs[modeEnd];
        const modeDurationS = Math.max(0, (modeEndTimeUs - modeStartTimeUs) / 1e6);
        const modeSampleCount = modeEnd - modeStart + 1;

        const active = activeGeneratorRange(chirpFrequencyDeciHz, chirpExcitationMilli, modeStart, modeEnd);
        const startIdx = active?.startIdx ?? modeStart;
        const endIdx = active?.endIdx ?? modeEnd;
        if (active) {
            trimmedAny = true;
        }
        const startTimeUs = timeUs[startIdx];
        const endTimeUs = timeUs[endIdx];
        return {
            index: i,
            axis,
            startIdx,
            endIdx,
            sampleCount: endIdx - startIdx + 1,
            startTimeUs,
            endTimeUs,
            durationS: Math.max(0, (endTimeUs - startTimeUs) / 1e6),
            modeDurationS,
            modeSampleCount,
            boundSource: active ? "firmware_debug_chirp" : "mode_flag_only",
        };
    });
    if (dropped) {
        warnings.push("chirp_axis_out_of_range_frames_dropped");
    }
    if (new Set(segments.map((s) => s.axis)).size < segments.length) {
        warnings.push("repeated_axis_segments_all_kept");
    }
    if (trimmedAny) {
        warnings.push("chirp_post_sweep_tail_excluded");
    }

    return {
        detected: segments.length > 0,
        segments,
        setpoint: [pick(frames.setpoint[0]), pick(frames.setpoint[1]), pick(frames.setpoint[2])],
        gyro: [pick(frames.gyroAdc[0]), pick(frames.gyroAdc[1]), pick(frames.gyroAdc[2])],
        timeUs,
        chirpFrequencyDeciHz,
        chirpExcitationMilli,
        motorMax: frames.motorMax ? pick(frames.motorMax, 1) : null,
        motorMin: frames.motorMin ? pick(frames.motorMin, 1) : null,
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
