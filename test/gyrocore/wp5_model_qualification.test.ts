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
 * WP5 (audit P1-3): the model-class qualification producer (engine/modelQualification.ts). It
 * picks an independent flight and gives it the finer identification its own samples support; the
 * verdict stays loopModel's; its output is shown, never handed to the release contract or Apply.
 * SIMULATION logs only: contract logic, never flight evidence.
 */

import { describe, expect, it } from "vitest";
import {
    controllerConfigFromHeaders,
    runAutotuneV2,
    type AutotuneLogInput,
} from "../../src/gyrocore/engine/autotuneV2";
import { crossLogReferenceIssues, finestWelchSegment } from "../../src/gyrocore/engine/logInput";
import { dtermConfigFromHeaders } from "../../src/js/blackbox/betaflight_dterm_dynamic";
import { assessModelQualification, qualificationCandidates } from "../../src/gyrocore/engine/modelQualification";
import { UNCERTAINTY } from "../../src/gyrocore/engine/loopModel";
import { simulatedQualificationLog, syntheticLogInput } from "./harness/syntheticLog";
import { verifiedTuneAllAxesFixture } from "./harness/verifiedTuneFixture";

const primary = syntheticLogInput("1".repeat(64));
/** SIMULATION: an independent flight whose CHIRP windows carry a finer Welch identification. */
const withFine = (l: AutotuneLogInput): AutotuneLogInput => ({
    ...l,
    chirp: Object.fromEntries(
        Object.entries(l.chirp).map(([a, c]) => [a, { ...c!, fine: { tf: c!.tf, analysis: c!.analysis! } }]),
    ),
});
const QUAL = withFine(simulatedQualificationLog());

describe("the finest Welch segment a window supports", () => {
    it("the longest power of two with at least the minimum segments at 50 % overlap", () => {
        // AIR65: a 20 s sweep at 4 kHz.
        expect(finestWelchSegment(80000)).toBe(16384);
        const n = finestWelchSegment(80000)!;
        expect(80000).toBeGreaterThanOrEqual((n * (UNCERTAINTY.minWelchSegments + 1)) / 2);
        expect(80000).toBeLessThan((2 * n * (UNCERTAINTY.minWelchSegments + 1)) / 2);
        expect(finestWelchSegment(1000)).toBeNull();
    });
});

