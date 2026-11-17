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
 * Blackbox file → step-response input per embedded log (docs/gyrocore/STEP_RESPONSE.md §3).
 * Reuses the Viewer decoder (FlightLog), the header readers, the timestamp spacing, the M4 flight
 * segmentation (flight runs) and the CHIRP extraction; adds the per-sample evidence the windows are
 * judged on. Diagnosis only: nothing here reads or writes a flight controller.
 */

import { FlightLog } from "@/blackbox-viewer/flightlog.js";
import { FlightLogIndex } from "@/blackbox-viewer/flightlog_index.js";
import { FIRMWARE_TYPE_BETAFLIGHT, FLIGHT_LOG_FLIGHT_MODE_NAME } from "@/blackbox-viewer/flightlog_fielddefs.js";
import { chirpFramesFromFlightLog, extractChirp } from "../chirp/extraction";
import {
    descaleHighResolution,
    parseLoggedHeaders,
    readHeaderPairs,
    sampleRateInputs,
    validateChirpDebugMode,
} from "../chirp/headers";
import { analyzeTimestampSpacing, resolveChirpSampleRate, SPACING_GAP_FACTOR } from "../chirp/sampleRate";
import type { AutotuneLogInput } from "../engine/autotuneV2";
import { logIdentity, type LogIdentity } from "../tuning/fcIdentity";
import { extractOptionalBlackboxChannels } from "@/js/blackbox/flight_metrics_analysis";
import { segmentFlightLog, SEGMENTATION_THRESHOLDS } from "@/js/blackbox/m4_segmentation";
import { analyzeAxisStep, STEP_METHOD, type StepAxisResult, type StepSampleEvidence } from "./stepResponse";

export const STEP_AXES = ["roll", "pitch", "yaw"] as const;
export type StepAxis = (typeof STEP_AXES)[number];

/**
 * Boxes after which the rate loop is not the plain Acro loop (self-level, heading or altitude
 * hold, automation, motor direction or stick mapping changed). Names as the Viewer's
 * version-dependent FLIGHT_LOG_FLIGHT_MODE_NAME table has them; a name a firmware lacks is ignored.
 */
export const SELF_LEVEL_OR_AUTOMATION_BOXES = [
    "ANGLE",
    "HORIZON",
    "MAG",
    "ALTHOLD",
    "BARO",
    "HEADFREE",
    "PASSTHRU",
    "FAILSAFE",
    "POSHOLD",
    "GPSHOME",
    "GPSHOLD",
    "GPSRESCUE",
    "AUTOPILOT",
    "3D",
    "FPVANGLEMIX",
    "FLIPOVERAFTERCRASH",
    "ACROTRAINER",
    "LAUNCHCONTROL",
] as const;

/** Boxes whose switching inside a window is a mode change (the above plus these). */
export const MODE_CHANGE_BOXES = [...SELF_LEVEL_OR_AUTOMATION_BOXES, "ARM", "AIRMODE", "ANTIGRAVITY", "CHIRP"] as const;

/** Only bits 0–31 of the box activation mask are logged (flightModeFlags is one 32-bit word). */
const LOGGED_BOX_BITS = 32;

const FIELDS = [
    "time",
    "loopIteration",
    "setpoint[0]",
    "setpoint[1]",
    "setpoint[2]",
    "gyroADC[0]",
    "gyroADC[1]",
    "gyroADC[2]",
    "rcCommand[3]",
    "flightModeFlags",
    "failsafePhase",
    "axisF[0]",
    "axisF[1]",
    "axisF[2]",
    "axisI[0]",
    "axisI[1]",
    "axisI[2]",
    "vbatLatest",
] as const;

export type Knowledge = "KNOWN" | "UNKNOWN";

/** What the log says about the loop that produced the curve (reported, not used in the estimate). */
export interface LoopInfo {
    itermRelax: { mode: string | null; type: string | null; cutoffHz: string | null };
    feedforward: {
        weights: string | null;
        transition: string | null;
        boost: string | null;
        smoothFactor: string | null;
        jitterFactor: string | null;
        averaging: string | null;
        maxRateLimit: string | null;
    };
    /** axisF / axisI logged per axis (roll, pitch, yaw). */
    axisFLogged: [boolean, boolean, boolean];
    axisILogged: [boolean, boolean, boolean];
}

