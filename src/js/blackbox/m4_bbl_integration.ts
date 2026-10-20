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
 * GF-1 M4.1: a blackbox file through the existing decode into M4.
 *
 *   file bytes
 *     -> Blackbox Viewer FlightLogIndex / FlightLog, every embedded log
 *     -> chirpFramesFromFlightLog            (time, setpoint, gyroADC, debug, flags)
 *     -> extractOptionalBlackboxChannels     (axisD, eRPM, motor; row-aligned)
 *     -> extractChirp + BOXCHIRP flag scan   (CHIRP detection, fail-closed)
 *     -> analyzeM4FlightMetrics              (measurement only)
 *
 * No decoding or analysis math lives here. A log whose CHIRP state cannot be
 * ruled out is analysed as CHIRP, so stick feedforward stays blocked for it.
 * Nothing here produces CLI, PID or filter values, or enables Apply.
 */

import { FlightLog } from "@/blackbox-viewer/flightlog.js";
import { FlightLogIndex } from "@/blackbox-viewer/flightlog_index.js";
import { BOXCHIRP_BIT } from "@/gyrocore/chirp/constants";
import {
    ChirpFramesError,
    DEBUG_FIELDS,
    GYRO_ADC_FIELDS,
    REQUIRED_FIELDS,
    SETPOINT_FIELDS,
    chirpFramesFromFlightLog,
    extractChirp,
    type FlightLogFrames,
} from "@/gyrocore/chirp/extraction";
import {
    highResolutionScale,
    jsParseInt,
    loggedInt,
    normalizeFieldKey,
    parseLoggedHeaders,
    readHeaderPairs,
    validateChirpDebugMode,
} from "@/gyrocore/chirp/headers";
import {
    analyzeM4FlightMetrics,
    extractOptionalBlackboxChannels,
    type FlightMetricsMeta,
    type M4FlightAnalysisResult,
} from "./flight_metrics_analysis";

export type M4ChirpStatus = "chirp" | "no_chirp" | "unknown";

export interface M4ChirpDetection {
    status: M4ChirpStatus;
    /** Why: e.g. `chirp_segments:3`, `debug_mode_chirp`, `boxchirp_flag_seen`, `flight_mode_flags_missing`. */
    evidence: string[];
    segmentCount: number;
    chirpSampleCount: number;
}

export interface M4SignalReport {
    present: string[];
    /** Signals M4 reads that this log does not contain. */
    missing: string[];
    /** Filter headers M4 echoes that this log does not contain (never filled with defaults). */
    missingHeaders: string[];
}

export interface M4LogReport {
    logIndex: number;
    /** Set when the log could not be analysed; `result` is then null. */
    error: string | null;
    firmwareRevision: string | null;
    debugMode: number | null;
    frameCount: number;
    durationS: number | null;
    chirp: M4ChirpDetection;
    signals: M4SignalReport;
    warnings: string[];
    result: M4FlightAnalysisResult | null;
}

export interface M4BblReport {
    filename: string;
    decoder: "betaflight-blackbox-viewer";
    logCount: number;
    /** File-level failure (unreadable / no logs); per-log failures are on each log. */
    error: string | null;
    logs: M4LogReport[];
    applyAllowed: false;
    recommendationsEnabled: false;
    cliOutput: null;
}

const OPTIONAL_SIGNALS = [
    "axisD[0]",
    "axisD[1]",
    "axisD[2]",
    "axisF[0]",
    "axisF[1]",
    "axisF[2]",
    "eRPM[0]",
    "eRPM[1]",
    "eRPM[2]",
    "eRPM[3]",
    "motor[0]",
    "motor[1]",
    "motor[2]",
    "motor[3]",
    "flightModeFlags",
] as const;

/** Header keys (normalised) M4 echoes, first match wins; older firmware names last. */
const FILTER_HEADERS: Record<
    "gyroLpf1Hz" | "gyroLpf2Hz" | "dtermLpf1Hz" | "dtermLpf2Hz" | "dynNotchCount" | "rpmFilterHarmonics" | "motorPoles",
    string[]
> = {
    gyroLpf1Hz: ["gyro_lpf1_static_hz", "gyro_lowpass_hz"],
    gyroLpf2Hz: ["gyro_lpf2_static_hz", "gyro_lowpass2_hz"],
    dtermLpf1Hz: ["dterm_lpf1_static_hz", "dterm_lpf_hz", "dterm_lowpass_hz"],
    dtermLpf2Hz: ["dterm_lpf2_static_hz", "dterm_lowpass2_hz"],
    dynNotchCount: ["dyn_notch_count"],
    rpmFilterHarmonics: ["rpm_filter_harmonics", "gyro_rpm_notch_harmonics"],
    motorPoles: ["motor_poles"],
};

interface ViewerFlightLog extends FlightLogFrames {
    getLogCount(): number;
    getLogError(index: number): string | false;
    openLog(index: number): boolean;
}

