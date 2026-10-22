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
 * Codex review P2-02: a CRC-valid but short reply must never pass as a complete live
 * configuration. The decoders turn a missing field into null (Number(null) → 0), into a real
 * 0 (tpa_rate = null / 100), or leave the previous value in the store (MSP_PID rows beyond the
 * payload, the 1.48 RPM block behind a remaining() guard). The route must refuse all three,
 * before any write, in Preview, Apply and Restore. The payload sizes below are counted from
 * Betaflight 2026.6.2 msp.c (the harness encoders follow it byte for byte).
 */

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FirmwareFc } from "./harness/mspFirmware";

const route = vi.hoisted(() => ({ fc: undefined as unknown as FirmwareFc }));
vi.mock("../../src/js/msp", () => ({
    default: {
        promise: vi.fn(async (code: number, data?: number[]) =>
            (await import("./harness/mspFirmware")).firmwarePromise(route.fc, code, data),
        ),
    },
}));
vi.mock("@/gyrocore/releaseGate/releaseContract", async () => ({
    ...(await vi.importActual<typeof import("../../src/gyrocore/releaseGate/releaseContract")>(
        "@/gyrocore/releaseGate/releaseContract",
    )),
    assertAbsoluteReleased: () => undefined,
}));

import MSPCodes from "../../src/js/msp/MSPCodes";
import {
    applyAbsoluteTune,
    previewAbsoluteRestore,
    previewAbsoluteTune,
    restoreAbsoluteTune,
} from "../../src/composables/useTuneApply";
import { ApplyBlockedError } from "../../src/gyrocore/chirp/applyGate";
import { issueConfirmation, resetConfirmations } from "../../src/gyrocore/tuning/applyConfirmation";
import {
    absoluteSnapshotIssues,
    changeSetIssues,
    valuesFromStore,
    type AbsoluteSnapshot,
} from "../../src/gyrocore/tuning/absoluteTune";
import type { AbsoluteProposal } from "../../src/gyrocore/releaseGate/releaseContract";
import {
    air65FirmwareState,
    createFirmwareFc,
    FIRMWARE_WRITE_CODES,
    firmwareCodecs,
    type FirmwareState,
} from "./harness/mspFirmware";

function headersFor(s: FirmwareState): [string, string][] {
    return [
        ["Firmware revision", "Betaflight 2026.6.2 (43875a55a) STM32G474"],
        ["Board information", "BEFH BETAFPVG473"],
        ["DeviceUID", "0a1b2c3d4e5f607112233445"],
        ["rollPID", s.pids[0].join(",")],
        ["pitchPID", s.pids[1].join(",")],
        ["yawPID", s.pids[2].join(",")],
    ];
}

function proposal(): AbsoluteProposal {
    return {
        id: "short-reply",
        createdAt: "2026-10-22T00:00:00Z",
        log: { sha256: "a".repeat(64), logIndex: 0, headerPairs: headersFor(air65FirmwareState()) },
        change: { p_roll: 60 },
        items: [],
        release: {
            measurement: { valid: true, reasons: [] },
            model: { status: "VALIDATED", reasons: [] },
            margins: [],
            independentValidation: null,
            safetyAnalysisEvidence: "available",
            safetyReasons: [],
        },
    };
}

const writes = () => route.fc.calls.map((c) => c.code).filter((c) => FIRMWARE_WRITE_CODES.has(c));
const failure = (p: Promise<unknown>) =>
    p.then(
        () => null,
        (e: unknown) => e,
    );

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    resetConfirmations();
    route.fc = createFirmwareFc();
});

describe("P2-02: firmware reply sizes (API 1.48, 2026.6.2)", () => {
    it("the encoders produce the sizes the route requires", () => {
        const s = air65FirmwareState();
        expect(firmwareCodecs.encodePid(s)).toHaveLength(15);
        expect(firmwareCodecs.encodePidAdvanced(s)).toHaveLength(61);
        expect(firmwareCodecs.encodeFilterConfig(s, "1.47.0")).toHaveLength(49);
        expect(firmwareCodecs.encodeFilterConfig(s, "1.48.0")).toHaveLength(56);
        expect(firmwareCodecs.encodeSimplified(s)).toHaveLength(53);
    });
});

