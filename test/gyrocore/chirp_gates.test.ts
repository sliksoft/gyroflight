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
 * WU2 unit tests for each GyroCore gate on its own: timing, sample rate,
 * measurement quality, current tune, and the slider-translation guard.
 */

import { describe, expect, it } from "vitest";
import type { GainRecommendation, TransferFunction } from "../../src/js/blackbox/spectral_analysis";
import { currentTuneGates } from "../../src/gyrocore/chirp/currentTune";
import { parseLoggedHeaders } from "../../src/gyrocore/chirp/headers";
import { analysisBand, postAnalysisReport, preAnalysisGates } from "../../src/gyrocore/chirp/quality";
import { guardRecommendation } from "../../src/gyrocore/chirp/recommendationGuard";
import { analyzeTimestampSpacing, resolveChirpSampleRate } from "../../src/gyrocore/chirp/sampleRate";
import { liveSliderModeBlocks } from "../../src/gyrocore/chirp/applyGate";
import messages from "../../src/gyroflight/locales/en.json";

const ts = (n: number, dt = 1000, at?: (i: number) => number) =>
    Float64Array.from({ length: n }, (_, i) => (at ? at(i) : i * dt));
const RATE_1K = { looptimeUs: 125, pidProcessDenom: 8, frameIntervalPNum: 1, frameIntervalPDenom: 1 };

function headers(lines: string[]) {
    return parseLoggedHeaders(lines.map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1)]));
}

describe("timestamp spacing", () => {
    it("uniform timing has no gaps", () => {
        const s = analyzeTimestampSpacing(ts(2000));
        expect(s).toMatchObject({ uniform: true, gapCount: 0, missingSamplesEstimate: 0, nonPositiveDeltas: 0 });
    });

    it("counts gaps and missing samples", () => {
        // 30 gaps of 4 missing samples each.
        const times = ts(2000, 1000, (i) => (i + 4 * Math.min(30, Math.floor(i / 60))) * 1000);
        const s = analyzeTimestampSpacing(times);
        expect(s.gapCount).toBe(30);
        expect(s.missingSamplesEstimate).toBe(120);
        expect(s.missingFraction).toBeCloseTo(120 / 2120, 12);
        const [rate] = [resolveChirpSampleRate(RATE_1K, times)];
        const gates = preAnalysisGates({ sampleCount: 2000, segmentSize: 512, rate, spacing: s });
        expect(gates.find((g) => g.code === "excessive_gaps")?.passed).toBe(false);
        expect(gates.find((g) => g.code === "timestamp_gaps_present")).toMatchObject({
            passed: false,
            severity: "warning",
        });
    });

    it("time running backwards is non-uniform", () => {
        const times = ts(100);
        times[50] = times[49] - 10;
        const s = analyzeTimestampSpacing(times);
        expect(s.nonPositiveDeltas).toBe(1);
        expect(s.uniform).toBe(false);
    });
});

describe("sample rate resolution", () => {
    it("header confirmed by timestamps", () => {
        expect(resolveChirpSampleRate(RATE_1K, ts(100))).toMatchObject({ status: "ok", effectiveRateHz: 1000 });
    });

    it("mismatch takes the timestamp rate", () => {
        const r = resolveChirpSampleRate(RATE_1K, ts(100, 500));
        expect(r).toMatchObject({ status: "mismatch", effectiveRateHz: 2000, headerRateHz: 1000 });
    });

    it("missing headers: timestamps only", () => {
        const none = { looptimeUs: null, pidProcessDenom: null, frameIntervalPNum: null, frameIntervalPDenom: null };
        expect(resolveChirpSampleRate(none, ts(100))).toMatchObject({ status: "timestamp_only", usable: true });
    });

    it("nothing trustworthy is invalid_sample_rate", () => {
        const none = { looptimeUs: null, pidProcessDenom: null, frameIntervalPNum: null, frameIntervalPDenom: null };
        const rate = resolveChirpSampleRate(none, ts(1));
        expect(rate).toMatchObject({ status: "unusable", usable: false, effectiveRateHz: null });
        const gates = preAnalysisGates({
            sampleCount: 1,
            segmentSize: null,
            rate,
            spacing: analyzeTimestampSpacing(ts(1)),
        });
        expect(gates.find((g) => g.code === "invalid_sample_rate")?.passed).toBe(false);
    });
});

