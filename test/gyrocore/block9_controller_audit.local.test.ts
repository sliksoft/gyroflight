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
 * LOCAL audit (block 9, not a regression): the controller the engine models against the controller
 * the AIR65 actually ran, per sweep. The logged P, I and D are deterministic functions of logged
 * signals (pid.c: P = Kp·(setpoint − gyroADCf)·AG, I += Ki·dT·relax·e, D = Kd·dMax·TPA·d/dt of the
 * D-filtered gyro), so their response to the error and to the gyro over the sweep is the controller
 * in force, measured. Written as JSON to GYROFLIGHT_TRACE_OUT. Skipped without the private logs.
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
    controllerConfigFromHeaders,
    flightMask,
    runAutotuneV2,
} from "../../src/gyrocore/engine/autotuneV2";
import type { AutotuneLogInput } from "../../src/gyrocore/engine/autotuneV2";
import {
    welchPowerSpectrum,
    welchTransferFunction,
    type TransferFunction,
} from "../../src/js/blackbox/spectral_analysis";
import { FlightLog } from "../../src/blackbox-viewer/flightlog.js";
import { extractOptionalBlackboxChannels } from "../../src/js/blackbox/flight_metrics_analysis";
import {
    cadd,
    cdiv,
    cmag,
    cmul,
    csub,
    evaluateControllerFrf,
    type Complex,
    type DigitalControllerConfig,
} from "../../src/js/blackbox/betaflight_digital_controller";

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
const REPORT_HZ = [4, 6, 8, 10, 15, 20, 25, 30, 35, 40, 45, 50, 60, 70, 80, 100, 120];

const at = (tf: TransferFunction, k: number): Complex => ({ re: tf.hReal[k], im: tf.hImag[k] });
const deg = (z: Complex) => (Math.atan2(z.im, z.re) * 180) / Math.PI;
const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const r3 = (x: number | null | undefined) =>
    x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000;

function headerMap(pairs: readonly (readonly [string, string])[]): Record<string, string> {
    return Object.fromEntries(pairs.map(([k, v]) => [k, v]));
}

/** Crossover, PM, GM and the |S| peak read on a list of loop points (linear interpolation). */
function readMargins(pts: { f: number; L: Complex }[]) {
    const mag = pts.map((p) => cmag(p.L));
    const ph: number[] = [];
    for (let i = 0; i < pts.length; i++) {
        let d = deg(pts[i].L);
        if (i > 0) {
            while (d - ph[i - 1] > 180) d -= 360;
            while (d - ph[i - 1] < -180) d += 360;
        }
        ph.push(d);
    }
    let fc: number | null = null;
    let pm: number | null = null;
    for (let i = pts.length - 1; i > 0; i--) {
        if (mag[i - 1] >= 1 && mag[i] < 1) {
            const a = Math.log(mag[i - 1]);
            const b = Math.log(mag[i]);
            const t = a / (a - b);
            fc = pts[i - 1].f + t * (pts[i].f - pts[i - 1].f);
            pm = 180 + ph[i - 1] + t * (ph[i] - ph[i - 1]);
            break;
        }
    }
    let gm: number | null = null;
    for (let i = 1; i < pts.length; i++) {
        const a = ph[i - 1] + 180;
        const b = ph[i] + 180;
        if (fc !== null && pts[i].f < fc) continue;
        if (a > 0 && b <= 0) {
            const t = a / (a - b);
            const m = mag[i - 1] + t * (mag[i] - mag[i - 1]);
            gm = -20 * Math.log10(m);
            break;
        }
    }
    let s = -Infinity;
    for (const p of pts) s = Math.max(s, -20 * Math.log10(cmag(cadd({ re: 1, im: 0 }, p.L))));
    return {
        crossoverHz: r3(fc),
        phaseMarginDeg: r3(pm),
        gainMarginDb: r3(gm),
        sensitivityPeakDb: r3(s),
        points: pts.length,
    };
}

interface Extra {
    modes: Float64Array | null;
}

/** Margins of loops on the same bins, for candidates scaled from the logged P / I / D. */
const CANDIDATES: Record<string, [number, number, number][]> = {
    roll: [
        [1, 1, 1],
        [39 / 56, 55 / 79, 1],
        [22 / 56, 32 / 79, 35 / 30],
        [1, 1, 40 / 30],
        [0.8, 0.8, 1.3],
    ],
    pitch: [[1, 1, 1]],
    yaw: [[1, 1, 1]],
};

