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
import { WELCH_OVERLAP, type ChirpMeasurement, type ChirpQualificationReport } from "@/gyrocore/chirp/qualification";
import { welchTransferFunction } from "@/js/blackbox/spectral_analysis";
import { UNCERTAINTY } from "./loopModel";
import { loggedAbsoluteValues } from "@/gyrocore/tuning/absoluteTune";
import { logIdentity } from "@/gyrocore/tuning/fcIdentity";
import type { AutotuneLogInput, ChirpAxisInput, FlightFragment } from "./autotuneV2";
import type { AxisName } from "./safetyEvidence";

const FIELDS = [
    "loopIteration",
    "time",
    "setpoint[0]",
    "setpoint[1]",
    "setpoint[2]",
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

/**
 * The longest power-of-two Welch segment a window of `windowSamples` samples analyses into at least
 * UNCERTAINTY.minWelchSegments segments at 50 % overlap (n ≥ N · (K + 1) / 2), or null below 256
 * samples. Its resolution is what the samples can give, nothing interpolated.
 */
export function finestWelchSegment(windowSamples: number): number | null {
    const max = (2 * windowSamples) / (UNCERTAINTY.minWelchSegments + 1);
    if (!(max >= 256)) return null;
    return 2 ** Math.floor(Math.log2(max));
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
        const setpoint = [ch["setpoint[0]"], ch["setpoint[1]"], ch["setpoint[2]"]];
        for (const [axis, m] of Object.entries(best) as [AxisName, ChirpMeasurement][]) {
            const start = firstAtOrAfter(t, m.startTimeUs);
            const end = firstAtOrAfter(t, m.endTimeUs);
            const ai = (["roll", "pitch", "yaw"] as const).indexOf(axis);
            const fs = m.sampleRate.effectiveRateHz;
            const N = finestWelchSegment(end - start);
            const sp = aligned(setpoint[ai]);
            // The finer identification for a model-class qualification: the same samples, the
            // longest segment that still averages enough (never the qualified `tf` itself).
            const fine =
                fs && N && sp && N > (m.segmentSize ?? Infinity)
                    ? (() => {
                          const tf = welchTransferFunction(
                              sp.subarray(start, end),
                              (ch[`gyroADC[${ai}]`] as Float64Array).subarray(start, end),
                              fs,
                              N,
                              WELCH_OVERLAP,
                          );
                          return {
                              tf,
                              analysis: {
                                  segmentSamples: N,
                                  sampleRateHz: fs,
                                  windowSamples: end - start,
                                  segments: tf.numSegments,
                              },
                          };
                      })()
                    : undefined;
            chirp[axis] = {
                ...(fine ? { fine } : {}),
                tf: m.diagnostics!.transferFunction,
                start,
                end,
                state: m.state,
                qualificationReasons: m.apply.blocked.filter((r) => r.startsWith("measurement:")),
                ...(m.segmentSize && m.sampleRate.effectiveRateHz
                    ? {
                          analysis: {
                              segmentSamples: m.segmentSize,
                              sampleRateHz: m.sampleRate.effectiveRateHz,
                              windowSamples: m.sampleCount,
                              segments: m.diagnostics!.transferFunction.numSegments,
                          },
                      }
                    : {}),
            };
        }
        const iterations = ch.loopIteration;
        const firstIteration = iterations && Number.isFinite(iterations[0]) ? iterations[0] : null;
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
            session: { firstIteration, startDatetime: logStartDatetime(log.headerPairs) },
        });
    }
    return out;
}

/**
 * The header's `Log start datetime`, or null: absent, unparseable, or the firmware's placeholder
 * without a real-time clock (year 0000, as most FPV flight controllers log it).
 */
export function logStartDatetime(pairs: readonly (readonly [string, string])[]): string | null {
    const raw = pairs.find(([k]) => k === "Log start datetime")?.[1]?.trim();
    if (!raw || /^0000-/.test(raw) || !Number.isFinite(Date.parse(raw))) return null;
    return raw;
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
            session: log.session,
            firstTimeUs: log.channels.timeUs.length ? log.channels.timeUs[0] : null,
        },
    ];
}

/**
 * How two logs' flights relate (audit F-01). Shared content proves one flight; its absence proves
 * nothing on its own, since two disjoint fragments of one flight share no sample. So:
 *
 *   SAME         the same log, the same samples (fingerprint), or FLIGHT_WINDOW.minShared shared
 *                active windows or more (trimmed, re-exported, time-shifted, overlapping fragments).
 *   INDEPENDENT  positive evidence of two recording sessions: no shared active window, both with
 *                enough active windows (minShared) that an overlap would have shown, both holding
 *                their session's first frame (loopIteration 0: the firmware starts every log there,
 *                an export from inside a session does not), and not the same session start (equal
 *                first sample time, or equal real `Log start datetime`).
 *   UNKNOWN      anything else: a few shared windows, too little movement to tell, a fragment
 *                without its session start, missing metadata. It never counts as a repeat, a
 *                reference, a qualification or a Verified Tune repeat, and is not merged either.
 */
export type FlightRelation = "SAME" | "INDEPENDENT" | "UNKNOWN";

export interface FlightRelationVerdict {
    relation: FlightRelation;
    /** Why it is not INDEPENDENT (empty when it is). */
    reasons: string[];
}

function sharedCount(a: FlightFragment, b: FlightFragment): number {
    const [small, large] = a.windows.size <= b.windows.size ? [a.windows, b.windows] : [b.windows, a.windows];
    let n = 0;
    for (const w of small) if (large.has(w)) n++;
    return n;
}

/**
 * The relation between two flights, each given by every fragment known to belong to it (the
 * fragments of one flight are linked by shared samples, so they share one recording session):
 * SAME if any pair of fragments is the same flight; INDEPENDENT only on the evidence above, with
 * a flight's session start shown by any one of its fragments.
 */