describe("measurement quality", () => {
    function tf(coherence: number, n = 257, fs = 1000): TransferFunction {
        const frequencies = Float64Array.from({ length: n }, (_, k) => (k * fs) / (2 * (n - 1)));
        return {
            frequencies,
            magnitude: new Float64Array(n),
            phase: new Float64Array(n),
            coherence: new Float64Array(n).fill(coherence),
            hReal: new Float64Array(n).fill(1),
            hImag: new Float64Array(n),
            numSegments: 10,
        };
    }
    const strong = Float64Array.from({ length: 1000 }, (_, i) => 100 * Math.sin(i / 7));

    it("passes a coherent, well-excited sweep", () => {
        const q = postAnalysisReport({
            gates: [],
            tf: tf(0.95),
            sampleRateHz: 1000,
            inputSignal: strong,
            bandHz: [5, 100],
        });
        expect(q.usable).toBe(true);
        expect(q.meanBandCoherence).toBeCloseTo(0.95, 12);
    });

    it("low coherence and no usable bins", () => {
        const q = postAnalysisReport({
            gates: [],
            tf: tf(0.4),
            sampleRateHz: 1000,
            inputSignal: strong,
            bandHz: [5, 100],
        });
        expect(q.failedGates).toEqual(["low_coherence", "unusable_frequency_range"]);
    });

    it("Betaflight's below-floor bins (magnitude -Infinity) are not usable", () => {
        const t = tf(0.95);
        t.magnitude.fill(-Infinity);
        const q = postAnalysisReport({ gates: [], tf: t, sampleRateHz: 1000, inputSignal: strong, bandHz: [5, 100] });
        expect(q.usableBinCount).toBe(0);
        expect(q.failedGates).toContain("unusable_frequency_range");
    });

    it("weak excitation", () => {
        const weak = strong.map((x) => x / 100);
        const q = postAnalysisReport({
            gates: [],
            tf: tf(0.95),
            sampleRateHz: 1000,
            inputSignal: weak,
            bandHz: [5, 100],
        });
        expect(q.failedGates).toEqual(["insufficient_excitation"]);
    });

    it("too few Welch segments", () => {
        const t = tf(0.95);
        t.numSegments = 3;
        const q = postAnalysisReport({ gates: [], tf: t, sampleRateHz: 1000, inputSignal: strong, bandHz: [5, 100] });
        expect(q.failedGates).toEqual(["insufficient_samples"]);
    });

    it("band near Nyquist or unknown is a warning, not a block", () => {
        expect(analysisBand([2, 480], 1000)[1].map((g) => [g.code, g.severity])).toEqual([
            ["chirp_band_near_nyquist", "warning"],
        ]);
        expect(analysisBand(null, 1000)[1].map((g) => g.code)).toEqual(["chirp_band_unknown_default_used"]);
    });
});

