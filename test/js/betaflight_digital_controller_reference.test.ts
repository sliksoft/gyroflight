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
 * GF-1 M1: independent digital controller reference tests.
 *
 * Analytic H(z) (evaluateControllerFrf) is compared to a separate time-domain
 * simulator that mirrors the firmware recurrence (FirmwarePidAxisSimulator).
 * They share scales/gains but not the same closed-form algebra path.
 */

import { describe, expect, it } from "vitest";
import {
    AIR65_BBL_CONTROLLER,
    FIRMWARE_REVISION_PINNED,
    FirmwarePidAxisSimulator,
    PTERM_SCALE,
    ITERM_SCALE,
    DTERM_SCALE,
    FEEDFORWARD_SCALE,
    air65RollConfig,
    air65YawConfig,
    classifyModelParts,
    cmag,
    cphaseDeg,
    csub,
    evaluateControllerFrf,
    evaluateGyroLpfFrf,
    measureFrfFromSimulator,
    phaseCompCoeffs,
    phaseCompHz,
    pidCoefficients,
    pt1Gain,
    pt1Hz,
    type Complex,
    type DigitalControllerConfig,
} from "../../src/js/blackbox/betaflight_digital_controller";

const FREQS = [5, 10, 20, 40, 80, 120];

function magErrDb(a: Complex, b: Complex): number {
    return 20 * Math.log10(cmag(a) / cmag(b));
}

function phaseErrDeg(a: Complex, b: Complex): number {
    let d = cphaseDeg(a) - cphaseDeg(b);
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    return d;
}

function assertFrfClose(label: string, analytic: Complex, measured: Complex, magTolDb: number, phaseTolDeg: number) {
    const md = magErrDb(measured, analytic);
    const pd = phaseErrDeg(measured, analytic);
    expect(Math.abs(md), `${label} mag dB=${md.toFixed(3)}`).toBeLessThan(magTolDb);
    expect(Math.abs(pd), `${label} phase deg=${pd.toFixed(3)}`).toBeLessThan(phaseTolDeg);
}

describe("GF-1 M1 firmware constants", () => {
    it("pins the required firmware revision and published PID scales", () => {
        expect(FIRMWARE_REVISION_PINNED.startsWith("43875a55")).toBe(true);
        expect(AIR65_BBL_CONTROLLER.firmwareRevision).toContain("43875a55a");
        expect(PTERM_SCALE).toBeCloseTo(0.032029, 6);
        expect(ITERM_SCALE).toBeCloseTo(0.244381, 6);
        expect(DTERM_SCALE).toBeCloseTo(0.000529, 6);
        expect(FEEDFORWARD_SCALE).toBeCloseTo(0.013754, 6);
    });
});

describe("1. P-only unity-feedback", () => {
    const cfg: DigitalControllerConfig = {
        gyroDt: 250e-6,
        pidDt: 250e-6,
        axis: { p: 50, i: 0, d: 0, f: 0 },
    };

    it("C_reference = C_feedback = Kp (analytic and TD agree)", () => {
        const Kp = pidCoefficients(cfg).Kp;
        for (const f of FREQS) {
            const frf = evaluateControllerFrf(cfg, f);
            expect(frf.cReference.re).toBeCloseTo(Kp, 5);
            expect(frf.cReference.im).toBeCloseTo(0, 5);
            expect(frf.cFeedback.re).toBeCloseTo(Kp, 5);
            const measR = measureFrfFromSimulator(() => new FirmwarePidAxisSimulator(cfg), {
                freqHz: f,
                pidDt: cfg.pidDt,
                mode: "reference",
            });
            const measF = measureFrfFromSimulator(() => new FirmwarePidAxisSimulator(cfg), {
                freqHz: f,
                pidDt: cfg.pidDt,
                mode: "feedback",
            });
            assertFrfClose(`P-only ref @${f}`, frf.cReference, measR, 0.15, 1.5);
            assertFrfClose(`P-only fb @${f}`, frf.cFeedback, measF, 0.15, 1.5);
        }
    });
});

