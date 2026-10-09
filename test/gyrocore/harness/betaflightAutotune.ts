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
 * Runs Betaflight Autotune's analysis on every CHIRP segment of every log.
 *
 * useAutotune.ts keeps analyzeLog / computeAxisResult / computeSampleRate /
 * chooseSegmentSize private, and the app only shows the first log with a
 * result and the last segment per axis. To compare every segment with GyroCore
 * this module repeats that orchestration using the exported upstream functions
 * (parser and spectral_analysis.ts, unmodified). The two small private helpers
 * are mirrored verbatim from src/composables/useAutotune.ts (upstream d85e797e);
 * test/gyrocore/air65_autotune.local.test.ts checks this mirror against the real
 * importAndAnalyze() on the log the app selects.
 */

import { findLogBoundaries, parseChirpLog } from "../../../src/js/blackbox/chirp_bbl_parser";
import type { ChirpData, ChirpSegment, SysConfig } from "../../../src/js/blackbox/chirp_bbl_parser";
import {
    computeSensitivity,
    computeSpectrogram,
    computeStepResponse,
    recommendGains,
    welchTransferFunction,
} from "../../../src/js/blackbox/spectral_analysis";

const AXIS_NAMES = ["roll", "pitch", "yaw"] as const;

/** useAutotune.ts computeSampleRate (verbatim). */
export function computeSampleRate(sysConfig: SysConfig) {
    const looptimeUs = sysConfig.looptime || 125;
    const pidDenom = sysConfig.pid_process_denom || 1;
    const bbRate = sysConfig.frameIntervalPDenom || 1;
    return 1e6 / (looptimeUs * pidDenom * bbRate);
}

/** useAutotune.ts chooseSegmentSize (verbatim). */
export function chooseSegmentSize(sampleRate: number) {
    let segmentSize = 256;
    while (segmentSize < sampleRate * 0.5) {
        segmentSize <<= 1;
    }
    return Math.min(segmentSize, 4096);
}

/** useAutotune.ts extractCurrentSliders (verbatim). */
export function extractCurrentSliders(sysConfig: SysConfig) {
    return {
        masterMultiplier: (sysConfig.simplified_master_multiplier || 100) / 100,
        piGain: (sysConfig.simplified_pi_gain || 100) / 100,
        iGain: (sysConfig.simplified_i_gain || 100) / 100,
        dGain: (sysConfig.simplified_d_gain || 100) / 100,
        feedforwardGain: (sysConfig.simplified_feedforward_gain || 100) / 100,
        dtermFilterMultiplier: (sysConfig.simplified_dterm_filter_multiplier || 100) / 100,
    };
}

export interface SegmentAnalysis {
    index: number;
    axis: number;
    axisName: string;
    startIdx: number;
    endIdx: number;
    length: number;
    /** Why Betaflight produces no result for this segment (it never rejects on quality). */
    skipped: string | null;
    transferFunction?: ReturnType<typeof welchTransferFunction>;
    sensitivity?: ReturnType<typeof computeSensitivity>;
    stepResponse?: ReturnType<typeof computeStepResponse>;
    spectrogram?: ReturnType<typeof computeSpectrogram>;
    recommendation?: ReturnType<typeof recommendGains>;
}

export interface LogAnalysis {
    logIndex: number;
    error: string | null;
    sysConfig?: SysConfig;
    chirpData?: ChirpData;
    sampleRate?: number;
    segmentSize?: number;
    segments: SegmentAnalysis[];
    /** Segment index per axis name the app would show (later segments overwrite earlier ones). */
    appSelected: Record<string, number>;
}

export function analyzeSegment(
    seg: ChirpSegment,
    index: number,
    chirpData: ChirpData,
    sampleRate: number,
    segmentSize: number,
    sysConfig: SysConfig,
    targetPhaseMarginDeg = 60,
): SegmentAnalysis {
    const length = seg.endIdx - seg.startIdx + 1;
    const out: SegmentAnalysis = {
        index,
        axis: seg.axis,
        axisName: AXIS_NAMES[seg.axis] ?? String(seg.axis),
        startIdx: seg.startIdx,
        endIdx: seg.endIdx,
        length,
        skipped: null,
    };
    if (!Number.isInteger(seg.axis) || seg.axis < 0 || seg.axis > 2) {
        out.skipped = "unsupported DEBUG_CHIRP axis encoding (app throws)";
        return out;
    }
    if (length < segmentSize) {
        out.skipped = "len < segmentSize (app drops the segment silently)";
        return out;
    }
    const input = chirpData.setpoint[seg.axis].subarray(seg.startIdx, seg.endIdx + 1);
    const output = chirpData.gyro[seg.axis].subarray(seg.startIdx, seg.endIdx + 1);
    const tf = welchTransferFunction(input, output, sampleRate, segmentSize, 0.5);
    out.transferFunction = tf;
    out.recommendation = recommendGains(tf, extractCurrentSliders(sysConfig), targetPhaseMarginDeg);
    out.sensitivity = computeSensitivity(tf);
    out.stepResponse = computeStepResponse(tf, sampleRate, segmentSize);
    out.spectrogram = computeSpectrogram(output, sampleRate);
    return out;
}

export function analyzeAllLogs(bytes: Uint8Array, apiVersion?: string): LogAnalysis[] {
    return findLogBoundaries(bytes).map((boundary, logIndex) => {
        const log: LogAnalysis = { logIndex, error: null, segments: [], appSelected: {} };
        try {
            const { sysConfig, chirpData } = parseChirpLog(bytes, boundary.start, boundary.end, apiVersion);
            log.sysConfig = sysConfig;
            log.chirpData = chirpData;
            const sampleRate = computeSampleRate(sysConfig);
            const segmentSize = chooseSegmentSize(sampleRate);
            log.sampleRate = sampleRate;
            log.segmentSize = segmentSize;
            for (const [i, seg] of chirpData.segments.entries()) {
                const s = analyzeSegment(seg, i, chirpData, sampleRate, segmentSize, sysConfig);
                log.segments.push(s);
                if (!s.skipped) {
                    log.appSelected[s.axisName] = i;
                }
            }
        } catch (e) {
            log.error = e instanceof Error ? e.message : String(e);
        }
        return log;
    });
}
