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

// The pure parts of Apply: identity against a real AIR65 header, the expected
// snapshot after a write, the single-use confirmation, and the backup store.

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { identityBlocks, logIdentity, parseDeviceUid, type FcIdentity } from "../../src/gyrocore/tuning/fcIdentity";
import {
    expectedAfterWrite,
    snapshotMismatches,
    sliderAxes,
    type TuneSnapshot,
} from "../../src/gyrocore/tuning/tuneSnapshot";
import {
    consumeConfirmation,
    issueConfirmation,
    resetConfirmations,
} from "../../src/gyrocore/tuning/applyConfirmation";
import { BACKUPS_PER_CRAFT, useTuneBackupStore, type TuneBackup } from "../../src/gyrocore/stores/tuneBackup";

// BTFL_BLACKBOX_LOG_AIR65_C_20261018_231421_BETAFPVG473.BBL, verbatim.
const AIR65_HEADERS: [string, string][] = [
    ["Firmware type", "Betaflight"],
    ["Firmware revision", "Betaflight 2026.6.2 (43875a55a) STM32G474"],
    ["DeviceUID", "0a1b2c3d4e5f607112233445"],
    ["Board information", "BEFH BETAFPVG473"],
    ["Craft name", "AIR65 C"],
];
const AIR65_FC: FcIdentity = {
    uid: [0x0a1b2c3d, 0x4e5f6071, 0x12233445],
    manufacturerId: "BEFH",
    boardName: "BETAFPVG473",
    variant: "BTFL",
    version: "2026.6.2",
    apiVersion: "1.48.0",
    armed: false,
    pidProfile: 0,
    pidProfileCount: 4,
};

describe("FC identity", () => {
    it("reads DeviceUID as MSP_UID's three words", () => {
        expect(parseDeviceUid("0a1b2c3d4e5f607112233445")).toEqual([0x0a1b2c3d, 0x4e5f6071, 0x12233445]);
        expect(parseDeviceUid("xyz")).toBeNull();
        expect(parseDeviceUid(undefined)).toBeNull();
    });

    it("the AIR65 log and its own FC match", () => {
        expect(identityBlocks(logIdentity(AIR65_HEADERS), AIR65_FC)).toEqual([]);
    });

    it("2026.6.2 is not 2026.6.20, and a log from older firmware does not match", () => {
        expect(identityBlocks(logIdentity(AIR65_HEADERS), { ...AIR65_FC, version: "2026.6" })).toEqual([
            "fc:identity_firmware_mismatch",
        ]);
        const older = AIR65_HEADERS.map(([k, v]) =>
            k === "Firmware revision" ? ([k, "Betaflight 2026.6.20 (abc) STM32G474"] as [string, string]) : [k, v],
        ) as [string, string][];
        expect(identityBlocks(logIdentity(older), AIR65_FC)).toEqual(["fc:identity_firmware_mismatch"]);
    });
});

describe("expected snapshot after a write", () => {
    const before: TuneSnapshot = {
        sliders: { slider_pids_mode: 1, slider_pi_gain: 100, slider_dterm_filter_multiplier: 100 },
        filters: { dterm_lowpass_hz: 75, gyro_lowpass_hz: 250 },
        pids: [
            [45, 80, 30],
            [47, 84, 34],
            [52, 90, 6],
        ],
        advanced: { feedforwardRoll: 120, feedforwardYaw: 100 },
    };

    it("takes the slider-driven axes from the firmware and keeps the rest", () => {
        expect(sliderAxes(0)).toEqual([]);
        expect(sliderAxes(1)).toEqual(["roll", "pitch"]);
        expect(sliderAxes(2)).toEqual(["roll", "pitch", "yaw"]);
        const out = expectedAfterWrite(
            before,
            { slider_pi_gain: 110, slider_dterm_filter_multiplier: 110 },
            {
                pids: { roll: [50, 88, 30], pitch: [52, 92, 34], yaw: [1, 1, 1] },
                advanced: { feedforwardRoll: 132, feedforwardYaw: 999 },
                dtermFilters: {
                    dterm_lowpass_hz: 83,
                    dterm_lowpass2_hz: 165,
                    dterm_lowpass_dyn_min_hz: 83,
                    dterm_lowpass_dyn_max_hz: 165,
                },
            },
        );
        expect(out.sliders.slider_pi_gain).toBe(110);
        expect(out.pids).toEqual([
            [50, 88, 30],
            [52, 92, 34],
            [52, 90, 6],
        ]);
        expect(out.advanced).toEqual({ feedforwardRoll: 132, feedforwardYaw: 100 });
        expect(out.filters).toEqual({
            dterm_lowpass_hz: 83,
            dterm_lowpass2_hz: 165,
            dterm_lowpass_dyn_min_hz: 83,
            dterm_lowpass_dyn_max_hz: 165,
            gyro_lowpass_hz: 250,
        });
        expect(snapshotMismatches(out, out)).toEqual([]);
        expect(
            snapshotMismatches(out, {
                ...out,
                pids: [
                    [50, 88, 30],
                    [52, 92, 35],
                    [52, 90, 6],
                ],
            }),
        ).toEqual(["pid:pitch:D expected 34 read 35"]);
    });
});

describe("confirmation tokens", () => {
    beforeEach(() => resetConfirmations());

    it("bind the exact sliders, regardless of key order", () => {
        const t = issueConfirmation({ kind: "apply", compositeId: "c", sliders: { a: 1, b: 2 }, preview: "h" });
        expect(() =>
            consumeConfirmation(t, { kind: "apply", compositeId: "c", sliders: { b: 2, a: 1 } }),
        ).not.toThrow();
        const u = issueConfirmation({ kind: "apply", compositeId: "c", sliders: { a: 1 }, preview: "h" });
        expect(() => consumeConfirmation(u, { kind: "apply", compositeId: "c", sliders: { a: 1, b: 2 } })).toThrow(
            /confirmation_mismatch/,
        );
    });
});

describe("backup store", () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        localStorage.clear();
    });

    const backup = (id: string, uid: [number, number, number]): TuneBackup => ({
        id,
        createdAt: "2026-10-21T00:00:00.000Z",
        reason: "before_apply",
        uid,
        board: "B",
        firmware: "2026.6.2",
        compositeId: null,
        snapshot: { sliders: {}, filters: {}, pids: [], advanced: {} },
    });

    it("keeps the newest backups per craft and survives a reload", () => {
        const store = useTuneBackupStore();
        for (let i = 0; i < BACKUPS_PER_CRAFT + 3; i++) {
            expect(store.save(backup(`a${i}`, [1, 2, 3]))).toBe(true);
        }
        expect(store.save(backup("other", [4, 5, 6]))).toBe(true);
        expect(store.forUid([1, 2, 3])).toHaveLength(BACKUPS_PER_CRAFT);
        expect(store.forUid([1, 2, 3])[0].id).toBe(`a${BACKUPS_PER_CRAFT + 2}`);
        setActivePinia(createPinia());
        expect(
            useTuneBackupStore()
                .forUid([4, 5, 6])
                .map((b) => b.id),
        ).toEqual(["other"]);
        expect(useTuneBackupStore().get("a0")).toBeNull();
    });
});
