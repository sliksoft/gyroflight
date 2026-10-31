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
 * Backups of the flight-controller tune, taken by Gyroflight right before it writes.
 *
 * A backup is a snapshot read from the craft itself (tuneSnapshot.ts) and is bound
 * to that craft's MCU UID. It is kept in this browser (localStorage) so it survives
 * a reload, and can be downloaded. Restore accepts only backups in this store: there
 * is no import, so Restore cannot be used to write values from elsewhere.
 */

import { defineStore } from "pinia";
import { ref } from "vue";
import type { TuneSnapshot } from "@/gyrocore/tuning/tuneSnapshot";
import type { AbsoluteSnapshot } from "@/gyrocore/tuning/absoluteTune";
import { readTransactionRecords } from "@/gyrocore/stores/transactionRecords";

export const BACKUP_STORAGE_KEY = "gyroflight.tuneBackups.v1";
/** Newest backups kept per craft, of each kind: Restore targets (stateKnown) and the others. */
export const BACKUPS_PER_CRAFT = 20;
/** The common prefix of fcTransactionState's keys (both formats; see transactionRecords.ts). */
export const TRANSACTION_KEYS_PREFIX = "gyroflight.fcTransactionState.";

export interface TuneBackup {
    id: string;
    createdAt: string;
    /** Why it was taken: right before an Apply, or before a Restore (so a Restore can be undone). */
    reason: "before_apply" | "before_absolute_apply" | "before_restore";
    uid: [number, number, number];
    board: string;
    firmware: string;
    compositeId: string | null;
    snapshot: TuneSnapshot;
    /** Absolute route: every firmware-held PID / PID_ADVANCED / FILTER_CONFIG value and the slider modes. */
    absolute?: AbsoluteSnapshot;
    /**
     * Whether the craft's state was known when it was taken: false for the backup a Restore takes
     * while the craft holds the result of a write nobody verified (kept to show what was there).
     * Missing on backups taken before this was recorded: those are never a Restore target.
     */
    stateKnown?: boolean;
}

/**
 * Why `b` must not be written back by a Restore; null when it may. An unverified state never, and
 * no backup without its provenance recorded, whatever its reason: one stored before stateKnown
 * existed may have been taken after a failed write left a partial result on the craft (audit WP8).
 * There is no migration that could prove an older backup sound.
 */
export function restoreTargetIssue(b: TuneBackup): string | null {
    if (b.stateKnown === false) return "restore:backup_unverified";
    if (b.stateKnown !== true) return "restore:backup_provenance_unknown";
    return null;
}

/**
 * The stored backups; null when the list cannot be read (Gyroflight audit WP8-F08: then nothing may
 * overwrite it, since that would delete every backup in it).
 */
function readList(): TuneBackup[] | null {
    try {
        const raw = globalThis.localStorage?.getItem(BACKUP_STORAGE_KEY);
        if (raw === null || raw === undefined) return [];
        const list = JSON.parse(raw) as unknown;
        const backups = (b: unknown) => !!b && typeof b === "object" && typeof (b as TuneBackup).id === "string";
        return Array.isArray(list) && list.every(backups) ? (list as TuneBackup[]) : null;
    } catch {
        return null;
    }
}

const readStorage = (): TuneBackup[] => readList() ?? [];

/**
 * The backup ids open transaction entries name (their evidence: what the craft held before); null
 * when an entry cannot be read by the transaction store's own definition (transactionRecords.ts),
 * and then no backup may be dropped.
 */
function backupIdsInUse(): Set<string> | null {
    const read = readTransactionRecords(globalThis.localStorage);
    if (!read.ok) return null;
    return new Set([...read.entries, ...(read.legacy ?? [])].map((e) => e.backupId));
}

export function sameUid(a: readonly number[] | null | undefined, b: readonly number[] | null | undefined): boolean {
    return !!a && !!b && a.length === 3 && b.length === 3 && a.every((w, i) => w === b[i]);
}

export const useTuneBackupStore = defineStore("gyroflightTuneBackup", () => {
    const backups = ref<TuneBackup[]>(readStorage());

    /**
     * Stores `backup` and reads it back; false when the browser did not keep it exactly. Starts from
     * the storage, not this page's copy, so a backup another tab stored meanwhile is kept. Of a
     * craft's backups the newest BACKUPS_PER_CRAFT Restore targets and the newest as many others
     * stay, and every one an open transaction entry names (audit WP8: repeated recovery snapshots
     * must not push out the evidence or the trusted targets).
     */
    function save(backup: TuneBackup): boolean {
        const list = readList();
        if (!list) return false;
        const others = list.filter((b) => b.id !== backup.id);
        const inUse = backupIdsInUse();
        const kept = { trusted: 0, other: 0 };
        const sameCraft = [backup, ...others.filter((b) => sameUid(b.uid, backup.uid))].filter((b) => {
            if (!inUse || inUse.has(b.id)) return true;
            const kind = b.stateKnown === true ? "trusted" : "other";
            return ++kept[kind] <= BACKUPS_PER_CRAFT;
        });
        const next = [...sameCraft, ...others.filter((b) => !sameUid(b.uid, backup.uid))];
        try {
            globalThis.localStorage.setItem(BACKUP_STORAGE_KEY, JSON.stringify(next));
        } catch {
            return false;
        }
        const stored = readStorage().find((b) => b.id === backup.id);
        if (!stored || JSON.stringify(stored) !== JSON.stringify(backup)) {
            return false;
        }
        backups.value = next;
        return true;
    }

    function get(id: string): TuneBackup | null {
        return readStorage().find((b) => b.id === id) ?? null;
    }

    function forUid(uid: readonly number[] | null | undefined): TuneBackup[] {
        return backups.value.filter((b) => sameUid(b.uid, uid));
    }

    function reload() {
        backups.value = readStorage();
    }

    return { backups, save, get, forUid, reload };
});

export function newBackupId(now = new Date()): string {
    const bytes = new Uint8Array(4);
    globalThis.crypto.getRandomValues(bytes);
    return `bk-${now.toISOString().replace(/[:.]/g, "")}-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
