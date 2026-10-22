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
 * The v2 absolute route (useTuneApply: previewAbsoluteTune / applyAbsoluteTune /
 * restoreAbsoluteTune) against a byte-level Betaflight 2026.6.2 simulation
 * (harness/mspFirmware.ts). The release contract is released by `route.release` so the
 * route behind it is reachable; one block runs the real contract and shows it stops
 * everything before any MSP. Each case states what reaches the craft.
 */

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FirmwareFc } from "./harness/mspFirmware";

const route = vi.hoisted(() => ({ fc: undefined as unknown as FirmwareFc, release: true }));

vi.mock("../../src/js/msp", () => ({
    default: {
        promise: vi.fn(async (code: number, data?: number[]) =>
            (await import("./harness/mspFirmware")).firmwarePromise(route.fc, code, data),
        ),
    },
}));
vi.mock("@/gyrocore/releaseGate/releaseContract", async () => {
    const actual = await vi.importActual<typeof import("../../src/gyrocore/releaseGate/releaseContract")>(
        "@/gyrocore/releaseGate/releaseContract",
    );
    return {
        ...actual,
        assertAbsoluteReleased: (p: Parameters<typeof actual.assertAbsoluteReleased>[0]) =>
            route.release ? undefined : actual.assertAbsoluteReleased(p),
    };
});

import MSPCodes from "../../src/js/msp/MSPCodes";
import {
    applyAbsoluteTune,
    previewAbsoluteRestore,
    previewAbsoluteTune,
    previewRestore,
    restoreAbsoluteTune,
    TuneWriteError,
} from "../../src/composables/useTuneApply";
import { ApplyBlockedError } from "../../src/gyrocore/chirp/applyGate";
import { useTuneBackupStore } from "../../src/gyrocore/stores/tuneBackup";
import {
    CONFIRMATION_TTL_MS,
    issueConfirmation,
    resetConfirmations,
} from "../../src/gyrocore/tuning/applyConfirmation";
import type { AbsoluteProposal } from "../../src/gyrocore/releaseGate/releaseContract";
import type { AbsoluteValues } from "../../src/gyrocore/tuning/absoluteTune";
import { air65FirmwareState, createFirmwareFc, FIRMWARE_WRITE_CODES, type FirmwareState } from "./harness/mspFirmware";

function headersFor(s: FirmwareState): [string, string][] {
    const p = s.p;
    return [
        ["Firmware revision", "Betaflight 2026.6.2 (43875a55a) STM32G474"],
        ["Board information", "BEFH BETAFPVG473"],
        ["DeviceUID", "0a1b2c3d4e5f607112233445"],
        ["rollPID", s.pids[0].join(",")],
        ["pitchPID", s.pids[1].join(",")],
        ["yawPID", s.pids[2].join(",")],
        ["ff_weight", `${p.f_roll},${p.f_pitch},${p.f_yaw}`],
        ["d_max", `${p.d_max_roll},${p.d_max_pitch},${p.d_max_yaw}`],
        ["d_max_gain", String(p.d_max_gain)],
        ["gyro_lpf1_static_hz", String(p.gyro_lpf1_static_hz)],
        ["gyro_lpf1_dyn_hz", `${p.gyro_lpf1_dyn_min_hz},${p.gyro_lpf1_dyn_max_hz}`],
        ["dterm_lpf1_static_hz", String(p.dterm_lpf1_static_hz)],
        ["dterm_lpf1_dyn_hz", `${p.dterm_lpf1_dyn_min_hz},${p.dterm_lpf1_dyn_max_hz}`],
        ["dyn_notch_count", String(p.dyn_notch_count)],
        ["dyn_notch_q", String(p.dyn_notch_q)],
        ["rpm_filter_harmonics", String(p.rpm_filter_harmonics)],
        ["rpm_filter_q", String(p.rpm_filter_q)],
        ["rpm_filter_weights", s.rpmWeights.join(",")],
    ];
}

const CHANGE: AbsoluteValues = {
    p_roll: 60,
    d_roll: 32,
    f_pitch: 40,
    dterm_lpf1_static_hz: 80,
    rpm_filter_q: 600,
    dyn_notch_count: 1,
};

function proposal(change: AbsoluteValues = CHANGE, state = air65FirmwareState()): AbsoluteProposal {
    return {
        id: `prop-${Object.entries(change).join("|")}`,
        createdAt: "2026-10-22T00:00:00Z",
        log: { sha256: "a".repeat(64), logIndex: 0, headerPairs: headersFor(state) },
        change: { ...change },
        items: [],
        release: {
            measurement: { valid: false, reasons: ["test"] },
            model: { status: "BLOCKED", reasons: ["test"] },
            margins: [],
            independentValidation: null,
            safetyAnalysisEvidence: "not_available",
            safetyReasons: [],
        },
    };
}

