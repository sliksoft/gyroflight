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
 * Release re-gate 2026-10-27: the two P2 findings of the independent release audit.
 *
 * P2-1  A generator that stopped inside the tail the bounds lean on (below 1.5 × the band end)
 *       appended `sweep_generator_stopped_early` but left the evidence level alone: with header
 *       f1 400 Hz and an observed stop at 100 / 120 / 200 Hz the margins came out VALIDATED with
 *       GM / |S| bounds, and the PID search called a candidate "improved" on them. The stop now
 *       blocks the bounds (loopModel loopMargins: stopBlocks).
 * P2-2  PID and filter candidates reused the H1 convergence verdict of the controller in force,
 *       whatever their own crossover. The verdict that applies to a candidate is now read on the
 *       same rungs with that candidate (AxisLoop.resolutionFor, autotuneV2), a copied verdict is
 *       UNKNOWN, and the bin spacing is checked against every crossover the margins are read at
 *       (loopModel resolutionVerdictFor, RESOLUTION_TARGET: Δf ≤ 0.1 × fc).
 *
 * Every plant is a SIMULATION (analytic loops on 1 kHz Welch grids, the synthetic Blackbox harness):
 * software-contract evidence only, never flight evidence.
 */

import { createHash } from "node:crypto";
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
import { closedLoopFromPlant, syntheticTransferFunction } from "../../src/js/blackbox/betaflight_open_loop";
import {
    controllerConfigFromHeaders,
    runAutotuneV2,
    type AutotuneLogInput,
} from "../../src/gyrocore/engine/autotuneV2";
import {
    buildAxisLoop,
    loopMargins,
    marginEvidenceIssues,
    RESOLUTION_TARGET,
    resolutionVerdictFor,
    type AxisLoop,
    type LoopCandidate,
    type LoopMargins,
} from "../../src/gyrocore/engine/loopModel";
import {
    chooseAnalysis,
    resolutionConvergence,
    type AnalysisOption,
} from "../../src/gyrocore/engine/adaptiveResolution";
import type { EffectiveChain } from "../../src/gyrocore/engine/gyroChain";
import { optimizeAxisPid } from "../../src/gyrocore/engine/pidOptimizer";
import { buildLogInputs } from "../../src/gyrocore/engine/logInput";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { closedLoopChirpLog, ratePlant, type Plant } from "./harness/closedLoopBbl";
import { BETAFLIGHT_TUNE_HEADERS, SIM_IDENTITY_HEADERS } from "./harness/chirpSim";
import { declaredSupport } from "./harness/frequencySupport";
import { declaredConvergence, declaredResolution } from "./harness/resolutionConvergence";

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
const SWEEP = { f0Hz: 1, f1Hz: 400, durationS: 40 };
const WINDOW = 40000;
/** The 20 s window of the T3 positive control (512-sample primary, 4096-sample qualification). */
const SWEEP20 = { f0Hz: 1, f1Hz: 400, durationS: 20 };
const WINDOW20 = 20000;
const SOURCE = { sha256: "a".repeat(64), logIndex: 2 };
const current = { p: cfg.axis.p, i: cfg.axis.i, d: cfg.axis.d, dMax: 40 };
/** The same controller with P scaled, or with P, I and D scaled (the step the PID search takes). */
const scaledP = (k: number): DigitalControllerConfig => ({ ...cfg, axis: { ...cfg.axis, p: cfg.axis.p * k } });
const scaledPid = (k: number): DigitalControllerConfig => ({
    ...cfg,
    axis: { ...cfg.axis, p: cfg.axis.p * k, i: cfg.axis.i * k, d: cfg.axis.d * k },
});

