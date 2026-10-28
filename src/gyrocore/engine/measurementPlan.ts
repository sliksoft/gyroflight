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
 * Measurement planner (WP3, audit F-02 "adaptive measurement"): what the next CHIRP flight must
 * measure for this craft's own loop, derived from the loop the current flight identified. It
 * changes no analysis and releases nothing; it turns the evidence gaps into numbers the pilot can
 * set (band, resolution, segment length, sweep duration) and names what the data show
 * (coherence dips, possible narrow features, noise, a poorly resolved crossover).
 *
 * Every requirement follows from a rule the margin evidence already applies (loopModel.ts):
 *   band          up to where |L| has fallen PLAN.bandEndDb below unity (BAND_END needs ≤ −6 dB
 *                 at the band end, falling; this leaves room for a resonance), extrapolated along
 *                 the tail slope when the band stops earlier; a qualification QUALIFICATION_BAND_
 *                 EXTENSION × further (P1-2).
 *   resolution    the steepest phase slope the bins show must take ≤ LOOP_RESOLUTION.maxPhaseStepDeg
 *                 per bin, and at most LOOP_RESOLUTION.maxRelativeSpacing × fc / 2 near the
 *                 crossover; a qualification RESOLVED_FEATURE_BINS × finer.
 *   averages      enough independent averages at the crossover that 2 σ of the loop phase (UNCERTAINTY,
 *                 Bendat & Piersol) stays within PLAN.pmUncertaintyDeg: n ≥ (1 − γ²) κ² / (2 γ² σ²).
 *   duration      an exponential sweep (chirp.c) over the planned band dwells T / (Ts² f ln(f1/f0))
 *                 segments per bin: one sweep of T = n Ts² fc ln(f1/f0) gives n averages at fc; a
 *                 window must also hold UNCERTAINTY.minWelchSegments segments. Gyroflight analyses one
 *                 sweep per axis and does not combine repeated sweeps, so the plan asks for one longer
 *                 sweep, never for repeats.
 * The figures are model-dependent (one sweep shape, the stationary-error approximation, the AIR65-
 * calibrated step limits); they say what this evidence rule needs, not that the craft is safe then.
 */

import { cmag, cphaseDeg } from "@/js/blackbox/betaflight_digital_controller";
import {
    candidateLoop,
    loopErrorGain,
    sweepAverages,
    LOOP_MIN_COHERENCE,
    LOOP_RESOLUTION,
    PHASE_CHECKS,
    QUALIFICATION_BAND_EXTENSION,
    RESOLVED_FEATURE_BINS,
    UNCERTAINTY,
    type AnalysisProvenance,
    type AxisLoop,
    type LoopMargins,
    type SweepInfo,
} from "./loopModel";
import type { AxisName } from "./safetyEvidence";
import { qualificationSegmentSamples } from "./qualificationRung";

/**
 * Planner design parameters (not calibrated):
 *   bandEndDb −12       the band should reach |L| ≤ −12 dB: 6 dB below BAND_END's −6 dB.
 *   pmUncertaintyDeg 2.5  2 σ of the loop phase at the crossover: half the 5° M5-A scatter the
 *                       model-class qualification tolerates (MODEL_CLASS_QUALIFICATION.maxPmDeficitDeg).
 *   narrowStepShare 0.6  a step of more than 60 % of the step limit marks a possible narrow feature.
 *   noiseRelErr 0.05     a median ε above 5 % around the crossover is "noise high".
 */
export const PLAN = Object.freeze({ bandEndDb: -12, pmUncertaintyDeg: 2.5, narrowStepShare: 0.6, noiseRelErr: 0.05 });

