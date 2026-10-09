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
 * The global (composite) recommendation: the one slider set Apply may write.
 *
 * Betaflight's simplified-tuning sliders are global: every key Autotune
 * proposes (master, PI, I, D, FF, D-term filter) applies to every axis the
 * slider mode covers. A per-axis recommendation is therefore evidence, not a
 * tune. This module turns the qualified per-axis Betaflight recommendations
 * of one log into one composite through GyroCore's merge (merge.ts), and adds
 * the checks GyroCore runs after the merge (autotune/absolute.py,
 * safety/output.py) plus Gyroflight's axis-coverage rule and final
 * slider-limit guard.
 *
 * Per log only: the current tune, and so every recommendation's baseline,
 * belongs to one log (GyroCore merges one log's system-ID run).
 */

import type { GainRecommendation } from "@/js/blackbox/spectral_analysis";
import type { ChirpMeasurement, ChirpQualificationReport } from "@/gyrocore/chirp/qualification";
import { AXIS_NAMES, type ChirpAxisName } from "@/gyrocore/chirp/constants";
import {
    MERGE_REQUIRES_REVIEW,
    mergeAutotuneSliders,
    SLIDER_KEYS,
    type GlobalSliderMerge,
    type SimplifiedSliders,
    type SliderKey,
} from "./merge";
import { axisCoverage, type AxisCoverage } from "./coverage";

type Proposed = GainRecommendation["proposed"];
type Direction = "increase" | "decrease" | "hold";

/** safety/output.py codes. */
export const BLOCK_MERGE_REVIEW = "unresolved_merge_requires_review";
export const BLOCK_SYSID = "system_id_unusable";

/** simplified_tuning.py CLI minmax (sliders_outside_cli_range). */
const CLI_MAX = 200;
const CLI_PIDS_MIN = 0;
const CLI_FILTERS_MIN = 10;

/** Integer rounding of a slider; any final value further than this from a request is a clamp. */
const ROUNDING_POINTS = 0.5;

export type SourceRole = "participating" | "excluded_by_axis_gate" | "not_selected" | "rejected";

export interface CompositeSource {
    measurementId: string;
    logIndex: number;
    axis: number;
    axisName: ChirpAxisName;
    role: SourceRole;
    /** Why the measurement does not take part, if it does not. */
    reasons: string[];
    /** Betaflight's per-axis proposal (evidence); null when none was produced. */
    proposed: Proposed | null;
    /** current x scale x 100 per slider, before Betaflight's 25..250 clamp. */
    requested: Partial<Record<SliderKey, number>> | null;
}

export interface CompositeSlider {
    key: SliderKey;
    current: number | null;
    perAxis: Partial<Record<ChirpAxisName, number>>;
    requestedByAxis: Partial<Record<ChirpAxisName, number>>;
    final: number | null;
    finalDirection: Direction | null;
    reason: string | null;
}

export interface CompositeRecommendation {
    /** Changes whenever any input changes: analysis, sources, their proposals, target or result. */
    id: string;
    reportToken: string;
    logIndex: number;
    firmwareRevision: string | null;
    targetPhaseMarginDeg: number;
    sources: CompositeSource[];
    /** Logged firmware sliders: the baseline every recommendation scaled from. */
    current: SimplifiedSliders;
    merge: GlobalSliderMerge;
    /** Axis-coverage authorization under the logged slider mode (coverage.ts), after the merge. */
    coverage: AxisCoverage;
    /** The global slider set Apply would write (Autotune keys); null unless the merge resolved. */
    final: Proposed | null;
    sliders: CompositeSlider[];
    blocked: string[];
    warnings: string[];
    authorized: boolean;
}

export type AxisSelection = Partial<Record<ChirpAxisName, string | null>>;

/** Measurement gate, sample-rate contract or no recommendation: the GyroCore system-ID class. */
function systemIdBlocks(m: ChirpMeasurement): string[] {
    return m.apply.blocked.filter(
        (r) =>
            r.startsWith("measurement:") ||
            r.startsWith("sample_rate_contract:") ||
            r === "recommendation:not_produced",
    );
}

/** engine.py _tune_gates: these block the axis, so the merge leaves it out. */
function isAxisTuneGate(code: string): boolean {
    return (
        code.startsWith("current_tune_") ||
        code === "simplified_pids_mode_off" ||
        code === "simplified_pids_mode_unknown" ||
        code === "yaw_not_under_slider_control"
    );
}

function direction(target: number, current: number, tolerance: number): Direction {
    if (target > current + tolerance) {
        return "increase";
    }
    if (target < current - tolerance) {
        return "decrease";
    }
    return "hold";
}

const SLIDER_TO_FIRMWARE: Record<SliderKey, keyof SimplifiedSliders> = {
    slider_master_multiplier: "master_multiplier",
    slider_pi_gain: "pi_gain",
    slider_i_gain: "i_gain",
    slider_d_gain: "d_gain",
    slider_feedforward_gain: "feedforward_gain",
    slider_dterm_filter_multiplier: "dterm_filter_multiplier",
};

function hash(text: string): string {
    // FNV-1a, 32 bit: an identity for the exact inputs, not a security measure.
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0");
}

/** absolute.py: sliders_outside_cli_range (warning only). */
function outsideCliRange(s: SimplifiedSliders): string[] {
    const out: string[] = [];
    const check = (name: keyof SimplifiedSliders, lo: number) => {
        const v = s[name];
        if (v !== null && !(v >= lo && v <= CLI_MAX)) {
            out.push(name);
        }
    };
    for (const name of ["master_multiplier", "i_gain", "d_gain", "pi_gain", "pitch_d_gain", "pitch_pi_gain"] as const) {
        check(name, CLI_PIDS_MIN);
    }
    for (const name of ["d_max_gain", "feedforward_gain"] as const) {
        check(name, 0);
    }
    for (const name of ["dterm_filter_multiplier", "gyro_filter_multiplier"] as const) {
        check(name, CLI_FILTERS_MIN);
    }
    return out;
}

const PID_FIELDS = [
    "pids_mode",
    "master_multiplier",
    "i_gain",
    "d_gain",
    "pi_gain",
    "d_max_gain",
    "feedforward_gain",
    "pitch_d_gain",
    "pitch_pi_gain",
] as const;

/**
 * One source per axis, deterministically:
 *  - no measurement on the axis: the axis does not take part (GyroCore requires none);
 *  - every measurement on it failed qualification: the axis's system ID is
 *    unusable, which blocks the composite (safety/output.py BLOCK_SYSID);
 *  - exactly one qualified: that one;
 *  - two or more qualified: GyroCore has no rule for repeated sweeps, so the
 *    user must pick one explicitly; until then the composite is blocked.
 */
function chooseSources(
    measurements: ChirpMeasurement[],
    selection: AxisSelection,
    explicitAxes: Partial<Record<ChirpAxisName, boolean>>,
    blocked: string[],
    warnings: string[],
): CompositeSource[] {
    const sources: CompositeSource[] = [];
    for (const axisName of AXIS_NAMES) {
        const onAxis = measurements.filter((m) => m.axisName === axisName);
        if (!onAxis.length) {
            continue;
        }
        const qualified = onAxis.filter((m) => systemIdBlocks(m).length === 0 && m.recommendation !== null);
        let chosen: ChirpMeasurement | null = null;
        if (qualified.length === 1) {
            chosen = qualified[0];
        } else if (qualified.length > 1) {
            const picked = qualified.find((m) => m.id === selection[axisName]);
            if (explicitAxes[axisName] && picked) {
                chosen = picked;
            } else {
                blocked.push(`repeated_axis_requires_selection:${axisName}`);
            }
        } else {
            blocked.push(BLOCK_SYSID, ...onAxis.flatMap((m) => [`${BLOCK_SYSID}:${m.id}`, ...systemIdBlocks(m)]));
        }
        for (const m of onAxis) {
            const guardRequested = m.recommendation
                ? Object.fromEntries(m.recommendation.guard.sliders.map((s) => [s.slider, s.requested]))
                : null;
            const base = {
                measurementId: m.id,
                logIndex: m.logIndex,
                axis: m.axis,
                axisName,
                proposed: m.recommendation?.result.proposed ?? null,
                requested: guardRequested,
            };
            if (m === chosen) {
                const tuneGates = m.apply.blocked.filter(isAxisTuneGate);
                sources.push({
                    ...base,
                    role: tuneGates.length ? "excluded_by_axis_gate" : "participating",
                    reasons: tuneGates,
                });
            } else if (systemIdBlocks(m).length || !m.recommendation) {
                sources.push({ ...base, role: "rejected", reasons: systemIdBlocks(m) });
                if (chosen) {
                    warnings.push(`rejected_repeat_not_used:${m.id}`);
                }
            } else {
                sources.push({ ...base, role: "not_selected", reasons: chosen ? [`selected:${chosen.id}`] : [] });
            }
        }
    }
    return sources;
}

export function buildComposite(
    report: ChirpQualificationReport,
    logIndex: number,
    selection: AxisSelection,
    explicitAxes: Partial<Record<ChirpAxisName, boolean>>,
): CompositeRecommendation | null {
    const log = report.logs.find((l) => l.logIndex === logIndex);
    if (!log?.measurements.length || !log.loggedSliders) {
        return null;
    }
    const blocked: string[] = [];
    const warnings: string[] = [];
    const sources = chooseSources(log.measurements, selection, explicitAxes, blocked, warnings);
    const current = log.loggedSliders;
    const participating = sources.filter((s) => s.role === "participating");
    const byId = new Map(log.measurements.map((m) => [m.id, m]));

    // Axis-gated sources are left out of the merge, as GyroCore blocks the axis.
    for (const s of sources.filter((x) => x.role === "excluded_by_axis_gate")) {
        warnings.push(...s.reasons.map((r) => `axis_excluded:${s.axisName}:${r}`));
    }

    const merge = mergeAutotuneSliders(
        sources
            .filter((s) => s.role === "participating" || s.role === "excluded_by_axis_gate")
            .map((s) => ({ axis: s.axis, blocked: s.role !== "participating", proposed: s.proposed })),
        current,
    );

    if (merge.status === MERGE_REQUIRES_REVIEW || merge.review_reasons.length) {
        blocked.push(BLOCK_MERGE_REVIEW, ...merge.review_reasons);
        if (!participating.length) {
            // Say why nobody took part.
            blocked.push(...sources.flatMap((s) => s.reasons.filter(isAxisTuneGate)));
        }
    }

    // Gyroflight blocks on a participating source's own recommendation (WU2 guard, robustness bound).
    for (const s of participating) {
        const m = byId.get(s.measurementId);
        blocked.push(...(m?.apply.blocked ?? []));
        warnings.push(...(m?.apply.warnings ?? []).map((w) => `${s.axisName}:${w}`));
    }

    // absolute.py, after a resolved merge.
    if (merge.simplified) {
        if (merge.simplified.pids_mode === 0) {
            blocked.push("simplified_pids_mode_off");
        }
        const missingPid = PID_FIELDS.filter((n) => merge.simplified?.[n] === null);
        if (missingPid.length) {
            blocked.push(`proposed_pid_sliders_incomplete:${missingPid.join(",")}`);
        }
        const missingDterm = (["dterm_filter", "dterm_filter_multiplier"] as const).filter(
            (n) => merge.simplified?.[n] === null,
        );
        if (missingDterm.length) {
            blocked.push(`proposed_dterm_sliders_incomplete:${missingDterm.join(",")}`);
        }
        const cli = outsideCliRange(merge.simplified);
        if (cli.length) {
            warnings.push(`proposed_sliders_outside_cli_minmax:${cli.join(",")}`);
        }
        if (merge.simplified.dterm_filter === 0) {
            warnings.push("dterm_filter_off_multiplier_has_no_effect");
        }
    }

    // Gyroflight axis coverage: a merged result is still not applicable unless
    // every axis the logged slider mode drives has a selected, qualified source.
    const coverage = axisCoverage(current.pids_mode, sources);
    blocked.push(...coverage.blocked);

    // Final slider-limit guard on the global values: no direction change and
    // no clamp beyond rounding against any participating axis's request.
    const final = merge.proposed_sliders ? ({ ...merge.proposed_sliders } as Proposed) : null;
    const sliders = SLIDER_KEYS.map((key): CompositeSlider => {
        const cur = current[SLIDER_TO_FIRMWARE[key]];
        const perAxis: CompositeSlider["perAxis"] = {};
        const requestedByAxis: CompositeSlider["requestedByAxis"] = {};
        for (const s of participating) {
            if (s.proposed) {
                perAxis[s.axisName] = s.proposed[key];
            }
            const r = s.requested?.[key];
            if (r !== undefined) {
                requestedByAxis[s.axisName] = r;
            }
        }
        const value = final ? final[key] : null;
        let reason: string | null = null;
        let finalDirection: Direction | null = null;
        if (value !== null) {
            if (cur === null || !Number.isFinite(value)) {
                reason = `composite_slider_unverifiable:${key}`;
            } else {
                finalDirection = direction(value, cur, 0);
                for (const requested of Object.values(requestedByAxis)) {
                    if (!Number.isFinite(requested) || direction(requested, cur, ROUNDING_POINTS) !== finalDirection) {
                        reason = `composite_clamp_changes_direction:${key}`;
                        break;
                    }
                    if (Math.abs(value - requested) > ROUNDING_POINTS) {
                        reason = `composite_clamp_material:${key}`;
                    }
                }
            }
            if (reason) {
                blocked.push(reason);
            }
        }
        return { key, current: cur, perAxis, requestedByAxis, final: value, finalDirection, reason };
    });

    const uniqueBlocked = [...new Set(blocked)];
    const identity = JSON.stringify({
        token: report.token,
        logIndex,
        target: report.targetPhaseMarginDeg,
        sources: sources.map((s) => [s.measurementId, s.role, s.proposed]),
        final,
        blocked: uniqueBlocked,
    });
    return {
        id: `composite-log${logIndex + 1}-${hash(identity)}`,
        reportToken: report.token,
        logIndex,
        firmwareRevision: log.firmwareRevision,
        targetPhaseMarginDeg: report.targetPhaseMarginDeg,
        sources,
        current,
        merge,
        coverage,
        final,
        sliders,
        blocked: uniqueBlocked,
        warnings: [...new Set(warnings)],
        authorized: merge.status === "merged" && final !== null && uniqueBlocked.length === 0,
    };
}