describe("P2-02: missing values are refused, never read as 0", () => {
    it("review probe: a null advanced / filter field is an incomplete snapshot", () => {
        const blocks = {
            pids: [
                [56, 79, 30],
                [82, 117, 61],
                [56, 79, 0],
            ],
            advancedTuning: { dMaxRoll: null, tpaRate: null } as Record<string, unknown>,
            filterConfig: { gyro_lowpass_hz: null } as Record<string, unknown>,
        };
        const values = valuesFromStore(blocks, "1.48.0");
        expect(Number.isNaN(values.d_max_roll)).toBe(true);
        expect(Number.isNaN(values.tpa_rate)).toBe(true);
        expect(Number.isNaN(values.gyro_lpf1_static_hz)).toBe(true);
        const snap: AbsoluteSnapshot = {
            apiVersion: "1.48.0",
            sliders: { slider_pids_mode: 0, slider_dterm_filter: 0, slider_gyro_filter: 0 },
            values,
        };
        expect(absoluteSnapshotIssues(snap)).toEqual(
            expect.arrayContaining(["value:d_max_roll", "value:tpa_rate", "value:gyro_lpf1_static_hz"]),
        );
        expect(changeSetIssues({ p_roll: 60 }, values, "1.48.0")).toContain("absolute:snapshot_incomplete");
    });
});

const SHORT: [string, number, number, string][] = [
    // [name, code, bytes dropped, how the old decoder hid it]
    ["MSP_PID (rows 3-4 left stale)", MSPCodes.MSP_PID, 6, "stale"],
    ["MSP_PID_ADVANCED (tpa_rate read as 0)", MSPCodes.MSP_PID_ADVANCED, 4, "zero"],
    ["MSP_FILTER_CONFIG (1.48 RPM block left stale)", MSPCodes.MSP_FILTER_CONFIG, 7, "stale"],
    ["MSP_SIMPLIFIED_TUNING (gyro sliders null)", MSPCodes.MSP_SIMPLIFIED_TUNING, 18, "null"],
];

describe("P2-02: CRC-valid short replies stop Preview, Apply and Restore before any write", () => {
    for (const [name, code, drop] of SHORT) {
        it(`Preview / Apply: ${name}`, async () => {
            route.fc.truncate[code] = drop;
            const p = proposal();
            const e1 = (await failure(previewAbsoluteTune(p))) as ApplyBlockedError;
            expect(e1).toBeInstanceOf(ApplyBlockedError);
            expect(e1.reasons.some((r) => r.startsWith("fc:reply_too_short:"))).toBe(true);
            const token = issueConfirmation({ kind: "absolute", proposalId: p.id, change: { ...p.change } });
            const e2 = (await failure(applyAbsoluteTune(p, token))) as ApplyBlockedError;
            expect(e2).toBeInstanceOf(ApplyBlockedError);
            expect(writes()).toEqual([]);
        });

        it(`Restore: ${name}`, async () => {
            const p = proposal();
            const pv = await previewAbsoluteTune(p);
            const res = await applyAbsoluteTune(
                p,
                issueConfirmation({ kind: "absolute", proposalId: p.id, change: { ...p.change }, preview: pv.hash }),
            );
            const before = writes().length;
            route.fc.truncate[code] = drop;
            const e = (await failure(previewAbsoluteRestore(res.backupId))) as ApplyBlockedError;
            expect(e).toBeInstanceOf(ApplyBlockedError);
            const e2 = (await failure(
                restoreAbsoluteTune(res.backupId, issueConfirmation({ kind: "restore", backupId: res.backupId })),
            )) as ApplyBlockedError;
            expect(e2).toBeInstanceOf(ApplyBlockedError);
            expect(writes().length).toBe(before);
        });
    }

    it("a short reply to a fresh read inside the write sequence stops the next write", async () => {
        const p = proposal();
        const pv = await previewAbsoluteTune(p);
        // The route reads MSP_PID once in the snapshot, then again right before MSP_SET_PID.
        let reads = 0;
        const orig = route.fc.truncate;
        route.fc.truncate = new Proxy(orig, {
            get: (t, k) => (Number(k) === MSPCodes.MSP_PID && ++reads > 1 ? 6 : Reflect.get(t, k)),
        });
        const e = await failure(
            applyAbsoluteTune(
                p,
                issueConfirmation({ kind: "absolute", proposalId: p.id, change: { ...p.change }, preview: pv.hash }),
            ),
        );
        expect(e).toBeTruthy();
        expect(writes()).not.toContain(MSPCodes.MSP_SET_PID);
        expect(writes()).not.toContain(MSPCodes.MSP_EEPROM_WRITE);
    });
});
