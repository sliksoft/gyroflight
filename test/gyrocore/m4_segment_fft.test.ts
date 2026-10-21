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
 * GF-1 M4.2: flight segmentation, segmented Welch spectrum and CHIRP / stick
 * isolation, through encoded BBL bytes and the Blackbox Viewer decode.
 * SYNTHETIC logs only.
 */

import { describe, expect, it } from "vitest";
import { analyzeM4BblFile, type M4LogReport } from "../../src/js/blackbox/m4_bbl_integration";
import { segmentFlightLog, type SampleRange } from "../../src/js/blackbox/m4_segmentation";
import { welchPowerSpectrum } from "../../src/js/blackbox/spectral_analysis";
import { encodeLog, type SyntheticFrame } from "./harness/bblWriter";

const ARM = 1;
const ANGLE = 2;
const CHIRP = 1 << 6;

type Kind = "steps" | "hover" | "chirp" | "bigError";

interface Phase {
    s: number;
    flags: number;
    thr: number;
    kind: Kind;
    /** Sinusoid added to gyro in this phase. */
    toneHz?: number;
    toneAmp?: number;
    erpm?: number;
}

interface BuildOpts {
    rateHz?: number;
    /** Drop one frame (time skips one interval) every N frames. */
    dropEvery?: number;
    /** Insert a time jump of this many ms before frame index `longGapAt`. */
    longGapMs?: number;
    longGapAt?: number;
    slowFields?: boolean;
    throttle?: boolean;
    debugMode?: number;
    seed?: number;
}

function lcg(seed: number) {
    let x = seed >>> 0;
    return () => {
        x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
        return x / 2 ** 32 - 0.5;
    };
}

function buildLog(phases: Phase[], o: BuildOpts = {}) {
    const rate = o.rateHz ?? 1000;
    const dt = 1e6 / rate;
    const rnd = lcg(o.seed ?? 7);
    const frames: SyntheticFrame[] = [];
    const sFrames: { atFrame: number; flightModeFlags: number }[] = [];
    let t = 1_000_000;
    let y0 = 0;
    let y1 = 0;
    let prevY = 0;
    let k = 0;
    for (const ph of phases) {
        if (frames.length) sFrames.push({ atFrame: frames.length, flightModeFlags: ph.flags });
        const n = Math.round(ph.s * rate);
        for (let i = 0; i < n; i++, k++) {
            const ts = i / rate;
            let sp = 0;
            if (ph.kind === "steps" || ph.kind === "bigError")
                sp = i % Math.round(0.4 * rate) < Math.round(0.2 * rate) ? 300 : -150;
            else if (ph.kind === "chirp")
                sp = 200 * Math.sin(2 * Math.PI * (2 * ts + ((100 - 2) / (2 * ph.s)) * ts * ts));
            y0 = y0 * 0.85 + sp * 0.15;
            y1 = y1 * 0.85 + sp * 0.15;
            const tone = ph.toneHz ? (ph.toneAmp ?? 20) * Math.sin(2 * Math.PI * ph.toneHz * ts) : 0;
            const big = ph.kind === "bigError" ? 400 * Math.sin(2 * Math.PI * 7 * ts) : 0;
            const g0 = Math.round(y0 + tone + big + 2 * rnd());
            const g1 = Math.round(y1 + tone + 2 * rnd());
            const d = Math.round(-(y0 - prevY) * 4 + 4 * rnd());
            prevY = y0;
            const erpm = ph.erpm ?? 1500;
            const extra = [d, d, erpm, erpm, erpm, erpm, ...(o.throttle === false ? [] : [ph.thr])];
            frames.push({
                time: Math.round(t),
                setpoint: [Math.round(sp), Math.round(sp), 0],
                gyro: [g0, g1, Math.round(2 * rnd())],
                debug: [0, ph.kind === "chirp" ? 0 : -1, 0, 0],
                motors: [1200, 1200, 1200, 1200],
                extra,
            });
            t += dt;
            if (o.dropEvery && k > 0 && k % o.dropEvery === 0) t += dt;
            if (o.longGapMs && k + 1 === o.longGapAt) t += o.longGapMs * 1000;
        }
    }
    return encodeLog(frames, {
        iInterval: 32,
        flightModeFlags: phases[0].flags,
        sFrames,
        slowFields: o.slowFields,
        debugMode: o.debugMode ?? 0,
        pidProcessDenom: Math.round(8000 / rate),
        motorCount: 4,
        extraHeaders: [
            "gyro_lpf1_static_hz:150",
            "dterm_lpf1_static_hz:75",
            "motor_poles:12",
            "rpm_filter_harmonics:2",
        ],
        extraFields: [
            "axisD[0]",
            "axisD[1]",
            "eRPM[0]",
            "eRPM[1]",
            "eRPM[2]",
            "eRPM[3]",
            ...(o.throttle === false ? [] : ["rcCommand[3]"]),
        ],
    });
}

