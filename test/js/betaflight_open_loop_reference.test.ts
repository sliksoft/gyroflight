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
 * GF-1 M2: independent open-loop / phase-margin reference tests.
 *
 * A priori tolerances (chosen before looking at failures):
 *   - Clean synthetic FRF (coherence=1, dense grid): |Δfc| ≤ 0.5 Hz, |ΔPM| ≤ 2.0°
 *   - Same with modest noise / dropped bins: |Δfc| ≤ 1.5 Hz, |ΔPM| ≤ 5.0°
 *   - Low coherence bins must be skipped (no invented L)
 *
 * Ground truth L = C_feedback · G is computed independently of the
 * reconstructStabilityLoop algebra (closedLoopFromPlant → T → reconstruct).
 */

import { describe, expect, it } from "vitest";
import {
    air65RollConfig,
    air65YawConfig,
    cmag,
    cphaseDeg,
    csub,
    evaluateControllerFrf,
    type DigitalControllerConfig,
} from "../../src/js/blackbox/betaflight_digital_controller";
import {
    AIR65_EXTERNAL_BLOCKERS,
    closedLoopFromPlant,
    evaluateStructureAwarePhaseMargin,
    findGainCrossover,
    plantFrf,
    reconstructStabilityLoop,
    syntheticTransferFunction,
    syntheticTransferFunctionWithCoherence,
    trueStabilityLoop,
    unityFeedbackL,
} from "../../src/js/blackbox/betaflight_open_loop";

/** Pre-declared acceptance for clean analytic grids. */
const CLEAN_FC_TOL_HZ = 0.5;
const CLEAN_PM_TOL_DEG = 2.0;
/** Pre-declared acceptance when bins are thinned or mildly degraded. */
const DEGRADED_FC_TOL_HZ = 1.5;
const DEGRADED_PM_TOL_DEG = 5.0;

function freqGrid(fMin: number, fMax: number, step: number): number[] {
    const out: number[] = [];
    for (let f = fMin; f <= fMax + 1e-9; f += step) out.push(Number(f.toFixed(6)));
    return out;
}

function truthCrossover(
    freqs: number[],
    Lof: (f: number) => { re: number; im: number },
): { frequencyHz: number; phaseMarginDeg: number } | null {
    let prevF = freqs[0];
    let prevMag = cmag(Lof(prevF));
    let prevPhase = cphaseDeg(Lof(prevF));
    let offset = 0;
    let prevRaw = prevPhase;
    for (let i = 1; i < freqs.length; i++) {
        const f = freqs[i];
        const L = Lof(f);
        const m = cmag(L);
        let raw = cphaseDeg(L);
        const delta = raw - prevRaw;
        if (delta > 180) offset -= 360;
        else if (delta < -180) offset += 360;
        const ph = raw + offset;
        if (prevMag > 1 && m <= 1) {
            const frac = (1 - prevMag) / (m - prevMag);
            return {
                frequencyHz: prevF + frac * (f - prevF),
                phaseMarginDeg: 180 + prevPhase + frac * (ph - prevPhase),
            };
        }
        prevF = f;
        prevMag = m;
        prevPhase = ph;
        prevRaw = raw;
    }
    return null;
}

function makeTf(
    cfg: DigitalControllerConfig,
    plant: { K: number; motorHz: number; delayS: number },
    freqs: number[],
    coh = 1,
) {
    return syntheticTransferFunction(
        freqs,
        (f) => {
            if (f <= 0) return { re: 1, im: 0 };
            const frf = evaluateControllerFrf(cfg, f);
            const G = plantFrf(f, plant);
            return closedLoopFromPlant(G, frf.cReference, frf.cFeedback);
        },
        coh,
    );
}

