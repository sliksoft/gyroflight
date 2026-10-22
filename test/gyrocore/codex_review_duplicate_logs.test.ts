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
 * Codex review P1-02: the same flight must never count as its own independent repeat. The
 * review's probe (one log as primary and as "other", same SHA-256 and logIndex) released a
 * proposal; so did the same flight under another file hash. A reference must also be the
 * same craft, firmware and relevant configuration. Synthetic flights differ only by their noise
 * seed (derived from the hash), so identical hashes give identical data, as in a real copy.
 */

import { createPinia, setActivePinia } from "pinia";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutotuneLogInput, AutotuneV2Result } from "../../src/gyrocore/engine/autotuneV2";

const mocks = vi.hoisted(() => ({ logs: new Map<string, AutotuneLogInput>() }));
vi.mock("@/js/blackbox/m4_bbl_integration", () => ({ analyzeM4BblFile: () => ({ logs: [] }) }));
vi.mock("@/gyrocore/engine/logInput", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/gyrocore/engine/logInput")>()),
    buildLogInputs: (_bytes: Uint8Array, _sha: string, report: { filename: string }) => [
        mocks.logs.get(report.filename)!,
    ],
}));

import { runAutotuneV2 } from "../../src/gyrocore/engine/autotuneV2";
import { evaluateRelease } from "../../src/gyrocore/releaseGate/releaseContract";
import { buildVerifiedTune, verifiedTuneIssues } from "../../src/gyrocore/releaseGate/verifiedTune";
import { verifiedTuneFromLogs } from "../../src/gyrocore/engine/verifiedTuneFromLogs";
import { useAutotuneV2 } from "../../src/composables/useAutotuneV2";
import { useAutotuneV2Store } from "../../src/gyrocore/stores/autotuneV2";
import type { ChirpQualificationReport } from "../../src/gyrocore/chirp/qualification";
import { syntheticLogInput } from "./harness/syntheticLog";
import { FIXTURE_FIRMWARE, FIXTURE_UID, verifiedTuneAllAxesFixture } from "./harness/verifiedTuneFixture";

const record = () => verifiedTuneAllAxesFixture(0.9, 0.7);
const AT = "2026-10-22T00:00:00Z";
const run = (primary: AutotuneLogInput, others: AutotuneLogInput[]) =>
    runAutotuneV2({ primary, others, verifiedTune: record(), createdAt: AT });
const released = (r: AutotuneV2Result) => !!r.releasableProposal && evaluateRelease(r.releasableProposal).released;

function withHeader(log: AutotuneLogInput, key: string, value: string): AutotuneLogInput {
    return { ...log, headerPairs: log.headerPairs.map(([k, v]) => [k, k === key ? value : v] as [string, string]) };
}

let independent: AutotuneV2Result;
let sameHash: AutotuneV2Result;
let sameFlightOtherHash: AutotuneV2Result;

beforeAll(() => {
    const primary = syntheticLogInput("1".repeat(64));
    independent = run(primary, [syntheticLogInput("2".repeat(64))]);
    // The review's probe: one log twice, as primary and as reference.
    sameHash = run(primary, [syntheticLogInput("1".repeat(64))]);
    // The same flight in a re-saved file: another hash, identical samples.
    sameFlightOtherHash = run(primary, [{ ...primary, sha256: "3".repeat(64) }]);
}, 600_000);

describe("P1-02: a duplicate is not an independent repeat", () => {
    it("positive control: an independent second flight of the same tune reproduces and releases", () => {
        expect(Object.values(independent.crossLogPlant).map((c) => c!.status)).toEqual(["PASS", "PASS", "PASS"]);
        expect(released(independent)).toBe(true);
    });

    it("review counterexample: same SHA-256 and logIndex → no cross-log check, nothing released", () => {
        expect(sameHash.crossLogPlant).toEqual({});
        expect(sameHash.crossLogRejected).toContain(`cross_log_duplicate_of_primary:${"1".repeat(64)}:0`);
        expect(released(sameHash)).toBe(false);
        expect(evaluateRelease(sameHash.releasableProposal ?? sameHash.proposal!).blocks).toEqual(
            expect.arrayContaining(["model_quality:cross_log_plant_untested:roll"]),
        );
    });

    it("the same flight under another file hash (identical samples) is a duplicate too", () => {
        expect(sameFlightOtherHash.crossLogPlant).toEqual({});
        expect(sameFlightOtherHash.crossLogRejected).toContain(`cross_log_duplicate_of_primary:${"3".repeat(64)}:0`);
        expect(released(sameFlightOtherHash)).toBe(false);
    });

    it("a reference of another craft, firmware or filter configuration is not used", () => {
        const primary = syntheticLogInput("1".repeat(64));
        const other = syntheticLogInput("2".repeat(64));
        const cases: [AutotuneLogInput, string][] = [
            [withHeader(other, "DeviceUID", "00000001000000020000000a"), "cross_log_other_craft"],
            [
                withHeader(other, "Firmware revision", "Betaflight 2026.12.0 (deadbeef) STM32G474"),
                "cross_log_other_firmware",
            ],
            [withHeader(other, "gyro_lpf2_static_hz", "250"), "cross_log_config_differs:gyro_lpf2_static_hz"],
        ];
        for (const [o, reason] of cases) {
            const r = run(primary, [o]);
            expect(r.crossLogPlant, reason).toEqual({});
            expect(
                r.crossLogRejected.some((x) => x.startsWith(reason)),
                reason,
            ).toBe(true);
        }
    }, 600_000);
});

