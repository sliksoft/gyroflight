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
 * The AutoTune session against a SITL bench (block 14; SITL only, never a real flight controller).
 *
 *   start      read the active tune over MSP; it is the start tune and the first accepted tune: the bench records it
 *              (commitAccepted) and must echo it before anything else happens; measure it (3 runs).
 *   each step  choose a bounded PID step from the LAST ACCEPTED measurement (stepPolicy), set it on the bench and read
 *              it back over MSP (exact, or INVALID readback_mismatch), measure it (every run reads the active tune over
 *              MSP before arming; it must equal the candidate), decide (decision.ts):
 *                ACCEPT   the bench records the candidate as the tune to restore (commitAccepted, echo checked) before
 *                         the next step; the candidate's measurement becomes the base;
 *                RESTORE  set the last accepted tune again and read it back (exact, else the session ends in error
 *                         restore_verification_failed); the candidate is excluded, ρ of the axis halves;
 *                INVALID  restore the same way; no exclusion; two in a row end the session (measurement_unreliable).
 *   stop       targets met, no eligible candidate, step floor, budget (5 trial steps / 18 runs), unreliable
 *              measurements, or Stop: the bench stops its running helper, restores the accepted tune and reads it back.
 * The best measured tune is the last accepted one (every ACCEPT improves on the accepted measurement before it).
 */

import type { PidValues } from "@/gyrocore/engine/pidOptimizer";
import type { SessionSearchResult } from "@/gyrocore/engine/sessionSearch";
import { decide, summarize, type Decision, type MeasurementSummary, type RunRead } from "./decision";
import { SESSION_PROTOCOL as P, type SessionAxis } from "./protocol";
import {
    afterAccept,
    afterRestore,
    chooseStep,
    initialPolicyState,
    stepSizeOf,
    type PolicyState,
    type StepChoice,
} from "./stepPolicy";

export interface Tune {
    roll: PidValues;
    pitch: PidValues;
    yaw: PidValues;
}

export interface ActiveRead {
    tune: Tune;
    pidProfile: number;
    armed: boolean;
    /** Raw MSP payloads (hex) as the bench received them. */
    raw?: Record<string, string>;
}

export interface BenchRun {
    start: number;
    status: string;
    reason: string | null;
    log: Uint8Array | null;
    logSha256: string | null;
    /** MSP read just before arming. */
    active: ActiveRead | null;
    plant: { maxAbsRollDeg: number; maxAbsPitchDeg: number; minZ: number; finite: boolean } | null;
}

export interface Bench {
    readActive(): Promise<ActiveRead>;
    /** Write the tune into the flash (Betaflight CLI) and read it back over MSP from a booted SITL. */
    setTune(t: Tune): Promise<ActiveRead>;
    /** Record the tune the bench restores on Stop or a lost connection; resolves with the bench's echo. */
    commitAccepted(t: Tune, measurementId: string): Promise<{ tune: Tune; measurementId: string }>;
    measure(label: string): Promise<{ runs: BenchRun[] }>;
    /** Stop the running helper, restore the accepted tune, read it back. */
    abort(): Promise<{ helperStopped: boolean; restored: ActiveRead | null; error: string | null }>;
}

export interface Analyzer {
    /** Per-run reads (margins per log, step and motor metrics) of a measurement's logs. */
    runs(runs: BenchRun[]): Promise<RunRead[]>;
    /** The bounded step search on a measurement's logs (all runs combined) with trust region ρ. */
    search(runs: BenchRun[], rho: Record<SessionAxis, number>): Promise<SessionSearchResult>;
}

export interface Measurement {
    id: string;
    label: string;
    tune: Tune;
    runs: BenchRun[];
    reads: RunRead[];
    summary: MeasurementSummary;
}

export type StepVerdict = "ACCEPT" | "RESTORE" | "INVALID" | "ABORTED";

export interface StepRecord {
    index: number;
    axis: SessionAxis;
    from: Tune;
    to: Tune;
    scripted: boolean;
    choice: StepChoice | null;
    /** The accepted measurement the choice was made on. */
    baseMeasurementId: string;
    setReadback: ActiveRead | null;
    measurement: Measurement | null;
    decision: Decision | null;
    verdict: StepVerdict;
    reasons: string[];
    restore: { readback: ActiveRead | null; exact: boolean } | null;
    commit: { measurementId: string; echoed: boolean } | null;
}

