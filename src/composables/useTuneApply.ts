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
 * Gyroflight Apply / Verify / Restore over Betaflight's own MSP handlers.
 *
 * Apply writes only GyroCore's authorized global (composite) tune, and only after:
 *   1. the composite gate (incl. the M2 phase-margin block), GyroCore Safety and the
 *      product release procedure pass (gyrocore/releaseGate/writeAuthority.ts, the one
 *      write authority of both Apply routes; no flight-controller access before this,
 *      and the same gates run again right before the first SET);
 *   2. the user's single-use confirmation of exactly this change is presented;
 *   3. a fresh read shows the connected FC is the logged craft (UID, board,
 *      firmware), runs Betaflight with simplified tuning, and is disarmed;
 *   4. a fresh MSP_SIMPLIFIED_TUNING read succeeds and the live sliders and PIDs
 *      are still the logged tune;
 *   5. a backup of the craft's tune is stored in this browser and read back.
 * The firmware then calculates what the write will produce (MSP_CALCULATE_*, no
 * state change), Apply writes MSP_SET_SIMPLIFIED_TUNING, reads everything back and
 * compares it with that calculation. MSP_EEPROM_WRITE runs only when every value
 * matches; otherwise nothing is saved and the error says so.
 *
 * Restore writes a stored backup back to the same craft (same UID), after its own
 * confirmation, takes a backup of the current state first, and verifies the result
 * against the backup before saving.
 *
 * A failure after the first SET leaves the craft in a state this route did not verify; it is
 * recorded per craft (gyrocore/stores/fcTransactionState.ts) and every Apply on that craft is
 * refused until a verified Restore or a read-only check (checkTransactionState) shows the state.
 *
 * Every write transaction and the read-only check hold the origin's write lock
 * (fcWriteGuard.withFcWriteLock): one at a time, a second one is refused. A transaction's SETs and
 * MSP_EEPROM_WRITE go out only through its own permit (Transaction.write), which the transport
 * checks right before each of them: its pending entry is still stored as it stored it, and no
 * entry it does not cover has appeared for the craft.
 */

import MSP from "@/js/msp";
import MSPCodes from "@/js/msp/MSPCodes";
import { eepromReplyState, eepromSendErrorState } from "@/js/msp/eepromSave";
import { mspHelper } from "@/js/msp/MSPHelper";
import { bit_check } from "@/js/bit";
import { useFlightControllerStore } from "@/stores/fc";
import { useConnectionStore } from "@/stores/connection";
import { validateTuningSliders } from "@/composables/useTuningSliders";
import { ApplyBlockedError } from "@/gyrocore/chirp/applyGate";
import { liveCompositeBlocks } from "@/gyrocore/tuning/authorize";
import type { CompositeGateState } from "@/gyrocore/tuning/authorize";
import type { ProposedSliders } from "@/composables/useAutotune";
import type { CompositeRecommendation } from "@/gyrocore/tuning/composite";
import { consumeConfirmation } from "@/gyrocore/tuning/applyConfirmation";
import {
    apiAtLeast,
    identityBlocks,
    logIdentity,
    MIN_SIMPLIFIED_TUNING_API,
    type FcIdentity,
} from "@/gyrocore/tuning/fcIdentity";
import {
    AXES,
    DTERM_FILTER_KEYS,
    GYRO_FILTER_KEYS,
    SNAPSHOT_ADVANCED_KEYS,
    SNAPSHOT_FILTER_KEYS,
    SNAPSHOT_SLIDER_KEYS,
    expectedAfterWrite,
    pick,
    pidsDifferFromLog,
    sliderAxes,
    snapshotHash,
    snapshotIssues,
    snapshotMismatches,
    type FirmwareCalculation,
    type TuneSnapshot,
} from "@/gyrocore/tuning/tuneSnapshot";
import {
    newBackupId,
    restoreTargetIssue,
    sameUid,
    useTuneBackupStore,
    type TuneBackup,
} from "@/gyrocore/stores/tuneBackup";
import {
    TRANSACTION_STATE_NOT_STORED,
    TRANSACTION_STATE_UNREADABLE,
    useFcTransactionStore,
    type UncertainTransaction,
} from "@/gyrocore/stores/fcTransactionState";
import {
    MIN_ABSOLUTE_API,
    SLIDER_MODE_KEYS,
    absoluteDiff,
    absoluteHash,
    absoluteMismatches,
    absoluteSnapshotIssues,
    changeSetIssues,
    changedGroups,
    expectedValues,
    liveDiffersFromLog,
    loggedAbsoluteValues,
    minReplyBytes,
    slidersActive,
    slidersOff,
    valuesFromStore,
    valuesToStore,
    type AbsoluteSnapshot,
    type AbsoluteValues,
    type StoreBlocks,
} from "@/gyrocore/tuning/absoluteTune";
import type { AbsoluteProposal } from "@/gyrocore/releaseGate/releaseContract";
import { assertAbsoluteWriteAuthorized, assertSliderWriteAuthorized } from "@/gyrocore/releaseGate/writeAuthority";
import { pinAnalysis, plainCopy } from "@/gyrocore/releaseGate/analysisBinding";
import { WriteRefusedError, withFcWriteLock, type WritePermit } from "@/composables/fcWriteGuard";

/**
 * Where a write transaction stopped. "prepare": before the first SET was sent (a check or a fresh
 * read failed), so the craft holds what it held; "write": a SET was sent and the transaction did
 * not reach verification (its result may be unknown, or a later SET failed: a partial write).
 */
export type WriteStage = "prepare" | "write" | "validate" | "verify" | "eeprom" | "eeprom_verify";

/** The PID profile switch a failed transaction ran into, from the route's own `fc:pid_profile_changed:a->b`. */
export function profileSwitchOf(detail: string): { from: number; to: number | null } | null {
    const m = /fc:pid_profile_changed:(\d+)->(\d+|\?)/.exec(detail);
    return m ? { from: Number(m[1]), to: m[2] === "?" ? null : Number(m[2]) } : null;
}

/**
 * "no": EEPROM was not written, the saved tune is the previous one. "unknown": it may or may not be.
 * "yes_adjusted": saved, but the firmware changed values on reload (validateAndFixConfig).
 */
export type SavedState = "no" | "unknown" | "yes_adjusted";

/** A write was sent and did not end verified and saved. Never shown as success. */
export class TuneWriteError extends Error {
    readonly stage: WriteStage;
    readonly saved: SavedState;
    readonly backupId: string;
    readonly mismatches: string[];
    /** Absolute route: fields that, as last read, differ from the backup (a partial write); null: unread. */
    readonly changedFromBackup: string[] | null;

    constructor(
        stage: WriteStage,
        saved: SavedState,
        backupId: string,
        detail: string,
        mismatches: string[] = [],
        changedFromBackup: string[] | null = null,
    ) {
        super(`Tune write failed at ${stage} (saved: ${saved}): ${detail}`);
        this.name = "TuneWriteError";
        this.stage = stage;
        this.saved = saved;
        this.backupId = backupId;
        this.mismatches = mismatches;
        this.changedFromBackup = changedFromBackup;
    }
}

export interface TuneWriteResult {
    status: "verified";
    backupId: string;
    expected: TuneSnapshot;
    readback: TuneSnapshot;
}

type MspReply = { crcError?: boolean; unsupported?: number | boolean; length?: number } | null | undefined;

/** One MSP read that must answer validly; throws `reason` otherwise (no response, CRC error, refused). */
async function readOk(code: number, reason: string, data?: number[]): Promise<void> {
    const reply = (await MSP.promise(code, data)) as MspReply;
    if (!reply || reply.crcError || reply.unsupported) {
        throw new ApplyBlockedError([reason]);
    }
}

