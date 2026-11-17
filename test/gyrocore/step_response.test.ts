/*
 * Step response setpoint → gyro (src/gyrocore/stepResponse/stepResponse.ts) on synthetic data with a
 * known response. Acceptance criteria fixed before verification (dossier PLAN.md, 2026-11-17) and in
 * docs/gyrocore/STEP_RESPONSE.md §7.
 */
import { describe, expect, it } from "vitest";
import {
    analyzeAxisStep,
    cleanEvidence,
    deconvolveStep,
    fftLengthFor,
    manoeuvreIds,
    responseSamples,
    stepMetrics,
    STEP_METHOD,
    STEP_WINDOW_REASONS,
    type StepThresholdResult,
} from "@/gyrocore/stepResponse/stepResponse";
import { rms, simulate, stickSetpoint, trueStep, withNoise, type SecondOrder } from "./harness/stepSynth";

const FS = 2000;
const PLANT: SecondOrder = { fnHz: 20, zeta: 0.5, delayMs: 5, gain: 1 };

function run(sp: Float64Array, gy: Float64Array, fs = FS, ev = cleanEvidence(sp.length), epsilonRel?: number) {
    return analyzeAxisStep({ sampleRateHz: fs, setpoint: sp, gyro: gy, evidence: ev, epsilonRel });
}
const at = (r: ReturnType<typeof run>, thr: 40 | 80) => r.thresholds.find((t) => t.thresholdDegS === thr)!;
const at80 = (r: ReturnType<typeof run>) => at(r, 80);
const sumCounts = (t: StepThresholdResult) => Object.values(t.rejected).reduce((a, b) => a + b, 0) + t.windowsUsed;

describe("method constants", () => {
    it("2 s windows every 0.4 s, 500 ms curve, FFT long enough that the response never wraps", () => {
        expect(STEP_METHOD.windowS).toBe(2);
        expect(STEP_METHOD.hopS).toBe(0.4);
        expect(responseSamples(4000)).toBe(2001);
        expect(fftLengthFor(8000, 4000)).toBe(16384);
        expect(fftLengthFor(8000, 4000)).toBeGreaterThanOrEqual(8000 + 2001);
        expect(fftLengthFor(2000, 1000)).toBe(4096);
    });
});

describe("stepMetrics", () => {
    it("overshoot is peak − 1, t50 interpolated at 0.5, final value over 200–500 ms", () => {
        const fs = 1000;
        const c = new Float64Array(501).map((_, k) => (k < 10 ? k / 10 : k < 40 ? 1.2 : 0.9));
        const m = stepMetrics(c, fs);
        expect(m.overshoot).toBeCloseTo(0.2, 12);
        expect(m.peakTimeMs).toBe(10);
        expect(m.t50Ms).toBeCloseTo(5, 12);
        expect(m.finalValue).toBeCloseTo(0.9, 12);
    });
    it("t50 is 0 when the curve starts at or above 0.5", () => {
        expect(stepMetrics(new Float64Array(501).fill(0.7), 1000).t50Ms).toBe(0);
    });
    it("t50 is null when the curve never reaches 0.5; overshoot may be negative", () => {
        const m = stepMetrics(new Float64Array(501).fill(0.4), 1000);
        expect(m.t50Ms).toBeNull();
        expect(m.overshoot).toBeCloseTo(-0.6, 12);
    });
});

