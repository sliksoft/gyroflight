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
 * Measurement qualification hardening (release gate 2026-10-27, P3 findings; continuation B1):
 *
 *   - γ²(excitation → setpoint) is taken from debug[3] only when qualityV2 measured that channel as
 *     the firmware's excitation; otherwise the bins' support is UNKNOWN (coherence is scale-invariant,
 *     so a corrupted or foreign channel would otherwise pass as support).
 *   - The gap rule refuses a grid that is not uniform: a transfer function with bins removed hides
 *     its own gaps (the gate's G2 experiment: VALIDATED 82° against a true 4.7°).
 *   - The decision-band diagnostic says why each missing bin dropped out (coherence, plant status,
 *     support, uncertainty). Diagnostic only: no verdict changes with it.
 *
 * SIMULATION throughout: analytic loops and the synthetic Blackbox harness.
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
import { controllerConfigFromHeaders, runAutotuneV2 } from "../../src/gyrocore/engine/autotuneV2";
import {
    buildAxisLoop,
    candidateLoop,
    gridNonUniformity,
    loopMargins,
    supportIssues,
} from "../../src/gyrocore/engine/loopModel";
import type { EffectiveChain } from "../../src/gyrocore/engine/gyroChain";
import { buildLogInputs } from "../../src/gyrocore/engine/logInput";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { closedLoopChirpLog, ratePlant, type Plant } from "./harness/closedLoopBbl";
import { BETAFLIGHT_TUNE_HEADERS, SIM_IDENTITY_HEADERS } from "./harness/chirpSim";
import { declaredSupport } from "./harness/frequencySupport";
import { declaredResolution } from "./harness/resolutionConvergence";

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
const SWEEP = { f0Hz: 1, f1Hz: 400, durationS: 20 };

/** Analytic T of `G` on the 512-sample grid, coherence `coh(f)`, minus the bins in `drop` (Hz). */
function anaTF(G: Plant, coh: (f: number) => number, n: number, K: number, drop: number[] = []): TransferFunction {
    const idx: number[] = [];
    for (let k = 0; k < n / 2 + 1; k++) if (!drop.some((d) => Math.abs(d - (k * FS) / n) < 1e-9)) idx.push(k);
    const fr = new Float64Array(idx.length);
    const mag = new Float64Array(idx.length);
    const ph = new Float64Array(idx.length);
    const co = new Float64Array(idx.length);
    const re = new Float64Array(idx.length);
    const im = new Float64Array(idx.length);
    idx.forEach((k, j) => {
        const f = (k * FS) / n;
        fr[j] = f;
        const ff = Math.max(f, 1e-3);
        const ctl = evaluateControllerFrf(cfg, ff);
        const g = G(ff);
        const T = cdiv(cmul(g, ctl.cReference), cadd({ re: 1, im: 0 }, cmul(g, ctl.cFeedback)));
        re[j] = T.re;
        im[j] = T.im;
        mag[j] = 20 * Math.log10(cmag(T));
        ph[j] = cphaseDeg(T);
        co[j] = k === 0 ? 0 : coh(f);
    });
    return { frequencies: fr, magnitude: mag, phase: ph, coherence: co, hReal: re, hImag: im, numSegments: K };
}
const cohWith =
    (top: number, holes: number[] = []) =>
    (f: number) =>
        f >= 2 && f <= top ? (holes.some((h) => Math.abs(h - f) < 1e-9) ? 0.5 : 0.999) : 0;

const G60 = ratePlant({ K: 60, motorHz: 40, delayS: 0.002 });
const build = (tf: TransferFunction, fine: TransferFunction) =>
    buildAxisLoop(
        0,
        tf,
        cfg,
        UNITY_CHAIN,
        true,
        true,
        {
            tf: fine,
            source: { sha256: "a".repeat(64), logIndex: 2 },
            sweep: SWEEP,
            analysis: { segmentSamples: 4096, sampleRateHz: FS, windowSamples: 20000, segments: 8 },
            support: declaredSupport(fine, { observedHz: [2, 400] }),
        },
        {
            sweep: SWEEP,
            analysis: { segmentSamples: 512, sampleRateHz: FS, windowSamples: 20000, segments: 77 },
            support: declaredSupport(tf, { observedHz: [2, 400] }),
            ...declaredResolution(FS / 512, FS),
        },
    );

describe("the gap rule refuses a grid that is not uniform", () => {
    it("gridNonUniformity: a full Welch grid passes, a grid with a bin removed does not", () => {
        const full = Array.from({ length: 257 }, (_, k) => (k * FS) / 512);
        expect(gridNonUniformity(full)).toBeNull();
        expect(gridNonUniformity(full.filter((_, k) => k !== 20))).toBe("frequency_grid_not_uniform:1_bins_removed");
        expect(gridNonUniformity([0, 1, 1, 2])).toBe("frequency_grid_not_uniform:non_positive_step");
        // Two bins removed in one place count as two.
        expect(gridNonUniformity(full.filter((_, k) => k !== 20 && k !== 21))).toBe(
            "frequency_grid_not_uniform:2_bins_removed",
        );
        // Grids that are non-uniform by construction are not uniform grids with bins removed.
        const log = Array.from({ length: 140 }, (_, i) => 10 ** (i / 60));
        expect(gridNonUniformity(log)).toBeNull();
        const jittered = Array.from({ length: 400 }, (_, i) => 0.5 * i + 0.15 * Math.sin(i * 1.7));
        expect(gridNonUniformity(jittered)).toBeNull();
    });

    it("control: the same loop on the full grid is VALIDATED", () => {
        const m = loopMargins(build(anaTF(G60, cohWith(138), 512, 77), anaTF(G60, cohWith(225), 4096, 8)));
        expect(m.evidence.level).toBe("VALIDATED");
    });

    it("bins removed from both grids (the gate's G2 case): MEASURED, no GM / |S|, the grid named", () => {
        const peak = 20 * (FS / 512);
        const fineStep = FS / 4096;
        const tf = anaTF(G60, cohWith(138), 512, 77, [peak]);
        const fine = anaTF(G60, cohWith(225), 4096, 8, [Math.floor(peak / fineStep) * fineStep]);
        const loop = build(tf, fine);
        const m = loopMargins(loop);
        expect(m.reasons).toContain("frequency_grid_not_uniform:1_bins_removed");
        expect(m.evidence.level).toBe("MEASURED");
        expect(m.gainMarginDb).toBeNull();
        expect(m.sensitivityPeakDb).toBeNull();
        expect(supportIssues(loop, candidateLoop(loop, { cfg }), m.crossoverHz)).toContain(
            "frequency_grid_not_uniform:1_bins_removed",
        );
    });
});

describe("decision-band drops are classified, never acted on", () => {
    it("a coherence hole in the band is counted as coherence; the verdict is the same as without the diagnostic", () => {
        const fcBin = 14 * (FS / 512); // ≈ 27.3 Hz, inside the band of the ≈ 26 Hz crossover
        const loop = build(
            anaTF(G60, cohWith(138, [fcBin, fcBin + FS / 512]), 512, 77),
            anaTF(G60, cohWith(225), 4096, 8),
        );
        const m = loopMargins(loop);
        const band = m.evidence.decisionBand!;
        expect(band.gridBins - band.keptBins).toBe(2);
        expect(band.dropped).toEqual({ plantStatus: 0, coherence: 2, support: 0, uncertainty: 0 });
        expect(m.evidence.level).toBe("MEASURED");
        expect(m.reasons).toContain("unidentified_bins_inside_band:2");
    });

    it("an unsupported bin is counted as support", () => {
        const tf = anaTF(G60, cohWith(138), 512, 77);
        const bin = 16 * (FS / 512);
        const loop = buildAxisLoop(0, tf, cfg, UNITY_CHAIN, true, true, null, {
            sweep: SWEEP,
            analysis: { segmentSamples: 512, sampleRateHz: FS, windowSamples: 20000, segments: 77 },
            support: declaredSupport(tf, { observedHz: [2, 400], except: [{ hz: bin, verdict: "UNSUPPORTED" }] }),
            ...declaredResolution(FS / 512, FS),
        });
        const band = loopMargins(loop).evidence.decisionBand!;
        expect(band.dropped!.support).toBe(1);
        expect(band.dropped!.coherence).toBe(0);
    });
});

describe("γ²(excitation → setpoint) only from a channel qualityV2 measured as the firmware's excitation", () => {
    const plant = ratePlant({ K: 60, motorHz: 40, delayS: 0.002 });
    const bytes = closedLoopChirpLog({ plants: [plant, null, null], noise: 0.3, seed: 11 });
    const sha = createHash("sha256").update(bytes).digest("hex");

    it("MEASURED excitation: SUPPORTED bins carry γ²(e→s); not MEASURED: every in-band bin UNKNOWN, no bounds", () => {
        const report = qualifyChirpFile(bytes, "exc", 45, AUTOTUNE_MATH);
        const m = report.measurements.find((x) => x.axisName === "roll")!;
        expect(m.qualityV2?.excitation.firmwareExcitation.availability).toBe("MEASURED");
        const [trusted] = buildLogInputs(bytes, sha, report, null);
        const tBins = [...trusted.chirp.roll!.support!.bins.values()];
        expect(tBins.some((b) => b.verdict === "SUPPORTED" && b.excitationCoherence !== null)).toBe(true);

        // The same report with the excitation channel judged out of range (another signal).
        for (const mm of report.measurements) {
            if (!mm.qualityV2) continue;
            mm.qualityV2.excitation.firmwareExcitation = {
                ...mm.qualityV2.excitation.firmwareExcitation,
                availability: "UNKNOWN",
                value: null,
                reasons: ["excitation_channel_out_of_range"],
            };
        }
        const [untrusted] = buildLogInputs(bytes, sha, report, null);
        const c = untrusted.chirp.roll!;
        const inBand = Array.from(c.tf.frequencies).filter((f) => f >= 5 && f <= 100);
        for (const f of inBand) {
            const b = c.support!.bins.get(f)!;
            expect(b.excitationCoherence).toBeNull();
            expect(b.verdict).not.toBe("SUPPORTED");
        }
        const r = runAutotuneV2({
            primary: untrusted,
            others: [],
            verifiedTune: null,
            createdAt: "2026-10-27T00:00:00Z",
        });
        const margins = r.margins.roll!.current;
        expect(margins.evidence.level).toBe("MEASURED");
        expect(margins.reasons.some((x) => x.startsWith("frequency_support_unknown"))).toBe(true);
        expect(r.pid.find((p) => p.axis === "roll")!.status).toBe("BLOCKED");
    }, 60_000);
});
