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
 * T3 frequency-support validation (audit 2026-10-27, P1 confirmed): regression of the frequency-
 * support contract in loopModel (FREQUENCY_SUPPORT, supportIssues) and pidOptimizer (meets).
 *
 * The counterexample: a narrow pole/zero pair (ζ 0.001 / 0.0002) at 39.06 Hz under a K 40 rate plant.
 * The one primary bin at the peak and one or two fine qualification bins at the peak drop out on
 * coherence. Before the contract the qualification PASSed and the engine reported a VALIDATED PM
 * bound of 82° against a true worst phase margin of 4.5–4.7°; the holes were causal (the same peak on
 * or off the grid never reached VALIDATED without them). Now any missing bin inside the decision band
 * is a gap, for both the primary and the qualification, and the margins stay MEASURED.
 *
 * Every plant here is a SIMULATION (an analytic closed loop on the engine's own 1 kHz / 512-sample
 * Welch grid, or the synthetic Blackbox harness): software-contract evidence, never AIR65 or any
 * other flight evidence. The reference for the true margins is the continuous analytic loop.
 */

import { describe, expect, it } from "vitest";
import type { TransferFunction } from "../../src/js/blackbox/spectral_analysis";
import {
    cadd,
    cdiv,
    cmag,
    cmul,
    cphaseDeg,
    evaluateControllerFrf,
    type DigitalControllerConfig,
} from "../../src/js/blackbox/betaflight_digital_controller";
import { controllerConfigFromHeaders, runAutotuneV2 } from "../../src/gyrocore/engine/autotuneV2";
import {
    binSupportVerdict,
    buildAxisLoop,
    candidateLoop,
    decisionBandStartHz,
    FREQUENCY_SUPPORT,
    generatorStop,
    loopMargins,
    supportIssues,
    type FrequencySupport,
    type LoopMargins,
} from "../../src/gyrocore/engine/loopModel";
import type { EffectiveChain } from "../../src/gyrocore/engine/gyroChain";
import { optimizeAxisPid, type ValidatedSegment } from "../../src/gyrocore/engine/pidOptimizer";
import { buildLogInputs, frequencySupportFor } from "../../src/gyrocore/engine/logInput";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { axisKeys } from "../../src/gyrocore/releaseGate/verifiedTune";
import { closedLoopChirpLog, ratePlant, type Plant } from "./harness/closedLoopBbl";
import { BETAFLIGHT_TUNE_HEADERS, SIM_IDENTITY_HEADERS } from "./harness/chirpSim";
import { declaredSupport } from "./harness/frequencySupport";
import { declaredConvergence } from "./harness/resolutionConvergence";

const HEADERS = Object.fromEntries([
    ...[...SIM_IDENTITY_HEADERS, ...BETAFLIGHT_TUNE_HEADERS].map((l) => [
        l.slice(0, l.indexOf(":")),
        l.slice(l.indexOf(":") + 1),
    ]),
    ["looptime", "125"],
    ["pid_process_denom", "8"],
]);
const cfg: DigitalControllerConfig = controllerConfigFromHeaders(HEADERS, 0)!;
const UNITY_CHAIN: EffectiveChain = {
    samples: 1,
    frf: () => ({ re: 1, im: 0 }),
    spread: () => ({ phaseDeg: 0, gainDb: 0 }),
    medianLpf1Hz: 0,
    dynNotchHz: [],
};
const FS = 1000;
const N = 512;
const BIN = FS / N;
const SWEEP = { f0Hz: 1, f1Hz: 400, durationS: 20 };
const PRIMARY = { segmentSamples: N, sampleRateHz: FS, windowSamples: 20000, segments: 77 };
const FINE_N = 4096;
const FINE = { segmentSamples: FINE_N, sampleRateHz: FS, windowSamples: 20000, segments: 8 };
const SOURCE = { sha256: "a".repeat(64), logIndex: 2 };
const PEAK_HZ = 20 * BIN; // 39.0625 Hz: on the primary grid

/** Pole/zero pair at fr: peak gain ζz/ζp, phase back to 0 away from fr (LOOP_RESOLUTION's own class). */
const dipole =
    (G: Plant, fr: number, zz: number, zp: number): Plant =>
    (f) => {
        const x = f / fr;
        return cmul(G(f), cdiv({ re: 1 - x * x, im: 2 * zz * x }, { re: 1 - x * x, im: 2 * zp * x }));
    };
