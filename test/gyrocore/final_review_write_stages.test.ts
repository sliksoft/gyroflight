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
 * Codex re-review P3-a and P3-b: what a failed absolute write tells the user.
 *
 * P3-b: a failure before the first SET (a profile / arming check, a fresh read, the link) was
 * reported as stage "write" with the craft's state unknown, as if a value might already have
 * been written. The route now tells five states apart: no SET sent ("prepare"), a SET sent with
 * an unknown result, a partial write the craft kept, a verification failure, and an unknown
 * EEPROM state.
 *
 * P3-a: a PID profile switch between the last profile check and a SET puts that block into the
 * other profile's RAM; the route catches it at the next check, but the panel only said
 * "unknown". It now names the profile that may hold the write, says that EEPROM was not
 * written, tells the user not to save, and gives the recovery (reboot so RAM reloads from EEPROM,
 * check that profile, Restore the original one if needed). The firmware is not changed: no
 * profile-bound atomic write exists, so the window itself remains.
 */

import { createApp, h } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FirmwareFc } from "./harness/mspFirmware";

const mocks = vi.hoisted(() => ({
    fc: undefined as unknown as FirmwareFc,
    showYesNo: vi.fn(async () => true),
    after: null as null | ((code: number) => void),
}));

vi.mock("../../src/js/msp", () => ({
    default: {
        promise: vi.fn(async (code: number, data?: number[]) => {
            const r = await (await import("./harness/mspFirmware")).firmwarePromise(mocks.fc, code, data);
            mocks.after?.(code);
            return r;
        }),
    },
}));
vi.mock("@/composables/useDialog", () => ({ useDialog: () => ({ showYesNo: mocks.showYesNo }) }));
vi.mock("@/stores/connection", () => ({
    useConnectionStore: () => ({ connectionValid: true, virtualMode: false }),
}));
vi.mock("@/js/localization", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/js/localization")>()),
    i18n: { getMessage: (key: string, args?: string[]) => (args?.length ? `${key}|${args.join("|")}` : key) },
}));

import UApp from "@nuxt/ui/components/App.vue";
import MSPCodes from "../../src/js/msp/MSPCodes";
import AutotuneV2Panel from "../../src/gyrocore/components/AutotuneV2Panel.vue";
import { useAutotuneV2 } from "../../src/composables/useAutotuneV2";
import { profileSwitchOf } from "../../src/composables/useTuneApply";
import { useAutotuneV2Store, type AutotuneV2Outcome } from "../../src/gyrocore/stores/autotuneV2";
import { useTuneBackupStore } from "../../src/gyrocore/stores/tuneBackup";
import { runAutotuneV2, type AutotuneV2Result } from "../../src/gyrocore/engine/autotuneV2";
import { resetConfirmations } from "../../src/gyrocore/tuning/applyConfirmation";
import { useFlightControllerStore } from "../../src/stores/fc";
import { createFirmwareFc, FIRMWARE_WRITE_CODES, profilePart, selectPidProfile } from "./harness/mspFirmware";
import { simulatedQualificationLog, syntheticLogInput } from "./harness/syntheticLog";
import { verifiedTuneAllAxesFixture } from "./harness/verifiedTuneFixture";

let released: AutotuneV2Result;
beforeAll(() => {
    released = runAutotuneV2({
        primary: syntheticLogInput("e".repeat(64)),
        others: [syntheticLogInput("f".repeat(64))],
        verifiedTune: verifiedTuneAllAxesFixture(0.9, 0.7),
        // SIMULATION: a synthetic finer second flight qualifies the margins' model class.
        modelClassQualification: simulatedQualificationLog(),
        createdAt: "2026-10-22T00:00:00Z",
    });
}, 600_000);

let pinia: ReturnType<typeof createPinia>;
let unmount: (() => void) | null = null;
const flush = () => new Promise((r) => setTimeout(r, 0));
const writes = () => mocks.fc.calls.map((c) => c.code).filter((c) => FIRMWARE_WRITE_CODES.has(c));
const q = (c: Element, sel: string) => c.querySelector(sel) as HTMLElement | null;

function mount() {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const app = createApp({ render: () => h(UApp, { portal: false }, { default: () => h(AutotuneV2Panel) }) });
    app.config.globalProperties.$t = ((key: string, args?: unknown[]) =>
        args?.length ? `${key}|${args.join("|")}` : key) as never;
    app.use(pinia);
    app.mount(container);
    unmount = () => (app.unmount(), container.remove());
    return container;
}

async function applyWith(setup: (fc: FirmwareFc) => void) {
    const store = useAutotuneV2Store();
    store.result = released;
    store.state = "done";
    setup(mocks.fc);
    const r = await useAutotuneV2().confirmAndApply();
    await flush();
    return r;
}

