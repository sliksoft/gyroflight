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
 * EXPERIMENTAL tuning proposal (block 5): the values the engine could compute from the measurement
 * but cannot release. It is a separate status, never a releasableProposal and never VALIDATED.
 *
 * Two kinds of blocker are told apart, item by item:
 *   - missing qualification (margin evidence MEASURED / MODEL_CONDITIONAL instead of VALIDATED, no
 *     Verified Tune, no cross-flight repeat, stationarity unknown, Safety's hardware validation not
 *     executed): the value is computable from the data and is offered here, with its gaps named;
 *   - insufficient or invalid measurement (no candidate meets the targets, margins not computable,
 *     the plant not identified, a rejected measurement): no value is computed, the item is withheld
 *     with its reason. Nothing is invented to make the proposal non-empty.
 * Per axis the primary route's candidate is used when it is computable; otherwise the CHIRP + JIO
 * route's candidate (its own loop model, uncalibrated uncertainty), named as such.
 */

import type { AbsoluteProposal, PartStatus, ProposalItem, ProposalPart } from "@/gyrocore/releaseGate/releaseContract";
import type { AxisPidProposal } from "@/gyrocore/engine/pidOptimizer";
import type { JioRouteResult } from "@/gyrocore/engine/autotuneV2";

export type ExperimentalSource = "primary_route" | "jio_route";

export interface ExperimentalItem extends ProposalItem {
    source: ExperimentalSource;
    /** Margin evidence level the value rests on (loopModel MarginEvidence), or "none". */
    evidence: string;
    /** Reasons that are missing qualification only (the value is still computed). */
    qualificationGaps: string[];
}

export interface WithheldItem {
    key: string;
    part: ProposalPart;
    source: ExperimentalSource;
    /** Why no value is computed: the measurement does not support it. */
    reasons: string[];
}

export interface ExperimentalProposal {
    /** Its own status: not releasable, not VALIDATED, written only through the experimental route. */
    status: "EXPERIMENTAL";
    /** The write-shaped proposal (id prefixed v2x-): only the computable items, their real statuses kept. */
    proposal: AbsoluteProposal;
    items: ExperimentalItem[];
    withheld: WithheldItem[];
    /** Union of the items' qualification gaps. */
    qualificationGaps: string[];
    /** What the values depend on and what is not shown: model, uncalibrated uncertainty, hardware. */
    limitations: string[];
    hardwareValidated: false;
}

/**
 * Reasons that mean the measurement does not support a value (not merely that it is unqualified).
 * Anything matching keeps the item out of the proposal.
 */
const DATA_INSUFFICIENT = [
    /^no_candidate_meets_all_targets/,
    /^robustness_unknown/,
    /^current_loop_margins_not_computable/,
    /^chirp_measurement_rejected/,
    /^chain_model_not_validated_on_this_log/,
    /^no_identified_plant_for_axis/,
    /^latency_band_not_identified/,
    /^stick_latency_not_measured/,
    /^rc_feedforward_cutoff_unknown/,
    /^verified_tune_segment_moves_feedforward/,
    /^jio_no_usable_record/,
    /^jio_margins_unavailable/,
    /^jio_repeats_inconsistent/,
    /^jio_cross_flight_inconsistent/,
    /^jio_engine_input_missing/,
    /^jio_no_supported_points/,
];

export function dataInsufficientReasons(reasons: readonly string[]): string[] {
    return reasons.filter((r) => DATA_INSUFFICIENT.some((re) => re.test(r)));
}

/** A PID candidate the search really computed (improved / restores margins), with a change. */
function pidCandidateComputable(c: AxisPidProposal): boolean {
    return (
        c.changed &&
        (c.outcome === "improved" || c.outcome === "restores_margins") &&
        [c.proposed.p, c.proposed.i, c.proposed.d, c.proposed.dMax].every(Number.isFinite) &&
        dataInsufficientReasons(c.reasons).length === 0
    );
}

const PID_KEYS = ["p", "i", "d", "d_max"] as const;

function pidItems(
    c: AxisPidProposal,
    source: ExperimentalSource,
    extraGaps: string[],
    extraLimits: string[],
): ExperimentalItem[] {
    const evidence = c.proposedMargins.evidence?.level ?? "none";
    const values: Record<(typeof PID_KEYS)[number], [number, number]> = {
        p: [c.current.p, c.proposed.p],
        i: [c.current.i, c.proposed.i],
        d: [c.current.d, c.proposed.d],
        d_max: [c.current.dMax, c.proposed.dMax],
    };
    const gaps = [...new Set([...c.reasons, ...extraGaps])];
    return PID_KEYS.flatMap((k) => {
        const [from, to] = values[k];
        if (from === to) return [];
        return [
            {
                key: `${k}_${c.axis}`,
                part: "pid" as const,
                from,
                to,
                status: c.status,
                reasons: [...c.reasons, ...extraLimits],
                source,
                evidence,
                qualificationGaps: gaps,
            },
        ];
    });
}

