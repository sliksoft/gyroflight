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

// Nuxt UI draws `i-lucide-*` icons through @iconify/vue, which asks api.iconify.design for any
// icon it does not already hold. src/gyroflight/icons.ts registers the bundled Lucide set so the
// installed PWA draws every icon offline and the app sends no request to the icon API. These cases
// check that the set is registered, that every lucide name the app and Nuxt UI use is in it (a
// missing or renamed one would silently fall back to the API), and that the app actually loads it.

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getIcon, iconLoaded } from "@iconify/vue";
import lucide from "@iconify-json/lucide/icons.json";
import { BUNDLED_ICON_PREFIXES, registerBundledIcons } from "../../src/gyroflight/icons";

const ROOT = resolve(__dirname, "../..");

function lucideNamesIn(dir: string, exts: RegExp): string[] {
    const names = new Set<string>();
    const walk = (d: string) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
            const p = join(d, e.name);
            if (e.isDirectory()) {
                if (e.name !== "dist" && e.name !== "node_modules") walk(p);
            } else if (exts.test(e.name)) {
                for (const m of readFileSync(p, "utf8").matchAll(/i-lucide-([a-z0-9]+(?:-[a-z0-9]+)*)/g)) {
                    names.add(m[1]);
                }
            }
        }
    };
    walk(dir);
    return [...names].sort();
}

describe("bundled icons for offline use", () => {
    it("registers the Lucide set on import, so icons resolve without the API", () => {
        expect(BUNDLED_ICON_PREFIXES).toEqual(["lucide"]);
        expect(iconLoaded("lucide:house")).toBe(true);
        expect(getIcon("lucide:house")?.body).toContain("<path");
        expect(registerBundledIcons()).toBe(true);
    });

    it("holds every lucide icon the app and Nuxt UI name", () => {
        const app = lucideNamesIn(join(ROOT, "src"), /\.(vue|ts|js)$/);
        const nuxtUi = lucideNamesIn(join(ROOT, "node_modules/@nuxt/ui/dist"), /\.(vue|ts|js|mjs)$/);
        expect(app.length).toBeGreaterThan(50);
        expect(nuxtUi.length).toBeGreaterThan(10);
        const known = new Set([...Object.keys(lucide.icons), ...Object.keys(lucide.aliases ?? {})]);
        expect([...app, ...nuxtUi].filter((n) => !known.has(n))).toEqual([]);
        for (const n of [...app, ...nuxtUi]) {
            expect(iconLoaded(`lucide:${n}`)).toBe(true);
        }
    });

    it("the app registers them before it mounts", () => {
        const init = readFileSync(join(ROOT, "src/components/init.ts"), "utf8");
        const icons = init.indexOf('import "../gyroflight/icons";');
        expect(icons).toBeGreaterThan(-1);
        expect(icons).toBeLessThan(init.indexOf("createApp({"));
    });

    it("renders an icon without any network request", async () => {
        const fetchSpy = vi.spyOn(globalThis, "fetch");
        const { mount } = await import("@vue/test-utils");
        const { Icon } = await import("@iconify/vue");
        const w = mount(Icon, { props: { icon: "lucide:table" } });
        await new Promise((r) => setTimeout(r, 50));
        expect(w.html()).toContain("<path");
        expect(fetchSpy).not.toHaveBeenCalled();
        w.unmount();
        fetchSpy.mockRestore();
    });
});
