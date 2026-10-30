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
 * Adaptive Welch resolution and the H1 convergence check (measurement audit 2026-10-26, B1 / H1;
 * adaptiveResolution.ts). The standard analysis fixes its segment on the sample rate; a loop that
 * crosses low (7-inch-like, ≈ 6.8 Hz) was read on 1.95 Hz bins with a systematic optimistic bias
 * (E1: fc +9 %, PM +1.5°). The engine now picks the rung of a resolution ladder (same samples,
 * longer segments) whose bin spacing suits the crossover, checks it against the next finer rung,
 * records a window too short for that explicitly, and never pads.
 *
 * Every plant is a SIMULATION (the synthetic Blackbox harness or analytic grids): software-contract
 * evidence only, never AIR65 or any other flight evidence; the 7-inch-like parameters are an
 * assumption, not a calibrated craft.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cmul, evaluateControllerFrf } from "../../src/js/blackbox/betaflight_digital_controller";
import { closedLoopFromPlant, plantFrf, syntheticTransferFunction } from "../../src/js/blackbox/betaflight_open_loop";
import {
    ADAPTIVE_RESOLUTION,
    binSpacingHz,
    chooseAnalysis,
    effectiveResolutionHz,
    resolutionConvergence,
    segmentNeededFor,
    type AnalysisOption,
} from "../../src/gyrocore/engine/adaptiveResolution";
import {
    buildAxisLoop,
    loopMargins,
    marginEvidenceIssues,
    provenanceIssues,
    UNCERTAINTY,
} from "../../src/gyrocore/engine/loopModel";
import type { EffectiveChain } from "../../src/gyrocore/engine/gyroChain";
import { buildLogInputs } from "../../src/gyrocore/engine/logInput";
import {
    controllerConfigFromHeaders,
    runAutotuneV2,
    type AutotuneLogInput,
} from "../../src/gyrocore/engine/autotuneV2";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { closedLoopChirpLog, ratePlant, type ClosedLoopLogOptions, type Plant } from "./harness/closedLoopBbl";
import { BETAFLIGHT_TUNE_HEADERS, SIM_IDENTITY_HEADERS } from "./harness/chirpSim";
import { declaredSupport } from "./harness/frequencySupport";
import { declaredConvergence } from "./harness/resolutionConvergence";
import { simulatedQualifiedEvidence } from "./harness/marginEvidenceFixture";

const HEADERS = Object.fromEntries([
    ...[...SIM_IDENTITY_HEADERS, ...BETAFLIGHT_TUNE_HEADERS].map((l) => [
        l.slice(0, l.indexOf(":")),
        l.slice(l.indexOf(":") + 1),
    ]),
    ["looptime", "125"],
    ["pid_process_denom", "8"],
]);
const cfg = controllerConfigFromHeaders(HEADERS, 0)!;
const UNITY_CHAIN: EffectiveChain = {
    samples: 1,
    frf: () => ({ re: 1, im: 0 }),
    spread: () => ({ phaseDeg: 0, gainDb: 0 }),
    medianLpf1Hz: 0,
    dynNotchHz: [],
};
const SEVEN_INCH = { K: 30, motorHz: 15, delayS: 0.004 };
const AIR65_LIKE = { K: 60, motorHz: 40, delayS: 0.002 };

