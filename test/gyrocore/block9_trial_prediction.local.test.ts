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
 * LOCAL (block 9, not a regression): the pre-registered prediction of a roll trial on the AIR65.
 * For candidate roll changes, the baseline plant (5 November, controller in force during the sweep)
 * predicts the candidate's closed-loop T during its sweep; compareAxis (releaseGate/verifiedTune.ts,
 * the Verified Tune rules) is fed that prediction as if it were measured, against the 6 November
 * repeat: how many bins the change makes detectable, so a PASS / FAIL can mean something. Written as
 * JSON to GYROFLIGHT_TRACE_OUT, with the predicted T per bin and the predicted margins.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { buildLogInputs } from "../../src/gyrocore/engine/logInput";
import { analyzeM4BblFile } from "../../src/js/blackbox/m4_bbl_integration";
import { analyzeAxisController, flightMask, type AutotuneLogInput } from "../../src/gyrocore/engine/autotuneV2";
import { buildAxisLoop, loopMargins } from "../../src/gyrocore/engine/loopModel";
import { compareAxis, toleranceFloor, VALIDATION_MAX_HZ } from "../../src/gyrocore/releaseGate/verifiedTune";
import {
    cadd,
    cdiv,
    cmag,
    cmul,
    evaluateControllerFrf,
    type Complex,
    type DigitalControllerConfig,
} from "../../src/js/blackbox/betaflight_digital_controller";
import type { TransferFunction } from "../../src/js/blackbox/spectral_analysis";

const FILES = [
    {
        name: "nov05",
        env: "GYROFLIGHT_AIR65_NOV05",
        sha256: "5654476ad783f1fa241d9fe6e8ae5f978c3d5cef6b417d0d93a59e26ed2b9894",
    },
    {
        name: "nov06",
        env: "GYROFLIGHT_AIR65_NOV06",
        sha256: "eb8ad42e2010e88b6c2bed7e2be4b316993dd38ad86f1438907355d8d5d923a7",
    },
    {
        name: "nov06b",
        env: "GYROFLIGHT_AIR65_NOV06B",
        sha256: "2d0f567f07ae04a19c4d3b15c10e306408575079b57a704b46e3d594ae97be29",
    },
];
const present = FILES.every((f) => !!process.env[f.env] && existsSync(process.env[f.env]!));
const r3 = (x: number | null | undefined) =>
    x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000;
const db = (z: Complex) => 20 * Math.log10(cmag(z));
const deg = (z: Complex) => (Math.atan2(z.im, z.re) * 180) / Math.PI;

/** Roll candidates as logged values (header P / I / D); the engine scales D by its effective ratio. */
const CANDIDATES = [
    { name: "P 50", p: 50, i: 79, d: 30 },
    { name: "P 45", p: 45, i: 79, d: 30 },
    { name: "P 42", p: 42, i: 79, d: 30 },
    { name: "P 39", p: 39, i: 79, d: 30 },
    { name: "P 45 I 63", p: 45, i: 63, d: 30 },
    { name: "D 24", p: 56, i: 79, d: 24 },
    { name: "D 36", p: 56, i: 79, d: 36 },
    { name: "P 39 I 55 D 30", p: 39, i: 55, d: 30 },
];

function load(f: (typeof FILES)[number]): AutotuneLogInput[] {
    const bytes = new Uint8Array(readFileSync(process.env[f.env]!));
    const sha = createHash("sha256").update(bytes).digest("hex");
    expect(sha).toBe(f.sha256);
    const q = qualifyChirpFile(bytes, `${f.name}.bbl`, 45, AUTOTUNE_MATH);
    return buildLogInputs(bytes, sha, q, analyzeM4BblFile(bytes, `${f.name}.bbl`));
}

function scaled(
    cfg: DigitalControllerConfig,
    header: { p: number; i: number; d: number },
    c: { p: number; i: number; d: number },
) {
    return {
        ...cfg,
        axis: {
            ...cfg.axis,
            p: cfg.axis.p * (c.p / header.p),
            i: cfg.axis.i * (c.i / header.i),
            d: cfg.axis.d * (c.d / header.d),
        },
    };
}

