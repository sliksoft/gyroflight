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
 * LOCAL (block 9b, not a regression): the basis of the roll P56 → P45 trial on the AIR65 logs.
 *
 *   A. The I relax at P45. pid.c (SETPOINT type) relaxes on the setpoint only: chirp + ANGLE outer
 *      loop (+ pilot). P can change the relax only through the outer loop's answer to the attitude.
 *      The logged setpoint is split into the firmware chirp (amplitude · phaseComp(debug[3])) and the
 *      rest; the rest's chirp-correlated part is moved with the outer-loop model
 *      H = −(Ka/s)·T / (1 + (Ka/s)·T), Ka = levelPID P / 10 (pid_init.c angleGain), from the measured
 *      T (P56) to the predicted T (P45). ASSUMPTION: the gyro answer at P45 is the predicted T, the
 *      pilot part of the setpoint stays as logged.
 *   B. How an error in the relax factor (baseline extraction and candidate) moves the predicted T per
 *      bin and the Verified Tune verdict (compareAxis with a simulated "measured" T).
 *   C. Flight-to-flight spread of the measured T (5 Nov, 6 Nov, 011849) per bin, the app's tolerance
 *      per bin, the predicted change and which bins are detectable; null comparisons of the unchanged
 *      tune (6 Nov and 011849 as "candidate" of 5 Nov).
 *   D. Per log and axis, the bins the I-relax repair judges differently (kept / dropped, ±2ε).
 *
 * JSON to GYROFLIGHT_TRACE_OUT. Skipped without the private logs.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { buildLogInputs } from "../../src/gyrocore/engine/logInput";
import { analyzeM4BblFile } from "../../src/js/blackbox/m4_bbl_integration";
import {
    analyzeAxisController,
    flightMask,
    sweepFromHeaders,
    type AutotuneLogInput,
} from "../../src/gyrocore/engine/autotuneV2";
import { buildAxisLoop, LOOP_MIN_COHERENCE, UNCERTAINTY, type AxisLoop } from "../../src/gyrocore/engine/loopModel";
import {
    compareAxis,
    toleranceFloor,
    VALIDATION_MAX_HZ,
    MAX_REPEAT_TOLERANCE_FACTOR,
} from "../../src/gyrocore/releaseGate/verifiedTune";
import { itermRelaxConfigFromHeaders, itermRelaxInForce } from "../../src/js/blackbox/betaflight_iterm_relax";
import {
    cadd,
    cdiv,
    cmag,
    cmul,
    evaluateControllerFrf,
    phaseCompCoeffs,
    type Complex,
    type DigitalControllerConfig,
} from "../../src/js/blackbox/betaflight_digital_controller";
import { ComplexFFT } from "../../src/js/blackbox/fft";
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
const AXES = ["roll", "pitch", "yaw"] as const;
const r3 = (x: number | null | undefined) =>
    x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000;
const db = (z: Complex) => 20 * Math.log10(cmag(z));
const deg = (z: Complex) => (Math.atan2(z.im, z.re) * 180) / Math.PI;
const dphase = (a: Complex, b: Complex) => ((((deg(a) - deg(b)) % 360) + 540) % 360) - 180;
const ONE = { re: 1, im: 0 };

function load(f: (typeof FILES)[number]): AutotuneLogInput[] {
    const bytes = new Uint8Array(readFileSync(process.env[f.env]!));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(f.sha256);
    const q = qualifyChirpFile(bytes, `${f.name}.bbl`, 45, AUTOTUNE_MATH);
    return buildLogInputs(bytes, f.sha256, q, analyzeM4BblFile(bytes, `${f.name}.bbl`));
}

const at = (tf: TransferFunction, f: number) => {
    const k = Array.from(tf.frequencies).findIndex((x) => Math.abs(x - f) < 1e-9);
    return k < 0 ? null : { T: { re: tf.hReal[k], im: tf.hImag[k] }, coh: tf.coherence[k] };
};

