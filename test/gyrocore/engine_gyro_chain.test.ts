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
 * Notch-aware gyro chain (src/gyrocore/engine/gyroChain.ts) against known ground truth:
 * the SVF FRF against the recurrence it describes, notch depth and fade, the dynamic notch
 * finding a tone, the RPM filter following eRPM, and the time-domain chain against the
 * analytic FRF for a fixed state.
 */

import { describe, expect, it } from "vitest";
import { cmag, cphaseDeg } from "../../src/js/blackbox/betaflight_digital_controller";
import {
    chainConfigFromHeaders,
    chainFrf,
    effectiveChainFrf,
    rpmNotchCoeffs,
    simulateGyroChain,
    svfFrf,
    type GyroChainConfig,
} from "../../src/gyrocore/engine/gyroChain";

const PID_DT = 250e-6;

function cfg(over: Partial<GyroChainConfig> = {}): GyroChainConfig {
    return {
        gyroDt: 125e-6,
        pidDt: PID_DT,
        lpf1Type: 0,
        lpf1StaticHz: 150,
        lpf1DynMinHz: 0,
        lpf1DynMaxHz: 0,
        lpf1DynExpo: 0,
        lpf2Type: 0,
        lpf2StaticHz: 0,
        notch1Hz: 0,
        notch2Hz: 0,
        rpmHarmonics: 0,
        rpmMinHz: 100,
        rpmFadeRangeHz: 50,
        rpmQ: 500,
        rpmWeights: [100, 100, 100],
        rpmLpfHz: 150,
        motorPoles: 12,
        dynNotchCount: 0,
        dynNotchQ: 300,
        dynNotchMinHz: 100,
        dynNotchMaxHz: 700,
        ...over,
    };
}

/** Steady-state gain / phase of a recurrence on a sine, by projection over whole cycles. */
function measureSine(apply: (x: number) => number, f: number, dt: number) {
    const n = Math.round(4 / dt);
    let re = 0;
    let im = 0;
    let cnt = 0;
    for (let k = 0; k < n; k++) {
        const y = apply(Math.sin(2 * Math.PI * f * k * dt));
        if (k > n / 2) {
            re += y * Math.sin(2 * Math.PI * f * k * dt);
            im += y * Math.cos(2 * Math.PI * f * k * dt);
            cnt++;
        }
    }
    return { gain: (2 * Math.hypot(re, im)) / cnt, phaseDeg: (Math.atan2(im, re) * 180) / Math.PI };
}

function input(n: number, gen: (k: number, axis: number) => number, erpm: number[] = [], throttle = 1400) {
    const timeUs = Float64Array.from({ length: n }, (_, k) => k * PID_DT * 1e6);
    const g = [0, 1, 2].map((a) => Float64Array.from({ length: n }, (_, k) => gen(k, a))) as [
        Float64Array,
        Float64Array,
        Float64Array,
    ];
    return {
        timeUs,
        gyroUnfilt: g,
        erpm: erpm.map((v) => new Float64Array(n).fill(v)),
        rcThrottle: new Float64Array(n).fill(throttle),
    };
}

describe("SVF notch: analytic FRF of the firmware recurrence", () => {
    it("matches the recurrence on sines and is a notch at its centre", () => {
        const c = rpmNotchCoeffs(200, PID_DT, 5, 1);
        for (const f of [20, 80, 180, 200, 230, 600]) {
            const s = { s1: 0, s2: 0 };
            const apply = (x: number) => {
                const v3 = x - s.s2;
                const v1 = c.a1 * s.s1 + c.a2 * v3;
                const v2 = s.s2 + c.f * v1;
                s.s1 = 2 * v1 - s.s1;
                s.s2 = 2 * v2 - s.s2;
                return x - c.wq * v1;
            };
            const m = measureSine(apply, f, PID_DT);
            const H = svfFrf(c, { re: Math.cos(2 * Math.PI * f * PID_DT), im: Math.sin(2 * Math.PI * f * PID_DT) });
            expect(m.gain, `gain @${f}`).toBeCloseTo(cmag(H), 2);
            if (cmag(H) > 0.05) expect(m.phaseDeg, `phase @${f}`).toBeCloseTo(cphaseDeg(H), 0);
        }
        const centre = svfFrf(c, {
            re: Math.cos(2 * Math.PI * 200 * PID_DT),
            im: Math.sin(2 * Math.PI * 200 * PID_DT),
        });
        expect(cmag(centre)).toBeLessThan(1e-6);
    });

    it("a half-weight notch only halves the centre (rpm_filter weights / fade)", () => {
        const c = rpmNotchCoeffs(200, PID_DT, 5, 0.5);
        const H = svfFrf(c, { re: Math.cos(2 * Math.PI * 200 * PID_DT), im: Math.sin(2 * Math.PI * 200 * PID_DT) });
        expect(cmag(H)).toBeCloseTo(0.5, 6);
    });
});