/** Crossover and phase margin of the true loop G · C_fb on a 0.001 Hz grid. */
function truth(G: Plant) {
    const L = (f: number) => cmul(G(f), evaluateControllerFrf(cfg, f).cFeedback);
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

function decoded(o: ClosedLoopLogOptions, name: string): AutotuneLogInput {
    const bytes = closedLoopChirpLog(o);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const [log] = buildLogInputs(bytes, sha, qualifyChirpFile(bytes, name, 45, AUTOTUNE_MATH), null);
    expect(log, name).toBeDefined();
    return log;
}
const engine = (primary: AutotuneLogInput) =>
    runAutotuneV2({ primary, others: [], verifiedTune: null, createdAt: "2026-10-27T00:00:00Z" });

/** An analytic rung: the closed loop of `G` on the Welch grid of `segment` samples at `fs`. */
function rung(G: Plant, segment: number, fs = 1000, windowSamples = 20000): AnalysisOption {
    const freqs = Array.from({ length: segment / 2 }, (_, k) => ((k + 1) * fs) / segment);
    const tf = syntheticTransferFunction(freqs, (f) => {
        const c = evaluateControllerFrf(cfg, f);
        return closedLoopFromPlant(G(f), c.cReference, c.cFeedback);
    });
    const segments = Math.floor((windowSamples - segment) / (segment / 2)) + 1;
    tf.numSegments = segments;
    return {
        tf,
        analysis: { segmentSamples: segment, sampleRateHz: fs, windowSamples, segments },
        support: declaredSupport(tf),
    };
}

describe("bin spacing, effective resolution and the rung a crossover needs", () => {
    const ladder = [512, 1024, 2048, 4096].map((n) => rung((f) => plantFrf(f, SEVEN_INCH), n));

    it("keeps bin spacing and effective (Hann ENBW) resolution apart", () => {
        expect(binSpacingHz(ladder[0].analysis)).toBeCloseTo(1.953125, 9);
        expect(effectiveResolutionHz(ladder[0].analysis)).toBeCloseTo(1.5 * 1.953125, 9);
        expect(ADAPTIVE_RESOLUTION.hannEnbwBins).toBe(1.5);
    });

    it("an AIR65-like crossover (≈ 26 Hz) is served by the standard rung", () => {
        expect(chooseAnalysis(ladder, 26)).toEqual({ index: 0, reasons: [] });
    });

    it("a 7-inch-like crossover (≈ 6.8 Hz) needs 2048 samples at 1 kHz: the third rung", () => {
        expect(chooseAnalysis(ladder, 6.8)).toEqual({ index: 2, reasons: [] });
        expect(segmentNeededFor(6.8, 1000)).toEqual({
            segmentSamples: 2048,
            windowSamples: (2048 * (UNCERTAINTY.minWelchSegments + 1)) / 2,
        });
    });

    it("a crossover the window cannot resolve: the finest rung, the shortfall and the data length named", () => {
        const r = chooseAnalysis(ladder, 2);
        expect(r.index).toBe(3);
        expect(r.reasons).toContain("resolution_target_not_reachable:needs_segment:8192:window_gives:4096");
        expect(r.reasons).toContain(`data_length_insufficient:needs_samples:${(8192 * 9) / 2}:have:20000`);
    });

    it("without a crossover on the standard analysis the standard rung is used and said so", () => {
        expect(chooseAnalysis(ladder, null).index).toBe(0);
        expect(chooseAnalysis(ladder, null).reasons).toEqual([
            "resolution_target_unknown:no_crossover_on_standard_analysis",
        ]);
    });

    it("the ladder must ascend", () => {
        expect(() => chooseAnalysis([ladder[1], ladder[0]], 10)).toThrow();
    });

    it("no rung claims a resolution its samples cannot give (no padding)", () => {
        for (const r of ladder) expect(provenanceIssues(r.tf, r.analysis)).toEqual([]);
    });
});

describe("the convergence verdict (H1)", () => {
    const G: Plant = (f) => plantFrf(f, AIR65_LIKE);
    const ladder = [512, 1024, 2048].map((n) => rung(G, n));
    // f1 at the Welch Nyquist of these rungs (fs/2 = 500 Hz): every bin has dwell, no generator-stop (F2).
    const probeSweep = { f0Hz: 0.5, f1Hz: 500, durationS: 8000 };
    const probe = (r: AnalysisOption) => {
        // Window must match the declared sweep or dwell is clipped to 20 s (Grokbot F2).
        const analysis = {
            ...r.analysis,
            windowSamples: Math.max(
                r.analysis.windowSamples,
                Math.floor(probeSweep.durationS * r.analysis.sampleRateHz),
            ),
        };
        const loop = buildAxisLoop(0, r.tf, cfg, UNITY_CHAIN, true, true, null, {
            analysis,
            support: r.support,
            sweep: probeSweep,
        });
        return { loop, margins: loopMargins(loop) };
    };

    it("an analytic smooth loop converges between adjacent rungs", () => {
        const v = resolutionConvergence(ladder, 0, probe);
        expect(v.status).toBe("CONVERGED");
        expect(v.usedSegmentSamples).toBe(512);
        expect(v.checkedAgainstSegmentSamples).toBe(1024);
        expect(Math.abs(v.deltaCrossoverPct!)).toBeLessThan(1);
        expect(Math.abs(v.deltaPhaseMarginDeg!)).toBeLessThan(1);
        expect(v.reasons).toEqual([]);
    });

    it("without a finer rung the convergence is unknown and the window length is named", () => {
        const v = resolutionConvergence(ladder, 2, probe);
        expect(v.status).toBe("UNKNOWN");
        expect(v.reasons).toContain("resolution_convergence_unknown:window_too_short_for_2x:2048:window:20000");
    });

    it("a rung that reads no crossover gives an unknown verdict", () => {
        const noCrossing = probe(ladder[0]);
        const v = resolutionConvergence(ladder, 0, () => ({
            loop: noCrossing.loop,
            margins: {
                ...noCrossing.margins,
                crossoverHz: null,
                measured: { ...noCrossing.margins.measured, phaseMarginDeg: null },
            },
        }));
        expect(v.status).toBe("UNKNOWN");
        expect(v.reasons).toContain("resolution_convergence_unknown:no_crossover_on_used_analysis");
    });

    it("a crossover that moves by more than 3 % between rungs is not converged", () => {
        const a = probe(ladder[0]);
        const b = probe(ladder[1]);
        const v = resolutionConvergence(ladder, 0, (r) =>
            r === ladder[0]
                ? a
                : { loop: b.loop, margins: { ...b.margins, crossoverHz: b.margins.crossoverHz! * 1.09 } },
        );
        expect(v.status).toBe("NOT_CONVERGED");
        expect(v.reasons.some((x) => x.startsWith("resolution_not_converged:fc:9."))).toBe(true);
    });

    it("the margins are MEASURED, never bounds, unless the verdict is CONVERGED", () => {
        const base = rung(G, 512);
        const sweep = { f0Hz: 0.5, f1Hz: 500, durationS: 8000 };
        const analysis = {
            ...base.analysis,
            windowSamples: Math.max(
                base.analysis.windowSamples,
                Math.floor(sweep.durationS * base.analysis.sampleRateHz),
            ),
        };
        const at = (resolution: ReturnType<typeof declaredConvergence> | null) =>
            loopMargins(
                buildAxisLoop(0, base.tf, cfg, UNITY_CHAIN, true, true, null, {
                    analysis,
                    support: base.support,
                    resolution,
                    sweep,
                }),
            );
        const none = at(null);
        expect(none.evidence.level).toBe("MEASURED");
        expect(none.reasons).toContain("resolution_convergence_unknown:not_checked");
        expect(none.gainMarginDb).toBeNull();
        const bad = at({
            ...declaredConvergence(),
            status: "NOT_CONVERGED",
            reasons: ["resolution_not_converged:fc:9.1pct"],
        });
        expect(bad.evidence.level).toBe("MEASURED");
        expect(bad.reasons).toContain("resolution_not_converged:fc:9.1pct");
        const good = at(declaredConvergence(1.953125, 1000));
        expect(good.evidence.level).toBe("MODEL_CONDITIONAL");
        expect(good.evidence.convergence?.status).toBe("CONVERGED");
        expect(good.gainMarginDb).not.toBeNull();
    });

    it("the release contract refuses VALIDATED evidence without a CONVERGED verdict (fail-closed)", () => {
        const ev = simulatedQualifiedEvidence(50, 10, 4);
        expect(marginEvidenceIssues(ev)).toEqual([]);
        expect(marginEvidenceIssues({ ...ev, convergence: null })).toContain("resolution_convergence_missing");
        expect(marginEvidenceIssues({ ...ev, convergence: undefined })).toContain("resolution_convergence_missing");
        expect(marginEvidenceIssues({ ...ev, convergence: { ...ev.convergence!, status: "UNKNOWN" } })).toContain(
            "resolution_convergence_missing",
        );
    });
});

// Each case synthesises a Blackbox log and runs the whole engine (ladder, candidate probes, PID and
// filter searches): about 3 s alone, more under the full suite's parallel load; an explicit timeout.
describe("end to end on synthetic flights (SIMULATION)", () => {
    it("7-inch-like, 20 s sweep: the engine reads the loop on a finer rung and lands within 3 % / 2° of the truth", () => {
        const G = ratePlant(SEVEN_INCH);
        const t = truth(G);
        const log = decoded({ plants: [G, null, null], noise: 0.3, seed: 31 }, "seven20");
        const c = log.chirp.roll!;
        expect(c.analyses!.length).toBeGreaterThanOrEqual(3);
        expect(c.analyses![0].analysis.segmentSamples).toBe(512);
        for (const r of c.analyses!) expect(provenanceIssues(r.tf, r.analysis)).toEqual([]);
        const m = engine(log).margins.roll!.current;
        const conv = m.evidence.convergence!;
        expect(conv.usedSegmentSamples).toBeGreaterThan(512);
        expect(conv.usedBinSpacingHz).toBeLessThanOrEqual(
            ADAPTIVE_RESOLUTION.maxBinSpacingOfCrossover * m.crossoverHz! * 1.001,
        );
        // The standard analysis read this loop 9 % high; the adaptive one lands on the truth.
        expect(Math.abs(m.crossoverHz! - t.fc) / t.fc).toBeLessThan(0.03);
        expect(Math.abs(m.measured.phaseMarginDeg! - t.pm)).toBeLessThan(2);
        if (conv.status === "CONVERGED") {
            expect(m.reasons.some((r) => r.startsWith("resolution_"))).toBe(false);
        } else {
            expect(m.evidence.level).toBe("MEASURED");
            expect(m.reasons.some((r) => r.startsWith("resolution_"))).toBe(true);
        }
    }, 60_000);

    it("7-inch-like, 6 s sweep: too short for the resolution its crossover needs, which is said, and nothing is bounded", () => {
        const G = ratePlant(SEVEN_INCH);
        const log = decoded({ plants: [G, null, null], noise: 0.3, seed: 32, sweepS: 6 }, "seven6");
        const r = engine(log);
        const m = r.margins.roll?.current;
        expect(m).toBeDefined();
        if (m!.crossoverHz !== null) {
            expect(m!.evidence.level).toBe("MEASURED");
            expect(
                m!.reasons.some(
                    (x) =>
                        x.startsWith("resolution_target_not_reachable:") ||
                        x.startsWith("resolution_convergence_unknown:"),
                ),
            ).toBe(true);
            expect(m!.reasons.some((x) => x.startsWith("data_length_insufficient:"))).toBe(true);
        }
        expect(r.pid.find((p) => p.axis === "roll")!.status).toBe("BLOCKED");
        expect(r.releasableProposal).toBeNull();
    }, 60_000);

    it("AIR65-like, 20 s sweep: the standard rung suffices, is checked against the next one and converges", () => {
        const G = ratePlant(AIR65_LIKE);
        const t = truth(G);
        const log = decoded({ plants: [G, null, null], noise: 0.3, seed: 33 }, "air20");
        const m = engine(log).margins.roll!.current;
        const conv = m.evidence.convergence!;
        expect(conv.usedSegmentSamples).toBe(512);
        expect(conv.checkedAgainstSegmentSamples).toBe(1024);
        expect(conv.status).toBe("CONVERGED");
        expect(Math.abs(m.crossoverHz! - t.fc) / t.fc).toBeLessThan(0.03);
        expect(Math.abs(m.measured.phaseMarginDeg! - t.pm)).toBeLessThan(2);
    }, 60_000);
});