const codes = () => route.fc.calls.map((c) => c.code);
const writes = () => codes().filter((c) => FIRMWARE_WRITE_CODES.has(c));
const confirm = (p: AbsoluteProposal, preview?: string) =>
    issueConfirmation({ kind: "absolute", proposalId: p.id, change: { ...p.change }, ...(preview ? { preview } : {}) });

async function failure(p: Promise<unknown>) {
    return p.then(
        () => null,
        (e: unknown) => e,
    );
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    resetConfirmations();
    route.fc = createFirmwareFc();
    route.release = true;
});

describe("preview: read-only", () => {
    it("reads identity and the four tuning blocks, writes nothing, lists every change", async () => {
        const p = proposal();
        const pv = await previewAbsoluteTune(p);
        expect(writes()).toEqual([]);
        expect(pv.changes.map((c) => c.key).sort()).toEqual(Object.keys(CHANGE).sort());
        expect(pv.expected.values.p_roll).toBe(60);
        expect(pv.before.values.p_roll).toBe(56);
    });

    it("shows switching simplified tuning off as a change of its own", async () => {
        route.fc.ram.sliders.slider_pids_mode = 2;
        route.fc.ram.sliders.slider_gyro_filter = 1;
        const pv = await previewAbsoluteTune(proposal());
        const sliderRows = pv.changes.filter((c) => c.group === "slider");
        expect(sliderRows).toEqual([
            { key: "slider_pids_mode", group: "slider", from: 2, to: 0 },
            { key: "slider_gyro_filter", group: "slider", from: 1, to: 0 },
        ]);
        expect(writes()).toEqual([]);
    });
});

describe("apply: only the confirmed values, verified, then saved", () => {
    it("writes the changed blocks only, reads every field back, saves, checks the save", async () => {
        const p = proposal();
        const before = structuredClone(route.fc.ram);
        const pv = await previewAbsoluteTune(p);
        route.fc.calls = [];
        const res = await applyAbsoluteTune(p, confirm(p, pv.hash));
        expect(res.status).toBe("verified");
        expect(writes()).toEqual([
            MSPCodes.MSP_SET_PID,
            MSPCodes.MSP_SET_PID_ADVANCED,
            MSPCodes.MSP_SET_FILTER_CONFIG,
            MSPCodes.MSP_EEPROM_WRITE,
        ]);
        // Exactly the confirmed values changed; every other firmware value is as before.
        const after = route.fc.eeprom;
        expect(after.pids[0]).toEqual([60, 79, 32]);
        expect(after.p.f_pitch).toBe(40);
        expect(after.p.dterm_lpf1_static_hz).toBe(80);
        expect(after.p.rpm_filter_q).toBe(600);
        expect(after.p.dyn_notch_count).toBe(1);
        const touched = new Set(["f_pitch", "dterm_lpf1_static_hz", "rpm_filter_q", "dyn_notch_count"]);
        for (const [k, v] of Object.entries(before.p)) {
            if (!touched.has(k)) expect(after.p[k], k).toBe(v);
        }
        expect(after.pids.slice(1)).toEqual(before.pids.slice(1));
        expect(after.rpmWeights).toEqual(before.rpmWeights);
        expect(after.sliders).toEqual(before.sliders);
        expect(res.afterSave.values).toEqual(res.expected.values);
        expect(res.rebootRequired).toBe(false);
        // The backup holds every firmware-held value from before the write.
        const backup = useTuneBackupStore().get(res.backupId)!;
        expect(backup.reason).toBe("before_absolute_apply");
        expect(backup.absolute!.values.p_roll).toBe(56);
        expect(backup.absolute!.values.rpm_filter_q).toBe(500);
    });

    it("a filter-only change writes MSP_SET_FILTER_CONFIG only", async () => {
        const p = proposal({ gyro_lpf2_static_hz: 280 });
        await applyAbsoluteTune(p, confirm(p));
        expect(writes()).toEqual([MSPCodes.MSP_SET_FILTER_CONFIG, MSPCodes.MSP_EEPROM_WRITE]);
        expect(route.fc.eeprom.p.gyro_lpf2_static_hz).toBe(280);
    });

    it("switches the slider modes off first, so the firmware cannot recompute the written PIDs", async () => {
        route.fc.ram.sliders.slider_pids_mode = 2;
        route.fc.ram.sliders.slider_dterm_filter = 1;
        const lpfBefore = { ...route.fc.ram.p };
        const p = proposal({ p_roll: 60 });
        await applyAbsoluteTune(p, confirm(p));
        expect(writes()).toEqual([MSPCodes.MSP_SET_SIMPLIFIED_TUNING, MSPCodes.MSP_SET_PID, MSPCodes.MSP_EEPROM_WRITE]);
        const s = route.fc.eeprom;
        expect([s.sliders.slider_pids_mode, s.sliders.slider_dterm_filter, s.sliders.slider_gyro_filter]).toEqual([
            0, 0, 0,
        ]);
        expect(s.pids[0][0]).toBe(60);
        // The slider write carried the live LPF values: nothing else moved.
        for (const k of [
            "dterm_lpf1_static_hz",
            "dterm_lpf2_static_hz",
            "gyro_lpf1_static_hz",
            "gyro_lpf2_static_hz",
        ]) {
            expect(s.p[k], k).toBe(lpfBefore[k]);
        }
    });

    it("reports a reboot request from MSP_STATUS_EX", async () => {
        route.fc.rebootRequired = true;
        const p = proposal({ dyn_notch_count: 3 });
        expect((await applyAbsoluteTune(p, confirm(p))).rebootRequired).toBe(true);
    });
});

