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
 * Codex final acceptance review, F-02 (remaining part): bounds read on discrete bins hold only for
 * a model class (no loop feature narrower than RESOLVED_FEATURE_BINS × resolutionHz). They may not
 * reach the release contract as unconditional VALIDATED evidence. loopModel MarginEvidence now
 * carries level, resolution, band, assumptions and qualification; releaseContract gates
 * phase_margin and robustness on the same evidence check (marginEvidenceIssues), fail-closed.
 *
 * Every plant here is a SIMULATION (analytic plant or the synthetic log harness): software-contract
 * evidence only, never AIR65 or any other flight evidence. The independent reference for the
 * narrow resonance is the exact analytic |L(fr)|.
 */

import { describe, expect, it } from "vitest";
import {
    air65RollConfig,
    cdiv,
    cmag,
    cmul,
    evaluateControllerFrf,
    type Complex,
} from "../../src/js/blackbox/betaflight_digital_controller";
import { closedLoopFromPlant, plantFrf, syntheticTransferFunction } from "../../src/js/blackbox/betaflight_open_loop";
import {
    buildAxisLoop,
    loopMargins,
    marginEvidenceIssues,
    RESOLVED_FEATURE_BINS,
    type LoopMargins,
    type MarginEvidence,
} from "../../src/gyrocore/engine/loopModel";
import type { EffectiveChain } from "../../src/gyrocore/engine/gyroChain";
import { optimizeAxisPid } from "../../src/gyrocore/engine/pidOptimizer";
import { runAutotuneV2, type AutotuneV2Result } from "../../src/gyrocore/engine/autotuneV2";
import {
    assertAbsoluteReleased,
    evaluateRelease,
    type AbsoluteProposal,
    type AxisMargins,
} from "../../src/gyrocore/releaseGate/releaseContract";
import { simulatedQualificationLog, syntheticLogInput } from "./harness/syntheticLog";
import { simulatedQualifiedEvidence, SIMULATED_QUALIFICATION_SHA } from "./harness/marginEvidenceFixture";
import { verifiedTuneAllAxesFixture } from "./harness/verifiedTuneFixture";

const UNITY_CHAIN: EffectiveChain = {
    samples: 1,
    frf: () => ({ re: 1, im: 0 }),
    spread: () => ({ phaseDeg: 0, gainDb: 0 }),
    medianLpf1Hz: 0,
    dynNotchHz: [],
};
const cfg = air65RollConfig();
type G = (f: number) => Complex;
const smooth: G = (f) => plantFrf(f, { K: 30, motorHz: 40, delayS: 0.002 });
/** Stable 2nd-order pole/zero pair at fr (the Codex probe's narrow resonance). */
const poleZero =
    (fr: number, zZero: number, zPole: number): G =>
    (f) => {
        const x = f / fr;
        return cmul(smooth(f), cdiv({ re: 1 - x * x, im: 2 * zZero * x }, { re: 1 - x * x, im: 2 * zPole * x }));
    };
const NARROW = poleZero(70.25, 0.0005, 0.00005);
const uniform = (end: number, step: number) => Array.from({ length: Math.round(end / step) }, (_, i) => (i + 1) * step);
const tfOf = (freqs: number[], g: G) =>
    syntheticTransferFunction(freqs, (f) => {
        const c = evaluateControllerFrf(cfg, f);
        return closedLoopFromPlant(g(f), c.cReference, c.cFeedback);
    });
