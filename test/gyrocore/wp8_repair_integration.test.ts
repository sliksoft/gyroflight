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
 * The Codex integration review of WP8 (HEAD 00eb8488). Production msp.ts, MSPHelper, the serial facade,
 * eepromSave and AutoRestore over a fake transport whose sends this test completes by hand.
 *   R1: MSP answers carry no request id: a delayed answer to an earlier EEPROM request must neither
 *       settle a later one that has not gone out yet, nor prove a later one that has.
 *   R2: a failed AutoRestore stops its command loop: nothing more goes out, also not on a link set
 *       up again, and nothing waits for good.
 *   R3: a failed CLI send closes the session before its successor may go out.
 */

import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MSP from "../../src/js/msp";
import MSPCodes from "../../src/js/msp/MSPCodes";
import { mspHelper } from "../../src/js/msp/MSPHelper";
import { serial } from "../../src/js/serial";
import { useConnectionStore } from "../../src/stores/connection";
import { useFlightControllerStore } from "../../src/stores/fc";
import { saveEeprom, EepromSaveError } from "../../src/js/msp/eepromSave";
import autoRestoreInstance, { type AutoRestoreResult } from "../../src/js/utils/AutoRestore";

interface Pending {
    bytes: number[];
    resolve: (n: number) => void;
}
let wire: Pending[];
let hold: boolean;

function fakeTransport() {
    return {
        connected: true,
        send: (d: ArrayBuffer) =>
            new Promise<{ bytesSent: number }>((resolve) => {
                const bytes = Array.from(new Uint8Array(d));
                const p = { bytes, resolve: (n: number) => resolve({ bytesSent: n }) };
                wire.push(p);
                if (!hold) p.resolve(bytes.length);
            }),
    };
}

const STX = 0x02;
const ack = (code: number) => MSP.read({ data: new Uint8Array([0x24, 0x4d, 0x3e, 0, code, code]).buffer });
const eepromOnWire = () => wire.filter((p) => p.bytes[0] === 0x24 && p.bytes[4] === MSPCodes.MSP_EEPROM_WRITE).length;
const cliOnWire = () => wire.filter((p) => p.bytes[0] === STX).map((p) => String.fromCharCode(...p.bytes.slice(1, -2)));
const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(async () => {
    setActivePinia(createPinia());
    localStorage.clear();
    vi.useFakeTimers();
    wire = [];
    hold = false;
    await serial.disconnect();
    (serial as unknown as { _protocol: unknown })._protocol = fakeTransport();
    vi.spyOn(serial, "disconnect").mockResolvedValue(true as never);
    useConnectionStore().virtualMode = false;
    MSP.callbacks = [];
    // Optional so this suite also runs against the commit before the fix (its before-evidence).
    (MSP as { write_transmissions?: Map<number, unknown> }).write_transmissions?.clear();
    MSP.parked.clear();
    MSP.disconnect_cleanup();
    MSP.clearListeners();
    MSP.state = MSP.decoder_states.IDLE;
    MSP.message_direction = 1;
    MSP.listen(mspHelper.process_data.bind(mspHelper));
    await vi.advanceTimersByTimeAsync(10);
    const fc = useFlightControllerStore();
    fc.config.uid = [8, 8, 8];
    fc.config.armingDisabled = true;
});