async function readIdentity(): Promise<FcIdentity> {
    const fcStore = useFlightControllerStore();
    for (const code of [
        MSPCodes.MSP_API_VERSION,
        MSPCodes.MSP_FC_VARIANT,
        MSPCodes.MSP_FC_VERSION,
        MSPCodes.MSP_BOARD_INFO,
        MSPCodes.MSP_UID,
        MSPCodes.MSP_STATUS_EX,
    ]) {
        await readOk(code, "fc:identity_readback_missing");
    }
    const c = fcStore.config;
    const uid = Array.isArray(c.uid) && c.uid.length === 3 && c.uid.every(Number.isFinite) ? c.uid : null;
    const count = Number.isInteger(c.numProfiles) && c.numProfiles > 0 ? Number(c.numProfiles) : null;
    const profile =
        Number.isInteger(c.profile) && c.profile >= 0 && (count === null || c.profile < count)
            ? Number(c.profile)
            : null;
    return {
        uid: uid ? ([uid[0], uid[1], uid[2]] as [number, number, number]) : null,
        manufacturerId: String(c.manufacturerId ?? ""),
        boardName: String(c.boardName ?? ""),
        variant: String(c.flightControllerIdentifier ?? ""),
        version: String(c.flightControllerVersion ?? ""),
        apiVersion: String(c.apiVersion ?? ""),
        armed: bit_check(Number(c.mode ?? 0), 0),
        pidProfile: profile,
        pidProfileCount: count,
    };
}

/** The store's copy of what the last MSP_SIMPLIFIED_TUNING / MSP_PID / MSP_PID_ADVANCED reads returned. */
function storeSnapshot(): TuneSnapshot {
    const fcStore = useFlightControllerStore();
    return {
        sliders: pick(fcStore.tuningSliders as unknown as Record<string, unknown>, SNAPSHOT_SLIDER_KEYS),
        filters: pick(fcStore.filterConfig as unknown as Record<string, unknown>, SNAPSHOT_FILTER_KEYS),
        pids: fcStore.pids.map((row) => row.map(Number)),
        advanced: pick(fcStore.advancedTuning as unknown as Record<string, unknown>, SNAPSHOT_ADVANCED_KEYS),
    };
}

function loadStore(s: TuneSnapshot) {
    const fcStore = useFlightControllerStore();
    Object.assign(fcStore.tuningSliders, s.sliders);
    Object.assign(fcStore.filterConfig, s.filters);
    s.pids.forEach((row, i) => {
        if (fcStore.pids[i]) {
            fcStore.pids[i].splice(0, 3, ...row);
        }
    });
    Object.assign(fcStore.advancedTuning, s.advanced);
}

async function readSnapshot(reason: string): Promise<TuneSnapshot> {
    await readOk(MSPCodes.MSP_SIMPLIFIED_TUNING, reason);
    await readOk(MSPCodes.MSP_PID, reason);
    await readOk(MSPCodes.MSP_PID_ADVANCED, reason);
    return storeSnapshot();
}

/** What the firmware says `proposed` produces from `before`; changes nothing on the craft. */
async function firmwareCalculation(
    before: TuneSnapshot,
    proposed: Record<string, number>,
): Promise<FirmwareCalculation> {
    const fcStore = useFlightControllerStore();
    loadStore(before);
    Object.assign(fcStore.tuningSliders, proposed);
    // The proposal and the firmware's answers sit in the shared store only while calculating: a
    // failed calculation must not leave them for the PID tab's Save to write.
    try {
        return await calculateInStore(fcStore);
    } finally {
        loadStore(before);
    }
}

async function calculateInStore(fcStore: ReturnType<typeof useFlightControllerStore>): Promise<FirmwareCalculation> {
    await readOk(
        MSPCodes.MSP_CALCULATE_SIMPLIFIED_PID,
        "fc:calculation_missing",
        mspHelper.crunch(MSPCodes.MSP_CALCULATE_SIMPLIFIED_PID),
    );
    const pids: FirmwareCalculation["pids"] = {};
    for (const [i, axis] of AXES.entries()) {
        if (sliderAxes(fcStore.tuningSliders.slider_pids_mode).includes(axis)) {
            pids[axis] = [Number(fcStore.pids[i][0]), Number(fcStore.pids[i][1]), Number(fcStore.pids[i][2])];
        }
    }
    const advanced = pick(fcStore.advancedTuning as unknown as Record<string, unknown>, SNAPSHOT_ADVANCED_KEYS);
    await readOk(
        MSPCodes.MSP_CALCULATE_SIMPLIFIED_DTERM,
        "fc:calculation_missing",
        mspHelper.crunch(MSPCodes.MSP_CALCULATE_SIMPLIFIED_DTERM),
    );
    const dtermFilters = pick(fcStore.filterConfig as unknown as Record<string, unknown>, DTERM_FILTER_KEYS);
    // MSP_SET_SIMPLIFIED_TUNING also applies the gyro filter sliders: ask for those too.
    await readOk(
        MSPCodes.MSP_CALCULATE_SIMPLIFIED_GYRO,
        "fc:calculation_missing",
        mspHelper.crunch(MSPCodes.MSP_CALCULATE_SIMPLIFIED_GYRO),
    );
    const gyroFilters = pick(fcStore.filterConfig as unknown as Record<string, unknown>, GYRO_FILTER_KEYS);
    return { pids, advanced, dtermFilters, gyroFilters };
}

function storeBackup(
    reason: TuneBackup["reason"],
    fc: FcIdentity,
    snapshot: TuneSnapshot,
    compositeId: string | null,
    absolute?: AbsoluteSnapshot,
    stateKnown = true,
): TuneBackup {
    const backup: TuneBackup = {
        id: newBackupId(),
        createdAt: new Date().toISOString(),
        reason,
        uid: fc.uid!,
        board: `${fc.manufacturerId} ${fc.boardName}`,
        firmware: fc.version,
        compositeId,
        snapshot,
        ...(absolute ? { absolute } : {}),
        stateKnown,
    };
    if (!useTuneBackupStore().save(backup)) {
        throw new ApplyBlockedError(["apply:backup_not_stored"]);
    }
    return backup;
}

/**
 * After the write was sent: read back, compare, save only when everything matches, and read
 * again after the save (the firmware reloads and validates its config there).
 */
async function verifyAndSave(
    expected: TuneSnapshot,
    backupId: string,
    backup: TuneSnapshot,
    tx: Transaction,
): Promise<TuneSnapshot> {
    let readback: TuneSnapshot;
    try {
        readback = await readSnapshot("fc:verify_readback_missing");
    } catch (err) {
        // Unread: the shared store keeps no value of this write (the PID tab's Save would send it).
        loadStore(backup);
        throw new TuneWriteError("verify", "no", backupId, errorText(err));
    }
    const mismatches = snapshotMismatches(expected, readback);
    if (mismatches.length) {
        throw new TuneWriteError("verify", "no", backupId, mismatches.join("; "), mismatches);
    }
    let reply: MspReply;
    try {
        reply = await tx.write(MSPCodes.MSP_EEPROM_WRITE);
    } catch (err) {
        throw new TuneWriteError("eeprom", savedAfterSendError(err), backupId, errorText(err));
    }
    const saved = eepromReplyState(reply);
    if (saved !== "saved") {
        throw new TuneWriteError(
            "eeprom",
            saved,
            backupId,
            saved === "no" ? "eeprom_write_refused" : "eeprom_reply_unreadable",
        );
    }
    let afterSave: TuneSnapshot;
    try {
        afterSave = await readSnapshot("fc:verify_readback_missing");
    } catch (err) {
        throw new TuneWriteError("eeprom_verify", "unknown", backupId, errorText(err));
    }
    const adjusted = snapshotMismatches(expected, afterSave);
    if (adjusted.length) {
        throw new TuneWriteError("eeprom_verify", "yes_adjusted", backupId, adjusted.join("; "), adjusted);
    }
    return afterSave;
}