describe("2. PI controller", () => {
    const cfg: DigitalControllerConfig = {
        gyroDt: 250e-6,
        pidDt: 250e-6,
        axis: { p: 56, i: 79, d: 0, f: 0 },
    };

    it("matches TD simulator across the band", () => {
        for (const f of FREQS) {
            const frf = evaluateControllerFrf(cfg, f);
            const meas = measureFrfFromSimulator(() => new FirmwarePidAxisSimulator(cfg), {
                freqHz: f,
                pidDt: cfg.pidDt,
                mode: "reference",
            });
            assertFrfClose(`PI @${f}`, frf.cReference, meas, 0.25, 2.5);
            expect(cmag(frf.cReference)).toBeGreaterThan(pidCoefficients(cfg).Kp); // I adds at low f
        }
    });
});

describe("3. D-term on gyro measurement", () => {
    const cfg: DigitalControllerConfig = {
        gyroDt: 250e-6,
        pidDt: 250e-6,
        axis: { p: 40, i: 0, d: 30, f: 0 },
        dtermLpf1Hz: 75,
        dtermLpf2Hz: 150,
    };

    it("makes C_feedback differ from C_reference (D-on-gyro structure)", () => {
        const frf = evaluateControllerFrf(cfg, 40);
        const delta = csub(frf.cFeedback, frf.cReference);
        expect(cmag(delta)).toBeGreaterThan(0.01);
    });

    it("analytic Cd path matches TD feedback measurement", () => {
        // Low-frequency D-term needs long settle: discrete differentiator + PT1 chain.
        for (const f of [20, 40, 80, 120]) {
            const frf = evaluateControllerFrf(cfg, f);
            const meas = measureFrfFromSimulator(() => new FirmwarePidAxisSimulator(cfg), {
                freqHz: f,
                pidDt: cfg.pidDt,
                mode: "feedback",
                settleCycles: 24,
                measureCycles: 32,
            });
            assertFrfClose(`PD fb @${f}`, frf.cFeedback, meas, 0.5, 5);
        }
    });
});

describe("4. Feedforward via RC route (not CHIRP)", () => {
    const cfg: DigitalControllerConfig = {
        gyroDt: 250e-6,
        pidDt: 250e-6,
        axis: { p: 50, i: 0, d: 0, f: 100 },
        includeRcFeedforward: true,
    };

    it("CHIRP reference path has F=0 even when Kf is non-zero", () => {
        const sim = new FirmwarePidAxisSimulator(cfg);
        const s = sim.step({ gyroRaw: 0, chirpExc: 1 });
        expect(s.f).toBe(0);
        expect(s.u).toBeCloseTo(s.p + s.i, 6);
    });

    it("RC feedforward path yields Kf independently of chirp", () => {
        const Kf = pidCoefficients(cfg).Kf;
        for (const f of [10, 40]) {
            const frf = evaluateControllerFrf(cfg, f);
            expect(frf.cFeedforwardRc.re).toBeCloseTo(Kf, 6);
            const meas = measureFrfFromSimulator(() => new FirmwarePidAxisSimulator(cfg), {
                freqHz: f,
                pidDt: cfg.pidDt,
                mode: "rc_feedforward",
            });
            assertFrfClose(`RC FF @${f}`, frf.cFeedforwardRc, meas, 0.2, 2);
        }
    });
});

