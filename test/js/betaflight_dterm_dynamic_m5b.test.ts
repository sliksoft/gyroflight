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

// GF-1 M5-B: the dynamic D-term path is taken from the firmware (cutoff from the
// logged throttle, quantized and rate-limited; D_max; TPA), not fitted. These
// cases pin the firmware formulas and show that the synthetic "logged" axisD
// is only accepted for the model that produced it.

import { describe, expect, it } from "vitest";
import {
    air65PitchConfig,
    air65RollConfig,
    DTERM_SCALE,
    evaluateControllerFrf,
} from "../../src/js/blackbox/betaflight_digital_controller";
import {
    dtermConfigFromHeaders,
    dtermFitAccepted,
    dtermLpf1CutoffForThrottle,
    dynLpfCutoffHz,
    effectiveDtermOverWindow,
    fitDterm,
    mixerThrottle,
    simulateDterm,
    summarizeCutoff,
    supportIssues,
    withEffectiveDterm,
    type DtermDynamicConfig,
} from "../../src/js/blackbox/betaflight_dterm_dynamic";

const FS = 4000;
const DT = 1 / FS;

// The AIR65 header values (BBL18/BBL19, Betaflight 2026.6.2).
const AIR65_HEADERS: Record<string, string> = {
    rollPID: "56,79,30",
    pitchPID: "82,117,61",
    yawPID: "56,79,0",
    d_max: "40,0,0",
    d_max_gain: "20",
    d_max_advance: "35",
    dterm_lpf1_type: "0",
    dterm_lpf1_static_hz: "75",
    dterm_lpf1_dyn_hz: "75,150",
    dterm_lpf1_dyn_expo: "5",
    dterm_lpf2_type: "0",
    dterm_lpf2_static_hz: "150",
    dterm_notch_hz: "0",
    tpa_rate: "60",
    tpa_breakpoint: "1350",
    tpa_low_rate: "20",
    tpa_low_breakpoint: "1050",
    tpa_low_always: "0",
    throttle_limit_type: "0",
};

const pitch = (): DtermDynamicConfig => dtermConfigFromHeaders(AIR65_HEADERS, 1, DT)!;
const roll = (): DtermDynamicConfig => dtermConfigFromHeaders(AIR65_HEADERS, 0, DT)!;

function trace(n: number, gyro: (k: number) => number, rc: (k: number) => number, dropAt: number[] = []) {
    const timeUs: number[] = [];
    let t = 0;
    for (let k = 0; k < n; k++) {
        t += dropAt.includes(k) ? 500 : 250;
        timeUs.push(t);
    }
    return {
        timeUs,
        gyro: Array.from({ length: n }, (_, k) => gyro(k)),
        rcThrottle: Array.from({ length: n }, (_, k) => rc(k)),
    };
}

/** Complex gain of the simulated D against the gyro tone, from the settled part. */
function toneGain(d: Float64Array, valid: Uint8Array, f: number, amp: number) {
    let re = 0;
    let im = 0;
    let n = 0;
    for (let k = 0; k < d.length; k++) {
        if (!valid[k]) continue;
        const w = 2 * Math.PI * f * k * DT;
        re += d[k] * Math.cos(w);
        im -= d[k] * Math.sin(w);
        n++;
    }
    return { re: (2 * re) / n / amp, im: (2 * im) / n / amp };
}

