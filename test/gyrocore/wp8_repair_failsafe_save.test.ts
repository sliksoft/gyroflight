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
 * Audit WP8-F05/F06: the Failsafe tab's Save through the production chain (useFailsafeSave, useSaving,
 * MSPHelper.sendRxFailConfig, msp.ts with its retries and write check, useReboot,
 * writeConfiguration). Only the transport is a fake that answers each request with the firmware's
 * ACK unless a test withholds it, and serial_backend's reboot entry points are spies.
 *
 * F05: whatever happens to an RXFAIL write (no answer, its retry refused, a refusal between two
 * channels) the save ends (isSaving false) with an error, and no EEPROM save follows.
 * F06: the tab's clean baseline (initializeDefaults) is reset only after the firmware acknowledged
 * the EEPROM save; a failed or unconfirmed save leaves the changes pending, so Save stays enabled.
 */

import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({ reinit: vi.fn(), tabSwitch: vi.fn((cb: () => void) => cb()) }));
vi.mock("../../src/js/serial_backend", () => ({
    __esModule: true,
    reinitializeConnection: backend.reinit,
    scheduleRebootReconnect: vi.fn(),
    cancelRebootReconnect: vi.fn(),
}));
vi.mock("../../src/js/tab_adapters", () => ({ tabSwitchCleanup: backend.tabSwitch }));
const log = vi.hoisted(() => ({ gui: vi.fn() }));
vi.mock("../../src/js/gui_log", () => ({ gui_log: log.gui }));
vi.mock("../../src/js/localization", () => ({ i18n: { getMessage: (key: string) => key } }));

import MSP from "../../src/js/msp";
import MSPCodes from "../../src/js/msp/MSPCodes";
import { mspHelper } from "../../src/js/msp/MSPHelper";
import { serial } from "../../src/js/serial";
import { useConnectionStore } from "../../src/stores/connection";
import { useFlightControllerStore } from "../../src/stores/fc";
import { useFailsafeSave } from "../../src/composables/failsafe/useFailsafeSave";
import { TRANSACTION_ENTRY_PREFIX } from "../../src/gyrocore/stores/fcTransactionState";
import Features from "../../src/js/Features";

const UID: [number, number, number] = [4, 5, 6];
let frames: Array<{ code: number; payload: number[] }>;
/** Whether the fake firmware answers this request; by default it acknowledges everything. */
let answers: (code: number, nth: number) => "ack" | "error" | "none";

function replyFrame(code: number, error: boolean) {
    MSP.read({ data: new Uint8Array([0x24, 0x4d, error ? 0x21 : 0x3e, 0, code, code]).buffer });
}

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

const rxfailFrames = () => frames.filter((f) => f.code === MSPCodes.MSP_SET_RXFAIL_CONFIG);
const codes = () => frames.map((f) => f.code);

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    vi.useFakeTimers();
    frames = [];
    answers = () => "ack";
    (serial as unknown as { _protocol: unknown })._protocol = { connected: true };
    vi.spyOn(serial, "send").mockImplementation(async (data) => {
        const b = Array.from(new Uint8Array(data as ArrayBuffer));
        if (b[0] === 0x24 && b[1] === 0x4d) {
            const code = b[4];
            frames.push({ code, payload: b.slice(5, 5 + b[3]) });
            const answer = answers(code, frames.filter((f) => f.code === code).length);
            if (answer !== "none") setTimeout(() => replyFrame(code, answer === "error"), 5);
        }
        return { bytesSent: b.length };
    });
    useConnectionStore().virtualMode = false;
    const fc = useFlightControllerStore();
    fc.config.uid = [...UID];
    fc.config.apiVersion = "1.40.0"; // no GPS rescue section
    fc.config.armingDisabled = true;
    fc.features.features = new Features(fc.config);
    fc.rxFailConfig = [
        { mode: 0, value: 1500 },
        { mode: 1, value: 1000 },
    ] as never;
    MSP.callbacks = [];
    MSP.parked.clear();
    MSP.clearListeners();
    MSP.state = MSP.decoder_states.IDLE;
    MSP.listen(mspHelper.process_data.bind(mspHelper));
    backend.reinit.mockClear();
    backend.tabSwitch.mockClear();
    log.gui.mockClear();
    vi.spyOn(console, "error").mockImplementation(
        (...a) => process.env.DBG && process.stdout.write(`ERR ${a.map(String).join(" ")}\n`),
    );
});

