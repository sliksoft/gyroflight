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
 *      product release procedure pass (no flight-controller access before this);
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
 */

import MSP from "@/js/msp";
import MSPCodes from "@/js/msp/MSPCodes";
import { mspHelper } from "@/js/msp/MSPHelper";
import { bit_check } from "@/js/bit";
import { useFlightControllerStore } from "@/stores/fc";
import { useConnectionStore } from "@/stores/connection";
import { validateTuningSliders } from "@/composables/useTuningSliders";
import { ApplyBlockedError } from "@/gyrocore/chirp/applyGate";
import {
    assertCompositeApplyAuthorized,
    authorizeCompositeApply,
    liveCompositeBlocks,
} from "@/gyrocore/tuning/authorize";
import type { CompositeGateState } from "@/gyrocore/tuning/authorize";
import type { ProposedSliders } from "@/composables/useAutotune";
import type { CompositeRecommendation } from "@/gyrocore/tuning/composite";
import { assertSafetyAuthorized } from "@/gyrocore/safety/authorize";
import { assertProductApplyReleased } from "@/gyrocore/productLock/productApply";
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
import { newBackupId, sameUid, useTuneBackupStore, type TuneBackup } from "@/gyrocore/stores/tuneBackup";
import { useChirpQualificationStore } from "@/gyrocore/stores/chirpQualification";
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
    slidersActive,
    slidersOff,
    valuesFromStore,
    valuesToStore,
    type AbsoluteSnapshot,
    type AbsoluteValues,
    type StoreBlocks,
} from "@/gyrocore/tuning/absoluteTune";
import { assertAbsoluteReleased, type AbsoluteProposal } from "@/gyrocore/releaseGate/releaseContract";
import { useVerifiedTuneStore } from "@/gyrocore/stores/verifiedTunes";

export type WriteStage = "write" | "validate" | "verify" | "eeprom" | "eeprom_verify";

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

type MspReply = { crcError?: boolean; unsupported?: number | boolean } | null | undefined;

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
    return {
        uid: uid ? ([uid[0], uid[1], uid[2]] as [number, number, number]) : null,
        manufacturerId: String(c.manufacturerId ?? ""),
        boardName: String(c.boardName ?? ""),
        variant: String(c.flightControllerIdentifier ?? ""),
        version: String(c.flightControllerVersion ?? ""),
        apiVersion: String(c.apiVersion ?? ""),
        armed: bit_check(Number(c.mode ?? 0), 0),
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
    loadStore(before);
    return { pids, advanced, dtermFilters, gyroFilters };
}

function storeBackup(
    reason: TuneBackup["reason"],
    fc: FcIdentity,
    snapshot: TuneSnapshot,
    compositeId: string | null,
    absolute?: AbsoluteSnapshot,
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
    };
    if (!useTuneBackupStore().save(backup)) {
        throw new ApplyBlockedError(["apply:backup_not_stored"]);
    }
    return backup;
}

/** After the write was sent: read back, compare, and save only when everything matches. */
async function verifyAndSave(expected: TuneSnapshot, backupId: string): Promise<TuneSnapshot> {
    let readback: TuneSnapshot;
    try {
        readback = await readSnapshot("fc:verify_readback_missing");
    } catch (err) {
        throw new TuneWriteError("verify", "no", backupId, errorText(err));
    }
    const mismatches = snapshotMismatches(expected, readback);
    if (mismatches.length) {
        throw new TuneWriteError("verify", "no", backupId, mismatches.join("; "), mismatches);
    }
    try {
        await MSP.promise(MSPCodes.MSP_EEPROM_WRITE);
    } catch (err) {
        throw new TuneWriteError("eeprom", "unknown", backupId, errorText(err));
    }
    return readback;
}

function errorText(err: unknown): string {
    if (err instanceof ApplyBlockedError) {
        return err.reasons.join(", ");
    }
    return typeof err === "object" && err !== null ? String(Reflect.get(err, "message") ?? err) : String(err);
}

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
 * itself calculates for the composite. Writes nothing and needs no release: it is what the
 * user confirms, and the first hardware check of the route.
 */
