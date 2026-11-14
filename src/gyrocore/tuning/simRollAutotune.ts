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
 * Closed roll autotune loop against a simulator (pure; no I/O).
 *
 * GyroFlight chooses roll P/I/D candidates inside a pre-registered box, a simulator in
 * which Betaflight runs the PID loop measures each one on fixed roll manoeuvres, and
 * the measured response decides which candidate goes on. The selected tune is then
 * measured again on held-out manoeuvres against the start tune; if the improvement
 * does not hold there, the start tune is kept. Everything numeric (box, budget, step
 * factors, thresholds, manoeuvres) comes from the pre-registration; this module only
 * applies it. The measurement itself is injected (`Measure`), so the loop is tested
 * with synthetic traces and run against the SITL by scripts/sim/air65RollAutotune.ts.
 *
 * Only roll P, I and D move (D carries d_max at the pre-registered ratio); filters,
 * rates and the other axes are the base configuration's and are checked unchanged in
 * every measurement's header.
 */

export interface RollPid {
    p: number;
    i: number;
    d: number;
}

export interface Segment {
    rollDps: number;
    /** 10 ms command ticks */
    ticks: number;
}

export interface Manoeuvre {
    id: string;
    segments: Segment[];
}

export interface Thresholds {
    /** composite cost (tracking + overshoot) must fall at least this share below the reference */
    minRelativeGain: number;
    /** tracking error may not rise more than this share above the reference */
    trackingTolerance: number;
    /** overshoot may not rise more than this (absolute share of the step) above the reference */
    overshootToleranceAbs: number;
    /** rise time may be at most reference * (1 + riseTolerance) + riseToleranceMs */
    riseTolerance: number;
    riseToleranceMs: number;
    /** absolute rejection: residual oscillation (peak-to-peak error after settleDelayMs, share of the step) */
    oscillationMax: number;
    settleDelayMs: number;
    /** absolute rejection: share of window samples with a motor at or beyond a limit */
    saturationShareMax: number;
    motorHigh: number;
    motorLow: number;
    /** flight envelope: beyond it the candidate failed the manoeuvre */
    maxAbsRollDeg: number;
    minZ: number;
}

export interface SearchSpec {
    bounds: { p: [number, number]; i: [number, number]; d: [number, number] };
    /** d_max_roll = round(d * dMaxRatio) */
    dMaxRatio: number;
    /** step factors per round (up; down is 1/up); one round = P up, P down, D up, D down, I up, I down */
    stepFactors: number[];
    budget: number;
}

export interface Preregistration {
    version: string;
    leadTicks: number;
    settleTicks: number;
    searchManoeuvres: Manoeuvre[];
    holdoutManoeuvres: Manoeuvre[];
    thresholds: Thresholds;
    search: SearchSpec;
    holdoutRepeats: number;
    startTunes: { id: string; pid: RollPid; rationale: string }[];
}

/** A command schedule (deg/s per 10 ms tick) with each manoeuvre's tick window. */
export interface Schedule {
    rollDps: number[];
    windows: { id: string; startTick: number; endTick: number }[];
}

export function buildSchedule(manoeuvres: Manoeuvre[], leadTicks: number, settleTicks: number): Schedule {
    const rollDps: number[] = [];
    const windows: Schedule["windows"] = [];
    for (let n = 0; n < leadTicks; n++) rollDps.push(0);
    for (const m of manoeuvres) {
        const startTick = rollDps.length;
        for (const s of m.segments) for (let n = 0; n < s.ticks; n++) rollDps.push(s.rollDps);
        for (let n = 0; n < settleTicks; n++) rollDps.push(0);
        windows.push({ id: m.id, startTick, endTick: rollDps.length });
    }
    return { rollDps, windows };
}

export function dMaxFor(d: number, ratio: number): number {
    return Math.round(d * ratio);
}

/** What the measurement adapter returns (scripts/sim/air65_roll_sitl.py result.json). */
export interface Measurement {
    status: "ok" | "harness_error";
    reason: string | null;
    header?: { values: Record<string, string>; duplicates: string[] };
    trace?: { dtS: number; setpointDps: number[]; gyroDps: number[]; motors: number[][] };
    plant?: { maxAbsRollDeg: number; minZ: number; finite: boolean };
    /** [command index, PID ticks to the next command] for every later gap other than 10 (lockstep phase slips) */
    commandPhaseSlips?: [number, number][];
}