describe("5. PT1 filters (gyro / D-term / yaw P)", () => {
    it("PT1 H(z) matches a recurrence-driven cosine fit", () => {
        const dT = 250e-6;
        const k = pt1Gain(100, dT);
        for (const f of [10, 40, 100]) {
            const zInv = { re: Math.cos(-2 * Math.PI * f * dT), im: Math.sin(-2 * Math.PI * f * dT) };
            const analytic = pt1Hz(k, zInv);
            // Independent TD
            let state = 0;
            const n = Math.round(20 / (f * dT));
            let sumXRe = 0,
                sumXIm = 0,
                sumYRe = 0,
                sumYIm = 0;
            const w = 2 * Math.PI * f;
            for (let i = 0; i < n; i++) {
                const t = i * dT;
                const x = Math.cos(w * t);
                state = state + k * (x - state);
                if (i > n / 2) {
                    sumXRe += x * Math.cos(w * t);
                    sumXIm += x * -Math.sin(w * t);
                    sumYRe += state * Math.cos(w * t);
                    sumYIm += state * -Math.sin(w * t);
                }
            }
            const half = n / 4;
            const U = { re: (sumXRe * 2) / half, im: (sumXIm * 2) / half };
            const Y = { re: (sumYRe * 2) / half, im: (sumYIm * 2) / half };
            // crude — use last half length
            const nMeas = Math.floor(n / 2);
            const Um = { re: (sumXRe * 2) / nMeas, im: (sumXIm * 2) / nMeas };
            const Ym = { re: (sumYRe * 2) / nMeas, im: (sumYIm * 2) / nMeas };
            void U;
            void Y;
            const Hm = {
                re: (Ym.re * Um.re + Ym.im * Um.im) / (Um.re * Um.re + Um.im * Um.im),
                im: (Ym.im * Um.re - Ym.re * Um.im) / (Um.re * Um.re + Um.im * Um.im),
            };
            assertFrfClose(`PT1 @${f}`, analytic, Hm, 0.4, 4);
        }
    });

    it("yaw P lowpass appears only on the P path", () => {
        const cfg: DigitalControllerConfig = {
            gyroDt: 250e-6,
            pidDt: 250e-6,
            axis: { p: 56, i: 0, d: 0, f: 0 },
            yawLowpassHz: 100,
        };
        const plain = evaluateControllerFrf({ ...cfg, yawLowpassHz: undefined }, 100);
        const filtered = evaluateControllerFrf(cfg, 100);
        expect(cmag(filtered.cReference)).toBeLessThan(cmag(plain.cReference));
    });
});

describe("6. Sample time and delay (phaseComp + discrete derivative)", () => {
    it("phaseComp coefficients follow firmware lead/lag mapping", () => {
        const c = phaseCompCoeffs(3, 30, 250)!;
        expect(c.b0).toBeGreaterThan(0);
        // At DC (zInv=1): H = (b0+b1)/(1+a1) should be ~1
        const hdc = phaseCompHz(c, { re: 1, im: 0 });
        expect(cmag(hdc)).toBeCloseTo(1, 2);
    });

    it("sample time enters PT1 gains, phaseComp coeffs and AIR65 pid rate", () => {
        expect(pt1Gain(75, 250e-6)).not.toBeCloseTo(pt1Gain(75, 125e-6), 5);
        const a = phaseCompCoeffs(3, 30, 250)!;
        const b = phaseCompCoeffs(3, 30, 125)!;
        expect(a.b0).not.toBeCloseTo(b.b0, 4);
        // AIR65: looptime 125 µs × pid_process_denom 2 → 4 kHz PID
        expect(1 / AIR65_BBL_CONTROLLER.pidDt).toBeCloseTo(4000, 6);
        expect(1 / AIR65_BBL_CONTROLLER.gyroDt).toBeCloseTo(8000, 6);
        // Near Nyquist of the slower rate the discrete differentiator diverges from continuous jω.
        const slow: DigitalControllerConfig = {
            gyroDt: 250e-6,
            pidDt: 250e-6,
            axis: { p: 0, i: 0, d: 30, f: 0 },
        };
        const fast = { ...slow, pidDt: 125e-6, gyroDt: 125e-6 };
        expect(
            Math.abs(magErrDb(evaluateControllerFrf(slow, 1500).cFeedback, evaluateControllerFrf(fast, 1500).cFeedback)),
        ).toBeGreaterThan(1);
    });
});

describe("7. Missing or contradictory firmware parameters", () => {
    it("refuses phaseComp when lag/lead are non-positive", () => {
        expect(phaseCompCoeffs(0, 30, 250)).toBeNull();
        expect(phaseCompCoeffs(3, 0, 250)).toBeNull();
    });

    it("treats D=0 as Cd=0 (AIR65 yaw)", () => {
        const yaw = air65YawConfig();
        // strip chirp shaping noise for equality check
        const frf = evaluateControllerFrf({ ...yaw, chirpLagHz: undefined, chirpLeadHz: undefined }, 40);
        expect(frf.cReference.re).toBeCloseTo(frf.cFeedback.re, 5);
        expect(frf.cReference.im).toBeCloseTo(frf.cFeedback.im, 5);
        expect(yaw.axis.d).toBe(0);
    });
});

