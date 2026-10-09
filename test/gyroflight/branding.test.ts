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
 * Gyroflight UI/product layer: branding, theme, Home, sidebar policy and the status tab.
 * Upstream Betaflight behaviour that must stay as it is (Autotune's Expert Mode, the
 * Pre-Flight and Flight Plan implementations, the Flasher and Blackbox Viewer tabs, the
 * GyroCore product Apply lock) is asserted here too.
 */

import fs from "node:fs";
import path from "node:path";
import { createApp, h, nextTick } from "vue";
import { describe, expect, it, vi } from "vitest";
import i18next from "i18next";

const expert = vi.hoisted(() => ({ on: false }));
const switched = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("@/js/utils/isExpertModeEnabled", () => ({ isExpertModeEnabled: () => expert.on }));
vi.mock("@/js/tab_switch.js", () => ({ switchTab: (...args: unknown[]) => switched.calls.push(args) }));

import { sidebarItems, isItemVisible } from "../../src/components/sidebar/sidebar_items.js";
import GUI from "../../src/js/gui";
import { VueTabComponents } from "../../src/js/vue_tab_registry.js";
import { gyroflightTabComponents } from "../../src/gyroflight/components";
import { GYROFLIGHT_HIDDEN_SIDEBAR_KEYS } from "../../src/gyroflight/navigation";
import { gyroflightCapabilities } from "../../src/gyroflight/capabilities";
import { gyroflightMessageStrings, registerGyroflightMessages } from "../../src/gyroflight/i18n";
import GyroflightHome from "../../src/gyroflight/tabs/GyroflightHome.vue";
import GyroflightLogo from "../../src/gyroflight/branding/GyroflightLogo.vue";
import { productApplyBlocks } from "../../src/gyrocore/productLock/productApply";

const root = path.resolve(__dirname, "../..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf-8");
const messages = gyroflightMessageStrings();

function mount(component: unknown, props: Record<string, unknown> = {}) {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const app = createApp({ render: () => h(component as never, props) });
    app.config.globalProperties.$t = ((key: string) => messages[key] ?? key) as never;
    app.mount(el);
    return { el, unmount: () => (app.unmount(), el.remove()) };
}

/** What useVisibleTabs shows for a disconnected craft, minus GUI.allowedTabs and the store. */
function visibleKeys(expertMode: boolean, mode: "disconnected" | "connected") {
    return sidebarItems
        .filter((i) => i.mode === mode || i.mode === "shared")
        .filter((i) => !i.hideInSidebar)
        .filter((i) => isItemVisible(i, { expertMode }))
        .map((i) => i.key);
}

describe("Gyroflight branding", () => {
    it("the app shell shows the Gyroflight logo instead of <betaflight-logo>", () => {
        const app = read("src/App.vue");
        expect(app).toContain("<GyroflightLogo");
        expect(app).not.toContain("<betaflight-logo");
        expect(app).not.toContain('<div class="mobile-topbar__logo"');
        // Betaflight's logo component and assets stay in the tree for upstream merges.
        expect(fs.existsSync(path.join(root, "src/components/betaflight-logo/BetaflightLogo.vue"))).toBe(true);
        expect(fs.existsSync(path.join(root, "src/images/bf_logo_white.svg"))).toBe(true);
    });

    it("uses the real Gyroflight logo PNG, in a sidebar and a hero size, with the version tooltip", () => {
        expect(fs.existsSync(path.join(root, "src/gyroflight/branding/logo-Gyrofly.png"))).toBe(true);
        const sidebar = mount(GyroflightLogo, { configuratorVersion: "1.2.3" });
        const logo = sidebar.el.querySelector('[data-gyroflight="logo"]')!;
        expect(logo.getAttribute("data-variant")).toBe("sidebar");
        const img = logo.querySelector("img")!;
        expect(img.getAttribute("src")).toMatch(/logo-Gyrofly/);
        expect(img.getAttribute("alt")).toBe("Gyroflight by Redline Dynamics");
        expect(logo.getAttribute("title")).toContain("1.2.3");
        // The artwork carries the wordmark: no separate text branding beside it.
        expect(logo.textContent!.trim()).toBe("");
        sidebar.unmount();
        const hero = mount(GyroflightLogo, { variant: "hero" });
        expect(hero.el.querySelector('[data-gyroflight="logo"]')!.getAttribute("data-variant")).toBe("hero");
        hero.unmount();
    });

    it("names the document and the PWA Gyroflight", () => {
        expect(read("src/index.html")).toContain("<title>Gyroflight</title>");
        const pkg = JSON.parse(read("package.json"));
        expect(pkg.productName).toBe("Gyroflight");
    });
});

