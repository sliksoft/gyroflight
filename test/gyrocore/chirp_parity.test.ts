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
 * CHIRP qualification of Betaflight Autotune against GyroCore (WU1), on the 20
 * synthetic WU7 logs GyroCore generated (test/gyrocore/fixtures/PROVENANCE.md).
 *
 * 1. Reproduction: GyroCore recorded upstream Autotune's output for these logs
 *    at upstream a38c4a79 (upstream_reference.json). The CHIRP sources are
 *    byte-identical at our base d85e797e, so the live code must reproduce that
 *    record exactly. This also proves the harness drives upstream correctly.
 * 2. Parity: Betaflight's live analysis against GyroCore's reference CHIRP
 *    pipeline (bbl_golden.json.gz: GyroCore identify_chirp_system_from_bbl):
 *    segments, sample rate, transfer function, magnitude, phase, coherence,
 *    sensitivity and step response, plus who accepts which measurement.
 */

import { describe, expect, it } from "vitest";
import { findLogBoundaries, parseChirpLog } from "../../src/js/blackbox/chirp_bbl_parser";
import { computeSpectrogram, openLoopResponse } from "../../src/js/blackbox/spectral_analysis";
import { analyzeAllLogs, chooseSegmentSize, computeSampleRate } from "./harness/betaflightAutotune";
import type { LogAnalysis } from "./harness/betaflightAutotune";
import { compareSegment, judgment } from "./harness/chirpCompare";
import type { GyroCoreAxis } from "./harness/chirpCompare";
import { readFixtureBytes, readFixtureJson, sha256, writeReport } from "./harness/fixtures";

/** GyroCore's encoding of non-finite numbers in its upstream record. */
function encode(value: unknown): unknown {
    return JSON.parse(
        JSON.stringify(value, (_k, v) => {
            if (typeof v === "number" && !Number.isFinite(v)) {
                return String(v);
            }
            if (ArrayBuffer.isView(v)) {
                return Array.from(v as unknown as ArrayLike<number>, (x) => (Number.isFinite(x) ? x : String(x)));
            }
            return v;
        }),
    );
}

