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
 * The product Apply lock holds on its own: with GyroCore Safety released by
 * the explicit test harness (it would otherwise block first), the Apply action
 * still refuses with full_safety_engine_pending before any MSP access.
 */

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const msp = vi.hoisted(() => ({ calls: [] as number[] }));
const picked = vi.hoisted(() => ({ bytes: new Uint8Array() as Uint8Array }));

vi.mock("../../src/js/FileSystem", () => ({
    default: {
        pickOpenFile: async () => ({ name: "lock.bbl" }),
        readFileAsBlob: async () => ({ arrayBuffer: async () => picked.bytes.slice().buffer }),
    },
}));

vi.mock("../../src/js/localization", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/js/localization")>()),
    i18n: { getMessage: (key: string) => key },
}));

vi.mock("../../src/js/msp", () => ({
    default: {
        promise: vi.fn(async (code: number) => {
            msp.calls.push(code);
            return null;
        }),
    },
}));

vi.mock("@/gyrocore/safety/authorize", async () => (await import("./harness/safetyRelease")).releasedSafety());

import { useAutotune } from "../../src/composables/useAutotune";
import { ApplyBlockedError } from "../../src/gyrocore/chirp/applyGate";
import { useChirpQualificationStore } from "../../src/gyrocore/stores/chirpQualification";
import { MERGE_E2E_CASES } from "./harness/mergeE2eCases";

beforeEach(() => {
    setActivePinia(createPinia());
    msp.calls = [];
});

describe("product Apply lock behind a released Safety step", () => {
    it("still blocks the safe positive fixture with full_safety_engine_pending and no MSP call", async () => {
        picked.bytes = MERGE_E2E_CASES.three_axis_agree();
        await useAutotune().importAndAnalyze();
        const composite = useChirpQualificationStore().composite!;
        expect(composite.authorized).toBe(true);
        const err = await useAutotune()
            .applyGains(composite.final!, composite.id)
            .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ApplyBlockedError);
        expect((err as ApplyBlockedError).reasons).toEqual(["full_safety_engine_pending"]);
        expect(msp.calls).toEqual([]);
    });
});
