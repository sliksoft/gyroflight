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

export const BACKUP_STORAGE_KEY = "gyroflight.tuneBackups.v1";
/** Newest backups kept per craft. */
export const BACKUPS_PER_CRAFT = 20;

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
     * Taken by a Restore while the craft held the result of a write nobody verified: kept to show
     * what was there, never a Restore target (useTuneApply refuses it).
     */
    unverified?: true;
}

function readStorage(): TuneBackup[] {
    try {
        const raw = globalThis.localStorage?.getItem(BACKUP_STORAGE_KEY);
        const list = raw ? (JSON.parse(raw) as unknown) : [];
        return Array.isArray(list) ? (list as TuneBackup[]) : [];
    } catch {
        return [];
    }
}

export function sameUid(a: readonly number[] | null | undefined, b: readonly number[] | null | undefined): boolean {
    return !!a && !!b && a.length === 3 && b.length === 3 && a.every((w, i) => w === b[i]);
}

export const useTuneBackupStore = defineStore("gyroflightTuneBackup", () => {
    const backups = ref<TuneBackup[]>(readStorage());

    /** Stores `backup` and reads it back; false when the browser did not keep it exactly. */
    function save(backup: TuneBackup): boolean {
        const others = backups.value.filter((b) => b.id !== backup.id);
        const sameCraft = [backup, ...others.filter((b) => sameUid(b.uid, backup.uid))].slice(0, BACKUPS_PER_CRAFT);
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
