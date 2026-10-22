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
 * Autotune engine v2 state: the imported CHIRP files (bytes + qualification report, newest
 * first, at most MAX_SOURCES, all of one craft), the last calculation, the last read-only
 * preview and the last write outcome. Memory only: nothing leaves the browser.
 */

import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import type { ChirpQualificationReport } from "@/gyrocore/chirp/qualification";
import type { AutotuneLogInput, AutotuneV2Result } from "@/gyrocore/engine/autotuneV2";
import type { AbsoluteDiffRow, AbsoluteSnapshot } from "@/gyrocore/tuning/absoluteTune";
import { logIdentity } from "@/gyrocore/tuning/fcIdentity";

/** Baseline, its repeat, candidate and its repeat, plus room for one more. */
export const MAX_SOURCES = 6;

export interface AutotuneV2Source {
    filename: string;
    bytes: Uint8Array;
    report: ChirpQualificationReport;
    /** DeviceUID of the first log, to keep sources of one craft together. */
    uid: string | null;
}

export interface AutotuneV2Preview {
    status: "ok" | "blocked";
    changes: AbsoluteDiffRow[];
    reasons: string[];
    at: string;
}

export type AutotuneV2Outcome =
    | {
          status: "verified";
          action: "apply" | "restore";
          backupId: string;
          expected: AbsoluteSnapshot;
          afterSave: AbsoluteSnapshot;
          rebootRequired: boolean | null;
          at: string;
      }
    | {
          status: "blocked" | "failed";
          action: "apply" | "restore";
          reasons: string[];
          stage: string | null;
          saved: string | null;
          mismatches: string[];
          changedFromBackup: string[] | null;
          backupId: string | null;
          message: string;
          at: string;
      };

export const useAutotuneV2Store = defineStore("gyroflightAutotuneV2", () => {
    const sources = shallowRef<AutotuneV2Source[]>([]);
    const result = shallowRef<AutotuneV2Result | null>(null);
    const state = ref<"idle" | "calculating" | "done" | "error">("idle");
    const errorMessage = ref("");
    const progressMessage = ref("");
    const preview = ref<AutotuneV2Preview | null>(null);
    const outcome = ref<AutotuneV2Outcome | null>(null);
    const busy = ref(false);
    /** Decoded engine inputs of the current sources (rebuilt when a source is added). */
    const inputs = shallowRef<AutotuneLogInput[] | null>(null);
    /** Outcome of the last "create Verified Tune" (the record itself goes to the Verified Tune store). */
    const verifiedTuneAttempt = ref<{ verdict: "PASS" | "FAIL" | "NONE"; id: string | null; reasons: string[] } | null>(
        null,
    );

    /** A newly imported file. Another craft's file replaces the list; the same file is not added twice. */
    function addSource(bytes: Uint8Array, filename: string, report: ChirpQualificationReport) {
        const uid = logIdentity(report.logs[0]?.headerPairs ?? []).uid?.join("-") ?? null;
        const same = sources.value.filter((s) => s.uid === uid && s.filename !== filename);
        sources.value = [{ filename, bytes, report, uid }, ...same].slice(0, MAX_SOURCES);
        inputs.value = null;
        result.value = null;
        preview.value = null;
        state.value = "idle";
    }

    function reset() {
        sources.value = [];
        inputs.value = null;
        verifiedTuneAttempt.value = null;
        result.value = null;
        preview.value = null;
        outcome.value = null;
        state.value = "idle";
        errorMessage.value = "";
        progressMessage.value = "";
    }

    return {
        sources,
        inputs,
        verifiedTuneAttempt,
        result,
        state,
        errorMessage,
        progressMessage,
        preview,
        outcome,
        busy,
        addSource,
        reset,
    };
});