async function failedBox() {
    const c = mount();
    await flush();
    const box = q(c, '[data-gyrocore="v2-failed"]')!;
    expect(box).not.toBeNull();
    return box;
}
const outcome = () => useAutotuneV2Store().outcome as Extract<AutotuneV2Outcome, { reasons: string[] }>;

beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    localStorage.clear();
    resetConfirmations();
    mocks.fc = createFirmwareFc();
    mocks.fc.profiles[1].pids[0] = [40, 60, 20];
    mocks.fc.eepromProfiles = structuredClone(mocks.fc.profiles);
    mocks.showYesNo.mockClear();
    mocks.after = null;
    useFlightControllerStore().config.uid = [...mocks.fc.uid];
});
afterEach(() => {
    unmount?.();
    unmount = null;
});

describe("P3-b: the five states of a failed write", () => {
    it("link lost at the profile check before the first SET: stage prepare, nothing written, craft as backed up", async () => {
        let statusReads = 0;
        // identity (preview) 1, snapshot check 2, identity (apply) 3, snapshot check 4, pre-write check 5
        expect(
            await applyWith(
                (fc) => (fc.disconnectWhen = (_f, code) => code === MSPCodes.MSP_STATUS_EX && ++statusReads >= 5),
            ),
        ).toBe("failed");
        expect(writes()).toEqual([]);
        const o = outcome();
        expect(o.stage).toBe("prepare");
        expect(o.saved).toBe("no");
        expect(o.changedFromBackup).toEqual([]);
        expect(o.profileSwitch ?? null).toBeNull();
        const box = await failedBox();
        expect(q(box, '[data-gyrocore="v2-stage"]')!.getAttribute("data-stage")).toBe("prepare");
        expect(q(box, '[data-gyrocore="v2-nothing-written"]')).not.toBeNull();
        expect(q(box, '[data-gyrocore="v2-fc-unknown"]')).toBeNull();
        expect(q(box, '[data-gyrocore="v2-partial"]')).toBeNull();
    }, 600_000);

    it("a profile switch found before the first SET is also 'prepare': nothing written, no RAM warning", async () => {
        let statusReads = 0;
        expect(
            await applyWith((fc) => {
                mocks.after = (code) => {
                    if (code === MSPCodes.MSP_STATUS_EX && ++statusReads === 4) selectPidProfile(fc, 1);
                };
            }),
        ).toBe("failed");
        expect(writes()).toEqual([]);
        const o = outcome();
        expect(o.stage).toBe("prepare");
        expect(o.message).toMatch(/fc:pid_profile_changed:0->1/);
        expect(o.profileSwitch ?? null).toBeNull();
        const box = await failedBox();
        expect(q(box, '[data-gyrocore="v2-nothing-written"]')).not.toBeNull();
        expect(q(box, '[data-gyrocore="v2-profile-switch"]')).toBeNull();
    }, 600_000);

    it("link lost on the first SET itself: stage write, result unknown (the SET-sent wording), not 'nothing written'", async () => {
        expect(await applyWith((fc) => (fc.disconnectWhen = (_f, code) => code === MSPCodes.MSP_SET_PID))).toBe(
            "failed",
        );
        const o = outcome();
        expect(o.stage).toBe("write");
        expect(o.changedFromBackup).toBeNull();
        const box = await failedBox();
        expect(q(box, '[data-gyrocore="v2-nothing-written"]')).toBeNull();
        const unknown = q(box, '[data-gyrocore="v2-fc-unknown"]')!;
        expect(unknown.textContent).toContain("gyroflightV2SetResultUnknown");
    }, 600_000);

    it("a partial write the craft kept: stage write with the differing values", async () => {
        expect(await applyWith((fc) => fc.errorAfterDecode.add(MSPCodes.MSP_SET_PID))).toBe("failed");
        const o = outcome();
        expect(o.stage).toBe("write");
        expect(o.changedFromBackup!.length).toBeGreaterThan(0);
        const box = await failedBox();
        expect(q(box, '[data-gyrocore="v2-partial"]')).not.toBeNull();
        expect(q(box, '[data-gyrocore="v2-fc-unknown"]')).toBeNull();
    }, 600_000);

    it("link lost during verification: stage verify, unknown (the current-state wording)", async () => {
        expect(await applyWith((fc) => (fc.disconnectWhen = (f) => f.writes >= 1))).toBe("failed");
        const o = outcome();
        expect(o.stage).toBe("verify");
        const box = await failedBox();
        expect(q(box, '[data-gyrocore="v2-fc-unknown"]')!.textContent).toContain("gyroflightV2CurrentUnknown");
    }, 600_000);

    it("EEPROM write times out: stage eeprom, saved unknown", async () => {
        expect(await applyWith((fc) => (fc.faults[MSPCodes.MSP_EEPROM_WRITE] = "timeout"))).toBe("failed");
        const o = outcome();
        expect(o.stage).toBe("eeprom");
        expect(o.saved).toBe("unknown");
        const box = await failedBox();
        expect(box.getAttribute("data-saved")).toBe("unknown");
    }, 600_000);
});

