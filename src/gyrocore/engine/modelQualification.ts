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
 * The model-class qualification producer (WP5, audit P1-3): picks, among the imported logs, the
 * flight that can qualify the primary's margin bounds, gives it the finer identification its own
 * samples support (logInput.ts finestWelchSegment, ChirpAxisInput.fine) and reports, criterion by
 * criterion, what the engine concluded with it.
 *
 * The producer never decides a verdict itself. Which flight may serve is decided by the cross-log
 * identity rules (logInput.ts crossLogReferenceIssues: an INDEPENDENT flight of the same craft,
 * firmware and configuration, never the primary's own); whether it qualifies is decided by
 * loopModel.ts (qualifyModelClass, marginEvidenceIssues) and again by the release contract on
 * whatever reaches it; the flight it picks is no cross-log reference as well (autotuneV2.ts).
 *
 * Informative only. Its result is not the analysis Apply is bound to (useAutotuneV2 publishes the
 * engine run without it, analysisBinding.ts recomputes without it), so it never reaches the write
 * authority: an absolute Apply stays blocked by GyroCore Safety in any case (safety/authorize.ts).
 * Statuses: the margin evidence levels and LoopMargins.status of loopModel.ts; per criterion the
 * report statuses PASS / FAIL / NOT_VALIDATED.
 */

import { runAutotuneV2, type AutotuneLogInput, type AutotuneV2Input, type AutotuneV2Result } from "./autotuneV2";
import { crossLogReferenceIssues, flightRelation } from "./logInput";
import {
    QUALIFICATION_BAND_EXTENSION,
    RESOLVED_FEATURE_BINS,
    type LoopMargins,
    type MarginEvidenceLevel,
    type ModelClassQualification,
} from "./loopModel";
import type { AxisName } from "./safetyEvidence";

const AXES: readonly AxisName[] = ["roll", "pitch", "yaw"];

export type CriterionStatus = "PASS" | "FAIL" | "NOT_VALIDATED";

export type CriterionName =
    | "identifiability"
    | "model_structure"
    | "measurement_quality"
    | "frequency_coverage"
    | "independent_evidence"
    | "uncertainty"
    | "margin_applicability"
    | "reference_quality"
    | "independent_validation";

export interface QualificationCriterion {
    name: CriterionName;
    status: CriterionStatus;
    reasons: string[];
}

export interface ModelQualificationReport {
    /** The flight used as the qualification, or null when none can serve. */
    source: { sha256: string; logIndex: number } | null;
    /** Every other imported flight and why it cannot serve (empty: it could). */
    candidates: { sha256: string; logIndex: number; rejected: string[] }[];
    /** Per axis: the evidence level and status the engine reached with the qualification. */
    axes: {
        axis: AxisName;
        level: MarginEvidenceLevel;
        status: LoopMargins["status"];
        verdict: ModelClassQualification["verdict"] | null;
        reasons: string[];
    }[];
    criteria: QualificationCriterion[];
    /** Always false: the producer's output is shown, never handed to the release contract or Apply. */
    connectedToApply: false;
}

/** Why `other` cannot carry a qualification of `primary` (empty: it can), and the log with its fine bins. */
function candidate(
    primary: AutotuneLogInput,
    other: AutotuneLogInput,
    pool: readonly AutotuneLogInput[],
): { log: AutotuneLogInput | null; rejected: string[] } {
    const rejected = crossLogReferenceIssues(primary, other, pool);
    const chirp: AutotuneLogInput["chirp"] = {};
    for (const a of AXES) {
        const c = other.chirp[a];
        if (!c) continue;
        if (c.state !== "usable") {
            rejected.push(`qualification_axis_not_qualified:${a}:${c.state}`);
            continue;
        }
        if (!c.fine) {
            rejected.push(`qualification_axis_without_finer_analysis:${a}`);
            continue;
        }
        // The fine identification stands in for this log's measurement, with where it comes from.
        chirp[a] = { ...c, tf: c.fine.tf, analysis: c.fine.analysis, fine: undefined };
    }
    if (!Object.keys(chirp).length) rejected.push("qualification_no_usable_axis_with_finer_analysis");
    return { log: rejected.length ? null : { ...other, chirp }, rejected };
}

/** The other flights that could serve, the finest first (then most axes). */
export function qualificationCandidates(input: Pick<AutotuneV2Input, "primary" | "others">) {
    const all = input.others.map((o) => ({ other: o, ...candidate(input.primary, o, input.others) }));
    const finest = (l: AutotuneLogInput) =>
        Math.min(...Object.values(l.chirp).map((c) => c!.analysis!.sampleRateHz / c!.analysis!.segmentSamples));
    const usable = all
        .filter((c) => c.log)
        .sort(
            (a, b) =>
                finest(a.log!) - finest(b.log!) || Object.keys(b.log!.chirp).length - Object.keys(a.log!.chirp).length,
        );
    return { all, best: usable[0]?.log ?? null };
}

const criterion = (name: CriterionName, status: CriterionStatus, reasons: string[]): QualificationCriterion => ({
    name,
    status,
    reasons,
});

/**
 * Run the engine with the qualification the imported logs can give and report what it shows.
 * `result` is that informative run (never the analysis the app publishes or Apply binds to).
 */
export function assessModelQualification(input: AutotuneV2Input): {
    result: AutotuneV2Result | null;
    report: ModelQualificationReport;
} {
    const { all, best } = qualificationCandidates(input);
    const candidates = all.map((c) => ({ sha256: c.other.sha256, logIndex: c.other.logIndex, rejected: c.rejected }));
    const empty: ModelQualificationReport = {
        source: null,
        candidates,
        axes: [],
        criteria: [
            criterion("independent_evidence", "FAIL", [
                "required_measurement:chirp_finer_resolution_model_class_qualification",
                ...new Set(all.flatMap((c) => c.rejected)),
            ]),
        ],
        connectedToApply: false,
    };
    if (!best) return { result: null, report: empty };
    const result = runAutotuneV2({ ...input, modelClassQualification: best });
    const margins = Object.entries(result.margins) as [AxisName, { current: LoopMargins; proposed: LoopMargins }][];
    const axes = margins.map(([axis, m]) => ({
        axis,
        level: m.current.evidence.level,
        status: m.current.status,
        verdict: m.current.evidence.qualification?.verdict ?? null,
        reasons: m.current.evidence.qualification?.reasons ?? m.current.reasons,
    }));
    const ev = margins.map(([axis, m]) => ({ axis, e: m.current.evidence, m: m.current }));
    const q = (x: (typeof ev)[number]) => x.e.qualification;
    const relation = flightRelation(input.primary, best);
    const plant = result.parts.find((p) => p.part === "plant_identification")!;
    const all3 = (ok: (x: (typeof ev)[number]) => boolean, bad: (x: (typeof ev)[number]) => string[]) => {
        const fails = ev.flatMap((x) => (ok(x) ? [] : bad(x).map((r) => `${x.axis}:${r}`)));
        return { ok: ev.length > 0 && !fails.length, fails };
    };
    const identif = all3(
        (x) => x.m.okBins >= 4 && x.m.crossoverHz !== null,
        (x) => [`identified_bins:${x.m.okBins}`, ...(x.m.crossoverHz === null ? ["crossover_not_found"] : [])],
    );
    const coverage = all3(
        (x) =>
            !!q(x)?.bandHz &&
            !!x.e.bandHz &&
            q(x)!.bandHz![1] >= x.e.bandHz![1] * QUALIFICATION_BAND_EXTENSION - (x.e.resolutionHz ?? 0),
        (x) => [`qualification_band:${q(x)?.bandHz?.join("-") ?? "none"}Hz`],
    );
    const finer = all3(
        (x) =>
            !!q(x)?.resolutionHz &&
            !!x.e.resolutionHz &&
            q(x)!.resolutionHz! * RESOLVED_FEATURE_BINS <= x.e.resolutionHz! * (1 + 1e-9),
        (x) => [`qualification_resolution:${q(x)?.resolutionHz ?? "?"}Hz`],
    );
    const uncertain = all3(
        (x) => !!x.e.uncertainty,
        (x) =>
            x.m.reasons.filter((r) => /uncertainty/.test(r)).concat(x.e.uncertainty ? [] : ["uncertainty_not_bounded"]),
    );
    const validated = all3(
        (x) => x.e.level === "VALIDATED",
        (x) => [`level:${x.e.level}`, ...(q(x)?.reasons ?? [])],
    );
    const criteria: QualificationCriterion[] = [
        criterion("identifiability", identif.ok ? "PASS" : "FAIL", identif.fails),
        // The model class (rate plant, no feature narrower than the resolved width, tail bounded)
        // is an assumption; a PASS qualification narrows it, never removes it.
        criterion("model_structure", "NOT_VALIDATED", [...new Set(ev.flatMap((x) => x.e.assumptions))]),
        criterion(
            "measurement_quality",
            AXES.every((a) => !input.primary.chirp[a] || input.primary.chirp[a]!.state === "usable") ? "PASS" : "FAIL",
            AXES.flatMap((a) =>
                input.primary.chirp[a] && input.primary.chirp[a]!.state !== "usable"
                    ? [`primary_${a}:${input.primary.chirp[a]!.state}`]
                    : [],
            ),
        ),
        criterion("frequency_coverage", coverage.ok && finer.ok ? "PASS" : "FAIL", [...coverage.fails, ...finer.fails]),
        criterion(
            "independent_evidence",
            relation.relation === "INDEPENDENT" ? "PASS" : "FAIL",
            relation.relation === "INDEPENDENT" ? [] : relation.reasons,
        ),
        criterion("uncertainty", uncertain.ok ? "PASS" : "FAIL", uncertain.fails),
        criterion("margin_applicability", validated.ok ? "PASS" : "NOT_VALIDATED", validated.fails),
        criterion(
            "reference_quality",
            plant.status === "VALIDATED" ? "PASS" : "NOT_VALIDATED",
            plant.status === "VALIDATED" ? [] : plant.reasons.filter((r) => !r.startsWith("required_measurement:")),
        ),
        criterion(
            "independent_validation",
            result.parts.find((p) => p.part === "independent_gain_prediction")!.status === "VALIDATED"
                ? "PASS"
                : "NOT_VALIDATED",
            result.parts.find((p) => p.part === "independent_gain_prediction")!.reasons,
        ),
    ];
    return {
        result,
        report: {
            source: { sha256: best.sha256, logIndex: best.logIndex },
            candidates,
            axes,
            criteria,
            connectedToApply: false,
        },
    };
}