const SMOOTH = ratePlant({ K: 40, motorHz: 40, delayS: 0.002 });
const narrow = (fr: number) => dipole(SMOOTH, fr, 0.001, 0.0002);

/** Analytic T on the Welch grid of `n` samples with a chosen coherence per bin. */
function anaTF(G: Plant, c: DigitalControllerConfig, coh: (f: number) => number, n = N, K = 77): TransferFunction {
    const bins = n / 2 + 1;
    const fr = new Float64Array(bins);
    const mag = new Float64Array(bins);
    const ph = new Float64Array(bins);
    const co = new Float64Array(bins);
    const re = new Float64Array(bins);
    const im = new Float64Array(bins);
    for (let k = 0; k < bins; k++) {
        const f = (k * FS) / n;
        fr[k] = f;
        const ff = Math.max(f, 1e-3);
        const ctl = evaluateControllerFrf(c, ff);
        const g = G(ff);
        const T = cdiv(cmul(g, ctl.cReference), cadd({ re: 1, im: 0 }, cmul(g, ctl.cFeedback)));
        re[k] = T.re;
        im[k] = T.im;
        mag[k] = 20 * Math.log10(cmag(T));
        ph[k] = cphaseDeg(T);
        co[k] = k === 0 ? 0 : coh(f);
    }
    return { frequencies: fr, magnitude: mag, phase: ph, coherence: co, hReal: re, hImag: im, numSegments: K };
}

/** Coherence 0.999 over [2, top] Hz, 0.5 at the listed bin frequencies (the holes), 0 elsewhere. */
const cohWith =
    (top: number, holesHz: number[] = []) =>
    (f: number) =>
        f >= 2 && f <= top ? (holesHz.some((h) => Math.abs(h - f) < 1e-6) ? 0.5 : 0.999) : 0;

/** The continuous truth of L = G·C_fb: first downward crossing and the worst PM over every crossing. */
function truth(G: Plant, c: DigitalControllerConfig) {
    const L = (f: number) => cmul(G(f), evaluateControllerFrf(c, f).cFeedback);
    const step = 0.0005;
    let prev = L(0.5);
    let un = Math.atan2(prev.im, prev.re);
    const cross: { f: number; down: boolean; pm: number }[] = [];
    for (let f = 0.5 + step; f < 450; f += step) {
        const l = L(f);
        let d = Math.atan2(l.im, l.re) - Math.atan2(prev.im, prev.re);
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        un += d;
        const m0 = cmag(prev);
        const m1 = cmag(l);
        if ((m0 >= 1 && m1 < 1) || (m0 < 1 && m1 >= 1)) {
            let lo = f - step;
            let hi = f;
            for (let j = 0; j < 40; j++) {
                const mid = (lo + hi) / 2;
                if (cmag(L(mid)) >= 1 === m0 >= 1) lo = mid;
                else hi = mid;
            }
            const at = (lo + hi) / 2;
            const raw = cphaseDeg(L(at));
            cross.push({ f: at, down: m0 >= 1, pm: 180 + raw + 360 * Math.round(((un * 180) / Math.PI - raw) / 360) });
        }
        prev = l;
    }
    const first = cross.find((x) => x.down);
    return {
        fc: first?.f ?? null,
        pmWorst: cross.length ? Math.min(...cross.map((x) => x.pm)) : null,
        crossings: cross.length,
    };
}

function build(
    tf: TransferFunction,
    o: {
        fine?: TransferFunction | null;
        support?: FrequencySupport | null;
        fineSupport?: FrequencySupport | null;
        attested?: boolean;
        observedHz?: [number, number] | null;
    } = {},
) {
    const support = o.support === undefined ? declaredSupport(tf, { observedHz: o.observedHz ?? [2, 400] }) : o.support;
    return buildAxisLoop(
        0,
        tf,
        cfg,
        UNITY_CHAIN,
        true,
        o.attested ?? true,
        o.fine
            ? {
                  tf: o.fine,
                  source: SOURCE,
                  sweep: SWEEP,
                  analysis: FINE,
                  support:
                      o.fineSupport === undefined ? declaredSupport(o.fine, { observedHz: [2, 400] }) : o.fineSupport,
              }
            : null,
        { sweep: SWEEP, analysis: PRIMARY, support, resolution: declaredConvergence(BIN, FS) },
    );
}

