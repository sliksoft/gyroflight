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
 * Block 9: the I term in force during a CHIRP sweep. pid.c relaxes I on the swept setpoint
 * (applyItermRelax after `currentPidSetpoint += currentChirp`), so the closed-loop T of a sweep was
 * measured under a controller with (almost) no I. The plant is extracted with that controller; the
 * margins and candidates keep the I of normal flight. SIMULATION ONLY.
 */

import { describe, expect, it } from "vitest";
import {
    BOX_ANGLE_BIT,
    ITERM_RELAX_ACCEPT,
    itermRelaxApplies,
    itermRelaxConfigFromHeaders,
    itermRelaxForSweep,
    itermRelaxInForce,
} from "../../src/js/blackbox/betaflight_iterm_relax";
import {
    cadd,
    cdiv,
    cmag,
    cmul,
    evaluateControllerFrf,
    ITERM_SCALE,
    pt1Gain,
    type Complex,
    type DigitalControllerConfig,
} from "../../src/js/blackbox/betaflight_digital_controller";
import type { TransferFunction } from "../../src/js/blackbox/spectral_analysis";
import { buildAxisLoop, loopMargins, loopUncertainty } from "../../src/gyrocore/engine/loopModel";

const PID_DT = 250e-6;
const HEADERS = {
    rollPID: "56,79,30",
    pitchPID: "82,117,61",
    yawPID: "56,79,0",
    iterm_relax: "1",
    iterm_relax_type: "1",
    iterm_relax_cutoff: "25",
};

/**
 * A sweep-like setpoint and a gyro that follows it, and the logged I the firmware recurrence gives
 * (relaxed, or not), rounded as blackbox.c logs it (lrintf).
 */
function sweepLog(o: { relaxed: boolean; angle: boolean; seconds?: number; amp?: number }) {
    const n = Math.round((o.seconds ?? 10) / PID_DT);
    const amp = o.amp ?? 60;
    const sp = new Float64Array(n);
    const gyro = new Float64Array(n);
    const P = new Float64Array(n);
    const I = new Float64Array(n);
    const mask = new Float64Array(n).fill(1 | (o.angle ? BOX_ANGLE_BIT : 0));
    const ki = ITERM_SCALE * 79;
    const k1 = pt1Gain(25, PID_DT);
    let lpf = 0;
    let iTerm = 0;
    let phase = 0;
    for (let k = 0; k < n; k++) {
        const t = k * PID_DT;
        const f = 2 * 30 ** (t / (o.seconds ?? 10)); // 2 → 60 Hz exponential
        phase += 2 * Math.PI * f * PID_DT;
        sp[k] = amp * Math.sin(phase) + 5;
        gyro[k] = 0.9 * amp * Math.sin(phase - 0.3) + 4;
        const e = sp[k] - gyro[k];
        P[k] = Math.round(0.032029 * 56 * e);
        lpf += k1 * (sp[k] - lpf);
        const thr = 40 * (o.angle ? 0.2 : 1);
        const factor = o.relaxed ? Math.max(0, 1 - Math.abs(sp[k] - lpf) / thr) : 1;
        if (k > 0) iTerm += ki * PID_DT * factor * e;
        I[k] = Math.round(iTerm);
    }
    return { sp, gyro, P, I, mask, n };
}

describe("iterm_relax configuration from the log headers", () => {
    it("reads RP / SETPOINT and applies it to roll and pitch, not yaw", () => {
        const roll = itermRelaxConfigFromHeaders(HEADERS, 0, PID_DT);
        expect(roll.config).not.toBeNull();
        expect(roll.config!.ki).toBeCloseTo(ITERM_SCALE * 79, 12);
        expect(itermRelaxApplies(roll.config!, 0)).toBe(true);
        const yaw = itermRelaxConfigFromHeaders(HEADERS, 2, PID_DT);
        expect(yaw.config!.ki).toBeCloseTo(ITERM_SCALE * 79 * 2.5, 12);
        expect(itermRelaxApplies(yaw.config!, 2)).toBe(false);
        expect(
            itermRelaxApplies(itermRelaxConfigFromHeaders({ ...HEADERS, iterm_relax: "2" }, 2, PID_DT).config!, 2),
        ).toBe(true);
    });

    it("refuses what it does not model instead of approximating", () => {
        expect(itermRelaxConfigFromHeaders({ ...HEADERS, iterm_relax: "3" }, 0, PID_DT).reasons).toEqual([
            "iterm_relax_unsupported:3",
        ]);
        expect(itermRelaxConfigFromHeaders({ ...HEADERS, iterm_relax_type: "0" }, 0, PID_DT).reasons).toEqual([
            "iterm_relax_type_unsupported:0",
        ]);
        const { iterm_relax_cutoff: _drop, ...noCutoff } = HEADERS;
        expect(itermRelaxConfigFromHeaders(noCutoff, 0, PID_DT).reasons).toEqual(["iterm_relax_headers_missing"]);
    });
});