export const SAMPLES_PER_TICK = 10;
/**
 * Header lines Betaflight fills at run time: the RX-rate estimate behind RC smoothing differs
 * by one between SITL runs of one configuration (seen in the calibration repeats), as on the
 * AIR65 logs of block 9. Every other line must equal the base run.
 */
export const RUNTIME_HEADER_KEYS = new Set([
    "vbatref",
    "rc_smoothing_active_cutoffs_ff_sp_thr",
    "rc_smoothing_rx_smoothed",
]);

/**
 * Validity of one measurement for the requested tune: the header must carry exactly the
 * requested roll PID and d_max and otherwise equal the base header, the log must be high
 * resolution at 1 kHz, and the logged setpoint must follow the commanded schedule (the
 * firmware takes a command up to one tick late). Issues mean the measurement says nothing
 * about the candidate; they are never a candidate rejection.
 */
export function validateMeasurement(
    m: Measurement,
    pid: RollPid,
    dMax: number,
    schedule: Schedule,
    baseHeader: Record<string, string> | null,
): string[] {
    const issues: string[] = [];
    if (m.status !== "ok") return [`harness:${m.reason ?? "unknown"}`];
    if (!m.header || !m.trace || !m.plant) return ["measurement_incomplete"];
    const h = m.header.values;
    if (m.header.duplicates.length) issues.push(`header_duplicate:${m.header.duplicates.join(",")}`);
    if (h.rollPID !== `${pid.p},${pid.i},${pid.d}`)
        issues.push(`roll_pid_expected_${pid.p},${pid.i},${pid.d}:${h.rollPID}`);
    const dMaxRoll = (h.d_max ?? "").split(",")[0];
    if (dMaxRoll !== String(dMax)) issues.push(`d_max_roll_expected_${dMax}:${dMaxRoll}`);
    if (h.blackbox_high_resolution !== "1") issues.push("blackbox_not_high_resolution");
    if (h.looptime !== "1000") issues.push(`looptime:${h.looptime}`);
    if (baseHeader) {
        const keys = new Set([...Object.keys(baseHeader), ...Object.keys(h)]);
        for (const k of keys) {
            if (k === "rollPID" || k === "d_max" || RUNTIME_HEADER_KEYS.has(k)) continue;
            if (!(k in h)) issues.push(`header_missing:${k}`);
            else if (!(k in baseHeader)) issues.push(`header_added:${k}`);
            else if (h[k] !== baseHeader[k]) issues.push(`header_changed:${k}:${baseHeader[k]}:${h[k]}`);
        }
        const rest = (s: string | undefined) => (s ?? "").split(",").slice(1).join(",");
        if (rest(h.d_max) !== rest(baseHeader.d_max))
            issues.push(`header_changed:d_max_pitch_yaw:${baseHeader.d_max}:${h.d_max}`);
    }
    const n = schedule.rollDps.length * SAMPLES_PER_TICK;
    const sp = m.trace.setpointDps;
    if (sp.length !== n || m.trace.gyroDps.length !== n || m.trace.motors.length !== n) {
        issues.push(`trace_length:${sp.length}:${n}`);
        return issues;
    }
    if (setpointLag(sp, schedule) === null) {
        // Only a logged command-delivery phase slip that accounts for every mismatching sample makes this a harness
        // fault (retried); any other mismatch is a wrong setpoint.
        const slips = m.commandPhaseSlips ?? [];
        issues.push(
            slips.length && slipsExplainSetpoint(sp, schedule, slips)
                ? `harness:command_phase_slip:${slips.map(([i, g]) => `${i}+${g}`).join(",")}`
                : "setpoint_not_schedule",
        );
    }
    if (!m.trace.gyroDps.every(Number.isFinite)) issues.push("gyro_not_finite");
    return issues;
}

/**
 * The constant delay (samples, whole command ticks up to MAX_LAG_TICKS) after which the
 * logged setpoint equals the commanded schedule at every sample, or null if there is none.
 * The SITL takes a command one or two ticks after it was sent; the delay is constant within
 * a run but not between runs.
 */