describe("time-domain chain", () => {
    it("static lpf1 + lpf2: the simulation equals the analytic FRF", () => {
        const c = cfg({ lpf2StaticHz: 300 });
        for (const f of [10, 40, 120]) {
            const sim = simulateGyroChain(
                input(16000, (k) => Math.sin(2 * Math.PI * f * k * PID_DT)),
                c,
            );
            let re = 0;
            let im = 0;
            let cnt = 0;
            for (let k = 8000; k < 16000; k++) {
                re += sim.out[0][k] * Math.sin(2 * Math.PI * f * k * PID_DT);
                im += sim.out[0][k] * Math.cos(2 * Math.PI * f * k * PID_DT);
                cnt++;
            }
            const H = chainFrf({ ...c, gyroDt: PID_DT }, { lpf1Hz: 150, rpmNotches: [], dynNotchHz: [] }, f);
            expect((2 * Math.hypot(re, im)) / cnt).toBeCloseTo(cmag(H), 2);
            expect((Math.atan2(im, re) * 180) / Math.PI).toBeCloseTo(cphaseDeg(H), 0);
        }
    });

    it("the RPM filter follows eRPM: a motor-frequency tone is removed, its weight fades near min_hz", () => {
        // 12 poles: eRPM/100 = 120 → 120·100/60/6 = 33.3 Hz?  Use 720 → 200 Hz fundamental.
        const tone = (k: number) =>
            Math.sin(2 * Math.PI * 200 * k * PID_DT) + 0.5 * Math.sin(2 * Math.PI * 400 * k * PID_DT);
        const c = cfg({ rpmHarmonics: 2, lpf1StaticHz: 0 });
        const sim = simulateGyroChain(input(12000, tone, [720, 720, 720, 720]), c);
        expect(sim.rpmHz[0][0][11000]).toBeCloseTo(200, 3);
        expect(sim.rpmHz[0][1][11000]).toBeCloseTo(400, 3);
        expect(sim.rpmWeight[0][0][11000]).toBe(1);
        let rms = 0;
        for (let k = 10000; k < 12000; k++) rms += sim.postRpm[0][k] ** 2;
        expect(Math.sqrt(rms / 2000)).toBeLessThan(0.01);
        // 120 Hz fundamental: 20 Hz above min_hz 100 with fade 50 → weight 0.4.
        const near = simulateGyroChain(
            input(8000, () => 0, [432, 432, 432, 432]),
            c,
        );
        expect(near.rpmWeight[0][0][7000]).toBeCloseTo(0.4, 3);
    });

    it("the dynamic notch finds a resonance and settles on it", () => {
        const c = cfg({ dynNotchCount: 1, lpf1StaticHz: 0 });
        const noise = (k: number, a: number) =>
            Math.sin(2 * Math.PI * 333 * k * PID_DT) * (a === 0 ? 50 : 1) + Math.sin(k * 1.7 + a);
        const sim = simulateGyroChain(input(16000, noise), c);
        const centre = sim.dynNotchHz[0][0][15999];
        expect(Math.abs(centre - 333)).toBeLessThan(8);
        let rmsIn = 0;
        let rmsOut = 0;
        for (let k = 14000; k < 16000; k++) {
            rmsIn += (50 * Math.sin(2 * Math.PI * 333 * k * PID_DT)) ** 2;
            rmsOut += sim.out[0][k] ** 2;
        }
        expect(Math.sqrt(rmsOut / rmsIn)).toBeLessThan(0.2);
    });

    it("refuses what it does not model instead of approximating it", () => {
        const sim = simulateGyroChain(
            input(4000, () => 0),
            cfg({ notch1Hz: 200, lpf2Type: 1, lpf2StaticHz: 300 }),
        );
        expect(sim.notes).toEqual(["gyro_lpf2_type_not_pt1", "gyro_static_notch_not_modelled"]);
        expect(sim.valid.every((v) => v === 0)).toBe(true);
    });
});

describe("effective (LTI stand-in) response over a window", () => {
    it("is exact for a fixed state and reports its spread for a moving one", () => {
        const c = cfg({ rpmHarmonics: 1, lpf1StaticHz: 150 });
        const fixed = simulateGyroChain(
            input(8000, () => 0, [720, 720, 720, 720]),
            c,
        );
        const eff = effectiveChainFrf(fixed, c, 0, 0, 8000)!;
        const H = chainFrf(
            c,
            { lpf1Hz: 150, rpmNotches: [0, 1, 2, 3].map(() => ({ hz: 200, weight: 1 })), dynNotchHz: [] },
            60,
        );
        expect(cmag(eff.frf(60))).toBeCloseTo(cmag(H), 6);
        expect(eff.spread(60).phaseDeg).toBeLessThan(1e-6);
        const sweep = input(8000, () => 0, [], 1400);
        sweep.erpm = [0, 1, 2, 3].map(() => Float64Array.from({ length: 8000 }, (_, k) => 450 + (k / 8000) * 900));
        const moving = simulateGyroChain(sweep, c);
        expect(effectiveChainFrf(moving, c, 0, 0, 8000)!.spread(100).phaseDeg).toBeGreaterThan(1);
    });

    it("reads its configuration from blackbox headers", () => {
        const c = chainConfigFromHeaders({
            looptime: "125",
            pid_process_denom: "2",
            gyro_lpf1_type: "0",
            gyro_lpf1_static_hz: "150",
            gyro_lpf1_dyn_hz: "150,300",
            gyro_lpf1_dyn_expo: "5",
            gyro_lpf2_type: "0",
            gyro_lpf2_static_hz: "300",
            rpm_filter_harmonics: "2",
            rpm_filter_weights: "100,100,100",
            motor_poles: "12",
            dyn_notch_count: "2",
        })!;
        expect([c.pidDt, c.lpf1DynMinHz, c.lpf1DynMaxHz, c.rpmHarmonics, c.motorPoles, c.dynNotchCount]).toEqual([
            250e-6, 150, 300, 2, 12, 2,
        ]);
        expect(chainConfigFromHeaders({ looptime: "125" })).toBeNull();
    });
});
