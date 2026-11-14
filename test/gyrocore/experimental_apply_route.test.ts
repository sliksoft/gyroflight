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
 * EXPERIMENTAL Apply (block 5) on the simulated firmware (harness/mspFirmware.ts): the release
 * contract and the product lock are the REAL modules here (nothing released), so a write that
 * succeeds does so only through the experimental authority and the user's acknowledgement; every
 * technical check of the absolute route stays in force. SIMULATION ONLY: no flight controller.
 */

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FirmwareFc } from "./harness/mspFirmware";
const route = vi.hoisted(() => ({ fc: undefined as unknown as FirmwareFc }));
vi.mock("../../src/js/msp", () => ({
    default: {
        promise: vi.fn(async (code: number, data?: number[]) =>
            (await import("./harness/mspFirmware")).firmwarePromise(route.fc, code, data),
        ),
    },
}));
// Only the analysis binding is released here (the authority unit test covers the real binding).
vi.mock("@/gyrocore/releaseGate/analysisBinding", async () =>
    (await import("./harness/analysisBindingRelease")).releasedAnalysisBinding(),
);
import MSPCodes from "../../src/js/msp/MSPCodes";
import {
    applyAbsoluteTune,
    applyExperimentalTune,
    previewAbsoluteRestore,
    previewAbsoluteTune,
    restoreAbsoluteTune,
    TuneWriteError,
} from "../../src/composables/useTuneApply";
import { ApplyBlockedError } from "../../src/gyrocore/chirp/applyGate";
import { useTuneBackupStore } from "../../src/gyrocore/stores/tuneBackup";
import { useFcTransactionStore } from "../../src/gyrocore/stores/fcTransactionState";
import { issueConfirmation, resetConfirmations } from "../../src/gyrocore/tuning/applyConfirmation";
import type { AbsoluteValues } from "../../src/gyrocore/tuning/absoluteTune";
import type { ExperimentalProposal } from "../../src/gyrocore/engine/experimentalProposal";
import { EXPERIMENTAL_WAIVED, experimentalWriteDecision } from "../../src/gyrocore/releaseGate/experimentalAuthority";
import { createFirmwareFc, FIRMWARE_WRITE_CODES } from "./harness/mspFirmware";
import { EXPERIMENTAL_CHANGE as CHANGE, experimentalFixture as experimental } from "./harness/experimentalFixture";
import { useConnectionStore } from "../../src/stores/connection";
import { FAULT_FREE_FIRMWARE, previewedHash } from "./harness/previewConfirmation";

const codes = () => route.fc.calls.map((c) => c.code);
const writes = () => codes().filter((c) => FIRMWARE_WRITE_CODES.has(c));
const confirm = async (x: ExperimentalProposal, preview?: string) =>
    issueConfirmation({
        kind: "experimental",
        proposalId: x.proposal.id,
        change: { ...x.proposal.change },
        acknowledged: true,
        preview:
            preview ?? (await previewedHash(route.fc, FAULT_FREE_FIRMWARE(), () => previewAbsoluteTune(x.proposal))),
    });
const confirmRestore = async (backupId: string) =>
    issueConfirmation({
        kind: "restore",
        backupId,
        preview: await previewedHash(route.fc, FAULT_FREE_FIRMWARE(), () => previewAbsoluteRestore(backupId)),
    });
async function failure(p: Promise<unknown>) {
    return p.then(
        () => null,
        (e: unknown) => e,
    );
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    resetConfirmations();
    route.fc = createFirmwareFc();
});

