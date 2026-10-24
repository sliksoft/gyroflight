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
 * WP7: the whole software chain, end to end.
 *
 * 1. From Blackbox bytes: a SIMULATED closed-loop CHIRP flight (harness/closedLoopBbl.ts) is encoded
 *    as the firmware logs it, decoded by the Blackbox Viewer, qualified (CHIRP qualification),
 *    turned into engine input (buildLogInputs: session evidence, finer analysis), then the engine
 *    (plant, margins with uncertainty, measurement plan), the qualification producer, GyroCore
 *    Safety and the write authority. Every scenario must block and say why.
 * 2. The strongest software evidence the tests can build (SIMULATION: synthetic logs, a producer-made
 *    qualification, a fixture Verified Tune): only GyroCore Safety (and the product lock that rests
 *    on it) refuses the Apply; released, the write runs on the byte-level firmware simulation, and a
 *    save whose answer is lost leaves an uncertain state that refuses the next Apply until Restore.
 *
 * None of this is flight or hardware evidence.
 */

import { createPinia, setActivePinia } from "pinia";
import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FirmwareFc } from "./harness/mspFirmware";

const gate = vi.hoisted(() => ({ fc: undefined as unknown as FirmwareFc, safety: false }));
vi.mock("../../src/js/msp", () => ({
    default: {
        promise: vi.fn(async (code: number, data?: number[]) =>
            (await import("./harness/mspFirmware")).firmwarePromise(gate.fc, code, data),
        ),
    },
}));
// Part 2 only: the binding compares with the app's published analysis, which never carries the
// producer's qualification (by design); released here so the steps behind it can be seen.
vi.mock("@/gyrocore/releaseGate/analysisBinding", async () =>
    (await import("./harness/analysisBindingRelease")).releasedAnalysisBinding(),
);
vi.mock("@/gyrocore/safety/authorize", async () => {
    const actual =
        await vi.importActual<typeof import("../../src/gyrocore/safety/authorize")>("@/gyrocore/safety/authorize");
    const released = (await import("./harness/safetyRelease")).releasedSafety;
    const r = await released();
    return {
        ...actual,
        absoluteSafetyAuthorization: (...a: Parameters<typeof actual.absoluteSafetyAuthorization>) =>
            gate.safety ? r.absoluteSafetyAuthorization(...a) : actual.absoluteSafetyAuthorization(...a),
    };
});

import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { buildLogInputs, flightRelation } from "../../src/gyrocore/engine/logInput";
import { runAutotuneV2, type AutotuneLogInput, type AutotuneV2Result } from "../../src/gyrocore/engine/autotuneV2";
import { assessModelQualification } from "../../src/gyrocore/engine/modelQualification";
import { absoluteWriteDecision } from "../../src/gyrocore/releaseGate/writeAuthority";
import { evaluateAbsoluteSafety } from "../../src/gyrocore/safety/absoluteEvaluate";
import {
    applyAbsoluteTune,
    checkTransactionState,
    previewAbsoluteRestore,
    previewAbsoluteTune,
    restoreAbsoluteTune,
    TuneWriteError,
} from "../../src/composables/useTuneApply";
import { ApplyBlockedError } from "../../src/gyrocore/chirp/applyGate";
import { issueConfirmation, resetConfirmations } from "../../src/gyrocore/tuning/applyConfirmation";
import { useVerifiedTuneStore } from "../../src/gyrocore/stores/verifiedTunes";
import { useTuneBackupStore } from "../../src/gyrocore/stores/tuneBackup";
import { useFcTransactionStore } from "../../src/gyrocore/stores/fcTransactionState";
import MSPCodes from "../../src/js/msp/MSPCodes";
import { closedLoopChirpLog, ratePlant, type ClosedLoopLogOptions } from "./harness/closedLoopBbl";
import { createFirmwareFc, FIRMWARE_WRITE_CODES } from "./harness/mspFirmware";
import { FAULT_FREE_FIRMWARE, previewedHash } from "./harness/previewConfirmation";
import { simulatedQualificationLog, syntheticLogInput } from "./harness/syntheticLog";
import { verifiedTuneAllAxesFixture } from "./harness/verifiedTuneFixture";

