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
 * Regressions for the WU2 review: a MEASURED value is never a PASS by itself,
 * the authorization level states its measurement-only scope, and per-bin power
 * is Betaflight's Welch Sxx / Syy per segment (relative, not a PSD). SYNTHETIC.
 */

import { createApp, h } from "vue";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/js/localization", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/js/localization")>()),
    i18n: { getMessage: (key: string, args?: string[]) => (args?.length ? `${key}|${args.join("|")}` : key) },
}));

globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
};

import UApp from "@nuxt/ui/components/App.vue";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import {
    postAnalysisReport,
    MIN_EXCITATION_RMS,
    MIN_MEAN_BAND_COHERENCE,
    MIN_USABLE_BINS,
} from "../../src/gyrocore/chirp/quality";
import {
    qualifyChirpFile,
    recomputeRecommendations,
    authorizeMeasurement,
    type ChirpMeasurement,
} from "../../src/gyrocore/chirp/qualification";
import {
    buildChirpQualityV2,
    SPECTROGRAM_POWER_FLOOR,
    type QualityV2Input,
} from "../../src/gyrocore/chirp/qualityV2/analyze";
import { QV2_REASONS, type ChirpQualityV2, type QualityTopic } from "../../src/gyrocore/chirp/qualityV2/contract";
import { refreshAuthorizationLevel } from "../../src/gyrocore/chirp/qualityV2/identity";
import { levelTone, qualityRows } from "../../src/gyrocore/chirp/qualityV2/view";
import { analyzeTimestampSpacing, type SampleRateEvidence } from "../../src/gyrocore/chirp/sampleRate";
import ChirpQualityV2Card from "../../src/gyrocore/components/ChirpQualityV2Card.vue";
import {
    assertProductApplyReleased,
    PRODUCT_APPLY_PENDING,
    productApplyBlocks,
} from "../../src/gyrocore/productLock/productApply";
import en from "../../src/gyroflight/locales/en.json";
import { hanningWindow, recommendGains, welchTransferFunction } from "../../src/js/blackbox/spectral_analysis";
import { encodeChirpLog, FULL_TUNE_HEADERS, simulateChirp } from "./harness/chirpSim";
import { readFixtureBytes, readFixtureJson } from "./harness/fixtures";

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
const t = (key: string, args: (string | number)[] = []) => (args.length ? `${key}|${args.join("|")}` : key);
const rowsOf = (v: ChirpQualityV2) => Object.fromEntries(qualityRows(v, t).map((r) => [r.id, r]));

const good = only(encodeChirpLog(simulateChirp({ firmwareDebug: true })));
const weak = only(fixture("weak_excitation"));
const poor = only(fixture("poor_coherence"));
const short = only(fixture("insufficient_samples"));
const truncated = only(encodeChirpLog(simulateChirp({ firmwareDebug: true, endHz: 50 })));

// ---------------------------------------------------------------------------
// Review 1: availability is not a verdict
// ---------------------------------------------------------------------------

