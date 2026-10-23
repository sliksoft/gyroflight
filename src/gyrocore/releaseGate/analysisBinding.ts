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
 * The first step of the absolute write authority (writeAuthority.ts), in the place the composite
 * gate holds for the slider route: the proposal must be the one the current analysis produced.
 *
 * A proposal carries its own release evidence; on its own that evidence proves nothing, since any
 * object of the right shape carries some. So the proposal must equal, field for field, the
 * releasable proposal of the analysis in the store (an older, edited or hand-built proposal
 * differs), and at the write point the engine runs again on the current inputs and the current
 * Verified Tune store (as currentComposite rebuilds the composite: never a cached copy) and must
 * reproduce it.
 */

import { toRaw } from "vue";
import { pickPrimary } from "@/gyrocore/engine/logInput";
import { runAutotuneV2, type AutotuneV2Input } from "@/gyrocore/engine/autotuneV2";
import { loggedAbsoluteValues } from "@/gyrocore/tuning/absoluteTune";
import { logIdentity } from "@/gyrocore/tuning/fcIdentity";
import { useAutotuneV2Store } from "@/gyrocore/stores/autotuneV2";
import { useVerifiedTuneStore } from "@/gyrocore/stores/verifiedTunes";
import type { AbsoluteProposal } from "@/gyrocore/releaseGate/releaseContract";

/**
 * The engine input for the decoded logs in the store: the one definition Calculate and the write
 * authority share, so a recomputation sees exactly what the analysis saw. null without inputs or CHIRP.
 */
export function currentAnalysisInput(): AutotuneV2Input | null {
    const inputs = useAutotuneV2Store().inputs;
    const picked = inputs ? pickPrimary(inputs) : null;
    if (!picked) return null;
    const id = logIdentity(picked.primary.headerPairs);
    const firmware = id.firmwareRevision?.split(/\s+/)[1] ?? null;
    return {
        ...picked,
        verifiedTune: useVerifiedTuneStore().forCraft(
            id.uid,
            firmware,
            loggedAbsoluteValues(picked.primary.headerPairs),
        ),
    };
}

/**
 * A plain object's or array's own fields (a Vue proxy is read through toRaw). Anything that is not
 * plain data throws: an accessor, a non-enumerable property (toJSON), a symbol key, a sparse array,
 * a class instance, Map or typed array.
 */
function plainFields(value: object): { isArray: boolean; entries: [string, unknown][] } {
    const o = toRaw(value) as Record<string, unknown>;
    const isArray = Array.isArray(o);
    const proto = Object.getPrototypeOf(o);
    if (proto !== (isArray ? Array.prototype : Object.prototype) && !(proto === null && !isArray)) {
        throw new TypeError("not plain data: prototype");
    }
    const keys = Object.getOwnPropertyNames(o).filter((k) => !(isArray && k === "length"));
    for (const k of keys) {
        const d = Object.getOwnPropertyDescriptor(o, k)!;
        if (!("value" in d) || !d.enumerable) throw new TypeError(`not plain data: property ${k}`);
    }
    if (Object.getOwnPropertySymbols(o).length) throw new TypeError("not plain data: symbol key");
    // Exactly the indices 0..length-1: a hole filled by a named property would serialize alike.
    if (isArray && (keys.length !== (o as unknown as unknown[]).length || keys.some((k, i) => k !== String(i)))) {
        throw new TypeError("not plain data: not exactly the indices of an array");
    }
    return { isArray, entries: keys.map((k) => [k, o[k]]) };
}

function assertPlainPrimitive(value: unknown): void {
    if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
        throw new TypeError(`not plain data: ${typeof value}`);
    }
}

/**
 * Exact text of plain data: object keys sorted, every type tagged (a string never reads as a
 * number, undefined or null). Serializes what code reading the value sees: no toJSON (plainFields).
 */
export function canonicalText(value: unknown): string {
    if (value === null || typeof value !== "object") {
        assertPlainPrimitive(value);
        if (value === null) return "null";
        if (value === undefined) return "undefined";
        if (typeof value === "number") return `#${Object.is(value, -0) ? 0 : value}`;
        return typeof value === "string" ? JSON.stringify(value) : String(value);
    }
    const { isArray, entries } = plainFields(value);
    if (isArray) return `[${entries.map(([, v]) => canonicalText(v)).join(",")}]`;
    return `{${entries
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${JSON.stringify(k)}:${canonicalText(v)}`)
        .join(",")}}`;
}

/** A deep copy of plain data that shares nothing with `value`; throws on what is not plain data. */
export function plainCopy<T>(value: T): T {
    if (value === null || typeof value !== "object") {
        assertPlainPrimitive(value);
        return value;
    }
    const { isArray, entries } = plainFields(value);
    return (
        isArray ? entries.map(([, v]) => plainCopy(v)) : Object.fromEntries(entries.map(([k, v]) => [k, plainCopy(v)]))
    ) as T;
}

/**
 * The analysis an Apply was authorized against: the decoded inputs and the result by identity,
 * and each input by identity and log. Deeper edits of a decoded log (its samples) are not seen.
 */
export interface AnalysisPin {
    inputs: unknown;
    result: unknown;
    logs: { input: unknown; sha256: string; logIndex: number }[];
}

export function pinAnalysis(): AnalysisPin {
    const store = useAutotuneV2Store();
    return {
        inputs: store.inputs,
        result: store.result,
        logs: (store.inputs ?? []).map((l) => ({ input: l, sha256: l.sha256, logIndex: l.logIndex })),
    };
}

function analysisChanged(since: AnalysisPin): boolean {
    const store = useAutotuneV2Store();
    const now = store.inputs ?? [];
    return (
        store.inputs !== since.inputs ||
        store.result !== since.result ||
        now.length !== since.logs.length ||
        now.some(
            (l, i) =>
                l !== since.logs[i].input || l.sha256 !== since.logs[i].sha256 || l.logIndex !== since.logs[i].logIndex,
        )
    );
}

/**
 * Why `proposal` is not the current analysis's releasable proposal; empty when it is.
 * `recompute`: run the engine again on the current inputs (the write point). `since`: the analysis
 * the Apply was authorized against; the inputs and the result must still be those objects (the
 * rechecks after the live reads, which do not recompute).
 */
export function analysisBindingIssues(
    proposal: AbsoluteProposal,
    { recompute, since }: { recompute: boolean; since?: AnalysisPin },
): string[] {
    const store = useAutotuneV2Store();
    if (store.state !== "done") return [`analysis_not_done:${store.state}`];
    const current = store.result?.releasableProposal ?? null;
    if (!current) return ["no_releasable_proposal"];
    if (canonicalText(proposal) !== canonicalText(current)) return ["proposal_differs_from_analysis"];
    if (since && analysisChanged(since)) {
        return ["analysis_changed_since_authorization"];
    }
    if (!recompute) return [];
    const input = currentAnalysisInput();
    if (!input) return ["analysis_inputs_missing"];
    let fresh: AbsoluteProposal | null;
    try {
        fresh = runAutotuneV2({ ...input, createdAt: proposal.createdAt }).releasableProposal;
    } catch {
        return ["analysis_recompute_failed"];
    }
    return fresh && canonicalText(fresh) === canonicalText(proposal) ? [] : ["analysis_not_reproduced"];
}