export const MAX_LAG_TICKS = 2;
export function setpointLag(sp: number[], schedule: Schedule): number | null {
    for (let lagTicks = 0; lagTicks <= MAX_LAG_TICKS; lagTicks++) {
        let ok = true;
        for (let k = 0; k < sp.length && ok; k++) {
            const tick = Math.floor(k / SAMPLES_PER_TICK) - lagTicks;
            const want = tick >= 0 ? schedule.rollDps[tick] : 0;
            if (Math.abs(sp[k] - want) > 0.05) ok = false;
        }
        if (ok) return lagTicks * SAMPLES_PER_TICK;
    }
    return null;
}

/**
 * Does the setpoint follow the schedule once the logged phase slips are applied? Slip [i, g]
 * delays every command after command i by g - 10 samples; on top of that one constant delay of
 * 0 to MAX_LAG_TICKS ticks is allowed, as in setpointLag.
 */
export function slipsExplainSetpoint(sp: number[], schedule: Schedule, slips: [number, number][]): boolean {
    for (let lagTicks = 0; lagTicks <= MAX_LAG_TICKS; lagTicks++) {
        const starts = schedule.rollDps.map(
            (_, j) =>
                (j + lagTicks) * SAMPLES_PER_TICK +
                slips.filter(([i]) => i < j).reduce((sum, [, g]) => sum + g - SAMPLES_PER_TICK, 0),
        );
        let j = -1;
        let ok = true;
        for (let k = 0; k < sp.length && ok; k++) {
            while (j + 1 < starts.length && starts[j + 1] <= k) j++;
            const want = j >= 0 ? schedule.rollDps[j] : 0;
            if (Math.abs(sp[k] - want) > 0.05) ok = false;
        }
        if (ok) return true;
    }
    return false;
}

/** Flight-envelope failures caused by the candidate (it lost the manoeuvre). */
export function envelopeFailures(m: Measurement, t: Thresholds): string[] {
    const out: string[] = [];
    if (!m.plant) return out;
    if (!m.plant.finite) out.push("plant_not_finite");
    if (m.plant.maxAbsRollDeg > t.maxAbsRollDeg) out.push(`roll_angle_${m.plant.maxAbsRollDeg.toFixed(1)}_deg`);
    if (m.plant.minZ < t.minZ) out.push(`height_${m.plant.minZ.toFixed(2)}_m`);
    return out;
}

export interface ManoeuvreMetrics {
    id: string;
    trackingRel: number;
    overshoot: number;
    riseMs: number;
    oscillation: number;
    saturationShare: number;
}

export interface SetMetrics {
    tracking: number;
    overshoot: number;
    riseMs: number;
    oscillation: number;
    saturationShare: number;
    cost: number;
    perManoeuvre: ManoeuvreMetrics[];
}

function rms(xs: number[]): number {
    if (!xs.length) return 0;
    let s = 0;
    for (const x of xs) s += x * x;
    return Math.sqrt(s / xs.length);
}

/**
 * Metrics of one manoeuvre window. Edges are the logged setpoint's changes. Per edge:
 * overshoot = excess beyond the new value in the direction of the step, as a share of
 * the step, over the edge's segment; rise = ms until the gyro first crosses 90 % of the
 * step; oscillation = peak-to-peak error from settleDelayMs after the edge to the next
 * edge, as a share of the step. Tracking = RMS error / RMS setpoint over the window.
 */