describe("MEASURED is not PASS", () => {
    it("a MEASURED value under an existing PASS gate may be green", () => {
        const r = rowsOf(good.qualityV2);
        expect(good.quality.usable).toBe(true);
        for (const id of ["excitation", "coherence", "usable-bins"]) {
            expect(r[id]).toMatchObject({ verdict: "PASS", verdictBasis: "EXISTING_GATE", tone: "good" });
        }
        expect(r.excitation.criterion).toBe(`gyrocoreQv2CriterionMin|${MIN_EXCITATION_RMS}`);
    });

    it("low excitation: MEASURED, existing gate FAIL, red, with the real minimum", () => {
        const r = rowsOf(weak.qualityV2);
        expect(weak.quality.failedGates).toContain("insufficient_excitation");
        expect(r.excitation).toMatchObject({ status: "MEASURED", verdict: "FAIL", tone: "bad" });
        expect(r.excitation.criterion).toBe(`gyrocoreQv2CriterionMin|${MIN_EXCITATION_RMS}`);
        const vd = weak.qualityV2.verdicts.excitation;
        expect(vd).toMatchObject({
            codes: ["insufficient_excitation"],
            threshold: MIN_EXCITATION_RMS,
            comparator: "MIN",
        });
        expect(vd.value).toBe(weak.quality.inputRms);
        expect(vd.value!).toBeLessThan(MIN_EXCITATION_RMS);
    });

    it("low coherence and too few usable bins: MEASURED, FAIL, red, on a rejected CHIRP", () => {
        const v = poor.qualityV2;
        const r = rowsOf(v);
        expect(poor.state).toBe("rejected");
        expect(v.levels.chirpQualified.status).toBe("NO");
        expect(r.coherence).toMatchObject({ status: "MEASURED", verdict: "FAIL", tone: "bad" });
        expect(r.coherence.criterion).toBe(`gyrocoreQv2CriterionMin|${MIN_MEAN_BAND_COHERENCE}`);
        expect(v.coherence.meanBandCoherence.value!).toBeLessThan(MIN_MEAN_BAND_COHERENCE);
        expect(r["usable-bins"]).toMatchObject({ verdict: "FAIL", tone: "bad" });
        expect(Number(r["usable-bins"].status)).toBeLessThan(MIN_USABLE_BINS);
        // Values are still available on a rejected CHIRP, and none of its failing topics is green.
        expect(v.coherence.bins.availability).toBe("MEASURED");
        expect(
            Object.values(r)
                .filter((x) => x.tone === "good")
                .map((x) => x.id),
        ).not.toContain("coherence");
    });

    it("limited sweep coverage is MEASURED but diagnostic only (no calibrated threshold)", () => {
        const r = rowsOf(truncated.qualityV2);
        expect(truncated.qualityV2.sweep.observedOfRequested.availability).toBe("MEASURED");
        expect(truncated.qualityV2.sweep.observedOfRequested.value!).toBeLessThan(0.5);
        for (const id of ["coverage", "sweep", "detection"]) {
            expect(r[id]).toMatchObject({
                verdict: "NOT_EVALUATED",
                verdictBasis: "NONE",
                tone: "neutral",
                criterion: "",
            });
        }
    });

    it("UNAVAILABLE and UNKNOWN stay neutral and unjudged when no gate ran", () => {
        const v = short.qualityV2;
        const r = rowsOf(v);
        expect(v.coherence.meanBandCoherence.availability).toBe("UNAVAILABLE");
        expect(r.coherence).toMatchObject({ status: "UNAVAILABLE", verdict: "NOT_EVALUATED", tone: "neutral" });
        expect(r["usable-bins"]).toMatchObject({ verdict: "NOT_EVALUATED", tone: "neutral" });
        expect(r.contamination).toMatchObject({ status: "UNKNOWN", verdict: "NOT_EVALUATED", tone: "neutral" });
    });

    it("every verdict mirrors the existing gates exactly", () => {
        const topicGates: Record<QualityTopic, string[]> = {
            detection: [],
            sweep: ["chirp_band_unknown_default_used", "chirp_band_near_nyquist"],
            coverage: [],
            excitation: ["insufficient_excitation"],
            coherence: ["low_coherence"],
            usableBins: ["unusable_frequency_range"],
            sampleGaps: ["excessive_gaps", "timestamp_gaps_present"],
            contamination: [],
            saturation: [],
        };
        for (const id of [...CASES.keys()]) {
            for (const m of qualify(fixture(id)).measurements) {
                for (const [topic, codes] of Object.entries(topicGates) as [QualityTopic, string[]][]) {
                    const ran = m.quality.gates.filter((g) => codes.includes(g.code));
                    const expected = !ran.length
                        ? "NOT_EVALUATED"
                        : ran.some((g) => !g.passed && g.severity === "blocking")
                          ? "FAIL"
                          : ran.some((g) => !g.passed)
                            ? "WARNING"
                            : "PASS";
                    const got = m.qualityV2.verdicts[topic];
                    if (topic === "saturation" && got.basis === "DOCUMENTED_DIAGNOSTIC") {
                        continue;
                    }
                    expect(got.verdict, `${id} ${m.id} ${topic}`).toBe(expected);
                }
            }
        }
    });

    it("MEASURED alone never makes a row or level green", () => {
        for (const m of [good, weak, poor, truncated]) {
            const v: ChirpQualityV2 = structuredClone(m.qualityV2);
            for (const k of Object.keys(v.verdicts) as QualityTopic[]) {
                v.verdicts[k] = {
                    verdict: "NOT_EVALUATED",
                    basis: "NONE",
                    codes: [],
                    value: null,
                    threshold: null,
                    comparator: null,
                };
            }
            for (const row of qualityRows(v, t)) {
                expect(row.tone, row.id).toBe("neutral");
            }
            for (const row of qualityRows(m.qualityV2, t)) {
                expect(row.tone === "good").toBe(row.verdict === "PASS" && row.verdictBasis === "EXISTING_GATE");
            }
        }
        // Diagnostic levels are never coloured, even when YES.
        for (const l of Object.values(good.qualityV2.levels)) {
            expect(levelTone(l)).toBe(
                l.role === "ACTIVE_GATE" && l.status === "YES"
                    ? "good"
                    : l.role === "ACTIVE_GATE" && l.status === "NO"
                      ? "bad"
                      : "neutral",
            );
        }
        expect(good.qualityV2.levels.chirpDetected.status).toBe("YES");
        expect(levelTone(good.qualityV2.levels.chirpDetected)).toBe("neutral");
    });

    it("motor saturation is a documented diagnostic finding (warning), never a PASS when absent", () => {
        const opts = { firmwareDebug: true, motors: (i: number) => [i % 500 < 20 ? 2047 : 1200, 1200, 1200, 1200] };
        const headers = [...FULL_TUNE_HEADERS, "motorOutput:158,2047"];
        const sat = only(encodeChirpLog(simulateChirp(opts), headers, 32, 4));
        expect(sat.qualityV2.saturation.status).toBe("DETECTED");
        expect(sat.qualityV2.verdicts.saturation).toMatchObject({ verdict: "WARNING", basis: "DOCUMENTED_DIAGNOSTIC" });
        expect(rowsOf(sat.qualityV2).saturation.tone).toBe("warn");
        const clean = only(
            encodeChirpLog(
                simulateChirp({ firmwareDebug: true, motors: () => [1200, 1200, 1200, 1200] }),
                headers,
                32,
                4,
            ),
        );
        expect(clean.qualityV2.saturation.status).toBe("NOT_DETECTED");
        expect(rowsOf(clean.qualityV2).saturation).toMatchObject({ verdict: "NOT_EVALUATED", tone: "neutral" });
    });
});