function run(phases: Phase[], o?: BuildOpts): M4LogReport {
    const report = analyzeM4BblFile(buildLog(phases, o), "synthetic.bbl");
    expect(report.error).toBeNull();
    return report.logs[0];
}

const ground = (s: number): Phase => ({ s, flags: ARM, thr: 1000, kind: "hover", erpm: 400 });
const stick = (s: number, extra: Partial<Phase> = {}): Phase => ({ s, flags: ARM, thr: 1400, kind: "steps", ...extra });
const hover = (s: number, extra: Partial<Phase> = {}): Phase => ({ s, flags: ARM, thr: 1400, kind: "hover", ...extra });
const chirp = (s: number): Phase => ({ s, flags: ARM | CHIRP, thr: 1400, kind: "chirp" });
const disarmed = (s: number): Phase => ({ s, flags: 0, thr: 1000, kind: "hover", erpm: 0 });

function inside(r: SampleRange, outer: SampleRange[]) {
    return outer.some((o) => r.start >= o.start && r.end <= o.end);
}

function covered(ranges: SampleRange[]) {
    return ranges.reduce((s, r) => s + r.end - r.start, 0);
}

describe("ground time is excluded", () => {
    it("armed idle and disarmed samples never reach stick, spectrum or eRPM", () => {
        const log = run([ground(2), stick(6), disarmed(1)]);
        const seg = log.segmentation!;
        expect(seg.status).toBe("segmented");
        expect(seg.durationsS.armed_low_throttle).toBeCloseTo(2, 1);
        expect(seg.durationsS.ground_or_disarmed).toBeCloseTo(1, 1);
        // 6 s of throttle-up minus two 0.5 s transitions.
        expect(seg.durationsS.stick).toBeCloseTo(5, 1);
        for (const r of [...seg.stick, ...seg.spectrum, ...seg.flight]) {
            expect(r.start).toBeGreaterThanOrEqual(2500);
            expect(r.end).toBeLessThanOrEqual(7500);
        }
        // Ground eRPM 400 / disarmed 0 would pull the median down if counted.
        expect(log.result!.filters.rpmFilter.estimatedFundamentalHz).toBeCloseTo((1500 * 200) / 60 / 12, 6);
    });

    it("a gyro tone present only on the ground is not reported as a flight resonance", () => {
        const log = run([{ ...ground(3), toneHz: 300, toneAmp: 60 }, hover(8, { toneHz: 120, toneAmp: 20 })]);
        const peaks = log.result!.filters.gyroLpf.spectrum[0].peaks.map((p) => p.frequencyHz);
        expect(peaks.some((f) => Math.abs(f - 120) < 5)).toBe(true);
        expect(peaks.some((f) => Math.abs(f - 300) < 10)).toBe(false);
    });

    it("throttle-up shorter than the minimum flight time is a transition, not flight", () => {
        const log = run([ground(1), stick(0.8), ground(1)]);
        expect(log.segmentation!.flight).toEqual([]);
        expect(log.segmentation!.durationsS.flight_transition).toBeCloseTo(0.8, 1);
        expect(log.result!.feedforward.advice).toBe("blocked");
    });
});

describe("multiple flight segments", () => {
    it("two flights separated by a landing give two stick segments, never bridged", () => {
        const log = run([ground(1), stick(4), ground(2), stick(4), ground(1)]);
        const seg = log.segmentation!;
        expect(seg.stick).toHaveLength(2);
        expect(seg.stick[0].end).toBeLessThanOrEqual(4500);
        expect(seg.stick[1].start).toBeGreaterThanOrEqual(7500);
        const ff = log.result!.feedforward;
        expect(ff.stickSegmentCount).toBe(2);
        expect(ff.stickDurationS).toBeCloseTo(6, 1);
        expect(ff.advice).toBe("measurement_only");
        expect(ff.axes[0].meanAbsError.limitations).toContain("combined_over_2_segments");
    });
});

