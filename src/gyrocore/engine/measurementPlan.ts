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
    /** The standard analysis of this axis (its Welch segment is the one the next flight gets too). */
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
    // The next flight is analysed with the standard segment whatever it needs: its dwell is planned at that one.
    plan.segmentSamples.primary = executable;
    plan.segmentSamples.qualification = pow2(sampleRateHz / plan.resolutionHz.qualification);
    if (executable === null) diagnostics.push("primary_analysis_segment_unknown");
    else if (wanted > executable) {
        // Only the qualification's finer analysis (finestWelchSegment) reaches it: no flight changes the standard one.
        diagnostics.push(`primary_resolution_needs_finer_analysis:${executable}<${wanted}`);
    }

    // Averages at the crossover for 2 σ of the phase within PLAN.pmUncertaintyDeg.
    const at = pts.reduce((b, p) => (Math.abs(p.f - fc) < Math.abs(b.f - fc) ? p : b), pts[0]);
    const bin = loop.plant.bins.find((b) => b.frequencyHz === at.f);
    const g2 = bin?.coherence ?? null;
    const sigma = ((PLAN.pmUncertaintyDeg / UNCERTAINTY.coverage) * Math.PI) / 180;
    const n = loop.uncertainty.averagesByHz?.get(at.f) ?? null;
    if (g2 !== null && g2 > 0 && at.err !== undefined && n !== null) {
        // ε_L = κ ε_T with ε_T = √(1 − γ²)/(|γ| √(2 n)): solve ε_L ≤ σ for n.
        const kappaSq = at.err ** 2 * ((2 * n * g2) / Math.max(1 - g2, 1e-12));
        const needed = Math.max(1, Math.ceil(((1 - g2) * kappaSq) / (2 * g2 * sigma * sigma)));
        plan.averages = { now: n, needed: g2 >= 1 ? 1 : needed };
        if (plan.averages.needed! > n) required.add("required_measurement:chirp_longer_sweep_for_averages");
        const near = pts.filter((p) => p.f >= fc / Math.SQRT2 && p.f <= fc * Math.SQRT2 && p.err !== undefined);
        const median = near.length ? near.map((p) => p.err!).sort((a, b) => a - b)[Math.floor(near.length / 2)] : 0;
        if (median > PLAN.noiseRelErr)
            diagnostics.push(`measurement_noise_high_near_crossover:${(median * 100).toFixed(1)}pct`);
    } else {
        diagnostics.push("uncertainty_unknown_averages_not_planned");
    }
    if (plan.bandHz.primary && plan.averages.needed !== null && plan.segmentSamples.primary !== null) {
        // n averages per bin: the sweep dwells n segments Ts in each bin of width 1/Ts at fc,
        // T = n · Ts² · fc · ln(f1/f0) (sweepAverages solved for n).
        const sweepFor = (band: [number, number], segment: number) => {
            const Ts = segment / sampleRateHz;
            const durationS = Math.max(
                plan.averages.needed! * Ts * Ts * fc * Math.log(band[1] / band[0]),
                (Ts * (UNCERTAINTY.minWelchSegments + 1)) / 2,
            );
            return { f0Hz: band[0], f1Hz: band[1], durationS };
        };
        plan.sweep = sweepFor(plan.bandHz.primary, plan.segmentSamples.primary!);
        plan.qualificationSweep = sweepFor(plan.bandHz.qualification!, plan.segmentSamples.qualification);
    }
    const octave = pts.filter((p) => p.f >= fc / Math.SQRT2 && p.f <= fc * Math.SQRT2).length;
    if (octave < PHASE_CHECKS.octaveBins)
        diagnostics.push(`crossover_insufficiently_resolved:${octave}_bins_in_octave`);
    required.add("required_measurement:chirp_finer_resolution_model_class_qualification");
    plan.requiredMeasurements = [...required];
    return plan;
}
