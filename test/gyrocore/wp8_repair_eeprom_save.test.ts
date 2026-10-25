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
 * Audit WP8-F04: the tabs' EEPROM saves (useReboot.saveAndReboot through
 * MSPHelper.writeConfiguration, useReboot.saveToEeprom) report "saved" only on the firmware's ACK of
 * MSP_EEPROM_WRITE. A disconnect between the SETs and the EEPROM request, the firmware's error reply,
 * a lost or corrupt answer, or a refused retry is an error that reaches the save's caller (useSaving
 * shows it), never "configurationEepromSaved" and never the reboot handoff.
 *
 * Production msp.ts (queue, retries, write check), MSPHelper (decoder, writeConfiguration),
 * useReboot and useSaving; the transport and serial_backend's reboot entry points are replaced.
 */

import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reboot = vi.hoisted(() => ({ reinit: vi.fn(), tabSwitch: vi.fn((cb: () => void) => cb()) }));
vi.mock("../../src/js/serial_backend", () => ({
    __esModule: true,
    reinitializeConnection: reboot.reinit,
    scheduleRebootReconnect: vi.fn(),
    cancelRebootReconnect: vi.fn(),
}));
vi.mock("../../src/js/tab_adapters", () => ({ tabSwitchCleanup: reboot.tabSwitch }));
const log = vi.hoisted(() => ({ gui: vi.fn() }));
vi.mock("../../src/js/gui_log", () => ({ gui_log: log.gui }));
// Each message is its key, so "the saved message was logged" cannot pass on an empty text.
vi.mock("../../src/js/localization", () => ({ i18n: { getMessage: (key: string) => key } }));

import MSP from "../../src/js/msp";
import MSPCodes from "../../src/js/msp/MSPCodes";
import { mspHelper } from "../../src/js/msp/MSPHelper";
import { serial } from "../../src/js/serial";
import { useConnectionStore } from "../../src/stores/connection";
import { useFlightControllerStore } from "../../src/stores/fc";
import { useReboot } from "../../src/composables/useReboot";
import { useSaving } from "../../src/composables/useSaving";
import { EepromSaveError } from "../../src/js/msp/eepromSave";
import { TRANSACTION_ENTRY_PREFIX } from "../../src/gyrocore/stores/fcTransactionState";
import { i18n } from "../../src/js/localization";

const UID: [number, number, number] = [7, 8, 9];
const protocol = { connected: true };
let sentCodes: number[];

/** An MSP v1 reply; `error` sends the firmware's error frame ('!'). */
function reply(code: number, { error = false, badCrc = false } = {}) {
    const checksum = 0 ^ code ^ (badCrc ? 0xff : 0);
    MSP.read({ data: new Uint8Array([0x24, 0x4d, error ? 0x21 : 0x3e, 0, code, checksum]).buffer });
}

const eepromLogged = () => log.gui.mock.calls.some(([text]) => text === "configurationEepromSaved");

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    vi.useFakeTimers();
    sentCodes = [];
    protocol.connected = true;
    (serial as unknown as { _protocol: unknown })._protocol = protocol;
    vi.spyOn(serial, "send").mockImplementation(async (data) => {
        const b = new Uint8Array(data as ArrayBuffer);
        if (b[0] === 0x24) sentCodes.push(b[1] === 0x4d ? b[4] : b[4] | (b[5] << 8));
        return { bytesSent: b.byteLength };
    });
    useConnectionStore().virtualMode = false;
    const fc = useFlightControllerStore();
    fc.config.uid = [...UID];
    fc.config.armingDisabled = true;
    MSP.callbacks = [];
    MSP.parked.clear();
    MSP.clearListeners();
    MSP.state = MSP.decoder_states.IDLE;
    MSP.message_direction = 1; // as after a firmware answer: no test inherits another's '<'
    MSP.listen(mspHelper.process_data.bind(mspHelper));
    reboot.reinit.mockClear();
    reboot.tabSwitch.mockClear();
    log.gui.mockClear();
});

