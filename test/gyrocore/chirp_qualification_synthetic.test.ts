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
 * WU2 synthetic regression: the GyroCore qualification layer in front of
 * Betaflight Autotune, on the 20 WU7 CHIRP logs, against GyroCore's reference
 * verdicts (bbl_golden.json.gz). Input comes from the Blackbox Viewer decode;
 * the transfer function is Betaflight's; the gates are GyroCore's.
 */

import { describe, expect, it, vi } from "vitest";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { qualifyChirpFile, type ChirpQualificationReport } from "../../src/gyrocore/chirp/qualification";
import { readFixtureBytes, readFixtureJson } from "./harness/fixtures";

vi.mock("../../src/js/localization", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/js/localization")>()),
    i18n: { getMessage: (key: string) => key },
}));

interface GoldenAxis {
    segment: { start_idx: number; end_idx: number; sample_count: number };
    effective_rate_hz: number | null;
    sample_rate: { status: string };
    quality: {
        usable: boolean;
        failed_gates: string[];
        warning_gates: string[];
        mean_band_coherence: number | null;
        usable_bin_count: number;
        usable_range_hz: [number, number] | null;
    };
    usable: boolean;
}

interface GoldenCase {
    result: {
        status: string;
        errors: string[];
        axes: Record<string, GoldenAxis>;
        extraction: { segments: { axis: number; start_idx: number; end_idx: number; sample_count: number }[] } | null;
    };
}

const cases = readFixtureJson<{ cases: { case_id: string }[] }>("chirp/cases.json").cases.map((c) => c.case_id);
const golden = readFixtureJson<{ cases: Record<string, GoldenCase> }>("chirp/bbl_golden.json.gz").cases;

const reports = new Map<string, ChirpQualificationReport>();
function qualify(caseId: string) {
    if (!reports.has(caseId)) {
        const bytes = readFixtureBytes(`chirp/bbl/${caseId}.bbl.gz`);
        reports.set(caseId, qualifyChirpFile(bytes, caseId, 60, AUTOTUNE_MATH));
    }
    return reports.get(caseId)!;
}

/** Cases upstream Betaflight Autotune accepts but GyroCore rejects (WU1). */
const UPSTREAM_UNSAFE: Record<string, string[]> = {
    poor_coherence: ["low_coherence", "unusable_frequency_range"],
    weak_excitation: ["insufficient_excitation"],
    dropped_timestamps: ["excessive_gaps"],
    pnum_pdenom: ["non_uniform_sampling"],
};

describe("GyroCore qualification reproduces GyroCore's verdicts on Viewer-decoded samples", () => {
    it("covers all 20 synthetic cases", () => {
        expect(cases).toHaveLength(20);
    });

    for (const caseId of cases) {
        it(caseId, () => {
            const report = qualify(caseId);
            const gold = golden[caseId].result;
            expect(report.decoder).toBe("betaflight-blackbox-viewer");
            expect(report.logCount).toBe(1);

            if (gold.status === "error") {
                // Malformed logs: same error, no measurement, never "usable".
                expect(report.logs[0].error).toBe(gold.errors[0]);
                expect(report.measurements).toHaveLength(0);
                expect(report.state).toBe("no_chirp");
                return;
            }

            // Every segment GyroCore extracts, none dropped or replaced.
            const segs = gold.extraction!.segments;
            expect(report.measurements.map((m) => [m.axis, m.sampleCount])).toEqual(
                segs.map((s) => [s.axis, s.sample_count]),
            );

            for (const [axisName, g] of Object.entries(gold.axes)) {
                // GyroCore analysed the last segment of each axis; that one must match exactly.
                const m = report.measurements.filter((x) => x.axisName === axisName).at(-1)!;
                expect(m.sampleCount).toBe(g.segment.sample_count);
                expect(m.sampleRate.status).toBe(g.sample_rate.status);
                expect(m.sampleRate.effectiveRateHz).toBe(g.effective_rate_hz);
                expect(new Set(m.quality.failedGates)).toEqual(new Set(g.quality.failed_gates));
                expect(m.quality.warningGates).toEqual(g.quality.warning_gates);
                expect(m.quality.usable).toBe(g.quality.usable);
                expect(m.quality.usableBinCount).toBe(g.quality.usable_bin_count);
                if (g.quality.mean_band_coherence === null) {
                    expect(m.quality.meanBandCoherence).toBeNull();
                } else {
                    expect(Math.abs(m.quality.meanBandCoherence! - g.quality.mean_band_coherence)).toBeLessThan(1e-9);
                }
                if (g.quality.usable_range_hz) {
                    expect(m.quality.usableRangeHz).toEqual(g.quality.usable_range_hz);
                }
                const expectedState = !g.usable
                    ? "rejected"
                    : g.quality.warning_gates.length
                      ? "usable_with_warnings"
                      : "usable";
                expect(m.state).toBe(expectedState);
            }
        });
    }
});