describe("known second-order system with delay and gain (criteria 1–2)", () => {
    for (const gain of [1, 0.8]) {
        const p = { ...PLANT, gain };
        const ref = stepMetrics(trueStep(FS, p), FS);
        const sp = stickSetpoint({ seconds: 30, fs: FS, seed: 7 });
        const gy = simulate(sp, FS, p);
        it(`noise-free, gain ${gain}: final ±0.03, overshoot ±0.03, peak and t50 ±2 ms; gain kept, not scaled to 1`, () => {
            const t = at(run(sp, gy), 80);
            expect(t.status).toBe("MEASURED");
            expect(Math.abs(t.metrics!.finalValue - gain)).toBeLessThanOrEqual(0.03);
            expect(Math.abs(t.metrics!.overshoot - ref.overshoot)).toBeLessThanOrEqual(0.03);
            expect(Math.abs(t.metrics!.peakTimeMs - ref.peakTimeMs)).toBeLessThanOrEqual(2);
            expect(Math.abs(t.metrics!.t50Ms! - ref.t50Ms!)).toBeLessThanOrEqual(2);
        });
        it(`20 dB SNR, gain ${gain}: final and overshoot ±0.06, peak and t50 ±4 ms`, () => {
            const t = at(run(sp, withNoise(gy, rms(gy) / 10, 3)), 80);
            expect(t.status).toBe("MEASURED");
            expect(Math.abs(t.metrics!.finalValue - gain)).toBeLessThanOrEqual(0.06);
            expect(Math.abs(t.metrics!.overshoot - ref.overshoot)).toBeLessThanOrEqual(0.06);
            expect(Math.abs(t.metrics!.peakTimeMs - ref.peakTimeMs)).toBeLessThanOrEqual(4);
            expect(Math.abs(t.metrics!.t50Ms! - ref.t50Ms!)).toBeLessThanOrEqual(4);
        });
    }
    it("a longer delay moves t50 and the peak by that delay (time zero = lag 0)", () => {
        const sp = stickSetpoint({ seconds: 30, fs: FS, seed: 11 });
        const a = at(run(sp, simulate(sp, FS, PLANT)), 80).metrics!;
        const b = at(run(sp, simulate(sp, FS, { ...PLANT, delayMs: 15 })), 80).metrics!;
        expect(b.t50Ms! - a.t50Ms!).toBeGreaterThan(9);
        expect(b.t50Ms! - a.t50Ms!).toBeLessThan(11);
        expect(b.peakTimeMs - a.peakTimeMs).toBeCloseTo(10, 0);
    });
    it("the same curve at 1, 2 and 4 kHz (the method scales with the sample rate)", () => {
        const out = [1000, 2000, 4000].map((fs) => {
            const sp = stickSetpoint({ seconds: 20, fs, seed: 5 });
            return at(run(sp, simulate(sp, fs, PLANT), fs), 80).metrics!;
        });
        for (const m of out) {
            expect(Math.abs(m.finalValue - 1)).toBeLessThan(0.03);
            expect(Math.abs(m.t50Ms! - out[2].t50Ms!)).toBeLessThan(1.5);
            expect(Math.abs(m.overshoot - out[2].overshoot)).toBeLessThan(0.03);
        }
    });
});

describe("ε (criterion 3)", () => {
    const ref = stepMetrics(trueStep(FS, PLANT), FS);
    const sp = stickSetpoint({ seconds: 30, fs: FS, seed: 7 });
    const gy = withNoise(simulate(sp, FS, PLANT), rms(simulate(sp, FS, PLANT)) / 10, 3);
    const err = (eps: number) => {
        const m = at(run(sp, gy, FS, cleanEvidence(sp.length), eps), 80).metrics!;
        return { final: Math.abs(m.finalValue - 1), overshoot: Math.abs(m.overshoot - ref.overshoot) };
    };
    it("the chosen ε gives a final-value error ≤ 0.03 and an overshoot error ≤ 0.03", () => {
        const e = err(STEP_METHOD.epsilonRel);
        expect(e.final).toBeLessThanOrEqual(0.03);
        expect(e.overshoot).toBeLessThanOrEqual(0.03);
    });
    it("ε matters both ways: 100× larger flattens the overshoot, 100× smaller lets the noise through", () => {
        const chosen = err(STEP_METHOD.epsilonRel).overshoot;
        expect(err(STEP_METHOD.epsilonRel * 100).overshoot).toBeGreaterThan(chosen + 0.03);
        expect(err(STEP_METHOD.epsilonRel / 100).overshoot).toBeGreaterThan(chosen + 0.03);
    });
    it("ε is relative: a setpoint offset or a different unit scale gives the same curve (DC kept, not detrended)", () => {
        const sp0 = stickSetpoint({ seconds: 30, fs: FS, seed: 9, maxDegS: 250 });
        const base = at(run(sp0, simulate(sp0, FS, PLANT)), 80).metrics!;
        const off = sp0.map((v) => v + 150);
        const withOffset = at(run(off, simulate(off, FS, PLANT)), 80).metrics!;
        expect(Math.abs(withOffset.finalValue - base.finalValue)).toBeLessThan(0.02);
        expect(Math.abs(withOffset.overshoot - base.overshoot)).toBeLessThan(0.02);
        const win = 4000;
        const a = deconvolveStep(sp0.subarray(0, win), simulate(sp0, FS, PLANT).subarray(0, win), FS)!;
        const b = deconvolveStep(
            sp0.subarray(0, win).map((v) => v * 10),
            simulate(sp0, FS, PLANT)
                .subarray(0, win)
                .map((v) => v * 10),
            FS,
        )!;
        for (let k = 0; k < a.length; k += 50) expect(b[k]).toBeCloseTo(a[k], 9);
    });
});

