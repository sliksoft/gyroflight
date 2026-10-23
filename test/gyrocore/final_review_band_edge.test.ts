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
 * Codex re-review R-2: with a resonance just above the measured band the loop gain was still
 * below one at the last bin but rising towards it (|L| 0.42 → 0.64 over 90–100 Hz for a ζ = 0.02
 * resonance at 110 Hz; 2.4 ten percent higher), and loopMargins reported VALIDATED with GM 9 dB
 * and |S| 3.9 dB as if the band bounded them. The band end now has to be bounded (loopModel.ts
 * BAND_END: no rise of more than 1 dB over the top 10 % of the band, |L| at the end at most
 * −6 dB) before GM and |S| are reported, and GM can never exceed the headroom at the band end.
 *
 * The plant is the review's analytic one (K = 30, motor pole 40 Hz, 2 ms delay) with a
 * 2nd-order resonance of ζ = 0.02 at 105, 110, 120 or 150 Hz, under the AIR65 roll controller;
 * expected values come from the plant, not from the code under test.
 */

import { describe, expect, it } from "vitest";
import {
    air65RollConfig,
    cdiv,
    cmag,
    cmul,
    evaluateControllerFrf,
} from "../../src/js/blackbox/betaflight_digital_controller";
import { closedLoopFromPlant, plantFrf, syntheticTransferFunction } from "../../src/js/blackbox/betaflight_open_loop";
import { BAND_END, buildAxisLoop, loopMargins } from "../../src/gyrocore/engine/loopModel";
import { RELEASE_TARGETS } from "../../src/gyrocore/releaseGate/releaseContract";
import type { EffectiveChain } from "../../src/gyrocore/engine/gyroChain";

const UNITY_CHAIN: EffectiveChain = {
    samples: 1,
    frf: () => ({ re: 1, im: 0 }),
    spread: () => ({ phaseDeg: 0, gainDb: 0 }),
    medianLpf1Hz: 0,
    dynNotchHz: [],
};

type G = (f: number) => { re: number; im: number };
const smooth: G = (f) => plantFrf(f, { K: 30, motorHz: 40, delayS: 0.002 });
const resonant =
    (fr: number, zeta = 0.02): G =>
    (f) => {
        const z = f / fr;
        return cmul(smooth(f), cdiv({ re: 1, im: 0 }, { re: 1 - z * z, im: 2 * zeta * z }));
    };

function identify(maxHz: number, G: G) {
    const cfg = air65RollConfig();
    const freqs = Array.from({ length: Math.round(maxHz / 0.5) }, (_, i) => 0.5 + i * 0.5);
    const tf = syntheticTransferFunction(freqs, (f) => {
        const frf = evaluateControllerFrf(cfg, f);
        return closedLoopFromPlant(G(f), frf.cReference, frf.cFeedback);
    });
    const L = (f: number) => cmag(cmul(G(f), evaluateControllerFrf(cfg, f).cFeedback));
    return { m: loopMargins(buildAxisLoop(0, tf, cfg, UNITY_CHAIN, true, true)), L };
}
const db = (x: number) => 20 * Math.log10(x);

