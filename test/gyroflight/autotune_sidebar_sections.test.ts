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

// The Autotune sections are listed in the main sidebar, under Autotune, while that tab is open; the
// tab has no navigation column of its own. Clicking a section opens it and keeps the Autotune tab.

import { createApp, h, nextTick } from "vue";
import { createPinia, getActivePinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
};

const switched = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("@/js/tab_switch.js", () => ({ switchTab: (...args: unknown[]) => switched.calls.push(args) }));
vi.mock("@/js/tab_switch", () => ({ switchTab: (...args: unknown[]) => switched.calls.push(args) }));
vi.mock("i18next-vue", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import UApp from "@nuxt/ui/components/App.vue";
import Sidebar from "../../src/components/sidebar/Sidebar.vue";
import StatusBar from "../../src/components/status-bar/StatusBar.vue";
import { vueTabState } from "../../src/js/vue_tab_mounter.js";
import { AUTOTUNE_SECTIONS, useAutotuneSectionStore } from "../../src/gyroflight/autotune/sections";
import { withAutotuneSections, type GyroflightSidebarEntry } from "../../src/gyroflight/autotune/sidebarSections";

type Vm = { expertMode?: boolean };
const g = globalThis as unknown as { vm?: Vm };
const flush = () => new Promise((r) => setTimeout(r, 0));

function mountSidebar(expanded = true) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    g.vm = { expertMode: true };
    const app = createApp({ render: () => h(UApp, { portal: false }, { default: () => h(Sidebar) }) });
    app.config.globalProperties.$t = ((key: string) => key) as never;
    app.provide("betaflightModel", { expertMode: true });
    app.provide("sidebarExpanded", { value: expanded, __v_isRef: true });
    app.use(getActivePinia()!);
    app.mount(container);
    return { container, unmount: () => (app.unmount(), container.remove()) };
}

const sectionLinks = (root: Element) => [...root.querySelectorAll("[data-autotune-section]")] as HTMLElement[];

describe("Autotune sections in the main sidebar", () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        switched.calls = [];
    });
    afterEach(() => {
        delete g.vm;
        vueTabState.activeTabName = null;
    });

    it("lists the seven sections right under Autotune while the Autotune tab is open", async () => {
        vueTabState.activeTabName = "autotune";
        const { container, unmount } = mountSidebar();
        await flush();
        const links = sectionLinks(container);
        expect(links.map((l) => l.getAttribute("data-autotune-section"))).toEqual([...AUTOTUNE_SECTIONS]);
        // In the one menu, directly after the Autotune entry, in order.
        const all = [...container.querySelectorAll('[data-slot="link"]')].map((l) => l.textContent?.trim());
        const at = all.indexOf("tabAutotune");
        expect(at).toBeGreaterThanOrEqual(0);
        expect(all.slice(at + 1, at + 1 + AUTOTUNE_SECTIONS.length)).toEqual(
            AUTOTUNE_SECTIONS.map((s) => `gyroflightAutotuneSection_${s}`),
        );
        expect(links[0].getAttribute("aria-current")).toBe("page");
        expect(links.every((l) => l.classList.contains("ps-7"))).toBe(true);
        unmount();
    });

    it("lists no sections while another tab is open", async () => {
        vueTabState.activeTabName = "blackbox_viewer";
        const { container, unmount } = mountSidebar();
        await flush();
        expect(sectionLinks(container)).toEqual([]);
        expect(container.textContent).toContain("tabAutotune");
        unmount();
    });

    it("clicking a section opens it, without switching tabs; the highlight follows", async () => {
        vueTabState.activeTabName = "autotune";
        const sections = useAutotuneSectionStore();
        const { container, unmount } = mountSidebar();
        await flush();
        for (const section of AUTOTUNE_SECTIONS) {
            container.querySelector<HTMLElement>(`[data-autotune-section="${section}"]`)!.click();
            await nextTick();
            expect(sections.active).toBe(section);
            const current = sectionLinks(container).filter((l) => l.getAttribute("aria-current") === "page");
            expect(current.map((l) => l.getAttribute("data-autotune-section"))).toEqual([section]);
        }
        expect(switched.calls).toEqual([]);
        unmount();
    });

    it("every section stays reachable when the sidebar shows icons only", async () => {
        vueTabState.activeTabName = "autotune";
        const sections = useAutotuneSectionStore();
        const { container, unmount } = mountSidebar(false);
        await flush();
        expect(sectionLinks(container)).toHaveLength(AUTOTUNE_SECTIONS.length);
        expect(sectionLinks(container).some((l) => l.classList.contains("ps-7"))).toBe(false);
        container.querySelector<HTMLElement>('[data-autotune-section="technical"]')!.click();
        await nextTick();
        expect(sections.active).toBe("technical");
        unmount();
    });
});