describe("window position: the peak must lie in the centre band (Grok r1 SHOULD-FIX-1)", () => {
    const fs = 1000;
    const p = { ...PLANT, gain: 0.8 };
    const ref = stepMetrics(trueStep(fs, p), fs);
    /** One 150 ms flick with its onset at sample `at` of a single 2 s window. */
    const single = (at: number) => {
        const raw = new Float64Array(2000);
        raw.fill(200, at, at + 150);
        let s = 0;
        const sp = raw.map((v) => (s += 0.2 * (v - s)));
        return { sp, gy: simulate(sp, fs, p) };
    };
    it("an event in the outer part of the window is biased by the taper (the reason for the rule)", () => {
        const { sp, gy } = single(1700);
        const m = stepMetrics(deconvolveStep(sp, gy, fs)!, fs);
        expect(Math.abs(m.overshoot - ref.overshoot)).toBeGreaterThan(0.05);
    });
    it("events whose peak lies in the centre band are within 0.03 of the truth", () => {
        for (const at of [700, 900, 1100, 1200]) {
            const { sp, gy } = single(at);
            const m = stepMetrics(deconvolveStep(sp, gy, fs)!, fs);
            expect(Math.abs(m.overshoot - ref.overshoot)).toBeLessThanOrEqual(0.03);
            expect(Math.abs(m.finalValue - 0.8)).toBeLessThanOrEqual(0.03);
        }
    });
    it("a window whose peak is outside the band is rejected as peak_off_centre", () => {
        for (const [at, used] of [
            [100, 0],
            [1700, 0],
            [900, 1],
        ] as const) {
            const { sp, gy } = single(at);
            const t = at80(run(sp, gy, fs));
            expect(t.windowsUsed).toBe(used);
            expect(t.rejected.peak_off_centre).toBe(1 - used);
        }
    });
    it("a smaller flick next to a larger one is not counted (fixed on purpose, docs §3)", () => {
        const make = (flicks: [number, number][]) => {
            const raw = new Float64Array(10 * fs);
            for (const [t, amp] of flicks) raw.fill(amp, Math.round(t * fs), Math.round(t * fs) + 150);
            let s = 0;
            return raw.map((v) => (s += 0.2 * (v - s)));
        };
        const alone = make([[5, 120]]);
        expect(at80(run(alone, simulate(alone, fs, p), fs)).manoeuvres).toBe(1);
        const next = make([
            [4, 200],
            [5, 120],
        ]);
        expect(at80(run(next, simulate(next, fs, p), fs)).manoeuvres).toBe(1);
        const apart = make([
            [4, 200],
            [6, 120],
        ]);
        expect(at80(run(apart, simulate(apart, fs, p), fs)).manoeuvres).toBe(2);
    });
    it("the band is wider than the hop, so every isolated flick keeps at least one window", () => {
        expect((STEP_METHOD.centreBand[1] - STEP_METHOD.centreBand[0]) * STEP_METHOD.windowS).toBeGreaterThan(
            STEP_METHOD.hopS,
        );
    });
});