describe("gates before any write", () => {
    it("the user's confirmation: missing, other values, used, expired, another kind", async () => {
        const p = proposal();
        expect(((await failure(applyAbsoluteTune(p, null))) as ApplyBlockedError).reasons).toEqual([
            "apply:confirmation_missing",
        ]);
        const other = issueConfirmation({ kind: "absolute", proposalId: p.id, change: { ...CHANGE, p_roll: 61 } });
        expect(((await failure(applyAbsoluteTune(p, other))) as ApplyBlockedError).reasons).toEqual([
            "apply:confirmation_mismatch",
        ]);
        const old = issueConfirmation(
            { kind: "absolute", proposalId: p.id, change: { ...CHANGE } },
            Date.now() - CONFIRMATION_TTL_MS - 1,
        );
        expect(((await failure(applyAbsoluteTune(p, old))) as ApplyBlockedError).reasons).toEqual([
            "apply:confirmation_expired",
        ]);
        const restore = issueConfirmation({ kind: "restore", backupId: "x" });
        expect(((await failure(applyAbsoluteTune(p, restore))) as ApplyBlockedError).reasons).toEqual([
            "apply:confirmation_mismatch",
        ]);
        expect(codes()).toEqual([]);
    });

    it("the real release contract stops an unreleased proposal before any MSP", async () => {
        route.release = false;
        const p = proposal();
        const err = (await failure(applyAbsoluteTune(p, confirm(p)))) as ApplyBlockedError;
        expect(err).toBeInstanceOf(ApplyBlockedError);
        expect(err.reasons.some((r) => r.startsWith("independent_validation:"))).toBe(true);
        expect(err.reasons.some((r) => r.startsWith("phase_margin:"))).toBe(true);
        expect(codes()).toEqual([]);
    });

    const live: [string, (fc: FirmwareFc) => void, string][] = [
        ["another craft", (fc) => (fc.uid = [1, 2, 3]), "fc:identity_uid_mismatch"],
        ["other firmware", (fc) => (fc.version = "2025.12.1"), "fc:identity_firmware_mismatch"],
        ["armed", (fc) => (fc.armed = true), "fc:armed"],
        ["MSP API without the absolute layout", (fc) => (fc.apiVersion = "1.44.0"), "absolute:api_version_unsupported"],
        [
            "active profile no longer holds the logged PIDs",
            (fc) => (fc.ram.pids[1][0] = 83),
            "fc:live_differs_from_log:p_pitch",
        ],
        [
            "filter changed since the log",
            (fc) => (fc.ram.p.rpm_filter_q = 510),
            "fc:live_differs_from_log:rpm_filter_q",
        ],
        [
            "FILTER_CONFIG read fails",
            (fc) => (fc.faults[MSPCodes.MSP_FILTER_CONFIG] = "crc"),
            "fc:live_readback_missing",
        ],
    ];
    for (const [name, mutate, reason] of live) {
        it(`${name} -> ${reason}, nothing written`, async () => {
            const p = proposal();
            mutate(route.fc);
            const err = (await failure(applyAbsoluteTune(p, confirm(p)))) as ApplyBlockedError;
            expect(err).toBeInstanceOf(ApplyBlockedError);
            expect(err.reasons).toContain(reason);
            expect(writes()).toEqual([]);
            expect(useTuneBackupStore().backups).toEqual([]);
        });
    }

    const invalid: [string, AbsoluteValues, string, string?][] = [
        ["out of range", { p_roll: 251 }, "absolute:out_of_range:p_roll:251:0-250"],
        ["not a proposable field", { tpa_rate: 50 }, "absolute:read_only_field:tpa_rate"],
        ["unknown field", { bogus: 1 }, "absolute:unknown_field:bogus"],
        ["d_max below D (the firmware would zero it on reload)", { d_roll: 45 }, "absolute:d_max_below_d:roll"],
        ["dynamic LPF min above max", { gyro_lpf1_dyn_min_hz: 400 }, "absolute:min_above_max:gyro_lpf1_dyn_min_hz"],
        ["RPM Q on a 1.47 FC", { rpm_filter_q: 600 }, "absolute:field_needs_api:rpm_filter_q:1.48.0", "1.47.0"],
    ];
    for (const [name, change, reason, api] of invalid) {
        it(`${name} -> ${reason}`, async () => {
            if (api) route.fc.apiVersion = api;
            const p = proposal(change);
            const err = (await failure(applyAbsoluteTune(p, confirm(p)))) as ApplyBlockedError;
            expect(err.reasons).toContain(reason);
            expect(writes()).toEqual([]);
        });
    }

    it("stale preview: the craft changed after the user confirmed", async () => {
        const p = proposal({ p_roll: 60 }, air65FirmwareState());
        const pv = await previewAbsoluteTune(p);
        route.fc.ram.p.gyro_hardware_lpf = 1; // not logged, but part of what the user saw
        const err = (await failure(applyAbsoluteTune(p, confirm(p, pv.hash)))) as ApplyBlockedError;
        expect(err.reasons).toEqual(["apply:preview_changed"]);
        expect(writes()).toEqual([]);
    });
});

