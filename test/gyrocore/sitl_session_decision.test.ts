/**
 * Block 14: the AutoTune session's re-measurement decision (decision.ts) and step policy (stepPolicy.ts).
 */
import { describe, expect, it } from "vitest";
import {
    decide,
    measuredShortfall,
    summarize,
    type AxisSummary,
    type MeasurementSummary,
    type RunRead,
} from "../../src/gyrocore/sitlSession/decision";
import {
    afterAccept,
    afterRestore,
    axisOrder,
    chooseStep,
    initialPolicyState,
} from "../../src/gyrocore/sitlSession/stepPolicy";
import {
    gmSigmaFromCoherence,
    shortfallOf,
    type SessionCandidate,
    type SessionSearchResult,
} from "../../src/gyrocore/engine/sessionSearch";

const st = (median: number, spread = 0) => ({ median, spread });
function axis(o: Partial<Record<keyof AxisSummary, unknown>> = {}): AxisSummary {
    return {
        fc: st(30, 0.02),
        pm: st(40, 0.05),
        gm: st(12, 0.2),
        gmLow: 11,
        gmMaxSigma: 0.5,
        gmAssessable: true,
        s: st(5.5, 0.01),
        tracking: st(0.47, 0.0003),
        overshoot: st(0.1, 0.004),
        riseMs: st(14, 0.3),
        oscillation: st(0.02, 0.001),
        ...(o as object),
    } as AxisSummary;
}
const motors = (x = 7.8) => [st(x, 0.05), st(x, 0.05), st(x, 0.05), st(x, 0.05)];
const meas = (roll: Partial<AxisSummary> = {}, pitch: Partial<AxisSummary> = {}, m = 7.8): MeasurementSummary => ({
    valid: true,
    issues: [],
    axes: { roll: axis(roll), pitch: axis({ pm: st(50), ...pitch }) },
    motors: motors(m),
});

