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

// Tab metadata only — no Vue imports here, because gui.js and sidebar_items.js
// import this module early and must not pull in components (circular imports).

export const GYROFLIGHT_TAB_KEY = "gyroflight";

/** Mirrors the shape of entries in src/components/sidebar/sidebar_items.js. */
export interface GyroflightSidebarItem {
    key: string;
    mode: "disconnected" | "connected" | "shared" | "cli" | "loggedin";
    i18n: string;
    icon: string;
    tab?: string;
    expert?: boolean;
    hideInSidebar?: boolean;
    buildOptions?: string[];
    feature?: string;
}

export const gyroflightSidebarItems: GyroflightSidebarItem[] = [
    { key: GYROFLIGHT_TAB_KEY, mode: "shared", i18n: "gyroflightTabTitle", icon: "i-lucide-activity" },
];

/** Tabs that must be reachable with or without a flight controller. */
export const gyroflightAllowedTabs = [GYROFLIGHT_TAB_KEY];
