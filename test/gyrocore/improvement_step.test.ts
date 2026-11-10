/*
 * Informative improvement step (block 10): the measured candidate that beats the current tune on PM,
 * GM and |S| at once is shown with its values, margins, evidence and the targets it still misses;
 * when the measurement does not support one, the deciding check is named. It is never an item of
 * the experimental proposal, so no Apply route can write it.
 */

import { describe, expect, it } from "vitest";
import {
    improvementStep,
    openTargetsOf,
    type DecisionCheck,
    type RouteDecision,
} from "../../src/gyrocore/engine/candidateDecision";
import type { AxisPidProposal } from "../../src/gyrocore/engine/pidOptimizer";
import type { LoopMargins } from "../../src/gyrocore/engine/loopModel";
import { buildExperimentalProposal } from "../../src/gyrocore/engine/experimentalProposal";
import { experimentalWriteDecision } from "../../src/gyrocore/releaseGate/experimentalAuthority";

const CURRENT = { p: 56, i: 79, d: 30, dMax: 40 };
const SAFEST = { p: 39, i: 55, d: 30, dMax: 40 };

function margins(pm: number, gm: number, s: number, fc: number): LoopMargins {
    return {
        status: "NOT_VALIDATED",
        crossoverHz: fc,
        phaseMarginDeg: pm,
        gainMarginDb: null,
        sensitivityPeakDb: null,
        delayMarginMs: null,
        chainSpreadDeg: null,
        okBins: 20,
        evidence: {
            level: "MEASURED",
            resolutionHz: 1.95,
            bandHz: [7.8, 50.8],
            minFeatureWidthHz: null,
            assumptions: [],
            qualification: null,
        },
        measured: { phaseMarginDeg: pm, gainMarginDb: gm, sensitivityPeakDb: s },
        reasons: [],
    } as unknown as LoopMargins;
}

const searchCheck: DecisionCheck = {
    rule: "candidate_search_measured_margins",
    ref: "src/gyrocore/engine/candidateDecision.ts:decideAxis",
    value: "best PM 26° (P 39, I 55, D 30), GM 4.9 dB, |S| 8.9 dB over 134 usable of 169",
    unit: "",
    threshold: "PM ≥ 45°, GM ≥ 6 dB, |S| ≤ 6 dB; P/I/D within ±30 %",
    result: "fail",
    consequence: "no candidate meets all targets; nothing offered",
};

function decision(over: Partial<RouteDecision>, cand: Partial<AxisPidProposal> | null): RouteDecision {
    const candidate: AxisPidProposal | null = cand
        ? {
              axis: "roll",
              current: CURRENT,
              proposed: SAFEST,
              changed: true,
              currentMargins: margins(16.8, 3.6, 11.7, 25.5),
              proposedMargins: margins(26.1, 4.9, 8.9, 24.3),
              outcome: "targets_not_reachable",
              status: "BLOCKED",
              reasons: ["experimental_search_on_measured_margins", "no_candidate_meets_all_targets"],
              ...cand,
          }
        : null;
    return {
        route: "primary",
        plant: "present",
        bandHz: [7.8, 50.8],
        metrics: { pm: "measured_in_band", gm: "measured_in_band", s: "measured_in_band" },
        current: { crossoverHz: 25.5, pmDeg: 16.8, gmDb: 3.6, sDb: 11.7 },
        checks: [searchCheck],
        searchRan: true,
        candidatesTried: 169,
        candidatesUsable: 134,
        status: "target_search_limit",
        firstCause: searchCheck,
        candidate,
        measurementUsable: true,
        missing: [],
        waived: [],
        target: null,
        ...over,
    };
}

