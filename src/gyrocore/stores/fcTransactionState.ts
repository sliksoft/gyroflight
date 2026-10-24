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
 * Write transactions whose outcome on the flight controller is not known (audit F-03): a SET was
 * sent and the transaction did not end verified and saved. Until the craft's state is known again,
 * no further Apply may build on it, since every Apply assumes the craft holds what was read before
 * it and what the log shows.
 *
 * An entry is recorded by useTuneApply.ts for every failure after the first SET (any stage but
 * "prepare"), per craft UID, and kept in this browser (localStorage) so a reload does not forget it.
 * It is cleared only by evidence:
 *   - a verified Restore of that craft (backup written, read back, saved, read again), or
 *   - a read-only check whose full read-back equals the backup, when EEPROM was not written
 *     (saved "no"): RAM then holds the backup and EEPROM never changed. With saved "unknown" or
 *     "yes_adjusted" a read-back cannot show what EEPROM holds, so only a Restore clears it.
 * Unreadable storage counts as an uncertain state for every craft (fail-closed).
 */

import { defineStore } from "pinia";
import { ref } from "vue";
import { sameUid } from "@/gyrocore/stores/tuneBackup";

export const TRANSACTION_STORAGE_KEY = "gyroflight.fcTransactionState.v1";

export interface UncertainTransaction {
    uid: [number, number, number];
    action: "apply" | "absolute_apply" | "restore" | "absolute_restore";
    /** useTuneApply WriteStage where it stopped (never "prepare": nothing was sent then). */
    stage: string;
    /** EEPROM state the failure could prove: "no", "unknown" or "yes_adjusted". */
    saved: string;
    /** The backup taken right before the write: what Restore puts back and the check compares with. */
    backupId: string;
    detail: string;
    at: string;
}

type Stored = { ok: true; entries: UncertainTransaction[] } | { ok: false };

function isEntry(e: unknown): e is UncertainTransaction {
    const t = e as Partial<UncertainTransaction> | null;
    return (
        !!t &&
        Array.isArray(t.uid) &&
        t.uid.length === 3 &&
        t.uid.every(Number.isFinite) &&
        typeof t.backupId === "string" &&
        typeof t.stage === "string" &&
        typeof t.saved === "string"
    );
}

function readStorage(): Stored {
    try {
        const raw = globalThis.localStorage.getItem(TRANSACTION_STORAGE_KEY);
        if (raw === null) return { ok: true, entries: [] };
        const list = JSON.parse(raw) as unknown;
        return Array.isArray(list) && list.every(isEntry) ? { ok: true, entries: list } : { ok: false };
    } catch {
        return { ok: false };
    }
}

export const TRANSACTION_STATE_UNREADABLE = "fc:transaction_state_unreadable";

export const useFcTransactionStore = defineStore("gyroflightFcTransactionState", () => {
    const stored = readStorage();
    const entries = ref<UncertainTransaction[]>(stored.ok ? stored.entries : []);
    const unreadable = ref(!stored.ok);

    function reload() {
        const s = readStorage();
        entries.value = s.ok ? s.entries : [];
        unreadable.value = !s.ok;
    }

    function persist(next: UncertainTransaction[]): boolean {
        try {
            globalThis.localStorage.setItem(TRANSACTION_STORAGE_KEY, JSON.stringify(next));
        } catch {
            unreadable.value = true;
            return false;
        }
        entries.value = next;
        return true;
    }

    /**
     * Record an uncertain outcome. Kept in memory even when the browser refuses to store it; that
     * refusal itself then blocks every craft (`unreadable`) until the page is reloaded.
     */
    function record(t: UncertainTransaction): void {
        const next = [t, ...entries.value];
        if (!persist(next)) entries.value = next;
    }

    /** The open entries for this craft; a null UID matches none (the caller blocks on the missing UID). */
    function forUid(uid: readonly number[] | null | undefined): UncertainTransaction[] {
        return entries.value.filter((e) => sameUid(e.uid, uid));
    }

    /** Why an Apply on this craft must not run now; empty when its state is known. */
    function blocks(uid: readonly number[] | null | undefined): string[] {
        const open = forUid(uid);
        return [
            ...(unreadable.value ? [TRANSACTION_STATE_UNREADABLE] : []),
            ...open.map((e) => `fc:transaction_state_uncertain:${e.backupId}:${e.stage}:${e.saved}`),
        ];
    }

    /** The craft's state is known again: drop every entry for it (kept when the browser refuses the change). */
    function resolve(uid: readonly number[]): boolean {
        return persist(entries.value.filter((e) => !sameUid(e.uid, uid)));
    }

    return { entries, unreadable, record, forUid, blocks, resolve, reload };
});
