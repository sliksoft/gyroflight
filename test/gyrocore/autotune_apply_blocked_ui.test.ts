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
 * WU2: Betaflight's Gain Recommendation panel with GyroCore's gate. A blocked
 * measurement disables Apply, says why, and a click cannot reach the action.
 */

import { createApp, h } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it, vi } from "vitest";

globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
};

const { applyGains, recomputeGains, showYesNo } = vi.hoisted(() => ({
    applyGains: vi.fn(),
    recomputeGains: vi.fn(),
    showYesNo: vi.fn(async () => true),
}));

vi.mock("@/composables/useAutotune", () => ({ useAutotune: () => ({ applyGains, recomputeGains }) }));
vi.mock("@/composables/useDialog", () => ({ useDialog: () => ({ showYesNo }) }));
vi.mock("@/stores/connection", () => ({ useConnectionStore: () => ({ connectionValid: true }) }));
// Test-only release of the product Apply lock, to test the gate behind it (product_apply_lock.test.ts tests the lock).
vi.mock("@/gyrocore/productLock/productApply", async () =>
    (await import("./harness/productRelease")).releasedProductApply(),
);
vi.mock("@/js/localization", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/js/localization")>()),
    i18n: { getMessage: (key: string) => key },
}));

import UApp from "@nuxt/ui/components/App.vue";
import GainRecommendation from "../../src/components/tabs/autotune/GainRecommendation.vue";
import type { AnalysisResult } from "../../src/composables/useAutotune";
import { useAutotuneStore } from "../../src/stores/autotune";
import { useChirpQualificationStore } from "../../src/gyrocore/stores/chirpQualification";
import { qualifiedReportFor } from "./harness/qualifiedReport";

const PROPOSED = {
    slider_master_multiplier: 100,
    slider_pi_gain: 50,
    slider_i_gain: 40,
    slider_d_gain: 100,
    slider_feedforward_gain: 25,
    slider_dterm_filter_multiplier: 50,
};

function mount(blocked: string[], withGains = true) {
    const pinia = createPinia();
    setActivePinia(pinia);
    useAutotuneStore().analysisResult = {
        axes: { roll: { gains: withGains ? { targetCrossover: 80, maxPhaseMargin: 60, proposed: PROPOSED } : null } },
        sysConfig: {},
    } as unknown as AnalysisResult;
    useChirpQualificationStore().setReport(qualifiedReportFor(PROPOSED, blocked));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const app = createApp({ render: () => h(UApp, { portal: false }, { default: () => h(GainRecommendation) }) });
    app.config.globalProperties.$t = ((key: string) => key) as never;
    app.use(pinia);
    app.mount(container);
    return { container, unmount: () => (app.unmount(), container.remove()) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const applyButton = (c: HTMLElement) =>
    [...c.querySelectorAll("button")].find((b) => b.textContent?.includes("autotuneApplyGains"))!;

describe("Apply Gains in the Autotune panel", () => {
    it("is disabled with the reasons listed when GyroCore blocks it", async () => {
        const { container, unmount } = mount(["slider_clamp_changes_direction:slider_feedforward_gain"]);
        await flush();
        const button = applyButton(container);
        expect(button.disabled).toBe(true);
        const notice = container.querySelector('[data-gyrocore="apply-blocked"]');
        expect(notice).not.toBeNull();
        expect(
            notice!.querySelector('[data-reason="slider_clamp_changes_direction:slider_feedforward_gain"]'),
        ).not.toBeNull();
        button.click();
        await flush();
        expect(showYesNo).not.toHaveBeenCalled();
        expect(applyGains).not.toHaveBeenCalled();
        unmount();
    });

    it("hides a rejected axis's gains and explains that no global tune can be applied", async () => {
        const { container, unmount } = mount(["measurement:low_coherence"], false);
        await flush();
        expect(container.querySelector("table.autotune-table")).toBeNull();
        expect(applyButton(container).disabled).toBe(true);
        const notice = container.querySelector('[data-gyrocore="apply-blocked"]');
        expect(notice?.querySelector('[data-reason="system_id_unusable"]')).not.toBeNull();
        expect(notice?.querySelector('[data-reason="measurement:low_coherence"]')).not.toBeNull();
        unmount();
    });

    it("control: an authorized global recommendation can be applied", async () => {
        const { container, unmount } = mount([]);
        await flush();
        expect(container.querySelector('[data-gyrocore="apply-blocked"]')).toBeNull();
        applyButton(container).click();
        await flush();
        await flush();
        expect(applyGains).toHaveBeenCalledWith(PROPOSED, expect.stringMatching(/^composite-log1-[0-9a-f]{8}$/));
        unmount();
    });
});
