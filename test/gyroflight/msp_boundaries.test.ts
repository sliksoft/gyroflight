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

// @vitest-environment node

// 2a8e3a23 made eslint-plugin-boundaries reject value imports of MSP outside src/stores,
// src/composables and src/js. src/gyrocore/stores and src/gyrocore/composables are not those
// folders, so GyroCore and Gyroflight count as UI and must reach the FC through upstream's stores
// and composables. The plugin skips imports it cannot resolve, so a clean lint run alone does
// not prove the rule covers our folders; these cases lint real paths with the real config.

import path from "node:path";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
let eslint: ESLint;

async function boundaryErrors(file: string, code: string): Promise<number> {
    const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, file) });
    return result.messages.filter((m) => m.ruleId === "boundaries/dependencies").length;
}

describe("MSP module boundary for Gyroflight and GyroCore", () => {
    beforeAll(() => {
        eslint = new ESLint({ cwd: ROOT });
    });

    it.each([
        ["src/gyrocore/composables/probe.ts", 'import MSP from "@/js/msp";\nexport const probe = MSP;\n'],
        ["src/gyrocore/stores/probe.ts", 'import MSP from "../../js/msp";\nexport const probe = MSP;\n'],
        ["src/gyrocore/tuning/probe.ts", 'import MSPCodes from "@/js/msp/MSPCodes";\nexport const probe = MSPCodes;\n'],
        ["src/gyroflight/probe.ts", 'export const probe = () => import("@/js/msp");\n'],
    ])(
        "rejects a runtime MSP import from %s",
        async (file, code) => {
            expect(await boundaryErrors(file, code)).toBe(1);
        },
        60_000,
    );

    // .vue goes through vue-eslint-parser, where an unresolved import would be skipped just as silently.
    it.each([
        ["src/gyrocore/components/Probe.vue", "@/js/msp"],
        ["src/gyroflight/tabs/Probe.vue", "../../js/msp"],
    ])(
        "rejects a runtime MSP import from the component %s",
        async (file, source) => {
            const code = `<script setup lang="ts">\nimport MSP from "${source}";\nconsole.log(MSP);\n</script>\n`;
            expect(await boundaryErrors(file, code)).toBe(1);
        },
        60_000,
    );

    it("allows a type-only MSP import from GyroCore", async () => {
        const code = 'import type { MspResponse } from "@/js/msp";\nexport type Probe = MspResponse;\n';
        expect(await boundaryErrors("src/gyrocore/tuning/probe.ts", code)).toBe(0);
    }, 60_000);

    it("allows the MSP import in upstream's composables, where Apply writes through useAutotune", async () => {
        const code = 'import MSP from "@/js/msp";\nexport const probe = MSP;\n';
        expect(await boundaryErrors("src/composables/probe.ts", code)).toBe(0);
    }, 60_000);
});