describe("improvement step", () => {
    it("shows the safest candidate when it beats the current tune on PM, GM and |S|, with the open targets", () => {
        const r = improvementStep(decision({}, {}));
        expect(r.blocked).toBeNull();
        const s = r.step!;
        expect(s.source).toBe("candidate_within_max_step");
        expect(s.values).toEqual(SAFEST);
        expect(s.change.p).toBeCloseTo(39 / 56 - 1, 6);
        expect(s.before).toEqual({ crossoverHz: 25.5, pmDeg: 16.8, gmDb: 3.6, sDb: 11.7 });
        expect(s.after).toEqual({ crossoverHz: 24.3, pmDeg: 26.1, gmDb: 4.9, sDb: 8.9 });
        expect(s.evidence).toBe("MEASURED");
        expect(s.offered).toBe(false);
        expect(s.informative).toBe(true);
        expect(s.openTargets).toEqual(["PM 26° < 45°", "GM 4.9 dB < 6 dB", "|S| 8.9 dB > 6 dB"]);
    });

    it("marks the step as the offered candidate when the search found one meeting the targets", () => {
        const r = improvementStep(
            decision(
                { status: "candidate_found", firstCause: null },
                { outcome: "restores_margins", proposedMargins: margins(47, 6.5, 5.5, 24) },
            ),
        );
        expect(r.step?.offered).toBe(true);
        expect(r.step?.openTargets).toEqual([]);
        expect(openTargetsOf({ crossoverHz: 24, pmDeg: 47, gmDb: 6.5, sDb: 5.5 })).toEqual([]);
    });

    it("shows no step when the candidate is not better on all three, naming the search check", () => {
        // better PM, worse GM
        const r = improvementStep(decision({}, { proposedMargins: margins(26.1, 3.4, 8.9, 24.3) }));
        expect(r.step).toBeNull();
        expect(r.blocked?.reason).toBe("not_better_on_all_three");
        expect(r.blocked?.check?.rule).toBe("candidate_search_measured_margins");
        expect(r.blocked?.check?.threshold).toContain("PM ≥ 45°");
    });

    it("falls back to the first step of the wider target search when that one improves all three", () => {
        const r = improvementStep(
            decision(
                {
                    target: {
                        pScale: [0.4, 1.3],
                        iScale: [0.4, 1.3],
                        dScale: [0.5, 1.3],
                        tried: 323,
                        usable: 171,
                        target: {
                            values: { p: 22, i: 32, d: 35, dMax: 46 },
                            change: { p: -0.6, i: -0.6, d: 0.17 },
                            crossoverHz: 15,
                            pmDeg: 46,
                            gmDb: 6.2,
                            sDb: 5.8,
                            meetsTargets: true,
                        },
                        best: null,
                        bestOnEdge: false,
                        step: {
                            values: { p: 39, i: 55, d: 39, dMax: 52 },
                            change: { p: -0.3, i: -0.3, d: 0.3 },
                            crossoverHz: 22,
                            pmDeg: 30,
                            gmDb: 5.2,
                            sDb: 8.1,
                            meetsTargets: false,
                        },
                        stepImprovesAll: true,
                    },
                },
                { proposedMargins: margins(26.1, 3.4, 8.9, 24.3) },
            ),
        );
        expect(r.step?.source).toBe("target_first_step");
        expect(r.step?.values).toEqual({ p: 39, i: 55, d: 39, dMax: 52 });
        expect(r.step?.openTargets).toEqual(["PM 30° < 45°", "GM 5.2 dB < 6 dB", "|S| 8.1 dB > 6 dB"]);
    });

    it("names the deciding check when the measurement does not support a search", () => {
        const hole: DecisionCheck = {
            rule: "decision_band_gaps",
            ref: "candidateDecision",
            value: 2,
            unit: "unidentified bins",
            threshold: "0 unidentified bins inside the decision band",
            result: "fail",
            consequence: "search not run",
        };
        const r = improvementStep(
            decision(
                {
                    status: "plant_band_insufficient",
                    searchRan: false,
                    checks: [hole],
                    firstCause: hole,
                    measurementUsable: false,
                },
                null,
            ),
        );
        expect(r.step).toBeNull();
        expect(r.blocked).toEqual({ reason: "no_measurement", check: hole });
        expect(improvementStep(null).blocked?.reason).toBe("no_measurement");
    });

    it("is never an experimental item: the Apply route has nothing to write", () => {
        const d = decision({}, {});
        expect(improvementStep(d).step).not.toBeNull();
        const out = buildExperimentalProposal({
            primaryItems: [],
            primaryPid: [d.candidate!],
            jio: null,
            decisions: { roll: { primary: d, jio: null } },
            buildProposal: () => null,
        });
        expect(out.proposal).toBeNull();
        expect(out.withheld.map((w) => w.key)).toContain("pid_roll");
        // the Apply route starts from an ExperimentalProposal (experimentalWriteDecision); there is none to start from
        expect(typeof experimentalWriteDecision).toBe("function");
    });
});