describe("gaps in the time series", () => {
    it("dropped frames split every analysis range but do not end the flight", () => {
        const log = run([ground(1), hover(10, { toneHz: 120 })], { dropEvery: 700 });
        const seg = log.segmentation!;
        expect(seg.gapCount).toBeGreaterThan(10);
        expect(seg.longGapCount).toBe(0);
        // One flight run (only the take-off / landing trims), split at each dropped frame.
        expect(seg.durationsS.flight_transition).toBeCloseTo(1, 1);
        expect(seg.spectrum.length).toBeGreaterThan(10);
        const report = log.timestampSpacing!;
        expect(report.gapCount).toBe(seg.gapCount);
        // No range contains a gap: every range is uniformly spaced inside.
        expect(seg.spectrum.every((r) => r.end - r.start <= 701)).toBe(true);
        expect(log.result!.filters.gyroLpf.measurement.welchSegments).toBeGreaterThan(0);
    });

    it("a long gap ends the flight run and both edges are trimmed", () => {
        const log = run([ground(1), hover(8)], { longGapMs: 200, longGapAt: 5000 });
        const seg = log.segmentation!;
        expect(seg.longGapCount).toBe(1);
        expect(seg.durationsS.flight_transition).toBeCloseTo(2, 1);
        expect(seg.flight.every((r) => r.end <= 4500 || r.start >= 5500)).toBe(true);
    });
});

describe("sample rate", () => {
    it.each([1000, 2000])("%i Hz log: timestamp rate used, tone found at its frequency", (rate) => {
        const log = run([ground(1), hover(8, { toneHz: 150, toneAmp: 20 })], { rateHz: rate });
        expect(log.sampleRate!.analysisRateHz).toBeCloseTo(rate, 0);
        expect(log.sampleRate!.analysisRateSource).toBe("timestamps_uniform");
        const m = log.result!.filters.gyroLpf.measurement;
        expect(m.binWidthHz).toBeCloseTo(rate / m.segmentSize, 6);
        const peak = log.result!.filters.gyroLpf.spectrum[0].peaks[0];
        expect(Math.abs(peak.frequencyHz - 150)).toBeLessThanOrEqual(m.binWidthHz);
    });

    it("Welch PSD integrates to the signal power (scaling check)", () => {
        const fs = 1000;
        const x = Float64Array.from({ length: 8192 }, (_, i) => 10 * Math.sin((2 * Math.PI * 100 * i) / fs));
        const ps = welchPowerSpectrum(x, fs, 512)!;
        const df = fs / 512;
        const total = ps.psd.reduce((s, v) => s + v * df, 0);
        expect(total).toBeCloseTo(50, 0); // A^2 / 2
        expect(welchPowerSpectrum(x.subarray(0, 100), fs, 512)).toBeNull();
    });
});

