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
 * Audit WP8-F07: the read-only recovery diagnosis. It must name what is unknown, offer only the
 * in-app recoveries the routes would actually accept (fcTransactionState.coveredBy,
 * notCoveredByRestore, checkTransactionState), say "none" otherwise, and never clear, change or
 * send anything: a diagnosis is no evidence of recovery.
 */

import { createPinia, setActivePinia } from "pinia";
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    diagnoseCraft,
    diagnoseEntry,
    transactionOwnerActive,
    type DiagnosisContext,
} from "../../src/gyrocore/recovery/transactionDiagnosis";
import type { UncertainTransaction } from "../../src/gyrocore/stores/transactionRecords";
import type { TuneBackup } from "../../src/gyrocore/stores/tuneBackup";
import { BACKUP_STORAGE_KEY } from "../../src/gyrocore/stores/tuneBackup";
import { TRANSACTION_ENTRY_PREFIX, useFcTransactionStore } from "../../src/gyrocore/stores/fcTransactionState";
import { FC_WRITE_LOCK } from "../../src/composables/fcWriteGuard";
import { useFlightControllerStore } from "../../src/stores/fc";
import { serial } from "../../src/js/serial";
import UncertainStateNotice from "../../src/gyrocore/components/UncertainStateNotice.vue";

vi.mock("../../src/js/localization", () => ({ i18n: { getMessage: (key: string) => key } }));

const UID: [number, number, number] = [2, 4, 6];

const entry = (e: Partial<UncertainTransaction> = {}): UncertainTransaction => ({
    id: "tx-1",
    uid: UID,
    action: "absolute_apply",
    stage: "eeprom",
    saved: "unknown",
    backupId: "bk-1",
    profiles: [0],
    detail: "",
    at: "2026-10-24T00:00:00Z",
    ...e,
});

const backup = (id: string, b: Partial<TuneBackup> = {}): TuneBackup =>
    ({
        id,
        createdAt: "2026-10-24T00:00:00Z",
        reason: "before_absolute_apply",
        uid: UID,
        board: "B",
        firmware: "2026.6.2",
        compositeId: null,
        snapshot: {},
        absolute: { pidProfile: 0 },
        stateKnown: true,
        ...b,
    }) as TuneBackup;

const ctx = (c: Partial<DiagnosisContext> = {}): DiagnosisContext => ({
    backups: [backup("bk-1")],
    ownerActive: false,
    ...c,
});

describe("WP8-F07 what the diagnosis finds", () => {
    it("an in-progress entry with no tab running it is an orphan; no in-app recovery", () => {
        const d = diagnoseEntry(entry({ stage: "in_progress" }), ctx());
        expect(d.findings).toContain("orphaned_in_progress");
        expect(d.recovery).toEqual(["none"]);
        expect(d.nextSteps).toContain("gyroflightRecoveryStepOutside");
    });

    it("an in-progress entry while a tab holds the transaction lock: wait, never an orphan", () => {
        const d = diagnoseEntry(entry({ stage: "in_progress" }), ctx({ ownerActive: true }));
        expect(d.findings).toContain("in_progress_owner_active");
        expect(d.findings).not.toContain("orphaned_in_progress");
        expect(d.recovery).toEqual(["none"]);
        expect(d.nextSteps).toContain("gyroflightRecoveryStepWaitForOwner");
    });

    it("lock state not readable: owner unknown", () => {
        expect(diagnoseEntry(entry({ stage: "in_progress" }), ctx({ ownerActive: null })).findings).toContain(
            "in_progress_owner_unknown",
        );
    });

    it.each([
        ["backup missing", entry({ backupId: "gone", saved: "no" }), "backup_missing"],
        ["EEPROM state unknown", entry(), "eeprom_state_unknown"],
        ["saved and adjusted", entry({ saved: "yes_adjusted" }), "eeprom_saved_adjusted"],
        ["profiles unknown (slider route)", entry({ action: "apply", profiles: null }), "profile_scope_unknown"],
        ["several profiles", entry({ profiles: [0, 1] }), "profiles_several"],
        ["a profile switch seen", entry({ detail: "fc:pid_profile_changed:0->1" }), "profile_switch_seen"],
        ["an interrupted Restore", entry({ action: "absolute_restore" }), "interrupted_restore"],
    ])("%s", (_name, e, finding) => {
        expect(diagnoseEntry(e, ctx()).findings).toContain(finding);
    });
});