describe("excitation measure: the 100 ms change", () => {
    it("near-constant input above 80 deg/s is rejected as insufficient_change", () => {
        const sp = withNoise(new Float64Array(10 * FS).fill(150), 2, 1);
        const gy = simulate(sp, FS, PLANT);
        const t = at(run(sp, gy), 80);
        expect(t.windowsUsed).toBe(0);
        expect(t.rejected.insufficient_change).toBe(t.windowsTotal);
        expect(t.status).toBe("INSUFFICIENT");
    });
    it("a slow ramp passes the peak test but not the change test, and would give a wrong curve", () => {
        const n = 2 * FS;
        const ramp = new Float64Array(n).map((_, i) => (200 * i) / n);
        const gy = simulate(ramp, FS, PLANT);
        expect(at(run(ramp, gy), 80).rejected.insufficient_change).toBe(1);
        // forced through the deconvolution, the ramp window misses the response badly
        const ref = trueStep(FS, PLANT);
        const forced = deconvolveStep(ramp, gy, FS)!;
        const flick = stickSetpoint({ seconds: 2, fs: FS, seed: 4 });
        const good = deconvolveStep(flick, simulate(flick, FS, PLANT), FS)!;
        const maxErr = (c: Float64Array) => Math.max(...Array.from(c.subarray(0, 200), (v, k) => Math.abs(v - ref[k])));
        expect(maxErr(forced)).toBeGreaterThan(0.2);
        expect(maxErr(good)).toBeLessThan(0.1);
    });
    it("zero input is below the threshold", () => {
        const sp = new Float64Array(6 * FS);
        const t = at(run(sp, sp.slice()), 40);
        expect(t.rejected.input_below_threshold).toBe(t.windowsTotal);
    });
    it("above 500 deg/s is rejected as input_above_max", () => {
        const sp = stickSetpoint({ seconds: 10, fs: FS, seed: 2, minDegS: 600, maxDegS: 700 });
        const t = at(run(sp, simulate(sp, FS, PLANT)), 80);
        expect(t.rejected.input_above_max).toBeGreaterThan(0);
        expect(t.windowsUsed).toBe(0);
    });
    it("the 40 and 80 deg/s thresholds differ when the moves are between them", () => {
        const sp = stickSetpoint({ seconds: 20, fs: FS, seed: 6, minDegS: 50, maxDegS: 70 });
        const r = run(sp, simulate(sp, FS, PLANT));
        expect(at(r, 40).status).toBe("MEASURED");
        expect(at(r, 80).windowsUsed).toBe(0);
        expect(at(r, 80).rejected.input_below_threshold).toBeGreaterThan(0);
    });
});

describe("exclusions (criterion 4)", () => {
    const sp = stickSetpoint({ seconds: 20, fs: FS, seed: 8 });
    const gy = simulate(sp, FS, PLANT);
    const n = sp.length;
    const W = 2 * FS;
    const hop = 0.4 * FS;
    /** Windows [s, s+W) that contain sample i strictly after their start. */
    const windowsOver = (i: number) => {
        let c = 0;
        for (let s = 0; s + W <= n; s += hop) if (i > s && i < s + W) c++;
        return c;
    };
    it("a local frame gap excludes only the windows over it", () => {
        const ev = cleanEvidence(n);
        ev.gapBefore[10 * FS] = 1;
        const clean = at(run(sp, gy), 80);
        const t = at(run(sp, gy, FS, ev), 80);
        expect(t.rejected.frame_gap).toBe(windowsOver(10 * FS));
        // the gap windows are counted under frame_gap; no other window is lost to the gap
        expect(t.windowsUsed).toBeGreaterThanOrEqual(clean.windowsUsed - t.rejected.frame_gap);
        expect(sumCounts(t)).toBe(clean.windowsTotal);
        expect(t.status).toBe("MEASURED");
    });
    const cases: [string, (ev: ReturnType<typeof cleanEvidence>) => void, (typeof STEP_WINDOW_REASONS)[number]][] = [
        ["not airborne", (ev) => ev.notAirborne.fill(1, 9 * FS, 9 * FS + 10), "not_airborne"],
        ["saturation", (ev) => ev.saturated!.fill(1, 9 * FS, 9 * FS + 10), "saturation"],
        ["ANGLE / HORIZON", (ev) => ev.selfLevel.fill(1, 9 * FS, 9 * FS + 10), "self_level_or_automation"],
        ["a mode switch", (ev) => ev.modeWord.fill(3, 9 * FS), "mode_change"],
        ["an active CHIRP", (ev) => ev.chirp.fill(1, 9 * FS, 9 * FS + 10), "chirp_active"],
    ];
    for (const [name, mark, reason] of cases) {
        it(`${name}: the windows over it are counted under ${reason}`, () => {
            const ev = cleanEvidence(n);
            mark(ev);
            const t = at(run(sp, gy, FS, ev), 80);
            expect(t.rejected[reason]).toBeGreaterThan(0);
            expect(sumCounts(t)).toBe(t.windowsTotal);
        });
    }
    it("NaN and Inf exclude only the windows that contain them", () => {
        const bad = sp.slice();
        bad[5 * FS] = Number.NaN;
        bad[15 * FS] = Number.POSITIVE_INFINITY;
        const t = at(run(bad, gy), 80);
        expect(t.rejected.non_finite).toBeGreaterThan(0);
        expect(t.rejected.non_finite).toBeLessThanOrEqual(windowsOver(5 * FS) + windowsOver(15 * FS) + 2);
        expect(t.windowsUsed).toBeGreaterThan(0);
    });
    it("precedence: one reason per window, the counts add up to the windows examined", () => {
        const ev = cleanEvidence(n);
        ev.gapBefore[9 * FS + 5] = 1;
        ev.selfLevel.fill(1, 9 * FS, 9 * FS + 10);
        const t = at(run(sp, gy, FS, ev), 80);
        expect(t.rejected.self_level_or_automation).toBe(0); // the gap comes first
        expect(sumCounts(t)).toBe(t.windowsTotal);
    });
    it("missing saturation evidence is unknown: windows are not excluded, the result says so", () => {
        const r = run(sp, gy, FS, cleanEvidence(n, false));
        expect(r.saturationKnown).toBe(false);
        expect(at(r, 80).rejected.saturation).toBe(0);
    });
    it("below 500 Hz is BLOCKED; a misaligned evidence array is BLOCKED", () => {
        const low = stickSetpoint({ seconds: 20, fs: 400, seed: 1 });
        expect(run(low, simulate(low, 400, PLANT), 400).status).toBe("BLOCKED");
        expect(run(low, simulate(low, 400, PLANT), 400).reasons[0]).toMatch(/^sample_rate_below_minimum/);
        expect(run(sp, gy, FS, cleanEvidence(n - 1)).status).toBe("BLOCKED");
    });
});

