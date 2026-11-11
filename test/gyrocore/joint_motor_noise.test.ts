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
 * Block 13: the every-axis noise and per-motor model (jointMotorNoise.ts) on the real firmware D path
 * (simulateDterm, no mocks). Checks the firmware sign convention (P on −gyro, D on −Δgyro), the quadratic
 * form against a direct band power of the mixed series, the QUAD X mixer, and the reproduction gate.
 */

import { describe, expect, it } from "vitest";
import { simulateDterm, type DtermDynamicConfig } from "../../src/js/blackbox/betaflight_dterm_dynamic";
import { maskedBandPower } from "../../src/gyrocore/engine/filterOptimizer";
import {
    motorNoiseModel,
    QUADX_MIX,
    REPRODUCTION,
    type FilterSignals,
    type MotorNoiseAxis,
} from "../../src/gyrocore/engine/jointMotorNoise";

const N = 8192;
const FS = 1000;
const PTERM = 0.032029;
let seed = 4242;
const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
};
// Broadband gyro noise per axis, partly shared between the axes (a frame that shakes all three at once).
const common = Float64Array.from({ length: N }, () => 20 * rnd());
const gyro = [0, 1, 2].map((a) => Float64Array.from({ length: N }, (_, i) => 40 * rnd() + (a === 2 ? 0 : common[i])));
const timeUs = Float64Array.from({ length: N }, (_, i) => i * 1000);
const rcThrottle = new Float64Array(N).fill(1400);
const mask = new Uint8Array(N).fill(1);
const dcfg = (d: number, dMax: number): DtermDynamicConfig => ({
    pidDt: 0.001,
    d,
    dMax,
    dMaxGain: 20,
    dMaxAdvance: 35,
    dtermLpf1Type: 0,
    dtermLpf1StaticHz: 75,
    dtermLpf1DynMinHz: 75,
    dtermLpf1DynMaxHz: 150,
    dtermLpf1DynExpo: 5,
    dtermLpf2Type: 0,
    dtermLpf2StaticHz: 150,
    dtermNotchHz: 0,
    tpaRate: 60,
    tpaBreakpoint: 1350,
    tpaLowRate: 20,
    tpaLowBreakpoint: 1050,
    tpaLowAlways: false,
    throttleLimitType: 0,
});
const pids = {
    roll: { p: 100, i: 79, d: 30, dMax: 40 },
    pitch: { p: 82, i: 117, d: 61, dMax: 0 },
    yaw: { p: 56, i: 79, d: 0, dMax: 0 },
};
const dOf = (ai: number, cfg: DtermDynamicConfig) => simulateDterm({ timeUs, gyro: gyro[ai], rcThrottle }, cfg);
/** The firmware's PID sum in the noise band: P on the error (setpoint 0: −gyro), D as simulated (−Δgyro). */
const pidSum = (ai: number, p: number, cfg: DtermDynamicConfig | null) => {
    const d = cfg ? dOf(ai, cfg).d : new Float64Array(N);
    return Float64Array.from(gyro[ai], (g, k) => -PTERM * p * g + (Number.isFinite(d[k]) ? d[k] : 0));
};
const axes = (logged: "firmware" | "wrong_sign" = "firmware"): MotorNoiseAxis[] =>
    (["roll", "pitch", "yaw"] as const).map((name, ai) => {
        const v = pids[name];
        const cfg = v.d > 0 ? dcfg(v.d, v.dMax) : null;
        const d = cfg ? dOf(ai, cfg).d : null;
        return {
            axis: name,
            current: v,
            dterm: cfg,
            dtermValidated: cfg ? true : null,
            chainNoiseValidated: true,
            gyroAdc: gyro[ai],
            yawLowpassHz: undefined,
            loggedP: Float64Array.from(gyro[ai], (g) => (logged === "firmware" ? -1 : 1) * PTERM * v.p * g),
            loggedD: d ? Float64Array.from(d, (x) => (Number.isFinite(x) ? x : 0)) : null,
        };
    });
const model = (a = axes()) =>
    motorNoiseModel({
        axes: a,
        timeUs,
        rcThrottle,
        sampleRateHz: FS,
        pidDt: 0.001,
        noiseMask: mask,
        mixer: { kind: "quadx", yawReversed: false },
        motors: null,
    });