describe("decision (session_v1)", () => {
    it("ACCEPT when the changed axis' shortfall falls by ≥ 0.5 beyond the spread and every guard holds", () => {
        const d = decide({ base: meas(), cand: meas({ pm: st(44, 0.05) }), start: meas(), axis: "roll" });
        expect(d.verdict).toBe("ACCEPT");
        expect(d.reasons).toEqual(["V1_shortfall_drop:roll"]);
    });

    it("V2: a narrowly missed target newly met with margin ≥ 2u is enough without a 0.5 drop", () => {
        const base = meas({ pm: st(44.8, 0.05) });
        const d = decide({ base, cand: meas({ pm: st(45.3, 0.05) }), start: base, axis: "roll" });
        expect(d.verdict).toBe("ACCEPT");
        expect(d.reasons).toEqual(["V2_target_newly_met:roll"]);
        // Met but inside 2u of the target: not enough.
        const d2 = decide({ base, cand: meas({ pm: st(45.05, 0.05) }), start: base, axis: "roll" });
        expect(d2.verdict).toBe("RESTORE");
        expect(d2.reasons).toEqual(["no_improvement:roll"]);
    });

    it("RESTORE on each guard, with the guard named", () => {
        const better = { pm: st(44, 0.05) };
        const cases: [Partial<AxisSummary>, Partial<AxisSummary>, number, string][] = [
            [better, {}, 8.7, "G1_motor_vs_accepted:m1"],
            [{ ...better, overshoot: st(0.13, 0.004) }, {}, 7.8, "G3_overshoot:roll"],
            [{ ...better, tracking: st(0.5, 0.0003) }, {}, 7.8, "G4_tracking:roll"],
            [{ ...better, riseMs: st(20, 0.3) }, {}, 7.8, "G5_rise:roll"],
            [{ ...better, fc: st(26, 0.02) }, {}, 7.8, "G5_crossover:roll"],
            [{ ...better, oscillation: st(0.09, 0.001) }, {}, 7.8, "G6_oscillation:roll"],
            [better, { pm: st(44.9) }, 7.8, "G2_pm_stays_met:pitch"],
            [{ ...better, gmLow: 9.4 }, {}, 7.8, "G2_gm_not_worse:roll"],
            [{ ...better, gmAssessable: false }, {}, 7.8, "G6_gm_assessable:roll"],
        ];
        for (const [r, p, m, rule] of cases) {
            const d = decide({ base: meas(), cand: meas(r, p, m), start: meas(), axis: "roll" });
            expect(d.verdict, rule).toBe("RESTORE");
            expect(d.reasons, rule).toContain(rule);
        }
    });

    it("G1 also holds against the start: motor load cannot creep up over accepted steps", () => {
        const start = meas({}, {}, 7.0);
        const base = meas({}, {}, 7.6); // accepted earlier at ×1.086 of the start
        const d = decide({ base, cand: meas({ pm: st(44) }, {}, 7.9), start, axis: "roll" });
        expect(d.reasons).toContain("G1_motor_vs_start:m1"); // 7.9/7.0 = 1.13; 7.9/7.6 = 1.04
        expect(d.reasons).not.toContain("G1_motor_vs_accepted:m1");
    });

    it("G6: an axis that already oscillates beyond the limit may stay as it is, not get worse", () => {
        const base = meas({}, { oscillation: st(0.123, 0.005) });
        expect(
            decide({ base, cand: meas({ pm: st(44) }, { oscillation: st(0.125, 0.004) }), start: base, axis: "roll" })
                .verdict,
        ).toBe("ACCEPT");
        const d = decide({
            base,
            cand: meas({ pm: st(44) }, { oscillation: st(0.14, 0.004) }),
            start: base,
            axis: "roll",
        });
        expect(d.reasons).toContain("G6_oscillation:pitch");
    });

    it("INVALID when the candidate measurement is not valid; the issues are the reasons", () => {
        const cand = { ...meas({ pm: st(44) }), valid: false, issues: ["run2:active_tune_before_arming_differs"] };
        const d = decide({ base: meas(), cand, start: meas(), axis: "roll" });
        expect(d.verdict).toBe("INVALID");
        expect(d.reasons).toEqual(["invalid:run2:active_tune_before_arming_differs"]);
    });

    it("summarize: medians, spreads, GM lower bound, validity limits", () => {
        const run = (pm: number, sig: number | null, hover = 11000): RunRead => ({
            margins: {
                roll: { crossoverHz: 30, pmDeg: pm, gmDb: 12, sDb: 5.5, gmHz: 67, gmSigmaDb: sig },
                pitch: { crossoverHz: 36, pmDeg: 50, gmDb: 10, sDb: 5, gmHz: 73, gmSigmaDb: 0.5 },
            },
            steps: {
                roll: { trackingRel: 0.47, overshoot: 0.1, riseMs: 14, oscillation: 0.02 },
                pitch: { trackingRel: 0.54, overshoot: 0.05, riseMs: 34, oscillation: 0.04 },
            },
            motors: { bandPower: [7.7, 7.8, 7.9, 7.8], hoverSamples: hover, clip: 0 },
            issues: [],
        });
        const ok = summarize([run(39.6, 0.5), run(39.7, 0.6), run(39.7, 0.5)]);
        expect(ok.valid).toBe(true);
        expect(ok.axes.roll!.pm.median).toBeCloseTo(39.7);
        expect(ok.axes.roll!.gmLow).toBeCloseTo(12 - 2 * 0.6);
        const unknownSigma = summarize([run(39.6, null), run(39.7, 0.6), run(39.7, 0.5)]);
        expect(unknownSigma.axes.roll!.gmAssessable).toBe(false);
        expect(unknownSigma.axes.roll!.gmLow).toBeCloseTo(12 - 2 * 1.5);
        const spread = summarize([run(38.5, 0.5), run(39.7, 0.6), run(39.7, 0.5)]);
        expect(spread.valid).toBe(false);
        expect(spread.issues.some((x) => x.startsWith("pm_spread:roll"))).toBe(true);
        const hover = summarize([run(39.6, 0.5, 2000), run(39.7, 0.6), run(39.7, 0.5)]);
        expect(hover.issues).toContain("run1:hover_samples:2000");
        expect(summarize([run(39.6, 0.5), run(39.7, 0.6)]).issues).toContain("runs:2");
    });

    it("GM uncertainty rule v4 and the shortfall units", () => {
        expect(gmSigmaFromCoherence(0.946)).toBeCloseTo(1.36, 2);
        expect(gmSigmaFromCoherence(null)).toBeNull();
        expect(shortfallOf(40, 6, 6)).toBeCloseTo(1);
        expect(shortfallOf(45, 4.5, 7)).toBeCloseTo(2);
        expect(measuredShortfall(axis({ pm: st(40), gmLow: 6, s: st(6) }))).toBeCloseTo(1);
    });
});

