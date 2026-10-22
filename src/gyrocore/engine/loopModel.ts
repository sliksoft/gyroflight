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
 * Loop model for one axis (plan V2-C / V2-D): margins of the current and of a candidate tune.
 *
 * The CHIRP T is measured on gyroADCf, so the plant G = T / (C_ref − T·C_fb) identified by
 * M3 already contains the gyro filter chain as it behaved during the sweep. A candidate
 * changes the controller (C_fb) and/or the chain; with the notch-aware chain model the loop
 * becomes
 *
 *     L_candidate(f) = G(f) · H_chain,candidate(f) / H_chain,current(f) · C_fb,candidate(f)
 *
 * where both chain responses are the mean response over the same sweep window, simulated
 * with the logged eRPM / throttle (gyroChain.ts). Margins are read on the identified,
 * coherent bins only; anything outside them is reported as unknown, never extrapolated.
 *
 * A margin is VALIDATED only when the chain model reproduced this log's gyroADC
 * (validateChain), the chain barely moved at the crossover during the sweep, the crossover
 * lies inside the identified band, and a Verified Tune for this craft attests the
 * prediction method (verifiedTune.ts). The model alone never validates.
 */

import {
    cadd,
    cdiv,
    cmag,
    cmul,
    cphaseDeg,
    evaluateControllerFrf,
    type Complex,
    type DigitalControllerConfig,
} from "@/js/blackbox/betaflight_digital_controller";
import { extractPlantFromClosedLoop, type IdentifiedPlant } from "@/js/blackbox/betaflight_open_loop";
import { fitDterm, type DtermFit } from "@/js/blackbox/betaflight_dterm_dynamic";
import type { TransferFunction } from "@/js/blackbox/spectral_analysis";
import type { ChainSimulation, EffectiveChain } from "./gyroChain";

/** Chain reproduces gyroADC: control band tight (decides PM), noise band looser (filter advice). */
export const CHAIN_ACCEPT = Object.freeze({
    controlBands: [
        [2, 20],
        [20, 80],
    ] as [number, number][],
    maxGainError: 0.05,
    maxPhaseDeg: 3,
    minCoherence: 0.9,
    noiseBands: [
        [80, 200],
        [200, 500],
    ] as [number, number][],
    noiseMaxGainError: 0.1,
    noiseMinCoherence: 0.8,
    /** The full chain must beat the chain without RPM and dynamic notch by this factor (NRMSE). */
    minAblationGain: 2,
});

/** Largest chain phase spread at the crossover over the sweep for an LTI stand-in to hold. */
export const MAX_CHAIN_SPREAD_DEG = 5;
/** Plant bins used for margins. */
export const LOOP_MIN_COHERENCE = 0.8;

export interface ChainValidation {
    axis: number;
    fit: DtermFit | null;
    ablationNrmse: number | null;
    controlBand: "PASS" | "FAIL" | "INSUFFICIENT";
    noiseBand: "PASS" | "FAIL" | "INSUFFICIENT";
    reasons: string[];
}

/**
 * Every required band must be measured with enough coherence: a band that is missing or
 * incoherent is unsupported (INSUFFICIENT), never left out. A supported band that misses the
 * gain / phase limits fails the whole set.
 */
function bandsOk(fit: DtermFit, bands: [number, number][], maxGain: number, maxPhase: number, minCoh: number) {
    const unsupported: string[] = [];
    let failed = false;
    for (const [lo, hi] of bands) {
        const b = fit.bands.find((x) => x.loHz === lo && x.hiHz === hi);
        if (!b || !((b.coherence ?? 0) >= minCoh)) {
            unsupported.push(`${lo}-${hi}Hz`);
            continue;
        }
        if (!(Math.abs((b.gainRatio ?? Infinity) - 1) <= maxGain && Math.abs(b.phaseDeg ?? Infinity) <= maxPhase)) {
            failed = true;
        }
    }
    const status = failed ? ("FAIL" as const) : unsupported.length ? ("INSUFFICIENT" as const) : ("PASS" as const);
    return { status, unsupported };
}

