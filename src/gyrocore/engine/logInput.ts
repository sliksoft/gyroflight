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
import { loggedAbsoluteValues } from "@/gyrocore/tuning/absoluteTune";
import { logIdentity } from "@/gyrocore/tuning/fcIdentity";
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

const fingerprints = new WeakMap<object, string>();

/**
 * Content fingerprint of a flight: the logged time base and gyroADC of every sample. Two inputs
 * with the same fingerprint are the same measurement, whatever file (hash, name) carried them.
 */
export function flightFingerprint(log: AutotuneLogInput): string {
    const cached = fingerprints.get(log.channels);
    if (cached) return cached;
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    const mix = (v: number) => {
        const x = Number.isFinite(v) ? Math.round(v * 1000) | 0 : 0x7fffffff;
        h1 = Math.imul(h1 ^ x, 0x01000193);
        h2 = Math.imul(h2 ^ x, 0x5bd1e995);
    };
    const { timeUs, gyroAdc } = log.channels;
    for (let k = 0; k < timeUs.length; k++) {
        mix(timeUs[k]);
        mix(gyroAdc[0][k]);
        mix(gyroAdc[1][k]);
        mix(gyroAdc[2][k]);
    }
    const fp = `${timeUs.length}:${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}`;
    fingerprints.set(log.channels, fp);
    return fp;
}

/** Same log of the same file, or the same flight carried by another file. */
export function sameFlight(a: AutotuneLogInput, b: AutotuneLogInput): boolean {
    return (a.sha256 === b.sha256 && a.logIndex === b.logIndex) || flightFingerprint(a) === flightFingerprint(b);
}

/** Every flight once (the first occurrence is kept, in input order). */
export function uniqueFlights(logs: AutotuneLogInput[]): AutotuneLogInput[] {
    const out: AutotuneLogInput[] = [];
    for (const l of logs) if (!out.some((o) => sameFlight(o, l))) out.push(l);
    return out;
}

/** Header values beyond the absolute fields that shape the identified plant. */
const PLANT_CONFIG_KEYS = ["looptime", "pid_process_denom", "motor_poles", "gyro_notch_hz", "dterm_notch_hz"];

/**
 * Why `other` cannot serve as an independent repeat of `primary` (empty: it can): not the same
 * flight, the same craft and firmware, and the same logged configuration.
 */
export function crossLogReferenceIssues(primary: AutotuneLogInput, other: AutotuneLogInput): string[] {
    if (sameFlight(primary, other)) return [`cross_log_duplicate_of_primary:${other.sha256}:${other.logIndex}`];
    const a = logIdentity(primary.headerPairs);
    const b = logIdentity(other.headerPairs);
    const out: string[] = [];
    if (!a.uid || !b.uid || a.uid.some((w, i) => w !== b.uid![i]) || a.board !== b.board) {
        out.push("cross_log_other_craft");
    }
    if (!a.firmwareRevision || a.firmwareRevision !== b.firmwareRevision) out.push("cross_log_other_firmware");
    const va = loggedAbsoluteValues(primary.headerPairs);
    const vb = loggedAbsoluteValues(other.headerPairs);
    const ha = new Map(primary.headerPairs);
    const hb = new Map(other.headerPairs);
    for (const k of new Set([...Object.keys(va), ...Object.keys(vb)])) {
        if (va[k] !== vb[k]) out.push(`cross_log_config_differs:${k}`);
    }
    for (const k of PLANT_CONFIG_KEYS) {
        if (ha.get(k) !== hb.get(k)) out.push(`cross_log_config_differs:${k}`);
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
    const unique = uniqueFlights(logs);
    if (!unique.length) return null;
    const primary = bestLog(groupByTune(unique)[0]);
    return { primary, others: unique.filter((l) => l !== primary) };
}
