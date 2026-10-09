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
 * GyroCore CHIRP qualification in front of Betaflight Autotune.
 *
 *   file bytes
 *     -> Blackbox Viewer FlightLog, every embedded log      (decode: Betaflight Viewer)
 *     -> CHIRP segments per log and axis, all kept           (detection: Betaflight rule)
 *     -> sample rate + timestamp checks                      (GyroCore)
 *     -> transfer function, sensitivity, step, spectrogram   (math: Betaflight spectral_analysis.ts)
 *     -> measurement-quality gates                           (GyroCore)
 *     -> recommendGains, only for a usable measurement       (math: Betaflight)
 *     -> current-tune gates + slider-translation guard       (GyroCore)
 *     -> Apply authorization                                 (GyroCore)
 *
 * No spectral or recommendation math lives here: Betaflight's functions are
 * passed in (see AutotuneMath) so this module never re-implements them.
 */

import { FlightLog } from "@/blackbox-viewer/flightlog.js";
import { FlightLogIndex } from "@/blackbox-viewer/flightlog_index.js";
import type { SysConfig } from "@/js/blackbox/chirp_bbl_parser";
import {
    computeSensitivity,
    computeSpectrogram,
    computeStepResponse,
    recommendGains,
    welchTransferFunction,
    type CurrentSliders,
    type GainRecommendation,
    type Sensitivity,
    type Spectrogram,
    type StepResponse,
    type TransferFunction,
} from "@/js/blackbox/spectral_analysis";
import { AXIS_NAMES, type ChirpAxisName } from "./constants";
import { currentTuneGates, type TuneGateResult } from "./currentTune";
import {
    ChirpFramesError,
    chirpFramesFromFlightLog,
    extractChirp,
    type ChirpExtraction,
    type ChirpSegmentInfo,
    type FlightLogFrames,
} from "./extraction";
import {
    loggedInt,
    parseLoggedHeaders,
    readHeaderPairs,
    sampleRateInputs,
    SLIDER_HEADER_KEYS,
    type LoggedHeaders,
} from "./headers";
import { analysisBand, postAnalysisReport, preAnalysisGates, type QualityReport } from "./quality";
import { guardRecommendation, type RecommendationGuard } from "./recommendationGuard";
import {
    analyzeTimestampSpacing,
    MISMATCH_TOLERANCE_FRACTION,
    resolveChirpSampleRate,
    type SampleRateEvidence,
    type TimestampSpacing,
} from "./sampleRate";

export const WELCH_OVERLAP = 0.5;

/** Betaflight Autotune helpers (src/composables/useAutotune.ts), injected to keep one copy of each. */
export interface AutotuneMath<G> {
    computeSampleRate(sysConfig: SysConfig): number;
    chooseSegmentSize(sampleRate: number): number;
    extractCurrentSliders(sysConfig: SysConfig): Required<CurrentSliders>;
    buildGains(rec: GainRecommendation, sensitivity: Sensitivity, stepResponse: StepResponse): G;
}

export type MeasurementState = "rejected" | "usable_with_warnings" | "usable";
export type QualificationState = "no_chirp" | MeasurementState;

/** Betaflight's analysis of one segment, computed whenever it is mathematically possible. */
export interface SegmentDiagnostics {
    transferFunction: TransferFunction;
    sensitivity: Sensitivity;
    stepResponse: StepResponse;
    spectrogram: Spectrogram;
    sampleCount: number;
}

export interface ApplyAuthorization {
    allowed: boolean;
    /** Every reason Apply is blocked, most fundamental first. Empty only when allowed. */
    blocked: string[];
    warnings: string[];
}

