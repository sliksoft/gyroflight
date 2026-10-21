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
 * Analyze -> Calculate -> Compare -> Apply -> Verify -> Restore, as data.
 *
 * Nothing here computes a tune. It gathers what the existing modules already
 * produced (GyroCore qualification and global composite, GyroCore Safety, the
 * release procedure, the M4/M4.2 flight metrics) and states, per tuning part,
 * whether a proposal exists and what is missing. A part is VALIDATED only when every
 * gate that guards it passes; nothing is presented as validated because it was
 * calculated.
 */

import type { CompositeRecommendation } from "@/gyrocore/tuning/composite";
import type { SafetyResult } from "@/gyrocore/safety/evaluate";
import type { M4BblReport, M4LogReport } from "@/js/blackbox/m4_bbl_integration";
import { SLIDER_KEYS } from "@/gyrocore/tuning/merge";
import type { SnapshotDiffRow } from "@/gyrocore/tuning/tuneSnapshot";

export type PartState = "IMPLEMENTED" | "VALIDATED" | "PARTIAL" | "BLOCKED";

export interface TunePart {
    key: "pid" | "feedforward" | "gyro_filters" | "dterm_filters" | "rpm_dynamic_notch" | "resonances";
    state: PartState;
    /** A change the analysis proposes, or null (none, or not computable). */
    proposal: string | null;
    /** Measured facts behind it (reason codes / short values). */
    evidence: string[];
    /** What blocks or is missing (reason codes). */
    missing: string[];
}

const COMPOSITE_TO_CURRENT: Record<string, string> = {
    slider_master_multiplier: "master_multiplier",
    slider_pi_gain: "pi_gain",
    slider_i_gain: "i_gain",
    slider_d_gain: "d_gain",
    slider_feedforward_gain: "feedforward_gain",
    slider_dterm_filter_multiplier: "dterm_filter_multiplier",
};

/** The slider changes a composite proposes, e.g. ["slider_pi_gain 100 -> 110"]. */
export function sliderChanges(composite: CompositeRecommendation | null): string[] {
    if (!composite?.final) {
        return [];
    }
    const current = composite.current as unknown as Record<string, number | null>;
    return SLIDER_KEYS.flatMap((k) => {
        const from = current[COMPOSITE_TO_CURRENT[k]];
        const to = (composite.final as Record<string, number>)[k];
        return from === to ? [] : [`${k} ${from ?? "?"} -> ${to}`];
    });
}

function m4Log(report: M4BblReport | null, logIndex: number | null): M4LogReport | null {
    if (!report || report.error) {
        return null;
    }
    const usable = report.logs.filter((l) => l.result && !l.error);
    return usable.find((l) => l.logIndex === logIndex) ?? usable[0] ?? null;
}

export interface TunePartsInput {
    composite: CompositeRecommendation | null;
    safety: SafetyResult | null;
    releaseBlocks: string[];
    m4: M4BblReport | null;
}