describe("overall state matches GyroCore's overall status", () => {
    const STATUS_TO_STATE: Record<string, string> = {
        ok: "usable",
        usable_with_warnings: "usable_with_warnings",
        unusable: "rejected",
        error: "no_chirp",
    };
    // GyroCore warns on repeated segments because it discards all but the last; nothing is discarded here.
    const EXCEPTIONS: Record<string, string> = { repeated_axis: "usable" };

    for (const caseId of cases) {
        it(caseId, () => {
            const expected = EXCEPTIONS[caseId] ?? STATUS_TO_STATE[golden[caseId].result.status];
            expect(qualify(caseId).state).toBe(expected);
        });
    }

    it("repeated_axis is the only documented exception", () => {
        expect(golden.repeated_axis.result.status).toBe("usable_with_warnings");
        expect(Object.keys(EXCEPTIONS)).toEqual(["repeated_axis"]);
    });
});

describe("measurements upstream accepts but GyroCore rejects stay rejected", () => {
    for (const [caseId, gates] of Object.entries(UPSTREAM_UNSAFE)) {
        it(caseId, () => {
            const report = qualify(caseId);
            expect(report.state).toBe("rejected");
            const [m] = report.measurements;
            expect(m.state).toBe("rejected");
            for (const gate of gates) {
                expect(m.quality.failedGates).toContain(gate);
                expect(m.apply.blocked).toContain(`measurement:${gate}`);
            }
            // No Betaflight recommendation is produced, so there is nothing to apply.
            expect(m.recommendation).toBeNull();
            expect(m.apply.allowed).toBe(false);
            // Betaflight's math still ran: diagnostics only.
            expect(m.diagnostics?.transferFunction.frequencies.length).toBeGreaterThan(0);
        });
    }

    it("pnum_pdenom: Betaflight's header-only rate is flagged as a broken sample-rate contract", () => {
        const [m] = qualify("pnum_pdenom").measurements;
        expect(Math.round(m.betaflightRateHz)).toBe(667);
        expect(m.sampleRate.effectiveRateHz).toBe(1000);
        expect(m.apply.blocked).toEqual(
            expect.arrayContaining([
                "sample_rate_contract:mismatch",
                "sample_rate_contract:betaflight_header_rate_differs",
            ]),
        );
    });

    it("malformed_missing_rate_headers stays fail-safe: no Apply on a timestamp-only rate", () => {
        const report = qualify("malformed_missing_rate_headers");
        const [m] = report.measurements;
        // GyroCore can measure it (timestamps), Betaflight would assume 8 kHz.
        expect(m.state).toBe("usable_with_warnings");
        expect(m.sampleRate.status).toBe("timestamp_only");
        expect(Math.round(m.betaflightRateHz)).toBe(8000);
        expect(m.apply.allowed).toBe(false);
        expect(m.apply.blocked).toEqual(
            expect.arrayContaining([
                "sample_rate_contract:timestamp_only",
                "sample_rate_contract:betaflight_header_rate_differs",
            ]),
        );
    });

    it("no synthetic measurement GyroCore rejects becomes eligible, and none is applicable", () => {
        let unsafeAccepted = 0;
        for (const caseId of cases) {
            const gold = golden[caseId].result;
            for (const m of qualify(caseId).measurements) {
                const g = gold.axes[m.axisName];
                const gyrocoreRejects = gold.status === "error" || !g?.usable;
                if (gyrocoreRejects && (m.state !== "rejected" || m.recommendation || m.apply.allowed)) {
                    unsafeAccepted++;
                }
                // None of the WU7 logs records the slider headers, so none may be applied.
                expect(m.apply.allowed).toBe(false);
                expect(m.apply.blocked).toContain("current_tune_missing:pi_gain");
            }
        }
        expect(unsafeAccepted).toBe(0);
    });
});

describe("log-level extraction warnings reach every measurement of the log", () => {
    it("corrupt_axis_frames: dropped axis frames qualify the measurement and are listed for Apply", () => {
        const [m] = qualify("corrupt_axis_frames").measurements;
        expect(m.logWarnings).toContain("chirp_axis_out_of_range_frames_dropped");
        expect(m.state).toBe("usable_with_warnings");
        expect(m.apply.warnings).toContain("log:chirp_axis_out_of_range_frames_dropped");
    });
});

describe("multiple segments on the same axis", () => {
    it("repeated_axis keeps both roll sweeps as separate measurements", () => {
        const report = qualify("repeated_axis");
        const roll = report.measurements.filter((m) => m.axisName === "roll");
        expect(roll).toHaveLength(2);
        expect(roll.map((m) => m.id)).toEqual(["log1-seg1", "log1-seg2"]);
        expect(roll.map((m) => m.axisOccurrence)).toEqual([1, 2]);
        expect(roll[0].startTimeUs).toBeLessThan(roll[1].startTimeUs);
        for (const m of roll) {
            expect(m.state).toBe("usable");
            expect(m.diagnostics).not.toBeNull();
        }
        expect(report.logs[0].extractionWarnings).toContain("repeated_axis_segments_all_kept");
    });
});
