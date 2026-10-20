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
 * GF-1 M4.1: the offline M4 report of one blackbox file.
 *
 * Independent of the Autotune / CHIRP qualification stores on purpose: nothing
 * here feeds a recommendation, the global tune, or Apply.
 */

import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";
import FileSystem from "@/js/FileSystem";
import { i18n } from "@/js/localization";
import { analyzeM4BblFile, type M4BblReport } from "@/js/blackbox/m4_bbl_integration";

export type M4State = "idle" | "importing" | "analyzing" | "done" | "error";

function errorField(err: unknown, field: "name" | "message"): string | undefined {
    if (typeof err !== "object" || err === null) {
        return undefined;
    }
    const value: unknown = Reflect.get(err, field);
    return typeof value === "string" ? value : undefined;
}

export const useM4FlightMetricsStore = defineStore("gyrocoreM4FlightMetrics", () => {
    // Shallow: the report holds large typed arrays that never change in place.
    const report = shallowRef<M4BblReport | null>(null);
    const state = ref<M4State>("idle");
    const errorMessage = ref("");
    const progressMessage = ref("");

    function reset() {
        report.value = null;
        state.value = "idle";
        errorMessage.value = "";
        progressMessage.value = "";
    }

    /** Analyse already-read file bytes (also the test entry point). */
    function analyzeBytes(bytes: Uint8Array, filename: string) {
        state.value = "analyzing";
        progressMessage.value = "";
        try {
            const next = analyzeM4BblFile(bytes, filename, (i, n) => {
                progressMessage.value = `${i + 1}/${n}`;
            });
            report.value = next;
            if (next.error) {
                state.value = "error";
                errorMessage.value = next.error;
            } else {
                state.value = "done";
                errorMessage.value = "";
            }
        } catch (err) {
            report.value = null;
            state.value = "error";
            errorMessage.value = errorField(err, "message") || "analysis_failed";
        }
        progressMessage.value = "";
    }

    async function importAndAnalyze() {
        reset();
        state.value = "importing";
        let file: Awaited<ReturnType<typeof FileSystem.pickOpenFile>>;
        try {
            file = await FileSystem.pickOpenFile(
                i18n.getMessage("fileSystemPickerFiles", { typeof: "BBL" }),
                [".bbl", ".bfl", ".txt"],
                "autotune-file",
            );
        } catch (err) {
            if (errorField(err, "name") === "AbortError" || errorField(err, "message") === "cancelled") {
                reset();
                return;
            }
            state.value = "error";
            errorMessage.value = errorField(err, "message") || "file_picker_failed";
            return;
        }
        if (!file) {
            reset();
            return;
        }
        try {
            const blob = await FileSystem.readFileAsBlob(file);
            state.value = "analyzing";
            // Let the "analysing" state render before the synchronous decode blocks the thread.
            await new Promise((r) => setTimeout(r, 0));
            analyzeBytes(new Uint8Array(await blob.arrayBuffer()), file.name);
        } catch (err) {
            state.value = "error";
            errorMessage.value = errorField(err, "message") || "file_read_failed";
        }
    }

    return { report, state, errorMessage, progressMessage, reset, analyzeBytes, importAndAnalyze };
});
