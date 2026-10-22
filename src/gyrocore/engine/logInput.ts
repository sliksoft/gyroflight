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
 * Engine input from a blackbox file: the Blackbox Viewer decodes the channels (the same
 * decoder as the CHIRP qualification and M4), the CHIRP qualification report gives each
 * axis' qualified transfer function and sweep window, M4 gives the acro stick latency and
 * the noise floor. No new analysis framework: this only joins the existing ones by sample.
 */

import { FlightLog } from "@/blackbox-viewer/flightlog.js";
import { FlightLogIndex } from "@/blackbox-viewer/flightlog_index.js";
import { extractOptionalBlackboxChannels } from "@/js/blackbox/flight_metrics_analysis";
import type { M4BblReport } from "@/js/blackbox/m4_bbl_integration";
import type { ChirpMeasurement, ChirpQualificationReport } from "@/gyrocore/chirp/qualification";
import type { AutotuneLogInput, ChirpAxisInput } from "./autotuneV2";
import type { AxisName } from "./safetyEvidence";

const FIELDS = [
    "time",
    "gyroADC[0]",
    "gyroADC[1]",
    "gyroADC[2]",
    "gyroUnfilt[0]",
    "gyroUnfilt[1]",
    "gyroUnfilt[2]",
    "rcCommand[3]",
] as const;
/** Rejected measurements still carry a transfer function: kept as diagnostics only (no proposal). */
const STATE_RANK: Record<string, number> = { usable: 3, usable_with_warnings: 2, rejected: 1 };