export interface ChirpMeasurement<G = unknown> {
    /** Stable within one analysis: "log<N>-seg<M>" (1-based). */
    id: string;
    logIndex: number;
    segmentIndex: number;
    axis: number;
    axisName: ChirpAxisName;
    /** 1-based count of this axis's segments within the log, so repeated sweeps stay distinct. */
    axisOccurrence: number;
    startTimeUs: number;
    endTimeUs: number;
    durationS: number;
    sampleCount: number;
    sampleRate: SampleRateEvidence;
    spacing: TimestampSpacing;
    /** What Betaflight Autotune's header-only formula gives for this log. */
    betaflightRateHz: number;
    segmentSize: number | null;
    quality: QualityReport;
    state: MeasurementState;
    /** Betaflight math on Viewer samples; may exist for a rejected measurement (diagnostic only). */
    diagnostics: SegmentDiagnostics | null;
    /** Betaflight recommendGains(); only ever produced for a usable measurement. */
    recommendation: { result: GainRecommendation; gains: G; guard: RecommendationGuard } | null;
    tune: TuneGateResult;
    apply: ApplyAuthorization;
}

export interface ChirpLogReport<G = unknown> {
    logIndex: number;
    error: string | null;
    totalFrames: number;
    firmwareRevision: string | null;
    /** Betaflight-shaped header view for the Autotune UI (current PIDs, sliders, CHIRP band). */
    sysConfig: SysConfig | null;
    currentSliders: Required<CurrentSliders> | null;
    extractionWarnings: string[];
    measurements: ChirpMeasurement<G>[];
}

export interface ChirpQualificationReport<G = unknown> {
    filename: string;
    decoder: "betaflight-blackbox-viewer";
    logCount: number;
    logs: ChirpLogReport<G>[];
    measurements: ChirpMeasurement<G>[];
    state: QualificationState;
    targetPhaseMarginDeg: number;
}

// ---------------------------------------------------------------------------
// Betaflight-shaped sysConfig for the Autotune UI
// ---------------------------------------------------------------------------