const cand = (values: SessionCandidate["values"], pm: number, motorMax: number, s = 5.5): SessionCandidate => ({
    values,
    change: { p: 0, i: 0, d: 0 },
    predicted: { crossoverHz: 28, pmDeg: pm, gmDb: 12, sDb: s },
    shortfall: shortfallOf(pm, 12, s),
    meets: { pm: pm >= 45, gm: true, s: s <= 6 },
    motorRatios: [motorMax, motorMax * 0.98, motorMax * 0.97, motorMax * 0.99],
});
function search(
    roll: SessionCandidate[],
    pitch: SessionCandidate[] = [],
    pmRoll = 40,
    pmPitch = 50,
): SessionSearchResult {
    const cur = { p: 100, i: 80, d: 30, dMax: 40 };
    const ax = (axis: "roll" | "pitch", pm: number, c: SessionCandidate[]) => ({
        axis,
        status: "searched" as const,
        reasons: [],
        current: cur,
        currentRead: { crossoverHz: 28, pmDeg: pm, gmDb: 12, sDb: 5.5, gmHz: 67, gmSigmaDb: 0.5 },
        rho: 0.2,
        tried: c.length,
        readable: c.length,
        candidates: c,
    });
    return {
        axes: [ax("roll", pmRoll, roll), ax("pitch", pmPitch, pitch)],
        motorModel: { assessable: true, reasons: [], limitations: [] },
    };
}

