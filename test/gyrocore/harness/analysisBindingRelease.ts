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
 * TEST ONLY: a released analysis binding (writeAuthority.ts step analysis_binding), so a test can
 * exercise the write path behind it with a proposal the app's own analysis could not produce
 * (no producer of a model-class qualification exists in the app). Every other step of the write
 * authority stays real unless replaced too. Production has no way to do this. Use, in a test file:
 *
 *   vi.mock("@/gyrocore/releaseGate/analysisBinding", async () =>
 *       (await import("<relative path to>/harness/analysisBindingRelease")).releasedAnalysisBinding());
 */

import { vi } from "vitest";

export async function releasedAnalysisBinding() {
    const actual = await vi.importActual<typeof import("../../../src/gyrocore/releaseGate/analysisBinding")>(
        "@/gyrocore/releaseGate/analysisBinding",
    );
    return {
        ...actual,
        analysisBindingIssues: (): string[] => [],
    };
}