/**
 * The saved state after MSP_EEPROM_WRITE failed with `err`: "no" when the write check refused it
 * before it was sent, otherwise unknown (the firmware may have saved before the answer was lost).
 */
function savedAfterSendError(err: unknown): "no" | "unknown" {
    return eepromSendErrorState(err) === "not_saved" ? "no" : "unknown";
}

function errorText(err: unknown): string {
    if (err instanceof ApplyBlockedError) {
        return err.reasons.join(", ");
    }
    return typeof err === "object" && err !== null ? String(Reflect.get(err, "message") ?? err) : String(err);
}

/** Refuses while an earlier write on this craft ended in a state nobody verified (fcTransactionState). */
function assertTransactionStateKnown(uid: readonly number[] | null | undefined): void {
    const states = useFcTransactionStore();
    states.sync();
    const blocks = states.blocks(uid);
    if (blocks.length) {
        throw new ApplyBlockedError(blocks);
    }
}

/** One write transaction's record in fcTransactionState: begun right before its first SET. */
interface Transaction {
    /**
     * Store the transaction as pending (read back) right after the backup and before the first SET;
     * throws, so no SET is sent, when the browser does not keep it or its id is taken. A Restore
     * passes the PID profile it restores (`restoring`): its writes may go on only while every other
     * entry of the craft is one it covers.
     */
    begin(
        uid: [number, number, number] | null,
        backupId: string,
        profiles: number[] | null,
        restoring?: number | null,
    ): void;
    /** A SET or MSP_EEPROM_WRITE of this transaction, with its permit (see the file header). */
    write(code: number, data?: MspPayload): Promise<MspReply>;
}

type MspPayload = Parameters<typeof MSP.promise>[1];

/** A new transaction id: a random UUID (no write starts without one). */
function newTransactionId(): string {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (!uuid) throw new ApplyBlockedError(["fc:transaction_id_unavailable"]);
    return `tx-${uuid}`;
}

/**
 * Runs one write transaction, holding the origin's write lock throughout. Once begun, it is pending
 * in fcTransactionState; at the end the entry is removed (verified, or nothing was sent) or replaced
 * by the failure, with the PID profiles it may have changed (a profile switch adds the other one).
 * A verified Restore then resolves the earlier entries it covers (fcTransactionState.resolveByRestore),
 * never more, and never one still in progress.
 */
async function transaction<T extends { backupId: string }>(
    action: UncertainTransaction["action"],
    run: (tx: Transaction) => Promise<T>,
): Promise<T> {
    return withFcWriteLock(() => transactionLocked(action, run));
}

async function transactionLocked<T extends { backupId: string }>(
    action: UncertainTransaction["action"],
    run: (tx: Transaction) => Promise<T>,
): Promise<T> {
    const states = useFcTransactionStore();
    const restoreRoute = action === "restore" ? "slider" : action === "absolute_restore" ? "absolute" : null;
    // A holder, not a variable: begin() assigns it from a closure.
    const rec: {
        begun: {
            pending: UncertainTransaction & { id: string };
            uid: [number, number, number];
            profiles: number[] | null;
            restoring: number | null;
        } | null;
        /** Writes handed to the transport and not refused by the write check (each may have run). */
        sent: number;
    } = { begun: null, sent: 0 };
    const permit: WritePermit = {
        issues() {
            const b = rec.begun;
            if (!b) return ["fc:transaction_not_begun"];
            const issues: string[] = [];
            if (!states.holds(b.pending)) issues.push("fc:transaction_ownership_lost");
            states.sync();
            if (states.unreadable) issues.push(TRANSACTION_STATE_UNREADABLE);
            if (restoreRoute) {
                for (const e of states.notCoveredByRestore(
                    b.uid,
                    { route: restoreRoute, profile: b.restoring },
                    b.pending.id,
                )) {
                    issues.push(`restore:uncertain_state_not_covered:${e.backupId}:${e.stage}:${e.saved}`);
                }
            } else {
                for (const e of states.forUid(b.uid)) {
                    if (e.id !== b.pending.id) {
                        issues.push(`fc:transaction_state_uncertain:${e.backupId}:${e.stage}:${e.saved}`);
                    }
                }
            }
            return issues;
        },
    };
    const tx: Transaction = {
        begin(uid, backupId, profiles, restoring = null) {
            if (!uid) throw new ApplyBlockedError(["fc:identity_uid_missing"]);
            const pending = {
                id: newTransactionId(),
                uid,
                action,
                stage: "in_progress",
                saved: "unknown",
                backupId,
                profiles,
                detail: "",
                at: new Date().toISOString(),
            };
            if (!states.recordPending(pending)) throw new ApplyBlockedError([TRANSACTION_STATE_NOT_STORED]);
            rec.begun = { pending, uid, profiles, restoring };
        },
        async write(code, data) {
            // Counted before it goes out: a write whose answer is lost may still have run.
            rec.sent++;
            try {
                return (await MSP.promise(code, data, { permit })) as MspReply;
            } catch (err) {
                if (err instanceof WriteRefusedError) rec.sent--;
                throw err;
            }
        },
    };
    try {
        const result = await run(tx);
        const b = rec.begun;
        if (b) {
            states.settle(b.pending.id, null, b.pending);
            // Written, read back, saved and read again: what this Restore covers is known again.
            if (restoreRoute && b.profiles?.length === 1) {
                states.resolveByRestore(b.uid, { route: restoreRoute, profile: b.profiles[0] });
            }
        }
        return result;
    } catch (err) {
        const b = rec.begun;
        if (b) {
            if (rec.sent === 0) {
                // Nothing reached the craft: it holds what was backed up.
                states.settle(b.pending.id, null, b.pending);
            } else if (err instanceof TuneWriteError) {
                const sw = profileSwitchOf(err.message);
                const profiles =
                    b.profiles && sw ? (sw.to === null ? null : [...new Set([...b.profiles, sw.to])]) : b.profiles;
                states.settle(b.pending.id, {
                    uid: b.uid,
                    action,
                    stage: err.stage === "prepare" ? "write" : err.stage,
                    saved: err.saved,
                    backupId: err.backupId,
                    profiles,
                    detail: err.message,
                    at: new Date().toISOString(),
                });
            } else {
                // Interrupted after a write went out, by something that is not a write failure.
                states.settle(b.pending.id, {
                    uid: b.uid,
                    action,
                    stage: "write",
                    saved: "unknown",
                    backupId: b.pending.backupId,
                    profiles: b.profiles,
                    detail: errorText(err),
                    at: new Date().toISOString(),
                });
            }
        }
        throw err;
    }
}

/**
 * The PID profiles a slider-route write may change: unknown. That route reads the profile once and
 * does not check it again while it writes (the absolute route does, assertPidProfile), so a switch
 * during its reads can move the SET into another profile. Its uncertain entries are therefore
 * covered by no Restore; saved "no" ones by the read-only check after a power cycle.
 */
const SLIDER_PROFILES_UNKNOWN = null;

/**
 * A Restore that starts while the craft has open uncertain entries recovers from a write nobody
 * verified: what it backs up first is that unverified state, kept so the recovery can be inspected
 * but never written back (the Restore routes refuse it).
 */
function recovering(fc: FcIdentity): boolean {
    const states = useFcTransactionStore();
    states.sync();
    return states.unreadable || states.forUid(fc.uid).length > 0;
}

/**
 * Before a Restore: the transaction state must be readable, and every open entry of this craft must
 * be one this Restore covers (fcTransactionState.notCoveredByRestore). Otherwise its EEPROM save
 * would persist what the other entries left in RAM (another PID profile, the filter block).
 */
