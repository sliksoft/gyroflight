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

// Web-only product (no desktop packaging), offline webfonts, and the Autotune sample-rate label
// that showed a literal "{{rate}}" (upstream passed no rate to the message).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { shallowMount } from "@vue/test-utils";
import i18next from "i18next";
import I18NextVue from "i18next-vue";
import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/composables/useAutotune", () => ({ useAutotune: () => ({ importAndAnalyze: vi.fn() }) }));

const ROOT = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const messages = (lang: string) =>
    Object.fromEntries(
        Object.entries(JSON.parse(read(`locales/${lang}/messages.json`)) as Record<string, { message: string }>).map(
            ([k, v]) => [k, v.message],
        ),
    );

describe("web-only product", () => {
    it("ships no desktop (Tauri) packaging", () => {
        expect(existsSync(join(ROOT, "src-tauri"))).toBe(false);
        for (const f of ["check-tauri-prereqs.mjs", "sync-tauri-version.mjs", "rename-tauri-bundles.mjs"]) {
            expect(existsSync(join(ROOT, "scripts", f))).toBe(false);
        }
        const pkg = JSON.parse(read("package.json"));
        expect(Object.keys(pkg.scripts).filter((s) => s.startsWith("tauri"))).toEqual([]);
        expect(pkg.devDependencies["@tauri-apps/cli"]).toBeUndefined();
        const workflows = readdirSync(join(ROOT, ".github/workflows"));
        expect(workflows.filter((w) => w.startsWith("tauri-"))).toEqual([]);
        expect(read(".github/workflows/build-release.yml")).not.toContain("tauri");
    });

    it("keeps every browser transport", () => {
        for (const f of ["WebSerial.ts", "WebUsbDfuTransport.ts", "WebBluetooth.ts", "usbdfu.ts"]) {
            expect(existsSync(join(ROOT, "src/js/protocols", f))).toBe(true);
        }
    });

    it("precaches the webfonts, so the installed PWA keeps its typeface offline", () => {
        const glob = /globPatterns:\s*\["([^"]+)"\]/.exec(read("vite.config.js"))?.[1] ?? "";
        expect(glob).toMatch(/woff2/);
        expect(glob).toMatch(/woff[,}]/);
        const fonts = readFileSync(join(ROOT, "src/css/opensans_webfontkit/fonts.css"), "utf8");
        expect(fonts).toMatch(/\.woff2/);
    });
});

describe("Autotune sample-rate label", () => {
    it("shows the rate in every language that has the message, never the placeholder", async () => {
        const langs = readdirSync(join(ROOT, "locales")).filter((l) =>
            existsSync(join(ROOT, "locales", l, "messages.json")),
        );
        const i18n = i18next.createInstance();
        await i18n.init({
            lng: "en",
            fallbackLng: "en",
            resources: Object.fromEntries(langs.map((l) => [l, { translation: messages(l) }])),
        });
        for (const l of langs) {
            const text = i18n.getFixedT(l)("autotuneSampleRate", { rate: 4000 });
            expect(text, l).not.toContain("{{");
            expect(text, l).toContain("4000");
        }
    });

    it("renders the rate in the import summary", async () => {
        setActivePinia(createPinia());
        const { useAutotuneStore } = await import("../../src/stores/autotune");
        const store = useAutotuneStore();
        store.analysisState = "done";
        store.analysisResult = { filename: "AIR65.BBL", sampleRate: 4000, axes: { roll: {} } } as never;
        const i18n = i18next.createInstance();
        await i18n.init({ lng: "en", resources: { en: { translation: messages("en") } } });
        const { default: AutotuneImport } = await import("../../src/components/tabs/autotune/AutotuneImport.vue");
        const w = shallowMount(AutotuneImport, {
            global: {
                plugins: [[I18NextVue, { i18next: i18n }]],
                stubs: { UiBox: { template: "<div><slot /></div>" } },
            },
        });
        const label = w.find('[data-gyroflight="sample-rate"]');
        expect(label.text()).toBe("Sample rate: 4000 Hz");
        expect(w.html()).not.toContain("{{rate}}");
        w.unmount();
    });
});
