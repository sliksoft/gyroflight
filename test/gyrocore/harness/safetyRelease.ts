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
 * TEST ONLY: a released Safety step, so a test can exercise the write path
 * behind it (composite gate, live recheck, exact MSP payload) with mocked MSP.
 * It does not fabricate analysis evidence: it replaces the Safety module's
 * verdict with PASS for the exact composite it is asked about, and is labelled
 * so in the result. Production has no way to do this. Use, in a test file:
 *
 *   vi.mock("@/gyrocore/safety/authorize", async () =>
 *       (await import("<relative path to>/harness/safetyRelease")).releasedSafety());
 */

import { vi } from "vitest";

export async function releasedSafety() {
    const actual =
        await vi.importActual<typeof import("../../../src/gyrocore/safety/authorize")>("@/gyrocore/safety/authorize");
    type Args = Parameters<typeof actual.safetyForComposite>;
    const released = (state: Args[0], composite: Args[1]) => {
        const real = actual.safetyForComposite(state, composite);
        if (real.status === "NOT_EVALUATED") {
            return real;
        }
        return {
            ...real,
            status: "PASS" as const,
            blocks: [],
            warnings: ["TEST_HARNESS_SAFETY_RELEASED"],
            authorized: true,
        };
    };
    return {
        ...actual,
        safetyForComposite: released,
        assertSafetyAuthorized: (state: Args[0], composite: NonNullable<Args[1]>) => released(state, composite),
    };
}