const current = { p: cfg.axis.p, i: cfg.axis.i, d: cfg.axis.d, dMax: 40 };
/** A Verified Tune segment from the current values to 1.3× (D 1.3×) with F unchanged: the stubbed attestation of the audit. */
function segment(): ValidatedSegment {
    const keys = axisKeys("roll");
    const base = {
        p_roll: current.p,
        i_roll: current.i,
        d_roll: current.d,
        f_roll: cfg.axis.f,
        d_max_roll: current.dMax,
    };
    const cand = {
        p_roll: Math.round(current.p * 1.3),
        i_roll: Math.round(current.i * 1.3),
        d_roll: Math.round(current.d * 1.3),
        f_roll: cfg.axis.f,
        d_max_roll: Math.round(current.dMax * 1.3),
    };
    return { keys, base, cand };
}

const noBounds = (m: LoopMargins) => {
    expect(m.evidence.level).not.toBe("VALIDATED");
    expect(m.evidence.level).not.toBe("MODEL_CONDITIONAL");
    expect(m.gainMarginDb).toBeNull();
    expect(m.sensitivityPeakDb).toBeNull();
    expect(m.status).toBe("NOT_VALIDATED");
};

describe("positive control: a smooth plant, full support, a finer qualification", () => {
    const tf = anaTF(SMOOTH, cfg, cohWith(138));
    const fine = anaTF(SMOOTH, cfg, cohWith(225), FINE_N, 8);
    const m = loopMargins(build(tf, { fine }));
    const t = truth(SMOOTH, cfg);

    it("reaches VALIDATED evidence with bounds that hold against the continuous loop", () => {
        expect(m.evidence.level).toBe("VALIDATED");
        expect(m.status).toBe("VALIDATED");
        expect(m.reasons).toEqual([]);
        expect(m.phaseMarginDeg!).toBeLessThanOrEqual(t.pmWorst! + 1e-6);
        expect(m.phaseMarginDeg!).toBeGreaterThan(t.pmWorst! - 15);
        expect(Math.abs(m.crossoverHz! - t.fc!) / t.fc!).toBeLessThan(0.03);
        expect(m.gainMarginDb).not.toBeNull();
        expect(m.sensitivityPeakDb).not.toBeNull();
    });

    it("the decision band starts at max(fc / 4, 2 Hz) and every grid bin in it is kept", () => {
        expect(decisionBandStartHz(m.crossoverHz!)).toBeCloseTo(Math.max(m.crossoverHz! / 4, 2), 9);
        expect(FREQUENCY_SUPPORT).toEqual({
            minExcitationCoherence: 0.95,
            minInputRelativePowerDb: -15,
            bandDivisor: 4,
            bandFloorHz: 2,
            generatorStopTolerance: 0.98,
        });
        const loop = build(tf, { fine });
        expect(supportIssues(loop, candidateLoop(loop, { cfg }), m.crossoverHz!)).toEqual([]);
    });

    it("the PID search proposes an increase on it as VALIDATED only on a Verified Tune segment", () => {
        const r = optimizeAxisPid(build(tf, { fine }), current, segment());
        expect(["improved", "no_change_needed"]).toContain(r.outcome);
        if (r.changed) expect(r.status).toBe("VALIDATED");
        const bare = optimizeAxisPid(build(tf, { fine }), current, null);
        expect(bare.outcome).toBe("improved");
        expect(bare.status).toBe("VALIDATED");
    });
});