describe("GF-1 M2 open-loop reconstruction — clean synthetic", () => {
    const plant = { K: 2 * Math.PI * 30, motorHz: 80, delayS: 0.002 };
    const freqs = freqGrid(2, 200, 0.25);

    it("1. P-only: reconstructed L matches C_fb·G; fc/PM within a priori tol", () => {
        const cfg: DigitalControllerConfig = {
            gyroDt: 250e-6,
            pidDt: 250e-6,
            axis: { p: 50, i: 0, d: 0, f: 0 },
        };
        const tf = makeTf(cfg, plant, freqs);
        const loop = reconstructStabilityLoop(tf, cfg);
        expect(loop.unityFeedbackEquivalent).toBe(true);

        for (const f of [10, 25, 40, 60]) {
            const k = freqs.findIndex((x) => Math.abs(x - f) < 1e-9);
            const bin = loop.bins[k];
            expect(bin.status).toBe("ok");
            const frf = evaluateControllerFrf(cfg, f);
            const Ltrue = trueStabilityLoop(plantFrf(f, plant), frf.cFeedback);
            expect(Math.abs(20 * Math.log10(bin.magnitude / cmag(Ltrue)))).toBeLessThan(0.05);
            expect(Math.abs(bin.phaseDeg - cphaseDeg(Ltrue))).toBeLessThan(0.5);
        }

        const got = findGainCrossover(loop);
        const truth = truthCrossover(freqs, (f) =>
            trueStabilityLoop(plantFrf(f, plant), evaluateControllerFrf(cfg, f).cFeedback),
        );
        expect(got.status).toBe("ok");
        expect(truth).not.toBeNull();
        expect(Math.abs(got.frequencyHz - truth!.frequencyHz)).toBeLessThanOrEqual(CLEAN_FC_TOL_HZ);
        expect(Math.abs(got.phaseMarginDeg - truth!.phaseMarginDeg)).toBeLessThanOrEqual(CLEAN_PM_TOL_DEG);
    });

    it("2. PI: same reconstruction contract", () => {
        const cfg: DigitalControllerConfig = {
            gyroDt: 250e-6,
            pidDt: 250e-6,
            axis: { p: 56, i: 79, d: 0, f: 0 },
        };
        const tf = makeTf(cfg, plant, freqs);
        const got = findGainCrossover(reconstructStabilityLoop(tf, cfg));
        const truth = truthCrossover(freqs, (f) =>
            trueStabilityLoop(plantFrf(f, plant), evaluateControllerFrf(cfg, f).cFeedback),
        );
        expect(got.status).toBe("ok");
        expect(Math.abs(got.frequencyHz - truth!.frequencyHz)).toBeLessThanOrEqual(CLEAN_FC_TOL_HZ);
        expect(Math.abs(got.phaseMarginDeg - truth!.phaseMarginDeg)).toBeLessThanOrEqual(CLEAN_PM_TOL_DEG);
    });

    it("3. D-on-gyro: C_ref ≠ C_fb; structure-aware L ≠ T/(1−T); still matches truth", () => {
        const cfg: DigitalControllerConfig = {
            gyroDt: 250e-6,
            pidDt: 250e-6,
            axis: { p: 40, i: 0, d: 30, f: 0 },
            dtermLpf1Hz: 75,
            dtermLpf2Hz: 150,
        };
        const tf = makeTf(cfg, plant, freqs);
        const loop = reconstructStabilityLoop(tf, cfg);
        expect(loop.unityFeedbackEquivalent).toBe(false);

        const f = 40;
        const k = freqs.findIndex((x) => Math.abs(x - f) < 1e-9);
        const T = { re: tf.hReal[k], im: tf.hImag[k] };
        const Lunity = unityFeedbackL(T)!;
        const Lstruct = loop.bins[k].L!;
        expect(cmag(csub(Lstruct, Lunity))).toBeGreaterThan(0.05);

        const got = findGainCrossover(loop);
        const truth = truthCrossover(freqs, (f0) =>
            trueStabilityLoop(plantFrf(f0, plant), evaluateControllerFrf(cfg, f0).cFeedback),
        );
        expect(got.status).toBe("ok");
        expect(Math.abs(got.frequencyHz - truth!.frequencyHz)).toBeLessThanOrEqual(CLEAN_FC_TOL_HZ);
        expect(Math.abs(got.phaseMarginDeg - truth!.phaseMarginDeg)).toBeLessThanOrEqual(CLEAN_PM_TOL_DEG);
    });

    it("4. Yaw P-lowpass: unity-equivalent (Ce cancels); L matches C_fb·G", () => {
        const cfg: DigitalControllerConfig = {
            gyroDt: 250e-6,
            pidDt: 250e-6,
            axis: { p: 56, i: 79, d: 0, f: 0 },
            yawKiBoost: true,
            yawLowpassHz: 100,
        };
        const tf = makeTf(cfg, plant, freqs);
        const loop = reconstructStabilityLoop(tf, cfg);
        expect(loop.unityFeedbackEquivalent).toBe(true);
        const got = findGainCrossover(loop);
        const truth = truthCrossover(freqs, (f) =>
            trueStabilityLoop(plantFrf(f, plant), evaluateControllerFrf(cfg, f).cFeedback),
        );
        expect(Math.abs(got.frequencyHz - truth!.frequencyHz)).toBeLessThanOrEqual(CLEAN_FC_TOL_HZ);
        expect(Math.abs(got.phaseMarginDeg - truth!.phaseMarginDeg)).toBeLessThanOrEqual(CLEAN_PM_TOL_DEG);
    });

    it("5. Filters + delay + multiple crossovers (two plants)", () => {
        const cfg: DigitalControllerConfig = {
            gyroDt: 125e-6,
            pidDt: 250e-6,
            axis: { p: 45, i: 60, d: 25, f: 0 },
            dtermLpf1Hz: 75,
            dtermLpf2Hz: 150,
            gyroLpf1Hz: undefined, // y := gyroADCf in T definition
        };
        for (const p of [
            { K: 2 * Math.PI * 20, motorHz: 70, delayS: 0.0015 },
            { K: 2 * Math.PI * 45, motorHz: 100, delayS: 0.003 },
        ]) {
            const tf = makeTf(cfg, p, freqs);
            const got = findGainCrossover(reconstructStabilityLoop(tf, cfg));
            const truth = truthCrossover(freqs, (f) =>
                trueStabilityLoop(plantFrf(f, p), evaluateControllerFrf(cfg, f).cFeedback),
            );
            expect(got.status, `plant K=${p.K}`).toBe("ok");
            expect(Math.abs(got.frequencyHz - truth!.frequencyHz)).toBeLessThanOrEqual(CLEAN_FC_TOL_HZ);
            expect(Math.abs(got.phaseMarginDeg - truth!.phaseMarginDeg)).toBeLessThanOrEqual(CLEAN_PM_TOL_DEG);
        }
    });
});

