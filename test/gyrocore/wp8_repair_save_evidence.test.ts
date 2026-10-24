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
 * Audit WP8-F01: a CLI `save` (AutoRestore, Presets/Backups) counts as saved only on the firmware's
 * own evidence. Betaflight's cliSave prints "# saving" and cliReboot "Rebooting" only after
 * writeEEPROM() returned, and writeEEPROM() verifies what it wrote or never returns (cli.c,
 * config_eeprom.c, 4.3 to master: source reviewed, not run on hardware). Sent but unconfirmed is its
 * own outcome ("not_verified"), never success; not sent, cut or refused is a failure.
 *
 * Production AutoRestore, msp.ts (queue, CLI decoder) and useMspCliSession; only the transport
 * (serial.send / disconnect) and the reconnect scheduler are replaced. The firmware's bytes are
 * fed to MSP.read as the STX path sends them (cli.c cliEnter, cliPrintHashLine, cliRebootEx).
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

const log = vi.hoisted(() => ({ gui: vi.fn() }));
vi.mock("../../src/js/gui_log", () => ({ gui_log: log.gui }));
// Each message is its key, so the warning a test looks for cannot be an empty text.
vi.mock("../../src/js/localization", () => ({ i18n: { getMessage: (key: string) => key } }));

import MSP from "../../src/js/msp";
import { serial } from "../../src/js/serial";
import { useConnectionStore } from "../../src/stores/connection";
import { useFlightControllerStore } from "../../src/stores/fc";
import { TRANSACTION_ENTRY_PREFIX } from "../../src/gyrocore/stores/fcTransactionState";
import { saveAndReconnect, send as cliSend } from "../../src/composables/useMspCliSession";
import autoRestoreInstance, { type AutoRestoreResult } from "../../src/js/utils/AutoRestore";

const UID: [number, number, number] = [0x0a1b2c3d, 0x4e5f6071, 0x12233445];
const STX = 0x02;
const text = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
/** What the firmware sends for a `save` on the STX path: no ETX, it resets after "Rebooting". */
const SAVE_OUTPUT = [STX, ...text("\r\n# saving\r\n\r\nRebooting")];
const feed = (bytes: number[]) => MSP.read({ data: new Uint8Array(bytes).buffer });

let sent: MockInstance<typeof serial.send>;
let bytesFor: (frame: ArrayBuffer) => number;

const sentCli = () =>
    sent.mock.calls
        .map(([buf]) => Array.from(new Uint8Array(buf as ArrayBuffer)))
        .filter((b) => b[0] === STX)
        .map((b) => String.fromCharCode(...b.slice(1, -2)));

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    vi.useFakeTimers();
    bytesFor = (frame) => frame.byteLength;
    sent = vi.spyOn(serial, "send").mockImplementation(async (data) => ({ bytesSent: bytesFor(data as ArrayBuffer) }));
    vi.spyOn(serial, "disconnect").mockResolvedValue(true as never);
    (serial as unknown as { _protocol: { connected: boolean } })._protocol = { connected: true };
    useConnectionStore().virtualMode = false;
    useFlightControllerStore().config.uid = [...UID];
    MSP.callbacks = [];
    MSP.cli_queue = [];
    MSP.cli_in_flight = null;
    MSP.cli_discarding = false;
    MSP.cli_session_uncertain = false;
    MSP.state = MSP.decoder_states.IDLE;
    reconnect.schedule.mockClear();
    log.gui.mockClear();
});

