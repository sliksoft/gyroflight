/*
 * The step-response card through the normal Autotune import (useAutotune().importAndAnalyze, the
 * Import button's action): an ordinary Acro file without CHIRP reaches the card, which shows the
 * status, the curves, the windows, manoeuvres and rejections, and the A/B with or without a delta.
 */
import { createApp, h } from "vue";
import { createPinia, setActivePinia, type Pinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
};

const picked = vi.hoisted(() => ({ bytes: new Uint8Array() as Uint8Array, name: "test.bbl" }));
/** Every object-form call of getMessage, to check the card turns i18next escaping off. */
const objectCalls = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock("../../src/js/FileSystem", () => ({
    default: {
        pickOpenFile: async () => ({ name: picked.name }),
        readFileAsBlob: async () => ({ arrayBuffer: async () => picked.bytes.slice().buffer }),
    },
}));

vi.mock("../../src/js/localization", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/js/localization")>()),
    i18n: {
        // Positional arrays, or the card's object form { "1": …, "2": …, interpolation } (no escaping)
        getMessage: (key: string, args?: string[] | Record<string, unknown>) => {
            // the card's positional object form ({ "1": … }); other callers pass named i18next values
            if (args && !Array.isArray(args) && "1" in args) objectCalls.push(args);
            const list = Array.isArray(args)
                ? args
                : Object.keys(args ?? {})
                      .filter((k) => /^\d+$/.test(k))
                      .sort((a, b) => Number(a) - Number(b))
                      .map((k) => String((args as Record<string, unknown>)[k]));
            return list.length ? `${key}|${list.join("|")}` : key;
        },
    },
}));

import UApp from "@nuxt/ui/components/App.vue";
import { useAutotune } from "../../src/composables/useAutotune";
import { useAutotuneStore } from "../../src/stores/autotune";
import StepResponseCard from "../../src/gyrocore/components/StepResponseCard.vue";
import { useStepResponseStore } from "../../src/gyrocore/stores/stepResponse";
import { acroLog, ANGLE_FLAG, ARM_FLAG } from "./harness/stepBbl";

let pinia: Pinia;
beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
});

async function importFile(bytes: Uint8Array, name: string) {
    picked.bytes = bytes;
    picked.name = name;
    await useAutotune().importAndAnalyze();
}

const flush = async () => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 10));
};

async function mount() {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const app = createApp({ render: () => h(UApp, { portal: false }, { default: () => h(StepResponseCard) }) });
    app.config.globalProperties.$t = ((key: string) => key) as never;
    app.use(pinia);
    app.mount(container);
    const store = useStepResponseStore();
    for (let i = 0; i < 100 && (store.pending || store.analyzing); i++) await flush();
    await flush();
    return { container, unmount: () => (app.unmount(), container.remove()) };
}

const q = (c: HTMLElement, sel: string) => c.querySelector(sel) as HTMLElement | null;

