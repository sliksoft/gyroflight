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
 * The outcome of the last Apply or Restore, for the Verify step. A failure is kept
 * with its stage and whether anything was saved, so the interface can never show a
 * failed write as success.
 */

import { defineStore } from "pinia";
import { ref } from "vue";
import type { TuneSnapshot } from "@/gyrocore/tuning/tuneSnapshot";

export interface TuneOutcomeOk {
    status: "verified";
    action: "apply" | "restore";
    backupId: string;
    expected: TuneSnapshot;
    readback: TuneSnapshot;
    at: string;
}

export interface TuneOutcomeFailed {
    status: "blocked" | "failed";
    action: "apply" | "restore";
    /** Blocked: the gate reasons (nothing was written). Failed: the stage that did not complete. */
    reasons: string[];
    stage: string | null;
    saved: "no" | "unknown" | null;
    mismatches: string[];
    backupId: string | null;
    message: string;
    at: string;
}

export type TuneOutcome = TuneOutcomeOk | TuneOutcomeFailed;

/** The last read-only preview: what the flight controller holds and would hold after Apply. */
export interface TunePreviewView {
    status: "ok" | "blocked";
    before: TuneSnapshot | null;
    expected: TuneSnapshot | null;
    reasons: string[];
    at: string;
}

export const useTuneWorkflowStore = defineStore("gyroflightTuneWorkflow", () => {
    const outcome = ref<TuneOutcome | null>(null);
    const preview = ref<TunePreviewView | null>(null);
    const busy = ref(false);
    return { outcome, preview, busy };
});
