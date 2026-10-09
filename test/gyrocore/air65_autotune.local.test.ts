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
 * LOCAL ONLY: Betaflight Autotune on the real AIR65 three-log CHIRP flight,
 * against GyroCore's reference analysis of the same bytes. Skipped unless
 *   GYROFLIGHT_AIR65_BBL      path to the AIR65 .BBL (sha256 checked)
 *   GYROFLIGHT_AIR65_REF_DIR  directory with GyroCore outputs for that file:
 *                             golden_log{0,1,2}.json.gz (make_browser_golden.py --local)
 *                             gc_recommend.json         (recommend_autotune_from_bbl per log)
 * See docs/gyrocore/BLACKBOX_CHIRP_PARITY.md for how to regenerate them.
 *
 * Upstream Autotune as shipped is reproduced by harness/betaflightAutotune.ts
 * (verified against the real useAutotune() pipeline in WU1, before WU2 replaced
 * that pipeline's input and added GyroCore's gate).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeAllLogs, analyzeSegment } from "./harness/betaflightAutotune";
import type { LogAnalysis } from "./harness/betaflightAutotune";
import { decodeWithViewer } from "./harness/viewerDecode";
import { compareSegment, judgment } from "./harness/chirpCompare";
import type { GyroCoreAxis } from "./harness/chirpCompare";
import { AIR65_SHA256, localAir65, readJsonFile, sha256, writeReport } from "./harness/fixtures";

const air65 = localAir65();

interface GoldenLog {
    bbl_sha256: string;
    log_index: number;
    result: {
        status: string;
        errors: string[];
        warnings: string[];
        axes: Record<string, GyroCoreAxis & { segment: { duration_s: number } }>;
        extraction: {
            sample_count: number;
            total_frames: number;
            segments: { axis: number; start_idx: number; end_idx: number; duration_s: number }[];
        } | null;
    };
}

interface GcRecommendation {
    log_index: number;
    status: string;
    axes: Record<
        string,
        {
            status: string;
            blocked: string[];
            proposed_gated: Record<string, number> | null;
            ungated_recommendation_for_parity_only: {
                proposed: Record<string, number>;
                metrics: Record<string, unknown>;
            };
        }
    >;
}

const SLIDER_KEYS = [
    "slider_master_multiplier",
    "slider_pi_gain",
    "slider_i_gain",
    "slider_d_gain",
    "slider_feedforward_gain",
    "slider_dterm_filter_multiplier",
];

/**
 * The same CHIRP samples decoded by the Blackbox Viewer parser (bit-exact with
 * GyroCore's reference decode), selected exactly as chirp_bbl_parser selects them:
 * BOXCHIRP set in the last S-frame and debug[1] in -1..2.
 */
function viewerSamples(bytes: Uint8Array, logIndex: number) {
    const log = decodeWithViewer(bytes, { only: logIndex, flightLog: false }).logs[0];
    const names = [...log.mainFieldNames, ...log.slowFieldNames];
    const col = (name: string) => names.indexOf(name);
    const flags = col("flightModeFlags");
    const axis = col("debug[1]");
    const rows = log.rows.filter((r) => (r[flags] & 64) !== 0 && r[axis] >= -1 && r[axis] <= 2);
    const pick = (name: string) => Float32Array.from(rows, (r) => r[col(name)]);
    return {
        iterations: rows.map((r) => r[0]),
        setpoint: [0, 1, 2].map((a) => pick(`setpoint[${a}]`)),
        gyro: [0, 1, 2].map((a) => pick(`gyroADC[${a}]`)),
        debug: [0, 1, 2, 3].map((d) => pick(`debug[${d}]`)),
    };
}

function sampleDiff(a: Float32Array, b: Float32Array, iterations: number[]) {
    let mismatches = 0;
    let maxAbs = 0;
    let firstIteration: number | null = null;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        const d = Math.abs(a[i] - b[i]);
        if (d !== 0) {
            mismatches++;
            maxAbs = Math.max(maxAbs, d);
            firstIteration ??= iterations[i];
        }
    }
    return { length: [a.length, b.length], mismatches, maxAbs, firstIteration };
}

/** Betaflight's analysis of every segment, but on the Viewer-decoded samples. */
function analyzeOnViewerSamples(log: LogAnalysis, samples: ReturnType<typeof viewerSamples>) {
    const chirpData = { ...log.chirpData!, setpoint: samples.setpoint, gyro: samples.gyro, debug: samples.debug };
    return log.chirpData!.segments.map((seg, i) =>
        analyzeSegment(seg, i, chirpData, log.sampleRate!, log.segmentSize!, log.sysConfig!),
    );
}