describe("current tune", () => {
    const SLIDERS = [
        "simplified_master_multiplier:100",
        "simplified_pi_gain:100",
        "simplified_i_gain:100",
        "simplified_d_gain:100",
        "simplified_feedforward_gain:100",
        "simplified_dterm_filter_multiplier:100",
        "simplified_dterm_filter:1",
    ];

    it("slider mode RPY with every slider logged is eligible", () => {
        expect(currentTuneGates(headers([...SLIDERS, "simplified_pids_mode:2"]), 2).blocked).toEqual([]);
    });

    it("mode OFF blocks; RP blocks yaw only; unknown blocks", () => {
        expect(currentTuneGates(headers([...SLIDERS, "simplified_pids_mode:0"]), 0).blocked).toEqual([
            "simplified_pids_mode_off",
        ]);
        expect(currentTuneGates(headers([...SLIDERS, "simplified_pids_mode:1"]), 0).blocked).toEqual([]);
        expect(currentTuneGates(headers([...SLIDERS, "simplified_pids_mode:1"]), 2).blocked).toEqual([
            "yaw_not_under_slider_control",
        ]);
        expect(currentTuneGates(headers(SLIDERS), 0).blocked).toEqual(["simplified_pids_mode_unknown"]);
    });

    it("a missing, unreadable or zero slider is never silently replaced by 100", () => {
        const lines = [
            ...SLIDERS.filter((l) => !l.startsWith("simplified_pi_gain") && !l.startsWith("simplified_i_gain:")),
            "simplified_i_gain:x",
            "simplified_d_gain:0",
            "simplified_pids_mode:2",
        ];
        expect(currentTuneGates(headers(lines), 0).blocked).toEqual([
            "current_tune_missing:pi_gain",
            "current_tune_unparseable:i_gain",
            "current_tune_zero:d_gain",
        ]);
    });

    it("live craft slider mode", () => {
        expect(liveSliderModeBlocks(2, 2)).toEqual([]);
        expect(liveSliderModeBlocks(0, 0)).toEqual(["fc:simplified_pids_mode_off"]);
        expect(liveSliderModeBlocks(1, 2)).toEqual(["fc:yaw_not_under_slider_control"]);
        expect(liveSliderModeBlocks(undefined, 0)).toEqual(["fc:simplified_pids_mode_unknown"]);
    });
});

describe("slider translation guard", () => {
    const current = {
        masterMultiplier: 1,
        piGain: 1,
        iGain: 1,
        dGain: 1,
        feedforwardGain: 1,
        dtermFilterMultiplier: 1,
    };
    function rec(scales: Record<string, number | boolean>, proposed: Partial<GainRecommendation["proposed"]>) {
        return {
            proposed: {
                slider_master_multiplier: 100,
                slider_pi_gain: 100,
                slider_i_gain: 100,
                slider_d_gain: 100,
                slider_feedforward_gain: 100,
                slider_dterm_filter_multiplier: 100,
                ...proposed,
            },
            analysis: {
                piScale: 1,
                iScale: 1,
                dScale: 1,
                ffScale: 1,
                filterScale: 1,
                sensitivityUnreachable: false,
                sensitivityBinds: false,
                gainClamped: false,
                targetCrossoverHz: 50,
                openLoopCrossoverHz: 40,
                ...scales,
            },
        } as unknown as GainRecommendation;
    }

    it("an unclamped proposal passes", () => {
        const g = guardRecommendation(
            current,
            rec({ piScale: 1.2, ffScale: 1.2 }, { slider_pi_gain: 120, slider_feedforward_gain: 120 }),
        );
        expect(g.blocked).toEqual([]);
    });

    it("a reduction turned into an increase blocks, with the values recorded", () => {
        const g = guardRecommendation(
            { ...current, feedforwardGain: 0.15 },
            rec({ ffScale: 0.6 }, { slider_feedforward_gain: 25 }),
        );
        expect(g.blocked).toEqual(["slider_clamp_changes_direction:slider_feedforward_gain"]);
        expect(g.sliders.find((s) => s.slider === "slider_feedforward_gain")).toMatchObject({
            current: 15,
            requested: 9,
            proposed: 25,
            requestedDirection: "decrease",
            proposedDirection: "increase",
            directionChanged: true,
        });
    });

    it("a requested change the clamp cancels or truncates materially blocks", () => {
        // Asked 25 -> 12.5: the floor keeps 25 (no change at all).
        expect(
            guardRecommendation({ ...current, piGain: 0.25 }, rec({ piScale: 0.5 }, { slider_pi_gain: 25 })).blocked,
        ).toEqual(["slider_clamp_changes_direction:slider_pi_gain"]);
        // Asked 200 -> 300: the ceiling gives 250, 50 points short.
        expect(
            guardRecommendation({ ...current, piGain: 2 }, rec({ piScale: 1.5 }, { slider_pi_gain: 250 })).blocked,
        ).toEqual(["slider_clamp_material:slider_pi_gain"]);
    });

    it("a same-direction change the clamp inflates beyond rounding blocks", () => {
        // FF 15 asked to go to 20.7 (+38 %); the floor gives 25 (+67 %).
        expect(
            guardRecommendation(
                { ...current, feedforwardGain: 0.15 },
                rec({ ffScale: 1.38 }, { slider_feedforward_gain: 25 }),
            ).blocked,
        ).toEqual(["slider_clamp_material:slider_feedforward_gain"]);
        // A clamp within integer rounding (24.6 -> 25) only warns.
        const g = guardRecommendation(
            { ...current, feedforwardGain: 0.15 },
            rec({ ffScale: 1.64 }, { slider_feedforward_gain: 25 }),
        );
        expect(g.blocked).toEqual([]);
        expect(g.warnings).toEqual(["slider_clamped:slider_feedforward_gain"]);
    });

    it("a held slider the clamp moves blocks", () => {
        // master multiplier 20 is outside 25..250: Betaflight would silently raise it.
        expect(
            guardRecommendation({ ...current, masterMultiplier: 0.2 }, rec({}, { slider_master_multiplier: 25 }))
                .blocked,
        ).toEqual(["slider_clamp_changes_direction:slider_master_multiplier"]);
    });

    it("an unreachable robustness bound blocks; other Betaflight notes warn", () => {
        const g = guardRecommendation(
            current,
            rec({ sensitivityUnreachable: true, gainClamped: true, targetCrossoverHz: Number.NaN }, {}),
        );
        expect(g.blocked).toEqual(["autotune_sensitivity_bound_unreachable"]);
        expect(g.warnings).toEqual(["autotune_target_margin_unreachable_gain_held", "autotune_gain_clamped_per_pass"]);
    });
});

