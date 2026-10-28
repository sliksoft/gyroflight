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
 * The segment contract of the model-class qualification (planner safety repair, 2026-10-28).
 *
 * The qualification must resolve RESOLVED_FEATURE_BINS × finer than the primary analysis it
 * qualifies (loopModel qualifyModelClass). Before this contract the planner sized the qualification
 * sweep for the smallest power-of-two segment that does so, while the engine analysed the
 * qualification flight with the LONGEST segment its window allows (logInput finestWelchSegment): on
 * a long planned sweep that was a segment of hundreds of seconds, swept through each bin in a
 * thousandth of its length, and the averages the plan promised were never delivered.
 *
 * One rule now serves both sides:
 *   qualificationSegmentSamples   the smallest power-of-two segment whose bin spacing is at most
 *                                 the primary's bin spacing / RESOLVED_FEATURE_BINS (in Hz, so the
 *                                 two flights may log at different rates);
 *   selectQualificationRung       the shortest adequate rung of the qualification log's own ladder,
 *                                 never longer than that segment (logInput: every power of two up to
 *                                 the finest that still averages UNCERTAINTY.minWelchSegments
 *                                 segments, so in production exactly that segment). A
 *                                 rung that is not there, or whose bins are not coherent over the
 *                                 sweep (QUALIFICATION_COHERENT_SHARE), is named and leaves the
 *                                 qualification out (fail-closed). Its averages, support and
 *                                 provenance are then judged by loopModel like any qualification.
 */

import type { TransferFunction } from "@/js/blackbox/spectral_analysis";
import { LOOP_MIN_COHERENCE, RESOLVED_FEATURE_BINS, type AnalysisProvenance, type SweepInfo } from "./loopModel";
import type { AnalysisOption } from "./adaptiveResolution";

/**
 * Share of the qualification rung's bins inside the sweep's band that must reach
 * LOOP_MIN_COHERENCE: 0.8, the share the Verified Tune comparison also asks of its bins
 * (MIN_WITHIN_SHARE). Not calibrated. (Was FINE_COHERENT_SHARE, judged on the finest analysis.)
 */
export const QUALIFICATION_COHERENT_SHARE = 0.8;

/** Share of the bins of `tf` inside the sweep's band (f0 … f1) that reach LOOP_MIN_COHERENCE. */
export function coherentShare(tf: TransferFunction, sweep: SweepInfo | null): number {
    let n = 0;
    let ok = 0;
    for (let k = 0; k < tf.frequencies.length; k++) {
        const f = tf.frequencies[k];
        if (!(f >= (sweep?.f0Hz ?? 1)) || !(f <= (sweep?.f1Hz ?? Infinity))) continue;
        n++;
        if (tf.coherence[k] >= LOOP_MIN_COHERENCE) ok++;
    }
    return n ? ok / n : 0;
}

/**
 * The qualification's Welch segment (samples at `sampleRateHz`): the smallest power of two whose
 * bin spacing is at most `primaryStepHz` / RESOLVED_FEATURE_BINS. Null when an input is not a
 * finite positive number.
 */
export function qualificationSegmentSamples(primaryStepHz: number, sampleRateHz: number): number | null {
    if (!(Number.isFinite(primaryStepHz) && primaryStepHz > 0 && Number.isFinite(sampleRateHz) && sampleRateHz > 0)) {
        return null;
    }
    const target = primaryStepHz / RESOLVED_FEATURE_BINS;
    let n = 2;
    while (sampleRateHz / n > target * (1 + 1e-9)) n *= 2;
    return n;
}

/**
 * The rung of the qualification log's ladder that the contract asks for, given the primary analysis
 * the margins are read on; or the reasons it cannot serve.
 */
export function selectQualificationRung(
    ladder: readonly AnalysisOption[] | undefined,
    primary: AnalysisProvenance | null,
    sweep: SweepInfo | null,
): { rung: AnalysisOption | null; segmentSamples: number | null; reasons: string[] } {
    if (!primary) return { rung: null, segmentSamples: null, reasons: ["qualification_primary_analysis_unknown"] };
    if (!ladder?.length)
        return { rung: null, segmentSamples: null, reasons: ["qualification_resolution_ladder_missing"] };
    const fs = ladder[0].analysis.sampleRateHz;
    const primaryStep = primary.sampleRateHz / primary.segmentSamples;
    const n = qualificationSegmentSamples(primaryStep, fs);
    if (n === null) return { rung: null, segmentSamples: null, reasons: ["qualification_segment_undefined"] };
    // The shortest rung that resolves RESOLVED_FEATURE_BINS × finer than the primary, and never one
    // longer than the contract's segment (the planner's, qualificationSegmentSamples): a ladder without
    // an adequate rung up to that length leaves the qualification out, it does not fall through to a
    // longer rung (Codex review 2026-10-28, P2). A production ladder holds every power of two from the
    // standard segment up to the finest, so this is exactly the contract's segment; a shorter adequate
    // rung (not a power of two) gets more averages from the planned dwell, never fewer.
    const target = (primaryStep / RESOLVED_FEATURE_BINS) * (1 + 1e-9);
    const rung =
        ladder
            .filter((r) => r.analysis.sampleRateHz / r.analysis.segmentSamples <= target)
            .sort((a, b) => a.analysis.segmentSamples - b.analysis.segmentSamples)[0] ?? null;
    if (!rung || rung.analysis.segmentSamples > n) {
        const have = [...new Set(ladder.map((r) => r.analysis.segmentSamples))].sort((a, b) => a - b);
        return {
            rung: null,
            segmentSamples: n,
            reasons: [`qualification_segment_not_available:needs:${n}:finest:${have[have.length - 1]}`],
        };
    }
    const share = coherentShare(rung.tf, sweep);
    if (!(share >= QUALIFICATION_COHERENT_SHARE)) {
        return {
            rung: null,
            segmentSamples: rung.analysis.segmentSamples,
            // The rung actually judged (its own segment), so a report never names one rung for another.
            reasons: [`qualification_rung_not_coherent:${rung.analysis.segmentSamples}:${(share * 100).toFixed(0)}pct`],
        };
    }
    return { rung, segmentSamples: rung.analysis.segmentSamples, reasons: [] };
}
