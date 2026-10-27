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
 * Measurement audit B6: the filter optimizer's noise estimate concatenated the valid in-flight samples
 * of a log before one Welch estimate, so every splice between non-adjacent stretches became a step
 * the window turned into broadband power inside the noise band. The estimate is now taken per
 * contiguous run and averaged over the runs (filterOptimizer maskedBandPower). SIMULATION: synthetic
 * signals only.
 */

import { describe, expect, it } from "vitest";
import { welchPowerSpectrum } from "../../src/js/blackbox/spectral_analysis";
import { maskedBandPower, NOISE_BAND_HZ, NOISE_WELCH_SEGMENT } from "../../src/gyrocore/engine/filterOptimizer";

const FS = 4000;

/** Band power as bandPower computes it, on one contiguous signal. */
function bandPowerOf(x: Float64Array): number {
    const ps = welchPowerSpectrum(x, FS, NOISE_WELCH_SEGMENT, 0.5)!;
    let p = 0;
    for (let k = 0; k < ps.frequencies.length; k++) {
        if (ps.frequencies[k] >= NOISE_BAND_HZ[0] && ps.frequencies[k] <= NOISE_BAND_HZ[1]) p += ps.psd[k];
    }
    return p * (ps.frequencies[1] - ps.frequencies[0]);
}

/** A slow 20 Hz manoeuvre with a small 300 Hz noise tone: its noise-band power is the tone's alone. */
function signal(n: number, phase = 0): Float64Array {
    return Float64Array.from({ length: n }, (_, i) => {
        const t = i / FS;
        return 400 * Math.sin(2 * Math.PI * 20 * t + phase) + 2 * Math.sin(2 * Math.PI * 300 * t);
    });
}

describe("noise-band power over non-adjacent stretches of a log", () => {
    const n = 8 * NOISE_WELCH_SEGMENT;
    const a = signal(n, 0);
    const b = signal(n, Math.PI); // the manoeuvre is at the opposite phase when the second stretch starts
    const whole = new Float64Array(2 * n + 2000);
    whole.set(a, 0);
    whole.set(b, n + 2000);
    const valid = new Uint8Array(whole.length).fill(1);
    const mask = new Uint8Array(whole.length).fill(1);
    for (let k = n; k < n + 2000; k++) mask[k] = 0; // the gap: on the ground, or filters not settled
    const reference = bandPowerOf(a);

    it("the spliced estimate charges the splice to the noise band", () => {
        const spliced = new Float64Array(2 * n);
        spliced.set(a, 0);
        spliced.set(b, n);
        expect(bandPowerOf(spliced)).toBeGreaterThan(2 * reference);
    });

    it("the per-run estimate equals the single-run reference", () => {
        const perRun = maskedBandPower(whole, valid, mask, FS)!;
        expect(perRun).not.toBeNull();
        expect(Math.abs(perRun - reference) / reference).toBeLessThan(0.02);
        expect(Math.abs(perRun - bandPowerOf(b)) / reference).toBeLessThan(0.02);
    });

    it("a run shorter than one Welch segment carries no estimate; no long run at all is unknown", () => {
        const short = new Uint8Array(whole.length);
        for (let k = 0; k < NOISE_WELCH_SEGMENT - 1; k++) short[k] = 1;
        expect(maskedBandPower(whole, valid, short, FS)).toBeNull();
        // One long run and one short one: the short one adds nothing.
        const mixed = new Uint8Array(whole.length);
        for (let k = 0; k < n; k++) mixed[k] = 1;
        for (let k = n + 2000; k < n + 2000 + 100; k++) mixed[k] = 1;
        expect(Math.abs(maskedBandPower(whole, valid, mixed, FS)! - reference) / reference).toBeLessThan(0.02);
    });

    it("invalid samples (the chain's warm-up) break a run like the flight mask does", () => {
        const v = new Uint8Array(whole.length).fill(1);
        const m = new Uint8Array(whole.length).fill(1);
        for (let k = n; k < n + 2000; k++) v[k] = 0;
        expect(Math.abs(maskedBandPower(whole, v, m, FS)! - reference) / reference).toBeLessThan(0.02);
    });

    it("runs are weighted by the Welch segments they hold", () => {
        const loud = signal(n, 0).map((x, i) => x + 6 * Math.sin(2 * Math.PI * 500 * (i / FS)));
        const both = new Float64Array(3 * n + 2000);
        both.set(a, 0); // n samples
        both.set(loud, n + 2000); // 2 n samples
        both.set(loud, 2 * n + 2000);
        const v = new Uint8Array(both.length).fill(1);
        const m = new Uint8Array(both.length).fill(1);
        for (let k = n; k < n + 2000; k++) m[k] = 0;
        const quiet = reference;
        const loudP = bandPowerOf(Float64Array.from([...loud, ...loud]));
        const got = maskedBandPower(both, v, m, FS)!;
        // Closer to the longer (louder) run than the plain mean of the two.
        expect(got).toBeGreaterThan((quiet + loudP) / 2);
        expect(got).toBeLessThan(loudP);
    });
});
