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

// Blind adversarial suite for CHIRP Quality V2, written from docs/gyrocore/CHIRP_QUALITY_V2.md without reading the implementation.

import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import {
    authorizeMeasurement,
    qualifyChirpFile,
    recomputeRecommendations,
    type ChirpMeasurement,
    type ChirpQualificationReport,
} from "../../src/gyrocore/chirp/qualification";
import {
    CHIRP_QUALITY_V2_ANALYSIS_VERSION,
    CHIRP_QUALITY_V2_SCHEMA,
    QV2_REASONS,
    type BinStatus,
    type ChirpQualityV2,
} from "../../src/gyrocore/chirp/qualityV2/contract";
import { attachChirpFlightIdentity } from "../../src/gyrocore/chirp/qualityV2/identity";
import { catalogBbl, checkIndependentFlights } from "../../src/gyrocore/flight/identity";
import { computeSpectrogram } from "../../src/js/blackbox/spectral_analysis";
import type { SyntheticFrame } from "./harness/bblWriter";
import {
    concatLogs,
    encodeChirpLog,
    FULL_TUNE_HEADERS,
    simulateChirp,
    simulateChirpSequence,
    withHeader,
    type SimOptions,
} from "./harness/chirpSim";

vi.mock("../../src/js/localization", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/js/localization")>()),
    i18n: { getMessage: (key: string) => key },
}));