describe("Gyroflight theme", () => {
    const css = read("src/gyroflight/branding/gyroflight-theme.css");

    it("maps the default theme's primary to GyroCore cyan and leaves Amber and High contrast alone", () => {
        expect(css).toContain('body:not([data-theme="amber"]):not([data-theme="contrast"])');
        expect(css).toContain("--gyroflight-cyan: #22d3ee;");
        expect(css).toContain("--color-primary-500: var(--gyroflight-cyan);");
        expect(css).toContain("--ui-primary: var(--color-primary-500);");
        expect(read("src/gyroflight/components.ts")).toContain('import "./branding/gyroflight-theme.css";');
    });

    it("never redefines semantic success, warning or error colours", () => {
        expect(css).not.toMatch(/--(ui-)?(color-)?(success|warning|error)/);
    });

    it("keeps the upstream theme key: 'yellow' stays the stored default, labelled as Gyroflight's", async () => {
        expect(read("src/js/main.js")).toContain('const colorTheme = result.colorTheme ?? "yellow";');
        const upstream = JSON.parse(read("locales/en/messages.json"));
        await i18next.init({
            lng: "en",
            ns: ["messages"],
            defaultNS: "messages",
            resources: {
                en: {
                    messages: Object.fromEntries(
                        Object.entries(upstream).map(([k, v]) => [k, (v as { message: string }).message]),
                    ),
                },
            },
        });
        registerGyroflightMessages();
        expect(i18next.t("colorThemeYellow")).toBe("Gyroflight (default)");
        expect(i18next.t("colorThemeAmber")).toBe("Amber");
        expect(i18next.t("colorThemeContrast")).toBe(upstream.colorThemeContrast.message);
    });
});

describe("Home label", () => {
    it("the first sidebar entry is Home in every language, via the Gyroflight product override", async () => {
        const upstream = (lng: string) =>
            Object.fromEntries(
                Object.entries(JSON.parse(read(`locales/${lng}/messages.json`))).map(([k, v]) => [
                    k,
                    (v as { message: string }).message,
                ]),
            );
        expect(upstream("en").tabLanding).toBe("Welcome");
        expect(upstream("nl").tabLanding).toBe("Welkom");
        await i18next.init({
            lng: "nl",
            fallbackLng: "en",
            ns: ["messages"],
            defaultNS: "messages",
            resources: { en: { messages: upstream("en") }, nl: { messages: upstream("nl") } },
        });
        registerGyroflightMessages();
        expect(i18next.t("tabLanding")).toBe("Home");
        await i18next.changeLanguage("en");
        expect(i18next.t("tabLanding")).toBe("Home");
        // A bundle (re)loaded later must not bring the upstream text back.
        i18next.addResourceBundle("nl", "messages", { tabLanding: "Welkom" }, true, true);
        i18next.emit("loaded", { nl: { messages: true } });
        await i18next.changeLanguage("nl");
        expect(i18next.t("tabLanding")).toBe("Home");
        expect(sidebarItems[0]).toMatchObject({ key: "landing", i18n: "tabLanding" });
    });
});

describe("Gyroflight sidebar policy", () => {
    it("hides Pre-Flight, both Flight Plan entries, Help and the status tab with upstream's own hideInSidebar flag", () => {
        expect(GYROFLIGHT_HIDDEN_SIDEBAR_KEYS).toEqual([
            "preflight",
            "flight_plan",
            "flight_plan_connected",
            "help",
            "gyroflight",
        ]);
        for (const key of GYROFLIGHT_HIDDEN_SIDEBAR_KEYS) {
            const item = sidebarItems.find((i) => i.key === key);
            expect(item, key).toBeDefined();
            expect(item!.hideInSidebar, key).toBe(true);
        }
        expect(visibleKeys(true, "disconnected")).not.toContain("preflight");
        expect(visibleKeys(true, "disconnected")).not.toContain("flight_plan");
        expect(visibleKeys(true, "connected")).not.toContain("flight_plan_connected");
        expect(visibleKeys(true, "disconnected")).not.toContain("help");
        expect(visibleKeys(true, "disconnected")).not.toContain("gyroflight");
        expect(visibleKeys(true, "connected")).not.toContain("gyroflight");
    });

    it("keeps their implementations: tab components and allowed tabs are unchanged", () => {
        expect(VueTabComponents.preflight).toBeDefined();
        expect(VueTabComponents.flight_plan).toBeDefined();
        expect(GUI.defaultAllowedTabsWhenDisconnected).toContain("preflight");
        expect(GUI.defaultAllowedTabsWhenDisconnected).toContain("flight_plan");
        expect(fs.existsSync(path.join(root, "src/components/tabs/PreflightTab.vue"))).toBe(true);
        expect(fs.existsSync(path.join(root, "src/components/tabs/FlightPlanTab.vue"))).toBe(true);
        expect(VueTabComponents.help).toBeDefined();
        expect(GUI.defaultAllowedTabsWhenDisconnected).toContain("help");
        expect(fs.existsSync(path.join(root, "src/components/tabs/HelpTab.vue"))).toBe(true);
        expect(VueTabComponents.gyroflight).toBeDefined();
        expect(GUI.defaultAllowedTabsWhenDisconnected).toContain("gyroflight");
        expect(GUI.defaultAllowedTabs).toContain("gyroflight");
    });

    it("changes nothing else in the sidebar list", () => {
        const hidden = sidebarItems.filter((i) => i.hideInSidebar).map((i) => i.key);
        expect(hidden.sort()).toEqual(
            [
                "backups",
                "flight_plan",
                "flight_plan_connected",
                "gyroflight",
                "help",
                "log",
                "preflight",
                "user_profile",
            ].sort(),
        );
        expect(sidebarItems[0].key).toBe("landing");
        expect(sidebarItems[1].key).toBe("firmware_flasher");
    });

    it("Autotune remains an Expert Mode tab", () => {
        const autotune = sidebarItems.find((i) => i.key === "autotune")!;
        expect(autotune.expert).toBe(true);
        expect(autotune.hideInSidebar).toBeUndefined();
        expect(visibleKeys(false, "disconnected")).not.toContain("autotune");
        expect(visibleKeys(true, "disconnected")).toContain("autotune");
    });

    it("Firmware Flasher and Blackbox Viewer stay reachable without Expert Mode", () => {
        expect(visibleKeys(false, "disconnected")).toEqual(
            expect.arrayContaining(["landing", "firmware_flasher", "blackbox_viewer"]),
        );
        expect(GUI.defaultAllowedTabsWhenDisconnected).toEqual(
            expect.arrayContaining(["firmware_flasher", "blackbox_viewer"]),
        );
    });
});

