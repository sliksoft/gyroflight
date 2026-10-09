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
 * LOCAL ONLY (WU2): the real AIR65 three-log CHIRP flight through Gyroflight's
 * Autotune import, with GyroCore's qualification in front of Betaflight's
 * recommendation. Skipped unless GYROFLIGHT_AIR65_BBL is set (see
 * air65_blackbox.local.test.ts); GYROFLIGHT_AIR65_REF_DIR adds the comparison
 * with GyroCore's reference verdicts (golden_log{0,1,2}.json.gz).
 *
 * Nothing here names AIR65-specific reasons: the measurements must fail
 * through the generic gates, and agree with GyroCore's own verdicts.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createPinia, setActivePinia } from "pinia";
import { describe, expect, it, vi } from "vitest";
import { AIR65_SHA256, localAir65, readJsonFile, sha256, writeReport } from "./harness/fixtures";

const msp = vi.hoisted(() => ({ calls: [] as number[] }));
const picked = vi.hoisted(() => ({ bytes: new Uint8Array() as Uint8Array }));

vi.mock("../../src/js/FileSystem", () => ({
    default: {
        pickOpenFile: async () => ({ name: "air65.bbl" }),
        readFileAsBlob: async () => ({ arrayBuffer: async () => picked.bytes.slice().buffer }),
    },
}));
vi.mock("../../src/js/localization", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/js/localization")>()),
    i18n: { getMessage: (key: string) => key },
}));
vi.mock("../../src/js/msp", () => ({
    default: {
        promise: vi.fn(async (code: number) => {
            msp.calls.push(code);
            return null;
        }),
    },
}));

import { useAutotune } from "../../src/composables/useAutotune";
import { useAutotuneStore } from "../../src/stores/autotune";
import { ApplyBlockedError } from "../../src/gyrocore/chirp/applyGate";
import { useChirpQualificationStore } from "../../src/gyrocore/stores/chirpQualification";

const air65 = localAir65();

interface GoldenLog {
    bbl_sha256: string;
    log_index: number;
    result: {
        axes: Record<
            string,
            { quality: { failed_gates: string[]; mean_band_coherence: number | null }; usable: boolean }
        >;
        extraction: { segments: { axis: number; sample_count: number }[] } | null;
    };
}

describe.skipIf(!air65)("AIR65 through the GyroCore CHIRP gate (local only)", () => {
    const bytes = air65?.bbl ?? new Uint8Array();

    it("uses the exact AIR65 fixture", () => {
        expect(sha256(bytes)).toBe(AIR65_SHA256);
    });

    it("finds every log and segment, qualifies none for tuning, and keeps Apply blocked", async () => {
        setActivePinia(createPinia());
        picked.bytes = bytes;
        await useAutotune().importAndAnalyze();
        const store = useAutotuneStore();
        const gate = useChirpQualificationStore();
        const report = gate.report!;

        // All embedded logs considered, all five sweeps found.
        expect(report.decoder).toBe("betaflight-blackbox-viewer");
        expect(report.logCount).toBe(3);
        expect(report.logs.map((l) => l.error)).toEqual([null, null, null]);
        expect(report.measurements).toHaveLength(5);

        const goldens = [0, 1, 2].map((i) => {
            const p = air65?.refDir ? join(air65.refDir, `golden_log${i}.json.gz`) : null;
            return p && existsSync(p) ? readJsonFile<GoldenLog>(p) : null;
        });
        for (const [i, gold] of goldens.entries()) {
            if (!gold) {
                continue;
            }
            expect(gold.bbl_sha256).toBe(AIR65_SHA256);
            const mine = report.logs[i].measurements;
            expect(mine.map((m) => [m.axis, m.sampleCount])).toEqual(
                gold.result.extraction!.segments.map((s) => [s.axis, s.sample_count]),
            );
            for (const [axisName, g] of Object.entries(gold.result.axes)) {
                const m = mine.filter((x) => x.axisName === axisName).at(-1)!;
                expect(new Set(m.quality.failedGates)).toEqual(new Set(g.quality.failed_gates));
                expect(Math.abs(m.quality.meanBandCoherence! - g.quality.mean_band_coherence!)).toBeLessThan(1e-9);
                expect(m.quality.usable).toBe(g.usable);
            }
        }

        let eligible = 0;
        for (const m of report.measurements) {
            if (m.apply.allowed) {
                eligible++;
            }
            // Rejected by a generic measurement gate, never by name.
            expect(m.state).toBe("rejected");
            expect(m.quality.failedGates.length).toBeGreaterThan(0);
            expect(m.apply.blocked.some((r) => r.startsWith("measurement:"))).toBe(true);
            // No recommendation is produced for a rejected measurement ...
            expect(m.recommendation).toBeNull();
            // ... but Betaflight's math still gives diagnostics.
            expect(m.diagnostics?.transferFunction.frequencies.length).toBeGreaterThan(0);
            expect(m.diagnostics?.spectrogram).toBeTruthy();
        }
        expect(eligible).toBe(0);

        // The plots show diagnostics, the gain table has nothing to offer.
        expect(store.analysisState).toBe("done");
        expect(report.state).toBe("rejected");
        for (const axis of Object.values(store.analysisResult!.axes)) {
            expect(axis?.gains).toBeNull();
        }

        // Apply stays blocked for every measurement, even called directly.
        const sliders = {
            slider_master_multiplier: 125,
            slider_pi_gain: 50,
            slider_i_gain: 40,
            slider_d_gain: 100,
            slider_feedforward_gain: 25,
            slider_dterm_filter_multiplier: 50,
        };
        for (const m of report.measurements) {
            const err = await useAutotune()
                .applyGains(sliders, m.id)
                .then(
                    () => null,
                    (e: unknown) => e,
                );
            expect(err).toBeInstanceOf(ApplyBlockedError);
        }
        expect(msp.calls).toEqual([]);

        // WU3: no global (composite) recommendation in any log, and Apply by composite is blocked too.
        let composites = 0;
        const compositeSummary = [];
        for (const log of report.logs) {
            gate.selectLog(log.logIndex);
            const composite = gate.composite!;
            expect(composite.authorized).toBe(false);
            expect(composite.final).toBeNull();
            if (composite.final) {
                composites++;
            }
            compositeSummary.push({
                logIndex: log.logIndex,
                merge: composite.merge.status,
                blocked: composite.blocked,
            });
            const err = await useAutotune()
                .applyGains(sliders, composite.id)
                .then(
                    () => null,
                    (e: unknown) => e,
                );
            expect(err).toBeInstanceOf(ApplyBlockedError);
        }
        expect(composites).toBe(0);
        expect(msp.calls).toEqual([]);
        writeReport("air65_composite", compositeSummary);

        writeReport(
            "air65_qualification",
            report.measurements.map((m) => ({
                id: m.id,
                axis: m.axisName,
                samples: m.sampleCount,
                durationS: m.durationS,
                rateHz: m.sampleRate.effectiveRateHz,
                state: m.state,
                failedGates: m.quality.failedGates,
                warningGates: m.quality.warningGates,
                meanBandCoherence: m.quality.meanBandCoherence,
                applyBlocked: m.apply.blocked,
            })),
        );
    }, 600_000);
});
