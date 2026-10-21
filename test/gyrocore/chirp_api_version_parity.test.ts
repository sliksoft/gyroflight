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

// f2ca9013 retired the CONFIGURATOR singleton: the CHIRP parser's fallback API version now comes
// from data_storage's exported constant. The bounds and the DEBUG_CHIRP index must not move.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { API_VERSION_ACCEPTED, API_VERSION_MAX_SUPPORTED } from "../../src/js/data_storage";
import { getDebugModeIndex } from "../../src/js/utils/debugModes";
import reference from "./fixtures/chirp/upstream_reference.json";

const parserSource = fs.readFileSync(path.resolve(__dirname, "../../src/js/blackbox/chirp_bbl_parser.ts"), "utf-8");

describe("CHIRP API version parity after the CONFIGURATOR removal", () => {
    it("keeps the accepted and maximum API versions (1.44 .. 1.49)", () => {
        expect(API_VERSION_ACCEPTED).toBe("1.44.0");
        expect(API_VERSION_MAX_SUPPORTED).toBe("1.49.0");
    });

    it("matches the maximum the upstream CHIRP reference fixtures were generated with", () => {
        expect(API_VERSION_MAX_SUPPORTED).toBe(reference.provenance.api_version_max_supported);
    });

    it("resolves DEBUG_CHIRP at the fallback version exactly as at 1.49.0", () => {
        const index = getDebugModeIndex("CHIRP", API_VERSION_MAX_SUPPORTED);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBe(getDebugModeIndex("CHIRP", "1.49.0"));
    });

    it("falls back to the exported constant, not a CONFIGURATOR field", () => {
        expect(parserSource).toContain('import { API_VERSION_MAX_SUPPORTED } from "../data_storage";');
        expect(parserSource).toContain("effectiveApiVersion = API_VERSION_MAX_SUPPORTED;");
        expect(parserSource).not.toContain("CONFIGURATOR");
    });
});