export function tuneParts(input: TunePartsInput): TunePart[] {
    const { composite, safety, releaseBlocks } = input;
    const log = m4Log(input.m4, composite?.logIndex ?? null);
    const r = log?.result ?? null;
    const notAnalysed = ["m4_flight_metrics_not_analysed"];

    // PID (simplified-tuning sliders): GyroCore's global composite, behind every gate.
    const pidMissing = composite
        ? [
              ...composite.blocked,
              ...(safety && !safety.authorized ? safety.blocks.map((b) => `safety:${b}`) : []),
              ...releaseBlocks,
          ]
        : ["no_qualified_chirp_composite"];
    const changes = sliderChanges(composite);
    const pid: TunePart = {
        key: "pid",
        state: composite?.authorized && safety?.authorized && releaseBlocks.length === 0 ? "VALIDATED" : "BLOCKED",
        proposal: composite?.final ? (changes.length ? changes.join(", ") : "hold_current_sliders") : null,
        evidence: composite
            ? [
                  `participating_axes:${composite.merge.participating_axes.join("+") || "none"}`,
                  `merge:${composite.merge.status}`,
              ]
            : [],
        missing: [...new Set(pidMissing)],
    };

    const ff: TunePart = r
        ? {
              key: "feedforward",
              // optimalFeedforward is never emitted (M4): no FF value is ever proposed.
              state: "BLOCKED",
              proposal: null,
              evidence: [
                  `stick_source:${r.feedforward.stickSource}`,
                  `stick_s:${r.feedforward.stickDurationS.toFixed(1)}`,
                  `advice:${r.feedforward.advice}`,
              ],
              missing: [r.feedforward.reason, "no_feedforward_calculation"],
          }
        : { key: "feedforward", state: "BLOCKED", proposal: null, evidence: [], missing: notAnalysed };

    const peaks = r
        ? r.filters.gyroLpf.spectrum.flatMap((s) =>
              s.peaks.map((p) => `${s.axis}:${p.frequencyHz.toFixed(1)}Hz+${(p.prominenceDb ?? 0).toFixed(1)}dB`),
          )
        : [];
    const gyro: TunePart = r
        ? {
              key: "gyro_filters",
              state: "PARTIAL",
              proposal: null,
              evidence: [
                  `configured_hz:${r.filters.gyroLpf.configuredHz.lpf1 ?? "?"}/${r.filters.gyroLpf.configuredHz.lpf2 ?? "?"}`,
                  `spectrum:${r.filters.gyroLpf.measurement.reliability}`,
                  ...r.filters.gyroLpf.notes,
              ],
              missing: ["no_automatic_filter_recommendation"],
          }
        : { key: "gyro_filters", state: "BLOCKED", proposal: null, evidence: [], missing: notAnalysed };
    const dterm: TunePart = r
        ? {
              key: "dterm_filters",
              state: "PARTIAL",
              proposal: null,
              evidence: [
                  `configured_hz:${r.filters.dtermLpf.configuredHz.lpf1 ?? "?"}/${r.filters.dtermLpf.configuredHz.lpf2 ?? "?"}`,
                  "m5b_dynamic_dterm_model_offline",
                  ...r.filters.dtermLpf.notes,
              ],
              missing: ["no_automatic_filter_recommendation", `dterm_effectiveness:${r.dTerm.advice}`],
          }
        : { key: "dterm_filters", state: "BLOCKED", proposal: null, evidence: [], missing: notAnalysed };
    const rpm: TunePart = {
        key: "rpm_dynamic_notch",
        state: "BLOCKED",
        proposal: null,
        evidence: r?.filters.rpmFilter.estimatedFundamentalHz
            ? [`erpm_median_hz:${r.filters.rpmFilter.estimatedFundamentalHz.toFixed(0)}`]
            : [],
        missing: ["dyn_notch_centres_unknown", "rpm_filter_schedule_unknown", ...(r ? [] : notAnalysed)],
    };
    const resonances: TunePart = r
        ? {
              key: "resonances",
              state: r.filters.gyroLpf.measurement.peaksReported ? "IMPLEMENTED" : "PARTIAL",
              proposal: null,
              evidence: peaks.length ? peaks : ["no_prominent_peak"],
              missing: ["cause_not_identified", "no_filter_advice_from_peaks"],
          }
        : { key: "resonances", state: "BLOCKED", proposal: null, evidence: [], missing: notAnalysed };

    return [pid, ff, gyro, dterm, rpm, resonances];
}

export interface CompareRow {
    group: "slider" | "pid" | "filter";
    key: string;
    current: number | null;
    /** A number, "same", or "fc" (calculated by the flight controller at Apply and shown in Verify). */
    proposed: number | "same" | "fc" | null;
    changed: boolean;
}

function headerNumbers(headerPairs: readonly (readonly [string, string])[], key: string): number[] | null {
    const raw = headerPairs.find(([k]) => k === key)?.[1];
    const v = raw?.split(",").map((x) => Number(x.trim()));
    return v && v.every(Number.isFinite) ? v : null;
}