// ---------------------------------------------------------------------------
// Review 2: authorization scope
// ---------------------------------------------------------------------------

describe("measurement authorization scope", () => {
    it("YES only mirrors apply.allowed, and always carries the measurement-only scope", () => {
        expect(good.apply.allowed).toBe(true);
        expect(good.qualityV2.levels.tuningAuthorized).toEqual({
            status: "YES",
            role: "ACTIVE_GATE",
            reasons: [QV2_REASONS.authorizationScope],
        });
        expect(good.qualityV2.reasons).toContain(QV2_REASONS.authorizationScope);
    });

    it("a rejected CHIRP is NO", () => {
        expect(poor.apply.allowed).toBe(false);
        expect(poor.qualityV2.levels.tuningAuthorized.status).toBe("NO");
        expect(poor.qualityV2.levels.tuningAuthorized.reasons).toEqual([
            QV2_REASONS.tuningBlocked,
            QV2_REASONS.authorizationScope,
        ]);
    });

    it("a usable CHIRP without a recommendation is NO", () => {
        const m = only(encodeChirpLog(simulateChirp({ firmwareDebug: true })));
        expect(m.state).not.toBe("rejected");
        m.recommendation = null;
        m.apply = authorizeMeasurement(m);
        refreshAuthorizationLevel(m);
        expect(m.apply.blocked).toContain("recommendation:not_produced");
        expect(m.qualityV2.levels.tuningAuthorized.status).toBe("NO");
    });

    it("follows a changed phase-margin target, and refreshAuthorizationLevel copies apply.allowed", () => {
        const r = qualify(encodeChirpLog(simulateChirp({ firmwareDebug: true })));
        const m = r.measurements[0];
        for (const target of [30, 45, 60, 75]) {
            recomputeRecommendations(r, target, AUTOTUNE_MATH);
            expect(m.qualityV2.levels.tuningAuthorized.status).toBe(m.apply.allowed ? "YES" : "NO");
        }
        const fake = {
            apply: { ...m.apply, allowed: false },
            qualityV2: structuredClone(m.qualityV2),
        } as ChirpMeasurement;
        refreshAuthorizationLevel(fake);
        expect(fake.qualityV2.levels.tuningAuthorized.status).toBe("NO");
        fake.apply.allowed = true;
        refreshAuthorizationLevel(fake);
        expect(fake.qualityV2.levels.tuningAuthorized.reasons).toEqual([QV2_REASONS.authorizationScope]);
    });

    it("physical Apply stays locked whatever the measurement level says", () => {
        expect(good.qualityV2.levels.tuningAuthorized.status).toBe("YES");
        expect(productApplyBlocks()).toEqual([PRODUCT_APPLY_PENDING]);
        expect(() => assertProductApplyReleased()).toThrow();
    });

    it("the UI names the scope: measurement authorization, separate gates, the Apply lock", () => {
        const msg = (k: string) => (en as Record<string, { message: string }>)[k].message;
        expect(msg("gyrocoreQv2Level_tuningAuthorized")).toBe("Measurement authorization");
        expect(msg("gyrocoreQv2Level_tuningAuthorized")).not.toMatch(/tuning authorized/i);
        expect(msg("gyrocoreQv2AuthorizationScope")).toMatch(/this CHIRP only/);
        for (const gate of ["Cross-flight", "composite tuning", "Safety", "physical FC Apply"]) {
            expect(msg("gyrocoreQv2AuthorizationScope")).toContain(gate);
        }
    });
});

