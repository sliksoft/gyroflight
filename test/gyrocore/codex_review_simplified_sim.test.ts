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
 * Codex review P2-01: the simulated MSP_SET_SIMPLIFIED_TUNING must do what Betaflight 2026.6.2
 * does, because Restore writes the slider modes first and a later failure leaves exactly that
 * intermediate state on the craft. Expected values are not computed by the harness: they are the
 * output of the firmware's own simplified_tuning.c compiled on the host
 * (harness/simplified_tuning_c/, generate.sh), stored as literals, plus the review's table.
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
// The write authority's steps other than the release contract (writeAuthority.ts), released.
vi.mock("@/gyrocore/releaseGate/analysisBinding", async () =>
    (await import("./harness/analysisBindingRelease")).releasedAnalysisBinding(),
);
vi.mock("@/gyrocore/safety/authorize", async () => (await import("./harness/safetyRelease")).releasedSafety());
vi.mock("@/gyrocore/productLock/productApply", async () =>
    (await import("./harness/productRelease")).releasedProductApply(),
);
vi.mock("@/gyrocore/releaseGate/releaseContract", async () => ({
    ...(await vi.importActual<typeof import("../../src/gyrocore/releaseGate/releaseContract")>(
        "@/gyrocore/releaseGate/releaseContract",
    )),
    evaluateRelease: () => ({ released: true, conditions: [], blocks: [] }),
}));

import MSPCodes from "../../src/js/msp/MSPCodes";
import {
    applyAbsoluteTune,
    previewAbsoluteRestore,
    previewAbsoluteTune,
    restoreAbsoluteTune,
    TuneWriteError,
} from "../../src/composables/useTuneApply";
import { issueConfirmation, resetConfirmations } from "../../src/gyrocore/tuning/applyConfirmation";
import type { AbsoluteProposal } from "../../src/gyrocore/releaseGate/releaseContract";
import cOutput from "./harness/simplified_tuning_c/firmware_c_output.json";
import { air65FirmwareState, applySimplified, createFirmwareFc, type FirmwareState } from "./harness/mspFirmware";

interface CCase {
    in: number[];
    pids: number[][];
    f: number[];
    dMax: number[];
    dterm: number[];
    gyro: number[];
}
const C_OUTPUT = cOutput as CCase[];

const SLIDERS = [
    "slider_pids_mode",
    "slider_master_multiplier",
    "slider_roll_pitch_ratio",
    "slider_i_gain",
    "slider_d_gain",
    "slider_pi_gain",
    "slider_dmax_gain",
    "slider_feedforward_gain",
    "slider_pitch_pi_gain",
    "slider_dterm_filter",
    "slider_dterm_filter_multiplier",
    "slider_gyro_filter",
    "slider_gyro_filter_multiplier",
];
const DTERM = ["dterm_lpf1_static_hz", "dterm_lpf2_static_hz", "dterm_lpf1_dyn_min_hz", "dterm_lpf1_dyn_max_hz"];
const GYRO = ["gyro_lpf1_static_hz", "gyro_lpf2_static_hz", "gyro_lpf1_dyn_min_hz", "gyro_lpf1_dyn_max_hz"];

/** The AIR65 state (the C driver's starting PIDs) with a case's sliders and LPF values. */
function stateFor(input: number[]): FirmwareState {
    const s = air65FirmwareState();
    SLIDERS.forEach((k, i) => (s.sliders[k] = input[i]));
    [...DTERM, ...GYRO].forEach((k, i) => (s.p[k] = input[13 + i]));
    return s;
}

function outcome(s: FirmwareState) {
    return {
        pids: s.pids.slice(0, 3),
        f: [s.p.f_roll, s.p.f_pitch, s.p.f_yaw],
        dMax: [s.p.d_max_roll, s.p.d_max_pitch, s.p.d_max_yaw],
        dterm: DTERM.map((k) => s.p[k]),
        gyro: GYRO.map((k) => s.p[k]),
    };
}

