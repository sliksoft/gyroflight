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

import i18next from "i18next";
import { i18n } from "@/js/localization";
import messages from "./locales/en.json";

/** The bundle in the flat key -> string form i18next expects, parsed exactly as upstream locale files are. */
export function gyroflightMessageStrings(): Record<string, string> {
    return i18n.parseInputFile(JSON.stringify(messages));
}

/**
 * Gyroflight strings live in their own bundle rather than locales/en/messages.json,
 * which is upstream's most frequently changed file. They are merged into the
 * English fallback namespace without overwriting any upstream key, so every
 * other language falls back to them.
 */
export function registerGyroflightMessages(): void {
    const add = () => i18next.addResourceBundle("en", "messages", gyroflightMessageStrings(), true, false);
    if (i18next.isInitialized) {
        add();
    } else {
        i18next.on("initialized", add);
    }
}