afterEach(() => {
    MSP.callbacks_cleanup();
    MSP.clearListeners();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

function failsafeSave() {
    // `defaults` is what makes the values sent the tab's clean baseline (useFailsafeSave captureBaseline).
    const defaults = vi.fn();
    const { saveConfig, isSaving } = useFailsafeSave(() => defaults);
    const done = saveConfig();
    return { defaults, isSaving, done };
}

describe("WP8-F05 the RXFAIL writes end the Failsafe save, whatever happens to them", () => {
    it("control: every section, both RXFAIL channels in order, then the EEPROM save; reboot after its ACK", async () => {
        const { defaults, isSaving, done } = failsafeSave();
        await vi.advanceTimersByTimeAsync(2000);
        await done;
        expect(codes()).toEqual([
            MSPCodes.MSP_SET_RX_CONFIG,
            MSPCodes.MSP_SET_FAILSAFE_CONFIG,
            MSPCodes.MSP_SET_RXFAIL_CONFIG,
            MSPCodes.MSP_SET_RXFAIL_CONFIG,
            MSPCodes.MSP_SET_FEATURE_CONFIG,
            MSPCodes.MSP_EEPROM_WRITE,
        ]);
        expect(rxfailFrames().map((f) => f.payload.slice(0, 2))).toEqual([
            [0, 0],
            [1, 1],
        ]);
        expect(isSaving.value).toBe(false);
        expect(defaults).toHaveBeenCalledTimes(1);
        expect(backend.tabSwitch).toHaveBeenCalledTimes(1);
    });

    it("the first RXFAIL write is never answered: the save ends with an error after the retries, nothing more is sent", async () => {
        answers = (code) => (code === MSPCodes.MSP_SET_RXFAIL_CONFIG ? "none" : "ack");
        const { defaults, isSaving, done } = failsafeSave();
        await vi.advanceTimersByTimeAsync(10_000);
        await done;
        expect(isSaving.value).toBe(false);
        expect(defaults).not.toHaveBeenCalled();
        expect(codes()).not.toContain(MSPCodes.MSP_EEPROM_WRITE);
        expect(rxfailFrames().every((f) => f.payload[0] === 0)).toBe(true);
        expect(log.gui).toHaveBeenCalled();
    });

    it("the first RXFAIL went out, its answer is lost and the state turns uncertain: the retry is refused and the save ends", async () => {
        answers = (code) => (code === MSPCodes.MSP_SET_RXFAIL_CONFIG ? "none" : "ack");
        const { defaults, isSaving, done } = failsafeSave();
        await vi.advanceTimersByTimeAsync(100);
        expect(rxfailFrames()).toHaveLength(1);
        uncertain();
        await vi.advanceTimersByTimeAsync(10_000);
        await done;
        expect(rxfailFrames()).toHaveLength(1);
        expect(isSaving.value).toBe(false);
        expect(defaults).not.toHaveBeenCalled();
        expect(codes()).not.toContain(MSPCodes.MSP_EEPROM_WRITE);
        expect(log.gui).toHaveBeenCalled();
    });

    it("refused between the two channels: the second is not sent and the save ends, no EEPROM save", async () => {
        answers = (code, nth) => {
            if (code === MSPCodes.MSP_SET_RXFAIL_CONFIG && nth === 1) uncertain();
            return "ack";
        };
        const { defaults, isSaving, done } = failsafeSave();
        await vi.advanceTimersByTimeAsync(10_000);
        await done;
        expect(rxfailFrames()).toHaveLength(1);
        expect(isSaving.value).toBe(false);
        expect(defaults).not.toHaveBeenCalled();
        expect(codes()).not.toContain(MSPCodes.MSP_EEPROM_WRITE);
    });
});

describe("Codex review of F05/F06", () => {
    it("the firmware refuses an RXFAIL channel (error answer): the save ends, no EEPROM save, still dirty", async () => {
        answers = (code) => (code === MSPCodes.MSP_SET_RXFAIL_CONFIG ? "error" : "ack");
        const { defaults, isSaving, done } = failsafeSave();
        await vi.advanceTimersByTimeAsync(5000);
        await done;
        expect(rxfailFrames()).toHaveLength(1);
        expect(codes()).not.toContain(MSPCodes.MSP_EEPROM_WRITE);
        expect(defaults).not.toHaveBeenCalled();
        expect(isSaving.value).toBe(false);
        expect(log.gui).toHaveBeenCalled();
    });

    it("the firmware refuses the failsafe section (error answer): the save ends before RXFAIL", async () => {
        answers = (code) => (code === MSPCodes.MSP_SET_FAILSAFE_CONFIG ? "error" : "ack");
        const { defaults, done } = failsafeSave();
        await vi.advanceTimersByTimeAsync(5000);
        await done;
        expect(rxfailFrames()).toHaveLength(0);
        expect(codes()).not.toContain(MSPCodes.MSP_EEPROM_WRITE);
        expect(defaults).not.toHaveBeenCalled();
    });

    it("cut short after a write went out (the queue cleared, a tab switch): the user is told, nothing is saved", async () => {
        answers = (code) => (code === MSPCodes.MSP_SET_RXFAIL_CONFIG ? "none" : "ack");
        const { defaults, isSaving, done } = failsafeSave();
        await vi.advanceTimersByTimeAsync(100);
        expect(rxfailFrames()).toHaveLength(1);
        MSP.callbacks_cleanup();
        await vi.advanceTimersByTimeAsync(100);
        await done;
        expect(isSaving.value).toBe(false);
        expect(defaults).not.toHaveBeenCalled();
        expect(log.gui).toHaveBeenCalledWith("gyroflightSaveInterrupted");
    });

    it("sends what the store held when the save started, even when it is edited during the save", async () => {
        const fc = useFlightControllerStore();
        const sentFailsafe = () => frames.find((f) => f.code === MSPCodes.MSP_SET_FAILSAFE_CONFIG)?.payload;
        const delay0 = fc.failsafeConfig.failsafe_delay;
        answers = (code) => {
            // Edited while the first section is on its way.
            if (code === MSPCodes.MSP_SET_RX_CONFIG) fc.failsafeConfig.failsafe_delay = delay0 + 7;
            return "ack";
        };
        const { done } = failsafeSave();
        await vi.advanceTimersByTimeAsync(5000);
        await done;
        expect(sentFailsafe()?.[0]).toBe(delay0 & 0xff);
    });
});

describe("WP8-F06 the Failsafe tab stays dirty until the EEPROM save is confirmed", () => {
    it("every SET acknowledged, the EEPROM save refused by the firmware: changes stay pending, no reboot", async () => {
        answers = (code) => (code === MSPCodes.MSP_EEPROM_WRITE ? "error" : "ack");
        const { defaults, isSaving, done } = failsafeSave();
        await vi.advanceTimersByTimeAsync(5000);
        await done;
        expect(codes()).toContain(MSPCodes.MSP_EEPROM_WRITE);
        expect(defaults).not.toHaveBeenCalled();
        expect(isSaving.value).toBe(false);
        expect(backend.tabSwitch).not.toHaveBeenCalled();
        expect(log.gui).toHaveBeenCalledWith("gyroflightEepromNotConfirmed");
    });

    it("every SET acknowledged, the EEPROM save never answered: changes stay pending", async () => {
        answers = (code) => (code === MSPCodes.MSP_EEPROM_WRITE ? "none" : "ack");
        const { defaults, done } = failsafeSave();
        await vi.advanceTimersByTimeAsync(10_000);
        await done;
        expect(defaults).not.toHaveBeenCalled();
    });

    it("the state turns uncertain right before the EEPROM save: refused, changes stay pending", async () => {
        answers = (code) => {
            if (code === MSPCodes.MSP_SET_FEATURE_CONFIG) uncertain();
            return "ack";
        };
        const { defaults, done } = failsafeSave();
        await vi.advanceTimersByTimeAsync(5000);
        await done;
        expect(codes()).not.toContain(MSPCodes.MSP_EEPROM_WRITE);
        expect(defaults).not.toHaveBeenCalled();
    });
});