function auditAxis(log: AutotuneLogInput, axis: (typeof AXES)[number], extra: Extra) {
    const ai = AXES.indexOf(axis) as 0 | 1 | 2;
    const chirp = log.chirp[axis];
    if (!chirp) return null;
    const h = headerMap(log.headerPairs);
    const mask = flightMask(log.channels.rcThrottle);
    const base = controllerConfigFromHeaders(h, ai)!;
    const ctl = analyzeAxisController(log, h, ai, chirp, mask);
    const cfg: DigitalControllerConfig = ctl?.cfg ?? base;
    const j = log.channels.jio as unknown as Record<string, Float64Array[] | Float64Array | null>;
    const col = (name: string) => (j[name] as Float64Array[])[ai];
    const s = chirp.start;
    const e = chirp.end;
    const sp = col("setpoint").subarray(s, e);
    const y = (log.channels.gyroAdc[ai] as Float64Array).subarray(s, e);
    const P = col("axisP").subarray(s, e);
    const I = col("axisI").subarray(s, e);
    const F = col("axisF").subarray(s, e);
    const Dfull = (log.channels.axisD?.[ai] as Float64Array | null | undefined) ?? null;
    const D = Dfull ? Dfull.subarray(s, e) : new Float64Array(e - s);
    const err = Float64Array.from(sp, (v, k) => v - y[k]);
    const PI = Float64Array.from(P, (v, k) => v + I[k]);
    const fs = chirp.analysis?.sampleRateHz ?? log.sampleRateHz;
    const seg = chirp.analysis?.segmentSamples ?? 1024;
    const tf = chirp.tf;
    const Hp = welchTransferFunction(err, P, fs, seg, 0.5);
    const Hi = welchTransferFunction(err, I, fs, seg, 0.5);
    const Hpi = welchTransferFunction(err, PI, fs, seg, 0.5);
    const Hd = welchTransferFunction(y, D, fs, seg, 0.5);
    const Hf = welchTransferFunction(sp, F, fs, seg, 0.5);
    const T = welchTransferFunction(sp, y, fs, seg, 0.5);
    // Same grid check: the qualified tf and this Welch run share the frequencies.
    const sameGrid =
        tf.frequencies.length === T.frequencies.length &&
        tf.frequencies.every((f, k) => Math.abs(f - T.frequencies[k]) < 1e-9);
    const table = REPORT_HZ.map((f0) => {
        let k = 0;
        for (let i = 1; i < Hp.frequencies.length; i++)
            if (Math.abs(Hp.frequencies[i] - f0) < Math.abs(Hp.frequencies[k] - f0)) k = i;
        const f = Hp.frequencies[k];
        const m = evaluateControllerFrf(cfg, f);
        const mb = evaluateControllerFrf(base, f);
        const Cd = csub(m.cFeedback, m.cReference);
        const Cdb = csub(mb.cFeedback, mb.cReference);
        const hp = at(Hp, k);
        const hpi = at(Hpi, k);
        const hd = { re: -Hd.hReal[k], im: -Hd.hImag[k] }; // D/y = −Cd
        return {
            f: r3(f),
            P: { gainOverKp: r3(cmag(hp) / (0.032029 * base.axis.p)), phaseDeg: r3(deg(hp)), coh: r3(Hp.coherence[k]) },
            PI: {
                gainRatio: r3(cmag(hpi) / cmag(m.cReference)),
                phaseDiffDeg: r3(wrap(deg(hpi) - deg(m.cReference))),
                coh: r3(Hpi.coherence[k]),
            },
            I: {
                gainRatio: r3(cmag(at(Hi, k)) / cmag(csub(m.cReference, { re: 0.032029 * base.axis.p, im: 0 }))),
                coh: r3(Hi.coherence[k]),
            },
            D: Dfull
                ? {
                      gainRatioEffective: r3(cmag(hd) / cmag(Cd)),
                      phaseDiffEffectiveDeg: r3(wrap(deg(hd) - deg(Cd))),
                      gainRatioHeader: r3(cmag(hd) / cmag(Cdb)),
                      phaseDiffHeaderDeg: r3(wrap(deg(hd) - deg(Cdb))),
                      coh: r3(Hd.coherence[k]),
                  }
                : null,
            F: { gain: r3(cmag(at(Hf, k))), coh: r3(Hf.coherence[k]) },
            T: { coh: r3(T.coherence[k]) },
        };
    });
    // Loop on the qualified bins (γ² ≥ 0.8), three controllers: header, engine (effective D), measured.
    const loops = {
        header: [] as { f: number; L: Complex }[],
        engine: [] as { f: number; L: Complex }[],
        measured: [] as { f: number; L: Complex }[],
    };
    const Tq: Complex[] = [];
    const candLoops = { trueP: [] as { f: number; L: Complex }[][], engP: [] as { f: number; L: Complex }[][] };
    for (let k = 0; k < tf.frequencies.length; k++) {
        const f = tf.frequencies[k];
        if (f < 3 || f > 200 || !(tf.coherence[k] >= 0.8)) continue;
        if (!sameGrid) break;
        if (!(Hpi.coherence[k] >= 0.9) || (Dfull && cfg.axis.d > 0 && !(Hd.coherence[k] >= 0.9))) continue;
        const Tk = at(tf, k);
        const loopOf = (Cref: Complex, Cfb: Complex) => {
            const TC = cmul(Tk, Cfb);
            return cdiv(TC, csub(Cref, TC));
        };
        const mh = evaluateControllerFrf(base, f);
        const me = evaluateControllerFrf(cfg, f);
        loops.header.push({ f, L: loopOf(mh.cReference, mh.cFeedback) });
        loops.engine.push({ f, L: loopOf(me.cReference, me.cFeedback) });
        const CePI = at(Hpi, k);
        const Cd = Dfull && cfg.axis.d > 0 ? { re: -Hd.hReal[k], im: -Hd.hImag[k] } : { re: 0, im: 0 };
        loops.measured.push({ f, L: loopOf(CePI, cadd(CePI, Cd)) });
        Tq.push(Tk);
        // The plant with the controller that was in force (measured), closed with candidates of the
        // modelled controller (I active, as in normal flight), against the engine's extraction.
        const Gtrue = cdiv(Tk, csub(CePI, cmul(Tk, cadd(CePI, Cd))));
        const Geng = cdiv(Tk, csub(me.cReference, cmul(Tk, me.cFeedback)));
        for (const [ci, c] of CANDIDATES[axis].entries()) {
            const cc: DigitalControllerConfig = {
                ...cfg,
                axis: { ...cfg.axis, p: cfg.axis.p * c[0], i: cfg.axis.i * c[1], d: cfg.axis.d * c[2] },
            };
            const Cc = evaluateControllerFrf(cc, f).cFeedback;
            (candLoops.trueP[ci] ??= []).push({ f, L: cmul(Gtrue, Cc) });
            (candLoops.engP[ci] ??= []).push({ f, L: cmul(Geng, Cc) });
        }
    }
    const motors = log.channels.motors;
    const hm = headerMap(log.headerPairs);
    const mo = (hm.motorOutput ?? "").split(",").map(Number);
    let atMin = 0;
    let atMax = 0;
    let sumLimit = 0;
    let angle = 0;
    let horizon = 0;
    let modeN = 0;
    let chirpBox = 0;
    const lim = Number(hm[axis === "yaw" ? "pidsum_limit_yaw" : "pidsum_limit"] ?? NaN);
    for (let k = s; k < e; k++) {
        if (motors && mo.length === 2) {
            if (motors.some((m) => m[k] <= mo[0] + 1)) atMin++;
            if (motors.some((m) => m[k] >= mo[1] - 1)) atMax++;
        }
        const u = col("axisP")[k] + col("axisI")[k] + (Dfull ? Dfull[k] : 0) + col("axisF")[k];
        if (Math.abs(u) >= lim - 0.5) sumLimit++;
        // Logged "flightModeFlags" is rcModeActivationMask (blackbox.c): bit 1 BOXANGLE, 2 BOXHORIZON, 6 BOXCHIRP.
        const fm = extra.modes?.[k];
        if (fm !== undefined && Number.isFinite(fm)) {
            modeN++;
            if (fm & 2) angle++;
            if (fm & 4) horizon++;
            if (fm & 64) chirpBox++;
        }
    }
    let thr = 0;
    for (let k = s; k < e; k++) thr += log.channels.rcThrottle[k];
    const conditions = {
        motorOutput: mo,
        fractionMotorAtMin: r3(atMin / (e - s)),
        fractionMotorAtMax: r3(atMax / (e - s)),
        pidsumLimit: lim,
        fractionPidsumAtLimit: r3(sumLimit / (e - s)),
        meanRcThrottle: r3(thr / (e - s)),
        angleModeFraction: modeN ? r3(angle / modeN) : null,
        horizonModeFraction: modeN ? r3(horizon / modeN) : null,
        chirpBoxFraction: modeN ? r3(chirpBox / modeN) : null,
    };
    return {
        axis,
        conditions,
        candidates: CANDIDATES[axis].map((c, ci) => ({
            scale: c.map(r3),
            pid: [cfg.axis.p * c[0], cfg.axis.i * c[1], cfg.axis.d * c[2]].map(r3),
            plantFromMeasuredController: readMargins(candLoops.trueP[ci] ?? []),
            plantFromEngineModel: readMargins(candLoops.engP[ci] ?? []),
        })),
        window: [s, e],
        durationS: r3((log.channels.timeUs[e - 1] - log.channels.timeUs[s]) / 1e6),
        sampleRateHz: r3(fs),
        segmentSamples: seg,
        sameGrid,
        header: {
            p: base.axis.p,
            i: base.axis.i,
            d: base.axis.d,
            f: base.axis.f,
            dtermLpf1Hz: base.dtermLpf1Hz,
            dtermLpf2Hz: base.dtermLpf2Hz,
            pidDt: base.pidDt,
        },
        engine: {
            d: r3(cfg.axis.d),
            dtermLpf1Hz: r3(cfg.dtermLpf1Hz),
            dtermAccepted: ctl?.accepted ?? null,
            dtermNrmse: r3(ctl?.nrmse ?? null),
        },
        signals: {
            rmsSetpoint: r3(Math.sqrt(sp.reduce((a, v) => a + v * v, 0) / sp.length)),
            rmsI: r3(Math.sqrt(I.reduce((a, v) => a + v * v, 0) / I.length)),
            rmsF: r3(Math.sqrt(F.reduce((a, v) => a + v * v, 0) / F.length)),
            rmsP: r3(Math.sqrt(P.reduce((a, v) => a + v * v, 0) / P.length)),
            rmsD: r3(Math.sqrt(D.reduce((a, v) => a + v * v, 0) / D.length)),
        },
        table,
        margins: {
            header: readMargins(loops.header),
            engine: readMargins(loops.engine),
            measured: readMargins(loops.measured),
        },
        loopPoints: loops.measured.map((p, i) => ({
            f: r3(p.f),
            Lmeasured: { mag: r3(cmag(p.L)), phaseDeg: r3(deg(p.L)) },
            Lengine: { mag: r3(cmag(loops.engine[i].L)), phaseDeg: r3(deg(loops.engine[i].L)) },
            T: { magDb: r3(20 * Math.log10(cmag(Tq[i]))), phaseDeg: r3(deg(Tq[i])) },
        })),
    };
}

