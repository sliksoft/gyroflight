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
 * The slider Preview runs the firmware calculation through the shared FC store, where the PID
 * tab's Save could pick the proposal up (review of the P0 fix, F1). So Preview needs the slider
 * route's whole write authority: with GyroCore Safety or the product lock real (production),
 * nothing reaches the craft and the store keeps what it held. The composite gate is real, with
 * the composite's final replaced by gate.change as in tune_apply_route.test.ts; the control case
 * releases Safety and the product lock and shows the Preview does run.
 */

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Craft } from "./harness/mspCraft";

const gate = vi.hoisted(() => ({
    craft: undefined as unknown as Craft,
    change: null as null | Record<string, number>,
    picked: new Uint8Array() as Uint8Array,
    safety: true,
    product: true,
}));

vi.mock("./harness/chirpSim", async (importOriginal) =>
    (await importOriginal<typeof import("./harness/chirpSim")>()).withIdentityHeaders(
        await importOriginal<typeof import("./harness/chirpSim")>(),
    ),
);
vi.mock("../../src/js/FileSystem", () => ({
    default: {
        pickOpenFile: async () => ({ name: "route.bbl" }),
        readFileAsBlob: async () => ({ arrayBuffer: async () => gate.picked.slice().buffer }),
    },
}));
vi.mock("../../src/js/localization", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/js/localization")>()),
    i18n: { getMessage: (key: string) => key },
}));
vi.mock("../../src/js/msp", () => ({
    default: {
        promise: vi.fn(async (code: number, data?: number[]) =>
            (await import("./harness/mspCraft")).craftPromise(gate.craft, code, data),
        ),
    },
}));
vi.mock("@/gyrocore/safety/authorize", async () => {
    const actual =
        await vi.importActual<typeof import("../../src/gyrocore/safety/authorize")>("@/gyrocore/safety/authorize");
    const released = await (await import("./harness/safetyRelease")).releasedSafety();
    return {
        ...actual,
        assertSafetyAuthorized: (...a: Parameters<typeof actual.assertSafetyAuthorized>) =>
            gate.safety ? released.assertSafetyAuthorized(a[0], a[1]) : actual.assertSafetyAuthorized(...a),
    };
});
vi.mock("@/gyrocore/productLock/productApply", async () => {
    const actual = await vi.importActual<typeof import("../../src/gyrocore/productLock/productApply")>(
        "@/gyrocore/productLock/productApply",
    );
    return {
        ...actual,
        assertProductApplyReleased: (...a: Parameters<typeof actual.assertProductApplyReleased>) =>
            gate.product ? undefined : actual.assertProductApplyReleased(...a),
    };
});
vi.mock("@/gyrocore/tuning/authorize", async () => {
    const actual =
        await vi.importActual<typeof import("../../src/gyrocore/tuning/authorize")>("@/gyrocore/tuning/authorize");
    const { ApplyBlockedError: Blocked } =
        await vi.importActual<typeof import("../../src/gyrocore/chirp/applyGate")>("@/gyrocore/chirp/applyGate");
    return {
        ...actual,
        assertCompositeApplyAuthorized: (...args: Parameters<typeof actual.assertCompositeApplyAuthorized>) => {
            const [state, id, sliders] = args;
            const held = actual.authorizeCompositeApply(state, id, undefined).composite;
            const composite = actual.assertCompositeApplyAuthorized(state, id, held?.final);
            if (JSON.stringify(sliders) !== JSON.stringify(gate.change)) {
                throw new Blocked(["apply:sliders_differ_from_composite"]);
            }
            return { ...composite, final: { ...gate.change! } };
        },
    };
});

import { useAutotune } from "../../src/composables/useAutotune";
import { previewTune } from "../../src/composables/useTuneApply";
import { ApplyBlockedError } from "../../src/gyrocore/chirp/applyGate";
import { useChirpQualificationStore } from "../../src/gyrocore/stores/chirpQualification";
import { useFlightControllerStore } from "../../src/stores/fc";
import { clearPhaseMarginForGate } from "./harness/clearPhaseMarginBlock";
import { MERGE_E2E_CASES } from "./harness/mergeE2eCases";
import { createCraft } from "./harness/mspCraft";

const CHANGE = {
    slider_master_multiplier: 100,
    slider_pi_gain: 110,
    slider_i_gain: 100,
    slider_d_gain: 105,
    slider_feedforward_gain: 100,
    slider_dterm_filter_multiplier: 110,
};

async function load() {
    gate.picked = MERGE_E2E_CASES.three_axis_agree();
    await useAutotune().importAndAnalyze();
    const store = useChirpQualificationStore();
    clearPhaseMarginForGate(store);
    return store.composite!;
}

/** What an upstream Save would serialize: the FC store's tuning blocks. */
function storeTuning() {
    const fc = useFlightControllerStore();
    return JSON.parse(
        JSON.stringify({
            sliders: { ...fc.tuningSliders },
            pids: fc.pids.map((r) => [...r]),
            advanced: { ...fc.advancedTuning },
            filters: { ...fc.filterConfig },
        }),
    );
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    gate.craft = createCraft();
    gate.change = { ...CHANGE };
    gate.safety = true;
    gate.product = true;
});

describe("slider Preview needs the write authority", () => {
    it("control: with Safety and the product lock released, Preview reads the craft and calculates", async () => {
        const c = await load();
        const p = await previewTune(CHANGE, c.id);
        expect(p.expected.sliders.slider_pi_gain).toBe(110);
        expect(gate.craft.calls.length).toBeGreaterThan(0);
    });

    it.each([
        ["GyroCore Safety", () => (gate.safety = false), "safety:"],
        ["the product lock", () => (gate.product = false), "full_safety_engine_pending"],
        [
            "the composite gate (sliders other than the composite's)",
            () => (gate.change = { ...CHANGE, slider_pi_gain: 120 }),
            "apply:sliders_differ_from_composite",
        ],
    ])("%s real: refused, no MSP request, the FC store unchanged", async (_name, close, reason) => {
        const c = await load();
        close();
        const before = storeTuning();
        const err = await previewTune(CHANGE, c.id).then(
            () => null,
            (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(ApplyBlockedError);
        expect((err as ApplyBlockedError).reasons.join(" ")).toContain(reason);
        expect(gate.craft.calls).toEqual([]);
        expect(storeTuning()).toEqual(before);
    });
});
