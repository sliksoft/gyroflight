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
 * CHIRP Quality V2 (docs/gyrocore/CHIRP_QUALITY_V2.md) on SYNTHETIC logs only:
 * the committed WU7 fixtures and closed-loop sweeps from harness/chirpSim.
 * They test structure, availability and consistency with the existing gates,
 * not real flight quality.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import {
    authorizeMeasurement,
    qualifyChirpFile,
    recomputeRecommendations,
    type ChirpMeasurement,
} from "../../src/gyrocore/chirp/qualification";
import { MIN_USABLE_BINS, USABLE_COHERENCE_MIN } from "../../src/gyrocore/chirp/quality";
import {
    CHIRP_QUALITY_V2_ANALYSIS_VERSION,
    CHIRP_QUALITY_V2_SCHEMA,
    QV2_REASONS,
    type ChirpQualityV2,
} from "../../src/gyrocore/chirp/qualityV2/contract";
import { attachChirpFlightIdentity } from "../../src/gyrocore/chirp/qualityV2/identity";
import { checkIndependentFlights } from "../../src/gyrocore/flight/identity";
import {
    FULL_TUNE_HEADERS,
    concatLogs,
    encodeChirpLog,
    simulateChirp,
    simulateChirpSequence,
} from "./harness/chirpSim";
import { readFixtureBytes, readFixtureJson } from "./harness/fixtures";

vi.mock("../../src/js/localization", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/js/localization")>()),
    i18n: { getMessage: (key: string) => key },
}));

const CASES = new Map(
    readFixtureJson<{ cases: { case_id: string; bbl: string }[] }>("chirp/cases.json").cases.map(
        (c) => [c.case_id, c.bbl] as const,
    ),
);
const fixture = (id: string) => readFixtureBytes(`chirp/${CASES.get(id)!}`);
const qualify = (bytes: Uint8Array) => qualifyChirpFile(bytes, "synthetic.bbl", 60, AUTOTUNE_MATH);
const only = (bytes: Uint8Array) => {
    const r = qualify(bytes);
    expect(r.measurements).toHaveLength(1);
    return r.measurements[0];
};

/** A 20 s roll sweep, 2–200 Hz, with the firmware DEBUG_CHIRP channels logged. */
const goodSweep = encodeChirpLog(simulateChirp({ firmwareDebug: true }));

describe("a good CHIRP", () => {
    const m = only(goodSweep);
    const v2 = m.qualityV2;

    it("is versioned and identifies the CHIRP", () => {
        expect(v2.schema).toBe(CHIRP_QUALITY_V2_SCHEMA);
        expect(v2.analysisVersion).toBe(CHIRP_QUALITY_V2_ANALYSIS_VERSION);
        expect(v2.identity).toMatchObject({
            measurementId: m.id,
            logIndex: 0,
            chirpIndex: 0,
            axisOccurrence: 1,
            axis: 0,
            axisName: "roll",
            startTimeUs: m.startTimeUs,
            endTimeUs: m.endTimeUs,
            sampleCount: m.sampleCount,
        });
        expect(v2.provenance).toMatchObject({
            inputField: "setpoint[0]",
            outputField: "gyroADC[0]",
            sampleRateHz: 1000,
        });
    });

    it("measures the requested, observed and usable sweep separately", () => {
        expect(v2.sweep.requested).toMatchObject({ availability: "MEASURED", startHz: 2, endHz: 200, durationS: 20 });
        expect(v2.sweep.observed.availability).toBe("MEASURED");
        expect(v2.sweep.observed.startHz).toBeCloseTo(2, 1);
        expect(v2.sweep.observed.endHz).toBeCloseTo(200, -1);
        expect(v2.sweep.observed.runs).toBe(1);
        expect(v2.sweep.observedOfRequested.value).toBeGreaterThan(0.95);
        expect(v2.sweep.durationOfRequested.value).toBeCloseTo(1, 2);
        expect(v2.sweep.usable).toMatchObject({
            availability: "MEASURED",
            role: "ACTIVE_GATE",
            binCount: m.quality.usableBinCount,
            startHz: m.quality.usableRangeHz![0],
            endHz: m.quality.usableRangeHz![1],
        });
    });

    it("reports the firmware excitation and the measured response", () => {
        expect(v2.excitation.firmwareExcitation.availability).toBe("MEASURED");
        expect(v2.excitation.firmwareExcitation.value!.rms).toBeCloseTo(Math.SQRT1_2, 1);
        expect(v2.excitation.firmwareExcitation.value!.peakAbs).toBeCloseTo(1, 2);
        expect(v2.excitation.setpointRms).toMatchObject({ role: "ACTIVE_GATE", value: m.quality.inputRms });
        expect(v2.excitation.gyroRms.value).toBeGreaterThan(0);
        expect(v2.excitation.requestedAmplitude.availability).toBe("UNKNOWN");
    });

    it("finds no gaps and says what it cannot know", () => {
        expect(v2.sampleGaps).toMatchObject({ status: "NONE", availability: "MEASURED", gapCount: 0, gaps: [] });
        expect(v2.contamination).toMatchObject({ status: "UNKNOWN", reasons: [QV2_REASONS.contaminationUnknown] });
        expect(v2.saturation.status).toBe("UNKNOWN");
        expect(v2.saturation.reasons).toContain(QV2_REASONS.motorFieldsMissing);
    });

    it("keeps the evidence levels apart", () => {
        expect(v2.levels.chirpDetected.status).toBe("YES");
        expect(v2.levels.blackboxDataUsable.status).toBe("YES");
        expect(v2.levels.chirpQualityAvailable.status).toBe("YES");
        expect(v2.levels.chirpQualified.status).toBe(m.state === "rejected" ? "NO" : "YES");
        expect(v2.levels.tuningAuthorized.status).toBe(m.apply.allowed ? "YES" : "NO");
        // Not attached yet: unknown, never assumed valid.
        expect(v2.levels.bblValid.status).toBe("UNKNOWN");
        expect(v2.levels.flightValid.status).toBe("UNKNOWN");
    });
});