function restoreStateBlocks(fc: FcIdentity, route: "absolute" | "slider"): string[] {
    const states = useFcTransactionStore();
    states.sync();
    if (states.unreadable) return [TRANSACTION_STATE_UNREADABLE];
    if (!fc.uid) return [];
    return states
        .notCoveredByRestore(fc.uid, { route, profile: fc.pidProfile })
        .map((e) => `restore:uncertain_state_not_covered:${e.backupId}:${e.stage}:${e.saved}`);
}

const uid3 = (u: readonly number[] | null | undefined): [number, number, number] | null =>
    Array.isArray(u) && u.length === 3 ? [u[0], u[1], u[2]] : null;

function assertConnectedReal() {
    if (useConnectionStore().virtualMode) {
        throw new ApplyBlockedError(["fc:virtual_mode"]);
    }
}

function logHeaders(state: CompositeGateState, composite: CompositeRecommendation) {
    const log = state.report?.logs.find((l) => l.logIndex === composite.logIndex);
    return log?.headerPairs ?? [];
}

interface LiveTune {
    fc: FcIdentity;
    before: TuneSnapshot;
    expected: TuneSnapshot;
}

/**
 * Read-only: the connected craft is the logged one, on the logged firmware, disarmed, still
 * holding the logged tune; then what the firmware calculates for `proposed`. No write.
 */
async function readLiveTune(
    composite: CompositeRecommendation,
    headers: readonly (readonly [string, string])[],
    proposed: Record<string, number>,
): Promise<LiveTune> {
    const fc = await readIdentity();
    const idBlocks = identityBlocks(logIdentity(headers), fc);
    if (idBlocks.length) {
        throw new ApplyBlockedError(idBlocks);
    }
    // Live slider state, read fresh (MSPHelper fills fcStore.tuningSliders). No response,
    // a refused reply or a CRC error leaves older values: never compare to those.
    const fcStore = useFlightControllerStore();
    const readback = (await MSP.promise(MSPCodes.MSP_SIMPLIFIED_TUNING)) as MspReply;
    if (!readback || readback.crcError || readback.unsupported) {
        throw new ApplyBlockedError(["fc:live_readback_missing"]);
    }
    const live = liveCompositeBlocks(fcStore.tuningSliders, composite);
    if (live.length) {
        throw new ApplyBlockedError(live);
    }
    await readOk(MSPCodes.MSP_PID, "fc:live_readback_missing");
    await readOk(MSPCodes.MSP_PID_ADVANCED, "fc:live_readback_missing");
    const before = storeSnapshot();
    const pidBlocks = pidsDifferFromLog(headers, before.pids);
    if (pidBlocks.length) {
        throw new ApplyBlockedError(pidBlocks);
    }
    const calc = await firmwareCalculation(before, proposed);
    return { fc, before, expected: expectedAfterWrite(before, proposed, calc) };
}

export interface TunePreview {
    before: TuneSnapshot;
    expected: TuneSnapshot;
    /** snapshotHash(expected): pass it in the confirmation so Apply refuses if anything changed. */
    hash: string;
}

/**
 * Read-only preview of an Apply: identity, live tune, and the values the flight controller
 * itself calculates for the composite. Writes nothing to the craft, and it is what the user
 * confirms. The firmware calculation runs through the shared FC store (MSPHelper decodes its
 * replies there), where the PID tab's Save could pick the proposal up: so the preview needs the
 * same write authority as the Apply, and an unauthorized proposal never enters that store.
 */
export async function previewTune(
    proposed: ProposedSliders,
    compositeId: string | null | undefined,
): Promise<TunePreview> {
    const { gateState, composite } = assertSliderWriteAuthorized(proposed, compositeId);
    assertConnectedReal();
    const live = await readLiveTune(composite, logHeaders(gateState, composite), { ...proposed });
    return { before: live.before, expected: live.expected, hash: snapshotHash(live.expected) };
}

/**
 * Apply GyroCore's global tune. `confirmation` is the token the interface issued after the
 * user confirmed exactly this composite, these sliders and the preview it showed.
 */
export async function applyTune(
    proposed: ProposedSliders,
    compositeId: string | null | undefined,
    confirmation: string | null | undefined,
): Promise<TuneWriteResult> {
    return transaction("apply", (tx) => applyTuneOnce(tx, proposed, compositeId, confirmation));
}

async function applyTuneOnce(
    tx: Transaction,
    proposed: ProposedSliders,
    compositeId: string | null | undefined,
    confirmation: string | null | undefined,
): Promise<TuneWriteResult> {
    // 1. Every gate that needs no flight controller, in this order, before any MSP.
    const { gateState, composite } = assertSliderWriteAuthorized(proposed, compositeId);
    const confirmed = consumeConfirmation(confirmation, {
        kind: "apply",
        compositeId: composite.id,
        sliders: { ...proposed },
    });
    assertTransactionStateKnown(logIdentity(logHeaders(gateState, composite)).uid);
    assertConnectedReal();

    // 2-4. Identity, live tune, logged PIDs, and the firmware's calculation (read-only).
    const { fc, before, expected } = await readLiveTune(composite, logHeaders(gateState, composite), {
        ...proposed,
    });
    assertTransactionStateKnown(fc.uid);
    // What the user confirmed must still be what the firmware would produce.
    if (confirmed.preview !== snapshotHash(expected)) {
        throw new ApplyBlockedError(["apply:preview_changed"]);
    }

    // The reads above awaited: the gates again on the state as it is now. Nothing awaits from here to the SET.
    assertSliderWriteAuthorized(proposed, compositeId);

    // 5. Backup, then the write itself.
    const backup = storeBackup("before_apply", fc, before, composite.id);
    tx.begin(uid3(fc.uid), backup.id, SLIDER_PROFILES_UNKNOWN);
    const fcStore = useFlightControllerStore();
    loadStore(before);
    // Object.keys widens to string[]; the keys are the proposal's own slider fields.
    for (const key of Object.keys(proposed) as (keyof ProposedSliders)[]) {
        if (key in fcStore.tuningSliders) {
            fcStore.tuningSliders[key] = proposed[key];
        }
    }
    try {
        await tx.write(MSPCodes.MSP_SET_SIMPLIFIED_TUNING, mspHelper.crunch(MSPCodes.MSP_SET_SIMPLIFIED_TUNING));
    } catch (err) {
        throw new TuneWriteError("write", "no", backup.id, errorText(err));
    }
    // After the SET: a failure here is a failed write with its stage, never a generic error.
    try {
        await validateTuningSliders();
    } catch (err) {
        throw new TuneWriteError("validate", "no", backup.id, errorText(err));
    }
    if (!fcStore.tuningSliders.slider_pids_valid || !fcStore.tuningSliders.slider_dterm_valid) {
        throw new TuneWriteError("validate", "no", backup.id, "the firmware did not validate the written sliders");
    }

    // 6. Read back, compare with the firmware's own calculation, save only on a full match.
    const after = await verifyAndSave(expected, backup.id, before, tx);
    return { status: "verified", backupId: backup.id, expected, readback: after };
}

export interface RestorePreview {
    backup: TuneBackup;
    fc: FcIdentity;
    current: TuneSnapshot;
    /**
     * The craft's current tune and the backup's target: pass it in the confirmation so Restore
     * refuses if either changed (restoreHash).
     */
    hash: string;
}

/** What a Restore confirmation binds: what the craft holds now and what the backup puts back. */
function restoreHash(current: string, target: string): string {
    return `${current}:${target}`;
}