export type StopReason =
    | "targets_met"
    | "no_eligible_candidate"
    | "step_floor"
    | "budget"
    | "measurement_unreliable"
    | "start_measurement_invalid"
    | "aborted"
    | "error";

export interface SessionResult {
    status: "finished" | "aborted" | "error";
    stopReason: StopReason;
    stopDetail: string[];
    start: Measurement | null;
    best: Measurement | null;
    steps: StepRecord[];
    finalActive: ActiveRead | null;
    error: string | null;
    runsUsed: number;
    /**
     * The tune read last over MSP equals the last accepted tune (the session's own guarantee). The app tells the bench the
     * session is finished only then; otherwise the bench's own restore on a lost connection stays armed.
     */
    activeIsAccepted: boolean;
}

export interface SessionEvent {
    phase:
        | "reading_active"
        | "committing"
        | "measuring"
        | "analysing"
        | "choosing"
        | "setting"
        | "deciding"
        | "restoring"
        | "stopping"
        | "done";
    step: number;
    detail: string;
}

/**
 * A candidate fixed in advance for one trial step (the pre-registered restore test): absolute values (`to`), or the
 * then accepted tune of `axis` with D scaled by `dScale` (d_max keeps its ratio to D).
 */
export interface ScriptedStep {
    step: number;
    axis: SessionAxis;
    to?: PidValues;
    dScale?: number;
}

export function scriptedValues(x: ScriptedStep, accepted: Tune): PidValues {
    if (x.to) return { ...x.to };
    const c = accepted[x.axis];
    const k = x.dScale ?? 1;
    const d = Math.round(c.d * k);
    return { ...c, d, dMax: c.dMax > 0 ? Math.max(Math.round(c.dMax * k), d) : 0 };
}

export class SessionAborted extends Error {}

export function sameTune(a: Tune, b: Tune): boolean {
    return (["roll", "pitch", "yaw"] as const).every(
        (x) => a[x].p === b[x].p && a[x].i === b[x].i && a[x].d === b[x].d && a[x].dMax === b[x].dMax,
    );
}

export function readbackExact(r: ActiveRead | null, t: Tune): boolean {
    return !!r && r.pidProfile === 0 && !r.armed && sameTune(r.tune, t);
}

/** Bench-side reasons a run cannot be used (status, MSP read before arming, flight envelope). */
export function runIssues(run: BenchRun, tune: Tune): string[] {
    const out: string[] = [];
    if (run.status !== "ok") out.push(`bench:${run.status}:${run.reason ?? ""}`);
    if (!readbackExact(run.active, tune)) out.push("active_tune_before_arming_differs");
    if (!run.plant) out.push("plant_summary_missing");
    else {
        if (!run.plant.finite) out.push("plant_not_finite");
        const att = Math.max(run.plant.maxAbsRollDeg, run.plant.maxAbsPitchDeg);
        if (att > P.validity.maxAbsAttitudeDeg) out.push(`envelope_attitude:${att.toFixed(1)}`);
        if (run.plant.minZ < P.validity.minZ) out.push(`envelope_height:${run.plant.minZ.toFixed(2)}`);
    }
    if (!run.log) out.push("no_log");
    return out;
}

function measurementId(runs: BenchRun[]): string {
    return runs.map((r) => (r.logSha256 ?? "none").slice(0, 12)).join("+");
}

function withAxis(t: Tune, axis: SessionAxis, v: PidValues): Tune {
    return { ...t, [axis]: { ...v } };
}