describe("the I term in force over a sweep, against the logged axisI", () => {
    const cfg = itermRelaxConfigFromHeaders(HEADERS, 0, PID_DT).config!;
    const run = (log: ReturnType<typeof sweepLog>, mask: ArrayLike<number> | null = log.mask) =>
        itermRelaxInForce(
            {
                setpoint: log.sp,
                gyro: log.gyro,
                loggedI: log.I,
                loggedP: log.P,
                modeMask: mask,
                start: 4000,
                end: log.n,
            },
            cfg,
            0,
        );

    it("reconstructs a relaxed I in ANGLE mode: mostly frozen, Ki × mean factor", () => {
        const r = run(sweepLog({ relaxed: true, angle: true }));
        expect(r.status).toBe("reconstructed");
        expect(r.frozenFraction!).toBeGreaterThan(0.5);
        expect(r.meanFactor).toBeGreaterThan(0);
        expect(r.meanFactor).toBeLessThan(0.3);
        expect(r.rmsError!).toBeLessThanOrEqual(ITERM_RELAX_ACCEPT.maxRmsOfUnrelaxed * r.rmsErrorUnrelaxed!);
    });

    it("uses the ACRO threshold (40 °/s) without the ANGLE bit: more of I stays active", () => {
        const angle = run(sweepLog({ relaxed: true, angle: true }));
        const acro = run(sweepLog({ relaxed: true, angle: false }));
        expect(acro.status).toBe("reconstructed");
        expect(acro.meanFactor).toBeGreaterThan(angle.meanFactor);
    });

    it("does not claim a relax the log does not show (I logged unrelaxed): unknown, headers' I", () => {
        const r = run(sweepLog({ relaxed: false, angle: true }));
        expect(r.status).toBe("unknown");
        expect(r.meanFactor).toBe(1);
        expect(r.reasons.some((x) => x.startsWith("iterm_relax_not_distinguished"))).toBe(true);
    });

    it("needs the logged mode mask: without it the threshold is unknown", () => {
        const log = sweepLog({ relaxed: true, angle: true });
        const r = run(log, null);
        expect(r.status).toBe("unknown");
        expect(r.reasons).toEqual(["iterm_relax_angle_mode_unknown"]);
        expect(r.meanFactor).toBe(1);
    });

    it("a mode mask of the wrong flight mode does not reproduce the logged I", () => {
        // Logged in ANGLE, read as ACRO: the threshold is 5× too high and the residual shows it.
        const log = sweepLog({ relaxed: true, angle: true, amp: 25 });
        const asAcro = run(log, new Float64Array(log.n).fill(1));
        const asAngle = run(log);
        expect(asAngle.rmsError!).toBeLessThan(asAcro.rmsError!);
    });
});

describe("itermRelaxForSweep: the decision the engine takes per axis", () => {
    const log = sweepLog({ relaxed: true, angle: true });
    const signals = { setpoint: log.sp, gyro: log.gyro, loggedI: log.I, loggedP: log.P, modeMask: log.mask };
    const win = { start: 4000, end: log.n };
    it("yaw under RP is not relaxed: the headers' I", () => {
        const r = itermRelaxForSweep(HEADERS, 2, PID_DT, signals, win);
        expect(r.status).toBe("not_relaxed");
        expect(r.meanFactor).toBe(1);
    });
    it("roll with the logged terms is reconstructed; without them it is unknown", () => {
        expect(itermRelaxForSweep(HEADERS, 0, PID_DT, signals, win).status).toBe("reconstructed");
        const r = itermRelaxForSweep(HEADERS, 0, PID_DT, null, win);
        expect(r).toMatchObject({ status: "unknown", meanFactor: 1, reasons: ["iterm_relax_logged_terms_missing"] });
    });
    it("missing headers: unknown, never a guess", () => {
        expect(itermRelaxForSweep({ rollPID: "56,79,30" }, 0, PID_DT, signals, win)).toMatchObject({
            status: "unknown",
            meanFactor: 1,
            reasons: ["iterm_relax_headers_missing"],
        });
    });
});

// --- the plant extracted with the controller in force -------------------------------------------