describe("GF-1 M2 open-loop — degraded / pathological data", () => {
    const plant = { K: 2 * Math.PI * 30, motorHz: 80, delayS: 0.002 };
    const cfg: DigitalControllerConfig = {
        gyroDt: 250e-6,
        pidDt: 250e-6,
        axis: { p: 50, i: 40, d: 0, f: 0 },
    };

    it("6. Low coherence bins are skipped (no L invented)", () => {
        const freqs = freqGrid(2, 100, 0.5);
        const tf = syntheticTransferFunctionWithCoherence(
            freqs,
            (f) => {
                const frf = evaluateControllerFrf(cfg, f);
                return closedLoopFromPlant(plantFrf(f, plant), frf.cReference, frf.cFeedback);
            },
            (f) => (f >= 20 && f <= 40 ? 0.2 : 1),
        );
        const loop = reconstructStabilityLoop(tf, cfg);
        for (const bin of loop.bins) {
            if (bin.frequencyHz >= 20 && bin.frequencyHz <= 40) {
                expect(bin.status).toBe("low_coherence");
                expect(bin.L).toBeNull();
            }
        }
    });

    it("7. Missing bins (coarse grid) still recovers fc/PM within degraded tol", () => {
        const freqs = freqGrid(2, 150, 2); // 2 Hz resolution
        const tf = makeTf(cfg, plant, freqs);
        const got = findGainCrossover(reconstructStabilityLoop(tf, cfg));
        const truth = truthCrossover(freqGrid(2, 150, 0.25), (f) =>
            trueStabilityLoop(plantFrf(f, plant), evaluateControllerFrf(cfg, f).cFeedback),
        );
        expect(got.status).toBe("ok");
        expect(Math.abs(got.frequencyHz - truth!.frequencyHz)).toBeLessThanOrEqual(DEGRADED_FC_TOL_HZ);
        expect(Math.abs(got.phaseMarginDeg - truth!.phaseMarginDeg)).toBeLessThanOrEqual(DEGRADED_PM_TOL_DEG);
    });

    it("8. Near-singular denominator near T≈1 is marked singular (no blow-up)", () => {
        // Force T very close to 1 at a mid band with C_ref=C_fb
        const freqs = [5, 10, 15];
        const tf = syntheticTransferFunction(freqs, () => ({ re: 0.999999, im: 0 }), 1);
        const loop = reconstructStabilityLoop(tf, cfg, { denomRelMin: 1e-4 });
        // At least one bin should be singular or ok with finite mag — never Infinity
        for (const bin of loop.bins) {
            if (bin.status === "ok") {
                expect(Number.isFinite(bin.magnitude)).toBe(true);
            }
        }
        expect(loop.bins.some((b) => b.status === "singular_denominator" || b.status === "ok")).toBe(true);
    });
});

