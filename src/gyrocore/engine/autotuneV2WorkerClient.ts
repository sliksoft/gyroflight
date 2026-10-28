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
 * Cancellable Autotune v2 worker client (completion program 2026-10-28, phase 6).
 *
 * Keeps the UI thread free during calculate. Generation tokens drop stale results. Worker
 * construction failure falls back to the main-thread engine (same numerical path). Partial or
 * failed worker runs never replace a newer analysis.
 */

import { toRaw } from "vue";
import { runAutotuneV2, type AutotuneV2Input, type AutotuneV2Result } from "./autotuneV2";
import { assessModelQualification, type ModelQualificationReport } from "./modelQualification";
import type { AutotuneWorkerRequest, AutotuneWorkerResponse } from "./autotuneV2.worker";

export interface AutotuneV2ComputeOutcome {
    result: AutotuneV2Result;
    qualification: ModelQualificationReport;
}

type PendingRun = {
    id: number;
    input: AutotuneV2Input;
    signal: AbortSignal | null | undefined;
    resolve: (v: AutotuneV2ComputeOutcome) => void;
    reject: (e: unknown) => void;
    settled: boolean;
    cleanup: () => void;
};

let nextId = 1;
let worker: Worker | null = null;
let workerFailed = false;
const pending = new Map<number, PendingRun>();

function getWorker(): Worker | null {
    if (workerFailed) return null;
    if (worker) return worker;
    // Browser UI path only: Node / Vitest have a different Worker and must not hang on module workers.
    if (typeof window === "undefined" || typeof Worker === "undefined") {
        workerFailed = true;
        return null;
    }
    try {
        worker = new Worker(new URL("./autotuneV2.worker.ts", import.meta.url), { type: "module" });
        return worker;
    } catch {
        workerFailed = true;
        return null;
    }
}

function computeSync(input: AutotuneV2Input): AutotuneV2ComputeOutcome {
    return {
        result: runAutotuneV2(input),
        qualification: assessModelQualification(input).report,
    };
}

function resolveSyncOrReject(
    input: AutotuneV2Input,
    signal: AbortSignal | null | undefined,
    resolve: (v: AutotuneV2ComputeOutcome) => void,
    reject: (e: unknown) => void,
): void {
    if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
    }
    try {
        resolve(computeSync(input));
    } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
    }
}

function settlePending(p: PendingRun, fn: () => void): void {
    if (p.settled) return;
    p.settled = true;
    pending.delete(p.id);
    p.cleanup();
    fn();
}

/**
 * Deep-clone engine input for postMessage. Vue reactive proxies (Verified Tune from the store)
 * are not structured-cloneable; strip them before cloning.
 */
function cloneForWorker(input: AutotuneV2Input): AutotuneV2Input {
    const detached: AutotuneV2Input = {
        ...input,
        verifiedTune: input.verifiedTune
            ? (structuredClone(toRaw(input.verifiedTune)) as AutotuneV2Input["verifiedTune"])
            : null,
        others: input.others?.map((o) => toRaw(o)) ?? input.others,
        primary: toRaw(input.primary),
    };
    return structuredClone(detached);
}

function isDataCloneError(err: unknown): boolean {
    return (
        (typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "DataCloneError") ||
        (err instanceof Error && /DataCloneError|could not be cloned/i.test(err.message))
    );
}

/**
 * Terminate the shared worker and settle every in-flight request so none is left hanging.
 * The aborted id (if any) rejects with AbortError; others fall back to the sync engine.
 */
function terminateSharedWorker(abortedId?: number): void {
    const w = worker;
    worker = null;
    if (w) {
        try {
            w.terminate();
        } catch {
            /* ignore */
        }
    }
    const stranded = [...pending.values()];
    for (const p of stranded) {
        if (abortedId !== undefined && p.id === abortedId) {
            settlePending(p, () => p.reject(new DOMException("Aborted", "AbortError")));
        } else {
            settlePending(p, () => resolveSyncOrReject(p.input, p.signal, p.resolve, p.reject));
        }
    }
}