/** Read-only checks before a Restore: a sound backup of this craft, same firmware, disarmed. */
async function readRestoreTarget(backupId: string): Promise<RestorePreview> {
    const backup = useTuneBackupStore().get(backupId);
    if (!backup) {
        throw new ApplyBlockedError(["restore:backup_not_found"]);
    }
    if (backup.absolute) {
        // Taken by the absolute route: only restoreAbsoluteTune puts back the filter block too.
        throw new ApplyBlockedError(["restore:use_absolute_restore"]);
    }
    if (snapshotIssues(backup.snapshot).length) {
        throw new ApplyBlockedError(["restore:backup_invalid"]);
    }
    const targetIssue = restoreTargetIssue(backup);
    if (targetIssue) {
        throw new ApplyBlockedError([targetIssue]);
    }
    assertConnectedReal();
    const fc = await readIdentity();
    const blocked: string[] = [];
    if (!sameUid(fc.uid, backup.uid)) {
        blocked.push("restore:different_craft");
    }
    if (fc.variant !== "BTFL") {
        blocked.push("fc:identity_not_betaflight");
    }
    if (!fc.apiVersion || !apiAtLeast(fc.apiVersion, MIN_SIMPLIFIED_TUNING_API)) {
        blocked.push("fc:api_version_unsupported");
    }
    if (fc.version !== backup.firmware) {
        blocked.push("restore:firmware_changed");
    }
    if (fc.armed) {
        blocked.push("fc:armed");
    }
    blocked.push(...restoreStateBlocks(fc, "slider"));
    if (blocked.length) {
        throw new ApplyBlockedError(blocked);
    }
    const current = await readSnapshot("fc:live_readback_missing");
    return { backup, fc, current, hash: restoreHash(snapshotHash(current), snapshotHash(backup.snapshot)) };
}

/** Read-only preview of a Restore: what is on the craft now, against the backup. */
export async function previewRestore(backupId: string): Promise<RestorePreview> {
    return readRestoreTarget(backupId);
}

/** Write a stored backup back to the craft it was taken from, then verify and save. */
export async function restoreTune(backupId: string, confirmation: string | null | undefined): Promise<TuneWriteResult> {
    return transaction("restore", (tx) => restoreTuneOnce(tx, backupId, confirmation));
}

async function restoreTuneOnce(
    tx: Transaction,
    backupId: string,
    confirmation: string | null | undefined,
): Promise<TuneWriteResult> {
    const confirmed = consumeConfirmation(confirmation, { kind: "restore", backupId });
    const { backup, fc, current } = await readRestoreTarget(backupId);
    const target = backup.snapshot;
    if (confirmed.preview !== restoreHash(snapshotHash(current), snapshotHash(target))) {
        throw new ApplyBlockedError(["restore:preview_changed"]);
    }
    const safety = storeBackup("before_restore", fc, current, null, undefined, !recovering(fc));
    tx.begin(uid3(fc.uid), safety.id, SLIDER_PROFILES_UNKNOWN, fc.pidProfile);

    const fcStore = useFlightControllerStore();
    loadStore({ ...current, sliders: target.sliders, filters: target.filters });
    try {
        await tx.write(MSPCodes.MSP_SET_SIMPLIFIED_TUNING, mspHelper.crunch(MSPCodes.MSP_SET_SIMPLIFIED_TUNING));
    } catch (err) {
        throw new TuneWriteError("write", "no", safety.id, errorText(err));
    }

    // Sliders alone reproduce slider-derived PIDs only; put back anything else exactly.
    let readback: TuneSnapshot;
    try {
        readback = await readSnapshot("fc:verify_readback_missing");
        const pidsOff = target.pids.some((row, i) => row.some((v, j) => v !== readback.pids[i]?.[j]));
        if (pidsOff) {
            loadStore({ ...readback, pids: target.pids });
            await tx.write(MSPCodes.MSP_SET_PID, mspHelper.crunch(MSPCodes.MSP_SET_PID));
        }
        const advancedOff = SNAPSHOT_ADVANCED_KEYS.some((k) => readback.advanced[k] !== target.advanced[k]);
        if (advancedOff) {
            // MSP_SET_PID_ADVANCED writes the whole block: start from a fresh read of it.
            await readOk(MSPCodes.MSP_PID_ADVANCED, "fc:verify_readback_missing");
            Object.assign(fcStore.advancedTuning, target.advanced);
            await tx.write(MSPCodes.MSP_SET_PID_ADVANCED, mspHelper.crunch(MSPCodes.MSP_SET_PID_ADVANCED));
        }
    } catch (err) {
        throw new TuneWriteError("write", "no", safety.id, errorText(err));
    }
    const after = await verifyAndSave(target, safety.id, current, tx);
    return { status: "verified", backupId: safety.id, expected: target, readback: after };
}

// ---------------------------------------------------------------------------
// v2: absolute PID / feedforward / filter values (MSP_PID, MSP_PID_ADVANCED, MSP_FILTER_CONFIG)
// ---------------------------------------------------------------------------

function storeBlocks(): StoreBlocks {
    const fcStore = useFlightControllerStore();
    return {
        pids: fcStore.pids,
        advancedTuning: fcStore.advancedTuning as unknown as Record<string, unknown>,
        filterConfig: fcStore.filterConfig as unknown as Record<string, unknown>,
    };
}

const ABSOLUTE_READ_BLOCK: Record<number, Parameters<typeof minReplyBytes>[0]> = {
    [MSPCodes.MSP_PID]: "pid",
    [MSPCodes.MSP_PID_ADVANCED]: "advanced",
    [MSPCodes.MSP_FILTER_CONFIG]: "filter",
    [MSPCodes.MSP_SIMPLIFIED_TUNING]: "simplified",
};

/**
 * One read of a tuning block that must answer validly and completely: a CRC-valid reply shorter
 * than the firmware's layout for this API leaves null, 0 or stale values in the store.
 */
async function readFull(code: number, reason: string, apiVersion: string): Promise<void> {
    const reply = (await MSP.promise(code)) as MspReply;
    if (!reply || reply.crcError || reply.unsupported) {
        throw new ApplyBlockedError([reason]);
    }
    const min = minReplyBytes(ABSOLUTE_READ_BLOCK[code], apiVersion);
    if (!(typeof reply.length === "number" && reply.length >= min)) {
        throw new ApplyBlockedError([reason, `fc:reply_too_short:${code}:${reply.length ?? "?"}<${min}`]);
    }
}

/**
 * MSP_STATUS_EX again: the active PID profile is still `profile` (MSP_PID, _PID_ADVANCED and the
 * D-term part of MSP_FILTER_CONFIG act on whichever profile is active) and, before a write, the
 * craft is still disarmed. Anything else stops the transaction.
 */
async function assertPidProfile(profile: number, { disarmed }: { disarmed: boolean }): Promise<void> {
    await readOk(MSPCodes.MSP_STATUS_EX, "fc:status_missing");
    const c = useFlightControllerStore().config;
    const blocked: string[] = [];
    if (c.profile !== profile) blocked.push(`fc:pid_profile_changed:${profile}->${c.profile ?? "?"}`);
    if (disarmed && bit_check(Number(c.mode ?? 0), 0)) blocked.push("fc:armed");
    if (blocked.length) {
        throw new ApplyBlockedError(blocked);
    }
}

/**
 * Fresh reads of the four blocks of PID profile `profile`; any missing, refused, short or corrupt
 * reply, or a profile switch while reading, blocks with `reason`.
 */
async function readAbsoluteSnapshot(reason: string, apiVersion: string, profile: number): Promise<AbsoluteSnapshot> {
    await readFull(MSPCodes.MSP_SIMPLIFIED_TUNING, reason, apiVersion);
    await readFull(MSPCodes.MSP_PID, reason, apiVersion);
    await readFull(MSPCodes.MSP_PID_ADVANCED, reason, apiVersion);
    await readFull(MSPCodes.MSP_FILTER_CONFIG, reason, apiVersion);
    await assertPidProfile(profile, { disarmed: false });
    const fcStore = useFlightControllerStore();
    const snapshot: AbsoluteSnapshot = {
        apiVersion,
        pidProfile: profile,
        sliders: pick(fcStore.tuningSliders as unknown as Record<string, unknown>, SNAPSHOT_SLIDER_KEYS),
        values: valuesFromStore(storeBlocks(), apiVersion),
    };
    const issues = absoluteSnapshotIssues(snapshot);
    if (issues.length) {
        throw new ApplyBlockedError([reason, ...issues.map((i) => `fc:snapshot_incomplete:${i}`)]);
    }
    return snapshot;
}