afterEach(() => {
    MSP.disconnect_cleanup();
    MSP.callbacks_cleanup();
    MSP.clearListeners();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("R1: an earlier EEPROM answer proves nothing for a later save", () => {
    /** Save A goes out twice (a retry) and the answer to its first transmission arrives. */
    async function saveAWithRetryOneAnswered() {
        const a = saveEeprom().then(
            () => "saved",
            (e: unknown) => e,
        );
        await vi.advanceTimersByTimeAsync(MSP.TIMEOUT + 50);
        expect(eepromOnWire()).toBe(2);
        ack(MSPCodes.MSP_EEPROM_WRITE);
        expect(await a).toBe("saved");
    }

    it("a delayed answer does not settle a later save still waiting for the transport", async () => {
        await saveAWithRetryOneAnswered();
        hold = true; // the next send stalls in the transport
        void serial.send(new Uint8Array([0x99]).buffer);
        let bResult: unknown = null;
        const b = saveEeprom().then(
            () => (bResult = "saved"),
            (e: unknown) => (bResult = e),
        );
        await settle();
        ack(MSPCodes.MSP_EEPROM_WRITE); // the delayed answer to A's retry, before B went out
        await settle();
        expect(bResult).toBeNull();
        hold = false;
        wire[wire.length - 1].resolve(1); // the stalled send finishes; B goes out now
        await settle();
        expect(eepromOnWire()).toBe(3);
        ack(MSPCodes.MSP_EEPROM_WRITE); // A's two transmissions are answered: this one is B's
        await b;
        expect(bResult).toBe("saved");
    });

    it("a save that went out while an earlier transmission was unanswered is not proven by the next answer", async () => {
        await saveAWithRetryOneAnswered(); // A's retry is still unanswered
        const b = saveEeprom().then(
            () => "saved",
            (e: unknown) => e,
        );
        await settle();
        expect(eepromOnWire()).toBe(3);
        ack(MSPCodes.MSP_EEPROM_WRITE); // A's retry answer, or B's: no request id tells them apart
        const result = await b;
        expect(result).toBeInstanceOf(EepromSaveError);
        expect((result as EepromSaveError).persistence).toBe("unknown");
    });

    // Single re-review of the integration fixes: a tab switch clears the MSP queue, not the link.
    it("a queue cleanup (tab switch) between the two saves keeps the earlier unanswered transmission in mind", async () => {
        await saveAWithRetryOneAnswered();
        MSP.callbacks_cleanup(); // a tab switch: the link stays, A's retry answer may still come
        const b = saveEeprom().then(
            () => "saved",
            (e: unknown) => e,
        );
        await settle();
        ack(MSPCodes.MSP_EEPROM_WRITE);
        const result = await b;
        expect(result).toBeInstanceOf(EepromSaveError);
        expect((result as EepromSaveError).persistence).toBe("unknown");
    });

    // Codex integration review of 5ef42d3b: no time proves an earlier answer cannot come any more.
    it("an earlier unanswered transmission still counts after long silence on the same link", async () => {
        await saveAWithRetryOneAnswered();
        await vi.advanceTimersByTimeAsync(60_000); // the link stays open
        hold = true; // B's bytes go to the transport, whose write stays pending
        let bResult: unknown = null;
        const b = saveEeprom().then(
            () => (bResult = "saved"),
            (e: unknown) => (bResult = e),
        );
        await settle();
        expect(eepromOnWire()).toBe(3);
        ack(MSPCodes.MSP_EEPROM_WRITE); // A's retry answer, late: it proves nothing for B
        await settle();
        expect(bResult).not.toBe("saved");
        hold = false;
        wire[wire.length - 1].resolve(6);
        await vi.advanceTimersByTimeAsync(MSP.TIMEOUT * (MSP.MAX_RETRIES + 2));
        await b;
        expect(bResult).toBeInstanceOf(EepromSaveError);
        expect((bResult as EepromSaveError).persistence).toBe("unknown");
    });

    it("a save after long silence that goes out while A's retry is unanswered is not proven by the next answer", async () => {
        await saveAWithRetryOneAnswered();
        await vi.advanceTimersByTimeAsync(60_000);
        const b = saveEeprom().then(
            () => "saved",
            (e: unknown) => e,
        );
        await settle();
        ack(MSPCodes.MSP_EEPROM_WRITE);
        const result = await b;
        expect(result).toBeInstanceOf(EepromSaveError);
        expect((result as EepromSaveError).persistence).toBe("unknown");
    });

    // Codex re-check of d070d344, P1 1: a frame whose CRC failed is no answer.
    it("a CRC-invalid frame for the code does not use up the earlier unanswered transmission", async () => {
        await saveAWithRetryOneAnswered();
        // "$M>" with code MSP_EEPROM_WRITE and a wrong checksum.
        MSP.read({ data: new Uint8Array([0x24, 0x4d, 0x3e, 0, MSPCodes.MSP_EEPROM_WRITE, 0]).buffer });
        hold = true;
        let bResult: unknown = null;
        const b = saveEeprom().then(
            () => (bResult = "saved"),
            (e: unknown) => (bResult = e),
        );
        await settle();
        ack(MSPCodes.MSP_EEPROM_WRITE); // A's retry answer, late
        await settle();
        expect(bResult).not.toBe("saved");
        hold = false;
        wire[wire.length - 1].resolve(6);
        await vi.advanceTimersByTimeAsync(MSP.TIMEOUT * (MSP.MAX_RETRIES + 2));
        await b;
        expect(bResult).toBeInstanceOf(EepromSaveError);
        expect((bResult as EepromSaveError).persistence).toBe("unknown");
    });

    it("control: a closed link ends the history, so the next connection's save is proven by its answer", async () => {
        await saveAWithRetryOneAnswered();
        MSP.disconnect_cleanup(); // the link closed: no answer of it can come any more
        const b = saveEeprom().then(
            () => "saved",
            (e: unknown) => e,
        );
        await settle();
        ack(MSPCodes.MSP_EEPROM_WRITE);
        expect(await b).toBe("saved");
    });

    it("control: without an earlier unanswered transmission a save's answer proves it", async () => {
        const a = saveEeprom().then(
            () => "saved",
            (e: unknown) => e,
        );
        await settle();
        ack(MSPCodes.MSP_EEPROM_WRITE);
        expect(await a).toBe("saved");
    });
});

describe("R2: a failed AutoRestore stops its command loop", () => {
    type Ar = {
        _callback: ((r: AutoRestoreResult) => void) | null;
        _cliLines: string[] | null;
        _sendCliCommands: () => Promise<void>;
        handleDisconnect: () => void;
    };

    it("after a disconnect mid-restore nothing more goes out, also not on a link set up again, and the loop ends", async () => {
        const a = autoRestoreInstance as unknown as Ar;
        const results: AutoRestoreResult[] = [];
        a._callback = (r) => results.push(r);
        a._cliLines = ["set a = 1", "set b = 2", "set c = 3", "save"];
        (autoRestoreInstance as unknown as { _run: number })._run++;
        const loop = a._sendCliCommands();
        await settle();
        expect(cliOnWire()).toEqual(["set a = 1"]);
        a.handleDisconnect(); // the link dropped: the restore failed
        expect(results).toEqual([expect.objectContaining({ success: false })]);
        (serial as unknown as { _protocol: unknown })._protocol = fakeTransport(); // a new link
        await vi.advanceTimersByTimeAsync(10_000);
        await loop;
        expect(cliOnWire()).toEqual(["set a = 1"]);
        expect(results).toHaveLength(1);
    });
});

describe("R2: a restore that ended between two commands sends no further one", () => {
    it("ended during the pause between commands (no command in flight to fail): the next line never goes out", async () => {
        const a = autoRestoreInstance as unknown as {
            _callback: ((r: AutoRestoreResult) => void) | null;
            _cliLines: string[] | null;
            _sendCliCommands: () => Promise<void>;
            _cleanup: (success: boolean, msg: string | null) => void;
        };
        a._callback = () => undefined;
        a._cliLines = ["set a = 1", "set b = 2"];
        (autoRestoreInstance as unknown as { _run: number })._run++;
        const loop = a._sendCliCommands();
        await settle();
        expect(cliOnWire()).toEqual(["set a = 1"]);
        MSP.read({ data: new Uint8Array([STX, 0x6f, 0x6b, 0x0a, 0x03]).buffer }); // "ok": the first line answered
        await settle();
        a._cleanup(false, "ended"); // the run ends while the loop waits between lines
        (serial as unknown as { _protocol: unknown })._protocol = fakeTransport(); // a new link
        await vi.advanceTimersByTimeAsync(10_000);
        await loop;
        expect(cliOnWire()).toEqual(["set a = 1"]);
    });
});

describe("R2 (re-review): a result callback that throws still ends the restore's save wait", () => {
    it("the confirmed save's wait is released even when the result callback throws", async () => {
        const a = autoRestoreInstance as unknown as {
            _callback: ((r: AutoRestoreResult) => void) | null;
            _finishWithSave: (errors: unknown[]) => Promise<void>;
        };
        a._callback = () => {
            throw new Error("callback failed");
        };
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        let finished = false;
        const done = a._finishWithSave([]).then(
            () => (finished = true),
            () => (finished = true),
        );
        await settle();
        MSP.read({
            data: new Uint8Array([STX, ...Array.from("\r\n# saving\r\n\r\nRebooting", (c) => c.charCodeAt(0))]).buffer,
        });
        try {
            (autoRestoreInstance as unknown as { handleDisconnect: () => void }).handleDisconnect();
        } catch {
            // the throwing callback
        }
        await settle();
        await vi.advanceTimersByTimeAsync(10);
        await Promise.race([done, settle()]);
        expect(finished).toBe(true);
    });
});

describe("R3: a failed CLI send closes the session before its successor goes out", () => {
    it("the command right after a cut send never reaches the transport", async () => {
        hold = true;
        const results: Array<{ cmd: string; error: unknown }> = [];
        MSP.send_cli_command("get a", (_l, e) => results.push({ cmd: "a", error: e ?? null }), { timeoutMs: 100 });
        MSP.send_cli_command("set b = 1", (_l, e) => results.push({ cmd: "b", error: e ?? null }));
        await settle();
        await vi.advanceTimersByTimeAsync(150); // A times out: drain
        MSP.read({ data: new Uint8Array([STX, 0x78, 0x0a, 0x03]).buffer }); // A's late reply: B leaves the queue
        await settle();
        hold = false;
        wire[0].resolve(wire[0].bytes.length - 2); // A's send turns out cut
        await settle();
        expect(cliOnWire()).toEqual(["get a"]);
        const b = results.find((r) => r.cmd === "b");
        expect(b?.error).toBeInstanceOf(Error);
        // B may have been on its way: not reported as "not sent".
        expect(Reflect.get(Object(b?.error), "notSent")).not.toBe(true);
    });
});