function emptyChirp(): M4ChirpDetection {
    return { status: "unknown", evidence: [], segmentCount: 0, chirpSampleCount: 0 };
}

function hasField(names: string[], want: string): boolean {
    const w = want.toLowerCase();
    const bare = w.replaceAll(/[[\]]/g, "");
    return names.some((n) => {
        const x = n.trim().toLowerCase();
        return x === w || x === bare;
    });
}

function headerMap(pairs: [string, string][]): Map<string, string> {
    const out = new Map<string, string>();
    for (const [k, v] of pairs) {
        out.set(normalizeFieldKey(k), v);
    }
    return out;
}

function filterMeta(headers: Map<string, string>): { meta: FlightMetricsMeta; missing: string[]; warnings: string[] } {
    const meta: FlightMetricsMeta = {};
    const missing: string[] = [];
    for (const [field, keys] of Object.entries(FILTER_HEADERS) as [keyof typeof FILTER_HEADERS, string[]][]) {
        const key = keys.find((k) => headers.has(k));
        const value = key === undefined ? null : jsParseInt(headers.get(key)!);
        if (value === null) {
            missing.push(keys[0]);
        } else {
            meta[field] = value;
        }
    }
    const warnings: string[] = [];
    // With a non-zero dynamic minimum the runtime cutoff follows throttle; the static value is not it.
    for (const [dyn, label] of [
        ["gyro_lpf1_dyn_hz", "gyro_lpf1"],
        ["dterm_lpf1_dyn_hz", "dterm_lpf1"],
    ] as const) {
        const raw = headers.get(dyn);
        const min = raw === undefined ? null : jsParseInt(raw);
        if (min !== null && min > 0) {
            warnings.push(`${label}_dynamic_static_hz_is_not_runtime_cutoff`);
        }
    }
    return { meta, missing, warnings };
}

/**
 * CHIRP state of the whole log. Fail-closed: `unknown` is treated as CHIRP by
 * the caller, since stick feedforward must never be derived from a sweep.
 */
function detectChirp(
    extraction: ReturnType<typeof extractChirp>,
    flags: Int32Array | null,
    debugModeIsChirp: boolean,
    debugModeUnsupported: boolean,
): M4ChirpDetection {
    const evidence: string[] = [];
    const chirpBit = 1 << BOXCHIRP_BIT;
    let flagRows = 0;
    if (flags) {
        for (let i = 0; i < flags.length; i++) {
            if (flags[i] >= 0 && flags[i] & chirpBit) {
                flagRows++;
            }
        }
    }
    if (extraction.detected) {
        evidence.push(`chirp_segments:${extraction.segments.length}`);
    }
    if (debugModeIsChirp) {
        evidence.push("debug_mode_chirp");
    }
    if (flagRows) {
        evidence.push("boxchirp_flag_seen");
    }
    const chirpSampleCount = extraction.segments.reduce((s, x) => s + x.sampleCount, 0);
    const base = { segmentCount: extraction.segments.length, chirpSampleCount };
    if (evidence.length) {
        return { status: "chirp", evidence, ...base };
    }
    if (!flags) {
        evidence.push("flight_mode_flags_missing");
    }
    if (debugModeUnsupported) {
        evidence.push("chirp_debug_mode_unknown_for_firmware");
    }
    if (evidence.length) {
        return { status: "unknown", evidence, ...base };
    }
    return { status: "no_chirp", evidence: ["no_boxchirp_flag", "debug_mode_not_chirp"], ...base };
}

function scaled(a: Float64Array, factor: number): Float64Array {
    if (factor === 1) {
        return a;
    }
    const out = new Float64Array(a.length);
    for (let i = 0; i < a.length; i++) {
        out[i] = a[i] * factor;
    }
    return out;
}