describe("P1-02: Verified Tune repeats are independent flights", () => {
    const BASE = { roll: [56, 79, 30], pitch: [82, 117, 61], yaw: [56, 79, 0] } as Record<
        string,
        [number, number, number]
    >;
    const CAND = { roll: [50, 71, 21], pitch: [74, 105, 43], yaw: [50, 71, 0] } as Record<
        string,
        [number, number, number]
    >;

    it("a baseline copy is not taken as the baseline repeat", () => {
        const baseline = { ...syntheticLogInput("1".repeat(64), { pids: BASE }), order: 1 };
        const copy = { ...baseline, sha256: "5".repeat(64), order: 2 };
        const candidate = { ...syntheticLogInput("3".repeat(64), { pids: CAND }), order: 3 };
        const a = verifiedTuneFromLogs([baseline, copy, candidate], AT);
        expect(a.record?.baselineRepeat).toBeNull();
        expect(a.reasons).toContain("verified_tune:no_baseline_repeat_m5a_floors_used");
    }, 600_000);

    it("the producer refuses a repeat that is the baseline or candidate log itself", () => {
        const v = record();
        const { id: _id, comparisons: _c, verdict: _v, reasons: _r, kind: _k, ...rest } = v;
        void _id;
        for (const repeat of [v.baseline, v.candidate]) {
            const again = buildVerifiedTune({
                ...rest,
                baselineRepeat: { sha256: repeat.sha256, logIndex: repeat.logIndex },
                axes: {},
                createdAt: AT,
            });
            expect(again.reasons).toContain("verified_tune:repeat_not_independent");
            const forged = { ...v, baselineRepeat: { sha256: repeat.sha256, logIndex: repeat.logIndex } };
            expect(verifiedTuneIssues(forged, { uid: FIXTURE_UID, firmware: FIXTURE_FIRMWARE })).toContain(
                "verified_tune:repeat_not_independent",
            );
        }
    });
});

describe("P1-02: import path", () => {
    function report(name: string, log: AutotuneLogInput) {
        mocks.logs.set(name, log);
        return {
            filename: name,
            logs: [{ headerPairs: log.headerPairs }],
            measurements: [],
        } as unknown as ChirpQualificationReport;
    }

    beforeEach(() => {
        setActivePinia(createPinia());
        localStorage.clear();
        mocks.logs.clear();
    });

    it("the same bytes under a second file name are not added as a second source", () => {
        const store = useAutotuneV2Store();
        const bytes = new Uint8Array([1, 2, 3, 4]);
        store.addSource(bytes, "flight.bbl", report("flight.bbl", syntheticLogInput("1".repeat(64))));
        store.addSource(
            bytes.slice(),
            "flight (copy).bbl",
            report("flight (copy).bbl", syntheticLogInput("1".repeat(64))),
        );
        expect(store.sources.map((s) => s.filename)).toEqual(["flight (copy).bbl"]);
    });

    it("two files carrying the same flight: Calculate finds no independent repeat and releases nothing", async () => {
        const store = useAutotuneV2Store();
        const log = syntheticLogInput("1".repeat(64));
        store.addSource(new Uint8Array([1]), "a.bbl", report("a.bbl", log));
        store.addSource(new Uint8Array([2]), "b.bbl", report("b.bbl", { ...log }));
        const v2 = useAutotuneV2();
        await v2.calculate();
        expect(store.state).toBe("done");
        // buildInputs keeps one of two logs with identical samples.
        expect(store.inputs).toHaveLength(1);
        expect(store.result!.crossLogPlant).toEqual({});
        expect(v2.releasedProposal()).toBeNull();
    }, 600_000);
});