describe("8. Nonlinear / dynamic features that invalidate the LTI model", () => {
    it("classifies dyn_notch, rpm_filter, D_max, iterm_relax, anti_gravity", () => {
        const v = classifyModelParts(air65RollConfig());
        expect(v.insufficientOrNonlinear.join(" ")).toMatch(/dyn_notch/);
        expect(v.insufficientOrNonlinear.join(" ")).toMatch(/rpm_filter/);
        expect(v.conditionalLinear.join(" ")).toMatch(/D_max/);
        expect(v.conditionalLinear.join(" ")).toMatch(/iterm_relax/);
        expect(v.linearTimeInvariant.length).toBeGreaterThan(3);
    });

    it("AIR65 roll has D_max while yaw does not — roll LTI not generally valid", () => {
        expect(AIR65_BBL_CONTROLLER.dMax[0]).toBeGreaterThan(0);
        expect(AIR65_BBL_CONTROLLER.dMax[2]).toBe(0);
        expect(AIR65_BBL_CONTROLLER.yaw.d).toBe(0);
        expect(AIR65_BBL_CONTROLLER.itermRelax).toBe(1); // RP — yaw exempt
    });
});

describe("AIR65 BBL parameter reconstruction", () => {
    it("records available vs missing parameters without inventing values", () => {
        expect(AIR65_BBL_CONTROLLER.pidDt).toBeCloseTo(250e-6, 12);
        expect(AIR65_BBL_CONTROLLER.gyroDt).toBeCloseTo(125e-6, 12);
        expect(AIR65_BBL_CONTROLLER.simplifiedPidsMode).toBe(0);
        expect(AIR65_BBL_CONTROLLER.debugMode).toBe(96);
        expect(AIR65_BBL_CONTROLLER.available.length).toBeGreaterThan(8);
        expect(AIR65_BBL_CONTROLLER.missingOrIncomplete.some((m) => /dyn_notch|rpm_filter|plant/i.test(m))).toBe(
            true,
        );
    });

    it("yaw LTI core: analytic vs TD within tolerance (practice reference axis)", () => {
        const cfg = {
            ...air65YawConfig(),
            // Compare Ce/Cfb with y:=gyroADCf — omit gyro LPF here (tested separately)
            gyroLpf1Hz: undefined,
            gyroLpf2Hz: undefined,
        };
        const magErrs: number[] = [];
        const phaseErrs: number[] = [];
        for (const f of [5, 10, 20, 40, 80]) {
            const frf = evaluateControllerFrf(cfg, f);
            const meas = measureFrfFromSimulator(
                () => new FirmwarePidAxisSimulator(cfg, { chirpAmplitude: AIR65_BBL_CONTROLLER.chirpAmplitude.yaw }),
                { freqHz: f, pidDt: cfg.pidDt, mode: "feedback" },
            );
            magErrs.push(Math.abs(magErrDb(meas, frf.cFeedback)));
            phaseErrs.push(Math.abs(phaseErrDeg(meas, frf.cFeedback)));
            assertFrfClose(`AIR65 yaw fb @${f}`, frf.cFeedback, meas, 0.4, 4);
        }
        // Expose summary numbers for the M1 report
        const maxMag = Math.max(...magErrs);
        const maxPhase = Math.max(...phaseErrs);
        expect(maxMag).toBeLessThan(0.4);
        expect(maxPhase).toBeLessThan(4);
    });

    it("gyro LPF FRF is defined at gyroDt independently of the PID rate", () => {
        const cfg = air65YawConfig();
        const h = evaluateGyroLpfFrf(cfg, 150);
        expect(cmag(h)).toBeLessThan(1); // near cutoff
        expect(cmag(evaluateGyroLpfFrf(cfg, 5))).toBeGreaterThan(0.95);
    });
});
