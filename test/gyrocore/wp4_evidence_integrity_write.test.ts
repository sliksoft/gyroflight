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
 * WP4 evidence integrity (audit F-03), write side, on the P0 harness (p0_write_authority.test.ts):
 * what a failed save proves, and what the route does after it. An EEPROM answer lost to a CRC error
 * after the firmware saved is "unknown", never "nothing saved"; a write that ended in a state
 * nobody verified blocks every further Apply on that craft, across a reload, until a verified
 * Restore or a read-back that proves the state.
 *
 * Every step can be switched between real and released (`gate.*`), so each case denies with
 * exactly one step real and all others released: a denial then shows that step alone blocks,
 * not that something else already did. The control case releases all and shows the write does
 * happen, so "no write" below means the authority stopped it. The engine's recomputation is
 * replaced by `gate.fresh` (the real engine runs in p0_write_authority_engine.test.ts).
 */

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FirmwareFc } from "./harness/mspFirmware";

const gate = vi.hoisted(() => ({
    fc: undefined as unknown as FirmwareFc,
    binding: true,
    release: true,
    safety: true,
    product: true,
    /** When set, the released Safety result is bound to this proposal id instead of the one asked about. */
    safetyFor: null as string | null,
    /** What the engine's recomputation returns as the releasable proposal; "throw" makes it fail. */
    fresh: null as unknown,
}));

vi.mock("../../src/js/msp", () => ({
    default: {
        promise: vi.fn(async (code: number, data?: number[]) =>
            (await import("./harness/mspFirmware")).firmwarePromise(gate.fc, code, data),
        ),
    },
}));
vi.mock("@/composables/useDialog", () => ({ useDialog: () => ({ showYesNo: async () => true }) }));
vi.mock("@/gyrocore/engine/autotuneV2", async () => ({
    ...(await vi.importActual<typeof import("../../src/gyrocore/engine/autotuneV2")>("@/gyrocore/engine/autotuneV2")),
    runAutotuneV2: () => {
        if (gate.fresh === "throw") throw new Error("engine failed");
        return { releasableProposal: structuredClone(gate.fresh) };
    },
}));
vi.mock("@/gyrocore/engine/logInput", async () => ({
    ...(await vi.importActual<typeof import("../../src/gyrocore/engine/logInput")>("@/gyrocore/engine/logInput")),
    pickPrimary: (logs: unknown[]) => (logs.length ? { primary: logs[0], others: logs.slice(1) } : null),
}));
vi.mock("@/gyrocore/releaseGate/analysisBinding", async () => {
    const actual = await vi.importActual<typeof import("../../src/gyrocore/releaseGate/analysisBinding")>(
        "@/gyrocore/releaseGate/analysisBinding",
    );
    return {
        ...actual,
        analysisBindingIssues: (...a: Parameters<typeof actual.analysisBindingIssues>) =>
            gate.binding ? [] : actual.analysisBindingIssues(...a),
    };
});
vi.mock("@/gyrocore/releaseGate/releaseContract", async () => {
    const actual = await vi.importActual<typeof import("../../src/gyrocore/releaseGate/releaseContract")>(
        "@/gyrocore/releaseGate/releaseContract",
    );
    return {
        ...actual,
        evaluateRelease: (p: Parameters<typeof actual.evaluateRelease>[0]) =>
            gate.release ? { released: true, conditions: [], blocks: [] } : actual.evaluateRelease(p),
    };
});
vi.mock("@/gyrocore/safety/authorize", async () => {
    const actual =
        await vi.importActual<typeof import("../../src/gyrocore/safety/authorize")>("@/gyrocore/safety/authorize");
    return {
        ...actual,
        absoluteSafetyAuthorization: (p: Parameters<typeof actual.absoluteSafetyAuthorization>[0]) =>
            gate.safety
                ? {
                      ...actual.absoluteSafetyAuthorization(p),
                      status: "PASS" as const,
                      blocks: [],
                      authorized: true,
                      proposalId: gate.safetyFor ?? p.id,
                  }
                : actual.absoluteSafetyAuthorization(p),
    };
});
vi.mock("@/gyrocore/productLock/productApply", async () => {
    const actual = await vi.importActual<typeof import("../../src/gyrocore/productLock/productApply")>(
        "@/gyrocore/productLock/productApply",
    );
    return {
        ...actual,
        productApplyBlocks: (e: Parameters<typeof actual.productApplyBlocks>[0]) =>
            gate.product ? [] : actual.productApplyBlocks(e),
    };
});

