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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settings = {
    sessionId: "session",
    userId: "user",
    appName: "Gyroflight",
    appVersion: "0.0.0",
    gitRevision: "test",
    os: "Linux",
    checkForDebugVersions: false,
    optOut: false,
};

async function loadAnalytics(analyticsEnabled: boolean) {
    vi.resetModules();
    vi.doMock("../../src/gyroflight/policy", () => ({
        UPSTREAM_ANALYTICS_ENABLED: analyticsEnabled,
        BETAFLIGHT_ACCOUNTS_ENABLED: false,
    }));
    return import("../../src/js/Analytics");
}

describe("Gyroflight privacy policy", () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(new Response("{}")));

    beforeEach(() => {
        fetchMock.mockClear();
        vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(() => {
        vi.doUnmock("../../src/gyroflight/policy");
        vi.unstubAllGlobals();
    });

    it("ships with upstream analytics and Betaflight accounts disabled", async () => {
        vi.resetModules();
        const policy = await import("../../src/gyroflight/policy");
        expect(policy.UPSTREAM_ANALYTICS_ENABLED).toBe(false);
        expect(policy.BETAFLIGHT_ACCOUNTS_ENABLED).toBe(false);
    });

    it("sends nothing even when the user has not opted out", async () => {
        const { Analytics } = await loadAnalytics(false);
        const tracking = new Analytics(settings);
        tracking.sendEvent(tracking.EVENT_CATEGORIES.APPLICATION, "AppStart", {});
        tracking.sendAppView("firmware_flasher");
        tracking.setOptOut(false);
        tracking.sendException("boom");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("would reach analytics.betaflight.com if the flag were enabled (control)", async () => {
        const { Analytics } = await loadAnalytics(true);
        const tracking = new Analytics(settings);
        tracking.sendAppView("firmware_flasher");
        expect(fetchMock).toHaveBeenCalled();
        expect(String(fetchMock.mock.calls[0][0])).toContain("analytics.betaflight.com");
    });
});