const SOURCE = { sha256: SIMULATED_QUALIFICATION_SHA, logIndex: 0 };
const PRIMARY_LOG = { sha256: "d".repeat(64), logIndex: 0, headerPairs: [] as [string, string][] };
/** Chain validated, steady, attested: only the margin evidence is left open. */
function margins(freqs: number[], g: G, fine: { freqs: number[]; g: G } | null = null): LoopMargins {
    const q = fine ? { tf: tfOf(fine.freqs, fine.g), source: SOURCE, analysis: welchOf(fine.freqs) } : null;
    return loopMargins(buildAxisLoop(0, tfOf(freqs, g), cfg, UNITY_CHAIN, true, true, q));
}
/** SIMULATION: the Welch analysis a synthetic grid claims (its step from 4 kHz segments, 32 of them). */
function welchOf(freqs: number[]) {
    const segmentSamples = Math.round(4000 / (freqs[1] - freqs[0]));
    return { segmentSamples, sampleRateHz: 4000, windowSamples: (segmentSamples * 33) / 2, segments: 32 };
}
/** AxisMargins exactly as autotuneV2 builds them from loopMargins. */
const axisMargins = (m: LoopMargins, axis: AxisMargins["axis"] = "roll"): AxisMargins => ({
    axis,
    status: m.status,
    phaseMarginDeg: m.phaseMarginDeg,
    gainMarginDb: m.gainMarginDb,
    sensitivityPeakDb: m.sensitivityPeakDb,
    measured: m.measured,
    evidence: m.evidence,
    reasons: m.reasons,
});
/** A proposal whose every other condition holds: only phase_margin and robustness can block. */
function marginOnlyProposal(ms: AxisMargins[]): AbsoluteProposal {
    return {
        id: "p",
        createdAt: "2026-10-23T00:00:00Z",
        log: PRIMARY_LOG,
        change: { p_roll: 1 },
        items: [{ key: "p_roll", part: "pid", from: 0, to: 1, status: "VALIDATED", reasons: [] }],
        release: {
            measurement: { valid: true, reasons: [] },
            model: { status: "VALIDATED", reasons: [] },
            margins: ms,
            independentValidation: null,
            safetyAnalysisEvidence: "available",
            safetyReasons: [],
        },
    };
}
const conditions = (p: AbsoluteProposal) => Object.fromEntries(evaluateRelease(p).conditions.map((c) => [c.name, c]));
const MODEL_CLASS_NEED = "required_measurement:chirp_finer_resolution_model_class_qualification";

describe("F-02 evidence: the Codex counterexample (70.25 Hz, ζ 5e-4 / 5e-5)", () => {
    const exact = cmag(cmul(NARROW(70.25), evaluateControllerFrf(cfg, 70.25).cFeedback));

    it("1. the 0.5 Hz grid stays visible as analysis but is MODEL_CONDITIONAL and releases nothing", () => {
        expect(exact).toBeGreaterThan(2); // the loop really is above unity at fr
        const m = margins(uniform(200, 0.5), NARROW);
        // The analysis is kept (the same numbers as before the fix) ...
        expect(m.measured.phaseMarginDeg!).toBeCloseTo(86.66, 1);
        expect(m.gainMarginDb!).toBeCloseTo(12.94, 1);
        expect(m.sensitivityPeakDb!).toBeCloseTo(2.73, 1);
        // The PM bound includes the between-bin allowance: never above the reading.
        expect(m.phaseMarginDeg!).toBeLessThanOrEqual(m.measured.phaseMarginDeg!);
        // ... with its basis explicit ...
        expect(m.evidence.level).toBe("MODEL_CONDITIONAL");
        expect(m.evidence.resolutionHz).toBeCloseTo(0.5, 9);
        expect(m.evidence.bandHz).toEqual([2, 200]); // the identified band (plant bins from 2 Hz)
        expect(m.evidence.minFeatureWidthHz).toBeCloseTo(RESOLVED_FEATURE_BINS * 0.5, 9);
        expect(m.evidence.assumptions).toContain("no_loop_feature_narrower_than:2.26Hz");
        expect(m.evidence.qualification).toBeNull();
        expect(m.reasons).toEqual(["model_class_not_qualified", "model_class_qualification_missing", MODEL_CLASS_NEED]);
        // ... and not VALIDATED: neither phase_margin nor robustness passes on it.
        expect(m.status).toBe("NOT_VALIDATED");
        const c = conditions(marginOnlyProposal([axisMargins(m)]));
        expect(c.phase_margin.passed).toBe(false);
        expect(c.robustness.passed).toBe(false);
        expect(c.phase_margin.reasons).toContain("margin_evidence_model_conditional:roll");
        expect(c.robustness.reasons).toContain("margin_evidence_model_conditional:roll");
    });

    it("1b. forging status VALIDATED on the same model-conditional evidence is refused by both conditions", () => {
        const m = margins(uniform(200, 0.5), NARROW);
        const forged = { ...axisMargins(m), status: "VALIDATED" as const, reasons: [] };
        const c = conditions(marginOnlyProposal([forged]));
        expect(c.phase_margin.passed).toBe(false);
        expect(c.robustness.passed).toBe(false);
        expect(c.robustness.reasons).toEqual(
            expect.arrayContaining([
                "margin_evidence_model_conditional:roll",
                "model_class_qualification_missing:roll",
            ]),
        );
        expect(() => assertAbsoluteReleased(marginOnlyProposal([forged]))).toThrow();
    });

    it("2. the 0.005 Hz grid detects the resonance", () => {
        const m = margins(uniform(200, 0.005), NARROW);
        expect(m.status).toBe("NOT_VALIDATED");
        expect(m.phaseMarginDeg!).toBeLessThan(0);
        expect(m.reasons.some((r) => r.startsWith("loop_gain_reenters_unity:70.2"))).toBe(true);
        expect(m.evidence.level).toBe("MEASURED");
        expect(m.gainMarginDb).toBeNull();
    }, 120_000);

    it("2b. that fine grid as the qualification of the coarse bounds FAILS it: no bounds, the worse PM", () => {
        const m = margins(uniform(200, 0.5), NARROW, { freqs: uniform(200, 0.005), g: NARROW });
        expect(m.evidence.qualification!.verdict).toBe("FAIL");
        expect(
            m.evidence.qualification!.reasons.some((r) => r.startsWith("qualification:loop_gain_reenters_unity")),
        ).toBe(true);
        expect(m.evidence.level).toBe("MEASURED");
        expect(m.phaseMarginDeg!).toBeLessThan(0);
        expect(m.gainMarginDb).toBeNull();
        expect(m.sensitivityPeakDb).toBeNull();
        expect(m.measured.phaseMarginDeg!).toBeCloseTo(86.66, 1); // the coarse reading stays visible
        expect(m.reasons).toContain("model_class_qualification_failed");
        expect(m.status).toBe("NOT_VALIDATED");
        const c = conditions(marginOnlyProposal([axisMargins(m)]));
        expect(c.phase_margin.passed).toBe(false);
        expect(c.robustness.passed).toBe(false);
    }, 120_000);
});

