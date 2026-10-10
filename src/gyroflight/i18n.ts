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
// Deliberate replacements of upstream English strings (product naming only), e.g. the
// default colour theme is Gyroflight's. Kept apart so en.json never shadows upstream.
import overrides from "./locales/en.overrides.json";
// Product names that replace an upstream string in EVERY language (e.g. the first sidebar entry is
// "Home", not a translation of "Welcome"). Re-applied whenever a language bundle loads.
import allLanguageOverrides from "./locales/all.overrides.json";

/** The bundle in the flat key -> string form i18next expects, parsed exactly as upstream locale files are. */
export function gyroflightMessageStrings(): Record<string, string> {
    return i18n.parseInputFile(JSON.stringify(messages));
}

export function gyroflightOverrideStrings(): Record<string, string> {
    return i18n.parseInputFile(JSON.stringify(overrides));
}

export function gyroflightAllLanguageOverrideStrings(): Record<string, string> {
    return i18n.parseInputFile(JSON.stringify(allLanguageOverrides));
}

function applyAllLanguageOverrides(): void {
    const languages = new Set(["en", ...(i18next.languages ?? []), ...(i18next.language ? [i18next.language] : [])]);
    for (const lng of languages) {
        i18next.addResourceBundle(lng, "messages", gyroflightAllLanguageOverrideStrings(), true, true);
    }
}

/**
 * Gyroflight strings live in their own bundle rather than locales/en/messages.json,
 * which is upstream's most frequently changed file. They are merged into the
 * English fallback namespace without overwriting any upstream key, so every
 * other language falls back to them.
 */
let listening = false;

export function registerGyroflightMessages(): void {
    const add = () => {
        i18next.addResourceBundle("en", "messages", gyroflightMessageStrings(), true, false);
        i18next.addResourceBundle("en", "messages", gyroflightOverrideStrings(), true, true);
        applyAllLanguageOverrides();
        // A language bundle loaded later (startup or a language switch) must not bring the upstream text back.
        if (!listening) {
            listening = true;
            i18next.on("loaded", applyAllLanguageOverrides);
            i18next.on("languageChanged", applyAllLanguageOverrides);
        }
    };
    if (i18next.isInitialized) {
        add();
    } else {
        i18next.on("initialized", add);
    }
}
