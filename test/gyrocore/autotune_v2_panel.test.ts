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
 * AutotuneV2Panel.vue with real engine results (synthetic log) and the absolute route on the
 * byte-level Betaflight simulation: what each part shows, that nothing unvalidated can be
 * applied, that the read-only preview writes nothing, and that Apply writes only after the
 * user's yes in a dialog listing every change; a "no" writes nothing; Restore asks too.
 */

import { createApp, h } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FirmwareFc } from "./harness/mspFirmware";

const mocks = vi.hoisted(() => ({
    fc: undefined as unknown as FirmwareFc,
    showYesNo: vi.fn(),
    connected: true,
    virtual: false,
}));

vi.mock("../../src/js/msp", () => ({
    default: {
        promise: vi.fn(async (code: number, data?: number[]) =>
            (await import("./harness/mspFirmware")).firmwarePromise(mocks.fc, code, data),
        ),
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
vi.mock("@/composables/useDialog", () => ({ useDialog: () => ({ showYesNo: mocks.showYesNo }) }));
vi.mock("@/stores/connection", () => ({
    useConnectionStore: () => ({ connectionValid: mocks.connected, virtualMode: mocks.virtual }),
}));
vi.mock("@/js/localization", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/js/localization")>()),
    i18n: { getMessage: (key: string, args?: string[]) => (args?.length ? `${key}|${args.join("|")}` : key) },
}));

import UApp from "@nuxt/ui/components/App.vue";
import MSPCodes from "../../src/js/msp/MSPCodes";
import AutotuneV2Panel from "../../src/gyrocore/components/AutotuneV2Panel.vue";
import { useAutotuneV2Store } from "../../src/gyrocore/stores/autotuneV2";
import { runAutotuneV2, type AutotuneV2Result } from "../../src/gyrocore/engine/autotuneV2";
import { resetConfirmations } from "../../src/gyrocore/tuning/applyConfirmation";
import { useFlightControllerStore } from "../../src/stores/fc";
import { createFirmwareFc, FIRMWARE_WRITE_CODES } from "./harness/mspFirmware";
import { runSoftwareQualifiedAutotuneV2 } from "./harness/softwareQualifiedResult";
import { syntheticLogInput } from "./harness/syntheticLog";
import { verifiedTuneAllAxesFixture } from "./harness/verifiedTuneFixture";

let blocked: AutotuneV2Result;
let released: AutotuneV2Result;

beforeAll(() => {
    const primary = syntheticLogInput("e".repeat(64));
    const repeat = syntheticLogInput("f".repeat(64));
    blocked = runAutotuneV2({ primary, others: [repeat], verifiedTune: null, createdAt: "2026-10-22T00:00:00Z" });
    // SIMULATION: software-only VALIDATED evidence (no fictitious qualification flight).
    released = runSoftwareQualifiedAutotuneV2({
        primary,
        others: [repeat],
        // A measured gain reduction from the logged tune: its segment carries the released proposal.
        verifiedTune: verifiedTuneAllAxesFixture(0.9, 0.7),
        createdAt: "2026-10-22T00:00:00Z",
    });
}, 600_000);

let pinia: ReturnType<typeof createPinia>;
let unmount: (() => void) | null = null;
const flush = () => new Promise((r) => setTimeout(r, 0));
const writes = () => mocks.fc.calls.map((c) => c.code).filter((c) => FIRMWARE_WRITE_CODES.has(c));
const q = (c: Element, sel: string) => c.querySelector(sel) as HTMLElement | null;

function mount(result: AutotuneV2Result | null) {
    const store = useAutotuneV2Store();
    store.result = result;
    store.state = result ? "done" : "idle";
    const container = document.createElement("div");
    document.body.appendChild(container);
    const app = createApp({ render: () => h(UApp, { portal: false }, { default: () => h(AutotuneV2Panel) }) });
    app.config.globalProperties.$t = ((key: string) => key) as never;
    app.use(pinia);
    app.mount(container);
    unmount = () => (app.unmount(), container.remove());
    return container;
}

beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    localStorage.clear();
    resetConfirmations();
    mocks.fc = createFirmwareFc();
    mocks.showYesNo.mockReset();
    mocks.connected = true;
    mocks.virtual = false;
    useFlightControllerStore().config.uid = [...mocks.fc.uid];
});
afterEach(() => {
    unmount?.();
    unmount = null;
});