describe("every reason code has an English explanation", () => {
    const keys = new Set(Object.keys(messages));
    const MEASUREMENT = [
        "invalid_sample_rate",
        "non_uniform_sampling",
        "excessive_gaps",
        "timestamp_gaps_present",
        "sample_rate_crosscheck",
        "insufficient_samples",
        "insufficient_excitation",
        "low_coherence",
        "unusable_frequency_range",
        "no_transfer_function",
        "chirp_band_unknown_default_used",
        "chirp_band_near_nyquist",
    ];
    const OTHER = [
        ...[
            "ok",
            "mismatch",
            "timestamp_only",
            "header_only",
            "unusable",
            "unknown",
            "betaflight_header_rate_differs",
        ].map((s) => `sample_rate_contract_${s}`),
        "current_tune_missing",
        "current_tune_unparseable",
        "current_tune_zero",
        "simplified_pids_mode_off",
        "simplified_pids_mode_unknown",
        "yaw_not_under_slider_control",
        "simplified_dterm_filter_unknown",
        "simplified_dterm_filter_off",
        "recommendation_not_produced",
        "slider_clamp_changes_direction",
        "slider_clamp_material",
        "slider_non_finite",
        "slider_clamped",
        "autotune_sensitivity_bound_unreachable",
        "autotune_sensitivity_bound_binds",
        "autotune_target_margin_unreachable_gain_held",
        "autotune_no_open_loop_crossover",
        "autotune_gain_clamped_per_pass",
        "apply_no_qualified_analysis",
        "apply_unknown_measurement",
        "apply_sliders_differ_from_qualified_recommendation",
        "apply_not_authorized",
        "fc_simplified_pids_mode_off",
        "fc_simplified_pids_mode_unknown",
        "fc_yaw_not_under_slider_control",
        ...[
            "malformed_rows_skipped",
            "flight_mode_flags_column_missing",
            "chirp_mode_flag_unavailable_debug_axis_only",
            "chirp_frequency_range_missing",
            "chirp_axis_out_of_range_frames_dropped",
        ].map((w) => `log_${w}`),
    ];
    for (const code of [...MEASUREMENT, ...OTHER]) {
        it(code, () => {
            expect(keys.has(`gyrocoreReason_${code}`)).toBe(true);
        });
    }
});
