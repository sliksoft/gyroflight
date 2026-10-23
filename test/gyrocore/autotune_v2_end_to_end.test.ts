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
 * Analyze → Calculate → Compare → Apply → Verify → Restore, end to end on synthetic data:
 * the engine (runAutotuneV2), the real release contract, and the absolute route against the
 * byte-level Betaflight simulation. Shows the contract both ways: without a Verified Tune
 * nothing is released and nothing reaches the craft; with complete evidence the VALIDATED
 * part is released, written only after the user's confirmation, verified and restorable,
 * while simulated-only items stay out of the write.
 */

import { createPinia, setActivePinia } from "pinia";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FirmwareFc } from "./harness/mspFirmware";

const route = vi.hoisted(() => ({ fc: undefined as unknown as FirmwareFc }));
vi.mock("../../src/js/msp", () => ({
    default: {
        promise: vi.fn(async (code: number, data?: number[]) =>
            (await import("./harness/mspFirmware")).firmwarePromise(route.fc, code, data),
        ),
    },
}));

import MSPCodes from "../../src/js/msp/MSPCodes";
import {
    applyAbsoluteTune,
    previewAbsoluteTune,
    previewAbsoluteRestore,
    restoreAbsoluteTune,
} from "../../src/composables/useTuneApply";
import { ApplyBlockedError } from "../../src/gyrocore/chirp/applyGate";
import { issueConfirmation, resetConfirmations } from "../../src/gyrocore/tuning/applyConfirmation";
import { evaluateRelease } from "../../src/gyrocore/releaseGate/releaseContract";
import { runAutotuneV2, type AutotuneV2Result } from "../../src/gyrocore/engine/autotuneV2";
import { createFirmwareFc, FIRMWARE_WRITE_CODES } from "./harness/mspFirmware";
import { simulatedQualificationLog, syntheticLogInput } from "./harness/syntheticLog";
import { verifiedTuneAllAxesFixture } from "./harness/verifiedTuneFixture";

let withoutVt: AutotuneV2Result;
let withVt: AutotuneV2Result;
let fromCandidate: AutotuneV2Result;
// A measured gain reduction (P / I × 0.9, D × 0.7) from the logged AIR65 tune: the direction the
// search recommends here, so its segment can carry a released proposal.
const record = () => verifiedTuneAllAxesFixture(0.9, 0.7);

beforeAll(() => {
    const primary = syntheticLogInput("e".repeat(64));
    const repeat = syntheticLogInput("f".repeat(64));
    withoutVt = runAutotuneV2({ primary, others: [repeat], verifiedTune: null, createdAt: "2026-10-22T00:00:00Z" });
    withVt = runAutotuneV2({
        primary,
        others: [repeat],
        verifiedTune: record(),
        // SIMULATION: a synthetic finer second flight qualifies the margins' model class (contract logic only).
        modelClassQualification: simulatedQualificationLog(),
        createdAt: "2026-10-22T00:00:00Z",
    });
    // The same record against a log flown with its candidate tune: a new starting point.
    const c = record().candidate.pids;
    const pids = {
        roll: [c.roll.p, c.roll.i, c.roll.d] as [number, number, number],
        pitch: [c.pitch.p, c.pitch.i, c.pitch.d] as [number, number, number],
        yaw: [c.yaw.p, c.yaw.i, c.yaw.d] as [number, number, number],
    };
    fromCandidate = runAutotuneV2({
        primary: syntheticLogInput("a".repeat(64), { pids }),
        others: [syntheticLogInput("9".repeat(64), { pids })],
        verifiedTune: record(),
        modelClassQualification: simulatedQualificationLog({ pids }),
        createdAt: "2026-10-22T00:00:00Z",
    });
}, 600_000);

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    resetConfirmations();
    route.fc = createFirmwareFc();
});

const writes = () => route.fc.calls.map((c) => c.code).filter((c) => FIRMWARE_WRITE_CODES.has(c));

describe("Analyze / Calculate", () => {
    it("validates the chain and the D path, identifies every axis and reproduces it across logs", () => {
        expect(withVt.chain.validation.map((v) => v.controlBand)).toEqual(["PASS", "PASS", "PASS"]);
        expect(withVt.dterm.every((d) => d.accepted)).toBe(true);
        expect(Object.values(withVt.crossLogPlant).map((c) => c!.status)).toEqual(["PASS", "PASS", "PASS"]);
        expect(withVt.parts.find((p) => p.part === "plant_identification")!.status).toBe("VALIDATED");
    });

    it("feedforward stays BLOCKED without acro stick data, whatever else is proven", () => {
        expect(withVt.parts.find((p) => p.part === "feedforward")).toMatchObject({
            status: "BLOCKED",
            requiredMeasurements: ["required_measurement:acro_stick_flight"],
        });
    });
});