/** One write of `tx`; the firmware's error reply (MSP_RESULT_ERROR) counts as a failed write. */
async function writeOk(code: number, tx: Transaction): Promise<void> {
    const reply = await tx.write(code, mspHelper.crunch(code));
    if (!reply || reply.crcError || reply.unsupported) {
        throw new Error(`write_refused:${code}`);
    }
}

function changedFrom(backup: AbsoluteSnapshot, now: AbsoluteSnapshot): string[] {
    return absoluteDiff(backup, now).map((r) => `${r.group}:${r.key} ${r.from}→${r.to}`);
}

/**
 * After a failed write: what is on the craft now, against the backup. null when unreadable, or
 * when another PID profile is active (the written one cannot be read without switching back).
 */
async function partialWriteState(backup: AbsoluteSnapshot): Promise<string[] | null> {
    try {
        return changedFrom(
            backup,
            await readAbsoluteSnapshot("fc:verify_readback_missing", backup.apiVersion, backup.pidProfile!),
        );
    } catch {
        return null;
    }
}

/** fcStore.config.configStateFlag bit 0 (MSP_STATUS_EX): the firmware asks for a reboot. */
async function rebootRequired(): Promise<boolean | null> {
    try {
        await readOk(MSPCodes.MSP_STATUS_EX, "fc:status_missing");
    } catch {
        return null;
    }
    return (Number(useFlightControllerStore().config.configStateFlag ?? 0) & 1) === 1;
}

export interface AbsoluteWriteResult {
    status: "verified";
    backupId: string;
    expected: AbsoluteSnapshot;
    readback: AbsoluteSnapshot;
    /** Read after MSP_EEPROM_WRITE (the firmware reloads and validates its config there). */
    afterSave: AbsoluteSnapshot;
    /** null: MSP_STATUS_EX could not be read after the save. */
    rebootRequired: boolean | null;
}

/**
 * Write `target` exactly: slider modes (first, so they cannot recompute what follows), then
 * every block whose values differ, each from a fresh read with only the target's values put in.
 */
async function writeAbsoluteBlocks(
    current: AbsoluteSnapshot,
    target: AbsoluteSnapshot,
    backup: AbsoluteSnapshot,
    backupId: string,
    tx: Transaction,
    all = false,
    beforeFirstSet?: () => void,
): Promise<void> {
    const fcStore = useFlightControllerStore();
    const api = target.apiVersion;
    const profile = current.pidProfile!;
    const groups = all ? new Set(["pid", "advanced", "filter"]) : changedGroups(current.values, target.values);
    const slidersChange = SLIDER_MODE_KEYS.some((k) => current.sliders[k] !== target.sliders[k]);
    // SETs sent so far: none means the craft still holds exactly what was backed up (a failed
    // check or fresh read before the first SET is "prepare", not a write with an unknown result).
    let sent = 0;
    // The store holds target values that no fresh read replaced: on a failure they go back out, so
    // the PID tab's Save can never write a value this route did not get onto the craft verified.
    let storeHoldsTarget = false;
    const send = async (code: number, fill: () => void) => {
        // The last check before the store and the craft change; nothing awaits between it, the
        // store update and the SET.
        if (sent === 0) beforeFirstSet?.();
        storeHoldsTarget = true;
        fill();
        sent++;
        try {
            await writeOk(code, tx);
        } catch (err) {
            // Refused by the write check: it never reached the craft.
            if (err instanceof WriteRefusedError) sent--;
            throw err;
        }
    };
    try {
        if (slidersChange || all) {
            await assertPidProfile(profile, { disarmed: true });
            // MSP_SET_SIMPLIFIED_TUNING also stores the LPF values it carries: send the live ones.
            await readFull(MSPCodes.MSP_SIMPLIFIED_TUNING, "fc:live_readback_missing", api);
            await readFull(MSPCodes.MSP_FILTER_CONFIG, "fc:live_readback_missing", api);
            await send(MSPCodes.MSP_SET_SIMPLIFIED_TUNING, () => {
                Object.assign(fcStore.tuningSliders, all ? target.sliders : pick(target.sliders, SLIDER_MODE_KEYS));
                if (all) {
                    valuesToStore(target.values, storeBlocks(), api);
                }
            });
        }
        const blocks: [string, number, number][] = [
            ["pid", MSPCodes.MSP_PID, MSPCodes.MSP_SET_PID],
            ["advanced", MSPCodes.MSP_PID_ADVANCED, MSPCodes.MSP_SET_PID_ADVANCED],
            ["filter", MSPCodes.MSP_FILTER_CONFIG, MSPCodes.MSP_SET_FILTER_CONFIG],
        ];
        for (const [group, read, write] of blocks) {
            if (!groups.has(group as never)) {
                continue;
            }
            // Each SET encodes the whole block: start from a complete fresh read of it, in the same profile.
            await assertPidProfile(profile, { disarmed: true });
            await readFull(read, "fc:live_readback_missing", api);
            await send(write, () => valuesToStore(target.values, storeBlocks(), api));
        }
    } catch (err) {
        if (sent === 0) {
            if (storeHoldsTarget) putBackInStore(current);
            throw new TuneWriteError("prepare", "no", backupId, errorText(err), [], []);
        }
        const changed = await partialWriteState(backup);
        // Unread craft: the store keeps no target value (partialWriteState left a fresh read otherwise).
        if (changed === null) putBackInStore(backup);
        throw new TuneWriteError("write", "no", backupId, errorText(err), [], changed);
    }
}

/** The values of `snapshot` into the shared FC store (the store only; nothing is sent). */
function putBackInStore(snapshot: AbsoluteSnapshot): void {
    Object.assign(useFlightControllerStore().tuningSliders, snapshot.sliders);
    valuesToStore(snapshot.values, storeBlocks(), snapshot.apiVersion);
}

/** Read back, compare everything, save, read again after the firmware reloaded its config. */
async function verifyAbsoluteAndSave(
    expected: AbsoluteSnapshot,
    backup: AbsoluteSnapshot,
    backupId: string,
    tx: Transaction,
): Promise<Omit<AbsoluteWriteResult, "status" | "backupId" | "expected">> {
    const profile = expected.pidProfile!;
    let readback: AbsoluteSnapshot;
    try {
        readback = await readAbsoluteSnapshot("fc:verify_readback_missing", expected.apiVersion, profile);
    } catch (err) {
        // Unread: the shared store keeps no value of this write (the PID tab's Save would send it).
        putBackInStore(backup);
        throw new TuneWriteError("verify", "no", backupId, errorText(err), [], null);
    }
    const mismatches = absoluteMismatches(expected, readback);
    if (mismatches.length) {
        throw new TuneWriteError(
            "verify",
            "no",
            backupId,
            mismatches.join("; "),
            mismatches,
            changedFrom(backup, readback),
        );
    }
    try {
        // MSP_EEPROM_WRITE saves every profile: only while the verified one is still active.
        await assertPidProfile(profile, { disarmed: true });
    } catch (err) {
        throw new TuneWriteError("verify", "no", backupId, errorText(err), [], null);
    }
    let reply: MspReply;
    try {
        reply = await tx.write(MSPCodes.MSP_EEPROM_WRITE);
    } catch (err) {
        throw new TuneWriteError("eeprom", savedAfterSendError(err), backupId, errorText(err));
    }
    const saved = eepromReplyState(reply);
    if (saved !== "saved") {
        // "no" only on the firmware's refusal (armed); a lost or corrupt answer leaves it unknown.
        throw new TuneWriteError(
            "eeprom",
            saved,
            backupId,
            saved === "no" ? "eeprom_write_refused" : "eeprom_reply_unreadable",
        );
    }
    let afterSave: AbsoluteSnapshot;
    try {
        afterSave = await readAbsoluteSnapshot("fc:verify_readback_missing", expected.apiVersion, profile);
    } catch (err) {
        throw new TuneWriteError("eeprom_verify", "unknown", backupId, errorText(err));
    }
    const adjusted = absoluteMismatches(expected, afterSave);
    if (adjusted.length) {
        throw new TuneWriteError(
            "eeprom_verify",
            "yes_adjusted",
            backupId,
            adjusted.join("; "),
            adjusted,
            changedFrom(backup, afterSave),
        );
    }
    return { readback, afterSave, rebootRequired: await rebootRequired() };
}

