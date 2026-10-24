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
 * the browser does not keep it), and settles it at the end: removed when nothing was sent or the
 * write was verified, replaced by the failure otherwise; a page closed mid-write leaves it pending
 * ("in_progress"). Kept per craft UID in this browser (localStorage). An entry is cleared only by
 * evidence that covers it:
 *   - a verified Restore (backup written, read back, saved, read again) by the same route of the one
 *     PID profile the entry could have changed. An entry still in progress (its writer may be
 *     paused, or its page closed before it could record a profile switch), an entry whose profiles
 *     are unknown, or one a profile switch may have spread over two profiles is covered by no
 *     Restore (coveredBy). A Restore itself is refused while the craft has an entry it would not
 *     cover, checked again before each of its writes: its EEPROM save would persist that entry's
 *     unverified values too (notCoveredByRestore), or
 *   - a read-only check whose full read-back of the one profile the entry names equals the backup,
 *     when EEPROM was not written (saved "no") and no profile switch was seen. With saved "unknown"
 *     or "yes_adjusted" a read-back cannot show what EEPROM holds, and with unknown or several
 *     profiles one profile's read-back cannot show the others: only a Restore clears it, or nothing.
 * There is no unlock on a power cycle or on an assumption: an entry nothing covers stays until it
 * is cleared by hand outside Gyroflight (fail-closed).
 *
 * While an entry is open, every write to that craft is refused: Gyroflight's routes, the shared
 * upstream saves (assertNoUncertainWriteOnConnectedCraft) and, at the transport, every MSP or CLI
 * write of any tab of the app (composables/fcWriteGuard.ts). Unreadable storage counts as an
 * uncertain state for every craft (fail-closed) and is never overwritten, so a later page cannot
 * lose what it held; clearing it is a manual step outside Gyroflight.
 *
 * Each entry is stored under its own key (TRANSACTION_ENTRY_PREFIX + id, the id a random UUID): a
 * page writes and removes only the keys of its own transactions. Pending entries are reserved and
 * settled only inside the origin's write lock (fcWriteGuard.withFcWriteLock), so no two
 * transactions of one browser reserve or settle at the same time. Every check and change reads the
 * storage first, so another tab's entry is seen, and a `storage` event refreshes what is shown.
 * Resolving or settling removes an entry only while its stored value is still the one the evidence
 * covered. localStorage is per browser and not strictly consistent between tabs: see fcWriteGuard.
 */

import { defineStore } from "pinia";
import { ref } from "vue";
import { ApplyBlockedError } from "@/gyrocore/chirp/applyGate";
import { sameUid } from "@/gyrocore/stores/tuneBackup";
import { useFlightControllerStore } from "@/stores/fc";

/** One key per transaction: this prefix and its id. */
export const TRANSACTION_ENTRY_PREFIX = "gyroflight.fcTransactionState.v2.";
/** The earlier format (one list): its entries are moved to their own keys when read. */
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
     * The PID profiles the write may have changed. Absolute route: the one active when it began
     * (it re-checks it around every SET), and the one a profile switch it saw moved a SET into.
     * null: not known (the slider route, which does not re-check it).
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

type Keyed = UncertainTransaction & { id: string };

const keyOf = (id: string) => TRANSACTION_ENTRY_PREFIX + id;

/** Store one entry under its own key and read it back. */
function putEntry(e: Keyed): boolean {
    try {
        const json = JSON.stringify(e);
        globalThis.localStorage.setItem(keyOf(e.id), json);
        return globalThis.localStorage.getItem(keyOf(e.id)) === json;
    } catch {
        return false;
    }
}

/** Remove one entry's key, only while it still holds `json` (another page may have changed it). */
function removeEntry(id: string, json: string | null): boolean {
    try {
        const ls = globalThis.localStorage;
        if (json !== null && ls.getItem(keyOf(id)) !== json) return false;
        ls.removeItem(keyOf(id));
        return ls.getItem(keyOf(id)) === null;
    } catch {
        return false;
    }
}

/**
 * Every entry the storage holds, oldest first; not ok when any of them (or an earlier-format list
 * that could not be moved to its own keys) cannot be read.
 */