describe("F-02 evidence: missing or invalid metadata fails closed (3)", () => {
    const good = simulatedQualifiedEvidence(60, 10, 3);
    const base: AxisMargins = {
        axis: "roll",
        status: "VALIDATED",
        phaseMarginDeg: 60,
        gainMarginDb: 10,
        sensitivityPeakDb: 3,
        measured: { phaseMarginDeg: 60, gainMarginDb: 10, sensitivityPeakDb: 3 },
        evidence: good,
        reasons: [],
    };
    it("SIMULATION positive control: the complete record passes both conditions", () => {
        expect(marginEvidenceIssues(good)).toEqual([]);
        const c = conditions(marginOnlyProposal([base]));
        expect(c.phase_margin.passed).toBe(true);
        expect(c.robustness.passed).toBe(true);
    });
    const q = good.qualification!;
    const cases: [string, Partial<AxisMargins> | ((m: AxisMargins) => AxisMargins), string][] = [
        [
            "evidence missing",
            (m) => ({ ...m, evidence: undefined as unknown as MarginEvidence }),
            "margin_evidence_missing",
        ],
        ["evidence null", { evidence: null as unknown as MarginEvidence }, "margin_evidence_missing"],
        ["unknown level", { evidence: { ...good, level: "BOUNDED" as never } }, "margin_evidence_level_invalid"],
        ["level MEASURED", { evidence: { ...good, level: "MEASURED" } }, "margin_evidence_measured"],
        ["level INSUFFICIENT", { evidence: { ...good, level: "INSUFFICIENT" } }, "margin_evidence_insufficient"],
        ["resolution NaN", { evidence: { ...good, resolutionHz: NaN } }, "margin_evidence_resolution_invalid"],
        ["resolution 0", { evidence: { ...good, resolutionHz: 0 } }, "margin_evidence_resolution_invalid"],
        ["resolution negative", { evidence: { ...good, resolutionHz: -0.5 } }, "margin_evidence_resolution_invalid"],
        [
            "resolution as text",
            { evidence: { ...good, resolutionHz: "0.5" as never } },
            "margin_evidence_resolution_invalid",
        ],
        ["band missing", { evidence: { ...good, bandHz: null } }, "margin_evidence_band_invalid"],
        ["band reversed", { evidence: { ...good, bandHz: [100, 1] } }, "margin_evidence_band_invalid"],
        [
            "feature width inconsistent",
            { evidence: { ...good, minFeatureWidthHz: 0.1 } },
            "margin_evidence_feature_width_invalid",
        ],
        ["no assumptions", { evidence: { ...good, assumptions: [] } }, "margin_evidence_assumptions_missing"],
        ["qualification missing", { evidence: { ...good, qualification: null } }, "model_class_qualification_missing"],
        [
            "qualification FAIL",
            { evidence: { ...good, qualification: { ...q, verdict: "FAIL" } } },
            "model_class_qualification_fail",
        ],
        [
            "qualification INSUFFICIENT",
            { evidence: { ...good, qualification: { ...q, verdict: "INSUFFICIENT" } } },
            "model_class_qualification_insufficient",
        ],
        [
            "qualification verdict unknown",
            { evidence: { ...good, qualification: { ...q, verdict: "OK" as never } } },
            "model_class_qualification_verdict_invalid",
        ],
        [
            "qualification source missing",
            { evidence: { ...good, qualification: { ...q, source: undefined as never } } },
            "model_class_qualification_source_invalid",
        ],
        [
            "qualification not finer (0.2 Hz against 0.5 Hz)",
            { evidence: { ...good, qualification: { ...q, resolutionHz: 0.2 } } },
            "model_class_qualification_not_finer",
        ],
        [
            "qualification band short",
            { evidence: { ...good, qualification: { ...q, bandHz: [1, 60] } } },
            "model_class_qualification_band_not_covered",
        ],
        [
            "qualification margins NaN",
            { evidence: { ...good, qualification: { ...q, gainMarginDb: NaN } } },
            "model_class_qualification_margins_missing",
        ],
        [
            "qualification with open reasons",
            { evidence: { ...good, qualification: { ...q, reasons: ["qualification_band_not_covered"] } } },
            "model_class_qualification_has_reasons",
        ],
        [
            "qualification is the proposal's own log",
            { evidence: { ...good, qualification: { ...q, source: { sha256: PRIMARY_LOG.sha256, logIndex: 0 } } } },
            "model_class_qualification_is_proposal_log",
        ],
        ["bounds better than the qualification measured", { phaseMarginDeg: 70 }, "margins_better_than_qualification"],
        ["|S| better than the qualification measured", { sensitivityPeakDb: 2 }, "margins_better_than_qualification"],
        ["status not VALIDATED", { status: "NOT_VALIDATED" }, "margins_not_validated"],
        ["status garbage", { status: "OK" as never }, "margins_ok"],
    ];
    for (const [name, over, reason] of cases) {
        it(`${name}: phase_margin and robustness both block`, () => {
            const m = typeof over === "function" ? over(base) : { ...base, ...over };
            const c = conditions(marginOnlyProposal([m]));
            expect(c.phase_margin.reasons).toContain(`${reason}:roll`);
            expect(c.robustness.reasons).toContain(`${reason}:roll`);
            expect(evaluateRelease(marginOnlyProposal([m])).released).toBe(false);
        });
    }
});