/** Analytic T of `G` on the Welch grid of `n` samples with coherence `coh(f)`. */
function anaTF(G: Plant, coh: (f: number) => number, n: number, K: number): TransferFunction {
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
        const ctl = evaluateControllerFrf(cfg, ff);
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
const cohTo = (top: number) => (f: number) => (f >= 2 && f <= top ? 0.999 : 0);

/** Crossover and phase margin of the true loop G · C_fb (controller `c`) on a 0.001 Hz grid. */
function truth(G: Plant, c: DigitalControllerConfig = cfg) {
    const L = (f: number) => cmul(G(f), evaluateControllerFrf(c, f).cFeedback);
    let prev = Math.atan2(L(0.5).im, L(0.5).re);
    let un = prev;
    for (let f = 0.501; f < 400; f += 0.001) {
        const l = L(f);
        const p = Math.atan2(l.im, l.re);
        let d = p - prev;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        un += d;
        prev = p;
        if (Math.hypot(l.re, l.im) <= 1) return { fc: f, pm: 180 + (un * 180) / Math.PI };
    }
    throw new Error("no crossover");
}

const noBounds = (m: LoopMargins) => {
    expect(m.evidence.level).toBe("MEASURED");
    expect(m.gainMarginDb).toBeNull();
    expect(m.sensitivityPeakDb).toBeNull();
    expect(m.phaseMarginDeg).toBe(m.measured.phaseMarginDeg);
    expect(m.status).toBe("NOT_VALIDATED");
    expect(marginEvidenceIssues(m.evidence)).not.toEqual([]);
};

describe("P2-1: a generator stop inside the tail blocks the bounds, not only the status", () => {
    // K 60: crossover ≈ 26 Hz, read on 512-sample bins (1.95 Hz: inside the resolution target), with
    // a 4096-sample qualification: the T3 positive control, which is VALIDATED with the full sweep.
    const G = ratePlant({ K: 60, motorHz: 40, delayS: 0.002 });
    const N = 512;
    const PRIMARY = { segmentSamples: N, sampleRateHz: FS, windowSamples: WINDOW20, segments: 77 };
    const FINE = { segmentSamples: 4096, sampleRateHz: FS, windowSamples: WINDOW20, segments: 8 };
    const fine = anaTF(G, cohTo(225), 4096, 8);
    const build = (bandTopHz: number, observedStopHz: number) => {
        const tf = anaTF(G, cohTo(bandTopHz), N, 77);
        return buildAxisLoop(
            0,
            tf,
            cfg,
            UNITY_CHAIN,
            true,
            true,
            {
                tf: fine,
                source: SOURCE,
                sweep: SWEEP20,
                analysis: FINE,
                support: declaredSupport(fine, { observedHz: [2, 400] }),
            },
            {
                sweep: SWEEP20,
                analysis: PRIMARY,
                support: declaredSupport(tf, { observedHz: [2, observedStopHz] }),
                ...declaredResolution(FS / N, FS),
            },
        );
    };

    it("control: the same loop with the generator reaching the header's end is VALIDATED", () => {
        const m = loopMargins(build(138, 400));
        expect(m.evidence.level).toBe("VALIDATED");
        expect(m.status).toBe("VALIDATED");
        expect(m.gainMarginDb).not.toBeNull();
        expect(m.sensitivityPeakDb).not.toBeNull();
        expect(marginEvidenceIssues(m.evidence)).toEqual([]);
    });

    // The audit's reproduction: header f1 400 Hz, observed stops at 100, 120 and 200 Hz, each below
    // 1.5 × the band end the stop itself produces (bins above the stop are unsupported).
    for (const [bandTopHz, stopHz] of [
        [97, 100],
        [138, 120],
        [138, 200],
    ] as const) {
        it(`observed stop at ${stopHz} Hz of 400 Hz (band to ≈ ${bandTopHz} Hz): MEASURED, no GM / |S|, nothing proposed`, () => {
            const loop = build(bandTopHz, stopHz);
            const m = loopMargins(loop);
            expect(m.reasons).toContain(`sweep_generator_stopped_early:${stopHz.toFixed(1)}<400.0Hz`);
            expect(m.evidence.bandHz![1]).toBeLessThanOrEqual(stopHz);
            expect(stopHz).toBeLessThan(1.5 * m.evidence.bandHz![1]);
            noBounds(m);
            expect(m.evidence.qualification).toBeNull();
            // The PID search cannot call anything improved on margins read on bins only.
            for (const seg of [null]) {
                const r = optimizeAxisPid(loop, current, seg);
                expect(r.status).toBe("BLOCKED");
                expect(r.outcome).toBe("targets_not_reachable");
                expect(r.changed).toBe(false);
                expect(r.proposedMargins.evidence.level).toBe("MEASURED");
                expect(r.proposedMargins.gainMarginDb).toBeNull();
                expect(r.reasons).toContain("required_measurement:chirp_with_full_band_support");
            }
        });
    }

    it("a stop above 1.5 × the band end does not block: noted with the evidence, VALIDATED stays", () => {
        const m = loopMargins(build(138, 300));
        expect(m.reasons.some((r) => r.startsWith("sweep_generator_stopped"))).toBe(false);
        expect(m.evidence.assumptions).toContain("sweep_generator_stopped_at:300.0Hz_of_400.0Hz");
        expect(m.evidence.level).toBe("VALIDATED");
        expect(m.status).toBe("VALIDATED");
    });

    it("end to end (SIMULATION): a sweep aborted at 1.3 × the crossover with a full-range header releases nothing", () => {
        const plant = ratePlant({ K: 60, motorHz: 40, delayS: 0.002 });
        const abortAtHz = 1.3 * truth(plant).fc;
        const bytes = closedLoopChirpLog({ plants: [plant, null, null], noise: 0.3, seed: 41, abortAtHz });
        const sha = createHash("sha256").update(bytes).digest("hex");
        const [log] = buildLogInputs(bytes, sha, qualifyChirpFile(bytes, "abort13", 45, AUTOTUNE_MATH), null);
        expect(log).toBeDefined();
        const r = runAutotuneV2({ primary: log, others: [], verifiedTune: null, createdAt: "2026-10-27T00:00:00Z" });
        const m = r.margins.roll?.current;
        if (m && m.crossoverHz !== null) {
            expect(m.reasons.some((x) => x.startsWith("sweep_generator_stopped_early:"))).toBe(true);
            expect(m.evidence.level).toBe("MEASURED");
            expect(m.gainMarginDb).toBeNull();
        }
        const pid = r.pid.find((p) => p.axis === "roll")!;
        expect(pid.status).toBe("BLOCKED");
        expect(pid.proposedMargins.evidence.level).not.toBe("VALIDATED");
        expect(r.releasableProposal).toBeNull();
    }, 120_000);
});

describe("P2-2: a candidate's resolution verdict is its own, never the current tune's", () => {
    /** An analytic rung: the closed loop of `G` on the Welch grid of `segment` samples. */
    function rung(G: Plant, segment: number): AnalysisOption {
        const freqs = Array.from({ length: segment / 2 }, (_, k) => ((k + 1) * FS) / segment);
        const tf = syntheticTransferFunction(freqs, (f) => {
            const c = evaluateControllerFrf(cfg, f);
            return closedLoopFromPlant(G(f), c.cReference, c.cFeedback);
        });
        const segments = Math.floor((WINDOW - segment) / (segment / 2)) + 1;
        tf.numSegments = segments;
        return {
            tf,
            analysis: { segmentSamples: segment, sampleRateHz: FS, windowSamples: WINDOW, segments },
            support: declaredSupport(tf),
        };
    }
    /** The engine's wiring (autotuneV2): the rung the current crossover needs, its verdict, and the per-candidate verdict. */
    function engineLoop(G: Plant, ladder: AnalysisOption[], forceIndex: number | null = null) {
        const loops = new Map<AnalysisOption, AxisLoop>();
        const rungLoop = (r: AnalysisOption) => {
            let l = loops.get(r);
            if (!l) {
                l = buildAxisLoop(0, r.tf, cfg, UNITY_CHAIN, true, true, null, {
                    sweep: SWEEP,
                    analysis: r.analysis,
                    support: r.support,
                });
                loops.set(r, l);
            }
            return l;
        };
        const probeWith = (cand: LoopCandidate | null) => (r: AnalysisOption) => {
            const loop = rungLoop(r);
            return { loop, margins: cand ? loopMargins(loop, cand) : loopMargins(loop) };
        };
        const pick =
            forceIndex === null
                ? chooseAnalysis(ladder, probeWith(null)(ladder[0]).margins.crossoverHz)
                : { index: forceIndex, reasons: [] };
        const r = ladder[pick.index];
        return buildAxisLoop(0, r.tf, cfg, UNITY_CHAIN, true, true, null, {
            sweep: SWEEP,
            analysis: r.analysis,
            support: r.support,
            resolution: resolutionConvergence(ladder, pick.index, probeWith(null), pick.reasons),
            resolutionFor: (cand) => resolutionConvergence(ladder, pick.index, probeWith(cand), pick.reasons),
        });
    }
    const K40 = ratePlant({ K: 40, motorHz: 40, delayS: 0.002 }); // crosses near 12 Hz
    const K60 = ratePlant({ K: 60, motorHz: 40, delayS: 0.002 }); // crosses near 26 Hz
    const binOf = (m: LoopMargins) => m.evidence.convergence!.usedBinSpacingHz;

    it("a copied CONVERGED verdict is not enough: without resolutionFor a candidate's verdict is UNKNOWN and its margins MEASURED", () => {
        const tf = anaTF(K60, cohTo(138), 1024, 77);
        const loop = buildAxisLoop(0, tf, cfg, UNITY_CHAIN, true, true, null, {
            sweep: SWEEP,
            analysis: { segmentSamples: 1024, sampleRateHz: FS, windowSamples: WINDOW, segments: 77 },
            support: declaredSupport(tf),
            resolution: declaredConvergence(FS / 1024, FS),
        });
        const own = loopMargins(loop);
        expect(own.evidence.level).toBe("MODEL_CONDITIONAL");
        expect(own.evidence.convergence?.status).toBe("CONVERGED");
        for (const k of [1.3, 0.7]) {
            const m = loopMargins(loop, { cfg: scaledP(k) });
            expect(m.evidence.convergence?.status).toBe("UNKNOWN");
            expect(m.reasons).toContain("resolution_convergence_unknown:candidate_not_checked");
            noBounds(m);
        }
        // The search finds no candidate with bounded robustness: nothing is proposed as improved.
        const r = optimizeAxisPid(loop, current, null);
        expect(r.status).toBe("BLOCKED");
        expect(r.proposedMargins.evidence.level).not.toBe("VALIDATED");
        expect(r.proposedMargins.evidence.level).not.toBe("MODEL_CONDITIONAL");
        expect(r.reasons).toContain("required_measurement:chirp_longer_window_for_resolution");
    });

    it("the audit's case: current ≈ 12 Hz on 1.95 Hz bins, candidate ≈ 20 Hz — each judged at its own crossover", () => {
        const ladder = [512, 1024, 2048].map((n) => rung(K40, n));
        // The standard rung forced (as the engine would have read it before the adaptive ladder).
        const loop = engineLoop(K40, ladder, 0);
        const cur = loopMargins(loop);
        expect(cur.crossoverHz!).toBeGreaterThan(10);
        expect(cur.crossoverHz!).toBeLessThan(14);
        // 1.95 Hz bins on a 12 Hz crossover miss the target: NOT_CONVERGED, MEASURED.
        expect(binOf(cur)).toBeGreaterThan(RESOLUTION_TARGET.maxBinSpacingOfCrossover * cur.crossoverHz!);
        expect(cur.evidence.convergence?.status).toBe("NOT_CONVERGED");
        expect(cur.reasons.some((x) => x.startsWith("resolution_target_not_met:bin_spacing:"))).toBe(true);
        noBounds(cur);
        // The candidate with P, I and D × 1.3 (the audit's proposal, 45/80/30 → 59/104/39) crosses near
        // 20.4 Hz, where the same bins do meet the target: it gets its own verdict (re-read on the
        // rungs, with the finer rung named), not the current one.
        const cand = loopMargins(loop, { cfg: scaledPid(1.3) });
        expect(cand.crossoverHz!).toBeGreaterThan(18);
        expect(cand.crossoverHz!).toBeLessThan(23);
        const v = cand.evidence.convergence!;
        expect(v.checkedAgainstSegmentSamples).toBe(1024);
        expect(v.deltaCrossoverPct).not.toBeNull();
        expect(v.reasons.some((x) => x.startsWith("resolution_target_not_met"))).toBe(false);
        expect(v).not.toEqual(cur.evidence.convergence);
        expect(binOf(cand)).toBeLessThanOrEqual(RESOLUTION_TARGET.maxBinSpacingOfCrossover * cand.crossoverHz! * 1.001);
        // The verdict is the rung comparison for this candidate: the same numbers as a direct call.
        const direct = resolutionVerdictFor(loop, { cfg: scaledPid(1.3) }, cand.crossoverHz!);
        expect(direct).toEqual(v);
    });

    it("falling crossover: a candidate that lowers fc below what the rung resolves is MEASURED, with the target named", () => {
        const ladder = [512, 1024, 2048].map((n) => rung(K60, n));
        const loop = engineLoop(K60, ladder); // 26 Hz: the 512 rung (1.95 Hz) meets the target
        const cur = loopMargins(loop);
        expect(cur.evidence.convergence?.usedSegmentSamples).toBe(512);
        expect(cur.evidence.convergence?.status).toBe("CONVERGED");
        expect(cur.evidence.level).toBe("MODEL_CONDITIONAL");
        const cand = loopMargins(loop, { cfg: scaledP(0.5) }); // ≈ 14.7 Hz: 1.95 Hz bins exceed 0.1 × fc
        expect(cand.crossoverHz!).toBeLessThan(cur.crossoverHz!);
        expect(binOf(cand)).toBeGreaterThan(RESOLUTION_TARGET.maxBinSpacingOfCrossover * cand.crossoverHz!);
        expect(cand.evidence.convergence?.status).toBe("NOT_CONVERGED");
        expect(cand.reasons.some((x) => x.startsWith("resolution_target_not_met:bin_spacing:"))).toBe(true);
        noBounds(cand);
    });

    it("rising crossover: a candidate that raises fc keeps a valid, recomputed verdict and may be bounded", () => {
        const ladder = [512, 1024, 2048].map((n) => rung(K60, n));
        const loop = engineLoop(K60, ladder);
        const cand = loopMargins(loop, { cfg: scaledP(1.3) });
        expect(cand.crossoverHz!).toBeGreaterThan(loopMargins(loop).crossoverHz!);
        const v = cand.evidence.convergence!;
        expect(v.status).toBe("CONVERGED");
        expect(v.checkedAgainstSegmentSamples).toBe(1024);
        expect(Math.abs(v.deltaCrossoverPct!)).toBeLessThan(3);
        expect(cand.evidence.level).toBe("MODEL_CONDITIONAL");
        expect(cand.gainMarginDb).not.toBeNull();
    });

    it("the PID search: whatever it picks carries a verdict read at the pick's own crossover", () => {
        const ladder = [512, 1024, 2048].map((n) => rung(K60, n));
        const loop = engineLoop(K60, ladder);
        const r = optimizeAxisPid(loop, current, null);
        const v = r.proposedMargins.evidence.convergence!;
        expect(v.reasons).not.toContain("resolution_convergence_unknown:candidate_not_checked");
        if (r.proposedMargins.evidence.level !== "MEASURED") {
            expect(v.status).toBe("CONVERGED");
            expect(v.usedBinSpacingHz).toBeLessThanOrEqual(
                RESOLUTION_TARGET.maxBinSpacingOfCrossover * r.proposedMargins.crossoverHz! * 1.001,
            );
        }
        if (r.changed) expect(v.deltaCrossoverPct).not.toBeNull();
    });

    it("end to end (SIMULATION): the engine's proposed margins carry their own verdict, consistent with the target", () => {
        const G = ratePlant({ K: 60, motorHz: 40, delayS: 0.002 });
        const bytes = closedLoopChirpLog({ plants: [G, null, null], noise: 0.3, seed: 33 });
        const sha = createHash("sha256").update(bytes).digest("hex");
        const [log]: AutotuneLogInput[] = buildLogInputs(
            bytes,
            sha,
            qualifyChirpFile(bytes, "air20", 45, AUTOTUNE_MATH),
            null,
        );
        const r = runAutotuneV2({ primary: log, others: [], verifiedTune: null, createdAt: "2026-10-27T00:00:00Z" });
        const { current: cur, proposed } = r.margins.roll!;
        expect(cur.evidence.convergence?.status).toBe("CONVERGED");
        const v = proposed.evidence.convergence!;
        expect(v.reasons).not.toContain("resolution_convergence_unknown:candidate_not_checked");
        expect(v.checkedAgainstSegmentSamples).not.toBeNull();
        if (proposed.evidence.level !== "MEASURED") {
            expect(v.status).toBe("CONVERGED");
            expect(v.usedBinSpacingHz).toBeLessThanOrEqual(
                RESOLUTION_TARGET.maxBinSpacingOfCrossover * proposed.crossoverHz! * 1.001,
            );
        }
        // One flight, no Verified Tune: nothing is released either way.
        expect(r.releasableProposal).toBeNull();
    }, 120_000);
});
