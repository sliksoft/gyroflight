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
 * Audit WP8-F08: backup retention and the transaction store read the same records with one
 * definition. Whatever the transaction store cannot read (and so blocks every write on), retention
 * must treat as unreadable too and drop nothing; every backup a readable entry names is kept.
 * Production stores over jsdom's localStorage; each fixture is checked against both.
 */

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import {
    BACKUP_STORAGE_KEY,
    BACKUPS_PER_CRAFT,
    useTuneBackupStore,
    type TuneBackup,
} from "../../src/gyrocore/stores/tuneBackup";
import {
    TRANSACTION_ENTRY_PREFIX,
    TRANSACTION_STORAGE_KEY,
    useFcTransactionStore,
} from "../../src/gyrocore/stores/fcTransactionState";
import { checkTransactionState } from "../../src/composables/useTuneApply";

const UID: [number, number, number] = [1, 2, 3];

function backup(id: string, stateKnown: boolean, uid = UID): TuneBackup {
    return {
        id,
        createdAt: "2026-10-24T00:00:00Z",
        reason: stateKnown ? "before_absolute_apply" : "before_restore",
        uid,
        board: "B",
        firmware: "2026.6.2",
        compositeId: null,
        snapshot: { sliders: {}, filters: {}, pids: [], advanced: {} } as unknown as TuneBackup["snapshot"],
        stateKnown,
    };
}

const entry = (id: string, backupId: string, extra: Record<string, unknown> = {}) => ({
    id,
    uid: UID,
    action: "absolute_restore",
    stage: "eeprom",
    saved: "unknown",
    backupId,
    profiles: [0],
    detail: "",
    at: "2026-10-24T00:00:00Z",
    ...extra,
});

const put = (key: string, value: unknown) =>
    localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));

/** 20 unverified backups b-0..b-19 (b-0 oldest), then the fixture, then two more unverified saves. */
function fillThenSaveTwo() {
    const store = useTuneBackupStore();
    for (let i = 0; i < BACKUPS_PER_CRAFT; i++) expect(store.save(backup(`b-${i}`, false))).toBe(true);
    return () => {
        store.save(backup("new-1", false));
        store.save(backup("new-2", false));
        return store;
    };
}

/** Whether the transaction store (the write guard's source) can read the storage now. */
function transactionStoreReads(): boolean {
    setActivePinia(createPinia());
    return !useFcTransactionStore().unreadable;
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
});

const unreadable: Array<[string, () => void]> = [
    ["invalid JSON", () => put(`${TRANSACTION_ENTRY_PREFIX}x`, "{not json")],
    [
        "a parseable record with only a backupId (Codex scenario)",
        () => put(`${TRANSACTION_ENTRY_PREFIX}x`, { backupId: "b-0" }),
    ],
    ["a record whose id is not its key's", () => put(`${TRANSACTION_ENTRY_PREFIX}x`, entry("other", "b-0"))],
    [
        "a record without the craft's UID",
        () => put(`${TRANSACTION_ENTRY_PREFIX}x`, { ...entry("x", "b-0"), uid: undefined }),
    ],
    ["a record with a malformed UID", () => put(`${TRANSACTION_ENTRY_PREFIX}x`, entry("x", "b-0", { uid: [1, 2] }))],
    ["a record without its time", () => put(`${TRANSACTION_ENTRY_PREFIX}x`, entry("x", "b-0", { at: undefined }))],
    [
        "a record with an unknown action",
        () => put(`${TRANSACTION_ENTRY_PREFIX}x`, entry("x", "b-0", { action: "flash" })),
    ],
    [
        "a record with malformed profiles",
        () => put(`${TRANSACTION_ENTRY_PREFIX}x`, entry("x", "b-0", { profiles: ["0"] })),
    ],
    ["null", () => put(`${TRANSACTION_ENTRY_PREFIX}x`, "null")],
    ["an array under an entry key", () => put(`${TRANSACTION_ENTRY_PREFIX}x`, [entry("x", "b-0")])],
    ["an old list that is not a list", () => put(TRANSACTION_STORAGE_KEY, { backupId: "b-0" })],
    ["an old list with one bad element", () => put(TRANSACTION_STORAGE_KEY, [{ backupId: "b-0" }])],
    [
        "an old list whose entries lack their time (earlier format)",
        () => put(TRANSACTION_STORAGE_KEY, [{ uid: UID, backupId: "b-0", stage: "write", saved: "unknown" }]),
    ],
];

describe("WP8-F08 what the transaction store cannot read, retention drops nothing for", () => {
    it.each(unreadable)("%s", (_name, fixture) => {
        const saveTwo = fillThenSaveTwo();
        fixture();
        expect(transactionStoreReads()).toBe(false);
        setActivePinia(createPinia());
        const store = saveTwo();
        const kept = store.forUid(UID).map((b) => b.id);
        for (let i = 0; i < BACKUPS_PER_CRAFT; i++) expect(kept).toContain(`b-${i}`);
        expect(kept).toEqual(expect.arrayContaining(["new-1", "new-2"]));
    });

    it("an old-format list is only read by retention, never rewritten by it", () => {
        const saveTwo = fillThenSaveTwo();
        const legacy = JSON.stringify([{ backupId: "b-0" }]);
        localStorage.setItem(TRANSACTION_STORAGE_KEY, legacy);
        saveTwo();
        expect(localStorage.getItem(TRANSACTION_STORAGE_KEY)).toBe(legacy);
    });
});