function readStorage(): Stored {
    try {
        const ls = globalThis.localStorage;
        const legacy = ls.getItem(TRANSACTION_STORAGE_KEY);
        if (legacy !== null) {
            const list = JSON.parse(legacy) as unknown;
            if (!Array.isArray(list) || !list.every(isEntry)) return { ok: false };
            const moved = list.map((e, i) => ({ ...e, id: e.id ?? `tx-v1-${i}-${e.backupId}` }));
            if (!moved.every(putEntry)) return { ok: false };
            ls.removeItem(TRANSACTION_STORAGE_KEY);
        }
        const out: Keyed[] = [];
        for (let i = 0; i < ls.length; i++) {
            const key = ls.key(i);
            if (!key?.startsWith(TRANSACTION_ENTRY_PREFIX)) continue;
            const e = JSON.parse(ls.getItem(key) ?? "null") as unknown;
            if (!isEntry(e) || keyOf(String(e.id)) !== key) return { ok: false };
            out.push(e as Keyed);
        }
        out.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
        return { ok: true, entries: out };
    } catch {
        return { ok: false };
    }
}

export const TRANSACTION_STATE_UNREADABLE = "fc:transaction_state_unreadable";
export const TRANSACTION_STATE_NOT_STORED = "fc:transaction_state_not_stored";
/** Entries are open and the connected craft's UID is not known: it may be one of theirs. */
export const TRANSACTION_STATE_UID_UNKNOWN = "fc:transaction_state_uid_unknown";
/** A Gyroflight write transaction of this page is open: no other write goes out meanwhile. */
export const GYROFLIGHT_WRITE_OPEN = "fc:gyroflight_write_in_progress";

let recordSeq = 0;

