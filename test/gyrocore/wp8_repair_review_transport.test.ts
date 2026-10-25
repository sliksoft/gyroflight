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
 * The Codex reviews of the WP8-F03 and WP8-F09 repairs. Production msp.ts and the serial.send
 * facade over a fake transport whose sends this test completes by hand (a stalled USB write).
 *   - F03: a request held behind a stalled send must not go out after it timed out, or after the
 *     write check would refuse it; a send stuck on one connection must not block the next.
 *   - F09: a command a caller sends from its timeout callback waits behind the drain; a reply that
 *     came before the transport reported a failed send is no success; a transport result from a
 *     connection set up again since does not affect the new session.
 */

import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MSP from "../../src/js/msp";
import MSPCodes from "../../src/js/msp/MSPCodes";
import { mspHelper } from "../../src/js/msp/MSPHelper";
import { serial } from "../../src/js/serial";
import { useConnectionStore } from "../../src/stores/connection";
import { useFlightControllerStore } from "../../src/stores/fc";
import { TRANSACTION_ENTRY_PREFIX } from "../../src/gyrocore/stores/fcTransactionState";
import { WriteRefusedError, WriteRetryRefusedError } from "../../src/composables/fcWriteGuard";
import { MspTimeoutError } from "../../src/js/msp/mspErrors";

const UID: [number, number, number] = [5, 5, 5];
const STX = 0x02;

interface Pending {
    bytes: number[];
    resolve: (bytesSent: number) => void;
}

let wire: Pending[];
let autoComplete: boolean;

function fakeTransport() {
    return {
        connected: true,
        send: (data: ArrayBuffer | Uint8Array) =>
            new Promise<{ bytesSent: number }>((resolve) => {
                const bytes = Array.from(new Uint8Array(data as ArrayBuffer));
                const p = { bytes, resolve: (n: number) => resolve({ bytesSent: n }) };
                wire.push(p);
                if (autoComplete) p.resolve(bytes.length);
            }),
    };
}

const mspCodesOnWire = () =>
    wire
        .filter((p) => p.bytes[0] === 0x24)
        .map((p) => (p.bytes[1] === 0x4d ? p.bytes[4] : p.bytes[4] | (p.bytes[5] << 8)));
const cliOnWire = () => wire.filter((p) => p.bytes[0] === STX).map((p) => String.fromCharCode(...p.bytes.slice(1, -2)));

function uncertain() {
    localStorage.setItem(
        `${TRANSACTION_ENTRY_PREFIX}tx-u`,
        JSON.stringify({
            id: "tx-u",
            uid: UID,
            action: "apply",
            stage: "eeprom",
            saved: "unknown",
            backupId: "bk",
            profiles: [0],
            detail: "",
            at: "2026-10-24T00:00:00Z",
        }),
    );
}

const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
};
const outcome = (p: Promise<unknown>) =>
    p.then(
        () => "resolved",
        (e: unknown) => e,
    );

beforeEach(async () => {
    setActivePinia(createPinia());
    localStorage.clear();
    vi.useFakeTimers();
    wire = [];
    autoComplete = true;
    await serial.disconnect(); // a fresh send queue
    (serial as unknown as { _protocol: unknown })._protocol = fakeTransport();
    useConnectionStore().virtualMode = false;
    useFlightControllerStore().config.uid = [...UID];
    MSP.callbacks = [];
    MSP.parked.clear();
    MSP.disconnect_cleanup();
    MSP.state = MSP.decoder_states.IDLE;
    await vi.advanceTimersByTimeAsync(50);
    useFlightControllerStore().config.uid = [...UID];
});

