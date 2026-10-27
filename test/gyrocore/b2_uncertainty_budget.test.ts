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
 * The uncertainty budget of the margins (continuation B2; measurement audit B3). Five things are kept
 * apart, each with the gate that already acts on it:
 *
 *   resolution      agreement with the next finer rung (H1)          bounds: CONVERGED only
 *   statistical     Bendat & Piersol random error per bin            bounds: known and folded in
 *   repeatability   the cross-log plant check between flights        release: model gate, PASS only
 *   systematic      model class (independent finer flight), chain    VALIDATED: qualification PASS
 *   unknown         the components not known                         each blocks something above
 *
 * The budget is a report of those gates, required and checked for consistency by the release
 * contract (marginEvidenceIssues): a missing budget, or one that contradicts the evidence, is refused.
 * A MEASURED phase margin now carries its spread (σ at the crossover) too.
 *
 * SIMULATION: analytic loops and the synthetic Blackbox harness.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runAutotuneV2, type AutotuneLogInput } from "../../src/gyrocore/engine/autotuneV2";
import {
    marginEvidenceIssues,
    phaseMarginSigmaDegAt,
    uncertaintyBudgetOf,
    withRepeatability,
    type LoopMargins,
} from "../../src/gyrocore/engine/loopModel";
import { buildLogInputs } from "../../src/gyrocore/engine/logInput";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { closedLoopChirpLog, ratePlant, type ClosedLoopLogOptions } from "./harness/closedLoopBbl";
import { simulatedQualifiedEvidence } from "./harness/marginEvidenceFixture";

function decoded(o: ClosedLoopLogOptions, name: string): AutotuneLogInput {
    const bytes = closedLoopChirpLog(o);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const [log] = buildLogInputs(bytes, sha, qualifyChirpFile(bytes, name, 45, AUTOTUNE_MATH), null);
    expect(log, name).toBeDefined();
    return log;
}
const G = ratePlant({ K: 60, motorHz: 40, delayS: 0.002 });

describe("the release contract requires the budget and refuses one that contradicts the evidence", () => {
    const ev = simulatedQualifiedEvidence(50, 10, 4);

    it("a complete, consistent budget passes", () => {
        expect(marginEvidenceIssues(ev)).toEqual([]);
    });

    it("no budget: refused", () => {
        expect(marginEvidenceIssues({ ...ev, uncertaintyBudget: undefined })).toContain("uncertainty_budget_missing");
        expect(marginEvidenceIssues({ ...ev, uncertaintyBudget: null })).toContain("uncertainty_budget_missing");
    });

    it("a budget that says something else than the evidence: refused", () => {
        const b = ev.uncertaintyBudget!;
        for (const bad of [
            { ...b, resolution: { ...b.resolution, status: "UNKNOWN" as const } },
            { ...b, statistical: { ...b.statistical, includedInBounds: false } },
            { ...b, statistical: { ...b.statistical, known: false } },
            { ...b, systematic: { ...b.systematic, modelClass: "NOT_QUALIFIED" as const } },
        ]) {
            expect(marginEvidenceIssues({ ...ev, uncertaintyBudget: bad })).toContain(
                "uncertainty_budget_inconsistent",
            );
        }
    });
});