describe("the T3 counterexample: a narrow resonance on one incoherent bin", () => {
    for (const offsetBins of [0, 0.25, 0.5]) {
        const fr = PEAK_HZ + offsetBins * BIN;
        const G = narrow(fr);
        const t = truth(G, cfg);
        // The primary bin nearest the peak and 1 or 2 fine bins at the peak drop out on coherence.
        const primaryHole = Math.round(fr / BIN) * BIN;
        const fineBin = FS / FINE_N;
        const fineHoles = (count: number) =>
            Array.from({ length: count }, (_, j) => (Math.floor(fr / fineBin) + j) * fineBin);

        describe(`peak at ${fr.toFixed(4)} Hz (${offsetBins} bin off the grid)`, () => {
            it("the continuous loop really has a crossing with almost no phase margin", () => {
                expect(t.crossings).toBeGreaterThanOrEqual(3);
                expect(t.pmWorst!).toBeLessThan(10);
            });

            it("control: without the holes the same peak never gets a VALIDATED bound above its true margin", () => {
                const tf = anaTF(G, cfg, cohWith(138));
                const fine = anaTF(G, cfg, cohWith(225), FINE_N, 8);
                const m = loopMargins(build(tf, { fine }));
                if (m.evidence.level === "VALIDATED") {
                    expect(m.phaseMarginDeg!).toBeLessThanOrEqual(t.pmWorst! + 5);
                }
            });

            for (const fineCount of [1, 2]) {
                it(`with the holes (${fineCount} fine bin${fineCount > 1 ? "s" : ""}): the gap is named and no bound is given`, () => {
                    const tf = anaTF(G, cfg, cohWith(138, [primaryHole]));
                    const fine = anaTF(G, cfg, cohWith(225, fineHoles(fineCount)), FINE_N, 8);
                    const m = loopMargins(build(tf, { fine }));
                    noBounds(m);
                    expect(m.evidence.level).toBe("MEASURED");
                    expect(m.reasons).toContain("unidentified_bins_inside_band:1");
                    // The reading on the bins is still shown, as a measurement, and it is wrong: that
                    // is exactly why it is not a bound.
                    expect(m.measured.phaseMarginDeg!).toBeGreaterThan(t.pmWorst! + 30);
                    // The qualification over the same gap is no PASS.
                    const q = m.evidence.qualification;
                    if (q) {
                        expect(q.verdict).not.toBe("PASS");
                        expect(
                            q.reasons.some((r) => r.startsWith("qualification:unidentified_bins_inside_band:")),
                        ).toBe(true);
                    }
                });

                it(`with the holes (${fineCount} fine bin${fineCount > 1 ? "s" : ""}): no PID proposal is VALIDATED, with or without a Verified Tune segment`, () => {
                    const tf = anaTF(G, cfg, cohWith(138, [primaryHole]));
                    const fine = anaTF(G, cfg, cohWith(225, fineHoles(fineCount)), FINE_N, 8);
                    for (const seg of [null, segment()]) {
                        const r = optimizeAxisPid(build(tf, { fine }), current, seg);
                        expect(r.status).toBe("BLOCKED");
                        expect(r.proposedMargins.evidence.level).not.toBe("VALIDATED");
                        // No bandwidth increase is suggested on margins read on bins only.
                        expect(r.outcome).toBe("targets_not_reachable");
                        expect(r.changed).toBe(false);
                        expect(r.reasons).toContain("required_measurement:chirp_with_full_band_support");
                    }
                });
            }
        });
    }
});

describe("gaps of one or two bins in a smooth loop are gaps", () => {
    const t = truth(SMOOTH, cfg);
    for (const width of [1, 2, 3, 4]) {
        it(`${width} missing bin${width > 1 ? "s" : ""} just above the crossover: MEASURED with the gap named`, () => {
            const start = Math.ceil((t.fc! * 1.2) / BIN) * BIN;
            const holes = Array.from({ length: width }, (_, j) => start + j * BIN);
            const tf = anaTF(SMOOTH, cfg, cohWith(138, holes));
            const fine = anaTF(SMOOTH, cfg, cohWith(225), FINE_N, 8);
            const m = loopMargins(build(tf, { fine }));
            noBounds(m);
            expect(m.reasons).toContain(`unidentified_bins_inside_band:${width}`);
        });
    }

    it("a missing bin below fc / 4 is outside the decision band and no gap", () => {
        // A plant with a higher crossover, so that a grid bin lies between 2 Hz and fc / 4.
        const G = ratePlant({ K: 90, motorHz: 40, delayS: 0.002 });
        const fc = truth(G, cfg).fc!;
        const low = Math.floor(fc / 4 / BIN) * BIN;
        expect(low).toBeGreaterThanOrEqual(2);
        expect(low).toBeLessThan(fc / 4);
        const fine = anaTF(G, cfg, cohWith(225), FINE_N, 8);
        const whole = loopMargins(build(anaTF(G, cfg, cohWith(138)), { fine }));
        const m = loopMargins(build(anaTF(G, cfg, cohWith(138, [low])), { fine }));
        expect(m.reasons.some((r) => r.startsWith("unidentified_bins_inside_band"))).toBe(false);
        expect(m.evidence.level).toBe(whole.evidence.level);
        expect(m.phaseMarginDeg).toBe(whole.phaseMarginDeg);
    });

    it("the crossing itself read over a gap is named", () => {
        const at = Math.round(t.fc! / BIN) * BIN;
        const tf = anaTF(SMOOTH, cfg, cohWith(138, [at]));
        const m = loopMargins(build(tf));
        expect(m.reasons).toContain("crossover_neighbour_bins_missing:1");
        noBounds(m);
    });
});

