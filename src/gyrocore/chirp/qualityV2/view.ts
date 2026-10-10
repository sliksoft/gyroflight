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

import type {
    BinStatus,
    ChirpQualityV2,
    EvidenceLevels,
    Level,
    QualityTopic,
    TopicVerdictV2,
    Verdict,
} from "./contract";

export type RowTone = "good" | "warn" | "bad" | "neutral";

export interface QualityRow {
    /** Stable id for tests and data attributes. */
    id: string;
    /** i18n key of the row label. */
    label: string;
    /** What was measured: an availability, a count or an evidence status. Always shown neutral. */
    status: string;
    /** The quality judgement, from an existing gate or a documented diagnostic finding only. */
    verdict: Verdict;
    verdictBasis: TopicVerdictV2["basis"];
    /** Colour of the verdict badge; follows the verdict alone, never the availability. */
    tone: RowTone;
    /** Measured detail, already formatted; empty when there is none. */
    detail: string;
    /** The existing criterion behind the verdict ("minimum 5"), or empty. */
    criterion: string;
}

const VERDICT_TONE: Record<Verdict, RowTone> = { PASS: "good", FAIL: "bad", WARNING: "warn", NOT_EVALUATED: "neutral" };

/** Badge tone of an evidence level: only an existing gate (ACTIVE_GATE) is coloured. */
export function levelTone(l: Level): RowTone {
    if (l.role !== "ACTIVE_GATE" || l.status === "UNKNOWN") {
        return "neutral";
    }
    return l.status === "YES" ? "good" : "bad";
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

    const row = (id: string, topic: QualityTopic, label: string, status: string, detail: string): QualityRow => {
        const vd = v.verdicts[topic];
        return {
            id,
            label,
            status,
            verdict: vd.verdict,
            verdictBasis: vd.basis,
            tone: VERDICT_TONE[vd.verdict],
            detail,
            criterion: criterion(vd, t),
        };
    };

    return [
        row(
            "detection",
            "detection",
            "gyrocoreQv2RowDetection",
            v.levels.chirpDetected.status === "YES" ? "FOUND" : "NOT_FOUND",
            t("gyrocoreQv2DetailDetection", [v.identity.sampleCount, fmt(v.identity.durationS)]),
        ),
        row("sweep", "sweep", "gyrocoreQv2RowSweep", s.observed.availability, sweepParts.join(" · ")),
        row(
            "coverage",
            "coverage",
            "gyrocoreQv2RowCoverage",
            s.usable.availability,
            t("gyrocoreQv2DetailCoverage", [range(s.usable.startHz, s.usable.endHz), pct(s.observedOfRequested.value)]),
        ),
        row(
            "excitation",
            "excitation",
            "gyrocoreQv2RowExcitation",
            e.setpointRms.availability,
            t("gyrocoreQv2DetailExcitation", [fmt(e.setpointRms.value, 1), fmt(e.gyroRms.value, 1)]) +
                (e.noInputPowerBins.value ? ` · ${t("gyrocoreQv2DetailNoInput", [e.noInputPowerBins.value])}` : ""),
        ),
        row(
            "coherence",
            "coherence",
            "gyrocoreQv2RowCoherence",
            c.meanBandCoherence.availability,
            t("gyrocoreQv2DetailCoherence", [
                fmt(c.meanBandCoherence.value),
                c.criteria.meanBandHz[0],
                c.criteria.meanBandHz[1],
            ]),
        ),
        row(
            "usable-bins",
            "usableBins",
            "gyrocoreQv2RowUsableBins",
            usable === null ? c.usableBinCount.availability : String(usable),
            usable === null ? "" : t("gyrocoreQv2DetailUsableBins", [inBand]),
        ),
        row(
            "sample-gaps",
            "sampleGaps",
            "gyrocoreQv2RowSampleGaps",
            g.status,
            g.status === "UNKNOWN"
                ? ""
                : t("gyrocoreQv2DetailGaps", [
                      g.gapCount ?? "--",
                      g.missingSamplesEstimate ?? "--",
                      pct(g.missingFraction),
                  ]),
        ),
        row("contamination", "contamination", "gyrocoreQv2RowContamination", v.contamination.status, ""),
        row(
            "saturation",
            "saturation",
            "gyrocoreQv2RowSaturation",
            sat.status,
            sat.status === "UNKNOWN"
                ? ""
                : t("gyrocoreQv2DetailSaturation", [
                      sat.motorUpper.value?.samples ?? "--",
                      sat.motorLower.value?.samples ?? "--",
                  ]),
        ),
    ];
}

function criterion(vd: TopicVerdictV2, t: Translate): string {
    if (vd.basis !== "EXISTING_GATE" || vd.threshold === null || vd.comparator === null) {
        return "";
    }
    return t(vd.comparator === "MIN" ? "gyrocoreQv2CriterionMin" : "gyrocoreQv2CriterionMax", [String(vd.threshold)]);
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