interface LiveAbsolute {
    fc: FcIdentity;
    before: AbsoluteSnapshot;
    expected: AbsoluteSnapshot;
}

/**
 * Read-only: the logged craft, logged firmware, disarmed, MSP API with the absolute layout,
 * the active PID profile still holding every logged value; then what the write must produce.
 */
async function readLiveAbsolute(proposal: AbsoluteProposal): Promise<LiveAbsolute> {
    const fc = await readIdentity();
    const blocked = identityBlocks(logIdentity(proposal.log.headerPairs), fc);
    if (!fc.apiVersion || !apiAtLeast(fc.apiVersion, MIN_ABSOLUTE_API)) {
        blocked.push("absolute:api_version_unsupported");
    }
    if (fc.pidProfile === null) {
        blocked.push("fc:pid_profile_unknown");
    }
    if (blocked.length) {
        throw new ApplyBlockedError([...new Set(blocked)]);
    }
    const before = await readAbsoluteSnapshot("fc:live_readback_missing", fc.apiVersion, fc.pidProfile!);
    const live = liveDiffersFromLog(loggedAbsoluteValues(proposal.log.headerPairs), before.values);
    const issues = changeSetIssues(proposal.change, before.values, fc.apiVersion);
    if (live.length || issues.length) {
        throw new ApplyBlockedError([...live, ...issues]);
    }
    const expected: AbsoluteSnapshot = {
        apiVersion: fc.apiVersion,
        // In the hash too: a profile switch after the preview refuses the Apply.
        pidProfile: before.pidProfile,
        sliders: slidersActive(before.sliders) ? slidersOff(before.sliders) : { ...before.sliders },
        values: expectedValues(before.values, proposal.change),
    };
    return { fc, before, expected };
}

export interface AbsolutePreview {
    before: AbsoluteSnapshot;
    expected: AbsoluteSnapshot;
    /** Every value that changes, slider modes included. */
    changes: ReturnType<typeof absoluteDiff>;
    /** absoluteHash(expected): pass it in the confirmation so Apply refuses if anything changed. */
    hash: string;
}

/** Read-only preview of an absolute Apply. Writes nothing and needs no release. */
export async function previewAbsoluteTune(proposal: AbsoluteProposal): Promise<AbsolutePreview> {
    // A proposal without its log or change cannot be compared with the craft: refused, not crashed through.
    const p = proposal as Partial<AbsoluteProposal> | null | undefined;
    if (!Array.isArray(p?.log?.headerPairs) || !p.change || typeof p.change !== "object") {
        throw new ApplyBlockedError(["preview:proposal_malformed"]);
    }
    assertConnectedReal();
    const live = await readLiveAbsolute(proposal);
    return {
        before: live.before,
        expected: live.expected,
        changes: absoluteDiff(live.before, live.expected),
        hash: absoluteHash(live.expected),
    };
}

/**
 * Apply an absolute proposal. `confirmation` is the token the interface issued after the user
 * confirmed exactly this proposal, these values and the preview it showed.
 */
export async function applyAbsoluteTune(
    proposal: AbsoluteProposal,
    confirmation: string | null | undefined,
): Promise<AbsoluteWriteResult> {
    return transaction("absolute_apply", (tx) => applyAbsoluteTuneOnce(tx, proposal, confirmation));
}

async function applyAbsoluteTuneOnce(
    tx: Transaction,
    proposal: AbsoluteProposal,
    confirmation: string | null | undefined,
): Promise<AbsoluteWriteResult> {
    // What is authorized, confirmed and written is this copy: plain data the caller can no longer
    // change while the Apply awaits (a getter, a function or a class instance is refused).
    let authorized: AbsoluteProposal;
    try {
        authorized = plainCopy(proposal);
    } catch {
        throw new ApplyBlockedError(["apply:proposal_not_plain_data"]);
    }
    // 1. The write authority (the engine recomputed for this proposal, release contract, GyroCore
    // Safety, product lock) and the user's confirmation, before any MSP.
    const since = pinAnalysis();
    assertAbsoluteWriteAuthorized(authorized, { recompute: true });
    const confirmed = consumeConfirmation(confirmation, {
        kind: "absolute",
        proposalId: authorized.id,
        change: { ...authorized.change },
    });
    assertTransactionStateKnown(logIdentity(authorized.log.headerPairs).uid);
    assertConnectedReal();

    // 2. Identity, live values against the log, and the expected result (read-only).
    const { fc, before, expected } = await readLiveAbsolute(authorized);
    assertTransactionStateKnown(fc.uid);
    if (confirmed.preview !== absoluteHash(expected)) {
        throw new ApplyBlockedError(["apply:preview_changed"]);
    }

    // 3. The authority again against the same analysis (the reads above awaited), backup (every
    // firmware-held value), the write with the authority once more right before its first SET,
    // then verify and save.
    const recheck = () => assertAbsoluteWriteAuthorized(authorized, { recompute: false, since });
    recheck();
    const backup = storeBackup("before_absolute_apply", fc, v1Snapshot(), null, before);
    tx.begin(uid3(fc.uid), backup.id, [before.pidProfile!]);
    await writeAbsoluteBlocks(before, expected, before, backup.id, tx, false, recheck);
    const verified = await verifyAbsoluteAndSave(expected, before, backup.id, tx);
    return { status: "verified", backupId: backup.id, expected, ...verified };
}

/** The v1 snapshot from the store as just read (kept in every backup for the v1 Restore). */
function v1Snapshot(): TuneSnapshot {
    return storeSnapshot();
}

export interface AbsoluteRestorePreview {
    backup: TuneBackup;
    current: AbsoluteSnapshot;
    changes: ReturnType<typeof absoluteDiff>;
    hash: string;
}