describe("step policy (session_v1)", () => {
    const base = meas();
    const ones = [1, 1, 1, 1];
    it("(a) a predicted shortfall drop ≥ 0.5: the largest drop, then the smallest step", () => {
        const out = chooseStep({
            search: search([
                cand({ p: 90, i: 80, d: 30, dMax: 40 }, 43, 0.95),
                cand({ p: 80, i: 72, d: 30, dMax: 40 }, 45.1, 0.9),
                cand({ p: 84, i: 80, d: 30, dMax: 40 }, 45.5, 0.92),
            ]),
            base,
            acceptedVsStart: ones,
            state: initialPolicyState(),
        });
        expect(out.kind).toBe("step");
        if (out.kind !== "step") return;
        expect(out.choice.to).toEqual({ p: 84, i: 80, d: 30, dMax: 40 }); // D 0 at the smaller step (0.16 < 0.2)
        expect(out.choice.kind).toBe("shortfall_drop");
    });

    it("(b) a predicted transition to a met target is eligible without a 0.5 drop (the step V2 is meant to keep)", () => {
        const out = chooseStep({
            search: search([cand({ p: 97, i: 80, d: 30, dMax: 40 }, 45.2, 0.99)], [], 44.7),
            base: meas({ pm: st(44.6) }),
            acceptedVsStart: ones,
            state: initialPolicyState(),
        });
        expect(out.kind === "step" && out.choice.kind).toBe("target_transition");
    });

    it("motor limit against the accepted tune and against the start; outside ρ; excluded points", () => {
        const c1 = cand({ p: 84, i: 80, d: 30, dMax: 40 }, 45.5, 1.12);
        expect(
            chooseStep({ search: search([c1]), base, acceptedVsStart: ones, state: initialPolicyState() }).kind,
        ).toBe("stop");
        const c2 = cand({ p: 84, i: 80, d: 30, dMax: 40 }, 45.5, 1.05);
        expect(
            chooseStep({ search: search([c2]), base, acceptedVsStart: [1.06, 1, 1, 1], state: initialPolicyState() })
                .kind,
        ).toBe("stop");
        const narrow = { ...initialPolicyState(), rho: { roll: 0.1, pitch: 0.2 } };
        expect(chooseStep({ search: search([c2]), base, acceptedVsStart: ones, state: narrow }).kind).toBe("stop");
        const ex = afterRestore(initialPolicyState(), {
            axis: "roll",
            from: { p: 100, i: 80, d: 30, dMax: 40 },
            to: { p: 84, i: 80, d: 30, dMax: 40 },
            stepSize: 0.16,
        } as never);
        expect(ex.rho.roll).toBeCloseTo(0.1);
        const near = cand({ p: 86, i: 80, d: 30, dMax: 40 }, 45.5, 0.9); // 0.024 from the rejected point < 0.08
        expect(
            chooseStep({
                search: search([near]),
                base,
                acceptedVsStart: ones,
                state: { ...ex, rho: { roll: 0.2, pitch: 0.2 } },
            }).kind,
        ).toBe("stop");
    });

    it("after a rejection the same axis is tried first, then the other axis, before no_eligible_candidate", () => {
        // Both axes miss a target; pitch misses more, so it comes first unless roll was just rejected.
        const b = meas({ pm: st(42) }, { pm: st(40) });
        const s = search(
            [cand({ p: 90, i: 80, d: 30, dMax: 40 }, 46, 0.9)],
            [cand({ p: 90, i: 80, d: 30, dMax: 40 }, 46, 0.9)],
            42,
            40,
        );
        const st0 = initialPolicyState();
        expect(axisOrder(b, st0).map((x) => x.axis)).toEqual(["pitch", "roll"]);
        const afterRoll = { ...st0, lastRejectedAxis: "roll" as const };
        expect(axisOrder(b, afterRoll).map((x) => x.axis)).toEqual(["roll", "pitch"]);
        const out = chooseStep({ search: s, base: b, acceptedVsStart: ones, state: afterRoll });
        expect(out.kind === "step" && out.choice.axis).toBe("roll");
        // Roll has nothing eligible: pitch is tried before the session stops.
        const s2 = search([], [cand({ p: 90, i: 80, d: 30, dMax: 40 }, 46, 0.9)], 42, 40);
        const out2 = chooseStep({ search: s2, base: b, acceptedVsStart: ones, state: afterRoll });
        expect(out2.kind === "step" && out2.choice.axis).toBe("pitch");
        expect(out2.kind === "step" && out2.choice.skipped.map((x) => x.axis)).toEqual(["roll"]);
        const out3 = chooseStep({ search: search([], [], 42, 40), base: b, acceptedVsStart: ones, state: afterRoll });
        expect(out3).toMatchObject({ kind: "stop", reason: "no_eligible_candidate" });
    });

    it("stops: targets met, step floor; accept doubles ρ (at most 0.2) and keeps exclusions", () => {
        expect(
            chooseStep({
                search: search([]),
                base: meas({ pm: st(46) }),
                acceptedVsStart: ones,
                state: initialPolicyState(),
            }),
        ).toMatchObject({
            kind: "stop",
            reason: "targets_met",
        });
        const floor = { ...initialPolicyState(), rho: { roll: 0.04, pitch: 0.2 } };
        expect(chooseStep({ search: search([]), base, acceptedVsStart: ones, state: floor })).toMatchObject({
            kind: "stop",
            reason: "step_floor",
        });
        const s1 = {
            rho: { roll: 0.05, pitch: 0.2 },
            excluded: [{ axis: "roll" as const, pid: { p: 1, i: 1, d: 1, dMax: 1 }, stepSize: 0.1 }],
            lastRejectedAxis: "roll" as const,
        };
        const a = afterAccept(s1, { axis: "roll" } as never);
        expect(a.rho.roll).toBeCloseTo(0.1);
        expect(a.excluded).toHaveLength(1);
        expect(a.lastRejectedAxis).toBeNull();
    });

    it("the guards the engine can predict hold on the predicted margins (selection aligned with the re-measurement)", () => {
        const ok = cand({ p: 90, i: 80, d: 30, dMax: 40 }, 46, 0.9);
        const lowFc = {
            ...cand({ p: 80, i: 80, d: 30, dMax: 40 }, 46, 0.9),
            predicted: { crossoverHz: 25.1, pmDeg: 46, gmDb: 12, sDb: 5.5 },
        };
        // current predicted fc 28: 25.1 < 0.92 × 28 = 25.76 → not eligible (the pilot smoke session's G5 crossover restore)
        const out = chooseStep({
            search: search([lowFc, ok]),
            base,
            acceptedVsStart: ones,
            state: initialPolicyState(),
        });
        expect(out.kind === "step" && out.choice.to).toEqual(ok.values);
        expect(
            chooseStep({ search: search([lowFc]), base, acceptedVsStart: ones, state: initialPolicyState() }).kind,
        ).toBe("stop");
        const sWorse = { ...cand({ p: 90, i: 80, d: 30, dMax: 40 }, 46, 0.9, 6.6) };
        // |S| 5.5 met → predicted 6.6 would lose it (G2)
        expect(
            chooseStep({ search: search([sWorse]), base, acceptedVsStart: ones, state: initialPolicyState() }).kind,
        ).toBe("stop");
    });

    it("v1.1: the guards also hold against the start, so per-step allowances cannot add up (fc −8 %, then −5 %)", () => {
        const start = meas({ pm: st(38, 0.05), fc: st(30, 0.02) });
        const step1 = meas({ pm: st(42, 0.05), fc: st(27.6, 0.02) }); // −8 % against the start: passes
        expect(decide({ base: start, cand: step1, start, axis: "roll" }).verdict).toBe("ACCEPT");
        const step2 = meas({ pm: st(45.5, 0.05), fc: st(26.2, 0.02) }); // −5 % against step 1, −12.7 % against the start
        const d = decide({ base: step1, cand: step2, start, axis: "roll" });
        expect(d.verdict).toBe("RESTORE");
        expect(d.reasons).toEqual(["G5_crossover_vs_start:roll"]);
    });
});

describe("step policy against the start (session_v1.1)", () => {
    it("a step whose predicted crossover drop passes against the accepted tune but not against the start is not eligible", () => {
        const ones = [1, 1, 1, 1];
        const start = meas({ pm: st(38), fc: st(30) });
        const base = meas({ pm: st(42), fc: st(27.6) });
        const c = {
            ...cand({ p: 90, i: 80, d: 30, dMax: 40 }, 46, 0.9),
            predicted: { crossoverHz: 26.6, pmDeg: 46, gmDb: 12, sDb: 5.5 },
        };
        // predicted against the accepted: 26.6 / 28 = 0.95 ≥ 0.92; projected 27.6 × 0.95 = 26.2 < 0.92 × 30 = 27.6 → not eligible
        expect(chooseStep({ search: search([c]), base, acceptedVsStart: ones, state: initialPolicyState() }).kind).toBe(
            "step",
        );
        expect(
            chooseStep({ search: search([c]), base, acceptedVsStart: ones, state: initialPolicyState(), start }).kind,
        ).toBe("stop");
    });
});
