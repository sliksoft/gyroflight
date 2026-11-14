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
 * Practical measurement strategy (completion program 2026-10-28, phase 2).
 *
 * The AxisMeasurementPlan already names the single exponential sweep that would meet every
 * decision's averages. That sweep is often longer than a battery (hours for qualification). This
 * module turns the plan into an explicit coverage ledger:
 *   - what is already measured adequately on the current evidence;
 *   - which decision frequencies remain uncertain, and why;
 *   - which additional sessions (narrow-band or short full-band) are required;
 *   - how independent recordings may combine averages (sum of whole-segment counts only);
 *   - which errors more time cannot reduce (model class, chain validity, support holes);
 *   - which requirements remain blocked without new firmware capability.
 *
 * It changes no margin gate and never invents averages. Combining recordings is opt-in and fails
 * closed on identity / configuration mismatch or duplicate content (multiRecording.ts).
 */

import type { AxisMeasurementPlan } from "./measurementPlan";
import { PLAN } from "./measurementPlan";
import { sweepAverages } from "./loopModel";

/** Practical session budget used when splitting a long plan into flights (not calibrated). */
export const SESSION = Object.freeze({
    /** Soft ceiling for one CHIRP sweep on one axis before suggesting a split (seconds). */
    maxPracticalSweepS: 180,
    /** Soft ceiling for one battery's total CHIRP time across axes (seconds). */
    maxPracticalFlightS: 600,
    /** Narrow-band half-width around a decision frequency, in octaves. */
    narrowBandOctaves: 0.5,
});

export type CoverageStatus = "ADEQUATE" | "UNCERTAIN" | "MISSING" | "UNACHIEVABLE";

export interface DecisionCoverage {
    purpose: AxisMeasurementPlan["averagesAt"][number]["purpose"];
    hz: number;
    needed: number | null;
    have: number | null;
    status: CoverageStatus;
    /** Why more flight time alone cannot close this gap (empty when time would help). */
    irreducible: string[];
    reason: string;
}

export interface PlannedSession {
    kind: "primary_full_band" | "qualification_full_band" | "narrow_band_followup" | "repeat_independence";
    axis: AxisMeasurementPlan["axis"];
    sweep: { f0Hz: number; f1Hz: number; durationS: number };
    windowSamples: number | null;
    purpose: string;
    targets: { purpose: string; hz: number; needed: number }[];
}

export interface AxisMeasurementStrategy {
    axis: AxisMeasurementPlan["axis"];
    /** Snapshot of the planner output this strategy was built from. */
    plan: AxisMeasurementPlan;
    decisions: DecisionCoverage[];
    /** Sessions that would close the remaining gaps under current Betaflight CHIRP capabilities. */
    sessions: PlannedSession[];
    /** Total planned CHIRP seconds if every session is flown separately (sum of durations). */
    totalDurationS: number;
    /** True when any required session exceeds SESSION.maxPracticalSweepS. */
    exceedsPracticalBudget: boolean;
    /** Named blockers that more time / more flights cannot remove. */
    blockedWithout: string[];
    /** Design comparison notes (quantitative, from this plan). */
    designNotes: string[];
}

function decisionStatus(have: number | null, needed: number | null): CoverageStatus {
    if (needed === null) return "MISSING";
    if (have !== null && have >= needed) return "ADEQUATE";
    if (needed > 0 && have === 0) return "MISSING";
    return "UNCERTAIN";
}

/** Narrow band around `hz` by SESSION.narrowBandOctaves, clipped to the parent band. */
export function narrowBandAround(
    hz: number,
    band: [number, number],
    octaves = SESSION.narrowBandOctaves,
): [number, number] {
    const lo = Math.max(band[0], hz / 2 ** octaves);
    const hi = Math.min(band[1], hz * 2 ** octaves);
    return lo < hi ? [lo, hi] : band;
}

/**
 * Welch analysis grid: the FFT bin nearest `hz` (same grid the full-band planner uses).
 */
export function analysisGridHz(hz: number, segmentSamples: number, sampleRateHz: number): number {
    const df = sampleRateHz / segmentSamples;
    if (!(df > 0 && hz > 0)) return hz;
    return Math.max(df, Math.round(hz / df) * df);
}

/**
 * Sweep edges as the firmware stores them (chirp_frequency_start/end in 0.1 Hz), matching
 * measurementPlan.ts. Duration stays in whole seconds.
 */
