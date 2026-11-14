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
 * The AutoTune session in SITL (block 14) for the app: shown only when the page was opened with
 * ?sitlBench=ws://127.0.0.1:<port> (a loopback bench, scripts/sim/session/bench_server.mjs). The session itself is
 * src/gyrocore/sitlSession/session.ts; this module holds its reactive state for the panel and wires the app's own
 * import path and engine worker into the analysis. Optional ?sitlScript=restore-test runs the pre-registered restore
 * test (one fixed first candidate, from the bench's scenario).
 */

import { reactive } from "vue";
import { qualifyChirpFile } from "@/gyrocore/chirp/qualification";
import { AUTOTUNE_MATH } from "@/composables/useAutotune";
import { buildLogInputs } from "@/gyrocore/engine/logInput";
import { analyzeM4BblFile } from "@/js/blackbox/m4_bbl_integration";
import { runAutotuneV2Cancellable } from "@/gyrocore/engine/autotuneV2WorkerClient";
import { sha256Hex } from "@/gyrocore/flight/sha256";
import { makeAnalyzer } from "@/gyrocore/sitlSession/analyzer";
import {
    BenchClient,
    isLoopbackBenchUrl,
    type BenchHello,
    type BenchProgress,
} from "@/gyrocore/sitlSession/benchClient";
import {
    runSession,
    type Measurement,
    type ScriptedStep,
    type SessionEvent,
    type SessionResult,
    type StepRecord,
} from "@/gyrocore/sitlSession/session";

export interface SitlSessionState {
    benchUrl: string | null;
    connected: boolean;
    hello: BenchHello | null;
    running: boolean;
    stopping: boolean;
    event: SessionEvent | null;
    progress: BenchProgress | null;
    startedAt: number | null;
    steps: StepRecord[];
    start: Measurement | null;
    result: SessionResult | null;
    error: string | null;
    scripted: SessionScript | null;
}

const state = reactive<SitlSessionState>({
    benchUrl: null,
    connected: false,
    hello: null,
    running: false,
    stopping: false,
    event: null,
    progress: null,
    startedAt: null,
    steps: [],
    start: null,
    result: null,
    error: null,
    scripted: null,
});

let client: BenchClient | null = null;
let abort: AbortController | null = null;

/** The bench address from the page URL, if it is a loopback WebSocket address. */
export function benchUrlFromLocation(search: string = globalThis.location?.search ?? ""): string | null {
    const u = new URLSearchParams(search).get("sitlBench");
    return u && isLoopbackBenchUrl(u) ? u : null;
}

interface SessionScript {
    steps: ScriptedStep[];
    maxTrialSteps?: number;
}

function scriptFromLocation(
    hello: BenchHello,
    search: string = globalThis.location?.search ?? "",
): SessionScript | null {
    const name = new URLSearchParams(search).get("sitlScript");
    const scripts = (hello.scenario as { scripts?: Record<string, SessionScript> }).scripts ?? {};
    return name && scripts[name] ? scripts[name] : null;
}

export function useSitlSession() {
    async function connect(url: string) {
        state.error = null;
        client?.close();
        client = new BenchClient(url);
        client.onProgress = (p) => (state.progress = p);
        client.onClose = () => {
            state.connected = false;
            if (state.running) abort?.abort();
        };
        state.hello = await client.connect();
        state.benchUrl = url;
        state.connected = true;
        state.scripted = scriptFromLocation(state.hello);
    }

    async function start() {
        // An unconfirmed restore ends the session for good: the bench refuses tuning actions until it restores.
        if (!client || state.running || state.result?.stopReason === "restore_unconfirmed") return;
        state.running = true;
        state.stopping = false;
        state.steps = [];
        state.start = null;
        state.result = null;
        state.error = null;
        state.startedAt = Date.now();
        abort = new AbortController();
        const analyzer = makeAnalyzer({
            async decode(bytes, name) {
                const sha = await sha256Hex(bytes);
                const report = qualifyChirpFile(bytes, name, 45, AUTOTUNE_MATH);
                const logs = buildLogInputs(bytes, sha, report, analyzeM4BblFile(bytes, name));
                if (!logs.length) throw new Error("bench_log_not_decoded");
                return logs[0];
            },
            async engine(input) {
                return (await runAutotuneV2Cancellable(input, abort?.signal)).result;
            },
        });
        try {
            const r = await runSession({
                bench: client,
                analyzer,
                signal: abort.signal,
                scripted: state.scripted?.steps,
                maxTrialSteps: state.scripted?.maxTrialSteps,
                onEvent: (e) => (state.event = e),
                onStart: (m) => (state.start = m),
                onStep: (s) => {
                    const i = state.steps.findIndex((x) => x.index === s.index);
                    if (i >= 0) state.steps.splice(i, 1, s);
                    else state.steps.push(s);
                },
            });
            state.result = r;
            // Records for the bench journal: tunes, verdicts, reasons, read-backs; no logs. Only when the active tune is the
            // accepted one: otherwise the bench keeps its own restore on a lost connection armed.
            const record = {
                status: r.status,
                stopReason: r.stopReason,
                stopDetail: r.stopDetail,
                error: r.error,
                runsUsed: r.runsUsed,
                startTune: r.start?.tune ?? null,
                startMeasurement: r.start ? { id: r.start.id, summary: r.start.summary } : null,
                bestTune: r.best?.tune ?? null,
                bestMeasurement: r.best ? { id: r.best.id, summary: r.best.summary } : null,
                finalActive: r.finalActive,
                steps: r.steps.map((s) => ({
                    index: s.index,
                    axis: s.axis,
                    scripted: s.scripted,
                    from: s.from,
                    to: s.to,
                    baseMeasurementId: s.baseMeasurementId,
                    measurementId: s.measurement?.id ?? null,
                    summary: s.measurement?.summary ?? null,
                    runIssues: s.measurement?.reads.map((x) => x.issues) ?? null,
                    choice: s.choice,
                    checks: s.decision?.checks ?? null,
                    verdict: s.verdict,
                    reasons: s.reasons,
                    setReadback: s.setReadback?.tune ?? null,
                    restore: s.restore,
                    commit: s.commit,
                })),
            };
            // Only a session that ends on the accepted tune is closed on the bench; otherwise the result is journalled and the
            // bench's own restore on a lost connection stays armed (Grok r2 notes A and D).
            // Never a finish after an unconfirmed restore, whatever MSP read last (Grok r7 N2).
            const closes = r.activeIsAccepted && r.stopReason !== "restore_unconfirmed";
            await (closes ? client.finish(record) : client.record(record)).catch(() => undefined);
        } catch (e) {
            state.error = String(e instanceof Error ? e.message : e);
        } finally {
            state.running = false;
            state.stopping = false;
        }
    }

    function stop() {
        if (!state.running) return;
        state.stopping = true;
        abort?.abort();
    }

    return { state, connect, start, stop };
}
