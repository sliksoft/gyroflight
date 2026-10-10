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

// Gyroflight navigation policy, applied to Betaflight's sidebar list by one hook in
// src/components/sidebar/sidebar_items.js. Entries listed here get upstream's own
// `hideInSidebar` flag: the sidebar and the compact bar skip them, but the tabs, their
// components and switchTab() stay exactly as upstream ships them.
// Nothing here may change `expert`, `mode`, `buildOptions` or `feature`.

/**
 * Sidebar keys hidden in Gyroflight: Pre-Flight, both Flight Plan entries (disconnected and
 * connected), Documentation & Support (help) and the Gyroflight status tab. Their tabs stay
 * registered and reachable through switchTab(); only the sidebar entry is hidden.
 */
export const GYROFLIGHT_HIDDEN_SIDEBAR_KEYS: readonly string[] = [
    "preflight",
    "flight_plan",
    "flight_plan_connected",
    "help",
    "gyroflight",
];

export function applyGyroflightSidebarPolicy<T extends { key: string; hideInSidebar?: boolean }>(items: T[]): T[] {
    return items.map((item) =>
        GYROFLIGHT_HIDDEN_SIDEBAR_KEYS.includes(item.key) ? { ...item, hideInSidebar: true } : item,
    );
}
