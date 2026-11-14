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
 * Autotune v2 engine worker (completion program 2026-10-28, phase 6).
 *
 * Runs the same pure calculate path off the UI thread. Errors and cancellation fail closed: a
 * cancelled or failed run never posts a result. Numerical behaviour matches the main-thread call.
 */

import { runAutotuneV2, type AutotuneV2Input, type AutotuneV2Result } from "./autotuneV2";
import { assessModelQualification } from "./modelQualification";
import type { ModelQualificationReport } from "./modelQualification";

export type AutotuneWorkerRequest =
    { type: "run"; id: number; input: AutotuneV2Input } | { type: "cancel"; id: number };

export type AutotuneWorkerResponse =
    | { type: "result"; id: number; result: AutotuneV2Result; qualification: ModelQualificationReport }
    | { type: "error"; id: number; message: string };

const cancelled = new Set<number>();

self.onmessage = (ev: MessageEvent<AutotuneWorkerRequest>) => {
    const msg = ev.data;
    if (msg.type === "cancel") {
        cancelled.add(msg.id);
        return;
    }
    if (msg.type !== "run") return;
    const { id, input } = msg;
    try {
        if (cancelled.has(id)) return;
        const result = runAutotuneV2(input);
        if (cancelled.has(id)) return;
        const qualification = assessModelQualification(input).report;
        if (cancelled.has(id)) return;
        const out: AutotuneWorkerResponse = { type: "result", id, result, qualification };
        self.postMessage(out);
    } catch (err) {
        if (cancelled.has(id)) return;
        const out: AutotuneWorkerResponse = {
            type: "error",
            id,
            message: err instanceof Error ? err.message : String(err),
        };
        self.postMessage(out);
    } finally {
        cancelled.delete(id);
    }
};