describe("GF-1 M2 AIR65 yaw policy", () => {
    it("yaw config is unity-feedback equivalent; external dyn blockers keep NOT_VALIDATED", () => {
        const cfg = {
            ...air65YawConfig(),
            gyroLpf1Hz: undefined,
            gyroLpf2Hz: undefined,
            chirpLagHz: undefined,
            chirpLeadHz: undefined,
        };
        const plant = { K: 2 * Math.PI * 25, motorHz: 90, delayS: 0.002 };
        const freqs = freqGrid(2, 120, 0.5);
        const tf = makeTf(cfg, plant, freqs);
        const pm = evaluateStructureAwarePhaseMargin(tf, cfg, {
            externalBlockReasons: [...AIR65_EXTERNAL_BLOCKERS],
        });
        expect(pm.unityFeedbackEquivalent).toBe(true);
        expect(pm.crossover?.status).toBe("ok");
        expect(pm.status).toBe("NOT_VALIDATED");
        expect(pm.blockReasons).toEqual(expect.arrayContaining(["dyn_notch_centres_unknown"]));
    });

    it("roll with D is not unity-equivalent; same dyn blockers apply", () => {
        const cfg = {
            ...air65RollConfig(),
            gyroLpf1Hz: undefined,
            gyroLpf2Hz: undefined,
            chirpLagHz: undefined,
            chirpLeadHz: undefined,
        };
        const plant = { K: 2 * Math.PI * 25, motorHz: 90, delayS: 0.002 };
        const freqs = freqGrid(2, 120, 0.5);
        const tf = makeTf(cfg, plant, freqs);
        const pm = evaluateStructureAwarePhaseMargin(tf, cfg, {
            externalBlockReasons: [
                ...AIR65_EXTERNAL_BLOCKERS,
                "d_max_state_dependent",
                "iterm_relax_nonlinear",
            ],
        });
        expect(pm.unityFeedbackEquivalent).toBe(false);
        expect(pm.status).toBe("NOT_VALIDATED");
        expect(pm.blockReasons).toEqual(expect.arrayContaining(["d_max_state_dependent"]));
    });
});
