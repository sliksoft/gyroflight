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
 * The Apply Gains hard gate. Called by the Apply action itself
 * (useAutotune.applyGains) before any flight-controller access, so disabling
 * the button is not what keeps an unsafe tune off the craft.
 */

import type { GainRecommendation } from "@/js/blackbox/spectral_analysis";
import type { ApplyAuthorization, ChirpMeasurement, ChirpQualificationReport } from "./qualification";

type Proposed = GainRecommendation["proposed"];

export class ApplyBlockedError extends Error {
    readonly reasons: string[];

    constructor(reasons: string[]) {
        super(`Apply Gains blocked by GyroCore: ${reasons.join(", ")}`);
        this.name = "ApplyBlockedError";
        this.reasons = reasons;
    }
}

function sameProposal(a: Proposed, b: Proposed): boolean {
    const keys = Object.keys(b) as (keyof Proposed)[];
    return Object.keys(a).length === keys.length && keys.every((k) => a[k] === b[k]);
}

export function findMeasurement<G>(
    report: ChirpQualificationReport<G> | null,
    measurementId: string | null | undefined,
): ChirpMeasurement<G> | null {
    return report?.measurements.find((m) => m.id === measurementId) ?? null;
}

/**
 * Apply is allowed only for a measurement of the current analysis that passed
 * every gate, and only with exactly the sliders recommended for it.
 */
export function authorizeApply(
    report: ChirpQualificationReport | null,
    measurementId: string | null | undefined,
    proposed: Proposed | null | undefined,
): ApplyAuthorization {
    if (!report) {
        return { allowed: false, blocked: ["apply:no_qualified_analysis"], warnings: [] };
    }
    const m = findMeasurement(report, measurementId);
    if (!m) {
        return { allowed: false, blocked: ["apply:unknown_measurement"], warnings: [] };
    }
    if (!m.apply.allowed) {
        return m.apply;
    }
    if (!m.recommendation || !proposed || !sameProposal(proposed, m.recommendation.result.proposed)) {
        return { allowed: false, blocked: ["apply:sliders_differ_from_qualified_recommendation"], warnings: [] };
    }
    return m.apply;
}

export function assertApplyAuthorized(
    report: ChirpQualificationReport | null,
    measurementId: string | null | undefined,
    proposed: Proposed | null | undefined,
): ChirpMeasurement {
    const auth = authorizeApply(report, measurementId, proposed);
    const m = findMeasurement(report, measurementId);
    if (!auth.allowed || !m) {
        throw new ApplyBlockedError(auth.blocked.length ? auth.blocked : ["apply:not_authorized"]);
    }
    return m;
}

/**
 * The craft's live slider mode, read just before writing: the logged mode
 * qualified the measurement, but the write goes to whatever is connected now.
 */
export function liveSliderModeBlocks(livePidsMode: number | undefined | null, axis: number): string[] {
    if (livePidsMode === 0) {
        return ["fc:simplified_pids_mode_off"];
    }
    if (livePidsMode === 1 && axis === 2) {
        return ["fc:yaw_not_under_slider_control"];
    }
    if (livePidsMode !== 1 && livePidsMode !== 2) {
        return ["fc:simplified_pids_mode_unknown"];
    }
    return [];
}
