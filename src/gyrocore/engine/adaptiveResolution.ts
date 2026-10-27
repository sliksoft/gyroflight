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
 * Adaptive Welch resolution (measurement audit 2026-10-26, B1 / H1).
 *
 * The standard CHIRP analysis fixes its Welch segment on the sample rate (useAutotune chooseSegmentSize:
 * 2048 samples at 4 kHz, 512 at 1 kHz: 1.95 Hz bins), whatever the craft. A loop that crosses unity
 * low (a 7-inch-like plant near 7 Hz) is then read on three or four bins per octave, and the margins
 * read on them are systematically optimistic (E1: fc +9 %, PM +1.5°, seed-independent). The
 * resolution a measurement can give is set by its samples, not by the grid: a longer segment
 * resolves finer but averages fewer segments, and a finer grid from padding or interpolation is no
 * resolution (loopModel provenanceIssues).
 *
 * Three things are kept apart here:
 *   bin spacing          Δf = fs / N: where the loop is read;
 *   effective resolution the Hann window's equivalent noise bandwidth, 1.5 Δf: the narrowest feature
 *                        two bins can tell apart;
 *   uncertainty          the per-bin random error (loopModel UNCERTAINTY), which grows as the segments
 *                        get fewer and the sweep dwells on each bin for less of them.
 *
 * logInput analyses every sweep window at a ladder of segment lengths, from the standard one up to the
 * longest that still averages UNCERTAINTY.minWelchSegments segments (finestWelchSegment), all from the
 * same samples. From the standard analysis's crossover, chooseAnalysis takes the shortest segment whose
 * bin spacing is at most maxBinSpacingOfCrossover × fc; when no rung reaches that, the window is too
 * short for the resolution the loop needs, which is said (`resolution_target_not_reachable`), and the
 * finest rung is used. Whether that analysis is converged is then checked against the next finer
 * rung on the same samples (H1): crossover within maxCrossoverChange, phase margin within
 * max(minPhaseMarginChangeDeg, 2 σ_PM). Without a finer rung the convergence is unknown
 * (`resolution_convergence_unknown:window_too_short_for_2x`): the window does not hold enough data to
 * show that its own resolution suffices. Either outcome short of CONVERGED leaves the margins MEASURED
 * (loopModel loopMargins), and the release contract repeats the check (marginEvidenceIssues).
 *
 *   maxBinSpacingOfCrossover 0.1  ten bins up to the crossover, about 7 per octave around it; the
 *     E1 figures: at Δf / fc = 0.29 (1.95 Hz on 6.8 Hz) the bias was +9 % / +1.5°, at 0.036 it was
 *     −0.1 % / −0.8°. A target, not a proof: the convergence check decides.
 *   maxCrossoverChange 0.03   fc is the primary convergence measure (it caught the bias in every
 *     seed of E1 / E1b); 3 % is above the seed-to-seed scatter of the fine analysis (≤ 0.9 %).
 *   minPhaseMarginChangeDeg 2 the PM threshold is noise-dependent: 2° or 2 σ_PM of the coarser
 *     analysis, whichever is larger (E1b: variance alone reached 2σ ≈ 1.6° at noise 40).
 */

import type { TransferFunction } from "@/js/blackbox/spectral_analysis";
import {
    RESOLUTION_TARGET,
    UNCERTAINTY,
    type AnalysisProvenance,
    type AxisLoop,
    type FrequencySupport,
    type LoopMargins,
    type ResolutionConvergence,
} from "./loopModel";

export const ADAPTIVE_RESOLUTION = Object.freeze({
    // Shared with loopModel.resolutionVerdictFor, which re-checks it at every candidate's crossover.
    maxBinSpacingOfCrossover: RESOLUTION_TARGET.maxBinSpacingOfCrossover,
    hannEnbwBins: 1.5,
    maxCrossoverChange: 0.03,
    minPhaseMarginChangeDeg: 2,
});

/** One rung of the resolution ladder: the same samples analysed with one Welch segment length. */
export interface AnalysisOption {
    tf: TransferFunction;
    analysis: AnalysisProvenance;
    support?: FrequencySupport;
}

/** Bin spacing of a rung (Hz). */
export function binSpacingHz(a: AnalysisProvenance): number {
    return a.sampleRateHz / a.segmentSamples;
}

/** Effective spectral resolution of a Hann-windowed rung: its equivalent noise bandwidth (Hz). */
export function effectiveResolutionHz(a: AnalysisProvenance): number {
    return ADAPTIVE_RESOLUTION.hannEnbwBins * binSpacingHz(a);
}

/**
 * The Welch segment (power of two) whose bin spacing first reaches maxBinSpacingOfCrossover × fc, and
 * the window length (samples) that averages UNCERTAINTY.minWelchSegments of them at 50 % overlap.
 */
export function segmentNeededFor(
    crossoverHz: number,
    sampleRateHz: number,
): { segmentSamples: number; windowSamples: number } {
    const target = ADAPTIVE_RESOLUTION.maxBinSpacingOfCrossover * crossoverHz;
    let n = 256;
    while (sampleRateHz / n > target) n <<= 1;
    return { segmentSamples: n, windowSamples: (n * (UNCERTAINTY.minWelchSegments + 1)) / 2 };
}

