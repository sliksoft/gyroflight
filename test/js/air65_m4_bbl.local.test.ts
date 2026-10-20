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
 * LOCAL ONLY: the two private AIR65 CHIRP flights through BBL -> FlightLog -> M4 (M4.2 segmentation).
 * Skipped unless GYROFLIGHT_AIR65_BBL18 / GYROFLIGHT_AIR65_BBL19 point at the
 * files. GYROFLIGHT_QUAL_OUT receives a JSON summary per file.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeM4BblFile, type M4BblReport } from "../../src/js/blackbox/m4_bbl_integration";
import { writeReport } from "../gyrocore/harness/fixtures";

const FILES = {
    bbl18: process.env.GYROFLIGHT_AIR65_BBL18,
    bbl19: process.env.GYROFLIGHT_AIR65_BBL19,
};

function summary(r: M4BblReport) {
    return {
        filename: r.filename,
        logCount: r.logCount,
        error: r.error,
        applyAllowed: r.applyAllowed,
        recommendationsEnabled: r.recommendationsEnabled,
        cliOutput: r.cliOutput,
        logs: r.logs.map((l) => ({
            logIndex: l.logIndex,
            error: l.error,
            firmwareRevision: l.firmwareRevision,
            debugMode: l.debugMode,
            frameCount: l.frameCount,
            durationS: l.durationS,
            chirp: l.chirp,
            missingSignals: l.signals.missing,
            missingHeaders: l.signals.missingHeaders,
            warnings: l.warnings,
            sampleRate: l.sampleRate && {
                header: l.sampleRate.headerRateHz,
                timestamp: l.sampleRate.timestampRateHz,
                analysis: l.sampleRate.analysisRateHz,
                source: l.sampleRate.analysisRateSource,
            },
            timestampSpacing: l.timestampSpacing,
            segmentation: l.segmentation && {
                status: l.segmentation.status,
                reasons: l.segmentation.reasons,
                durationsS: l.segmentation.durationsS,
                counts: {
                    flight: l.segmentation.flight.length,
                    chirp: l.segmentation.chirp.length,
                    stick: l.segmentation.stick.length,
                    spectrum: l.segmentation.spectrum.length,
                },
                segments: l.segmentation.segments.map((s) => ({
                    kind: s.kind,
                    t0: Math.round(((s.startTimeUs - l.segmentation!.segments[0].startTimeUs) / 1e6) * 100) / 100,
                    durationS: Math.round(s.durationS * 100) / 100,
                    reasons: s.reasons,
                })),
            },
            sampleRateHz: l.result?.sampleRateHz,
            meta: l.result?.meta,
            feedforward: l.result && {
                executable: l.result.feedforward.executable,
                advice: l.result.feedforward.advice,
                reason: l.result.feedforward.reason,
                chirpRejectedForStickFf: l.result.feedforward.chirpRejectedForStickFf,
                chirpSamplesExcluded: l.result.feedforward.chirpSamplesExcluded,
                stickSource: l.result.feedforward.stickSource,
                stickSegmentCount: l.result.feedforward.stickSegmentCount,
                stickDurationS: l.result.feedforward.stickDurationS,
                optimalFeedforward: l.result.feedforward.optimalFeedforward,
                axes: l.result.feedforward.axes.map((a) => ({
                    axis: a.axis,
                    meanAbsError: a.meanAbsError.value,
                    trackingScore: a.trackingScore.value,
                    latencyMs: a.latencyMs.value,
                })),
            },
            dTerm: l.result && {
                advice: l.result.dTerm.advice,
                missingDTerm: l.result.dTerm.missingDTerm,
                axes: l.result.dTerm.axes.map((a) => ({
                    axis: a.axis,
                    signalSource: a.signalSource,
                    label: a.label,
                    usableWindowCount: a.usableWindowCount,
                    reliability: a.reliability,
                })),
            },
            filters: l.result && {
                gyroLpf: l.result.filters.gyroLpf.configuredHz,
                spectrumMeasurement: l.result.filters.gyroLpf.measurement,
                gyroNotes: l.result.filters.gyroLpf.notes,
                gyroPeaks: l.result.filters.gyroLpf.spectrum.map((s) => ({
                    axis: s.axis,
                    reliability: s.reliability,
                    noiseFloorDb: s.noiseFloorDb,
                    peaks: s.peaks.map((p) => ({
                        hz: Math.round(p.frequencyHz * 10) / 10,
                        prominenceDb: p.prominenceDb === undefined ? null : Math.round(p.prominenceDb * 10) / 10,
                        amplitude: Math.round(p.amplitude * 1000) / 1000,
                    })),
                })),
                dtermLpf: l.result.filters.dtermLpf.configuredHz,
                rpm: {
                    notes: l.result.filters.rpmFilter.notes,
                    advice: l.result.filters.rpmFilter.advice,
                    erpmPresent: l.result.filters.rpmFilter.erpmPresent,
                    estimatedFundamentalHz: l.result.filters.rpmFilter.estimatedFundamentalHz,
                },
                dynNotch: l.result.filters.dynamicNotch.advice,
                informationalCandidates: l.result.filters.informationalCandidates.length,
            },
            safety: l.result?.m2m3Safety,
        })),
    };
}