afterEach(() => {
    MSP.disconnect_cleanup();
    MSP.callbacks_cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("Codex review F03: nothing goes out late", () => {
    it("a write held behind a stalled send that timed out meanwhile never reaches the transport", async () => {
        autoComplete = false;
        void MSP.promise(MSPCodes.MSP_STATUS).catch(() => undefined); // stalls in the transport
        await settle();
        const write = outcome(MSP.promise(MSPCodes.MSP_SET_PID, [1, 2, 3]));
        await vi.advanceTimersByTimeAsync(5 * MSP.TIMEOUT);
        expect(await write).toBeInstanceOf(MspTimeoutError);
        autoComplete = true;
        wire[0].resolve(wire[0].bytes.length);
        await vi.advanceTimersByTimeAsync(100);
        expect(mspCodesOnWire().filter((c) => c === MSPCodes.MSP_SET_PID)).toEqual([]);
    });

    it("a write held behind a stalled send that the check would now refuse is not sent, and reported as not sent", async () => {
        autoComplete = false;
        void MSP.promise(MSPCodes.MSP_STATUS).catch(() => undefined);
        await settle();
        const write = outcome(MSP.promise(MSPCodes.MSP_SET_PID, [1, 2, 3]));
        await settle();
        uncertain();
        autoComplete = true;
        wire[0].resolve(wire[0].bytes.length);
        await vi.advanceTimersByTimeAsync(5 * MSP.TIMEOUT);
        expect(mspCodesOnWire().filter((c) => c === MSPCodes.MSP_SET_PID)).toEqual([]);
        const err = await write;
        expect(err).toBeInstanceOf(WriteRefusedError);
        expect(err).not.toBeInstanceOf(WriteRetryRefusedError);
    });

    it("a write that went out once and whose retry is refused is still 'may have run'", async () => {
        const write = outcome(MSP.promise(MSPCodes.MSP_SET_PID, [1, 2, 3]));
        await settle();
        expect(mspCodesOnWire()).toEqual([MSPCodes.MSP_SET_PID]);
        uncertain();
        await vi.advanceTimersByTimeAsync(5 * MSP.TIMEOUT);
        expect(await write).toBeInstanceOf(WriteRetryRefusedError);
        expect(mspCodesOnWire()).toEqual([MSPCodes.MSP_SET_PID]);
    });

    it("a send stuck on a closed connection does not block the next connection's sends", async () => {
        autoComplete = false;
        void serial.send(new Uint8Array([1, 2, 3]).buffer);
        await settle();
        await serial.disconnect();
        (serial as unknown as { _protocol: unknown })._protocol = fakeTransport();
        autoComplete = true;
        const r = await serial.send(new Uint8Array([9]).buffer);
        expect(r).toEqual({ bytesSent: 1 });
    });

    it("a send queued behind the stuck one on the old connection is dropped (0 bytes), not sent later", async () => {
        autoComplete = false;
        void serial.send(new Uint8Array([1]).buffer);
        const queued = serial.send(new Uint8Array([2]).buffer);
        await settle();
        await serial.disconnect();
        autoComplete = true;
        wire[0].resolve(1);
        expect(await queued).toEqual({ bytesSent: 0 });
        expect(wire.map((p) => p.bytes[0])).toEqual([1]);
    });
});

describe("Codex review F09: no reply goes to the wrong command, no success before delivery", () => {
    const feed = (bytes: number[]) => MSP.read({ data: new Uint8Array(bytes).buffer });
    const reply = (s: string, etx = true) => [
        STX,
        ...Array.from(s, (c) => c.charCodeAt(0)),
        0x0a,
        ...(etx ? [0x03] : []),
    ];

    it("a command sent from the timeout callback of another waits for the drain; the late reply is not its answer", async () => {
        const results: Array<{ cmd: string; lines: string[]; error: unknown }> = [];
        MSP.send_cli_command(
            "get a",
            (lines, error) => {
                results.push({ cmd: "a", lines, error });
                MSP.send_cli_command("get b", (l, e) => results.push({ cmd: "b", lines: l, error: e ?? null }));
            },
            { timeoutMs: 100 },
        );
        await vi.advanceTimersByTimeAsync(150);
        expect(cliOnWire()).toEqual(["get a"]);
        feed(reply("late-a"));
        await settle();
        expect(cliOnWire()).toEqual(["get a", "get b"]);
        feed(reply("answer-b"));
        await settle();
        expect(results.find((r) => r.cmd === "b")).toEqual({ cmd: "b", lines: ["answer-b", ""], error: null });
    });

    it("a reply that came before the transport reported a short send is an error, and nothing queued goes out", async () => {
        autoComplete = false;
        const results: Array<{ cmd: string; error: unknown }> = [];
        MSP.send_cli_command("get a", (_l, e) => results.push({ cmd: "a", error: e ?? null }));
        MSP.send_cli_command("get b", (_l, e) => results.push({ cmd: "b", error: e ?? null }));
        await settle();
        feed(reply("answer-a"));
        await settle();
        expect(results).toEqual([]);
        wire[0].resolve(wire[0].bytes.length - 2);
        await settle();
        expect(results[0].cmd).toBe("a");
        expect(results[0].error).toBeInstanceOf(Error);
        expect(results[1]?.error).toBeInstanceOf(Error);
        expect(cliOnWire()).toEqual(["get a"]);
    });

    it("a reply that came before the transport reported the whole send succeeds once it does", async () => {
        autoComplete = false;
        const results: Array<{ lines: string[]; error: unknown }> = [];
        MSP.send_cli_command("get a", (lines, e) => results.push({ lines, error: e ?? null }));
        await settle();
        feed(reply("answer-a"));
        await settle();
        wire[0].resolve(wire[0].bytes.length);
        await settle();
        expect(results).toEqual([{ lines: ["answer-a", ""], error: null }]);
    });

    it("an old connection's failed send result does not close the new session", async () => {
        autoComplete = false;
        MSP.send_cli_command("get a", () => {});
        await settle();
        const old = wire[0];
        MSP.disconnect_cleanup();
        autoComplete = true;
        const results: Array<{ lines: string[]; error: unknown }> = [];
        MSP.send_cli_command("get b", (lines, e) => results.push({ lines, error: e ?? null }));
        await settle();
        old.resolve(0);
        await settle();
        expect(MSP.cli_session_uncertain).toBe(false);
        feed(reply("answer-b"));
        await settle();
        expect(results).toEqual([{ lines: ["answer-b", ""], error: null }]);
    });
});

describe("Codex review round 2 (F03/F09/F04)", () => {
    beforeEach(() => {
        MSP.clearListeners();
        MSP.listen(mspHelper.process_data.bind(mspHelper));
    });
    afterEach(() => MSP.clearListeners());

    const feed = (bytes: number[]) => MSP.read({ data: new Uint8Array(bytes).buffer });
    const reply = (s: string) => [STX, ...Array.from(s, (c) => c.charCodeAt(0)), 0x0a, 0x03];

    it("a legacy write whose retries ran out never leaves late from behind a stalled send", async () => {
        autoComplete = false;
        void MSP.promise(MSPCodes.MSP_STATUS).catch(() => undefined); // stalls in the transport
        await settle();
        MSP.send_message(MSPCodes.MSP_SET_PID, [1, 2, 3], false, () => undefined);
        await vi.advanceTimersByTimeAsync(5 * MSP.TIMEOUT);
        autoComplete = true;
        wire[0].resolve(wire[0].bytes.length);
        await vi.advanceTimersByTimeAsync(100);
        expect(mspCodesOnWire().filter((c) => c === MSPCodes.MSP_SET_PID)).toEqual([]);
    });

    it("a late failed send of an earlier command closes the session: its successor neither goes out nor succeeds", async () => {
        autoComplete = false;
        const results: Array<{ cmd: string; lines: string[]; error: unknown }> = [];
        MSP.send_cli_command("get a", (lines, e) => results.push({ cmd: "a", lines, error: e ?? null }), {
            timeoutMs: 100,
        });
        await settle();
        const a = wire[0];
        const c = serial.send(new Uint8Array([0x99]).buffer); // another send, held behind A
        MSP.send_cli_command("set b = 1", (lines, e) => results.push({ cmd: "b", lines, error: e ?? null }));
        await vi.advanceTimersByTimeAsync(150); // A times out: drain
        feed(reply("late-a")); // A's late reply ends the drain; B leaves the queue (its bytes wait behind C)
        await settle();
        a.resolve(a.bytes.length - 2); // A's send turns out cut: the session is uncertain
        await settle();
        autoComplete = true;
        wire[1]?.resolve(1); // C finishes
        await c;
        await settle();
        expect(cliOnWire().filter((t) => t.startsWith("set b"))).toEqual([]);
        const b = results.find((r) => r.cmd === "b");
        expect(b?.error).toBeInstanceOf(Error);
    });

    it("the firmware's error answer to a SET rejects an awaiter (it resolved, and tabs took it for saved)", async () => {
        const write = outcome(MSP.promise(MSPCodes.MSP_SET_OSD_CONFIG, [1, 2]));
        await settle();
        const code = MSPCodes.MSP_SET_OSD_CONFIG;
        feed([0x24, 0x4d, 0x21, 0, code, code]);
        const err = await write;
        expect((err as Error).name).toBe("MspFirmwareRefusedError");
    });

    it("the firmware's error answer to a read still resolves with the answer (reads keep their meaning)", async () => {
        const read = MSP.promise(MSPCodes.MSP_STATUS);
        await settle();
        const code = MSPCodes.MSP_STATUS;
        feed([0x24, 0x4d, 0x21, 0, code, code]);
        expect(await read).toMatchObject({ unsupported: 1 });
    });
});