export function manoeuvreMetrics(
    id: string,
    sp: number[],
    gy: number[],
    motors: number[][],
    dtS: number,
    t: Thresholds,
): ManoeuvreMetrics {
    const err = sp.map((v, k) => gy[k] - v);
    const trackingRel = rms(err) / Math.max(rms(sp), 1e-9);
    const edges: number[] = [];
    for (let k = 1; k < sp.length; k++) if (Math.abs(sp[k] - sp[k - 1]) > 0.05) edges.push(k);
    let overshoot = 0;
    let oscillation = 0;
    const rises: number[] = [];
    const settle = Math.round(t.settleDelayMs / 1000 / dtS);
    for (let e = 0; e < edges.length; e++) {
        const k0 = edges[e];
        const k1 = e + 1 < edges.length ? edges[e + 1] : sp.length;
        const target = sp[k0];
        const step = target - sp[k0 - 1];
        const dir = Math.sign(step);
        const size = Math.abs(step);
        let excess = 0;
        let rise = -1;
        for (let k = k0; k < k1; k++) {
            excess = Math.max(excess, dir * (gy[k] - target));
            if (rise < 0 && dir * (gy[k] - sp[k0 - 1]) >= 0.9 * size) rise = k - k0;
        }
        overshoot = Math.max(overshoot, excess / size);
        rises.push(rise < 0 ? k1 - k0 : rise);
        if (k0 + settle < k1) {
            let lo = Infinity;
            let hi = -Infinity;
            for (let k = k0 + settle; k < k1; k++) {
                lo = Math.min(lo, err[k]);
                hi = Math.max(hi, err[k]);
            }
            oscillation = Math.max(oscillation, (hi - lo) / size);
        }
    }
    let saturated = 0;
    for (const row of motors) if (row.some((v) => v >= t.motorHigh || v <= t.motorLow)) saturated++;
    const riseMs = rises.length ? (rises.reduce((a, b) => a + b, 0) / rises.length) * dtS * 1000 : 0;
    return {
        id,
        trackingRel,
        overshoot,
        riseMs,
        oscillation,
        saturationShare: motors.length ? saturated / motors.length : 0,
    };
}

export function setMetrics(m: Measurement, schedule: Schedule, t: Thresholds): SetMetrics {
    const tr = m.trace!;
    const lag = setpointLag(tr.setpointDps, schedule);
    if (lag === null) throw new Error("setpoint does not follow the schedule");
    const n = tr.setpointDps.length;
    // Each window moves by the run's command delay and starts one tick early, so its first edge has a sample
    // before it (lead and settle ticks are 0); the last window loses `lag` samples of its settle tail.
    const per = schedule.windows.map((w) => {
        const a = Math.max(0, (w.startTick - 1) * SAMPLES_PER_TICK + lag);
        const b = Math.min(n, w.endTick * SAMPLES_PER_TICK + lag);
        return manoeuvreMetrics(
            w.id,
            tr.setpointDps.slice(a, b),
            tr.gyroDps.slice(a, b),
            tr.motors.slice(a, b),
            tr.dtS,
            t,
        );
    });
    const mean = (f: (x: ManoeuvreMetrics) => number) => per.reduce((s, x) => s + f(x), 0) / per.length;
    const tracking = mean((x) => x.trackingRel);
    const overshoot = mean((x) => x.overshoot);
    return {
        tracking,
        overshoot,
        riseMs: mean((x) => x.riseMs),
        oscillation: Math.max(...per.map((x) => x.oscillation)),
        saturationShare: Math.max(...per.map((x) => x.saturationShare)),
        cost: tracking + overshoot,
        perManoeuvre: per,
    };
}

/** Mean of repeated measurements of one tune (identical when the simulator is deterministic). */
export function meanMetrics(all: SetMetrics[]): SetMetrics {
    const avg = (f: (x: SetMetrics) => number) => all.reduce((s, x) => s + f(x), 0) / all.length;
    return {
        tracking: avg((x) => x.tracking),
        overshoot: avg((x) => x.overshoot),
        riseMs: avg((x) => x.riseMs),
        oscillation: Math.max(...all.map((x) => x.oscillation)),
        saturationShare: Math.max(...all.map((x) => x.saturationShare)),
        cost: avg((x) => x.cost),
        perManoeuvre: all[0].perManoeuvre,
    };
}

/** Absolute rejections of a tune on its own response (oscillation, motor saturation). */
export function absoluteRejections(c: SetMetrics, t: Thresholds): string[] {
    const out: string[] = [];
    if (c.oscillation > t.oscillationMax) out.push(`oscillation_${c.oscillation.toFixed(3)}>${t.oscillationMax}`);
    if (c.saturationShare > t.saturationShareMax)
        out.push(`motor_saturation_${c.saturationShare.toFixed(3)}>${t.saturationShareMax}`);
    return out;
}