async function readAbsoluteRestoreTarget(backupId: string): Promise<{
    backup: TuneBackup & { absolute: AbsoluteSnapshot };
    fc: FcIdentity;
    current: AbsoluteSnapshot;
}> {
    const backup = useTuneBackupStore().get(backupId);
    if (!backup?.absolute) {
        throw new ApplyBlockedError(["restore:backup_not_found"]);
    }
    if (!Number.isInteger(backup.absolute.pidProfile)) {
        // Taken before backups named their profile: which profile it belongs to is unknown.
        throw new ApplyBlockedError(["restore:backup_without_pid_profile"]);
    }
    if (absoluteSnapshotIssues(backup.absolute).length) {
        throw new ApplyBlockedError(["restore:backup_invalid"]);
    }
    const targetIssue = restoreTargetIssue(backup);
    if (targetIssue) {
        throw new ApplyBlockedError([targetIssue]);
    }
    assertConnectedReal();
    const fc = await readIdentity();
    const blocked: string[] = [];
    if (!sameUid(fc.uid, backup.uid)) blocked.push("restore:different_craft");
    if (fc.variant !== "BTFL") blocked.push("fc:identity_not_betaflight");
    if (fc.version !== backup.firmware) blocked.push("restore:firmware_changed");
    if (fc.apiVersion !== backup.absolute.apiVersion) blocked.push("restore:api_version_changed");
    if (fc.armed) blocked.push("fc:armed");
    // The profile-bound values go back into the profile they were read from, never another one.
    if (fc.pidProfile === null) blocked.push("fc:pid_profile_unknown");
    else if (fc.pidProfile !== backup.absolute.pidProfile) {
        blocked.push(`restore:pid_profile_changed:${backup.absolute.pidProfile}->${fc.pidProfile}`);
    }
    blocked.push(...restoreStateBlocks(fc, "absolute"));
    if (blocked.length) {
        throw new ApplyBlockedError(blocked);
    }
    const current = await readAbsoluteSnapshot("fc:live_readback_missing", fc.apiVersion, fc.pidProfile!);
    return { backup: backup as TuneBackup & { absolute: AbsoluteSnapshot }, fc, current };
}

/** Read-only preview of restoring an absolute backup: every value that would change back. */
export async function previewAbsoluteRestore(backupId: string): Promise<AbsoluteRestorePreview> {
    const { backup, current } = await readAbsoluteRestoreTarget(backupId);
    return {
        backup,
        current,
        changes: absoluteDiff(current, backup.absolute),
        hash: restoreHash(absoluteHash(current), absoluteHash(backup.absolute)),
    };
}

/** Write an absolute backup back exactly (slider modes first, then all three blocks), verify, save. */
export async function restoreAbsoluteTune(
    backupId: string,
    confirmation: string | null | undefined,
): Promise<AbsoluteWriteResult> {
    return transaction("absolute_restore", (tx) => restoreAbsoluteTuneOnce(tx, backupId, confirmation));
}

async function restoreAbsoluteTuneOnce(
    tx: Transaction,
    backupId: string,
    confirmation: string | null | undefined,
): Promise<AbsoluteWriteResult> {
    const confirmed = consumeConfirmation(confirmation, { kind: "restore", backupId });
    const { backup, fc, current } = await readAbsoluteRestoreTarget(backupId);
    const target = backup.absolute;
    if (confirmed.preview !== restoreHash(absoluteHash(current), absoluteHash(target))) {
        throw new ApplyBlockedError(["restore:preview_changed"]);
    }
    const safety = storeBackup("before_restore", fc, v1Snapshot(), null, current, !recovering(fc));
    tx.begin(uid3(fc.uid), safety.id, [current.pidProfile!], current.pidProfile);
    await writeAbsoluteBlocks(current, target, current, safety.id, tx, true);
    const verified = await verifyAbsoluteAndSave(target, current, safety.id, tx);
    return { status: "verified", backupId: safety.id, expected: target, ...verified };
}

export interface TransactionStateCheck {
    /** The craft's open entries are all resolved now. */
    resolved: boolean;
    /** Per open entry, why it stays open (empty when it was resolved). */
    reasons: string[];
}

/**
 * Read-only: does the connected craft show a known state again after an uncertain write? An entry
 * whose EEPROM was not written (saved "no") and that names exactly one PID profile is resolved when
 * a full read-back of that profile, active now, equals the backup taken right before that write
 * (RAM holds it and EEPROM never changed). With saved "unknown" or "yes_adjusted" EEPROM cannot be
 * read, and an entry whose profiles are unknown (the slider route, entries from before profiles
 * were recorded) or several may hold a SET in a profile this read does not see: only a verified
 * Restore resolves those, or nothing does. Holds the write lock; writes nothing.
 */
export async function checkTransactionState(): Promise<TransactionStateCheck> {
    return withFcWriteLock(checkTransactionStateLocked);
}

async function checkTransactionStateLocked(): Promise<TransactionStateCheck> {
    // Unreadable storage holds entries this check cannot see: never "resolved" (audit WP8-F08 review).
    const stored = useFcTransactionStore();
    stored.sync();
    if (stored.unreadable) return { resolved: false, reasons: ["state:transaction_storage_unreadable"] };
    assertConnectedReal();
    const fc = await readIdentity();
    if (!fc.uid) throw new ApplyBlockedError(["fc:identity_uid_missing"]);
    const states = useFcTransactionStore();
    states.sync();
    const unreadable = { resolved: false, reasons: ["state:transaction_storage_unreadable"] };
    // It may have turned unreadable while the identity was read (WP8-F08 review).
    if (states.unreadable) return unreadable;
    const open = states.forUid(fc.uid);
    const reasons: string[] = [];
    for (const entry of open) {
        const backup = useTuneBackupStore().get(entry.backupId);
        if (!backup) {
            reasons.push(`state:${entry.backupId}:backup_not_found`);
        } else if (entry.saved !== "no") {
            reasons.push(`state:${entry.backupId}:eeprom_state_unknown_restore_required`);
        } else if (profileSwitchOf(entry.detail)) {
            // A SET may sit in another profile's RAM; one profile's read-back cannot show that.
            reasons.push(`state:${entry.backupId}:profile_switch_seen_restore_required`);
        } else if (!Array.isArray(entry.profiles) || entry.profiles.length !== 1) {
            // Which profiles it changed is not known as one: the others cannot be read from here.
            reasons.push(`state:${entry.backupId}:profile_scope_unknown_restore_required`);
        } else if (fc.version !== backup.firmware) {
            reasons.push(`state:${entry.backupId}:firmware_changed`);
        } else if (backup.absolute) {
            const profile = backup.absolute.pidProfile;
            if (
                entry.profiles[0] !== profile ||
                fc.pidProfile !== profile ||
                fc.apiVersion !== backup.absolute.apiVersion
            ) {
                reasons.push(`state:${entry.backupId}:pid_profile_or_api_differs`);
            } else {
                const now = await readAbsoluteSnapshot("fc:live_readback_missing", fc.apiVersion, profile!);
                const diff = absoluteDiff(now, backup.absolute);
                if (diff.length) reasons.push(`state:${entry.backupId}:differs_from_backup:${diff.length}`);
            }
        } else if (fc.pidProfile !== entry.profiles[0]) {
            reasons.push(`state:${entry.backupId}:pid_profile_or_api_differs`);
        } else {
            const now = await readSnapshot("fc:live_readback_missing");
            const diff = snapshotMismatches(backup.snapshot, now);
            if (diff.length) reasons.push(`state:${entry.backupId}:differs_from_backup:${diff.length}`);
        }
    }
    states.sync();
    if (states.unreadable) return unreadable;
    if (!open.length) {
        const appeared = states.forUid(fc.uid);
        return appeared.length
            ? { resolved: false, reasons: appeared.map((e) => `state:${e.backupId}:changed_during_check`) }
            : { resolved: true, reasons: [] };
    }
    if (reasons.length) return { resolved: false, reasons };
    if (!states.resolveEntries(open)) return { resolved: false, reasons: ["state:not_stored"] };
    if (states.unreadable) return unreadable;
    // An entry another page stored or changed during the awaited reads is not covered by them.
    const left = states.forUid(fc.uid);
    return left.length
        ? { resolved: false, reasons: left.map((e) => `state:${e.backupId}:changed_during_check`) }
        : { resolved: true, reasons: [] };
}

export type { AbsoluteProposal, AbsoluteValues };

export function useTuneApply() {
    return {
        previewTune,
        applyTune,
        previewRestore,
        restoreTune,
        previewAbsoluteTune,
        applyAbsoluteTune,
        previewAbsoluteRestore,
        restoreAbsoluteTune,
        checkTransactionState,
    };
}