describe("manoeuvres (criterion 5)", () => {
    it("one manoeuvre that appears in five windows counts once", () => {
        const fs = FS;
        const n = 4 * fs;
        const sp = new Float64Array(n);
        const raw = new Float64Array(n);
        // inside the windows starting at 0.4, 0.8, 1.2, 1.6 and 2.0 s, not in the one ending at 2.0 s
        raw.fill(250, Math.round(2.05 * fs), Math.round(2.3 * fs));
        let s = 0;
        for (let i = 0; i < n; i++) sp[i] = s += 0.12 * (raw[i] - s);
        const t = at(run(sp, simulate(sp, fs, PLANT), fs), 80);
        expect(t.windowsTotal).toBe(6);
        // the flick lies in 5 windows; the ones whose centre band (40–70 %) misses its peak are
        // peak_off_centre, the rest all belong to the same single manoeuvre
        expect(t.rejected.input_below_threshold).toBe(1);
        expect(t.rejected.peak_off_centre + t.windowsUsed).toBe(5);
        expect(t.windowsUsed).toBeGreaterThanOrEqual(1);
        expect(t.manoeuvres).toBe(1);
        expect(t.status).toBe("INSUFFICIENT");
        expect(t.reasons[0]).toBe(`manoeuvres_below_minimum:1<${STEP_METHOD.minManoeuvres}`);
    });
    it("a log of exactly one window gives one window", () => {
        const sp = stickSetpoint({ seconds: 2, fs: FS, seed: 3 });
        const t = at(run(sp, simulate(sp, FS, PLANT)), 80);
        expect(t.windowsTotal).toBe(1);
        expect(t.status).toBe("INSUFFICIENT");
    });
    it("runs closer than 0.2 s merge, longer than 2 s split", () => {
        const fs = 1000;
        const x = new Float64Array(6000);
        x.fill(100, 100, 300);
        x.fill(100, 400, 600); // 100 ms apart: same manoeuvre
        x.fill(100, 1000, 1200); // 400 ms later: next one
        x.fill(100, 2000, 5000); // 3 s: split into two
        const ids = manoeuvreIds(x, 80, fs);
        expect(ids[150]).toBe(ids[450]);
        expect(ids[1100]).toBe(ids[450] + 1);
        expect(ids[2100]).not.toBe(ids[4900]);
        expect(ids[350]).toBe(ids[150]); // the short pause belongs to the merged manoeuvre
        expect(ids[800]).toBe(-1);
    });
    it("every manoeuvre weighs the same: a manoeuvre with many windows does not dominate", () => {
        // two flights of identical plant but one long manoeuvre added: the mean barely moves
        const sp = stickSetpoint({ seconds: 20, fs: FS, seed: 21 });
        const r = at(run(sp, simulate(sp, FS, PLANT)), 80);
        expect(r.manoeuvres).toBeGreaterThanOrEqual(STEP_METHOD.minManoeuvres);
        expect(r.windowsUsed).toBeGreaterThan(r.manoeuvres);
        expect(r.curve!.mean.length).toBe(responseSamples(FS));
        for (let k = 0; k < r.curve!.mean.length; k += 100) {
            expect(r.curve!.p25[k]).toBeLessThanOrEqual(r.curve!.p75[k] + 1e-12);
        }
    });
    it(`the minimum of ${STEP_METHOD.minManoeuvres}: below it the overshoot error is clearly larger (seeded Monte Carlo, 14 dB SNR)`, () => {
        const fs = 1000;
        const p = { ...PLANT };
        const ref = stepMetrics(trueStep(fs, p), fs);
        const few: number[] = [];
        const enough: number[] = [];
        for (let seed = 1; seed <= 40; seed++) {
            for (const seconds of [3, 12]) {
                const sp = stickSetpoint({ seconds, fs, seed: seed * 7919 });
                const g0 = simulate(sp, fs, p);
                const t = at(run(sp, withNoise(g0, rms(g0) / 5, seed), fs), 80);
                if (!t.metrics) continue;
                const e = Math.abs(t.metrics.overshoot - ref.overshoot);
                if (t.manoeuvres <= 3) few.push(e);
                else if (t.manoeuvres >= STEP_METHOD.minManoeuvres) enough.push(e);
            }
        }
        const p90 = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(0.9 * (a.length - 1))];
        expect(few.length).toBeGreaterThan(10);
        expect(enough.length).toBeGreaterThan(10);
        expect(p90(enough)).toBeLessThanOrEqual(0.12);
        expect(p90(few)).toBeGreaterThan(p90(enough) * 1.4);
    });
});