export interface AxisMeasurementPlan {
    axis: AxisName;
    crossoverHz: number | null;
    /** The band the margins need measured, and the band a qualification must cover. */
    bandHz: { primary: [number, number] | null; qualification: [number, number] | null };
    /** Largest bin step that resolves the measured loop, and the one a qualification needs. */
    resolutionHz: { now: number | null; primary: number | null; qualification: number | null };
    /**
     * Welch segment length (samples, power of two) at this sample rate. The primary one is the
     * segment the standard analysis uses (`executable`): it is set by the sample rate, not by the
     * flight, so the next flight gets that one whatever its resolution needs; the qualification's
     * is the one its finer analysis needs.
     */
    segmentSamples: { primary: number | null; qualification: number | null; executable: number | null };
    /** Independent averages at the crossover: available now and needed (PLAN.pmUncertaintyDeg). */
    averages: { now: number | null; needed: number | null };
    /**
     * The one sweep over the planned band (not the logged one: only the band the evidence needs)
     * that gives the averages needed at the crossover at the planned resolution (repeated sweeps
     * are not combined by the analysis).
     */
    sweep: { f0Hz: number; f1Hz: number; durationS: number } | null;
    /** The same for the qualification flight, at its resolution over its band. */
    qualificationSweep: { f0Hz: number; f1Hz: number; durationS: number } | null;
    /** What the data show: coherence dips, possible narrow features, noise, crossover resolution. */
    diagnostics: string[];
    /** Targeted measurement needs, as required_measurement:* codes (the panel shows them). */
    requiredMeasurements: string[];
    /**
     * The averages each stability decision needs, at its own frequency (planner safety repair
     * 2026-10-28): every gain crossing (PM), every phase crossing (GM), the |S| peak; `needed` from
     * that bin's coherence and error gain κ (null: unknown), `primary` / `qualification` the whole
     * averages the planned sweeps give there (loopModel sweepAverages, the analysis's own count).
     */
    averagesAt: {
        purpose: "gain_crossover" | "phase_crossover" | "sensitivity_peak";
        hz: number;
        needed: number | null;
        now: number | null;
        primary: number | null;
        qualification: number | null;
    }[];
    /** Samples the planned sweep windows must hold at the sample rate (whole segments; null: not planned). */
    windowSamples: { primary: number | null; qualification: number | null };
}

const pow2 = (x: number) => 2 ** Math.ceil(Math.log2(Math.max(2, x)));

/** Least-squares slope (dB/decade) of |L| over the top 10 % of the band (at least four bins). */
function tailSlopeDbPerDecade(pts: { f: number; db: number }[]): number | null {
    const n = pts.length;
    if (n < 4) return null;
    const from = pts[n - 1].f - 0.1 * (pts[n - 1].f - pts[0].f);
    const tail = pts.slice(
        Math.min(
            pts.findIndex((p) => p.f >= from),
            n - 4,
        ),
    );
    const xs = tail.map((p) => Math.log10(p.f));
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = tail.reduce((a, p) => a + p.db, 0) / tail.length;
    let num = 0;
    let den = 0;
    tail.forEach((p, i) => {
        num += (xs[i] - mx) * (p.db - my);
        den += (xs[i] - mx) ** 2;
    });
    return den > 0 ? num / den : null;
}

/** Ranges of consecutive bins below the loop coherence inside the identified band. */
function coherenceDips(loop: AxisLoop): string[] {
    const bins = loop.plant.bins;
    const ok = bins.map((b) => b.status === "ok" && b.coherence >= LOOP_MIN_COHERENCE);
    const first = ok.indexOf(true);
    const last = ok.lastIndexOf(true);
    const out: string[] = [];
    for (let i = first; i >= 0 && i <= last; i++) {
        if (ok[i]) continue;
        let j = i;
        while (j + 1 <= last && !ok[j + 1]) j++;
        out.push(`coherence_dip:${bins[i].frequencyHz.toFixed(1)}-${bins[j].frequencyHz.toFixed(1)}Hz`);
        i = j;
    }
    return out;
}

