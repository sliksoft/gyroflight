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
 * LOCAL, PRE-REGISTERED evaluation of the AIR65 roll trial (PROEFPLAN.md §4–§5, preregistration v2).
 * The rules are in support/air65RollTrial.ts (tested in CI); this file only runs them on the logs:
 *
 *   GYROFLIGHT_TRIAL_R  same-session reference, P56 (one complete round)
 *   GYROFLIGHT_TRIAL_A  P45, round 1          GYROFLIGHT_TRIAL_B  P45, round 2
 *
 * "R check" (needs R only, run right after downloading R; dossier scripts/r_check.sh):
 *   the file holds exactly one log with a roll sweep and is no reference log; every logged setting
 *   equals 5 November except the registered run-time keys, rollPID 56,79,30; ANGLE over the whole
 *   roll sweep; R against 5 November with repeat 6 November and no PID change (compareAxis):
 *   REPRODUCED when not INSUFFICIENT, within share ≥ MIN_WITHIN_SHARE and max excess ≤ 2 in both
 *   domains, P and I equal and the effective D within 5 %. Changed settings: CHANGED; missing
 *   evidence: INSUFFICIENT. Only REPRODUCED continues to P45.
 * "trial evaluation" (needs R, A and B):
 *   the R check; per A and B the same log and header rules with rollPID exactly 45,79,30 and nothing
 *   else changed (else NONE with the reasons, before the app outcome counts); the app's verdict
 *   (verifiedTuneFromLogs on {5 Nov, 6 Nov, A|B}, verifiedTuneOutcome) against the registered
 *   baseline and repeat; per-bin coverage from compareAxis's trace, checked against the record; the
 *   decision table; the peak conclusion (25.4 / 27.3 / 29.3 Hz), separate from the decision.
 *
 * Nothing here is tuned after the flight. JSON to GYROFLIGHT_TRACE_OUT. Skipped without the logs.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { buildLogInputs, sameFlight } from "../../src/gyrocore/engine/logInput";
import { analyzeM4BblFile } from "../../src/js/blackbox/m4_bbl_integration";
import { analyzeAxisController, flightMask, type AutotuneLogInput } from "../../src/gyrocore/engine/autotuneV2";
import { buildAxisLoop } from "../../src/gyrocore/engine/loopModel";
import { verifiedTuneFromLogs, verifiedTuneOutcome } from "../../src/gyrocore/engine/verifiedTuneFromLogs";
import { compareAxis, MIN_WITHIN_SHARE, type AxisBinTrace } from "../../src/gyrocore/releaseGate/verifiedTune";
import {
    angleThroughSweep,
    coverage,
    peakAssessment,
    traceMatches,
    TRIAL,
    trialHeaderCheck,
    trialLogIssues,
} from "./support/air65RollTrial";

const BASE_ENV = "GYROFLIGHT_AIR65_NOV05";
const REP_ENV = "GYROFLIGHT_AIR65_NOV06";
const TRIAL_ENV = { R: "GYROFLIGHT_TRIAL_R", A: "GYROFLIGHT_TRIAL_A", B: "GYROFLIGHT_TRIAL_B" } as const;
const has = (...envs: string[]) => envs.every((e) => !!process.env[e] && existsSync(process.env[e]!));

function loadFile(env: string, order: number): { sha256: string; logs: AutotuneLogInput[] } {
    const bytes = new Uint8Array(readFileSync(process.env[env]!));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const name = path.basename(process.env[env]!);
    const q = qualifyChirpFile(bytes, name, 45, AUTOTUNE_MATH);
    const logs = buildLogInputs(bytes, sha256, q, analyzeM4BblFile(bytes, name)).map((l) => ({ ...l, order }));
    return { sha256, logs };
}

/** The registered reference log of a file (sha and log index fixed). */
function reference(env: string, ref: { sha256: string; logIndex: number }, order: number): AutotuneLogInput {
    const f = loadFile(env, order);
    expect(f.sha256).toBe(ref.sha256);
    const log = f.logs.find((l) => l.logIndex === ref.logIndex && l.chirp.roll);
    expect(log).toBeTruthy();
    return log!;
}

/** A trial file: its one log with a roll sweep, or null with the reasons. */
function trialLog(env: string, order: number, forbidden: string[]) {
    const f = loadFile(env, order);
    const issues = trialLogIssues(
        f.logs.map((l) => ({ sha256: l.sha256, logIndex: l.logIndex, hasRollSweep: !!l.chirp.roll })),
        forbidden,
    );
    const log = issues.length ? null : f.logs.find((l) => l.chirp.roll)!;
    return { fileSha256: f.sha256, log, issues };
}