afterEach(() => {
    vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Synthetic logs
// ---------------------------------------------------------------------------

const SECONDS = 6;
const FS = 1000;
const HEADERS = withHeader(withHeader(FULL_TUNE_HEADERS, `chirp_time_seconds:${SECONDS}`), "chirp_amplitude_roll:200");
const MOTOR_HEADERS = [...HEADERS, "motorOutput:48,2047"];
const ALL_CODES = new Set<string>(Object.values(QV2_REASONS));

function sim(o: SimOptions = {}): SyntheticFrame[] {
    return simulateChirp({ seconds: SECONDS, firmwareDebug: true, startHz: 2, endHz: 200, ...o });
}

function qualify(bytes: Uint8Array): ChirpQualificationReport {
    return qualifyChirpFile(bytes, "adversarial.bbl", 60, AUTOTUNE_MATH);
}

function run(frames: SyntheticFrame[], headers: string[] = HEADERS, motorCount = 0) {
    const bytes = encodeChirpLog(frames, headers, 32, motorCount);
    return { bytes, report: qualify(bytes) };
}

/** Single-segment run; returns the only measurement. */
function single(frames: SyntheticFrame[], headers: string[] = HEADERS, motorCount = 0) {
    const { bytes, report } = run(frames, headers, motorCount);
    expect(report.measurements).toHaveLength(1);
    return { bytes, report, m: report.measurements[0], q: report.measurements[0].qualityV2 };
}

/** Replace debug[2] (sweep frequency, 0.1 Hz) on every frame. */
function withFreq(frames: SyntheticFrame[], f: (i: number, old: number) => number): SyntheticFrame[] {
    return frames.map((fr, i) => ({ ...fr, debug: [fr.debug[0], fr.debug[1], f(i, fr.debug[2]), fr.debug[3]] }));
}

function dropFrames(frames: SyntheticFrame[], drop: Set<number>): SyntheticFrame[] {
    return frames.filter((_, i) => !drop.has(i));
}

function without(headers: string[], key: string): string[] {
    return headers.filter((h) => !h.startsWith(`${key}:`));
}

/** numpy rint: round half to even. */
function rint(x: number): number {
    const r = Math.round(x);
    return Math.abs(x - Math.trunc(x)) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

// Cached base scenarios, so the expensive decode runs once.
let baseCache: ReturnType<typeof single> | null = null;
const base = () => (baseCache ??= single(sim()));

// ---------------------------------------------------------------------------
// Generic invariants applied to every report produced here
// ---------------------------------------------------------------------------

function walk(x: unknown, path: string, visit: (v: unknown, path: string) => void) {
    visit(x, path);
    if (Array.isArray(x)) {
        x.forEach((v, i) => walk(v, `${path}[${i}]`, visit));
    } else if (x && typeof x === "object") {
        for (const [k, v] of Object.entries(x)) {
            walk(v, `${path}.${k}`, visit);
        }
    }
}

const SECTIONS = [
    "identity",
    "provenance",
    "levels",
    "sweep",
    "excitation",
    "coherence",
    "sampleGaps",
    "contamination",
    "saturation",
] as const;

function checkInvariants(q: ChirpQualityV2) {
    expect(q.schema).toBe("gyrocore.chirp-quality.v2");
    expect(q.analysisVersion).toBe("2.0.0");
    const problems: string[] = [];
    walk(q, "q", (v, path) => {
        if (typeof v === "number" && !Number.isFinite(v)) {
            problems.push(`${path}: non-finite number ${v}`);
        }
        if (v === undefined) {
            problems.push(`${path}: undefined`);
        }
        if (ArrayBuffer.isView(v)) {
            problems.push(`${path}: typed array`);
        }
        if (v && typeof v === "object" && !Array.isArray(v)) {
            const o = v as Record<string, unknown>;
            if ("availability" in o && "value" in o) {
                if (o.availability !== "MEASURED" && o.value !== null) {
                    problems.push(`${path}: ${String(o.availability)} with value ${JSON.stringify(o.value)}`);
                }
                if (o.availability === "MEASURED" && o.value === null) {
                    problems.push(`${path}: MEASURED with null value`);
                }
            }
            if ("reasons" in o) {
                for (const r of o.reasons as string[]) {
                    if (!ALL_CODES.has(r)) {
                        problems.push(`${path}: unknown reason ${r}`);
                    }
                }
            }
            if ("role" in o && o.role !== "ACTIVE_GATE" && o.role !== "DIAGNOSTIC") {
                problems.push(`${path}: bad role ${String(o.role)}`);
            }
        }
    });
    // Sweep ranges: UNKNOWN is never filled in.
    const { requested, observed, usable } = q.sweep;
    if (requested.availability !== "MEASURED") {
        if (requested.startHz !== null || requested.endHz !== null) {
            problems.push("sweep.requested: not MEASURED but has a range");
        }
    }
    if (observed.availability !== "MEASURED") {
        for (const k of ["startHz", "endHz", "minHz", "maxHz", "runs"] as const) {
            if (observed[k] !== null) {
                problems.push(`sweep.observed.${k}: not MEASURED but ${observed[k]}`);
            }
        }
    }
    if (usable.availability !== "MEASURED" && (usable.startHz !== null || usable.endHz !== null)) {
        problems.push("sweep.usable: not MEASURED but has a range");
    }
    if (q.identity.file.availability !== "MEASURED" && q.identity.file.sha256 !== null) {
        problems.push("identity.file: not MEASURED but has a hash");
    }
    if (q.identity.flight.availability !== "MEASURED" && q.identity.flight.ref !== null) {
        problems.push("identity.flight: not MEASURED but has a ref");
    }
    if (q.sampleGaps.status === "UNKNOWN" && q.sampleGaps.gapCount !== null) {
        problems.push(`sampleGaps: UNKNOWN but gapCount ${q.sampleGaps.gapCount}`);
    }
    // Contamination: always UNKNOWN in this version.
    if (q.contamination.status !== "UNKNOWN" || !q.contamination.reasons.includes(QV2_REASONS.contaminationUnknown)) {
        problems.push(`contamination: ${q.contamination.status} ${q.contamination.reasons.join(",")}`);
    }
    // Gyro clipping: always UNKNOWN.
    if (
        q.saturation.gyroClipping.availability === "MEASURED" ||
        !q.saturation.gyroClipping.reasons.concat(q.saturation.reasons).includes(QV2_REASONS.gyroClippingUnknown)
    ) {
        problems.push("saturation.gyroClipping: not UNKNOWN or reason missing");
    }
    if (q.saturation.status === "NOT_DETECTED" && !q.saturation.reasons.includes(QV2_REASONS.saturationMotorsOnly)) {
        problems.push("saturation: NOT_DETECTED without saturation_scope:motor_outputs_only");
    }
    // Top-level reasons: every nested reason, once, in section order.
    const firstSection = new Map<string, number>();
    SECTIONS.forEach((s, si) =>
        walk(q[s], s, (v) => {
            if (v && typeof v === "object" && !Array.isArray(v) && "reasons" in v) {
                for (const r of (v as { reasons: string[] }).reasons) {
                    if (!firstSection.has(r)) {
                        firstSection.set(r, si);
                    }
                }
            }
        }),
    );
    if (new Set(q.reasons).size !== q.reasons.length) {
        problems.push(`reasons: duplicates ${q.reasons.join(",")}`);
    }
    if ([...q.reasons].sort().join() !== [...firstSection.keys()].sort().join()) {
        problems.push(`reasons: top-level ${q.reasons.join(",")} != nested ${[...firstSection.keys()].join(",")}`);
    }
    const order = q.reasons.map((r) => firstSection.get(r) ?? -1);
    if (order.some((s, i) => i > 0 && s < order[i - 1])) {
        problems.push(`reasons: not in section order ${q.reasons.join(",")}`);
    }
    // Plain JSON round trip.
    if (JSON.stringify(JSON.parse(JSON.stringify(q))) !== JSON.stringify(q)) {
        problems.push("JSON round trip differs");
    }
    expect(JSON.parse(JSON.stringify(q))).toStrictEqual(q);
    expect(problems).toEqual([]);
}

/** Own recomputation of every stored bin from Betaflight's transfer function. */
function expectedBins(m: ChirpMeasurement) {
    const tf = m.diagnostics!.transferFunction;
    const fs = m.sampleRate.effectiveRateHz!;
    const nyq = fs / 2;
    const band = m.quality.analysisBandHz;
    const reqEnd = m.qualityV2.sweep.requested.endHz;
    const limit = Math.max(band[1], reqEnd ?? -Infinity);
    const idx: number[] = [];
    let omitted = 0;
    for (let k = 1; k < tf.frequencies.length; k++) {
        const f = tf.frequencies[k];
        if (f >= nyq) {
            continue;
        }
        if (f <= limit) {
            idx.push(k);
        } else {
            omitted++;
        }
    }
    const status = idx.map((k): BinStatus => {
        const f = tf.frequencies[k];
        if (f < band[0] || f > band[1]) {
            return "OUTSIDE_ANALYSIS_BAND";
        }
        if (!Number.isFinite(tf.magnitude[k])) {
            return "NO_INPUT_POWER";
        }
        return tf.coherence[k] >= 0.5 ? "USABLE" : "WEAK_COHERENCE";
    });
    return { tf, idx, status, omitted };
}

function checkBins(m: ChirpMeasurement) {
    const q = m.qualityV2;
    const b = q.coherence.bins;
    const { tf, idx, status, omitted } = expectedBins(m);
    expect(b.availability).toBe("MEASURED");
    expect(b.kind).toBe("MEASURED_BINS");
    const n = b.frequencyHz.length;
    for (const arr of [b.coherence, b.magnitudeDb, b.inputPowerDb, b.outputPowerDb, b.snrDb, b.status]) {
        expect(arr).toHaveLength(n);
    }
    expect(b.frequencyHz).toEqual(idx.map((k) => tf.frequencies[k]));
    expect(b.frequencyHz[0]).toBeGreaterThan(0);
    expect(Math.max(...b.frequencyHz)).toBeLessThan(m.sampleRate.effectiveRateHz! / 2);
    // Nyquist may or may not be counted as omitted; the spec only says it is never stored.
    expect([omitted, omitted + 1]).toContain(b.omittedBinCount);
    idx.forEach((k, i) => {
        expect(Math.abs(b.coherence[i] - tf.coherence[k])).toBeLessThan(1e-12);
        if (Number.isFinite(tf.magnitude[k])) {
            expect(Math.abs(b.magnitudeDb[i]! - tf.magnitude[k])).toBeLessThan(1e-9);
        } else {
            expect(b.magnitudeDb[i]).toBeNull();
        }
        const c = tf.coherence[k];
        if (c <= 0 || c >= 1) {
            expect(b.snrDb[i]).toBeNull();
        } else {
            expect(Math.abs(b.snrDb[i]! - 10 * Math.log10(c / (1 - c)))).toBeLessThan(1e-9);
        }
    });
    expect(b.status).toEqual(status);
    // The USABLE count is the existing gate's count, everywhere it is reported.
    const usable = status.filter((s) => s === "USABLE").length;
    expect(usable).toBe(m.quality.usableBinCount);
    expect(q.coherence.usableBinCount.value).toBe(m.quality.usableBinCount);
    expect(q.coherence.usableBinCount.role).toBe("ACTIVE_GATE");
    // Zero usable bins is itself a measured fact; the range is then null, never invented.
    if (q.sweep.usable.availability === "MEASURED") {
        expect(q.sweep.usable.binCount).toBe(m.quality.usableBinCount);
    }
    expect([q.sweep.usable.startHz, q.sweep.usable.endHz]).toEqual(m.quality.usableRangeHz ?? [null, null]);
    const inBand = status.filter((s) => s !== "OUTSIDE_ANALYSIS_BAND").length;
    expect(q.sweep.usableOfAnalysisBand.availability).toBe("MEASURED");
    expect(q.sweep.usableOfAnalysisBand.value!).toBeCloseTo(usable / inBand, 12);
    expect(q.excitation.noInputPowerBins.value).toBe(status.filter((s) => s === "NO_INPUT_POWER").length);
}

function checkRegions(q: ChirpQualityV2) {
    const b = q.coherence.bins;
    const items = q.coherence.regions.items;
    expect(q.coherence.regions.kind).toBe("SUMMARY");
    let at = 0;
    items.forEach((r, i) => {
        expect(r.binCount).toBeGreaterThan(0);
        const run = b.status.slice(at, at + r.binCount);
        expect(new Set(run)).toEqual(new Set([r.status]));
        expect(r.fromHz).toBe(b.frequencyHz[at]);
        expect(r.toHz).toBe(b.frequencyHz[at + r.binCount - 1]);
        const coh = b.coherence.slice(at, at + r.binCount);
        expect(r.minCoherence).toBe(Math.min(...coh));
        expect(r.maxCoherence).toBe(Math.max(...coh));
        expect(r.meanCoherence).toBeCloseTo(coh.reduce((s, c) => s + c, 0) / coh.length, 12);
        if (i > 0) {
            // Maximal runs: neighbours differ, so a region is never split arbitrarily.
            expect(r.status).not.toBe(items[i - 1].status);
            expect(r.fromHz).toBeGreaterThan(items[i - 1].toHz);
        }
        at += r.binCount;
    });
    // Regions tile the stored bins exactly, no overlap, no gap.
    expect(at).toBe(b.frequencyHz.length);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("contract", () => {
    it("exports the documented schema and version", () => {
        expect(CHIRP_QUALITY_V2_SCHEMA).toBe("gyrocore.chirp-quality.v2");
        expect(CHIRP_QUALITY_V2_ANALYSIS_VERSION).toBe("2.0.0");
        expect(new Set(Object.values(QV2_REASONS)).size).toBe(Object.values(QV2_REASONS).length);
    });

    it("base report: invariants, plain JSON, no file bytes", () => {
        const { q, bytes } = base();
        checkInvariants(q);
        // No file bytes: the JSON is far smaller than the file, and holds no long numeric byte arrays.
        expect(JSON.stringify(q).length).toBeLessThan(bytes.length);
    });
});

describe("coherence bins against Betaflight's welchTransferFunction", () => {
    it("every stored bin and status matches an independent recomputation", () => {
        const { m, q } = base();
        checkBins(m);
        checkRegions(q);
        expect(q.coherence.meanBandCoherence.value).toBe(m.quality.meanBandCoherence);
        expect(q.coherence.meanBandCoherence.role).toBe("ACTIVE_GATE");
        expect(q.coherence.criteria).toEqual({
            usableBinCoherenceMin: 0.5,
            meanBandCoherenceMin: 0.6,
            meanBandHz: [5, 100],
            minUsableBins: 8,
            inputPowerFloor: 1e-20,
        });
    });

    it("stores bins up to the requested end when it lies above the analysis band (and below Nyquist)", () => {
        // 1 kHz: band top = 0.9 * 500 = 450 Hz; requested end 480 Hz.
        const headers = withHeader(HEADERS, "chirp_frequency_end_deci_hz:4800");
        const { m, q } = single(sim({ endHz: 480 }), headers);
        expect(m.quality.analysisBandHz[1]).toBe(450);
        checkBins(m);
        checkRegions(q);
        const top = Math.max(...q.coherence.bins.frequencyHz);
        expect(top).toBeGreaterThan(450);
        expect(top).toBeLessThanOrEqual(480);
        expect(q.coherence.bins.status.at(-1)).toBe("OUTSIDE_ANALYSIS_BAND");
    });

    it("input and output power are the Welch Sxx/Syy from computeSpectrogram with the Welch framing", () => {
        const frames = sim();
        const { m, q } = single(frames);
        const fs = m.sampleRate.effectiveRateHz!;
        const seg = m.segmentSize!;
        const input = Float32Array.from(frames.map((f) => f.setpoint[0]));
        const output = Float32Array.from(frames.map((f) => f.gyro[0]));
        const avg = (sig: Float32Array) => {
            const s = computeSpectrogram(sig, fs, seg, 0.5);
            expect(s.numSegments).toBe(m.diagnostics!.transferFunction.numSegments);
            const db: number[] = [];
            const lin: number[] = [];
            for (let k = 0; k < s.numBins; k++) {
                let sDb = 0;
                let sLin = 0;
                for (let j = 0; j < s.numSegments; j++) {
                    const p = s.power[j * s.numBins + k];
                    sDb += p;
                    sLin += 10 ** (p / 10);
                }
                db.push(sDb / s.numSegments);
                lin.push(10 * Math.log10(sLin / s.numSegments));
            }
            return { db, lin, freq: Array.from(s.freqHz) };
        };
        const pin = avg(input);
        const pout = avg(output);
        const b = q.coherence.bins;
        b.frequencyHz.forEach((f, i) => {
            const k = pin.freq.indexOf(f);
            expect(k).toBeGreaterThan(0);
            for (const [got, ref] of [
                [b.inputPowerDb[i], pin],
                [b.outputPowerDb[i], pout],
            ] as const) {
                expect(got).not.toBeNull();
                const ok = Math.abs(got! - ref.db[k]) < 1e-6 || Math.abs(got! - ref.lin[k]) < 1e-6;
                expect(ok, `bin ${f} Hz: ${got} vs dB-mean ${ref.db[k]} / linear-mean ${ref.lin[k]}`).toBe(true);
            }
        });
        // inputPowerPeakDb: highest in-band input power.
        const inBand = b.inputPowerDb.filter((_, i) => b.status[i] !== "OUTSIDE_ANALYSIS_BAND") as number[];
        expect(q.excitation.inputPowerPeakDb.value).toBeCloseTo(Math.max(...inBand), 9);
    });

    it("zero excitation: in-band bins are NO_INPUT_POWER, no usable range, never saturation", () => {
        const { m, q } = single(sim({ amplitude: 0 }));
        checkInvariants(q);
        checkBins(m);
        checkRegions(q);
        const b = q.coherence.bins;
        b.status.forEach((s, i) => {
            const f = b.frequencyHz[i];
            const inBand = f >= m.quality.analysisBandHz[0] && f <= m.quality.analysisBandHz[1];
            expect(s).toBe(inBand ? "NO_INPUT_POWER" : "OUTSIDE_ANALYSIS_BAND");
            expect(b.magnitudeDb[i]).toBeNull();
            expect(b.snrDb[i]).toBeNull();
        });
        expect(q.coherence.usableBinCount.value).toBe(0);
        expect(q.sweep.usable.startHz).toBeNull();
        expect(q.sweep.usable.endHz).toBeNull();
        expect(q.sweep.usable.reasons).toContain(QV2_REASONS.noUsableBins);
        expect(q.saturation.status).not.toBe("DETECTED");
        expect(q.levels.chirpQualified.status).toBe("NO");
        expect(q.levels.tuningAuthorized.status).toBe("NO");
    });

    it("pure noise output (low coherence) with motors in range: saturation NOT_DETECTED, never DETECTED", () => {
        let s = 12345;
        const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
        const frames = sim().map((f) => ({
            ...f,
            gyro: [Math.round(300 * rnd()), 0, 0] as [number, number, number],
            motors: [1000, 1100, 1200, 1300],
        }));
        const { m, q } = single(frames, MOTOR_HEADERS, 4);
        checkInvariants(q);
        checkBins(m);
        checkRegions(q);
        expect(m.quality.failedGates).toContain("low_coherence");
        expect(q.saturation.status).toBe("NOT_DETECTED");
        expect(q.saturation.motorUpper.value).toEqual({ samples: 0, fraction: 0 });
        expect(q.saturation.motorLower.value).toEqual({ samples: 0, fraction: 0 });
    });
});

describe("provenance and excitation", () => {
    it("provenance mirrors the qualification's sample rate and Welch framing", () => {
        const { m, q } = base();
        const p = q.provenance;
        expect(p.sampleRateHz).toBe(m.sampleRate.effectiveRateHz);
        expect(p.segmentSize).toBe(m.segmentSize);
        expect(p.welchOverlap).toBe(0.5);
        expect(p.welchSegments).toBe(m.diagnostics!.transferFunction.numSegments);
        expect(p.binWidthHz).toBeCloseTo(m.sampleRate.effectiveRateHz! / m.segmentSize!, 12);
        expect(q.coherence.bins.binWidthHz).toBeCloseTo(p.binWidthHz!, 12);
        expect(p.inputField).toMatch(/setpoint/);
        expect(p.outputField).toMatch(/gyro/i);
    });

    it("excitation values come from the logged samples and the firmware channel", () => {
        const frames = sim();
        const { m, q } = single(frames);
        const sp = frames.map((f) => f.setpoint[0]);
        const gy = frames.map((f) => f.gyro[0]);
        const ex = frames.map((f) => f.debug[3] / 1000);
        const e = q.excitation;
        expect(e.setpointRms.role).toBe("ACTIVE_GATE");
        expect(e.setpointRms.value).toBeCloseTo(m.quality.inputRms, 9);
        expect(e.setpointPeakAbs.value).toBe(Math.max(...sp.map(Math.abs)));
        expect(e.gyroPeakAbs.value).toBe(Math.max(...gy.map(Math.abs)));
        const ms = sp.reduce((s, v) => s + v * v, 0) / sp.length;
        // Mean square of a zero-mean sweep: equals RMS² up to the small DC term.
        expect(Math.abs(e.setpointMeanSquare.value! - ms) / ms).toBeLessThan(0.01);
        expect(e.requestedAmplitude.value).toBe(200);
        expect(e.firmwareExcitation.availability).toBe("MEASURED");
        const exRms = Math.sqrt(ex.reduce((s, v) => s + v * v, 0) / ex.length);
        expect(e.firmwareExcitation.value!.peakAbs).toBeCloseTo(Math.max(...ex.map(Math.abs)), 9);
        expect(Math.abs(e.firmwareExcitation.value!.rms - exRms)).toBeLessThan(0.01);
        for (const k of [
            "setpointPeakAbs",
            "setpointMeanSquare",
            "setpointEnergy",
            "gyroRms",
            "gyroPeakAbs",
        ] as const) {
            expect(e[k].role).toBe("DIAGNOSTIC");
        }
    });

    it("firmware excitation channel of zeros is UNKNOWN, not 0", () => {
        const { q } = single(sim({ firmwareDebug: false }));
        checkInvariants(q);
        expect(q.excitation.firmwareExcitation.availability).toBe("UNKNOWN");
        expect(q.excitation.firmwareExcitation.value).toBeNull();
        expect(q.excitation.firmwareExcitation.reasons).toContain(QV2_REASONS.excitationChannelConstant);
    });

    it("missing chirp_amplitude header leaves requestedAmplitude without a value", () => {
        const { q } = single(sim(), without(HEADERS, "chirp_amplitude_roll"));
        checkInvariants(q);
        expect(q.sweep.requested.amplitude).toBeNull();
        expect(q.excitation.requestedAmplitude.value).toBeNull();
        expect(q.reasons).toContain(QV2_REASONS.requestedAmplitudeMissing);
    });
});

describe("sweep: requested vs observed", () => {
    it("full sweep: observed equals the firmware channel, coverage near 1", () => {
        const frames = sim();
        const { q } = single(frames);
        const deci = frames.map((f) => f.debug[2]);
        const o = q.sweep.observed;
        expect(q.sweep.requested).toMatchObject({ availability: "MEASURED", startHz: 2, endHz: 200, durationS: 6 });
        expect(o.availability).toBe("MEASURED");
        expect(o.startHz).toBeCloseTo(deci[0] / 10, 9);
        expect(o.endHz).toBeCloseTo(deci.at(-1)! / 10, 9);
        expect(o.minHz).toBeCloseTo(Math.min(...deci) / 10, 9);
        expect(o.maxHz).toBeCloseTo(Math.max(...deci) / 10, 9);
        expect(o.runs).toBe(1);
        expect(o.reasons).not.toContain(QV2_REASONS.observedRestarted);
        const overlap = (Math.min(200, o.maxHz!) - Math.max(2, o.minHz!)) / (200 - 2);
        expect(q.sweep.observedOfRequested.value).toBeCloseTo(overlap, 9);
        expect(q.sweep.durationOfRequested.value).toBeCloseTo(((frames.length - 1) * 1e-3) / 6, 6);
        expect(q.sweep.analysisBandHz).toEqual([2, 200]);
    });

    it("sweep ending exactly one count below the requested end is not flagged; two counts is", () => {
        const one = single(withFreq(sim(), (i, old) => (i === SECONDS * FS - 1 ? 1999 : Math.min(old, 1999)))).q;
        expect(one.sweep.observed.availability).toBe("MEASURED");
        expect(one.sweep.observed.reasons).not.toContain(QV2_REASONS.observedBelowRequestedEnd);
        const two = single(withFreq(sim(), (_, old) => Math.min(old, 1998))).q;
        expect(two.sweep.observed.availability).toBe("MEASURED");
        expect(two.sweep.observed.reasons).toContain(QV2_REASONS.observedBelowRequestedEnd);
    });

    it("truncated sweep (stopped at 100 of 200 Hz) is MEASURED, flagged, coverage about half", () => {
        const { q } = single(sim({ endHz: 100 }));
        checkInvariants(q);
        const o = q.sweep.observed;
        expect(o.availability).toBe("MEASURED");
        expect(o.maxHz!).toBeLessThanOrEqual(100);
        expect(o.reasons).toContain(QV2_REASONS.observedBelowRequestedEnd);
        expect(q.sweep.observedOfRequested.value!).toBeCloseTo((o.maxHz! - o.minHz!) / 198, 9);
        expect(q.sweep.observedOfRequested.value!).toBeLessThan(0.51);
    });

    it("restarted sweep (chirp_repeat) inside one segment: runs = 2, restarted reason, still MEASURED", () => {
        const a = sim({ seconds: 3 });
        const b = sim({ seconds: 3, startTimeUs: a.at(-1)!.time + 1000 });
        const { q } = single([...a, ...b]);
        checkInvariants(q);
        expect(q.sweep.observed.availability).toBe("MEASURED");
        expect(q.sweep.observed.runs).toBe(2);
        expect(q.sweep.observed.reasons).toContain(QV2_REASONS.observedRestarted);
    });

    it("falls back on 0.33 % of steps: MEASURED with restarts; on 2 %: UNKNOWN not_monotonic", () => {
        const few = single(withFreq(sim(), (i, old) => (i % 300 === 299 ? 5 : old))).q;
        checkInvariants(few);
        expect(few.sweep.observed.availability).toBe("MEASURED");
        expect(few.sweep.observed.runs).toBeGreaterThan(1);
        expect(few.sweep.observed.reasons).toContain(QV2_REASONS.observedRestarted);

        const many = single(withFreq(sim(), (i, old) => (i % 50 === 49 ? 5 : old))).q;
        checkInvariants(many);
        expect(many.sweep.observed.availability).toBe("UNKNOWN");
        expect(many.sweep.observed.reasons).toContain(QV2_REASONS.observedChannelNotMonotonic);
        expect(many.sweep.observedOfRequested.availability).not.toBe("MEASURED");
        expect(many.sweep.observedOfRequested.reasons).toContain(QV2_REASONS.coverageNeedsObserved);
    });

    it("garbage frequency channel (pseudo-random) is UNKNOWN, never a range", () => {
        let s = 7;
        const { q } = single(withFreq(sim(), () => ((s = (s * 48271) % 2147483647) % 2000) + 1));
        checkInvariants(q);
        expect(q.sweep.observed.availability).toBe("UNKNOWN");
        expect(q.sweep.observedOfRequested.value).toBeNull();
    });

    it("constant channel (zeros, as the WU7 logs, and a non-zero constant) is UNKNOWN constant", () => {
        for (const frames of [sim({ firmwareDebug: false }), withFreq(sim(), () => 500)]) {
            const { q, m } = single(frames);
            checkInvariants(q);
            expect(q.sweep.observed.availability).toBe("UNKNOWN");
            expect(q.sweep.observed.reasons).toContain(QV2_REASONS.observedChannelConstant);
            expect(q.sweep.observedOfRequested.reasons).toContain(QV2_REASONS.coverageNeedsObserved);
            // Gaps cannot carry a sweep frequency without a MEASURED observed sweep (none here, but no crash).
            expect(m.qualityV2.sampleGaps.status).toBe("NONE");
        }
    });

    it("negative values make the channel UNKNOWN negative", () => {
        const { q } = single(withFreq(sim(), (i, old) => (i === 10 ? -3 : old)));
        checkInvariants(q);
        expect(q.sweep.observed.availability).toBe("UNKNOWN");
        expect(q.sweep.observed.reasons).toContain(QV2_REASONS.observedChannelNegative);
    });

    it("above the requested end: one count is tolerated, two counts is UNKNOWN", () => {
        const last = SECONDS * FS - 1;
        const ok = single(withFreq(sim(), (i, old) => (i === last ? 2001 : old))).q;
        expect(ok.sweep.observed.availability).toBe("MEASURED");
        expect(ok.sweep.observed.maxHz).toBeCloseTo(200.1, 9);
        const bad = single(withFreq(sim(), (i, old) => (i === last ? 2002 : old))).q;
        checkInvariants(bad);
        expect(bad.sweep.observed.availability).toBe("UNKNOWN");
        expect(bad.sweep.observed.reasons).toContain(QV2_REASONS.observedChannelOutOfRange);
    });

    it("missing start/end headers: requested UNKNOWN, coverage needs requested, nothing invented", () => {
        const headers = without(without(HEADERS, "chirp_frequency_start_deci_hz"), "chirp_frequency_end_deci_hz");
        const { q } = single(sim(), headers);
        checkInvariants(q);
        expect(q.sweep.requested.availability).toBe("UNKNOWN");
        expect(q.sweep.requested.reasons).toContain(QV2_REASONS.requestedHeadersMissing);
        expect(q.sweep.observedOfRequested.availability).not.toBe("MEASURED");
        expect(q.sweep.observedOfRequested.reasons).toContain(QV2_REASONS.coverageNeedsRequested);
        // Observed still comes from the channel, with no out-of-range check possible.
        expect(q.sweep.observed.availability).toBe("MEASURED");
    });

    it("invalid start/end headers (end <= start) are treated as missing", () => {
        const headers = withHeader(HEADERS, "chirp_frequency_end_deci_hz:20");
        const { q } = single(sim(), headers);
        checkInvariants(q);
        expect(q.sweep.requested.availability).toBe("UNKNOWN");
        expect(q.sweep.requested.startHz).toBeNull();
    });

    it("missing chirp_time_seconds: durationOfRequested UNKNOWN with its own reason", () => {
        const { q } = single(sim(), without(HEADERS, "chirp_time_seconds"));
        checkInvariants(q);
        expect(q.sweep.requested.durationS).toBeNull();
        expect(q.reasons).toContain(QV2_REASONS.requestedDurationMissing);
        expect(q.sweep.durationOfRequested.availability).not.toBe("MEASURED");
        // The range headers are still there.
        expect(q.sweep.requested.availability).toBe("MEASURED");
    });
});

describe("sample gaps", () => {
    function expectGaps(frames: SyntheticFrame[]) {
        const t = frames.map((f) => f.time);
        const d = t.slice(1).map((v, i) => v - t[i]);
        const sorted = d.filter((x) => x > 0).sort((a, b) => a - b);
        const median =
            sorted.length % 2
                ? sorted[(sorted.length - 1) / 2]
                : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
        return d
            .map((g, i) => ({ g, i }))
            .filter(({ g }) => g > 1.5 * median)
            .map(({ g, i }) => ({
                atTimeUs: t[i],
                afterSampleIndex: i,
                gapUs: g,
                missingSamples: rint(g / median) - 1,
                freqBefore: frames[i].debug[2] / 10,
                freqAfter: frames[i + 1].debug[2] / 10,
            }));
    }

    it("no gaps: NONE, empty list, expectedDtUs from the sample rate", () => {
        const { q, m } = base();
        expect(q.sampleGaps.status).toBe("NONE");
        expect(q.sampleGaps.gaps).toEqual([]);
        expect(q.sampleGaps.gapCount).toBe(0);
        expect(q.sampleGaps.gapsTruncated).toBe(false);
        expect(q.sampleGaps.expectedDtUs).toBeCloseTo(1e6 / m.sampleRate.effectiveRateHz!, 9);
        expect(q.sampleGaps.medianDtUs).toBe(m.spacing.medianDtUs);
    });

    it("gaps at the start, middle and end: each located, sized and given the sweep frequency", () => {
        const n = SECONDS * FS;
        const frames = dropFrames(sim(), new Set([1, 2, 3000, 3001, 3002, n - 3, n - 2]));
        const { q, m } = single(frames);
        checkInvariants(q);
        const want = expectGaps(frames);
        expect(want).toHaveLength(3);
        const g = q.sampleGaps;
        expect(g.status).toBe("DETECTED");
        expect(g.reasons).toContain(QV2_REASONS.gapsDetected);
        expect(g.gapCount).toBe(3);
        expect(g.gapCount).toBe(m.spacing.gapCount);
        expect(g.missingSamplesEstimate).toBe(7);
        expect(g.missingSamplesEstimate).toBe(m.spacing.missingSamplesEstimate);
        expect(g.maxGapSamples).toBe(3);
        expect(g.missingFraction).toBeCloseTo(m.spacing.missingFraction, 12);
        expect(g.gaps).toHaveLength(3);
        g.gaps.forEach((gap, i) => {
            const w = want[i];
            expect(gap.atTimeUs).toBe(w.atTimeUs);
            expect(gap.afterSampleIndex).toBe(w.afterSampleIndex);
            expect(gap.gapUs).toBe(w.gapUs);
            expect(gap.missingSamples).toBe(w.missingSamples);
            expect(gap.sweepFrequencyHz).not.toBeNull();
            expect(gap.sweepFrequencyHz!).toBeGreaterThanOrEqual(w.freqBefore - 1e-9);
            expect(gap.sweepFrequencyHz!).toBeLessThanOrEqual(w.freqAfter + 1e-9);
        });
    });

    it("gaps without a MEASURED observed sweep carry no sweep frequency", () => {
        const frames = dropFrames(sim({ firmwareDebug: false }), new Set([2000, 2001]));
        const { q } = single(frames);
        checkInvariants(q);
        expect(q.sampleGaps.status).toBe("DETECTED");
        expect(q.sampleGaps.gaps).toHaveLength(1);
        expect(q.sampleGaps.gaps[0].sweepFrequencyHz).toBeNull();
    });

    it("more than 32 gaps: 32 listed, truncated flag, counts cover all", () => {
        const drop = new Set(Array.from({ length: 40 }, (_, i) => 100 + i * 130));
        const frames = dropFrames(sim(), drop);
        const { q } = single(frames);
        checkInvariants(q);
        const want = expectGaps(frames);
        expect(want).toHaveLength(40);
        expect(q.sampleGaps.gapCount).toBe(40);
        expect(q.sampleGaps.missingSamplesEstimate).toBe(40);
        expect(q.sampleGaps.gaps).toHaveLength(32);
        expect(q.sampleGaps.gapsTruncated).toBe(true);
        const real = new Set(want.map((w) => w.afterSampleIndex));
        for (const gap of q.sampleGaps.gaps) {
            expect(real.has(gap.afterSampleIndex)).toBe(true);
        }
    });

    it("exactly 32 gaps is not truncated", () => {
        const drop = new Set(Array.from({ length: 32 }, (_, i) => 100 + i * 150));
        const { q } = single(dropFrames(sim(), drop));
        expect(q.sampleGaps.gapCount).toBe(32);
        expect(q.sampleGaps.gaps).toHaveLength(32);
        expect(q.sampleGaps.gapsTruncated).toBe(false);
    });

    it("non-increasing timestamps make the status DETECTED with timestamps_not_increasing", () => {
        const frames = sim().map((f, i) => (i === 3000 ? { ...f, time: f.time - 1000 } : f));
        const { q, m } = single(frames);
        checkInvariants(q);
        expect(m.spacing.nonPositiveDeltas).toBeGreaterThan(0);
        expect(q.sampleGaps.status).toBe("DETECTED");
        expect(q.sampleGaps.reasons).toContain(QV2_REASONS.timestampsNotIncreasing);
        expect(q.sampleGaps.nonPositiveDeltas).toBe(m.spacing.nonPositiveDeltas);
    });

    it("a CHIRP too short for a transfer function: no invented bins, gaps and quality not MEASURED", () => {
        const a = sim({ seconds: 2 });
        let t = a.at(-1)!.time;
        const tiny: SyntheticFrame[] = Array.from({ length: 2 }, (_, i) => ({
            time: (t += 1000),
            setpoint: [0, 50 * (i + 1), 0],
            gyro: [0, 10, 0],
            debug: [0, 1, 20 + i, 0],
        }));
        const { report } = run([...a, ...tiny]);
        expect(report.measurements).toHaveLength(2);
        const m = report.measurements[1];
        expect(m.sampleCount).toBe(2);
        const q = m.qualityV2;
        checkInvariants(q);
        expect(m.diagnostics).toBeNull();
        expect(q.levels.chirpDetected.status).toBe("YES");
        expect(q.levels.chirpQualityAvailable.status).toBe("NO");
        expect(q.levels.chirpQualityAvailable.reasons).toContain(QV2_REASONS.noTransferFunction);
        expect(q.coherence.bins.availability).not.toBe("MEASURED");
        expect(q.coherence.bins.frequencyHz).toEqual([]);
        expect(q.coherence.regions.items).toEqual([]);
        expect(q.coherence.meanBandCoherence.availability).not.toBe("MEASURED");
        expect(q.sweep.usableOfAnalysisBand.availability).not.toBe("MEASURED");
        expect(q.excitation.inputPowerPeakDb.availability).not.toBe("MEASURED");
        expect(q.levels.chirpQualified.status).toBe("NO");
        expect(q.levels.tuningAuthorized.status).toBe("NO");
    });

    it("a 1-sample CHIRP makes sample gaps UNKNOWN (too few timestamps)", () => {
        const a = sim({ seconds: 2 });
        const tiny: SyntheticFrame = {
            time: a.at(-1)!.time + 1000,
            setpoint: [0, 50, 0],
            gyro: [0, 10, 0],
            debug: [0, 1, 20, 0],
        };
        const { report } = run([...a, tiny]);
        const q = report.measurements[1].qualityV2;
        checkInvariants(q);
        expect(q.sampleGaps.status).toBe("UNKNOWN");
        expect(q.sampleGaps.reasons).toContain(QV2_REASONS.gapsUnknown);
    });
});

describe("saturation: motors only", () => {
    const n = SECONDS * FS;

    it("no motor fields: UNKNOWN motor_fields_missing, never NOT_DETECTED", () => {
        const { q } = base();
        expect(q.saturation.status).toBe("UNKNOWN");
        expect(q.saturation.reasons).toContain(QV2_REASONS.motorFieldsMissing);
        expect(q.saturation.motorUpper.value).toBeNull();
        expect(q.saturation.motorLower.value).toBeNull();
    });

    it("motor fields without a motorOutput range: UNKNOWN motor_output_range_unknown", () => {
        const frames = sim().map((f) => ({ ...f, motors: [1000, 1000, 1000, 1000] }));
        const { q } = single(frames, HEADERS, 4);
        checkInvariants(q);
        expect(q.saturation.status).toBe("UNKNOWN");
        expect(q.saturation.reasons).toContain(QV2_REASONS.motorRangeUnknown);
    });

    it("motors in range: NOT_DETECTED with motor-outputs-only scope", () => {
        const frames = sim().map((f) => ({ ...f, motors: [1000, 1500, 49, 2046] }));
        const { q } = single(frames, MOTOR_HEADERS, 4);
        checkInvariants(q);
        expect(q.saturation.status).toBe("NOT_DETECTED");
        expect(q.saturation.reasons).toContain(QV2_REASONS.saturationMotorsOnly);
        expect(q.saturation.motorUpper).toMatchObject({ availability: "MEASURED", value: { samples: 0, fraction: 0 } });
    });

    it("motors at or beyond each limit are counted per direction", () => {
        const frames = sim().map((f, i) => ({
            ...f,
            // 100 samples at the max (half exactly at, half above), 50 at the min (half at, half below).
            motors: [
                i < 50 ? 2047 : i < 100 ? 2100 : 1000,
                i >= 1000 && i < 1025 ? 48 : i >= 1025 && i < 1050 ? 10 : 1000,
                1000,
                1000,
            ],
        }));
        const { q } = single(frames, MOTOR_HEADERS, 4);
        checkInvariants(q);
        expect(q.saturation.status).toBe("DETECTED");
        expect(q.saturation.motorUpper.value!.samples).toBe(100);
        expect(q.saturation.motorUpper.value!.fraction).toBeCloseTo(100 / n, 12);
        expect(q.saturation.motorLower.value!.samples).toBe(50);
        expect(q.saturation.motorLower.value!.fraction).toBeCloseTo(50 / n, 12);
        expect(q.saturation.reasons).toEqual(
            expect.arrayContaining([QV2_REASONS.motorUpperDetected, QV2_REASONS.motorLowerDetected]),
        );
    });

    it("only the upper limit: lower is 0 and its reason absent", () => {
        const frames = sim().map((f, i) => ({ ...f, motors: [i === 10 ? 2047 : 1000, 1000, 1000, 1000] }));
        const { q } = single(frames, MOTOR_HEADERS, 4);
        expect(q.saturation.status).toBe("DETECTED");
        expect(q.saturation.motorUpper.value!.samples).toBe(1);
        expect(q.saturation.motorLower.value!.samples).toBe(0);
        expect(q.saturation.reasons).not.toContain(QV2_REASONS.motorLowerDetected);
    });

    it("saturation outside the CHIRP (idle frames between sweeps) is not counted", () => {
        const frames = simulateChirpSequence([
            { seconds: 2, axis: 0, firmwareDebug: true, startHz: 2, endHz: 200 },
            { seconds: 2, axis: 1, firmwareDebug: true, startHz: 2, endHz: 200 },
        ]).map((f) => ({ ...f, motors: f.debug[1] === -1 ? [2047, 48, 2047, 48] : [1000, 1000, 1000, 1000] }));
        const { report } = run(frames, MOTOR_HEADERS, 4);
        expect(report.measurements).toHaveLength(2);
        for (const m of report.measurements) {
            checkInvariants(m.qualityV2);
            expect(m.qualityV2.saturation.status).toBe("NOT_DETECTED");
        }
    });
});

describe("evidence levels and authorization", () => {
    it("levels mirror the existing verdicts, roles as documented", () => {
        const { m, q } = base();
        const l = q.levels;
        expect(l.chirpDetected.status).toBe("YES");
        expect(l.blackboxDataUsable.status).toBe(m.sampleRate.effectiveRateHz ? "YES" : "NO");
        expect(l.chirpQualityAvailable.status).toBe(m.diagnostics ? "YES" : "NO");
        expect(l.chirpQualified.status).toBe(m.state !== "rejected" ? "YES" : "NO");
        expect(l.tuningAuthorized.status).toBe(m.apply.allowed ? "YES" : "NO");
        expect(l.chirpQualified.role).toBe("ACTIVE_GATE");
        expect(l.tuningAuthorized.role).toBe("ACTIVE_GATE");
        for (const k of [
            "bblValid",
            "flightValid",
            "blackboxDataUsable",
            "chirpDetected",
            "chirpQualityAvailable",
        ] as const) {
            expect(l[k].role).toBe("DIAGNOSTIC");
        }
        expect(l.bblValid.status).toBe("UNKNOWN");
        expect(l.flightValid.status).toBe("UNKNOWN");
        expect(q.identity.file.reasons).toContain(QV2_REASONS.identityNotAttached);
    });

    it("a rejected measurement still has a quality report: lower levels never imply higher", () => {
        const { m, q } = single(sim({ amplitude: 3 }));
        checkInvariants(q);
        expect(m.state).toBe("rejected");
        expect(q.levels.chirpQualityAvailable.status).toBe("YES");
        expect(q.levels.chirpQualified.status).toBe("NO");
        expect(q.levels.chirpQualified.reasons).toContain(QV2_REASONS.chirpRejected);
        expect(q.levels.tuningAuthorized.status).toBe("NO");
        expect(q.levels.tuningAuthorized.reasons).toContain(QV2_REASONS.tuningBlocked);
    });

    it("qualityV2 is never read by a gate: garbling it changes no verdict on recompute", () => {
        const { report } = run(sim());
        const before = report.measurements.map((m) => ({ state: m.state, apply: m.apply, quality: m.quality }));
        for (const m of report.measurements) {
            // Shape kept, values flipped to the worst case.
            const q = m.qualityV2;
            q.coherence.usableBinCount.value = 0;
            q.coherence.meanBandCoherence.value = 0;
            q.levels.chirpQualified.status = "NO";
            q.saturation.status = "DETECTED";
            q.sampleGaps.status = "DETECTED";
        }
        recomputeRecommendations(report, 60, AUTOTUNE_MATH);
        expect(report.measurements.map((m) => ({ state: m.state, apply: m.apply, quality: m.quality }))).toEqual(
            before,
        );
        for (const m of report.measurements) {
            expect(authorizeMeasurement(m)).toEqual(m.apply);
        }
    });

    it("recomputing for another phase-margin target refreshes tuningAuthorized to the new verdict", () => {
        const { report } = run(sim());
        for (const pm of [30, 45, 60, 75, 90]) {
            recomputeRecommendations(report, pm, AUTOTUNE_MATH);
            for (const m of report.measurements) {
                expect(m.qualityV2.levels.tuningAuthorized.status).toBe(m.apply.allowed ? "YES" : "NO");
                checkInvariants(m.qualityV2);
            }
        }
    });

    it("the same bytes give the same qualityV2 JSON", () => {
        const bytes = encodeChirpLog(dropFrames(sim(), new Set([500, 501])));
        const a = qualify(bytes).measurements.map((m) => JSON.stringify(m.qualityV2));
        const b = qualify(bytes).measurements.map((m) => JSON.stringify(m.qualityV2));
        expect(a).toEqual(b);
    });
});

describe("identity (WU1) and multiple CHIRPs / Flights", () => {
    const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
    const twoChirpLog = (amp: number) =>
        encodeChirpLog(
            simulateChirpSequence([
                { seconds: 2, axis: 0, amplitude: amp, firmwareDebug: true, startHz: 2, endHz: 200 },
                { seconds: 2, axis: 1, amplitude: amp, firmwareDebug: true, startHz: 2, endHz: 200 },
                { seconds: 2, axis: 0, amplitude: amp, firmwareDebug: true, startHz: 2, endHz: 200 },
            ]),
            HEADERS,
        );

    it("two Flights with three CHIRPs each: ids, indices, FlightRefs and independence", async () => {
        const bytes = concatLogs(twoChirpLog(200), twoChirpLog(150));
        const report = qualify(bytes);
        expect(report.logCount).toBe(2);
        expect(report.measurements).toHaveLength(6);
        const verdicts = JSON.stringify(
            report.measurements.map((m) => [m.state, m.apply, m.quality, m.recommendation]),
        );
        const v2Before = report.measurements.map((m) => m.qualityV2);
        const v2BeforeJson = JSON.parse(JSON.stringify(v2Before)) as ChirpQualityV2[];

        await attachChirpFlightIdentity(report, bytes);
        expect(JSON.stringify(report.measurements.map((m) => [m.state, m.apply, m.quality, m.recommendation]))).toBe(
            verdicts,
        );

        const catalog = await catalogBbl(bytes);
        report.measurements.forEach((m, i) => {
            const q = m.qualityV2;
            checkInvariants(q);
            expect(q.identity.measurementId).toBe(m.id);
            expect(q.identity.logIndex).toBe(m.logIndex);
            expect(q.identity.chirpIndex).toBe(i % 3);
            expect(q.identity.axis).toBe(m.axis);
            expect(q.identity.axisOccurrence).toBe([1, 1, 2][i % 3]);
            expect(q.identity.sampleCount).toBe(m.sampleCount);
            expect(q.identity.startTimeUs).toBe(m.startTimeUs);
            expect(q.identity.endTimeUs).toBe(m.endTimeUs);
            expect(q.identity.file).toMatchObject({
                availability: "MEASURED",
                sha256: sha(bytes),
                byteLength: bytes.length,
            });
            expect(q.identity.flight.availability).toBe("MEASURED");
            expect(q.identity.flight.ref).toEqual(catalog.flights[m.logIndex]);
            expect(q.levels.bblValid.status).toBe("YES");
            expect(q.levels.flightValid.status).toBe("YES");
            expect(q.reasons).not.toContain(QV2_REASONS.identityNotAttached);
            // Everything but identity, levels and reasons is untouched by the attachment.
            const { identity: _i, levels: _l, reasons: _r, ...rest } = q;
            const { identity: _bi, levels: _bl, reasons: _br, ...restBefore } = v2BeforeJson[i];
            expect(JSON.parse(JSON.stringify(rest))).toEqual(restBefore);
        });
        const refs = report.measurements.map((m) => m.qualityV2.identity.flight.ref!);
        // Same Flight: one ref, never independent.
        expect(refs[0].locationId).toBe(refs[1].locationId);
        expect(refs[0].locationId).toBe(refs[2].locationId);
        expect(checkIndependentFlights(refs[0], refs[2]).independent).toBe(false);
        // Different Flights of distinct content: different refs, independent.
        expect(refs[0].locationId).not.toBe(refs[3].locationId);
        expect(checkIndependentFlights(refs[0], refs[3]).independent).toBe(true);
        // Measurement ids are unique across the file.
        expect(new Set(report.measurements.map((m) => m.qualityV2.identity.measurementId)).size).toBe(6);
    });

    it("the same Flight copied twice in one BBL is never two independent flights", async () => {
        const log = twoChirpLog(200);
        const bytes = concatLogs(log, log);
        const report = qualify(bytes);
        await attachChirpFlightIdentity(report, bytes);
        const a = report.measurements.find((m) => m.logIndex === 0)!.qualityV2.identity.flight.ref!;
        const b = report.measurements.find((m) => m.logIndex === 1)!.qualityV2.identity.flight.ref!;
        expect(a.locationId).not.toBe(b.locationId);
        expect(checkIndependentFlights(a, b).independent).toBe(false);
    });

    it("attaching is deterministic and idempotent", async () => {
        const bytes = twoChirpLog(200);
        const r1 = qualify(bytes);
        const r2 = qualify(bytes);
        await attachChirpFlightIdentity(r1, bytes);
        await attachChirpFlightIdentity(r2, bytes);
        const j1 = JSON.stringify(r1.measurements.map((m) => m.qualityV2));
        expect(JSON.stringify(r2.measurements.map((m) => m.qualityV2))).toBe(j1);
        await attachChirpFlightIdentity(r1, bytes);
        expect(JSON.stringify(r1.measurements.map((m) => m.qualityV2))).toBe(j1);
    });

    it("without Web Crypto the identity stays UNKNOWN and the analysis is unaffected", async () => {
        const bytes = twoChirpLog(200);
        const report = qualify(bytes);
        const before = JSON.parse(JSON.stringify(report.measurements.map((m) => m.qualityV2))) as ChirpQualityV2[];
        const verdicts = JSON.stringify(report.measurements.map((m) => [m.state, m.apply]));
        vi.stubGlobal("crypto", {});
        await expect(attachChirpFlightIdentity(report, bytes)).resolves.not.toThrow();
        vi.unstubAllGlobals();
        expect(JSON.stringify(report.measurements.map((m) => [m.state, m.apply]))).toBe(verdicts);
        report.measurements.forEach((m, i) => {
            const q = m.qualityV2;
            checkInvariants(q);
            expect(q.identity.file.availability).toBe("UNKNOWN");
            expect(q.identity.file.sha256).toBeNull();
            expect(q.identity.flight.ref).toBeNull();
            expect(q.reasons).toContain(QV2_REASONS.identityHashUnavailable);
            expect(q.levels.bblValid.status).toBe("UNKNOWN");
            expect(q.levels.flightValid.status).toBe("UNKNOWN");
            expect(JSON.parse(JSON.stringify(q.coherence))).toEqual(before[i].coherence);
            expect(JSON.parse(JSON.stringify(q.sweep))).toEqual(before[i].sweep);
        });
    });

    it("every CHIRP of a multi-CHIRP log passes the bin and region checks", () => {
        const report = qualify(twoChirpLog(200));
        for (const m of report.measurements) {
            checkInvariants(m.qualityV2);
            if (m.diagnostics) {
                checkBins(m);
                checkRegions(m.qualityV2);
            }
        }
    });
});

describe("further edge cases", () => {
    it("observed sweep outside the requested start is clipped: coverage stays within [0, 1]", () => {
        // Observed 1 -> 200 Hz, requested 2 -> 200 Hz: overlap is the whole requested range.
        const wide = single(sim({ startHz: 1 })).q;
        checkInvariants(wide);
        expect(wide.sweep.observed.availability).toBe("MEASURED");
        expect(wide.sweep.observedOfRequested.value!).toBeLessThanOrEqual(1);
        expect(wide.sweep.observedOfRequested.value!).toBeGreaterThan(0.99);
        // Observed 0.5 -> 1.5 Hz only: no overlap, coverage 0, never negative.
        const below = single(withFreq(sim(), (i) => 5 + Math.floor((10 * i) / (SECONDS * FS)))).q;
        checkInvariants(below);
        expect(below.sweep.observed.availability).toBe("MEASURED");
        expect(below.sweep.observedOfRequested.value).toBe(0);
    });

    it("1 % fallback guard counts every step: 59 falls in 5999 steps is MEASURED, 61 is UNKNOWN", () => {
        const at = (count: number, spacing: number) =>
            new Set(Array.from({ length: count }, (_, j) => 50 + j * spacing));
        const f59 = at(59, 100);
        const ok = single(withFreq(sim(), (i, old) => (f59.has(i) ? 5 : old))).q;
        expect(ok.sweep.observed.availability).toBe("MEASURED");
        expect(ok.sweep.observed.runs).toBe(60);
        const f61 = at(61, 97);
        const bad = single(withFreq(sim(), (i, old) => (f61.has(i) ? 5 : old))).q;
        expect(bad.sweep.observed.availability).toBe("UNKNOWN");
        expect(bad.sweep.observed.reasons).toContain(QV2_REASONS.observedChannelNotMonotonic);
    });

    it("each CHIRP of a sequence reads only its own slice of the frequency channel and its own amplitude header", () => {
        const headers = [
            ...without(HEADERS, "chirp_amplitude_roll"),
            "chirp_amplitude_roll:111",
            "chirp_amplitude_pitch:222",
            "chirp_amplitude_yaw:333",
        ];
        const frames = simulateChirpSequence(
            [0, 1, 2].map((axis) => ({
                seconds: 2,
                axis: axis as 0 | 1 | 2,
                firmwareDebug: true,
                startHz: 2,
                endHz: 200,
            })),
        );
        const { report } = run(frames, headers);
        expect(report.measurements.map((m) => m.axis)).toEqual([0, 1, 2]);
        report.measurements.forEach((m, i) => {
            const q = m.qualityV2;
            checkInvariants(q);
            expect(q.sweep.observed.availability).toBe("MEASURED");
            expect(q.sweep.observed.runs).toBe(1);
            expect(q.sweep.observed.startHz).toBeCloseTo(2, 1);
            expect(q.sweep.observed.minHz).toBeGreaterThan(1.5);
            expect(q.sweep.requested.amplitude).toBe([111, 222, 333][i]);
            expect(q.excitation.requestedAmplitude.value).toBe([111, 222, 333][i]);
            expect(q.identity.axis).toBe(i);
            expect(q.identity.chirpIndex).toBe(i);
            expect(q.identity.durationS).toBeCloseTo(m.durationS, 12);
            checkBins(m);
            checkRegions(q);
        });
    });

    it("high-resolution scaling never touches the firmware debug channels", () => {
        const frames = sim();
        const ref = single(frames).q;
        const { q, m } = single(frames, [...HEADERS, "blackbox_high_resolution:1"]);
        checkInvariants(q);
        expect(q.sweep.observed).toEqual(ref.sweep.observed);
        expect(q.excitation.firmwareExcitation).toEqual(ref.excitation.firmwareExcitation);
        expect(q.excitation.setpointRms.value).toBeCloseTo(m.quality.inputRms, 9);
    });

    it("requested end above Nyquist: bins stop below Nyquist", () => {
        const headers = withHeader(HEADERS, "chirp_frequency_end_deci_hz:6000");
        const { m, q } = single(sim({ endHz: 499 }), headers);
        checkInvariants(q);
        checkBins(m);
        checkRegions(q);
        expect(Math.max(...q.coherence.bins.frequencyHz)).toBeLessThan(500);
    });

    it("region mean powers lie within their bins' powers", () => {
        for (const q of [base().q, single(sim({ endHz: 100 })).q]) {
            const b = q.coherence.bins;
            let at = 0;
            for (const r of q.coherence.regions.items) {
                for (const [mean, arr] of [
                    [r.meanInputPowerDb, b.inputPowerDb],
                    [r.meanOutputPowerDb, b.outputPowerDb],
                ] as const) {
                    const vals = arr.slice(at, at + r.binCount).filter((v): v is number => v !== null);
                    if (vals.length === 0) {
                        expect(mean).toBeNull();
                    } else {
                        expect(mean!).toBeGreaterThanOrEqual(Math.min(...vals) - 1e-9);
                        expect(mean!).toBeLessThanOrEqual(Math.max(...vals) + 1e-9);
                    }
                }
                at += r.binCount;
            }
        }
    });

    it("gap rule: 1.5 x median is not a gap; 2.5 x median is one gap of rint(2.5) - 1 = 1 missing sample", () => {
        const frames = sim().map((f, i) => ({ ...f, time: f.time + (i >= 3000 ? 1500 : 0) + (i >= 4000 ? 500 : 0) }));
        const { q, m } = single(frames);
        checkInvariants(q);
        expect(m.spacing.gapCount).toBe(1);
        expect(q.sampleGaps.gapCount).toBe(1);
        expect(q.sampleGaps.gaps).toHaveLength(1);
        expect(q.sampleGaps.gaps[0]).toMatchObject({ afterSampleIndex: 2999, gapUs: 2500, missingSamples: 1 });
        expect(q.sampleGaps.missingSamplesEstimate).toBe(m.spacing.missingSamplesEstimate);
    });

    it("chirp_time_seconds of 0 or negative never yields an Infinity or negative duration coverage", () => {
        for (const v of ["0", "-5"]) {
            const { q } = single(sim(), withHeader(HEADERS, `chirp_time_seconds:${v}`));
            checkInvariants(q);
            const d = q.sweep.durationOfRequested;
            expect(d.availability).not.toBe("MEASURED");
        }
    });

    it("an inverted or one-sided motorOutput header is not a valid range", () => {
        const frames = sim().map((f) => ({ ...f, motors: [1000, 1000, 1000, 1000] }));
        for (const line of ["motorOutput:2047,48", "motorOutput:48"]) {
            const { q } = single(frames, [...HEADERS, line], 4);
            checkInvariants(q);
            expect(q.saturation.status).toBe("UNKNOWN");
            expect(q.saturation.reasons).toContain(QV2_REASONS.motorRangeUnknown);
        }
    });

    it("a duplicated timestamp (zero step) is non-increasing too", () => {
        const frames = sim().map((f, i, all) => (i === 2000 ? { ...f, time: all[1999].time } : f));
        const { q, m } = single(frames);
        checkInvariants(q);
        expect(m.spacing.nonPositiveDeltas).toBeGreaterThan(0);
        expect(q.sampleGaps.status).toBe("DETECTED");
        expect(q.sampleGaps.reasons).toContain(QV2_REASONS.timestampsNotIncreasing);
    });

    it("gaps in a restarted sweep carry the frequency of the run they fall in", () => {
        const a = sim({ seconds: 3 });
        const b = sim({ seconds: 3, startTimeUs: a.at(-1)!.time + 1000 });
        const frames = dropFrames([...a, ...b], new Set([3010, 3011]));
        const { q } = single(frames);
        checkInvariants(q);
        expect(q.sweep.observed.runs).toBe(2);
        expect(q.sampleGaps.gaps).toHaveLength(1);
        const g = q.sampleGaps.gaps[0];
        expect(g.afterSampleIndex).toBe(3009);
        // Just after the restart: near the start frequency, not near the end of the first run.
        expect(g.sweepFrequencyHz!).toBeLessThan(5);
    });
});