const nearest = (fr: ArrayLike<number>, f0: number) => {
    let k = 0;
    for (let i = 1; i < fr.length; i++) if (Math.abs(fr[i] - f0) < Math.abs(fr[k] - f0)) k = i;
    return k;
};

/**
 * Excitation path, outer-loop bias, gyro chain, coherence before the filters, headroom by frequency
 * and the iterm_relax in force (pid.c applyItermRelax) on one sweep.
 */
function pathAudit(
    log: AutotuneLogInput,
    axis: (typeof AXES)[number],
    modes: Float64Array | null,
    jx: { excitation: Float64Array | null; frequencyDeciHz: Float64Array | null },
) {
    const ai = AXES.indexOf(axis) as 0 | 1 | 2;
    const chirp = log.chirp[axis]!;
    const h = headerMap(log.headerPairs);
    const s = chirp.start;
    const e = chirp.end;
    const j = log.channels.jio as unknown as Record<string, Float64Array[] | null>;
    const spF = j.setpoint![ai];
    const yF = log.channels.gyroAdc[ai] as Float64Array;
    const yuF = (log.channels.gyroUnfilt?.[ai] as Float64Array | undefined) ?? null;
    const fs = chirp.analysis?.sampleRateHz ?? log.sampleRateHz;
    const seg = chirp.analysis?.segmentSamples ?? 1024;
    const base = controllerConfigFromHeaders(h, ai)!;
    const amp = Number(h[`chirp_amplitude_${axis}`] ?? NaN);
    const out: Record<string, unknown> = {};
    if (jx.excitation) {
        const exc = Float64Array.from(jx.excitation.subarray(s, e), (v) => v / 1000);
        const sp = spF.subarray(s, e);
        const y = yF.subarray(s, e);
        const He = welchTransferFunction(exc, sp, fs, seg, 0.5);
        const Hey = welchTransferFunction(exc, y, fs, seg, 0.5);
        const T = welchTransferFunction(sp, y, fs, seg, 0.5);
        out.excitation = REPORT_HZ.map((f0) => {
            const k = nearest(He.frequencies, f0);
            const f = He.frequencies[k];
            const model = evaluateControllerFrf(base, f).cExcitationShaping;
            const meas = at(He, k);
            const iv = cdiv(at(Hey, k), meas);
            const h1 = at(T, k);
            return {
                f: r3(f),
                spOverAmpPhaseComp: r3(cmag(meas) / (amp * cmag(model))),
                phaseDiffDeg: r3(wrap(deg(meas) - deg(model))),
                cohExcSp: r3(He.coherence[k]),
                ivOverH1: r3(cmag(iv) / cmag(h1)),
                ivMinusH1PhaseDeg: r3(wrap(deg(iv) - deg(h1))),
                cohExcY: r3(Hey.coherence[k]),
            };
        });
    }
    if (yuF) {
        const yu = yuF.subarray(s, e);
        const y = yF.subarray(s, e);
        const sp = spF.subarray(s, e);
        const Hc = welchTransferFunction(yu, y, fs, seg, 0.5);
        const Tu = welchTransferFunction(sp, yu, fs, seg, 0.5);
        const T = welchTransferFunction(sp, y, fs, seg, 0.5);
        out.chain = [10, 20, 25, 30, 40, 50, 60, 80, 95, 100, 105, 110, 120, 150].map((f0) => {
            const k = nearest(Hc.frequencies, f0);
            return {
                f: r3(Hc.frequencies[k]),
                chainGainDb: r3(20 * Math.log10(cmag(at(Hc, k)))),
                chainPhaseDeg: r3(deg(at(Hc, k))),
                chainCoh: r3(Hc.coherence[k]),
                cohSpToUnfilt: r3(Tu.coherence[k]),
                cohSpToFilt: r3(T.coherence[k]),
                TunfiltPhaseDeg: r3(deg(at(Tu, k))),
                TfiltPhaseDeg: r3(deg(at(T, k))),
            };
        });
    }
    // Headroom by the generator's own frequency (debug[2], deci-Hz).
    if (jx.frequencyDeciHz) {
        const bands = [2, 4, 8, 16, 32, 64, 128, 256];
        const motors = log.channels.motors;
        const mo = (h.motorOutput ?? "").split(",").map(Number);
        const lim = Number(h[axis === "yaw" ? "pidsum_limit_yaw" : "pidsum_limit"] ?? NaN);
        const D = (log.channels.axisD?.[ai] as Float64Array | null | undefined) ?? null;
        out.headroom = bands.slice(0, -1).map((lo, bi) => {
            const hi = bands[bi + 1];
            let n = 0;
            let maxU = 0;
            let maxP = 0;
            let atLim = 0;
            let minMotor = Infinity;
            let maxMotor = -Infinity;
            let atMin = 0;
            let maxSp = 0;
            const motorVals: number[] = [];
            const motorMeanByMotor: number[] = [];
            const uVals: number[] = [];
            for (let k = s; k < e; k++) {
                const f = jx.frequencyDeciHz![k] / 10;
                if (!(f >= lo && f < hi)) continue;
                n++;
                const u = j.axisP![ai][k] + j.axisI![ai][k] + (D ? D[k] : 0) + j.axisF![ai][k];
                maxU = Math.max(maxU, Math.abs(u));
                maxP = Math.max(maxP, Math.abs(j.axisP![ai][k]));
                maxSp = Math.max(maxSp, Math.abs(spF[k]));
                if (Math.abs(u) >= lim - 0.5) atLim++;
                uVals.push(Math.abs(u));
                if (motors) {
                    for (const m of motors) {
                        motorVals.push(m[k]);
                        minMotor = Math.min(minMotor, m[k]);
                        maxMotor = Math.max(maxMotor, m[k]);
                    }
                    if (mo.length === 2 && motors.some((m) => m[k] <= mo[0] + 1)) atMin++;
                }
            }
            motorVals.sort((a, b) => a - b);
            uVals.sort((a, b) => a - b);
            const q = (v: number[], x: number) =>
                v.length ? v[Math.min(v.length - 1, Math.floor(x * v.length))] : null;
            void motorMeanByMotor;
            return {
                band: [lo, hi],
                motorP001: q(motorVals, 0.001),
                motorP01: q(motorVals, 0.01),
                motorMedian: q(motorVals, 0.5),
                pidsumP999: q(uVals, 0.999),
                samples: n,
                maxAbsSetpoint: r3(maxSp),
                maxAbsPidsum: r3(maxU),
                maxAbsP: r3(maxP),
                samplesAtPidsumLimit: atLim,
                minMotor: Number.isFinite(minMotor) ? minMotor : null,
                maxMotor: Number.isFinite(maxMotor) ? maxMotor : null,
                samplesMotorAtMin: atMin,
            };
        });
    }
    // iterm_relax in force: firmware recurrence from the logged setpoint and gyro against logged axisI.
    if (axis !== "yaw" || h.iterm_relax === "2" || h.iterm_relax === "4") {
        const cutoff = Number(h.iterm_relax_cutoff ?? NaN);
        const dt = base.pidDt;
        const k1 = (2 * Math.PI * cutoff * dt) / (2 * Math.PI * cutoff * dt + 1);
        let lpf = spF[Math.max(0, s - 1)];
        // Warm the setpoint low-pass up over the second before the sweep.
        const warm = Math.max(0, s - Math.round(1 / dt));
        lpf = spF[warm];
        for (let k = warm; k < s; k++) lpf += k1 * (spF[k] - lpf);
        const Ki = 0.244381 * base.axis.i;
        const I = j.axisI![ai];
        let iSim = I[s];
        let iFull = I[s];
        let sumF = 0;
        let se = 0;
        let seFull = 0;
        let ss = 0;
        let mean = 0;
        for (let k = s; k < e; k++) mean += I[k];
        mean /= e - s;
        let frozen = 0;
        for (let k = s; k < e; k++) {
            lpf += k1 * (spF[k] - lpf);
            const hpf = Math.abs(spF[k] - lpf);
            const angleOn = modes ? (Number(modes[k]) & 2) !== 0 : true;
            const thr = 40 * (angleOn ? 0.2 : 1);
            const factor = Math.max(0, 1 - hpf / thr);
            if (factor === 0) frozen++;
            sumF += factor;
            const err = spF[k] - yF[k];
            iSim += Ki * dt * factor * err;
            iFull += Ki * dt * err;
            se += (iSim - I[k]) ** 2;
            seFull += (iFull - I[k]) ** 2;
            ss += (I[k] - mean) ** 2;
        }
        out.itermRelax = {
            cutoffHz: cutoff,
            meanFactor: r3(sumF / (e - s)),
            frozenFraction: r3(frozen / (e - s)),
            rmsErrorRelaxModel: r3(Math.sqrt(se / (e - s))),
            rmsErrorNoRelax: r3(Math.sqrt(seFull / (e - s))),
            rmsLoggedIAroundMean: r3(Math.sqrt(ss / (e - s))),
        };
    }
    return out;
}

