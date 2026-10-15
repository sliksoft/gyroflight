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
 * WU6-S1 synthetic regression cases A–D (AIR65-shaped). SYNTHETIC ONLY —
 * Cloud does not have the original AIR65 BBL. These prove diagnostic coverage
 * and support classification without changing existing qualification gates.
 */

import { describe, expect, it, vi } from "vitest";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { MIN_MEAN_BAND_COHERENCE, MIN_USABLE_BINS, USABLE_COHERENCE_MIN } from "../../src/gyrocore/chirp/quality";
import {
    CHIRP_QUALITY_V2_ANALYSIS_VERSION,
    QV2_REASONS,
    type SupportClass,
} from "../../src/gyrocore/chirp/qualityV2/contract";
import { classifyBinSupport } from "../../src/gyrocore/chirp/qualityV2/coverage";
import { qualityRows } from "../../src/gyrocore/chirp/qualityV2/view";
import { FULL_TUNE_HEADERS, encodeChirpLog, simulateChirp, withHeader } from "./harness/chirpSim";

vi.mock("../../src/js/localization", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/js/localization")>()),
    i18n: { getMessage: (key: string, args: string[] = []) => `${key}:${args.join(",")}` },
}));

const AIR65_HEADERS = withHeader(
    withHeader(withHeader(FULL_TUNE_HEADERS, "chirp_frequency_start_deci_hz:2"), "chirp_frequency_end_deci_hz:6000"),
    "chirp_time_seconds:20",
);

const qualify = (bytes: Uint8Array) => qualifyChirpFile(bytes, "wu6-s1-synthetic.bbl", 60, AUTOTUNE_MATH);
const only = (bytes: Uint8Array) => {
    const r = qualify(bytes);
    expect(r.measurements).toHaveLength(1);
    return r.measurements[0];
};

/** Existing gate constants must not drift in this work unit. */
describe("WU6-S1 existing gates unchanged", () => {
    it("keeps the documented coherence and usable-bin thresholds", () => {
        expect(MIN_MEAN_BAND_COHERENCE).toBe(0.6);
        expect(USABLE_COHERENCE_MIN).toBe(0.5);
        expect(MIN_USABLE_BINS).toBe(8);
        expect(CHIRP_QUALITY_V2_ANALYSIS_VERSION).toBe("2.2.0");
    });

    it("never treats frequency <= observedEnd alone as spectral support", () => {
        const observed = {
            availability: "MEASURED" as const,
            startHz: 0.2,
            endHz: 60,
            minHz: 0.2,
            maxHz: 60,
            runs: 1,
            reasons: [],
        };
        // Residual spectrum at 90 Hz with high coherence is still outside the observed sweep.
        expect(classifyBinSupport(90, "USABLE", 0.95, -10, observed)).toBe("OUTSIDE_OBSERVED_SWEEP");
        expect(classifyBinSupport(40, "USABLE", 0.95, -10, observed)).toBe("COHERENT");
        expect(classifyBinSupport(40, "WEAK_COHERENCE", 0.4, -10, observed)).toBe("WEAK_COHERENCE");
        expect(classifyBinSupport(40, "NO_INPUT_POWER", 0, null, observed)).toBe("INSUFFICIENT_SPECTRAL_SUPPORT");
        expect(
            classifyBinSupport(40, "USABLE", 0.95, -10, {
                ...observed,
                availability: "UNKNOWN",
                minHz: null,
                maxHz: null,
            }),
        ).toBe("UNKNOWN");
    });
});

/**
 * Incomplete yaw: stop early so most of 5–100 Hz is unswept and the existing
 * mean-band gate fails, while supported bins below the observed end stay coherent.
 * (Real AIR65 yaw ended ~60 Hz with mean 0.534; clean sim needs a lower end to
 * pull the 5–100 Hz mean under 0.60.)
 */
