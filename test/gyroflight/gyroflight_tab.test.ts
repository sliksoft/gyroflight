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

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { sidebarItems } from "../../src/components/sidebar/sidebar_items.js";
import GUI from "../../src/js/gui";
import { GYROFLIGHT_TAB_KEY, gyroflightHiddenSidebarKeys, gyroflightSidebarItems } from "../../src/gyroflight/tabs";
import { gyroflightTabComponents } from "../../src/gyroflight/components";
import { gyroflightCapabilities } from "../../src/gyroflight/capabilities";
import gyroflightMessages from "../../src/gyroflight/locales/en.json";
import { gyroflightMessageStrings, registerGyroflightMessages } from "../../src/gyroflight/i18n";
import i18next from "i18next";

const upstreamMessages = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../locales/en/messages.json"), "utf-8"),
);

describe("Gyroflight tab registration", () => {
    it("registers a component for the tab", () => {
        expect(gyroflightTabComponents[GYROFLIGHT_TAB_KEY]).toBeDefined();
    });

    it("appends the sidebar item after the upstream items without reordering them", () => {
        const keys = sidebarItems.map((item) => item.key);
        expect(keys[0]).toBe("landing");
        expect(keys[1]).toBe("firmware_flasher");
        expect(keys.indexOf(GYROFLIGHT_TAB_KEY)).toBeGreaterThan(keys.indexOf("blackbox_viewer"));
        expect(sidebarItems.find((item) => item.key === GYROFLIGHT_TAB_KEY)?.mode).toBe("shared");
    });

    it("is allowed both with and without a connected flight controller", () => {
        expect(GUI.defaultAllowedTabsWhenDisconnected).toContain(GYROFLIGHT_TAB_KEY);
        expect(GUI.defaultAllowedTabs).toContain(GYROFLIGHT_TAB_KEY);
    });

    it("keeps the upstream feature tabs reachable", () => {
        for (const key of ["firmware_flasher", "blackbox_viewer", "autotune"]) {
            expect(GUI.defaultAllowedTabsWhenDisconnected).toContain(key);
        }
    });

    it("keeps Autotune behind upstream Expert Mode", () => {
        expect(sidebarItems.find((item) => item.key === "autotune")?.expert).toBe(true);
    });

    it("hides Pre-Flight and both Flight Plan sidebar entries without deleting the upstream tabs", () => {
        expect([...gyroflightHiddenSidebarKeys].sort()).toEqual(["flight_plan", "flight_plan_connected", "preflight"]);
        expect(sidebarItems.some((item) => item.key === "preflight")).toBe(true);
        expect(sidebarItems.some((item) => item.key === "flight_plan")).toBe(true);
        expect(sidebarItems.some((item) => item.key === "flight_plan_connected")).toBe(true);
    });

    it("overrides only the landing component through the Gyroflight integration layer", () => {
        expect(gyroflightTabComponents.landing).toBeDefined();
    });
});

describe("Gyroflight messages", () => {
    it("defines every key the tab and sidebar reference", () => {
        const used = [
            ...gyroflightSidebarItems.map((item) => item.i18n),
            ...gyroflightCapabilities.map((c) => c.label),
        ];
        for (const key of used) {
            expect(gyroflightMessages).toHaveProperty(key);
        }
    });

    it("registers plain strings, not the raw { message } objects", () => {
        const strings = gyroflightMessageStrings();
        expect(Object.keys(strings)).toEqual(Object.keys(gyroflightMessages));
        for (const value of Object.values(strings)) {
            expect(typeof value).toBe("string");
        }
        expect(strings.gyroflightTabTitle).toBe("Gyroflight");
    });

    it("resolves to text through i18next once registered, including from a non-English language", async () => {
        await i18next.init({ lng: "de", fallbackLng: ["en"], ns: ["messages"], defaultNS: "messages", resources: {} });
        registerGyroflightMessages();
        expect(i18next.t("gyroflightTabTitle")).toBe("Gyroflight");
        expect(i18next.t("gyroflightStatusLocked")).toBe("Locked");
    });

    it("never shadows an upstream message key", () => {
        for (const key of Object.keys(gyroflightMessages)) {
            expect(upstreamMessages).not.toHaveProperty(key);
        }
    });
});