export function firmwareChirpSweep(
    band: [number, number],
    durationS: number,
): {
    f0Hz: number;
    f1Hz: number;
    durationS: number;
} {
    return {
        f0Hz: Math.max(0.1, Math.floor(band[0] * 10 + 1e-9) / 10),
        f1Hz: Math.ceil(band[1] * 10 - 1e-9) / 10,
        durationS,
    };
}

/**
 * Duration of an exponential sweep that puts `needed` whole segments of length N at `hz`, using the
 * same dwell law as loopModel. Counts on the analysis FFT grid and the firmware-quantized band
 * (Codex release-gate P2, 2026-10-28). Returns null when inputs are invalid or unsatisfiable.
 */
export function narrowSweepDurationS(
    hz: number,
    needed: number,
    segmentSamples: number,
    sampleRateHz: number,
    band: [number, number],
): number | null {
    if (!(hz > 0 && needed >= 1 && segmentSamples > 0 && sampleRateHz > 0 && band[1] > band[0])) return null;
    const gridHz = analysisGridHz(hz, segmentSamples, sampleRateHz);
    const fwBand: [number, number] = [firmwareChirpSweep(band, 1).f0Hz, firmwareChirpSweep(band, 1).f1Hz];
    if (!(fwBand[1] > fwBand[0])) return null;
    if (gridHz < fwBand[0] || gridHz > fwBand[1]) return null;

    const df = sampleRateHz / segmentSamples;
    const lo = Math.max(gridHz - df / 2, fwBand[0]);
    const hi = Math.min(gridHz + df / 2, fwBand[1]);
    if (!(hi > lo)) return null;
    const L = Math.log(fwBand[1] / fwBand[0]);
    const binL = Math.log(hi / lo);
    if (!(binL > 0 && L > 0)) return null;

    // Same window/segment model as measurementPlan.solve (AIR65: window one sample short of T·fs).
    const windowOf = (T: number) => Math.floor(T * sampleRateHz) - 1;
    const segmentsOf = (T: number) =>
        Math.max(1, Math.floor((windowOf(T) - segmentSamples) / (segmentSamples / 2)) + 1);
    const count = (T: number) =>
        sweepAverages(
            gridHz,
            { segmentSamples, sampleRateHz, segments: segmentsOf(T) },
            firmwareChirpSweep(band, T),
            windowOf(T),
        );

    let durationS = Math.ceil(((needed * segmentSamples) / sampleRateHz) * (L / binL));
    if (!(durationS >= 1)) durationS = 1;
    const limit = durationS + Math.max(needed * segmentSamples, 10_000);
    for (; durationS <= limit; durationS++) {
        if (count(durationS) >= needed) return durationS;
    }
    return null;
}

/**
 * Build the practical strategy for one axis from its planner output. Does not re-plan averages;
 * it only schedules how to collect what the planner already asked for.
 */
