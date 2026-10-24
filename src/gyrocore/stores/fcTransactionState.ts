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
 * useTuneApply.ts stores a pending entry before the first MSP of every write (no write starts when
 * the browser does not keep it), and settles it at the end: removed when verified or stopped before
 * the first SET, replaced by the failure otherwise; a page closed mid-write leaves it pending. Kept
 * per craft UID in this browser (localStorage). An entry is cleared only by evidence that covers it:
 *   - a verified Restore (backup written, read back, saved, read again) by the same route of the one
 *     PID profile the entry could have changed; an entry whose profiles are unknown, or that a
 *     profile switch may have spread over two profiles, is covered by no Restore (resolveByRestore).
 *     A Restore itself is refused while the craft has an entry it would not cover: its EEPROM save
 *     would persist that entry's unverified values too (notCoveredByRestore), or
 *   - a read-only check whose full read-back equals the backup, when EEPROM was not written (saved
 *     "no") and no profile switch was seen. With saved "unknown" or "yes_adjusted" a read-back
 *     cannot show what EEPROM holds, so only a Restore clears it.
 * While an entry is open, Gyroflight's Apply and the shared upstream saves (PID tab, EEPROM saves)
 * refuse on that craft (assertNoUncertainWriteOnConnectedCraft). Unreadable storage counts as an
 * uncertain state for every craft (fail-closed) and is never overwritten, so a later page cannot
 * lose what it held; clearing it is a manual step outside Gyroflight.
 *
 * Every check and change reads the storage first, so a write in another tab of this browser is
 * seen (and a `storage` event refreshes what is shown). localStorage has no compare-and-swap: two
 * tabs changing it in the same instant can still lose one change (residual risk).
 */

import { defineStore } from "pinia";
import { ref } from "vue";
import { ApplyBlockedError } from "@/gyrocore/chirp/applyGate";
import { sameUid } from "@/gyrocore/stores/tuneBackup";
import { useFlightControllerStore } from "@/stores/fc";

export const TRANSACTION_STORAGE_KEY = "gyroflight.fcTransactionState.v1";

export interface UncertainTransaction {
    /** Unique per write transaction (a pending entry and its outcome share it). */
    id?: string;
    uid: [number, number, number];
    action: "apply" | "absolute_apply" | "restore" | "absolute_restore";
    /**
     * useTuneApply WriteStage where it stopped (never "prepare": nothing was sent then), or
     * "in_progress": recorded before the first MSP and never settled (the page closed or crashed
     * in the middle of the write, so nothing is known of its outcome).
     */
    stage: string;
    /** EEPROM state the failure could prove: "no", "unknown" or "yes_adjusted". */
    saved: string;
    /** The backup taken right before the write: what Restore puts back and the check compares with. */
    backupId: string;
    /**
     * The PID profiles the write may have changed: the one active when it began, and the one a
     * profile switch the absolute route saw moved a SET into; null: not known.
     */
    profiles?: number[] | null;
    detail: string;
    at: string;
}

