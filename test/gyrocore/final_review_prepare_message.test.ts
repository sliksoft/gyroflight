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
 * Codex final review F-03: an attempt stopped before its first SET (stage "prepare") said "the
 * flight controller holds exactly the backed-up values". After a PID profile switch before the
 * first SET the active profile holds other values (roll P 40, backup 56), and after a disconnect
 * nothing was read back at all. The panel now says what the attempt did (no SET, no EEPROM write),
 * that the current configuration was not re-verified, which profile became active, and that the
 * backup, with its profile, stays available.
 *
 * The panel renders the real English locale here (not keys), so the sentences themselves are
 * checked; the firmware harness runs the real write route.
 */

import { createApp, h } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FirmwareFc } from "./harness/mspFirmware";
import en from "../../src/gyroflight/locales/en.json";

const mocks = vi.hoisted(() => ({
    fc: undefined as unknown as FirmwareFc,
    after: null as null | ((code: number) => void),
}));
const text = vi.hoisted(() => (messages: Record<string, { message: string }>, key: string, args?: unknown[]) => {
    const m = messages[key]?.message ?? key;
    return (args ?? []).reduce<string>((s, a, i) => s.replaceAll(`$${i + 1}`, String(a)), m);
});

vi.mock("../../src/js/msp", () => ({
    default: {
        promise: vi.fn(async (code: number, data?: number[]) => {
            const r = await (await import("./harness/mspFirmware")).firmwarePromise(mocks.fc, code, data);
            mocks.after?.(code);
            return r;
        }),
    },
}));
// The write authority's steps other than the release contract (writeAuthority.ts), released.
vi.mock("@/gyrocore/releaseGate/analysisBinding", async () =>
    (await import("./harness/analysisBindingRelease")).releasedAnalysisBinding(),
);
vi.mock("@/gyrocore/safety/authorize", async () => (await import("./harness/safetyRelease")).releasedSafety());
vi.mock("@/gyrocore/productLock/productApply", async () =>
    (await import("./harness/productRelease")).releasedProductApply(),
);
vi.mock("@/composables/useDialog", () => ({ useDialog: () => ({ showYesNo: async () => true }) }));
vi.mock("@/stores/connection", () => ({
    useConnectionStore: () => ({ connectionValid: true, virtualMode: false }),
}));
vi.mock("@/js/localization", async (importOriginal) => {
    const messages = (await import("../../src/gyroflight/locales/en.json")).default;
    return {
        ...(await importOriginal<typeof import("../../src/js/localization")>()),
        i18n: { getMessage: (key: string, args?: string[]) => text(messages, key, args) },
    };
});

import UApp from "@nuxt/ui/components/App.vue";
import MSPCodes from "../../src/js/msp/MSPCodes";
import AutotuneV2Panel from "../../src/gyrocore/components/AutotuneV2Panel.vue";
import { useAutotuneV2 } from "../../src/composables/useAutotuneV2";
import { useAutotuneV2Store, type AutotuneV2Outcome } from "../../src/gyrocore/stores/autotuneV2";
import { useTuneBackupStore } from "../../src/gyrocore/stores/tuneBackup";
import { runAutotuneV2, type AutotuneV2Result } from "../../src/gyrocore/engine/autotuneV2";
import { resetConfirmations } from "../../src/gyrocore/tuning/applyConfirmation";
import { useFlightControllerStore } from "../../src/stores/fc";
import { createFirmwareFc, FIRMWARE_WRITE_CODES, selectPidProfile } from "./harness/mspFirmware";
import { simulatedQualificationLog, syntheticLogInput } from "./harness/syntheticLog";
import { verifiedTuneAllAxesFixture } from "./harness/verifiedTuneFixture";

const messages = en as Record<string, { message: string }>;

let released: AutotuneV2Result;
beforeAll(() => {
    released = runAutotuneV2({
        primary: syntheticLogInput("e".repeat(64)),
        others: [syntheticLogInput("f".repeat(64))],
        verifiedTune: verifiedTuneAllAxesFixture(0.9, 0.7),
        // SIMULATION: a synthetic finer second flight qualifies the margins' model class.
        modelClassQualification: simulatedQualificationLog(),
        createdAt: "2026-10-23T00:00:00Z",
    });
}, 600_000);

