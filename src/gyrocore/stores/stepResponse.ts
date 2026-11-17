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
 * Step response from ordinary flights: the imported files and their results, in memory only (this
 * browser tab). Nothing is saved, nothing goes into a Tune Session, nothing reaches a flight
 * controller. Every file the normal Autotune import reads is offered here, with or without CHIRP;
 * the analysis runs when the card asks for it (analyzePending), not during the import.
 */

import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import { uniqueFlights } from "../engine/logInput";
import { analyzeStepFile, type StepLogResult } from "../stepResponse/stepLog";
import { compareStepLogs, type StepComparison } from "../stepResponse/stepCompare";
import type { AbIntent } from "../stepResponse/stepSettings";

/** Files kept in memory at most (oldest dropped first). */
export const MAX_STEP_FILES = 8;

export interface StepFile {
    fileName: string;
    sha256: string;
    bytes: Uint8Array | null;
    logs: StepLogResult[] | null;
    error: string | null;
}

export interface StepLogOption {
    key: string;
    log: StepLogResult;
    selectable: boolean;
    /** Why it cannot be chosen; empty when selectable. */
    reasons: string[];
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const useStepResponseStore = defineStore("gyrocoreStepResponse", () => {
    // Shallow: results hold large arrays that never change in place.
    const files = shallowRef<StepFile[]>([]);
    const analyzing = ref(false);
    const selection = ref<{ a: string | null; b: string | null }>({ a: null, b: null });
    const intent = ref<AbIntent>({ kind: "none" });

    /** Offer a file read by the normal import. The same bytes twice are kept once. */
    async function addFile(bytes: Uint8Array, fileName: string): Promise<void> {
        const sha256 = await sha256Hex(bytes);
        if (files.value.some((f) => f.sha256 === sha256)) return;
        const next = [...files.value, { fileName, sha256, bytes, logs: null, error: null }];
        files.value = next.slice(Math.max(0, next.length - MAX_STEP_FILES));
        reconcile();
    }

    /** Analyse every file not analysed yet (synchronous decode per file; the UI yields between files). */
    async function analyzePending(): Promise<void> {
        if (analyzing.value) return;
        analyzing.value = true;
        try {
            for (const f of files.value) {
                if (f.logs || f.error || !f.bytes) continue;
                await new Promise((r) => setTimeout(r, 0));
                let logs: StepLogResult[] | null = null;
                let error: string | null = null;
                try {
                    logs = analyzeStepFile(f.bytes, f.fileName, f.sha256);
                } catch (err) {
                    error = err instanceof Error ? err.message : "analysis_failed";
                }
                files.value = files.value.map((x) => (x.sha256 === f.sha256 ? { ...x, logs, error, bytes: null } : x));
            }
        } finally {
            analyzing.value = false;
        }
        reconcile();
    }

    const pending = computed(() => files.value.some((f) => !f.logs && !f.error));
    const logs = computed(() => files.value.flatMap((f) => f.logs ?? []));

    /**
     * Every analysed log once per flight (uniqueFlights: a flight imported in several files is one
     * option, the longest copy); BLOCKED logs are listed, not selectable.
     */
    const options = computed<StepLogOption[]>(() => {
        const all = logs.value;
        const withFlight = all.filter((l) => l.flight);
        const kept = new Set(uniqueFlights(withFlight.map((l) => l.flight!)).map((f) => `${f.sha256}:${f.logIndex}`));
        return all.map((log) => {
            const reasons: string[] = [];
            if (log.status !== "ANALYSED") reasons.push(...log.blockedReasons);
            if (log.flight && !kept.has(log.key)) reasons.push("duplicate_flight_of_another_import");
            return { key: log.key, log, selectable: reasons.length === 0, reasons };
        });
    });

    /** Drop a choice that is gone or no longer selectable. */
    function reconcile() {
        const ok = (k: string | null) =>
            k !== null && options.value.some((o) => o.key === k && o.selectable) ? k : null;
        selection.value = { a: ok(selection.value.a), b: ok(selection.value.b) };
    }

    /** Choose one side; the other side's flight cannot be chosen again (same rule as Flight A/B). */
    function select(side: "a" | "b", key: string | null) {
        if (key !== null && !options.value.some((o) => o.key === key && o.selectable)) return;
        const other = side === "a" ? selection.value.b : selection.value.a;
        if (key !== null && key === other) return;
        selection.value = { ...selection.value, [side]: key };
    }

    function setIntent(next: AbIntent) {
        intent.value = next;
    }

    const byKey = (k: string | null) => (k ? (logs.value.find((l) => l.key === k) ?? null) : null);
    const comparison = computed<StepComparison>(() =>
        compareStepLogs(byKey(selection.value.a), byKey(selection.value.b), intent.value),
    );

    function clear() {
        files.value = [];
        selection.value = { a: null, b: null };
    }

    return {
        files,
        analyzing,
        pending,
        logs,
        options,
        selection,
        intent,
        comparison,
        addFile,
        analyzePending,
        select,
        setIntent,
        clear,
    };
});
