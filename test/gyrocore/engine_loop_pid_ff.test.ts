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
 * Engine v2 against known ground truth: margins of a synthetic loop (plant known, so L is
 * known exactly), the PID search on it, the feedforward gate and calibration, the Safety
 * evidence contract and the chain-validation acceptance.
 */

import { describe, expect, it } from "vitest";
import { declaredSupport } from "./harness/frequencySupport";
import { declaredConvergence } from "./harness/resolutionConvergence";
import {
    air65RollConfig,
    cadd,
    cmag,
    cmul,
    cphaseDeg,
    evaluateControllerFrf,
    type DigitalControllerConfig,
} from "../../src/js/blackbox/betaflight_digital_controller";
import { closedLoopFromPlant, plantFrf, syntheticTransferFunction } from "../../src/js/blackbox/betaflight_open_loop";
import { buildAxisLoop, loopMargins, validateChain } from "../../src/gyrocore/engine/loopModel";
import { optimizeAxisPid, PID_TARGETS } from "../../src/gyrocore/engine/pidOptimizer";
import { optimizeFeedforward } from "../../src/gyrocore/engine/feedforwardOptimizer";
import { absoluteSafetyEvidence } from "../../src/gyrocore/engine/safetyEvidence";
import type { ChainSimulation, EffectiveChain } from "../../src/gyrocore/engine/gyroChain";

const FREQS = Array.from({ length: 199 }, (_, i) => 1 + i * 0.5);

// SIMULATION: 0.1 Hz to 160 Hz (QUALIFICATION_BAND_EXTENSION × the 100 Hz primary band and more),
// with the Welch analysis such bins take at 4 kHz (40 000-sample segments, 32 of them).
const FINE_FREQS = Array.from({ length: 1591 }, (_, i) => 1 + i * 0.1);
const FINE_WELCH = { segmentSamples: 40000, sampleRateHz: 4000, windowSamples: 40000 * 16.5, segments: 32 };

function tfFor(cfg: DigitalControllerConfig, K: number, freqs = FREQS) {
    return syntheticTransferFunction(freqs, (f) => {
        const frf = evaluateControllerFrf(cfg, f);
        return closedLoopFromPlant(plantFrf(f, { K, motorHz: 40, delayS: 0.002 }), frf.cReference, frf.cFeedback);
    });
}

const steadyChain: EffectiveChain = {
    samples: 1000,
    frf: () => ({ re: 1, im: 0 }),
    spread: () => ({ phaseDeg: 0.5, gainDb: 0.05 }),
    medianLpf1Hz: 200,
    dynNotchHz: [],
};

/** Ground truth: exact crossover by bisection on the analytic L = G·C_fb; |S| on the bins. */
function truth(cfg: DigitalControllerConfig, K: number) {
    const L = (f: number) =>
        cmul(plantFrf(f, { K, motorHz: 40, delayS: 0.002 }), evaluateControllerFrf(cfg, f).cFeedback);
    let lo = 2;
    let hi = 2;
    while (cmag(L(hi)) >= 1) hi += 0.5;
    lo = hi - 0.5;
    for (let k = 0; k < 60; k++) {
        const mid = (lo + hi) / 2;
        if (cmag(L(mid)) >= 1) lo = mid;
        else hi = mid;
    }
    const s = Math.max(...FREQS.filter((f) => f >= 2).map((f) => -20 * Math.log10(cmag(cadd({ re: 1, im: 0 }, L(f))))));
    return { pm: 180 + cphaseDeg(L(lo)), s };
}