const ctlOf = (log: AutotuneLogInput) =>
    analyzeAxisController(
        log,
        Object.fromEntries(log.headerPairs),
        0,
        log.chirp.roll!,
        flightMask(log.channels.rcThrottle),
    )!;

/** The roll comparison of `cand` against the registered baseline and repeat, with its per-bin trace. */
function rollComparison(base: AutotuneLogInput, rep: AutotuneLogInput, cand: AutotuneLogInput) {
    const b = ctlOf(base);
    const c = ctlOf(cand);
    const trace: AxisBinTrace[] = [];
    const cmp = compareAxis(
        "roll",
        {
            plant: buildAxisLoop(0, base.chirp.roll!.tf, b.cfg, null, false, false, null, { sweepCfg: b.sweepCfg })
                .plant,
            baselineCfg: b.sweepCfg,
            candidateCfg: c.sweepCfg,
            candidateT: cand.chirp.roll!.tf,
            baselineRepeatT: rep.chirp.roll!.tf,
        },
        trace,
    );
    return { cmp, trace, base: b, cand: c };
}

/** The R check (PROEFPLAN §4b): may the session go on to P45? */
function rCheck(base: AutotuneLogInput, rep: AutotuneLogInput) {
    const r = trialLog(TRIAL_ENV.R, 3, [TRIAL.baseline.sha256, TRIAL.repeat.sha256]);
    const out: Record<string, unknown> = { file: r.fileSha256, logIssues: r.issues };
    if (!r.log)
        return {
            condition: "INSUFFICIENT" as const,
            file: r.fileSha256,
            log: null,
            out: { ...out, condition: "INSUFFICIENT" },
        };
    const R = r.log;
    const header = trialHeaderCheck(base.headerPairs, R.headerPairs, TRIAL.rollPidReference);
    const angle = angleThroughSweep(R.channels.rcModeMask, R.chirp.roll);
    const evidence: string[] = [];
    if (R.chirp.roll!.state === "rejected") evidence.push("roll_sweep_rejected");
    // A re-exported reference (other bytes, same samples) is no new reference flight.
    if (sameFlight(R, base) || sameFlight(R, rep)) evidence.push("same_flight_as_reference");
    const { cmp, trace, base: bc, cand: rc } = rollComparison(base, rep, R);
    // Kept from block 9b: P and I equal, the effective D (D max, TPA) within 5 %.
    const samePid =
        bc.cfg.axis.p === rc.cfg.axis.p &&
        bc.cfg.axis.i === rc.cfg.axis.i &&
        Math.abs(bc.cfg.axis.d - rc.cfg.axis.d) < 0.05 * bc.cfg.axis.d;
    const missing = [...header.issues.filter((x) => x.startsWith("header_missing")), ...angle, ...evidence];
    const changed = header.issues.filter((x) => !x.startsWith("header_missing"));
    const reproduces =
        cmp.withinShare >= MIN_WITHIN_SHARE &&
        cmp.maxExcess <= 2 &&
        cmp.loopWithinShare >= MIN_WITHIN_SHARE &&
        cmp.loopMaxExcess <= 2;
    const condition: "REPRODUCED" | "CHANGED" | "INSUFFICIENT" =
        missing.length || cmp.verdict === "INSUFFICIENT"
            ? "INSUFFICIENT"
            : changed.length || !samePid || !reproduces
              ? "CHANGED"
              : "REPRODUCED";
    return {
        condition,
        file: r.fileSha256,
        log: R,
        out: {
            ...out,
            log: { sha256: R.sha256, logIndex: R.logIndex },
            condition,
            reasons: [...missing, ...changed, ...(samePid ? [] : ["effective_pid_differs"])],
            settings: header.settings,
            samePid,
            relax: { base: bc.itermRelax.meanFactor, R: rc.itermRelax.meanFactor },
            comparison: cmp,
            coverage: coverage(trace),
        },
    };
}

function writeOut(name: string, data: unknown) {
    const dir = process.env.GYROFLIGHT_TRACE_OUT;
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, name), JSON.stringify(data, null, 1));
}

describe.skipIf(!has(BASE_ENV, REP_ENV, TRIAL_ENV.R))("block 9b: R check (local)", () => {
    it("R check", () => {
        const base = reference(BASE_ENV, TRIAL.baseline, 1);
        const rep = reference(REP_ENV, TRIAL.repeat, 2);
        const { condition, out } = rCheck(base, rep);
        const go = condition === "REPRODUCED";
        writeOut("r_check.json", { ...out, go });
        // The one line the pilot reads (scripts/r_check.sh prints it again).
        console.log(go ? "R_CHECK DOORGAAN: REPRODUCED" : `R_CHECK STOP: ${condition}`);
        expect(typeof condition).toBe("string");
    }, 900_000);
});

