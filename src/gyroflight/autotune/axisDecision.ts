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

import type { AutotuneV2Result } from "@/gyrocore/engine/autotuneV2";
import type { AutotuneSection } from "./sections";

export type Axis = "roll" | "pitch" | "yaw";
export const AXES: Axis[] = ["roll", "pitch", "yaw"];

export interface AxisDecisionText {
    axis: Axis;
    kind: "record" | "search_limit" | "candidate" | "none";
    /** One plain sentence: why there is (no) proposal for this axis. */
    summary: string;
    /** The deciding check as the engine states it (rule, value, threshold), for the expandable details. */
    technical: string;
    /** The recording plan's own note for the axis. */
    note: string;
    next: string;
    section: AutotuneSection | null;
}

type Translate = (key: string, params?: (string | number)[]) => string;

/**
 * Per axis, the recording plan's decision (recordingInstruction.ts) in words: a short summary for
 * the reader and the engine's deciding check kept apart for the technical details. Reads the result
 * only; nothing is decided here.
 */
export function axisDecisionTexts(result: AutotuneV2Result | null, t: Translate): AxisDecisionText[] {
    return AXES.map((axis) => {
        const ax = result?.recordingPlan?.axes.find((a) => a.axis === axis) ?? null;
        if (!ax) {
            const none = t("gyroflightOverviewNoDecision");
            return { axis, kind: "none", summary: none, technical: "", note: "", next: "", section: null };
        }
        const tr = ax.trigger;
        const value = tr?.value === null || tr?.value === undefined ? "unknown" : String(tr.value);
        // Assembled here, not through i18n parameters: those are HTML-escaped ("P/I/D" would show as "P&#x2F;I…").
        const technical = tr?.rule
            ? `${tr.route} · ${tr.status} — ${tr.rule}: ${value}; ${t("gyroflightOverviewRequired")} ${tr.threshold ?? "--"}`
            : "";
        const summary =
            ax.kind === "record"
                ? t("gyroflightAxisSummaryRecord")
                : ax.kind === "search_limit"
                  ? t(
                        tr?.status === "search_constrained_by_verified_tune"
                            ? "gyroflightAxisSummaryVerifiedTune"
                            : "gyroflightAxisSummarySearchLimit",
                    )
                  : t(
                        tr?.status === "no_change_needed"
                            ? "gyroflightAxisSummaryNoChange"
                            : "gyroflightAxisSummaryCandidate",
                    );
        const next =
            ax.kind === "record"
                ? t("gyroflightOverviewNextRecord")
                : ax.kind === "search_limit"
                  ? t("gyroflightOverviewNextSearchLimit")
                  : t("gyroflightOverviewNextCandidate");
        const section: AutotuneSection =
            ax.kind === "record" ? "plan" : ax.kind === "candidate" ? "tuning" : "technical";
        return { axis, kind: ax.kind, summary, technical, note: ax.note, next, section };
    });
}
