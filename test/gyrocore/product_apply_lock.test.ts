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
 * WU3.1/WU4A: the production default with no module mocks. The product Apply
 * lock is on, and GyroCore Safety (WU4A) blocks every tune before it because
 * Gyroflight has no analysis evidence. product_apply_lock_behind_safety.test.ts
 * shows the lock still holds when Safety is released by the test harness.
 */

import { join } from "node:path";
import { createApp, h } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
};

const msp = vi.hoisted(() => ({ calls: [] as number[] }));
const picked = vi.hoisted(() => ({ bytes: new Uint8Array() as Uint8Array }));

vi.mock("../../src/js/FileSystem", () => ({
    default: {
        pickOpenFile: async () => ({ name: "lock.bbl" }),
        readFileAsBlob: async () => ({ arrayBuffer: async () => picked.bytes.slice().buffer }),
    },
}));

vi.mock("../../src/js/localization", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/js/localization")>()),
    i18n: { getMessage: (key: string) => key },
}));

vi.mock("../../src/js/msp", () => ({
    default: {
        promise: vi.fn(async (code: number) => {
            msp.calls.push(code);
            return null;
        }),
    },
}));

vi.mock("@/stores/connection", () => ({ useConnectionStore: () => ({ connectionValid: true }) }));

import UApp from "@nuxt/ui/components/App.vue";
import GainRecommendation from "../../src/components/tabs/autotune/GainRecommendation.vue";
import { useAutotune, type AnalysisResult } from "../../src/composables/useAutotune";
import { useAutotuneStore } from "../../src/stores/autotune";
import { ApplyBlockedError } from "../../src/gyrocore/chirp/applyGate";
import { PRODUCT_APPLY_PENDING, productApplyBlocks } from "../../src/gyrocore/productLock/productApply";
import { useChirpQualificationStore } from "../../src/gyrocore/stores/chirpQualification";
import { authorizeCompositeApply } from "../../src/gyrocore/tuning/authorize";
import { safetyForComposite } from "../../src/gyrocore/safety/authorize";
import { MERGE_E2E_CASES } from "./harness/mergeE2eCases";
import { qualifiedReportFor } from "./harness/qualifiedReport";
import { readJsonFile } from "./harness/fixtures";

const SENTENCE = "Apply is disabled until Gyroflight Safety validation is complete.";

beforeEach(() => {
    setActivePinia(createPinia());
    msp.calls = [];
});

describe("product Apply lock (production default)", () => {
    it("is on, with its own reason", () => {
        expect(PRODUCT_APPLY_PENDING).toBe("full_safety_engine_pending");
        expect(productApplyBlocks()).toEqual(["full_safety_engine_pending"]);
    });

    it("safe positive fixture: merge, coverage and the composite gate pass; GyroCore Safety blocks before any FC access", async () => {
        picked.bytes = MERGE_E2E_CASES.three_axis_agree();
        await useAutotune().importAndAnalyze();
        const gate = useChirpQualificationStore();
        const composite = gate.composite!;
        expect(composite.merge.status).toBe("merged");
        expect(composite.coverage.missingAxes).toEqual([]);
        expect(composite.coverage.coveredAxes).toEqual(["roll", "pitch", "yaw"]);
        expect(composite.authorized).toBe(true);
        expect(authorizeCompositeApply(gate.gateState(), composite.id, composite.final).allowed).toBe(true);

        const err = await useAutotune()
            .applyGains(composite.final!, composite.id)
            .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ApplyBlockedError);
        // Safety (WU4) decides first: no analysis evidence, so the reference fails closed.
        // The WU3 synthetic log also lacks the ff_weight / filter header lines, so the baseline is incomplete too.
        expect((err as ApplyBlockedError).reasons).toEqual([
            "safety:mechanical_hard_block",
            "safety:missing_required_analysis",
            "safety:safe_tune_candidate_blocked",
            "safety:missing_required_pid_or_filter_baseline:roll.f,pitch.f,yaw.f,dterm.lpf1_dyn_min_hz,dterm.lpf1_dyn_max_hz,dterm.lpf1_static_hz,dterm.lpf2_static_hz,gyro.lpf1_dyn_min_hz,gyro.lpf1_dyn_max_hz,gyro.lpf1_static_hz,gyro.lpf2_static_hz",
            "safety:missing_required_pid_or_filter_baseline",
        ]);
        expect(safetyForComposite(gate.gateState(), composite).status).toBe("BLOCK");
        // Not even the read: no flight-controller access at all.
        expect(msp.calls).toEqual([]);
    });

    it("the Autotune panel disables Apply and says why, without calling it a rejection", async () => {
        const PROPOSED = {
            slider_master_multiplier: 100,
            slider_pi_gain: 138,
            slider_i_gain: 100,
            slider_d_gain: 100,
            slider_feedforward_gain: 138,
            slider_dterm_filter_multiplier: 100,
        };
        const pinia = createPinia();
        setActivePinia(pinia);
        useAutotuneStore().analysisResult = {
            axes: { roll: { gains: { targetCrossover: 80, maxPhaseMargin: 60, proposed: PROPOSED } } },
            sysConfig: {},
        } as unknown as AnalysisResult;
        useChirpQualificationStore().setReport(qualifiedReportFor(PROPOSED));
        const container = document.createElement("div");
        document.body.appendChild(container);
        const app = createApp({ render: () => h(UApp, { portal: false }, { default: () => h(GainRecommendation) }) });
        app.config.globalProperties.$t = ((key: string) => key) as never;
        app.use(pinia);
        app.mount(container);
        await new Promise((r) => setTimeout(r, 0));

        const button = [...container.querySelectorAll("button")].find((b) =>
            b.textContent?.includes("autotuneApplyGains"),
        )!;
        expect(button.disabled).toBe(true);
        const lock = container.querySelector('[data-gyrocore="product-apply-locked"]');
        expect(lock?.textContent?.trim()).toBe("gyrocoreProductApplyPending");
        // The tune itself passes the composite gate: no rejection notice for it.
        expect(container.querySelector('[data-gyrocore="apply-blocked"]')).toBeNull();
        // GyroCore Safety blocks it (no analysis evidence), shown separately from the product lock.
        const safety = container.querySelector('[data-gyrocore="safety-apply-blocked"]');
        expect(safety?.getAttribute("data-status")).toBe("BLOCK");
        expect(safety?.querySelector('[data-reason="missing_required_analysis"]')).not.toBeNull();
        button.click();
        await new Promise((r) => setTimeout(r, 0));
        expect(msp.calls).toEqual([]);
        app.unmount();
        container.remove();
    });

    it("the message is the exact sentence", () => {
        const en = readJsonFile<Record<string, { message: string }>>(
            join(import.meta.dirname, "..", "..", "src", "gyroflight", "locales", "en.json"),
        );
        expect(en.gyrocoreProductApplyPending.message).toBe(SENTENCE);
    });
});