describe("frequency-dependent coherence", () => {
    const reports = ["clean_single_axis", "poor_coherence", "noisy", "chirp_near_nyquist"].map((id) => [
        id,
        only(fixture(id)),
    ]) as [string, ChirpMeasurement][];

    it.each(reports)("%s: every bin's status follows the existing criteria", (_id, m) => {
        const b = m.qualityV2.coherence.bins;
        const band = m.quality.analysisBandHz;
        expect(b.availability).toBe("MEASURED");
        const tf = m.diagnostics!.transferFunction;
        b.frequencyHz.forEach((f, i) => {
            const k = Math.round(f / b.binWidthHz!);
            expect(tf.frequencies[k]).toBe(f);
            expect(b.coherence[i]).toBe(tf.coherence[k]);
            const inBand = f >= band[0] && f <= band[1];
            const expected = !inBand
                ? "OUTSIDE_ANALYSIS_BAND"
                : !Number.isFinite(tf.magnitude[k])
                  ? "NO_INPUT_POWER"
                  : tf.coherence[k] >= USABLE_COHERENCE_MIN
                    ? "USABLE"
                    : "WEAK_COHERENCE";
            expect(b.status[i]).toBe(expected);
        });
        expect(b.status.filter((s) => s === "USABLE")).toHaveLength(m.quality.usableBinCount);
        expect(m.qualityV2.coherence.meanBandCoherence.value).toBe(m.quality.meanBandCoherence);
    });

    it.each(reports)("%s: regions summarise the real bins without gaps or overlaps", (_id, m) => {
        const b = m.qualityV2.coherence.bins;
        const regions = m.qualityV2.coherence.regions.items;
        expect(regions.reduce((n, r) => n + r.binCount, 0)).toBe(b.frequencyHz.length);
        let i = 0;
        for (const r of regions) {
            expect(r.fromHz).toBe(b.frequencyHz[i]);
            expect(r.toHz).toBe(b.frequencyHz[i + r.binCount - 1]);
            expect(new Set(b.status.slice(i, i + r.binCount))).toEqual(new Set([r.status]));
            expect(r.minCoherence).toBeLessThanOrEqual(r.meanCoherence);
            expect(r.maxCoherence).toBeGreaterThanOrEqual(r.meanCoherence);
            i += r.binCount;
        }
        for (let k = 1; k < regions.length; k++) {
            expect(regions[k].status).not.toBe(regions[k - 1].status);
        }
    });

    it("shows weak coherence where the existing gate rejects the measurement", () => {
        const m = reports.find(([id]) => id === "poor_coherence")![1];
        expect(m.state).toBe("rejected");
        expect(m.qualityV2.coherence.bins.status).toContain("WEAK_COHERENCE");
        expect(m.qualityV2.coherence.usableBinCount.value).toBeLessThan(MIN_USABLE_BINS);
        expect(m.qualityV2.levels.chirpQualified).toMatchObject({ status: "NO", role: "ACTIVE_GATE" });
    });

    it("its input and output power are Betaflight's Welch spectra (|H|² = Syy/Sxx · γ²)", () => {
        const m = only(goodSweep);
        const b = m.qualityV2.coherence.bins;
        let checked = 0;
        b.status.forEach((s, i) => {
            if (s !== "USABLE") {
                return;
            }
            const derived = b.outputRelativePowerDb[i]! - b.inputRelativePowerDb[i]! + 10 * Math.log10(b.coherence[i]);
            expect(derived).toBeCloseTo(b.magnitudeDb[i]!, 6);
            checked++;
        });
        expect(checked).toBeGreaterThan(MIN_USABLE_BINS);
    });
});