describe("coherence alone is not support", () => {
    const t = truth(SMOOTH, cfg);
    const tf = anaTF(SMOOTH, cfg, cohWith(138));
    const fine = anaTF(SMOOTH, cfg, cohWith(225), FINE_N, 8);
    const octave = Array.from(tf.frequencies).filter((f) => f >= t.fc! / Math.SQRT2 && f <= t.fc! * Math.SQRT2);

    it("bins the generator never excited are dropped and the band named unsupported, however coherent", () => {
        const support = declaredSupport(tf, {
            observedHz: [2, 400],
            except: octave.map((hz) => ({
                hz,
                verdict: "UNSUPPORTED" as const,
                class: "INSUFFICIENT_SPECTRAL_SUPPORT" as const,
            })),
        });
        const loop = build(tf, { fine, support });
        expect(candidateLoop(loop, { cfg }).some((p) => octave.includes(p.f))).toBe(false);
        const m = loopMargins(loop);
        noBounds(m);
        expect(m.reasons.some((r) => r.startsWith("crossover_band_unsupported:"))).toBe(true);
        expect(m.reasons).toContain(`unidentified_bins_inside_band:${octave.length}`);
        const r = optimizeAxisPid(loop, current, segment());
        expect(r.status).toBe("BLOCKED");
    });

    it("a setpoint that is not the generator's (γ² excitation→setpoint below 0.95) is no support", () => {
        expect(binSupportVerdict("COHERENT", 0.94)).toBe("UNSUPPORTED");
        expect(binSupportVerdict("COHERENT", 0.95)).toBe("SUPPORTED");
        expect(binSupportVerdict("COHERENT", null)).toBe("UNKNOWN");
        expect(binSupportVerdict("WEAK_COHERENCE", 0.999)).toBe("UNSUPPORTED");
        expect(binSupportVerdict("OUTSIDE_OBSERVED_SWEEP", 0.999)).toBe("UNSUPPORTED");
        expect(binSupportVerdict("INSUFFICIENT_SPECTRAL_SUPPORT", 0.999)).toBe("UNSUPPORTED");
        expect(binSupportVerdict("UNKNOWN", 0.999)).toBe("UNKNOWN");
    });

    it("no support evidence at all (no DEBUG_CHIRP): the margins stay MEASURED, the reason says why", () => {
        const m = loopMargins(build(tf, { fine, support: null }));
        noBounds(m);
        expect(m.reasons).toContain("frequency_support_unknown:no_support_evidence");
        expect(m.measured.phaseMarginDeg).not.toBeNull();
    });

    it("kept bins whose support could not be decided bound nothing either", () => {
        const support = declaredSupport(tf, {
            observedHz: [2, 400],
            except: octave.slice(0, 2).map((hz) => ({ hz, verdict: "UNKNOWN" as const })),
        });
        const m = loopMargins(build(tf, { fine, support }));
        noBounds(m);
        expect(m.reasons).toContain("frequency_support_unknown:2_bins");
    });

    it("a qualification without support evidence is INSUFFICIENT, never a PASS", () => {
        const m = loopMargins(build(tf, { fine, fineSupport: null }));
        expect(m.evidence.level).toBe("MODEL_CONDITIONAL");
        expect(m.evidence.qualification!.verdict).toBe("INSUFFICIENT");
        expect(m.evidence.qualification!.reasons).toContain(
            "qualification:frequency_support_unknown:no_support_evidence",
        );
    });
});