describe("experimental apply: an unreleased but computable proposal is written only on the acknowledged confirmation", () => {
    it("the released route still refuses the same values (real release contract and product lock)", async () => {
        const x = experimental();
        const token = issueConfirmation({
            kind: "absolute",
            proposalId: x.proposal.id,
            change: { ...x.proposal.change },
            preview: await previewedHash(route.fc, FAULT_FREE_FIRMWARE(), () => previewAbsoluteTune(x.proposal)),
        });
        const err = (await failure(applyAbsoluteTune(x.proposal, token))) as ApplyBlockedError;
        expect(err).toBeInstanceOf(ApplyBlockedError);
        expect(
            err.reasons.some(
                (r) =>
                    r.startsWith("release_contract:") ||
                    r.startsWith("product_lock:") ||
                    /full_safety_engine_pending|independent_pid_validation_missing|item_not_validated/.test(r),
            ),
        ).toBe(true);
        expect(writes()).toEqual([]);
    });

    it("writes, reads back, saves and verifies; the backup carries the provenance", async () => {
        const x = experimental();
        const d = experimentalWriteDecision(x, { recompute: false });
        expect(d.verdict).toBe("EXPERIMENTAL_APPLY_ALLOWED");
        expect(d.waived).toEqual(EXPERIMENTAL_WAIVED);
        const before = structuredClone(route.fc.ram);
        const pv = await previewAbsoluteTune(x.proposal);
        route.fc.calls = [];
        const res = await applyExperimentalTune(x, await confirm(x, pv.hash));
        expect(res.status).toBe("verified");
        expect(writes()).toEqual([MSPCodes.MSP_SET_PID, MSPCodes.MSP_SET_FILTER_CONFIG, MSPCodes.MSP_EEPROM_WRITE]);
        expect(route.fc.eeprom.pids[0]).toEqual([60, 79, 32]);
        expect(route.fc.eeprom.p.dterm_lpf1_static_hz).toBe(80);
        expect(route.fc.eeprom.pids.slice(1)).toEqual(before.pids.slice(1));
        expect(res.afterSave.values).toEqual(res.expected.values);
        const backup = useTuneBackupStore().get(res.backupId)!;
        expect(backup.reason).toBe("before_experimental_apply");
        expect(backup.absolute!.values.p_roll).toBe(56);
        expect(backup.provenance).toMatchObject({
            route: "experimental",
            proposalId: x.proposal.id,
            log: { sha256: "b".repeat(64), logIndex: 0, firmwareRevision: "Betaflight 2026.6.2 (43875a55a) STM32G474" },
            change: CHANGE,
            sources: { p_roll: "primary_route", d_roll: "primary_route", dterm_lpf1_static_hz: "primary_route" },
            hardwareValidated: false,
        });
        expect(backup.provenance!.limitations).toContain("experimental:not_hardware_validated");
        // The transaction state is resolved: a next write is not refused as uncertain.
        expect(useFcTransactionStore().blocks(route.fc.uid)).toEqual([]);
    });

    it("the confirmation must be of kind experimental, acknowledged, for these values and this preview", async () => {
        const x = experimental();
        const pv = await previewAbsoluteTune(x.proposal);
        const absoluteKind = issueConfirmation({
            kind: "absolute",
            proposalId: x.proposal.id,
            change: { ...x.proposal.change },
            preview: pv.hash,
        });
        for (const [name, token] of [
            ["missing", null],
            ["absolute kind", absoluteKind],
            ["other values", await confirm(experimental({ p_roll: 61 }), pv.hash)],
            ["other preview", await confirm(x, "not-the-preview")],
        ] as const) {
            route.fc.calls = [];
            const err = (await failure(applyExperimentalTune(x, token))) as ApplyBlockedError;
            expect(err, name).toBeInstanceOf(ApplyBlockedError);
            expect(writes(), name).toEqual([]);
        }
        expect(useTuneBackupStore().backups).toEqual([]);
    });

    it("a withheld key, a mismatched inner proposal or a releasable-route id is refused before any MSP", async () => {
        const withheld = experimental({ p_roll: 60 }, { withheld: ["pid_roll"] });
        let err = (await failure(applyExperimentalTune(withheld, await confirm(withheld)))) as ApplyBlockedError;
        expect(err.reasons).toContain("withheld_axis_in_change:roll");
        const tampered = experimental();
        tampered.proposal = { ...tampered.proposal, change: { ...tampered.proposal.change, p_roll: 70 } };
        err = (await failure(applyExperimentalTune(tampered, await confirm(tampered)))) as ApplyBlockedError;
        expect(err.reasons).toContain("item_value_differs:p_roll");
        const released = experimental();
        released.proposal = { ...released.proposal, id: "v2-looks-released" };
        err = (await failure(applyExperimentalTune(released, await confirm(released)))) as ApplyBlockedError;
        expect(err.reasons).toContain("proposal_id_is_releasable_route");
        const invalidMeasurement = experimental(CHANGE, { measurementValid: false });
        err = (await failure(
            applyExperimentalTune(invalidMeasurement, await confirm(invalidMeasurement)),
        )) as ApplyBlockedError;
        expect(err.reasons).toContain("measurement_invalid");
        expect(writes()).toEqual([]);
    });

    const invalid: [string, AbsoluteValues, string][] = [
        ["out of range", { p_roll: 251 }, "absolute_values_in_range:absolute:out_of_range:p_roll:251:0-250"],
        ["unknown field", { bogus: 1 }, "absolute_values_in_range:absolute:unknown_field:bogus"],
        ["too large a step", { p_roll: 120 }, "plausible_step:step_too_large:p_roll:56->120"],
        ["not finite", { p_roll: Number.NaN }, "value_not_finite:p_roll"],
        ["not an integer", { p_roll: 60.5 }, "value_not_integer:p_roll"],
    ];
    for (const [name, change, reason] of invalid) {
        it(`${name} -> ${reason}, nothing written`, async () => {
            const x = experimental(change);
            const d = experimentalWriteDecision(x, { recompute: false });
            expect(d.verdict).toBe("EXPERIMENTAL_APPLY_DENIED");
            expect(d.blocks).toContain(reason);
            const err = (await failure(applyExperimentalTune(x, null))) as ApplyBlockedError;
            expect(err).toBeInstanceOf(ApplyBlockedError);
            expect(writes()).toEqual([]);
        });
    }

    const live: [string, (fc: FirmwareFc) => void, string][] = [
        ["another craft", (fc) => (fc.uid = [1, 2, 3]), "fc:identity_uid_mismatch"],
        ["armed", (fc) => (fc.armed = true), "fc:armed"],
        ["other firmware", (fc) => (fc.version = "2026.5.0"), "fc:identity_firmware_mismatch"],
        ["configuration differs from the log", (fc) => (fc.ram.pids[0][0] = 50), "fc:live_differs_from_log:p_roll"],
        ["identity read fails", (fc) => (fc.faults[MSPCodes.MSP_UID] = "noreply"), "fc:identity_readback_missing"],
    ];
    for (const [name, mutate, reason] of live) {
        it(`${name} -> ${reason}, nothing written`, async () => {
            const x = experimental();
            const token = await confirm(x);
            mutate(route.fc);
            route.fc.calls = [];
            const err = (await failure(applyExperimentalTune(x, token))) as ApplyBlockedError;
            expect(err).toBeInstanceOf(ApplyBlockedError);
            expect(err.reasons.some((r) => r.startsWith(reason))).toBe(true);
            expect(writes()).toEqual([]);
            expect(useTuneBackupStore().backups).toEqual([]);
        });
    }

    it("virtual mode is refused", async () => {
        const x = experimental();
        const token = await confirm(x);
        useConnectionStore().virtualMode = true;
        const err = (await failure(applyExperimentalTune(x, token))) as ApplyBlockedError;
        expect(err.reasons).toContain("fc:virtual_mode");
        expect(writes()).toEqual([]);
    });
});