describe("failed writes: never shown as success, never saved, the partial state reported", () => {
    it("timeout on the filter write after PIDs were written", async () => {
        route.fc.faults[MSPCodes.MSP_SET_FILTER_CONFIG] = "timeout";
        const p = proposal();
        const err = (await failure(applyAbsoluteTune(p, confirm(p)))) as TuneWriteError;
        expect(err).toBeInstanceOf(TuneWriteError);
        expect([err.stage, err.saved]).toEqual(["write", "no"]);
        expect(err.changedFromBackup).toEqual(
            expect.arrayContaining(["pid:p_roll 56→60", "pid:d_roll 30→32", "advanced:f_pitch 32→40"]),
        );
        expect(codes()).not.toContain(MSPCodes.MSP_EEPROM_WRITE);
        expect(route.fc.eeprom.pids[0]).toEqual([56, 79, 30]);
        expect(useTuneBackupStore().get(err.backupId)?.absolute?.values.p_roll).toBe(56);
    });

    it("the firmware answers MSP_SET_FILTER_CONFIG with an error after storing part of it", async () => {
        route.fc.errorAfterDecode.add(MSPCodes.MSP_SET_FILTER_CONFIG);
        const p = proposal({ p_roll: 60, dterm_lpf1_static_hz: 90 });
        const err = (await failure(applyAbsoluteTune(p, confirm(p)))) as TuneWriteError;
        expect([err.stage, err.saved]).toEqual(["write", "no"]);
        // Both blocks reached RAM before the error: the report says so, nothing was saved.
        expect(err.changedFromBackup).toEqual(["pid:p_roll 56→60", "filter:dterm_lpf1_static_hz 75→90"]);
        expect(codes()).not.toContain(MSPCodes.MSP_EEPROM_WRITE);
        expect(route.fc.eeprom.p.dterm_lpf1_static_hz).toBe(75);
    });

    it("a disconnect during verification: not saved", async () => {
        route.fc.faultsAfterWrites.push({ after: 1, code: MSPCodes.MSP_PID_ADVANCED, fault: "disconnect" });
        const p = proposal({ p_roll: 60 });
        const err = (await failure(applyAbsoluteTune(p, confirm(p)))) as TuneWriteError;
        expect([err.stage, err.saved]).toEqual(["verify", "no"]);
        expect(codes()).not.toContain(MSPCodes.MSP_EEPROM_WRITE);
    });

    it("the firmware acknowledges but keeps its values: verification fails, not saved", async () => {
        route.fc.ignoreWrite.add(MSPCodes.MSP_SET_FILTER_CONFIG);
        const p = proposal({ dterm_lpf1_static_hz: 80 });
        const err = (await failure(applyAbsoluteTune(p, confirm(p)))) as TuneWriteError;
        expect([err.stage, err.saved]).toEqual(["verify", "no"]);
        expect(err.mismatches).toEqual(["filter:dterm_lpf1_static_hz expected 80 read 75"]);
        expect(codes()).not.toContain(MSPCodes.MSP_EEPROM_WRITE);
    });

    it("EEPROM write times out: saved state unknown", async () => {
        route.fc.faults[MSPCodes.MSP_EEPROM_WRITE] = "timeout";
        const p = proposal({ p_roll: 60 });
        const err = (await failure(applyAbsoluteTune(p, confirm(p)))) as TuneWriteError;
        expect([err.stage, err.saved]).toEqual(["eeprom", "unknown"]);
    });

    it("EEPROM write refused (armed in the meantime): not saved", async () => {
        route.fc.faultsAfterWrites.push({ after: 1, code: MSPCodes.MSP_EEPROM_WRITE, fault: "unsupported" });
        const p = proposal({ p_roll: 60 });
        const err = (await failure(applyAbsoluteTune(p, confirm(p)))) as TuneWriteError;
        expect([err.stage, err.saved]).toEqual(["eeprom", "no"]);
        expect(route.fc.eeprom.pids[0][0]).toBe(56);
    });

    it("the firmware changes a value when it reloads the saved config: reported, not hidden", async () => {
        route.fc.adjustOnReload = (s) => (s.p.dyn_notch_q = 250);
        const p = proposal({ dyn_notch_q: 280 });
        const err = (await failure(applyAbsoluteTune(p, confirm(p)))) as TuneWriteError;
        expect([err.stage, err.saved]).toEqual(["eeprom_verify", "yes_adjusted"]);
        expect(err.mismatches).toEqual(["filter:dyn_notch_q expected 280 read 250"]);
    });
});

