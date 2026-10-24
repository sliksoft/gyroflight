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
 * WP8 final acceptance (Codex review of c7072275..17fd4b0a and the routes behind it): what the
 * write check judges must be what reaches the firmware. Same harness as wp8_p0_closure_transport:
 * the real msp.ts, guard, transaction store, useMspCliSession and useCli; only serial.send is spied.
 */

import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const reconnect = vi.hoisted(() => ({ schedule: vi.fn(), cancel: vi.fn() }));
vi.mock("../../src/js/serial_backend", () => ({
    __esModule: true,
    scheduleRebootReconnect: reconnect.schedule,
    cancelRebootReconnect: reconnect.cancel,
    reinitializeConnection: vi.fn(),
}));

import MSP from "../../src/js/msp";
import { serial } from "../../src/js/serial";
import MSPCodes from "../../src/js/msp/MSPCodes";
import { useConnectionStore } from "../../src/stores/connection";
import { useFlightControllerStore } from "../../src/stores/fc";
import { ApplyBlockedError } from "../../src/gyrocore/chirp/applyGate";
import { TRANSACTION_ENTRY_PREFIX, type UncertainTransaction } from "../../src/gyrocore/stores/fcTransactionState";
import { send as cliSend } from "../../src/composables/useMspCliSession";
import { useCli } from "../../src/composables/useCli";
import autoRestoreInstance from "../../src/js/utils/AutoRestore";

const UID: [number, number, number] = [0x0a1b2c3d, 0x4e5f6071, 0x12233445];

function uncertainEntry(e: Partial<UncertainTransaction> = {}): UncertainTransaction {
    return {
        id: "tx-u",
        uid: [...UID],
        action: "absolute_apply",
        stage: "eeprom",
        saved: "unknown",
        backupId: "bk-u",
        profiles: [0],
        detail: "",
        at: "2026-10-24T00:00:00Z",
        ...e,
    };
}

function uncertain(e: Partial<UncertainTransaction> = {}) {
    const t = uncertainEntry(e);
    localStorage.setItem(`${TRANSACTION_ENTRY_PREFIX}${t.id}`, JSON.stringify(t));
}

// serial.js is untyped JS; `connected` is the only protocol field serial.connected reads.
function setProtocolConnected(connected: boolean) {
    (serial as unknown as { _protocol: { connected: boolean } })._protocol = { connected };
}

let sent: MockInstance<typeof serial.send>;

/** MSP codes of the frames that reached the serial port (v1 `$M<` and v2 `$X<`). */
function sentCodes(): number[] {
    return sent.mock.calls
        .map(([buf]) => new Uint8Array(buf as ArrayBuffer))
        .filter((b) => b[0] === 0x24 && (b[1] === 0x4d || b[1] === 0x58))
        .map((b) => (b[1] === 0x4d ? b[4] : b[4] | (b[5] << 8)));
}

/** Text that reached the serial port as CLI (MSP CLI frames STX..ETX, or the CLI tab's raw bytes). */
function sentText(): string[] {
    return sent.mock.calls
        .map(([buf]) => new Uint8Array(buf as ArrayBuffer))
        .filter((b) => !(b[0] === 0x24 && (b[1] === 0x4d || b[1] === 0x58)))
        .map((b) => String.fromCodePoint(...b).replace(/[\u0002\u0003]/g, ""));
}

async function rejected(p: Promise<unknown>): Promise<unknown> {
    return p.then(
        () => null,
        (e: unknown) => e,
    );
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    vi.useFakeTimers();
    sent = vi.spyOn(serial, "send").mockImplementation(async () => ({ bytesSent: 0 }));
    setProtocolConnected(true);
    useConnectionStore().virtualMode = false;
    useFlightControllerStore().config.uid = [...UID];
    MSP.callbacks = [];
    MSP.parked.clear();
    MSP.cli_queue = [];
    MSP.cli_in_flight = null;
    MSP.state = MSP.decoder_states.IDLE;
    reconnect.schedule.mockClear();
});

afterEach(() => {
    MSP.callbacks_cleanup();
    MSP.cli_queue = [];
    MSP.cli_in_flight = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
});

/** The raw bytes of every send, MSP CLI framing (STX / ETX) removed. */
function wireBytes(): number[][] {
    return sent.mock.calls
        .map(([buf]) => Array.from(new Uint8Array(buf as ArrayBuffer)))
        .filter((b) => !(b[0] === 0x24 && (b[1] === 0x4d || b[1] === 0x58)))
        .map((b) => b.filter((x) => x !== 0x02 && x !== 0x03));
}

