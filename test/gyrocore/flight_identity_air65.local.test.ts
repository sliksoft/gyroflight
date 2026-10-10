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
 * LOCAL ONLY: File and Flight identity on the real AIR65 three-log file.
 * Skipped unless GYROFLIGHT_AIR65_BBL is set (see air65_blackbox.local.test.ts).
 */

import { describe, expect, it } from "vitest";
import { catalogBbl, checkIndependentFlights } from "../../src/gyrocore/flight/identity";
import { AIR65_SHA256, localAir65 } from "./harness/fixtures";

const air65 = localAir65();

describe.skipIf(!air65)("AIR65 Flight identity (local only)", () => {
    const bytes = air65?.bbl ?? new Uint8Array();

    it("identifies the file and its three Flights as three distinct, valid recordings", async () => {
        const cat = await catalogBbl(bytes);
        expect(cat.file.sha256).toBe(AIR65_SHA256);
        expect(cat.status).toBe("valid");
        expect(cat.flights.map((f) => f.status)).toEqual(["valid", "valid", "valid"]);
        expect(new Set(cat.flights.map((f) => f.section.sha256)).size).toBe(3);
        for (const [a, b] of [
            [0, 1],
            [0, 2],
            [1, 2],
        ]) {
            expect(checkIndependentFlights(cat.flights[a], cat.flights[b]).independent).toBe(true);
        }
    });
});