/**
 * Gyro spectrum of each axis in flight outside the sweeps (debug[1] = −1, throttle ≥ 1100): the
 * disturbance response S·d. A sensitivity peak shows as a bump at its frequency whatever d is.
 */
function hoverSpectrum(log: AutotuneLogInput, modes: Float64Array | null) {
    const dbg = log.channels.jio?.debugAxis ?? null;
    const thr = log.channels.rcThrottle;
    const n = thr.length;
    const runs: [number, number][] = [];
    let st = -1;
    for (let k = 0; k <= n; k++) {
        const ok = k < n && thr[k] >= 1100 && (!dbg || dbg[k] === -1);
        if (ok && st < 0) st = k;
        if (!ok && st >= 0) {
            runs.push([st, k]);
            st = -1;
        }
    }
    const longest = runs.sort((a, b) => b[1] - b[0] - (a[1] - a[0]))[0];
    if (!longest || longest[1] - longest[0] < 8192) return null;
    const [a, b] = longest;
    let angle = 0;
    if (modes) for (let k = a; k < b; k++) if (Number(modes[k]) & 2) angle++;
    return {
        window: longest,
        seconds: r3((log.channels.timeUs[b - 1] - log.channels.timeUs[a]) / 1e6),
        angleModeFraction: modes ? r3(angle / (b - a)) : null,
        axes: AXES.map((ax, ai) => {
            const ps = welchPowerSpectrum(
                (log.channels.gyroAdc[ai] as Float64Array).subarray(a, b),
                log.sampleRateHz,
                1024,
                0.5,
            );
            if (!ps) return { axis: ax, psd: null };
            const pick = [5, 10, 15, 20, 25, 28, 30, 35, 40, 50, 60, 80, 100, 150].map((f0) => {
                let k = 0;
                for (let i = 1; i < ps.frequencies.length; i++)
                    if (Math.abs(ps.frequencies[i] - f0) < Math.abs(ps.frequencies[k] - f0)) k = i;
                return { f: r3(ps.frequencies[k]), db: r3(10 * Math.log10(ps.psd[k])) };
            });
            return { axis: ax, psd: pick };
        }),
    };
}