/** What a verified Restore wrote: its route, and the PID profile active then (null: not known). */
export interface RestoreScope {
    route: "absolute" | "slider";
    profile: number | null;
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
export const TRANSACTION_STATE_NOT_STORED = "fc:transaction_state_not_stored";

export const useFcTransactionStore = defineStore("gyroflightFcTransactionState", () => {
    const stored = readStorage();
    const entries = ref<UncertainTransaction[]>(stored.ok ? stored.entries : []);
    // A latch: once storage was unreadable or refused a change, this page keeps its own entries.
    const unreadable = ref(!stored.ok);

    /** Take what the storage holds now (another tab may have changed it); memory once unreadable. */
    function sync(): void {
        if (unreadable.value) return;
        const s = readStorage();
        if (!s.ok) unreadable.value = true;
        else if (JSON.stringify(s.entries) !== JSON.stringify(entries.value)) entries.value = s.entries;
    }

    globalThis.addEventListener?.("storage", (e: StorageEvent) => {
        if (e.key === TRANSACTION_STORAGE_KEY || e.key === null) sync();
    });

    /**
     * Store `next` and read it back; false (and every craft blocked) when the browser does not keep
     * it. Never writes over storage that was unreadable: what it held is unknown.
     */
    function persist(next: UncertainTransaction[]): boolean {
        if (unreadable.value) return false;
        try {
            globalThis.localStorage.setItem(TRANSACTION_STORAGE_KEY, JSON.stringify(next));
            if (globalThis.localStorage.getItem(TRANSACTION_STORAGE_KEY) !== JSON.stringify(next)) {
                throw new Error("not kept");
            }
        } catch {
            unreadable.value = true;
            return false;
        }
        entries.value = next;
        return true;
    }

    /** persist(), or keep `next` in this page's memory when the browser refuses it (see settle). */
    function keep(next: UncertainTransaction[]): void {
        if (!persist(next)) entries.value = next;
    }

    /**
     * Before the first MSP of a write: the transaction as pending, stored and read back. false: the
     * browser did not keep it (or its storage is unreadable), and the write must not start.
     */
    function recordPending(t: UncertainTransaction & { id: string }): boolean {
        sync();
        return persist([t, ...entries.value]);
    }

    /**
     * The transaction `id` ended: its pending entry is replaced by `outcome` (an uncertain end) or
     * removed (verified, or stopped before the first SET). Kept in memory when the browser refuses
     * the change; that refusal then blocks every craft until the page is reloaded.
     */
    function settle(id: string, outcome: UncertainTransaction | null): void {
        sync();
        keep([...(outcome ? [{ ...outcome, id }] : []), ...entries.value.filter((e) => e.id !== id)]);
    }

    /** Record an uncertain outcome (kept in memory when the browser refuses it; see settle). */
    function record(t: UncertainTransaction): void {
        sync();
        keep([t, ...entries.value]);
    }

    /** The open entries for this craft as last read; a null UID matches none (the caller blocks on the missing UID). */
    function forUid(uid: readonly number[] | null | undefined): UncertainTransaction[] {
        return entries.value.filter((e) => sameUid(e.uid, uid));
    }

    /**
     * Why a write on this craft must not run now, as last read; empty when its state is known.
     * Pure (the panels compute from it); a write path calls sync() first.
     */
    function blocks(uid: readonly number[] | null | undefined): string[] {
        return [
            ...(unreadable.value ? [TRANSACTION_STATE_UNREADABLE] : []),
            ...forUid(uid).map((e) => `fc:transaction_state_uncertain:${e.backupId}:${e.stage}:${e.saved}`),
        ];
    }

    /** Drop the given entries: their craft state is known again (kept when the browser refuses the change). */
    function resolveEntries(list: readonly UncertainTransaction[]): boolean {
        const gone = new Set(list.map((e) => JSON.stringify(e)));
        sync();
        return persist(entries.value.filter((e) => !gone.has(JSON.stringify(e))));
    }

    /**
     * Whether a verified Restore by `restored.route` of PID profile `restored.profile` proves the
     * state `e` left: the same route (the slider Restore does not write the filter block), and the
     * entry's affected profiles are known and just that one.
     */
    function coveredBy(e: UncertainTransaction, restored: RestoreScope): boolean {
        const absolute = e.action === "absolute_apply" || e.action === "absolute_restore";
        return (
            absolute === (restored.route === "absolute") &&
            restored.profile !== null &&
            Array.isArray(e.profiles) &&
            e.profiles.length === 1 &&
            e.profiles[0] === restored.profile
        );
    }

    /** The open entries of this craft such a Restore would not cover: while any exists, it must not run. */
    function notCoveredByRestore(uid: readonly number[], restored: RestoreScope): UncertainTransaction[] {
        sync();
        return forUid(uid).filter((e) => !coveredBy(e, restored));
    }

    /** After a verified Restore: resolve the entries it covers; the others stay. */
    function resolveByRestore(uid: readonly number[], restored: RestoreScope): boolean {
        sync();
        return resolveEntries(forUid(uid).filter((e) => coveredBy(e, restored)));
    }

    return {
        entries,
        unreadable,
        sync,
        recordPending,
        settle,
        record,
        forUid,
        blocks,
        resolveEntries,
        notCoveredByRestore,
        resolveByRestore,
    };
});

/**
 * For write paths outside Gyroflight's routes (the PID tab's Save, EEPROM saves of any tab): refuse
 * while the connected craft's last Gyroflight write ended in a state nobody verified, since such a
 * save would write or persist those unverified values (audit WP8). Throws ApplyBlockedError.
 */
export function assertNoUncertainWriteOnConnectedCraft(): void {
    const uid = useFlightControllerStore().config.uid;
    const states = useFcTransactionStore();
    states.sync();
    const blocks = states.blocks(Array.isArray(uid) && uid.length === 3 ? uid : null);
    if (blocks.length) throw new ApplyBlockedError(blocks);
}