describe("firmware formulas", () => {
    it("dynLpfCutoffFreq with expo and the dynThrottle branch without it", () => {
        // 75 + 75 * (0.35 + 0.35 * 0.65 * 0.5)
        expect(dynLpfCutoffHz(0.35, 75, 150, 5)).toBeCloseTo(109.78125, 10);
        expect(dynLpfCutoffHz(0, 75, 150, 5)).toBe(75);
        expect(dynLpfCutoffHz(1, 75, 150, 5)).toBe(150);
        // expo 0: max(dynThrottle(t) * max, min), dynThrottle(0.5) = 0.6875
        expect(dynLpfCutoffHz(0.5, 75, 150, 0)).toBeCloseTo(103.125, 10);
        expect(dynLpfCutoffHz(0.1, 75, 150, 0)).toBe(75);
    });

    it("throttle comes from rcCommand[3] and is quantized to 1/100 before the curve", () => {
        expect(mixerThrottle(1345)).toBeCloseTo(0.345, 12);
        expect(mixerThrottle(900)).toBe(0);
        expect(mixerThrottle(2100)).toBe(1);
        const cfg = pitch();
        expect(dtermLpf1CutoffForThrottle(cfg, 0.3449)).toBe(dynLpfCutoffHz(0.34, 75, 150, 5));
        // Static lpf1 when dyn min is 0.
        expect(dtermLpf1CutoffForThrottle({ ...cfg, dtermLpf1DynMinHz: 0 }, 0.5)).toBe(75);
    });

    it("reads the AIR65 header subset and refuses a header with a key missing", () => {
        const r = roll();
        expect([r.d, r.dMax, r.dtermLpf1DynMinHz, r.dtermLpf1DynMaxHz, r.dtermLpf1DynExpo]).toEqual([
            30, 40, 75, 150, 5,
        ]);
        expect(pitch().d).toBe(61);
        expect(pitch().dMax).toBe(0);
        const { dterm_lpf1_dyn_hz: _omit, ...missing } = AIR65_HEADERS;
        expect(dtermConfigFromHeaders(missing, 0, DT)).toBeNull();
    });

    it("does not simulate filter types or options it does not model", () => {
        expect(supportIssues(pitch())).toEqual([]);
        for (const [patch, issue] of [
            [{ dtermLpf1Type: 1 }, "dterm_lpf1_type_not_pt1"],
            [{ dtermLpf2Type: 2 }, "dterm_lpf2_type_not_pt1"],
            [{ dtermNotchHz: 200 }, "dterm_notch_not_modelled"],
            [{ throttleLimitType: 1 }, "throttle_limit_not_modelled"],
        ] as const) {
            const sim = simulateDterm(
                trace(
                    2000,
                    () => 0,
                    () => 1350,
                ),
                { ...pitch(), ...patch },
            );
            expect(sim.notes).toContain(issue);
            expect(sim.runs).toBe(0);
            expect(sim.valid.every((v) => v === 0)).toBe(true);
        }
    });
});

describe("D path against the M1 frequency response", () => {
    it("at held throttle the simulated D equals M1 Cd at the throttle's cutoff, not at the static 75 Hz", () => {
        const f = 40;
        const amp = 50;
        const tr = trace(
            16000,
            (k) => amp * Math.cos(2 * Math.PI * f * k * DT),
            () => 1350,
        );
        const sim = simulateDterm(tr, pitch());
        expect(summarizeCutoff(sim)).toEqual({ minHz: 109.78125, medianHz: 109.78125, maxHz: 109.78125 });
        const g = toneGain(sim.d, sim.valid, f, amp);
        const cd = (lpf1: number) => {
            const frf = evaluateControllerFrf({ ...air65PitchConfig(), dtermLpf1Hz: lpf1 }, f);
            // D on gyro is −Cd·y.
            return { re: -(frf.cFeedback.re - frf.cReference.re), im: -(frf.cFeedback.im - frf.cReference.im) };
        };
        const dyn = cd(109.78125);
        const stat = cd(75);
        const rel = (a: { re: number; im: number }, b: { re: number; im: number }) =>
            Math.hypot(a.re - b.re, a.im - b.im) / Math.hypot(b.re, b.im);
        expect(rel(g, dyn)).toBeLessThan(2e-3);
        expect(rel(g, stat)).toBeGreaterThan(0.05);
    });

    it("withEffectiveDterm puts the window's median cutoff and Kd scale into the M1 config", () => {
        const tr = trace(
            8000,
            (k) => 30 * Math.sin(2 * Math.PI * 20 * k * DT),
            () => 1340,
        );
        const sim = simulateDterm(tr, pitch());
        const eff = effectiveDtermOverWindow(sim, 0, 8000)!;
        expect(eff.lpf1Hz).toBeCloseTo(dynLpfCutoffHz(0.34, 75, 150, 5), 10);
        expect(eff.kdScale).toBeCloseTo(1, 12); // below the TPA breakpoint, no D_max on pitch
        const cfg = withEffectiveDterm(air65PitchConfig(), { ...eff, kdScale: 0.99 });
        expect(cfg.dtermLpf1Hz).toBe(eff.lpf1Hz);
        expect(cfg.axis.d).toBeCloseTo(61 * 0.99, 12);
        expect(air65PitchConfig().dtermLpf1Hz).toBe(75); // the static header config is unchanged
    });
});