describe("Gyroflight Home", () => {
    it("replaces the Welcome tab through the Gyroflight registry; LandingTab.vue is untouched", () => {
        expect(gyroflightTabComponents.landing).toBe(GyroflightHome);
        expect(VueTabComponents.landing).toBe(GyroflightHome);
        expect(fs.existsSync(path.join(root, "src/components/tabs/LandingTab.vue"))).toBe(true);
    });

    it("shows the product, the start areas and the Betaflight attribution, without sponsors or donations", () => {
        expert.on = false;
        const { el, unmount } = mount(GyroflightHome);
        const text = el.textContent!;
        for (const s of ["Built on Betaflight", "GNU General Public License v3.0", "Betaflight App source"]) {
            expect(text).toContain(s);
        }
        // One branding element: the hero logo, no text wordmark beside it.
        const hero = el.querySelector('[data-gyroflight="home-hero"]')!;
        expect(hero.querySelectorAll('[data-gyroflight="logo"][data-variant="hero"]')).toHaveLength(1);
        expect(text).not.toContain("GYROFLIGHT");
        expect(el.querySelectorAll('[data-gyroflight="home-cards"] > *')).toHaveLength(4);
        for (const s of ["home-connect", "home-blackbox", "home-flasher", "home-autotune", "home-attribution"]) {
            expect(el.querySelector(`[data-gyroflight="${s}"]`), s).not.toBeNull();
        }
        expect(text).not.toMatch(/donat|patreon|sponsor/i);
        unmount();
    });

    it("links to Autotune only in Expert Mode", async () => {
        expert.on = false;
        let m = mount(GyroflightHome);
        expect(m.el.querySelector('[data-gyroflight="home-autotune-open"]')).toBeNull();
        expect(m.el.querySelector('[data-gyroflight="home-autotune-expert"]')).not.toBeNull();
        m.unmount();

        expert.on = true;
        m = mount(GyroflightHome);
        await nextTick();
        const open = m.el.querySelector<HTMLButtonElement>('[data-gyroflight="home-autotune-open"]');
        expect(open).not.toBeNull();
        switched.calls = [];
        open!.click();
        expect(switched.calls[0][0]).toBe("autotune");
        m.unmount();
        expert.on = false;
    });

    it("opens Blackbox Viewer and Firmware Flasher with their sidebar mode", () => {
        const { el, unmount } = mount(GyroflightHome);
        switched.calls = [];
        el.querySelector<HTMLButtonElement>('[data-gyroflight="home-blackbox"] button')!.click();
        el.querySelector<HTMLButtonElement>('[data-gyroflight="home-flasher"] button')!.click();
        expect(switched.calls.map((c) => [c[0], (c[1] as { mode: string }).mode])).toEqual([
            ["blackbox_viewer", "shared"],
            ["firmware_flasher", "disconnected"],
        ]);
        unmount();
    });
});

describe("Gyroflight status tab", () => {
    it("states the current reality, with no 'migration pending' language", () => {
        const status = Object.fromEntries(gyroflightCapabilities.map((c) => [c.key, c.status]));
        expect(status).toEqual({
            firmware_flasher: "available",
            blackbox_viewer: "available",
            autotune: "available",
            chirp_qualification: "implemented",
            global_tune: "implemented",
            safety_foundation: "implemented",
            safety_full: "incomplete",
            physical_apply: "locked",
            tune_session: "not_started",
        });
        expect(JSON.stringify(messages)).not.toMatch(/migration pending/i);
    });
});

describe("GyroCore Apply authority is untouched", () => {
    it("the product Apply lock is still full_safety_engine_pending", () => {
        expect(productApplyBlocks()).toEqual(["full_safety_engine_pending"]);
    });
});
