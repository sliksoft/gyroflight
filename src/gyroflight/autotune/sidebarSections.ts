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

import { AUTOTUNE_SECTIONS, AUTOTUNE_SECTION_ICONS, type AutotuneSection } from "./sections";

/** One sidebar entry as Sidebar.vue hands it to UNavigationMenu. */
export interface GyroflightSidebarEntry {
    label: string;
    icon: string;
    active: boolean;
    tooltip: { text: string };
    onSelect: (event?: Event) => void;
    class?: string;
    "data-autotune-section"?: AutotuneSection;
    "aria-current"?: "page";
}

export interface AutotuneSidebarContext {
    /** The tab the app shows now. */
    activeTab: string | null;
    /** The open Autotune section. */
    activeSection: AutotuneSection;
    t: (key: string) => string;
    openSection: (section: AutotuneSection) => void;
    /** Indent the sections under Autotune (not when the sidebar shows icons only). */
    indent: boolean;
    /** Closes the drawer on a phone after a choice. */
    closeMobileSidebar: () => void;
}

/**
 * Gyroflight: the Autotune sections are listed in the main sidebar, right under the Autotune entry,
 * while the Autotune tab is open, so the tab needs no navigation column of its own. The Autotune
 * entry itself is then not highlighted: the open section is.
 */
export function withAutotuneSections<T extends GyroflightSidebarEntry>(
    items: T[],
    keys: string[],
    ctx: AutotuneSidebarContext,
): (T | GyroflightSidebarEntry)[] {
    const at = keys.indexOf("autotune");
    if (at < 0 || ctx.activeTab !== "autotune") {
        return items;
    }
    const children = AUTOTUNE_SECTIONS.map((section): GyroflightSidebarEntry => {
        const label = ctx.t(`gyroflightAutotuneSection_${section}`);
        const active = ctx.activeSection === section;
        return {
            label,
            icon: AUTOTUNE_SECTION_ICONS[section],
            active,
            tooltip: { text: label },
            ...(ctx.indent ? { class: "ps-7" } : {}),
            "data-autotune-section": section,
            ...(active ? { "aria-current": "page" as const } : {}),
            onSelect: (event?: Event) => {
                event?.preventDefault?.();
                ctx.openSection(section);
                ctx.closeMobileSidebar();
            },
        };
    });
    const parent = { ...items[at], active: false };
    return [...items.slice(0, at), parent, ...children, ...items.slice(at + 1)];
}