/** The decoded engine input of one simulated flight, through the app's own decode and qualification. */
function decoded(o: ClosedLoopLogOptions, name: string): AutotuneLogInput {
    const bytes = closedLoopChirpLog(o);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const report = qualifyChirpFile(bytes, name, 45, AUTOTUNE_MATH);
    const [log] = buildLogInputs(bytes, sha, report, null);
    expect(log, name).toBeDefined();
    return log;
}
const engine = (primary: AutotuneLogInput, others: AutotuneLogInput[] = []) =>
    runAutotuneV2({ primary, others, verifiedTune: null, createdAt: "2026-10-24T00:00:00Z" });

const AIR65_LIKE = ratePlant({ K: 60, motorHz: 40, delayS: 0.002 });
const SEVEN_INCH_LIKE = ratePlant({ K: 30, motorHz: 15, delayS: 0.004 });
const UNSTABLE = ratePlant({ K: 600, motorHz: 40, delayS: 0.002 });
const RESONANT = ratePlant({ K: 60, motorHz: 40, delayS: 0.002, resonance: { hz: 90, zeta: 0.015 } });

/** Every step's reasons for an absolute proposal, with the binding real-equivalent (released here). */
const denial = (r: AutotuneV2Result) =>
    absoluteWriteDecision((r.releasableProposal ?? r.proposal)!, { recompute: false });