let pinia: ReturnType<typeof createPinia>;
let unmount: (() => void) | null = null;
const flush = () => new Promise((r) => setTimeout(r, 0));
const writes = () => mocks.fc.calls.map((c) => c.code).filter((c) => FIRMWARE_WRITE_CODES.has(c));
const q = (c: Element, sel: string) => c.querySelector(sel) as HTMLElement | null;
const outcome = () => useAutotuneV2Store().outcome as Extract<AutotuneV2Outcome, { reasons: string[] }>;

async function applyAndRender(setup: (fc: FirmwareFc) => void) {
    const store = useAutotuneV2Store();
    store.result = released;
    store.state = "done";
    setup(mocks.fc);
    expect(await useAutotuneV2().confirmAndApply()).toBe("failed");
    await flush();
    return render();
}

async function render() {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const app = createApp({ render: () => h(UApp, { portal: false }, { default: () => h(AutotuneV2Panel) }) });
    app.config.globalProperties.$t = ((key: string, args?: unknown[]) => text(messages, key, args)) as never;
    app.use(pinia);
    app.mount(container);
    unmount = () => (app.unmount(), container.remove());
    await flush();
    const box = q(container, '[data-gyrocore="v2-nothing-written"]');
    expect(box).not.toBeNull();
    return { box: box!, failed: q(container, '[data-gyrocore="v2-failed"]')! };
}

/** Claims the old text made: equality with the backup, or exact values on the craft. */
const EQUALITY =
    /holds exactly|exactly the backed-up|matches the backup\b(?!\.)|equal to the backup|same as the backup/i;

beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    localStorage.clear();
    resetConfirmations();
    mocks.fc = createFirmwareFc();
    mocks.fc.profiles[1].pids[0] = [40, 60, 20];
    mocks.fc.eepromProfiles = structuredClone(mocks.fc.profiles);
    mocks.after = null;
    useFlightControllerStore().config.uid = [...mocks.fc.uid];
});
afterEach(() => {
    unmount?.();
    unmount = null;
});