describe("excitation", () => {
    it("mirrors the existing gate on weak excitation", () => {
        const m = only(fixture("weak_excitation"));
        expect(m.quality.failedGates).toContain("insufficient_excitation");
        expect(m.qualityV2.excitation.setpointRms.value).toBe(m.quality.inputRms);
        expect(m.qualityV2.excitation.setpointRms.value).toBeLessThan(5);
    });

    it("finds no input power at all when the setpoint never moves", () => {
        const m = only(encodeChirpLog(simulateChirp({ amplitude: 0, firmwareDebug: true })));
        const v = m.qualityV2;
        const inBand = v.coherence.bins.status.filter((s) => s !== "OUTSIDE_ANALYSIS_BAND");
        expect(inBand.length).toBeGreaterThan(0);
        expect(new Set(inBand)).toEqual(new Set(["NO_INPUT_POWER"]));
        expect(v.excitation.noInputPowerBins.value).toBe(inBand.length);
        expect(v.excitation.inputRelativePowerPeakDb.availability).toBe("UNKNOWN");
        expect(v.sweep.usable.binCount).toBe(0);
        // The firmware still swept: the sweep is observed even with no excitation reaching the setpoint.
        expect(v.sweep.observed.availability).toBe("MEASURED");
    });

    it("is UNKNOWN, not zero, when the firmware channels carry nothing (the WU7 logs)", () => {
        const v = only(fixture("clean_single_axis")).qualityV2;
        expect(v.excitation.firmwareExcitation).toMatchObject({
            availability: "UNKNOWN",
            value: null,
            reasons: [QV2_REASONS.excitationChannelConstant],
        });
        expect(v.sweep.observed).toMatchObject({ availability: "UNKNOWN", startHz: null });
        expect(v.sweep.observed.reasons).toEqual([QV2_REASONS.observedChannelConstant]);
        expect(v.sweep.observedOfRequested.reasons).toEqual([QV2_REASONS.coverageNeedsObserved]);
    });
});

describe("sweep coverage", () => {
    it("measures a sweep that stopped below the requested end", () => {
        const v = only(encodeChirpLog(simulateChirp({ endHz: 50, firmwareDebug: true }))).qualityV2;
        expect(v.sweep.observed.maxHz).toBeCloseTo(50, 0);
        expect(v.sweep.observed.reasons).toContain(QV2_REASONS.observedBelowRequestedEnd);
        expect(v.sweep.observedOfRequested.value).toBeCloseTo((50 - 2) / (200 - 2), 2);
    });

    it("reports UNKNOWN when the sweep headers are missing", () => {
        const headers = FULL_TUNE_HEADERS.filter((h) => !h.startsWith("chirp_"));
        const m = only(encodeChirpLog(simulateChirp({ firmwareDebug: true }), headers));
        const v = m.qualityV2;
        expect(v.sweep.requested).toMatchObject({ availability: "UNKNOWN", startHz: null, endHz: null });
        expect(v.sweep.requested.reasons).toEqual([QV2_REASONS.requestedHeadersMissing]);
        expect(v.sweep.observedOfRequested).toMatchObject({ availability: "UNKNOWN", value: null });
        expect(v.sweep.durationOfRequested.availability).toBe("UNKNOWN");
        // The observed sweep does not need the headers.
        expect(v.sweep.observed.availability).toBe("MEASURED");
        expect(m.quality.warningGates).toContain("chirp_band_unknown_default_used");
    });

    it("refuses a frequency channel that rises above the requested end", () => {
        const headers = FULL_TUNE_HEADERS.map((h) =>
            h.startsWith("chirp_frequency_end_deci_hz") ? "chirp_frequency_end_deci_hz:1000" : h,
        );
        const v = only(encodeChirpLog(simulateChirp({ firmwareDebug: true }), headers)).qualityV2;
        expect(v.sweep.observed).toMatchObject({ availability: "UNKNOWN", maxHz: null });
        expect(v.sweep.observed.reasons).toEqual([QV2_REASONS.observedChannelOutOfRange]);
    });
});