describe("final value outside 0.5–1.5", () => {
    it("is flagged, kept in the primary result, and reported separately without those windows", () => {
        const sp = stickSetpoint({ seconds: 20, fs: FS, seed: 12 });
        const t = at(run(sp, simulate(sp, FS, { ...PLANT, gain: 0.3 })), 80);
        expect(t.finalValueOutliers).toBe(t.windowsUsed);
        expect(t.status).toBe("MEASURED");
        expect(t.metrics!.finalValue).toBeCloseTo(0.3, 1);
        expect(t.withoutOutliers.manoeuvres).toBe(0);
        expect(t.withoutOutliers.status).toBe("INSUFFICIENT");
    });
    it("a normal flight has no outliers and the same secondary result", () => {
        const sp = stickSetpoint({ seconds: 20, fs: FS, seed: 12 });
        const t = at(run(sp, simulate(sp, FS, PLANT)), 80);
        expect(t.finalValueOutliers).toBe(0);
        expect(t.withoutOutliers.metrics).toEqual(t.metrics);
    });
});

describe("battery voltage over the used windows", () => {
    it("is the median of the logged voltage inside the used windows only", () => {
        const sp = stickSetpoint({ seconds: 20, fs: FS, seed: 61 });
        const gy = simulate(sp, FS, PLANT);
        // 380 everywhere except 420 inside the first 4 s: the median follows where the used windows are
        const vb = new Float64Array(sp.length).fill(380);
        vb.fill(420, 0, 4 * FS);
        const ev = cleanEvidence(sp.length);
        ev.notAirborne.fill(1, 4 * FS); // only the first 4 s can be used
        const t = analyzeAxisStep({ sampleRateHz: FS, setpoint: sp, gyro: gy, evidence: ev, battery: vb })
            .thresholds[1];
        expect(t.windowsUsed).toBeGreaterThan(0);
        expect(t.batteryMedian).toBe(420);
        expect(
            analyzeAxisStep({ sampleRateHz: FS, setpoint: sp, gyro: gy, evidence: ev }).thresholds[1].batteryMedian,
        ).toBeNull();
    });
});
