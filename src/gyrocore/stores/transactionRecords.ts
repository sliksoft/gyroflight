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
 * The one definition of a readable transaction record (audit WP8-F08), for the transaction store
 * (fcTransactionState: what blocks writes) and backup retention (tuneBackup: what must not be
 * deleted). Both read the same localStorage with it, so a record one of them cannot read is
 * unreadable to the other too. Reading never writes: moving the earlier one-list format to its
 * own keys is the transaction store's step, not this module's.
 */

/** One key per transaction: this prefix and its id. */
export const TRANSACTION_ENTRY_PREFIX = "gyroflight.fcTransactionState.v2.";
/** The earlier format (one list): its entries are moved to their own keys when the store reads it. */
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

export type KeyedTransaction = UncertainTransaction & { id: string };

const ACTIONS: ReadonlySet<string> = new Set(["apply", "absolute_apply", "restore", "absolute_restore"]);

/**
 * Whether `e` is a record the transaction store can act on: a craft UID of three integers, the
 * backup it names, its stage, saved state and time; its id, action, profiles and detail, where
 * present, of their kind. The earlier format may lack id, action, profiles and detail.
 */
export function isTransactionRecord(e: unknown): e is UncertainTransaction {
    if (!e || typeof e !== "object" || Array.isArray(e)) return false;
    const t = e as Record<string, unknown>;
    return (
        Array.isArray(t.uid) &&
        t.uid.length === 3 &&
        t.uid.every((w) => Number.isInteger(w)) &&
        typeof t.backupId === "string" &&
        t.backupId !== "" &&
        typeof t.stage === "string" &&
        typeof t.saved === "string" &&
        typeof t.at === "string" &&
        (t.id === undefined || typeof t.id === "string") &&
        (t.action === undefined || ACTIONS.has(t.action as string)) &&
        (t.profiles === undefined ||
            t.profiles === null ||
            (Array.isArray(t.profiles) && t.profiles.every((p) => Number.isInteger(p) && (p as number) >= 0))) &&
        (t.detail === undefined || typeof t.detail === "string")
    );
}

export const transactionKey = (id: string) => TRANSACTION_ENTRY_PREFIX + id;

/** The id an earlier-format entry (the `i`th of the list) gets when it is moved to its own key. */
export const legacyEntryId = (e: UncertainTransaction, i: number) => e.id ?? `tx-v1-${i}-${e.backupId}`;

export type TransactionRecords =
    { ok: true; entries: KeyedTransaction[]; legacy: UncertainTransaction[] | null } | { ok: false };

/**
 * Every record in `ls`, without changing it: the entries under their own keys (each must be a
 * record whose id is its key's), and the earlier-format list if one is still stored. Not ok when
 * any of them cannot be read, or (audit WP8-F08 review) when moving the list would overwrite
 * anything: two of its entries get the same id, or one's key already holds a different entry.
 */
export function readTransactionRecords(ls: Storage): TransactionRecords {
    try {
        let legacy: UncertainTransaction[] | null = null;
        const raw = ls.getItem(TRANSACTION_STORAGE_KEY);
        if (raw !== null) {
            const list = JSON.parse(raw) as unknown;
            if (!Array.isArray(list) || !list.every(isTransactionRecord)) return { ok: false };
            const ids = list.map(legacyEntryId);
            if (new Set(ids).size !== ids.length) return { ok: false };
            for (let i = 0; i < list.length; i++) {
                const there = ls.getItem(transactionKey(ids[i]));
                if (there !== null && there !== JSON.stringify({ ...list[i], id: ids[i] })) return { ok: false };
            }
            legacy = list;
        }
        const entries: KeyedTransaction[] = [];
        for (let i = 0; i < ls.length; i++) {
            const key = ls.key(i);
            if (!key?.startsWith(TRANSACTION_ENTRY_PREFIX)) continue;
            const e = JSON.parse(ls.getItem(key) ?? "null") as unknown;
            if (!isTransactionRecord(e) || typeof e.id !== "string" || transactionKey(e.id) !== key) {
                return { ok: false };
            }
            entries.push(e as KeyedTransaction);
        }
        return { ok: true, entries, legacy };
    } catch {
        return { ok: false };
    }
}