afterEach(() => {
    MSP.disconnect_cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

type Ar = {
    _callback: ((r: AutoRestoreResult) => void) | null;
    _finishWithSave: (errors: unknown[]) => Promise<void>;
    handleDisconnect: () => void;
};

function autoRestore() {
    const a = autoRestoreInstance as unknown as Ar;
    const results: AutoRestoreResult[] = [];
    a._callback = (r) => results.push(r);
    return { a, results };
}

const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("WP8-F01 AutoRestore: saved only on the firmware's evidence", () => {
    it("the firmware printed '# saving' / 'Rebooting', then the port closed: success, persistence confirmed", async () => {
        const { a, results } = autoRestore();
        const done = a._finishWithSave([]);
        await settle();
        feed(SAVE_OUTPUT);
        a.handleDisconnect();
        await done;
        expect(sentCli()).toEqual(["save"]);
        expect(results).toEqual([expect.objectContaining({ success: true, persistence: "confirmed" })]);
    });

    it("only 'Rebooting' (MINIMAL_CLI builds print no '# saving') is evidence too", async () => {
        const { a, results } = autoRestore();
        const done = a._finishWithSave([]);
        await settle();
        feed([STX, ...text("\r\nRebooting")]);
        a.handleDisconnect();
        await done;
        expect(results).toEqual([expect.objectContaining({ success: true, persistence: "confirmed" })]);
    });

    it("the save went out whole and the port closed, but nothing from the firmware: not verified, not success", async () => {
        const { a, results } = autoRestore();
        const done = a._finishWithSave([]);
        await settle();
        a.handleDisconnect();
        await done;
        expect(results).toEqual([expect.objectContaining({ success: false, persistence: "not_verified" })]);
    });

    it("the save went out whole and nothing happened (no reboot, no text) past the flush delay: not verified", async () => {
        const { a, results } = autoRestore();
        const done = a._finishWithSave([]);
        await vi.advanceTimersByTimeAsync(10_000);
        await done;
        expect(results).toEqual([expect.objectContaining({ success: false, persistence: "not_verified" })]);
    });

    it("the transport took 0 bytes of the save: failure, never success, even after the flush delay", async () => {
        bytesFor = () => 0;
        const { a, results } = autoRestore();
        const done = a._finishWithSave([]);
        await vi.advanceTimersByTimeAsync(10_000);
        await done;
        expect(results).toEqual([expect.objectContaining({ success: false })]);
        expect(results[0].persistence).not.toBe("confirmed");
        expect(results[0].persistence).not.toBe("not_verified");
    });

    it("the transport took only part of the save frame: failure (unknown), a following disconnect is no reboot proof", async () => {
        bytesFor = (frame) => frame.byteLength - 3;
        const { a, results } = autoRestore();
        const done = a._finishWithSave([]);
        await settle();
        a.handleDisconnect();
        await vi.advanceTimersByTimeAsync(10_000);
        await done;
        expect(results).toEqual([expect.objectContaining({ success: false, persistence: "unknown" })]);
    });

    it("a disconnect before the transport reported the save's bytes is not the save's reboot", async () => {
        sent.mockImplementationOnce(() => new Promise(() => {}));
        const { a, results } = autoRestore();
        const done = a._finishWithSave([]);
        await settle();
        a.handleDisconnect();
        await done;
        expect(results).toEqual([expect.objectContaining({ success: false })]);
        expect(results[0].persistence).not.toBe("confirmed");
        expect(results[0].persistence).not.toBe("not_verified");
    });

    it("the transport never reports on the save and the port stays open: ends unknown, never success", async () => {
        sent.mockImplementationOnce(() => new Promise(() => {}));
        const { a, results } = autoRestore();
        const done = a._finishWithSave([]);
        await vi.advanceTimersByTimeAsync(10_000);
        await done;
        expect(results).toEqual([expect.objectContaining({ success: false, persistence: "unknown" })]);
    });

    it("the firmware answered the save with its ETX and no '# saving' (it refused to save): failure", async () => {
        const { a, results } = autoRestore();
        const done = a._finishWithSave([]);
        await settle();
        feed([STX, ...text("\r\n###ERROR: PLEASE FIX ERRORS THEN 'SAVE'\r\n"), 0x03]);
        await done;
        expect(results).toEqual([expect.objectContaining({ success: false, persistence: "not_saved" })]);
    });

    it("a save the write check refuses: failure, nothing sent, persistence not_saved", async () => {
        const e = {
            id: "tx-u",
            uid: UID,
            action: "apply",
            stage: "eeprom",
            saved: "unknown",
            backupId: "bk",
            profiles: [0],
            detail: "",
            at: "2026-10-24T00:00:00Z",
        };
        localStorage.setItem(`${TRANSACTION_ENTRY_PREFIX}tx-u`, JSON.stringify(e));
        const { a, results } = autoRestore();
        await a._finishWithSave([]);
        expect(sentCli()).toEqual([]);
        expect(results).toEqual([expect.objectContaining({ success: false, persistence: "not_saved" })]);
    });

    it("a save still queued behind another command when the port closes was never sent: failure", async () => {
        const { a, results } = autoRestore();
        void cliSend("get p_roll", { timeoutMs: 3000 }).catch(() => undefined);
        const done = a._finishWithSave([]);
        await settle();
        a.handleDisconnect();
        await done;
        expect(sentCli()).toEqual(["get p_roll"]);
        expect(results).toEqual([expect.objectContaining({ success: false, persistence: "not_saved" })]);
    });
});

describe("WP8-F01 MSP CLI save (Presets, Backups): saveAndReconnect", () => {
    it("closed after the firmware's '# saving': confirmed, reconnect scheduled", async () => {
        const result = saveAndReconnect();
        await settle();
        feed(SAVE_OUTPUT);
        MSP.disconnect_cleanup();
        expect(await result).toEqual(expect.objectContaining({ ok: true, persistence: "confirmed" }));
        expect(reconnect.schedule).toHaveBeenCalledTimes(1);
    });

    it("closed after a delivered save without firmware output: not verified, not ok, and the user is told", async () => {
        const result = saveAndReconnect();
        await settle();
        MSP.disconnect_cleanup();
        expect(await result).toEqual(expect.objectContaining({ ok: false, persistence: "not_verified" }));
        expect(log.gui).toHaveBeenCalledWith("gyroflightCliSaveNotVerified");
    });

    it("a confirmed save tells the user nothing extra (the caller reports its success)", async () => {
        const result = saveAndReconnect();
        await settle();
        feed(SAVE_OUTPUT);
        MSP.disconnect_cleanup();
        expect((await result).ok).toBe(true);
        expect(log.gui).not.toHaveBeenCalled();
    });

    it("a save not taken whole by the transport is reported to the user", async () => {
        bytesFor = () => 0;
        await saveAndReconnect();
        expect(log.gui).toHaveBeenCalledWith("gyroflightRestoreSaveNotDelivered");
    });

    it("a save the transport did not take whole is not reported as accepted; the uncertain link is set up again", async () => {
        bytesFor = () => 0;
        const result = await saveAndReconnect();
        expect(result.ok).toBe(false);
        expect(result.persistence).toBe("unknown");
        expect(reconnect.schedule).toHaveBeenCalledTimes(1);
    });

    it("a delivered save that times out with '# saving' received (a link that survives the reset): confirmed", async () => {
        const result = saveAndReconnect();
        await settle();
        feed(SAVE_OUTPUT);
        await vi.advanceTimersByTimeAsync(6000);
        expect(await result).toEqual(expect.objectContaining({ ok: true, persistence: "confirmed" }));
    });

    it("a save drained from the queue by a disconnect was never sent: not accepted, no reboot awaited", async () => {
        void cliSend("get p_roll", { timeoutMs: 3000 }).catch(() => undefined);
        const result = saveAndReconnect();
        await settle();
        MSP.disconnect_cleanup();
        const r = await result;
        expect(r.ok).toBe(false);
        expect(r.persistence).toBe("not_saved");
        expect(reconnect.schedule).not.toHaveBeenCalled();
    });
});
