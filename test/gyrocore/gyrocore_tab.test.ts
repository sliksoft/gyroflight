/*
 * This file is part of GyroCore App, a derivative of the Betaflight App.
 *
 * GyroCore App is free software. You can redistribute this software
 * and/or modify this software under the terms of the GNU General
 * Public License as published by the Free Software Foundation,
 * either version 3 of the License, or (at your option) any later
 * version.
 *
 * GyroCore App is distributed in the hope that it will be useful,
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
import { GYROCORE_TAB_KEY, gyrocoreSidebarItems } from "../../src/gyrocore/tabs";
import { gyrocoreTabComponents } from "../../src/gyrocore/components";
import { gyrocoreCapabilities } from "../../src/gyrocore/capabilities";
import gyrocoreMessages from "../../src/gyrocore/locales/en.json";
import { gyrocoreMessageStrings, registerGyroCoreMessages } from "../../src/gyrocore/i18n";
import i18next from "i18next";

const upstreamMessages = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../locales/en/messages.json"), "utf-8"),
);

describe("GyroCore tab registration", () => {
    it("registers a component for the tab", () => {
        expect(gyrocoreTabComponents[GYROCORE_TAB_KEY]).toBeDefined();
    });

    it("appends the sidebar item after the upstream items without reordering them", () => {
        const keys = sidebarItems.map((item) => item.key);
        expect(keys[0]).toBe("landing");
        expect(keys[1]).toBe("firmware_flasher");
        expect(keys.indexOf(GYROCORE_TAB_KEY)).toBeGreaterThan(keys.indexOf("blackbox_viewer"));
        expect(sidebarItems.find((item) => item.key === GYROCORE_TAB_KEY)?.mode).toBe("shared");
    });

    it("is allowed both with and without a connected flight controller", () => {
        expect(GUI.defaultAllowedTabsWhenDisconnected).toContain(GYROCORE_TAB_KEY);
        expect(GUI.defaultAllowedTabs).toContain(GYROCORE_TAB_KEY);
    });

    it("keeps the upstream feature tabs reachable", () => {
        for (const key of ["firmware_flasher", "blackbox_viewer", "autotune"]) {
            expect(GUI.defaultAllowedTabsWhenDisconnected).toContain(key);
        }
    });
});

describe("GyroCore messages", () => {
    it("defines every key the tab and sidebar reference", () => {
        const used = [...gyrocoreSidebarItems.map((item) => item.i18n), ...gyrocoreCapabilities.map((c) => c.label)];
        for (const key of used) {
            expect(gyrocoreMessages).toHaveProperty(key);
        }
    });

    it("registers plain strings, not the raw { message } objects", () => {
        const strings = gyrocoreMessageStrings();
        expect(Object.keys(strings)).toEqual(Object.keys(gyrocoreMessages));
        for (const value of Object.values(strings)) {
            expect(typeof value).toBe("string");
        }
        expect(strings.gyrocoreTabTitle).toBe("GyroCore");
    });

    it("resolves to text through i18next once registered, including from a non-English language", async () => {
        await i18next.init({ lng: "de", fallbackLng: ["en"], ns: ["messages"], defaultNS: "messages", resources: {} });
        registerGyroCoreMessages();
        expect(i18next.t("gyrocoreTabTitle")).toBe("GyroCore");
        expect(i18next.t("gyrocoreStatusPending")).toBe("Migration pending");
    });

    it("never shadows an upstream message key", () => {
        for (const key of Object.keys(gyrocoreMessages)) {
            expect(upstreamMessages).not.toHaveProperty(key);
        }
    });
});
