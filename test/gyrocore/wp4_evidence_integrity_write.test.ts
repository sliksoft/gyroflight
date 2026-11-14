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
        // The callback API of upstream's save-and-reboot: recorded, answered at once.
        send_message: vi.fn((code: number, _data: unknown, _cb: unknown, callback?: () => void) => {
            gate.fc.calls.push({ code, data: [] });
            callback?.();
        }),
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
    TRANSACTION_STATE_NOT_STORED,
    TRANSACTION_STATE_UNREADABLE,
    TRANSACTION_ENTRY_PREFIX,
    TRANSACTION_STORAGE_KEY,
    useFcTransactionStore,
    type UncertainTransaction,
} from "../../src/gyrocore/stores/fcTransactionState";
import { useFlightControllerStore } from "../../src/stores/fc";
import { valuesFromStore } from "../../src/gyrocore/tuning/absoluteTune";
import { usePidTuningMsp } from "../../src/composables/pidTuning/usePidTuningMsp";
import { useReboot } from "../../src/composables/useReboot";

const localStorageSet = Storage.prototype.setItem;

/** The transaction entries as stored now (one key each). */
function storedEntries(): UncertainTransaction[] {
    return Object.keys(localStorage)
        .filter((k) => k.startsWith(TRANSACTION_ENTRY_PREFIX))
        .map((k) => JSON.parse(localStorage.getItem(k)!) as UncertainTransaction);
}

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
        ["DeviceUID", "0a1b2c3d4e5f607112233445"],
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

/** An open entry of this craft as another write (another profile, page or tab) left it. */
function other(e: Partial<UncertainTransaction>): UncertainTransaction {
    return {
        uid: [...gate.fc.uid] as [number, number, number],
        action: "absolute_apply",
        stage: "write",
        saved: "no",
        backupId: "bk-other",
        profiles: [1],
        detail: "",
        at: "2026-10-24T00:00:00Z",
        ...e,
    };
}

describe("WP8 review: the lock covers what it claims, and only evidence clears it", () => {
    async function uncertainOnProfile0() {
        gate.fc.corruptReplyAfterExecute = new Set([MSPCodes.MSP_EEPROM_WRITE]);
        const err = await writeFailure(apply(proposal()));
        gate.fc.corruptReplyAfterExecute = new Set();
        gate.fc.calls = [];
        return err;
    }

    it("a Restore of profile 0 is refused while an entry a profile switch spread to profile 1 is open: nothing written", async () => {
        const err = await uncertainOnProfile0();
        const states = useFcTransactionStore();
        expect(states.forUid(gate.fc.uid)[0].profiles).toEqual([0]);
        const token = await confirmRestore(err.backupId);
        states.record(other({ backupId: "bk-other", profiles: [0, 1], detail: "fc:pid_profile_changed:0->1" }));
        gate.fc.calls = [];
        const refused = await denial(restoreAbsoluteTune(err.backupId, token));
        expect(refused.reasons).toEqual(["restore:uncertain_state_not_covered:bk-other:write:no"]);
        // Its EEPROM save would have persisted profile 1's unverified RAM too.
        expect(writes()).toEqual([]);
        expect(states.forUid(gate.fc.uid).map((e) => e.backupId)).toEqual(["bk-other", err.backupId]);
    });

    it("the transaction is stored as pending before its first SET (a page closed mid-write keeps it)", async () => {
        let pendingAtFirstSet: unknown = null;
        gate.fc.disconnectWhen = (_fc, code) => {
            if (pendingAtFirstSet === null && FIRMWARE_WRITE_CODES.has(code)) {
                pendingAtFirstSet = storedEntries();
            }
            return false;
        };
        expect((await apply(proposal())).status).toBe("verified");
        expect(pendingAtFirstSet).toEqual([expect.objectContaining({ stage: "in_progress", saved: "unknown" })]);
        // Settled: nothing left once verified.
        expect(useFcTransactionStore().forUid(gate.fc.uid)).toEqual([]);
    });

    it("no SET when the browser does not keep the pending entry", async () => {
        const p = proposal();
        const token = await confirm(p);
        // The browser refuses this one key (a full quota); everything else is stored as usual.
        const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
            if (key.startsWith(TRANSACTION_ENTRY_PREFIX)) throw new Error("quota");
            localStorageSet.call(this, key, value);
        });
        try {
            const err = await denial(applyAbsoluteTune(p, token));
            expect(err.reasons).toEqual([TRANSACTION_STATE_NOT_STORED]);
        } finally {
            spy.mockRestore();
        }
        expect(writes()).toEqual([]);
    });

    it("the shared upstream saves refuse on that craft: the PID tab's write and the EEPROM save", async () => {
        await uncertainOnProfile0();
        useFlightControllerStore().config.uid = [...gate.fc.uid];
        await expect(usePidTuningMsp().writePidTuningConfig()).rejects.toBeInstanceOf(ApplyBlockedError);
        await expect(useReboot().saveToEeprom()).rejects.toBeInstanceOf(ApplyBlockedError);
        expect(writes()).toEqual([]);
    });

    it("a verify read that fails after the SETs leaves the backup's values in the shared store, not the proposal's", async () => {
        const p = proposal();
        const live = (await previewAbsoluteTune(p)).before;
        gate.fc.calls = [];
        let sets = 0;
        gate.fc.disconnectWhen = (_fc, code) => {
            if (FIRMWARE_WRITE_CODES.has(code)) sets++;
            // The link drops on the first read after the last SET of the write.
            return sets >= 3 && code === MSPCodes.MSP_PID;
        };
        const err = await writeFailure(apply(p));
        expect(err.stage).toBe("verify");
        const fc = useFlightControllerStore();
        const now = valuesFromStore(
            {
                pids: fc.pids,
                advancedTuning: fc.advancedTuning as unknown as Record<string, unknown>,
                filterConfig: fc.filterConfig as unknown as Record<string, unknown>,
            },
            gate.fc.apiVersion,
        );
        for (const key of Object.keys(CHANGE)) expect(now[key]).toBe(live.values[key]);
    });
});