function analyzeLog(
    bytes: Uint8Array,
    flightLog: ViewerFlightLog,
    index: { getLogBeginOffset(i: number): number },
    logIndex: number,
): M4LogReport {
    const report: M4LogReport = {
        logIndex,
        error: null,
        firmwareRevision: null,
        debugMode: null,
        frameCount: 0,
        durationS: null,
        chirp: emptyChirp(),
        signals: { present: [], missing: [], missingHeaders: [] },
        warnings: [],
        result: null,
    };
    const start = index.getLogBeginOffset(logIndex);
    const end = index.getLogBeginOffset(logIndex + 1);
    const pairs = readHeaderPairs(bytes, start, end);
    const headers = parseLoggedHeaders(pairs);
    report.firmwareRevision = headers.firmwareRevision;
    report.debugMode = loggedInt(headers, "debug_mode");

    const logError = flightLog.getLogError(logIndex);
    if (logError || !flightLog.openLog(logIndex)) {
        report.error = `log_unreadable:${logError || "open_failed"}`;
        return report;
    }

    const names = flightLog.getMainFieldNames();
    const wanted = ["time", ...SETPOINT_FIELDS, ...GYRO_ADC_FIELDS, ...DEBUG_FIELDS, ...OPTIONAL_SIGNALS];
    for (const f of wanted) {
        // flightModeFlags is a slow (S-frame) field merged into main frames by the Viewer.
        (hasField(names, f) ? report.signals.present : report.signals.missing).push(f);
    }
    const filters = filterMeta(headerMap(pairs));
    report.signals.missingHeaders = filters.missing;
    report.warnings.push(...filters.warnings);

    let frames: ReturnType<typeof chirpFramesFromFlightLog>;
    try {
        frames = chirpFramesFromFlightLog(flightLog);
    } catch (err) {
        if (err instanceof ChirpFramesError) {
            // Without setpoint/gyro there is nothing to measure; without debug CHIRP cannot be ruled out.
            report.error = err.message;
            report.chirp.evidence.push("required_fields_missing");
            return report;
        }
        throw err;
    }
    report.frameCount = frames.timeUs.length;
    report.warnings.push(...frames.warnings);
    if (frames.timeUs.length >= 2) {
        report.durationS = (frames.timeUs[frames.timeUs.length - 1] - frames.timeUs[0]) / 1e6;
    }

    const extraction = extractChirp(frames, headers);
    const [, , debugErr] = validateChirpDebugMode(headers);
    report.chirp = detectChirp(
        extraction,
        frames.flightModeFlags,
        debugErr === null,
        debugErr === "chirp_debug_mode_unsupported_api",
    );

    if (frames.timeUs.length < 8) {
        report.error = "too_few_frames";
        return report;
    }

    const optional = extractOptionalBlackboxChannels(flightLog, { alignWith: ["time", ...REQUIRED_FIELDS] });
    const aligned = (cols: Float64Array[] | null) =>
        cols && cols.every((c) => c.length === frames.timeUs.length) ? cols : null;
    const dCols = aligned(optional.dTerm);
    const erpm = aligned(optional.erpm);
    const motors = aligned(optional.motors);
    if ((optional.dTerm && !dCols) || (optional.erpm && !erpm) || (optional.motors && !motors)) {
        report.warnings.push("optional_channels_not_row_aligned_dropped");
    }

    const scale = highResolutionScale(headers);
    const result = analyzeM4FlightMetrics({
        timeUs: frames.timeUs,
        setpoint: [
            scaled(frames.setpoint[0], scale),
            scaled(frames.setpoint[1], scale),
            scaled(frames.setpoint[2], scale),
        ],
        gyro: [scaled(frames.gyroAdc[0], scale), scaled(frames.gyroAdc[1], scale), scaled(frames.gyroAdc[2], scale)],
        // An axis without its own axisD column is passed as absent, never as zeros.
        dTerm: dCols
            ? [
                  optional.present.axisDAxes[0] ? dCols[0] : null,
                  optional.present.axisDAxes[1] ? dCols[1] : null,
                  optional.present.axisDAxes[2] ? dCols[2] : null,
              ]
            : undefined,
        motors: motors ?? undefined,
        erpm: erpm ?? undefined,
        meta: {
            ...filters.meta,
            firmwareVersion: headers.firmwareRevision ?? undefined,
            debugMode: report.debugMode ?? undefined,
            chirpActive: report.chirp.status !== "no_chirp",
        },
    });
    report.result = result;
    return report;
}

/** Run M4 on every embedded log of a blackbox file, decoded by the Blackbox Viewer. */
export function analyzeM4BblFile(
    bytes: Uint8Array,
    filename: string,
    onProgress?: (logIndex: number, logCount: number) => void,
): M4BblReport {
    const report: M4BblReport = {
        filename,
        decoder: "betaflight-blackbox-viewer",
        logCount: 0,
        error: null,
        logs: [],
        applyAllowed: false,
        recommendationsEnabled: false,
        cliOutput: null,
    };
    let index: { getLogBeginOffset(i: number): number; getLogCount(): number };
    let flightLog: ViewerFlightLog;
    try {
        index = new FlightLogIndex(bytes) as typeof index;
        flightLog = new FlightLog(bytes) as unknown as ViewerFlightLog;
        report.logCount = index.getLogCount();
    } catch (err) {
        report.error = `decode_failed:${err instanceof Error ? err.message : String(err)}`;
        return report;
    }
    if (report.logCount === 0) {
        report.error = "no_logs_found";
        return report;
    }
    for (let i = 0; i < report.logCount; i++) {
        onProgress?.(i, report.logCount);
        try {
            report.logs.push(analyzeLog(bytes, flightLog, index, i));
        } catch (err) {
            report.logs.push({
                logIndex: i,
                error: `analysis_failed:${err instanceof Error ? err.message : String(err)}`,
                firmwareRevision: null,
                debugMode: null,
                frameCount: 0,
                durationS: null,
                chirp: emptyChirp(),
                signals: { present: [], missing: [], missingHeaders: [] },
                warnings: [],
                result: null,
            });
        }
    }
    return report;
}