export const useFcTransactionStore = defineStore("gyroflightFcTransactionState", () => {
    const stored = readStorage();
    const entries = ref<UncertainTransaction[]>(stored.ok ? stored.entries : []);
    // A latch: once storage was unreadable or refused a change, this page keeps its own entries.
    const unreadable = ref(!stored.ok);
    // Gyroflight write transactions (and read-only checks) of this page holding the write lock.
    const localWrites = ref(0);

    /** Take what the storage holds now (another tab may have changed it); memory once unreadable. */
    function sync(): void {
        if (unreadable.value) return;
        const s = readStorage();
        if (!s.ok) unreadable.value = true;
        else if (JSON.stringify(s.entries) !== JSON.stringify(entries.value)) entries.value = s.entries;
    }

    globalThis.addEventListener?.("storage", (e: StorageEvent) => {
        if (e.key === null || e.key === TRANSACTION_STORAGE_KEY || e.key.startsWith(TRANSACTION_ENTRY_PREFIX)) sync();
    });

    /** This page's view after its own change: kept in memory whether or not the browser stored it. */
    function upsert(e: Keyed): void {
        entries.value = [...entries.value.filter((x) => x.id !== e.id), e];
    }

    /**
     * Store `e` under its key and read it back; false (and every craft blocked) when the browser does
     * not keep it. Never writes while the storage was unreadable: what it held is unknown.
     */
    function store(e: Keyed): boolean {
        if (unreadable.value || !putEntry(e)) {
            unreadable.value = true;
            return false;
        }
        upsert(e);
        return true;
    }

    /**
     * Before the first MSP of a write: the transaction as pending, stored and read back. false: the
     * browser did not keep it (or its storage is unreadable), or its id is taken, and the write must
     * not start. Called inside the write lock, so no other transaction of this origin reserves now.
     */
    function recordPending(t: Keyed): boolean {
        sync();
        if (unreadable.value) return false;
        // A new transaction never takes over a stored one's key (ids are random UUIDs).
        if (entries.value.some((e) => e.id === t.id)) return false;
        return store(t);
    }

    /**
     * The transaction `id` ended: its pending entry is replaced by `outcome` (an uncertain end) or
     * removed (verified, or stopped before the first SET). Kept in memory when the browser refuses
     * the change; that refusal then blocks every craft until the page is reloaded.
     */
    function settle(id: string, outcome: UncertainTransaction | null, pending?: UncertainTransaction): void {
        sync();
        if (outcome) {
            const e = { ...outcome, id };
            if (!store(e)) upsert(e);
            return;
        }
        // Removed only while it still holds the pending entry this page stored; anything else stays.
        const json = pending ? JSON.stringify(pending) : null;
        if (json !== null && !unreadable.value && !holds({ ...pending!, id })) {
            sync();
            return;
        }
        const ok = !unreadable.value && removeEntry(id, json);
        if (!ok) unreadable.value = true;
        entries.value = entries.value.filter((x) => x.id !== id);
    }

    /** Whether the storage still holds exactly the pending entry `e` this page stored (its ownership). */
    function holds(e: UncertainTransaction & { id: string }): boolean {
        try {
            return !unreadable.value && globalThis.localStorage.getItem(keyOf(e.id)) === JSON.stringify(e);
        } catch {
            return false;
        }
    }

    /** Record an uncertain outcome (kept in memory when the browser refuses it; see settle). */
    function record(t: UncertainTransaction): void {
        sync();
        const e = { ...t, id: t.id ?? `tx-rec-${Date.now()}-${++recordSeq}` };
        if (!store(e)) upsert(e);
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

    /**
     * Drop the given entries: their craft state is known again. Each is removed only while its
     * stored value is the one given (an entry another page changed meanwhile stays). false when any
     * stays or the browser refuses.
     */
    function resolveEntries(list: readonly UncertainTransaction[]): boolean {
        if (unreadable.value) return false;
        let all = true;
        for (const e of list) {
            if (!e.id || !removeEntry(e.id, JSON.stringify(e))) all = false;
        }
        sync();
        return all;
    }

    /**
     * Whether a verified Restore by `restored.route` of PID profile `restored.profile` proves the
     * state `e` left: the entry ended (one still in progress may be written further by its paused
     * writer, and a page closed mid-write never recorded a profile switch it may have run into), the
     * same route (the slider Restore does not write the filter block), and the entry's affected
     * profiles are known and just that one.
     */
    function coveredBy(e: UncertainTransaction, restored: RestoreScope): boolean {
        const absolute = e.action === "absolute_apply" || e.action === "absolute_restore";
        return (
            e.stage !== "in_progress" &&
            absolute === (restored.route === "absolute") &&
            restored.profile !== null &&
            Array.isArray(e.profiles) &&
            e.profiles.length === 1 &&
            e.profiles[0] === restored.profile
        );
    }

    /**
     * The open entries of this craft such a Restore would not cover (but `exceptId`, the Restore's own
     * pending entry): while any exists, it must not run, nor write on.
     */
    function notCoveredByRestore(
        uid: readonly number[],
        restored: RestoreScope,
        exceptId?: string,
    ): UncertainTransaction[] {
        sync();
        return forUid(uid).filter((e) => e.id !== exceptId && !coveredBy(e, restored));
    }

    /** After a verified Restore: resolve the entries it covers; the others stay. */
    function resolveByRestore(uid: readonly number[], restored: RestoreScope): boolean {
        sync();
        return resolveEntries(forUid(uid).filter((e) => coveredBy(e, restored)));
    }

    return {
        entries,
        unreadable,
        localWrites,
        sync,
        recordPending,
        settle,
        holds,
        record,
        forUid,
        blocks,
        resolveEntries,
        notCoveredByRestore,
        resolveByRestore,
    };
});

/**
 * Why a write that is not part of a Gyroflight transaction must not reach the connected craft now;
 * empty when it may: a Gyroflight transaction of this page is open, the craft has an open entry,
 * the storage is unreadable, or entries are open while the craft's UID is unknown.
 */
export function connectedCraftWriteIssues(): string[] {
    const uid = useFlightControllerStore().config.uid;
    const states = useFcTransactionStore();
    states.sync();
    const known = Array.isArray(uid) && uid.length === 3 ? uid : null;
    return [
        ...(states.localWrites > 0 ? [GYROFLIGHT_WRITE_OPEN] : []),
        ...states.blocks(known),
        ...(!known && states.entries.length ? [TRANSACTION_STATE_UID_UNKNOWN] : []),
    ];
}

/**
 * For write paths outside Gyroflight's routes (the PID tab's Save, EEPROM saves of any tab): refuse
 * while the connected craft's last Gyroflight write ended in a state nobody verified, since such a
 * save would write or persist those unverified values (audit WP8). Throws ApplyBlockedError. The
 * transport checks the same again for every request (composables/fcWriteGuard.ts).
 */
export function assertNoUncertainWriteOnConnectedCraft(): void {
    const issues = connectedCraftWriteIssues();
    if (issues.length) throw new ApplyBlockedError(issues);
}