describe("loop margins on a synthetic loop", () => {
    const cfg = air65RollConfig();
    it("PM and |S| peak equal the ground truth of L = G·C_fb", () => {
        const loop = buildAxisLoop(0, tfFor(cfg, 80), cfg, steadyChain, true, true, null, {
            support: declaredSupport(tfFor(cfg, 80)),
            resolution: declaredConvergence(),
        });
        const m = loopMargins(loop);
        const t = truth(cfg, 80);
        // Linear interpolation between 0.5 Hz bins: within a few tenths of a degree.
        expect(Math.abs(m.phaseMarginDeg! - t.pm)).toBeLessThan(0.3);
        expect(m.sensitivityPeakDb!).toBeCloseTo(t.s, 1);
        expect(m.gainMarginDb).not.toBeNull();
        // Bounds the bins resolve, model class not qualified by a finer independent log: MODEL_CONDITIONAL.
        expect(m.evidence.level).toBe("MODEL_CONDITIONAL");
        expect(m.status).toBe("NOT_VALIDATED");
    });

    it("is VALIDATED only with a validated chain, a steady chain and an attestation", () => {
        const tf = tfFor(cfg, 80);
        expect(
            loopMargins(
                buildAxisLoop(0, tf, cfg, steadyChain, false, true, null, {
                    support: declaredSupport(tf),
                    resolution: declaredConvergence(),
                }),
            ).reasons,
        ).toContain("chain_model_not_validated_on_this_log");
        expect(
            loopMargins(
                buildAxisLoop(0, tf, cfg, steadyChain, true, false, null, {
                    support: declaredSupport(tf),
                    resolution: declaredConvergence(),
                }),
            ).reasons,
        ).toContain("independent_validation_missing");
        const moving = { ...steadyChain, spread: () => ({ phaseDeg: 9, gainDb: 1 }) };
        expect(
            loopMargins(
                buildAxisLoop(0, tf, cfg, moving, true, true, null, {
                    support: declaredSupport(tf),
                    resolution: declaredConvergence(),
                }),
            ).reasons,
        ).toContain("chain_moves_at_crossover:9.0deg");
        expect(
            loopMargins(
                buildAxisLoop(0, tf, cfg, null, true, true, null, {
                    support: declaredSupport(tf),
                    resolution: declaredConvergence(),
                }),
            ).reasons,
        ).toContain("chain_spread_unknown");
    });

    it("never extrapolates: a band that ends below the crossover gives no margin", () => {
        const short = syntheticTransferFunction(
            FREQS.filter((f) => f <= 20),
            (f) => {
                const frf = evaluateControllerFrf(cfg, f);
                return closedLoopFromPlant(
                    plantFrf(f, { K: 80, motorHz: 40, delayS: 0.002 }),
                    frf.cReference,
                    frf.cFeedback,
                );
            },
        );
        const m = loopMargins(
            buildAxisLoop(0, short, cfg, steadyChain, true, true, null, {
                support: declaredSupport(short),
                resolution: declaredConvergence(),
            }),
        );
        expect(m.phaseMarginDeg).toBeNull();
        expect(m.reasons).toContain("crossover_outside_identified_band");
    });
});

describe("PID search", () => {
    const cfg = air65RollConfig();
    const current = { p: cfg.axis.p, i: cfg.axis.i, d: cfg.axis.d, dMax: 40 };

    it("with margin to spare it raises bandwidth and stays inside every target", () => {
        // SIMULATION: a synthetic finer identification (0.1 Hz) of the same plant stands in for the
        // model-class qualification log; contract logic only, never flight evidence.
        const fineTf = tfFor(cfg, 40, FINE_FREQS);
        const loop = buildAxisLoop(
            0,
            tfFor(cfg, 40),
            cfg,
            steadyChain,
            true,
            true,
            {
                tf: fineTf,
                source: { sha256: "5".repeat(64), logIndex: 0 },
                analysis: FINE_WELCH,
                support: declaredSupport(fineTf),
            },
            { support: declaredSupport(tfFor(cfg, 40)), resolution: declaredConvergence() },
        );
        const r = optimizeAxisPid(loop, current);
        expect(r.outcome).toBe("improved");
        expect(r.proposedMargins.crossoverHz!).toBeGreaterThan(r.currentMargins.crossoverHz!);
        expect(r.proposedMargins.phaseMarginDeg!).toBeGreaterThanOrEqual(PID_TARGETS.minPhaseMarginDeg);
        expect(r.proposed.dMax).toBeGreaterThanOrEqual(r.proposed.d);
        // At most MAX_STEP, plus the integer rounding of the firmware value.
        expect(Math.abs(r.proposed.p - current.p)).toBeLessThanOrEqual(0.3 * current.p + 0.5);
        expect(r.proposedMargins.evidence.level).toBe("VALIDATED");
        expect(r.status).toBe("VALIDATED");
        // Without the qualification the same search proposes the same values, but never as VALIDATED.
        const bare = optimizeAxisPid(
            buildAxisLoop(0, tfFor(cfg, 40), cfg, steadyChain, true, true, null, {
                support: declaredSupport(tfFor(cfg, 40)),
                resolution: declaredConvergence(),
            }),
            current,
        );
        expect(bare.proposed).toEqual(r.proposed);
        expect(bare.proposedMargins.evidence.level).toBe("MODEL_CONDITIONAL");
        expect(bare.status).toBe("BLOCKED");
    });

    it("with too little margin it restores the targets instead of chasing bandwidth", () => {
        const loop = buildAxisLoop(0, tfFor(cfg, 160), cfg, steadyChain, true, true, null, {
            support: declaredSupport(tfFor(cfg, 160)),
            resolution: declaredConvergence(),
        });
        const before = loopMargins(loop);
        expect(before.phaseMarginDeg!).toBeLessThan(PID_TARGETS.minPhaseMarginDeg);
        const r = optimizeAxisPid(loop, current);
        expect(["restores_margins", "targets_not_reachable"]).toContain(r.outcome);
        expect(r.proposedMargins.phaseMarginDeg!).toBeGreaterThan(before.phaseMarginDeg!);
        // Missing a target is shown, never recommended.
        if (r.outcome === "targets_not_reachable") expect(r.status).toBe("BLOCKED");
    });

    it("a change is BLOCKED while its margins are not validated", () => {
        const loop = buildAxisLoop(0, tfFor(cfg, 40), cfg, steadyChain, true, false, null, {
            support: declaredSupport(tfFor(cfg, 40)),
            resolution: declaredConvergence(),
        });
        const r = optimizeAxisPid(loop, current);
        expect(r.changed).toBe(true);
        expect(r.status).toBe("BLOCKED");
        expect(r.reasons).toContain("margins:independent_validation_missing");
    });
});