/**
 * Is the candidate measurably better than the reference? It must pass the absolute
 * rejections, lower the composite cost by minRelativeGain, worsen neither tracking nor
 * overshoot beyond their tolerances and stay within the rise-time limit. An empty list
 * means better; otherwise every failed condition is named.
 */
export function compareToReference(c: SetMetrics, ref: SetMetrics, t: Thresholds): string[] {
    const out = absoluteRejections(c, t);
    if (c.cost > ref.cost * (1 - t.minRelativeGain))
        out.push(`cost_not_lower_${c.cost.toFixed(4)}_vs_${ref.cost.toFixed(4)}`);
    if (c.tracking > ref.tracking * (1 + t.trackingTolerance))
        out.push(`tracking_worse_${c.tracking.toFixed(4)}_vs_${ref.tracking.toFixed(4)}`);
    if (c.overshoot > ref.overshoot + t.overshootToleranceAbs)
        out.push(`overshoot_worse_${c.overshoot.toFixed(4)}_vs_${ref.overshoot.toFixed(4)}`);
    const riseLimit = ref.riseMs * (1 + t.riseTolerance) + t.riseToleranceMs;
    if (c.riseMs > riseLimit) out.push(`slower_${c.riseMs.toFixed(1)}ms>${riseLimit.toFixed(1)}ms`);
    return out;
}

const pidKey = (x: RollPid) => `${x.p},${x.i},${x.d}`;

/** The candidates of one round around the incumbent, in their fixed order, inside the box. */
export function roundCandidates(inc: RollPid, factor: number, spec: SearchSpec): RollPid[] {
    const clamp = (v: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, Math.round(v)));
    const out: RollPid[] = [];
    const moves: [keyof RollPid, number][] = [
        ["p", factor],
        ["p", 1 / factor],
        ["d", factor],
        ["d", 1 / factor],
        ["i", factor],
        ["i", 1 / factor],
    ];
    for (const [k, f] of moves) {
        const c = { ...inc, [k]: clamp(inc[k] * f, spec.bounds[k]) };
        if (c[k] !== inc[k] && !out.some((o) => pidKey(o) === pidKey(c))) out.push(c);
    }
    return out;
}

export interface Evaluation {
    pid: RollPid;
    dMax: number;
    round: number;
    metrics: SetMetrics | null;
    /** candidate-caused failures: flight envelope or absolute rejections */
    rejected: string[];
    /** comparison with the incumbent at the time and with the start ("start:" prefix); empty = better than both */
    versusIncumbent: string[] | null;
}

/** Measure one tune on a manoeuvre set; resolves with a measurement or throws on an I/O fault. */
export type Measure = (pid: RollPid, dMax: number, schedule: Schedule, label: string) => Promise<Measurement>;

export interface StartTuneResult {
    id: string;
    start: RollPid;
    startSearch: SetMetrics;
    evaluations: Evaluation[];
    searchSelection: RollPid;
    searchSelectionVsStart: string[];
    holdout: {
        /** null when the start was rejected on the search manoeuvres (no holdout run) */
        start: SetMetrics | null;
        /** envelope failures on the held-out manoeuvres, per repeat */
        startEnvelope: string[];
        selectedEnvelope: string[];
        selected: SetMetrics | null;
        versusStart: string[] | null;
        repeatsIdentical: boolean;
    };
    final: RollPid;
    decision: "improved" | "kept_no_search_improvement" | "kept_holdout_failed" | "kept_start_rejected";
    reason: string;
    onBound: string[];
    /** the header every measurement of this start tune was checked against */
    baseHeader: Record<string, string>;
}

export class MeasurementInvalid extends Error {}

async function measureValid(
    measure: Measure,
    pid: RollPid,
    spec: SearchSpec,
    schedule: Schedule,
    label: string,
    baseHeader: Record<string, string> | null,
    retries = 1,
): Promise<{ m: Measurement; issues: string[] }> {
    const dMax = dMaxFor(pid.d, spec.dMaxRatio);
    let last: string[] = [];
    for (let attempt = 0; attempt <= retries; attempt++) {
        const m = await measure(pid, dMax, schedule, attempt ? `${label}_retry${attempt}` : label);
        const issues = validateMeasurement(m, pid, dMax, schedule, baseHeader);
        if (!issues.length) return { m, issues };
        last = issues;
        // A wrong configuration is not a transient fault: retrying cannot change the header.
        if (!issues.every((x) => x.startsWith("harness:"))) break;
    }
    throw new MeasurementInvalid(`${label}: ${last.join("; ")}`);
}

