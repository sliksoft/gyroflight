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
 * LOCAL, PRE-REGISTERED evaluation of the AIR65 roll trial (block 9b; PROEFPLAN.md §5). Run after the
 * flight with the trial logs:
 *
 *   GYROFLIGHT_TRIAL_R  same-session reference, P56 (one complete round)
 *   GYROFLIGHT_TRIAL_A  P45, round 1          GYROFLIGHT_TRIAL_B  P45, round 2
 *
 * 1. Condition check: R against the registered baseline (5 November, repeat 6 November) with the
 *    Verified Tune rules and no PID change (compareAxis): the session reproduces the baseline when
 *    withinShare ≥ MIN_WITHIN_SHARE, maxExcess ≤ 2 in both domains and the comparison is not
 *    INSUFFICIENT. Otherwise the measurement conditions changed.
 * 2. Verdicts exactly as the app's "Create Verified Tune from these logs" computes them
 *    (verifiedTuneFromLogs) on {5 Nov, 6 Nov, A} and on {5 Nov, 6 Nov, B}, imported in that order.
 * 3. The plan's decision table (PROEFPLAN.md §5) on those three results.
 *
 * Nothing here is tuned after the flight: the rules are the committed code. JSON to
 * GYROFLIGHT_TRACE_OUT. Skipped without the logs.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { buildLogInputs } from "../../src/gyrocore/engine/logInput";
import { analyzeM4BblFile } from "../../src/js/blackbox/m4_bbl_integration";
import { analyzeAxisController, flightMask, type AutotuneLogInput } from "../../src/gyrocore/engine/autotuneV2";
import { buildAxisLoop } from "../../src/gyrocore/engine/loopModel";
import { verifiedTuneFromLogs, verifiedTuneOutcome } from "../../src/gyrocore/engine/verifiedTuneFromLogs";
import { compareAxis, MIN_WITHIN_SHARE } from "../../src/gyrocore/releaseGate/verifiedTune";

const BASE = {
    env: "GYROFLIGHT_AIR65_NOV05",
    sha256: "5654476ad783f1fa241d9fe6e8ae5f978c3d5cef6b417d0d93a59e26ed2b9894",
};
const REP = {
    env: "GYROFLIGHT_AIR65_NOV06",
    sha256: "eb8ad42e2010e88b6c2bed7e2be4b316993dd38ad86f1438907355d8d5d923a7",
};
const TRIAL = ["GYROFLIGHT_TRIAL_R", "GYROFLIGHT_TRIAL_A", "GYROFLIGHT_TRIAL_B"];
const present = [BASE.env, REP.env, ...TRIAL].every((e) => !!process.env[e] && existsSync(process.env[e]!));

function load(env: string, sha?: string, order = 0): AutotuneLogInput[] {
    const bytes = new Uint8Array(readFileSync(process.env[env]!));
    const s = createHash("sha256").update(bytes).digest("hex");
    if (sha) expect(s).toBe(sha);
    const q = qualifyChirpFile(bytes, path.basename(process.env[env]!), 45, AUTOTUNE_MATH);
    return buildLogInputs(bytes, s, q, analyzeM4BblFile(bytes, path.basename(process.env[env]!))).map((l) => ({
        ...l,
        order,
    }));
}

/** The log of a file with a roll sweep (the trial logs hold one session each; a hover log has none). */
const withRoll = (logs: AutotuneLogInput[]) => logs.find((l) => l.chirp.roll) ?? null;

describe.skipIf(!present)("block 9b: pre-registered trial evaluation (local)", () => {
    it("condition check, app verdicts, decision", () => {
        const base = withRoll(load(BASE.env, BASE.sha256, 1))!;
        const rep = withRoll(load(REP.env, REP.sha256, 2))!;
        const [R, A, B] = TRIAL.map((e, i) => withRoll(load(e, undefined, 3 + i)));
        const out: Record<string, unknown> = { logs: { R: R?.sha256, A: A?.sha256, B: B?.sha256 } };

        // 1. Condition check: the unchanged tune flown in the trial session against the baseline.
        let condition: "REPRODUCED" | "CHANGED" | "INSUFFICIENT" = "INSUFFICIENT";
        if (R?.chirp.roll && R.chirp.roll.state !== "rejected") {
            const h = Object.fromEntries(base.headerPairs);
            const ctl = analyzeAxisController(base, h, 0, base.chirp.roll!, flightMask(base.channels.rcThrottle))!;
            const rh = Object.fromEntries(R.headerPairs);
            const rctl = analyzeAxisController(R, rh, 0, R.chirp.roll, flightMask(R.channels.rcThrottle))!;
            const plant = buildAxisLoop(0, base.chirp.roll!.tf, ctl.cfg, null, false, false, null, {
                sweepCfg: ctl.sweepCfg,
            }).plant;
            const cmp = compareAxis("roll", {
                plant,
                baselineCfg: ctl.sweepCfg,
                candidateCfg: rctl.sweepCfg,
                candidateT: R.chirp.roll.tf,
                baselineRepeatT: rep.chirp.roll!.tf,
            });
            const samePid = ["p", "i", "d"].every(
                (k) =>
                    ctl.cfg.axis[k as "p"] === rctl.cfg.axis[k as "p"] ||
                    (k === "d" && Math.abs(ctl.cfg.axis.d - rctl.cfg.axis.d) < 0.05 * ctl.cfg.axis.d),
            );
            condition =
                cmp.verdict === "INSUFFICIENT" || !samePid
                    ? "INSUFFICIENT"
                    : cmp.withinShare >= MIN_WITHIN_SHARE &&
                        cmp.maxExcess <= 2 &&
                        cmp.loopWithinShare >= MIN_WITHIN_SHARE &&
                        cmp.loopMaxExcess <= 2
                      ? "REPRODUCED"
                      : "CHANGED";
            out.conditionCheck = {
                condition,
                samePid,
                relax: { base: ctl.itermRelax.meanFactor, R: rctl.itermRelax.meanFactor },
                comparison: cmp,
            };
        } else out.conditionCheck = { condition, reason: "R_missing_or_roll_rejected" };

        // 2. The app's verdict per trial log, on exactly the import set the plan prescribes.
        const verdictOf = (cand: AutotuneLogInput | null) => {
            if (!cand) return { verdict: "NONE" as const, reasons: ["log_missing"], roll: null };
            const attempt = verifiedTuneFromLogs([base, rep, cand]);
            const roll = attempt.record?.comparisons.find((c) => c.axis === "roll") ?? null;
            // The outcome the app shows (useAutotuneV2 createVerifiedTune → verifiedTuneOutcome).
            return { verdict: verifiedTuneOutcome(attempt), reasons: attempt.reasons, roll };
        };
        const vA = verdictOf(A);
        const vB = verdictOf(B);
        out.verdicts = { A: vA, B: vB };

        // 3. Decision table (PROEFPLAN.md §5).
        const v = [vA.verdict, vB.verdict];
        const decision =
            condition !== "REPRODUCED"
                ? `INSUFFICIENT:condition_${condition.toLowerCase()}`
                : v.every((x) => x === "PASS")
                  ? "PASS"
                  : v.every((x) => x === "FAIL")
                    ? "FAIL"
                    : `INSUFFICIENT:A=${v[0]},B=${v[1]}`;
        out.decision = decision;

        const dir = process.env.GYROFLIGHT_TRACE_OUT;
        if (dir) {
            mkdirSync(dir, { recursive: true });
            writeFileSync(path.join(dir, "trial_evaluation.json"), JSON.stringify(out, null, 1));
        }
        expect(typeof decision).toBe("string");
    }, 900_000);
});