describe.skipIf(!air65)("AIR65 Betaflight Autotune qualification (local only)", () => {
    const bytes = air65?.bbl ?? new Uint8Array();

    it("uses the exact GyroCore AIR65 fixture", () => {
        expect(sha256(bytes)).toBe(AIR65_SHA256);
    });

    it("records what Betaflight Autotune shows the user and compares it with GyroCore", async () => {
        // 1. Every log and segment through the same upstream functions.
        const logs = analyzeAllLogs(bytes);
        const appLog = logs.find((l) => Object.keys(l.appSelected).length > 0);

        // Since WU2 the app no longer runs this path (its input is the Viewer decode and
        // GyroCore gates it, air65_qualification.local.test.ts); the mirror records
        // upstream Autotune as shipped, including the log upstream would show.
        expect(appLog).toBeDefined();

        // 2. GyroCore reference outputs, if provided.
        const refDir = air65?.refDir;
        const gcRec: GcRecommendation[] | null =
            refDir && existsSync(join(refDir, "gc_recommend.json"))
                ? readJsonFile<GcRecommendation[]>(join(refDir, "gc_recommend.json"))
                : null;

        const perLog = logs.map((log) => {
            const goldenPath = refDir ? join(refDir, `golden_log${log.logIndex}.json.gz`) : null;
            const gold = goldenPath && existsSync(goldenPath) ? readJsonFile<GoldenLog>(goldenPath) : null;
            if (gold) {
                expect(gold.bbl_sha256).toBe(AIR65_SHA256);
                expect(gold.log_index).toBe(log.logIndex);
            }
            const gc = gold?.result;
            const rec = gcRec?.find((r) => r.log_index === log.logIndex);
            const samples = viewerSamples(bytes, log.logIndex);
            const decodeParity = Object.fromEntries(
                (["setpoint", "gyro", "debug"] as const).flatMap((field) =>
                    samples[field].map((arr, i) => [
                        `${field}[${i}]`,
                        sampleDiff(log.chirpData![field][i], arr, samples.iterations),
                    ]),
                ),
            );
            const onViewer = analyzeOnViewerSamples(log, samples);
            return {
                logIndex: log.logIndex,
                error: log.error,
                sampleRate: log.sampleRate,
                segmentSize: log.segmentSize,
                sampleCount: log.chirpData?.sampleCount,
                totalFrames: log.chirpData?.totalFrames,
                corruptFrames: log.chirpData?.corruptFrames,
                chirpHeaders: log.sysConfig && {
                    start_hz: log.sysConfig.chirp_frequency_start_deci_hz / 10,
                    end_hz: log.sysConfig.chirp_frequency_end_deci_hz / 10,
                    seconds: log.sysConfig.chirp_time_seconds,
                },
                frameIntervalI: (log.sysConfig as unknown as Record<string, number>)?.frameIntervalI,
                decodeParity,
                gyrocore: gc && {
                    status: gc.status,
                    errors: gc.errors,
                    warnings: gc.warnings,
                    sampleCount: gc.extraction?.sample_count,
                    totalFrames: gc.extraction?.total_frames,
                },
                segments: log.segments.map((seg, segIndex) => {
                    const gcAxis = gc?.axes?.[seg.axisName];
                    const viewerSeg = onViewer[segIndex];
                    const viewerProposed = viewerSeg.recommendation?.proposed ?? null;
                    const gcRecAxis = rec?.axes?.[String(seg.axis)];
                    const bfProposed = seg.recommendation?.proposed ?? null;
                    const gcProposed = gcRecAxis?.ungated_recommendation_for_parity_only?.proposed ?? null;
                    return {
                        axis: seg.axisName,
                        startIdx: seg.startIdx,
                        endIdx: seg.endIdx,
                        samples: seg.length,
                        seconds: log.sampleRate ? seg.length / log.sampleRate : null,
                        shownByApp: log === appLog && appLog.appSelected[seg.axisName] === seg.index,
                        judgment: judgment(seg, gcAxis),
                        betaflightAnalysis: seg.recommendation && {
                            ...seg.recommendation.analysis,
                            overshootPct: seg.stepResponse?.overshootPct,
                            riseTimeMs: seg.stepResponse?.riseTimeMs,
                            settlingTimeMs: seg.stepResponse?.settlingTimeMs,
                            sensitivityPeakDb: seg.sensitivity?.peakDb,
                        },
                        // (c) shipped Betaflight (its own decoder) vs GyroCore.
                        numerics:
                            gcAxis && seg.transferFunction
                                ? compareSegment(seg, gcAxis, log.sampleRate!, log.segmentSize!)
                                : null,
                        // (b) Betaflight's spectral code on correctly decoded samples vs GyroCore.
                        numericsOnViewerSamples:
                            gcAxis && viewerSeg.transferFunction
                                ? compareSegment(viewerSeg, gcAxis, log.sampleRate!, log.segmentSize!)
                                : null,
                        judgmentOnViewerSamples: judgment(viewerSeg, gcAxis).betaflight,
                        gyrocoreRecommendation: gcRecAxis && {
                            status: gcRecAxis.status,
                            blocked: gcRecAxis.blocked,
                            proposedGated: gcRecAxis.proposed_gated,
                        },
                        recommendationParityOnViewerSamples:
                            viewerProposed && gcProposed
                                ? {
                                      betaflight: SLIDER_KEYS.map((k) => (viewerProposed as Record<string, number>)[k]),
                                      gyrocoreUngated: SLIDER_KEYS.map((k) => gcProposed[k]),
                                      same: SLIDER_KEYS.every(
                                          (k) => (viewerProposed as Record<string, number>)[k] === gcProposed[k],
                                      ),
                                  }
                                : null,
                        recommendationParity:
                            bfProposed && gcProposed
                                ? {
                                      betaflight: SLIDER_KEYS.map((k) => (bfProposed as Record<string, number>)[k]),
                                      gyrocoreUngated: SLIDER_KEYS.map((k) => gcProposed[k]),
                                      same: SLIDER_KEYS.every(
                                          (k) => (bfProposed as Record<string, number>)[k] === gcProposed[k],
                                      ),
                                  }
                                : null,
                    };
                }),
            };
        });

        writeReport("air65_autotune", { appLogIndex: appLog?.logIndex ?? null, logs: perLog });

        let shippedDiverges = false;
        for (const log of perLog) {
            // Extraction: exactly the samples and segments GyroCore extracts.
            if (log.gyrocore) {
                expect(log.sampleCount).toBe(log.gyrocore.sampleCount);
                expect(log.totalFrames).toBe(log.gyrocore.totalFrames);
            }
            // (a) Autotune's decoder vs the Viewer decoder: setpoint exact; gyro wrong from the
            // first P-frame after an I-frame (chirp_parser_history.test.ts).
            for (const axis of [0, 1, 2]) {
                expect(log.decodeParity[`setpoint[${axis}]`].mismatches).toBe(0);
                const gyro = log.decodeParity[`gyro[${axis}]`];
                expect(gyro.mismatches).toBeGreaterThan(0);
                expect(gyro.firstIteration! % log.frameIntervalI!).toBe(1);
            }
            for (const seg of log.segments) {
                // (b) Same algorithm on the same samples: float64 noise and identical sliders.
                const n = seg.numericsOnViewerSamples!;
                expect(n.segment.same).toBe(true);
                expect(n.sampleRate.betaflight).toBe(n.sampleRate.gyrocore);
                expect(n.hRelative!.maxAbs).toBeLessThan(1e-9);
                expect(n.magnitudeDb!.maxAbs).toBeLessThan(1e-8);
                expect(n.phaseDeg!.maxAbs).toBeLessThan(1e-6);
                expect(n.coherence!.maxAbs).toBeLessThan(1e-10);
                expect(n.sensitivityPeakDb.diff).toBeLessThan(1e-8);
                expect(n.step!.maxMetricDiff).toBeLessThan(1e-6);
                if (seg.recommendationParityOnViewerSamples) {
                    expect(seg.recommendationParityOnViewerSamples.same).toBe(true);
                }
                // (c) The shipped pipeline differs only through the decoder bug.
                if ((seg.numerics?.magnitudeDb?.maxAbs ?? 0) > 1) {
                    shippedDiverges = true;
                }
                // Judgment: Betaflight would recommend from every segment; GyroCore blocks every one.
                expect(seg.judgment.betaflight?.producesRecommendation).toBe(true);
                expect(seg.judgmentOnViewerSamples?.producesRecommendation).toBe(true);
                expect(seg.judgment.gyrocore?.usable).toBe(false);
                expect(seg.gyrocoreRecommendation?.status).toBe("blocked");
            }
        }
        expect(shippedDiverges).toBe(true);
    }, 600_000);
});