/** The frequency range a PASS of the control bands covers; margins outside it are not backed by the chain. */
export const CHAIN_VALIDATED_BAND_HZ: readonly [number, number] = [
    CHAIN_ACCEPT.controlBands[0][0],
    CHAIN_ACCEPT.controlBands[CHAIN_ACCEPT.controlBands.length - 1][1],
];

/**
 * Compare the simulated chain with the logged gyroADC of one axis over `mask` (in-flight
 * samples). `ablation` is the same simulation without RPM filter and dynamic notch.
 */
export function validateChain(
    axis: number,
    sim: ChainSimulation,
    ablation: ChainSimulation | null,
    loggedGyroAdc: ArrayLike<number>,
    sampleRateHz: number,
    mask: Uint8Array,
): ChainValidation {
    const valid = sim.valid.map((v, k) => (v && mask[k] ? 1 : 0));
    const bands = [...CHAIN_ACCEPT.controlBands, ...CHAIN_ACCEPT.noiseBands];
    const fit = fitDterm({ d: sim.out[axis], valid } as never, loggedGyroAdc, sampleRateHz, 1024, bands);
    const reasons: string[] = [...sim.notes];
    if (!fit) {
        return {
            axis,
            fit,
            ablationNrmse: null,
            controlBand: "INSUFFICIENT",
            noiseBand: "INSUFFICIENT",
            reasons: [...reasons, "chain_fit_insufficient_data"],
        };
    }
    const control = bandsOk(
        fit,
        CHAIN_ACCEPT.controlBands,
        CHAIN_ACCEPT.maxGainError,
        CHAIN_ACCEPT.maxPhaseDeg,
        CHAIN_ACCEPT.minCoherence,
    );
    let controlBand = control.status;
    reasons.push(...control.unsupported.map((b) => `chain_band_unsupported:${b}`));
    const noiseBand = bandsOk(
        fit,
        CHAIN_ACCEPT.noiseBands,
        CHAIN_ACCEPT.noiseMaxGainError,
        10,
        CHAIN_ACCEPT.noiseMinCoherence,
    ).status;
    let ablationNrmse: number | null = null;
    if (ablation) {
        const abValid = ablation.valid.map((v, k) => (v && mask[k] ? 1 : 0));
        ablationNrmse =
            fitDterm({ d: ablation.out[axis], valid: abValid } as never, loggedGyroAdc, sampleRateHz, 1024, bands)
                ?.nrmse ?? null;
        if (
            ablationNrmse !== null &&
            !(ablationNrmse > 0 && fit.nrmse * CHAIN_ACCEPT.minAblationGain <= ablationNrmse)
        ) {
            reasons.push("chain_notches_not_shown_to_matter");
            if (controlBand === "PASS") controlBand = "FAIL";
        }
    }
    if (controlBand !== "PASS") reasons.push(`chain_control_band_${controlBand.toLowerCase()}`);
    if (noiseBand !== "PASS") reasons.push(`chain_noise_band_${noiseBand.toLowerCase()}`);
    return { axis, fit, ablationNrmse, controlBand, noiseBand, reasons };
}

export interface AxisLoop {
    axis: 0 | 1 | 2;
    plant: IdentifiedPlant;
    cfg: DigitalControllerConfig;
    chain: EffectiveChain | null;
    chainValidated: boolean;
    /** A Verified Tune for this craft / firmware passed (the only attestation). */
    attested: boolean;
}

export interface LoopCandidate {
    cfg: DigitalControllerConfig;
    /** Mean chain response of the candidate's gyro filters over the same window; null: unchanged. */
    chain?: EffectiveChain | null;
}

export interface LoopMargins {
    status: "VALIDATED" | "NOT_VALIDATED" | "UNAVAILABLE";
    crossoverHz: number | null;
    phaseMarginDeg: number | null;
    gainMarginDb: number | null;
    sensitivityPeakDb: number | null;
    delayMarginMs: number | null;
    /** Chain phase spread at the crossover over the sweep (°). */
    chainSpreadDeg: number | null;
    okBins: number;
    reasons: string[];
}

