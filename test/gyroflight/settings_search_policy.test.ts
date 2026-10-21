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

// The global settings search (c3d823e2) lists only settings whose tab useVisibleTabs returns, and
// Sidebar.vue only opens a picked result when that tab is in the same list. Both therefore follow
// the Gyroflight sidebar policy (hideInSidebar), Expert Mode and the allowed-tab lists; there is
// no second permission list. These cases feed results for hidden tabs through the real filter and
// the real Sidebar selection handler.

import { effectScope } from "vue";
import { shallowMount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const switched = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("@/js/tab_switch.js", () => ({ switchTab: (...args: unknown[]) => switched.calls.push(args) }));
vi.mock("@/js/tab_switch", () => ({ switchTab: (...args: unknown[]) => switched.calls.push(args) }));
vi.mock("i18next-vue", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { settingsSearchIndex, type SettingsSearchEntry } from "virtual:settings-search-index";
import { filterSearchableSettings } from "../../src/components/settings-search/settingsSearch";
import { useVisibleTabs } from "../../src/components/sidebar/useVisibleTabs";
import { sidebarItems } from "../../src/components/sidebar/sidebar_items";
import Sidebar from "../../src/components/sidebar/Sidebar.vue";
import SettingsSearch from "../../src/components/settings-search/SettingsSearch.vue";
import { useConnectionStore } from "../../src/stores/connection";
import { GYROFLIGHT_HIDDEN_SIDEBAR_KEYS } from "../../src/gyroflight/navigation";
import { GYROFLIGHT_TAB_KEY } from "../../src/gyroflight/tabs";

type Vm = { expertMode?: boolean };
const g = globalThis as unknown as { vm?: Vm };

// The tab each hidden sidebar key opens; flight_plan_connected opens flight_plan.
const HIDDEN_TABS = [
    ...new Set(GYROFLIGHT_HIDDEN_SIDEBAR_KEYS.map((k) => sidebarItems.find((i) => i.key === k)?.tab ?? k)),
];

function entry(tab: string, overrides: Partial<SettingsSearchEntry> = {}): SettingsSearchEntry {
    return {
        tab,
        subtab: null,
        searchId: `${tab}::probe:1`,
        labelKey: "probe",
        sectionKey: "",
        ...overrides,
    } as SettingsSearchEntry;
}

function visibleTabNames(connected: boolean, expertMode: boolean): Set<string> {
    useConnectionStore().connectionValid = connected;
    g.vm = { expertMode };
    const scope = effectScope();
    const names = scope.run(() => new Set(useVisibleTabs().value.map((i) => i.tab ?? i.key)))!;
    scope.stop();
    return names;
}

describe("settings search follows the Gyroflight navigation policy", () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        switched.calls = [];
    });
    afterEach(() => {
        delete g.vm;
    });

    it("indexes no Gyroflight tab, and only tabs the sidebar knows", () => {
        const known = new Set(sidebarItems.map((i) => i.tab ?? i.key));
        const indexedTabs = new Set(settingsSearchIndex.map((s) => s.tab));
        expect(indexedTabs.size).toBeGreaterThan(0);
        expect(indexedTabs.has(GYROFLIGHT_TAB_KEY)).toBe(false);
        for (const tab of indexedTabs) {
            expect(known.has(tab)).toBe(true);
        }
    });

    it.each([
        [false, false],
        [false, true],
        [true, false],
        [true, true],
    ])("drops results for hidden tabs (connected=%s, expert=%s)", (connected, expertMode) => {
        const names = visibleTabNames(connected, expertMode);
        const probes = HIDDEN_TABS.map((tab) => entry(tab));
        const results = filterSearchableSettings([...settingsSearchIndex, ...probes], names, expertMode);
        for (const tab of HIDDEN_TABS) {
            expect(names.has(tab)).toBe(false);
            expect(results.some((s) => s.tab === tab)).toBe(false);
        }
    });

    it("keeps Blackbox Viewer reachable and Autotune behind Expert Mode", () => {
        for (const connected of [false, true]) {
            expect(visibleTabNames(connected, false).has("blackbox_viewer")).toBe(true);
            expect(visibleTabNames(connected, false).has("autotune")).toBe(false);
            expect(visibleTabNames(connected, true).has("autotune")).toBe(true);
        }
    });

    it("drops expert-only settings without Expert Mode", () => {
        const names = new Set(["configuration"]);
        const probes = [entry("configuration", { expert: true })];
        expect(filterSearchableSettings(probes, names, false)).toEqual([]);
        expect(filterSearchableSettings(probes, names, true)).toHaveLength(1);
    });
});

describe("Sidebar opens a picked search result only for a visible tab", () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        switched.calls = [];
    });
    afterEach(() => {
        delete g.vm;
    });

    function pick(tab: string, expertMode: boolean) {
        g.vm = { expertMode };
        const wrapper = shallowMount(Sidebar, {
            global: { provide: { betaflightModel: { expertMode } }, mocks: { $t: (key: string) => key } },
        });
        wrapper.findComponent(SettingsSearch).vm.$emit("select", entry(tab));
        wrapper.unmount();
    }

    it.each(HIDDEN_TABS)("does not switch to the hidden tab %s", (tab) => {
        for (const expertMode of [false, true]) {
            pick(tab, expertMode);
        }
        expect(switched.calls).toEqual([]);
    });

    it("does not switch to Autotune without Expert Mode", () => {
        pick("autotune", false);
        expect(switched.calls).toEqual([]);
    });

    it("switches to a visible tab (control case)", () => {
        pick("blackbox_viewer", false);
        pick("autotune", true);
        expect(switched.calls.map((c) => c[0])).toEqual(["blackbox_viewer", "autotune"]);
    });
});
