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
 * A bounded check of the JIO uncertainty assumption on the synthetic closed loop (local only;
 * GYROFLIGHT_JIO_NEFF_CHECK=1): N independent flights of the same plant with a fed-back
 * gyro-like disturbance; at every supported evaluation point the empirical spread of the closed-loop
 * estimate T = H_ry across flights against the spread the route predicts from the coherence under
 * n_eff = 2m + 1. This is not a calibration — the fixture is a simulation and the real disturbance
 * is not this one — it says whether the formula is in the right order on a loop it fully controls.
 * Seeds 1_100_001… (outside every range the frozen research consumed).
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { buildLogInputs } from "../../src/gyrocore/engine/logInput";
import { runAutotuneV2 } from "../../src/gyrocore/engine/autotuneV2";
import { JIO_SWEEP, relativeSd } from "../../src/gyrocore/engine/jioSweep";
import { closedLoopChirpLog, ratePlant } from "./harness/closedLoopBbl";

const N = Number(process.env.GYROFLIGHT_JIO_NEFF_N ?? 24);
const enabled = process.env.GYROFLIGHT_JIO_NEFF_CHECK === "1";

describe.skipIf(!enabled)("JIO n_eff assumption against the empirical spread on the synthetic loop (local)", () => {
    it(`predicted vs empirical relative sd of T over ${N} independent synthetic flights`, () => {
        const G = ratePlant({ K: 60, motorHz: 40, delayS: 0.002 });
        const runs: { f: Float64Array; tRe: Float64Array; tIm: Float64Array; g2: Float64Array; sup: Uint8Array }[] = [];
        for (let k = 0; k < N; k++) {
            const seed = 1_100_001 + k;
            const bytes = closedLoopChirpLog({
                plants: [G, null, null],
                sweepS: 20,
                amplitude: 150,
                seed,
                startTimeUs: 2_000_000 + k * 1_000_000,
                jio: { disturbance: { sd: 3, poleHz: 300 } },
            });
            const sha = createHash("sha256").update(bytes).digest("hex");
            const [log] = buildLogInputs(
                bytes,
                sha,
                qualifyChirpFile(bytes, `neff-${seed}.bbl`, 45, AUTOTUNE_MATH),
                null,
            );
            const r = runAutotuneV2({ primary: log, others: [], verifiedTune: null });
            const a = r.jio.analysis.axes.roll!;
            expect(a.grid!.nEff).toBe(2 * JIO_SWEEP.daniellHalfWidthBins + 1);
            const p = a.points!;
            runs.push({ f: p.frequencyHz, tRe: p.tRe, tIm: p.tIm, g2: p.coherenceRy, sup: p.supported });
        }
        const nf = runs[0].f.length;
        expect(runs.every((x) => x.f.length === nf)).toBe(true);
        const nEff = 2 * JIO_SWEEP.daniellHalfWidthBins + 1;
        const perPoint: { f: number; g2: number; predicted: number; empirical: number; ratio: number }[] = [];
        for (let i = 0; i < nf; i++) {
            if (!runs.every((x) => x.sup[i])) continue;
            let mRe = 0;
            let mIm = 0;
            let g2 = 0;
            for (const x of runs) {
                mRe += x.tRe[i] / N;
                mIm += x.tIm[i] / N;
                g2 += x.g2[i] / N;
            }
            const mag = Math.hypot(mRe, mIm);
            let ss = 0;
            for (const x of runs) ss += (x.tRe[i] - mRe) ** 2 + (x.tIm[i] - mIm) ** 2;
            // Per-component sd of the complex estimate (the formula's relsd is per component).
            const empirical = Math.sqrt(ss / (2 * (N - 1))) / mag;
            const predicted = relativeSd(g2, nEff);
            perPoint.push({ f: runs[0].f[i], g2, predicted, empirical, ratio: empirical / predicted });
        }
        expect(perPoint.length).toBeGreaterThan(20);
        const ratios = perPoint.map((p) => p.ratio).sort((a, b) => a - b);
        const q = (x: number) => ratios[Math.min(ratios.length - 1, Math.floor(x * ratios.length))];
        const summary = {
            fixture:
                "closedLoopChirpLog roll, AIR65-like plant, disturbance sd 3 PT1 300 Hz, 2–200 Hz / 20 s, amplitude 150",
            flights: N,
            seeds: [1_100_001, 1_100_000 + N],
            nEffAssumed: nEff,
            pointsAllSupported: perPoint.length,
            bandHz: [perPoint[0].f, perPoint[perPoint.length - 1].f],
            ratioEmpiricalOverPredicted: { q10: q(0.1), median: q(0.5), q90: q(0.9) },
            // relsd ∝ 1/√n_eff: the n_eff that would make the median ratio 1 on this fixture.
            impliedNEffOnThisFixture: nEff / q(0.5) ** 2,
            verdict:
                "synthetic only: not a calibration of the real-flight uncertainty; the route keeps n_eff an uncalibrated assumption",
            perPoint: perPoint.map((p) => ({
                f: +p.f.toFixed(2),
                g2: +p.g2.toFixed(3),
                predicted: +p.predicted.toFixed(4),
                empirical: +p.empirical.toFixed(4),
            })),
        };
        const out = process.env.GYROFLIGHT_QUAL_OUT;
        if (out) {
            mkdirSync(out, { recursive: true });
            writeFileSync(path.join(out, "jio_neff_check_synthetic.json"), JSON.stringify(summary, null, 1));
        }
        // The assertion is only that the result is finite and reported; the number itself is evidence, not a gate.
        expect(Number.isFinite(summary.ratioEmpiricalOverPredicted.median)).toBe(true);
    }, 1_800_000);
});
