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
 * WP8 P0 closure, route side: the findings of the Codex review of 241e1f05..6aa4fa7a on the real
 * Restore routes, the read-only check, the transaction store and the upstream PID-tab save, against
 * the byte-level firmware simulator (harness/mspFirmware.ts).
 *
 * What is real here and what is not:
 *   - Restore, checkTransactionState, fcTransactionState, tuneBackup and the PID-tab save are the
 *     production code. Restore does not go through the write authority (writeAuthority.ts), so no
 *     Safety, release or product-lock stand-in is involved in any Restore or check below.
 *   - The absolute Apply runs only to create a starting state (a verified write and its backup, or an
 *     uncertain one); for that the binding, release, Safety and product lock are released by the
 *     harness (`gate`), as in wp4_evidence_integrity_write.test.ts. No assertion here is about them.
 *   - MSP is the simulator's stand-in for MSP.promise. It passes every request through the same
 *     write guard msp.ts calls (fcWriteGuard.mspRequestRefusal), with the permit the route gave; that
 *     msp.ts itself calls it is shown on the real transport in wp8_p0_closure_transport.test.ts.
 *   - "Another tab" is what this page can see of one: the shared localStorage and navigator.locks.
 *     navigator.locks is the test shim (harness/webLocks.ts), not a browser.
 */

import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FirmwareFc } from "./harness/mspFirmware";

const gate = vi.hoisted(() => ({
    fc: undefined as unknown as FirmwareFc,
    binding: true,
    release: true,
    safety: true,
    product: true,
    fresh: null as unknown,
    /** Hold the first request with this code until `release` resolves (a writer pausing mid-transaction). */
    pause: null as null | { code: number; reached: () => void; release: Promise<void>; used?: boolean },
}));

