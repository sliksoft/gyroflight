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
 * Autotune engine v2 in the interface: Calculate (engine, no MSP), read-only Preview, and
 * Apply / Restore through useTuneApply's absolute route. Apply offers only the releasable
 * proposal (VALIDATED items whose release contract holds), shows every value that changes
 * (slider modes included), and writes only after the user's yes, bound to that preview.
 */

import { i18n } from "@/js/localization";
import { analyzeM4BblFile } from "@/js/blackbox/m4_bbl_integration";
import { useDialog } from "@/composables/useDialog";
import {
    applyAbsoluteTune,
    previewAbsoluteRestore,
    previewAbsoluteTune,
    restoreAbsoluteTune,
    TuneWriteError,
    type AbsoluteWriteResult,
} from "@/composables/useTuneApply";
import { ApplyBlockedError } from "@/gyrocore/chirp/applyGate";
import { runAutotuneV2, type AutotuneLogInput } from "@/gyrocore/engine/autotuneV2";
import { buildLogInputs, pickPrimary, uniqueFlights } from "@/gyrocore/engine/logInput";
import { verifiedTuneFromLogs } from "@/gyrocore/engine/verifiedTuneFromLogs";
import { evaluateRelease, type AbsoluteProposal } from "@/gyrocore/releaseGate/releaseContract";
import { useAutotuneV2Store, type AutotuneV2Outcome } from "@/gyrocore/stores/autotuneV2";
import type { TuneBackup } from "@/gyrocore/stores/tuneBackup";
import { useVerifiedTuneStore } from "@/gyrocore/stores/verifiedTunes";
import { issueConfirmation } from "@/gyrocore/tuning/applyConfirmation";
import { loggedAbsoluteValues, type AbsoluteDiffRow } from "@/gyrocore/tuning/absoluteTune";
import { logIdentity } from "@/gyrocore/tuning/fcIdentity";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function reasonsOf(err: unknown): string[] {
    if (err instanceof ApplyBlockedError) return err.reasons;
    return [typeof err === "object" && err !== null ? String(Reflect.get(err, "message") ?? err) : String(err)];
}