describe("WP8 review round 2: Restore covers one profile and one route, and never runs past what it does not cover", () => {
    async function uncertain() {
        gate.fc.corruptReplyAfterExecute = new Set([MSPCodes.MSP_EEPROM_WRITE]);
        const err = await writeFailure(apply(proposal()));
        gate.fc.corruptReplyAfterExecute = new Set();
        gate.fc.calls = [];
        return err;
    }

    async function refusedRestore(backupId: string, inject: () => void): Promise<ApplyBlockedError> {
        const token = await confirmRestore(backupId);
        inject();
        gate.fc.calls = [];
        const refused = await denial(restoreAbsoluteTune(backupId, token));
        expect(writes()).toEqual([]);
        return refused;
    }

    it("a page closed mid-write on profile 1 (pending) keeps the craft locked through a Restore of profile 0", async () => {
        const err = await uncertain();
        const states = useFcTransactionStore();
        const refused = await refusedRestore(err.backupId, () =>
            states.record(other({ id: "tx-p1", stage: "in_progress", saved: "unknown", profiles: [1] })),
        );
        expect(refused.reasons).toEqual(["restore:uncertain_state_not_covered:bk-other:in_progress:unknown"]);
        expect(states.forUid(gate.fc.uid)).toHaveLength(2);
    });

    it("an entry with unknown profiles (null) is covered by no Restore", async () => {
        const err = await uncertain();
        const refused = await refusedRestore(err.backupId, () =>
            useFcTransactionStore().record(other({ profiles: null, stage: "in_progress", saved: "unknown" })),
        );
        expect(refused.reasons).toEqual(["restore:uncertain_state_not_covered:bk-other:in_progress:unknown"]);
    });

    it("a slider-route entry on the same profile is not covered by the absolute Restore (another route, other blocks)", async () => {
        const err = await uncertain();
        const refused = await refusedRestore(err.backupId, () =>
            useFcTransactionStore().record(other({ action: "apply", profiles: [0] })),
        );
        expect(refused.reasons).toEqual(["restore:uncertain_state_not_covered:bk-other:write:no"]);
    });

    it("a pending entry of profile 0 is covered by no Restore: its writer may still be writing (WP8 P0, was the bug)", async () => {
        const err = await uncertain();
        const states = useFcTransactionStore();
        const token = await confirmRestore(err.backupId);
        states.record(other({ id: "tx-p0", stage: "in_progress", saved: "unknown", profiles: [0] }));
        gate.fc.calls = [];
        expect((await denial(restoreAbsoluteTune(err.backupId, token))).reasons).toEqual([
            "restore:uncertain_state_not_covered:bk-other:in_progress:unknown",
        ]);
        expect(writes()).toEqual([]);
        expect(states.forUid(gate.fc.uid)).toHaveLength(2);
    });

    it("an ended entry of profile 0 is covered by a verified Restore of profile 0", async () => {
        const err = await uncertain();
        const states = useFcTransactionStore();
        const token = await confirmRestore(err.backupId);
        states.record(other({ id: "tx-p0", stage: "write", saved: "no", profiles: [0] }));
        expect((await restoreAbsoluteTune(err.backupId, token)).status).toBe("verified");
        expect(states.forUid(gate.fc.uid)).toEqual([]);
    });

    it("the backup a recovery Restore takes of the unverified state is never a Restore target", async () => {
        const err = await uncertain();
        const back = await restoreAbsoluteTune(err.backupId, await confirmRestore(err.backupId));
        expect(back.status).toBe("verified");
        const taken = useTuneBackupStore().get(back.backupId)!;
        expect(taken).toMatchObject({ reason: "before_restore", stateKnown: false });
        gate.fc.calls = [];
        // Writing it back would put the unverified (possibly partial) write on the craft again.
        const refused = await denial(previewAbsoluteRestore(back.backupId));
        expect(refused.reasons).toEqual(["restore:backup_unverified"]);
        const token = issueConfirmation({ kind: "restore", backupId: back.backupId, preview: "any" });
        expect((await denial(restoreAbsoluteTune(back.backupId, token))).reasons).toEqual([
            "restore:backup_unverified",
        ]);
        expect(writes()).toEqual([]);
    });

    it("a before-Restore backup stored before provenance was recorded is no Restore target", async () => {
        expect((await apply(proposal())).status).toBe("verified");
        const { stateKnown: _known, ...legacy } = {
            ...backups()[0],
            id: "bk-legacy",
            reason: "before_restore" as const,
        };
        expect(useTuneBackupStore().save(legacy)).toBe(true);
        gate.fc.calls = [];
        expect((await denial(previewAbsoluteRestore("bk-legacy"))).reasons).toEqual([
            "restore:backup_provenance_unknown",
        ]);
        expect(writes()).toEqual([]);
    });

    it("a Restore on a craft with a known state takes an ordinary backup", async () => {
        expect((await apply(proposal())).status).toBe("verified");
        const first = backups()[0];
        const back = await restoreAbsoluteTune(first.id, await confirmRestore(first.id));
        expect(useTuneBackupStore().get(back.backupId)?.stateKnown).toBe(true);
        // And that one may be written back (undoing the Restore).
        expect((await previewAbsoluteRestore(back.backupId)).backup.id).toBe(back.backupId);
    });

    it("unreadable storage is never overwritten: a Restore refuses, and a new page still finds it unreadable", async () => {
        expect((await apply(proposal())).status).toBe("verified");
        const first = backups()[0];
        const token = await confirmRestore(first.id);
        localStorage.setItem(TRANSACTION_STORAGE_KEY, "{not json");
        setActivePinia(createPinia());
        gate.fc.calls = [];
        expect((await denial(restoreAbsoluteTune(first.id, token))).reasons).toEqual([TRANSACTION_STATE_UNREADABLE]);
        expect(writes()).toEqual([]);
        expect(localStorage.getItem(TRANSACTION_STORAGE_KEY)).toBe("{not json");
        // Even a record or settle on this page leaves the unreadable storage as it is.
        useFcTransactionStore().record(other({}));
        expect(localStorage.getItem(TRANSACTION_STORAGE_KEY)).toBe("{not json");
        setActivePinia(createPinia());
        expect(useFcTransactionStore().unreadable).toBe(true);
    });

    it("storage that turns unreadable after the page loaded (another tab) blocks the next Apply", async () => {
        useFcTransactionStore();
        localStorage.setItem(TRANSACTION_STORAGE_KEY, "[1,2]");
        const next = await denial(apply(proposal()));
        expect(next.reasons).toEqual([TRANSACTION_STATE_UNREADABLE]);
        expect(writes()).toEqual([]);
    });

    it("an entry another tab stored after this page loaded blocks this page's Apply and its upstream saves", async () => {
        const states = useFcTransactionStore();
        expect(states.forUid(gate.fc.uid)).toEqual([]);
        // Tab A's failure, written straight to the shared storage; this page's store never saw it.
        localStorage.setItem(TRANSACTION_STORAGE_KEY, JSON.stringify([other({ id: "tx-a" })]));
        expect((await denial(apply(proposal()))).reasons).toEqual(["fc:transaction_state_uncertain:bk-other:write:no"]);
        useFlightControllerStore().config.uid = [...gate.fc.uid];
        await expect(useReboot().saveToEeprom()).rejects.toBeInstanceOf(ApplyBlockedError);
        expect(writes()).toEqual([]);
    });

    it("an upstream EEPROM save reads the storage too: another tab's entry refuses it on its own", async () => {
        useFcTransactionStore();
        useFlightControllerStore().config.uid = [...gate.fc.uid];
        localStorage.setItem(TRANSACTION_STORAGE_KEY, JSON.stringify([other({ id: "tx-a" })]));
        await expect(useReboot().saveToEeprom()).rejects.toBeInstanceOf(ApplyBlockedError);
        expect(writes()).toEqual([]);
    });

    it("this page's next record keeps the entry another tab stored (it starts from the storage, not its cache)", async () => {
        const states = useFcTransactionStore();
        localStorage.setItem(TRANSACTION_STORAGE_KEY, JSON.stringify([other({ id: "tx-a" })]));
        states.record(other({ id: "tx-b", backupId: "bk-b" }));
        expect(
            storedEntries()
                .map((e) => e.id)
                .sort(),
        ).toEqual(["tx-a", "tx-b"]);
    });

    it("the slider Restore covers the slider route's entries of its own profile only", () => {
        const st = useFcTransactionStore();
        const uid = [...gate.fc.uid] as [number, number, number];
        for (const [backupId, action, profiles] of [
            ["s0", "apply", [0]],
            ["s1", "apply", [1]],
            ["sn", "restore", null],
            ["a0", "absolute_apply", [0]],
        ] as const) {
            st.record(other({ backupId, action, profiles: profiles ? [...profiles] : null }));
        }
        const ids = (l: UncertainTransaction[]) => l.map((e) => e.backupId).sort();
        expect(ids(st.notCoveredByRestore(uid, { route: "slider", profile: 0 }))).toEqual(["a0", "s1", "sn"]);
        expect(st.notCoveredByRestore(uid, { route: "slider", profile: null })).toHaveLength(4);
        expect(st.resolveByRestore(uid, { route: "slider", profile: 0 })).toBe(true);
        expect(ids(st.forUid(uid))).toEqual(["a0", "s1", "sn"]);
    });

    it("save-and-reboot checks again when its delayed EEPROM write goes out", async () => {
        Object.assign(useFlightControllerStore().config, { uid: [...gate.fc.uid], armingDisabled: true });
        const saving = useReboot().saveAndReboot();
        // A Gyroflight write in another tab ends unverified during the 100 ms delay.
        localStorage.setItem(TRANSACTION_STORAGE_KEY, JSON.stringify([other({ id: "tx-a" })]));
        await expect(saving).rejects.toBeInstanceOf(ApplyBlockedError);
        expect(codes()).not.toContain(MSPCodes.MSP_EEPROM_WRITE);
    });

    it("two tabs that both read an empty state and then store a pending entry each keep both (one key per entry)", () => {
        const pinA = createPinia();
        const pinB = createPinia();
        setActivePinia(pinA);
        const a = useFcTransactionStore();
        setActivePinia(pinB);
        const b = useFcTransactionStore();
        a.sync();
        b.sync();
        expect(a.recordPending({ ...other({}), id: "tx-x", stage: "in_progress", backupId: "bk-x" })).toBe(true);
        expect(b.recordPending({ ...other({}), id: "tx-y", stage: "in_progress", backupId: "bk-y" })).toBe(true);
        // Tab A closes mid-write: its entry is still there for the next page.
        setActivePinia(createPinia());
        expect(
            useFcTransactionStore()
                .forUid(gate.fc.uid)
                .map((e) => e.id)
                .sort(),
        ).toEqual(["tx-x", "tx-y"]);
        // B settling its own transaction leaves A's.
        b.settle("tx-y", null);
        expect(storedEntries().map((e) => e.id)).toEqual(["tx-x"]);
    });

    it("an entry another page changed after it was read is not resolved by evidence about the old one", () => {
        const st = useFcTransactionStore();
        st.record(other({ id: "tx-c" }));
        const seen = st.forUid(gate.fc.uid);
        localStorage.setItem(
            `${TRANSACTION_ENTRY_PREFIX}tx-c`,
            JSON.stringify(other({ id: "tx-c", saved: "unknown" })),
        );
        expect(st.resolveEntries(seen)).toBe(false);
        expect(storedEntries()).toEqual([expect.objectContaining({ id: "tx-c", saved: "unknown" })]);
    });

    it("an unreadable entry key blocks every craft, and is left as it is", async () => {
        localStorage.setItem(`${TRANSACTION_ENTRY_PREFIX}tx-bad`, "{not json");
        setActivePinia(createPinia());
        expect((await denial(apply(proposal()))).reasons).toEqual([TRANSACTION_STATE_UNREADABLE]);
        expect(localStorage.getItem(`${TRANSACTION_ENTRY_PREFIX}tx-bad`)).toBe("{not json");
        nothingReachedTheCraft();
    });

    it("an earlier-format list is moved to one key per entry and still blocks", async () => {
        localStorage.setItem(TRANSACTION_STORAGE_KEY, JSON.stringify([other({ id: "tx-old" })]));
        setActivePinia(createPinia());
        expect((await denial(apply(proposal()))).reasons).toEqual(["fc:transaction_state_uncertain:bk-other:write:no"]);
        expect(localStorage.getItem(TRANSACTION_STORAGE_KEY)).toBeNull();
        expect(storedEntries().map((e) => e.id)).toEqual(["tx-old"]);
    });

    it("the read-only check does not report a known state while another page added an entry during its reads", async () => {
        gate.fc.faults[MSPCodes.MSP_SET_FILTER_CONFIG] = "timeout";
        const err = await writeFailure(apply(proposal()));
        expect(err).toMatchObject({ stage: "write", saved: "no" });
        gate.fc.faults = {};
        gate.fc.ram = structuredClone(gate.fc.eeprom);
        gate.fc.profiles = structuredClone(gate.fc.eepromProfiles);
        let injected = false;
        gate.fc.disconnectWhen = (_fc, code) => {
            // During the read-back the check compares (after it listed the open entries).
            if (!injected && code === MSPCodes.MSP_PID) {
                injected = true;
                localStorage.setItem(`${TRANSACTION_ENTRY_PREFIX}tx-late`, JSON.stringify(other({ id: "tx-late" })));
            }
            return false;
        };
        const check = await checkTransactionState();
        expect(check).toEqual({ resolved: false, reasons: ["state:bk-other:changed_during_check"] });
        // Its own entry was resolved by the evidence; the late one stays.
        expect(storedEntries().map((e) => e.id)).toEqual(["tx-late"]);
    });

    it("a pending entry never takes over the key of a stored one (an id collision refuses the write)", () => {
        const st = useFcTransactionStore();
        st.record(other({ id: "tx-same", backupId: "bk-first" }));
        expect(st.recordPending({ ...other({}), id: "tx-same", stage: "in_progress", backupId: "bk-second" })).toBe(
            false,
        );
        expect(storedEntries()).toEqual([expect.objectContaining({ id: "tx-same", backupId: "bk-first" })]);
    });
});
