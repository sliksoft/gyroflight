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
 * LOCAL TOOL (WU3): writes the generated merge end-to-end logs to
 * $GYROFLIGHT_WRITE_E2E_DIR as <case>.bbl, for tools/gc_merge_e2e.py.
 * Skipped unless that variable is set.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import { MERGE_E2E_CASES } from "./harness/mergeE2eCases";

const dir = process.env.GYROFLIGHT_WRITE_E2E_DIR;

describe.skipIf(!dir)("write merge end-to-end logs (local tool)", () => {
    it("writes every case", () => {
        for (const [id, make] of Object.entries(MERGE_E2E_CASES)) {
            writeFileSync(join(dir!, `${id}.bbl`), make());
        }
    });
});
