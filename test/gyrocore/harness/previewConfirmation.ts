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
 * Every confirmation token carries the hash of the read-only preview the user saw
 * (applyConfirmation.ts); a route refuses a token without one. Tests issue tokens the way the
 * interface does: from the real preview of the simulated craft.
 */

import { ApplyBlockedError } from "../../../src/gyrocore/chirp/applyGate";
import type { Craft } from "./mspCraft";
import type { FirmwareFc } from "./mspFirmware";

/** A hash for a token whose route stops before it compares the hash (a refusal test). */
export const UNREAD_PREVIEW = "test:preview-not-read";

/**
 * The hash the preview shows now. The fault injection a test arranged is meant for the write that
 * follows, so it is paused while the preview reads (`paused`: the simulator fields and their
 * fault-free values), and the preview's MSP traffic is dropped from the call log. A preview that
 * the route refuses anyway (ApplyBlockedError) gives UNREAD_PREVIEW: the write then stops at that
 * same check, before the hash is compared.
 */
export async function previewedHash<S extends { calls: unknown[] }>(
    sim: S,
    paused: Partial<S>,
    preview: () => Promise<{ hash: string }>,
): Promise<string> {
    const keys = Object.keys(paused) as (keyof S)[];
    const saved = keys.map((k) => [k, sim[k]] as const);
    const n = sim.calls.length;
    Object.assign(sim, paused);
    try {
        return (await preview()).hash;
    } catch (err) {
        // Only the route's own refusal; anything else is a broken test and must surface.
        if (!(err instanceof ApplyBlockedError)) throw err;
        return UNREAD_PREVIEW;
    } finally {
        for (const [k, v] of saved) sim[k] = v;
        sim.calls.length = n;
    }
}

/** The firmware simulator (mspFirmware.ts) without its injected faults. */
export const FAULT_FREE_FIRMWARE = (): Partial<FirmwareFc> => ({
    faults: {},
    faultsAfterWrites: [],
    truncate: {},
    disconnectWhen: undefined,
});

/** The slider-route craft simulator (mspCraft.ts) without its injected faults. */
export const FAULT_FREE_CRAFT = (): Partial<Craft> => ({ faults: {}, faultsAfterWrite: {} });
