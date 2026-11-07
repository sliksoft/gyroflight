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
 * MSP parity of the absolute route: firmware-order encoder (written from msp.c) → the real
 * MSPHelper decoder → absoluteTune.valuesFromStore / valuesToStore → the real MSPHelper
 * encoder → firmware-order decoder must return every firmware-held value unchanged, on the
 * AIR65 values and on random in-range values, for MSP API 1.47 and 1.48. Fields the firmware
 * does not hold (deprecated slots) are covered by being absent from ABSOLUTE_FIELDS.
 */

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import MSPCodes from "../../src/js/msp/MSPCodes";
import { mspHelper } from "../../src/js/msp/MSPHelper";
import { MspDataView } from "../../src/js/msp/mspBytes";
import { useFlightControllerStore } from "../../src/stores/fc";
import {
    ABSOLUTE_FIELDS,
    fieldsForApi,
    valuesFromStore,
    valuesToStore,
    type StoreBlocks,
} from "../../src/gyrocore/tuning/absoluteTune";
import { air65FirmwareState, firmwareCodecs, firmwareDecoders, type FirmwareState } from "./harness/mspFirmware";

function deliver(code: number, bytes: number[]) {
    mspHelper.process_data({
        code,
        dataView: new MspDataView(Uint8Array.from(bytes).buffer),
        crcError: false,
        unsupported: 0,
        callbacks: [],
    });
}

function blocks(): StoreBlocks {
    const fc = useFlightControllerStore();
    return {
        pids: fc.pids,
        advancedTuning: fc.advancedTuning as unknown as Record<string, unknown>,
        filterConfig: fc.filterConfig as unknown as Record<string, unknown>,
    };
}

function readAll(s: FirmwareState, api: string) {
    useFlightControllerStore().config.apiVersion = api;
    deliver(MSPCodes.MSP_PID, firmwareCodecs.encodePid(s));
    deliver(MSPCodes.MSP_PID_ADVANCED, firmwareCodecs.encodePidAdvanced(s));
    deliver(MSPCodes.MSP_FILTER_CONFIG, firmwareCodecs.encodeFilterConfig(s, api));
    return valuesFromStore(blocks(), api);
}

function writeAll(target: FirmwareState) {
    firmwareDecoders.decodeSetPid(target, mspHelper.crunch(MSPCodes.MSP_SET_PID));
    firmwareDecoders.decodeSetPidAdvanced(target, mspHelper.crunch(MSPCodes.MSP_SET_PID_ADVANCED));
    return firmwareDecoders.decodeSetFilterConfig(target, mspHelper.crunch(MSPCodes.MSP_SET_FILTER_CONFIG));
}

/** Deterministic PRNG so a failure is reproducible. */
function rng(seed: number) {
    return () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 2 ** 32;
    };
}

function randomState(r: () => number): FirmwareState {
    const s = air65FirmwareState();
    const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
    s.pids = s.pids.map((row) => row.map(() => int(0, 250)));
    for (const f of ABSOLUTE_FIELDS) {
        if (f.group === "pid") continue;
        const fw = FW_NAME[f.key] ?? f.key;
        if (f.key.startsWith("rpm_filter_weights")) continue;
        s.p[fw] = int(Math.max(f.min, f.key === "auto_profile_cell_count" ? -1 : f.min), Math.min(f.max, 1000));
    }
    // gyro_lpf1_static_hz travels once as U8 first; the U16 copy after it wins. Keep it any value.
    s.rpmWeights = [int(0, 100), int(0, 100), int(0, 100)];
    // Keep the firmware's own post-write fix out of the comparison.
    if (s.p.gyro_lpf1_dyn_min_hz > s.p.gyro_lpf1_dyn_max_hz) s.p.gyro_lpf1_dyn_min_hz = 0;
    return s;
}

/** CLI name → harness firmware-state name where they differ. */
const FW_NAME: Record<string, string> = {
    rate_accel_limit: "rateAccelLimit",
    yaw_rate_accel_limit: "yawRateAccelLimit",
    gyro_notch1_hz: "gyro_soft_notch_hz_1",
    gyro_notch1_cutoff: "gyro_soft_notch_cutoff_1",
    gyro_notch2_hz: "gyro_soft_notch_hz_2",
    gyro_notch2_cutoff: "gyro_soft_notch_cutoff_2",
};

function expectSameFirmwareState(a: FirmwareState, b: FirmwareState, api: string) {
    expect(b.pids).toEqual(a.pids);
    for (const f of fieldsForApi(api)) {
        if (f.group === "pid" || f.key.startsWith("rpm_filter_weights")) continue;
        const fw = FW_NAME[f.key] ?? f.key;
        expect(b.p[fw], f.key).toBe(a.p[fw]);
    }
    if (api >= "1.48.0") expect(b.rpmWeights).toEqual(a.rpmWeights);
}

beforeEach(() => setActivePinia(createPinia()));

describe("absolute MSP round trip through the real MSPHelper codecs", () => {
    for (const api of ["1.47.0", "1.48.0"]) {
        it(`AIR65 values survive read → write unchanged (API ${api})`, () => {
            const fw = air65FirmwareState();
            const values = readAll(fw, api);
            expect(values.p_roll).toBe(56);
            expect(values.tpa_rate).toBe(60);
            expect(values.gyro_lpf1_static_hz).toBe(150);
            expect("rpm_filter_q" in values).toBe(api === "1.48.0");
            const target = air65FirmwareState();
            for (const k of Object.keys(target.p)) target.p[k] = 7; // anything: every field must be overwritten
            target.rpmWeights = [7, 7, 7];
            target.pids = target.pids.map(() => [7, 7, 7]);
            expect(writeAll(target)).toBe(true);
            if (api === "1.47.0") {
                // No RPM extension in the 1.47 payload: the firmware keeps what it had.
                target.p.rpm_filter_q = fw.p.rpm_filter_q;
                target.p.rpm_filter_fade_range_hz = fw.p.rpm_filter_fade_range_hz;
                target.rpmWeights = fw.rpmWeights;
            }
            expectSameFirmwareState(fw, target, api);
        });

        it(`random in-range values survive, and a changed field arrives alone (API ${api})`, () => {
            const r = rng(api === "1.48.0" ? 48 : 47);
            for (let trial = 0; trial < 25; trial++) {
                const fw = randomState(r);
                const values = readAll(fw, api);
                const target = structuredClone(fw);
                expect(writeAll(target)).toBe(true);
                expectSameFirmwareState(fw, target, api);
                // Change one proposable field through valuesToStore; only it moves.
                const proposable = fieldsForApi(api).filter((f) => f.proposable);
                const f = proposable[trial % proposable.length];
                const next = Math.min(
                    f.max,
                    Math.max(f.min, (values[f.key] ?? f.min) + 1 > f.max ? f.min : (values[f.key] ?? f.min) + 1),
                );
                valuesToStore({ ...values, [f.key]: next }, blocks(), api);
                const written = structuredClone(fw);
                writeAll(written);
                const back = readAll(written, api);
                expect(back[f.key], f.key).toBe(next);
                for (const k of Object.keys(values)) {
                    if (k !== f.key) expect(back[k], `${f.key} moved ${k}`).toBe(values[k]);
                }
            }
        });
    }

    it("tpa_rate is the firmware's raw U8 on both sides (MSPHelper keeps /100)", () => {
        const fw = air65FirmwareState();
        fw.p.tpa_rate = 33;
        const values = readAll(fw, "1.48.0");
        expect(values.tpa_rate).toBe(33);
        expect(useFlightControllerStore().advancedTuning.tpaRate).toBeCloseTo(0.33);
    });
});
