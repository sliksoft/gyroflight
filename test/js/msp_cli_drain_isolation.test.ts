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
 * Audit WP8-F09: the MSP CLI queue after a timeout, through production msp.ts and MSPHelper
 * (decoder, callbacks) with the transport replaced. MSP CLI replies carry no request id: only the
 * old reply's ETX proves it is consumed. Until then no new CLI command goes out; when the grace
 * period ends without it the session is uncertain and every CLI command is refused until the link
 * is set up again (disconnect_cleanup). MSP replies are never thrown away by the drain.
 * Also: a CLI command is "delivered" only when the transport reports every byte of its frame.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import MSP from "../../src/js/msp";
import MSPCodes from "../../src/js/msp/MSPCodes";
import { mspHelper } from "../../src/js/msp/MSPHelper";
import { serial } from "../../src/js/serial";
import { useFlightControllerStore } from "../../src/stores/fc";

const STX = 0x02;
const ETX = 0x03;
const LF = 0x0a;

const cliReply = (body: string) => [STX, ...Array.from(body, (c) => c.charCodeAt(0)), LF, ETX];

/** An MSP v1 reply frame (FC to app). */
function mspReply(code: number, payload: number[]) {
    let checksum = payload.length ^ code;
    for (const b of payload) checksum ^= b;
    return [0x24, 0x4d, 0x3e, payload.length, code, ...payload, checksum];
}

const feed = (bytes: number[]) => MSP.read({ data: new Uint8Array(bytes).buffer });

type SendResult = { bytesSent: number };
let sent: number[][];
let sendResult: (frame: ArrayBuffer) => SendResult;

function resetMsp() {
    for (const t of [MSP.cli_timer, MSP.cli_drain_timer]) if (t) clearTimeout(t);
    MSP.cli_timer = null;
    MSP.cli_drain_timer = null;
    MSP.disconnect_cleanup();
    MSP.clearListeners();
    MSP.state = MSP.decoder_states.IDLE;
}

beforeEach(() => {
    setActivePinia(createPinia());
    vi.useFakeTimers();
    sent = [];
    sendResult = (frame) => ({ bytesSent: frame.byteLength });
    vi.spyOn(serial, "connected", "get").mockReturnValue(true);
    vi.spyOn(serial, "send").mockImplementation(async (data: ArrayBuffer | Uint8Array) => {
        const frame = data instanceof Uint8Array ? (data.buffer as ArrayBuffer) : data;
        sent.push(Array.from(new Uint8Array(frame)));
        return sendResult(frame);
    });
    resetMsp();
    MSP.listen(mspHelper.process_data.bind(mspHelper));
});