describe("R-2: the band end must be bounded before GM and |S| count", () => {
    it("the thresholds are the documented ones and tie to the release gain-margin target", () => {
        expect(BAND_END).toEqual({ tailFraction: 0.1, minTailBins: 4, maxTailRiseDb: 1, maxBandEndDb: -6 });
        expect(BAND_END.maxBandEndDb).toBe(-RELEASE_TARGETS.minGainMarginDb);
    });

    it("the analytic loops really do what the review said at the 100 Hz band end", () => {
        const { L } = identify(100, resonant(110));
        expect(L(100)).toBeLessThan(1);
        expect(db(L(100)) - db(L(90))).toBeGreaterThan(3); // rising by > 3 dB over the last 10 %
        expect(L(110)).toBeGreaterThan(2);
        const far = identify(100, resonant(150)).L;
        expect(db(far(100)) - db(far(90))).toBeLessThan(0); // falling
        expect(far(100)).toBeLessThan(0.5); // below −6 dB
    });

    for (const fr of [105, 110, 120]) {
        it(`review counterexample: resonance at ${fr} Hz, band to 100 Hz → NOT_VALIDATED, GM and |S| unknown`, () => {
            const { m, L } = identify(100, resonant(fr));
            expect(L(fr)).toBeGreaterThan(1);
            expect(m.status).toBe("NOT_VALIDATED");
            expect(m.gainMarginDb).toBeNull();
            expect(m.sensitivityPeakDb).toBeNull();
            const edge = L(100) >= 1 ? "loop_gain_above_one_at_band_end" : "loop_gain_rising_at_band_end:";
            expect(m.reasons.some((r) => r.startsWith(edge))).toBe(true);
        });
    }

    it("110 Hz: the rise and the level are both named, with their size", () => {
        const { m } = identify(100, resonant(110));
        expect(m.reasons.find((r) => r.startsWith("loop_gain_rising_at_band_end:+"))).toMatch(/\+3\.\dd?B/);
        expect(m.reasons.find((r) => r.startsWith("loop_gain_near_unity_at_band_end:"))).toMatch(/-3\.\d/);
    });

    it("positive: resonance at 150 Hz (band to 100 Hz) keeps bounds; GM is capped by the band-end headroom", () => {
        const { m, L } = identify(100, resonant(150));
        // Bounds, open only on the model class (no finer independent log here: Codex final acceptance F-02).
        expect(m.evidence.level).toBe("MODEL_CONDITIONAL");
        expect(m.reasons).toEqual([
            "model_class_not_qualified",
            "model_class_qualification_missing",
            "required_measurement:chirp_finer_resolution_model_class_qualification",
        ]);
        expect(m.gainMarginDb).not.toBeNull();
        const headroom = -db(Math.max(...[90, 92, 94, 96, 98, 100].map(L)));
        expect(m.gainMarginDb!).toBeLessThanOrEqual(headroom + 0.01);
        expect(m.sensitivityPeakDb).not.toBeNull();
    });

    it("positive: the smooth, well-damped plant keeps the same margins as before (bounds, model-conditional)", () => {
        const { m } = identify(200, smooth);
        // Bounds, open only on the model class (no finer independent log here: Codex final acceptance F-02).
        expect(m.evidence.level).toBe("MODEL_CONDITIONAL");
        expect(m.reasons).toEqual([
            "model_class_not_qualified",
            "model_class_qualification_missing",
            "required_measurement:chirp_finer_resolution_model_class_qualification",
        ]);
        expect(m.crossoverHz!).toBeCloseTo(9.64, 1);
        expect(m.phaseMarginDeg!).toBeCloseTo(86.7, 0);
        expect(m.gainMarginDb!).toBeCloseTo(12.97, 1);
        expect(m.sensitivityPeakDb!).toBeCloseTo(2.73, 1);
    });

    it("the same resonances inside a band to 200 Hz are still seen as crossings", () => {
        for (const fr of [110, 150]) {
            const { m } = identify(200, resonant(fr));
            expect(m.status).toBe("NOT_VALIDATED");
            expect(m.reasons.some((r) => r.startsWith("loop_gain_reenters_unity:"))).toBe(true);
        }
    });

    it("a band that ends with |L| flat but above −6 dB is not bounded either", () => {
        // The smooth plant with the band cut where |L| is still near unity: no rise, but the
        // headroom the band shows is less than the required gain margin.
        const { m, L } = identify(13, smooth);
        expect(L(13)).toBeLessThan(1);
        expect(db(L(13))).toBeGreaterThan(BAND_END.maxBandEndDb);
        expect(m.status).toBe("NOT_VALIDATED");
        expect(m.reasons.some((r) => r.startsWith("loop_gain_near_unity_at_band_end:"))).toBe(true);
        expect(m.gainMarginDb).toBeNull();
    });
});
