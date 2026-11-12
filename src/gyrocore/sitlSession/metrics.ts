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
 * What the AutoTune session measures in one SITL run's Blackbox log besides the margins (block 14, session_v1):
 *
 *  - the step block: per axis tracking (RMS error / RMS setpoint), overshoot (largest excess beyond the new value as a
 *    share of the step), rise r90 (mean ms to 90 % of each step) and oscillation (peak-to-peak error from 60 ms after
 *    each edge, share of the step) — the definitions of the roll-demo loop (simRollAutotune manoeuvreMetrics), applied
 *    to each doublet of the block;
 *  - the per-motor band power 100–500 Hz in steady hover: every motor above 1001 for at least 1 s, outside every active
 *    CHIRP ± 0.5 s and outside the step block (with its acro lead and tail) ± 0.5 s; per contiguous run, weighted by its
 *    Welch segments (maskedBandPower). Motor clip: share of those samples with any motor ≥ 2000 or ≤ 1000.
 *
 * The block is found in the log itself: the first sample after the last active CHIRP at which |setpoint| of the
 * block's first axis exceeds half the amplitude, walked back to its edge; the doublets follow at the schedule's tick
 * offsets (sampleRateHz / 100 samples per 10 ms tick).
 */

import { manoeuvreMetrics, type Thresholds } from "@/gyrocore/tuning/simRollAutotune";
import { maskedBandPower } from "@/gyrocore/engine/filterOptimizer";
import type { AutotuneLogInput } from "@/gyrocore/engine/autotuneV2";
import { SESSION_PROTOCOL, type SessionAxis } from "./protocol";

export interface StepMetrics {
    trackingRel: number;
    overshoot: number;
    riseMs: number;
    oscillation: number;
}

export interface RunMetrics {
    steps: Partial<Record<SessionAxis, StepMetrics>>;
    motors: { bandPower: (number | null)[]; hoverSamples: number; clip: number | null } | null;
    blockStartSample: number | null;
    /** The step block with its acro lead and tail, ± the CHIRP guard, as samples [start, end): not steady hover. */
    blockExclusion: [number, number] | null;
    issues: string[];
}

/** Only the definitions are used (settleDelayMs and the motor limits); the roll-demo thresholds are not. */
const STEP_DEFS: Thresholds = {
    minRelativeGain: 0,
    trackingTolerance: 0,
    overshootToleranceAbs: 0,
    riseTolerance: 0,
    riseToleranceMs: 0,
    oscillationMax: 0,
    settleDelayMs: 60,
    saturationShareMax: 0,
    motorHigh: 2000,
    motorLow: 1000,
    maxAbsRollDeg: 0,
    minZ: 0,
};

/** The schedule's step block (the doublets in order), as scripts/sim/session/schedule.py builds it. */
export function stepBlockLayout(): { axis: SessionAxis; offsetTicks: number; lengthTicks: number }[] {
    const m = SESSION_PROTOCOL.measurement;
    const len = 2 * m.stepHalfTicks + m.stepGapTicks;
    const out: { axis: SessionAxis; offsetTicks: number; lengthTicks: number }[] = [];
    let t = 0;
    for (const axis of SESSION_PROTOCOL.axes)
        for (let s = 0; s < 2; s++) {
            out.push({ axis, offsetTicks: t, lengthTicks: len });
            t += len;
        }
    return out;
}

function chirpActive(log: AutotuneLogInput): Uint8Array | null {
    const ax = log.channels.jio?.debugAxis;
    const fq = log.channels.jio?.frequencyDeciHz;
    if (!ax || !fq) return null;
    const n = log.channels.timeUs.length;
    const out = new Uint8Array(n);
    for (let k = 0; k < n; k++) out[k] = Number(ax[k]) >= 0 && Number(fq[k]) > 0 ? 1 : 0;
    return out;
}