function firstAtOrAfter(t: ArrayLike<number>, v: number): number {
    let lo = 0;
    let hi = t.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (t[mid] < v) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

function medianRateHz(t: ArrayLike<number>): number {
    const d: number[] = [];
    for (let k = 1; k < t.length && d.length < 20000; k++) d.push(t[k] - t[k - 1]);
    d.sort((a, b) => a - b);
    const m = d[Math.floor(d.length / 2)];
    return m > 0 ? 1e6 / m : 0;
}

/** The best qualified measurement per axis (usable before usable-with-warnings; rejected never). */
function bestPerAxis(ms: ChirpMeasurement[]): Partial<Record<AxisName, ChirpMeasurement>> {
    const out: Partial<Record<AxisName, ChirpMeasurement>> = {};
    for (const m of ms) {
        const rank = STATE_RANK[m.state] ?? 0;
        if (!rank || !m.diagnostics) continue;
        const cur = out[m.axisName as AxisName];
        if (
            !cur ||
            rank > (STATE_RANK[cur.state] ?? 0) ||
            (rank === STATE_RANK[cur.state] && m.durationS > cur.durationS)
        ) {
            out[m.axisName as AxisName] = m;
        }
    }
    return out;
}

export function buildLogInputs(
    bytes: Uint8Array,
    sha256: string,
    report: ChirpQualificationReport,
    m4: M4BblReport | null,
): AutotuneLogInput[] {
    const index = new FlightLogIndex(bytes) as unknown as { getLogCount(): number };
    const flightLog = new FlightLog(bytes) as unknown as { openLog(i: number): boolean } & Parameters<
        typeof extractOptionalBlackboxChannels
    >[0];
    const out: AutotuneLogInput[] = [];
    for (const log of report.logs) {
        const best = bestPerAxis(log.measurements);
        if (!Object.keys(best).length || log.logIndex >= index.getLogCount() || !flightLog.openLog(log.logIndex))
            continue;
        const ex = extractOptionalBlackboxChannels(flightLog, { fields: FIELDS });
        const ch = ex.named;
        const t = ch.time;
        if (!t || !ch["gyroADC[0]"] || !ch["gyroADC[1]"] || !ch["gyroADC[2]"] || !ch["rcCommand[3]"]) continue;
        const aligned = <T extends ArrayLike<number>>(c: T | null | undefined) =>
            c && c.length === t.length ? c : null;
        const unfilt = [ch["gyroUnfilt[0]"], ch["gyroUnfilt[1]"], ch["gyroUnfilt[2]"]].map(aligned);
        const chirp: Partial<Record<AxisName, ChirpAxisInput>> = {};
        for (const [axis, m] of Object.entries(best) as [AxisName, ChirpMeasurement][]) {
            chirp[axis] = {
                tf: m.diagnostics!.transferFunction,
                start: firstAtOrAfter(t, m.startTimeUs),
                end: firstAtOrAfter(t, m.endTimeUs),
                state: m.state,
                qualificationReasons: m.apply.blocked.filter((r) => r.startsWith("measurement:")),
            };
        }
        const m4log = m4?.logs.find((l) => l.logIndex === log.logIndex)?.result ?? null;
        const latency = (axis: AxisName) => {
            const a = m4log?.feedforward.axes.find((x) => x.axis === axis);
            return a && a.latencyMs.reliability !== "insufficient" ? a.latencyMs.value : null;
        };
        out.push({
            sha256,
            logIndex: log.logIndex,
            headerPairs: log.headerPairs,
            sampleRateHz: medianRateHz(t),
            channels: {
                timeUs: t,
                gyroAdc: [ch["gyroADC[0]"], ch["gyroADC[1]"], ch["gyroADC[2]"]],
                gyroUnfilt: unfilt.every(Boolean) ? (unfilt as [Float64Array, Float64Array, Float64Array]) : null,
                erpm: (ex.erpm ?? []).filter((c) => c.length === t.length),
                rcThrottle: ch["rcCommand[3]"],
                axisD: ex.dTerm
                    ? [
                          ex.present.axisDAxes[0] ? aligned(ex.dTerm[0]) : null,
                          ex.present.axisDAxes[1] ? aligned(ex.dTerm[1]) : null,
                          ex.present.axisDAxes[2] ? aligned(ex.dTerm[2]) : null,
                      ]
                    : null,
                motors: ex.motors?.every((c) => c.length === t.length) ? ex.motors : null,
            },
            chirp,
            stick: {
                acroSeconds: m4log?.feedforward.executable ? m4log.feedforward.stickDurationS : 0,
                latencyMs: { roll: latency("roll"), pitch: latency("pitch"), yaw: latency("yaw") },
            },
            noiseFloorKnown: !!m4log && m4log.filters.gyroLpf.spectrum.every((s) => s.noiseFloorDb !== null),
        });
    }
    return out;
}

/** The logged P/I/D/F of all axes: logs with the same key were flown with the same tune. */
export function tuneKey(log: AutotuneLogInput): string {
    const h = new Map(log.headerPairs.map(([k, v]) => [k, v]));
    return ["rollPID", "pitchPID", "yawPID", "ff_weight", "d_max"].map((k) => h.get(k) ?? "").join("|");
}

/** Logs grouped by tune, the most recently imported tune first. */
export function groupByTune(logs: AutotuneLogInput[]): AutotuneLogInput[][] {
    const groups = new Map<string, AutotuneLogInput[]>();
    for (const l of logs) groups.set(tuneKey(l), [...(groups.get(tuneKey(l)) ?? []), l]);
    const newest = (g: AutotuneLogInput[]) => Math.max(...g.map((l) => l.order ?? 0));
    return [...groups.values()].sort((a, b) => newest(b) - newest(a));
}

const score = (l: AutotuneLogInput) =>
    Object.values(l.chirp).reduce((s, c) => s + (STATE_RANK[c!.state] ?? 0) * 1000 + (c!.end - c!.start) / 1e6, 0);

/** The best log of a group: most qualified axes, then the longest sweeps, then the earliest import. */
export function bestLog(logs: AutotuneLogInput[]): AutotuneLogInput {
    return [...logs].sort((a, b) => score(b) - score(a) || (a.order ?? 0) - (b.order ?? 0))[0];
}

/**
 * Primary log: the best log of the most recently imported tune (what the flight controller is
 * expected to hold); the others serve as cross-log references (same tune only).
 */
export function pickPrimary(
    logs: AutotuneLogInput[],
): { primary: AutotuneLogInput; others: AutotuneLogInput[] } | null {
    if (!logs.length) return null;
    const primary = bestLog(groupByTune(logs)[0]);
    return { primary, others: logs.filter((l) => l !== primary) };
}