/** Current (logged) against proposed, per slider, per axis PID and per filter. */
export function compareRows(
    composite: CompositeRecommendation | null,
    headerPairs: readonly (readonly [string, string])[],
): CompareRow[] {
    const rows: CompareRow[] = [];
    const current = (composite?.current ?? {}) as unknown as Record<string, number | null>;
    const final = (composite?.final ?? null) as Record<string, number> | null;
    let anyPid = false;
    for (const k of SLIDER_KEYS) {
        const from = current[COMPOSITE_TO_CURRENT[k]] ?? null;
        const to = final ? final[k] : null;
        const changed = to !== null && from !== to;
        if (changed && k !== "slider_dterm_filter_multiplier") {
            anyPid = true;
        }
        rows.push({ group: "slider", key: k, current: from, proposed: to, changed });
    }
    const dtermChanged = rows.some((r) => r.key === "slider_dterm_filter_multiplier" && r.changed);
    for (const [axis, key] of [
        ["roll", "rollPID"],
        ["pitch", "pitchPID"],
        ["yaw", "yawPID"],
    ] as const) {
        const v = headerNumbers(headerPairs, key);
        ["P", "I", "D"].forEach((term, i) => {
            rows.push({
                group: "pid",
                key: `${axis}:${term}`,
                current: v?.[i] ?? null,
                proposed: final ? (anyPid ? "fc" : "same") : null,
                changed: anyPid,
            });
        });
    }
    for (const [label, key, index] of [
        ["dterm_lpf1_static_hz", "dterm_lpf1_static_hz", 0],
        ["dterm_lpf1_dyn_min_hz", "dterm_lpf1_dyn_hz", 0],
        ["dterm_lpf1_dyn_max_hz", "dterm_lpf1_dyn_hz", 1],
        ["dterm_lpf2_static_hz", "dterm_lpf2_static_hz", 0],
        ["gyro_lpf1_static_hz", "gyro_lpf1_static_hz", 0],
        ["gyro_lpf2_static_hz", "gyro_lpf2_static_hz", 0],
    ] as const) {
        const v = headerNumbers(headerPairs, key);
        const dterm = label.startsWith("dterm");
        rows.push({
            group: "filter",
            key: label,
            current: v?.[index] ?? null,
            proposed: final ? (dterm && dtermChanged ? "fc" : "same") : null,
            changed: dterm && dtermChanged,
        });
    }
    return rows;
}

export interface ChecklistItem {
    key: "composite" | "safety" | "release" | "connection";
    ok: boolean;
    reasons: string[];
}

/** What must hold before Apply can even be offered; identity, live tune and backup are checked on the click. */
export function applyChecklist(input: {
    composite: CompositeRecommendation | null;
    compositeBlocks: string[];
    safety: SafetyResult | null;
    releaseBlocks: string[];
    connected: boolean;
    virtualMode: boolean;
}): ChecklistItem[] {
    return [
        {
            key: "composite",
            ok: !!input.composite && input.compositeBlocks.length === 0,
            reasons: input.composite ? input.compositeBlocks : ["no_qualified_chirp_composite"],
        },
        {
            key: "safety",
            ok: !!input.safety?.authorized,
            reasons: input.safety?.authorized ? [] : (input.safety?.blocks ?? ["not_evaluated"]),
        },
        { key: "release", ok: input.releaseBlocks.length === 0, reasons: input.releaseBlocks },
        {
            key: "connection",
            ok: input.connected && !input.virtualMode,
            reasons: !input.connected ? ["fc:not_connected"] : input.virtualMode ? ["fc:virtual_mode"] : [],
        },
    ];
}

const esc = (v: unknown) =>
    String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");

/** The confirmation dialog body: every row of the comparison, escaped. */
export function compareTableHtml(
    rows: CompareRow[],
    label: (key: string) => string,
    fcLabel: string,
    sameLabel: string,
): string {
    const cell = (v: CompareRow["proposed"]) => (v === "fc" ? fcLabel : v === "same" ? sameLabel : v);
    const body = rows
        .map(
            (r) =>
                `<tr data-row="${esc(r.group)}:${esc(r.key)}"${r.changed ? ' class="font-bold"' : ""}><td>${esc(label(r.key))}</td><td>${esc(r.current ?? "?")}</td><td>${esc(cell(r.proposed) ?? "?")}</td></tr>`,
        )
        .join("");
    return `<table class="gyroflight-compare" data-gyrocore="confirm-diff"><tbody>${body}</tbody></table>`;
}

/** A read-only preview or Restore as a table: every value that changes, from -> to, escaped. */
export function snapshotDiffHtml(rows: SnapshotDiffRow[], label: (key: string) => string, noChange: string): string {
    if (!rows.length) {
        return `<p data-gyrocore="confirm-nochange">${esc(noChange)}</p>`;
    }
    const body = rows
        .map(
            (r) =>
                `<tr data-row="${esc(r.key)}"><td>${esc(label(r.key))}</td><td>${esc(r.from ?? "?")}</td><td>${esc(r.to ?? "?")}</td></tr>`,
        )
        .join("");
    return `<table class="gyroflight-compare" data-gyrocore="confirm-values"><tbody>${body}</tbody></table>`;
}