export interface StepLogResult {
    /** `${sha256}:${logIndex}` */
    key: string;
    fileName: string;
    sha256: string;
    /** 0-based index; logNumber = logIndex + 1 as the Viewer and the app number logs. */
    logIndex: number;
    logNumber: number;
    logCount: number;
    status: "ANALYSED" | "BLOCKED";
    blockedReasons: string[];
    headerPairs: readonly (readonly [string, string])[];
    identity: LogIdentity;
    firmwareVersion: string | null;
    sampleRateHz: number | null;
    headerRateHz: number | null;
    durationS: number;
    timestamps: { gapCount: number; missingFraction: number; medianDtUs: number | null; uniform: boolean } | null;
    /** Seconds of each sample class (flight, CHIRP, self-level …), for the overview. */
    seconds: { airborne: number; chirp: number; selfLevel: number; saturated: number | null };
    chirp: { debugModeChirp: boolean; segments: number; boxInFirmware: boolean; boxSeen: boolean };
    saturation: Knowledge;
    failsafe: Knowledge;
    /**
     * Median logged battery voltage (vbatLatest, log units) over the airborne samples; null when
     * not logged. A flight-state covariate for the A/B (Grok r6): at a fixed motor command the
     * thrust scales with the voltage, so a fresh and a sagging pack can change the loop gain.
     */
    battery: { medianInFlight: number | null };
    /** Mode names (bits) active in the log, for the report. */
    modesSeen: string[];
    notes: string[];
    loop: LoopInfo;
    axes: Partial<Record<StepAxis, StepAxisResult>>;
    /** The flight identity flightRelation / uniqueFlights work on (logInput.ts); null when BLOCKED early. */
    flight: AutotuneLogInput | null;
}

interface ViewerLog {
    getLogError(i: number): string | null | false;
    openLog(i: number): boolean;
    getMainFieldNames(): string[];
    getMinTime(): number;
    getMaxTime(): number;
    getChunksInTimeRange(min: number, max: number): { frames: ArrayLike<number | null | undefined>[] }[];
    getSysConfig(): Record<string, unknown>;
}

const header = (pairs: readonly (readonly [string, string])[], key: string) =>
    pairs.find(([k]) => k === key)?.[1]?.trim() ?? null;

/** Motor output range from the header (`motorOutput:min,max`), or null. */
export function motorRangeFromHeader(pairs: readonly (readonly [string, string])[]): [number, number] | null {
    const raw = header(pairs, "motorOutput");
    if (!raw) return null;
    const [a, b] = raw.split(",").map((v) => Number.parseInt(v, 10));
    return Number.isFinite(a) && Number.isFinite(b) && b > a ? [a, b] : null;
}

function loopInfo(pairs: readonly (readonly [string, string])[], fields: string[]): LoopInfo {
    const has = (f: string) => fields.some((n) => n.trim() === f);
    return {
        itermRelax: {
            mode: header(pairs, "iterm_relax"),
            type: header(pairs, "iterm_relax_type"),
            cutoffHz: header(pairs, "iterm_relax_cutoff"),
        },
        feedforward: {
            weights: header(pairs, "ff_weight"),
            transition: header(pairs, "feedforward_transition"),
            boost: header(pairs, "feedforward_boost"),
            smoothFactor: header(pairs, "feedforward_smooth_factor"),
            jitterFactor: header(pairs, "feedforward_jitter_factor"),
            averaging: header(pairs, "feedforward_averaging"),
            maxRateLimit: header(pairs, "feedforward_max_rate_limit"),
        },
        axisFLogged: [has("axisF[0]"), has("axisF[1]"), has("axisF[2]")],
        axisILogged: [has("axisI[0]"), has("axisI[1]"), has("axisI[2]")],
    };
}

function maskOf(names: readonly string[], table: readonly string[]): number {
    let m = 0;
    for (const name of names) {
        const i = table.indexOf(name);
        if (i >= 0 && i < LOGGED_BOX_BITS) m |= 1 << i;
    }
    return m;
}

