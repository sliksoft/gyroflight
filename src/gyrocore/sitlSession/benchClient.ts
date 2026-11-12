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
 * WebSocket client of the local SITL bench (scripts/sim/session/bench_server.mjs; block 14). Only a loopback address
 * is accepted: the bench drives a simulator on this machine and never a flight controller.
 */

import type { ActiveRead, Bench, BenchRun, Tune } from "./session";

export interface BenchHello {
    session: string;
    scenario: { id?: string; fixedSettings?: Record<string, unknown> };
    seed: number;
    starts: number[];
    accepted: { tune: Tune; measurementId: string } | null;
}

export interface BenchProgress {
    event: "progress";
    label: string;
    run: number;
    of: number;
}

export function isLoopbackBenchUrl(url: string): boolean {
    try {
        const u = new URL(url);
        return (
            u.protocol === "ws:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]")
        );
    } catch {
        return false;
    }
}

function b64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
    return out;
}

export class BenchClient implements Bench {
    private ws: WebSocket | null = null;
    private next = 1;
    private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    onProgress: ((p: BenchProgress) => void) | null = null;
    onClose: (() => void) | null = null;

    constructor(readonly url: string) {
        if (!isLoopbackBenchUrl(url)) throw new Error(`bench_url_not_loopback:${url}`);
    }

    connect(): Promise<BenchHello> {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(this.url);
            this.ws = ws;
            ws.onopen = () => this.call<BenchHello>("hello").then(resolve, reject);
            ws.onerror = () => reject(new Error("bench_connection_failed"));
            ws.onclose = () => {
                for (const p of this.pending.values()) p.reject(new Error("bench_connection_closed"));
                this.pending.clear();
                this.onClose?.();
            };
            ws.onmessage = (ev) => {
                const m = JSON.parse(String(ev.data));
                if (m.event === "progress") return this.onProgress?.(m as BenchProgress);
                const p = this.pending.get(m.id);
                if (!p) return;
                this.pending.delete(m.id);
                if (m.ok) p.resolve(m.result);
                else p.reject(new Error(String(m.error)));
            };
        });
    }

    close(): void {
        this.ws?.close();
    }

    private call<T>(method: string, params: unknown = {}): Promise<T> {
        const ws = this.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("bench_not_connected"));
        const id = this.next++;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
            ws.send(JSON.stringify({ id, method, params }));
        });
    }

    readActive(): Promise<ActiveRead> {
        return this.call("readActive");
    }

    setTune(tune: Tune): Promise<ActiveRead> {
        return this.call("setTune", { tune });
    }

    commitAccepted(tune: Tune, measurementId: string): Promise<{ tune: Tune; measurementId: string }> {
        return this.call("commitAccepted", { tune, measurementId });
    }

    async measure(label: string): Promise<{ runs: BenchRun[] }> {
        const r = await this.call<{
            runs: (Omit<BenchRun, "log"> & { logBase64: string | null; logPath: string | null })[];
        }>("measure", { label });
        return {
            runs: r.runs.map(({ logBase64, ...x }) => ({ ...x, log: logBase64 ? b64ToBytes(logBase64) : null })),
        };
    }

    abort(): Promise<{ helperStopped: boolean; restored: ActiveRead | null; error: string | null }> {
        return this.call("abort");
    }

    finish(result: unknown): Promise<unknown> {
        return this.call("finish", { result });
    }

    /** Journal the app's result without ending the session on the bench (its restore on a lost connection stays armed). */
    record(result: unknown): Promise<unknown> {
        return this.call("record", { result });
    }
}