vi.mock("../../src/js/msp", () => ({
    default: {
        promise: vi.fn(async (code: number, data?: number[], opts?: { permit?: unknown }) => {
            const guard = await import("../../src/composables/fcWriteGuard");
            const refusal = guard.mspRequestRefusal(code, data, opts?.permit as never);
            if (refusal) throw guard.writeRefused(refusal);
            if (gate.pause && gate.pause.code === code && !gate.pause.used) {
                gate.pause.used = true;
                gate.pause.reached();
                await gate.pause.release;
            }
            return (await import("./harness/mspFirmware")).firmwarePromise(gate.fc, code, data);
        }),
        send_message: vi.fn((code: number, _data: unknown, _cb: unknown, callback?: () => void) => {
            gate.fc.calls.push({ code, data: [] });
            callback?.();
        }),
    },
}));
vi.mock("@/composables/useDialog", () => ({ useDialog: () => ({ showYesNo: async () => true }) }));
vi.mock("@/gyrocore/engine/autotuneV2", async () => ({
    ...(await vi.importActual<typeof import("../../src/gyrocore/engine/autotuneV2")>("@/gyrocore/engine/autotuneV2")),
    runAutotuneV2: () => ({ releasableProposal: structuredClone(gate.fresh) }),
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
                      proposalId: p.id,
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
import { restoreTargetIssue, useTuneBackupStore, type TuneBackup } from "../../src/gyrocore/stores/tuneBackup";
import { issueConfirmation, resetConfirmations } from "../../src/gyrocore/tuning/applyConfirmation";
import {
    TRANSACTION_ENTRY_PREFIX,
    useFcTransactionStore,
    type UncertainTransaction,
} from "../../src/gyrocore/stores/fcTransactionState";
import { useFlightControllerStore } from "../../src/stores/fc";
import { usePidTuningMsp } from "../../src/composables/pidTuning/usePidTuningMsp";
import type { AbsoluteProposal } from "../../src/gyrocore/releaseGate/releaseContract";
import type { AutotuneLogInput, AutotuneV2Result } from "../../src/gyrocore/engine/autotuneV2";
import type { AbsoluteValues } from "../../src/gyrocore/tuning/absoluteTune";
import { air65FirmwareState, createFirmwareFc, FIRMWARE_WRITE_CODES, type FirmwareState } from "./harness/mspFirmware";
import { FAULT_FREE_FIRMWARE, previewedHash } from "./harness/previewConfirmation";

/** The name of the write lock: every Gyroflight write transaction of this origin holds it. */
const WRITE_LOCK = "gyroflight.fcWrite";

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

const CHANGE: AbsoluteValues = { p_roll: 60, d_roll: 32, f_pitch: 40, dterm_lpf1_static_hz: 80 };

function proposal(change: AbsoluteValues = CHANGE): AbsoluteProposal {
    return {
        id: `prop-${Object.entries(change).join("|")}`,
        createdAt: "2026-10-22T00:00:00Z",
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

/** Setup only (harness-released gates, see the header): a verified absolute Apply. */
async function verifiedApply(p: AbsoluteProposal = proposal()) {
    analysed(p);
    const token = issueConfirmation({
        kind: "absolute",
        proposalId: p.id,
        change: { ...p.change },
        preview: await previewedHash(gate.fc, FAULT_FREE_FIRMWARE(), () => previewAbsoluteTune(p)),
    });
    return applyAbsoluteTune(p, token);
}

/** Setup only: an absolute Apply whose EEPROM answer is lost after the save (saved "unknown"). */
async function uncertainApply(): Promise<TuneWriteError> {
    gate.fc.corruptReplyAfterExecute = new Set([MSPCodes.MSP_EEPROM_WRITE]);
    const err = await verifiedApply().then(
        () => null,
        (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TuneWriteError);
    gate.fc.corruptReplyAfterExecute = new Set();
    gate.fc.calls = [];
    return err as TuneWriteError;
}

const confirmRestore = async (backupId: string) =>
    issueConfirmation({
        kind: "restore",
        backupId,
        preview: await previewedHash(gate.fc, FAULT_FREE_FIRMWARE(), () => previewAbsoluteRestore(backupId)),
    });

async function refusal(p: Promise<unknown>): Promise<string[]> {
    const err = await p.then(
        () => null,
        (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApplyBlockedError);
    return (err as ApplyBlockedError).reasons;
}

async function writeFailure(p: Promise<unknown>): Promise<TuneWriteError> {
    const err = await p.then(
        () => null,
        (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TuneWriteError);
    return err as TuneWriteError;
}

function other(e: Partial<UncertainTransaction>): UncertainTransaction {
    return {
        id: "tx-other",
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

/** What another tab (or a closed page) left in the shared storage. */
function storeAsAnotherTab(e: UncertainTransaction) {
    localStorage.setItem(`${TRANSACTION_ENTRY_PREFIX}${e.id}`, JSON.stringify(e));
}

function storedEntries(): UncertainTransaction[] {
    return Object.keys(localStorage)
        .filter((k) => k.startsWith(TRANSACTION_ENTRY_PREFIX))
        .map((k) => JSON.parse(localStorage.getItem(k)!) as UncertainTransaction);
}

/** Another tab holding the write lock until the returned function is called. */
async function anotherTabHoldsTheLock(): Promise<() => void> {
    let release!: () => void;
    let granted!: () => void;
    const held = new Promise<void>((r) => (granted = r));
    void (
        navigator as unknown as { locks: { request: (n: string, cb: () => Promise<void>) => Promise<void> } }
    ).locks.request(
        WRITE_LOCK,
        () =>
            new Promise<void>((r) => {
                release = r;
                granted();
            }),
    );
    await held;
    return () => release();
}

/** Pause the next request with `code` (before the simulated firmware runs it). */
function pauseAt(code: number) {
    let reached!: () => void;
    let release!: () => void;
    const at = new Promise<void>((r) => (reached = r));
    gate.pause = { code, reached, release: new Promise<void>((r) => (release = r)) };
    return { at, release: () => release() };
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    resetConfirmations();
    gate.fc = createFirmwareFc();
    gate.pause = null;
    Object.assign(gate, { binding: true, release: true, safety: true, product: true, fresh: null });
});

afterEach(() => {
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------
describe("P0-1: the read-only check never releases an entry whose profile scope it cannot read", () => {
    /** A verified Apply, then the craft put back to the state before it (as a power cycle would not prove). */
    async function backupMatchingTheCraft(): Promise<TuneBackup> {
        const ram0 = structuredClone(gate.fc.ram);
        const profiles0 = structuredClone(gate.fc.profiles);
        expect((await verifiedApply()).status).toBe("verified");
        const b = backups()[0];
        gate.fc.ram = structuredClone(ram0);
        gate.fc.profiles = structuredClone(profiles0);
        gate.fc.calls = [];
        return b;
    }

    it("a slider entry (profiles null) stays open although profile 0 reads back equal: profile 1 may hold its SET", async () => {
        const b = await backupMatchingTheCraft();
        const { absolute: _a, ...v1 } = { ...b, id: "bk-slider", reason: "before_apply" as const };
        expect(useTuneBackupStore().save(v1)).toBe(true);
        // The slider write began on profile 0; a switch during its reads moved its SET into profile 1.
        gate.fc.profiles[1].pids[0][0] = 99;
        useFcTransactionStore().record(
            other({ id: "tx-slider", action: "apply", backupId: "bk-slider", profiles: null, saved: "no" }),
        );
        const check = await checkTransactionState();
        expect(check.resolved).toBe(false);
        expect(check.reasons).toEqual(["state:bk-slider:profile_scope_unknown_restore_required"]);
        expect(storedEntries().map((e) => e.id)).toEqual(["tx-slider"]);
        // And the lock it keeps still refuses the PID tab's save.
        useFlightControllerStore().config.uid = [...gate.fc.uid];
        await expect(usePidTuningMsp().writePidTuningConfig()).rejects.toBeInstanceOf(ApplyBlockedError);
        expect(writes()).toEqual([]);
    });

    it("an entry stored before profiles were recorded (no field) is not released by one profile's read-back", async () => {
        const b = await backupMatchingTheCraft();
        const { profiles: _p, ...legacy } = other({ id: "tx-legacy", backupId: b.id, profiles: [0] });
        storeAsAnotherTab(legacy as UncertainTransaction);
        setActivePinia(createPinia());
        const check = await checkTransactionState();
        expect(check).toEqual({
            resolved: false,
            reasons: [`state:${b.id}:profile_scope_unknown_restore_required`],
        });
        expect(storedEntries()).toHaveLength(1);
    });

    it("an absolute entry that may have reached two profiles is not released by one of them", async () => {
        const b = await backupMatchingTheCraft();
        useFcTransactionStore().record(other({ id: "tx-two", backupId: b.id, profiles: [0, 1] }));
        const check = await checkTransactionState();
        expect(check).toEqual({
            resolved: false,
            reasons: [`state:${b.id}:profile_scope_unknown_restore_required`],
        });
    });

    it("control: an absolute entry of exactly the read profile, saved 'no', equal to its backup, is released", async () => {
        const b = await backupMatchingTheCraft();
        useFcTransactionStore().record(other({ id: "tx-p0", backupId: b.id, profiles: [0] }));
        expect(await checkTransactionState()).toEqual({ resolved: true, reasons: [] });
        expect(storedEntries()).toEqual([]);
    });
});

// ---------------------------------------------------------------------------------------------
describe("P0-2: a Restore never removes a transaction that is still in progress, and checks again before each write", () => {
    it("a pending entry of profile 0 (a page still writing, or closed mid-write) is covered by no Restore", async () => {
        const err = await uncertainApply();
        const token = await confirmRestore(err.backupId);
        storeAsAnotherTab(other({ id: "tx-p0", stage: "in_progress", saved: "unknown", profiles: [0] }));
        gate.fc.calls = [];
        expect(await refusal(restoreAbsoluteTune(err.backupId, token))).toEqual([
            "restore:uncertain_state_not_covered:bk-other:in_progress:unknown",
        ]);
        expect(writes()).toEqual([]);
        expect(
            storedEntries()
                .map((e) => e.id)
                .sort(),
        ).toEqual(expect.arrayContaining(["tx-p0"]));
        expect(storedEntries()).toHaveLength(2);
    });

    it("an entry another tab stores after the Restore's first SET stops it before its next SET", async () => {
        const err = await uncertainApply();
        const token = await confirmRestore(err.backupId);
        gate.fc.afterWrite = () => {
            if (writes().length === 1) storeAsAnotherTab(other({ id: "tx-late", profiles: [1] }));
        };
        gate.fc.calls = [];
        const failed = await writeFailure(restoreAbsoluteTune(err.backupId, token));
        expect(failed.stage).toBe("write");
        expect(writes()).toHaveLength(1);
        expect(codes()).not.toContain(MSPCodes.MSP_EEPROM_WRITE);
        // Its own outcome stays uncertain, and the late entry is kept.
        expect(storedEntries().map((e) => e.id)).toContain("tx-late");
        expect(useFcTransactionStore().forUid(gate.fc.uid).length).toBeGreaterThanOrEqual(3);
    });

    it("an entry another tab stores after the Restore's last SET stops it before MSP_EEPROM_WRITE", async () => {
        const err = await uncertainApply();
        const token = await confirmRestore(err.backupId);
        gate.fc.afterWrite = (fc) => {
            if (codes().includes(MSPCodes.MSP_SET_FILTER_CONFIG)) {
                storeAsAnotherTab(other({ id: "tx-late", profiles: [1] }));
                fc.afterWrite = undefined;
            }
        };
        gate.fc.calls = [];
        const failed = await writeFailure(restoreAbsoluteTune(err.backupId, token));
        expect(failed.saved).toBe("no");
        expect(codes()).not.toContain(MSPCodes.MSP_EEPROM_WRITE);
        expect(gate.fc.eeprom.pids[0][0]).toBe(CHANGE.p_roll);
    });

    it("a transaction whose own pending entry was removed meanwhile stops before its next write", async () => {
        const err = await uncertainApply();
        const token = await confirmRestore(err.backupId);
        gate.fc.afterWrite = () => {
            if (writes().length === 1) {
                const own = storedEntries().find((e) => e.stage === "in_progress")!;
                localStorage.removeItem(`${TRANSACTION_ENTRY_PREFIX}${own.id}`);
            }
        };
        gate.fc.calls = [];
        await writeFailure(restoreAbsoluteTune(err.backupId, token));
        expect(writes()).toHaveLength(1);
        // The uncertain outcome is recorded again: the craft stays locked.
        expect(useFcTransactionStore().forUid(gate.fc.uid).length).toBeGreaterThanOrEqual(2);
    });
});

// ---------------------------------------------------------------------------------------------
describe("P0-3: backups without a recorded provenance are never a Restore target, whatever their reason", () => {
    for (const reason of ["before_apply", "before_absolute_apply", "before_restore"] as const) {
        it(`a ${reason} backup stored before stateKnown was recorded is refused by preview and Restore`, async () => {
            expect((await verifiedApply()).status).toBe("verified");
            const { stateKnown: _k, ...legacy } = { ...backups()[0], id: `bk-legacy-${reason}`, reason };
            expect(useTuneBackupStore().save(legacy)).toBe(true);
            gate.fc.calls = [];
            expect(await refusal(previewAbsoluteRestore(legacy.id))).toEqual(["restore:backup_provenance_unknown"]);
            const token = issueConfirmation({ kind: "restore", backupId: legacy.id, preview: "any" });
            expect(await refusal(restoreAbsoluteTune(legacy.id, token))).toEqual(["restore:backup_provenance_unknown"]);
            expect(writes()).toEqual([]);
            // The panels list Restore targets through the same rule.
            expect(restoreTargetIssue(legacy)).toBe("restore:backup_provenance_unknown");
        });
    }

    it("a backup taken by this code (stateKnown true) is a Restore target", async () => {
        expect((await verifiedApply()).status).toBe("verified");
        const b = backups()[0];
        expect(b.stateKnown).toBe(true);
        expect(restoreTargetIssue(b)).toBeNull();
        expect((await restoreAbsoluteTune(b.id, await confirmRestore(b.id))).status).toBe("verified");
    });
});

// ---------------------------------------------------------------------------------------------
describe("P2: one write transaction at a time per origin, reserved atomically", () => {
    it("another tab holding the write lock refuses this page's Restore before any MSP, and leaves its entry", async () => {
        expect((await verifiedApply()).status).toBe("verified");
        const b = backups()[0];
        const token = await confirmRestore(b.id);
        const release = await anotherTabHoldsTheLock();
        storeAsAnotherTab(other({ id: "tx-busy", stage: "in_progress", saved: "unknown", profiles: [0] }));
        gate.fc.calls = [];
        try {
            expect(await refusal(restoreAbsoluteTune(b.id, token))).toEqual(["fc:write_lock_busy"]);
            expect(codes()).toEqual([]);
            // The read-only check resolves entries: it waits for no one and refuses too.
            expect(await refusal(checkTransactionState())).toEqual(["fc:write_lock_busy"]);
            expect(storedEntries().map((e) => e.id)).toEqual(["tx-busy"]);
        } finally {
            release();
        }
    });

    it("a writer paused mid-Restore: a second Restore and the check on the same page are refused, then the first ends verified", async () => {
        expect((await verifiedApply()).status).toBe("verified");
        const b = backups()[0];
        const t1 = await confirmRestore(b.id);
        const t2 = await confirmRestore(b.id);
        const pause = pauseAt(MSPCodes.MSP_SET_PID);
        gate.fc.calls = [];
        const first = restoreAbsoluteTune(b.id, t1);
        await pause.at;
        const pending = storedEntries();
        expect(pending).toEqual([expect.objectContaining({ stage: "in_progress", action: "absolute_restore" })]);
        const before = codes().length;
        expect(await refusal(restoreAbsoluteTune(b.id, t2))).toEqual(["fc:write_lock_busy"]);
        expect(await refusal(checkTransactionState())).toEqual(["fc:write_lock_busy"]);
        // The PID tab's save on the same page is refused while the Restore is open.
        useFlightControllerStore().config.uid = [...gate.fc.uid];
        await expect(usePidTuningMsp().writePidTuningConfig()).rejects.toBeInstanceOf(ApplyBlockedError);
        expect(codes().length).toBe(before + 0 + 0);
        expect(storedEntries()).toEqual(pending);
        pause.release();
        expect((await first).status).toBe("verified");
        expect(storedEntries()).toEqual([]);
    });

    it("while a Restore of this page is still reading (no entry yet), another write of the page is refused", async () => {
        expect((await verifiedApply()).status).toBe("verified");
        const b = backups()[0];
        const token = await confirmRestore(b.id);
        const pause = pauseAt(MSPCodes.MSP_API_VERSION);
        gate.fc.calls = [];
        const restoring = restoreAbsoluteTune(b.id, token);
        await pause.at;
        expect(storedEntries()).toEqual([]);
        useFlightControllerStore().config.uid = [...gate.fc.uid];
        const err = await usePidTuningMsp()
            .writePidTuningConfig()
            .then(
                () => null,
                (e: unknown) => e,
            );
        // The page also gave up its shared write lease for the transaction's exclusive one (WP8-F02).
        const inProgress = ["fc:write_lease_not_held", "fc:gyroflight_write_in_progress"];
        expect((err as ApplyBlockedError).reasons).toEqual(["fc:gyroflight_write_in_progress"]);
        // At the transport too, for a write that skips the tab's own check.
        const { default: MSP } = await import("../../src/js/msp");
        expect(await refusal(MSP.promise(MSPCodes.MSP_SET_PID, [1]))).toEqual(inProgress);
        expect(writes()).toEqual([]);
        pause.release();
        expect((await restoring).status).toBe("verified");
    });

    it("a pending entry another page changed before this transaction settled is left as that page stored it", async () => {
        expect((await verifiedApply()).status).toBe("verified");
        const b = backups()[0];
        const token = await confirmRestore(b.id);
        let changed: UncertainTransaction | null = null;
        let saved = false;
        // During the read-back after MSP_EEPROM_WRITE (no write of this transaction follows).
        gate.fc.disconnectWhen = (_fc, code) => {
            if (code === MSPCodes.MSP_EEPROM_WRITE) saved = true;
            else if (saved && !changed) {
                const own = storedEntries().find((e) => e.stage === "in_progress")!;
                changed = { ...own, detail: "changed by another page" };
                storeAsAnotherTab(changed);
            }
            return false;
        };
        gate.fc.calls = [];
        expect((await restoreAbsoluteTune(b.id, token)).status).toBe("verified");
        expect(storedEntries()).toEqual([changed]);
        // Not someone else's change taken for a broken storage: the page still reads it normally.
        expect(useFcTransactionStore().unreadable).toBe(false);
    });

    it("two transactions started in the same tick: exactly one reaches the craft", async () => {
        expect((await verifiedApply()).status).toBe("verified");
        const b = backups()[0];
        const t1 = await confirmRestore(b.id);
        const t2 = await confirmRestore(b.id);
        gate.fc.calls = [];
        const results = await Promise.allSettled([restoreAbsoluteTune(b.id, t1), restoreAbsoluteTune(b.id, t2)]);
        const ok = results.filter((r) => r.status === "fulfilled");
        const refused = results.filter(
            (r) =>
                r.status === "rejected" &&
                r.reason instanceof ApplyBlockedError &&
                r.reason.reasons.includes("fc:write_lock_busy"),
        );
        expect(ok).toHaveLength(1);
        expect(refused).toHaveLength(1);
        expect(codes().filter((c) => c === MSPCodes.MSP_EEPROM_WRITE)).toHaveLength(1);
    });

    it("a colliding transaction id never takes over a stored entry: no SET, the stored one unchanged", async () => {
        expect((await verifiedApply()).status).toBe("verified");
        const b = backups()[0];
        const token = await confirmRestore(b.id);
        const id = "11111111-1111-4111-8111-111111111111";
        vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(id);
        // A page closed mid-write left this id (its entry is pending, its lock released by the browser).
        const crashed = other({ id: `tx-${id}`, stage: "in_progress", saved: "unknown", profiles: [2] });
        storeAsAnotherTab(crashed);
        gate.fc.calls = [];
        const reasons = await refusal(restoreAbsoluteTune(b.id, token));
        expect(reasons).toContain("restore:uncertain_state_not_covered:bk-other:in_progress:unknown");
        expect(writes()).toEqual([]);
        expect(storedEntries()).toEqual([crashed]);
    });

    it("the transaction store refuses a pending entry whose id is stored, inside the lock", () => {
        const st = useFcTransactionStore();
        storeAsAnotherTab(other({ id: "tx-same", backupId: "bk-first" }));
        expect(st.recordPending({ ...other({}), id: "tx-same", stage: "in_progress", backupId: "bk-second" })).toBe(
            false,
        );
        expect(storedEntries()).toEqual([expect.objectContaining({ id: "tx-same", backupId: "bk-first" })]);
    });

    it("without navigator.locks no Gyroflight write starts (fail-closed)", async () => {
        expect((await verifiedApply()).status).toBe("verified");
        const b = backups()[0];
        const token = await confirmRestore(b.id);
        const locks = Object.getOwnPropertyDescriptor(navigator, "locks")!;
        Object.defineProperty(navigator, "locks", { value: undefined, configurable: true, writable: true });
        gate.fc.calls = [];
        try {
            expect(await refusal(restoreAbsoluteTune(b.id, token))).toEqual(["fc:write_lock_unavailable"]);
            expect(codes()).toEqual([]);
        } finally {
            Object.defineProperty(navigator, "locks", locks);
        }
    });
});

// ---------------------------------------------------------------------------------------------
describe("an interrupted write stays uncertain across a restart; normal writes still run", () => {
    it("an EEPROM write cut off by a lost link: kept as 'unknown', and after a restart nothing releases or saves over it", async () => {
        gate.fc.disconnectWhen = (_fc, code) => code === MSPCodes.MSP_EEPROM_WRITE;
        const err = await writeFailure(verifiedApply());
        expect(err).toMatchObject({ stage: "eeprom", saved: "unknown" });
        gate.fc.disconnectWhen = undefined;
        gate.fc.disconnected = false;
        setActivePinia(createPinia());
        gate.fc.calls = [];
        const check = await checkTransactionState();
        expect(check.resolved).toBe(false);
        expect(check.reasons).toEqual([`state:${err.backupId}:eeprom_state_unknown_restore_required`]);
        useFlightControllerStore().config.uid = [...gate.fc.uid];
        await expect(usePidTuningMsp().writePidTuningConfig()).rejects.toBeInstanceOf(ApplyBlockedError);
        expect(writes()).toEqual([]);
    });

    it("a page closed mid-write (pending entry, no lock) after a restart: Restore refused, check open, upstream save refused", async () => {
        expect((await verifiedApply()).status).toBe("verified");
        const b = backups()[0];
        storeAsAnotherTab(other({ id: "tx-crash", stage: "in_progress", saved: "unknown", profiles: [0] }));
        setActivePinia(createPinia());
        resetConfirmations();
        gate.fc.calls = [];
        const token = issueConfirmation({ kind: "restore", backupId: b.id, preview: "any" });
        expect(await refusal(restoreAbsoluteTune(b.id, token))).toEqual([
            "restore:uncertain_state_not_covered:bk-other:in_progress:unknown",
        ]);
        expect((await checkTransactionState()).resolved).toBe(false);
        useFlightControllerStore().config.uid = [...gate.fc.uid];
        await expect(usePidTuningMsp().writePidTuningConfig()).rejects.toBeInstanceOf(ApplyBlockedError);
        expect(writes()).toEqual([]);
        expect(storedEntries().map((e) => e.id)).toEqual(["tx-crash"]);
    });

    it("normal writes without any uncertainty: PID-tab save, Restore and (setup-gated) Apply all reach the craft", async () => {
        expect((await verifiedApply()).status).toBe("verified");
        const b = backups()[0];
        expect((await restoreAbsoluteTune(b.id, await confirmRestore(b.id))).status).toBe("verified");
        gate.fc.calls = [];
        useFlightControllerStore().config.uid = [...gate.fc.uid];
        await usePidTuningMsp().writePidTuningConfig();
        expect(writes()).toContain(MSPCodes.MSP_SET_PID);
        expect(storedEntries()).toEqual([]);
    });
});

describe("Codex review of F08 (round 2): the read-only check and storage that turns unreadable", () => {
    it("storage turning unreadable while the check reads the identity: never 'resolved'", async () => {
        const pause = pauseAt(MSPCodes.MSP_API_VERSION);
        const checking = checkTransactionState();
        await pause.at;
        localStorage.setItem(`${TRANSACTION_ENTRY_PREFIX}broken`, "{not json");
        pause.release();
        expect(await checking).toEqual({ resolved: false, reasons: ["state:transaction_storage_unreadable"] });
    });
});
