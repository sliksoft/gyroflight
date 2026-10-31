import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import MSP from "../../src/js/msp";
import { serial } from "../../src/js/serial";

const STX = 0x02;
const ETX = 0x03;
const LF = 0x0a;

function toReadInfo(bytes: number[]) {
    return { data: new Uint8Array(bytes).buffer };
}

function responseBytes(body: string) {
    const bytes = [STX];
    for (let i = 0; i < body.length; i++) {
        bytes.push(body.codePointAt(i)!);
    }
    bytes.push(LF, ETX);
    return bytes;
}

describe("MSP CLI queue", () => {
    let serialSendSpy: MockInstance<typeof serial.send>;

    beforeEach(() => {
        vi.useFakeTimers();
        // The transport takes every byte (a CLI command is delivered only then: audit WP8-F09).
        serialSendSpy = vi.spyOn(serial, "send").mockImplementation(async (data) => ({ bytesSent: data.byteLength }));
        MSP.cli_queue.length = 0;
        MSP.cli_in_flight = null;
        MSP.cli_callback = null;
        MSP.cli_buffer.length = 0;
        MSP.cli_output.length = 0;
        MSP.cli_discarding = false;
        MSP.cli_session_uncertain = false;
        if (MSP.cli_timer) {
            clearTimeout(MSP.cli_timer);
            MSP.cli_timer = null;
        }
        if (MSP.cli_drain_timer) {
            clearTimeout(MSP.cli_drain_timer);
            MSP.cli_drain_timer = null;
        }
        MSP.state = MSP.decoder_states.IDLE;
    });

    afterEach(() => {
        if (MSP.cli_timer) {
            clearTimeout(MSP.cli_timer);
            MSP.cli_timer = null;
        }
        if (MSP.cli_drain_timer) {
            clearTimeout(MSP.cli_drain_timer);
            MSP.cli_drain_timer = null;
        }
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    // Gyroflight (audit WP8-F09): a reply counts once the transport reported the command's bytes sent.
    const settled = async () => {
        for (let i = 0; i < 10; i++) await Promise.resolve();
    };

    it("serialises commands in push order", async () => {
        const order: Array<[string, string[]]> = [];

        MSP.send_cli_command("first", (lines) => order.push(["first", lines]));
        MSP.send_cli_command("second", (lines) => order.push(["second", lines]));

        expect(serialSendSpy).toHaveBeenCalledTimes(1);

        MSP.read(toReadInfo(responseBytes("hello-first")));
        await settled();
        expect(order).toEqual([["first", ["hello-first", ""]]]);
        expect(serialSendSpy).toHaveBeenCalledTimes(2);

        MSP.read(toReadInfo(responseBytes("hello-second")));
        await settled();
        expect(order).toEqual([
            ["first", ["hello-first", ""]],
            ["second", ["hello-second", ""]],
        ]);
    });

    it("fires the callback with an error when a command times out", () => {
        const results: Array<Record<string, unknown>> = [];
        MSP.send_cli_command("slow", (lines, error) => results.push({ cmd: "slow", lines, error }), { timeoutMs: 100 });

        vi.advanceTimersByTime(150);

        expect(results).toHaveLength(1);
        expect(results[0].cmd).toBe("slow");
        expect(results[0].error).toBeInstanceOf(Error);
        expect((results[0].error as Error).message).toMatch(/Timed out after 100ms/);
        expect(MSP.cli_discarding).toBe(true);
    });

    it("drains a late response in full before sending the next command", async () => {
        const results: Array<Record<string, unknown>> = [];
        MSP.send_cli_command("slow", (lines, error) => results.push({ cmd: "slow", error }), { timeoutMs: 100 });
        MSP.send_cli_command("fast", (lines, error) => results.push({ cmd: "fast", lines, error }));

        expect(serialSendSpy).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(150);
        // "fast" must not have been sent yet — we're still draining.
        expect(serialSendSpy).toHaveBeenCalledTimes(1);
        expect(MSP.cli_discarding).toBe(true);

        // The firmware's late response for "slow" finally arrives.
        MSP.read(toReadInfo(responseBytes("late-slow")));

        // Drain ends on the ETX, "fast" is dispatched, and its reply is clean.
        expect(MSP.cli_discarding).toBe(false);
        expect(serialSendSpy).toHaveBeenCalledTimes(2);

        MSP.read(toReadInfo(responseBytes("fast-response")));
        await settled();
        expect(results[1]).toEqual({ cmd: "fast", lines: ["fast-response", ""], error: null });
    });

    // Gyroflight (audit WP8-F09): upstream let the next command go out here, so a late reply could be
    // taken for its answer. With no request id in the framing, the session is closed instead.
    it("after the grace period without the late reply's ETX, refuses the queue until the link is set up again", () => {
        const results: Array<{ cmd: string; error: unknown }> = [];
        MSP.send_cli_command("slow", (lines, error) => results.push({ cmd: "slow", error }), { timeoutMs: 100 });
        MSP.send_cli_command("fast", (lines, error) => results.push({ cmd: "fast", error }));

        vi.advanceTimersByTime(150); // timeout fires
        expect(MSP.cli_discarding).toBe(true);
        expect(serialSendSpy).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(MSP.cli_drain_grace_ms + 10);
        expect(MSP.cli_discarding).toBe(false);
        expect(MSP.cli_session_uncertain).toBe(true);
        expect(serialSendSpy).toHaveBeenCalledTimes(1);
        expect(results[1]).toEqual({ cmd: "fast", error: expect.any(Error) });
    });

    it("drains the queue on disconnect_cleanup and notifies callers", () => {
        const results: Array<Record<string, unknown>> = [];

        MSP.send_cli_command("a", (lines, error) => results.push({ cmd: "a", error }));
        MSP.send_cli_command("b", (lines, error) => results.push({ cmd: "b", error }));
        MSP.send_cli_command("c", (lines, error) => results.push({ cmd: "c", error }));

        MSP.disconnect_cleanup();

        expect(results).toHaveLength(3);
        for (const r of results) {
            expect(r.error).toBeInstanceOf(Error);
        }
        expect(MSP.cli_queue).toHaveLength(0);
        expect(MSP.cli_in_flight).toBeNull();
        expect(MSP.cli_callback).toBeNull();
        expect(MSP.cli_discarding).toBe(false);
    });
});