describe("P2-01: simplified tuning matches the firmware's own C", () => {
    it(`all ${C_OUTPUT.length} reference cases (rounding, clamps, F, d_max, filters kept off)`, () => {
        for (const c of C_OUTPUT) {
            const s = stateFor(c.in);
            applySimplified(s);
            expect(outcome(s), c.in.join(" ")).toEqual({
                pids: c.pids,
                f: c.f,
                dMax: c.dMax,
                dterm: c.dterm,
                gyro: c.gyro,
            });
        }
    });

    it("the review's table (master 125, PID mode 2, gyro filter mode 1, static LPF 0)", () => {
        const s = air65FirmwareState();
        Object.assign(s.sliders, { slider_pids_mode: 2, slider_master_multiplier: 125, slider_gyro_filter: 1 });
        s.p.gyro_lpf1_static_hz = 0;
        applySimplified(s);
        expect(s.pids[1][0]).toBe(58); // pitch P (the old simulator: 59)
        expect(s.p.f_roll).toBe(150); // (22)
        expect(s.p.d_max_roll).toBe(50); // (40)
        expect(s.p.gyro_lpf1_static_hz).toBe(0); // off stays off (250)
        expect([s.p.gyro_lpf1_dyn_min_hz, s.p.gyro_lpf1_dyn_max_hz]).toEqual([250, 500]); // (150/300)
    });
});

// --- Restore failing after each write -------------------------------------------------------

/** The craft at Apply: AIR65 values, simplified modes on (C reference case 0's sliders and LPFs). */
const CASE = C_OUTPUT[0];
function craftWithSlidersOn(): FirmwareState {
    return stateFor(CASE.in);
}

function headersFor(s: FirmwareState): [string, string][] {
    return [
        ["Firmware revision", "Betaflight 2026.6.2 (43875a55a) STM32G474"],
        ["Board information", "BEFH BETAFPVG473"],
        ["DeviceUID", "003e00213841501220343141"],
        ["rollPID", s.pids[0].join(",")],
        ["pitchPID", s.pids[1].join(",")],
        ["yawPID", s.pids[2].join(",")],
    ];
}