export async function previewTune(
    proposed: ProposedSliders,
    compositeId: string | null | undefined,
): Promise<TunePreview> {
    const gateState = useChirpQualificationStore().gateState();
    const composite = authorizeCompositeApply(gateState, compositeId, proposed).composite;
    if (!composite || composite.id !== compositeId) {
        throw new ApplyBlockedError(["apply:no_composite"]);
    }
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
    // 1. Every gate that needs no flight controller, in this order, before any MSP.
    const gateState = useChirpQualificationStore().gateState();
    const composite = assertCompositeApplyAuthorized(gateState, compositeId, proposed);
    const safety = assertSafetyAuthorized(gateState, composite, { ...proposed });
    const logged = logIdentity(logHeaders(gateState, composite));
    const loggedFirmware = logged.firmwareRevision?.split(/\s+/)[1] ?? null;
    assertProductApplyReleased({
        safetyAnalysisEvidence: safety.analysisEvidence,
        independentPidValidation: useVerifiedTuneStore().forCraft(logged.uid, loggedFirmware),
        craft: { uid: logged.uid, firmware: loggedFirmware },
    });
    const confirmed = consumeConfirmation(confirmation, {
        kind: "apply",
        compositeId: composite.id,
        sliders: { ...proposed },
    });
    assertConnectedReal();

    // 2-4. Identity, live tune, logged PIDs, and the firmware's calculation (read-only).
    const { fc, before, expected } = await readLiveTune(composite, logHeaders(gateState, composite), {
        ...proposed,
    });
    // What the user confirmed must still be what the firmware would produce.
    if (confirmed.preview !== undefined && confirmed.preview !== snapshotHash(expected)) {
        throw new ApplyBlockedError(["apply:preview_changed"]);
    }

    // 5. Backup, then the write itself.
    const backup = storeBackup("before_apply", fc, before, composite.id);
    const fcStore = useFlightControllerStore();
    loadStore(before);
    // Object.keys widens to string[]; the keys are the proposal's own slider fields.
    for (const key of Object.keys(proposed) as (keyof ProposedSliders)[]) {
        if (key in fcStore.tuningSliders) {
            fcStore.tuningSliders[key] = proposed[key];
        }
    }
    try {
        await MSP.promise(MSPCodes.MSP_SET_SIMPLIFIED_TUNING, mspHelper.crunch(MSPCodes.MSP_SET_SIMPLIFIED_TUNING));
    } catch (err) {
        throw new TuneWriteError("write", "no", backup.id, errorText(err));
    }
    await validateTuningSliders();
    if (!fcStore.tuningSliders.slider_pids_valid || !fcStore.tuningSliders.slider_dterm_valid) {
        throw new TuneWriteError("validate", "no", backup.id, "the firmware did not validate the written sliders");
    }

    // 6. Read back, compare with the firmware's own calculation, save only on a full match.
    const after = await verifyAndSave(expected, backup.id);
    return { status: "verified", backupId: backup.id, expected, readback: after };
}

export interface RestorePreview {
    backup: TuneBackup;
    fc: FcIdentity;
    current: TuneSnapshot;
    /** snapshotHash(current): pass it in the confirmation so Restore refuses if the craft changed. */
    hash: string;
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
    if (blocked.length) {
        throw new ApplyBlockedError(blocked);
    }
    const current = await readSnapshot("fc:live_readback_missing");
    return { backup, fc, current, hash: snapshotHash(current) };
}

/** Read-only preview of a Restore: what is on the craft now, against the backup. */
export async function previewRestore(backupId: string): Promise<RestorePreview> {
    return readRestoreTarget(backupId);
}

/** Write a stored backup back to the craft it was taken from, then verify and save. */
export async function restoreTune(backupId: string, confirmation: string | null | undefined): Promise<TuneWriteResult> {
    const confirmed = consumeConfirmation(confirmation, { kind: "restore", backupId });
    const { backup, fc, current } = await readRestoreTarget(backupId);
    if (confirmed.preview !== undefined && confirmed.preview !== snapshotHash(current)) {
        throw new ApplyBlockedError(["restore:preview_changed"]);
    }
    const safety = storeBackup("before_restore", fc, current, null);
    const target = backup.snapshot;

    const fcStore = useFlightControllerStore();
    loadStore({ ...current, sliders: target.sliders, filters: target.filters });
    try {
        await MSP.promise(MSPCodes.MSP_SET_SIMPLIFIED_TUNING, mspHelper.crunch(MSPCodes.MSP_SET_SIMPLIFIED_TUNING));
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
            await MSP.promise(MSPCodes.MSP_SET_PID, mspHelper.crunch(MSPCodes.MSP_SET_PID));
        }
        const advancedOff = SNAPSHOT_ADVANCED_KEYS.some((k) => readback.advanced[k] !== target.advanced[k]);
        if (advancedOff) {
            // MSP_SET_PID_ADVANCED writes the whole block: start from a fresh read of it.
            await readOk(MSPCodes.MSP_PID_ADVANCED, "fc:verify_readback_missing");
            Object.assign(fcStore.advancedTuning, target.advanced);
            await MSP.promise(MSPCodes.MSP_SET_PID_ADVANCED, mspHelper.crunch(MSPCodes.MSP_SET_PID_ADVANCED));
        }
    } catch (err) {
        throw new TuneWriteError("write", "no", safety.id, errorText(err));
    }
    const after = await verifyAndSave(target, safety.id);
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