describe("F-02 evidence: the smooth plant and a qualified model (4, 5)", () => {
    it("4. the smooth plant stays analysable: same bounds as before, MODEL_CONDITIONAL without a qualification", () => {
        const m = margins(uniform(200, 0.5), smooth);
        expect(m.crossoverHz!).toBeCloseTo(9.64, 1);
        expect(m.phaseMarginDeg!).toBeCloseTo(86.7, 0);
        expect(m.gainMarginDb!).toBeCloseTo(12.97, 1);
        expect(m.sensitivityPeakDb!).toBeCloseTo(2.73, 1);
        expect(m.evidence.level).toBe("MODEL_CONDITIONAL");
        expect(m.reasons).toEqual(["model_class_not_qualified", "model_class_qualification_missing", MODEL_CLASS_NEED]);
    });

    it("5a. SIMULATION: a finer (0.1 Hz) identification of the same smooth plant qualifies it: VALIDATED", () => {
        const coarse = margins(uniform(200, 0.5), smooth);
        // Over 1.5 × the primary's band (QUALIFICATION_BAND_EXTENSION, audit P1-2).
        const m = margins(uniform(200, 0.5), smooth, { freqs: uniform(310, 0.1), g: smooth });
        expect(m.evidence.qualification!.verdict).toBe("PASS");
        expect(m.evidence.level).toBe("VALIDATED");
        expect(m.reasons).toEqual([]);
        expect(m.status).toBe("VALIDATED");
        // The worse of both logs: never better than the coarse bounds.
        expect(m.phaseMarginDeg!).toBeLessThanOrEqual(coarse.phaseMarginDeg!);
        expect(m.gainMarginDb!).toBeLessThanOrEqual(coarse.gainMarginDb!);
        expect(m.sensitivityPeakDb!).toBeGreaterThanOrEqual(coarse.sensitivityPeakDb!);
        expect(Math.abs(m.phaseMarginDeg! - coarse.phaseMarginDeg!)).toBeLessThan(0.5);
        expect(m.evidence.assumptions).toContain(
            `qualified_down_to_feature_width:${(RESOLVED_FEATURE_BINS * 0.1).toFixed(3)}Hz`,
        );
        const c = conditions(marginOnlyProposal([axisMargins(m)]));
        expect(c.phase_margin.passed).toBe(true);
        expect(c.robustness.passed).toBe(true);
    });

    it("5b. a qualification that is not fine enough (0.25 Hz against 0.5 Hz) is INSUFFICIENT: MODEL_CONDITIONAL", () => {
        const m = margins(uniform(200, 0.5), smooth, { freqs: uniform(200, 0.25), g: smooth });
        expect(m.evidence.qualification!.verdict).toBe("INSUFFICIENT");
        expect(m.evidence.qualification!.reasons.some((r) => r.startsWith("qualification_not_finer"))).toBe(true);
        expect(m.evidence.level).toBe("MODEL_CONDITIONAL");
        expect(m.status).toBe("NOT_VALIDATED");
    });

    it("5e. a finer qualification over the same band does not test the loop above it (P1-2): INSUFFICIENT", () => {
        const m = margins(uniform(200, 0.5), smooth, { freqs: uniform(200, 0.1), g: smooth });
        expect(m.evidence.qualification!.verdict).toBe("INSUFFICIENT");
        expect(m.evidence.qualification!.reasons.some((r) => r.startsWith("qualification_band_not_extended:"))).toBe(
            true,
        );
        expect(m.evidence.level).toBe("MODEL_CONDITIONAL");
        expect(m.status).toBe("NOT_VALIDATED");
    });

    it("5f. finer bins that the qualification's samples cannot give (zero padding) are no qualification", () => {
        const fine = uniform(310, 0.1);
        // 0.1 Hz bins claimed from 0.5 Hz segments: interpolated, not resolved.
        const q = { tf: tfOf(fine, smooth), source: SOURCE, analysis: { ...welchOf(uniform(200, 0.5)), segments: 32 } };
        const m = loopMargins(buildAxisLoop(0, tfOf(uniform(200, 0.5), smooth), cfg, UNITY_CHAIN, true, true, q));
        expect(m.evidence.qualification!.reasons).toContain(
            "qualification_resolution_not_shown:bins_denser_than_segment_resolution",
        );
        expect(m.evidence.level).toBe("MODEL_CONDITIONAL");
        const bare = loopMargins(
            buildAxisLoop(0, tfOf(uniform(200, 0.5), smooth), cfg, UNITY_CHAIN, true, true, {
                tf: tfOf(fine, smooth),
                source: SOURCE,
            }),
        );
        expect(bare.evidence.qualification!.reasons).toContain(
            "qualification_resolution_not_shown:resolution_provenance_missing",
        );
    });

    it("5c. a qualification over a shorter band is INSUFFICIENT", () => {
        const m = margins(uniform(200, 0.5), smooth, { freqs: uniform(120, 0.1), g: smooth });
        expect(m.evidence.qualification!.reasons).toContain("qualification_band_not_covered");
        expect(m.evidence.level).toBe("MODEL_CONDITIONAL");
    });

    it("5d. a finer flight of a different plant (gain × 1.6) contradicts the bounds: FAIL", () => {
        const heavier: G = (f) => plantFrf(f, { K: 48, motorHz: 40, delayS: 0.002 });
        const m = margins(uniform(200, 0.5), smooth, { freqs: uniform(200, 0.1), g: heavier });
        expect(m.evidence.qualification!.verdict).toBe("FAIL");
        expect(m.evidence.level).toBe("MEASURED");
        expect(m.status).toBe("NOT_VALIDATED");
        // The PID search never recommends on it and asks for resolution, not a higher CHIRP end.
        const loop = buildAxisLoop(0, tfOf(uniform(200, 0.5), smooth), cfg, UNITY_CHAIN, true, true, {
            tf: tfOf(uniform(200, 0.1), heavier),
            source: SOURCE,
        });
        const r = optimizeAxisPid(loop, { p: cfg.axis.p, i: cfg.axis.i, d: cfg.axis.d, dMax: 0 }, null);
        expect(r.status).not.toBe("VALIDATED");
        expect(r.reasons).not.toContain("required_measurement:chirp_to_higher_frequency_for_gain_margin");
    }, 600_000);
});