describe("sample gaps", () => {
    it("locates every proven gap and the sweep frequency at it", () => {
        const frames = simulateChirp({ firmwareDebug: true });
        const kept = frames.filter((_, i) => !(i >= 10_000 && i < 10_005));
        const m = only(encodeChirpLog(kept));
        const g = m.qualityV2.sampleGaps;
        expect(g).toMatchObject({ status: "DETECTED", gapCount: 1, missingSamplesEstimate: 5 });
        expect(g.gaps).toEqual([
            {
                atTimeUs: frames[9_999].time,
                afterSampleIndex: 9_999,
                gapUs: frames[10_005].time - frames[9_999].time,
                missingSamples: 5,
                sweepFrequencyHz: frames[9_999].debug[2] / 10,
            },
        ]);
        expect(g.reasons).toContain(QV2_REASONS.gapsDetected);
    });

    it("agrees with the existing spacing analysis on the dropped-timestamps fixture", () => {
        const m = only(fixture("dropped_timestamps"));
        const g = m.qualityV2.sampleGaps;
        expect(g.status).toBe("DETECTED");
        expect(g.gapCount).toBe(m.spacing.gapCount);
        expect(g.gaps.length).toBe(Math.min(m.spacing.gapCount, 32));
        expect(g.gapsTruncated).toBe(m.spacing.gapCount > 32);
        if (!g.gapsTruncated) {
            expect(g.gaps.reduce((n, x) => n + x.missingSamples, 0)).toBe(m.spacing.missingSamplesEstimate);
        }
        // No measured sweep in the WU7 logs, so no frequency is claimed at the gaps.
        expect(g.gaps.every((x) => x.sweepFrequencyHz === null)).toBe(true);
    });
});

describe("saturation", () => {
    const withMotors = (headers: string[], motor: (i: number) => number) =>
        only(
            encodeChirpLog(
                simulateChirp({ firmwareDebug: true, motors: (i) => [motor(i), 1000, 1000, 1000] }),
                headers,
                32,
                4,
            ),
        ).qualityV2.saturation;

    it("finds no motor saturation when every motor stays inside the logged range", () => {
        const s = withMotors([...FULL_TUNE_HEADERS, "motorOutput:48,2047"], () => 1200);
        expect(s.status).toBe("NOT_DETECTED");
        expect(s.motorUpper.value).toEqual({ samples: 0, fraction: 0 });
        expect(s.reasons).toEqual([QV2_REASONS.saturationMotorsOnly, QV2_REASONS.gyroClippingUnknown]);
        expect(s.gyroClipping.availability).toBe("UNKNOWN");
    });

    it("counts samples with a motor at its logged maximum", () => {
        const s = withMotors([...FULL_TUNE_HEADERS, "motorOutput:48,2047"], (i) => (i % 100 === 0 ? 2047 : 1200));
        expect(s.status).toBe("DETECTED");
        expect(s.motorUpper.value).toEqual({ samples: 200, fraction: 0.01 });
        expect(s.motorLower.value!.samples).toBe(0);
        expect(s.reasons).toContain(QV2_REASONS.motorUpperDetected);
    });

    it("is UNKNOWN without the motor output range", () => {
        const s = withMotors(FULL_TUNE_HEADERS, () => 2047);
        expect(s.status).toBe("UNKNOWN");
        expect(s.reasons).toContain(QV2_REASONS.motorRangeUnknown);
    });
});