/** Fresh reads of the four blocks; any missing, refused or corrupt reply blocks with `reason`. */
async function readAbsoluteSnapshot(reason: string, apiVersion: string): Promise<AbsoluteSnapshot> {
    await readOk(MSPCodes.MSP_SIMPLIFIED_TUNING, reason);
    await readOk(MSPCodes.MSP_PID, reason);
    await readOk(MSPCodes.MSP_PID_ADVANCED, reason);
    await readOk(MSPCodes.MSP_FILTER_CONFIG, reason);
    const fcStore = useFlightControllerStore();
    return {
        apiVersion,
        sliders: pick(fcStore.tuningSliders as unknown as Record<string, unknown>, SNAPSHOT_SLIDER_KEYS),
        values: valuesFromStore(storeBlocks(), apiVersion),
    };
}

/** One write; the firmware's error reply (MSP_RESULT_ERROR) counts as a failed write. */
async function writeOk(code: number): Promise<void> {
    const reply = (await MSP.promise(code, mspHelper.crunch(code))) as MspReply;
    if (!reply || reply.crcError || reply.unsupported) {
        throw new Error(`write_refused:${code}`);
    }
}

function changedFrom(backup: AbsoluteSnapshot, now: AbsoluteSnapshot): string[] {
    return absoluteDiff(backup, now).map((r) => `${r.group}:${r.key} ${r.from}→${r.to}`);
}