describe("the observed generator range, not the header's", () => {
    const t = truth(SMOOTH, cfg);
    const tf = anaTF(SMOOTH, cfg, cohWith(138));
    const fine = anaTF(SMOOTH, cfg, cohWith(225), FINE_N, 8);

    it("a sweep that stopped below the crossover: bins above the stop are no support, no margin, the stop named", () => {
        const stopHz = 0.6 * t.fc!;
        const loop = build(tf, { fine, observedHz: [2, stopHz] });
        expect(generatorStop(loop)).toEqual([stopHz, SWEEP.f1Hz]);
        expect(candidateLoop(loop, { cfg }).every((p) => p.f <= stopHz)).toBe(true);
        const m = loopMargins(loop);
        expect(m.phaseMarginDeg).toBeNull();
        expect(m.reasons).toContain(`sweep_generator_stopped_early:${stopHz.toFixed(1)}<400.0Hz`);
        expect(optimizeAxisPid(loop, current, segment()).status).toBe("BLOCKED");
    });

    it("a stop inside the tail the bounds lean on (below 1.5 × the band end) blocks the bounds", () => {
        const loop = build(tf, { fine, observedHz: [2, 120] });
        const m = loopMargins(loop);
        expect(m.reasons.some((r) => r.startsWith("sweep_generator_stopped_early:120.0<400.0Hz"))).toBe(true);
        expect(m.status).toBe("NOT_VALIDATED");
    });

    it("a stop well above the band is reported with the evidence and does not block", () => {
        const m = loopMargins(build(tf, { fine, observedHz: [2, 300] }));
        expect(m.reasons.some((r) => r.startsWith("sweep_generator_stopped"))).toBe(false);
        expect(m.evidence.assumptions).toContain("sweep_generator_stopped_at:300.0Hz_of_400.0Hz");
        expect(m.evidence.level).toBe("VALIDATED");
    });

    it("a generator that reached the header's end is no stop", () => {
        expect(generatorStop(build(tf, { observedHz: [2, 396] }))).toBeNull();
        expect(generatorStop(build(tf, { support: null }))).toBeNull();
    });
});

