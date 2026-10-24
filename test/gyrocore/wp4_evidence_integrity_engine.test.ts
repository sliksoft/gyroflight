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
 * WP4 evidence integrity (audit F-03), engine side. A reference measurement the qualification did
 * not pass never validates the plant (P1-5), references that disagree block instead of the first
 * agreeing one deciding, a baseline repeat must match the baseline's whole configuration and its
 * scatter cannot widen the tolerance without bound (P1-4), and a calculation that was still running
 * when the files changed never publishes its result (P1-7).
 * (Synthetic logs: they exercise the code path, not the physics.)
 */

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutotuneLogInput } from "../../src/gyrocore/engine/autotuneV2";

const mocks = vi.hoisted(() => ({ logs: new Map<string, AutotuneLogInput>() }));
vi.mock("@/js/blackbox/m4_bbl_integration", () => ({ analyzeM4BblFile: () => ({ logs: [] }) }));
vi.mock("@/gyrocore/engine/logInput", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/gyrocore/engine/logInput")>()),
    buildLogInputs: (_bytes: Uint8Array, _sha: string, report: { filename: string }) => [
        mocks.logs.get(report.filename)!,
    ],
}));

import { runAutotuneV2 } from "../../src/gyrocore/engine/autotuneV2";
import { verifiedTuneFromLogs } from "../../src/gyrocore/engine/verifiedTuneFromLogs";
import { compareAxis, MAX_REPEAT_TOLERANCE_FACTOR } from "../../src/gyrocore/releaseGate/verifiedTune";
import { useAutotuneV2 } from "../../src/composables/useAutotuneV2";
import { useAutotuneV2Store } from "../../src/gyrocore/stores/autotuneV2";
import type { ChirpQualificationReport } from "../../src/gyrocore/chirp/qualification";
import { syntheticLogInput } from "./harness/syntheticLog";

const BASE: Record<string, [number, number, number]> = { roll: [56, 79, 30], pitch: [82, 117, 61], yaw: [56, 79, 0] };
const CAND = { roll: [50, 71, 21], pitch: [74, 105, 43], yaw: [50, 71, 0] } as Record<string, [number, number, number]>;

const primary = () => syntheticLogInput("1".repeat(64), { pids: BASE });
const withAxisState = (l: AutotuneLogInput, state: string): AutotuneLogInput => ({
    ...l,
    chirp: Object.fromEntries(Object.entries(l.chirp).map(([a, c]) => [a, { ...c!, state }])),
});
const withHeader = (l: AutotuneLogInput, key: string, value: string): AutotuneLogInput => ({
    ...l,
    headerPairs: l.headerPairs.map(([k, v]) => [k, k === key ? value : v] as const),
});

describe("P1-5: only a fully qualified reference measurement counts for the plant", () => {
    it("control: an independent usable reference of the same tune validates the plant", () => {
        const r = runAutotuneV2({
            primary: primary(),
            others: [syntheticLogInput("2".repeat(64), { pids: BASE })],
            verifiedTune: null,
        });
        expect(r.crossLogPlant.roll?.status).toBe("PASS");
        expect(r.parts.find((p) => p.part === "plant_identification")!.status).toBe("VALIDATED");
    }, 120_000);

    it.each(["rejected", "usable_with_warnings"])(
        "a reference sweep in state %s never validates it",
        (state) => {
            const ref = withAxisState(syntheticLogInput("2".repeat(64), { pids: BASE }), state);
            const r = runAutotuneV2({ primary: primary(), others: [ref], verifiedTune: null });
            expect(r.crossLogPlant.roll).toBeUndefined();
            expect(r.crossLogRejected).toContain(`cross_log_reference_not_qualified:${state}:${ref.sha256}:0`);
            expect(r.parts.find((p) => p.part === "plant_identification")!.status).not.toBe("VALIDATED");
        },
        120_000,
    );
});

