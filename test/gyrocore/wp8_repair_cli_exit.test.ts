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
 * Audit WP8-F10: leaving the CLI tab sends `exit`; only an `exit` the transport took whole starts the
 * reboot handoff. Otherwise the FC may still be in its CLI, where MSP frames reach the line editor:
 * no reboot is reported, the CLI flags are not cleared as if it left, and the link is dropped
 * without another MSP request. Production useCli and the real serial.send facade; the transport
 * behind it is a fake whose send this test decides, and serial_backend's entry points are spies.
 */

import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({ reinit: vi.fn(), dropUnknownMode: vi.fn() }));
vi.mock("../../src/js/serial_backend", () => ({
    __esModule: true,
    reinitializeConnection: backend.reinit,
    disconnectCliModeUnknown: backend.dropUnknownMode,
    scheduleRebootReconnect: vi.fn(),
    cancelRebootReconnect: vi.fn(),
}));

import { serial } from "../../src/js/serial";
import { useConnectionStore } from "../../src/stores/connection";
import { useCli } from "../../src/composables/useCli";
import { useFlightControllerStore } from "../../src/stores/fc";

let wire: number[][];
let transport: (data: Uint8Array) => Promise<{ bytesSent: number }>;

function fakeProtocol() {
    return {
        connected: true,
        send: async (data: ArrayBuffer | Uint8Array) => {
            const bytes = new Uint8Array(data as ArrayBuffer);
            wire.push(Array.from(bytes));
            return transport(bytes);
        },
    };
}

function cliTab() {
    const connection = useConnectionStore();
    connection.connectionValid = true;
    connection.cliValid = true;
    connection.cliActive = true;
    return useCli();
}

const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    wire = [];
    transport = async (bytes) => ({ bytesSent: bytes.byteLength });
    (serial as unknown as { _protocol: unknown })._protocol = fakeProtocol();
    backend.reinit.mockClear();
    backend.dropUnknownMode.mockClear();
});

afterEach(() => {
    (serial as unknown as { _protocol: unknown })._protocol = null;
    vi.restoreAllMocks();
});

describe("WP8-F10 CLI exit: a reboot only for an exit that went out whole", () => {
    it("exit taken whole by the transport: reboot handoff, CLI flags cleared", async () => {
        const cli = cliTab();
        expect(cli.cleanup()).toBe(true);
        await settle();
        expect(wire.map((b) => String.fromCharCode(...b))).toEqual(["exit\r"]);
        expect(backend.reinit).toHaveBeenCalledTimes(1);
        expect(backend.dropUnknownMode).not.toHaveBeenCalled();
        expect(useConnectionStore().cliActive).toBe(false);
        expect(useConnectionStore().cliValid).toBe(false);
    });

    it.each([
        ["0 bytes", async () => ({ bytesSent: 0 })],
        ["a partial send", async (b: Uint8Array) => ({ bytesSent: b.byteLength - 1 })],
        [
            "a transport error",
            async () => {
                throw new Error("NetworkError: device lost");
            },
        ],
    ])("%s: no reboot, the CLI mode stays unknown, the link is dropped without MSP", async (_name, result) => {
        transport = result as typeof transport;
        const cli = cliTab();
        cli.cleanup();
        // Until the transport answered nothing says the FC left its CLI.
        expect(useConnectionStore().cliActive).toBe(true);
        await settle();
        expect(backend.reinit).not.toHaveBeenCalled();
        expect(backend.dropUnknownMode).toHaveBeenCalledTimes(1);
        expect(useConnectionStore().cliActive).toBe(true);
        // Only the exit attempt reached the transport: no MSP frame followed it.
        expect(wire).toHaveLength(1);
        expect(wire[0][0]).not.toBe(0x24);
    });

    it("the port already closed (the transport reports 0 bytes): no reboot reported", async () => {
        (serial as unknown as { _protocol: { connected: boolean } })._protocol.connected = true;
        transport = async () => ({ bytesSent: 0 });
        const cli = cliTab();
        cli.cleanup();
        await settle();
        expect(backend.reinit).not.toHaveBeenCalled();
    });

    it("a second cleanup while the exit's result is pending sends no second exit", async () => {
        let release: (r: { bytesSent: number }) => void = () => {};
        transport = () => new Promise((resolve) => (release = resolve));
        const cli = cliTab();
        expect(cli.cleanup()).toBe(true);
        expect(cli.cleanup()).toBe(true);
        await settle();
        expect(wire).toHaveLength(1);
        release({ bytesSent: wire[0].length });
        await settle();
        expect(backend.reinit).toHaveBeenCalledTimes(1);
    });

    it("with an uncertain state the exit goes out behind the line clearing; delivery counts all of it", async () => {
        localStorage.setItem(
            "gyroflight.fcTransactionState.v2.tx-u",
            JSON.stringify({
                id: "tx-u",
                uid: [1, 2, 3],
                action: "apply",
                stage: "eeprom",
                saved: "unknown",
                backupId: "bk",
                profiles: [0],
                detail: "",
                at: "2026-10-24T00:00:00Z",
            }),
        );
        useFlightControllerStore().config.uid = [1, 2, 3];
        // Every byte but the trailing CR: the firmware never ran `exit`.
        transport = async (b) => ({ bytesSent: b.byteLength - 1 });
        const cli = cliTab();
        cli.cleanup();
        await settle();
        expect(wire[0].length).toBe(256 + "exit\r".length);
        expect(backend.reinit).not.toHaveBeenCalled();
        expect(backend.dropUnknownMode).toHaveBeenCalledTimes(1);
    });
});