describe("time-varying behaviour", () => {
    it("a throttle step moves the cutoff only after the 5 ms rate limit, one loop late", () => {
        // Step at sample 1000; no update since the start because throttle was constant.
        const tr = trace(
            2000,
            () => 0,
            (k) => (k < 1000 ? 1300 : 1600),
        );
        const sim = simulateDterm(tr, pitch());
        const low = dynLpfCutoffHz(0.3, 75, 150, 5);
        const high = dynLpfCutoffHz(0.6, 75, 150, 5);
        expect(sim.cutoffHz[1000]).toBe(low);
        // The mixer of loop 1000 sees the new throttle, loop 1001 filters with it.
        expect(sim.cutoffHz[1001]).toBe(high);
        // A second change 1 ms later is held back until 5 ms after the last update (20 loops).
        const tr2 = trace(
            2000,
            () => 0,
            (k) => (k < 1000 ? 1300 : k < 1004 ? 1600 : 1700),
        );
        const sim2 = simulateDterm(tr2, pitch());
        expect(sim2.cutoffHz[1010]).toBe(high);
        expect(sim2.cutoffHz[1020]).toBe(high);
        expect(sim2.cutoffHz[1021]).toBe(dynLpfCutoffHz(0.7, 75, 150, 5));
    });

    it("TPA scales D above the breakpoint (rate 60 %, breakpoint 1350)", () => {
        const tr = trace(
            2000,
            (k) => 20 * Math.sin(0.05 * k),
            () => 1675,
        );
        const sim = simulateDterm(tr, pitch());
        // 1 − (0.6 / 0.65) · (0.675 − 0.35) = 0.7
        expect(sim.tpaFactor[1000]).toBeCloseTo(0.7, 6);
        // And D itself carries it: same static filters, below vs above the breakpoint.
        const fixed = { ...pitch(), dtermLpf1DynMinHz: 0 };
        const above = simulateDterm(tr, fixed);
        const below = simulateDterm({ ...tr, rcThrottle: tr.rcThrottle.map(() => 1340) }, fixed);
        expect(above.d[1000] / below.d[1000]).toBeCloseTo(0.7, 6);
    });

    it("after a throttle step the filter runs at the new cutoff", () => {
        const g = (k: number) => 40 * Math.sin(2 * Math.PI * 90 * k * DT);
        const stepped = simulateDterm(
            trace(6000, g, (k) => (k < 1000 ? 1300 : 1600)),
            pitch(),
        );
        const held = simulateDterm(
            trace(6000, g, () => 1600),
            pitch(),
        );
        // Long after the step the PT1 state has forgotten the old cutoff.
        expect(stepped.d[5000]).toBeCloseTo(held.d[5000], 6);
        const low = simulateDterm(
            trace(6000, g, () => 1300),
            pitch(),
        );
        expect(Math.abs(low.d[5000] - held.d[5000])).toBeGreaterThan(1e-3);
    });

    it("D_max boosts roll with the gyro derivative and never beyond d_max / D", () => {
        const fast = trace(
            8000,
            (k) => 300 * Math.sin(2 * Math.PI * 60 * k * DT),
            () => 1340,
        );
        const sim = simulateDterm(fast, roll());
        const mult = Array.from(sim.dMaxMultiplier).filter((_, k) => sim.valid[k]);
        expect(Math.max(...mult)).toBeGreaterThan(1.05);
        expect(Math.max(...mult)).toBeLessThanOrEqual(40 / 30 + 1e-12);
        const slow = simulateDterm(
            trace(
                8000,
                (k) => 1 * Math.sin(2 * Math.PI * 2 * k * DT),
                () => 1340,
            ),
            roll(),
        );
        expect(Math.max(...Array.from(slow.dMaxMultiplier).filter((_, k) => slow.valid[k]))).toBeLessThan(1.001);
        // Pitch has d_max 0 → no boost at all.
        const p = simulateDterm(fast, pitch());
        expect(Array.from(p.dMaxMultiplier).every((m, k) => !p.valid[k] || m === 1)).toBe(true);
    });

    it("marks the setpoint part of D_max as not modelled outside self-level", () => {
        const tr = trace(
            2000,
            (k) => 10 * Math.sin(0.1 * k),
            () => 1340,
        );
        const acro = simulateDterm({ ...tr, selfLevel: tr.gyro.map(() => false) }, roll());
        expect(acro.notes).toContain("setpoint_boost_not_modelled");
        const angle = simulateDterm({ ...tr, selfLevel: tr.gyro.map(() => true) }, roll());
        expect(angle.notes).not.toContain("setpoint_boost_not_modelled");
    });

    it("a dropped frame restarts the filters and discards the warm-up on both sides", () => {
        const tr = trace(
            4000,
            (k) => 10 * Math.sin(0.01 * k),
            () => 1340,
            [2000],
        );
        const sim = simulateDterm(tr, pitch());
        expect(sim.runs).toBe(2);
        expect(sim.valid[1999]).toBe(1);
        expect(sim.valid[2000]).toBe(0);
        expect(sim.valid[2000 + 399]).toBe(0);
        expect(sim.valid[2000 + 400]).toBe(1);
    });
});