describe("CLI text is judged as the bytes the firmware gets (Codex WP8 final review P0)", () => {
    // Each would reach the MSP CLI as a different command: the encoder keeps the low byte.
    const smuggled = [
        ["U+010A (LF)", "get p_rollĊsave"],
        ["U+010D (CR)", "get p_rollčsave"],
        ["U+017F (DEL)", "save ſſſſſget"],
        ["U+1000A (astral, LF)", "get p_roll\u{1000a}save"],
        ["U+0120 (space)", "saveĠget"],
    ] as const;

    it.each(smuggled)("MSP CLI: %s is refused before it reaches the port", async (_name, text) => {
        uncertain();
        expect(await rejected(cliSend(text))).toBeInstanceOf(ApplyBlockedError);
        expect(wireBytes()).toEqual([]);
    });

    it.each(smuggled)(
        "MSP CLI: %s queued behind another command is refused when it would go out",
        async (_name, text) => {
            const first = rejected(cliSend("get p_roll", { timeoutMs: 100 }));
            const queued = rejected(cliSend(text));
            uncertain();
            await vi.advanceTimersByTimeAsync(5000);
            await first;
            expect(await queued).toBeInstanceOf(ApplyBlockedError);
            expect(sentText()).toEqual(["get p_roll\n"]);
        },
    );

    it("CLI tab: non-ASCII and Unicode spaces are refused (the check splits on them, cli.c does not)", () => {
        uncertain();
        const cli = useCli();
        cli.sendLine("get p_rollĊsave");
        cli.sendLine("get p_roll");
        cli.sendLine(" save");
        expect(wireBytes()).toEqual([]);
    });

    it("plain ASCII reads still go out on both routes", () => {
        uncertain();
        void cliSend("get p_roll").catch(() => undefined);
        expect(sentText()).toEqual(["get p_roll\n"]);
    });

    it("without an uncertain state nothing changes: such text is sent as before", () => {
        void cliSend("get p_rollĊsave").catch(() => undefined);
        expect(sentText()).toEqual(["get p_roll\nsave\n"]);
    });
});

describe("MSP2_CLI_SETTING is judged on its encoded bytes", () => {
    it("a value whose low byte is '=' is a set and is refused", async () => {
        uncertain();
        const payload = Array.from("p_roll ", (c) => c.codePointAt(0)!).concat(
            [0x13d],
            Array.from(" 50", (c) => c.codePointAt(0)!),
        );
        expect(await rejected(MSP.promise(MSPCodes.MSP2_CLI_SETTING, payload))).toBeInstanceOf(ApplyBlockedError);
        expect(sentCodes()).toEqual([]);
    });

    it("a Uint8Array payload with '=' is a set", async () => {
        uncertain();
        const payload = new TextEncoder().encode("p_roll = 50");
        expect(await rejected(MSP.promise(MSPCodes.MSP2_CLI_SETTING, payload))).toBeInstanceOf(ApplyBlockedError);
        expect(sentCodes()).toEqual([]);
    });
});

/**
 * The firmware's interactive line editor (cli.c processCharacterInteractive / processCharacter) over
 * the bytes sent, against a few command names (the table is sorted, as cmdTable is): which command
 * lines it would run. Completion on tab or '?', 0x7f deletes, leading spaces dropped, 255 characters.
 */
function firmwareRuns(bytes: number[], names = ["diff", "dump", "exit", "get", "save", "set", "status"]): string[] {
    let buf = "";
    const ran: string[] = [];
    for (const c of bytes) {
        if (c === 0x09 || c === 0x3f) {
            const m = names.filter((n) => n.startsWith(buf.toLowerCase()));
            if (!m.length) continue;
            const [first, last] = [m[0], m.at(-1)!];
            let i = buf.length;
            for (; i < first.length && first[i] === last[i]; i++) buf += first[i];
            if (m.length === 1 && i === first.length) buf += " ";
        } else if (c === 0x7f) {
            buf = buf.slice(0, -1);
        } else if (c === 0x0a || c === 0x0d) {
            const line = (buf.includes("#") ? buf.slice(0, buf.indexOf("#")) : buf).replace(/ +$/, "");
            if (line) ran.push(line);
            buf = "";
        } else if (c >= 0x20 && c <= 0x7e && buf.length < 255 && !(buf === "" && c === 0x20)) {
            buf += String.fromCodePoint(c);
        }
    }
    return ran;
}

