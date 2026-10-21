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

// Sidebar order and visibility after upstream moved Blackbox Viewer directly below Blackbox
// (a399ffb1). The Gyroflight items stay appended after that upstream group.

import { describe, expect, it } from "vitest";
import { sidebarItems, isItemVisible } from "../../src/components/sidebar/sidebar_items";
import { GYROFLIGHT_TAB_KEY } from "../../src/gyroflight/tabs";
import { DEFAULT_ALLOWED_TABS, DEFAULT_ALLOWED_TABS_WHEN_DISCONNECTED } from "../../src/stores/navigation";

const keys = () => sidebarItems.map((item) => item.key);

function visibleKeys(expertMode: boolean, mode: "disconnected" | "connected") {
    return sidebarItems
        .filter((i) => i.mode === mode || i.mode === "shared")
        .filter((i) => !i.hideInSidebar)
        .filter((i) => isItemVisible(i, { expertMode }))
        .map((i) => i.key);
}

describe("Gyroflight sidebar order", () => {
    it("keeps the full upstream order with the Gyroflight item after Autotune", () => {
        expect(keys()).toEqual([
            "landing",
            "firmware_flasher",
            "help",
            "preflight",
            "flight_plan",
            "setup",
            "sensors",
            "ports",
            "configuration",
            "power",
            "failsafe",
            "presets",
            "pid_tuning",
            "receiver",
            "auxiliary",
            "adjustments",
            "servos",
            "gps",
            "motors",
            "osd",
            "vtx",
            "led_strip",
            "flight_plan_connected",
            "logging",
            "onboard_logging",
            "blackbox_viewer",
            "autotune",
            GYROFLIGHT_TAB_KEY,
            "cli",
            "log",
            "backups",
            "user_profile",
        ]);
    });

    it("places Blackbox Viewer directly below Blackbox, then Autotune, then Gyroflight", () => {
        const k = keys();
        expect(k.indexOf("blackbox_viewer")).toBe(k.indexOf("onboard_logging") + 1);
        expect(k.indexOf("autotune")).toBe(k.indexOf("blackbox_viewer") + 1);
        expect(k.indexOf(GYROFLIGHT_TAB_KEY)).toBe(k.indexOf("autotune") + 1);
    });

    it("keeps Home first and the Firmware Flasher second", () => {
        expect(keys().slice(0, 2)).toEqual(["landing", "firmware_flasher"]);
    });
});

describe("Gyroflight sidebar visibility", () => {
    it("shows Home, Flasher and Blackbox Viewer without Expert Mode", () => {
        expect(visibleKeys(false, "disconnected")).toEqual(["landing", "firmware_flasher", "blackbox_viewer"]);
    });

    it("adds Autotune with Expert Mode, after Blackbox Viewer", () => {
        expect(visibleKeys(true, "disconnected")).toEqual([
            "landing",
            "firmware_flasher",
            "blackbox_viewer",
            "autotune",
        ]);
    });

    it("never shows the hidden upstream tabs or the Gyroflight status tab", () => {
        for (const expertMode of [false, true]) {
            for (const mode of ["disconnected", "connected"] as const) {
                const visible = visibleKeys(expertMode, mode);
                for (const hidden of [
                    "preflight",
                    "flight_plan",
                    "flight_plan_connected",
                    "help",
                    GYROFLIGHT_TAB_KEY,
                ]) {
                    expect(visible).not.toContain(hidden);
                }
            }
        }
    });

    it("keeps hidden tabs allowed, so their implementations stay reachable by switchTab", () => {
        for (const key of ["preflight", "flight_plan", "help", GYROFLIGHT_TAB_KEY, "blackbox_viewer", "autotune"]) {
            expect(DEFAULT_ALLOWED_TABS_WHEN_DISCONNECTED).toContain(key);
        }
        for (const key of [GYROFLIGHT_TAB_KEY, "blackbox_viewer", "autotune"]) {
            expect(DEFAULT_ALLOWED_TABS).toContain(key);
        }
    });
});