function num(v: unknown, fallback: number): number {
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function pidTriple(v: unknown): number[] {
    return Array.isArray(v) && v.length >= 3 ? v.slice(0, 3).map((x) => num(x, 0)) : [0, 0, 0];
}

/**
 * The Autotune UI reads current PIDs, sliders and the CHIRP band from
 * Betaflight's SysConfig shape. Built from the Viewer's sysConfig; the sliders
 * use Betaflight's defaults for display only, the gates read the logged values.
 */
export function autotuneSysConfig(viewer: Record<string, unknown>, headers: LoggedHeaders, names: string[]): SysConfig {
    const slider = (key: (typeof SLIDER_HEADER_KEYS)[number]) => loggedInt(headers, key) ?? 100;
    const fieldIndices: Record<string, number> = {};
    names.forEach((name, i) => {
        fieldIndices[name] = i;
    });
    const motorOutput = Array.isArray(viewer.motorOutput) ? viewer.motorOutput.map((x) => num(x, 0)) : [0, 0];
    return {
        dataVersion: loggedInt(headers, "data_version") ?? 2,
        looptime: num(viewer.looptime, 125),
        pid_process_denom: num(viewer.pid_process_denom, 1),
        debug_mode: num(viewer.debug_mode, -1),
        blackbox_high_resolution: loggedInt(headers, "blackbox_high_resolution") ?? 0,
        frameIntervalI: num(viewer.frameIntervalI, 32),
        frameIntervalPNum: num(viewer.frameIntervalPNum, 1),
        frameIntervalPDenom: num(viewer.frameIntervalPDenom, 1),
        minthrottle: num(viewer.minthrottle, 0),
        maxthrottle: num(viewer.maxthrottle, 0),
        vbatref: num(viewer.vbatref, 0),
        motorOutput,
        rollPID: pidTriple(viewer.rollPID),
        pitchPID: pidTriple(viewer.pitchPID),
        yawPID: pidTriple(viewer.yawPID),
        chirp_lag_freq_hz: loggedInt(headers, "chirp_lag_freq_hz") ?? 0,
        chirp_lead_freq_hz: loggedInt(headers, "chirp_lead_freq_hz") ?? 0,
        chirp_amplitude_roll: loggedInt(headers, "chirp_amplitude_roll") ?? 0,
        chirp_amplitude_pitch: loggedInt(headers, "chirp_amplitude_pitch") ?? 0,
        chirp_amplitude_yaw: loggedInt(headers, "chirp_amplitude_yaw") ?? 0,
        chirp_frequency_start_deci_hz: loggedInt(headers, "chirp_frequency_start_deci_hz") ?? 0,
        chirp_frequency_end_deci_hz: loggedInt(headers, "chirp_frequency_end_deci_hz") ?? 0,
        chirp_time_seconds: loggedInt(headers, "chirp_time_seconds") ?? 0,
        simplified_master_multiplier: slider("simplified_master_multiplier"),
        simplified_pi_gain: slider("simplified_pi_gain"),
        simplified_i_gain: slider("simplified_i_gain"),
        simplified_d_gain: slider("simplified_d_gain"),
        simplified_feedforward_gain: slider("simplified_feedforward_gain"),
        simplified_dterm_filter_multiplier: slider("simplified_dterm_filter_multiplier"),
        firmwareApiVersion: headers.firmwareApiVersion ?? undefined,
        firmwareRevision: headers.firmwareRevision ?? undefined,
        fieldIndices,
    };
}

// ---------------------------------------------------------------------------
// Per-measurement qualification
// ---------------------------------------------------------------------------

/** Sample-rate contract between GyroCore's resolved rate and the rate Betaflight Autotune assumes. */
function sampleRateContract(rate: SampleRateEvidence, betaflightRateHz: number): string[] {
    const out: string[] = [];
    if (rate.status !== "ok") {
        out.push(`sample_rate_contract:${rate.status}`);
    }
    const eff = rate.effectiveRateHz;
    if (eff === null || !Number.isFinite(betaflightRateHz) || betaflightRateHz <= 0) {
        out.push("sample_rate_contract:unknown");
    } else if (Math.abs(betaflightRateHz - eff) / eff > MISMATCH_TOLERANCE_FRACTION) {
        out.push("sample_rate_contract:betaflight_header_rate_differs");
    }
    return out;
}

function measurementState(quality: QualityReport, diagnostics: SegmentDiagnostics | null): MeasurementState {
    if (!quality.usable || diagnostics === null) {
        return "rejected";
    }
    return quality.warningGates.length ? "usable_with_warnings" : "usable";
}

/** Decide Apply for one measurement. Pure: the same inputs always give the same answer. */
export function authorizeMeasurement(
    m: Pick<
        ChirpMeasurement,
        "quality" | "diagnostics" | "sampleRate" | "betaflightRateHz" | "tune" | "recommendation"
    >,
): ApplyAuthorization {
    const blocked: string[] = [];
    const warnings: string[] = [];
    if (m.diagnostics === null) {
        blocked.push("measurement:no_transfer_function");
    }
    blocked.push(...m.quality.failedGates.map((g) => `measurement:${g}`));
    warnings.push(...m.quality.warningGates.map((g) => `measurement:${g}`));
    blocked.push(...sampleRateContract(m.sampleRate, m.betaflightRateHz));
    blocked.push(...m.tune.blocked);
    warnings.push(...m.tune.warnings);
    if (m.recommendation === null) {
        blocked.push("recommendation:not_produced");
    } else {
        blocked.push(...m.recommendation.guard.blocked);
        warnings.push(...m.recommendation.guard.warnings);
    }
    const uniqueBlocked = [...new Set(blocked)];
    return { allowed: uniqueBlocked.length === 0, blocked: uniqueBlocked, warnings: [...new Set(warnings)] };
}

function recommend<G>(
    m: ChirpMeasurement<G>,
    currentSliders: Required<CurrentSliders>,
    targetPhaseMarginDeg: number,
    math: AutotuneMath<G>,
): ChirpMeasurement<G>["recommendation"] {
    // GyroCore gate first: Betaflight is asked for gains only on a usable measurement.
    if (m.state === "rejected" || m.diagnostics === null) {
        return null;
    }
    const d = m.diagnostics;
    const result = recommendGains(d.transferFunction, currentSliders, targetPhaseMarginDeg);
    return {
        result,
        gains: math.buildGains(result, d.sensitivity, d.stepResponse),
        guard: guardRecommendation(currentSliders, result),
    };
}

function qualifySegment<G>(
    seg: ChirpSegmentInfo,
    extraction: ChirpExtraction,
    ctx: {
        logIndex: number;
        headers: LoggedHeaders;
        sysConfig: SysConfig;
        currentSliders: Required<CurrentSliders>;
        axisOccurrence: number;
        targetPhaseMarginDeg: number;
        math: AutotuneMath<G>;
    },
): ChirpMeasurement<G> {
    const lo = seg.startIdx;
    const hi = seg.endIdx + 1;
    const input = extraction.setpoint[seg.axis].subarray(lo, hi);
    const output = extraction.gyro[seg.axis].subarray(lo, hi);
    const ts = extraction.timeUs.subarray(lo, hi);

    const rate = resolveChirpSampleRate(sampleRateInputs(ctx.headers), ts);
    const spacing = analyzeTimestampSpacing(ts);
    const fs = rate.effectiveRateHz;
    const segmentSize = fs ? ctx.math.chooseSegmentSize(fs) : null;
    let gates = preAnalysisGates({ sampleCount: seg.sampleCount, segmentSize, rate, spacing });
    let band: [number, number] = [0, 0];
    if (fs) {
        const [b, bandGates] = analysisBand(extraction.frequencyRangeHz, fs);
        band = b;
        gates = gates.concat(bandGates);
    }

    let diagnostics: SegmentDiagnostics | null = null;
    if (fs && segmentSize !== null && seg.sampleCount >= segmentSize) {
        // Betaflight's math, at the sample rate GyroCore resolved for these samples.
        const transferFunction = welchTransferFunction(input, output, fs, segmentSize, WELCH_OVERLAP);
        diagnostics = {
            transferFunction,
            sensitivity: computeSensitivity(transferFunction),
            stepResponse: computeStepResponse(transferFunction, fs, segmentSize),
            spectrogram: computeSpectrogram(output, fs),
            sampleCount: seg.sampleCount,
        };
    }
    const quality = postAnalysisReport({
        gates,
        tf: diagnostics?.transferFunction ?? null,
        sampleRateHz: fs,
        inputSignal: input,
        bandHz: band,
    });

    const m: ChirpMeasurement<G> = {
        id: `log${ctx.logIndex + 1}-seg${seg.index + 1}`,
        logIndex: ctx.logIndex,
        segmentIndex: seg.index,
        axis: seg.axis,
        axisName: AXIS_NAMES[seg.axis],
        axisOccurrence: ctx.axisOccurrence,
        startTimeUs: seg.startTimeUs,
        endTimeUs: seg.endTimeUs,
        durationS: seg.durationS,
        sampleCount: seg.sampleCount,
        sampleRate: rate,
        spacing,
        betaflightRateHz: ctx.math.computeSampleRate(ctx.sysConfig),
        segmentSize,
        quality,
        state: measurementState(quality, diagnostics),
        diagnostics,
        recommendation: null,
        tune: currentTuneGates(ctx.headers, seg.axis),
        apply: { allowed: false, blocked: [], warnings: [] },
    };
    m.recommendation = recommend(m, ctx.currentSliders, ctx.targetPhaseMarginDeg, ctx.math);
    m.apply = authorizeMeasurement(m);
    return m;
}

// ---------------------------------------------------------------------------
// Whole file
// ---------------------------------------------------------------------------

/** The parts of the Viewer FlightLog used here (untyped JS). */
interface ViewerFlightLog extends FlightLogFrames {
    getLogCount(): number;
    getLogError(index: number): string | false;
    openLog(index: number): boolean;
    getSysConfig(): Record<string, unknown>;
}

function qualifyLog<G>(
    bytes: Uint8Array,
    flightLog: ViewerFlightLog,
    index: { getLogBeginOffset(i: number): number },
    logIndex: number,
    targetPhaseMarginDeg: number,
    math: AutotuneMath<G>,
): ChirpLogReport<G> {
    const report: ChirpLogReport<G> = {
        logIndex,
        error: null,
        totalFrames: 0,
        firmwareRevision: null,
        sysConfig: null,
        currentSliders: null,
        extractionWarnings: [],
        measurements: [],
    };
    const start = index.getLogBeginOffset(logIndex);
    const end = index.getLogBeginOffset(logIndex + 1);
    const headers = parseLoggedHeaders(readHeaderPairs(bytes, start, end));
    report.firmwareRevision = headers.firmwareRevision;

    const logError = flightLog.getLogError(logIndex);
    if (logError || !flightLog.openLog(logIndex)) {
        report.error = `log_unreadable:${logError || "open_failed"}`;
        return report;
    }
    let extraction: ChirpExtraction;
    try {
        const frames = chirpFramesFromFlightLog(flightLog);
        report.totalFrames = frames.timeUs.length;
        extraction = extractChirp(frames, headers);
    } catch (err) {
        if (err instanceof ChirpFramesError) {
            report.error = err.message;
            return report;
        }
        throw err;
    }
    report.extractionWarnings = extraction.warnings;
    if (extraction.errors.length) {
        report.error = extraction.errors[0];
        return report;
    }
    const sysConfig = autotuneSysConfig(flightLog.getSysConfig(), headers, flightLog.getMainFieldNames());
    const currentSliders = math.extractCurrentSliders(sysConfig);
    report.sysConfig = sysConfig;
    report.currentSliders = currentSliders;

    const seen = [0, 0, 0];
    for (const seg of extraction.segments) {
        seen[seg.axis]++;
        report.measurements.push(
            qualifySegment(seg, extraction, {
                logIndex,
                headers,
                sysConfig,
                currentSliders,
                axisOccurrence: seen[seg.axis],
                targetPhaseMarginDeg,
                math,
            }),
        );
    }
    return report;
}

export function overallState(measurements: ChirpMeasurement[]): QualificationState {
    if (!measurements.length) {
        return "no_chirp";
    }
    if (measurements.some((m) => m.state === "usable")) {
        return "usable";
    }
    if (measurements.some((m) => m.state === "usable_with_warnings")) {
        return "usable_with_warnings";
    }
    return "rejected";
}

/** Qualify every CHIRP segment of every embedded log in a blackbox file. */
export function qualifyChirpFile<G>(
    bytes: Uint8Array,
    filename: string,
    targetPhaseMarginDeg: number,
    math: AutotuneMath<G>,
    onProgress?: (logIndex: number, logCount: number) => void,
): ChirpQualificationReport<G> {
    const index = new FlightLogIndex(bytes) as { getLogBeginOffset(i: number): number; getLogCount(): number };
    const flightLog = new FlightLog(bytes) as unknown as ViewerFlightLog;
    const logCount = index.getLogCount();
    const logs: ChirpLogReport<G>[] = [];
    for (let i = 0; i < logCount; i++) {
        onProgress?.(i, logCount);
        logs.push(qualifyLog(bytes, flightLog, index, i, targetPhaseMarginDeg, math));
    }
    const measurements = logs.flatMap((l) => l.measurements);
    return {
        filename,
        decoder: "betaflight-blackbox-viewer",
        logCount,
        logs,
        measurements,
        state: overallState(measurements),
        targetPhaseMarginDeg,
    };
}

/** Re-derive recommendations and authorizations for a new phase-margin target (no re-parse). */
export function recomputeRecommendations<G>(
    report: ChirpQualificationReport<G>,
    targetPhaseMarginDeg: number,
    math: AutotuneMath<G>,
): void {
    report.targetPhaseMarginDeg = targetPhaseMarginDeg;
    for (const log of report.logs) {
        for (const m of log.measurements) {
            m.recommendation = log.currentSliders ? recommend(m, log.currentSliders, targetPhaseMarginDeg, math) : null;
            m.apply = authorizeMeasurement(m);
        }
    }
}
