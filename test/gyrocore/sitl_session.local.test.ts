/**
 * Local (SITL harness only): the AutoTune session's analysis on bench logs, through the app's own import path and engine
 * (block 14). GYROFLIGHT_SESSION_JOBS = [{ logs: [run1.BFL, run2.BFL, run3.BFL], out: "analysis.json", rho?: {roll, pitch} }].
 * Writes per job: the per-run reads, the measurement summary, the bounded step search and the policy's choice.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { buildLogInputs } from "../../src/gyrocore/engine/logInput";
import { analyzeM4BblFile } from "../../src/js/blackbox/m4_bbl_integration";
import { runAutotuneV2 } from "../../src/gyrocore/engine/autotuneV2";
import { makeAnalyzer } from "../../src/gyrocore/sitlSession/analyzer";
import { summarize } from "../../src/gyrocore/sitlSession/decision";
import { chooseStep, initialPolicyState } from "../../src/gyrocore/sitlSession/stepPolicy";
import type { BenchRun } from "../../src/gyrocore/sitlSession/session";

const jobs: {
    logs: string[];
    out: string;
    rho?: { roll: number; pitch: number };
    probe?: { axis: "roll" | "pitch"; values: { p: number; i: number; d: number; dMax: number } }[];
}[] = process.env.GYROFLIGHT_SESSION_JOBS ? JSON.parse(process.env.GYROFLIGHT_SESSION_JOBS) : [];

export const nodeAnalyzer = () =>
    makeAnalyzer({
        async decode(bytes, name) {
            const sha = createHash("sha256").update(bytes).digest("hex");
            const qual = qualifyChirpFile(bytes, name, 45, AUTOTUNE_MATH);
            const logs = buildLogInputs(bytes, sha, qual, analyzeM4BblFile(bytes, name));
            if (!logs.length) throw new Error("no_log_input");
            return logs[0];
        },
        async engine(input) {
            return runAutotuneV2(input);
        },
    });

describe.skipIf(!jobs.length)("SITL AutoTune session analysis (local)", () => {
    it("reads every run and searches the bounded step", { timeout: 1_800_000 }, async () => {
        for (const job of jobs) {
            const runs: BenchRun[] = job.logs.map((f, k) => {
                const log = new Uint8Array(readFileSync(f));
                return {
                    start: k,
                    status: "ok",
                    reason: null,
                    log,
                    logSha256: createHash("sha256").update(log).digest("hex"),
                    active: null,
                    plant: null,
                };
            });
            const an = nodeAnalyzer();
            const t0 = Date.now();
            const reads = await an.runs(runs);
            const t1 = Date.now();
            const summary = summarize(reads);
            const state = initialPolicyState();
            if (job.rho) state.rho = { ...job.rho };
            const search = await an.search(runs, state.rho);
            const t2 = Date.now();
            const choice = summary.motors
                ? chooseStep({ search, base: summary, acceptedVsStart: summary.motors.map(() => 1), state })
                : null;
            writeFileSync(
                job.out,
                JSON.stringify(
                    {
                        reads,
                        summary,
                        search: {
                            ...search,
                            axes: search.axes.map((a) => ({ ...a, candidates: a.candidates.length })),
                        },
                        topCandidates: search.axes.map((a) => ({
                            axis: a.axis,
                            best: [...a.candidates].sort((x, y) => x.shortfall - y.shortfall).slice(0, 5),
                        })),
                        choice,
                        probes: (job.probe ?? []).map((pr) => ({
                            ...pr,
                            read:
                                search.axes
                                    .find((a) => a.axis === pr.axis)
                                    ?.candidates.find((c) => JSON.stringify(c.values) === JSON.stringify(pr.values)) ??
                                null,
                        })),
                        ms: { runs: t1 - t0, search: t2 - t1 },
                    },
                    null,
                    1,
                ),
            );
            expect(reads.length).toBe(job.logs.length);
        }
    });
});