function fragmentsRelation(fa: readonly FlightFragment[], fb: readonly FlightFragment[]): FlightRelationVerdict {
    if (!fa.length || !fb.length) return { relation: "UNKNOWN", reasons: ["no_fragments"] };
    let shared = 0;
    for (const x of fa) {
        for (const y of fb) {
            if (x.sha256 === y.sha256 && x.logIndex === y.logIndex) return { relation: "SAME", reasons: ["same_log"] };
            if (x.fingerprint === y.fingerprint) return { relation: "SAME", reasons: ["same_samples"] };
            const n = sharedCount(x, y);
            if (n >= FLIGHT_WINDOW.minShared) return { relation: "SAME", reasons: [`shared_windows:${n}`] };
            shared += n;
        }
    }
    const reasons: string[] = [];
    const id = (f: FlightFragment) => `${f.sha256}:${f.logIndex}`;
    // A few bit-identical windows are shared samples: not one flight by the threshold, never two.
    if (shared > 0) reasons.push(`samples_in_common:${shared}_windows`);
    for (const f of [...fa, ...fb]) {
        // Too little movement: an overlap with the other flight could not have shown.
        if (f.windows.size < FLIGHT_WINDOW.minShared) reasons.push(`too_little_movement_to_tell:${id(f)}`);
    }
    const anchors: FlightFragment[] = [];
    for (const fs of [fa, fb]) {
        const anchor = fs.find((f) => f.session?.firstIteration === 0);
        if (anchor) {
            anchors.push(anchor);
            continue;
        }
        reasons.push(
            fs.every((f) => f.session?.firstIteration == null)
                ? `session_evidence_missing:${id(fs[0])}`
                : `session_start_not_in_log:${id(fs[0])}`,
        );
    }
    if (
        anchors.length === 2 &&
        typeof anchors[0].firstTimeUs === "number" &&
        anchors[0].firstTimeUs === anchors[1].firstTimeUs
    ) {
        reasons.push("same_session_start_time");
    }
    const dates = (fs: readonly FlightFragment[]) => new Set(fs.map((f) => f.session?.startDatetime).filter(Boolean));
    const db = dates(fb);
    if ([...dates(fa)].some((d) => db.has(d))) reasons.push("same_session_datetime");
    return reasons.length ? { relation: "UNKNOWN", reasons } : { relation: "INDEPENDENT", reasons: [] };
}

/** How the flights of `a` and `b` relate, over every fragment each stands for (uniqueFlights). */
export function flightRelation(a: AutotuneLogInput, b: AutotuneLogInput): FlightRelationVerdict {
    return fragmentsRelation(flightFragments(a), flightFragments(b));
}

/**
 * Same log of the same file, the same samples under another file, or the same flight trimmed,
 * re-exported or time-shifted (FLIGHT_WINDOW.minShared shared active windows or more). A log kept
 * by uniqueFlights for several files matches whatever any of them matches. Not SAME is not
 * independent: see flightRelation.
 */
export function sameFlight(a: AutotuneLogInput, b: AutotuneLogInput): boolean {
    return flightRelation(a, b).relation === "SAME";
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

/**
 * Header values beyond the absolute fields that the models read (audit WP8): the loop rates, the
 * gyro chain (gyroChain.chainConfigFromHeaders), the D path (dtermConfigFromHeaders) and the
 * controller model (controllerConfigFromHeaders). Not the sweep settings (a qualification flight
 * sweeps differently by design) nor values the firmware computes per flight.
 */
export const PLANT_CONFIG_KEYS = [
    "looptime",
    "pid_process_denom",
    "motor_poles",
    "gyro_notch_hz",
    "dterm_notch_hz",
    "gyro_lpf1_type",
    "gyro_lpf1_static_hz",
    "gyro_lpf1_dyn_hz",
    "gyro_lpf1_dyn_expo",
    "gyro_lpf2_type",
    "gyro_lpf2_static_hz",
    "dyn_notch_count",
    "dyn_notch_q",
    "dyn_notch_min_hz",
    "dyn_notch_max_hz",
    "rpm_filter_harmonics",
    "rpm_filter_q",
    "rpm_filter_min_hz",
    "rpm_filter_fade_range_hz",
    "rpm_filter_lpf_hz",
    "rpm_filter_weights",
    "dterm_lpf1_type",
    "dterm_lpf1_static_hz",
    "dterm_lpf1_dyn_hz",
    "dterm_lpf1_dyn_expo",
    "dterm_lpf2_type",
    "dterm_lpf2_static_hz",
    "throttle_limit_type",
    "yaw_lowpass_hz",
    "chirp_lag_freq_hz",
    "chirp_lead_freq_hz",
];

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
    const groups = flightGroups([primary, other, ...pool.filter((l) => l !== primary && l !== other)]);
    const groupOf = (l: AutotuneLogInput) => groups.find((g) => g.includes(l)) ?? [l];
    if (sameFlight(primary, other) || groupOf(primary).includes(other)) {
        return [`cross_log_duplicate_of_primary:${other.sha256}:${other.logIndex}`];
    }
    const out: string[] = [];
    // Independent only on positive evidence, over every fragment either flight is known by.
    const relation = fragmentsRelation(
        groupOf(primary).flatMap(flightFragments),
        groupOf(other).flatMap(flightFragments),
    );
    if (relation.relation !== "INDEPENDENT") {
        out.push(...relation.reasons.map((r) => `cross_log_independence_unproven:${r}`));
    }
    const a = logIdentity(primary.headerPairs);
    const b = logIdentity(other.headerPairs);
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
    return [...new Set(out)];
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