/**
 * The rung to read the margins on: the shortest segment whose bin spacing is at most
 * maxBinSpacingOfCrossover × the standard analysis's crossover; without a crossover the standard rung;
 * when no rung reaches the target, the finest, with the shortfall named.
 */
export function chooseAnalysis(
    ladder: readonly AnalysisOption[],
    crossoverHz: number | null,
): { index: number; reasons: string[] } {
    if (!ladder.length) throw new Error("chooseAnalysis: empty ladder");
    const sorted = ladder.every((r, i) => i === 0 || r.analysis.segmentSamples > ladder[i - 1].analysis.segmentSamples);
    if (!sorted) throw new Error("chooseAnalysis: ladder must ascend in segment length");
    if (!(typeof crossoverHz === "number" && crossoverHz > 0)) {
        return { index: 0, reasons: ["resolution_target_unknown:no_crossover_on_standard_analysis"] };
    }
    const target = ADAPTIVE_RESOLUTION.maxBinSpacingOfCrossover * crossoverHz;
    const index = ladder.findIndex((r) => binSpacingHz(r.analysis) <= target * (1 + 1e-9));
    if (index >= 0) return { index, reasons: [] };
    const last = ladder[ladder.length - 1];
    const need = segmentNeededFor(crossoverHz, last.analysis.sampleRateHz);
    return {
        index: ladder.length - 1,
        reasons: [
            `resolution_target_not_reachable:needs_segment:${need.segmentSamples}:window_gives:${last.analysis.segmentSamples}`,
            `data_length_insufficient:needs_samples:${need.windowSamples}:have:${last.analysis.windowSamples}`,
        ],
    };
}

/** σ of the phase margin (degrees) from the loop's per-bin relative error at the bin nearest `fc`. */
function phaseMarginSigmaDeg(loop: AxisLoop, fc: number): number | null {
    const relErr = loop.uncertainty.relErr;
    if (!relErr) return null;
    let best: number | null = null;
    let dist = Infinity;
    for (const [f, e] of relErr) {
        const d = Math.abs(f - fc);
        if (d < dist) {
            dist = d;
            best = e;
        }
    }
    return best === null ? null : (best * 180) / Math.PI;
}

/**
 * Whether the margins read on rung `index` are converged against the next finer rung of the same
 * samples (H1). `probe` builds the loop and margins of one rung with the same controller, chain,
 * attestation and support as the final loop, without a qualification or a convergence verdict.
 */
export function resolutionConvergence(
    ladder: readonly AnalysisOption[],
    index: number,
    probe: (rung: AnalysisOption) => { loop: AxisLoop; margins: LoopMargins },
    chosenReasons: readonly string[] = [],
): ResolutionConvergence {
    const used = ladder[index];
    const base: Omit<ResolutionConvergence, "status" | "reasons"> = {
        usedSegmentSamples: used.analysis.segmentSamples,
        usedBinSpacingHz: binSpacingHz(used.analysis),
        effectiveResolutionHz: effectiveResolutionHz(used.analysis),
        checkedAgainstSegmentSamples: null,
        deltaCrossoverPct: null,
        deltaPhaseMarginDeg: null,
        phaseMarginSigmaDeg: null,
    };
    const unknown = (reason: string): ResolutionConvergence => ({
        ...base,
        status: "UNKNOWN",
        reasons: [...chosenReasons, reason],
    });
    const a = probe(used);
    const fc0 = a.margins.crossoverHz;
    const pm0 = a.margins.measured.phaseMarginDeg;
    if (fc0 === null || pm0 === null) return unknown("resolution_convergence_unknown:no_crossover_on_used_analysis");
    const finer = ladder[index + 1];
    if (!finer) {
        return unknown(
            `resolution_convergence_unknown:window_too_short_for_2x:${used.analysis.segmentSamples}:window:${used.analysis.windowSamples}`,
        );
    }
    const b = probe(finer);
    const fc1 = b.margins.crossoverHz;
    const pm1 = b.margins.measured.phaseMarginDeg;
    const checked = { ...base, checkedAgainstSegmentSamples: finer.analysis.segmentSamples };
    if (fc1 === null || pm1 === null) {
        return {
            ...checked,
            status: "UNKNOWN",
            reasons: [...chosenReasons, "resolution_convergence_unknown:finer_analysis_reads_no_crossover"],
        };
    }
    const dFc = (fc1 - fc0) / fc0;
    const dPm = pm1 - pm0;
    const sigma = phaseMarginSigmaDeg(a.loop, fc0);
    const pmLimit = Math.max(ADAPTIVE_RESOLUTION.minPhaseMarginChangeDeg, sigma === null ? 0 : 2 * sigma);
    const reasons = [...chosenReasons];
    if (Math.abs(dFc) > ADAPTIVE_RESOLUTION.maxCrossoverChange) {
        reasons.push(`resolution_not_converged:fc:${(100 * dFc).toFixed(1)}pct`);
    }
    if (Math.abs(dPm) > pmLimit) reasons.push(`resolution_not_converged:pm:${dPm.toFixed(1)}deg`);
    return {
        ...checked,
        status: reasons.length ? "NOT_CONVERGED" : "CONVERGED",
        deltaCrossoverPct: 100 * dFc,
        deltaPhaseMarginDeg: dPm,
        phaseMarginSigmaDeg: sigma,
        reasons,
    };
}
