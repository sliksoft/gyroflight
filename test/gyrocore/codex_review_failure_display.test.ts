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
 * Codex review P2-03: when an Apply fails, the panel must say in which phase, why, whether
 * anything was saved, and what the flight controller holds now: the values that differ from
 * the backup, or explicitly that the current configuration is unknown. The failures are real:
 * the link drops in the simulated FC while useAutotuneV2.confirmAndApply runs; then the panel is
 * mounted on that outcome. ($t returns the key, i18n.getMessage "key|args".)
 */

import { createApp, h } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FirmwareFc } from "./harness/mspFirmware";

const mocks = vi.hoisted(() => ({
    fc: undefined as unknown as FirmwareFc,
    showYesNo: vi.fn(async () => true),
}));

vi.mock("../../src/js/msp", () => ({
    default: {
        promise: vi.fn(async (code: number, data?: number[]) =>
            (await import("./harness/mspFirmware")).firmwarePromise(mocks.fc, code, data),
        ),
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
import { useAutotuneV2Store } from "../../src/gyrocore/stores/autotuneV2";
import { runAutotuneV2, type AutotuneV2Result } from "../../src/gyrocore/engine/autotuneV2";
import { resetConfirmations } from "../../src/gyrocore/tuning/applyConfirmation";
import { useFlightControllerStore } from "../../src/stores/fc";
import { createFirmwareFc, FIRMWARE_WRITE_CODES } from "./harness/mspFirmware";
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

/** Apply through the composable, the way the button does it, with the FC as configured. */
async function applyWith(setup: (fc: FirmwareFc) => void) {
    const store = useAutotuneV2Store();
    store.result = released;
    store.state = "done";
    setup(mocks.fc);
    const r = await useAutotuneV2().confirmAndApply();
    await flush();
    return r;
}

beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    localStorage.clear();
    resetConfirmations();
    mocks.fc = createFirmwareFc();
    mocks.showYesNo.mockClear();
    useFlightControllerStore().config.uid = [...mocks.fc.uid];
});
afterEach(() => {
    unmount?.();
    unmount = null;
});

describe("P2-03: a failed Apply says where, why, what is saved and what the FC holds now", () => {
    it("disconnect while writing: phase, cause, nothing saved, current configuration unknown", async () => {
        expect(await applyWith((fc) => (fc.disconnectWhen = (_f, code) => code === MSPCodes.MSP_SET_PID))).toBe(
            "failed",
        );
        expect(mocks.fc.writes).toBe(0); // the SET never reached the craft
        const c = mount();
        await flush();
        const box = q(c, '[data-gyrocore="v2-failed"]')!;
        expect(box).not.toBeNull();
        expect(q(c, '[data-gyrocore="v2-verified"]')).toBeNull();
        expect(q(box, '[data-gyrocore="v2-stage"]')!.getAttribute("data-stage")).toBe("write");
        expect(q(box, '[data-gyrocore="v2-stage"]')!.textContent).toContain("gyroflightV2Stage_write");
        expect(q(box, '[data-gyrocore="v2-cause"]')!.textContent).toContain("MSP request while disconnected");
        expect(box.getAttribute("data-saved")).toBe("no");
        expect(box.textContent).toContain("gyroflightV2Saved_no");
        const unknown = q(box, '[data-gyrocore="v2-fc-unknown"]')!;
        expect(unknown).not.toBeNull();
        // The SET was sent and its result is unknown (final review P3-b wording for stage "write").
        expect(unknown.textContent).toContain("gyroflightV2SetResultUnknown");
        expect(q(box, '[data-gyrocore="v2-partial"]')).toBeNull();
    }, 600_000);

    it("disconnect after the write, during verification: phase verify, written but unverified, unknown", async () => {
        expect(await applyWith((fc) => (fc.disconnectWhen = (f) => f.writes >= 1))).toBe("failed");
        expect(writes()).toEqual([MSPCodes.MSP_SET_PID]);
        const c = mount();
        await flush();
        const box = q(c, '[data-gyrocore="v2-failed"]')!;
        expect(q(box, '[data-gyrocore="v2-stage"]')!.getAttribute("data-stage")).toBe("verify");
        expect(q(box, '[data-gyrocore="v2-fc-unknown"]')).not.toBeNull();
        expect(box.getAttribute("data-saved")).toBe("no");
    }, 600_000);

    it("a refused write with the FC still readable: the values now different from the backup are listed", async () => {
        expect(await applyWith((fc) => (fc.faults[MSPCodes.MSP_SET_PID] = "unsupported"))).toBe("failed");
        const c = mount();
        await flush();
        const box = q(c, '[data-gyrocore="v2-failed"]')!;
        expect(q(box, '[data-gyrocore="v2-stage"]')!.getAttribute("data-stage")).toBe("write");
        expect(q(box, '[data-gyrocore="v2-fc-unknown"]')).toBeNull();
        // Nothing was accepted: the FC still holds the backup, and the panel says so.
        expect(q(box, '[data-gyrocore="v2-fc-as-backup"]')).not.toBeNull();
    }, 600_000);

    it("a partial write that the FC kept: the differing values are shown", async () => {
        expect(
            await applyWith((fc) => {
                fc.errorAfterDecode.add(MSPCodes.MSP_SET_PID); // stored, then MSP_RESULT_ERROR
            }),
        ).toBe("failed");
        const c = mount();
        await flush();
        const box = q(c, '[data-gyrocore="v2-failed"]')!;
        const partial = q(box, '[data-gyrocore="v2-partial"]')!;
        expect(partial).not.toBeNull();
        expect(partial.textContent).toMatch(/pid:p_roll 56→\d+/);
        expect(q(box, '[data-gyrocore="v2-fc-unknown"]')).toBeNull();
    }, 600_000);
});
