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
 * The compact CHIRP Quality V2 summary the Autotune panel shows: one row per
 * topic with a status word and the measured detail. Display only.
 */

import type { Availability, BinStatus, ChirpQualityV2, EvidenceLevels } from "./contract";

export type RowTone = "good" | "warn" | "bad" | "unknown" | "neutral";

export interface QualityRow {
    /** Stable id for tests and data attributes. */
    id: string;
    /** i18n key of the row label. */
    label: string;
    /** Status word shown as a badge (an availability, a level or an evidence status). */
    status: string;
    tone: RowTone;
    /** Measured detail, already formatted; empty when there is none. */
    detail: string;
}

function fmt(v: number | null | undefined, digits = 2): string {
    return typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "--";
}

function hz(v: number | null | undefined): string {
    return typeof v === "number" && Number.isFinite(v) ? `${v < 10 ? v.toFixed(1) : Math.round(v)} Hz` : "--";
}

function range(lo: number | null | undefined, hi: number | null | undefined): string {
    return lo === null || lo === undefined || hi === null || hi === undefined ? "--" : `${hz(lo)}–${hz(hi)}`;
}

function pct(v: number | null | undefined): string {
    return typeof v === "number" && Number.isFinite(v) ? `${Math.round(v * 100)} %` : "--";
}

const availabilityTone = (a: Availability): RowTone =>
    a === "MEASURED" ? "good" : a === "NOT_APPLICABLE" ? "neutral" : "unknown";

/** i18n lookup with $1.. arguments (i18n.getMessage in the app). */
export type Translate = (key: string, args?: (string | number)[]) => string;