describe("the card", () => {
    function mount(quality: ChirpQualityV2) {
        const container = document.createElement("div");
        document.body.appendChild(container);
        const app = createApp({
            render: () => h(UApp, { portal: false }, { default: () => h(ChirpQualityV2Card, { quality }) }),
        });
        app.config.globalProperties.$t = ((key: string) => key) as never;
        app.mount(container);
        return { container, unmount: () => (app.unmount(), container.remove()) };
    }

    it("shows availability neutral and the verdict separately; FAIL is never green", () => {
        const { container, unmount } = mount(weak.qualityV2);
        const row = container.querySelector('[data-row="excitation"]')!;
        expect(row.getAttribute("data-status")).toBe("MEASURED");
        expect(row.getAttribute("data-verdict")).toBe("FAIL");
        expect(row.querySelector('[data-badge="verdict"]')!.getAttribute("data-tone")).toBe("bad");
        expect(row.querySelector('[data-badge="verdict"]')!.textContent).toContain("gyrocoreQv2Verdict_FAIL");
        expect(row.textContent).toContain(`gyrocoreQv2CriterionMin|${MIN_EXCITATION_RMS}`);
        const coverage = container.querySelector('[data-row="coverage"] [data-badge="verdict"]')!;
        expect(coverage.getAttribute("data-tone")).toBe("neutral");
        expect(coverage.textContent).toContain("gyrocoreQv2Verdict_NOT_EVALUATED");
        unmount();
    });

    it("labels the authorization level with its scope and the Apply lock", () => {
        const { container, unmount } = mount(good.qualityV2);
        const level = container.querySelector('[data-level="tuningAuthorized"]')!;
        expect(level.textContent).toContain("gyrocoreQv2Level_tuningAuthorized");
        expect(container.querySelector('[data-gyrocore="qv2-authorization-scope"]')!.textContent).toContain(
            `gyrocoreQv2AuthorizationScope|${PRODUCT_APPLY_PENDING}`,
        );
        expect(container.querySelector('[data-level="chirpDetected"]')!.getAttribute("data-tone")).toBe("neutral");
        unmount();
    });
});

// ---------------------------------------------------------------------------
// Review 3: relative spectral power
// ---------------------------------------------------------------------------

/** Plain DFT reference (no Betaflight FFT): mean over Welch segments of |sum w x e^-j..|^2 at bin k. */
function referenceSegmentMean(x: ArrayLike<number>, n: number, hop: number, k: number) {
    const w = hanningWindow(n);
    const segments = Math.max(1, Math.floor((x.length - n) / hop) + 1);
    let sum = 0;
    for (let s = 0; s < segments; s++) {
        let re = 0;
        let im = 0;
        for (let i = 0; i < n; i++) {
            const a = (-2 * Math.PI * k * i) / n;
            re += w[i] * x[s * hop + i] * Math.cos(a);
            im += w[i] * x[s * hop + i] * Math.sin(a);
        }
        sum += re * re + im * im;
    }
    return { mean: sum / segments, segments };
}

