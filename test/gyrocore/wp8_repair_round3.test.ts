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
 * Codex review round 3 (WP8): the legacy Ports save (a callback chain) stops on a refused or
 * unanswered SET before the EEPROM save; an EEPROM answer that comes after the earlier waiter gave up
 * still counts that waiter's transmissions; a WebSocket transport that still buffers bytes keeps
 * the page busy. Production usePortsConfiguration, msp.ts, MSPHelper and the serial facade; the
 * transport is a fake answering like the firmware, useReboot's save is a spy.
 */

import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reboot = vi.hoisted(() => ({ saveAndReboot: vi.fn(async () => undefined) }));
vi.mock("../../src/composables/useReboot", () => ({
    useReboot: () => ({ saveAndReboot: reboot.saveAndReboot, saveToEeprom: vi.fn(), reboot: vi.fn() }),
}));
const log = vi.hoisted(() => ({ gui: vi.fn() }));
vi.mock("../../src/js/gui_log", () => ({ gui_log: log.gui }));
vi.mock("../../src/js/localization", () => ({ i18n: { getMessage: (key: string) => key } }));

import MSP from "../../src/js/msp";
import MSPCodes from "../../src/js/msp/MSPCodes";
import { mspHelper } from "../../src/js/msp/MSPHelper";
import { serial } from "../../src/js/serial";
import Features from "../../src/js/Features";
import { useConnectionStore } from "../../src/stores/connection";
import { useFlightControllerStore } from "../../src/stores/fc";
import { usePortsConfiguration } from "../../src/composables/ports/usePortsConfiguration";
import { saveEeprom, EepromSaveError } from "../../src/js/msp/eepromSave";

let answers: (code: number) => "ack" | "error" | "none";
let protocol: { connected: boolean; send: (d: ArrayBuffer) => Promise<{ bytesSent: number }>; bufferedAmount?: number };

/** A firmware answer (v1 or v2 framing, matching the request). */
function answer(code: number, error: boolean) {
    if (code <= 254) {
        MSP.read({ data: new Uint8Array([0x24, 0x4d, error ? 0x21 : 0x3e, 0, code, code]).buffer });
        return;
    }
    const body = [0, code & 0xff, code >> 8, 0, 0];
    const crc = MSP.crc8_dvb_s2_data(body, 0, body.length);
    MSP.read({ data: new Uint8Array([0x24, 0x58, error ? 0x21 : 0x3e, ...body, crc]).buffer });
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    vi.useFakeTimers();
    answers = () => "ack";
    protocol = {
        connected: true,
        send: async (d) => {
            const b = new Uint8Array(d);
            const code = b[1] === 0x4d ? b[4] : b[4] | (b[5] << 8);
            const a = answers(code);
            if (a !== "none") setTimeout(() => answer(code, a === "error"), 5);
            return { bytesSent: b.byteLength };
        },
    };
    (serial as unknown as { _protocol: unknown })._protocol = protocol;
    useConnectionStore().virtualMode = false;
    const fc = useFlightControllerStore();
    fc.config.uid = [1, 1, 1];
    fc.config.apiVersion = "1.47.0";
    fc.features.features = new Features(fc.config);
    MSP.callbacks = [];
    MSP.parked.clear();
    MSP.clearListeners();
    MSP.state = MSP.decoder_states.IDLE;
    MSP.message_direction = 1;
    MSP.listen(mspHelper.process_data.bind(mspHelper));
    reboot.saveAndReboot.mockClear();
    log.gui.mockClear();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
    MSP.callbacks_cleanup();
    MSP.clearListeners();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("legacy Ports save: no EEPROM save after a refused or unanswered SET", () => {
    const save = async () => {
        usePortsConfiguration([], {}, []).saveConfig();
        await vi.advanceTimersByTimeAsync(10_000);
    };

    it("control: both SETs acknowledged: the save goes on to EEPROM", async () => {
        await save();
        expect(reboot.saveAndReboot).toHaveBeenCalledTimes(1);
    });

    it("the serial config refused by the firmware: no EEPROM save, the failure is shown", async () => {
        answers = (code) => (code === MSPCodes.MSP2_COMMON_SET_SERIAL_CONFIG ? "error" : "ack");
        await save();
        expect(reboot.saveAndReboot).not.toHaveBeenCalled();
        expect(log.gui).toHaveBeenCalledWith("configurationSaveFailed");
    });

    it("the feature config refused by the firmware: no EEPROM save", async () => {
        answers = (code) => (code === MSPCodes.MSP_SET_FEATURE_CONFIG ? "error" : "ack");
        await save();
        expect(reboot.saveAndReboot).not.toHaveBeenCalled();
    });

    it("the link down (the legacy callback runs without an answer): no EEPROM save", async () => {
        protocol.connected = false;
        await save();
        expect(reboot.saveAndReboot).not.toHaveBeenCalled();
    });
});

describe("an EEPROM answer after the earlier waiter gave up still counts its transmissions", () => {
    it("waiter B joined A's retried request; A exhausted; a refusal then reaches B: unknown, not 'not saved'", async () => {
        answers = () => "none";
        const a = saveEeprom().catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(2.5 * MSP.TIMEOUT); // A went out and was retried
        const b = saveEeprom().catch((e: unknown) => e); // identical request: attaches
        await vi.advanceTimersByTimeAsync(0.6 * MSP.TIMEOUT); // A gives up and is removed
        expect(await a).toBeInstanceOf(EepromSaveError);
        answer(MSPCodes.MSP_EEPROM_WRITE, true);
        const err = await b;
        expect((err as EepromSaveError).persistence).toBe("unknown");
    });
});

describe("a transport that resolves before its bytes are out keeps the page busy", () => {
    it("a WebSocket with bytes still buffered counts as a send in progress", () => {
        protocol.bufferedAmount = 12;
        expect(serial.pendingSends).toBeGreaterThan(0);
        protocol.bufferedAmount = 0;
        expect(serial.pendingSends).toBe(0);
    });
});