describe("several CHIRPs and several Flights", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("keeps each CHIRP of a Flight separate, with its own axis, and never as two flights", async () => {
        const bytes = fixture("three_axis_sequence");
        const report = qualify(bytes);
        await attachChirpFlightIdentity(report, bytes);
        const v = report.measurements.map((m) => m.qualityV2);
        expect(v.map((x) => [x.identity.chirpIndex, x.identity.axisName, x.provenance.inputField])).toEqual([
            [0, "roll", "setpoint[0]"],
            [1, "pitch", "setpoint[1]"],
            [2, "yaw", "setpoint[2]"],
        ]);
        const refs = v.map((x) => x.identity.flight.ref!);
        expect(new Set(refs.map((r) => r.locationId)).size).toBe(1);
        expect(checkIndependentFlights(refs[0], refs[2])).toMatchObject({
            independent: false,
            relation: "same_section",
        });
    });

    it("links each CHIRP to its own Flight in a multi-flight BBL", async () => {
        const rollLog = encodeChirpLog(simulateChirp({ firmwareDebug: true, seconds: 8 }));
        const sequence = encodeChirpLog(
            simulateChirpSequence([
                { axis: 1, seconds: 8, firmwareDebug: true },
                { axis: 0, seconds: 8, firmwareDebug: true },
            ]),
        );
        const bytes = concatLogs(rollLog, fixture("noisy"), sequence);
        const report = qualify(bytes);
        const catalog = await attachChirpFlightIdentity(report, bytes);
        expect(catalog?.flights).toHaveLength(3);
        expect(report.measurements.map((m) => [m.logIndex, m.qualityV2.identity.chirpIndex])).toEqual([
            [0, 0],
            [1, 0],
            [2, 0],
            [2, 1],
        ]);
        for (const m of report.measurements) {
            const id = m.qualityV2.identity;
            expect(id.file).toMatchObject({ availability: "MEASURED", sha256: catalog!.file.sha256 });
            expect(id.flight.ref).toEqual(catalog!.flights[m.logIndex]);
            expect(m.qualityV2.levels.bblValid.status).toBe("YES");
            expect(m.qualityV2.levels.flightValid.status).toBe("YES");
            expect(m.qualityV2.reasons).not.toContain(QV2_REASONS.identityNotAttached);
        }
        const [first, , third, fourth] = report.measurements.map((m) => m.qualityV2.identity.flight.ref!);
        expect(checkIndependentFlights(first, third).independent).toBe(true);
        expect(checkIndependentFlights(third, fourth).independent).toBe(false);
    });

    it("leaves the identity UNKNOWN, with a reason, when SHA-256 is unavailable", async () => {
        const report = qualify(goodSweep);
        vi.stubGlobal("crypto", undefined);
        expect(await attachChirpFlightIdentity(report, goodSweep)).toBeNull();
        const v = report.measurements[0].qualityV2;
        expect(v.identity.flight).toMatchObject({ availability: "UNKNOWN", ref: null });
        expect(v.levels.flightValid.status).toBe("UNKNOWN");
        expect(v.reasons).toContain(QV2_REASONS.identityHashUnavailable);
    });
});

/** Every finite number stays a number; nothing becomes null or a string in JSON. */
function assertPlainJson(value: unknown, path = "$"): void {
    if (typeof value === "number") {
        expect(Number.isFinite(value), path).toBe(true);
    } else if (Array.isArray(value)) {
        value.forEach((v, i) => assertPlainJson(v, `${path}[${i}]`));
    } else if (value && typeof value === "object") {
        expect(Object.getPrototypeOf(value), path).toBe(Object.prototype);
        for (const [k, v] of Object.entries(value)) {
            assertPlainJson(v, `${path}.${k}`);
        }
    }
}