import MSPCodes from "../../src/js/msp/MSPCodes";
import {
    applyAbsoluteTune,
    checkTransactionState,
    previewAbsoluteRestore,
    previewAbsoluteTune,
    restoreAbsoluteTune,
    TuneWriteError,
} from "../../src/composables/useTuneApply";
import { ApplyBlockedError } from "../../src/gyrocore/chirp/applyGate";
import { useAutotuneV2Store } from "../../src/gyrocore/stores/autotuneV2";
import { useTuneBackupStore } from "../../src/gyrocore/stores/tuneBackup";
import { issueConfirmation, resetConfirmations } from "../../src/gyrocore/tuning/applyConfirmation";
import {
    TRANSACTION_STATE_UNREADABLE,
    TRANSACTION_STORAGE_KEY,
    useFcTransactionStore,
} from "../../src/gyrocore/stores/fcTransactionState";

import type { AbsoluteProposal } from "../../src/gyrocore/releaseGate/releaseContract";
import type { AutotuneLogInput, AutotuneV2Result } from "../../src/gyrocore/engine/autotuneV2";
import type { AbsoluteValues } from "../../src/gyrocore/tuning/absoluteTune";
import { air65FirmwareState, createFirmwareFc, FIRMWARE_WRITE_CODES, type FirmwareState } from "./harness/mspFirmware";
import { FAULT_FREE_FIRMWARE, previewedHash } from "./harness/previewConfirmation";

function headersFor(s: FirmwareState): [string, string][] {
    const p = s.p;
    return [
        ["Firmware revision", "Betaflight 2026.6.2 (43875a55a) STM32G474"],
        ["Board information", "BEFH BETAFPVG473"],
        ["DeviceUID", "003e00213841501220343141"],
        ["rollPID", s.pids[0].join(",")],
        ["pitchPID", s.pids[1].join(",")],
        ["yawPID", s.pids[2].join(",")],
        ["ff_weight", `${p.f_roll},${p.f_pitch},${p.f_yaw}`],
        ["d_max", `${p.d_max_roll},${p.d_max_pitch},${p.d_max_yaw}`],
        ["d_max_gain", String(p.d_max_gain)],
        ["gyro_lpf1_static_hz", String(p.gyro_lpf1_static_hz)],
        ["gyro_lpf1_dyn_hz", `${p.gyro_lpf1_dyn_min_hz},${p.gyro_lpf1_dyn_max_hz}`],
        ["dterm_lpf1_static_hz", String(p.dterm_lpf1_static_hz)],
        ["dterm_lpf1_dyn_hz", `${p.dterm_lpf1_dyn_min_hz},${p.dterm_lpf1_dyn_max_hz}`],
        ["dyn_notch_count", String(p.dyn_notch_count)],
        ["dyn_notch_q", String(p.dyn_notch_q)],
        ["rpm_filter_harmonics", String(p.rpm_filter_harmonics)],
        ["rpm_filter_q", String(p.rpm_filter_q)],
        ["rpm_filter_weights", s.rpmWeights.join(",")],
    ];
}

/** A PID, a feedforward and a filter value: every kind of change the absolute route writes. */
const CHANGE: AbsoluteValues = { p_roll: 60, d_roll: 32, f_pitch: 40, dterm_lpf1_static_hz: 80 };

function proposal(change: AbsoluteValues = CHANGE, createdAt = "2026-10-22T00:00:00Z"): AbsoluteProposal {
    return {
        id: `prop-${Object.entries(change).join("|")}`,
        createdAt,
        log: { sha256: "a".repeat(64), logIndex: 0, headerPairs: headersFor(air65FirmwareState()) },
        change: { ...change },
        items: [],
        release: {
            measurement: { valid: false, reasons: ["test"] },
            model: { status: "BLOCKED", reasons: ["test"] },
            margins: [],
            independentValidation: null,
            safetyAnalysisEvidence: "not_available",
            safetyReasons: [],
        },
    };
}