describe("the producer picks an independent flight and lets the engine decide", () => {
    it("SIMULATION: a finer independent flight qualifies the bounds; the report says so, criterion by criterion", () => {
        const { result, report } = assessModelQualification({
            primary,
            others: [QUAL],
            verifiedTune: verifiedTuneAllAxesFixture(0.9, 0.7),
            createdAt: "2026-10-24T00:00:00Z",
        });
        expect(report.source).toEqual({ sha256: QUAL.sha256, logIndex: 0 });
        expect(report.connectedToApply).toBe(false);
        expect(report.axes.map((a) => a.level)).toEqual(["VALIDATED", "VALIDATED", "VALIDATED"]);
        expect(report.axes.every((a) => a.verdict === "PASS")).toBe(true);
        const c = Object.fromEntries(report.criteria.map((x) => [x.name, x.status]));
        expect(c).toMatchObject({
            identifiability: "PASS",
            frequency_coverage: "PASS",
            independent_evidence: "PASS",
            uncertainty: "PASS",
            margin_applicability: "PASS",
            independent_validation: "PASS",
            // An assumption narrowed, never removed.
            model_structure: "NOT_VALIDATED",
        });
        // The qualification flight is not also the plant's reference: one flight, one piece of evidence.
        expect(result!.crossLogRejected).toContain(`cross_log_reference_is_the_qualification:${QUAL.sha256}:0`);
        expect(c.reference_quality).toBe("NOT_VALIDATED");
    }, 600_000);

    it("without the finer analysis nothing qualifies (the standard bins are never finer)", () => {
        const plain = simulatedQualificationLog();
        const { report } = assessModelQualification({ primary, others: [plain], verifiedTune: null });
        expect(report.source).toBeNull();
        expect(report.candidates[0].rejected).toContain("qualification_no_usable_axis_with_finer_analysis");
    }, 600_000);

    it("a flight whose independence is unproven, of other firmware, or with a rejected sweep never serves", () => {
        // Three separate flights (distinct samples), each failing one rule.
        const flight = (seed: string) =>
            withFine(
                syntheticLogInput(seed.repeat(32), {
                    seconds: 46,
                    binStepHz: 0.1,
                    maxHz: 160,
                    welch: { segments: 8, windowS: 45 },
                }),
            );
        const fragment = { ...flight("a1"), session: { firstIteration: 4000, startDatetime: null } };
        const base = flight("b2");
        const otherFw = {
            ...base,
            headerPairs: base.headerPairs.map(
                ([k, v]) => [k, k === "Firmware revision" ? "Betaflight 2026.12.0 (x) STM32G474" : v] as const,
            ),
        };
        const r0 = flight("c3");
        const rejected = {
            ...r0,
            chirp: Object.fromEntries(Object.entries(r0.chirp).map(([a, c]) => [a, { ...c!, state: "rejected" }])),
        };
        const { all, best } = qualificationCandidates({ primary, others: [fragment, otherFw, rejected] });
        expect(best).toBeNull();
        expect(all[0].rejected).toContain(
            `cross_log_independence_unproven:session_start_not_in_log:${fragment.sha256}:0`,
        );
        expect(all[1].rejected).toContain("cross_log_other_firmware");
        expect(all[2].rejected).toContain("qualification_axis_not_qualified:roll:rejected");
    }, 600_000);

    it("the primary's own flight under another name never qualifies itself", () => {
        const copy = withFine({ ...primary, sha256: "d4".repeat(32), channels: structuredClone(primary.channels) });
        const { best, all } = qualificationCandidates({ primary, others: [copy] });
        expect(best).toBeNull();
        expect(all[0].rejected[0]).toBe(`cross_log_duplicate_of_primary:${copy.sha256}:0`);
    });

    it("a finer flight over the same band only (P1-2) is INSUFFICIENT: the bounds stay MODEL_CONDITIONAL", () => {
        const narrow = withFine(
            syntheticLogInput("e5".repeat(32), { seconds: 46, binStepHz: 0.1, welch: { segments: 8, windowS: 45 } }),
        );
        const { report } = assessModelQualification({ primary, others: [narrow], verifiedTune: null });
        expect(report.source?.sha256).toBe(narrow.sha256);
        expect(report.axes.every((a) => a.verdict === "INSUFFICIENT" && a.level === "MODEL_CONDITIONAL")).toBe(true);
        expect(report.criteria.find((c) => c.name === "frequency_coverage")!.status).toBe("FAIL");
    }, 600_000);

    it("the engine without the producer: the same inputs stay MODEL_CONDITIONAL (what the app publishes)", () => {
        const r = runAutotuneV2({ primary, others: [QUAL], verifiedTune: verifiedTuneAllAxesFixture(0.9, 0.7) });
        for (const m of Object.values(r.margins)) expect(m!.current.evidence.level).toBe("MODEL_CONDITIONAL");
        expect(r.releasableProposal).toBeNull();
    }, 600_000);
});