describe("AutotuneV2Panel", () => {
    it("without an imported CHIRP file: nothing to calculate", async () => {
        const c = mount(null);
        await flush();
        expect(q(c, '[data-gyrocore="v2-no-source"]')).not.toBeNull();
        expect((q(c, '[data-gyrocore="v2-calculate"]') as HTMLButtonElement).disabled).toBe(true);
    });

    it("shows every part's status and missing measurement; unvalidated values are never applied", async () => {
        const c = mount(blocked);
        await flush();
        expect(c.querySelectorAll('[data-gyrocore="v2-parts"] tbody tr')).toHaveLength(9);
        const ff = q(c, '[data-part="feedforward"]')!;
        expect(ff.getAttribute("data-state")).toBe("BLOCKED");
        expect(ff.textContent).toContain("acro_stick_flight");
        expect(q(c, '[data-part="independent_gain_prediction"]')!.getAttribute("data-state")).toBe("BLOCKED");
        // Compare lists every proposed value, none of them marked as applied.
        const items = c.querySelectorAll('[data-gyrocore="v2-compare"] tbody tr');
        expect(items.length).toBe(blocked.proposal!.items.length);
        for (const row of items) expect(row.textContent).toContain("✗");
        expect(q(c, '[data-condition="independent_validation"]')!.getAttribute("data-ok")).toBe("no");
        const apply = q(c, '[data-gyrocore="v2-apply"]') as HTMLButtonElement;
        expect(apply.disabled).toBe(true);
        apply.click();
        await flush();
        expect(mocks.showYesNo).not.toHaveBeenCalled();
        expect(mocks.fc.calls).toEqual([]);
    });

    it("the read-only preview reads the craft and writes nothing", async () => {
        const c = mount(blocked);
        await flush();
        (q(c, '[data-gyrocore="v2-preview"]') as HTMLButtonElement).click();
        for (let i = 0; i < 20 && !q(c, '[data-gyrocore="v2-preview-result"]'); i++) await flush();
        expect(q(c, '[data-gyrocore="v2-preview-result"]')!.getAttribute("data-status")).toBe("ok");
        expect(writes()).toEqual([]);
        expect(mocks.fc.calls.length).toBeGreaterThan(0);
    });

    it("Apply asks with every change listed; no writes nothing; yes writes, verifies, saves; Restore asks too", async () => {
        const c = mount(released);
        await flush();
        const apply = q(c, '[data-gyrocore="v2-apply"]') as HTMLButtonElement;
        expect(apply.disabled).toBe(false);

        mocks.showYesNo.mockResolvedValueOnce(false);
        apply.click();
        for (let i = 0; i < 30 && !mocks.showYesNo.mock.calls.length; i++) await flush();
        await flush();
        expect(mocks.showYesNo).toHaveBeenCalledTimes(1);
        const html = String(mocks.showYesNo.mock.calls[0][1]);
        for (const key of Object.keys(released.releasableProposal!.change)) expect(html).toContain(key);
        expect(writes()).toEqual([]);

        mocks.showYesNo.mockResolvedValueOnce(true);
        apply.click();
        for (let i = 0; i < 60 && !q(c, '[data-gyrocore="v2-verified"]'); i++) await flush();
        expect(q(c, '[data-gyrocore="v2-verified"]')).not.toBeNull();
        expect(writes().at(-1)).toBe(MSPCodes.MSP_EEPROM_WRITE);
        for (const [k, v] of Object.entries(released.releasableProposal!.change)) {
            const [term, axis] = [k.split("_")[0], k.split("_").slice(1).join("_")];
            const row = ["roll", "pitch", "yaw"].indexOf(axis);
            if (["p", "i", "d"].includes(term) && row >= 0)
                expect(mocks.fc.eeprom.pids[row]["pid".indexOf(term)], k).toBe(v);
        }

        await flush();
        const restore = q(c, '[data-gyrocore="v2-restore"]') as HTMLButtonElement;
        expect(restore).not.toBeNull();
        mocks.showYesNo.mockResolvedValueOnce(true);
        const before = mocks.fc.calls.length;
        restore.click();
        for (let i = 0; i < 60 && mocks.showYesNo.mock.calls.length < 3; i++) await flush();
        for (
            let i = 0;
            i < 60 && mocks.fc.calls.slice(before).filter((x) => x.code === MSPCodes.MSP_EEPROM_WRITE).length === 0;
            i++
        )
            await flush();
        expect(mocks.showYesNo).toHaveBeenCalledTimes(3);
        expect(mocks.fc.eeprom.pids[0]).toEqual([56, 79, 30]);
    });

    it("a write that ended unverified: the panel names it, Apply is not offered, a Restore clears it (F-03)", async () => {
        const c = mount(released);
        await flush();
        const apply = q(c, '[data-gyrocore="v2-apply"]') as HTMLButtonElement;
        expect(q(c, '[data-gyrocore="uncertain-state"]')).toBeNull();
        // The firmware saves, its answer arrives corrupt: the saved state is unknown.
        mocks.fc.corruptReplyAfterExecute = new Set([MSPCodes.MSP_EEPROM_WRITE]);
        mocks.showYesNo.mockResolvedValue(true);
        apply.click();
        for (let i = 0; i < 60 && !q(c, '[data-gyrocore="uncertain-state"]'); i++) await flush();
        mocks.fc.corruptReplyAfterExecute = new Set();
        const notice = q(c, '[data-gyrocore="uncertain-state"]')!;
        expect(notice).not.toBeNull();
        expect(notice.textContent).toContain("gyroflightUncertainEntry|");
        expect(notice.textContent).toContain("|eeprom|unknown|");
        expect(apply.disabled).toBe(true);
        // A read-back cannot show what EEPROM holds: the check says so and the notice stays.
        (q(c, '[data-gyrocore="uncertain-state-check"]') as HTMLButtonElement).click();
        for (let i = 0; i < 60 && !q(c, '[data-gyrocore="uncertain-state-why"]'); i++) await flush();
        expect(q(c, '[data-gyrocore="uncertain-state-why"]')!.textContent).toContain(
            "eeprom_state_unknown_restore_required",
        );
        // Restore (verified and saved) makes the state known: the notice goes, Apply is offered again.
        const restore = q(c, '[data-gyrocore="v2-restore"]') as HTMLButtonElement;
        restore.click();
        for (let i = 0; i < 80 && q(c, '[data-gyrocore="uncertain-state"]'); i++) await flush();
        expect(q(c, '[data-gyrocore="uncertain-state"]')).toBeNull();
        expect(apply.disabled).toBe(false);
    });

    it("in virtual mode neither preview nor Apply is offered", async () => {
        mocks.virtual = true;
        const c = mount(released);
        await flush();
        expect((q(c, '[data-gyrocore="v2-preview"]') as HTMLButtonElement).disabled).toBe(true);
        expect((q(c, '[data-gyrocore="v2-apply"]') as HTMLButtonElement).disabled).toBe(true);
    });

    it("margin evidence: MODEL_CONDITIONAL bounds are never green and say what they assume and need (F-02)", async () => {
        const c = mount(blocked);
        await flush();
        const rows = c.querySelectorAll('[data-gyrocore="v2-margins"] tbody tr');
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
            expect(row.getAttribute("data-evidence")).toBe("MODEL_CONDITIONAL");
            expect(row.getAttribute("data-state")).toBe("NOT_VALIDATED");
            expect(row.querySelector(".text-green-500")).toBeNull();
            // Bounds, the measured values, and the frequency resolution.
            expect(row.textContent).toContain("gyroflightV2Measured");
            expect(row.textContent).toContain("0.50 Hz");
        }
        const roll = q(c, '[data-gyrocore="v2-margin-evidence"] [data-axis="roll"]')!;
        expect(roll.textContent).toContain("gyroflightV2EvidenceRange|roll|2.0|100.0|0.50");
        expect(roll.textContent).toContain("gyroflightV2EvidenceConditional|2.26");
        expect(roll.textContent).toContain("no_loop_feature_narrower_than:2.26Hz");
        expect(roll.textContent).toContain(
            "gyroflightV2EvidenceNeeded|chirp_finer_resolution_model_class_qualification",
        );
        expect(q(c, '[data-gyrocore="v2-evidence-legend"]')).not.toBeNull();
    });

    it("margin evidence: a qualified model shows VALIDATED in green with its qualification (SIMULATION)", async () => {
        const c = mount(released);
        await flush();
        const roll = q(c, '[data-gyrocore="v2-margins"] tbody tr[data-axis="roll"]')!;
        expect(roll.getAttribute("data-evidence")).toBe("VALIDATED");
        expect(roll.querySelector(".text-green-500")).not.toBeNull();
        const detail = q(c, '[data-gyrocore="v2-margin-evidence"] [data-axis="roll"]')!;
        // SIMULATED_QUALIFICATION_SHA is "5".repeat(64); the panel shows the first 8 hex chars.
        expect(detail.textContent).toContain("gyroflightV2EvidenceQualified|55555555|0.100|0.451");
        expect(detail.textContent).not.toContain("gyroflightV2EvidenceNeeded");
    });
});