describe("restore: the backup exactly, slider modes included", () => {
    it("puts every value back after an absolute Apply, verifies and saves", async () => {
        route.fc.ram.sliders.slider_pids_mode = 2;
        const original = structuredClone(route.fc.ram);
        route.fc.eeprom = structuredClone(original);
        const p = proposal(CHANGE, original);
        const res = await applyAbsoluteTune(p, confirm(p));
        expect(route.fc.eeprom.sliders.slider_pids_mode).toBe(0);

        const pv = await previewAbsoluteRestore(res.backupId);
        expect(pv.changes.some((c) => c.key === "slider_pids_mode" && c.to === 2)).toBe(true);
        route.fc.calls = [];
        const token = issueConfirmation({ kind: "restore", backupId: res.backupId, preview: pv.hash });
        const back = await restoreAbsoluteTune(res.backupId, token);
        expect(back.status).toBe("verified");
        expect(writes()).toEqual([
            MSPCodes.MSP_SET_SIMPLIFIED_TUNING,
            MSPCodes.MSP_SET_PID,
            MSPCodes.MSP_SET_PID_ADVANCED,
            MSPCodes.MSP_SET_FILTER_CONFIG,
            MSPCodes.MSP_EEPROM_WRITE,
        ]);
        expect(route.fc.eeprom).toEqual(original);
    });

    it("refuses another craft, other firmware, another MSP API, or the v1 Restore", async () => {
        const p = proposal({ p_roll: 60 });
        const res = await applyAbsoluteTune(p, confirm(p));
        for (const [mutate, reason] of [
            [(fc: FirmwareFc) => (fc.uid = [9, 9, 9]), "restore:different_craft"],
            [(fc: FirmwareFc) => (fc.version = "2026.12.0"), "restore:firmware_changed"],
            [(fc: FirmwareFc) => (fc.apiVersion = "1.49.0"), "restore:api_version_changed"],
        ] as const) {
            const saved = structuredClone(route.fc);
            mutate(route.fc);
            route.fc.calls = [];
            const token = issueConfirmation({ kind: "restore", backupId: res.backupId });
            const err = (await failure(restoreAbsoluteTune(res.backupId, token))) as ApplyBlockedError;
            expect(err.reasons).toContain(reason);
            expect(writes()).toEqual([]);
            route.fc = { ...saved, ignoreWrite: new Set() };
        }
        expect(((await failure(previewRestore(res.backupId))) as ApplyBlockedError).reasons).toEqual([
            "restore:use_absolute_restore",
        ]);
    });
});