describe("the CLI tab's line: the firmware may hold text whose echo has not arrived (Codex WP8 final review P0)", () => {
    function cliTab() {
        const connection = useConnectionStore();
        connection.connectionValid = true;
        connection.cliValid = true;
        connection.cliActive = true;
        return useCli();
    }
    const allBytes = () => sent.mock.calls.flatMap(([b]) => Array.from(new Uint8Array(b as ArrayBuffer)));

    it("a completion sent while writes were allowed, then uncertainty, then leaving the tab: `save exit` never runs", () => {
        const cli = cliTab();
        cli.state.commandInput = "sa";
        cli.handleCommandKeyDown(new KeyboardEvent("keydown", { key: "Tab" }));
        expect(sentText()).toEqual(["sa\t"]);
        uncertain(); // the echo "ve " has not arrived; the page still sees an empty line
        expect(cli.cleanup()).toBe(true);
        expect(firmwareRuns(allBytes())).toEqual(["exit"]);
    });

    it("the same for a typed read: `get p_roll` runs, not `save get p_roll`", () => {
        const cli = cliTab();
        cli.state.commandInput = "sa";
        cli.handleCommandKeyDown(new KeyboardEvent("keydown", { key: "Tab" }));
        uncertain();
        cli.sendLine("get p_roll");
        expect(firmwareRuns(allBytes())).toEqual(["get p_roll"]);
    });

    it("leaving the tab with echoed text in the line (`# save `) exits; the reboot it reports is real", () => {
        const cli = cliTab();
        cli.read(new TextEncoder().encode("# save "));
        uncertain();
        expect(cli.cleanup()).toBe(true);
        expect(firmwareRuns(allBytes())).toEqual(["exit"]);
    });

    it("'?' completes like a tab in the interactive CLI and is refused like one", () => {
        uncertain();
        const cli = cliTab();
        cli.sendLine("sa?");
        cli.sendLine("get p_roll?");
        expect(sent).not.toHaveBeenCalled();
    });

    it("a refused write over the CLI tab sends nothing at all, not even the line clearing", () => {
        uncertain();
        const cli = cliTab();
        cli.sendLine("save");
        expect(sent).not.toHaveBeenCalled();
    });

    it("without an uncertain state the tab sends exactly what it did before (no line clearing)", () => {
        const cli = cliTab();
        cli.read(new TextEncoder().encode("# ex"));
        expect(cli.cleanup()).toBe(true);
        expect(sentText()).toEqual(["it\r"]);
    });
});

describe("AutoRestore reports success only for a save that went out (Codex WP8 final review P1)", () => {
    type Ar = {
        _callback: ((r: unknown) => void) | null;
        _finishWithSave: (errors: unknown[]) => Promise<void>;
        handleDisconnect: () => void;
    };
    async function autoRestore() {
        const ar = autoRestoreInstance;
        vi.spyOn(serial, "disconnect").mockResolvedValue(true as never);
        const results: { success: boolean }[] = [];
        const a = ar as unknown as Ar;
        a._callback = (r) => results.push(r as { success: boolean });
        return { a, results };
    }

    it("a refused save followed by a disconnect inside the flush delay is a failure", async () => {
        uncertain();
        const { a, results } = await autoRestore();
        const done = a._finishWithSave([]);
        a.handleDisconnect();
        await vi.advanceTimersByTimeAsync(5000);
        await done;
        expect(results).toEqual([expect.objectContaining({ success: false })]);
        expect(sentText()).toEqual([]);
    });

    it("a save waiting behind another CLI command is refused when it would go out: failure, nothing sent", async () => {
        const { a, results } = await autoRestore();
        const first = rejected(cliSend("get p_roll", { timeoutMs: 3000 }));
        const done = a._finishWithSave([]);
        await vi.advanceTimersByTimeAsync(1000); // past the flush delay: the save has not gone out
        expect(results).toEqual([]);
        uncertain();
        await vi.advanceTimersByTimeAsync(5000);
        await first;
        await done;
        expect(results).toEqual([expect.objectContaining({ success: false })]);
        expect(sentText()).toEqual(["get p_roll\n"]);
    });

    it("a disconnect while the save still waits in the queue is a failure, not the save's reboot", async () => {
        const { a, results } = await autoRestore();
        void cliSend("get p_roll", { timeoutMs: 3000 }).catch(() => undefined);
        void a._finishWithSave([]);
        await vi.advanceTimersByTimeAsync(600);
        a.handleDisconnect();
        expect(results).toEqual([expect.objectContaining({ success: false })]);
    });

    it("without an uncertain state a save that went out still ends as success", async () => {
        const { a, results } = await autoRestore();
        const done = a._finishWithSave([]);
        await vi.advanceTimersByTimeAsync(1000);
        await done;
        expect(sentText()).toEqual(["save\n"]);
        expect(results).toEqual([expect.objectContaining({ success: true })]);
    });
});
