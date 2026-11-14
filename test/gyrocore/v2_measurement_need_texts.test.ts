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

/*
 * Every further measurement the engine asks for (`required_measurement:<code>`) has a sentence in
 * the panel (`gyroflightV2Need_<code>`), so the user is told what to fly, not shown a code.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "../../src");

function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) return n === "dist" ? [] : sources(p);
        return /\.(ts|vue)$/.test(n) ? [p] : [];
    });
}

/** The codes the source emits; `${…}` in a template literal stands for an axis name. */
function emittedCodes(): string[] {
    const codes = new Set<string>();
    for (const file of sources(ROOT)) {
        for (const m of readFileSync(file, "utf8").matchAll(/required_measurement:([A-Za-z0-9_${}.]+)/g)) {
            const code = m[1];
            if (!/[a-z0-9]$/.test(code)) continue; // a regex or prefix, not an emitted code
            const forms = code.includes("${")
                ? ["roll", "pitch", "yaw"].map((a) => code.replace(/\$\{[^}]+\}/g, a))
                : [code];
            forms.forEach((c) => codes.add(c));
        }
    }
    return [...codes].sort();
}

describe("required measurements have panel texts", () => {
    const messages = JSON.parse(readFileSync(join(ROOT, "gyroflight/locales/en.json"), "utf8")) as Record<
        string,
        { message?: string }
    >;

    it("finds the codes it checks", () => {
        expect(emittedCodes()).toContain("chirp_finer_resolution_model_class_qualification");
        expect(emittedCodes()).toContain("chirp_yaw_meeting_qualification");
    });

    it.each(emittedCodes())("%s", (code) => {
        expect(messages[`gyroflightV2Need_${code}`]?.message, code).toMatch(/\S/);
    });
});
