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
 * WP8 P0 closure, transport side: every write route of the app reaches the flight controller
 * through the real msp.ts (MSP requests, MSP CLI) or the CLI tab's raw serial line (useCli.ts), and
 * each of them must respect an uncertain FC state. Only serial.send is replaced (spied, as in
 * test/js/msp_promise.test.ts): what reaches it is what would reach the craft. The transaction
 * store, the write guard, MSP, useMspCliSession (the Presets tab's apply and save) and useCli are
 * the production code.
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
import { mspHelper } from "../../src/js/msp/MSPHelper";
import { useConnectionStore } from "../../src/stores/connection";
import { useFlightControllerStore } from "../../src/stores/fc";
import { ApplyBlockedError } from "../../src/gyrocore/chirp/applyGate";
import { TRANSACTION_ENTRY_PREFIX, type UncertainTransaction } from "../../src/gyrocore/stores/fcTransactionState";
import { saveAndReconnect, send as cliSend, sendSave, useMspCliSession } from "../../src/composables/useMspCliSession";
import { useCli } from "../../src/composables/useCli";

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

describe("MSP requests from any caller while the craft's state is uncertain", () => {
    it("a SET (the PID tab's MSP_SET_PID) is refused before it reaches the port", async () => {
        uncertain();
        const err = await rejected(MSP.promise(MSPCodes.MSP_SET_PID, mspHelper.crunch(MSPCodes.MSP_SET_PID)));
        expect(err).toBeInstanceOf(ApplyBlockedError);
        expect((err as ApplyBlockedError).reasons).toEqual(["fc:transaction_state_uncertain:bk-u:eeprom:unknown"]);
        expect(sentCodes()).toEqual([]);
    });

    it("MSP_EEPROM_WRITE over the callback API is not sent, and its success callback never runs", () => {
        uncertain();
        const done = vi.fn();
        expect(MSP.send_message(MSPCodes.MSP_EEPROM_WRITE, false, false, done)).toBe(false);
        expect(sentCodes()).toEqual([]);
        expect(done).not.toHaveBeenCalled();
    });

    it("a profile switch, a profile copy and a profile reset are refused (they change what a check would read)", async () => {
        uncertain();
        for (const [code, data] of [
            [MSPCodes.MSP_SELECT_SETTING, [1]],
            [MSPCodes.MSP_COPY_PROFILE, [0, 0, 1]],
            [MSPCodes.MSP_SET_RESET_CURR_PID, undefined],
            [MSPCodes.MSP_RESET_CONF, undefined],
        ] as const) {
            expect(await rejected(MSP.promise(code, data as number[] | undefined))).toBeInstanceOf(ApplyBlockedError);
        }
        expect(sentCodes()).toEqual([]);
    });

    it("MSP2_CLI_SETTING is a set when it carries '=' and a read otherwise", async () => {
        uncertain();
        const bytes = (s: string) => Array.from(s, (c) => c.codePointAt(0)!);
        expect(await rejected(MSP.promise(MSPCodes.MSP2_CLI_SETTING, bytes("p_roll = 50")))).toBeInstanceOf(
            ApplyBlockedError,
        );
        void MSP.promise(MSPCodes.MSP2_CLI_SETTING, bytes("p_roll")).catch(() => undefined);
        expect(sentCodes()).toEqual([MSPCodes.MSP2_CLI_SETTING]);
    });

    it("reads, the connect sequence's MSP_SET_RTC and a motor stop still go out (the check must be able to run)", () => {
        uncertain();
        void MSP.promise(MSPCodes.MSP_PID).catch(() => undefined);
        void MSP.promise(MSPCodes.MSP_UID).catch(() => undefined);
        MSP.send_message(MSPCodes.MSP_SET_RTC, mspHelper.crunch(MSPCodes.MSP_SET_RTC), false, () => undefined);
        MSP.send_message(MSPCodes.MSP_SET_MOTOR, [0, 0, 0, 0, 0, 0, 0, 0], false, () => undefined);
        expect(sentCodes()).toEqual([MSPCodes.MSP_PID, MSPCodes.MSP_UID, MSPCodes.MSP_SET_RTC, MSPCodes.MSP_SET_MOTOR]);
    });

    it("a SET parked behind another one is checked again when it is released", async () => {
        // The first SET goes out while the state is known; the second waits behind it (same code).
        const first = MSP.promise(MSPCodes.MSP_SET_PID, [1, 2, 3]);
        const second = MSP.promise(MSPCodes.MSP_SET_PID, [4, 5, 6]);
        expect(sentCodes()).toEqual([MSPCodes.MSP_SET_PID]);
        // Meanwhile a Gyroflight write elsewhere ends unverified; then the first one times out.
        uncertain();
        void first.catch(() => undefined);
        const secondErr = rejected(second);
        await vi.advanceTimersByTimeAsync(MSP.TIMEOUT * (MSP.MAX_RETRIES + 1));
        expect(await secondErr).toBeInstanceOf(ApplyBlockedError);
        // Only the first one's (re)transmissions reached the port.
        expect(sent.mock.calls.every(([b]) => new Uint8Array(b as ArrayBuffer)[5] === 1)).toBe(true);
    });

    it("an entry with an unknown craft (UID not read yet) refuses SETs too", async () => {
        uncertain();
        useFlightControllerStore().config.uid = null as never;
        expect(await rejected(MSP.promise(MSPCodes.MSP_SET_PID, [1]))).toBeInstanceOf(ApplyBlockedError);
        expect(sentCodes()).toEqual([]);
    });
});

describe("the MSP CLI (Presets, Backups, AutoRestore, flight plan, VTX and port tools) while uncertain", () => {
    it("CLI `save` is refused and nothing reaches the port", async () => {
        uncertain();
        expect(await rejected(sendSave())).toBeInstanceOf(ApplyBlockedError);
        expect(sentText()).toEqual([]);
    });

    it("a preset apply: each `set` and the closing save are refused; a `get` still runs; no reconnect for a save that never ran", async () => {
        uncertain();
        const session = useMspCliSession();
        const batch = session.runBatch(["# preset", "set p_roll = 50", "get p_roll", "defaults nosave", "save"]);
        await vi.advanceTimersByTimeAsync(5000);
        const result = await batch;
        // Refused by the write check (the `get` went out; with no simulated FC its answer times out).
        const refused = result.errors.filter((e) => e.errors[0].includes("fc:transaction_state_uncertain"));
        expect(refused.map((e) => e.command)).toEqual(["set p_roll = 50", "defaults nosave", "save"]);
        expect(sentText()).toEqual(["get p_roll\n"]);
        const saved = await saveAndReconnect();
        expect(saved.ok).toBe(false);
        expect(saved.error).toBeInstanceOf(ApplyBlockedError);
        expect(reconnect.schedule).not.toHaveBeenCalled();
        expect(sentText()).toEqual(["get p_roll\n"]);
    });

    it("an unknown command is not taken for a read", async () => {
        uncertain();
        expect(await rejected(cliSend("frobnicate"))).toBeInstanceOf(ApplyBlockedError);
        expect(await rejected(cliSend("profile 1"))).toBeInstanceOf(ApplyBlockedError);
        expect(await rejected(cliSend("get p_roll\nsave"))).toBeInstanceOf(ApplyBlockedError);
        expect(sentText()).toEqual([]);
    });
});

describe("the CLI tab's raw serial line (useCli) while uncertain", () => {
    it("`save` typed into the CLI tab never reaches the port; `get`, `diff all` and `exit` do", () => {
        uncertain();
        const cli = useCli();
        cli.sendLine("save");
        cli.sendLine("set p_roll = 50");
        cli.sendLine("get p_roll");
        cli.sendLine("diff all");
        cli.sendLine("exit");
        expect(sentText()).toEqual(["get p_roll\n", "diff all\n", "exit\n"]);
    });

    it("tab completion is refused: the firmware's line buffer would hold text the guard never saw", () => {
        uncertain();
        const cli = useCli();
        // What the native completion sends (`useCli.sendNativeAutoComplete`) carries a tab; any such text is refused.
        cli.sendLine("sa\t");
        cli.sendLine("get p_\t");
        expect(sentText()).toEqual([]);
    });
});

describe("normal writes without an uncertain state", () => {
    it("SETs, EEPROM writes, CLI save and a preset batch all reach the port", async () => {
        void MSP.promise(MSPCodes.MSP_SET_PID, [1]).catch(() => undefined);
        MSP.send_message(MSPCodes.MSP_EEPROM_WRITE, false, false, () => undefined);
        void sendSave().catch(() => undefined);
        expect(sentCodes()).toEqual([MSPCodes.MSP_SET_PID, MSPCodes.MSP_EEPROM_WRITE]);
        expect(sentText()).toEqual(["save\n"]);
        const cli = useCli();
        cli.sendLine("set p_roll = 50");
        expect(sentText()).toEqual(["save\n", "set p_roll = 50\n"]);
    });
});

describe("the inventory of MSP codes", () => {
    it("every code is classified; only listed runtime commands pass while uncertain", async () => {
        const { classifyMsp, RUNTIME_MSP_CODES } = await import("../../src/composables/fcWriteGuard");
        const all = Object.entries(MSPCodes).filter(([, v]) => typeof v === "number") as [string, number][];
        const classes = Object.fromEntries(all.map(([k, v]) => [k, classifyMsp(v, undefined)]));
        expect(Object.values(classes).every((c) => ["read", "runtime", "write"].includes(c))).toBe(true);
        expect([...RUNTIME_MSP_CODES].sort((a, b) => a - b)).toEqual(
            [MSPCodes.MSP_REBOOT, MSPCodes.MSP_SET_ARMING_DISABLED, MSPCodes.MSP_SET_MOTOR, MSPCodes.MSP_SET_RTC].sort(
                (a, b) => a - b,
            ),
        );
        // Every MSP_SET_* / MSP2_SET_* and the other state-changing commands are writes.
        for (const [k] of all.filter(([k]) => /^MSP2?_(COMMON_)?SET_/.test(k))) {
            if (!["MSP_SET_RTC", "MSP_SET_ARMING_DISABLED", "MSP_SET_MOTOR"].includes(k))
                expect([k, classes[k]]).toEqual([k, "write"]);
        }
        for (const k of [
            "MSP_EEPROM_WRITE",
            "MSP_RESET_CONF",
            "MSP_SELECT_SETTING",
            "MSP_COPY_PROFILE",
            "MSP_ACC_CALIBRATION",
            "MSP_MAG_CALIBRATION",
            "MSP_DATAFLASH_ERASE",
            "MSP_OSD_CHAR_WRITE",
            "MSP2_SEND_DSHOT_COMMAND",
            "MSP2_BETAFLIGHT_BIND",
            "MSP_DISPLAYPORT",
        ]) {
            expect([k, classes[k]]).toEqual([k, "write"]);
        }
        // A code the table does not know is a write.
        expect(classifyMsp(0x7fff, undefined)).toBe("write");
    });
});