describe("normal import → step-response card", () => {
    it("a file without CHIRP: the CHIRP route says so, the file is offered to the card", async () => {
        await importFile(acroLog({ seconds: 20, seed: 1, startUs: 4_000_000 }), "acro-a.bbl");
        expect(useAutotuneStore().analysisState).toBe("error");
        expect(useAutotuneStore().errorMessage).toContain("gyrocoreChirpNoChirpError");
        expect(useStepResponseStore().files).toHaveLength(1);
    });

    it("shows the log, its status per axis and threshold, curves, windows, manoeuvres and rejections", async () => {
        await importFile(acroLog({ seconds: 20, seed: 1, startUs: 4_000_000 }), "acro-a.bbl");
        const { container, unmount } = await mount();
        const item = q(container, "[data-gyrocore='step-logs'] li")!;
        expect(item.dataset.status).toBe("ANALYSED");
        expect(item.textContent).toContain("gyrocoreStepLogLabel|acro-a.bbl|1|1");
        const sel = q(container, "[data-gyrocore='step-select-a']") as HTMLSelectElement;
        sel.value = item.dataset.log!;
        sel.dispatchEvent(new Event("change"));
        await flush();
        for (const axis of ["roll", "pitch", "yaw"]) {
            for (const thr of [40, 80]) {
                const cellEl = q(container, `[data-gyrocore='step-cell-${axis}-${thr}']`)!;
                expect(q(cellEl, "[data-row='status'] [data-side='a']")!.dataset.status).toBe("MEASURED");
                expect(q(cellEl, "[data-line='a']")).not.toBeNull();
                expect(q(cellEl, "[data-band='a']")).not.toBeNull();
                expect(q(cellEl, "[data-row='overshoot'] [data-side='a']")!.textContent!.trim()).toMatch(
                    /^-?\d+\.\d{3}$/,
                );
                expect(q(cellEl, "[data-row='t50Ms'] [data-side='a']")!.textContent).toMatch(/ms/);
                expect(q(cellEl, "[data-row='windows'] [data-side='a']")!.textContent).toMatch(/^\s*\d+ \/ \d+\s*$/);
                expect(
                    Number(q(cellEl, "[data-row='manoeuvres'] [data-side='a']")!.textContent),
                ).toBeGreaterThanOrEqual(5);
                expect(q(cellEl, `[data-gyrocore='step-rejections-${axis}-${thr}']`)!.textContent).toContain(
                    "gyrocoreStepReason_not_airborne",
                );
            }
        }
        expect(q(container, "[data-gyrocore='step-loop-info']")!.textContent).toContain(
            "gyrocoreStepLoopItermRelax|1|1|25",
        );
        // every argument-carrying message of the card is asked for without i18next HTML escaping
        expect(objectCalls.length).toBeGreaterThan(0);
        expect(objectCalls.every((c) => (c.interpolation as { escapeValue?: boolean })?.escapeValue === false)).toBe(
            true,
        );
        unmount();
    });

    it("an ANGLE flight: INSUFFICIENT with the self-levelling rejections, and no curve", async () => {
        await importFile(acroLog({ seconds: 20, seed: 2, flags: ARM_FLAG | ANGLE_FLAG }), "angle.bbl");
        const { container, unmount } = await mount();
        const store = useStepResponseStore();
        store.select("a", store.options[0].key);
        await flush();
        const cellEl = q(container, "[data-gyrocore='step-cell-roll-80']")!;
        expect(q(cellEl, "[data-row='status'] [data-side='a']")!.dataset.status).toBe("INSUFFICIENT");
        expect(q(cellEl, "[data-gyrocore='step-chart-empty']")).not.toBeNull();
        expect(q(cellEl, "[data-gyrocore='step-rejections-roll-80']")!.textContent).toContain(
            "gyrocoreStepReason_self_level_or_automation",
        );
        unmount();
    });

    it("A/B, same tune: compared, with a delta per axis and threshold", async () => {
        await importFile(acroLog({ seconds: 20, seed: 1, startUs: 4_000_000 }), "a.bbl");
        await importFile(acroLog({ seconds: 20, seed: 2, startUs: 8_000_000 }), "b.bbl");
        const { container, unmount } = await mount();
        const store = useStepResponseStore();
        store.select("a", store.options[0].key);
        store.select("b", store.options[1].key);
        await flush();
        expect(q(container, "[data-gyrocore='step-ab-status']")!.dataset.status).toBe("COMPARED");
        expect(
            q(container, "[data-gyrocore='step-cell-roll-80'] [data-row='overshoot'] [data-side='delta']"),
        ).not.toBeNull();
        expect(q(container, "[data-gyrocore='step-no-delta-roll-80']")).toBeNull();
        unmount();
    });

    it("A/B with an extra change: both curves, no delta, and the exact reason", async () => {
        await importFile(acroLog({ seconds: 20, seed: 1, startUs: 4_000_000 }), "a.bbl");
        await importFile(
            acroLog({
                seconds: 20,
                seed: 2,
                startUs: 8_000_000,
                headers: { rollPID: "45,79,30", ff_weight: "30,32,22" },
            }),
            "b.bbl",
        );
        const { container, unmount } = await mount();
        const store = useStepResponseStore();
        store.select("a", store.options[0].key);
        store.select("b", store.options[1].key);
        const intent = q(container, "[data-gyrocore='step-intent']") as HTMLSelectElement;
        intent.value = "p";
        intent.dispatchEvent(new Event("change"));
        await flush();
        expect(q(container, "[data-gyrocore='step-ab-status']")!.dataset.status).toBe("NOT_COMPARABLE");
        const cellEl = q(container, "[data-gyrocore='step-cell-roll-80']")!;
        expect(q(cellEl, "[data-line='a']")).not.toBeNull();
        expect(q(cellEl, "[data-line='b']")).not.toBeNull();
        expect(q(cellEl, "[data-side='delta']")).toBeNull();
        expect(q(cellEl, "[data-gyrocore='step-no-delta-roll-80']")!.textContent).toContain("extra_change:ff_weight");
        expect(q(container, "[data-check='settings_as_intended']")!.dataset.status).toBe("FAIL");
        unmount();
    });
});