describe("Autotune sections in the compact tab bar (phone-width app shell)", () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        switched.calls = [];
    });
    afterEach(() => {
        delete g.vm;
        vueTabState.activeTabName = null;
    });

    it("follows Autotune with the seven sections; a section opens without switching tabs", async () => {
        vueTabState.activeTabName = "autotune";
        g.vm = { expertMode: true };
        const sections = useAutotuneSectionStore();
        const container = document.createElement("div");
        document.body.appendChild(container);
        const app = createApp({ render: () => h(UApp, { portal: false }, { default: () => h(StatusBar) }) });
        app.config.globalProperties.$t = ((key: string) => key) as never;
        app.provide("betaflightModel", { expertMode: true });
        app.use(getActivePinia()!);
        app.mount(container);
        await flush();
        const buttons = [...container.querySelectorAll<HTMLElement>(".status-bar__tabs > button")];
        const labels = buttons.map((b) => b.getAttribute("aria-label"));
        const at = labels.indexOf("tabAutotune");
        expect(labels.slice(at + 1, at + 1 + AUTOTUNE_SECTIONS.length)).toEqual(
            AUTOTUNE_SECTIONS.map((s) => `gyroflightAutotuneSection_${s}`),
        );
        buttons[at + 1 + AUTOTUNE_SECTIONS.indexOf("compare")].click();
        await nextTick();
        expect(sections.active).toBe("compare");
        expect(switched.calls).toEqual([]);
        app.unmount();
        container.remove();
    });
});

describe("withAutotuneSections", () => {
    const entry = (label: string, active = false): GyroflightSidebarEntry => ({
        label,
        icon: "",
        active,
        tooltip: { text: label },
        onSelect: () => {},
    });
    const ctx = (activeTab: string | null) => ({
        activeTab,
        activeSection: "chirp" as const,
        t: (k: string) => k,
        openSection: vi.fn(),
        indent: true,
        closeMobileSidebar: vi.fn(),
    });

    it("leaves the list alone when Autotune is not open or not listed", () => {
        const items = [entry("a"), entry("b")];
        expect(withAutotuneSections(items, ["setup", "autotune"], ctx("setup"))).toBe(items);
        expect(withAutotuneSections(items, ["setup", "cli"], ctx("autotune"))).toBe(items);
    });

    it("inserts the sections after Autotune, highlights the open one, not Autotune itself", () => {
        const items = [entry("setup"), entry("autotune", true), entry("cli")];
        const c = ctx("autotune");
        const out = withAutotuneSections(items, ["setup", "autotune", "cli"], c);
        expect(out.map((i) => i.label)).toEqual([
            "setup",
            "autotune",
            ...AUTOTUNE_SECTIONS.map((s) => `gyroflightAutotuneSection_${s}`),
            "cli",
        ]);
        expect(out.filter((i) => i.active).map((i) => i["data-autotune-section"])).toEqual(["chirp"]);
        out[2 + AUTOTUNE_SECTIONS.indexOf("plan")].onSelect();
        expect(c.openSection).toHaveBeenCalledWith("plan");
        expect(c.closeMobileSidebar).toHaveBeenCalled();
    });
});
