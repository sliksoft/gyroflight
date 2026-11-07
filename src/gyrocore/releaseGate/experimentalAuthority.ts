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
 * Write authority of the EXPERIMENTAL route (block 5). It is deliberately a second, separate
 * authority next to writeAuthority.ts: the released route keeps its release contract, GyroCore
 * Safety authorization and product lock unchanged; this one keeps every technical check and
 * names what it does not require.
 *
 *   analysis_binding    the proposal is the current analysis's experimental proposal, recomputed at
 *                       the write point and unchanged since the user was shown it
 *   computable_items    the proposal carries only values the measurement supports (no withheld key
 *                       in the change, every item computed by a route, measurement valid)
 *   values_technical    every value finite, an integer inside the firmware's settings.c range, the
 *                       same Safety range / step checks the released route runs (absoluteEvaluate)
 *   acknowledgement     enforced by the route: a confirmation of kind "experimental", acknowledged
 *
 * Not required here (named in `waived` so the interface says so): release contract conditions that
 * are qualification (phase_margin, robustness, model_quality, independent_validation,
 * safety_evidence, items_validated), the product lock (full_safety_engine_pending,
 * independent_pid_validation_missing, independent_pid_validation_not_current) and Safety's
 * validated_starting_configuration, dynamic_margins and hardware_validation. The route itself still reads identity, refuses an armed or other craft, a
 * live configuration that differs from the log, takes a backup, reads back and verifies the save.
 */

import { ApplyBlockedError } from "@/gyrocore/chirp/applyGate";
import type { ExperimentalProposal } from "@/gyrocore/engine/experimentalProposal";
import { analysisBindingIssues, type AnalysisPin } from "@/gyrocore/releaseGate/analysisBinding";
import { evaluateAbsoluteSafety } from "@/gyrocore/safety/absoluteEvaluate";
import { useVerifiedTuneStore } from "@/gyrocore/stores/verifiedTunes";
import { loggedAbsoluteValues } from "@/gyrocore/tuning/absoluteTune";
import { logIdentity } from "@/gyrocore/tuning/fcIdentity";

export type ExperimentalStepName = "analysis_binding" | "computable_items" | "values_technical";

export interface ExperimentalStep {
    name: ExperimentalStepName;
    passed: boolean;
    reasons: string[];
}

export interface ExperimentalWriteDecision {
    verdict: "EXPERIMENTAL_APPLY_ALLOWED" | "EXPERIMENTAL_APPLY_DENIED";
    steps: ExperimentalStep[];
    blocks: string[];
    /** The released route's requirements this route does not impose: shown, never silently dropped. */
    waived: readonly string[];
}

export const EXPERIMENTAL_WAIVED: readonly string[] = Object.freeze([
    "release_contract:phase_margin",
    "release_contract:robustness",
    "release_contract:model_quality",
    "release_contract:independent_validation",
    "release_contract:safety_evidence",
    "release_contract:items_validated",
    "product_lock:full_safety_engine_pending",
    "product_lock:independent_pid_validation_missing",
    "product_lock:independent_pid_validation_not_current",
    "gyrocore_safety:hardware_validation_not_executed",
    "gyrocore_safety:validated_starting_configuration",
    "gyrocore_safety:dynamic_margins",
]);

/** The technical blocks of an experimental proposal, step by step. Pure apart from the stores it reads. */
export function experimentalWriteDecision(
    x: ExperimentalProposal,
    { recompute, since }: { recompute: boolean; since?: AnalysisPin },
): ExperimentalWriteDecision {
    const steps: ExperimentalStep[] = [];
    const add = (name: ExperimentalStepName, reasons: () => string[]) => {
        let r: string[];
        try {
            r = reasons();
        } catch {
            r = [`${name}:evaluation_failed`];
        }
        steps.push({ name, passed: !r.length, reasons: r });
    };

    add("analysis_binding", () =>
        analysisBindingIssues(x.proposal, { recompute, since, route: "experimental" }).map((r) => `binding:${r}`),
    );

    add("computable_items", () => {
        const out: string[] = [];
        if (x.status !== "EXPERIMENTAL") out.push("status_not_experimental");
        if (x.hardwareValidated !== false) out.push("hardware_validated_flag_tampered");
        const p = x.proposal;
        if (!p || typeof p !== "object" || !p.change || !Array.isArray(p.items)) return [...out, "proposal_malformed"];
        if (/^v2-/.test(p.id)) out.push("proposal_id_is_releasable_route");
        const keys = Object.keys(p.change);
        if (!keys.length) out.push("no_change");
        const withheld = new Set(x.withheld.map((w) => w.key));
        for (const k of keys) {
            const item = x.items.find((i) => i.key === k);
            const pItem = p.items.find((i) => i.key === k);
            if (!item || !pItem) out.push(`change_without_item:${k}`);
            else if (item.to !== p.change[k] || pItem.to !== p.change[k]) out.push(`item_value_differs:${k}`);
            if (withheld.has(k)) out.push(`withheld_key_in_change:${k}`);
            const axis = /_(roll|pitch|yaw)$/.exec(k)?.[1];
            if (axis && withheld.has(`pid_${axis}`) && /^(p|i|d|d_max)_/.test(k))
                out.push(`withheld_axis_in_change:${axis}`);
        }
        if (!p.release?.measurement?.valid) out.push("measurement_invalid", ...(p.release?.measurement?.reasons ?? []));
        return out;
    });

    add("values_technical", () => {
        const p = x.proposal;
        const out: string[] = [];
        for (const [k, v] of Object.entries(p.change)) {
            if (typeof v !== "number" || !Number.isFinite(v)) out.push(`value_not_finite:${k}`);
            else if (!Number.isInteger(v)) out.push(`value_not_integer:${k}`);
        }
        const id = logIdentity(p.log.headerPairs);
        const verifiedTune = useVerifiedTuneStore().forCraft(
            id.uid,
            id.firmwareRevision?.split(/\s+/)[1] ?? null,
            loggedAbsoluteValues(p.log.headerPairs),
        );
        // The same range, step and identity-binding checks the released route's Safety runs; its
        // qualification checks (starting configuration, dynamic margins, hardware) are waived here.
        const safety = evaluateAbsoluteSafety(p, { verifiedTune });
        for (const name of ["absolute_values_in_range", "plausible_step", "fc_identity_binding"] as const) {
            const c = safety.checks.find((s) => s.name === name);
            if (!c) out.push(`${name}:not_evaluated`);
            else if (c.status !== "PASS") out.push(...c.reasons.map((r) => `${name}:${r}`));
        }
        return out;
    });

    const blocks = steps.flatMap((s) => s.reasons);
    return {
        verdict: blocks.length ? "EXPERIMENTAL_APPLY_DENIED" : "EXPERIMENTAL_APPLY_ALLOWED",
        steps,
        blocks,
        waived: EXPERIMENTAL_WAIVED,
    };
}

export function assertExperimentalWriteAuthorized(
    x: ExperimentalProposal,
    opts: { recompute: boolean; since?: AnalysisPin },
): void {
    const d = experimentalWriteDecision(x, opts);
    if (d.verdict !== "EXPERIMENTAL_APPLY_ALLOWED") throw new ApplyBlockedError(d.blocks);
}