export function runMetrics(log: AutotuneLogInput): RunMetrics {
    const issues: string[] = [];
    const n = log.channels.timeUs.length;
    const fs = log.sampleRateHz;
    const sp = log.channels.jio?.setpoint ?? null;
    const gy = log.channels.gyroAdc;
    const act = chirpActive(log);
    const m = SESSION_PROTOCOL.measurement;
    const perTick = Math.round(fs / 100);
    const steps: RunMetrics["steps"] = {};
    let block: number | null = null;
    if (!sp) issues.push("setpoint_not_logged");
    if (!act) issues.push("chirp_debug_not_logged");
    if (sp && act) {
        let last = -1;
        for (let k = 0; k < n; k++) if (act[k]) last = k;
        const amp = m.stepAmplitudeDps;
        const layout = stepBlockLayout();
        const first = SESSION_PROTOCOL.axes.indexOf(layout[0].axis);
        for (let k = Math.max(0, last + 1); k < n; k++)
            if (Math.abs(Number(sp[first][k])) > 0.5 * amp) {
                block = k;
                break;
            }
        if (block === null) issues.push("step_block_not_found");
        else {
            while (block > 0 && Math.abs(Number(sp[first][block - 1])) > 0.05 * amp) block--;
            for (const axis of SESSION_PROTOCOL.axes) {
                const ai = SESSION_PROTOCOL.axes.indexOf(axis);
                const spCat: number[] = [];
                const gyCat: number[] = [];
                let over = 0;
                let osc = 0;
                const rises: number[] = [];
                for (const d of layout.filter((x) => x.axis === axis)) {
                    const k0 = block + d.offsetTicks * perTick;
                    const k1 = Math.min(n, block + (d.offsetTicks + d.lengthTicks) * perTick);
                    if (k0 < 1 || k1 <= k0) {
                        issues.push(`step_window_outside_log:${axis}`);
                        continue;
                    }
                    // One sample before the window, so its first edge is seen (manoeuvreMetrics reads edges from k = 1).
                    const s = Array.from({ length: k1 - k0 + 1 }, (_, j) => Number(sp[ai][k0 - 1 + j]));
                    const g = Array.from({ length: k1 - k0 + 1 }, (_, j) => Number(gy[ai][k0 - 1 + j]));
                    const r = manoeuvreMetrics(`${axis}`, s, g, [], 1 / fs, STEP_DEFS);
                    over = Math.max(over, r.overshoot);
                    osc = Math.max(osc, r.oscillation);
                    rises.push(r.riseMs);
                    spCat.push(...s.slice(1));
                    gyCat.push(...g.slice(1));
                }
                if (!spCat.length) continue;
                let e2 = 0;
                let s2 = 0;
                for (let k = 0; k < spCat.length; k++) {
                    e2 += (gyCat[k] - spCat[k]) ** 2;
                    s2 += spCat[k] ** 2;
                }
                steps[axis] = {
                    trackingRel: Math.sqrt(e2 / spCat.length) / Math.max(Math.sqrt(s2 / spCat.length), 1e-9),
                    overshoot: over,
                    riseMs: rises.reduce((a, b) => a + b, 0) / rises.length,
                    oscillation: osc,
                };
            }
        }
    }
    // Hover samples for the per-motor band power.
    const mot = log.channels.motors;
    let motors: RunMetrics["motors"] = null;
    let blockExclusion: [number, number] | null = null;
    if (!mot || mot.length !== 4) issues.push("four_motors_not_logged");
    else {
        const tS = (k: number) => (Number(log.channels.timeUs[k]) - Number(log.channels.timeUs[0])) * 1e-6;
        const ok = new Uint8Array(n);
        let runStart: number | null = null;
        for (let k = 0; k < n; k++) {
            const armed = mot.every((x) => Number(x[k]) > 1001);
            if (armed) {
                if (runStart === null) runStart = tS(k);
                ok[k] = tS(k) - runStart >= m.hoverMinRunS ? 1 : 0;
            } else runStart = null;
        }
        const cut = (a: number, b: number) => {
            for (let k = 0; k < n; k++) if (tS(k) >= a && tS(k) <= b) ok[k] = 0;
        };
        if (act) {
            let k = 0;
            while (k < n) {
                if (!act[k]) {
                    k++;
                    continue;
                }
                const a = k;
                while (k < n && act[k]) k++;
                cut(tS(a) - m.chirpGuardS, tS(k - 1) + m.chirpGuardS);
            }
        }
        if (block !== null) {
            const layout = stepBlockLayout();
            const end = layout[layout.length - 1];
            const blen = ((end.offsetTicks + end.lengthTicks) * perTick) / fs;
            const t0 = tS(block);
            const a = t0 - m.acroLeadS - m.chirpGuardS;
            const b = t0 + blen + m.acroTailS + m.chirpGuardS;
            cut(a, b);
            let ka = 0;
            while (ka < n && tS(ka) < a) ka++;
            let kb = ka;
            while (kb < n && tS(kb) <= b) kb++;
            blockExclusion = [ka, kb];
        }
        let hover = 0;
        let clipped = 0;
        for (let k = 0; k < n; k++)
            if (ok[k]) {
                hover++;
                if (mot.some((x) => Number(x[k]) >= 2000 || Number(x[k]) <= 1000)) clipped++;
            }
        const all = new Uint8Array(n).fill(1);
        motors = {
            bandPower: mot.map((x) => maskedBandPower(x, all, ok, fs)),
            hoverSamples: hover,
            clip: hover ? clipped / hover : null,
        };
    }
    return { steps, motors, blockStartSample: block, blockExclusion, issues };
}