describe("feedforward", () => {
    const cfg = air65RollConfig();
    const loop = buildAxisLoop(0, tfFor(cfg, 80), cfg, steadyChain, true, true, null, {
        support: declaredSupport(tfFor(cfg, 80)),
        resolution: declaredConvergence(),
    });
    it("is BLOCKED without acro stick data, naming the flight it needs", () => {
        const r = optimizeFeedforward(0, {
            loop,
            currentF: 22,
            acroStickSeconds: 0,
            measuredLatencyMs: null,
            rcFeedforwardCutoffHz: 53,
        });
        expect(r.status).toBe("BLOCKED");
        expect(r.reasons).toContain("required_measurement:acro_stick_flight");
        expect(r.reasons).toContain("angle_mode_and_chirp_carry_no_pid_feedforward");
    });
    it("with stick latency it moves F toward zero lag without a tracking peak", () => {
        const r = optimizeFeedforward(0, {
            loop,
            currentF: 22,
            acroStickSeconds: 12,
            measuredLatencyMs: 18,
            rcFeedforwardCutoffHz: 53,
        });
        expect(r.status).toBe("PARTIAL");
        expect(r.proposed).toBeGreaterThan(22);
        expect(Math.abs(r.predictedLatencyMs.proposed!)).toBeLessThan(Math.abs(r.predictedLatencyMs.current!));
        expect(r.trackingPeakDb!).toBeLessThanOrEqual(1);
    });
});

describe("Safety evidence contract (absolute route)", () => {
    const ok = {
        measurementState: { roll: "usable" },
        coherenceAtCrossover: { roll: 0.95 },
        chainValidated: { roll: true },
        dtermValidated: { roll: true },
        crossLogPlant: { roll: "PASS" },
        motorSaturationFraction: 0.001,
        noiseFloorKnown: true,
    };
    it("is available only when every field is present and passes", () => {
        expect(absoluteSafetyEvidence(ok, ["roll"], true)).toEqual({ analysisEvidence: "available", reasons: [] });
        const cases: [Partial<typeof ok>, string][] = [
            [{ measurementState: { roll: "usable_with_warnings" } }, "chirp_measurement_usable_with_warnings:roll"],
            [{ coherenceAtCrossover: { roll: 0.8 } }, "coherence_at_crossover_low:roll:0.80"],
            [{ chainValidated: { roll: false } }, "gyro_chain_not_validated:roll"],
            [{ dtermValidated: { roll: false } }, "dterm_path_not_validated:roll"],
            [{ crossLogPlant: { roll: "PARTIAL" } }, "cross_log_plant_partial:roll"],
            [{ motorSaturationFraction: null as unknown as number }, "motor_saturation_unknown"],
            [{ motorSaturationFraction: 0.05 }, "motor_saturation_high:5.0%"],
            [{ noiseFloorKnown: false }, "noise_floor_unknown"],
        ];
        for (const [over, reason] of cases) {
            const r = absoluteSafetyEvidence({ ...ok, ...over }, ["roll"], true);
            expect(r.analysisEvidence).toBe("not_available");
            expect(r.reasons).toContain(reason);
        }
        expect(absoluteSafetyEvidence(ok, [], false).reasons).toContain("no_axis_in_scope");
    });
});

describe("chain validation acceptance", () => {
    function sim(out: Float64Array): ChainSimulation {
        return {
            out: [out, out, out],
            postRpm: [out, out, out],
            lpf1Hz: new Float64Array(out.length),
            dynNotchHz: [[], [], []],
            rpmHz: [],
            rpmWeight: [],
            valid: new Uint8Array(out.length).fill(1),
            runs: 1,
            notes: [],
        };
    }
    const n = 40000;
    // Deterministic broadband signal: every validation band has content.
    let seed = 7;
    const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32 - 0.5;
    const x = new Float64Array(n);
    for (let k = 1; k < n; k++) x[k] = 0.9 * x[k - 1] + 10 * rnd();
    const mask = new Uint8Array(n).fill(1);
    it("passes when the prediction is the logged signal and the notches clearly matter", () => {
        const noisy = Float64Array.from(x, (v) => v + 10 * rnd());
        const v = validateChain(0, sim(x), sim(noisy), x, 4000, mask);
        expect(v.controlBand).toBe("PASS");
    });
    it("fails when the prediction lags the logged signal, or when the notches are not shown to matter", () => {
        const lagged = Float64Array.from(x, (_, k) => x[Math.max(0, k - 2)]);
        expect(validateChain(0, sim(lagged), null, x, 4000, mask).controlBand).toBe("FAIL");
        const v = validateChain(0, sim(x), sim(x), x, 4000, mask);
        expect(v.controlBand).toBe("FAIL");
        expect(v.reasons).toContain("chain_notches_not_shown_to_matter");
    });
});