describe("CHIRP / stick isolation", () => {
    const mixed = (middle: Phase) => [ground(1), stick(4), middle, stick(4), ground(1)];

    it("stick segments around a CHIRP are analysed; CHIRP and its guard band are excluded", () => {
        const log = run(mixed(chirp(6)));
        const seg = log.segmentation!;
        expect(log.chirp.status).toBe("chirp");
        expect(seg.chirp.length).toBeGreaterThan(0);
        expect(seg.durationsS.chirp_guard).toBeCloseTo(0.5, 1);
        for (const r of seg.stick) {
            expect(inside(r, seg.chirp)).toBe(false);
            expect(r.end <= 4750 || r.start >= 11250).toBe(true);
        }
        const ff = log.result!.feedforward;
        expect(ff.stickSource).toBe("isolated_segments");
        expect(ff.chirpRejectedForStickFf).toBe(false);
        expect(ff.chirpSamplesExcluded).toBe(true);
        expect(ff.advice).toBe("measurement_only");
        expect(ff.optimalFeedforward).toBeNull();
    });

    it("whatever happens during CHIRP cannot change the stick FF metrics", () => {
        const a = run(mixed(chirp(6))).result!.feedforward;
        const b = run(mixed({ s: 6, flags: ARM | CHIRP, thr: 1400, kind: "bigError" })).result!.feedforward;
        expect(b.stickDurationS).toBeCloseTo(a.stickDurationS, 6);
        for (let i = 0; i < 3; i++) {
            expect(b.axes[i].meanAbsError.value).toBeCloseTo(a.axes[i].meanAbsError.value, 9);
            expect(b.axes[i].latencyMs.value).toBeCloseTo(a.axes[i].latencyMs.value, 9);
        }
        // The same disturbance without the CHIRP flag is stick data and does change them.
        const c = run(mixed({ s: 6, flags: ARM, thr: 1400, kind: "bigError" })).result!.feedforward;
        expect(Math.abs(c.axes[0].meanAbsError.value - a.axes[0].meanAbsError.value)).toBeGreaterThan(1);
    });

    it("a CHIRP-only log has no stick data: FF blocked, no fallback", () => {
        const log = run([ground(1), chirp(10), ground(1)]);
        const ff = log.result!.feedforward;
        expect(log.segmentation!.stick).toEqual([]);
        expect(ff.advice).toBe("blocked");
        expect(ff.reason).toBe("no_valid_stick_segments");
        expect(ff.axes).toEqual([]);
        expect(ff.aggregate).toBeNull();
        // CHIRP is excluded from the noise spectrum as well.
        expect(log.result!.filters.gyroLpf.measurement.welchSegments).toBe(0);
        expect(log.result!.filters.gyroLpf.spectrum.every((s) => s.peaks.length === 0)).toBe(true);
        expect(log.result!.filters.gyroLpf.notes).toContain("no_flight_segment_long_enough_for_fft");
    });
});

describe("missing armed status / uncertain classification", () => {
    it("no flightModeFlags column: unclassifiable, FF blocked, no spectrum peaks", () => {
        const log = run([ground(1), stick(8, { toneHz: 120 })], { slowFields: false });
        expect(log.signals.missing).toContain("flightModeFlags");
        const seg = log.segmentation!;
        expect(seg.status).toBe("unclassifiable");
        expect(seg.reasons).toContain("flight_mode_flags_missing_arm_state_unknown");
        const r = log.result!;
        expect(r.feedforward.advice).toBe("blocked");
        expect(r.feedforward.axes).toEqual([]);
        expect(r.dTerm.axes.every((a) => a.usableWindowCount === 0)).toBe(true);
        expect(r.filters.gyroLpf.spectrum.every((s) => s.peaks.length === 0)).toBe(true);
        expect(r.filters.rpmFilter.estimatedFundamentalHz).toBeNull();
    });

    it("no throttle column: unclassifiable", () => {
        const log = run([ground(1), stick(8)], { throttle: false });
        expect(log.segmentation!.status).toBe("unclassifiable");
        expect(log.segmentation!.reasons).toContain("throttle_rccommand3_missing");
        expect(log.result!.feedforward.advice).toBe("blocked");
    });

    it("angle mode: setpoint is not stick rate, so no stick segment (spectrum still used)", () => {
        const log = run([ground(1), stick(8, { flags: ARM | ANGLE, toneHz: 120 })]);
        const seg = log.segmentation!;
        expect(seg.stick).toEqual([]);
        expect(seg.durationsS.flight_self_level).toBeCloseTo(7, 1);
        expect(log.result!.feedforward.reason).toBe("no_valid_stick_segments");
        expect(log.result!.filters.gyroLpf.measurement.welchSegments).toBeGreaterThan(0);
    });

    it("acro hover without stick input is flight but not stick data", () => {
        const log = run([ground(1), hover(8)]);
        expect(log.segmentation!.durationsS.flight_no_stick_input).toBeCloseTo(7, 1);
        expect(log.segmentation!.stick).toEqual([]);
        expect(log.result!.feedforward.advice).toBe("blocked");
    });

    it("unit: unknown mode flags (-1) are invalid, never flight", () => {
        const n = 3000;
        const seg = segmentFlightLog({
            timeUs: Float64Array.from({ length: n }, (_, i) => i * 1000),
            flightModeFlags: Int32Array.from({ length: n }, () => -1),
            throttle: Float64Array.from({ length: n }, () => 1500),
            failsafePhase: null,
            setpoint: [new Float64Array(n).fill(300), new Float64Array(n), new Float64Array(n)],
            sampleRateHz: 1000,
        });
        expect(seg.status).toBe("segmented");
        expect(seg.flight).toEqual([]);
        expect(seg.durationsS.invalid).toBeCloseTo(3, 6);
        expect(seg.reasons).toContain("failsafe_phase_missing_not_checked");
    });

    it("unit: failsafe rows are invalid", () => {
        const n = 4000;
        const seg = segmentFlightLog({
            timeUs: Float64Array.from({ length: n }, (_, i) => i * 1000),
            flightModeFlags: Int32Array.from({ length: n }, () => ARM),
            throttle: Float64Array.from({ length: n }, () => 1500),
            failsafePhase: Float64Array.from({ length: n }, (_, i) => (i >= 2000 ? 1 : 0)),
            setpoint: [new Float64Array(n), new Float64Array(n), new Float64Array(n)],
            sampleRateHz: 1000,
        });
        expect(seg.durationsS.invalid).toBeCloseTo(2, 6);
        expect(covered(seg.flight)).toBe(1000);
    });
});

