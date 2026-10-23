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
import type { AutotuneLogInput, ChirpAxisInput, FlightFragment } from "./autotuneV2";
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

/**
 * Window identity of a flight, independent of file boundaries and of the time base: the gyroADC
 * stream is cut at content-defined anchors (a sample whose own hash is 0 mod `anchorModulo`), and
 * each window of `samples` samples from an anchor is hashed. A trimmed, re-exported or time-shifted
 * copy of the same flight cuts at the same anchors inside the shared stretch and so carries the
 * same window hashes; two independent flights never share a window, because a window is 256
 * samples × 3 axes of gyro noise equal to 1e-3 (a chance collision of the 64-bit hash aside).
 *
 * Windows in which no axis moves more than `minSpan` (constant / clipped / zero stretches, as on
 * the bench or when a log was padded) are not counted: any two logs could share those.
 */
export const FLIGHT_WINDOW = Object.freeze({
    /** Samples per window: 256 (64 ms at 4 kHz, 32 ms at 8 kHz). */
    samples: 256,
    /** Anchor density: about one window start per 64 samples. */
    anchorModulo: 64,
    /** Gyro quantum before hashing (an exact copy agrees to it; a re-identification does not). */
    quantum: 1e-3,
    /** Smallest peak-to-peak gyro movement (log units) of any axis for a window to count. */
    minSpan: 1,
    /**
     * Shared active windows that make two logs the same flight: 4 (≈ 0.26 s of bit-identical gyro
     * at 4 kHz, a quarter of the shortest CHIRP segment the engine analyses). Trimming or shifting
     * a flight leaves hundreds; independent flights leave none.
     */
    minShared: 4,
});

const windowSets = new WeakMap<object, Set<string>>();

/** The active window hashes of a flight (cached per channel set). */
export function flightWindows(log: AutotuneLogInput): Set<string> {
    const cached = windowSets.get(log.channels);
    if (cached) return cached;
    const { samples, anchorModulo, quantum, minSpan } = FLIGHT_WINDOW;
    const [g0, g1, g2] = log.channels.gyroAdc;
    const n = Math.min(g0.length, g1.length, g2.length);
    const q = (v: number) => (Number.isFinite(v) ? Math.round(v / quantum) | 0 : 0x7fffffff);
    const out = new Set<string>();
    for (let k = 0; k + samples <= n; k++) {
        const a = Math.imul(q(g0[k]) ^ Math.imul(q(g1[k]), 0x9e3779b1) ^ Math.imul(q(g2[k]), 0x85ebca6b), 0x27d4eb2f);
        if ((a >>> 0) % anchorModulo !== 0) continue;
        let span = 0;
        for (const g of [g0, g1, g2]) {
            let lo = Infinity;
            let hi = -Infinity;
            for (let j = k; j < k + samples; j++) {
                const v = g[j];
                if (v < lo) lo = v;
                if (v > hi) hi = v;
            }
            span = Math.max(span, hi - lo);
        }
        if (!(span > minSpan)) {
            // A flat stretch anchors at every sample; its windows are not counted anyway.
            k += samples / 2 - 1;
            continue;
        }
        let h1 = 0x811c9dc5;
        let h2 = 0x01000193;
        for (const g of [g0, g1, g2]) {
            for (let j = k; j < k + samples; j++) {
                const x = q(g[j]);
                h1 = Math.imul(h1 ^ x, 0x01000193);
                h2 = Math.imul(h2 ^ x, 0x5bd1e995);
            }
        }
        out.add(`${(h1 >>> 0).toString(16)}:${(h2 >>> 0).toString(16)}`);
    }
    windowSets.set(log.channels, out);
    return out;
}

/** Active windows two flights have in common. */
export function sharedWindows(a: AutotuneLogInput, b: AutotuneLogInput): number {
    const wa = flightWindows(a);
    const wb = flightWindows(b);
    const [small, large] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
    let n = 0;
    for (const w of small) if (large.has(w)) n++;
    return n;
}

/**
 * The identities a log stands for: its own, or, for the file uniqueFlights kept for a flight
 * carried by several files, those of all of them.
 */
export function flightFragments(log: AutotuneLogInput): readonly FlightFragment[] {
    if (log.flightGroup?.length) return log.flightGroup;
    return [
        {
            sha256: log.sha256,
            logIndex: log.logIndex,
            fingerprint: flightFingerprint(log),
            windows: flightWindows(log),
        },
    ];
}

function sameFragment(a: FlightFragment, b: FlightFragment): boolean {
    if (a.sha256 === b.sha256 && a.logIndex === b.logIndex) return true;
    if (a.fingerprint === b.fingerprint) return true;
    const [small, large] = a.windows.size <= b.windows.size ? [a.windows, b.windows] : [b.windows, a.windows];
    let n = 0;
    for (const w of small) if (large.has(w) && ++n >= FLIGHT_WINDOW.minShared) return true;
    return false;
}