function float32Digest(arr: Float32Array) {
    return sha256(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
}

interface UpstreamCase {
    case_id: string;
    bbl_sha256: string;
    logBoundaries: { start: number; end: number }[];
    parseError?: string;
    sysConfig?: Record<string, unknown>;
    chirpData?: Record<string, unknown>;
    analysis?: {
        sampleRate: number;
        segmentSize: number;
        segments: Record<string, unknown>[];
        selectedSegmentByAxis: Record<string, number>;
        result: string | null;
    };
}

interface GoldenCase {
    bbl: string;
    bbl_sha256: string;
    result: {
        status: string;
        usable: boolean;
        errors: string[];
        detected: boolean;
        axes: Record<string, GyroCoreAxis>;
        extraction: {
            sample_count: number;
            total_frames: number;
            segments: { axis: number; start_idx: number; end_idx: number }[];
            selected_by_axis: Record<string, number>;
            errors: string[];
        } | null;
    };
}

const upstream = readFixtureJson<{ provenance: { upstream_commit: string }; cases: UpstreamCase[] }>(
    "chirp/upstream_reference.json",
);
const golden = readFixtureJson<{ cases: Record<string, GoldenCase> }>("chirp/bbl_golden.json.gz");

function caseBytes(caseId: string) {
    return readFixtureBytes(`chirp/bbl/${caseId}.bbl.gz`);
}

describe("Betaflight Autotune reproduces GyroCore's recorded upstream output", () => {
    it("record was made from the same upstream CHIRP sources", () => {
        expect(upstream.provenance.upstream_commit).toBe("a38c4a797a86a580106162653db92af7e14be787");
        expect(upstream.cases).toHaveLength(20);
    });

    for (const ref of upstream.cases) {
        it(ref.case_id, () => {
            const bytes = caseBytes(ref.case_id);
            expect(sha256(bytes)).toBe(ref.bbl_sha256);
            const logs = findLogBoundaries(bytes);
            expect(logs).toEqual(ref.logBoundaries);

            let parsed: ReturnType<typeof parseChirpLog>;
            try {
                parsed = parseChirpLog(bytes, logs[0].start, logs[0].end);
            } catch (e) {
                expect((e as Error).message).toBe(ref.parseError);
                return;
            }
            expect(ref.parseError).toBeUndefined();
            const { sysConfig, chirpData } = parsed;
            for (const [key, value] of Object.entries(ref.sysConfig ?? {})) {
                expect((sysConfig as Record<string, unknown>)[key] ?? null, key).toEqual(value);
            }
            expect({
                sampleCount: chirpData.sampleCount,
                totalFrames: chirpData.totalFrames,
                corruptFrames: chirpData.corruptFrames,
                segments: chirpData.segments,
                digests: {
                    setpoint: chirpData.setpoint.map(float32Digest),
                    gyro: chirpData.gyro.map(float32Digest),
                    debug: chirpData.debug.map(float32Digest),
                },
            }).toEqual(ref.chirpData);

            const analysis = ref.analysis!;
            const sampleRate = computeSampleRate(sysConfig);
            const segmentSize = chooseSegmentSize(sampleRate);
            expect(sampleRate).toBe(analysis.sampleRate);
            expect(segmentSize).toBe(analysis.segmentSize);

            const [log] = analyzeAllLogs(bytes);
            expect(log.appSelected).toEqual(
                Object.fromEntries(
                    Object.entries(analysis.selectedSegmentByAxis).map(([axis, i]) => [
                        ["roll", "pitch", "yaw"][Number(axis)],
                        i,
                    ]),
                ),
            );
            for (const refSeg of analysis.segments) {
                const seg = log.segments[refSeg.index as number];
                expect([seg.axis, seg.startIdx, seg.endIdx, seg.length]).toEqual([
                    refSeg.axis,
                    refSeg.startIdx,
                    refSeg.endIdx,
                    refSeg.length,
                ]);
                if (refSeg.skipped || refSeg.error) {
                    expect(seg.skipped).not.toBeNull();
                    continue;
                }
                const tf = seg.transferFunction!;
                expect(encode({ numSegments: tf.numSegments, ...pickTf(tf) })).toEqual(
                    encode({
                        numSegments: (refSeg.transferFunction as { numSegments: number }).numSegments,
                        ...pickTf(refSeg.transferFunction as never),
                    }),
                );
                expect(
                    encode({
                        magnitude: seg.sensitivity!.magnitude,
                        phase: seg.sensitivity!.phase,
                        peakDb: seg.sensitivity!.peakDb,
                    }),
                ).toEqual(refSeg.sensitivity);
                const step = seg.stepResponse!;
                expect(encode(step)).toEqual(refSeg.stepResponse);
                const ol = openLoopResponse(tf);
                expect(encode({ magnitude: ol.magnitude, phase: ol.phase, startIndex: ol.startIndex })).toEqual(
                    refSeg.openLoop,
                );
                const sg = computeSpectrogram(
                    log.chirpData!.gyro[seg.axis].subarray(seg.startIdx, seg.endIdx + 1),
                    sampleRate,
                );
                const refSg = refSeg.spectrogram as Record<string, unknown>;
                expect(
                    encode({
                        numSegments: sg.numSegments,
                        numBins: sg.numBins,
                        timeMs: sg.timeMs,
                        freqHz: sg.freqHz,
                        powerFirstRow: sg.power.subarray(0, sg.numBins),
                        powerLastRow: sg.power.subarray((sg.numSegments - 1) * sg.numBins),
                    }),
                ).toEqual({ ...refSg, powerSum: undefined });
                expect(sg.power.reduce((a, b) => a + b, 0)).toBe(refSg.powerSum);
            }
        });
    }
});

function pickTf(tf: {
    frequencies: unknown;
    hReal: unknown;
    hImag: unknown;
    magnitude: unknown;
    phase: unknown;
    coherence: unknown;
}) {
    return {
        frequencies: tf.frequencies,
        hReal: tf.hReal,
        hImag: tf.hImag,
        magnitude: tf.magnitude,
        phase: tf.phase,
        coherence: tf.coherence,
    };
}

/**
 * Tightest tolerances that hold for the same algorithm in float64 (GyroCore
 * Python/NumPy vs Betaflight TypeScript): both read float32 samples, use the
 * same symmetric Hann window, 50 % overlap and H1 = Sxy/Sxx.
 */
export const TOLERANCES = {
    frequencyHz: 1e-9,
    hRelative: 1e-9,
    magnitudeDb: 1e-8,
    phaseDeg: 1e-6,
    coherence: 1e-10,
    sensitivityPeakDb: 1e-8,
    stepResponse: 1e-9,
    stepMetric: 1e-9,
};

const BOTH_ACCEPT = { bfRecommends: true, gcUsable: true };
const BOTH_REJECT = { bfRecommends: false, gcUsable: false };
/** Betaflight recommends gains from a log GyroCore's quality gates reject. */
const ONLY_BETAFLIGHT = { bfRecommends: true, gcUsable: false };
/** GyroCore can use a log Betaflight silently drops. */
const ONLY_GYROCORE = { bfRecommends: false, gcUsable: true };

const EXPECTED_JUDGMENT: Record<string, { bfRecommends: boolean; gcUsable: boolean }> = {
    chirp_at_log_end: BOTH_ACCEPT,
    chirp_near_nyquist: BOTH_ACCEPT,
    clean_single_axis: BOTH_ACCEPT,
    corrupt_axis_frames: BOTH_ACCEPT,
    high_resolution: BOTH_ACCEPT,
    known_gain: BOTH_ACCEPT,
    known_phase_delay: BOTH_ACCEPT,
    log_rate_below_pid: BOTH_ACCEPT,
    low_noise: BOTH_ACCEPT,
    noisy: BOTH_ACCEPT,
    repeated_axis: BOTH_ACCEPT,
    three_axis_sequence: BOTH_ACCEPT,
    insufficient_samples: BOTH_REJECT,
    malformed_missing_debug_field: BOTH_REJECT,
    malformed_wrong_debug_mode: BOTH_REJECT,
    dropped_timestamps: ONLY_BETAFLIGHT,
    poor_coherence: ONLY_BETAFLIGHT,
    weak_excitation: ONLY_BETAFLIGHT,
    pnum_pdenom: ONLY_BETAFLIGHT,
    malformed_missing_rate_headers: ONLY_GYROCORE,
};

describe("Betaflight Autotune vs GyroCore reference CHIRP pipeline", () => {
    const report: Record<string, unknown>[] = [];

    for (const [caseId, gold] of Object.entries(golden.cases)) {
        it(caseId, () => {
            const bytes = caseBytes(caseId);
            expect(sha256(bytes)).toBe(gold.bbl_sha256);
            const [log]: LogAnalysis[] = analyzeAllLogs(bytes);
            const gc = gold.result;
            const entry: Record<string, unknown> = {
                caseId,
                betaflight: {
                    error: log.error,
                    sampleRate: log.sampleRate ?? null,
                    segmentSize: log.segmentSize ?? null,
                    sampleCount: log.chirpData?.sampleCount ?? null,
                    totalFrames: log.chirpData?.totalFrames ?? null,
                    corruptFrames: log.chirpData?.corruptFrames ?? null,
                    segments: log.segments.map((s) => [s.axisName, s.startIdx, s.endIdx, s.skipped]),
                    appSelected: log.appSelected,
                },
                gyrocore: {
                    status: gc.status,
                    usable: gc.usable,
                    errors: gc.errors,
                    sampleCount: gc.extraction?.sample_count ?? null,
                    totalFrames: gc.extraction?.total_frames ?? null,
                    segments: gc.extraction?.segments.map((s) => [s.axis, s.start_idx, s.end_idx]) ?? [],
                    selectedByAxis: gc.extraction?.selected_by_axis ?? {},
                },
                axes: {} as Record<string, unknown>,
            };
            const axes = entry.axes as Record<string, unknown>;
            const names = new Set([...Object.keys(log.appSelected), ...Object.keys(gc.axes ?? {})]);
            for (const name of names) {
                const bfSeg = log.appSelected[name] === undefined ? undefined : log.segments[log.appSelected[name]];
                const gcAxis = gc.axes?.[name];
                axes[name] = {
                    judgment: judgment(bfSeg, gcAxis),
                    numerics: bfSeg && gcAxis ? compareSegment(bfSeg, gcAxis, log.sampleRate!, log.segmentSize!) : null,
                };
            }
            report.push(entry);

            // Extraction: same samples, frames and segment bounds on every log both sides can read.
            expect(log.error !== null, "Betaflight rejects the log").toBe(gc.extraction === null);
            if (gc.extraction) {
                expect(log.chirpData!.sampleCount).toBe(gc.extraction.sample_count);
                expect(log.chirpData!.totalFrames).toBe(gc.extraction.total_frames);
                expect(log.segments.map((seg) => [seg.axis, seg.startIdx, seg.endIdx])).toEqual(
                    gc.extraction.segments.map((seg) => [seg.axis, seg.start_idx, seg.end_idx]),
                );
            }

            // Numerics: the same algorithm, so float64 noise only. Where the sample rates differ the
            // frequency axis scales by their ratio and every other array is unchanged.
            for (const name of Object.keys(axes)) {
                const numerics = (axes[name] as { numerics: ReturnType<typeof compareSegment> | null }).numerics;
                if (!numerics) {
                    continue;
                }
                expect(numerics.segment.same, `${name} segment bounds`).toBe(true);
                expect(numerics.segmentSize.betaflight).toBe(numerics.segmentSize.gyrocore);
                expect(numerics.welchSegments.betaflight).toBe(numerics.welchSegments.gyrocore);
                if (numerics.sampleRate.betaflight === numerics.sampleRate.gyrocore) {
                    expect(numerics.frequencies!.maxAbs).toBeLessThanOrEqual(TOLERANCES.frequencyHz);
                } else {
                    expect(caseId).toBe("pnum_pdenom");
                }
                for (const key of ["frequencies", "hRelative", "magnitudeDb", "phaseDeg", "coherence"] as const) {
                    expect(numerics[key]!.finitenessMismatch, `${name} ${key} non-finite bins`).toBe(0);
                }
                expect(numerics.hRelative!.maxAbs).toBeLessThanOrEqual(TOLERANCES.hRelative);
                expect(numerics.magnitudeDb!.maxAbs).toBeLessThanOrEqual(TOLERANCES.magnitudeDb);
                expect(numerics.phaseDeg!.maxAbs).toBeLessThanOrEqual(TOLERANCES.phaseDeg);
                expect(numerics.coherence!.maxAbs).toBeLessThanOrEqual(TOLERANCES.coherence);
                expect(numerics.sensitivityPeakDb.diff).toBeLessThanOrEqual(TOLERANCES.sensitivityPeakDb);
                expect(numerics.step!.response.maxAbs).toBeLessThanOrEqual(TOLERANCES.stepResponse);
                expect(numerics.step!.maxMetricDiff).toBeLessThanOrEqual(TOLERANCES.stepMetric);
            }

            // Judgment: who would hand the user a gain recommendation from this log.
            const bfRecommends = Object.values(axes).some(
                (a) => (a as { judgment: ReturnType<typeof judgment> }).judgment.betaflight?.producesRecommendation,
            );
            const gcUsable = Object.values(axes).some(
                (a) => (a as { judgment: ReturnType<typeof judgment> }).judgment.gyrocore?.usable,
            );
            expect({ bfRecommends, gcUsable }).toEqual(EXPECTED_JUDGMENT[caseId]);
        });
    }

    it("writes the comparison report", () => {
        writeReport("wu7_chirp_parity", report);
        expect(report).toHaveLength(20);
    });
});
