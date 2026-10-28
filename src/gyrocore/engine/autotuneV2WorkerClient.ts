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

import { runAutotuneV2, type AutotuneV2Input, type AutotuneV2Result } from "./autotuneV2";
import { assessModelQualification, type ModelQualificationReport } from "./modelQualification";
import type { AutotuneWorkerRequest, AutotuneWorkerResponse } from "./autotuneV2.worker";

export interface AutotuneV2ComputeOutcome {
    result: AutotuneV2Result;
    qualification: ModelQualificationReport;
}

let nextId = 1;
let worker: Worker | null = null;
let workerFailed = false;

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

/**
 * Run the engine (and informative model-class assessment) for `input`. When `signal` aborts, the
 * worker is cancelled and terminated so a blocking compute cannot keep running after the UI moved
 * on; the promise rejects with AbortError. Crash / construction failure falls back once to the
 * main-thread engine (same numerical path). Callers must still discard stale store writes after abort.
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
        let settled = false;
        const settle = (fn: () => void) => {
            if (settled) return;
            settled = true;
            cleanup();
            fn();
        };
        const onAbort = () => {
            try {
                const cancel: AutotuneWorkerRequest = { type: "cancel", id };
                w.postMessage(cancel);
            } catch {
                /* worker may already be gone */
            }
            // Cancel alone cannot interrupt a synchronous runAutotuneV2 inside the worker.
            try {
                w.terminate();
            } catch {
                /* ignore */
            }
            worker = null;
            settle(() => reject(new DOMException("Aborted", "AbortError")));
        };
        const onMessage = (ev: MessageEvent<AutotuneWorkerResponse>) => {
            const msg = ev.data;
            if (!msg || typeof msg !== "object" || msg.id !== id) return;
            if (msg.type === "result") {
                settle(() => resolve({ result: msg.result, qualification: msg.qualification }));
            } else if (msg.type === "error") {
                settle(() => reject(new Error(msg.message || "autotune_worker_error")));
            } else {
                settle(() => reject(new Error("autotune_worker_invalid_message")));
            }
        };
        const onError = (ev: ErrorEvent) => {
            workerFailed = true;
            try {
                w.terminate();
            } catch {
                /* ignore */
            }
            worker = null;
            settle(() => resolveSyncOrReject(input, signal, resolve, reject));
            void ev;
        };
        const onMessageError = () => {
            workerFailed = true;
            try {
                w.terminate();
            } catch {
                /* ignore */
            }
            worker = null;
            settle(() => reject(new Error("autotune_worker_message_error")));
        };
        const cleanup = () => {
            signal?.removeEventListener("abort", onAbort);
            w.removeEventListener("message", onMessage);
            w.removeEventListener("error", onError);
            w.removeEventListener("messageerror", onMessageError);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        w.addEventListener("message", onMessage);
        w.addEventListener("error", onError);
        w.addEventListener("messageerror", onMessageError);
        const req: AutotuneWorkerRequest = { type: "run", id, input };
        try {
            w.postMessage(req);
        } catch (err) {
            workerFailed = true;
            worker = null;
            settle(() => resolveSyncOrReject(input, signal, resolve, reject));
            void err;
        }
    });
}
