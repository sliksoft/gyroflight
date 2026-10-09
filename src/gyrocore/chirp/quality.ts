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
 * Measurement-validity gates for one CHIRP segment. Port of GyroCore quality.ts /
 * quality.py (d2e60f7): same gates, thresholds, codes and severities.
 *
 * The only change is where the spectra come from: GyroCore computed its own
 * Welch transfer function; here the gates read Betaflight's
 * (spectral_analysis.ts welchTransferFunction), which WU1 showed equal to
 * GyroCore's to ~1e-10. Betaflight does not return Sxx, but it zeroes the
 * coherence of every bin below the same 1e-20 Sxx floor GyroCore uses, so the
 * "Sxx >= floor and coherence >= 0.5" usable-bin test is unchanged.
 */

import type { TransferFunction } from "@/js/blackbox/spectral_analysis";
import { npMean } from "./numeric";
import type { SampleRateEvidence, TimestampSpacing } from "./sampleRate";

export const MIN_WELCH_SEGMENTS = 4;
export const MIN_EXCITATION_RMS = 5;
export const MAX_MISSING_SAMPLE_FRACTION = 0.01;
export const USABLE_COHERENCE_MIN = 0.5;
export const MIN_MEAN_BAND_COHERENCE = 0.6;
export const MEAN_COHERENCE_BAND_HZ: [number, number] = [5, 100];
export const MIN_USABLE_BINS = 8;
export const NYQUIST_GUARD_FRACTION = 0.9;
export const DEFAULT_ANALYSIS_BAND_HZ: [number, number] = [5, 100];

export type GateSeverity = "blocking" | "warning";

export interface QualityGate {
    code: string;
    passed: boolean;
    severity: GateSeverity;
    value: number | null;
    threshold: number | null;
    detail: string;
}

export interface QualityReport {
    usable: boolean;
    failedGates: string[];
    warningGates: string[];
    gates: QualityGate[];
    usableRangeHz: [number, number] | null;
    usableBinCount: number;
    analysisBandHz: [number, number];
    meanBandCoherence: number | null;
    inputRms: number;
}

function gate(
    code: string,
    passed: boolean,
    value: number | null,
    threshold: number | null,
    detail = "",
    severity: GateSeverity = "blocking",
): QualityGate {
    return { code, passed, severity, value, threshold, detail };
}

/** Python `f"{x:g}"` for the band edges quoted in gate details. */
function fmtG(x: number): string {
    if (Number.isInteger(x) && Math.abs(x) < 1e16) {
        return String(x);
    }
    const s = x.toPrecision(6);
    return s.includes("e") ? s : s.replace(/\.?0+$/, "");
}

export function preAnalysisGates(opts: {
    sampleCount: number;
    segmentSize: number | null;
    rate: SampleRateEvidence;
    spacing: TimestampSpacing;
}): QualityGate[] {
    const { rate, spacing } = opts;
    const gates = [
        gate(
            "invalid_sample_rate",
            rate.usable && rate.effectiveRateHz !== null && rate.effectiveRateHz > 0,
            rate.effectiveRateHz,
            null,
            rate.status,
        ),
        gate(
            "non_uniform_sampling",
            spacing.uniform,
            spacing.uniformFraction,
            0.9,
            "timestamp deltas outside +/-10% of the median",
        ),
        gate(
            "excessive_gaps",
            spacing.missingFraction <= MAX_MISSING_SAMPLE_FRACTION,
            spacing.missingFraction,
            MAX_MISSING_SAMPLE_FRACTION,
            `${spacing.gapCount} gaps, ~${spacing.missingSamplesEstimate} samples missing`,
        ),
        gate("timestamp_gaps_present", spacing.gapCount === 0, spacing.gapCount, 0, "", "warning"),
        gate("sample_rate_crosscheck", rate.status === "ok", rate.differencePercent, 5, rate.status, "warning"),
    ];
    if (opts.segmentSize !== null) {
        gates.push(
            gate(
                "insufficient_samples",
                opts.sampleCount >= opts.segmentSize,
                opts.sampleCount,
                opts.segmentSize,
                "segment shorter than the Welch segment",
            ),
        );
    }
    return gates;
}