afterEach(() => {
    MSP.callbacks_cleanup();
    MSP.clearListeners();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

async function outcome(p: Promise<unknown>) {
    return p.then(
        () => "resolved" as const,
        (e: unknown) => e,
    );
}

describe("WP8-F04 Save and Reboot (writeConfiguration): saved only on the firmware's ACK", () => {
    it("(harness) the 'saved' message this suite looks for is a real text", () => {
        expect(i18n.getMessage("configurationEepromSaved")).toBe("configurationEepromSaved");
    });

    it("ACK: resolves, logs saved, starts the reboot handoff", async () => {
        const done = outcome(useReboot().saveAndReboot());
        await vi.advanceTimersByTimeAsync(150);
        expect(sentCodes).toContain(MSPCodes.MSP_EEPROM_WRITE);
        reply(MSPCodes.MSP_EEPROM_WRITE);
        expect(await done).toBe("resolved");
        expect(eepromLogged()).toBe(true);
        expect(reboot.tabSwitch).toHaveBeenCalledTimes(1);
    });

    it("the link drops between the SETs and the EEPROM request: rejects not_saved, no saved log, no reboot", async () => {
        const done = outcome(useReboot().saveAndReboot());
        protocol.connected = false; // before the 100 ms delay ends
        await vi.advanceTimersByTimeAsync(150);
        const err = await done;
        expect(err).toBeInstanceOf(EepromSaveError);
        expect((err as EepromSaveError).persistence).toBe("not_saved");
        expect(sentCodes).not.toContain(MSPCodes.MSP_EEPROM_WRITE);
        expect(eepromLogged()).toBe(false);
        expect(reboot.tabSwitch).not.toHaveBeenCalled();
        expect(reboot.reinit).not.toHaveBeenCalled();
    });

    it("the firmware's error reply (armed): rejects not_saved, no reboot", async () => {
        const done = outcome(useReboot().saveAndReboot());
        await vi.advanceTimersByTimeAsync(150);
        reply(MSPCodes.MSP_EEPROM_WRITE, { error: true });
        const err = await done;
        expect((err as EepromSaveError).persistence).toBe("not_saved");
        expect(eepromLogged()).toBe(false);
        expect(reboot.tabSwitch).not.toHaveBeenCalled();
    });

    it("no answer at all: rejects unknown after the retries, never waits for good", async () => {
        const done = outcome(useReboot().saveAndReboot());
        await vi.advanceTimersByTimeAsync(150 + 5 * MSP.TIMEOUT);
        const err = await done;
        expect(err).toBeInstanceOf(EepromSaveError);
        expect((err as EepromSaveError).persistence).toBe("unknown");
        expect(reboot.tabSwitch).not.toHaveBeenCalled();
    });

    it("a corrupt answer: rejects unknown", async () => {
        const done = outcome(useReboot().saveAndReboot());
        await vi.advanceTimersByTimeAsync(150);
        reply(MSPCodes.MSP_EEPROM_WRITE, { badCrc: true });
        expect(((await done) as EepromSaveError).persistence).toBe("unknown");
    });

    it("its retry refused (the state turned uncertain after the first send): rejects unknown, nothing resent", async () => {
        const done = outcome(useReboot().saveAndReboot());
        await vi.advanceTimersByTimeAsync(150);
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
        await vi.advanceTimersByTimeAsync(5 * MSP.TIMEOUT);
        expect(((await done) as EepromSaveError).persistence).toBe("unknown");
        expect(sentCodes.filter((c) => c === MSPCodes.MSP_EEPROM_WRITE)).toHaveLength(1);
    });

    it("through useSaving (the tabs' Save button): the failure is shown, not swallowed as a cancellation", async () => {
        const { runSave, isSaving } = useSaving();
        const { saveAndReboot } = useReboot();
        const run = runSave(() => saveAndReboot());
        protocol.connected = false;
        await vi.advanceTimersByTimeAsync(150);
        await run;
        expect(isSaving.value).toBe(false);
        expect(log.gui).toHaveBeenCalled();
        expect(eepromLogged()).toBe(false);
    });
});

describe("Codex review of F04: what counts as the firmware's ACK", () => {
    it("an echo of the request ('$M<') is no ACK: no saved log, no reboot", async () => {
        const done = outcome(useReboot().saveAndReboot());
        await vi.advanceTimersByTimeAsync(150);
        const code = MSPCodes.MSP_EEPROM_WRITE;
        MSP.read({ data: new Uint8Array([0x24, 0x4d, 0x3c, 0, code, code]).buffer });
        await vi.advanceTimersByTimeAsync(10);
        expect(eepromLogged()).toBe(false);
        await vi.advanceTimersByTimeAsync(5 * MSP.TIMEOUT);
        expect(((await done) as EepromSaveError).persistence).toBe("unknown");
        expect(reboot.tabSwitch).not.toHaveBeenCalled();
    });

    // Codex review round 2.
    it("a frame with a direction byte the firmware never sends ('$M=') is no ACK", async () => {
        const done = outcome(useReboot().saveAndReboot());
        await vi.advanceTimersByTimeAsync(150);
        const code = MSPCodes.MSP_EEPROM_WRITE;
        MSP.read({ data: new Uint8Array([0x24, 0x4d, 0x3d, 0, code, code]).buffer });
        await vi.advanceTimersByTimeAsync(10);
        expect(eepromLogged()).toBe(false);
        await vi.advanceTimersByTimeAsync(5 * MSP.TIMEOUT);
        expect(((await done) as EepromSaveError).persistence).toBe("unknown");
    });

    it("a second save that joined a retried EEPROM request learns of the retry too (refusal: unknown)", async () => {
        const first = outcome(useReboot().saveToEeprom());
        await vi.advanceTimersByTimeAsync(MSP.TIMEOUT + 50); // the first attempt went unanswered, retried
        const second = outcome(useReboot().saveToEeprom()); // identical request: attaches, no new send
        await vi.advanceTimersByTimeAsync(10);
        reply(MSPCodes.MSP_EEPROM_WRITE, { error: true });
        expect(((await first) as EepromSaveError).persistence).toBe("unknown");
        expect(((await second) as EepromSaveError).persistence).toBe("unknown");
    });

    it("a refusal of a retry (the first attempt's answer lost) leaves persistence unknown, not 'not saved'", async () => {
        const done = outcome(useReboot().saveToEeprom());
        await vi.advanceTimersByTimeAsync(MSP.TIMEOUT + 50); // the first attempt went unanswered, a retry went out
        expect(sentCodes.filter((c) => c === MSPCodes.MSP_EEPROM_WRITE).length).toBeGreaterThan(1);
        reply(MSPCodes.MSP_EEPROM_WRITE, { error: true });
        expect(((await done) as EepromSaveError).persistence).toBe("unknown");
    });
});

describe("WP8-F04 saveToEeprom (PID, Receiver, Motors, ... tabs)", () => {
    it("ACK: resolves and logs saved", async () => {
        const done = outcome(useReboot().saveToEeprom());
        await vi.advanceTimersByTimeAsync(10);
        reply(MSPCodes.MSP_EEPROM_WRITE);
        expect(await done).toBe("resolved");
        expect(log.gui).toHaveBeenCalledWith(i18n.getMessage("configurationEepromSaved"));
    });

    it("the firmware's error reply: rejects, no saved log", async () => {
        const done = outcome(useReboot().saveToEeprom());
        await vi.advanceTimersByTimeAsync(10);
        reply(MSPCodes.MSP_EEPROM_WRITE, { error: true });
        const err = await done;
        expect((err as EepromSaveError).persistence).toBe("not_saved");
        expect(log.gui).not.toHaveBeenCalledWith(i18n.getMessage("configurationEepromSaved"));
    });

    it("the queue cleared under it (disconnect / tab switch after it went out): unknown, reported by useSaving", async () => {
        const { runSave } = useSaving();
        const run = runSave(() => useReboot().saveToEeprom());
        await vi.advanceTimersByTimeAsync(10);
        MSP.callbacks_cleanup();
        await run;
        expect(log.gui).toHaveBeenCalled();
        expect(log.gui).not.toHaveBeenCalledWith(i18n.getMessage("configurationEepromSaved"));
    });
});