describe.skipIf(!has(BASE_ENV, REP_ENV, TRIAL_ENV.R, TRIAL_ENV.A, TRIAL_ENV.B))(
    "block 9b: pre-registered trial evaluation (local)",
    () => {
        it("condition check, exact change, app verdicts, coverage, decision, peak", () => {
            const base = reference(BASE_ENV, TRIAL.baseline, 1);
            const rep = reference(REP_ENV, TRIAL.repeat, 2);
            const r = rCheck(base, rep);
            const out: Record<string, unknown> = { conditionCheck: r.out };
            const forbidden = [TRIAL.baseline.sha256, TRIAL.repeat.sha256, r.file];
            const logs = { A: trialLog(TRIAL_ENV.A, 4, forbidden), B: trialLog(TRIAL_ENV.B, 5, forbidden) };

            const evaluate = (name: "A" | "B") => {
                const t = logs[name];
                const otherName = name === "A" ? "B" : "A";
                const other = logs[otherName];
                const own = [...t.issues];
                if (t.fileSha256 === other.fileSha256) own.push("file_is_a_reference_or_other_trial_log");
                if (!t.log) return { verdict: "NONE" as const, reasons: own, coverage: null, traceMatches: false };
                const cand = t.log;
                // Two rounds count only as two flights: a copy of R, A or a reference is the same flight.
                for (const [n, l] of [
                    ["5nov", base],
                    ["6nov", rep],
                    ["R", r.log],
                    [otherName, other.log],
                ] as const) {
                    if (l && sameFlight(cand, l)) own.push(`same_flight_as_${n}`);
                }
                // The exact change and nothing else, before the app outcome may count.
                const header = trialHeaderCheck(base.headerPairs, cand.headerPairs, TRIAL.rollPidTrial);
                const angle = angleThroughSweep(cand.channels.rcModeMask, cand.chirp.roll);
                const attempt = verifiedTuneFromLogs([base, rep, cand]);
                const rec = attempt.record;
                const registered: string[] = [];
                if (
                    rec &&
                    (rec.baseline.sha256 !== TRIAL.baseline.sha256 ||
                        rec.baseline.logIndex !== TRIAL.baseline.logIndex ||
                        rec.baselineRepeat?.sha256 !== TRIAL.repeat.sha256 ||
                        rec.baselineRepeat?.logIndex !== TRIAL.repeat.logIndex)
                ) {
                    registered.push(
                        `baseline_not_registered:${rec.baseline.sha256}:${rec.baselineRepeat?.sha256 ?? "none"}`,
                    );
                }
                const invalid = [...own, ...header.issues, ...angle, ...registered];
                // The outcome the app shows (verifiedTuneOutcome), only when the trial rules hold.
                const verdict = invalid.length ? ("NONE" as const) : verifiedTuneOutcome(attempt);
                const roll = rec?.comparisons.find((c) => c.axis === "roll") ?? null;
                const { cmp, trace } = rollComparison(base, rep, cand);
                const matches = !!roll && traceMatches(trace, roll) && cmp.verdict === roll.verdict;
                return {
                    log: { sha256: cand.sha256, logIndex: cand.logIndex },
                    verdict,
                    appOutcome: verifiedTuneOutcome(attempt),
                    reasons: [...invalid, ...attempt.reasons],
                    settings: header.settings,
                    roll,
                    traceMatches: matches,
                    coverage: verdict === "NONE" ? null : coverage(trace),
                    coverageAll: coverage(trace),
                };
            };
            const vA = evaluate("A");
            const vB = evaluate("B");
            out.verdicts = { A: vA, B: vB };

            // Decision table (PROEFPLAN.md §5), unchanged.
            const v = [vA.verdict, vB.verdict];
            const decision =
                r.condition !== "REPRODUCED"
                    ? `INSUFFICIENT:condition_${r.condition.toLowerCase()}`
                    : v.every((x) => x === "PASS")
                      ? "PASS"
                      : v.every((x) => x === "FAIL")
                        ? "FAIL"
                        : `INSUFFICIENT:A=${v[0]},B=${v[1]}`;
            out.decision = decision;
            // The peak, separately: never changes the decision.
            out.peak = peakAssessment(
                r.condition,
                { coverage: vA.coverage, traceMatches: vA.traceMatches },
                { coverage: vB.coverage, traceMatches: vB.traceMatches },
            );
            writeOut("trial_evaluation.json", out);
            expect(typeof decision).toBe("string");
        }, 1_800_000);
    },
);