export function analysisBand(
    chirpRangeHz: [number, number] | null,
    sampleRateHz: number,
): [[number, number], QualityGate[]] {
    const nyquist = sampleRateHz / 2;
    const gates: QualityGate[] = [];
    const [lo, top] = chirpRangeHz ?? DEFAULT_ANALYSIS_BAND_HZ;
    if (chirpRangeHz === null) {
        gates.push(gate("chirp_band_unknown_default_used", false, null, null, "", "warning"));
    } else if (top > NYQUIST_GUARD_FRACTION * nyquist) {
        gates.push(gate("chirp_band_near_nyquist", false, top, NYQUIST_GUARD_FRACTION * nyquist, "", "warning"));
    }
    return [[lo, Math.min(top, NYQUIST_GUARD_FRACTION * nyquist)], gates];
}

function inputRms(x: ArrayLike<number>): number {
    if (!x.length) {
        return 0;
    }
    const mean = npMean(x);
    const sq = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) {
        const d = x[i] - mean;
        sq[i] = d * d;
    }
    return Math.sqrt(npMean(sq));
}

export function postAnalysisReport(opts: {
    gates: QualityGate[];
    tf: TransferFunction | null;
    sampleRateHz: number | null;
    inputSignal: ArrayLike<number>;
    bandHz: [number, number];
}): QualityReport {
    const rms = inputRms(opts.inputSignal);
    const gates = opts.gates.slice();
    gates.push(gate("insufficient_excitation", rms >= MIN_EXCITATION_RMS, rms, MIN_EXCITATION_RMS, "setpoint RMS"));
    const band = opts.bandHz;
    const tf = opts.tf;
    if (tf === null || opts.sampleRateHz === null) {
        return finish(gates, 0, null, band, null, rms);
    }

    gates.push(
        gate(
            "insufficient_samples",
            tf.numSegments >= MIN_WELCH_SEGMENTS,
            tf.numSegments,
            MIN_WELCH_SEGMENTS,
            "too few Welch segments for a meaningful coherence estimate",
        ),
    );
    const f = tf.frequencies;
    let cohLo = Math.max(MEAN_COHERENCE_BAND_HZ[0], band[0]);
    let cohHi = Math.min(MEAN_COHERENCE_BAND_HZ[1], band[1]);
    if (cohHi <= cohLo) {
        [cohLo, cohHi] = band;
    }
    const cohBins: number[] = [];
    for (let k = 0; k < f.length; k++) {
        if (f[k] >= cohLo && f[k] <= cohHi) {
            cohBins.push(tf.coherence[k]);
        }
    }
    const meanCoh = cohBins.length ? npMean(cohBins) : null;
    gates.push(
        gate(
            "low_coherence",
            meanCoh !== null && meanCoh >= MIN_MEAN_BAND_COHERENCE,
            meanCoh,
            MIN_MEAN_BAND_COHERENCE,
            `mean coherence over ${fmtG(cohLo)}-${fmtG(cohHi)} Hz`,
        ),
    );
    const nyquist = opts.sampleRateHz / 2;
    let count = 0;
    let uMin = Infinity;
    let uMax = -Infinity;
    for (let k = 0; k < f.length; k++) {
        const fk = f[k];
        const inBand = fk >= band[0] && fk <= band[1] && fk > 0 && fk < nyquist;
        // Betaflight marks bins below its Sxx floor with magnitude -Infinity and coherence 0.
        if (inBand && Number.isFinite(tf.magnitude[k]) && tf.coherence[k] >= USABLE_COHERENCE_MIN) {
            count++;
            uMin = Math.min(uMin, fk);
            uMax = Math.max(uMax, fk);
        }
    }
    gates.push(gate("unusable_frequency_range", count >= MIN_USABLE_BINS, count, MIN_USABLE_BINS));
    return finish(gates, count, count ? [uMin, uMax] : null, band, meanCoh, rms);
}

function finish(
    gates: QualityGate[],
    usableBinCount: number,
    usableRangeHz: [number, number] | null,
    band: [number, number],
    meanBandCoherence: number | null,
    rms: number,
): QualityReport {
    const blocking = gates.filter((g) => g.severity === "blocking");
    return {
        usable: blocking.every((g) => g.passed),
        failedGates: [...new Set(blocking.filter((g) => !g.passed).map((g) => g.code))],
        warningGates: gates.filter((g) => g.severity === "warning" && !g.passed).map((g) => g.code),
        gates,
        usableRangeHz,
        usableBinCount,
        analysisBandHz: [band[0], band[1]],
        meanBandCoherence,
        inputRms: rms,
    };
}