/**
 * Run the engine (and informative model-class assessment) for `input`. When `signal` aborts, the
 * worker is cancelled and terminated so a blocking compute cannot keep running after the UI moved
 * on; the promise rejects with AbortError. Concurrent in-flight requests on the shared worker are
 * settled (sync fallback), never left pending. Crash / construction / clone failure falls back to
 * the main-thread engine (same numerical path) without stranding siblings. Callers must still
 * discard stale store writes after abort.
 */
export function runAutotuneV2Cancellable(
    input: AutotuneV2Input,
    signal?: AbortSignal | null,
): Promise<AutotuneV2ComputeOutcome> {
    if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    const w = getWorker();
    if (!w) {
        try {
            return Promise.resolve(computeSync(input));
        } catch (err) {
            return Promise.reject(err instanceof Error ? err : new Error(String(err)));
        }
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
        const pendingRun: PendingRun = {
            id,
            input,
            signal,
            resolve,
            reject,
            settled: false,
            cleanup: () => {
                signal?.removeEventListener("abort", onAbort);
                w.removeEventListener("message", onMessage);
                w.removeEventListener("error", onError);
                w.removeEventListener("messageerror", onMessageError);
            },
        };
        pending.set(id, pendingRun);

        const onAbort = () => {
            try {
                const cancel: AutotuneWorkerRequest = { type: "cancel", id };
                w.postMessage(cancel);
            } catch {
                /* worker may already be gone */
            }
            // Cancel alone cannot interrupt a synchronous runAutotuneV2 inside the worker.
            terminateSharedWorker(id);
        };
        const onMessage = (ev: MessageEvent<AutotuneWorkerResponse>) => {
            const msg = ev.data;
            if (!msg || typeof msg !== "object" || msg.id !== id) return;
            if (msg.type === "result") {
                settlePending(pendingRun, () => resolve({ result: msg.result, qualification: msg.qualification }));
            } else if (msg.type === "error") {
                settlePending(pendingRun, () => reject(new Error(msg.message || "autotune_worker_error")));
            } else {
                settlePending(pendingRun, () => reject(new Error("autotune_worker_invalid_message")));
            }
        };
        const onError = (ev: ErrorEvent) => {
            workerFailed = true;
            // Settle every pending (including this one via sync fallback) — do not leave siblings hanging.
            const stranded = [...pending.values()];
            try {
                w.terminate();
            } catch {
                /* ignore */
            }
            worker = null;
            for (const p of stranded) {
                settlePending(p, () => resolveSyncOrReject(p.input, p.signal, p.resolve, p.reject));
            }
            void ev;
        };
        const onMessageError = () => {
            workerFailed = true;
            const stranded = [...pending.values()];
            try {
                w.terminate();
            } catch {
                /* ignore */
            }
            worker = null;
            for (const p of stranded) {
                settlePending(p, () => p.reject(new Error("autotune_worker_message_error")));
            }
        };

        signal?.addEventListener("abort", onAbort, { once: true });
        w.addEventListener("message", onMessage);
        w.addEventListener("error", onError);
        w.addEventListener("messageerror", onMessageError);

        let wire: AutotuneV2Input;
        try {
            wire = cloneForWorker(input);
        } catch (err) {
            // Clone failed (unexpected proxy shape): sync once; keep the worker for later plain inputs.
            settlePending(pendingRun, () => resolveSyncOrReject(input, signal, resolve, reject));
            void err;
            return;
        }

        const req: AutotuneWorkerRequest = { type: "run", id, input: wire };
        try {
            w.postMessage(req);
        } catch (err) {
            if (isDataCloneError(err)) {
                // Do not permanently disable the worker for a one-off non-cloneable payload.
                settlePending(pendingRun, () => resolveSyncOrReject(input, signal, resolve, reject));
            } else {
                workerFailed = true;
                worker = null;
                const stranded = [...pending.values()];
                for (const p of stranded) {
                    settlePending(p, () => resolveSyncOrReject(p.input, p.signal, p.resolve, p.reject));
                }
            }
            void err;
        }
    });
}