afterEach(() => {
    resetMsp();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

const cliFrames = () => sent.filter((f) => f[0] === STX).map((f) => String.fromCharCode(...f.slice(1, -2)));

async function settle() {
    for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("WP8-F09 CLI timeout drain and reply isolation", () => {
    it("delivers an MSP reply that arrives while a timed-out CLI reply is drained", async () => {
        const results: unknown[] = [];
        MSP.send_cli_command("get slow", (lines, error) => results.push(error), { timeoutMs: 100 });
        vi.advanceTimersByTime(150);
        expect(MSP.cli_discarding).toBe(true);

        const reply = MSP.promise(MSPCodes.MSP_API_VERSION);
        await settle();
        feed(mspReply(MSPCodes.MSP_API_VERSION, [0, 1, 47]));
        await expect(reply).resolves.toMatchObject({ command: MSPCodes.MSP_API_VERSION });
        expect(useFlightControllerStore().config.apiVersion).toBe("1.47.0");
        expect(MSP.cli_discarding).toBe(true);
    });

    it("does not end the drain on an ETX byte inside an MSP frame", async () => {
        MSP.send_cli_command("get slow", () => {}, { timeoutMs: 100 });
        vi.advanceTimersByTime(150);
        const reply = MSP.promise(MSPCodes.MSP_API_VERSION);
        await settle();
        feed(mspReply(MSPCodes.MSP_API_VERSION, [ETX, 1, 47]));
        await reply;
        expect(MSP.cli_discarding).toBe(true);
    });

    it("sends no new CLI command submitted during the drain until the old reply's ETX", async () => {
        const results: Array<{ cmd: string; lines?: string[]; error?: unknown }> = [];
        MSP.send_cli_command("get slow", (lines, error) => results.push({ cmd: "slow", error }), { timeoutMs: 100 });
        await settle();
        vi.advanceTimersByTime(150);
        MSP.send_cli_command("get fast", (lines, error) => results.push({ cmd: "fast", lines, error }));
        await settle();
        expect(cliFrames()).toEqual(["get slow"]);

        feed(cliReply("late-slow"));
        await settle();
        expect(cliFrames()).toEqual(["get slow", "get fast"]);
        feed(cliReply("fast-response"));
        expect(results[1]).toEqual({ cmd: "fast", lines: ["fast-response", ""], error: null });
    });

    it("refuses every CLI command after the grace period without an ETX, and gives a late old reply to none", async () => {
        const results: Array<{ cmd: string; lines?: string[]; error?: unknown }> = [];
        MSP.send_cli_command("get slow", (lines, error) => results.push({ cmd: "slow", error }), { timeoutMs: 100 });
        MSP.send_cli_command("get queued", (lines, error) => results.push({ cmd: "queued", lines, error }));
        await settle();
        vi.advanceTimersByTime(150 + MSP.cli_drain_grace_ms + 10);
        await settle();

        MSP.send_cli_command("get later", (lines, error) => results.push({ cmd: "later", lines, error }));
        await settle();
        // Nothing after the timed-out command went out.
        expect(cliFrames()).toEqual(["get slow"]);
        feed(cliReply("late-slow"));
        const queued = results.find((r) => r.cmd === "queued");
        const later = results.find((r) => r.cmd === "later");
        expect(queued?.error).toBeInstanceOf(Error);
        expect(later?.error).toBeInstanceOf(Error);
        expect(queued?.lines).toEqual([]);
        expect(later?.lines).toEqual([]);
        expect(results.every((r) => !r.lines?.includes("late-slow"))).toBe(true);
    });

    it("lets CLI commands out again once the link is set up again (disconnect_cleanup)", async () => {
        MSP.send_cli_command("get slow", () => {}, { timeoutMs: 100 });
        vi.advanceTimersByTime(150 + MSP.cli_drain_grace_ms + 10);
        MSP.disconnect_cleanup();
        MSP.listen(mspHelper.process_data.bind(mspHelper));
        const results: Array<{ lines: string[]; error: unknown }> = [];
        MSP.send_cli_command("get again", (lines, error) => results.push({ lines, error: error ?? null }));
        await settle();
        expect(cliFrames()).toEqual(["get slow", "get again"]);
        feed(cliReply("again-response"));
        expect(results).toEqual([{ lines: ["again-response", ""], error: null }]);
    });

    it("tells the sender a command was delivered only when the transport took every byte", async () => {
        const outcome: boolean[] = [];
        MSP.send_cli_command("get a", () => {}, { onDelivery: (d: boolean) => outcome.push(d) });
        await settle();
        expect(outcome).toEqual([true]);
    });

    it("ends a command the transport took only in part with an error and refuses the CLI after it", async () => {
        sendResult = (frame) => ({ bytesSent: frame.byteLength - 2 });
        const outcome: boolean[] = [];
        const results: Array<{ cmd: string; error: unknown }> = [];
        MSP.send_cli_command("set x = 1", (lines, error) => results.push({ cmd: "partial", error }), {
            onDelivery: (d: boolean) => outcome.push(d),
        });
        await settle();
        expect(outcome).toEqual([false]);
        expect(results[0]?.error).toBeInstanceOf(Error);
        sendResult = (frame) => ({ bytesSent: frame.byteLength });
        MSP.send_cli_command("get b", (lines, error) => results.push({ cmd: "next", error }));
        await settle();
        expect(cliFrames()).toEqual(["set x = 1"]);
        expect(results[1]?.error).toBeInstanceOf(Error);
    });

    it("ends a command the transport reported 0 bytes for with an error (no silent wait)", async () => {
        sendResult = () => ({ bytesSent: 0 });
        const outcome: boolean[] = [];
        const results: unknown[] = [];
        MSP.send_cli_command("save", (lines, error) => results.push(error), {
            onDelivery: (d: boolean) => outcome.push(d),
        });
        await settle();
        expect(outcome).toEqual([false]);
        expect(results[0]).toBeInstanceOf(Error);
    });

    it("tags only the in-flight command as connection-closed on disconnect; queued ones were never sent", async () => {
        const errors: Record<string, Error & { connectionClosed?: boolean; delivered?: boolean; notSent?: boolean }> =
            {};
        MSP.send_cli_command("save", (lines, error) => (errors.save = error as never));
        MSP.send_cli_command("get queued", (lines, error) => (errors.queued = error as never));
        await settle();
        MSP.disconnect_cleanup();
        expect(errors.save?.connectionClosed).toBe(true);
        expect(errors.save?.delivered).toBe(true);
        expect(errors.queued?.connectionClosed).not.toBe(true);
        expect(errors.queued?.notSent).toBe(true);
    });

    it("marks an in-flight command whose delivery was not reported yet as not known delivered", async () => {
        let release: (r: SendResult) => void = () => {};
        vi.mocked(serial.send).mockImplementationOnce(
            (data) =>
                new Promise<SendResult>((resolve) => {
                    sent.push(Array.from(new Uint8Array(data as ArrayBuffer)));
                    release = resolve;
                }),
        );
        let err: (Error & { connectionClosed?: boolean; delivered?: boolean }) | undefined;
        MSP.send_cli_command("save", (lines, error) => (err = error as never));
        await settle();
        MSP.disconnect_cleanup();
        release({ bytesSent: 0 });
        expect(err?.connectionClosed).toBe(true);
        expect(err?.delivered).toBe(false);
    });
});