function scaled(
    cfg: DigitalControllerConfig,
    c: { p: number; i: number; d: number },
    header = { p: 56, i: 79, d: 30 },
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
const withFactor = (cfg: DigitalControllerConfig, flight: DigitalControllerConfig, factor: number) => ({
    ...cfg,
    axis: { ...cfg.axis, i: flight.axis.i * factor },
});

/** Closed-loop T of the sweep from a plant bin under controller c. */
const closed = (G: Complex, c: DigitalControllerConfig, f: number) => {
    const frf = evaluateControllerFrf(c, f);
    return cdiv(cmul(G, frf.cReference), cadd(ONE, cmul(G, frf.cFeedback)));
};

/** Predicted T of the candidate on the plant's bins, as a TransferFunction on the baseline grid. */
function predictedTf(loop: AxisLoop, cand: DigitalControllerConfig, numSegments: number): TransferFunction {
    const pred = loop.plant.bins.map((b) =>
        b.status === "ok" && b.G ? closed(b.G, cand, b.frequencyHz) : { re: NaN, im: NaN },
    );
    return {
        frequencies: Float64Array.from(loop.plant.bins.map((b) => b.frequencyHz)),
        magnitude: Float64Array.from(pred, (z) => db(z)),
        phase: Float64Array.from(pred, (z) => deg(z)),
        coherence: Float64Array.from(loop.plant.bins.map((b) => (b.status === "ok" ? b.coherence : 0))),
        hReal: Float64Array.from(pred, (z) => z.re),
        hImag: Float64Array.from(pred, (z) => z.im),
        numSegments,
    };
}

describe.skipIf(!present)("block 9b: basis of the roll trial (local)", () => {
    it("A–D", () => {
        const logs = {
            nov05: load(FILES[0])[0],
            nov06: load(FILES[1])[0],
            nov06b: load(FILES[2]).find((l) => l.logIndex === 1)!,
        };
        const out: Record<string, unknown> = {};
        const base = logs.nov05;
        const h = Object.fromEntries(base.headerPairs);
        const ctl = analyzeAxisController(base, h, 0, base.chirp.roll!, flightMask(base.channels.rcThrottle))!;
        const tf56 = base.chirp.roll!.tf;
        const loop = buildAxisLoop(0, tf56, ctl.cfg, null, false, false, null, { sweepCfg: ctl.sweepCfg });
        const P45 = { p: 45, i: 79, d: 30 };
        const cand45 = scaled(ctl.sweepCfg, P45);

        // --- A. relax factor at P45 through the ANGLE outer loop --------------------------------
        {
            const c = base.chirp.roll!;
            const s = c.start;
            const e = c.end;
            const n = e - s;
            const j = base.channels.jio!;
            const sp = j.setpoint![0];
            const exc = j.excitation!;
            const amp = Number(h.chirp_amplitude_roll);
            const pc = phaseCompCoeffs(
                Number(h.chirp_lag_freq_hz),
                Number(h.chirp_lead_freq_hz),
                Math.round(ctl.cfg.pidDt * 1e6),
            )!;
            // Firmware chirp at the setpoint: amplitude · phaseComp(exc), the filter run from 1 s before.
            const chirp = new Float64Array(n);
            let x1 = 0;
            let y1 = 0;
            for (let k = Math.max(0, s - 4000); k < e; k++) {
                const x = exc[k] / 1000;
                const yv = pc.b0 * x + pc.b1 * x1 - pc.a1 * y1;
                x1 = x;
                y1 = yv;
                if (k >= s) chirp[k - s] = amp * yv;
            }
            const rest = Float64Array.from({ length: n }, (_, k) => sp[s + k] - chirp[k]);
            const fs = 1 / ctl.cfg.pidDt;
            const ka = Number((h.levelPID ?? "90").split(",")[0]) / 10;
            // T on the FFT grid: the measured / predicted bins, linear in complex between bins.
            const interp = (tf: TransferFunction, f: number): Complex => {
                const fr = tf.frequencies;
                if (f <= fr[1]) return { re: tf.hReal[1], im: tf.hImag[1] };
                for (let k = 1; k < fr.length; k++) {
                    if (fr[k] >= f) {
                        const t = (f - fr[k - 1]) / (fr[k] - fr[k - 1]);
                        const a = { re: tf.hReal[k - 1], im: tf.hImag[k - 1] };
                        const b = { re: tf.hReal[k], im: tf.hImag[k] };
                        if (![a.re, a.im, b.re, b.im].every(Number.isFinite)) return Number.isFinite(a.re) ? a : b;
                        return { re: a.re + t * (b.re - a.re), im: a.im + t * (b.im - a.im) };
                    }
                }
                return { re: 0, im: 0 };
            };
            const outer = (T: Complex, f: number): Complex => {
                const w = 2 * Math.PI * Math.max(f, 1e-6);
                const kOverS = { re: 0, im: -ka / w };
                const kt = cmul(kOverS, T);
                return cdiv({ re: -kt.re, im: -kt.im }, cadd(ONE, kt));
            };
            const fft = new ComplexFFT(n, false);
            const ifft = new ComplexFFT(n, true);
            const C = new Float64Array(2 * n);
            fft.simple(C, chirp, "real");
            const tf45 = predictedTf(loop, cand45, tf56.numSegments);
            // Outer-loop model check against the measured chirp → rest response (P56).
            const restSpec = new Float64Array(2 * n);
            fft.simple(restSpec, rest, "real");
            const modelCheck = [2, 3, 4, 6, 8, 12, 16, 25, 40].map((f0) => {
                const k = Math.round((f0 * n) / fs);
                // Cross over ±8 bins (a sweep: few bins carry the chirp at f0).
                let sxyRe = 0;
                let sxyIm = 0;
                let sxx = 0;
                for (let q = k - 8; q <= k + 8; q++) {
                    const cr = C[2 * q];
                    const ci = C[2 * q + 1];
                    const rr = restSpec[2 * q];
                    const ri = restSpec[2 * q + 1];
                    sxyRe += cr * rr + ci * ri;
                    sxyIm += cr * ri - ci * rr;
                    sxx += cr * cr + ci * ci;
                }
                const meas = { re: sxyRe / sxx, im: sxyIm / sxx };
                const model = outer(interp(tf56, f0), f0);
                return {
                    f: f0,
                    measured: { mag: r3(cmag(meas)), deg: r3(deg(meas)) },
                    model: { mag: r3(cmag(model)), deg: r3(deg(model)) },
                };
            });
            const D = new Float64Array(2 * n);
            for (let q = 0; q < n; q++) {
                const fq = (Math.min(q, n - q) * fs) / n;
                const conj = q > n / 2;
                const d =
                    fq < 1 || fq > 200
                        ? { re: 0, im: 0 }
                        : (() => {
                              const h56 = outer(interp(tf56, fq), fq);
                              // No predicted bin (outside the plant's identified bins): no change there.
                              const t45 = interp(tf45, fq);
                              const h45 = outer(
                                  Number.isFinite(t45.re) && Number.isFinite(t45.im) ? t45 : interp(tf56, fq),
                                  fq,
                              );
                              const dh = { re: h45.re - h56.re, im: h45.im - h56.im };
                              return conj ? { re: dh.re, im: -dh.im } : dh;
                          })();
                const cq = { re: C[2 * q], im: C[2 * q + 1] };
                const v = cmul(d, cq);
                D[2 * q] = v.re;
                D[2 * q + 1] = v.im;
            }
            const dTime = new Float64Array(2 * n);
            ifft.simple(dTime, D);
            const rest45 = Float64Array.from(rest, (v, k) => v + dTime[2 * k] / n);
            const relaxCfg = itermRelaxConfigFromHeaders(h, 0, ctl.cfg.pidDt).config!;
            const factorOf = (setpoint: ArrayLike<number>) => {
                // The factor only (pid.c applyItermRelax): the same PT1 and threshold as the module.
                const k1 =
                    (2 * Math.PI * relaxCfg.cutoffHz * ctl.cfg.pidDt) /
                    (2 * Math.PI * relaxCfg.cutoffHz * ctl.cfg.pidDt + 1);
                let lpf = setpoint[0];
                let sum = 0;
                for (let k = 0; k < setpoint.length; k++) {
                    lpf += k1 * (setpoint[k] - lpf);
                    const angle = (Number(base.channels.rcModeMask![s + k]) & 2) !== 0;
                    sum += Math.max(0, 1 - Math.abs(setpoint[k] - lpf) / (40 * (angle ? 0.2 : 1)));
                }
                return sum / setpoint.length;
            };
            const logged = itermRelaxInForce(
                {
                    setpoint: sp,
                    gyro: base.channels.gyroAdc[0],
                    loggedI: j.axisI![0],
                    loggedP: j.axisP![0],
                    modeMask: base.channels.rcModeMask!,
                    start: s,
                    end: e,
                },
                relaxCfg,
                0,
            );
            const mix = (k: number) => Float64Array.from(chirp, (v, q) => v + k * rest[q]);
            const rmsOf = (a: ArrayLike<number>) => Math.sqrt(Array.from(a).reduce((x, v) => x + v * v, 0) / a.length);
            out.A = {
                angleGain: ka,
                rms: {
                    setpoint: r3(rmsOf(Array.from({ length: n }, (_, k) => sp[s + k]))),
                    chirp: r3(rmsOf(chirp)),
                    rest: r3(rmsOf(rest)),
                    restChangeAtP45: r3(
                        rmsOf(
                            Float64Array.from(
                                dTime.filter((_, i) => i % 2 === 0),
                                (v) => v / n,
                            ),
                        ),
                    ),
                },
                outerLoopModelCheck: modelCheck,
                factor: {
                    loggedValidated: r3(logged.meanFactor),
                    recomputedFromLoggedSetpoint: r3(factorOf(Array.from({ length: n }, (_, k) => sp[s + k]))),
                    chirpOnly: r3(factorOf(chirp)),
                    restTimes0_5: r3(factorOf(mix(0.5))),
                    restTimes1_5: r3(factorOf(mix(1.5))),
                    predictedP45: r3(factorOf(Float64Array.from(chirp, (v, q) => v + rest45[q]))),
                },
            };
        }

        // --- B. relax factor error → predicted T and verdict ------------------------------------
        {
            const fFlight = ctl.cfg;
            const modelF = ctl.itermRelax.meanFactor;
            const factors = [0, 0.03, 0.061, modelF, 0.15, 0.2, 0.3, 0.5, 1];
            const repT = logs.nov06.chirp.roll!.tf;
            const predModel = predictedTf(loop, cand45, tf56.numSegments);
            const rows = [];
            for (const fb of [0.061, modelF, 0.2]) {
                // "Truth": the plant extracted with factor fb, the candidate run with factor fc.
                const truthLoop = buildAxisLoop(0, tf56, fFlight, null, false, false, null, {
                    sweepCfg: withFactor(ctl.cfg, fFlight, fb),
                });
                for (const fc of factors) {
                    const truthT = predictedTf(
                        truthLoop,
                        withFactor(scaled(ctl.cfg, P45), scaled(fFlight, P45), fc),
                        tf56.numSegments,
                    );
                    let maxDb = 0;
                    let maxDeg = 0;
                    let maxDbLow = 0;
                    let maxDegLow = 0;
                    for (let k = 0; k < truthT.frequencies.length; k++) {
                        const f = truthT.frequencies[k];
                        if (
                            f > VALIDATION_MAX_HZ ||
                            !Number.isFinite(truthT.hReal[k]) ||
                            !Number.isFinite(predModel.hReal[k])
                        )
                            continue;
                        const a = { re: truthT.hReal[k], im: truthT.hImag[k] };
                        const b = { re: predModel.hReal[k], im: predModel.hImag[k] };
                        const ddb = Math.abs(db(a) - db(b));
                        const dd = Math.abs(dphase(a, b));
                        if (f < 20) {
                            maxDbLow = Math.max(maxDbLow, ddb);
                            maxDegLow = Math.max(maxDegLow, dd);
                        } else {
                            maxDb = Math.max(maxDb, ddb);
                            maxDeg = Math.max(maxDeg, dd);
                        }
                    }
                    const v = compareAxis("roll", {
                        plant: loop.plant,
                        baselineCfg: ctl.sweepCfg,
                        candidateCfg: cand45,
                        candidateT: truthT,
                        baselineRepeatT: repT,
                    });
                    rows.push({
                        baselineFactor: r3(fb),
                        candidateFactor: r3(fc),
                        maxDeviationBelow20Hz: { db: r3(maxDbLow), deg: r3(maxDegLow) },
                        maxDeviation20to40Hz: { db: r3(maxDb), deg: r3(maxDeg) },
                        verdict: v.verdict,
                        withinShare: r3(v.withinShare),
                        maxExcess: r3(v.maxExcess),
                        loopWithinShare: r3(v.loopWithinShare),
                        loopMaxExcess: r3(v.loopMaxExcess),
                        detectable: v.detectableBins,
                    });
                }
            }
            out.B = { modelFactor: r3(modelF), rows };
        }

        // --- C. spread, tolerance, predicted change, null comparisons -----------------------------
        {
            const rep = logs.nov06.chirp.roll!.tf;
            const rep2 = logs.nov06b.chirp.roll!.tf;
            const pred = predictedTf(loop, cand45, tf56.numSegments);
            const bins = [];
            for (const b of loop.plant.bins) {
                const f = b.frequencyHz;
                if (f > VALIDATION_MAX_HZ || !b.T || b.status !== "ok") continue;
                const a6 = at(rep, f);
                const a11 = at(rep2, f);
                const k = Array.from(pred.frequencies).indexOf(f);
                const p = { re: pred.hReal[k], im: pred.hImag[k] };
                const floor = toleranceFloor(f);
                const s6 = a6 ? { db: Math.abs(db(a6.T) - db(b.T)), deg: Math.abs(dphase(a6.T, b.T)) } : null;
                const tol = s6
                    ? { db: Math.max(floor.magDb, 2 * s6.db), deg: Math.max(floor.phaseDeg, 2 * s6.deg) }
                    : null;
                const capped = tol
                    ? tol.db > MAX_REPEAT_TOLERANCE_FACTOR * floor.magDb ||
                      tol.deg > MAX_REPEAT_TOLERANCE_FACTOR * floor.phaseDeg
                    : null;
                const change = { db: db(p) - db(b.T), deg: dphase(p, b.T) };
                bins.push({
                    f: r3(f),
                    coherence: { nov05: r3(b.coherence), nov06: r3(a6?.coh), n011849: r3(a11?.coh) },
                    spread: {
                        nov06MinusNov05: s6 && { db: r3(db(a6!.T) - db(b.T)), deg: r3(dphase(a6!.T, b.T)) },
                        n011849MinusNov05: a11 && { db: r3(db(a11.T) - db(b.T)), deg: r3(dphase(a11.T, b.T)) },
                    },
                    floor,
                    appTolerance: tol && { db: r3(tol.db), deg: r3(tol.deg), capped },
                    predictedChange: { db: r3(change.db), deg: r3(change.deg) },
                    detectable: tol ? Math.abs(change.db) > tol.db || Math.abs(change.deg) > tol.deg : null,
                    inLoopBand: (() => {
                        const L = cmul(b.G!, evaluateControllerFrf(scaled(ctl.cfg, P45), f).cFeedback);
                        return cmag(L) >= 0.25 && cmag(L) <= 4;
                    })(),
                });
            }
            // Null comparisons: the unchanged tune flown again, read as a "candidate" with the same PIDs.
            const nullCmp = (cand: TransferFunction, repeat?: TransferFunction) =>
                compareAxis("roll", {
                    plant: loop.plant,
                    baselineCfg: ctl.sweepCfg,
                    candidateCfg: ctl.sweepCfg,
                    candidateT: cand,
                    ...(repeat ? { baselineRepeatT: repeat } : {}),
                });
            out.C = {
                bins,
                nullComparison: {
                    nov06AsCandidate_floorOnly: nullCmp(rep),
                    n011849AsCandidate_repeatNov06: nullCmp(rep2, rep),
                    n011849AsCandidate_floorOnly: nullCmp(rep2),
                },
                verdictPerfectPrediction: compareAxis("roll", {
                    plant: loop.plant,
                    baselineCfg: ctl.sweepCfg,
                    candidateCfg: cand45,
                    candidateT: pred,
                    baselineRepeatT: rep,
                }),
            };
        }

        // --- D. bins judged differently by the I-relax repair -------------------------------------
        {
            const rows = [];
            for (const [name, log] of Object.entries(logs)) {
                const lh = Object.fromEntries(log.headerPairs);
                for (const [ai, axis] of AXES.entries()) {
                    const c = log.chirp[axis];
                    if (!c) continue;
                    const lc = analyzeAxisController(log, lh, ai as 0 | 1 | 2, c, flightMask(log.channels.rcThrottle))!;
                    const m = { sweep: sweepFromHeaders(lh), analysis: c.analysis ?? null, support: c.support ?? null };
                    const old = buildAxisLoop(ai as 0 | 1 | 2, c.tf, lc.cfg, null, false, false, null, m);
                    const neu = buildAxisLoop(ai as 0 | 1 | 2, c.tf, lc.cfg, null, false, false, null, {
                        ...m,
                        sweepCfg: lc.sweepCfg,
                    });
                    const verdictOf = (l: AxisLoop, f: number) => {
                        const b = l.plant.bins.find((x) => x.frequencyHz === f)!;
                        if (b.status !== "ok" || !(b.coherence >= LOOP_MIN_COHERENCE))
                            return { status: `not_identified:${b.status}`, kEps: null };
                        if (l.support?.bins.get(f)?.verdict === "UNSUPPORTED")
                            return { status: "unsupported", kEps: null };
                        const e = l.uncertainty.relErr?.get(f);
                        const kEps = e === undefined ? null : UNCERTAINTY.coverage * e;
                        return {
                            status:
                                kEps !== null && kEps >= UNCERTAINTY.maxCoverageRelErr ? "dropped_uncertainty" : "kept",
                            kEps: r3(kEps),
                        };
                    };
                    for (const b of neu.plant.bins) {
                        const f = b.frequencyHz;
                        if (f < 2 || f > 130) continue;
                        const o = verdictOf(old, f);
                        const nn = verdictOf(neu, f);
                        if (o.status !== nn.status)
                            rows.push({
                                log: name,
                                axis,
                                f: r3(f),
                                old: o,
                                new: nn,
                                coherence: r3(b.coherence),
                                relax: { status: lc.itermRelax.status, factor: r3(lc.itermRelax.meanFactor) },
                            });
                    }
                }
            }
            out.D = rows;
        }

        const dir = process.env.GYROFLIGHT_TRACE_OUT;
        if (dir) {
            mkdirSync(dir, { recursive: true });
            writeFileSync(path.join(dir, "trial_basis.json"), JSON.stringify(out, null, 1));
        }
        expect(out.D).toBeDefined();
    }, 900_000);
});
