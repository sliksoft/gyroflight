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

import { describe, expect, it } from "vitest";
import { AIR65_EXTERNAL_BLOCKERS } from "../../src/js/blackbox/betaflight_open_loop";
import {
    analyzeM4FlightMetrics,
    extractOptionalBlackboxChannels,
    type FlightMetricsInput,
} from "../../src/js/blackbox/flight_metrics_analysis";

function makeSeries(n: number, fn: (i: number) => number): Float64Array {
    const a = new Float64Array(n);
    for (let i = 0; i < n; i++) a[i] = fn(i);
    return a;
}

function validStickFlight(n = 4000, fs = 1000): FlightMetricsInput {
    const dtUs = 1e6 / fs;
    const timeUs = makeSeries(n, (i) => i * dtUs);
    // Stick steps + lagging gyro (tracking) + D-like signal
    const sp = makeSeries(n, (i) => (i % 400 < 200 ? 80 : -40));
    const gyroY = makeSeries(n, (i) => {
        let y = 0;
        for (let k = 0; k <= i; k++) y = y * 0.85 + sp[k] * 0.15;
        return y;
    });
    const d = makeSeries(n, (i) => (i > 0 ? -(gyroY[i] - gyroY[i - 1]) * fs * 0.01 : 0));
    const motors = [makeSeries(n, () => 1200), makeSeries(n, () => 1180), makeSeries(n, () => 1190), makeSeries(n, () => 1210)];
    return {
        timeUs,
        gyro: [gyroY, gyroY, makeSeries(n, () => 0)],
        setpoint: [sp, sp, makeSeries(n, () => 0)],
        dTerm: [d, d, makeSeries(n, () => 0)],
        motors,
        throttle: makeSeries(n, () => 0.4),
        erpm: [makeSeries(n, () => 60000), makeSeries(n, () => 61000), makeSeries(n, () => 59500), makeSeries(n, () => 60500)],
        meta: {
            firmwareVersion: "Betaflight 2026.6.2",
            debugMode: 0,
            chirpActive: false,
            gyroLpf1Hz: 150,
            gyroLpf2Hz: 300,
            dtermLpf1Hz: 75,
            dtermLpf2Hz: 150,
            dynNotchCount: 2,
            rpmFilterHarmonics: 2,
            sampleRateHz: fs,
            betaflightMajorMinor: "2026.6",
        },
    };
}

describe("M4 flight metrics — valid flight data", () => {
    it("computes tracking, D-effectiveness, and filter spectra without enabling Apply", () => {
        const r = analyzeM4FlightMetrics(validStickFlight());
        expect(r.feedforward.chirpRejectedForStickFf).toBe(false);
        expect(r.feedforward.optimalFeedforward).toBeNull();
        expect(r.feedforward.axes.length).toBe(3);
        expect(r.feedforward.aggregate?.score).toBeGreaterThan(0);
        expect(r.dTerm.missingDTerm).toBe(false);
        expect(r.dTerm.axes.some((a) => a.usableWindowCount > 0)).toBe(true);
        expect(r.filters.rpmFilter.erpmPresent).toBe(true);
        expect(r.filters.dynamicNotch.centresKnown).toBe(false);
        expect(r.filters.dynamicNotch.advice).toBe("blocked");
        expect(r.m2m3Safety.applyAllowed).toBe(false);
        expect(r.m2m3Safety.recommendationsEnabled).toBe(false);
        expect(r.m2m3Safety.independentPidValidation).toBe("BLOCKED");
        expect(r.provenance.fpvpidlabCopied).toBe(false);
    });
});

