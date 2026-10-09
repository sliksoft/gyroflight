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
 * Human-readable text for GyroCore reason codes, with the measured values that
 * triggered them, so the UI can say exactly why a measurement was rejected or
 * why Apply is blocked. Unknown codes are shown as the code itself.
 */

import { i18n } from "@/js/localization";
import type { ChirpMeasurement } from "./qualification";

const SLIDER_LABEL_KEYS: Record<string, string> = {
    master_multiplier: "autotuneSliderMasterMultiplier",
    pi_gain: "autotuneSliderPIGain",
    i_gain: "autotuneSliderIGain",
    d_gain: "autotuneSliderDGain",
    feedforward_gain: "autotuneSliderFeedforward",
    dterm_filter_multiplier: "autotuneSliderDTermFilter",
};

function fmt(v: number | null | undefined, digits = 2): string {
    return typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "--";
}

function sliderLabel(name: string): string {
    const bare = name.replace(/^slider_/, "");
    const key = SLIDER_LABEL_KEYS[bare];
    const label = key ? i18n.getMessage(key) : bare;
    return label && label !== key ? label : bare;
}

function message(key: string, args: (string | number)[], fallback: string): string {
    const text = i18n.getMessage(key, args.map(String));
    return text && text !== key ? text : fallback;
}

function gateArgs(code: string, m: ChirpMeasurement | null | undefined): (string | number)[] {
    const g = m?.quality.gates.find((x) => x.code === code && (!x.passed || x.severity === "warning"));
    switch (code) {
        case "non_uniform_sampling":
            return [fmt((g?.value ?? 0) * 100, 1)];
        case "excessive_gaps":
            return [fmt((g?.value ?? 0) * 100, 2), m?.spacing.gapCount ?? "--"];
        case "low_coherence":
            return [fmt(g?.value), fmt(g?.threshold), g?.detail ?? ""];
        case "insufficient_excitation":
            return [fmt(g?.value), fmt(g?.threshold, 0)];
        case "insufficient_samples":
        case "unusable_frequency_range":
            return [g?.value ?? "--", g?.threshold ?? "--"];
        case "timestamp_gaps_present":
            return [m?.spacing.gapCount ?? "--"];
        case "invalid_sample_rate":
        case "sample_rate_crosscheck":
            return [m?.sampleRate.status ?? "--"];
        case "chirp_band_near_nyquist":
            return [fmt(g?.value, 1), fmt(g?.threshold, 1)];
        default:
            return [];
    }
}

/** One reason code as a sentence. `m` supplies the measured values where the code has them. */
export function describeReason(code: string, m?: ChirpMeasurement | null): string {
    const colon = code.indexOf(":");
    const head = colon >= 0 ? code.slice(0, colon) : code;
    const tail = colon >= 0 ? code.slice(colon + 1) : "";

    if (head === "log") {
        return message(`gyrocoreReason_log_${tail}`, [], code);
    }
    if (head === "measurement") {
        return message(`gyrocoreReason_${tail}`, gateArgs(tail, m), code);
    }
    if (head === "sample_rate_contract") {
        const rate = m?.sampleRate.effectiveRateHz;
        return message(
            `gyrocoreReason_sample_rate_contract_${tail}`,
            [fmt(m?.betaflightRateHz, 1), fmt(rate, 1), m?.sampleRate.status ?? "--"],
            code,
        );
    }
    if (head.startsWith("current_tune_")) {
        return message(`gyrocoreReason_${head}`, [sliderLabel(tail)], code);
    }
    if (head.startsWith("slider_clamp") || head === "slider_non_finite" || head === "slider_clamped") {
        const s = m?.recommendation?.guard.sliders.find((x) => x.slider === tail);
        return message(
            `gyrocoreReason_${head}`,
            [
                sliderLabel(tail),
                fmt(s?.current, 0),
                fmt(s?.requested, 1),
                s?.requestedDirection ?? "--",
                s?.proposed ?? "--",
                s?.proposedDirection ?? "--",
            ],
            code,
        );
    }
    const key = `gyrocoreReason_${code.replaceAll(":", "_")}`;
    return message(key, [], code);
}