/** Plan the next measurement for one axis from its identified loop and its current margins. */
export function planMeasurement(
    axis: AxisName,
    loop: AxisLoop,
    margins: LoopMargins,
    sampleRateHz: number,
    sweep: SweepInfo | null,
    /**
     * The analysis the margins were read on (the adaptive rung, adaptiveResolution.ts): the next
     * flight's sweep is planned at that segment, so its averages and duration belong together.
     */
    analysis: AnalysisProvenance | null,
): AxisMeasurementPlan {
    const pts = candidateLoop(loop, { cfg: loop.cfg });
    const fc = margins.crossoverHz;
    const diagnostics = coherenceDips(loop);
    const required = new Set<string>();
    const plan: AxisMeasurementPlan = {
        axis,
        crossoverHz: fc,
        bandHz: { primary: null, qualification: null },
        resolutionHz: { now: margins.evidence.resolutionHz, primary: null, qualification: null },
        segmentSamples: { primary: null, qualification: null, executable: analysis?.segmentSamples ?? null },
        averages: { now: loop.uncertainty.averages?.[0] ?? null, needed: null },
        sweep: null,
        qualificationSweep: null,
        diagnostics,
        requiredMeasurements: [],
        averagesAt: [],
        windowSamples: { primary: null, qualification: null },
    };
    if (pts.length < 4 || !fc) {
        diagnostics.push(pts.length < 4 ? "too_few_identified_bins" : "crossover_not_found_in_band");
        required.add("required_measurement:chirp_covering_the_crossover");
        plan.requiredMeasurements = [...required];
        return plan;
    }
    const db = pts.map((p) => ({ f: p.f, db: 20 * Math.log10(cmag(p.L)) }));
    const ph = (() => {
        const raw = pts.map((p) => cphaseDeg(p.L));
        const out: number[] = [];
        let off = 0;
        raw.forEach((v, i) => {
            if (i > 0) {
                const d = v + off - out[i - 1];
                if (d > 180) off -= 360;
                else if (d < -180) off += 360;
            }
            out.push(v + off);
        });
        return out;
    })();

    // Band: from a quarter of the crossover up to |L| ≤ bandEndDb, extrapolated along the tail if needed.
    const end = pts[pts.length - 1].f;
    const lo = Math.max(pts[0].f, fc / 4);
    const below = db.findIndex((p, i) => p.f > fc && db.slice(i).every((q) => q.db <= PLAN.bandEndDb));
    let hi: number | null = below >= 0 ? db[below].f : null;
    if (hi === null) {
        const slope = tailSlopeDbPerDecade(db);
        const endDb = db[db.length - 1].db;
        hi = slope !== null && slope < 0 ? end * 10 ** ((endDb - PLAN.bandEndDb) / -slope) : null;
        if (hi === null) diagnostics.push("loop_not_falling_at_band_end");
        required.add("required_measurement:chirp_to_higher_frequency_for_gain_margin");
    }
    // The gain margin is read at the phase crossover (−180° − k·360°), and the band end must lie
    // far enough beyond it to be bounded (loopModel readLoop / BAND_END): a band that ends where |L|
    // reaches bandEndDb can stop short of it on a craft whose phase falls late (7-inch-like: the
    // planned flight then never gives a GM, and the next plan asks for the same band). When the
    // bins show the phase crossover, the band reaches QUALIFICATION_BAND_EXTENSION × it
    // (continuation B5). This asks for a wider sweep; no gate changes with it.
    const phaseCrossHz = (() => {
        for (let i = 1; i < pts.length; i++) {
            if (pts[i].f <= fc) continue;
            const a = ph[i - 1];
            const b = ph[i];
            for (let n = Math.ceil((Math.min(a, b) + 180) / 360); n * 360 - 180 <= Math.max(a, b); n++) {
                const target = n * 360 - 180;
                if (a === b || target === a) continue;
                return pts[i - 1].f + ((target - a) / (b - a)) * (pts[i].f - pts[i - 1].f);
            }
        }
        return null;
    })();
    if (hi !== null && phaseCrossHz !== null && QUALIFICATION_BAND_EXTENSION * phaseCrossHz > hi) {
        diagnostics.push(`band_extended_past_phase_crossover:${phaseCrossHz.toFixed(1)}Hz`);
        hi = QUALIFICATION_BAND_EXTENSION * phaseCrossHz;
    }
    if (hi !== null) {
        plan.bandHz.primary = [lo, hi];
        plan.bandHz.qualification = [lo, QUALIFICATION_BAND_EXTENSION * Math.max(hi, end)];
    }

    // Resolution: the steepest phase slope over the planned band takes at most the step limit per bin.
    const inBand = (f: number) => f >= lo && (hi === null || f <= hi);
    let slope = 0;
    const narrow: string[] = [];
    for (let i = 1; i < pts.length; i++) {
        if (!inBand(pts[i].f)) continue;
        const step = Math.abs(ph[i] - ph[i - 1]);
        slope = Math.max(slope, step / (pts[i].f - pts[i - 1].f));
        if (step > PLAN.narrowStepShare * LOOP_RESOLUTION.maxPhaseStepDeg) narrow.push(`${pts[i - 1].f.toFixed(1)}Hz`);
    }
    if (narrow.length) diagnostics.push(`possible_narrow_feature:${narrow.slice(0, 3).join(",")}`);
    const bySlope = slope > 0 ? LOOP_RESOLUTION.maxPhaseStepDeg / slope : Infinity;
    const byCrossover = LOOP_RESOLUTION.maxRelativeSpacing * (fc / 2);
    const dfPrimary = Math.min(bySlope, byCrossover, (fc * (Math.SQRT2 - 1 / Math.SQRT2)) / PHASE_CHECKS.octaveBins);
    plan.resolutionHz.primary = dfPrimary;
    plan.resolutionHz.qualification =
        Math.min(dfPrimary, margins.evidence.resolutionHz ?? dfPrimary) / RESOLVED_FEATURE_BINS;
    const wanted = pow2(sampleRateHz / dfPrimary);
    const executable = plan.segmentSamples.executable;
    // The next flight is analysed at this rung (adaptiveResolution picks it from the crossover): its
    // dwell is planned at that one. A finer rung than the window supports stays a diagnostic.
    plan.segmentSamples.primary = executable;
    // The qualification's segment is the one the engine will read it on (qualificationRung.ts, the
    // segment contract): RESOLVED_FEATURE_BINS × finer than the primary rung actually used, the rung
    // qualifyModelClass judges it against, not the primary's wanted resolution.
    const qualificationSegment =
        executable !== null ? qualificationSegmentSamples(sampleRateHz / executable, sampleRateHz) : null;
    plan.segmentSamples.qualification = qualificationSegment ?? pow2(sampleRateHz / plan.resolutionHz.qualification);
    if (qualificationSegment !== null) plan.resolutionHz.qualification = sampleRateHz / qualificationSegment;
    if (executable === null) diagnostics.push("primary_analysis_segment_unknown");
    else if (wanted > executable) {
        // The rung used is still coarser than the loop's steps ask for: a longer window gives a finer rung.
        diagnostics.push(`primary_resolution_needs_finer_analysis:${executable}<${wanted}`);
    }

    // Averages each stability decision needs (planner safety repair 2026-10-28): for 2 σ of the
    // loop's relative error (phase in rad, gain relative) within PLAN.pmUncertaintyDeg at every gain
    // crossing (PM), every phase crossing (GM) and the |S| peak, from that bin's coherence and its
    // error gain κ taken directly from T and the controller (the bin's error may be unknown):
    // ε_L = κ √(1 − γ²) / (|γ| √(2 n)) ≤ σ.
    const sigma = ((PLAN.pmUncertaintyDeg / UNCERTAINTY.coverage) * Math.PI) / 180;
    const mags = pts.map((p) => cmag(p.L));
    const decisions: { purpose: AxisMeasurementPlan["averagesAt"][number]["purpose"]; hz: number }[] = [];
    for (let i = 1; i < pts.length; i++) {
        if (mags[i - 1] >= 1 !== mags[i] >= 1) {
            const t = (0 - Math.log(mags[i - 1])) / (Math.log(mags[i]) - Math.log(mags[i - 1]));
            decisions.push({ purpose: "gain_crossover", hz: pts[i - 1].f + t * (pts[i].f - pts[i - 1].f) });
        }
        const a = ph[i - 1];
        const b = ph[i];
        for (let k = Math.ceil((Math.min(a, b) + 180) / 360); k * 360 - 180 <= Math.max(a, b); k++) {
            const target = k * 360 - 180;
            if (a === b || target === a) continue;
            decisions.push({
                purpose: "phase_crossover",
                hz: pts[i - 1].f + ((target - a) / (b - a)) * (pts[i].f - pts[i - 1].f),
            });
        }
    }
    const sPeak = pts.reduce(
        (best, p) => {
            const d = cmag({ re: 1 + p.L.re, im: p.L.im });
            return d < best.d ? { d, f: p.f } : best;
        },
        { d: Infinity, f: pts[0].f },
    );
    decisions.push({ purpose: "sensitivity_peak", hz: sPeak.f });
    const used = new Set(pts.map((p) => p.f));
    const neededAt = (hz: number) => {
        // The decision's own bin: the identified bin nearest to it, whatever its status. If that bin
        // is not one the margins are read on (not coherent, unsupported, too uncertain), the averages
        // the decision needs are unknown; a neighbour's coherence is never borrowed.
        const own = loop.plant.bins.reduce(
            (b, q) => (Math.abs(q.frequencyHz - hz) < Math.abs(b.frequencyHz - hz) ? q : b),
            loop.plant.bins[0],
        );
        const p = { f: own.frequencyHz };
        if (!used.has(own.frequencyHz)) return { binHz: p.f, needed: null };
        const bin = own;
        const g2 = bin?.coherence;
        const kappa = bin?.T ? loopErrorGain(bin.T, loop.cfg, p.f) : Infinity;
        if (!(typeof g2 === "number" && g2 > 0 && g2 <= 1) || !Number.isFinite(kappa))
            return { binHz: p.f, needed: null };
        if (g2 >= 1) return { binHz: p.f, needed: 1 };
        return { binHz: p.f, needed: Math.max(1, Math.ceil(((1 - g2) * kappa * kappa) / (2 * g2 * sigma * sigma))) };
    };
    const targets = decisions.map((d) => ({ ...d, ...neededAt(d.hz) }));
    const atFc = neededAt(fc);
    const nowFc = loop.uncertainty.averagesByHz?.get(atFc.binHz) ?? null;
    plan.averages = { now: nowFc, needed: atFc.needed };
    const unknownTargets = targets.filter((t) => t.needed === null);
    for (const t of unknownTargets) diagnostics.push(`averages_unknown_at:${t.purpose}:${t.hz.toFixed(1)}Hz`);
    if (atFc.needed === null) diagnostics.push("uncertainty_unknown_averages_not_planned");
    if (targets.some((t) => t.needed !== null && t.needed > (loop.uncertainty.averagesByHz?.get(t.binHz) ?? 0)))
        required.add("required_measurement:chirp_longer_sweep_for_averages");
    const near = pts.filter((p) => p.f >= fc / Math.SQRT2 && p.f <= fc * Math.SQRT2 && p.err !== undefined);
    const median = near.length ? near.map((p) => p.err!).sort((a, b) => a - b)[Math.floor(near.length / 2)] : 0;
    if (median > PLAN.noiseRelErr)
        diagnostics.push(`measurement_noise_high_near_crossover:${(median * 100).toFixed(1)}pct`);

    // Durations, solved in whole samples and checked with the analysis's own count (sweepAverages):
    // the shortest sweep over the band whose dwell gives every target its averages on the planned
    // segment, in a window of at least `floorSegments` segments. The primary's floor holds the next
    // finer rung with UNCERTAINTY.minWelchSegments segments (2N · (K + 1) / 2 samples: the resolution
    // convergence check needs it); the qualification's its own rung's.
    const known = targets.filter((t): t is (typeof targets)[number] & { needed: number } => t.needed !== null);
    const solve = (band: [number, number], N: number, minSamples: number, extra: { hz: number; n: number }[]) => {
        const fs = sampleRateHz;
        const df = fs / N;
        const grid = (hz: number) => Math.max(1, Math.round(hz / df)) * df;
        const all = [
            ...known.map((t) => ({ hz: grid(t.hz), n: t.needed })),
            ...extra.map((e) => ({ hz: grid(e.hz), n: e.n })),
        ].filter((t) => t.hz >= band[0] && t.hz <= band[1]);
        const L = Math.log(band[1] / band[0]);
        const sweepOf = (T: number) => ({ f0Hz: band[0], f1Hz: band[1], durationS: T });
        const segmentsOf = (T: number) => Math.max(1, Math.floor((Math.floor(T * fs) - N) / (N / 2)) + 1);
        const count = (hz: number, T: number) =>
            sweepAverages(hz, { segmentSamples: N, sampleRateHz: fs, segments: segmentsOf(T) }, sweepOf(T));
        let T = minSamples / fs;
        for (const t of all) {
            const lo = Math.max(t.hz - df / 2, band[0]);
            const hi = Math.min(t.hz + df / 2, band[1]);
            if (hi > lo) T = Math.max(T, ((t.n * N + 2) / fs) * (L / Math.log(hi / lo)));
        }
        for (let i = 0; i < 200 && !all.every((t) => count(t.hz, T) >= t.n); i++) T = T * 1.002 + 1 / fs;
        return { durationS: T, windowSamples: Math.ceil(T * fs), count: (hz: number) => count(grid(hz), T) };
    };
    const Np = plan.segmentSamples.primary;
    const Nq = plan.segmentSamples.qualification;
    if (plan.bandHz.primary && Np !== null && known.length) {
        const primary = solve(plan.bandHz.primary, Np, (2 * Np * (UNCERTAINTY.minWelchSegments + 1)) / 2, []);
        plan.sweep = { f0Hz: plan.bandHz.primary[0], f1Hz: plan.bandHz.primary[1], durationS: primary.durationS };
        plan.windowSamples.primary = primary.windowSamples;
        // The primary path counts a bin with less than one segment of dwell as one average
        // (loopModel SUB_SEGMENT_DWELL.primary): said, not planned away.
        const df = sampleRateHz / Np;
        let sub = 0;
        for (let k = Math.ceil(plan.bandHz.primary[0] / df); k * df <= plan.bandHz.primary[1]; k++) {
            if (primary.count(k * df) < 1) sub++;
        }
        if (sub) diagnostics.push(`primary_sub_segment_bins_counted_as_one:${sub}`);
        // The qualification needs every bin of its band known (SUB_SEGMENT_DWELL.qualification): at
        // least one whole segment of dwell at its highest bin, where the dwell is shortest.
        if (plan.bandHz.qualification && Nq !== null) {
            if (unknownTargets.length) {
                diagnostics.push("qualification_not_planned:averages_unknown");
            } else {
                const qdf = sampleRateHz / Nq;
                const top = Math.floor(plan.bandHz.qualification[1] / qdf) * qdf;
                const qual = solve(plan.bandHz.qualification, Nq, (Nq * (UNCERTAINTY.minWelchSegments + 1)) / 2, [
                    { hz: top, n: 1 },
                ]);
                plan.qualificationSweep = {
                    f0Hz: plan.bandHz.qualification[0],
                    f1Hz: plan.bandHz.qualification[1],
                    durationS: qual.durationS,
                };
                plan.windowSamples.qualification = qual.windowSamples;
                plan.averagesAt = targets.map((t) => ({
                    purpose: t.purpose,
                    hz: t.hz,
                    needed: t.needed,
                    now: loop.uncertainty.averagesByHz?.get(t.binHz) ?? null,
                    primary: t.needed === null ? null : primary.count(t.hz),
                    qualification: t.needed === null ? null : qual.count(t.hz),
                }));
            }
        }
        if (!plan.averagesAt.length) {
            plan.averagesAt = targets.map((t) => ({
                purpose: t.purpose,
                hz: t.hz,
                needed: t.needed,
                now: loop.uncertainty.averagesByHz?.get(t.binHz) ?? null,
                primary: t.needed === null ? null : primary.count(t.hz),
                qualification: null,
            }));
        }
    }
    const octave = pts.filter((p) => p.f >= fc / Math.SQRT2 && p.f <= fc * Math.SQRT2).length;
    if (octave < PHASE_CHECKS.octaveBins)
        diagnostics.push(`crossover_insufficiently_resolved:${octave}_bins_in_octave`);
    required.add("required_measurement:chirp_finer_resolution_model_class_qualification");
    plan.requiredMeasurements = [...required];
    return plan;
}