export function buildMeasurementStrategy(
    plan: AxisMeasurementPlan,
    opts: { sampleRateHz?: number } = {},
): AxisMeasurementStrategy {
    // Prefer the analysis rate the planner already used (plan.sampleRateHz); never the raw log
    // timestamp median when they differ (Codex release-gate P2, 2026-10-28).
    const fs = opts.sampleRateHz ?? plan.sampleRateHz ?? 4000;
    const decisions: DecisionCoverage[] = plan.averagesAt.map((a) => {
        const have = a.now;
        const needed = a.needed;
        const irreducible: string[] = [];
        if (plan.diagnostics.some((d) => d.startsWith("coherence_dip"))) {
            // Coherence holes are support failures; more dwell at the same excitation does not create support.
            if (have !== null && needed !== null && have < needed) {
                irreducible.push("coherence_or_support_hole_not_fixed_by_dwell_alone");
            }
        }
        const status = decisionStatus(have, needed);
        let reason = "adequate";
        if (status === "MISSING" && needed === null) reason = "needed_averages_unknown";
        else if (status === "MISSING") reason = `have_${have ?? 0}_need_${needed}`;
        else if (status === "UNCERTAIN") reason = `have_${have}_need_${needed}`;
        return { purpose: a.purpose, hz: a.hz, needed, have, status, irreducible, reason };
    });

    const sessions: PlannedSession[] = [];
    const designNotes: string[] = [];
    const blockedWithout: string[] = [];

    // Design A: one full-band primary sweep (existing planner).
    if (plan.sweep) {
        sessions.push({
            kind: "primary_full_band",
            axis: plan.axis,
            sweep: plan.sweep,
            windowSamples: plan.windowSamples.primary,
            purpose: "primary_decision_averages",
            targets: plan.averagesAt
                .filter((a) => a.needed !== null && (a.primary === null || a.primary < a.needed))
                .map((a) => ({ purpose: a.purpose, hz: a.hz, needed: a.needed! })),
        });
        designNotes.push(
            `design_A_one_primary_sweep:${plan.sweep.durationS}s_band_${plan.sweep.f0Hz}-${plan.sweep.f1Hz}Hz`,
        );
    }

    // Design B: split uncertain decisions into narrow-band follow-ups when the full sweep is long.
    const band = plan.bandHz.primary;
    const N = plan.segmentSamples.primary ?? plan.segmentSamples.executable;
    if (band && N && plan.sweep && plan.sweep.durationS > SESSION.maxPracticalSweepS) {
        let narrowTotal = 0;
        for (const d of decisions) {
            if (d.status === "ADEQUATE" || d.needed === null) continue;
            const gridHz = analysisGridHz(d.hz, N, fs);
            const nb = narrowBandAround(gridHz, band);
            const dur = narrowSweepDurationS(gridHz, d.needed, N, fs, nb);
            if (dur === null) continue;
            narrowTotal += dur;
            const sweep = firmwareChirpSweep(nb, dur);
            sessions.push({
                kind: "narrow_band_followup",
                axis: plan.axis,
                sweep,
                windowSamples: Math.ceil(dur * fs),
                purpose: `narrow_${d.purpose}_at_${gridHz.toFixed(1)}Hz`,
                targets: [{ purpose: d.purpose, hz: gridHz, needed: d.needed }],
            });
        }
        designNotes.push(
            `design_B_narrow_followups_total:${narrowTotal}s_vs_full_primary:${plan.sweep.durationS}s${
                narrowTotal > 0 && narrowTotal < plan.sweep.durationS ? ":narrow_shorter" : ":narrow_not_shorter"
            }`,
        );
    }

    // Design C: qualification as one long sweep (existing planner) — often unachievable in one flight.
    if (plan.qualificationSweep) {
        sessions.push({
            kind: "qualification_full_band",
            axis: plan.axis,
            sweep: plan.qualificationSweep,
            windowSamples: plan.windowSamples.qualification,
            purpose: "model_class_qualification",
            targets: plan.averagesAt
                .filter((a) => a.needed !== null)
                .map((a) => ({ purpose: a.purpose, hz: a.hz, needed: Math.max(1, a.needed!) })),
        });
        designNotes.push(`design_C_qualification_sweep:${plan.qualificationSweep.durationS}s`);
        if (plan.qualificationSweep.durationS > SESSION.maxPracticalFlightS) {
            blockedWithout.push(
                "practical_qualification_needs_multi_session_or_finer_firmware_excitation:" +
                    `${plan.qualificationSweep.durationS}s`,
            );
        }
    }

    // Independence repeat (H2): a second primary of the same band, not concatenated with the first.
    if (plan.sweep) {
        sessions.push({
            kind: "repeat_independence",
            axis: plan.axis,
            sweep: plan.sweep,
            windowSamples: plan.windowSamples.primary,
            purpose: "between_flight_repeatability",
            targets: [],
        });
        designNotes.push("design_D_independent_repeat_required_for_H2_delta_fc");
    }

    for (const d of decisions) {
        for (const r of d.irreducible) {
            if (!blockedWithout.includes(r)) blockedWithout.push(r);
        }
    }
    // Errors more time cannot reduce.
    blockedWithout.push(
        "model_class_systematic_not_reduced_by_dwell",
        "chain_validation_not_reduced_by_dwell",
        `pm_uncertainty_target_deg:${PLAN.pmUncertaintyDeg}`,
    );

    const totalDurationS = sessions.reduce((s, x) => s + x.sweep.durationS, 0);
    const exceedsPracticalBudget = sessions.some((s) => s.sweep.durationS > SESSION.maxPracticalSweepS);

    return {
        axis: plan.axis,
        plan,
        decisions,
        sessions,
        totalDurationS,
        exceedsPracticalBudget,
        blockedWithout,
        designNotes,
    };
}