function sameMetrics(a: SetMetrics, b: SetMetrics): boolean {
    return (
        a.tracking === b.tracking &&
        a.overshoot === b.overshoot &&
        a.riseMs === b.riseMs &&
        a.oscillation === b.oscillation &&
        a.saturationShare === b.saturationShare
    );
}

/**
 * The closed loop for one start tune: measure the start, run the pre-registered pattern
 * search on the search manoeuvres (the measured response alone decides which candidate
 * becomes the incumbent), then measure start and selection again on the held-out
 * manoeuvres and keep the selection only if it is better there too.
 */
export async function runStartTune(
    id: string,
    start: RollPid,
    pre: Preregistration,
    measure: Measure,
    baseHeader: Record<string, string> | null,
    log: (line: string) => void = () => undefined,
): Promise<StartTuneResult> {
    const t = pre.thresholds;
    const spec = pre.search;
    const search = buildSchedule(pre.searchManoeuvres, pre.leadTicks, pre.settleTicks);
    const holdout = buildSchedule(pre.holdoutManoeuvres, pre.leadTicks, pre.settleTicks);

    const s0 = await measureValid(measure, start, spec, search, `${id}_start_search`, baseHeader);
    // Without a base header from an earlier start tune, this start measurement is the base for everything after it.
    const base = baseHeader ?? s0.m.header!.values;
    const startEnvelope = envelopeFailures(s0.m, t);
    const startSearch = setMetrics(s0.m, search, t);
    log(`${id} start ${pidKey(start)} cost ${startSearch.cost.toFixed(4)}`);

    const evaluations: Evaluation[] = [];
    if (startEnvelope.length) {
        // Without a valid reference no candidate can be shown to be better: nothing is searched.
        return {
            id,
            start,
            startSearch,
            evaluations,
            searchSelection: start,
            searchSelectionVsStart: [],
            holdout: {
                start: null,
                startEnvelope: [],
                selectedEnvelope: [],
                selected: null,
                versusStart: null,
                repeatsIdentical: true,
            },
            final: start,
            decision: "kept_start_rejected",
            reason: `start tune left the envelope on the search manoeuvres: ${startEnvelope.join(", ")}`,
            onBound: [],
            baseHeader: base,
        };
    }
    let incumbent = start;
    let incMetrics = startSearch;
    let used = 0;
    const seen = new Set([pidKey(start)]);
    let round = 0;
    for (const factor of spec.stepFactors) {
        round++;
        let improvedThisRound = true;
        while (improvedThisRound) {
            improvedThisRound = false;
            const cands = roundCandidates(incumbent, factor, spec).filter((c) => !seen.has(pidKey(c)));
            let best: Evaluation | null = null;
            for (const c of cands) {
                if (used >= spec.budget) break;
                used++;
                seen.add(pidKey(c));
                const { m } = await measureValid(measure, c, spec, search, `${id}_r${round}_${pidKey(c)}`, base);
                const env = envelopeFailures(m, t);
                const metrics = env.length ? null : setMetrics(m, search, t);
                const rejected = metrics ? absoluteRejections(metrics, t) : env;
                // Better than the incumbent and, so that per-step tolerances cannot add up, better than the start too.
                const versus = metrics ? compareToReference(metrics, incMetrics, t) : null;
                const versusStart =
                    metrics && incumbent !== start
                        ? compareToReference(metrics, startSearch, t).map((x) => `start:${x}`)
                        : [];
                const ev: Evaluation = {
                    pid: c,
                    dMax: dMaxFor(c.d, spec.dMaxRatio),
                    round,
                    metrics,
                    rejected,
                    versusIncumbent: versus ? [...versus, ...versusStart] : null,
                };
                evaluations.push(ev);
                log(
                    `${id} r${round} ${pidKey(c)} ${metrics ? `cost ${metrics.cost.toFixed(4)}` : "envelope"} ${[...new Set([...rejected, ...(ev.versusIncumbent ?? [])])].join(" ") || "BETTER"}`,
                );
                if (
                    metrics &&
                    ev.versusIncumbent &&
                    !ev.versusIncumbent.length &&
                    (!best || metrics.cost < best.metrics!.cost)
                )
                    best = ev;
            }
            if (best) {
                incumbent = best.pid;
                incMetrics = best.metrics!;
                improvedThisRound = used < spec.budget;
            }
        }
        if (used >= spec.budget) break;
    }

    const searchSelectionVsStart =
        pidKey(incumbent) === pidKey(start) ? [] : compareToReference(incMetrics, startSearch, t);
    const onBound = (["p", "i", "d"] as const)
        .filter((k) => incumbent[k] === spec.bounds[k][0] || incumbent[k] === spec.bounds[k][1])
        .map((k) => `${k}=${incumbent[k]}`);

    const startH: SetMetrics[] = [];
    const selH: SetMetrics[] = [];
    const startHoldoutEnvelope: string[] = [];
    const selectedEnvelope: string[] = [];
    const changed = pidKey(incumbent) !== pidKey(start) && !searchSelectionVsStart.length;
    for (let r = 0; r < pre.holdoutRepeats; r++) {
        const a = await measureValid(measure, start, spec, holdout, `${id}_holdout_start_${r + 1}`, base);
        startHoldoutEnvelope.push(...envelopeFailures(a.m, t).map((x) => `repeat${r + 1}:${x}`));
        startH.push(setMetrics(a.m, holdout, t));
        if (changed) {
            const b = await measureValid(measure, incumbent, spec, holdout, `${id}_holdout_selected_${r + 1}`, base);
            selectedEnvelope.push(...envelopeFailures(b.m, t).map((x) => `repeat${r + 1}:${x}`));
            selH.push(setMetrics(b.m, holdout, t));
        }
    }
    const repeatsIdentical =
        startH.every((x) => sameMetrics(x, startH[0])) && selH.every((x) => sameMetrics(x, selH[0]));
    const startHold = meanMetrics(startH);
    const selHold = selH.length ? meanMetrics(selH) : null;
    // A selection that loses a held-out manoeuvre is not better, whatever its metrics say.
    // Likewise a start that loses one is no valid reference (as on the search manoeuvres): the start tune is kept.
    const versusStart = selHold
        ? [
              ...startHoldoutEnvelope.map((x) => `start_envelope:${x}`),
              ...selectedEnvelope.map((x) => `selection_envelope:${x}`),
              ...compareToReference(selHold, startHold, t),
          ]
        : null;

    let decision: StartTuneResult["decision"];
    let reason: string;
    let final = start;
    if (!changed) {
        decision = "kept_no_search_improvement";
        reason =
            pidKey(incumbent) === pidKey(start)
                ? `no candidate within budget ${spec.budget} was measurably better on the search manoeuvres`
                : `selection not better than the start on the search manoeuvres: ${searchSelectionVsStart.join(", ")}`;
    } else if (versusStart && versusStart.length) {
        decision = "kept_holdout_failed";
        reason = `improvement did not hold on the held-out manoeuvres: ${versusStart.join(", ")}`;
    } else {
        decision = "improved";
        final = incumbent;
        reason = `held-out cost ${selHold!.cost.toFixed(4)} vs start ${startHold.cost.toFixed(4)} (${(100 * (1 - selHold!.cost / startHold.cost)).toFixed(1)} % lower), all limits met`;
    }
    if (startHoldoutEnvelope.length && !selHold)
        reason += `; the start tune left the envelope on the holdout: ${startHoldoutEnvelope.join(", ")}`;
    return {
        id,
        start,
        startSearch,
        evaluations,
        searchSelection: incumbent,
        searchSelectionVsStart,
        holdout: {
            start: startHold,
            startEnvelope: startHoldoutEnvelope,
            selectedEnvelope,
            selected: selHold,
            versusStart,
            repeatsIdentical,
        },
        final,
        decision,
        reason,
        onBound,
        baseHeader: base,
    };
}