describe("CASE A — incomplete yaw sweep (synthetic AIR65-shaped)", () => {
    const bytes = encodeChirpLog(
        simulateChirp({
            firmwareDebug: true,
            axis: 2,
            startHz: 0.2,
            endHz: 38,
            seconds: 20,
            crossoverHz: 25,
        }),
        AIR65_HEADERS,
    );
    const m = only(bytes);
    const v2 = m.qualityV2;
    const mc = v2.measurementCoverage;
    const fq = v2.frequencyQuality;

    it("reports requested 0.2–600 Hz and an early observed end", () => {
        expect(mc.requestedRangeHz).toEqual([0.2, 600]);
        expect(mc.metadataReliable).toBe(true);
        expect(mc.observedRangeHz?.[1]).toBeGreaterThan(30);
        expect(mc.observedRangeHz?.[1]).toBeLessThan(45);
        expect(v2.sweep.observed.reasons).toContain(QV2_REASONS.observedBelowRequestedEnd);
    });

    it("keeps the 5–100 Hz qualification FAIL while supporting lower frequencies diagnostically", () => {
        expect(m.state).toBe("rejected");
        expect(v2.levels.chirpQualified.status).toBe("NO");
        expect(v2.verdicts.coherence.verdict).toBe("FAIL");
        expect(fq.coherentSupportedBinCount.value ?? 0).toBeGreaterThan(0);
        expect(fq.meanSupportedCoherence.availability).toBe("MEASURED");
        expect(fq.meanSupportedCoherence.value ?? 0).toBeGreaterThan(0.6);
        // In-band bins beyond the observed end are outside the sweep, never COHERENT.
        for (let i = 0; i < fq.supportClass.length; i++) {
            const f = v2.coherence.bins.frequencyHz[i];
            if (f > (mc.observedRangeHz?.[1] ?? 0) && v2.coherence.bins.status[i] !== "OUTSIDE_ANALYSIS_BAND") {
                expect(fq.supportClass[i]).toBe("OUTSIDE_OBSERVED_SWEEP");
            }
        }
    });

    it("exposes usable lower-frequency regions in the diagnostic UI rows", () => {
        const rows = qualityRows(v2, (k, a = []) => `${k}:${a.join(",")}`);
        const coverage = rows.find((r) => r.id === "coverage");
        expect(coverage?.detail).toMatch(/spectral/i);
        expect(mc.missingAnalysisBand.some((b) => b.toHz === 100 || b.fromHz > 30)).toBe(true);
    });
});

describe("CASE B — incomplete roll sweep with magnitude peak observation (synthetic)", () => {
    const bytes = encodeChirpLog(
        simulateChirp({
            firmwareDebug: true,
            axis: 0,
            startHz: 0.2,
            endHz: 83.5,
            seconds: 20,
            crossoverHz: 29,
        }),
        AIR65_HEADERS,
    );
    const m = only(bytes);
    const v2 = m.qualityV2;
    const fq = v2.frequencyQuality;

    it("observes ~83 Hz and reports a supported-band magnitude peak without resonance claims", () => {
        expect(v2.measurementCoverage.observedRangeHz?.[1]).toBeGreaterThan(70);
        expect(v2.measurementCoverage.observedRangeHz?.[1]).toBeLessThan(95);
        expect(fq.peakSupportedMagnitude.availability).toBe("MEASURED");
        const peakHz = fq.peakSupportedMagnitude.value!.frequencyHz;
        const end = v2.measurementCoverage.observedRangeHz![1];
        expect(peakHz).toBeGreaterThan(0);
        expect(peakHz).toBeLessThanOrEqual(end + 1e-6);
        // Peak is observational only — never a gate or instability label.
        expect(v2.verdicts.coherence.basis).toBe("EXISTING_GATE");
        expect(m.qualityV2.reasons).toContain(QV2_REASONS.coverageDiagnosticOnly);
        expect(m.state).not.toBe("usable"); // incomplete vs 600 Hz request; may still warn-pass on residual spectrum
    });

    it("does not invent spectral support above the observed end", () => {
        const end = v2.measurementCoverage.observedRangeHz![1];
        const above = fq.supportClass.filter(
            (c, i) => v2.coherence.bins.frequencyHz[i] > end && c !== "OUTSIDE_ANALYSIS_BAND",
        );
        expect(above.every((c) => c === "OUTSIDE_OBSERVED_SWEEP")).toBe(true);
    });
});