/** The store as after Calculate produced `p`; the engine reproduces it unless `gate.fresh` is changed. */
function analysed(p: AbsoluteProposal) {
    const store = useAutotuneV2Store();
    store.inputs = [{ headerPairs: p.log.headerPairs } as unknown as AutotuneLogInput];
    store.result = {
        proposal: structuredClone(p),
        releasableProposal: structuredClone(p),
    } as unknown as AutotuneV2Result;
    store.state = "done";
    gate.fresh = structuredClone(p);
}

const codes = () => gate.fc.calls.map((c) => c.code);
const writes = () => codes().filter((c) => FIRMWARE_WRITE_CODES.has(c));
const backups = () => useTuneBackupStore().backups;
/** The user's confirmation of `p`, bound to the read-only preview of the craft as it is now. */
const confirm = async (p: AbsoluteProposal) =>
    issueConfirmation({
        kind: "absolute",
        proposalId: p.id,
        change: { ...p.change },
        preview: await previewedHash(gate.fc, FAULT_FREE_FIRMWARE(), () => previewAbsoluteTune(p)),
    });
const apply = async (p: AbsoluteProposal) => applyAbsoluteTune(p, await confirm(p));

async function denial(p: Promise<unknown>): Promise<ApplyBlockedError> {
    const err = await p.then(
        () => null,
        (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApplyBlockedError);
    return err as ApplyBlockedError;
}

/** Nothing reached the craft: not one MSP request, no backup taken. */
function nothingReachedTheCraft() {
    expect(codes()).toEqual([]);
    expect(backups()).toEqual([]);
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    resetConfirmations();
    gate.fc = createFirmwareFc();
    Object.assign(gate, { binding: true, release: true, safety: true, product: true, safetyFor: null, fresh: null });
});

/** The user's confirmation of a Restore, bound to its read-only preview. */
const confirmRestore = async (backupId: string) =>
    issueConfirmation({
        kind: "restore",
        backupId,
        preview: await previewedHash(gate.fc, FAULT_FREE_FIRMWARE(), () => previewAbsoluteRestore(backupId)),
    });