/** Plant from the CHIRP T and the controller in force during the sweep. */
export function buildAxisLoop(
    axis: 0 | 1 | 2,
    tf: TransferFunction,
    cfg: DigitalControllerConfig,
    chain: EffectiveChain | null,
    chainValidated: boolean,
    attested: boolean,
): AxisLoop {
    const missing = chainValidated ? [] : ["dyn_notch_centres_unknown", "rpm_filter_schedule_unknown"];
    const plant = extractPlantFromClosedLoop(tf, cfg, { missingFilterInfo: missing, coherenceMin: LOOP_MIN_COHERENCE });
    return { axis, plant, cfg, chain, chainValidated, attested };
}

function unwrap(phases: number[]): number[] {
    const out: number[] = [];
    let offset = 0;
    for (let i = 0; i < phases.length; i++) {
        if (i > 0) {
            const d = phases[i] + offset - out[i - 1];
            if (d > 180) offset -= 360;
            else if (d < -180) offset += 360;
        }
        out.push(phases[i] + offset);
    }
    return out;
}

/** Loop response of a candidate on the identified bins. */
export function candidateLoop(loop: AxisLoop, cand: LoopCandidate): { f: number; L: Complex }[] {
    const out: { f: number; L: Complex }[] = [];
    for (const b of loop.plant.bins) {
        if (b.status !== "ok" || !b.G || !(b.coherence >= LOOP_MIN_COHERENCE)) continue;
        let G = b.G;
        if (cand.chain && loop.chain) {
            G = cmul(G, cdiv(cand.chain.frf(b.frequencyHz), loop.chain.frf(b.frequencyHz)));
        }
        out.push({ f: b.frequencyHz, L: cmul(G, evaluateControllerFrf(cand.cfg, b.frequencyHz).cFeedback) });
    }
    return out;
}