describe("short FFT segments and spectral reliability", () => {
    it("ranges shorter than one Welch segment are skipped, not zero-padded", () => {
        // Gaps every 200 frames: every range < 256-sample Welch segment at 1 kHz.
        const log = run([ground(1), hover(6, { toneHz: 120 })], { dropEvery: 200 });
        const m = log.result!.filters.gyroLpf.measurement;
        expect(m.segmentSize).toBe(256);
        expect(m.shortRangesSkipped).toBe(m.rangeCount);
        expect(m.welchSegments).toBe(0);
        expect(m.reliability).toBe("insufficient");
        expect(log.result!.filters.gyroLpf.advice).toBe("not_advised");
        expect(log.result!.filters.gyroLpf.spectrum.every((s) => s.peaks.length === 0)).toBe(true);
    });

    it("too little flight spectrum: peaks withheld (low reliability)", () => {
        const log = run([ground(1), hover(2.2, { toneHz: 120, toneAmp: 40 }), ground(1)]);
        const m = log.result!.filters.gyroLpf.measurement;
        expect(m.welchSegments).toBeGreaterThan(0);
        expect(m.reliability).toBe("low");
        expect(m.peaksReported).toBe(false);
        expect(log.result!.filters.gyroLpf.spectrum[0].peaks).toEqual([]);
        expect(log.result!.filters.gyroLpf.notes).toContain("peaks_withheld_low_spectral_reliability");
        expect(log.result!.filters.informationalCandidates).toEqual([]);
    });

    it("pure noise produces no prominent peak", () => {
        const log = run([ground(1), hover(10)]);
        expect(log.result!.filters.gyroLpf.measurement.reliability).toBe("high");
        for (const s of log.result!.filters.gyroLpf.spectrum) {
            for (const p of s.peaks) expect(p.prominenceDb!).toBeGreaterThanOrEqual(6);
        }
    });
});

describe("insufficient FF and D-term data", () => {
    it("stick time below the FF gate is not_advised; D reports no windows outside stick", () => {
        const log = run([ground(1), stick(3), hover(6)]);
        const ff = log.result!.feedforward;
        expect(ff.stickDurationS).toBeLessThan(3);
        expect(ff.advice).toBe("not_advised");
        expect(ff.reason).toBe("insufficient_stick_segment_duration_for_ff");
        expect(ff.optimalFeedforward).toBeNull();
    });

    it("no stick segment: D-term has no usable windows and no advice", () => {
        const log = run([ground(1), hover(8)]);
        const d = log.result!.dTerm;
        expect(d.axes.every((a) => a.usableWindowCount === 0)).toBe(true);
        expect(d.axes[0].limitations).toContain("no_stick_segments");
        expect(d.advice).toBe("not_advised");
        expect(log.result!.m2m3Safety).toMatchObject({
            applyAllowed: false,
            recommendationsEnabled: false,
            independentPidValidation: "BLOCKED",
        });
        expect(log.result!.filters.dynamicNotch.advice).toBe("blocked");
        expect(log.result!.filters.rpmFilter.scheduleUnknown).toBe(true);
    });
});
