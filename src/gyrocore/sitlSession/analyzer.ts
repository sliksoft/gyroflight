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
 * The session's measurement analysis (block 14): every run's log through the app's own import path and engine.
 *   per run    the engine on that log alone (margins of the current tune: sessionMarginsOf) and runMetrics (step
 *              block, per-motor hover band power);
 *   search     the engine on all runs of the accepted measurement (first log primary, the others as repeats), with
 *              the session's bounded step search at trust region ρ.
 * The import (decode) and the engine call are injected: the app passes its import path and the worker client; the
 * tests pass their own.
 */

import type { AutotuneLogInput, AutotuneV2Input, AutotuneV2Result } from "@/gyrocore/engine/autotuneV2";
import type { SessionSearchResult } from "@/gyrocore/engine/sessionSearch";
import type { RunRead } from "./decision";
import { runMetrics } from "./metrics";
import { SESSION_PROTOCOL as P, type SessionAxis } from "./protocol";
import type { Analyzer, BenchRun } from "./session";

export interface AnalyzerDeps {
    /** The app's import of one Blackbox file: the log of the flight (the first log of the file). */
    decode(bytes: Uint8Array, name: string): Promise<AutotuneLogInput>;
    engine(input: AutotuneV2Input): Promise<AutotuneV2Result>;
}

export function makeAnalyzer(deps: AnalyzerDeps): Analyzer {
    const cache = new Map<string, AutotuneLogInput>();
    const decode = async (r: BenchRun) => {
        const key = r.logSha256 ?? `${r.start}`;
        const hit = cache.get(key);
        if (hit) return hit;
        const decoded = await deps.decode(r.log!, `sitl_s${r.start}.bfl`);
        // The step block is not steady hover: the engine's noise and motor reads leave it out, as runMetrics does.
        const m = runMetrics(decoded);
        const l = m.blockExclusion ? { ...decoded, noiseExclusions: [m.blockExclusion] as const } : decoded;
        cache.set(key, l);
        return l;
    };
    return {
        async runs(runs) {
            const out: RunRead[] = [];
            for (const r of runs) {
                if (!r.log) {
                    out.push({ margins: {}, steps: {}, motors: null, issues: [] });
                    continue;
                }
                const log = await decode(r);
                const res = await deps.engine({
                    primary: log,
                    others: [],
                    verifiedTune: null,
                    session: { axes: [...P.axes], maxStepRel: { roll: 0, pitch: 0 } },
                });
                const margins: RunRead["margins"] = {};
                const issues: string[] = [];
                for (const axis of P.axes) {
                    const a = res.sessionSearch?.axes.find((x) => x.axis === axis);
                    margins[axis] = a?.currentRead ?? null;
                    if (!a?.currentRead)
                        issues.push(`engine:${axis}:${a ? `${a.status}:${a.reasons.join(",")}` : "no_session_search"}`);
                }
                const m = runMetrics(log);
                out.push({ margins, steps: m.steps, motors: m.motors, issues: [...issues, ...m.issues] });
            }
            return out;
        },
        async search(runs, rho: Record<SessionAxis, number>): Promise<SessionSearchResult> {
            const logs = [];
            for (const r of runs) if (r.log) logs.push(await decode(r));
            const res = await deps.engine({
                primary: logs[0],
                others: logs.slice(1),
                verifiedTune: null,
                session: { axes: [...P.axes], maxStepRel: { ...rho } },
            });
            if (!res.sessionSearch) throw new Error("engine_returned_no_session_search");
            return res.sessionSearch;
        },
    };
}