describe("references that disagree block; the first agreeing one does not decide", () => {
    it("one reference agrees, another shows a different plant: FAIL, named", () => {
        const agree = syntheticLogInput("2".repeat(64), { pids: BASE });
        const other = syntheticLogInput("6".repeat(64), { pids: BASE, plantScale: 3 });
        const r = runAutotuneV2({ primary: primary(), others: [agree, other], verifiedTune: null });
        expect(r.crossLogPlant.roll?.status).toBe("FAIL");
        expect(r.crossLogRejected).toContain("cross_log_references_disagree:roll");
        expect(r.parts.find((p) => p.part === "plant_identification")!.status).not.toBe("VALIDATED");
    }, 120_000);
});

describe("P1-4: the baseline repeat", () => {
    it("a repeat with the same P/I/D/F but another filter configuration is not the baseline's repeat", () => {
        const repeat = withHeader(syntheticLogInput("2".repeat(64), { pids: BASE }), "gyro_lpf1_static_hz", "300");
        const attempt = verifiedTuneFromLogs([
            { ...syntheticLogInput("1".repeat(64), { pids: BASE }), order: 1 },
            { ...repeat, order: 2 },
            { ...syntheticLogInput("3".repeat(64), { pids: CAND }), order: 3 },
        ]);
        expect(attempt.record?.baselineRepeat).toBeNull();
        expect(attempt.reasons).toContain("verified_tune:repeat_rejected:cross_log_config_differs:gyro_lpf1_static_hz");
    }, 120_000);

    it(`a repeat scattering beyond ${MAX_REPEAT_TOLERANCE_FACTOR}× the floor cannot widen the tolerance: INSUFFICIENT`, () => {
        const attempt = verifiedTuneFromLogs([
            { ...syntheticLogInput("1".repeat(64), { pids: BASE }), order: 1 },
            { ...syntheticLogInput("2".repeat(64), { pids: BASE, plantScale: 2 }), order: 2 },
            { ...syntheticLogInput("3".repeat(64), { pids: CAND }), order: 3 },
        ]);
        expect(attempt.record?.baselineRepeat?.sha256).toBe("2".repeat(64));
        const roll = attempt.record!.comparisons.find((c) => c.axis === "roll")!;
        expect(roll.verdict).toBe("INSUFFICIENT");
        expect(roll.scatterCappedBins).toBeGreaterThan(0);
        expect(attempt.record!.verdict).toBe("FAIL");
    }, 120_000);

    it("control: a close repeat sets a tolerance and the record passes", () => {
        const attempt = verifiedTuneFromLogs([
            { ...syntheticLogInput("1".repeat(64), { pids: BASE }), order: 1 },
            { ...syntheticLogInput("2".repeat(64), { pids: BASE }), order: 2 },
            { ...syntheticLogInput("3".repeat(64), { pids: CAND }), order: 3 },
        ]);
        expect(attempt.record!.verdict).toBe("PASS");
        expect(attempt.record!.comparisons.every((c) => c.scatterCappedBins === 0)).toBe(true);
        expect(typeof compareAxis).toBe("function");
    }, 120_000);
});

describe("P1-7: a calculation still running when the files change never publishes", () => {
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
        mocks.logs.clear();
    }, 120_000);

    it("a file added while Calculate awaits: no result, no inputs from the old list", async () => {
        importLog("a.bbl", syntheticLogInput("1".repeat(64), { pids: BASE }));
        const v2 = useAutotuneV2();
        const running = v2.calculate();
        importLog("second.bbl", syntheticLogInput("2".repeat(64), { pids: BASE }));
        await running;
        const store = useAutotuneV2Store();
        expect(store.result).toBeNull();
        expect(store.inputs).toBeNull();
        expect(store.state).toBe("idle");
        // Calculate on the current files works as usual.
        await v2.calculate();
        expect(store.state).toBe("done");
        expect(store.inputs!.map((l) => l.sha256).sort()).toEqual(["1".repeat(64), "2".repeat(64)]);
    }, 120_000);

    it("reset while Calculate awaits: nothing is published", async () => {
        importLog("a.bbl", syntheticLogInput("1".repeat(64), { pids: BASE }));
        const running = useAutotuneV2().calculate();
        useAutotuneV2Store().reset();
        await running;
        expect(useAutotuneV2Store().result).toBeNull();
        expect(useAutotuneV2Store().state).toBe("idle");
    }, 120_000);
});