export function loopMargins(loop: AxisLoop, cand: LoopCandidate = { cfg: loop.cfg }): LoopMargins {
    const pts = candidateLoop(loop, cand);
    const reasons: string[] = [];
    const empty: LoopMargins = {
        status: "UNAVAILABLE",
        crossoverHz: null,
        phaseMarginDeg: null,
        gainMarginDb: null,
        sensitivityPeakDb: null,
        delayMarginMs: null,
        chainSpreadDeg: null,
        okBins: pts.length,
        reasons,
    };
    if (pts.length < 4) {
        reasons.push("too_few_identified_bins");
        return empty;
    }
    const mag = pts.map((p) => cmag(p.L));
    const ph = unwrap(pts.map((p) => cphaseDeg(p.L)));
    // Bins must be contiguous for unwrapping and crossings to mean anything.
    const gaps = pts.some((p, i) => i > 0 && p.f - pts[i - 1].f > 3 * (pts[1].f - pts[0].f));
    if (gaps) reasons.push("identified_band_has_gaps");

    // Unity crossings in both directions: a resonance can lift |L| above one again after the
    // first crossover, and every crossing then has its own phase margin.
    const crossings: { i: number; down: boolean }[] = [];
    for (let i = 1; i < pts.length; i++) {
        if (mag[i - 1] >= 1 && mag[i] < 1) crossings.push({ i, down: true });
        else if (mag[i - 1] < 1 && mag[i] >= 1) crossings.push({ i, down: false });
    }
    const lastBin = pts.length - 1;
    if (!crossings.some((c) => c.down)) {
        reasons.push(mag[0] < 1 ? "loop_gain_below_one_in_band" : "crossover_outside_identified_band");
        return { ...empty, status: "NOT_VALIDATED" };
    }
    if (crossings.length > 1) reasons.push(`ambiguous_crossovers:${crossings.length}`);
    const at = (c: { i: number }) => {
        const i = c.i;
        const t = (0 - 20 * Math.log10(mag[i - 1])) / (20 * Math.log10(mag[i]) - 20 * Math.log10(mag[i - 1]));
        return { f: pts[i - 1].f + t * (pts[i].f - pts[i - 1].f), pm: 180 + ph[i - 1] + t * (ph[i] - ph[i - 1]) };
    };
    const first = at(crossings.find((c) => c.down)!);
    for (const c of crossings.filter((x) => !x.down)) reasons.push(`loop_gain_reenters_unity:${at(c).f.toFixed(1)}Hz`);
    // Still above unity where the measurement stops: the next crossover lies outside the band.
    if (mag[lastBin] >= 1) reasons.push("loop_gain_above_one_at_band_end");
    const fc = first.f;
    const pm = Math.min(...crossings.map((c) => at(c).pm));
    const lastCrossHz = at(crossings[crossings.length - 1]).f;

    // Every phase crossover (−180° − k·360° of the unwrapped phase, either direction).
    let gm: number | null = null;
    let gmHz: number | null = null;
    for (let k = 1; k < pts.length; k++) {
        const lo = Math.min(ph[k - 1], ph[k]);
        const hi = Math.max(ph[k - 1], ph[k]);
        for (let n = Math.ceil((lo + 180) / 360); n * 360 - 180 <= hi; n++) {
            const target = n * 360 - 180;
            if (ph[k] === ph[k - 1] || target === ph[k - 1]) continue;
            const u = (target - ph[k - 1]) / (ph[k] - ph[k - 1]);
            const m = -20 * Math.log10(mag[k - 1] + u * (mag[k] - mag[k - 1]));
            if (gm === null || m < gm) {
                gm = m;
                gmHz = pts[k - 1].f + u * (pts[k].f - pts[k - 1].f);
            }
        }
    }
    if (gm === null) reasons.push("phase_crossover_outside_identified_band");

    // |S| peak is only meaningful when the band reaches well past the last crossing and the peak
    // is not still rising at the band edge; a band-limited value is unknown, not a bound.
    let sPeak: number | null = null;
    let sPeakHz: number | null = null;
    const sDb = pts.map((p) => 20 * Math.log10(1 / Math.max(cmag(cadd({ re: 1, im: 0 }, p.L)), 1e-12)));
    const peakAt = sDb.indexOf(Math.max(...sDb));
    if (pts[lastBin].f >= 1.5 * lastCrossHz && mag[lastBin] < 1 && peakAt < lastBin) {
        sPeak = sDb[peakAt];
        sPeakHz = pts[peakAt].f;
    } else {
        reasons.push("sensitivity_peak_outside_identified_band");
    }

    // The chain model is validated on CHAIN_VALIDATED_BAND_HZ only: a crossover outside it, or a
    // candidate filter change judged above it, is not backed by that validation.
    const [bandLo, bandHi] = CHAIN_VALIDATED_BAND_HZ;
    if (fc < bandLo || fc > bandHi) reasons.push("crossover_outside_chain_validated_band");
    if (cand.chain && loop.chain && [gmHz, sPeakHz].some((f) => f !== null && f > bandHi)) {
        reasons.push("chain_change_judged_outside_validated_band");
    }
    const spread = loop.chain ? loop.chain.spread(fc).phaseDeg : null;
    if (!loop.chainValidated) reasons.push("chain_model_not_validated_on_this_log");
    if (spread === null) reasons.push("chain_spread_unknown");
    else if (spread > MAX_CHAIN_SPREAD_DEG) reasons.push(`chain_moves_at_crossover:${spread.toFixed(1)}deg`);
    if (!loop.attested) reasons.push("independent_validation_missing");
    return {
        status: reasons.length ? "NOT_VALIDATED" : "VALIDATED",
        crossoverHz: fc,
        phaseMarginDeg: pm,
        gainMarginDb: gm,
        sensitivityPeakDb: sPeak,
        delayMarginMs: fc > 0 ? (pm / (360 * fc)) * 1000 : null,
        chainSpreadDeg: spread,
        okBins: pts.length,
        reasons,
    };
}