export interface ExperimentalInput {
    /** Every item of the primary route (filters, feedforward and PID, whatever its status). */
    primaryItems: ProposalItem[];
    primaryPid: AxisPidProposal[];
    jio: JioRouteResult | null;
    /** Builds the write-shaped proposal (margins, Safety evidence) for a selection: the engine's own. */
    buildProposal: (selected: ProposalItem[]) => AbsoluteProposal | null;
}

/** The proposal (null when no value is computable) and, always, what was withheld and why. */
export interface ExperimentalOutcome {
    proposal: ExperimentalProposal | null;
    withheld: WithheldItem[];
}

export function buildExperimentalProposal(input: ExperimentalInput): ExperimentalOutcome {
    const items: ExperimentalItem[] = [];
    const withheld: WithheldItem[] = [];
    const limitations = new Set<string>([
        "experimental:not_releasable",
        "experimental:not_hardware_validated",
        "experimental:margins_depend_on_the_identified_loop_model",
    ]);

    // Filters and feedforward: a computed value (PARTIAL or VALIDATED) is offered; BLOCKED is withheld.
    for (const it of input.primaryItems) {
        if (it.part === "pid") continue;
        const data = dataInsufficientReasons(it.reasons);
        if (it.status === "BLOCKED" || data.length || !Number.isFinite(it.to)) {
            withheld.push({
                key: it.key,
                part: it.part,
                source: "primary_route",
                reasons: data.length ? data : it.reasons,
            });
            continue;
        }
        items.push({
            ...it,
            source: "primary_route",
            evidence: it.status,
            qualificationGaps: it.reasons,
        });
    }

    // PID per axis: the primary candidate when computable, else the JIO candidate, else withheld.
    for (const axis of ["roll", "pitch", "yaw"] as const) {
        const primary = input.primaryPid.find((p) => p.axis === axis) ?? null;
        const jioChain = input.jio?.chain[axis] ?? null;
        const jioCand = jioChain?.candidate ?? null;
        // An axis neither route analysed has nothing to offer or withhold (no sweep on it).
        if (!primary && !jioChain) continue;
        if (primary && pidCandidateComputable(primary)) {
            items.push(...pidItems(primary, "primary_route", [], []));
            if (primary.proposedMargins.evidence?.level !== "VALIDATED")
                limitations.add(
                    `experimental:${axis}:margin_evidence_${primary.proposedMargins.evidence?.level ?? "none"}`,
                );
            continue;
        }
        // The JIO chain's own blockers (inconsistent repeats, cross-flight disagreement, no usable
        // record) count against its candidate as well, whatever the candidate object carries.
        if (
            jioCand &&
            jioChain &&
            pidCandidateComputable(jioCand) &&
            !dataInsufficientReasons(jioChain.reasons).length
        ) {
            const jioLimits = [
                "jio_experimental_plant",
                "jio_uncertainty_n_eff_not_calibrated",
                ...jioChain.reasons.filter((r) => /^(stationarity_unknown|cross_flight_repeat)/.test(r)),
            ];
            items.push(...pidItems(jioCand, "jio_route", jioLimits, jioLimits));
            limitations.add(`experimental:${axis}:values_from_jio_route_uncalibrated_uncertainty`);
            continue;
        }
        const reasons = [
            ...(primary
                ? [`primary:${primary.outcome}`, ...dataInsufficientReasons(primary.reasons)]
                : ["primary:axis_not_analysed"]),
            ...(jioCand
                ? [
                      `jio:${jioCand.outcome}`,
                      ...dataInsufficientReasons([...jioCand.reasons, ...(jioChain?.reasons ?? [])]),
                  ]
                : jioChain
                  ? [`jio:not_computable`, ...jioChain.reasons]
                  : ["jio:axis_not_analysed"]),
        ];
        // An axis without a change on either route is not "withheld": nothing to propose there.
        // An axis is not "withheld" only when every route that analysed it needs no change.
        const outcomes = [primary?.outcome, jioCand?.outcome].filter((o): o is NonNullable<typeof o> => !!o);
        const unchanged = outcomes.length > 0 && outcomes.every((o) => o === "no_change_needed");
        if (!unchanged)
            withheld.push({ key: `pid_${axis}`, part: "pid", source: "primary_route", reasons: [...new Set(reasons)] });
    }

    if (!items.length) return { proposal: null, withheld };
    const selected: ProposalItem[] = items.map(({ key, part, from, to, status, reasons }) => ({
        key,
        part,
        from,
        to,
        status,
        reasons,
    }));
    const built = input.buildProposal(selected);
    if (!built) return { proposal: null, withheld };
    const proposal: AbsoluteProposal = { ...built, id: built.id.replace(/^v2-/, "v2x-") };
    return {
        proposal: {
            status: "EXPERIMENTAL",
            proposal,
            items,
            withheld,
            qualificationGaps: [...new Set(items.flatMap((i) => i.qualificationGaps))],
            limitations: [...limitations],
            hardwareValidated: false,
        },
        withheld,
    };
}

/** The statuses an experimental item may carry; VALIDATED items are the releasable route's business too. */
export const EXPERIMENTAL_ITEM_STATUSES: readonly PartStatus[] = ["VALIDATED", "PARTIAL", "BLOCKED"];