describe("F-03: the prepare-stage message claims only what is known", () => {
    it("the English sentences: nothing written by this attempt, not re-verified, no equality claim", () => {
        expect(messages.gyroflightV2NothingWritten.message).toMatch(/no SET command/);
        expect(messages.gyroflightV2NothingWritten.message).toMatch(/did not write EEPROM/);
        expect(messages.gyroflightV2NothingWritten.message).not.toMatch(EQUALITY);
        expect(messages.gyroflightV2NotReverified.message).toMatch(/not read back/);
        expect(messages.gyroflightV2NotReverified.message).toMatch(
            /not verified and not confirmed to match the backup/,
        );
        expect(messages.gyroflightV2NotReverified.message).toMatch(/Another PID profile may be active/);
    });

    it("profile switch before the first SET: active profile 2 named, backup of profile 1 kept, no equality claim", async () => {
        let statusReads = 0;
        const { box, failed } = await applyAndRender((fc) => {
            mocks.after = (code) => {
                if (code === MSPCodes.MSP_STATUS_EX && ++statusReads === 4) selectPidProfile(fc, 1);
            };
        });
        // What the craft really holds: profile 1 (index) active with roll P 40; the backup has 56.
        expect(writes()).toEqual([]);
        const o = outcome();
        expect(o.stage).toBe("prepare");
        expect(o.profileSwitch ?? null).toBeNull();
        expect(o.prepareProfileSwitch).toEqual({ from: 0, to: 1 });
        const backup = useTuneBackupStore().backups.find((b) => b.id === o.backupId)!;
        expect(backup.absolute!.pidProfile).toBe(0);
        expect(mocks.fc.ram.pids[0][0]).toBe(40);
        expect(backup.absolute!.values.p_roll).not.toBe(40);

        const all = failed.textContent!;
        expect(all).not.toMatch(EQUALITY);
        expect(box.textContent).toContain(messages.gyroflightV2NothingWritten.message);
        expect(q(box, '[data-gyrocore="v2-not-reverified"]')!.textContent).toContain("not verified");
        expect(q(box, '[data-gyrocore="v2-prepare-profile"]')!.textContent!.trim()).toBe(
            "The active PID profile changed from profile 1 to profile 2 before the first write. Profile 2 was neither backed up nor written by this attempt.",
        );
        expect(q(box, '[data-gyrocore="v2-backup-kept"]')!.textContent!.trim()).toBe(
            "The backup taken before this attempt (PID profile 1) is unchanged and remains available for Restore.",
        );
        // No RAM warning: no SET was sent, so no profile can hold part of this write.
        expect(q(failed, '[data-gyrocore="v2-profile-switch"]')).toBeNull();
    }, 600_000);

    it("Restore with a profile switch before the first SET: the backup named is the one taken before the restore", async () => {
        const store = useAutotuneV2Store();
        store.result = released;
        store.state = "done";
        expect(await useAutotuneV2().confirmAndApply()).toBe("verified");
        const applied = useTuneBackupStore().backups.find((b) => b.reason === "before_absolute_apply")!;
        const writesBefore = writes().length;
        let statusReads = 0;
        mocks.after = (code) => {
            if (code === MSPCodes.MSP_STATUS_EX && ++statusReads === 4) selectPidProfile(mocks.fc, 1);
        };
        expect(await useAutotuneV2().confirmAndRestore(applied)).toBe("failed");
        expect(writes().length).toBe(writesBefore); // no SET of the restore
        const o = outcome();
        expect(o.action).toBe("restore");
        expect(o.stage).toBe("prepare");
        expect(o.prepareProfileSwitch).toEqual({ from: 0, to: 1 });
        const safety = useTuneBackupStore().backups.find((b) => b.id === o.backupId)!;
        expect(safety.reason).toBe("before_restore");
        expect(safety.id).not.toBe(applied.id);
        const { box, failed } = await render();
        expect(failed.textContent).not.toMatch(EQUALITY);
        expect(q(box, '[data-gyrocore="v2-no-set"]')).not.toBeNull();
        expect(q(box, '[data-gyrocore="v2-prepare-profile"]')!.textContent).toContain("from profile 1 to profile 2");
        expect(q(box, '[data-gyrocore="v2-backup-kept"]')!.textContent).toContain("PID profile 1");
    }, 600_000);

    it("link lost before the first SET: not re-verified, no profile claim, backup kept", async () => {
        let statusReads = 0;
        const { box, failed } = await applyAndRender(
            (fc) => (fc.disconnectWhen = (_f, code) => code === MSPCodes.MSP_STATUS_EX && ++statusReads >= 5),
        );
        expect(writes()).toEqual([]);
        expect(outcome().stage).toBe("prepare");
        expect(outcome().prepareProfileSwitch ?? null).toBeNull();
        expect(failed.textContent).not.toMatch(EQUALITY);
        expect(q(box, '[data-gyrocore="v2-not-reverified"]')!.textContent).toMatch(/not read back after this failure/);
        expect(q(box, '[data-gyrocore="v2-prepare-profile"]')).toBeNull();
        expect(q(box, '[data-gyrocore="v2-backup-kept"]')!.textContent).toContain("PID profile 1");
    }, 600_000);

    it("a failure outside the write route (no stage, no backup id): no backup sentence", async () => {
        // The shape useAutotuneV2's failure() gives an error that is not a TuneWriteError: the
        // route stopped before it took a backup, so the panel must not promise one.
        useAutotuneV2Store().result = released;
        useAutotuneV2Store().outcome = {
            status: "failed",
            action: "apply",
            reasons: ["boom"],
            stage: null,
            saved: "no",
            mismatches: [],
            changedFromBackup: null,
            backupId: null,
            message: "boom",
            at: "2026-10-23T00:00:00Z",
        };
        const { box, failed } = await render();
        expect(failed.textContent).not.toMatch(EQUALITY);
        // Outside the tracked stages a sent SET is not recorded: no "no SET was sent" claim either.
        expect(q(box, '[data-gyrocore="v2-no-set"]')).toBeNull();
        expect(q(box, '[data-gyrocore="v2-set-unrecorded"]')!.textContent!.trim()).toBe(
            messages.gyroflightV2StageUnknownWrite.message,
        );
        expect(failed.textContent).not.toContain(messages.gyroflightV2NothingWritten.message);
        expect(q(box, '[data-gyrocore="v2-not-reverified"]')).not.toBeNull();
        expect(q(box, '[data-gyrocore="v2-backup-kept"]')).toBeNull();
        expect(q(failed, '[data-gyrocore="v2-failed-backup"]')).toBeNull();
    }, 600_000);
});