describe("WP8 review: what a qualification flight must itself show", () => {
    it("its controller must be reconstructed with a validated D path (no logged D term: not used)", () => {
        const noD = { ...QUAL, sha256: "f6".repeat(32), channels: { ...QUAL.channels, axisD: null } };
        const r = runAutotuneV2({ primary, others: [], verifiedTune: null, modelClassQualification: noD });
        const part = r.parts.find((p) => p.part === "phase_margin_robustness")!;
        expect(part.reasons).toContain("model_class_qualification_rejected:dterm_path_not_validated:roll");
        expect(r.margins.roll!.current.evidence.qualification).toBeNull();
    }, 600_000);

    it("its finer analysis must itself be coherent over the sweep (not only the standard one)", () => {
        const incoherent = {
            ...QUAL,
            sha256: "a7".repeat(32),
            chirp: Object.fromEntries(
                Object.entries(QUAL.chirp).map(([a, c]) => {
                    const tf = { ...c!.fine!.tf, coherence: c!.fine!.tf.coherence.map(() => 0.5) };
                    return [a, { ...c!, fine: { tf, analysis: c!.fine!.analysis } }];
                }),
            ),
        };
        const { all } = qualificationCandidates({ primary, others: [incoherent as AutotuneLogInput] });
        expect(all[0].rejected.some((r) => r.startsWith("qualification_axis_fine_analysis_not_coherent:roll:"))).toBe(
            true,
        );
    });

    it("the whole configuration the models read must match (e.g. rpm_filter_lpf_hz, gyro_lpf1_dyn_expo)", () => {
        for (const [key, value] of [
            ["rpm_filter_lpf_hz", "77"],
            ["gyro_lpf1_dyn_expo", "9"],
        ] as const) {
            const other = {
                ...QUAL,
                headerPairs: [...QUAL.headerPairs.filter(([k]) => k !== key), [key, value] as const],
            };
            expect(crossLogReferenceIssues(primary, other)).toContain(`cross_log_config_differs:${key}`);
        }
    });

    it("every header the controller and D-path reconstruction read is part of the comparison", () => {
        const h = Object.fromEntries(QUAL.headerPairs);
        const read = new Set<string>();
        const recording = new Proxy(h, {
            get: (t, k) => {
                if (typeof k === "string") read.add(k);
                return t[k as string];
            },
        });
        for (const axis of [0, 1, 2] as const) {
            const base = controllerConfigFromHeaders(recording, axis);
            expect(base).not.toBeNull();
            dtermConfigFromHeaders(recording, axis, base!.pidDt);
        }
        // The sweep settings shape the measurement, not the model: a repeat may sweep differently.
        const measurement = /^chirp_(frequency_start_deci_hz|frequency_end_deci_hz|time_seconds)$/;
        const keys = [...read].filter((k) => !measurement.test(k));
        expect(keys).toEqual(expect.arrayContaining(["tpa_low_rate", "d_max_gain", "looptime"]));
        for (const key of keys) {
            const changed = h[key] === undefined ? "1" : h[key].replace(/\d+/, (d) => String(Number(d) + 1));
            const other = {
                ...QUAL,
                headerPairs: [...QUAL.headerPairs.filter(([k]) => k !== key), [key, changed] as const],
            };
            expect(
                crossLogReferenceIssues(primary, other).some((r) => r.startsWith("cross_log_config_differs:")),
                key,
            ).toBe(true);
        }
    });

    it("a missing D header leaves no D path, and no D path is no validated one (tpa_low_always removed)", () => {
        const noTpaLow = {
            ...QUAL,
            sha256: "e5".repeat(32),
            headerPairs: QUAL.headerPairs.filter(([k]) => k !== "tpa_low_always"),
        };
        const h = Object.fromEntries(noTpaLow.headerPairs);
        const base = controllerConfigFromHeaders(h, 0)!;
        expect(base.axis.d).toBeGreaterThan(0);
        expect(dtermConfigFromHeaders(h, 0, base.pidDt)).toBeNull();
        // The configurations differ, so the identity rules reject it already; the guard must hold on its own too.
        const asPrimary = { ...primary, headerPairs: primary.headerPairs.filter(([k]) => k !== "tpa_low_always") };
        const r = runAutotuneV2({
            primary: asPrimary,
            others: [],
            verifiedTune: null,
            modelClassQualification: noTpaLow,
        });
        const part = r.parts.find((p) => p.part === "phase_margin_robustness")!;
        expect(part.reasons).toContain("model_class_qualification_rejected:dterm_path_not_validated:roll");
    }, 600_000);
});