describe("P3-a: a profile switch after a SET names the profile that may hold it", () => {
    it("profileSwitchOf reads the route's own reason", () => {
        expect(profileSwitchOf("Tune write failed at verify (saved: no): fc:pid_profile_changed:0->1")).toEqual({
            from: 0,
            to: 1,
        });
        expect(profileSwitchOf("fc:pid_profile_changed:2->?")).toEqual({ from: 2, to: null });
        expect(profileSwitchOf("MSP timeout")).toBeNull();
    });

    it("switch right after the fresh read that precedes MSP_SET_PID: the SET lands in profile 1; the panel says so", async () => {
        let pidReads = 0;
        const profile1Before = structuredClone(mocks.fc.profiles[1]);
        expect(
            await applyWith((fc) => {
                mocks.after = (code) => {
                    // preview snapshot 1, apply snapshot 2, fresh read before SET_PID 3
                    if (code === MSPCodes.MSP_PID && ++pidReads === 3) selectPidProfile(fc, 1);
                };
            }),
        ).toBe("failed");
        // The write went into profile 1's RAM; profile 0 and every EEPROM copy are unchanged.
        expect(writes()).toEqual([MSPCodes.MSP_SET_PID]);
        expect(mocks.fc.pidProfile).toBe(1);
        expect(mocks.fc.ram.pids[0]).not.toEqual(profile1Before.pids[0]);
        expect(mocks.fc.profiles[0].pids[0]).toEqual([56, 79, 30]);
        expect(mocks.fc.eepromProfiles[1]).toEqual(profile1Before);
        const o = outcome();
        expect(o.stage).toBe("verify");
        expect(o.saved).toBe("no");
        expect(o.changedFromBackup).toBeNull();
        expect(o.profileSwitch).toEqual({ from: 0, to: 1 });
        const box = await failedBox();
        const warn = q(box, '[data-gyrocore="v2-profile-switch"]')!;
        expect(warn).not.toBeNull();
        expect(warn.getAttribute("data-from")).toBe("0");
        expect(warn.getAttribute("data-to")).toBe("1");
        // Which profile (1-based, as the interface shows them), EEPROM not written, do not save, recovery.
        expect(warn.textContent).toContain("gyroflightV2ProfileSwitchRam|2|1");
        expect(warn.textContent).toContain("gyroflightV2ProfileSwitchNotSaved");
        expect(warn.textContent).toContain("gyroflightV2ProfileSwitchNoSave");
        expect(warn.textContent).toContain("gyroflightV2ProfileSwitchRecovery|2|1");
        // The backup is there for profile 0 once the user is back on it.
        const backup = useTuneBackupStore().backups.find((b) => b.reason === "before_absolute_apply")!;
        expect(backup.absolute?.pidProfile).toBe(0);
        expect(q(box, '[data-gyrocore="v2-failed-backup"]')!.textContent).toContain(backup.id);
    }, 600_000);

    it("the same switch during Restore is reported the same way", async () => {
        // A verified Apply first, so there is a backup to restore.
        expect(await applyWith(() => undefined)).toBe("verified");
        const backup = useTuneBackupStore().backups.find((b) => b.reason === "before_absolute_apply")!;
        let pidReads = 0;
        mocks.after = (code) => {
            // restore: snapshot (preview) 1, snapshot (restore) 2, fresh read before SET_PID 3
            if (code === MSPCodes.MSP_PID && ++pidReads === 3) selectPidProfile(mocks.fc, 1);
        };
        expect(await useAutotuneV2().confirmAndRestore(backup)).toBe("failed");
        await flush();
        const o = outcome();
        expect(o.action).toBe("restore");
        expect(o.profileSwitch).toEqual({ from: 0, to: 1 });
        expect(o.saved).toBe("no");
        const box = await failedBox();
        expect(q(box, '[data-gyrocore="v2-profile-switch"]')!.textContent).toContain(
            "gyroflightV2ProfileSwitchRam|2|1",
        );
        expect(profilePart(mocks.fc.ram).pids[0]).not.toEqual([40, 60, 20]);
    }, 600_000);
});