function sineInput(opts: {
    fs: number;
    seconds: number;
    n: number;
    k0: number;
    inAmp: number;
    outAmp: number;
}): QualityV2Input {
    const { fs, n } = opts;
    const len = Math.round(fs * opts.seconds);
    const f0 = (opts.k0 * fs) / n;
    const setpoint = new Float64Array(len);
    const gyro = new Float64Array(len);
    const timeUs = new Float64Array(len);
    for (let i = 0; i < len; i++) {
        setpoint[i] = opts.inAmp * Math.sin((2 * Math.PI * f0 * i) / fs);
        gyro[i] = opts.outAmp * Math.sin((2 * Math.PI * f0 * i) / fs - 0.3);
        timeUs[i] = (i * 1e6) / fs;
    }
    const tf = welchTransferFunction(setpoint, gyro, fs, n, 0.5);
    const quality = postAnalysisReport({ gates: [], tf, sampleRateHz: fs, inputSignal: setpoint, bandHz: [5, 100] });
    const rate: SampleRateEvidence = {
        pidLoopRateHz: fs,
        headerRateHz: fs,
        timestampRateHz: fs,
        effectiveRateHz: fs,
        source: "header_confirmed",
        status: "ok",
        differencePercent: 0,
        warnings: [],
        usable: true,
    };
    return {
        measurementId: "log1-seg1",
        logIndex: 0,
        chirpIndex: 0,
        axisOccurrence: 1,
        axis: 0,
        axisName: "roll",
        startTimeUs: 0,
        endTimeUs: timeUs[len - 1],
        durationS: opts.seconds,
        setpoint,
        gyro,
        timeUs,
        chirpFrequencyDeciHz: null,
        chirpExcitationMilli: null,
        motorMax: null,
        motorMin: null,
        rate,
        spacing: analyzeTimestampSpacing(timeUs),
        segmentSize: n,
        welchOverlap: 0.5,
        transferFunction: tf,
        quality,
        requestedRangeHz: null,
        requestedDurationS: null,
        requestedAmplitude: null,
        motorOutputRange: null,
        firmwareRevision: null,
        apiVersion: null,
        flagGating: "none",
        highResolutionScale: 1,
        qualified: false,
        applyAllowed: false,
    };
}

function binOf(v: ChirpQualityV2, hz: number) {
    const i = v.coherence.bins.frequencyHz.findIndex((f) => Math.abs(f - hz) < 1e-9);
    expect(i).toBeGreaterThanOrEqual(0);
    return i;
}