describe.skipIf(!present)("block 9: pre-registered roll trial prediction (local)", () => {
    it("baseline 5 Nov, repeats 6 Nov and 011849", () => {
        const [base] = load(FILES[0]);
        const [rep] = load(FILES[1]);
        const rep2 = load(FILES[2]).find((l) => l.logIndex === 1)!;
        const h = Object.fromEntries(base.headerPairs);
        const header = { p: 56, i: 79, d: 30 };
        const ctl = analyzeAxisController(base, h, 0, base.chirp.roll!, flightMask(base.channels.rcThrottle))!;
        const loop = buildAxisLoop(0, base.chirp.roll!.tf, ctl.cfg, null, false, false, null, {
            sweepCfg: ctl.sweepCfg,
        });
        const plant = loop.plant;
        const out: Record<string, unknown> = {
            baseline: {
                sha256: base.sha256,
                itermRelax: ctl.itermRelax,
                flightCfg: ctl.cfg.axis,
                sweepCfg: ctl.sweepCfg.axis,
            },
        };
        // Repeat scatter of the measured T between the three flights, per bin up to 60 Hz.
        const T = (tf: TransferFunction, f: number) => {
            const k = Array.from(tf.frequencies).findIndex((x) => Math.abs(x - f) < 1e-9);
            return k < 0 ? null : { T: { re: tf.hReal[k], im: tf.hImag[k] }, coh: tf.coherence[k] };
        };
        out.repeatScatter = plant.bins
            .filter((b) => b.frequencyHz <= 60 && b.T)
            .map((b) => {
                const a = T(rep.chirp.roll!.tf, b.frequencyHz);
                const c = T(rep2.chirp.roll!.tf, b.frequencyHz);
                return {
                    f: r3(b.frequencyHz),
                    T: { db: r3(db(b.T!)), deg: r3(deg(b.T!)), coh: r3(b.coherence) },
                    dNov06: a
                        ? {
                              db: r3(db(a.T) - db(b.T!)),
                              deg: r3(((deg(a.T) - deg(b.T!) + 540) % 360) - 180),
                              coh: r3(a.coh),
                          }
                        : null,
                    d011849: c
                        ? {
                              db: r3(db(c.T) - db(b.T!)),
                              deg: r3(((deg(c.T) - deg(b.T!) + 540) % 360) - 180),
                              coh: r3(c.coh),
                          }
                        : null,
                };
            });
        const results = CANDIDATES.map((c) => {
            const flightCand = scaled(ctl.cfg, header, c);
            const sweepCand = scaled(ctl.sweepCfg, header, c);
            const pred: Complex[] = plant.bins.map((b) => {
                if (b.status !== "ok" || !b.G) return { re: NaN, im: NaN };
                const frf = evaluateControllerFrf(sweepCand, b.frequencyHz);
                return cdiv(cmul(b.G, frf.cReference), cadd({ re: 1, im: 0 }, cmul(b.G, frf.cFeedback)));
            });
            const tfPred: TransferFunction = {
                frequencies: Float64Array.from(plant.bins.map((b) => b.frequencyHz)),
                magnitude: Float64Array.from(pred, (z) => db(z)),
                phase: Float64Array.from(pred, (z) => deg(z)),
                coherence: Float64Array.from(plant.bins.map((b) => (b.status === "ok" ? b.coherence : 0))),
                hReal: Float64Array.from(pred, (z) => z.re),
                hImag: Float64Array.from(pred, (z) => z.im),
                numSegments: base.chirp.roll!.tf.numSegments,
            };
            // The Verified Tune comparison with the prediction itself as the "measurement": the bins the
            // change makes detectable against the 6 November repeat (a perfect prediction PASSes only
            // when enough bins are detectable).
            const cmp = compareAxis("roll", {
                plant,
                baselineCfg: ctl.sweepCfg,
                candidateCfg: sweepCand,
                candidateT: tfPred,
                baselineRepeatT: rep.chirp.roll!.tf,
            });
            const cmpFloor = compareAxis("roll", {
                plant,
                baselineCfg: ctl.sweepCfg,
                candidateCfg: sweepCand,
                candidateT: tfPred,
            });
            const m = loopMargins(loop, { cfg: flightCand }).measured;
            const peak = pred
                .map((z, k) => ({ f: plant.bins[k].frequencyHz, db: db(z) }))
                .filter((x) => Number.isFinite(x.db) && x.f <= 60)
                .sort((a, b) => b.db - a.db)[0];
            const curPeak = plant.bins
                .filter((b) => b.T && b.frequencyHz <= 60 && b.status === "ok")
                .map((b) => ({ f: b.frequencyHz, db: db(b.T!) }))
                .sort((a, b) => b.db - a.db)[0];
            return {
                candidate: c,
                predictedMargins: { pm: r3(m.phaseMarginDeg), gm: r3(m.gainMarginDb), s: r3(m.sensitivityPeakDb) },
                predictedTPeak: peak ? { f: r3(peak.f), db: r3(peak.db) } : null,
                currentTPeak: curPeak ? { f: r3(curPeak.f), db: r3(curPeak.db) } : null,
                verifiedTuneWithRepeat: cmp,
                verifiedTuneFloorOnly: cmpFloor,
                perBin: plant.bins
                    .map((b, k) => ({ b, k }))
                    .filter(({ b }) => b.status === "ok" && b.T && b.frequencyHz <= VALIDATION_MAX_HZ)
                    .map(({ b, k }) => ({
                        f: r3(b.frequencyHz),
                        current: { db: r3(db(b.T!)), deg: r3(deg(b.T!)) },
                        predicted: { db: r3(db(pred[k])), deg: r3(deg(pred[k])) },
                        floor: toleranceFloor(b.frequencyHz),
                    })),
            };
        });
        out.candidates = results;
        const dir = process.env.GYROFLIGHT_TRACE_OUT;
        if (dir) {
            mkdirSync(dir, { recursive: true });
            writeFileSync(path.join(dir, "trial_prediction.json"), JSON.stringify(out, null, 1));
        }
        expect(results.length).toBe(CANDIDATES.length);
    }, 600_000);
});
