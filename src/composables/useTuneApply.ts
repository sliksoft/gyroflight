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
import { assertCompositeApplyAuthorized, liveCompositeBlocks } from "@/gyrocore/tuning/authorize";
import type { CompositeGateState } from "@/gyrocore/tuning/authorize";
import type { ProposedSliders } from "@/composables/useAutotune";
import type { CompositeRecommendation } from "@/gyrocore/tuning/composite";
import { assertSafetyAuthorized } from "@/gyrocore/safety/authorize";
import { assertProductApplyReleased } from "@/gyrocore/productLock/productApply";
import { consumeConfirmation } from "@/gyrocore/tuning/applyConfirmation";
import { identityBlocks, logIdentity, type FcIdentity } from "@/gyrocore/tuning/fcIdentity";
import {
    AXES,
    DTERM_FILTER_KEYS,
    SNAPSHOT_ADVANCED_KEYS,
    SNAPSHOT_FILTER_KEYS,
    SNAPSHOT_SLIDER_KEYS,
    expectedAfterWrite,
    pick,
    pidsDifferFromLog,
    sliderAxes,
    snapshotMismatches,
    type FirmwareCalculation,
    type TuneSnapshot,
} from "@/gyrocore/tuning/tuneSnapshot";
import { newBackupId, sameUid, useTuneBackupStore, type TuneBackup } from "@/gyrocore/stores/tuneBackup";
import { useChirpQualificationStore } from "@/gyrocore/stores/chirpQualification";

export type WriteStage = "write" | "validate" | "verify" | "eeprom";

/** A write was sent and did not end verified and saved. Never shown as success. */
export class TuneWriteError extends Error {
    readonly stage: WriteStage;
    /** "no": EEPROM was not written, the saved tune is the previous one. "unknown": it may or may not be. */
    readonly saved: "no" | "unknown";
    readonly backupId: string;
    readonly mismatches: string[];

    constructor(
        stage: WriteStage,
        saved: "no" | "unknown",
        backupId: string,
        detail: string,
        mismatches: string[] = [],
    ) {
        super(`Tune write failed at ${stage} (saved: ${saved}): ${detail}`);
        this.name = "TuneWriteError";
        this.stage = stage;
        this.saved = saved;
        this.backupId = backupId;
        this.mismatches = mismatches;
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
    loadStore(before);
    return { pids, advanced, dtermFilters };
}

function storeBackup(
    reason: TuneBackup["reason"],
    fc: FcIdentity,
    snapshot: TuneSnapshot,
    compositeId: string | null,
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

/**
 * Apply GyroCore's global tune. `confirmation` is the token the interface issued after
 * the user confirmed exactly this composite and these sliders.
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
    assertProductApplyReleased({
        safetyAnalysisEvidence: safety.analysisEvidence,
        independentPidValidation: null,
    });
    consumeConfirmation(confirmation, { kind: "apply", compositeId: composite.id, sliders: { ...proposed } });
    assertConnectedReal();

    // 2. The connected craft is the logged one, on the logged firmware, disarmed.
    const headers = logHeaders(gateState, composite);
    const fc = await readIdentity();
    const idBlocks = identityBlocks(logIdentity(headers), fc);
    if (idBlocks.length) {
        throw new ApplyBlockedError(idBlocks);
    }

    // 3. Live slider state, read fresh (MSPHelper fills fcStore.tuningSliders). No
    // response, a refused reply or a CRC error leaves older values: never compare to those.
    const fcStore = useFlightControllerStore();
    const readback = (await MSP.promise(MSPCodes.MSP_SIMPLIFIED_TUNING)) as MspReply;
    if (!readback || readback.crcError || readback.unsupported) {
        throw new ApplyBlockedError(["fc:live_readback_missing"]);
    }
    const live = liveCompositeBlocks(fcStore.tuningSliders, composite);
    if (live.length) {
        throw new ApplyBlockedError(live);
    }

    // 4. Backup of everything the write can change, and the logged PIDs still in place.
    await readOk(MSPCodes.MSP_PID, "fc:live_readback_missing");
    await readOk(MSPCodes.MSP_PID_ADVANCED, "fc:live_readback_missing");
    const before = storeSnapshot();
    const pidBlocks = pidsDifferFromLog(headers, before.pids);
    if (pidBlocks.length) {
        throw new ApplyBlockedError(pidBlocks);
    }
    const backup = storeBackup("before_apply", fc, before, composite.id);

    // 5. What the firmware will produce, then the write itself.
    const calc = await firmwareCalculation(before, { ...proposed });
    const expected = expectedAfterWrite(before, { ...proposed }, calc);
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

/** Write a stored backup back to the craft it was taken from, then verify and save. */
export async function restoreTune(backupId: string, confirmation: string | null | undefined): Promise<TuneWriteResult> {
    consumeConfirmation(confirmation, { kind: "restore", backupId });
    const backup = useTuneBackupStore().get(backupId);
    if (!backup) {
        throw new ApplyBlockedError(["restore:backup_not_found"]);
    }
    assertConnectedReal();
    const fc = await readIdentity();
    if (!sameUid(fc.uid, backup.uid)) {
        throw new ApplyBlockedError(["restore:different_craft"]);
    }
    if (fc.armed) {
        throw new ApplyBlockedError(["fc:armed"]);
    }

    const current = await readSnapshot("fc:live_readback_missing");
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

export function useTuneApply() {
    return { applyTune, restoreTune };
}
