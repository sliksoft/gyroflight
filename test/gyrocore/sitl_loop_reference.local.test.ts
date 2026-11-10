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
 * Reads product code only; changes nothing in it.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { buildLogInputs } from "../../src/gyrocore/engine/logInput";
import { analyzeM4BblFile } from "../../src/js/blackbox/m4_bbl_integration";
import { runAutotuneV2, controllerConfigFromHeaders } from "../../src/gyrocore/engine/autotuneV2";
import { evaluateControllerFrf } from "../../src/js/blackbox/betaflight_digital_controller";

const jobs: { log: string; out: string }[] = process.env.GYROFLIGHT_REF_JOBS
    ? JSON.parse(process.env.GYROFLIGHT_REF_JOBS)
    : [];

describe.skipIf(!jobs.length)("SITL loop reference: GyroFlight side (local)", () => {
    it("writes the engine's roll margins and controller FRF per log", () => {
        for (const job of jobs) {
            const bytes = new Uint8Array(readFileSync(job.log));
            const sha = createHash("sha256").update(bytes).digest("hex");
            const qual = qualifyChirpFile(bytes, "sitl.bbl", 45, AUTOTUNE_MATH);
            const logs = buildLogInputs(bytes, sha, qual, analyzeM4BblFile(bytes, "sitl.bbl"));
            expect(logs.length).toBeGreaterThan(0);
            const primary = logs[0];
            const r = runAutotuneV2({ primary, others: [], verifiedTune: null, createdAt: "2026-11-10T00:00:00Z" });
            const m = r.margins.roll?.current ?? null;
            const headers = Object.fromEntries(primary.headerPairs.map(([k, v]) => [k, v])) as Record<string, string>;
            const cfg = headers ? controllerConfigFromHeaders(headers, 0) : null;
            const relax = r.itermRelax.find((x) => x.axis === "roll") ?? null;
            const sweepCfg =
                cfg && relax && relax.status === "reconstructed"
                    ? { ...cfg, axis: { ...cfg.axis, i: cfg.axis.i * relax.meanFactor } }
                    : cfg;
            const bins: {
                f: number;
                Cfb: [number, number];
                Cref: [number, number];
                CfbSweep: [number, number];
                CrefSweep: [number, number];
            }[] = [];
            if (cfg && sweepCfg) {
                for (let f = 0.48828125; f <= 120; f += 0.48828125) {
                    const a = evaluateControllerFrf(cfg, f);
                    const b = evaluateControllerFrf(sweepCfg, f);
                    bins.push({
                        f,
                        Cfb: [a.cFeedback.re, a.cFeedback.im],
                        Cref: [a.cReference.re, a.cReference.im],
                        CfbSweep: [b.cFeedback.re, b.cFeedback.im],
                        CrefSweep: [b.cReference.re, b.cReference.im],
                    });
                }
            }
            const qlog = qual.logs.find((l) => l.logIndex === primary.logIndex) ?? qual.logs[0];
            const result = {
                file: job.log,
                sha256: sha,
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