export function qualityRows(v: ChirpQualityV2, t: Translate): QualityRow[] {
    const s = v.sweep;
    const e = v.excitation;
    const c = v.coherence;
    const g = v.sampleGaps;
    const sat = v.saturation;
    const usable = c.usableBinCount.value;
    const inBand = c.bins.status.filter((x) => x !== "OUTSIDE_ANALYSIS_BAND").length;

    const sweepParts = [
        t("gyrocoreQv2DetailRequested", [range(s.requested.startHz, s.requested.endHz)]),
        t("gyrocoreQv2DetailObserved", [range(s.observed.startHz, s.observed.endHz)]),
    ];
    if (s.observed.runs !== null && s.observed.runs > 1) {
        sweepParts.push(t("gyrocoreQv2DetailRuns", [s.observed.runs]));
    }

    return [
        {
            id: "detection",
            label: "gyrocoreQv2RowDetection",
            status: v.levels.chirpDetected.status === "YES" ? "FOUND" : "NOT_FOUND",
            tone: v.levels.chirpDetected.status === "YES" ? "good" : "bad",
            detail: t("gyrocoreQv2DetailDetection", [v.identity.sampleCount, fmt(v.identity.durationS)]),
        },
        {
            id: "sweep",
            label: "gyrocoreQv2RowSweep",
            status: s.observed.availability,
            tone: availabilityTone(s.observed.availability),
            detail: sweepParts.join(" · "),
        },
        {
            id: "coverage",
            label: "gyrocoreQv2RowCoverage",
            status: s.usable.availability,
            tone:
                s.usable.availability === "MEASURED" && !s.usable.binCount
                    ? "bad"
                    : availabilityTone(s.usable.availability),
            detail: t("gyrocoreQv2DetailCoverage", [
                range(s.usable.startHz, s.usable.endHz),
                pct(s.observedOfRequested.value),
            ]),
        },
        {
            id: "excitation",
            label: "gyrocoreQv2RowExcitation",
            status: e.setpointRms.availability,
            tone: availabilityTone(e.setpointRms.availability),
            detail:
                t("gyrocoreQv2DetailExcitation", [fmt(e.setpointRms.value, 1), fmt(e.gyroRms.value, 1)]) +
                (e.noInputPowerBins.value ? ` · ${t("gyrocoreQv2DetailNoInput", [e.noInputPowerBins.value])}` : ""),
        },
        {
            id: "coherence",
            label: "gyrocoreQv2RowCoherence",
            status: c.meanBandCoherence.availability,
            // Judged only by the existing low_coherence criterion, so a measured but failing value is not green.
            tone:
                c.meanBandCoherence.value === null
                    ? availabilityTone(c.meanBandCoherence.availability)
                    : c.meanBandCoherence.value >= c.criteria.meanBandCoherenceMin
                      ? "good"
                      : "bad",
            detail: t("gyrocoreQv2DetailCoherence", [
                fmt(c.meanBandCoherence.value),
                c.criteria.meanBandHz[0],
                c.criteria.meanBandHz[1],
            ]),
        },
        {
            id: "usable-bins",
            label: "gyrocoreQv2RowUsableBins",
            status: usable === null ? c.usableBinCount.availability : String(usable),
            tone: usable === null ? "unknown" : usable >= c.criteria.minUsableBins ? "good" : "bad",
            detail: usable === null ? "" : t("gyrocoreQv2DetailUsableBins", [inBand]),
        },
        {
            id: "sample-gaps",
            label: "gyrocoreQv2RowSampleGaps",
            status: g.status,
            tone: g.status === "NONE" ? "good" : g.status === "DETECTED" ? "warn" : "unknown",
            detail:
                g.status === "UNKNOWN"
                    ? ""
                    : t("gyrocoreQv2DetailGaps", [
                          g.gapCount ?? "--",
                          g.missingSamplesEstimate ?? "--",
                          pct(g.missingFraction),
                      ]),
        },
        {
            id: "contamination",
            label: "gyrocoreQv2RowContamination",
            status: v.contamination.status,
            tone:
                v.contamination.status === "DETECTED"
                    ? "warn"
                    : v.contamination.status === "UNKNOWN"
                      ? "unknown"
                      : "good",
            detail: "",
        },
        {
            id: "saturation",
            label: "gyrocoreQv2RowSaturation",
            status: sat.status,
            tone: sat.status === "DETECTED" ? "warn" : sat.status === "UNKNOWN" ? "unknown" : "good",
            detail:
                sat.status === "UNKNOWN"
                    ? ""
                    : t("gyrocoreQv2DetailSaturation", [
                          sat.motorUpper.value?.samples ?? "--",
                          sat.motorLower.value?.samples ?? "--",
                      ]),
        },
    ];
}

export const LEVEL_ORDER: (keyof EvidenceLevels)[] = [
    "bblValid",
    "flightValid",
    "blackboxDataUsable",
    "chirpDetected",
    "chirpQualityAvailable",
    "chirpQualified",
    "tuningAuthorized",
];

export const BIN_STATUS_ORDER: BinStatus[] = ["USABLE", "WEAK_COHERENCE", "NO_INPUT_POWER", "OUTSIDE_ANALYSIS_BAND"];

/** Log-frequency plot geometry for the coherence chart; null without measured bins. */
export function coherencePlot(v: ChirpQualityV2, width: number, height: number) {
    const b = v.coherence.bins;
    if (b.availability !== "MEASURED" || !b.frequencyHz.length) {
        return null;
    }
    const lo = b.frequencyHz[0];
    const hi = b.frequencyHz[b.frequencyHz.length - 1];
    const span = Math.log10(hi / lo) || 1;
    const x = (f: number) => (Math.log10(f / lo) / span) * width;
    const y = (c: number) => height - Math.max(0, Math.min(1, c)) * height;
    const ticks = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000].filter((t) => t >= lo && t <= hi);
    return {
        bars: b.frequencyHz.map((f, i) => ({
            x: x(f),
            y: y(b.coherence[i]),
            frequencyHz: f,
            coherence: b.coherence[i],
            status: b.status[i],
        })),
        ticks: ticks.map((t) => ({ x: x(t), label: t >= 1000 ? `${t / 1000}k` : String(t) })),
        thresholdY: y(v.coherence.criteria.usableBinCoherenceMin),
    };
}