/**
 * Same log of the same file, the same samples under another file, or the same flight trimmed,
 * re-exported or time-shifted (FLIGHT_WINDOW.minShared shared active windows or more). A log kept
 * by uniqueFlights for several files matches whatever any of them matches.
 */
export function sameFlight(a: AutotuneLogInput, b: AutotuneLogInput): boolean {
    const fb = flightFragments(b);
    return flightFragments(a).some((x) => fb.some((y) => sameFragment(x, y)));
}

/**
 * Logs grouped by flight, transitively: fragments A and C of one flight share no sample, but a
 * third fragment B overlapping both proves all three one flight (Codex final review F-01). Groups
 * are in the input order of their first log.
 */
export function flightGroups(logs: readonly AutotuneLogInput[]): AutotuneLogInput[][] {
    const parent = logs.map((_, i) => i);
    const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i])));
    for (let i = 0; i < logs.length; i++) {
        for (let j = i + 1; j < logs.length; j++) {
            if (root(i) !== root(j) && sameFlight(logs[i], logs[j]))
                parent[Math.max(root(i), root(j))] = Math.min(root(i), root(j));
        }
    }
    const groups = new Map<number, AutotuneLogInput[]>();
    logs.forEach((l, i) => groups.set(root(i), [...(groups.get(root(i)) ?? []), l]));
    return [...groups.values()];
}

/**
 * Every flight once, in the input order of its first file. Of several files carrying one flight
 * (directly or through overlapping fragments, flightGroups) the longest is kept, ties broken by
 * file hash and log index so the choice does not depend on the import order; the kept log carries
 * the identity of the whole group (flightGroup), so the dropped files still count as this flight.
 */
export function uniqueFlights(logs: readonly AutotuneLogInput[]): AutotuneLogInput[] {
    return flightGroups(logs).map((group) => {
        if (group.length === 1) return group[0];
        const kept = [...group].sort(
            (a, b) =>
                b.channels.timeUs.length - a.channels.timeUs.length ||
                (a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0) ||
                a.logIndex - b.logIndex,
        )[0];
        const fragments = new Map<string, FlightFragment>();
        for (const f of group.flatMap(flightFragments)) fragments.set(`${f.sha256}:${f.logIndex}:${f.fingerprint}`, f);
        return { ...kept, flightGroup: [...fragments.values()] };
    });
}

/** Header values beyond the absolute fields that shape the identified plant. */
const PLANT_CONFIG_KEYS = ["looptime", "pid_process_denom", "motor_poles", "gyro_notch_hz", "dterm_notch_hz"];

/**
 * Why `other` cannot serve as an independent repeat of `primary` (empty: it can): not the same
 * flight, the same craft and firmware, and the same logged configuration. `pool` are the further
 * logs at hand: a fragment among them that overlaps both makes `other` the primary's flight too.
 */
export function crossLogReferenceIssues(
    primary: AutotuneLogInput,
    other: AutotuneLogInput,
    pool: readonly AutotuneLogInput[] = [],
): string[] {
    const linked =
        sameFlight(primary, other) ||
        (pool.length > 0 &&
            flightGroups([primary, other, ...pool.filter((l) => l !== primary && l !== other)]).some(
                (g) => g.includes(primary) && g.includes(other),
            ));
    if (linked) return [`cross_log_duplicate_of_primary:${other.sha256}:${other.logIndex}`];
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
export function groupByTune(logs: readonly AutotuneLogInput[]): AutotuneLogInput[][] {
    const groups = new Map<string, AutotuneLogInput[]>();
    for (const l of logs) groups.set(tuneKey(l), [...(groups.get(tuneKey(l)) ?? []), l]);
    const newest = (g: AutotuneLogInput[]) => Math.max(...g.map((l) => l.order ?? 0));
    return [...groups.values()].sort((a, b) => newest(b) - newest(a));
}

const score = (l: AutotuneLogInput) =>
    Object.values(l.chirp).reduce((s, c) => s + (STATE_RANK[c!.state] ?? 0) * 1000 + (c!.end - c!.start) / 1e6, 0);

/** The best log of a group: most qualified axes, then the longest sweeps, then the earliest import. */
export function bestLog(logs: readonly AutotuneLogInput[]): AutotuneLogInput {
    return [...logs].sort((a, b) => score(b) - score(a) || (a.order ?? 0) - (b.order ?? 0))[0];
}

/**
 * Primary log: the best log of the most recently imported tune (what the flight controller is
 * expected to hold); the others serve as cross-log references (same tune only).
 */
export function pickPrimary(
    logs: readonly AutotuneLogInput[],
): { primary: AutotuneLogInput; others: AutotuneLogInput[] } | null {
    const unique = uniqueFlights(logs);
    if (!unique.length) return null;
    const primary = bestLog(groupByTune(unique)[0]);
    return { primary, others: unique.filter((l) => l !== primary) };
}
