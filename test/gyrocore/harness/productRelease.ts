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
 * TEST ONLY: a released product Apply lock, so a test can exercise the write
 * path behind it (authorization, live recheck, exact MSP payload) with mocked
 * MSP. Production has no way to release the lock. Use, in a test file:
 *
 *   vi.mock("@/gyrocore/productLock/productApply", async () =>
 *       (await import("<relative path to>/harness/productRelease")).releasedProductApply());
 */

import { vi } from "vitest";

export async function releasedProductApply() {
    const actual = await vi.importActual<typeof import("../../../src/gyrocore/productLock/productApply")>(
        "@/gyrocore/productLock/productApply",
    );
    const productApplyBlocks = (): string[] => [];
    return {
        ...actual,
        productApplyBlocks,
        assertProductApplyReleased: () => undefined,
    };
}