function emptyResult(
    base: Pick<StepLogResult, "key" | "fileName" | "sha256" | "logIndex" | "logNumber" | "logCount" | "headerPairs">,
    reasons: string[],
): StepLogResult {
    return {
        ...base,
        status: "BLOCKED",
        blockedReasons: reasons,
        identity: logIdentity(base.headerPairs),
        firmwareVersion: null,
        sampleRateHz: null,
        headerRateHz: null,
        durationS: 0,
        timestamps: null,
        seconds: { airborne: 0, chirp: 0, selfLevel: 0, saturated: null },
        chirp: { debugModeChirp: false, segments: 0, boxInFirmware: false, boxSeen: false },
        saturation: "UNKNOWN",
        failsafe: "UNKNOWN",
        battery: { medianInFlight: null },
        modesSeen: [],
        notes: [],
        loop: loopInfo(base.headerPairs, []),
        axes: {},
        flight: null,
    };
}

/** First index with t[i] ≥ value (t ascending). */
function lowerBound(t: ArrayLike<number>, value: number): number {
    let lo = 0;
    let hi = t.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (t[mid] < value) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/** Step-response analysis of one embedded log. */
function analyzeLog(
    bytes: Uint8Array,
    flightLog: ViewerLog,
    index: { getLogBeginOffset(i: number): number },
    logIndex: number,
    logCount: number,
    fileName: string,
    sha256: string,
): StepLogResult {
    const headerPairs = readHeaderPairs(
        bytes,
        index.getLogBeginOffset(logIndex),
        index.getLogBeginOffset(logIndex + 1),
    );
    const base = {
        key: `${sha256}:${logIndex}`,
        fileName,
        sha256,
        logIndex,
        logNumber: logIndex + 1,
        logCount,
        headerPairs,
    };
    const logError = flightLog.getLogError(logIndex);
    if (logError || !flightLog.openLog(logIndex))
        return emptyResult(base, [`log_unreadable:${logError || "open_failed"}`]);

    const sys = flightLog.getSysConfig();
    const firmwareVersion = typeof sys.firmwareVersion === "string" ? sys.firmwareVersion : null;
    const reasons: string[] = [];
    const notes: string[] = [];
    if (sys.firmwareType !== FIRMWARE_TYPE_BETAFLIGHT || !firmwareVersion) reasons.push("unsupported_firmware");
    // Read right after openLog: the Viewer sets the table for this log's firmware version.
    const modeTable = [...(FLIGHT_LOG_FLIGHT_MODE_NAME as readonly string[])];

    const h = parseLoggedHeaders(headerPairs as [string, string][]);
    const ex = extractOptionalBlackboxChannels(flightLog, { fields: FIELDS, alignWith: ["time"] });
    const ch = descaleHighResolution(ex.named, h);
    const t = ch.time;
    const sp = [ch["setpoint[0]"], ch["setpoint[1]"], ch["setpoint[2]"]];
    const gy = [ch["gyroADC[0]"], ch["gyroADC[1]"], ch["gyroADC[2]"]];
    const flagsRaw = ch.flightModeFlags;
    if (!t || t.length < 2) reasons.push("missing_required_field:time");
    if (sp.some((c) => !c)) reasons.push("missing_required_field:setpoint");
    if (gy.some((c) => !c)) reasons.push("missing_required_field:gyroADC");
    if (!flagsRaw) reasons.push("missing_required_field:flightModeFlags");
    if (!ch["rcCommand[3]"]) reasons.push("missing_required_field:rcCommand[3]");
    if (reasons.length || !t) return { ...emptyResult(base, reasons), firmwareVersion };

    const n = t.length;
    const spacing = analyzeTimestampSpacing(t);
    const rate = resolveChirpSampleRate(sampleRateInputs(h), t);
    const fs = spacing.medianDtUs ? 1e6 / spacing.medianDtUs : null;
    if (!fs || !spacing.uniform) reasons.push("timebase_unusable");
    if (rate.status === "mismatch" || rate.status === "unusable") reasons.push(`sample_rate_${rate.status}`);
    if (fs && fs < STEP_METHOD.minSampleRateHz)
        reasons.push(`sample_rate_below_minimum:${Math.round(fs)}<${STEP_METHOD.minSampleRateHz}`);

    const flags = new Int32Array(n);
    // −1: no S-frame yet (unknown). Bit 31 (PREARM in 2025.12+) is cleared so that a set bit 31 does not
    // read as that unknown marker; it is not a flight mode (Grok r1 NOTE-4).
    for (let i = 0; i < n; i++) flags[i] = Number.isFinite(flagsRaw![i]) ? Math.trunc(flagsRaw![i]) & 0x7fffffff : -1;
    const failsafe = ch.failsafePhase;
    const throttle = ch["rcCommand[3]"]!;

    const loop = loopInfo(headerPairs, flightLog.getMainFieldNames());
    const identity = logIdentity(headerPairs);
    const iterations = ch.loopIteration;
    const flight: AutotuneLogInput = {
        sha256,
        logIndex,
        headerPairs,
        sampleRateHz: fs ?? 0,
        channels: {
            timeUs: t,
            gyroAdc: [gy[0]!, gy[1]!, gy[2]!],
            gyroUnfilt: null,
            erpm: [],
            rcThrottle: throttle,
            axisD: null,
            motors: ex.motors,
            rcModeMask: flags,
        },
        chirp: {},
        stick: { acroSeconds: 0, latencyMs: {} },
        noiseFloorKnown: false,
        session: {
            firstIteration: iterations && Number.isFinite(iterations[0]) ? iterations[0] : null,
            startDatetime: (() => {
                const raw = header(headerPairs, "Log start datetime");
                return raw && !/^0000-/.test(raw) && Number.isFinite(Date.parse(raw)) ? raw : null;
            })(),
        },
    };
    const durationS = n > 1 ? (t[n - 1] - t[0]) / 1e6 : 0;
    const result: StepLogResult = {
        ...emptyResult(base, []),
        status: "ANALYSED",
        identity,
        firmwareVersion,
        sampleRateHz: fs,
        headerRateHz: rate.headerRateHz,
        durationS,
        timestamps: {
            gapCount: spacing.gapCount,
            missingFraction: spacing.missingFraction,
            medianDtUs: spacing.medianDtUs,
            uniform: spacing.uniform,
        },
        failsafe: failsafe ? "KNOWN" : "UNKNOWN",
        loop,
        flight,
        notes,
    };
    if (reasons.length || !fs) return { ...result, status: "BLOCKED", blockedReasons: reasons };

    // Per-sample evidence.
    const ev: StepSampleEvidence = {
        notAirborne: new Uint8Array(n).fill(1),
        gapBefore: new Uint8Array(n),
        chirp: new Uint8Array(n),
        selfLevel: new Uint8Array(n),
        modeWord: new Int32Array(n),
        saturated: null,
    };
    const seg = segmentFlightLog({
        timeUs: t,
        flightModeFlags: flags,
        throttle,
        failsafePhase: failsafe ?? null,
        setpoint: [sp[0]!, sp[1]!, sp[2]!],
        sampleRateHz: fs,
    });
    notes.push(...seg.reasons);
    for (const r of seg.flight) ev.notAirborne.fill(0, r.start, r.end);
    const dtMed = spacing.medianDtUs!;
    for (let i = 1; i < n; i++) {
        const d = t[i] - t[i - 1];
        if (!(d > 0) || d > SPACING_GAP_FACTOR * dtMed) ev.gapBefore[i] = 1;
    }
    const selfMask = maskOf(SELF_LEVEL_OR_AUTOMATION_BOXES, modeTable);
    const changeMask = maskOf(MODE_CHANGE_BOXES, modeTable);
    const chirpMask = maskOf(["CHIRP"], modeTable);
    const beyond = MODE_CHANGE_BOXES.filter((b) => modeTable.indexOf(b) >= LOGGED_BOX_BITS);
    if (beyond.length) notes.push(`modes_not_logged_beyond_bit_31:${beyond.join(",")}`);
    let seen = 0;
    for (let i = 0; i < n; i++) {
        const f = flags[i];
        if (f < 0) {
            ev.modeWord[i] = -1;
            continue;
        }
        seen |= f;
        ev.modeWord[i] = f & changeMask;
        if (f & selfMask) ev.selfLevel[i] = 1;
        if (chirpMask && f & chirpMask) ev.chirp[i] = 1;
    }
    result.modesSeen = modeTable.filter((name, i) => i < LOGGED_BOX_BITS && seen & (1 << i));

    // CHIRP: the BOXCHIRP flag where the firmware has the box, and the existing extraction's sweep
    // segments where the debug mode is CHIRP. A CHIRP debug mode without a sweep is not activity.
    const [, , debugErr] = validateChirpDebugMode(h, h.firmwareApiVersion);
    const debugModeChirp = !debugErr;
    let segments = 0;
    if (debugModeChirp) {
        try {
            const frames = chirpFramesFromFlightLog(flightLog);
            const extraction = extractChirp(frames, h);
            segments = extraction.segments.length;
            for (const s of extraction.segments) {
                const a = lowerBound(t, s.startTimeUs);
                const b = lowerBound(t, s.endTimeUs + 1);
                ev.chirp.fill(1, a, Math.max(a, b));
            }
        } catch {
            notes.push("chirp_extraction_failed_flag_only");
        }
    }
    // Guard band around every CHIRP run, as the M4 segmentation (settling at sweep start / end).
    const guard = Math.round(SEGMENTATION_THRESHOLDS.chirpGuardS * fs);
    const chirpCore = ev.chirp.slice();
    for (let i = 0; i < n; i++) {
        if (!chirpCore[i] || (i > 0 && chirpCore[i - 1] && i + 1 < n && chirpCore[i + 1])) continue;
        ev.chirp.fill(1, Math.max(0, i - guard), Math.min(n, i + guard + 1));
    }
    result.chirp = {
        debugModeChirp,
        segments,
        boxInFirmware: chirpMask !== 0,
        boxSeen: chirpMask !== 0 && (seen & chirpMask) !== 0,
    };
    if (!debugModeChirp && !chirpMask) notes.push("chirp_not_available_in_this_firmware_or_debug_mode");

    // Saturation: a motor at either end of its output range while in flight.
    const range = motorRangeFromHeader(headerPairs);
    if (ex.motors?.length && range) {
        const sat = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
            for (const m of ex.motors) {
                const v = m[i];
                // A missing (non-finite) motor value cannot show it is inside the range: counted as saturated.
                if (!(v < range[1] && v > range[0])) {
                    sat[i] = 1;
                    break;
                }
            }
        }
        ev.saturated = sat;
        result.saturation = "KNOWN";
    } else {
        notes.push(
            ex.motors?.length
                ? "motor_output_range_missing_saturation_unknown"
                : "motors_not_logged_saturation_unknown",
        );
    }

    const count = (a: Uint8Array, also?: Uint8Array) => {
        let c = 0;
        for (let i = 0; i < n; i++) if (a[i] && (!also || !also[i])) c++;
        return c / fs;
    };
    const airborne = new Uint8Array(n);
    for (let i = 0; i < n; i++) airborne[i] = ev.notAirborne[i] ? 0 : 1;
    const vbat = ch.vbatLatest;
    if (vbat) {
        const v: number[] = [];
        for (let i = 0; i < n; i++) if (airborne[i] && Number.isFinite(vbat[i]) && vbat[i] > 0) v.push(vbat[i]);
        v.sort((x, y) => x - y);
        result.battery = { medianInFlight: v.length ? v[v.length >> 1] : null };
    }
    if (result.battery.medianInFlight === null) notes.push("battery_voltage_not_logged_in_flight");
    result.seconds = {
        airborne: count(airborne),
        chirp: count(ev.chirp),
        selfLevel: count(ev.selfLevel),
        saturated: ev.saturated ? count(ev.saturated) : null,
    };
    STEP_AXES.forEach((axis, a) => {
        result.axes[axis] = analyzeAxisStep({ sampleRateHz: fs, setpoint: sp[a]!, gyro: gy[a]!, evidence: ev });
    });
    return result;
}

/** Every embedded log of a blackbox file ("Log 1 of N" … as the app numbers them). */
export function analyzeStepFile(bytes: Uint8Array, fileName: string, sha256: string): StepLogResult[] {
    const index = new FlightLogIndex(bytes) as unknown as {
        getLogCount(): number;
        getLogBeginOffset(i: number): number;
    };
    const flightLog = new FlightLog(bytes) as unknown as ViewerLog;
    const count = index.getLogCount();
    const out: StepLogResult[] = [];
    for (let i = 0; i < count; i++) out.push(analyzeLog(bytes, flightLog, index, i, count, fileName, sha256));
    return out;
}