async function writeFailure(p: Promise<unknown>): Promise<TuneWriteError> {
    const err = await p.then(
        () => null,
        (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TuneWriteError);
    return err as TuneWriteError;
}

describe("what an EEPROM answer proves", () => {
    it("the firmware saved, its answer arrived corrupt: saved state unknown, not 'nothing saved'", async () => {
        gate.fc.corruptReplyAfterExecute = new Set([MSPCodes.MSP_EEPROM_WRITE]);
        const err = await writeFailure(apply(proposal()));
        expect(err).toMatchObject({ stage: "eeprom", saved: "unknown" });
        expect(err.message).toContain("eeprom_reply_unreadable");
        // The simulated firmware did save: "no" would have been a false statement.
        expect(gate.fc.eeprom.pids[0][0]).toBe(CHANGE.p_roll);
    });

    it("the firmware refuses the save (armed meanwhile): nothing saved", async () => {
        gate.fc.afterWrite = (fc) => {
            if (codes().includes(MSPCodes.MSP_SET_FILTER_CONFIG)) fc.armed = true;
        };
        const err = await writeFailure(apply(proposal()));
        // The refusal is caught at the profile/armed check before the save, or by the save itself.
        expect(["verify", "eeprom"]).toContain(err.stage);
        expect(err.saved).toBe("no");
        expect(gate.fc.eeprom.pids[0][0]).not.toBe(CHANGE.p_roll);
    });

    it("no answer to the save at all: unknown", async () => {
        gate.fc.faults[MSPCodes.MSP_EEPROM_WRITE] = "noreply";
        const err = await writeFailure(apply(proposal()));
        expect(err).toMatchObject({ stage: "eeprom", saved: "unknown" });
    });
});

describe("an unverified outcome blocks every further Apply on that craft", () => {
    async function uncertain() {
        gate.fc.corruptReplyAfterExecute = new Set([MSPCodes.MSP_EEPROM_WRITE]);
        const err = await writeFailure(apply(proposal()));
        gate.fc.corruptReplyAfterExecute = new Set();
        gate.fc.calls = [];
        return err;
    }

    it("is recorded with stage, saved state and backup, and refuses the next Apply before any MSP", async () => {
        const err = await uncertain();
        const open = useFcTransactionStore().forUid(gate.fc.uid);
        expect(open).toEqual([
            expect.objectContaining({
                stage: "eeprom",
                saved: "unknown",
                backupId: err.backupId,
                action: "absolute_apply",
            }),
        ]);
        const next = await denial(apply(proposal({ p_roll: 61 })));
        expect(next.reasons).toEqual([`fc:transaction_state_uncertain:${err.backupId}:eeprom:unknown`]);
        // The preview (read-only) was allowed; the Apply itself sent nothing.
        expect(writes()).toEqual([]);
    });

    it("survives a reload of the page (kept in this browser)", async () => {
        const err = await uncertain();
        setActivePinia(createPinia());
        const next = await denial(apply(proposal({ p_roll: 61 })));
        expect(next.reasons).toEqual([`fc:transaction_state_uncertain:${err.backupId}:eeprom:unknown`]);
    });

    it("a read-back cannot clear an unknown EEPROM state; only a verified Restore does", async () => {
        const err = await uncertain();
        const check = await checkTransactionState();
        expect(check.resolved).toBe(false);
        expect(check.reasons).toEqual([`state:${err.backupId}:eeprom_state_unknown_restore_required`]);
        const back = await restoreAbsoluteTune(err.backupId, await confirmRestore(err.backupId));
        expect(back.status).toBe("verified");
        expect(useFcTransactionStore().forUid(gate.fc.uid)).toEqual([]);
        expect((await apply(proposal({ p_roll: 61 }))).status).toBe("verified");
    });

    it("EEPROM not written (saved 'no'): a read-back equal to the backup resolves it, a different one does not", async () => {
        gate.fc.faults[MSPCodes.MSP_SET_FILTER_CONFIG] = "timeout";
        const err = await writeFailure(apply(proposal()));
        expect(err).toMatchObject({ stage: "write", saved: "no" });
        gate.fc.faults = {};
        // PIDs were written, the filter block not: RAM differs from the backup.
        let check = await checkTransactionState();
        expect(check.resolved).toBe(false);
        expect(check.reasons[0]).toMatch(new RegExp(`^state:${err.backupId}:differs_from_backup:`));
        // A reboot reloads RAM from EEPROM, which this write never touched.
        gate.fc.ram = structuredClone(gate.fc.eeprom);
        gate.fc.profiles = structuredClone(gate.fc.eepromProfiles);
        check = await checkTransactionState();
        expect(check).toEqual({ resolved: true, reasons: [] });
        expect(writes()).toEqual(expect.arrayContaining([MSPCodes.MSP_SET_PID]));
        gate.fc.calls = [];
        expect((await apply(proposal({ p_roll: 61 }))).status).toBe("verified");
    });

    it("unreadable storage of that state blocks (fail-closed)", async () => {
        localStorage.setItem(TRANSACTION_STORAGE_KEY, "{not json");
        setActivePinia(createPinia());
        const next = await denial(apply(proposal()));
        expect(next.reasons).toEqual([TRANSACTION_STATE_UNREADABLE]);
        nothingReachedTheCraft();
    });

    it("a failure before the first SET (stage prepare) is not recorded: the craft is unchanged", async () => {
        gate.fc.disconnectWhen = () => {
            if (useTuneBackupStore().backups.length) gate.product = false;
            return false;
        };
        const err = await writeFailure(apply(proposal()));
        expect(err.stage).toBe("prepare");
        expect(useFcTransactionStore().forUid(gate.fc.uid)).toEqual([]);
    });
});
