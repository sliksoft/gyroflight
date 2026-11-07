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
 * Feedforward weight per axis (plan V2-F).
 *
 * Betaflight 2026.6.2 adds F = Kf · setpoint speed (pid.c, rc.c) only on axes in acro: in
 * ANGLE mode the PID feedforward is forced to 0. So FF can only be judged from acro stick
 * data, never from a CHIRP or an ANGLE flight.
 *
 * With acro stick segments (M4 segmentation, ≥ MIN_STICK_FF_S) the measured setpoint → gyro
 * latency calibrates the model T_rc = (C_ref + C_ff)·G / (1 + C_fb·G), C_ff = Kf · s · H_rc
 * (rc smoothing PT3 at the logged feedforward cutoff), on the identified plant G. The weight
 * that brings the predicted latency closest to zero without lifting |T_rc| above
 * MAX_TRACKING_PEAK_DB in 2–20 Hz is proposed, PARTIAL until a stick flight with it confirms.
 */

import {
    cadd,
    cdiv,
    cmag,
    cmul,
    cphaseDeg,
    evaluateControllerFrf,
    FEEDFORWARD_SCALE,
    type Complex,
} from "@/js/blackbox/betaflight_digital_controller";
import { MIN_STICK_FF_S } from "@/js/blackbox/flight_metrics_analysis";
import type { AxisLoop } from "./loopModel";

export const MAX_TRACKING_PEAK_DB = 1;
const LATENCY_BAND_HZ: [number, number] = [2, 8];

export interface FeedforwardInput {
    loop: AxisLoop | null;
    currentF: number;
    /** Acro stick time outside CHIRP (M4 segmentation `stick`, self-level excluded). */
    acroStickSeconds: number;
    /** M4 setpoint → gyro latency on those segments; null when not measured. */
    measuredLatencyMs: number | null;
    /** rc_smoothing feedforward cutoff in force (Hz); 0 / null: unknown. */
    rcFeedforwardCutoffHz: number | null;
}

export interface FeedforwardProposal {
    axis: "roll" | "pitch" | "yaw";
    current: number;
    proposed: number;
    changed: boolean;
    predictedLatencyMs: { current: number | null; proposed: number | null };
    trackingPeakDb: number | null;
    status: "VALIDATED" | "PARTIAL" | "BLOCKED";
    reasons: string[];
}

function pt3(f: number, cutoff: number): Complex {
    if (!(cutoff > 0)) return { re: 1, im: 0 };
    // PT3 cutoff correction (filter.c pt3FilterGain: 1.961459177).
    const fc = cutoff * 1.961459177;
    const one = cdiv({ re: 1, im: 0 }, { re: 1, im: f / fc });
    return cmul(cmul(one, one), one);
}

function trackingT(loop: AxisLoop, F: number, f: number, ffCut: number): Complex | null {
    const b = loop.plant.bins.find((x) => x.status === "ok" && x.G && Math.abs(x.frequencyHz - f) < 1e-9);
    if (!b?.G) return null;
    const frf = evaluateControllerFrf(loop.cfg, f);
    const Kf = FEEDFORWARD_SCALE * (F * 0.01);
    const cff = cmul({ re: 0, im: 2 * Math.PI * f * Kf }, pt3(f, ffCut));
    return cdiv(cmul(cadd(frf.cReference, cff), b.G), cadd({ re: 1, im: 0 }, cmul(frf.cFeedback, b.G)));
}

function latencyMs(loop: AxisLoop, F: number, ffCut: number): number | null {
    const v: number[] = [];
    for (const b of loop.plant.bins) {
        if (b.status !== "ok" || b.frequencyHz < LATENCY_BAND_HZ[0] || b.frequencyHz > LATENCY_BAND_HZ[1]) continue;
        const T = trackingT(loop, F, b.frequencyHz, ffCut);
        if (T) v.push((-cphaseDeg(T) / (360 * b.frequencyHz)) * 1000);
    }
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function peakDb(loop: AxisLoop, F: number, ffCut: number): number | null {
    let p = -Infinity;
    for (const b of loop.plant.bins) {
        if (b.status !== "ok" || b.frequencyHz < 2 || b.frequencyHz > 20) continue;
        const T = trackingT(loop, F, b.frequencyHz, ffCut);
        if (T) p = Math.max(p, 20 * Math.log10(cmag(T)));
    }
    return Number.isFinite(p) ? p : null;
}

const NAMES = ["roll", "pitch", "yaw"] as const;

export function optimizeFeedforward(axis: 0 | 1 | 2, input: FeedforwardInput): FeedforwardProposal {
    const base = {
        axis: NAMES[axis],
        current: input.currentF,
        proposed: input.currentF,
        changed: false,
        predictedLatencyMs: { current: null, proposed: null },
        trackingPeakDb: null,
    };
    const reasons: string[] = [];
    if (input.acroStickSeconds < MIN_STICK_FF_S) {
        reasons.push(
            "angle_mode_and_chirp_carry_no_pid_feedforward",
            `acro_stick_data_${input.acroStickSeconds.toFixed(1)}s_below_${MIN_STICK_FF_S}s`,
            "required_measurement:acro_stick_flight",
        );
    }
    if (input.measuredLatencyMs === null) reasons.push("stick_latency_not_measured");
    if (!input.loop) reasons.push("no_identified_plant_for_axis", "required_measurement:chirp_on_this_axis");
    if (!(input.rcFeedforwardCutoffHz && input.rcFeedforwardCutoffHz > 0))
        reasons.push("rc_feedforward_cutoff_unknown");
    if (reasons.length) return { ...base, status: "BLOCKED", reasons };
    const loop = input.loop!;
    const cut = input.rcFeedforwardCutoffHz!;
    const cur = latencyMs(loop, input.currentF, cut);
    if (cur === null) return { ...base, status: "BLOCKED", reasons: ["latency_band_not_identified"] };
    const offset = input.measuredLatencyMs! - cur;
    let best = { F: input.currentF, lat: cur + offset, peak: peakDb(loop, input.currentF, cut) };
    for (let s = 0.5; s <= 2.0001; s += 0.1) {
        const F = Math.min(1000, Math.max(0, Math.round(input.currentF * s)));
        const lat = latencyMs(loop, F, cut);
        const peak = peakDb(loop, F, cut);
        if (lat === null || peak === null || peak > MAX_TRACKING_PEAK_DB) continue;
        if (Math.abs(lat + offset) < Math.abs(best.lat)) best = { F, lat: lat + offset, peak };
    }
    const changed = best.F !== input.currentF;
    return {
        ...base,
        proposed: best.F,
        changed,
        predictedLatencyMs: { current: cur + offset, proposed: best.lat },
        trackingPeakDb: best.peak,
        status: "PARTIAL",
        reasons: [
            "model_calibrated_on_measured_stick_latency",
            "rc_feedforward_averaging_jitter_boost_not_modelled",
            ...(changed ? ["required_measurement:ab_stick_flight_with_proposal"] : []),
        ],
    };
}