export async function runSession(o: {
    bench: Bench;
    analyzer: Analyzer;
    signal?: AbortSignal;
    onEvent?: (e: SessionEvent) => void;
    onStep?: (r: StepRecord) => void;
    /** The start measurement, as soon as it is analysed. */
    onStart?: (m: Measurement) => void;
    scripted?: ScriptedStep[];
    /** Trial-step budget (default protocol maxTrialSteps; the restore-test sessions use a smaller one). */
    maxTrialSteps?: number;
}): Promise<SessionResult> {
    const { bench, analyzer } = o;
    const emit = (phase: SessionEvent["phase"], step: number, detail = "") => o.onEvent?.({ phase, step, detail });
    const steps: StepRecord[] = [];
    let runsUsed = 0;
    let start: Measurement | null = null;
    let base: Measurement | null = null;
    let accepted: Tune | null = null;
    let state: PolicyState = initialPolicyState();
    let invalidStreak = 0;
    const checkAbort = () => {
        if (o.signal?.aborted) throw new SessionAborted("aborted");
    };
    /** A bench or analysis call that gives way to Stop at once (the bench's own abort then stops its helper). */
    const guard = <T>(p: Promise<T>): Promise<T> => {
        const sig = o.signal;
        if (!sig) return p;
        if (sig.aborted) return Promise.reject(new SessionAborted("aborted"));
        return new Promise<T>((resolve, reject) => {
            const onAbort = () => reject(new SessionAborted("aborted"));
            sig.addEventListener("abort", onAbort, { once: true });
            p.then(
                (v) => {
                    sig.removeEventListener("abort", onAbort);
                    resolve(v);
                },
                (e) => {
                    sig.removeEventListener("abort", onAbort);
                    reject(e);
                },
            );
        });
    };

    const result = (
        status: SessionResult["status"],
        stopReason: StopReason,
        stopDetail: string[],
        finalActive: ActiveRead | null,
        error: string | null = null,
    ): SessionResult => ({
        status,
        stopReason,
        stopDetail,
        start,
        best: base,
        steps,
        finalActive,
        error,
        runsUsed,
        activeIsAccepted: !!accepted && readbackExact(finalActive, accepted),
    });

    /** A normal end: the active tune is read back over MSP and must be the last accepted one. */
    const finished = async (reason: StopReason, detail: string[]): Promise<SessionResult> => {
        const active = await guard(bench.readActive());
        if (!readbackExact(active, accepted!))
            return result(
                "error",
                "error",
                ["restore_verification_failed", "active_tune_is_not_the_accepted_tune"],
                active,
                "restore_verification_failed",
            );
        return result("finished", reason, detail, active);
    };

    /** The tune of a commit the bench may already hold while its echo is still on the way (Stop during the commit). */
    let pendingCommit: Tune | null = null;
    const commit = async (t: Tune, id: string) => {
        emit("committing", steps.length, id);
        pendingCommit = t;
        const echo = await guard(bench.commitAccepted(t, id));
        if (!sameTune(echo.tune, t) || echo.measurementId !== id) throw new Error("commit_not_confirmed_by_bench");
        pendingCommit = null;
        return echo;
    };

    const measure = async (label: string, tune: Tune): Promise<Measurement> => {
        emit("measuring", steps.length, label);
        const m = await guard(bench.measure(label));
        runsUsed += m.runs.length;
        checkAbort();
        emit("analysing", steps.length, label);
        const reads = await guard(analyzer.runs(m.runs));
        reads.forEach((r, k) => r.issues.unshift(...runIssues(m.runs[k], tune)));
        return { id: measurementId(m.runs), label, tune, runs: m.runs, reads, summary: summarize(reads) };
    };

    /** Restore the accepted tune and read it back; throws when the read-back differs. */
    const restore = async (): Promise<{ readback: ActiveRead | null; exact: boolean }> => {
        emit("restoring", steps.length, "");
        const rb = await bench.setTune(accepted!);
        const exact = readbackExact(rb, accepted!);
        return { readback: rb, exact };
    };

    try {
        emit("reading_active", 0, "");
        const active = await guard(bench.readActive());
        accepted = active.tune;
        await commit(accepted, "start");
        start = await measure("start", accepted);
        o.onStart?.(start);
        if (!start.summary.valid) return await finished("start_measurement_invalid", start.summary.issues);
        base = start;
        await commit(accepted, start.id);
        for (let trial = 1; ; trial++) {
            checkAbort();
            if (trial > (o.maxTrialSteps ?? P.policy.maxTrialSteps) || runsUsed + P.measurement.runs > P.policy.maxRuns)
                return await finished("budget", [`trial_steps:${trial - 1}`, `runs:${runsUsed}`]);
            emit("choosing", trial, "");
            const scripted = o.scripted?.find((x) => x.step === trial) ?? null;
            let choice: StepChoice | null = null;
            let axis: SessionAxis;
            let to: PidValues;
            if (scripted) {
                axis = scripted.axis;
                to = scriptedValues(scripted, accepted);
            } else {
                const search = await guard(analyzer.search(base.runs, state.rho));
                const acceptedVsStart = base.summary.motors!.map((s, m) => s.median / start!.summary.motors![m].median);
                const out = chooseStep({ search, base: base.summary, acceptedVsStart, state, start: start.summary });
                if (out.kind === "stop") return await finished(out.reason, out.detail);
                choice = out.choice;
                axis = choice.axis;
                to = choice.to;
            }
            const from = accepted;
            const cand = withAxis(from, axis, to);
            const rec: StepRecord = {
                index: trial,
                axis,
                from,
                to: cand,
                scripted: !!scripted,
                choice,
                baseMeasurementId: base.id,
                setReadback: null,
                measurement: null,
                decision: null,
                verdict: "INVALID",
                reasons: [],
                restore: null,
                commit: null,
            };
            steps.push(rec);
            try {
                emit("setting", trial, JSON.stringify(to));
                rec.setReadback = await guard(bench.setTune(cand));
                checkAbort();
                if (!readbackExact(rec.setReadback, cand)) {
                    rec.verdict = "INVALID";
                    rec.reasons = ["readback_mismatch"];
                } else {
                    rec.measurement = await measure(`step${trial}`, cand);
                    emit("deciding", trial, "");
                    rec.decision = decide({
                        base: base.summary,
                        cand: rec.measurement.summary,
                        start: start.summary,
                        axis,
                    });
                    rec.verdict = rec.decision.verdict;
                    rec.reasons = rec.decision.reasons;
                }
            } catch (e) {
                if (e instanceof SessionAborted || o.signal?.aborted) {
                    rec.verdict = "ABORTED";
                    rec.reasons = ["stopped_by_user"];
                    o.onStep?.(rec);
                    throw new SessionAborted("aborted");
                }
                throw e;
            }
            if (rec.verdict === "ACCEPT") {
                const echo = await commit(cand, rec.measurement!.id);
                rec.commit = { measurementId: echo.measurementId, echoed: true };
                accepted = cand;
                base = rec.measurement!;
                invalidStreak = 0;
                if (choice) state = afterAccept(state, choice);
                else state = { ...state, lastRejectedAxis: null };
            } else {
                rec.restore = await restore();
                if (!rec.restore.exact) {
                    o.onStep?.(rec);
                    return result(
                        "error",
                        "error",
                        ["restore_verification_failed"],
                        rec.restore.readback,
                        "restore_verification_failed",
                    );
                }
                if (rec.verdict === "RESTORE") {
                    invalidStreak = 0;
                    const c: StepChoice =
                        choice ??
                        ({ axis, from: from[axis], to, stepSize: stepSizeOf(from[axis], to) } as unknown as StepChoice);
                    state = afterRestore(state, c);
                } else if (++invalidStreak >= P.policy.maxConsecutiveInvalid) {
                    o.onStep?.(rec);
                    return await finished("measurement_unreliable", rec.reasons);
                }
            }
            o.onStep?.(rec);
        }
    } catch (e) {
        const aborted = e instanceof SessionAborted || !!o.signal?.aborted;
        const why = aborted ? "" : String(e instanceof Error ? e.message : e);
        if (!accepted)
            return result("error", "error", [why || "aborted_before_start"], null, why || "aborted_before_start");
        // Stop, or any other failure once a tune may have been set: the bench stops its helper, restores the accepted tune
        // and reads it back (the same path for both, so an error never leaves a candidate active).
        emit("stopping", steps.length, "");
        let a: Awaited<ReturnType<Bench["abort"]>> | null = null;
        let abortError: string | null = null;
        try {
            a = await bench.abort();
        } catch (x) {
            abortError = String(x instanceof Error ? x.message : x);
        }
        // A Stop during a commit: the bench may already hold the committed tune as its restore tune.
        if (a && pendingCommit && readbackExact(a.restored, pendingCommit)) accepted = pendingCommit;
        const exact = !!a && readbackExact(a.restored, accepted);
        const last = steps[steps.length - 1];
        if (last && (last.verdict === "ABORTED" || !aborted) && !last.restore)
            last.restore = { readback: a?.restored ?? null, exact };
        if (!a || !a.helperStopped || !exact)
            return result(
                "error",
                "error",
                ["restore_verification_failed", ...(why ? [why] : []), a?.error ?? abortError ?? ""].filter(Boolean),
                a?.restored ?? null,
                "restore_verification_failed",
            );
        if (!aborted) return result("error", "error", [why, "accepted_tune_restored"], a.restored, why);
        return result("aborted", "aborted", [], a.restored);
    } finally {
        emit("done", steps.length, "");
    }
}