describe("1. from Blackbox bytes through every stage: each failing condition blocks and says why", () => {
    let stable: AutotuneLogInput;
    let stableR: AutotuneV2Result;
    beforeAll(() => {
        setActivePinia(createPinia());
        stable = decoded({ plants: [AIR65_LIKE, AIR65_LIKE, AIR65_LIKE], noise: 0.3, seed: 11 }, "stable.bbl");
        stableR = engine(stable);
    }, 600_000);

    it("decode: qualified sweeps, the session start from the log itself, a finer analysis from the same samples", () => {
        expect(Object.values(stable.chirp).map((c) => c!.state)).toEqual(["usable", "usable", "usable"]);
        expect(stable.session).toEqual({ firstIteration: 0, startDatetime: null });
        for (const c of Object.values(stable.chirp)) {
            expect(c!.analysis!.segmentSamples).toBe(512);
            expect(c!.fine!.analysis.segmentSamples).toBeGreaterThan(c!.analysis!.segmentSamples);
            expect(c!.fine!.analysis.segments).toBeGreaterThanOrEqual(8);
        }
    });

    it("AIR65-like stable loop: margins read, bounded with their uncertainty, a plan; nothing released and why", () => {
        const roll = stableR.margins.roll!.current;
        expect(roll.crossoverHz!).toBeGreaterThan(15);
        expect(roll.crossoverHz!).toBeLessThan(45);
        expect(roll.measured.phaseMarginDeg!).toBeGreaterThan(40);
        expect(["MODEL_CONDITIONAL", "MEASURED"]).toContain(roll.evidence.level);
        expect(stableR.measurementPlan.map((p) => p.axis)).toEqual(["roll", "pitch", "yaw"]);
        expect(stableR.releasableProposal).toBeNull();
        // Why: no gyroUnfilt (chain not validated), no qualification, no independent flight, no Verified Tune.
        const why = stableR.parts.flatMap((p) => p.requiredMeasurements);
        for (const need of [
            "required_measurement:log_gyro_unfilt",
            "required_measurement:chirp_finer_resolution_model_class_qualification",
            "required_measurement:second_chirp_flight_same_tune",
            "required_measurement:gain_change_chirp_flight_plus_baseline_repeat",
        ]) {
            expect(why).toContain(need);
        }
        if (stableR.proposal) {
            const d = denial(stableR);
            expect(d.verdict).toBe("APPLY_DENIED");
            expect(d.blocks).toContain("safety:absolute_safety:not_hardware_validated");
        }
    });

    it("unstable loop (too much gain for its delay): negative PM measured, never released", () => {
        const r = engine(decoded({ plants: [UNSTABLE, UNSTABLE, UNSTABLE], noise: 0.3, seed: 12 }, "unstable.bbl"));
        expect(r.margins.roll!.current.measured.phaseMarginDeg!).toBeLessThan(0);
        expect(r.margins.roll!.current.status).not.toBe("VALIDATED");
        expect(r.releasableProposal).toBeNull();
        expect(r.parts.find((p) => p.part === "phase_margin_robustness")!.status).not.toBe("VALIDATED");
    }, 600_000);

    it("7-inch-like dynamics (slow motors, more delay): a low crossover, and a plan that asks for more", () => {
        const r = engine(
            decoded({ plants: [SEVEN_INCH_LIKE, SEVEN_INCH_LIKE, null], noise: 0.3, seed: 13 }, "seven.bbl"),
        );
        const plan = r.measurementPlan.find((p) => p.axis === "roll")!;
        expect(plan.crossoverHz!).toBeLessThan(stableR.measurementPlan[0].crossoverHz!);
        expect(plan.averages.needed!).toBeGreaterThan(stableR.measurementPlan[0].averages.needed!);
        expect(r.releasableProposal).toBeNull();
    }, 600_000);

    it("a resonance that takes the loop back above unity: several crossings, no bounds", () => {
        const r = engine(decoded({ plants: [RESONANT, null, null], noise: 0.3, seed: 14, endHz: 300 }, "resonant.bbl"));
        const m = r.margins.roll!.current;
        expect(m.reasons.some((x) => /^(ambiguous_crossovers|loop_gain_reenters_unity)/.test(x))).toBe(true);
        expect(m.gainMarginDb).toBeNull();
        expect(r.releasableProposal).toBeNull();
    }, 600_000);

    it("poor coherence (a gyro that does not follow the setpoint): the measurement is rejected, diagnostics only", () => {
        const log = decoded({ plants: [AIR65_LIKE, null, null], uncorrelated: true, seed: 15 }, "incoherent.bbl");
        expect(log.chirp.roll!.state).toBe("rejected");
        const r = engine(log);
        expect(r.pid.find((p) => p.axis === "roll")!.reasons).toContain("chirp_measurement_rejected");
        expect(r.releasableProposal).toBeNull();
    }, 600_000);

    it("high noise: wider bounds or none, and the plan names the noise", () => {
        const noisy = engine(decoded({ plants: [AIR65_LIKE, null, null], noise: 8, seed: 16 }, "noisy.bbl"));
        const quiet = stableR.margins.roll!.current;
        const m = noisy.margins.roll!.current;
        // Either the bounds are wider than the quiet flight's, or there are none.
        if (m.evidence.uncertainty) {
            expect(m.evidence.uncertainty.maxRelErr).toBeGreaterThan(quiet.evidence.uncertainty?.maxRelErr ?? 0);
        } else {
            expect(m.evidence.level).not.toBe("VALIDATED");
        }
        const plan = noisy.measurementPlan[0];
        expect(plan.averages.needed!).toBeGreaterThan(stableR.measurementPlan[0].averages.needed!);
        expect(noisy.releasableProposal).toBeNull();
    }, 600_000);

    it("missing measurement segments: only the swept axis is analysed, the rest is named as missing", () => {
        const r = engine(decoded({ plants: [AIR65_LIKE, null, null], noise: 0.3, seed: 17 }, "roll-only.bbl"));
        expect(Object.keys(r.margins)).toEqual(["roll"]);
        expect(r.measurementPlan.map((p) => p.axis)).toEqual(["roll"]);
        // A filter change moves every axis: without their margins it can never be released.
        if (r.proposal && Object.keys(r.proposal.change).some((k) => !/_(roll|pitch|yaw)$/.test(k))) {
            expect(
                denial(r).blocks.some((b) => b.startsWith("release_contract:") || b.startsWith("phase_margin:")),
            ).toBe(true);
        }
        expect(r.releasableProposal).toBeNull();
    }, 600_000);

    it("dependent flights: an export from inside the same session is no repeat; an independent flight is", () => {
        const sameSession = decoded(
            {
                plants: [AIR65_LIKE, AIR65_LIKE, AIR65_LIKE],
                noise: 0.3,
                seed: 18,
                firstIteration: 70_000,
                startTimeUs: 72_000_000,
            },
            "same-session-export.bbl",
        );
        const independent = decoded(
            { plants: [AIR65_LIKE, AIR65_LIKE, AIR65_LIKE], noise: 0.3, seed: 19, startTimeUs: 5_000_000 },
            "second-flight.bbl",
        );
        expect(flightRelation(stable, sameSession).relation).toBe("UNKNOWN");
        expect(flightRelation(stable, independent).relation).toBe("INDEPENDENT");
        const r = engine(stable, [sameSession, independent]);
        expect(r.crossLogRejected).toContain(
            `cross_log_independence_unproven:session_start_not_in_log:${sameSession.sha256}:0`,
        );
        expect(r.crossLogPlant.roll?.status).toBe("PASS");
        expect(r.parts.find((p) => p.part === "plant_identification")!.requiredMeasurements).toContain(
            "required_measurement:complete_log_of_an_independent_flight",
        );
    }, 600_000);

    it("insufficient frequency resolution: a short sweep has no finer analysis, so no qualification", () => {
        const short = decoded(
            { plants: [AIR65_LIKE, AIR65_LIKE, AIR65_LIKE], noise: 0.3, seed: 20, sweepS: 4, startTimeUs: 9_000_000 },
            "short.bbl",
        );
        expect(Object.values(short.chirp).every((c) => !c!.fine)).toBe(true);
        const { report } = assessModelQualification({ primary: stable, others: [short], verifiedTune: null });
        expect(report.source).toBeNull();
        expect(report.candidates[0].rejected).toContain("qualification_no_usable_axis_with_finer_analysis");
    }, 600_000);

    it("the producer on decoded flights: one 20 s sweep analysed finer is not coherent enough, so no qualification", () => {
        // An independent second flight of the same tune. Its finer analysis (8× the resolution, the
        // same samples) leaves most fine bins too briefly excited by the exponential sweep: the
        // producer refuses it, and the plan asks for a longer sweep (measurementPlan.ts).
        const second = decoded(
            { plants: [AIR65_LIKE, AIR65_LIKE, AIR65_LIKE], noise: 0.3, seed: 21, startTimeUs: 6_000_000 },
            "qualification.bbl",
        );
        expect(flightRelation(stable, second).relation).toBe("INDEPENDENT");
        const { report } = assessModelQualification({ primary: stable, others: [second], verifiedTune: null });
        expect(report.source).toBeNull();
        expect(report.connectedToApply).toBe(false);
        expect(
            report.candidates[0].rejected.some((r) => r.startsWith("qualification_axis_fine_analysis_not_coherent:")),
        ).toBe(true);
        expect(stableR.parts.flatMap((p) => p.requiredMeasurements)).toContain(
            "required_measurement:chirp_longer_sweep_for_averages",
        );
    }, 600_000);
});