const CFG: DigitalControllerConfig = {
    gyroDt: 125e-6,
    pidDt: PID_DT,
    axis: { p: 56, i: 79, d: 30.8, f: 0 },
    dtermLpf1Hz: 110,
    dtermLpf2Hz: 150,
};
const SWEEP_CFG: DigitalControllerConfig = { ...CFG, axis: { ...CFG.axis, i: 79 * 0.11 } };

/** A rate plant K / (s (τ s + 1)) · e^(−s Td). */
function plantAt(f: number): Complex {
    const w = 2 * Math.PI * f;
    const K = 400;
    const tau = 0.012;
    const Td = 0.0025;
    const s: Complex = { re: 0, im: w };
    const den = cmul(s, cadd({ re: 1, im: 0 }, { re: 0, im: w * tau }));
    return cmul(cdiv({ re: K, im: 0 }, den), { re: Math.cos(-w * Td), im: Math.sin(-w * Td) });
}

/** The closed-loop T a sweep measures under controller `c` (D on the gyro): G·C_ref / (1 + G·C_fb). */
function measuredT(c: DigitalControllerConfig): TransferFunction {
    const f = Array.from({ length: 60 }, (_, k) => 2 + k * 2);
    const T = f.map((hz) => {
        const frf = evaluateControllerFrf(c, hz);
        const G = plantAt(hz);
        return cdiv(cmul(G, frf.cReference), cadd({ re: 1, im: 0 }, cmul(G, frf.cFeedback)));
    });
    return {
        frequencies: Float64Array.from(f),
        magnitude: Float64Array.from(T, (t) => 20 * Math.log10(cmag(t))),
        phase: Float64Array.from(T, (t) => (Math.atan2(t.im, t.re) * 180) / Math.PI),
        coherence: new Float64Array(f.length).fill(0.99),
        hReal: Float64Array.from(T, (t) => t.re),
        hImag: Float64Array.from(T, (t) => t.im),
        numSegments: 30,
    };
}

describe("buildAxisLoop with the controller in force during the sweep", () => {
    const tf = measuredT(SWEEP_CFG);

    it("recovers the plant exactly; the headers' controller does not", () => {
        const right = buildAxisLoop(0, tf, CFG, null, false, false, null, { sweepCfg: SWEEP_CFG });
        const wrong = buildAxisLoop(0, tf, CFG, null, false, false);
        let maxRight = 0;
        let maxWrong = 0;
        for (const b of right.plant.bins) {
            if (b.status !== "ok" || !b.G) continue;
            const G = plantAt(b.frequencyHz);
            maxRight = Math.max(maxRight, cmag({ re: b.G.re - G.re, im: b.G.im - G.im }) / cmag(G));
        }
        for (const b of wrong.plant.bins) {
            if (b.status !== "ok" || !b.G) continue;
            const G = plantAt(b.frequencyHz);
            maxWrong = Math.max(maxWrong, cmag({ re: b.G.re - G.re, im: b.G.im - G.im }) / cmag(G));
        }
        expect(maxRight).toBeLessThan(1e-9);
        expect(maxWrong).toBeGreaterThan(0.05);
    });

    it("reads the margins with the flight controller (I active), on the plant of the sweep", () => {
        const loop = buildAxisLoop(0, tf, CFG, null, false, false, null, { sweepCfg: SWEEP_CFG });
        expect(loop.cfg).toBe(CFG);
        expect(loop.sweepCfg).toBe(SWEEP_CFG);
        // The truth: the known plant closed with the flight controller.
        const truth = buildAxisLoop(0, measuredT(CFG), CFG, null, false, false);
        const a = loopMargins(loop).measured;
        const b = loopMargins(truth).measured;
        expect(a.phaseMarginDeg!).toBeCloseTo(b.phaseMarginDeg!, 6);
        expect(a.sensitivityPeakDb!).toBeCloseTo(b.sensitivityPeakDb!, 6);
    });

    it("propagates the uncertainty of T with the controller T was measured under", () => {
        const loop = buildAxisLoop(0, tf, CFG, null, false, false, null, { sweepCfg: SWEEP_CFG });
        const expected = loopUncertainty(tf, SWEEP_CFG, {});
        for (const [f, e] of expected.relErr!) expect(loop.uncertainty.relErr!.get(f)).toBe(e);
        expect(loopUncertainty(tf, CFG, {}).relErr!.get(4)).not.toBe(expected.relErr!.get(4));
    });

    it("leaves a loop without a sweep controller as before (no sweepCfg field)", () => {
        const loop = buildAxisLoop(0, tf, CFG, null, false, false);
        expect("sweepCfg" in loop).toBe(false);
    });
});