describe.skipIf(!present)("block 9: controller in force vs the engine's model (local)", () => {
    it("per file and axis", () => {
        const out: unknown[] = [];
        for (const f of FILES) {
            const bytes = new Uint8Array(readFileSync(process.env[f.env]!));
            const sha = createHash("sha256").update(bytes).digest("hex");
            expect(sha).toBe(f.sha256);
            const q = qualifyChirpFile(bytes, `${f.name}.bbl`, 45, AUTOTUNE_MATH);
            const logs = buildLogInputs(bytes, sha, q, analyzeM4BblFile(bytes, `${f.name}.bbl`));
            const fl = new FlightLog(bytes) as unknown as { openLog(i: number): boolean } & Parameters<
                typeof extractOptionalBlackboxChannels
            >[0];
            for (const log of logs) {
                fl.openLog(log.logIndex);
                const named = extractOptionalBlackboxChannels(fl, { fields: ["flightModeFlags", "time"] }).named;
                const ax0 = log.channels.jio as unknown as {
                    excitation: Float64Array | null;
                    frequencyDeciHz: Float64Array | null;
                };
                const modes =
                    named.flightModeFlags && named.flightModeFlags.length === log.channels.timeUs.length
                        ? named.flightModeFlags
                        : null;
                out.push({ file: f.name, logIndex: log.logIndex, hover: hoverSpectrum(log, modes) });
                const r = runAutotuneV2({
                    primary: log,
                    others: [],
                    verifiedTune: null,
                    createdAt: "2026-11-08T00:00:00Z",
                });
                for (const axis of AXES) {
                    const a = auditAxis(log, axis, { modes });
                    const pa = a ? pathAudit(log, axis, modes, ax0) : null;
                    if (!a) continue;
                    const m = r.margins[axis]?.current;
                    out.push({
                        file: f.name,
                        logIndex: log.logIndex,
                        state: log.chirp[axis]!.state,
                        engineMargins: m ? { crossoverHz: r3(m.crossoverHz), measured: m.measured } : null,
                        ...a,
                        path: pa,
                    });
                }
            }
        }
        const dir = process.env.GYROFLIGHT_TRACE_OUT;
        if (dir) {
            mkdirSync(dir, { recursive: true });
            writeFileSync(path.join(dir, "controller_audit.json"), JSON.stringify(out, null, 1));
        }
        expect(out.length).toBeGreaterThan(0);
    }, 900_000);
});
