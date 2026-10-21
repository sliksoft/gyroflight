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

// The real switchTab against the navigation store's allowed-tab lists: the Gyroflight tab and Home
// open, and a tab outside the list stays refused. Mounting itself is stubbed.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const { mountVueTab } = vi.hoisted(() => ({
    mountVueTab: vi.fn((_tabKey: string, _contentReady?: () => void) => true),
}));

vi.mock("../../src/js/ConfigStorage", () => ({ get: () => ({}), set: vi.fn() }));
vi.mock("../../src/js/Analytics", () => ({ checkSetupAnalytics: vi.fn() }));
vi.mock("../../src/js/tab_adapters", () => ({ tabSwitchCleanup: (callback: () => void) => callback() }));
vi.mock("../../src/js/vue_tab_mounter", () => ({ mountVueTab, vueTabState: { activeTabName: null } }));
vi.mock("../../src/components/sidebar/sidebar_items.js", () => ({ sidebarItems: [] }));
vi.mock("../../src/js/gui_log", () => ({ gui_log: vi.fn() }));
vi.mock("../../src/js/localization", () => ({ i18n: { getMessage: (key: string) => key } }));

import { switchTab } from "../../src/js/tab_switch";
import { GYROFLIGHT_TAB_KEY } from "../../src/gyroflight/tabs";
import { useConnectionStore } from "../../src/stores/connection";
import {
    DEFAULT_ALLOWED_FC_TABS_WHEN_CONNECTED,
    DEFAULT_ALLOWED_TABS_WHEN_DISCONNECTED,
    useNavigationStore,
} from "../../src/stores/navigation";

function open(tabKey: string, mode: string): boolean {
    // Each switch leaves tabSwitchInProgress set until the (stubbed) tab reports ready.
    useNavigationStore().tabSwitchInProgress = false;
    return switchTab(tabKey, { mode });
}

describe("Gyroflight tab switching through the navigation store", () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        mountVueTab.mockClear();
        useConnectionStore().connectionValid = true;
    });

    it("opens Home and the Gyroflight tab without a flight controller", () => {
        expect(useNavigationStore().allowedTabs).toEqual([...DEFAULT_ALLOWED_TABS_WHEN_DISCONNECTED]);

        expect(open("landing", "disconnected")).toBe(true);
        expect(open(GYROFLIGHT_TAB_KEY, "shared")).toBe(true);
        expect(mountVueTab.mock.calls.map((call) => call[0])).toEqual(["landing", GYROFLIGHT_TAB_KEY]);
    });

    it("refuses tabs outside the disconnected list, even with a valid connection flag", () => {
        expect(open("setup", "connected")).toBe(false);
        expect(open("pid_tuning", "connected")).toBe(false);
        expect(mountVueTab).not.toHaveBeenCalled();
    });

    it("keeps the Gyroflight tab reachable once connected", () => {
        useNavigationStore().allowedTabs = [...DEFAULT_ALLOWED_FC_TABS_WHEN_CONNECTED];

        expect(open(GYROFLIGHT_TAB_KEY, "shared")).toBe(true);
        expect(open("setup", "connected")).toBe(true);
        expect(open("not_a_tab", "connected")).toBe(false);
    });
});
