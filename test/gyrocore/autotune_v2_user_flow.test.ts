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
 * The release contract reached the way a user reaches it, through useAutotuneV2 only: import
 * baseline + repeat, apply a clearly different PID set, import its two CHIRP logs, create the
 * Verified Tune from those logs, Calculate, then Apply / Verify / Restore on the simulated FC
 * that holds the candidate tune. No fixture record is injected. A candidate flight that
 * contradicts the prediction yields no record and nothing releasable.
 * (Synthetic logs stand in for the BBL decode: buildLogInputs is replaced per file.)
 */

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FirmwareFc } from "./harness/mspFirmware";
import type { AutotuneLogInput } from "../../src/gyrocore/engine/autotuneV2";

const mocks = vi.hoisted(() => ({
    fc: undefined as unknown as FirmwareFc,
    logs: new Map<string, AutotuneLogInput>(),
    showYesNo: vi.fn(async () => true),
}));
vi.mock("../../src/js/msp", () => ({
    default: {
        promise: vi.fn(async (code: number, data?: number[]) =>
            (await import("./harness/mspFirmware")).firmwarePromise(mocks.fc, code, data),
        ),
    },
}));
vi.mock("@/composables/useDialog", () => ({ useDialog: () => ({ showYesNo: mocks.showYesNo }) }));
vi.mock("@/js/blackbox/m4_bbl_integration", () => ({ analyzeM4BblFile: () => ({ logs: [] }) }));
vi.mock("@/gyrocore/engine/logInput", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/gyrocore/engine/logInput")>()),
    buildLogInputs: (_bytes: Uint8Array, _sha: string, report: { filename: string }) => [
        mocks.logs.get(report.filename)!,
    ],
}));

import { useAutotuneV2 } from "../../src/composables/useAutotuneV2";
import { useAutotuneV2Store } from "../../src/gyrocore/stores/autotuneV2";
import { useVerifiedTuneStore } from "../../src/gyrocore/stores/verifiedTunes";
import { useTuneBackupStore } from "../../src/gyrocore/stores/tuneBackup";
import { resetConfirmations } from "../../src/gyrocore/tuning/applyConfirmation";
import { useConnectionStore } from "../../src/stores/connection";
import type { ChirpQualificationReport } from "../../src/gyrocore/chirp/qualification";
import { air65FirmwareState, createFirmwareFc } from "./harness/mspFirmware";
import { SYNTH_HEADERS, syntheticLogInput } from "./harness/syntheticLog";

const BASE: Record<string, [number, number, number]> = { roll: [56, 79, 30], pitch: [82, 117, 61], yaw: [56, 79, 0] };
// P / I +20 %, D −20 %: a change the CHIRP can resolve (scaling all three together cannot).
const CAND = { roll: [67, 95, 24], pitch: [98, 140, 49], yaw: [67, 95, 0] } as Record<string, [number, number, number]>;

function importLog(name: string, log: AutotuneLogInput) {
    mocks.logs.set(name, log);
    const report = {
        filename: name,
        logs: [{ headerPairs: log.headerPairs }],
        measurements: [],
    } as unknown as ChirpQualificationReport;
    useAutotuneV2Store().addSource(new Uint8Array([name.length]), name, report);
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    resetConfirmations();
    mocks.logs.clear();
    mocks.showYesNo.mockClear();
    const ram = air65FirmwareState();
    ram.pids = [CAND.roll, CAND.pitch, CAND.yaw, ram.pids[3], ram.pids[4]].map((r) => [...r]);
    mocks.fc = createFirmwareFc({ ram });
    useConnectionStore().virtualMode = false;
});

describe("user flow: baseline, gain change, Verified Tune, Apply, Restore", () => {
    it("the contract is reachable from imported logs alone, and the write is verified and restorable", async () => {
        importLog("baseline.bbl", syntheticLogInput("1".repeat(64), { pids: BASE }));
        importLog("baseline-repeat.bbl", syntheticLogInput("2".repeat(64), { pids: BASE }));
        importLog("candidate.bbl", syntheticLogInput("3".repeat(64), { pids: CAND }));
        importLog("candidate-repeat.bbl", syntheticLogInput("4".repeat(64), { pids: CAND }));
        expect(SYNTH_HEADERS.find(([k]) => k === "rollPID")![1]).toBe("56,79,30");

        const v2 = useAutotuneV2();
        const store = useAutotuneV2Store();
        await v2.createVerifiedTune();
        expect(store.verifiedTuneAttempt?.verdict).toBe("PASS");
        expect(useVerifiedTuneStore().records).toHaveLength(1);
        const record = useVerifiedTuneStore().records[0];
        expect(record.baseline.sha256).toBe("1".repeat(64));
        expect(record.candidate.sha256).toBe("3".repeat(64));
        expect(record.baselineRepeat?.sha256).toBe("2".repeat(64));

        // Calculate ran again with the record; it works from the candidate tune (what the FC holds).
        expect(store.state).toBe("done");
        expect(store.result!.proposal?.log.sha256 ?? store.result!.releasableProposal?.log.sha256).toBe("3".repeat(64));
        const released = v2.releasedProposal();
        expect(released).not.toBeNull();

        const original = structuredClone(mocks.fc.ram);
        useConnectionStore().connectionValid = true;
        expect(await v2.confirmAndApply()).toBe("verified");
        expect(mocks.showYesNo).toHaveBeenCalledTimes(1);
        expect(store.outcome?.status).toBe("verified");
        for (const [k, v] of Object.entries(released!.change)) {
            if (store.outcome?.status === "verified") expect(store.outcome.afterSave.values[k], k).toBe(v);
        }

        const backup = useTuneBackupStore().backups.find((b) => b.absolute)!;
        expect(await v2.confirmAndRestore(backup)).toBe("verified");
        expect(mocks.fc.eeprom).toEqual(original);
    }, 600_000);

    it("a candidate flight that contradicts the prediction: no record, nothing releasable", async () => {
        importLog("baseline.bbl", syntheticLogInput("1".repeat(64), { pids: BASE }));
        importLog("candidate.bbl", syntheticLogInput("3".repeat(64), { pids: CAND, plantScale: 1.4 }));
        const v2 = useAutotuneV2();
        await v2.createVerifiedTune();
        expect(useAutotuneV2Store().verifiedTuneAttempt?.verdict).toBe("FAIL");
        expect(useVerifiedTuneStore().records).toHaveLength(0);
        expect(v2.releasedProposal()).toBeNull();
        expect(mocks.fc.calls).toEqual([]);
    }, 600_000);

    it("a single tune cannot validate itself", async () => {
        importLog("baseline.bbl", syntheticLogInput("1".repeat(64), { pids: BASE }));
        importLog("baseline-repeat.bbl", syntheticLogInput("2".repeat(64), { pids: BASE }));
        await useAutotuneV2().createVerifiedTune();
        expect(useAutotuneV2Store().verifiedTuneAttempt).toMatchObject({
            verdict: "NONE",
            reasons: [
                "verified_tune:needs_two_tunes",
                "required_measurement:gain_change_chirp_flight_plus_baseline_repeat",
            ],
        });
    }, 600_000);
});