describe("M4 missing / unreliable inputs", () => {
    it("blocks FF when stick setpoints are missing", () => {
        const base = validStickFlight(100);
        const empty = new Float64Array(0);
        const r = analyzeM4FlightMetrics({
            ...base,
            setpoint: [empty, empty, empty],
            gyro: [empty, empty, empty],
        });
        expect(r.feedforward.missingStickSignals).toBe(true);
        expect(r.feedforward.advice).toBe("blocked");
        expect(r.feedforward.optimalFeedforward).toBeNull();
    });

    it("blocks RPM advice when eRPM is missing", () => {
        const base = validStickFlight();
        delete base.erpm;
        const r = analyzeM4FlightMetrics(base);
        expect(r.filters.rpmFilter.erpmPresent).toBe(false);
        expect(r.filters.rpmFilter.advice).toBe("blocked");
        expect(r.filters.rpmFilter.scheduleUnknown).toBe(true);
    });

    it("marks missing D-term and does not advise D changes", () => {
        const base = validStickFlight();
        delete base.dTerm;
        const r = analyzeM4FlightMetrics(base);
        expect(r.dTerm.missingDTerm).toBe(true);
        expect(r.dTerm.advice).toBe("blocked");
        expect(r.dTerm.notes.join(" ")).toMatch(/axisD|missing/i);
    });

    it("reports insufficient D windows when maneuvers are too few", () => {
        const n = 100;
        const fs = 1000;
        const timeUs = makeSeries(n, (i) => i * 1000);
        const flat = makeSeries(n, () => 1);
        const r = analyzeM4FlightMetrics({
            timeUs,
            gyro: [flat, flat, flat],
            setpoint: [flat, flat, flat],
            dTerm: [flat, flat, flat],
            meta: { chirpActive: false, sampleRateHz: fs },
        });
        expect(r.dTerm.axes.every((a) => a.usableWindowCount === 0 || a.reliability === "insufficient")).toBe(
            true,
        );
    });

    it("rejects CHIRP logs for stick feedforward optimization", () => {
        const base = validStickFlight();
        base.meta = { ...base.meta, chirpActive: true, debugMode: 96 };
        const r = analyzeM4FlightMetrics(base);
        expect(r.feedforward.chirpRejectedForStickFf).toBe(true);
        expect(r.feedforward.advice).toBe("blocked");
        expect(r.feedforward.optimalFeedforward).toBeNull();
        expect(r.feedforward.reason).toMatch(/CHIRP/i);
    });

    it("keeps dyn_notch centres unknown (unreliable filter schedule)", () => {
        const r = analyzeM4FlightMetrics(validStickFlight());
        expect(r.filters.dynamicNotch.centresKnown).toBe(false);
        expect(r.filters.dynamicNotch.notes).toEqual(
            expect.arrayContaining(["dyn_notch_centres_unknown"]),
        );
        expect(r.m2m3Safety.externalBlockers).toEqual([...AIR65_EXTERNAL_BLOCKERS]);
    });

    it("records firmware version metadata without inventing recommendations", () => {
        const base = validStickFlight();
        base.meta = { ...base.meta, firmwareVersion: "Betaflight 4.5.0", betaflightMajorMinor: "4.5" };
        const r = analyzeM4FlightMetrics(base);
        expect(r.meta.firmwareVersion).toBe("Betaflight 4.5.0");
        expect(r.filters.informationalCandidates.every((c) => c.reason.includes("not_a_cli"))).toBe(true);
        expect(r.m2m3Safety.recommendationsEnabled).toBe(false);
    });
});

describe("M4 optional channel helper", () => {
    it("reports absent optional channels without throwing", () => {
        const empty = {
            getMainFieldNames: () => ["time", "gyroADC[0]"],
            getMinTime: () => 0,
            getMaxTime: () => 0,
            getChunksInTimeRange: () => [],
        };
        const ch = extractOptionalBlackboxChannels(empty);
        expect(ch.present.axisD).toBe(false);
        expect(ch.present.erpm).toBe(false);
        expect(ch.dTerm).toBeNull();
        expect(ch.erpm).toBeNull();
    });
});

describe("M4 safety lock intact", () => {
    it("never enables Apply or independent PID validation", () => {
        const r = analyzeM4FlightMetrics(validStickFlight());
        expect(r.m2m3Safety.applyAllowed).toBe(false);
        expect(r.m2m3Safety.recommendationsEnabled).toBe(false);
        expect(r.m2m3Safety.independentPidValidation).toBe("BLOCKED");
        expect(r.m2m3Safety.externalBlockers).toContain("dyn_notch_centres_unknown");
        expect(r.m2m3Safety.externalBlockers).toContain("rpm_filter_schedule_unknown");
    });

    it("does not recommend without sufficient evidence", () => {
        const r = analyzeM4FlightMetrics(validStickFlight(50));
        expect(r.feedforward.optimalFeedforward).toBeNull();
        expect(r.dTerm.advice === "blocked" || r.dTerm.advice === "not_advised" || r.dTerm.advice === "measurement_only").toBe(
            true,
        );
        // measurement_only still must not flip Apply
        expect(r.m2m3Safety.applyAllowed).toBe(false);
    });
});