describe("acceptance against a logged axisD", () => {
    // "Logged" D: the firmware path with a slowly wandering throttle, rounded like the blackbox.
    function logged(cfg: DtermDynamicConfig) {
        let seed = 7;
        const noise = () => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed / 2147483648 - 0.5;
        };
        const n = 40000;
        const tr = trace(
            n,
            (k) => Math.round(80 * Math.sin(2 * Math.PI * (2 + 0.004 * k) * k * DT) + 20 * noise()),
            (k) => 1300 + 120 * Math.sin((2 * Math.PI * k) / 16000),
        );
        const truth = simulateDterm(tr, cfg);
        return { tr, axisD: Array.from(truth.d, (v) => (Number.isFinite(v) ? Math.round(v) : NaN)) };
    }

    it("accepts the dynamic model and rejects the static 75 Hz one", () => {
        const cfg = pitch();
        const { tr, axisD } = logged(cfg);
        const dyn = fitDterm(simulateDterm(tr, cfg), axisD, FS);
        const stat = fitDterm(simulateDterm(tr, cfg, { kind: "fixed", hz: 75 }), axisD, FS);
        expect(dyn!.nrmse).toBeLessThan(stat!.nrmse);
        expect(dtermFitAccepted(dyn, stat)).toBe(true);
        expect(dtermFitAccepted(stat, dyn)).toBe(false);
        const hi = stat!.bands.find((b) => b.loHz === 80)!;
        expect(hi.gainRatio!).toBeGreaterThan(1.05);
    });

    it("rejects a fit without coherent bands or without enough samples", () => {
        const cfg = pitch();
        const { tr, axisD } = logged(cfg);
        const sim = simulateDterm(tr, cfg);
        expect(
            fitDterm(
                sim,
                axisD.map(() => 0),
                FS,
            ),
        ).toBeNull();
        const short = simulateDterm(
            trace(
                600,
                () => 0,
                () => 1340,
            ),
            cfg,
        );
        expect(fitDterm(short, new Array(600).fill(0), FS)).toBeNull();
        expect(dtermFitAccepted(null, null)).toBe(false);
    });

    it("keeps DTERM_SCALE as the D gain the firmware uses", () => {
        // Guard against a units slip: Kd for D 61 is 0.032269.
        expect(DTERM_SCALE * 61).toBeCloseTo(0.032269, 6);
        expect(air65RollConfig().axis.d).toBe(30);
    });
});
