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
 * Verified Tune from those logs, Calculate. A record covers only its measured segment from its
 * measured baseline: with the FC on the candidate tune nothing further is released; with the FC
 * back on the baseline (a new baseline flight imported) the confirmed segment is released, then
 * Apply / Verify / Restore run on the simulated FC. No fixture record is injected. A candidate
 * flight that contradicts the prediction yields no record and nothing releasable.
 * (Synthetic logs stand in for the BBL decode: buildLogInputs is replaced per file.)
 */

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FirmwareFc } from "./harness/mspFirmware";
import { type AutotuneLogInput } from "../../src/gyrocore/engine/autotuneV2";
import { pickPrimary } from "../../src/gyrocore/engine/logInput";

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
// The write authority's steps other than the release contract (writeAuthority.ts), released.
vi.mock("@/gyrocore/releaseGate/analysisBinding", async () =>
    (await import("./harness/analysisBindingRelease")).releasedAnalysisBinding(),
);
vi.mock("@/gyrocore/safety/authorize", async () => (await import("./harness/safetyRelease")).releasedSafety());
vi.mock("@/gyrocore/productLock/productApply", async () =>
    (await import("./harness/productRelease")).releasedProductApply(),
);
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
import { runSoftwareQualifiedAutotuneV2 } from "./harness/softwareQualifiedResult";
import { SYNTH_HEADERS, syntheticLogInput } from "./harness/syntheticLog";

const BASE: Record<string, [number, number, number]> = { roll: [56, 79, 30], pitch: [82, 117, 61], yaw: [56, 79, 0] };
// P / I −10 %, D −30 %: a change the CHIRP can resolve (scaling all three together cannot), in
// the direction the search recommends for this craft.
const CAND = { roll: [50, 71, 21], pitch: [74, 105, 43], yaw: [50, 71, 0] } as Record<string, [number, number, number]>;

function fcHolding(pids: Record<string, [number, number, number]>) {
    const ram = air65FirmwareState();
    ram.pids = [pids.roll, pids.pitch, pids.yaw, ram.pids[3], ram.pids[4]].map((r) => [...r]);
    mocks.fc = createFirmwareFc({ ram });
}

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
    fcHolding(CAND);
    useConnectionStore().virtualMode = false;
});

describe("user flow: baseline, gain change, Verified Tune, Apply, Restore", () => {
    async function verifiedFromLogs() {
        importLog("baseline.bbl", syntheticLogInput("1".repeat(64), { pids: BASE }));
        importLog("baseline-repeat.bbl", syntheticLogInput("2".repeat(64), { pids: BASE }));
        importLog("candidate.bbl", syntheticLogInput("3".repeat(64), { pids: CAND }));
        importLog("candidate-repeat.bbl", syntheticLogInput("4".repeat(64), { pids: CAND }));
        expect(SYNTH_HEADERS.find(([k]) => k === "rollPID")![1]).toBe("56,79,30");

        const v2 = useAutotuneV2();
        await v2.createVerifiedTune();
        expect(useAutotuneV2Store().verifiedTuneAttempt?.verdict).toBe("PASS");
        expect(useVerifiedTuneStore().records).toHaveLength(1);
        const record = useVerifiedTuneStore().records[0];
        expect(record.baseline.sha256).toBe("1".repeat(64));
        expect(record.candidate.sha256).toBe("3".repeat(64));
        expect(record.baselineRepeat?.sha256).toBe("2".repeat(64));
        return v2;
    }

    it("FC on the candidate tune: the record covers no further step from there", async () => {
        const v2 = await verifiedFromLogs();
        const store = useAutotuneV2Store();
        // Calculate ran again with the record, from the candidate tune (what the FC holds).
        expect(store.state).toBe("done");
        expect(store.result!.parts.find((p) => p.part === "independent_gain_prediction")!.reasons).toContain(
            "verified_tune_measured_from_another_configuration",
        );
        expect(v2.releasedProposal()).toBeNull();
        useConnectionStore().connectionValid = true;
        expect(await v2.confirmAndApply()).toBe("cancelled");
        expect(mocks.fc.calls).toEqual([]);
    }, 600_000);

    it("FC back on the measured baseline: the confirmed segment is released, verified and restorable", async () => {
        const v2 = await verifiedFromLogs();
        const store = useAutotuneV2Store();
        // The user put the baseline back on the craft and flew it again.
        fcHolding(BASE);
        importLog("baseline-again.bbl", syntheticLogInput("5".repeat(64), { pids: BASE }));
        await v2.calculate();
        expect(store.state).toBe("done");
        // Published frozen: what an Apply is authorized against cannot be edited in place.
        expect(Object.isFrozen(store.inputs)).toBe(true);
        for (const l of store.inputs!) expect(Object.isFrozen(l) && Object.isFrozen(l.channels)).toBe(true);
        // The app has no qualification log for the margins' model class (Codex final acceptance
        // F-02): the bounds stay MODEL_CONDITIONAL, the measurement is named, nothing is released.
        expect(v2.releasedProposal()).toBeNull();
        // Proposed PID can lower fc below the ladder → MEASURED on that axis; current stays bounded.
        for (const m of Object.values(store.result!.margins)) {
            expect(["MODEL_CONDITIONAL", "MEASURED"]).toContain(m!.proposed.evidence.level);
            expect(m!.current.evidence.level).toBe("MODEL_CONDITIONAL");
        }
        expect(store.result!.parts.find((p) => p.part === "phase_margin_robustness")!.requiredMeasurements).toContain(
            "required_measurement:chirp_finer_resolution_model_class_qualification",
        );
        // SIMULATION: software-only VALIDATED evidence (no fictitious qualification flight).
        // Apply is still the user's click.
        const picked = pickPrimary(store.inputs!)!;
        store.result = runSoftwareQualifiedAutotuneV2({
            ...picked,
            verifiedTune: useVerifiedTuneStore().records[0],
        });
        const released = v2.releasedProposal();
        expect(released).not.toBeNull();
        expect(released!.log.sha256).toBe("1".repeat(64));
        const record = useVerifiedTuneStore().records[0];
        for (const [k, to] of Object.entries(released!.change)) {
            const [b, c] = [record.baseline.values[k], record.candidate.values[k]];
            expect(Math.min(b, c) <= to && to <= Math.max(b, c), k).toBe(true);
        }

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