for (const [key, path] of Object.entries(FILES)) {
    const present = Boolean(path && existsSync(path));
    describe.skipIf(!present)(`AIR65 ${key}: BBL -> FlightLog -> M4 (local only)`, () => {
        it("segments flight, isolates CHIRP from stick FF, Welch over flight, no apply path", () => {
            const bytes = new Uint8Array(readFileSync(path!));
            const report = analyzeM4BblFile(bytes, basename(path!));
            writeReport(`air65_m4_${key}`, summary(report));

            expect(report.error).toBeNull();
            expect(report.decoder).toBe("betaflight-blackbox-viewer");
            expect(report.logCount).toBeGreaterThan(0);
            expect(report.applyAllowed).toBe(false);
            expect(report.recommendationsEnabled).toBe(false);
            expect(report.cliOutput).toBeNull();

            const analysed = report.logs.filter((l) => l.result);
            expect(analysed.length).toBeGreaterThan(0);
            for (const log of analysed) {
                const r = log.result!;
                const seg = log.segmentation!;
                expect(log.chirp.status).toBe("chirp");
                expect(r.meta.chirpActive).toBe(true);
                // M4.2: segmented; ground time (armed idle at the start) outside every analysis range.
                expect(seg.status).toBe("segmented");
                expect(seg.durationsS.armed_low_throttle).toBeGreaterThan(1);
                const firstFlight = seg.segments.find((s) => s.kind !== "invalid" && s.kind !== "armed_low_throttle");
                for (const range of [...seg.flight, ...seg.spectrum, ...seg.stick]) {
                    expect(range.start).toBeGreaterThanOrEqual(firstFlight!.start);
                }
                // CHIRP samples never reach stick FF; AIR65 flies ANGLE, so no acro stick segment exists.
                expect(seg.chirp.length).toBeGreaterThan(0);
                expect(seg.stick).toEqual([]);
                expect(r.feedforward.stickSource).toBe("isolated_segments");
                expect(r.feedforward.chirpSamplesExcluded).toBe(true);
                expect(r.feedforward.advice).toBe("blocked");
                expect(r.feedforward.reason).toBe("no_valid_stick_segments");
                expect(r.feedforward.optimalFeedforward).toBeNull();
                // Full-flight Welch spectrum over CHIRP-free flight.
                expect(r.filters.gyroLpf.measurement.source).toBe("segments");
                expect(r.filters.gyroLpf.measurement.durationS).toBeGreaterThan(2);
                expect(["medium", "high"]).toContain(r.filters.gyroLpf.measurement.reliability);
                expect(r.m2m3Safety.applyAllowed).toBe(false);
                expect(r.m2m3Safety.recommendationsEnabled).toBe(false);
                expect(r.m2m3Safety.independentPidValidation).toBe("BLOCKED");
                expect(r.filters.dynamicNotch.advice).toBe("blocked");
                expect(r.filters.rpmFilter.scheduleUnknown).toBe(true);
                // AIR65 logs no yaw D: reported missing, not filled with zeros.
                expect(log.signals.missing).toContain("axisD[2]");
                expect(r.dTerm.axes[2].signalSource).toBe("missing");
                expect(r.meta.gyroLpf1Hz).toBe(150);
                expect(r.meta.dtermLpf1Hz).toBe(75);
            }
        }, 600_000);
    });
}
