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

import { defineStore } from "pinia";
import { ref } from "vue";

/** The Autotune tab's sections, in navigation order. */
export const AUTOTUNE_SECTIONS = ["overview", "chirp", "graphs", "tuning", "compare", "plan", "technical"] as const;
export type AutotuneSection = (typeof AUTOTUNE_SECTIONS)[number];

export const AUTOTUNE_SECTION_ICONS: Record<AutotuneSection, string> = {
    overview: "i-lucide-layout-dashboard",
    chirp: "i-lucide-audio-waveform",
    graphs: "i-lucide-chart-spline",
    tuning: "i-lucide-sliders-horizontal",
    compare: "i-lucide-git-compare",
    plan: "i-lucide-clipboard-list",
    technical: "i-lucide-microscope",
};

/**
 * The open section. Kept in a store, not in the tab, so it survives leaving and reopening the tab;
 * the imported log and every analysis result live in their own stores and are never reset here.
 */
export const useAutotuneSectionStore = defineStore("gyroflightAutotuneSection", () => {
    const active = ref<AutotuneSection>("overview");
    function open(section: AutotuneSection) {
        active.value = section;
    }
    return { active, open };
});
