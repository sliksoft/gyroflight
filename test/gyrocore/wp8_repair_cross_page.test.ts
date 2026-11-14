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
 * Audit WP8-F02, the reported scenario: page A runs a Gyroflight transaction (withFcWriteLock) and is
 * still reading, so no pending entry is stored yet; page B, another tab of the origin, sends an
 * ordinary SET. "Page A" is a second instance of the production modules (vi.resetModules) with
 * its own Pinia; the pages share what tabs share: navigator.locks, localStorage and the
 * BroadcastChannel. Page B's write must not be admitted while A's transaction runs.
 */

import { createPinia, setActivePinia, type Pinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MSP from "../../src/js/msp";
import MSPCodes from "../../src/js/msp/MSPCodes";
import { serial } from "../../src/js/serial";
import { useConnectionStore } from "../../src/stores/connection";
import { useFlightControllerStore } from "../../src/stores/fc";
import { mspRequestRefusal } from "../../src/composables/fcWriteGuard";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pageB: Pinia;
let sent: number[][];

beforeEach(() => {
    pageB = createPinia();
    setActivePinia(pageB);
    localStorage.clear();
    sent = [];
    (serial as unknown as { _protocol: unknown })._protocol = { connected: true };
    vi.spyOn(serial, "send").mockImplementation(async (d) => {
        sent.push(Array.from(new Uint8Array(d as ArrayBuffer)));
        return { bytesSent: (d as ArrayBuffer).byteLength };
    });
    useConnectionStore().virtualMode = false;
    useFlightControllerStore().config.uid = [9, 9, 9];
    MSP.callbacks = [];
    MSP.write_transmissions.clear();
    MSP.parked.clear();
});

afterEach(() => {
    MSP.callbacks_cleanup();
    vi.restoreAllMocks();
});

/** Page A: fresh production modules and its own Pinia, starting a transaction that waits in its reads. */
async function pageATransaction() {
    vi.resetModules();
    const guardA = await import("../../src/composables/fcWriteGuard");
    const piniaA = createPinia();
    setActivePinia(piniaA);
    let release!: () => void;
    let entered!: () => void;
    const reading = new Promise<void>((r) => (entered = r));
    const tx = guardA.withFcWriteLock(
        () =>
            new Promise<void>((r) => {
                release = r;
                entered();
            }),
    );
    setActivePinia(pageB);
    await reading;
    return { release: () => release(), tx };
}

describe("WP8-F02 another tab's ordinary write while a transaction reads", () => {
    it("page B's SET is not admitted and nothing is sent while page A's transaction runs; afterwards it is", async () => {
        await wait(20);
        expect(mspRequestRefusal(MSPCodes.MSP_SET_PID, [1])).toBeNull();
        const a = await pageATransaction();
        expect(localStorage.length).toBe(0); // A has stored no pending entry yet
        expect(mspRequestRefusal(MSPCodes.MSP_SET_PID, [1])).not.toBeNull();
        const err = await MSP.promise(MSPCodes.MSP_SET_PID, [1]).then(
            () => null,
            (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(Error);
        expect(sent).toEqual([]);
        a.release();
        await a.tx;
        await wait(50);
        expect(mspRequestRefusal(MSPCodes.MSP_SET_PID, [1])).toBeNull();
    });

    it("page B's CLI write is not admitted either while page A's transaction runs", async () => {
        await wait(20);
        const a = await pageATransaction();
        const errors: unknown[] = [];
        MSP.send_cli_command("set p_roll = 99", (_l, e) => errors.push(e));
        expect(errors[0]).toBeInstanceOf(Error);
        expect(sent).toEqual([]);
        a.release();
        await a.tx;
    });
});