describe("relative spectral power", () => {
    const base = { fs: 1000, seconds: 4, n: 256, k0: 8, inAmp: 20, outAmp: 10 };
    const f0 = (base.k0 * base.fs) / base.n;

    it("is Betaflight's Welch Sxx and Syy divided by the segment count (dB re 1 unit²)", () => {
        const inp = sineInput(base);
        const v = buildChirpQualityV2(inp);
        const i = binOf(v, f0);
        const refIn = referenceSegmentMean(inp.setpoint, base.n, base.n / 2, base.k0);
        const refOut = referenceSegmentMean(inp.gyro, base.n, base.n / 2, base.k0);
        expect(refIn.segments).toBe(inp.transferFunction!.numSegments);
        expect(v.coherence.bins.inputRelativePowerDb[i]!).toBeCloseTo(10 * Math.log10(refIn.mean), 6);
        expect(v.coherence.bins.outputRelativePowerDb[i]!).toBeCloseTo(10 * Math.log10(refOut.mean), 6);
        // A bin-centred tone of amplitude A: |X|² ≈ (A Σw / 2)².
        const sumW = hanningWindow(base.n).reduce((a, b) => a + b, 0);
        expect(v.coherence.bins.inputRelativePowerDb[i]!).toBeCloseTo(20 * Math.log10((base.inAmp * sumW) / 2), 1);
        expect(v.coherence.bins.powerScale).toEqual({
            quantity: "RELATIVE_SPECTRAL_POWER",
            isPsd: false,
            definition: "mean_over_welch_segments_of_abs_fft_hann_squared",
            unit: "dB re 1 (signal unit)^2",
            window: "hann (betaflight hanningWindow), unnormalised",
            segmentSize: base.n,
            numSegments: inp.transferFunction!.numSegments,
            spectrogramFloorRemoved: SPECTROGRAM_POWER_FLOOR,
        });
    });

    it("gives the output/input ratio of the amplitudes, independent of segment count and size", () => {
        const ratio = (o: typeof base) => {
            const v = buildChirpQualityV2(sineInput(o));
            const i = binOf(v, (o.k0 * o.fs) / o.n);
            return {
                v,
                inDb: v.coherence.bins.inputRelativePowerDb[i]!,
                diff: v.coherence.bins.outputRelativePowerDb[i]! - v.coherence.bins.inputRelativePowerDb[i]!,
            };
        };
        const expected = 20 * Math.log10(base.outAmp / base.inAmp);
        const a = ratio(base);
        const longer = ratio({ ...base, seconds: 12 });
        const bigger = ratio({ ...base, n: 512, k0: 16 });
        for (const r of [a, longer, bigger]) {
            // Hann leakage between the phase-shifted tones is far below 0.001 dB.
            expect(r.diff).toBeCloseTo(expected, 3);
        }
        // Averaged, not summed: three times the segments leaves the level unchanged.
        expect(longer.v.provenance.welchSegments!).toBeGreaterThan(2 * a.v.provenance.welchSegments!);
        expect(longer.inDb).toBeCloseTo(a.inDb, 2);
        // Not a PSD: doubling the segment raises a tone by (Σw512/Σw256)², about 6 dB.
        const sw = (n: number) => hanningWindow(n).reduce((x, y) => x + y, 0);
        expect(bigger.inDb - a.inDb).toBeCloseTo(20 * Math.log10(sw(512) / sw(256)), 2);
    });

    it("removes the spectrogram floor near 1e-20 instead of reporting it as signal", () => {
        // Per-segment |X|² about 1e-19 at the tone: the floor would add 0.4 dB if kept.
        const sumW = hanningWindow(base.n).reduce((a, b) => a + b, 0);
        const amp = (2 * Math.sqrt(1e-19)) / sumW;
        const inp = sineInput({ ...base, inAmp: amp, outAmp: amp / 2 });
        const v = buildChirpQualityV2(inp);
        const i = binOf(v, f0);
        const ref = referenceSegmentMean(inp.setpoint, base.n, base.n / 2, base.k0);
        expect(ref.mean).toBeLessThan(1e-18);
        expect(Number.isFinite(inp.transferFunction!.magnitude[base.k0])).toBe(true);
        expect(v.coherence.bins.inputRelativePowerDb[i]!).toBeCloseTo(10 * Math.log10(ref.mean), 3);
        expect(v.coherence.bins.outputRelativePowerDb[i]! - v.coherence.bins.inputRelativePowerDb[i]!).toBeCloseTo(
            20 * Math.log10(0.5),
            2,
        );
    });

    it("a silent output has no recoverable power: null with a reason, never -Infinity or NaN", () => {
        const inp = sineInput({ ...base, outAmp: 0 });
        const v = buildChirpQualityV2(inp);
        expect(v.coherence.bins.outputRelativePowerDb.every((x) => x === null)).toBe(true);
        expect(v.coherence.bins.reasons).toContain(QV2_REASONS.outputPowerAtFloor);
        const json = JSON.stringify(v);
        expect(json).not.toMatch(/NaN|Infinity/);
        expect(JSON.parse(json)).toEqual(v);
    });

    it("bins below Betaflight's input floor carry no input power", () => {
        const inp = sineInput({ ...base, inAmp: 0 });
        const v = buildChirpQualityV2(inp);
        const b = v.coherence.bins;
        b.status.forEach((s, k) => {
            if (s === "NO_INPUT_POWER") {
                expect(b.inputRelativePowerDb[k]).toBeNull();
            }
        });
        expect(b.status.filter((s) => s === "NO_INPUT_POWER").length).toBeGreaterThan(0);
    });

    it("leaves the transfer function and recommendGains() untouched", () => {
        const inp = sineInput(base);
        const tf = inp.transferFunction!;
        // Plain copies: jsdom's structuredClone yields typed arrays from another realm.
        const plain = (x: typeof tf) =>
            Object.fromEntries(Object.entries(x).map(([k, a]) => [k, typeof a === "number" ? a : Array.from(a)]));
        const before = plain(tf);
        const sliders = {
            masterMultiplier: 1,
            piGain: 1,
            iGain: 1,
            dGain: 1,
            feedforwardGain: 1,
            dtermFilterMultiplier: 1,
        };
        const gainsBefore = recommendGains(tf, sliders, 60);
        const v = buildChirpQualityV2(inp);
        expect(plain(tf)).toEqual(before);
        expect(recommendGains(tf, sliders, 60)).toEqual(gainsBefore);
        expect(v.coherence.bins.coherence).toEqual(
            v.coherence.bins.frequencyHz.map((f) => tf.coherence[Math.round(f / (base.fs / base.n))]),
        );
    });
});