describe("CASE C — long pitch sweep with poor coherence and saturation (synthetic)", () => {
    const bytes = encodeChirpLog(
        simulateChirp({
            firmwareDebug: true,
            axis: 1,
            startHz: 0.2,
            endHz: 420,
            seconds: 20,
            uncorrelatedGyro: true,
            motors: () => [2047, 2047, 2047, 2047],
        }),
        [...AIR65_HEADERS, "motorOutput:1000,2047"],
        32,
        4,
    );
    const m = only(bytes);
    const v2 = m.qualityV2;
    const fq = v2.frequencyQuality;

    it("reaches far in frequency but must not look reliable from sweep length alone", () => {
        expect(v2.measurementCoverage.observedRangeHz?.[1]).toBeGreaterThan(400);
        expect(m.state).toBe("rejected");
        expect(v2.levels.chirpQualified.status).toBe("NO");
        expect(v2.coherence.usableBinCount.value ?? 0).toBeLessThan(MIN_USABLE_BINS);
        expect(fq.coherentSupportedBinCount.value ?? 0).toBeLessThan(MIN_USABLE_BINS);
        expect(v2.saturation.status).toBe("DETECTED");
        // Reaching 400 Hz must not flip weak data into PASS-looking COHERENT mass.
        const coherentShare =
            (fq.supportClass.filter((c) => c === "COHERENT").length || 0) / Math.max(fq.supportClass.length, 1);
        expect(coherentShare).toBeLessThan(0.25);
    });
});

describe("CASE D — adversarial / unknown never becomes PASS (synthetic)", () => {
    it("missing DEBUG_CHIRP frequency yields UNKNOWN support, not COHERENT", () => {
        const bytes = encodeChirpLog(simulateChirp({ firmwareDebug: false, endHz: 200 }), AIR65_HEADERS);
        const m = only(bytes);
        const fq = m.qualityV2.frequencyQuality;
        expect(m.qualityV2.measurementCoverage.metadataReliable).toBe(false);
        expect(fq.supportClass.every((c: SupportClass) => c === "UNKNOWN" || c === "OUTSIDE_ANALYSIS_BAND")).toBe(true);
        expect(fq.meanSupportedCoherence.availability).not.toBe("MEASURED");
        // Unknown observed metadata must not invent COHERENT support (qualification may still use Welch alone).
        expect(fq.supportClass.filter((c) => c === "COHERENT")).toHaveLength(0);
        expect(m.qualityV2.reasons).toContain(QV2_REASONS.supportNeedsObserved);
    });

    it("constant / invalid frequency channel stays UNKNOWN", () => {
        const frames = simulateChirp({ firmwareDebug: true, seconds: 5, endHz: 50 });
        for (const f of frames) {
            f.debug[2] = 100; // constant 10 Hz
        }
        const m = only(encodeChirpLog(frames, AIR65_HEADERS));
        expect(m.qualityV2.sweep.observed.availability).toBe("UNKNOWN");
        expect(m.qualityV2.measurementCoverage.metadataReliable).toBe(false);
        expect(m.qualityV2.frequencyQuality.supportClass.filter((c) => c === "COHERENT")).toHaveLength(0);
    });

    it("negative frequency values yield UNKNOWN observed sweep", () => {
        const frames = simulateChirp({ firmwareDebug: true, seconds: 5, endHz: 50 });
        frames[10].debug[2] = -5;
        const m = only(encodeChirpLog(frames, AIR65_HEADERS));
        expect(m.qualityV2.sweep.observed.availability).toBe("UNKNOWN");
        expect(m.qualityV2.frequencyQuality.meanSupportedCoherence.availability).toBe("UNKNOWN");
    });

    it("classifyBinSupport never returns COHERENT without measured observed bounds", () => {
        const classes = (
            [
                ["UNKNOWN", null, null],
                ["UNAVAILABLE", null, null],
            ] as const
        ).map(([availability, minHz, maxHz]) =>
            classifyBinSupport(20, "USABLE", 0.99, 0, {
                availability,
                startHz: null,
                endHz: null,
                minHz,
                maxHz,
                runs: null,
                reasons: [],
            }),
        );
        expect(classes).toEqual(["UNKNOWN", "UNKNOWN"]);
    });
});
