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
 * Grokbot P2: synthetic full-chain fixtures must not declare Welch windowSamples beyond the
 * chirp end−start held in the channel buffer (production contract).
 */

import { describe, expect, it } from "vitest";
import { selectableQualificationLog, syntheticIdentityLog, syntheticLogInput } from "./harness/syntheticLog";

describe("synthetic fixture window contract (P2)", () => {
    it("default full-chain log: analysis window equals chirp end−start and fits channels", () => {
        const log = syntheticLogInput("f1".repeat(32));
        expect(log.channels.timeUs.length).toBeGreaterThanOrEqual(30 * 4000);
        for (const axis of ["roll", "pitch", "yaw"] as const) {
            const c = log.chirp[axis]!;
            const held = c.end - c.start;
            expect(c.analysis!.windowSamples).toBe(held);
            expect(c.analysis!.windowSamples).toBeLessThanOrEqual(log.channels.timeUs.length);
            expect(c.end).toBeLessThanOrEqual(log.channels.timeUs.length);
        }
    });

    it("identity helper keeps staggered short slices with window ≤ end−start", () => {
        const log = syntheticIdentityLog("i1".repeat(32));
        expect(log.channels.timeUs.length).toBe(11 * 4000);
        expect(Object.keys(log.chirp).sort()).toEqual(["pitch", "roll", "yaw"]);
        const roll = log.chirp.roll!;
        expect(roll.end - roll.start).toBeLessThanOrEqual(3 * 4000 + 1);
        expect(roll.analysis!.windowSamples).toBe(roll.end - roll.start);
    });

    it("selectable qualification log channels cover its declared 120 s window", () => {
        const log = selectableQualificationLog();
        expect(log.channels.timeUs.length).toBeGreaterThanOrEqual(120 * 4000);
        const c = log.chirp.roll!;
        expect(c.analysis!.windowSamples).toBe(c.end - c.start);
        expect(c.analysis!.windowSamples).toBeGreaterThanOrEqual(120 * 4000 - 4000);
    });
});