describe("2. the strongest software evidence: only Safety refuses; released, the write and its failure modes", () => {
    const record = () => verifiedTuneAllAxesFixture(0.9, 0.7);
    const QUAL = (() => {
        const q = simulatedQualificationLog();
        return {
            ...q,
            chirp: Object.fromEntries(
                Object.entries(q.chirp).map(([a, c]) => [a, { ...c!, fine: { tf: c!.tf, analysis: c!.analysis! } }]),
            ),
        };
    })();
    let qualified: AutotuneV2Result;
    beforeAll(() => {
        // SIMULATION: the producer itself makes the qualification from an independent synthetic flight.
        qualified = assessModelQualification({
            primary: syntheticLogInput("e".repeat(64)),
            // An independent repeat for the plant's reproducibility, and the qualification flight
            // (which is not also that reference: one flight, one piece of evidence).
            others: [syntheticLogInput("f".repeat(64)), QUAL as AutotuneLogInput],
            verifiedTune: record(),
            createdAt: "2026-10-24T00:00:00Z",
        }).result!;
    }, 600_000);

    beforeEach(() => {
        setActivePinia(createPinia());
        localStorage.clear();
        resetConfirmations();
        gate.fc = createFirmwareFc();
        gate.safety = false;
        expect(useVerifiedTuneStore().save(record())).toBe(true);
    });

    const writes = () => gate.fc.calls.map((c) => c.code).filter((c) => FIRMWARE_WRITE_CODES.has(c));
    const confirm = async () => {
        const p = qualified.releasableProposal!;
        return issueConfirmation({
            kind: "absolute",
            proposalId: p.id,
            change: { ...p.change },
            preview: await previewedHash(gate.fc, FAULT_FREE_FIRMWARE(), () => previewAbsoluteTune(p)),
        });
    };

    it("every software condition holds; Safety (not hardware-validated) and the product lock resting on it refuse", async () => {
        const p = qualified.releasableProposal!;
        expect(p).not.toBeNull();
        const d = absoluteWriteDecision(p, { recompute: true });
        expect(d.steps.filter((s) => !s.passed).map((s) => s.name)).toEqual(["gyrocore_safety", "product_lock"]);
        expect(d.steps.find((s) => s.name === "gyrocore_safety")!.reasons).toEqual([
            "safety:absolute_safety:not_hardware_validated",
        ]);
        expect(d.steps.find((s) => s.name === "product_lock")!.reasons).toEqual(["full_safety_engine_pending"]);
        expect(evaluateAbsoluteSafety(p, { verifiedTune: record() }).checks.filter((c) => c.status === "FAIL")).toEqual(
            [],
        );
        const err = await applyAbsoluteTune(p, await confirm()).then(
            () => null,
            (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(ApplyBlockedError);
        expect(writes()).toEqual([]);
        expect(useTuneBackupStore().backups).toEqual([]);
    });

    it("control: with Safety released, preview, Apply, verify and save run on the simulator", async () => {
        gate.safety = true;
        const r = await applyAbsoluteTune(qualified.releasableProposal!, await confirm());
        expect(r.status).toBe("verified");
        expect(writes()).toEqual(expect.arrayContaining([MSPCodes.MSP_EEPROM_WRITE]));
    });

    it("an uncertain FC write state: a save whose answer is lost refuses the next Apply until Restore", async () => {
        gate.safety = true;
        gate.fc.corruptReplyAfterExecute = new Set([MSPCodes.MSP_EEPROM_WRITE]);
        const err = (await applyAbsoluteTune(qualified.releasableProposal!, await confirm()).then(
            () => null,
            (e: unknown) => e,
        )) as TuneWriteError;
        expect(err).toMatchObject({ stage: "eeprom", saved: "unknown" });
        gate.fc.corruptReplyAfterExecute = new Set();
        const next = (await applyAbsoluteTune(qualified.releasableProposal!, await confirm()).then(
            () => null,
            (e: unknown) => e,
        )) as ApplyBlockedError;
        expect(next.reasons).toEqual([`fc:transaction_state_uncertain:${err.backupId}:eeprom:unknown`]);
        expect((await checkTransactionState()).resolved).toBe(false);
        const preview = await previewedHash(gate.fc, FAULT_FREE_FIRMWARE(), () => previewAbsoluteRestore(err.backupId));
        const back = await restoreAbsoluteTune(
            err.backupId,
            issueConfirmation({ kind: "restore", backupId: err.backupId, preview }),
        );
        expect(back.status).toBe("verified");
        expect(useFcTransactionStore().forUid(gate.fc.uid)).toEqual([]);
    });
});