describe("WP8-F08 readable entries: their backups stay, the rest is pruned by quota", () => {
    it("an entry with unknown profile scope (slider route) is readable and keeps its backup", () => {
        const saveTwo = fillThenSaveTwo();
        put(`${TRANSACTION_ENTRY_PREFIX}tx-a`, entry("tx-a", "b-0", { profiles: null, action: "apply" }));
        expect(transactionStoreReads()).toBe(true);
        setActivePinia(createPinia());
        const store = saveTwo();
        expect(store.get("b-0")).not.toBeNull();
        // A pinned backup does not count against the quota: of the 21 unpinned the oldest goes.
        expect(store.get("b-1")).toBeNull();
        expect(store.get("b-2")).not.toBeNull();
    });

    it("several entries naming several backups keep all of them", () => {
        const saveTwo = fillThenSaveTwo();
        put(`${TRANSACTION_ENTRY_PREFIX}tx-a`, entry("tx-a", "b-0"));
        put(`${TRANSACTION_ENTRY_PREFIX}tx-b`, entry("tx-b", "b-1", { stage: "in_progress" }));
        put(`${TRANSACTION_ENTRY_PREFIX}tx-c`, entry("tx-c", "b-2", { profiles: [0, 1] }));
        expect(transactionStoreReads()).toBe(true);
        setActivePinia(createPinia());
        const store = saveTwo();
        for (const id of ["b-0", "b-1", "b-2"]) expect(store.get(id)).not.toBeNull();
    });

    it("a readable old-format list (with times) keeps the backups it names", () => {
        const saveTwo = fillThenSaveTwo();
        put(TRANSACTION_STORAGE_KEY, [{ ...entry("x", "b-0"), id: undefined }]);
        const store = saveTwo();
        expect(store.get("b-0")).not.toBeNull();
    });

    it("quota boundary: with nothing referenced exactly BACKUPS_PER_CRAFT of each kind stay", () => {
        const store = useTuneBackupStore();
        for (let i = 0; i < BACKUPS_PER_CRAFT + 1; i++) store.save(backup(`o-${i}`, false));
        for (let i = 0; i < BACKUPS_PER_CRAFT + 1; i++) store.save(backup(`t-${i}`, true));
        const kept = store.forUid(UID);
        expect(kept.filter((b) => b.stateKnown)).toHaveLength(BACKUPS_PER_CRAFT);
        expect(kept.filter((b) => !b.stateKnown)).toHaveLength(BACKUPS_PER_CRAFT);
        expect(store.get("o-0")).toBeNull();
        expect(store.get("t-0")).toBeNull();
    });
});

describe("WP8-F08 the backup list itself unreadable", () => {
    it("a save refuses rather than overwrite (and so delete) what it could not read", () => {
        localStorage.setItem(BACKUP_STORAGE_KEY, "[{broken");
        const store = useTuneBackupStore();
        expect(store.save(backup("n", true))).toBe(false);
        expect(localStorage.getItem(BACKUP_STORAGE_KEY)).toBe("[{broken");
    });

    it("a list that is not an array of backups is not overwritten either", () => {
        localStorage.setItem(BACKUP_STORAGE_KEY, JSON.stringify({ id: "x" }));
        const store = useTuneBackupStore();
        expect(store.save(backup("n", true))).toBe(false);
        expect(localStorage.getItem(BACKUP_STORAGE_KEY)).toBe(JSON.stringify({ id: "x" }));
    });
});

describe("Codex review of F08: moving the old list never overwrites an entry", () => {
    const UID2: [number, number, number] = [7, 7, 7];

    it("two old entries with the same id: unreadable, nothing moved, both crafts stay blocked", () => {
        const legacy = JSON.stringify([entry("x", "bk-1"), { ...entry("x", "bk-2"), uid: UID2 }]);
        localStorage.setItem(TRANSACTION_STORAGE_KEY, legacy);
        const states = useFcTransactionStore();
        expect(states.unreadable).toBe(true);
        expect(states.blocks(UID).length).toBeGreaterThan(0);
        expect(states.blocks(UID2).length).toBeGreaterThan(0);
        expect(localStorage.getItem(TRANSACTION_STORAGE_KEY)).toBe(legacy);
        expect(localStorage.getItem(`${TRANSACTION_ENTRY_PREFIX}x`)).toBeNull();
    });

    it("an old entry whose key already holds a different entry: unreadable, the stored one kept", () => {
        const stored = JSON.stringify(entry("x", "bk-new"));
        localStorage.setItem(`${TRANSACTION_ENTRY_PREFIX}x`, stored);
        localStorage.setItem(TRANSACTION_STORAGE_KEY, JSON.stringify([entry("x", "bk-old")]));
        const states = useFcTransactionStore();
        expect(states.unreadable).toBe(true);
        expect(localStorage.getItem(`${TRANSACTION_ENTRY_PREFIX}x`)).toBe(stored);
    });

    it("an old entry already moved once (same content at its key) still moves: readable, one entry", () => {
        const e = { ...entry("x", "bk-1") };
        localStorage.setItem(`${TRANSACTION_ENTRY_PREFIX}x`, JSON.stringify({ ...e, id: "x" }));
        localStorage.setItem(TRANSACTION_STORAGE_KEY, JSON.stringify([e]));
        const states = useFcTransactionStore();
        expect(states.unreadable).toBe(false);
        expect(states.forUid(UID)).toHaveLength(1);
        expect(localStorage.getItem(TRANSACTION_STORAGE_KEY)).toBeNull();
    });

    it("the read-only check never reports 'resolved' while the transaction storage is unreadable", async () => {
        localStorage.setItem(`${TRANSACTION_ENTRY_PREFIX}x`, JSON.stringify(entry("x", "b-0", { at: undefined })));
        const result = await checkTransactionState();
        expect(result.resolved).toBe(false);
        expect(result.reasons).toEqual(["state:transaction_storage_unreadable"]);
    });
});