/** A missing message (undefined) must not break the confirmation dialog. */
function escapeHtml(s: string | undefined) {
    return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

export function changesHtml(rows: AbsoluteDiffRow[]): string {
    if (!rows.length) return `<p>${escapeHtml(i18n.getMessage("gyroflightPreviewNoChange"))}</p>`;
    const body = rows
        .map((r) => `<tr><td>${escapeHtml(r.key)}</td><td>${r.from ?? "?"}</td><td>${r.to ?? "?"}</td></tr>`)
        .join("");
    return `<table><thead><tr><th>${escapeHtml(i18n.getMessage("gyroflightCompareSetting"))}</th><th>${escapeHtml(
        i18n.getMessage("gyroflightPreviewNow"),
    )}</th><th>${escapeHtml(i18n.getMessage("gyroflightPreviewAfter"))}</th></tr></thead><tbody>${body}</tbody></table>`;
}

function failure(action: "apply" | "restore", err: unknown): AutotuneV2Outcome {
    const at = new Date().toISOString();
    if (err instanceof TuneWriteError) {
        return {
            status: "failed",
            action,
            reasons: [],
            stage: err.stage,
            saved: err.saved,
            mismatches: err.mismatches,
            changedFromBackup: err.changedFromBackup,
            backupId: err.backupId,
            message: err.message,
            at,
        };
    }
    return {
        status: err instanceof ApplyBlockedError ? "blocked" : "failed",
        action,
        reasons: reasonsOf(err),
        stage: null,
        saved: err instanceof ApplyBlockedError ? null : "no",
        mismatches: [],
        changedFromBackup: null,
        backupId: null,
        message: err instanceof Error ? err.message : String(err),
        at,
    };
}

function success(action: "apply" | "restore", r: AbsoluteWriteResult): AutotuneV2Outcome {
    return {
        status: "verified",
        action,
        backupId: r.backupId,
        expected: r.expected,
        afterSave: r.afterSave,
        rebootRequired: r.rebootRequired,
        at: new Date().toISOString(),
    };
}

export function useAutotuneV2() {
    const store = useAutotuneV2Store();
    const dialog = useDialog();

    /** Engine inputs of every imported file (cached until a file is added). Newest import = highest order. */
    async function buildInputs(): Promise<AutotuneLogInput[]> {
        if (store.inputs) return store.inputs;
        const inputs: AutotuneLogInput[] = [];
        const n = store.sources.length;
        for (const [i, s] of store.sources.entries()) {
            store.progressMessage = i18n.getMessage("gyroflightV2Progress", [s.filename, String(i + 1), String(n)]);
            // Let the interface paint the progress line before the long synchronous analysis.
            await new Promise((r) => setTimeout(r, 0));
            const sha = await sha256Hex(s.bytes);
            // store.sources is newest first: the first source gets the highest order.
            for (const l of buildLogInputs(s.bytes, sha, s.report, analyzeM4BblFile(s.bytes, s.filename))) {
                inputs.push({ ...l, order: n - i });
            }
        }
        // One flight carried by two files (renamed, re-saved) is kept once.
        store.inputs = uniqueFlights(inputs);
        return store.inputs;
    }

    /** Run the engine on every imported file of this craft. Pure computation: no flight controller. */
    async function calculate() {
        if (!store.sources.length || store.state === "calculating") return;
        store.state = "calculating";
        store.errorMessage = "";
        try {
            const picked = pickPrimary(await buildInputs());
            if (!picked) throw new Error(i18n.getMessage("gyroflightV2NoChirp"));
            const id = logIdentity(picked.primary.headerPairs);
            const firmware = id.firmwareRevision?.split(/\s+/)[1] ?? null;
            store.result = runAutotuneV2({
                ...picked,
                verifiedTune: useVerifiedTuneStore().forCraft(
                    id.uid,
                    firmware,
                    loggedAbsoluteValues(picked.primary.headerPairs),
                ),
            });
            store.state = "done";
        } catch (err) {
            store.state = "error";
            store.errorMessage = reasonsOf(err).join(", ");
        } finally {
            store.progressMessage = "";
        }
    }

    /**
     * Independent validation from the imported logs: the tune imported last is the candidate, the
     * one before it the baseline (with its repeat). A passing record is stored for this craft and
     * the calculation is run again with it. No flight controller access.
     */
    async function createVerifiedTune() {
        if (!store.sources.length || store.state === "calculating") return;
        try {
            const attempt = verifiedTuneFromLogs(await buildInputs());
            const stored = attempt.record?.verdict === "PASS" && useVerifiedTuneStore().save(attempt.record);
            store.verifiedTuneAttempt = {
                verdict: attempt.record ? attempt.record.verdict : "NONE",
                id: stored ? attempt.record!.id : null,
                reasons: attempt.reasons,
            };
        } catch (err) {
            store.verifiedTuneAttempt = { verdict: "NONE", id: null, reasons: reasonsOf(err) };
        } finally {
            store.progressMessage = "";
        }
        await calculate();
    }

    /** The proposal Apply may write: VALIDATED items only, and only when its release contract holds. */
    function releasedProposal(): AbsoluteProposal | null {
        const p = store.result?.releasableProposal ?? null;
        return p && evaluateRelease(p).released ? p : null;
    }

    /** Read-only: identity, live values, and every value the proposal would change. Writes nothing. */
    async function preview(proposal: AbsoluteProposal | null = store.result?.proposal ?? null) {
        if (!proposal) return null;
        const at = new Date().toISOString();
        try {
            const p = await previewAbsoluteTune(proposal);
            store.preview = { status: "ok", changes: p.changes, reasons: [], at };
            return p;
        } catch (err) {
            store.preview = { status: "blocked", changes: [], reasons: reasonsOf(err), at };
            return null;
        }
    }

    async function confirmAndApply(): Promise<"verified" | "cancelled" | "blocked" | "failed"> {
        const proposal = releasedProposal();
        if (!proposal || store.busy) return "cancelled";
        store.busy = true;
        try {
            const p = await preview(proposal);
            if (!p) {
                store.outcome = failure("apply", new ApplyBlockedError(store.preview?.reasons ?? ["preview"]));
                return "blocked";
            }
            const confirmed = await dialog.showYesNo(
                i18n.getMessage("gyroflightV2ApplyConfirmTitle"),
                `${i18n.getMessage("gyroflightV2ApplyConfirmText")}${changesHtml(p.changes)}<p>${i18n.getMessage("gyroflightV2ApplyProcedure")}</p>`,
                {
                    destructive: true,
                    yesText: i18n.getMessage("gyroflightV2ApplyYes"),
                    noText: i18n.getMessage("cancel"),
                },
            );
            if (!confirmed) return "cancelled";
            const token = issueConfirmation({
                kind: "absolute",
                proposalId: proposal.id,
                change: { ...proposal.change },
                preview: p.hash,
            });
            store.outcome = success("apply", await applyAbsoluteTune(proposal, token));
            return "verified";
        } catch (err) {
            store.outcome = failure("apply", err);
            return store.outcome.status === "blocked" ? "blocked" : "failed";
        } finally {
            store.busy = false;
        }
    }

    async function confirmAndRestore(backup: TuneBackup): Promise<"verified" | "cancelled" | "blocked" | "failed"> {
        if (store.busy) return "cancelled";
        store.busy = true;
        try {
            const p = await previewAbsoluteRestore(backup.id);
            const confirmed = await dialog.showYesNo(
                i18n.getMessage("gyroflightRestoreConfirmTitle"),
                `${i18n.getMessage("gyroflightRestoreConfirmText", [backup.createdAt, backup.board, backup.firmware])}${changesHtml(p.changes)}`,
                { destructive: true, yesText: i18n.getMessage("gyroflightRestore"), noText: i18n.getMessage("cancel") },
            );
            if (!confirmed) return "cancelled";
            const token = issueConfirmation({ kind: "restore", backupId: backup.id, preview: p.hash });
            store.outcome = success("restore", await restoreAbsoluteTune(backup.id, token));
            return "verified";
        } catch (err) {
            store.outcome = failure("restore", err);
            return store.outcome.status === "blocked" ? "blocked" : "failed";
        } finally {
            store.busy = false;
        }
    }

    return { calculate, createVerifiedTune, preview, releasedProposal, confirmAndApply, confirmAndRestore };
}