/** After a failed write: what is on the craft now, against the backup (null when unreadable). */
async function partialWriteState(backup: AbsoluteSnapshot): Promise<string[] | null> {
    try {
        return changedFrom(backup, await readAbsoluteSnapshot("fc:verify_readback_missing", backup.apiVersion));
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
    all = false,
): Promise<void> {
    const fcStore = useFlightControllerStore();
    const api = target.apiVersion;
    const groups = all ? new Set(["pid", "advanced", "filter"]) : changedGroups(current.values, target.values);
    const slidersChange = SLIDER_MODE_KEYS.some((k) => current.sliders[k] !== target.sliders[k]);
    try {
        if (slidersChange || all) {
            // MSP_SET_SIMPLIFIED_TUNING also stores the LPF values it carries: send the live ones.
            await readOk(MSPCodes.MSP_SIMPLIFIED_TUNING, "fc:live_readback_missing");
            await readOk(MSPCodes.MSP_FILTER_CONFIG, "fc:live_readback_missing");
            Object.assign(fcStore.tuningSliders, all ? target.sliders : pick(target.sliders, SLIDER_MODE_KEYS));
            if (all) {
                valuesToStore(target.values, storeBlocks(), api);
            }
            await writeOk(MSPCodes.MSP_SET_SIMPLIFIED_TUNING);
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
            await readOk(read, "fc:live_readback_missing");
            valuesToStore(target.values, storeBlocks(), api);
            await writeOk(write);
        }
    } catch (err) {
        throw new TuneWriteError("write", "no", backupId, errorText(err), [], await partialWriteState(backup));
    }
}

/** Read back, compare everything, save, read again after the firmware reloaded its config. */
async function verifyAbsoluteAndSave(
    expected: AbsoluteSnapshot,
    backup: AbsoluteSnapshot,
    backupId: string,
): Promise<Omit<AbsoluteWriteResult, "status" | "backupId" | "expected">> {
    let readback: AbsoluteSnapshot;
    try {
        readback = await readAbsoluteSnapshot("fc:verify_readback_missing", expected.apiVersion);
    } catch (err) {
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
    let reply: MspReply;
    try {
        reply = (await MSP.promise(MSPCodes.MSP_EEPROM_WRITE)) as MspReply;
    } catch (err) {
        throw new TuneWriteError("eeprom", "unknown", backupId, errorText(err));
    }
    if (!reply || reply.crcError || reply.unsupported) {
        // The firmware refuses MSP_EEPROM_WRITE while armed: nothing was saved.
        throw new TuneWriteError("eeprom", reply ? "no" : "unknown", backupId, "eeprom_write_refused");
    }
    let afterSave: AbsoluteSnapshot;
    try {
        afterSave = await readAbsoluteSnapshot("fc:verify_readback_missing", expected.apiVersion);
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
    if (blocked.length) {
        throw new ApplyBlockedError([...new Set(blocked)]);
    }
    const before = await readAbsoluteSnapshot("fc:live_readback_missing", fc.apiVersion);
    const live = liveDiffersFromLog(loggedAbsoluteValues(proposal.log.headerPairs), before.values);
    const issues = changeSetIssues(proposal.change, before.values, fc.apiVersion);
    if (live.length || issues.length) {
        throw new ApplyBlockedError([...live, ...issues]);
    }
    const expected: AbsoluteSnapshot = {
        apiVersion: fc.apiVersion,
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
    // 1. The release contract and the user's confirmation, before any MSP.
    assertAbsoluteReleased(proposal);
    const confirmed = consumeConfirmation(confirmation, {
        kind: "absolute",
        proposalId: proposal.id,
        change: { ...proposal.change },
    });
    assertConnectedReal();

    // 2. Identity, live values against the log, and the expected result (read-only).
    const { fc, before, expected } = await readLiveAbsolute(proposal);
    if (confirmed.preview !== undefined && confirmed.preview !== absoluteHash(expected)) {
        throw new ApplyBlockedError(["apply:preview_changed"]);
    }

    // 3. Backup (every firmware-held value), then the write, then verify and save.
    const backup = storeBackup("before_absolute_apply", fc, v1Snapshot(), null, before);
    await writeAbsoluteBlocks(before, expected, before, backup.id);
    const verified = await verifyAbsoluteAndSave(expected, before, backup.id);
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
    if (absoluteSnapshotIssues(backup.absolute).length) {
        throw new ApplyBlockedError(["restore:backup_invalid"]);
    }
    assertConnectedReal();
    const fc = await readIdentity();
    const blocked: string[] = [];
    if (!sameUid(fc.uid, backup.uid)) blocked.push("restore:different_craft");
    if (fc.variant !== "BTFL") blocked.push("fc:identity_not_betaflight");
    if (fc.version !== backup.firmware) blocked.push("restore:firmware_changed");
    if (fc.apiVersion !== backup.absolute.apiVersion) blocked.push("restore:api_version_changed");
    if (fc.armed) blocked.push("fc:armed");
    if (blocked.length) {
        throw new ApplyBlockedError(blocked);
    }
    const current = await readAbsoluteSnapshot("fc:live_readback_missing", fc.apiVersion);
    return { backup: backup as TuneBackup & { absolute: AbsoluteSnapshot }, fc, current };
}

/** Read-only preview of restoring an absolute backup: every value that would change back. */
export async function previewAbsoluteRestore(backupId: string): Promise<AbsoluteRestorePreview> {
    const { backup, current } = await readAbsoluteRestoreTarget(backupId);
    return { backup, current, changes: absoluteDiff(current, backup.absolute), hash: absoluteHash(current) };
}

/** Write an absolute backup back exactly (slider modes first, then all three blocks), verify, save. */
export async function restoreAbsoluteTune(
    backupId: string,
    confirmation: string | null | undefined,
): Promise<AbsoluteWriteResult> {
    const confirmed = consumeConfirmation(confirmation, { kind: "restore", backupId });
    const { backup, fc, current } = await readAbsoluteRestoreTarget(backupId);
    if (confirmed.preview !== undefined && confirmed.preview !== absoluteHash(current)) {
        throw new ApplyBlockedError(["restore:preview_changed"]);
    }
    const safety = storeBackup("before_restore", fc, v1Snapshot(), null, current);
    const target = backup.absolute;
    await writeAbsoluteBlocks(current, target, current, safety.id, true);
    const verified = await verifyAbsoluteAndSave(target, current, safety.id);
    return { status: "verified", backupId: safety.id, expected: target, ...verified };
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
    };
}