describe("release contract on the engine's own proposal", () => {
    it("without a Verified Tune: nothing is VALIDATED, nothing releasable, nothing reaches the craft", async () => {
        expect(withoutVt.releasableProposal).toBeNull();
        expect(withoutVt.proposal).not.toBeNull();
        const d = evaluateRelease(withoutVt.proposal!);
        expect(d.released).toBe(false);
        expect(d.blocks).toContain("independent_validation:independent_pid_validation_missing");
        const p = withoutVt.proposal!;
        const err = (await applyAbsoluteTune(
            p,
            issueConfirmation({ kind: "absolute", proposalId: p.id, change: { ...p.change } }),
        ).then(
            () => null,
            (e: unknown) => e,
        )) as ApplyBlockedError;
        expect(err).toBeInstanceOf(ApplyBlockedError);
        expect(route.fc.calls).toEqual([]);
    });

    it("with complete evidence the VALIDATED part is released; simulated-only items are not in it", () => {
        const r = withVt.releasableProposal!;
        expect(r).not.toBeNull();
        expect(evaluateRelease(r)).toMatchObject({ released: true, blocks: [] });
        expect(r.items.every((i) => i.status === "VALIDATED")).toBe(true);
        expect(r.items.every((i) => i.part === "pid")).toBe(true);
        const partial = withVt.proposal!.items.filter((i) => i.status !== "VALIDATED");
        for (const it of partial) expect(r.change[it.key]).toBeUndefined();
        if (partial.length) expect(evaluateRelease(withVt.proposal!).released).toBe(false);
    });

    it("the released PID values lie on the record's measured segment, never past its candidate", () => {
        const r = withVt.releasableProposal!;
        const v = record();
        for (const [k, to] of Object.entries(r.change)) {
            const [b, c] = [v.baseline.values[k], v.candidate.values[k]];
            expect(Math.min(b, c) <= to && to <= Math.max(b, c), `${k}: ${b} → ${to} (cand ${c})`).toBe(true);
        }
    });

    it("the same record from its candidate tune (a new starting point) releases nothing", () => {
        expect(fromCandidate.parts.find((p) => p.part === "independent_gain_prediction")).toMatchObject({
            status: "BLOCKED",
            reasons: [
                "verified_tune_measured_from_another_configuration",
                "required_measurement:gain_change_chirp_flight_plus_baseline_repeat",
            ],
        });
        const p = fromCandidate.releasableProposal ?? fromCandidate.proposal;
        if (p) expect(evaluateRelease(p).released).toBe(false);
    });
});

describe("Compare → Apply → Verify → Restore on the simulated FC", () => {
    it("writes exactly the released values after the user's confirmation, verifies, saves, restores", async () => {
        const p = withVt.releasableProposal!;
        const original = structuredClone(route.fc.ram);
        const preview = await previewAbsoluteTune(p);
        expect(writes()).toEqual([]);
        expect(preview.changes.map((c) => c.key).sort()).toEqual(Object.keys(p.change).sort());

        const token = issueConfirmation({
            kind: "absolute",
            proposalId: p.id,
            change: { ...p.change },
            preview: preview.hash,
        });
        const res = await applyAbsoluteTune(p, token);
        expect(res.status).toBe("verified");
        expect(writes().at(-1)).toBe(MSPCodes.MSP_EEPROM_WRITE);
        for (const [k, v] of Object.entries(p.change)) expect(res.afterSave.values[k], k).toBe(v);
        for (const [k, v] of Object.entries(preview.before.values)) {
            if (!(k in p.change)) expect(res.afterSave.values[k], k).toBe(v);
        }

        const rp = await previewAbsoluteRestore(res.backupId);
        const back = await restoreAbsoluteTune(
            res.backupId,
            issueConfirmation({ kind: "restore", backupId: res.backupId, preview: rp.hash }),
        );
        expect(back.status).toBe("verified");
        expect(route.fc.eeprom).toEqual(original);
    });
});