describe("data contract", () => {
    const all = [...CASES.keys()].flatMap((id) => qualify(fixture(id)).measurements.map((m) => [id, m] as const));

    it.each(all)("%s: plain JSON that survives a round trip", (_id, m) => {
        assertPlainJson(m.qualityV2);
        expect(JSON.parse(JSON.stringify(m.qualityV2))).toEqual(m.qualityV2);
    });

    it("is deterministic", async () => {
        const bytes = concatLogs(goodSweep, fixture("three_axis_sequence"));
        const a = qualify(bytes);
        const b = qualify(bytes);
        await attachChirpFlightIdentity(a, bytes);
        await attachChirpFlightIdentity(b, bytes);
        expect(JSON.stringify(a.measurements.map((m) => m.qualityV2))).toBe(
            JSON.stringify(b.measurements.map((m) => m.qualityV2)),
        );
    });

    it("holds no file bytes", () => {
        const v = only(goodSweep).qualityV2;
        expect(JSON.stringify(v).length).toBeLessThan(goodSweep.length / 4);
    });

    it("lists every section's reasons once, in the report-level list", () => {
        for (const [, m] of all) {
            const v: ChirpQualityV2 = m.qualityV2;
            expect(new Set(v.reasons).size).toBe(v.reasons.length);
            for (const code of [...v.sweep.observed.reasons, ...v.saturation.reasons, ...v.contamination.reasons]) {
                expect(v.reasons).toContain(code);
            }
        }
    });
});

describe("missing or corrupt source data", () => {
    it("reports UNAVAILABLE coherence when Betaflight could not compute a transfer function", () => {
        const m = qualify(fixture("insufficient_samples")).measurements[0];
        expect(m.diagnostics).toBeNull();
        const v = m.qualityV2;
        expect(v.levels.chirpQualityAvailable.status).toBe("NO");
        expect(v.coherence.bins).toMatchObject({ availability: "UNAVAILABLE", frequencyHz: [] });
        expect(v.coherence.meanBandCoherence).toMatchObject({ availability: "UNAVAILABLE", value: null });
        expect(v.sweep.usable.availability).toBe("UNAVAILABLE");
    });

    it("still reports on corrupt axis frames and a log without rate headers", () => {
        for (const id of ["corrupt_axis_frames", "malformed_missing_rate_headers"]) {
            for (const m of qualify(fixture(id)).measurements) {
                expect(m.qualityV2.schema).toBe(CHIRP_QUALITY_V2_SCHEMA);
                expect(m.qualityV2.levels.chirpDetected.status).toBe("YES");
            }
        }
    });

    it("survives a log cut off mid-frame", () => {
        const cut = goodSweep.slice(0, Math.floor(goodSweep.length * 0.6));
        const report = qualify(cut);
        for (const m of report.measurements) {
            expect(JSON.parse(JSON.stringify(m.qualityV2))).toEqual(m.qualityV2);
            expect(m.qualityV2.identity.sampleCount).toBe(m.sampleCount);
        }
    });
});

describe("existing authorization is unchanged", () => {
    it("Apply authorization does not read Quality V2", () => {
        const report = qualify(concatLogs(goodSweep, fixture("poor_coherence")));
        for (const m of report.measurements) {
            const before = authorizeMeasurement(m);
            const scrambled = { ...m, qualityV2: { levels: { tuningAuthorized: { status: "YES" } } } };
            expect(authorizeMeasurement(scrambled as unknown as ChirpMeasurement)).toEqual(before);
            expect(before).toEqual(m.apply);
        }
    });

    it("TUNING AUTHORIZED follows the existing verdict after a recompute", () => {
        const report = qualify(goodSweep);
        for (const target of [45, 60, 72.5]) {
            recomputeRecommendations(report, target, AUTOTUNE_MATH);
            for (const m of report.measurements) {
                expect(m.qualityV2.levels.tuningAuthorized.status).toBe(m.apply.allowed ? "YES" : "NO");
            }
        }
    });

    it("no gate, tuning, Safety or Apply module imports Quality V2", () => {
        const root = join(import.meta.dirname, "..", "..", "src", "gyrocore");
        const dirs = ["safety", "tuning", "productLock", "composables"];
        const files = dirs.flatMap((d) => readdirSync(join(root, d)).map((f) => join(root, d, f)));
        files.push(
            ...["quality.ts", "applyGate.ts", "currentTune.ts", "recommendationGuard.ts"].map((f) =>
                join(root, "chirp", f),
            ),
        );
        for (const f of files) {
            expect(readFileSync(f, "utf8"), f).not.toMatch(/qualityV2/);
        }
    });
});
