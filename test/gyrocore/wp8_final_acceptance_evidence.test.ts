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
 * WP8 final acceptance (Codex review of c7072275..17fd4b0a, P1): recovery must never drop safety
 * evidence silently. Every absolute Restore stores a backup first, unverified while the craft's
 * state is uncertain; those must not push out the backup an open entry names or the craft's
 * trusted Restore targets. The production backup store over jsdom's localStorage.
 */

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import {
    BACKUPS_PER_CRAFT,
    TRANSACTION_KEYS_PREFIX,
    useTuneBackupStore,
    type TuneBackup,
} from "../../src/gyrocore/stores/tuneBackup";
import { TRANSACTION_ENTRY_PREFIX, TRANSACTION_STORAGE_KEY } from "../../src/gyrocore/stores/fcTransactionState";

const UID: [number, number, number] = [1, 2, 3];

function backup(id: string, stateKnown: boolean | undefined, uid = UID): TuneBackup {
    return {
        id,
        createdAt: "2026-10-24T00:00:00Z",
        reason: stateKnown ? "before_absolute_apply" : "before_restore",
        uid,
        board: "B",
        firmware: "2026.6.2",
        compositeId: null,
        snapshot: { sliders: {}, filters: {}, pids: [], advanced: {} } as unknown as TuneBackup["snapshot"],
        ...(stateKnown === undefined ? {} : { stateKnown }),
    };
}

function openEntry(id: string, backupId: string) {
    const e = {
        id,
        uid: UID,
        action: "absolute_restore",
        stage: "eeprom",
        saved: "unknown",
        backupId,
        profiles: [0],
        detail: "",
        at: "2026-10-24T00:00:00Z",
    };
    localStorage.setItem(`${TRANSACTION_ENTRY_PREFIX}${id}`, JSON.stringify(e));
}

const ids = () =>
    useTuneBackupStore()
        .forUid(UID)
        .map((b) => b.id);

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
});

describe("backup retention keeps the evidence", () => {
    it("failed recovery attempts do not push out the trusted Restore target (Codex probe)", () => {
        const store = useTuneBackupStore();
        expect(store.save(backup("target", true))).toBe(true);
        for (let i = 0; i < BACKUPS_PER_CRAFT + 5; i++) expect(store.save(backup(`recovery-${i}`, false))).toBe(true);
        expect(store.get("target")).not.toBeNull();
        expect(ids().filter((id) => id.startsWith("recovery-"))).toHaveLength(BACKUPS_PER_CRAFT);
    });

    it("the backup an open transaction entry names stays, however many backups follow", () => {
        const store = useTuneBackupStore();
        expect(store.save(backup("evidence", false))).toBe(true);
        openEntry("tx-open", "evidence");
        for (let i = 0; i < BACKUPS_PER_CRAFT + 5; i++) expect(store.save(backup(`later-${i}`, false))).toBe(true);
        expect(store.get("evidence")).not.toBeNull();
    });

    it("an entry in the earlier one-list format protects its backup too", () => {
        const store = useTuneBackupStore();
        expect(store.save(backup("evidence-v1", true))).toBe(true);
        localStorage.setItem(
            TRANSACTION_STORAGE_KEY,
            JSON.stringify([{ uid: UID, backupId: "evidence-v1", stage: "write", saved: "unknown" }]),
        );
        for (let i = 0; i < BACKUPS_PER_CRAFT + 5; i++) expect(store.save(backup(`t-${i}`, true))).toBe(true);
        expect(store.get("evidence-v1")).not.toBeNull();
    });

    it("while an entry cannot be read nothing is dropped", () => {
        const store = useTuneBackupStore();
        for (let i = 0; i < BACKUPS_PER_CRAFT; i++) expect(store.save(backup(`b-${i}`, false))).toBe(true);
        localStorage.setItem(`${TRANSACTION_ENTRY_PREFIX}broken`, "{not json");
        for (let i = 0; i < 5; i++) expect(store.save(backup(`c-${i}`, false))).toBe(true);
        expect(ids()).toHaveLength(BACKUPS_PER_CRAFT + 5);
    });

    it("unreferenced backups beyond the limit still go, oldest first (control)", () => {
        const store = useTuneBackupStore();
        for (let i = 0; i < BACKUPS_PER_CRAFT + 2; i++) expect(store.save(backup(`u-${i}`, false))).toBe(true);
        expect(ids()).toHaveLength(BACKUPS_PER_CRAFT);
        expect(store.get("u-0")).toBeNull();
        expect(store.get("u-1")).toBeNull();
    });

    it("the prefix the backup store reads covers both places fcTransactionState keeps entries", () => {
        expect(TRANSACTION_ENTRY_PREFIX.startsWith(TRANSACTION_KEYS_PREFIX)).toBe(true);
        expect(TRANSACTION_STORAGE_KEY.startsWith(TRANSACTION_KEYS_PREFIX)).toBe(true);
    });
});