describe("the budget of real engine margins (one synthetic flight, then two)", () => {
    const first = decoded({ plants: [G, null, null], noise: 0.3, seed: 11 }, "b2-1");

    it("one flight: every component reported, the unknown ones named, a MEASURED PM with its σ", () => {
        const r = runAutotuneV2({ primary: first, others: [], verifiedTune: null, createdAt: "2026-10-27T00:00:00Z" });
        const m = r.margins.roll!.current;
        const b = m.evidence.uncertaintyBudget!;
        expect(b).toBeDefined();
        expect(m.evidence.level).toBe("MEASURED");
        // Resolution: the H1 verdict of the rung used, with its deltas.
        expect(b.resolution.status).toBe(m.evidence.convergence!.status);
        expect(b.resolution.deltaCrossoverPct).toBe(m.evidence.convergence!.deltaCrossoverPct);
        // Statistical: known per bin, not folded into bounds (there are none), σ_PM at the crossover.
        expect(b.statistical.known).toBe(true);
        expect(b.statistical.includedInBounds).toBe(false);
        expect(b.statistical.phaseMarginSigmaDeg!).toBeGreaterThan(0);
        expect(b.statistical.phaseMarginSigmaDeg!).toBeLessThan(30);
        // Repeatability: no second flight, untested.
        expect(b.repeatability).toEqual({ status: "UNTESTED", meanAbsGRel: null });
        // Systematic: no qualification flight; what is not quantified is named.
        expect(b.systematic.modelClass).toBe("NOT_QUALIFIED");
        expect(b.systematic.notQuantified).toContain("resolution_convergence_is_agreement_between_rungs_not_accuracy");
        expect(b.unknown).toEqual(expect.arrayContaining(["repeatability_between_flights", "model_class"]));
        // MEASURED: no bounds, and nothing releasable.
        expect(m.gainMarginDb).toBeNull();
        expect(r.releasableProposal).toBeNull();
    }, 120_000);

    it("a second, independent flight of the same craft: repeatability measured, the release still gated on it", () => {
        const second = decoded({ plants: [G, null, null], noise: 0.3, seed: 21, startTimeUs: 9_000_000 }, "b2-2");
        const r = runAutotuneV2({
            primary: first,
            others: [second],
            verifiedTune: null,
            createdAt: "2026-10-27T00:00:00Z",
        });
        const cross = r.crossLogPlant.roll!;
        // Two independent synthetic flights of the same plant agree: the repeat is accepted and PASSes.
        expect(r.crossLogRejected).toEqual([]);
        expect(cross.status).toBe("PASS");
        expect(cross.meanAbsGRel).toBeGreaterThan(0);
        const b = r.margins.roll!.current.evidence.uncertaintyBudget!;
        expect(b.repeatability).toEqual({ status: "PASS", meanAbsGRel: cross.meanAbsGRel });
        expect(b.unknown).not.toContain("repeatability_between_flights");
        expect(r.margins.roll!.proposed.evidence.uncertaintyBudget!.repeatability.status).toBe("PASS");
        // The other components are unchanged by the repeat: still MEASURED, still no model class.
        expect(b.unknown).toContain("model_class");
        expect(r.releasableProposal).toBeNull();
    }, 180_000);
});

describe("withRepeatability and σ_PM", () => {
    it("only PASS / PARTIAL / FAIL count as tested; anything else is UNTESTED", () => {
        const base = {
            evidence: {
                uncertaintyBudget: {
                    resolution: { status: "CONVERGED", deltaCrossoverPct: 0, deltaPhaseMarginDeg: 0 },
                    statistical: {
                        known: true,
                        includedInBounds: true,
                        coverage: 2,
                        maxRelErr: 0.01,
                        phaseMarginSigmaDeg: 0.6,
                        averages: [1, 1],
                    },
                    repeatability: { status: "UNTESTED", meanAbsGRel: null },
                    systematic: { modelClass: "PASS", chainValidated: true, notQuantified: [] },
                    unknown: ["repeatability_between_flights"],
                },
            },
        } as unknown as LoopMargins;
        expect(
            withRepeatability(base, { status: "PASS", meanAbsGRel: 0.03 }).evidence.uncertaintyBudget!.unknown,
        ).toEqual([]);
        const odd = withRepeatability(base, { status: "SOMETHING", meanAbsGRel: 0.03 }).evidence.uncertaintyBudget!;
        expect(odd.repeatability).toEqual({ status: "UNTESTED", meanAbsGRel: null });
        expect(odd.unknown).toContain("repeatability_between_flights");
        expect(withRepeatability(base, null).evidence.uncertaintyBudget!.repeatability.status).toBe("UNTESTED");
    });

    it("σ_PM is the relative error at the bin nearest the crossover, in degrees; unknown error gives null", () => {
        const loop = {
            uncertainty: {
                relErr: new Map([
                    [10, 0.01],
                    [20, 0.02],
                    [30, 0.05],
                ]),
                averages: null,
                reasons: [],
            },
        };
        expect(phaseMarginSigmaDegAt(loop, 19)).toBeCloseTo((0.02 * 180) / Math.PI, 12);
        expect(phaseMarginSigmaDegAt({ uncertainty: { relErr: null, averages: null, reasons: [] } }, 19)).toBeNull();
        expect(typeof uncertaintyBudgetOf).toBe("function");
    });
});