describe("F-02 evidence: the engine route loopMargins → autotuneV2 → AxisMargins → release (5, 6)", () => {
    const AT = "2026-10-23T00:00:00Z";
    const primary = syntheticLogInput("1".repeat(64));
    const other = syntheticLogInput("2".repeat(64));
    const vt = verifiedTuneAllAxesFixture(0.9, 0.7);
    const released = (r: AutotuneV2Result) => !!r.releasableProposal && evaluateRelease(r.releasableProposal).released;
    let bare: AutotuneV2Result;
    let qualified: AutotuneV2Result;

    it("without a qualification log nothing is released, and the evidence reaches AxisMargins unchanged", () => {
        bare = runAutotuneV2({ primary, others: [other], verifiedTune: vt, createdAt: AT });
        expect(released(bare)).toBe(false);
        for (const m of Object.values(bare.margins)) expect(m!.proposed.evidence.level).toBe("MODEL_CONDITIONAL");
        const p = bare.proposal!;
        for (const am of p.release.margins) {
            expect(am.evidence).toEqual(bare.margins[am.axis]!.proposed.evidence);
            expect(am.measured).toEqual(bare.margins[am.axis]!.proposed.measured);
            expect(am.evidence.resolutionHz).toBeCloseTo(0.5, 9);
            expect(am.status).toBe("NOT_VALIDATED");
        }
        const d = evaluateRelease(p);
        expect(d.blocks).toEqual(expect.arrayContaining(["phase_margin:margin_evidence_model_conditional:roll"]));
        expect(d.blocks).toEqual(expect.arrayContaining(["robustness:margin_evidence_model_conditional:roll"]));
        // No other route promotes the conditional bounds: no PID item, no part, no filter is VALIDATED.
        expect(bare.pid.every((x) => x.status !== "VALIDATED")).toBe(true);
        expect(bare.releasableProposal).toBeNull();
        expect(bare.parts.find((x) => x.part === "phase_margin_robustness")!.status).not.toBe("VALIDATED");
        expect(bare.parts.find((x) => x.part === "phase_margin_robustness")!.requiredMeasurements).toContain(
            MODEL_CLASS_NEED,
        );
        expect(bare.filters.every((f) => f.status !== "VALIDATED")).toBe(true);
    }, 600_000);

    it("SIMULATION: with a finer independent flight of the same craft and tune the proposal releases", () => {
        qualified = runAutotuneV2({
            primary,
            others: [other],
            verifiedTune: vt,
            modelClassQualification: simulatedQualificationLog(),
            createdAt: AT,
        });
        expect(released(qualified)).toBe(true);
        for (const am of qualified.releasableProposal!.release.margins) {
            expect(am.evidence.level).toBe("VALIDATED");
            expect(am.evidence.qualification!.source.sha256).toBe(simulatedQualificationLog().sha256);
            expect(am.evidence.qualification!.resolutionHz!).toBeCloseTo(0.1, 6);
        }
        // The search is unchanged: the same values as without the qualification.
        expect(qualified.pid.map((x) => x.proposed)).toEqual(bare.pid.map((x) => x.proposed));
    }, 600_000);

    it("a qualification log that is the primary flight again, or another configuration, is rejected", () => {
        const copy = { ...syntheticLogInput("1".repeat(64), { binStepHz: 0.1 }), sha256: "6".repeat(64) };
        const r1 = runAutotuneV2({
            primary,
            others: [other],
            verifiedTune: vt,
            modelClassQualification: copy,
            createdAt: AT,
        });
        expect(released(r1)).toBe(false);
        expect(
            r1.parts
                .find((x) => x.part === "phase_margin_robustness")!
                .reasons.some((r) => r.startsWith("model_class_qualification_rejected:cross_log_duplicate_of_primary")),
        ).toBe(true);
        const otherTune = simulatedQualificationLog({ pids: { roll: [50, 71, 21] } });
        const r2 = runAutotuneV2({
            primary,
            others: [other],
            verifiedTune: vt,
            modelClassQualification: otherTune,
            createdAt: AT,
        });
        expect(released(r2)).toBe(false);
        expect(
            r2.parts
                .find((x) => x.part === "phase_margin_robustness")!
                .reasons.some((r) => r.startsWith("model_class_qualification_rejected:cross_log_config_differs")),
        ).toBe(true);
        for (const m of Object.values(r2.margins)) expect(m!.proposed.evidence.qualification).toBeNull();
    }, 600_000);
});