const base = { sim: null, dterm: [dcfg(30, 40), dcfg(61, 0), null] };

describe("every-axis noise and per-motor model (block 13)", () => {
    it("the firmware D path acts on −Δgyro: its output is anti-correlated with the gyro increment", () => {
        const d = dOf(0, dcfg(30, 40)).d;
        let dot = 0;
        for (let k = 1; k < N; k++) if (Number.isFinite(d[k])) dot += d[k] * (gyro[0][k] - gyro[0][k - 1]);
        expect(dot).toBeLessThan(0);
    });

    it("per-motor power equals the band power of the QUAD X sum of the firmware PID sums (P on −gyro)", () => {
        const m = model();
        // P and D scaled differently (P ×0.8, D ×1.1): the cross term between them decides the ratio.
        const cand = { p: 80, i: 79, d: 33, dMax: 44 };
        const a = m.assess("1|1", base, base, false, { roll: cand });
        expect(a.assessed).toBe(true);
        const u = [pidSum(0, cand.p, dcfg(cand.d, cand.dMax)), pidSum(1, 82, dcfg(61, 0)), pidSum(2, 56, null)];
        const u0 = [pidSum(0, 100, dcfg(30, 40)), u[1], u[2]];
        const valid = new Uint8Array(N);
        const dv = [dOf(0, dcfg(30, 40)), dOf(1, dcfg(61, 0))];
        for (let k = 0; k < N; k++) valid[k] = dv.every((x) => x.valid[k] && Number.isFinite(x.d[k])) ? 1 : 0;
        QUADX_MIX.forEach((row, mi) => {
            const mix = (us: Float64Array[]) =>
                Float64Array.from({ length: N }, (_, k) => row[0] * us[0][k] + row[1] * us[1][k] - row[2] * us[2][k]);
            const want = maskedBandPower(mix(u), valid, mask, FS)! / maskedBandPower(mix(u0), valid, mask, FS)!;
            expect(a.motorRatios![mi]).toBeCloseTo(want, 6);
        });
        // A wrong P sign (P on +gyro) would give another ratio: the convention is pinned.
        const wrong = Float64Array.from(u[0], (x, k) => x + 2 * PTERM * cand.p * gyro[0][k]);
        const wrong0 = Float64Array.from(u0[0], (x, k) => x + 2 * PTERM * 100 * gyro[0][k]);
        const w = maskedBandPower(wrong, valid, mask, FS)! / maskedBandPower(wrong0, valid, mask, FS)!;
        const right = maskedBandPower(u[0], valid, mask, FS)! / maskedBandPower(u0[0], valid, mask, FS)!;
        expect(Math.abs(w - right)).toBeGreaterThan(0.01);
        expect(a.axisRatios.roll!).toBeCloseTo(right, 6);
    });

    it("the quadratic form of one axis equals the direct assessment", () => {
        const m = model();
        for (const cand of [
            { p: 70, i: 55, d: 21, dMax: 28 },
            { p: 130, i: 79, d: 39, dMax: 52 },
        ]) {
            const q = m.ratiosFor("1|1", base, base, false, 0, cand)!;
            const a = m.assess("1|1", base, base, false, { roll: cand });
            q.motorRatios.forEach((r, mi) => expect(r).toBeCloseTo(a.motorRatios![mi], 9));
            expect(q.axisRatio!).toBeCloseTo(a.axisRatios.roll!, 9);
        }
    });

    it("reproduction: the firmware convention is reproduced exactly; another P sign or scale is not, and a large axis blocks the motor rule", () => {
        const ok = model().reproduction(base);
        for (const r of ok) expect(r.ratio!).toBeCloseTo(1, 6);
        expect(ok.every((r) => r.reproduced)).toBe(true);
        // P on +gyro moves the ratio by the P/D cross term (how far depends on the D path's phase in the band).
        const signed = model(axes("wrong_sign")).reproduction(base);
        expect(Math.abs(signed.find((r) => r.axis === "roll")!.ratio! - 1)).toBeGreaterThan(0.01);
        // A pitch P twice what the log shows (pitch carries most of the power): not reproduced, motor rule blocked.
        const a = axes();
        a[1] = { ...a[1], loggedP: Float64Array.from(a[1].loggedP!, (x) => x / 2) };
        const bad = model(a);
        const rows = bad.reproduction(base);
        const pitch = rows.find((r) => r.axis === "pitch")!;
        expect(pitch.reproduced).toBe(false);
        expect(pitch.share!).toBeGreaterThan(REPRODUCTION.maxUnreproducedShare);
        const as = bad.assess("1|1", base, base, false, {});
        expect(as.assessed).toBe(false);
        expect(as.reasons.some((x) => x.startsWith("noise_not_reproduced:pitch"))).toBe(true);
        expect(bad.ratiosFor("1|1", base, base, false, 0, pids.roll)).toBeNull();
    });

    it("an unreproduced axis below the share limit is allowed with a named limitation", () => {
        const a = axes();
        // Yaw's logged P ten times too small (as on the SITL, where the logged yaw P is near zero): its share is tiny.
        a[2] = {
            ...a[2],
            current: { ...a[2].current, p: 1 },
            loggedP: Float64Array.from(a[2].loggedP!, (x) => x / 10),
        };
        const m = model(a);
        const rows = m.reproduction(base);
        const yaw = rows.find((r) => r.axis === "yaw")!;
        expect(yaw.reproduced).toBe(false);
        expect(yaw.share!).toBeLessThan(0.05);
        const as = m.assess("1|1", base, base, false, { roll: { p: 90, i: 79, d: 27, dMax: 36 } });
        expect(as.assessed).toBe(true);
        expect(as.axisRatios.yaw).toBeNull();
        expect(as.limitations!.some((x) => x.startsWith("noise_not_reproduced:yaw:share_"))).toBe(true);
    });

    it("gates (Grok block 13 r1): unknown mixer, unvalidated or unlogged D path, D added to a D-less axis, unvalidated chain noise band", () => {
        const mk = (over: Partial<Parameters<typeof motorNoiseModel>[0]> = {}, a = axes()) =>
            motorNoiseModel({
                axes: a,
                timeUs,
                rcThrottle,
                sampleRateHz: FS,
                pidDt: 0.001,
                noiseMask: mask,
                mixer: { kind: "quadx", yawReversed: false },
                motors: null,
                ...over,
            });
        const unknown = mk({ mixer: { kind: "unknown", reason: "mixer_type:CUSTOM:motors_logged:6" } });
        expect(unknown.staticReasons[0]).toMatch(/^mixer_not_modelled:/);
        expect(unknown.assess("1|1", base, base, false, {}).assessed).toBe(false);
        const notValidated = axes();
        notValidated[1] = { ...notValidated[1], dtermValidated: false };
        expect(mk({}, notValidated).staticReasons).toContain("dterm_path_not_validated:pitch");
        const notLogged = axes();
        notLogged[0] = { ...notLogged[0], dtermValidated: null };
        expect(mk({}, notLogged).staticReasons).toContain("dterm_not_logged_noise_unknown:roll");
        const m = mk();
        expect(m.ratiosFor("1|1", base, base, false, 2, { p: 56, i: 79, d: 10, dMax: 0 })).toBeNull();
        expect(m.assess("1|1", base, base, false, { yaw: { p: 56, i: 79, d: 10, dMax: 0 } }).reasons).toContain(
            "d_added_to_an_axis_without_d_not_modelled:yaw",
        );
        const chainBad = axes();
        chainBad[2] = { ...chainBad[2], chainNoiseValidated: false };
        const mc = mk({}, chainBad);
        expect(mc.gyroReasons).toEqual(["gyro_chain_noise_band_not_validated:yaw"]);
        // A gyro change is blocked for the motor sums, the per-axis noise of the validated axes is still predicted.
        const sim = { out: gyro, valid: new Uint8Array(N).fill(1) } as unknown as FilterSignals["sim"];
        const g = mc.assess("1.25|1", { sim, dterm: base.dterm }, base, true, {});
        expect(g.assessed).toBe(false);
        expect(g.axisRatios.roll).not.toBeNull();
        expect(g.axisRatios.yaw).toBeNull();
    });

    it("yaw_motors_reversed flips the yaw sign in every motor: per-motor powers equal the direct sum with yaw negated or not", () => {
        // Yaw shares the frame's common noise with roll and pitch here, so its sign in the mixer changes the motor powers.
        const gy = [gyro[0], gyro[1], Float64Array.from(gyro[2], (g, k) => g + 3 * common[k])];
        const ax = axes().map((a, ai) => ({
            ...a,
            gyroAdc: gy[ai],
            loggedP: Float64Array.from(gy[ai], (g) => -PTERM * a.current.p * g),
        }));
        const mk = (yawReversed: boolean) =>
            motorNoiseModel({
                axes: ax,
                timeUs,
                rcThrottle,
                sampleRateHz: FS,
                pidDt: 0.001,
                noiseMask: mask,
                mixer: { kind: "quadx", yawReversed },
                motors: null,
            });
        const cand = { p: 120, i: 79, d: 36, dMax: 48 };
        const normal = mk(false).assess("1|1", base, base, false, { roll: cand });
        const reversed = mk(true).assess("1|1", base, base, false, { roll: cand });
        const dRoll = dOf(0, dcfg(cand.d, cand.dMax)).d;
        const dRoll0 = dOf(0, dcfg(30, 40)).d;
        const dPitch = dOf(1, dcfg(61, 0)).d;
        const valid = new Uint8Array(N);
        const dv = [dOf(0, dcfg(30, 40)), dOf(0, dcfg(cand.d, cand.dMax)), dOf(1, dcfg(61, 0))];
        for (let k = 0; k < N; k++) valid[k] = dv.every((x) => x.valid[k] && Number.isFinite(x.d[k])) ? 1 : 0;
        const fin = (x: number) => (Number.isFinite(x) ? x : 0);
        const uR = Float64Array.from(gy[0], (g, k) => -PTERM * cand.p * g + fin(dRoll[k]));
        const uR0 = Float64Array.from(gy[0], (g, k) => -PTERM * 100 * g + fin(dRoll0[k]));
        const uP = Float64Array.from(gy[1], (g, k) => -PTERM * 82 * g + fin(dPitch[k]));
        const uY = Float64Array.from(gy[2], (g) => -PTERM * 56 * g);
        const ratio = (row: readonly number[], yawSign: number) => {
            const mix = (r: Float64Array) =>
                Float64Array.from({ length: N }, (_, k) => row[0] * r[k] + row[1] * uP[k] + yawSign * row[2] * uY[k]);
            return maskedBandPower(mix(uR), valid, mask, FS)! / maskedBandPower(mix(uR0), valid, mask, FS)!;
        };
        QUADX_MIX.forEach((row, m) => {
            expect(normal.motorRatios![m]).toBeCloseTo(ratio(row, -1), 6);
            expect(reversed.motorRatios![m]).toBeCloseTo(ratio(row, +1), 6);
        });
        // The flip is visible: on at least one motor the two differ by more than 1 %.
        expect(
            Math.max(...normal.motorRatios!.map((r, m) => Math.abs(r - reversed.motorRatios![m]) / r)),
        ).toBeGreaterThan(0.01);
    });

    it("every ratio is paired: a candidate series with fewer valid samples reads the baseline on the same samples", () => {
        const m = model();
        // Candidate chain simulation valid only on the second half: the baseline must be read there too.
        const half = Uint8Array.from({ length: N }, (_, k) => (k >= N / 2 ? 1 : 0));
        const sim = { out: gyro, valid: half } as unknown as FilterSignals["sim"];
        const a = m.assess("cand", { sim, dterm: base.dterm }, base, true, {});
        // Same signals as the baseline (the "chain" passes the logged gyro): every ratio is exactly 1 on paired samples.
        expect(a.assessed).toBe(true);
        a.motorRatios!.forEach((r) => expect(r).toBeCloseTo(1, 9));
        expect(a.axisRatios.roll!).toBeCloseTo(1, 9);
    });

    it("the quadratic basis is paired too: a half-valid candidate series gives ratio 1 at the current tune", () => {
        const half = Uint8Array.from({ length: N }, (_, k) => (k >= N / 2 ? 1 : 0));
        const sim = { out: gyro, valid: half } as unknown as FilterSignals["sim"];
        const q = model().ratiosFor("cand-basis", { sim, dterm: base.dterm }, base, true, 0, pids.roll)!;
        q.motorRatios.forEach((r) => expect(r).toBeCloseTo(1, 9));
        expect(q.axisRatio!).toBeCloseTo(1, 9);
    });
});
