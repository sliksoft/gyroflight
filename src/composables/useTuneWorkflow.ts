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
 * The only way the interface writes a tune: show the complete change, let the user
 * confirm it, issue the single-use confirmation for exactly that change, then run
 * Apply (or Restore) and record the outcome for the Verify step. Used by the Tune
 * workflow panel and by the Autotune panel's Apply button.
 */

import { useDialog } from "@/composables/useDialog";
import { useAutotune, type ProposedSliders } from "@/composables/useAutotune";
import { restoreTune, TuneWriteError, type TuneWriteResult } from "@/composables/useTuneApply";
import { i18n } from "@/js/localization";
import { ApplyBlockedError } from "@/gyrocore/chirp/applyGate";
import { issueConfirmation } from "@/gyrocore/tuning/applyConfirmation";
import type { CompositeRecommendation } from "@/gyrocore/tuning/composite";
import { compareRows, compareTableHtml } from "@/gyrocore/tuning/tuneWorkflow";
import type { TuneBackup } from "@/gyrocore/stores/tuneBackup";
import { useTuneWorkflowStore, type TuneOutcome } from "@/gyrocore/stores/tuneWorkflow";

export type TuneActionResult = "verified" | "cancelled" | "blocked" | "failed";

const label = (key: string) => {
    const text = i18n.getMessage(`gyroflightCompare_${key.replace(/:/g, "_")}`);
    return text && !text.startsWith("gyroflightCompare_") ? text : key;
};

function failure(action: "apply" | "restore", err: unknown): TuneOutcome {
    const at = new Date().toISOString();
    if (err instanceof ApplyBlockedError) {
        return {
            status: "blocked",
            action,
            reasons: err.reasons,
            stage: null,
            saved: null,
            mismatches: [],
            backupId: null,
            message: err.message,
            at,
        };
    }
    if (err instanceof TuneWriteError) {
        return {
            status: "failed",
            action,
            reasons: [],
            stage: err.stage,
            saved: err.saved,
            mismatches: err.mismatches,
            backupId: err.backupId,
            message: err.message,
            at,
        };
    }
    const message = typeof err === "object" && err !== null ? String(Reflect.get(err, "message") ?? err) : String(err);
    // An unexpected error before any write (e.g. a timed-out read) is still not success; the stage is unknown.
    return {
        status: "failed",
        action,
        reasons: [],
        stage: null,
        saved: "no",
        mismatches: [],
        backupId: null,
        message,
        at,
    };
}

function success(action: "apply" | "restore", r: TuneWriteResult): TuneOutcome {
    return {
        status: "verified",
        action,
        backupId: r.backupId,
        expected: r.expected,
        readback: r.readback,
        at: new Date().toISOString(),
    };
}

export function useTuneWorkflow() {
    const dialog = useDialog();
    const store = useTuneWorkflowStore();

    /** Shows the full comparison; on the user's yes, applies exactly that composite. */
    async function confirmAndApply(
        composite: CompositeRecommendation,
        headerPairs: readonly (readonly [string, string])[],
    ): Promise<TuneActionResult> {
        const proposed = composite.final as ProposedSliders | null;
        if (!proposed || store.busy) {
            return "cancelled";
        }
        const table = compareTableHtml(
            compareRows(composite, headerPairs),
            label,
            i18n.getMessage("gyroflightCompareByFc"),
            i18n.getMessage("gyroflightCompareSame"),
        );
        const confirmed = await dialog.showYesNo(
            i18n.getMessage("autotuneApplyConfirmTitle"),
            `${i18n.getMessage("autotuneApplyConfirmText")}${table}<p>${i18n.getMessage("gyroflightApplyProcedure")}</p>`,
            { destructive: true, yesText: i18n.getMessage("autotuneApplyGains"), noText: i18n.getMessage("cancel") },
        );
        if (!confirmed) {
            return "cancelled";
        }
        const token = issueConfirmation({ kind: "apply", compositeId: composite.id, sliders: { ...proposed } });
        store.busy = true;
        try {
            const result = await useAutotune().applyGains(proposed, composite.id, token);
            store.outcome = success("apply", result as TuneWriteResult);
            return "verified";
        } catch (err) {
            store.outcome = failure("apply", err);
            return store.outcome.status === "blocked" ? "blocked" : "failed";
        } finally {
            store.busy = false;
        }
    }

    /** Asks before writing a stored backup back to the craft it came from. */
    async function confirmAndRestore(backup: TuneBackup): Promise<TuneActionResult> {
        if (store.busy) {
            return "cancelled";
        }
        const confirmed = await dialog.showYesNo(
            i18n.getMessage("gyroflightRestoreConfirmTitle"),
            i18n.getMessage("gyroflightRestoreConfirmText", [backup.createdAt, backup.board, backup.firmware]),
            { destructive: true, yesText: i18n.getMessage("gyroflightRestore"), noText: i18n.getMessage("cancel") },
        );
        if (!confirmed) {
            return "cancelled";
        }
        const token = issueConfirmation({ kind: "restore", backupId: backup.id });
        store.busy = true;
        try {
            store.outcome = success("restore", await restoreTune(backup.id, token));
            return "verified";
        } catch (err) {
            store.outcome = failure("restore", err);
            return store.outcome.status === "blocked" ? "blocked" : "failed";
        } finally {
            store.busy = false;
        }
    }

    return { confirmAndApply, confirmAndRestore };
}
