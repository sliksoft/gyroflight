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
 * Codex review P1-03 and P1-04: counterexamples that the old loop model released.
 *
 * P1-03: validateChain dropped an incoherent required band and passed the control band on the
 * other one alone. The inputs are the review's own (seed 7, 65 536 samples at 1 024 Hz, shared
 * sines below 20 Hz, independent AR noise above), plus the mirrored case.
 *
 * P1-04: loopMargins counted only downward unity crossings. The plant is the review's analytic
 * one (K = 30, motor pole 40 Hz, 2 ms delay, a 100 Hz structural resonance with ζ = 0.02) under
 * the AIR65 roll controller; chain and attestation are set so that nothing else blocks. Expected
 * values come from that plant, not from the code under test.
 */

import { describe, expect, it } from "vitest";
import { declaredSupport } from "./harness/frequencySupport";
import { declaredConvergence } from "./harness/resolutionConvergence";
import {
    air65RollConfig,
    cdiv,
    cmag,
    cmul,
    evaluateControllerFrf,
} from "../../src/js/blackbox/betaflight_digital_controller";
import { closedLoopFromPlant, plantFrf, syntheticTransferFunction } from "../../src/js/blackbox/betaflight_open_loop";
import { buildAxisLoop, loopMargins, validateChain } from "../../src/gyrocore/engine/loopModel";
import type { ChainSimulation, EffectiveChain } from "../../src/gyrocore/engine/gyroChain";

const N = 65536;
const FS = 1024;

/** The review's generator: shared sines in [loHz, hiHz), independent AR(0.7) noise everywhere. */
function chainCase(loHz: number, hiHz: number) {
    let seed = 7;
    const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32 - 0.5;
    const x = new Float64Array(N);
    const y = new Float64Array(N);
    let a = 0;
    let b = 0;
    for (let k = 0; k < N; k++) {
        a = 0.7 * a + rnd();
        b = 0.7 * b + rnd();
        let s = 0;
        for (let f = loHz; f < hiHz; f++) s += 20 * Math.sin((2 * Math.PI * f * k) / FS + f * f);
        x[k] = s + a;
        y[k] = s + b;
    }
    const sim = { out: [x, x, x], valid: new Uint8Array(N).fill(1), notes: [] } as unknown as ChainSimulation;
    return validateChain(0, sim, null, y, FS, new Uint8Array(N).fill(1));
}

describe("P1-03: every required control band needs coherent support", () => {
    it("review counterexample: coherent 2–20 Hz, incoherent 20–80 Hz → INSUFFICIENT, not PASS", () => {
        const v = chainCase(2, 20);
        const hi = v.fit!.bands.find((b) => b.loHz === 20 && b.hiHz === 80)!;
        expect(hi.coherence).toBeLessThan(0.1); // the review measured 0.0238
        expect(v.controlBand).toBe("INSUFFICIENT");
        expect(v.reasons).toContain("chain_band_unsupported:20-80Hz");
    });

    it("mirrored: incoherent 2–20 Hz, coherent 20–80 Hz → INSUFFICIENT", () => {
        const v = chainCase(20, 80);
        expect(v.fit!.bands.find((b) => b.loHz === 20)!.coherence).toBeGreaterThan(0.9);
        expect(v.controlBand).toBe("INSUFFICIENT");
        expect(v.reasons).toContain("chain_band_unsupported:2-20Hz");
    });

    it("positive control: both bands coherent and matching → PASS", () => {
        const v = chainCase(2, 80);
        expect(v.controlBand).toBe("PASS");
    });
});

const UNITY_CHAIN: EffectiveChain = {
    samples: 1,
    frf: () => ({ re: 1, im: 0 }),
    spread: () => ({ phaseDeg: 0, gainDb: 0 }),
    medianLpf1Hz: 0,
    dynNotchHz: [],
};

function resonantLoop(maxHz: number, resonance = true) {
    const cfg = air65RollConfig();
    const freqs = Array.from({ length: Math.round(maxHz / 0.5) }, (_, i) => 0.5 + i * 0.5);
    const G = (f: number) => {
        const base = plantFrf(f, { K: 30, motorHz: 40, delayS: 0.002 });
        if (!resonance) return base;
        const z = f / 100;
        return cmul(base, cdiv({ re: 1, im: 0 }, { re: 1 - z * z, im: 0.04 * z }));
    };
    const tf = syntheticTransferFunction(freqs, (f) => {
        const frf = evaluateControllerFrf(cfg, f);
        return closedLoopFromPlant(G(f), frf.cReference, frf.cFeedback);
    });
    const loop = buildAxisLoop(0, tf, cfg, UNITY_CHAIN, true, true, null, {
        support: declaredSupport(tf),
        resolution: declaredConvergence(),
        sweep: { f0Hz: 1, f1Hz: 400, durationS: 20 },
    });
    // Independent check on the analytic loop (not on the code under test).
    const L = (f: number) => cmag(cmul(G(f), evaluateControllerFrf(cfg, f).cFeedback));
    return { loop, L, freqs };
}

describe("P1-04: a loop that comes back above unity is not validated", () => {
    it("the analytic loop really re-enters |L| ≥ 1 near 94 Hz and leaves again near 105 Hz", () => {
        const { L } = resonantLoop(200);
        expect(L(9.5)).toBeGreaterThan(1);
        expect(L(10)).toBeLessThan(1);
        expect(L(93.5)).toBeLessThan(1);
        expect(L(94)).toBeGreaterThan(1);
        expect(L(100)).toBeGreaterThan(2.5);
        expect(L(105)).toBeLessThan(1);
    });

    it("band to 100 Hz (ends above unity): NOT_VALIDATED with the re-entry and band-end reasons", () => {
        const m = loopMargins(resonantLoop(100).loop);
        expect(m.status).toBe("NOT_VALIDATED");
        expect(m.reasons).toContain("loop_gain_above_one_at_band_end");
        expect(m.reasons.some((r) => r.startsWith("loop_gain_reenters_unity:"))).toBe(true);
        expect(m.reasons).toContain("ambiguous_crossovers:2");
        // A band-limited |S| peak is not reported as a robustness bound.
        expect(m.sensitivityPeakDb).toBeNull();
    });

    it("band to 200 Hz: NOT_VALIDATED, all three crossings counted, PM is the worst of them", () => {
        const m = loopMargins(resonantLoop(200).loop);
        expect(m.status).toBe("NOT_VALIDATED");
        expect(m.reasons).toContain("ambiguous_crossovers:3");
        expect(m.reasons.some((r) => r.startsWith("loop_gain_reenters_unity:"))).toBe(true);
        expect(m.reasons).not.toContain("loop_gain_above_one_at_band_end");
        // The re-entry around the resonance carries far less margin than the 86.5° first crossover.
        expect(m.phaseMarginDeg!).toBeLessThan(80);
    });

    it("positive control: the same plant without the resonance has bounds, open only on the model class", () => {
        const m = loopMargins(resonantLoop(200, false).loop);
        // Without a finer, independent log the bounds are MODEL_CONDITIONAL (Codex final acceptance F-02).
        expect(m.reasons).toEqual([
            "model_class_not_qualified",
            "model_class_qualification_missing",
            "required_measurement:chirp_finer_resolution_model_class_qualification",
        ]);
        expect(m.evidence.level).toBe("MODEL_CONDITIONAL");
        expect(m.status).toBe("NOT_VALIDATED");
        expect(m.crossoverHz!).toBeGreaterThan(9);
        expect(m.crossoverHz!).toBeLessThan(11);
    });
});
