/*
 * GyroFlight side of the SITL loop-reference test (local; skipped without GYROFLIGHT_REF_JOBS).
 *
 * Runs each Blackbox log through the normal Autotune v2 import and engine, exactly as the app builds
 * its inputs (qualifyChirpFile -> buildLogInputs with the M4 report -> runAutotuneV2), and writes the
 * roll margins the engine reads plus the controller FRF the engine uses per bin, so a deviation from
 * the independent reference can be split into controller and plant.
 *
 *   GYROFLIGHT_REF_JOBS='[{"log":"/path/chirp.BFL","out":"/path/gyroflight.json"}]' \
 *     npx vitest run test/gyrocore/sitl_loop_reference.local.test.ts --maxWorkers=1
 *
 * A job may name `others`: further logs of the same tune. All logs are then imported and the primary is picked
 * as the app picks it (logInput pickPrimary), the rest go in as repeats (e2e roll proof, scripts/sim/e2e).
 *
 * Reads product code only; changes nothing in it.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { buildLogInputs, pickPrimary } from "../../src/gyrocore/engine/logInput";
import { analyzeM4BblFile } from "../../src/js/blackbox/m4_bbl_integration";
import {
    runAutotuneV2,
    controllerConfigFromHeaders,
    analyzeAxisController,
    flightMask,
} from "../../src/gyrocore/engine/autotuneV2";
import {
    dtermConfigFromHeaders,
    simulateDterm,
    effectiveDtermOverWindow,
} from "../../src/js/blackbox/betaflight_dterm_dynamic";
import { evaluateControllerFrf } from "../../src/js/blackbox/betaflight_digital_controller";

const jobs: { log: string; out: string; others?: string[] }[] = process.env.GYROFLIGHT_REF_JOBS
    ? JSON.parse(process.env.GYROFLIGHT_REF_JOBS)
    : [];

describe.skipIf(!jobs.length)("SITL loop reference: GyroFlight side (local)", () => {
    it("writes the engine's roll margins and controller FRF per log", { timeout: 1_800_000 }, () => {
        for (const job of jobs) {
            const importFile = (file: string) => {
                const bytes = new Uint8Array(readFileSync(file));
                const sha = createHash("sha256").update(bytes).digest("hex");
                const qual = qualifyChirpFile(bytes, "sitl.bbl", 45, AUTOTUNE_MATH);
                return { sha, qual, logs: buildLogInputs(bytes, sha, qual, analyzeM4BblFile(bytes, "sitl.bbl")) };
            };
            const first = importFile(job.log);
            const { sha, qual } = first;
            const logs = first.logs;
            expect(logs.length).toBeGreaterThan(0);
            const otherLogs = (job.others ?? []).flatMap((f) => importFile(f).logs);
            // Several logs: the primary as the app picks it (pickPrimary), the rest as repeats of the same tune.
            const picked = otherLogs.length ? pickPrimary([...logs, ...otherLogs]) : null;
            const primary = picked?.primary ?? logs[0];
            const others = picked?.others ?? [];
            const r = runAutotuneV2({ primary, others, verifiedTune: null, createdAt: "2026-11-10T00:00:00Z" });
            const m = r.margins.roll?.current ?? null;
            const headers = Object.fromEntries(primary.headerPairs.map(([k, v]) => [k, v])) as Record<string, string>;
            const cfg = headers ? controllerConfigFromHeaders(headers, 0) : null;
            const relax = r.itermRelax.find((x) => x.axis === "roll") ?? null;
            // The controller the engine actually reads the loop with (effective D from its D-path simulation).
            const mask = flightMask(primary.channels.rcThrottle);
            const ctl = primary.chirp.roll
                ? analyzeAxisController(primary, headers, 0, primary.chirp.roll, mask)
                : null;
            const dcfg = cfg ? dtermConfigFromHeaders(headers, 0, cfg.pidDt) : null;
            let dsim: Record<string, unknown> | null = null;
            if (dcfg && primary.chirp.roll) {
                const sim = simulateDterm(
                    {
                        timeUs: primary.channels.timeUs,
                        gyro: primary.channels.gyroAdc[0],
                        rcThrottle: primary.channels.rcThrottle,
                    },
                    dcfg,
                    { kind: "dynamic" },
                );
                const eff = effectiveDtermOverWindow(sim, primary.chirp.roll.start, primary.chirp.roll.end);
                const win = (arr: ArrayLike<number>) => {
                    const v: number[] = [];
                    for (let k = primary.chirp.roll!.start; k < Math.min(primary.chirp.roll!.end, sim.d.length); k++)
                        if (sim.valid[k]) v.push(arr[k]);
                    v.sort((a, b) => a - b);
                    return v.length
                        ? { min: v[0], median: v[Math.floor(v.length / 2)], max: v[v.length - 1], n: v.length }
                        : null;
                };
                dsim = {
                    eff,
                    notes: sim.notes,
                    dMaxMultiplier: win(sim.dMaxMultiplier),
                    tpaFactor: win(sim.tpaFactor),
                    cutoffHz: win(sim.cutoffHz),
                    throttle: win(primary.channels.rcThrottle),
                };
            }
            const sweepCfg =
                cfg && relax && relax.status === "reconstructed"
                    ? { ...cfg, axis: { ...cfg.axis, i: cfg.axis.i * relax.meanFactor } }
                    : cfg;
            // Controller FRFs per bin: from the header (nominal D) and as the engine actually reads the loop (ctl.cfg, effective D;
            // ctl.sweepCfg, the I in force during the sweep, used for the plant extraction).
            const bins: Record<string, number | [number, number]>[] = [];
            if (cfg && sweepCfg) {
                for (let f = 0.48828125; f <= 120; f += 0.48828125) {
                    const a = evaluateControllerFrf(cfg, f);
                    const b = evaluateControllerFrf(sweepCfg, f);
                    const row: Record<string, number | [number, number]> = {
                        f,
                        Cfb: [a.cFeedback.re, a.cFeedback.im],
                        Cref: [a.cReference.re, a.cReference.im],
                        CfbSweep: [b.cFeedback.re, b.cFeedback.im],
                        CrefSweep: [b.cReference.re, b.cReference.im],
                    };
                    if (ctl) {
                        const e = evaluateControllerFrf(ctl.cfg, f);
                        const es = evaluateControllerFrf(ctl.sweepCfg, f);
                        row.CfbEngine = [e.cFeedback.re, e.cFeedback.im];
                        row.CrefEngine = [e.cReference.re, e.cReference.im];
                        row.CfbEngineSweep = [es.cFeedback.re, es.cFeedback.im];
                        row.CrefEngineSweep = [es.cReference.re, es.cReference.im];
                    }
                    bins.push(row);
                }
            }
            const qlog = qual.logs.find((l) => l.logIndex === primary.logIndex) ?? qual.logs[0];
            const result = {
                gyroflightHead: process.env.GYROFLIGHT_REF_HEAD ?? null,
                file: job.log,
                sha256: sha,
                others: job.others ?? [],
                primarySha256: primary.sha256,
                othersSha256: others.map((l) => l.sha256),
                sampleRateHz: primary.sampleRateHz,
                logIndex: primary.logIndex,
                measurements: qlog?.measurements.map((x) => ({
                    id: x.id,
                    axis: x.axisName,
                    state: x.state,
                    durationS: (x.endTimeUs - x.startTimeUs) / 1e6,
                    quality: x.quality ?? null,
                    gates: (x as unknown as { gates?: unknown }).gates ?? null,
                })),
                chirpRoll: primary.chirp.roll
                    ? { state: primary.chirp.roll.state, reasons: primary.chirp.roll.qualificationReasons }
                    : null,
                margins: m && {
                    status: m.status,
                    crossoverHz: m.crossoverHz,
                    phaseMarginDeg: m.phaseMarginDeg,
                    gainMarginDb: m.gainMarginDb,
                    sensitivityPeakDb: m.sensitivityPeakDb,
                    okBins: m.okBins,
                    measured: m.measured,
                    evidence: m.evidence,
                    reasons: m.reasons,
                },
                pidRoll: r.pid.find((p) => p.axis === "roll") ?? null,
                decisionRoll: r.candidateDecisions.roll ?? null,
                itermRelax: relax,
                dterm: r.dterm.find((x) => x.axis === "roll") ?? null,
                chain: r.chain,
                headersUsed: Object.keys(headers).length,
                cfg,
                engineCfg: ctl
                    ? {
                          cfg: ctl.cfg,
                          sweepCfg: ctl.sweepCfg,
                          accepted: ctl.accepted,
                          nrmse: ctl.nrmse,
                          dterm: ctl.dterm,
                      }
                    : null,
                dtermSim: dsim,
                controllerBins: bins,
                jioRoll: r.jio.analysis.axes.roll
                    ? {
                          band: r.jio.analysis.axes.roll.band,
                          blockers: r.jio.analysis.axes.roll.blockers,
                          margins: r.jio.chain.roll?.margins ?? null,
                      }
                    : null,
            };
            writeFileSync(job.out, `${JSON.stringify(result, null, 1)}\n`);
        }
    });
});