function proposal(): AbsoluteProposal {
    return {
        id: "p2-01",
        createdAt: "2026-10-22T00:00:00Z",
        log: { sha256: "a".repeat(64), logIndex: 0, headerPairs: headersFor(craftWithSlidersOn()) },
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

async function applied() {
    route.fc = createFirmwareFc({ ram: craftWithSlidersOn() });
    const p = proposal();
    const pv = await previewAbsoluteTune(p);
    const res = await applyAbsoluteTune(
        p,
        issueConfirmation({ kind: "absolute", proposalId: p.id, change: { ...p.change }, preview: pv.hash }),
    );
    return { backupId: res.backupId, appliedRam: structuredClone(route.fc.ram), appliedEeprom: route.fc.eeprom };
}

async function restoreFailingAt(code: number, backupId: string) {
    route.fc.faultsAfterWrites.push({ after: route.fc.writes, code, fault: "timeout" });
    const pv = await previewAbsoluteRestore(backupId);
    return restoreAbsoluteTune(backupId, issueConfirmation({ kind: "restore", backupId, preview: pv.hash })).then(
        () => null,
        (e: unknown) => e as TuneWriteError,
    );
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    resetConfirmations();
});

describe("P2-01: a Restore that fails after each write leaves the firmware's intermediate state", () => {
    // Restore writes: MSP_SET_SIMPLIFIED_TUNING, _PID, _PID_ADVANCED, _FILTER_CONFIG, then EEPROM.
    it("write 1 itself refused (MSP_RESULT_ERROR before decoding): the FC still holds the applied tune", async () => {
        const { backupId, appliedRam } = await applied();
        route.fc.faults[MSPCodes.MSP_SET_SIMPLIFIED_TUNING] = "unsupported";
        const pv = await previewAbsoluteRestore(backupId);
        const e = await restoreAbsoluteTune(
            backupId,
            issueConfirmation({ kind: "restore", backupId, preview: pv.hash }),
        ).then(
            () => null,
            (err: unknown) => err as TuneWriteError,
        );
        expect(e).toBeInstanceOf(TuneWriteError);
        expect([e!.stage, e!.saved]).toEqual(["write", "no"]);
        expect(route.fc.ram).toEqual(appliedRam);
        // Against the Restore's safety backup (the applied tune): nothing differs.
        expect(e!.changedFromBackup).toEqual([]);
    });

    it("after write 1 (slider modes back on): the firmware recomputed PIDs, F, d_max and gyro LPFs", async () => {
        const { backupId } = await applied();
        const e = await restoreFailingAt(MSPCodes.MSP_SET_PID, backupId);
        expect(e).toBeInstanceOf(TuneWriteError);
        expect([e!.stage, e!.saved]).toEqual(["write", "no"]);
        // Literal firmware output (C case 0), not the harness:
        expect(route.fc.ram.pids.slice(0, 3)).toEqual(CASE.pids);
        expect([route.fc.ram.p.f_roll, route.fc.ram.p.f_pitch, route.fc.ram.p.f_yaw]).toEqual(CASE.f);
        expect([route.fc.ram.p.d_max_roll, route.fc.ram.p.d_max_pitch, route.fc.ram.p.d_max_yaw]).toEqual(CASE.dMax);
        expect(GYRO.map((k) => route.fc.ram.p[k])).toEqual(CASE.gyro);
        // The partial state is reported against the Restore's own safety backup (the applied tune).
        expect(e!.changedFromBackup).toEqual(
            expect.arrayContaining([
                "pid:p_roll 60→56",
                "pid:p_pitch 82→58",
                "advanced:f_roll 22→150",
                "advanced:d_max_roll 40→50",
                "filter:gyro_lpf2_static_hz 300→500",
                "slider:slider_pids_mode 0→2",
            ]),
        );
    });

    it("after write 2 (PIDs back): F, d_max and gyro LPFs still as the firmware recomputed them", async () => {
        const original = craftWithSlidersOn();
        const { backupId } = await applied();
        const e = await restoreFailingAt(MSPCodes.MSP_SET_PID_ADVANCED, backupId);
        expect(e).toBeInstanceOf(TuneWriteError);
        expect(route.fc.ram.pids.slice(0, 3)).toEqual(original.pids.slice(0, 3));
        expect([route.fc.ram.p.f_roll, route.fc.ram.p.d_max_roll]).toEqual([CASE.f[0], CASE.dMax[0]]);
        expect(e!.changedFromBackup).toEqual(expect.arrayContaining(["advanced:f_roll 22→150"]));
        expect(e!.changedFromBackup).not.toEqual(expect.arrayContaining([expect.stringMatching(/^pid:p_pitch/)]));
    });

    it("after write 3 (advanced back): only the gyro LPFs remain recomputed", async () => {
        const original = craftWithSlidersOn();
        const { backupId } = await applied();
        const e = await restoreFailingAt(MSPCodes.MSP_SET_FILTER_CONFIG, backupId);
        expect(e).toBeInstanceOf(TuneWriteError);
        expect(route.fc.ram.p.f_roll).toBe(original.p.f_roll);
        expect(GYRO.map((k) => route.fc.ram.p[k])).toEqual(CASE.gyro);
        expect(e!.changedFromBackup).toEqual(
            expect.arrayContaining(["filter:gyro_lpf2_static_hz 300→500", "filter:gyro_lpf1_dyn_min_hz 150→250"]),
        );
    });

    it("after write 4 (all blocks back), EEPROM times out: RAM is the backup, the save is unknown", async () => {
        const original = craftWithSlidersOn();
        const { backupId, appliedEeprom } = await applied();
        const e = await restoreFailingAt(MSPCodes.MSP_EEPROM_WRITE, backupId);
        expect(e).toBeInstanceOf(TuneWriteError);
        expect([e!.stage, e!.saved]).toEqual(["eeprom", "unknown"]);
        expect(route.fc.ram).toEqual(original);
        expect(route.fc.eeprom).toEqual(appliedEeprom);
    });

    it("valid: the same Restore without a fault restores the craft exactly, modes included", async () => {
        const original = craftWithSlidersOn();
        const { backupId } = await applied();
        const pv = await previewAbsoluteRestore(backupId);
        const back = await restoreAbsoluteTune(
            backupId,
            issueConfirmation({ kind: "restore", backupId, preview: pv.hash }),
        );
        expect(back.status).toBe("verified");
        expect(route.fc.ram).toEqual(original);
        expect(route.fc.eeprom).toEqual(original);
    });
});