describe("experimental apply: failures are never success, the state is recorded, Restore works", () => {
    it("timeout on the filter write after the PIDs: partial state reported, nothing saved, next write refused", async () => {
        route.fc.faults[MSPCodes.MSP_SET_FILTER_CONFIG] = "timeout";
        const x = experimental();
        const err = (await failure(applyExperimentalTune(x, await confirm(x)))) as TuneWriteError;
        expect(err).toBeInstanceOf(TuneWriteError);
        expect([err.stage, err.saved]).toEqual(["write", "no"]);
        expect(err.changedFromBackup).toEqual(expect.arrayContaining(["pid:p_roll 56→60", "pid:d_roll 30→32"]));
        expect(codes()).not.toContain(MSPCodes.MSP_EEPROM_WRITE);
        expect(route.fc.eeprom.pids[0]).toEqual([56, 79, 30]);
        expect(useTuneBackupStore().get(err.backupId)?.reason).toBe("before_experimental_apply");
        expect(useFcTransactionStore().blocks(route.fc.uid).length).toBeGreaterThan(0);
    });

    it("a disconnect during verification: not saved", async () => {
        route.fc.faultsAfterWrites.push({ after: 1, code: MSPCodes.MSP_PID_ADVANCED, fault: "disconnect" });
        const x = experimental({ p_roll: 60 });
        const err = (await failure(applyExperimentalTune(x, await confirm(x)))) as TuneWriteError;
        expect([err.stage, err.saved]).toEqual(["verify", "no"]);
        expect(codes()).not.toContain(MSPCodes.MSP_EEPROM_WRITE);
    });

    it("the firmware keeps its values: readback mismatch, not saved", async () => {
        route.fc.ignoreWrite.add(MSPCodes.MSP_SET_FILTER_CONFIG);
        const x = experimental({ dterm_lpf1_static_hz: 80 });
        const err = (await failure(applyExperimentalTune(x, await confirm(x)))) as TuneWriteError;
        expect([err.stage, err.saved]).toEqual(["verify", "no"]);
        expect(err.mismatches).toEqual(["filter:dterm_lpf1_static_hz expected 80 read 75"]);
    });

    it("EEPROM write times out: saved state unknown", async () => {
        route.fc.faults[MSPCodes.MSP_EEPROM_WRITE] = "timeout";
        const x = experimental({ p_roll: 60 });
        const err = (await failure(applyExperimentalTune(x, await confirm(x)))) as TuneWriteError;
        expect([err.stage, err.saved]).toEqual(["eeprom", "unknown"]);
    });

    it("Restore puts the backup of an experimental Apply back, verified and saved", async () => {
        const x = experimental();
        const res = await applyExperimentalTune(x, await confirm(x));
        expect(route.fc.eeprom.pids[0]).toEqual([60, 79, 32]);
        route.fc.calls = [];
        const r = await restoreAbsoluteTune(res.backupId, await confirmRestore(res.backupId));
        expect(r.status).toBe("verified");
        expect(route.fc.eeprom.pids[0]).toEqual([56, 79, 30]);
        expect(route.fc.eeprom.p.dterm_lpf1_static_hz).toBe(75);
        expect(writes()).toContain(MSPCodes.MSP_EEPROM_WRITE);
        expect(useFcTransactionStore().blocks(route.fc.uid)).toEqual([]);
    });
});