describe("A/B with a setting that is not logged", () => {
    async function pair(omitA: string[], omitB: string[]) {
        await importFile(acroLog({ seconds: 20, seed: 1, startUs: 4_000_000, omitHeaders: omitA }), "a.bbl");
        await importFile(acroLog({ seconds: 20, seed: 2, startUs: 8_000_000, omitHeaders: omitB }), "b.bbl");
        const m = await mount();
        const store = useStepResponseStore();
        store.select("a", store.options[0].key);
        store.select("b", store.options[1].key);
        await flush();
        return m;
    }
    function expectCurvesWithoutDelta(container: HTMLElement) {
        expect(q(container, "[data-gyrocore='step-ab-status']")!.dataset.status).toBe("NOT_COMPARABLE");
        expect(q(container, "[data-check='settings_as_intended']")!.dataset.status).toBe("FAIL");
        expect(container.querySelector("[data-side='delta']")).toBeNull();
        const cellEl = q(container, "[data-gyrocore='step-cell-roll-80']")!;
        expect(q(cellEl, "[data-line='a']")).not.toBeNull();
        expect(q(cellEl, "[data-line='b']")).not.toBeNull();
    }

    it("missing from both logs: Not logged (A and B), named, curves shown, no delta", async () => {
        const { container, unmount } = await pair(["tpa_rate"], ["tpa_rate"]);
        expectCurvesWithoutDelta(container);
        expect(q(container, "[data-gyrocore='step-unknown-settings']")!.textContent).toContain(
            "tpa_rate: gyrocoreStepMissing_both",
        );
        expect(q(container, "[data-gyrocore='step-no-delta-roll-80']")!.textContent).toContain(
            "settings_not_logged:tpa_rate",
        );
        unmount();
    });

    it("missing from one log: Not logged in B, named, curves shown, no delta", async () => {
        const { container, unmount } = await pair([], ["tpa_rate"]);
        expectCurvesWithoutDelta(container);
        expect(q(container, "[data-gyrocore='step-unknown-settings']")!.textContent).toContain(
            "tpa_rate: gyrocoreStepMissing_b",
        );
        unmount();
    });
});

describe("message arguments are not HTML-escaped twice", () => {
    it("i18next escapes interpolated values by default; the card's escapeValue: false keeps a '/' as '/'", async () => {
        const i18next = (await import("i18next")).default.createInstance();
        await i18next.init({ lng: "en", resources: { en: { translation: { noDelta: "No delta: {{1}}" } } } });
        expect(i18next.t("noDelta", { 1: "a / b" })).toContain("&#x2F;");
        expect(i18next.t("noDelta", { 1: "a / b", interpolation: { escapeValue: false } })).toBe("No delta: a / b");
    });
});