describe("WP8-F07 which recovery it offers: only what the routes accept", () => {
    it("ended, one profile, a trusted backup of the same route: a verified Restore", () => {
        expect(diagnoseEntry(entry(), ctx()).recovery).toEqual(["verified_restore"]);
    });

    it("no trusted backup of that route (only an unverified one): no Restore offered", () => {
        const d = diagnoseEntry(entry(), ctx({ backups: [backup("bk-1", { stateKnown: false })] }));
        expect(d.recovery).toEqual(["none"]);
    });

    it("a slider-route entry is not covered by an absolute backup", () => {
        const d = diagnoseEntry(entry({ action: "apply", profiles: [0] }), ctx());
        expect(d.recovery).not.toContain("verified_restore");
    });

    it("EEPROM not written, one profile, its backup stored: the read-only check too", () => {
        const d = diagnoseEntry(entry({ saved: "no" }), ctx());
        expect(d.recovery).toEqual(["verified_restore", "read_only_check"]);
        expect(d.nextSteps).toContain("gyroflightRecoveryStepCheck");
    });

    it("the read-only check is not offered for a profile switch or a missing backup", () => {
        expect(
            diagnoseEntry(entry({ saved: "no", detail: "fc:pid_profile_changed:0->1" }), ctx()).recovery,
        ).not.toContain("read_only_check");
        expect(diagnoseEntry(entry({ saved: "no", backupId: "gone" }), ctx()).recovery).not.toContain(
            "read_only_check",
        );
    });

    it("one entry no recovery covers takes the Restore away from the craft's other entries", () => {
        const all = diagnoseCraft([entry(), entry({ id: "tx-2", stage: "in_progress" })], ctx());
        expect(all[0].recovery).toEqual(["none"]);
        expect(all[0].findings).toContain("blocked_by_other_entry");
    });

    it("entries in two different profiles: no single Restore covers both", () => {
        const all = diagnoseCraft(
            [entry(), entry({ id: "tx-2", profiles: [1] })],
            ctx({ backups: [backup("bk-1"), backup("bk-2", { absolute: { pidProfile: 1 } as never })] }),
        );
        expect(all.every((d) => !d.recovery.includes("verified_restore"))).toBe(true);
    });
});

describe("WP8-F07 the transaction lock owner", () => {
    it("held by a page: active; released: not", async () => {
        let release!: () => void;
        let granted!: () => void;
        const held = new Promise<void>((r) => (granted = r));
        void (
            navigator as unknown as { locks: { request: (n: string, cb: () => Promise<void>) => Promise<void> } }
        ).locks.request(
            FC_WRITE_LOCK,
            () =>
                new Promise<void>((r) => {
                    release = r;
                    granted();
                }),
        );
        await held;
        expect(await transactionOwnerActive()).toBe(true);
        release();
        await new Promise((r) => setTimeout(r, 10));
        expect(await transactionOwnerActive()).toBe(false);
    });
});

describe("WP8-F07 the notice's diagnosis reads only", () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        localStorage.clear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("shows an orphan with no recovery; storage, the block and the transport are untouched", async () => {
        const stored = JSON.stringify(entry({ stage: "in_progress" }));
        localStorage.setItem(`${TRANSACTION_ENTRY_PREFIX}tx-1`, stored);
        localStorage.setItem(BACKUP_STORAGE_KEY, JSON.stringify([backup("bk-1")]));
        useFlightControllerStore().config.uid = [...UID];
        const send = vi.spyOn(serial, "send");
        const before = { ...localStorage };
        const wrapper = mount(UncertainStateNotice, {
            global: {
                mocks: { $t: (k: string) => k },
                stubs: { UButton: { template: "<button @click=\"$emit('click')\"><slot /></button>" } },
            },
        });
        await wrapper.find("[data-gyrocore='uncertain-state-diagnose']").trigger("click");
        await new Promise((r) => setTimeout(r, 20));
        const diagnosis = wrapper.find("[data-gyrocore='uncertain-state-diagnosis']");
        expect(diagnosis.exists()).toBe(true);
        expect(diagnosis.find("[data-finding='orphaned_in_progress']").exists()).toBe(true);
        expect(diagnosis.find("[data-recovery='none']").exists()).toBe(true);
        expect({ ...localStorage }).toEqual(before);
        expect(useFcTransactionStore().blocks(UID).length).toBeGreaterThan(0);
        expect(send).not.toHaveBeenCalled();
        wrapper.unmount();
    });
});
