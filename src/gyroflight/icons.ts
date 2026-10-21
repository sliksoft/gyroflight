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

// Nuxt UI draws every `i-lucide-*` icon through @iconify/vue, which fetches icon data from
// api.iconify.design (falling back to api.simplesvg.com / api.unisvg.com) the first time a
// name is shown. Offline, in the installed PWA, those icons stay blank, and every start sends
// a request to a third party. Registering the bundled Lucide set (@iconify-json/lucide, already
// a dependency) before the app mounts makes all of them local; @iconify/vue then never asks the
// API for a lucide icon.

import { addCollection } from "@iconify/vue";
import lucide from "@iconify-json/lucide/icons.json";

export const BUNDLED_ICON_PREFIXES = ["lucide"] as const;

export function registerBundledIcons(): boolean {
    return addCollection(lucide);
}

registerBundledIcons();
