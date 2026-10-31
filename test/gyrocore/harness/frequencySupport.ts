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
 * SIMULATION ONLY: declared frequency support for synthetic transfer functions (loopModel
 * FREQUENCY_SUPPORT). A contract test that is about something else (resolution, uncertainty, the
 * release gate) declares every bin of its analytic T as supported, as a real DEBUG_CHIRP log with a
 * full sweep would show; a support test declares exactly the defect it injects. This is test input,
 * never evidence about any flight.
 */

import type { TransferFunction } from "../../../src/js/blackbox/spectral_analysis";
import type { BinSupportVerdict, FrequencySupport } from "../../../src/gyrocore/engine/loopModel";
import type { SupportClass } from "../../../src/gyrocore/chirp/qualityV2/contract";

/**
 * The sweep the contract tests declare for their analytic grids (SIMULATION).
 * f0 below the lowest 0.5 Hz grid bin; duration leaves ≥1 whole Welch segment of dwell
 * through ~200 Hz on a 0.5 Hz grid (Grokbot F2: sub-segment dwell is UNKNOWN, never invent n=1).
 */
export const SIM_SWEEP = { f0Hz: 0.1, f1Hz: 400, durationS: 8000 };

/**
 * SIMULATION: sweep plus a matching analysed window (Codex Gate 1 2026-10-28). A sweep header
 * without a positive window is ambiguous in the engine; contract tests that need averages must
 * declare both.
 */
export function declaredMeasurement(
    o: {
        sweep?: { f0Hz: number; f1Hz: number; durationS: number };
        sampleRateHz?: number;
        segmentSamples?: number;
        segments?: number;
    } = {},
): {
    sweep: { f0Hz: number; f1Hz: number; durationS: number };
    analysis: { segmentSamples: number; sampleRateHz: number; windowSamples: number; segments: number };
} {
    const sweep = o.sweep ?? SIM_SWEEP;
    const sampleRateHz = o.sampleRateHz ?? 4000;
    const segmentSamples = o.segmentSamples ?? Math.round(sampleRateHz / 0.5);
    return {
        sweep,
        analysis: {
            segmentSamples,
            sampleRateHz,
            windowSamples: Math.max(1, Math.floor(sweep.durationS * sampleRateHz)),
            segments: o.segments ?? 32,
        },
    };
}

/**
 * Every bin of `tf` supported (COHERENT, γ²(excitation → setpoint) 0.999), the observed generator
 * range the whole grid above 0 Hz unless given. `except` overrides single bins (by frequency, to
 * 1e-6 Hz) with another verdict.
 */
export function declaredSupport(
    tf: TransferFunction,
    o: {
        observedHz?: [number, number] | null;
        except?: {
            hz: number;
            verdict: BinSupportVerdict;
            class?: SupportClass;
            excitationCoherence?: number | null;
        }[];
    } = {},
): FrequencySupport {
    const f = Array.from(tf.frequencies).filter((x) => x > 0);
    // Default: the generator swept the whole grid and on to SIM_SWEEP's end (no generator stop).
    const observedHz =
        o.observedHz === undefined
            ? ([f[0], Math.max(f[f.length - 1], SIM_SWEEP.f1Hz)] as [number, number])
            : o.observedHz;
    const bins: FrequencySupport["bins"] = new Map();
    for (const hz of f) {
        const inside = !observedHz || (hz >= observedHz[0] && hz <= observedHz[1]);
        const ex = o.except?.find((e) => Math.abs(e.hz - hz) < 1e-6);
        if (ex) {
            bins.set(hz, {
                class:
                    ex.class ??
                    (ex.verdict === "SUPPORTED"
                        ? "COHERENT"
                        : ex.verdict === "UNKNOWN"
                          ? "UNKNOWN"
                          : "INSUFFICIENT_SPECTRAL_SUPPORT"),
                excitationCoherence:
                    ex.excitationCoherence === undefined
                        ? ex.verdict === "UNKNOWN"
                            ? null
                            : 0.999
                        : ex.excitationCoherence,
                verdict: ex.verdict,
            });
        } else if (!inside) {
            bins.set(hz, { class: "OUTSIDE_OBSERVED_SWEEP", excitationCoherence: null, verdict: "UNSUPPORTED" });
        } else {
            bins.set(hz, { class: "COHERENT", excitationCoherence: 0.999, verdict: "SUPPORTED" });
        }
    }
    return { observedHz, bins };
}