describe("end to end: support from a synthetic DEBUG_CHIRP log (SIMULATION)", () => {
    const plant = ratePlant({ K: 60, motorHz: 40, delayS: 0.002 });
    const sha = "e".repeat(64);
    const decode = (bytes: Uint8Array) => {
        const report = qualifyChirpFile(bytes, sha.slice(0, 12), 45, AUTOTUNE_MATH);
        return buildLogInputs(bytes, sha, report, null);
    };

    it("a full sweep: every bin of the identified band is supported, the generator range is the observed one", () => {
        const logs = decode(closedLoopChirpLog({ plants: [plant, null, null], noise: 0.3, seed: 11 }));
        const c = logs[0]?.chirp.roll;
        expect(c?.support).toBeDefined();
        const s = c!.support!;
        expect(s.observedHz![0]).toBeLessThanOrEqual(2.1);
        expect(s.observedHz![1]).toBeGreaterThan(190);
        const inBand = Array.from(c!.tf.frequencies).filter((f) => f >= 5 && f <= 100);
        const supported = inBand.filter((f) => s.bins.get(f)?.verdict === "SUPPORTED");
        expect(supported.length).toBeGreaterThan(0.9 * inBand.length);
        for (const f of inBand) {
            const b = s.bins.get(f)!;
            if (b.verdict === "SUPPORTED")
                expect(b.excitationCoherence!).toBeGreaterThanOrEqual(FREQUENCY_SUPPORT.minExcitationCoherence);
        }
        // The finer identification carries its own support on its own grid.
        expect(c!.fine?.support).toBeDefined();
        expect(c!.fine!.support!.bins.size).toBe(c!.fine!.tf.frequencies.length - 1);
        const r = runAutotuneV2({
            primary: logs[0],
            others: [],
            verifiedTune: null,
            createdAt: "2026-10-27T00:00:00Z",
        });
        const m = r.margins.roll!.current;
        expect(m.reasons.some((x) => x.startsWith("frequency_support_unknown"))).toBe(false);
        expect(m.reasons.some((x) => x.startsWith("sweep_generator_stopped"))).toBe(false);
    });

    it("the generator stopped at 60 % of the crossover while the header claims 200 Hz: named, no margin, BLOCKED", () => {
        const fcHz = truth(plant, cfg).fc!;
        const abortAtHz = 0.6 * fcHz;
        const logs = decode(closedLoopChirpLog({ plants: [plant, null, null], noise: 0.3, seed: 12, abortAtHz }));
        const c = logs[0]?.chirp.roll;
        expect(c?.support?.observedHz).toBeTruthy();
        expect(c!.support!.observedHz![1]).toBeLessThan(abortAtHz + 0.2);
        const above = Array.from(c!.tf.frequencies).filter((f) => f > abortAtHz + 1 && f <= 100);
        expect(above.every((f) => c!.support!.bins.get(f)?.verdict === "UNSUPPORTED")).toBe(true);
        const r = runAutotuneV2({
            primary: logs[0],
            others: [],
            verifiedTune: null,
            createdAt: "2026-10-27T00:00:00Z",
        });
        const m = r.margins.roll?.current;
        if (m) {
            expect(m.phaseMarginDeg).toBeNull();
            expect(m.reasons.some((x) => x.startsWith("sweep_generator_stopped_early:"))).toBe(true);
        }
        expect(r.pid.find((p) => p.axis === "roll")!.status).toBe("BLOCKED");
        expect(r.releasableProposal?.items.length ?? 0).toBe(0);
    });

    it("an excitation hole around the crossover: the hole's bins are unsupported, the band named, BLOCKED", () => {
        const fcHz = truth(plant, cfg).fc!;
        const envelope = (f: number) => (f >= fcHz / 1.5 && f <= fcHz * 1.5 ? 0 : 1);
        const logs = decode(closedLoopChirpLog({ plants: [plant, null, null], noise: 0.3, seed: 13, envelope }));
        const c = logs[0]?.chirp.roll;
        expect(c?.support).toBeDefined();
        // Inside the hole (its edge bins aside: Hann leakage from the excited neighbours) no bin is
        // supported: the setpoint there is leakage, not excitation, however coherent the loop is.
        const hole = Array.from(c!.tf.frequencies).filter((f) => f >= fcHz / 1.4 && f <= fcHz * 1.4);
        expect(hole.length).toBeGreaterThan(3);
        const unsupported = hole.filter((f) => c!.support!.bins.get(f)?.verdict === "UNSUPPORTED");
        expect(unsupported.length).toBeGreaterThanOrEqual(hole.length - 2);
        expect(unsupported.every((f) => c!.support!.bins.get(f)!.class === "INSUFFICIENT_SPECTRAL_SUPPORT")).toBe(true);
        // The coherence setpoint → gyro there is what made the old engine accept them.
        const coherentInHole = hole.filter((f) => c!.tf.coherence[Array.from(c!.tf.frequencies).indexOf(f)] >= 0.8);
        expect(coherentInHole.length).toBeGreaterThan(0);
        const r = runAutotuneV2({
            primary: logs[0],
            others: [],
            verifiedTune: null,
            createdAt: "2026-10-27T00:00:00Z",
        });
        const m = r.margins.roll?.current;
        if (m && m.crossoverHz !== null) {
            expect(m.evidence.level).not.toBe("VALIDATED");
            expect(m.evidence.level).not.toBe("MODEL_CONDITIONAL");
            expect(
                m.reasons.some(
                    (x) =>
                        x.startsWith("crossover_band_unsupported:") || x.startsWith("unidentified_bins_inside_band:"),
                ),
            ).toBe(true);
        }
        expect(r.pid.find((p) => p.axis === "roll")!.status).toBe("BLOCKED");
    });

    it("frequencySupportFor reuses the qualityV2 classes: outside the observed range is never support", () => {
        const tf = anaTF(SMOOTH, cfg, cohWith(138));
        const sp = new Float64Array(20000).map((_, i) => Math.sin(i / 7));
        const s = frequencySupportFor(tf, {
            sampleRateHz: FS,
            setpoint: sp,
            excitation: sp,
            observed: { availability: "MEASURED", startHz: 2, endHz: 50, minHz: 2, maxHz: 50, runs: 1, reasons: [] },
        });
        expect(s.observedHz).toEqual([2, 50]);
        for (const [f, b] of s.bins) {
            if (f > 50) expect(b.class).toBe("OUTSIDE_OBSERVED_SWEEP");
            if (f > 50) expect(b.verdict).toBe("UNSUPPORTED");
        }
        const unknown = frequencySupportFor(tf, {
            sampleRateHz: FS,
            setpoint: sp,
            excitation: null,
            observed: {
                availability: "UNAVAILABLE",
                startHz: null,
                endHz: null,
                minHz: null,
                maxHz: null,
                runs: null,
                reasons: [],
            },
        });
        expect(unknown.observedHz).toBeNull();
        expect([...unknown.bins.values()].every((b) => b.verdict === "UNKNOWN")).toBe(true);
    });
});
