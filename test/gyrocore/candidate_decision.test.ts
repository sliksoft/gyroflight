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
 * Block 6/7: the per-axis candidate decision (candidateDecision.ts), the agreed recording plan it
 * drives (recordingInstruction.ts: two CHIRP rounds, one shared sweep configuration, the missing
 * frequencies per axis) and the experimental proposal built from measured in-band
 * margins. A missing plant, an insufficient band and a real search failure are separate statuses;
 * unknown is never a zero; nothing is fabricated. SIMULATION ONLY.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildLogInputs } from "../../src/gyrocore/engine/logInput";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { runAutotuneV2, type AutotuneLogInput } from "../../src/gyrocore/engine/autotuneV2";
import {
    bandShortfall,
    decideAxis,
    metricStates,
    type RouteDecision,
} from "../../src/gyrocore/engine/candidateDecision";
import type { AxisLoop } from "../../src/gyrocore/engine/loopModel";
import {
    deciHzText,
    MEASUREMENT_AGREEMENT,
    recordingPlan,
    RECORDING_TIMING,
} from "../../src/gyrocore/engine/recordingInstruction";
import { buildExperimentalProposal } from "../../src/gyrocore/engine/experimentalProposal";
import type { LoopMargins } from "../../src/gyrocore/engine/loopModel";
import type { AxisPidProposal } from "../../src/gyrocore/engine/pidOptimizer";
import type { AbsoluteProposal, ProposalItem } from "../../src/gyrocore/releaseGate/releaseContract";
import type { JioSweepAdvice } from "../../src/gyrocore/engine/jioSweep";
import { closedLoopChirpLog, ratePlant } from "./harness/closedLoopBbl";
import { createPinia, setActivePinia } from "pinia";
import { useAutotuneV2Store } from "../../src/gyrocore/stores/autotuneV2";
import { experimentalWriteDecision } from "../../src/gyrocore/releaseGate/experimentalAuthority";

function margins(o: Partial<LoopMargins> & { reasons?: string[] }): LoopMargins {
    return {
        status: "NOT_VALIDATED",
        crossoverHz: 25,
        phaseMarginDeg: 40,
        gainMarginDb: null,
        sensitivityPeakDb: null,
        delayMarginMs: null,
        chainSpreadDeg: null,
        okBins: 30,
        evidence: { level: "MEASURED" } as LoopMargins["evidence"],
        measured: { phaseMarginDeg: 40, gainMarginDb: 8, sensitivityPeakDb: 5 },
        reasons: [],
        ...o,
    } as LoopMargins;
}

describe("metricStates: how GM and |S| are known", () => {
    it("bound, in-band measured, crossing outside, peak outside, band end near unity, not computable", () => {
        expect(metricStates(margins({ gainMarginDb: 7, sensitivityPeakDb: 5 }))).toMatchObject({
            gm: "bounded",
            s: "bounded",
        });
        expect(metricStates(margins({}))).toEqual({
            pm: "measured_in_band",
            gm: "measured_in_band",
            s: "measured_in_band",
        });
        expect(
            metricStates(
                margins({
                    measured: { phaseMarginDeg: 40, gainMarginDb: null, sensitivityPeakDb: 9 },
                    reasons: ["phase_crossover_outside_identified_band", "sensitivity_peak_outside_identified_band"],
                }),
            ),
        ).toMatchObject({ gm: "crossing_outside_band", s: "peak_outside_band" });
        expect(metricStates(margins({ reasons: ["loop_gain_near_unity_at_band_end:-4.2dB"] }))).toMatchObject({
            gm: "band_end_near_unity",
            s: "band_end_near_unity",
        });
        expect(
            metricStates(
                margins({
                    crossoverHz: null,
                    phaseMarginDeg: null,
                    measured: { phaseMarginDeg: null, gainMarginDb: null, sensitivityPeakDb: null },
                }),
            ),
        ).toEqual({ pm: "not_computable", gm: "not_computable", s: "not_computable" });
    });

    it("a measured 0 dB is a value, an unknown is not: 0 is in band, null is not computable", () => {
        expect(
            metricStates(margins({ measured: { phaseMarginDeg: 40, gainMarginDb: 0, sensitivityPeakDb: 0 } })),
        ).toMatchObject({
            gm: "measured_in_band",
            s: "measured_in_band",
        });
        expect(
            metricStates(margins({ measured: { phaseMarginDeg: 40, gainMarginDb: null, sensitivityPeakDb: null } })),
        ).toMatchObject({
            gm: "not_computable",
            s: "not_computable",
        });
        expect(
            metricStates(margins({ measured: { phaseMarginDeg: 40, gainMarginDb: Number.NaN, sensitivityPeakDb: 5 } }))
                .gm,
        ).toBe("not_computable");
    });
});

describe("decideAxis: no plant is its own status, never 'targets not reachable'", () => {
    it("without a loop: plant_not_identified, search not run, the reason value kept, unknown stays null", () => {
        const d = decideAxis({ route: "jio", loop: null, current: null, noPlantReasons: ["jio_no_usable_record"] });
        expect(d.status).toBe("plant_not_identified");
        expect(d.plant).toBe("absent");
        expect(d.searchRan).toBe(false);
        expect(d.candidate).toBeNull();
        expect(d.firstCause).toMatchObject({ rule: "jio_engine_input", value: "jio_no_usable_record", result: "fail" });
        const none = decideAxis({ route: "primary", loop: null, current: null });
        expect(none.firstCause!.value).toBeNull();
    });
});

describe("decideAxis on simulated flights: statuses agree with what the search really did", () => {
    const G = ratePlant({ K: 60, motorHz: 40, delayS: 0.002 });
    function decoded(seed: number): AutotuneLogInput {
        const bytes = closedLoopChirpLog({
            plants: [G, G, null],
            sweepS: 12,
            seed,
            jio: { disturbance: { sd: 3, poleHz: 300 } },
        });
        const sha = createHash("sha256").update(bytes).digest("hex");
        const [log] = buildLogInputs(bytes, sha, qualifyChirpFile(bytes, `d${seed}.bbl`, 45, AUTOTUNE_MATH), null);
        return log;
    }

    it("targets_not_reachable / search limit only with a usable plant and a search that ran; candidates reach the proposal", () => {
        const r = runAutotuneV2({
            primary: decoded(131),
            others: [],
            verifiedTune: null,
            createdAt: "2026-11-03T00:00:00Z",
        });
        // Facts of this fixture (output disturbance through the loop): both routes on both axes stop at the band.
        for (const axis of ["roll", "pitch"] as const) {
            expect(r.candidateDecisions[axis]!.primary!.status).toBe("plant_band_insufficient");
            expect(r.candidateDecisions[axis]!.jio!.status).toBe("plant_band_insufficient");
        }
        for (const axis of ["roll", "pitch"] as const) {
            const d = r.candidateDecisions[axis]!;
            for (const route of [d.primary, d.jio]) {
                if (!route) continue;
                expect(route.checks.length).toBeGreaterThan(0);
                for (const c of route.checks) {
                    expect(typeof c.rule).toBe("string");
                    expect(typeof c.threshold).toBe("string");
                    expect(["pass", "fail", "unknown", "waived"]).toContain(c.result);
                    if (typeof c.value === "number") expect(Number.isFinite(c.value)).toBe(true);
                }
                if (route.status === "targets_not_reachable" || route.status === "search_limit_max_step") {
                    expect(route.searchRan).toBe(true);
                    expect(route.candidatesUsable).toBeGreaterThan(0);
                    expect(route.plant).not.toBe("absent");
                }
                if (route.status === "plant_band_insufficient" || route.status === "plant_not_identified")
                    expect(route.candidate).toBeNull();
                if (route.status === "candidate_found") {
                    expect(route.candidate!.status).toBe("BLOCKED");
                    expect(route.candidate!.reasons).toContain("experimental_search_on_measured_margins");
                }
            }
            // An axis whose route found a candidate offers it (or a release-route one) in the experimental proposal.
            if ([d.primary, d.jio].some((x) => x?.status === "candidate_found"))
                expect(r.experimental?.items.some((i) => i.key.endsWith(`_${axis}`))).toBe(true);
        }
        expect(JSON.stringify(r.candidateDecisions)).not.toContain('"VALIDATED"');
        expect(r.releasableProposal).toBeNull();
    }, 120_000);
});

describe("measured-margin search and decision_band_gaps on simulated flights (block 6)", () => {
    const G = ratePlant({ K: 60, motorHz: 40, delayS: 0.002 });
    const decode = (envelope: (f: number) => number, name: string) => {
        const bytes = closedLoopChirpLog({ plants: [G, null, null], sweepS: 12, seed: 141, noise: 0.3, envelope });
        const sha = createHash("sha256").update(bytes).digest("hex");
        const [log] = buildLogInputs(bytes, sha, qualifyChirpFile(bytes, name, 45, AUTOTUNE_MATH), null);
        return runAutotuneV2({ primary: log, others: [], verifiedTune: null, createdAt: "2026-11-03T00:00:00Z" });
    };

    it("only the bounds' qualification missing: the search runs on in-band margins, finds a candidate, and it passes the experimental authority", () => {
        // A short excitation dip at 30–34 Hz that drops no bin: margins MEASURED (uncertainty unknown), no gaps.
        const r = decode((f) => (f >= 30 && f <= 34 ? 0 : 1), "clean.bbl");
        const d = r.candidateDecisions.roll!.primary!;
        expect(d.checks.find((c) => c.rule === "decision_band_gaps")).toMatchObject({ value: 0, result: "pass" });
        expect(d.checks.find((c) => c.rule === "margin_bounds_established")).toMatchObject({
            value: "MEASURED",
            result: "waived",
        });
        expect(d.status).toBe("candidate_found");
        expect(d.searchRan).toBe(true);
        expect(d.candidate!.status).toBe("BLOCKED");
        expect(r.releasableProposal).toBeNull();
        const x = r.experimental!;
        const roll = x.items.filter((i) => i.key.endsWith("_roll"));
        expect(roll.length).toBeGreaterThan(0);
        expect(roll.every((i) => i.source === "primary_route")).toBe(true);
        for (const it of roll) {
            const k = it.key.replace("_roll", "") as "p" | "i" | "d" | "d_max";
            expect(it.to).toBe(k === "d_max" ? d.candidate!.proposed.dMax : d.candidate!.proposed[k]);
        }
        setActivePinia(createPinia());
        const store = useAutotuneV2Store();
        store.state = "done";
        store.result = r;
        // No second flight imported: the cross-flight check is unknown, not passed, and withholds nothing.
        expect(r.recordingPlan.existing.secondFlight).toMatchObject({ flights: 0, state: "unknown" });
        expect(r.experimentalWithheld.find((w) => w.key === "pid_roll")).toBeUndefined();
        const decision = experimentalWriteDecision(x, { recompute: false });
        expect(decision.steps.find((st) => st.name === "analysis_binding")!.reasons).toEqual([]);
        expect(decision.steps.find((st) => st.name === "computable_items")!.reasons).toEqual([]);
        expect(decision.steps.find((st) => st.name === "values_technical")!.reasons).toEqual([]);
        expect(decision.verdict).toBe("EXPERIMENTAL_APPLY_ALLOWED");
    }, 120_000);

    it("a hole inside the decision band stops the search: decision_band_gaps with the bin count, no candidate", () => {
        const r = decode((f) => (f >= 10 && f <= 20 ? 0 : 1), "hole.bbl");
        const d = r.candidateDecisions.roll!.primary!;
        const gaps = d.checks.find((c) => c.rule === "decision_band_gaps")!;
        expect(gaps.result).toBe("fail");
        expect(gaps.value).toBe(3);
        expect(d.status).toBe("plant_band_insufficient");
        expect(d.searchRan).toBe(false);
        expect(d.candidate).toBeNull();
        expect(r.experimental?.items.some((i) => i.key.endsWith("_roll")) ?? false).toBe(false);
        expect(r.experimentalWithheld.find((w) => w.key === "pid_roll")!.reasons).toContain(
            "primary:plant_band_insufficient",
        );
        // The missing frequencies: the listed bins are exactly the bins the gap rule counts, inside the hole.
        const roll = r.recordingPlan.axes.find((a) => a.axis === "roll")!;
        expect(roll.kind).toBe("record");
        const holes = roll.missing
            .find((m) => m.route === "primary")!
            .intervals.filter((iv) => iv.kind === "decision_band_hole");
        expect(holes.reduce((n, iv) => n + iv.bins!, 0)).toBe(3);
        expect(d.missing.filter((iv) => iv.kind === "decision_band_hole")).toEqual(holes);
        for (const iv of holes) {
            expect(iv.fromHz).toBeGreaterThanOrEqual(9);
            expect(iv.toHz).toBeLessThanOrEqual(21);
            expect(iv.threshold).toMatch(/γ² ≥ 0\.8|±2ε < 0\.5|support|plant status/);
            if (iv.reason === "coherence") expect(iv.value).toBeLessThan(0.8);
        }
        expect(r.recordingPlan.sweep!.valid).toBe(true);
    }, 120_000);
});

const advice = (end: number): JioSweepAdvice => ({
    current: { f0Hz: 0.2, f1Hz: 600, durationS: 20, secondsPerOctave: 1.7, octavesAboveSupport: 3 },
    tuningBandHz: [6, 77],
    bandSufficientForTuning: false,
    target: { chirp_frequency_start_deci_hz: 20, chirp_frequency_end_deci_hz: end },
    suggested: {
        chirp_frequency_start_deci_hz: 20,
        chirp_frequency_end_deci_hz: end,
        chirp_time_seconds: 20,
        secondsPerOctave: 3.4,
        excitationGainDb: 2.9,
    },
    basis: ["supported_band:3.1-76.9Hz", "end_kept_at_tuning_band_top:77Hz", "tuning_band:6.0-77.0Hz"],
});
const HEADERS = {
    debug_mode: "96",
    "P interval": "1",
    chirp_frequency_start_deci_hz: "2",
    chirp_frequency_end_deci_hz: "6000",
    chirp_time_seconds: "20",
    chirp_amplitude_roll: "230",
    chirp_amplitude_pitch: "230",
    chirp_amplitude_yaw: "180",
};
function decision(status: RouteDecision["status"], extra: Partial<RouteDecision> = {}): RouteDecision {
    const fail = {
        rule: "gain_margin_shown_by_band",
        ref: "x",
        value: 2.86,
        unit: "dB",
        threshold: "phase crossing inside the band",
        result: "fail" as const,
        consequence: "c",
    };
    return {
        route: "primary",
        plant: "present_with_limitation",
        bandHz: [9.8, 37.1],
        metrics: null,
        current: null,
        checks: [fail],
        searchRan: false,
        candidatesTried: 0,
        candidatesUsable: 0,
        status,
        firstCause: status === "candidate_found" || status === "no_change_needed" ? null : fail,
        candidate: null,
        measurementUsable: true,
        missing: [],
        waived: [],
        ...extra,
    };
}
const rounds = (roll: number, pitch: number, yaw: number, present = [roll, pitch, yaw]) => ({
    roll: { present: present[0], complete: roll, usableComplete: roll },
    pitch: { present: present[1], complete: pitch, usableComplete: pitch },
    yaw: { present: present[2], complete: yaw, usableComplete: yaw },
});
const insufficient = { primary: decision("plant_band_insufficient"), jio: null };
const plan = (o: Partial<Parameters<typeof recordingPlan>[0]> = {}) =>
    recordingPlan({
        decisions: { roll: insufficient, pitch: insufficient, yaw: insufficient },
        headers: HEADERS,
        advice: {},
        plannerBandsHz: {},
        sweeps: rounds(2, 2, 2),
        crossFlight: {},
        ...o,
    });

describe("recordingPlan: the agreed two CHIRP rounds (block 7)", () => {
    it("one flight, two rounds roll → pitch → yaw, six activations of 20 s = 120 s; the second flight is optional", () => {
        const p = plan();
        expect(MEASUREMENT_AGREEMENT).toMatchObject({ rounds: 2, activations: 6, sweepS: 20, activeExcitationS: 120 });
        expect(p.timing).toMatchObject({ activations: 6, sweepS: 20, activeExcitationS: 120 });
        const per = RECORDING_TIMING.leadInS + 20 + RECORDING_TIMING.settleS + RECORDING_TIMING.pauseS;
        expect(p.timing.sequenceS).toBe(6 * per);
        expect(p.timing).not.toHaveProperty("flights");
        expect(p.procedure.find((x) => x.startsWith("Round 1"))).toContain("roll, then pitch, then yaw");
        expect(p.procedure.find((x) => x.startsWith("Round 2"))).toContain("roll, pitch, yaw");
        expect(p.procedure.join(" ")).toContain("120 s of excitation");
        expect(p.procedure.join(" ")).not.toMatch(/second, independent flight/i);
        expect(p.procedure.find((x) => x.startsWith("Switched off early"))).toContain("advances anyway");
        expect(p.secondFlight).toMatch(/^Optional/);
        expect(p.secondFlight).toContain("stays unknown");
        expect(p.secondFlight).toContain("not a pass");
        expect(p.note).toContain("no guarantee of a tuning proposal");
    });

    it("one shared sweep configuration: lowest start, highest end over the axes, covering every planner band", () => {
        const p = plan({
            advice: { roll: advice(1200), pitch: advice(1500), yaw: null },
            plannerBandsHz: {
                roll: [[6, 66], null],
                pitch: [
                    [6, 109],
                    [6, 72],
                ],
                yaw: [[5, 180]],
            },
        });
        const sw = p.sweep!;
        expect(sw.scope).toBe("pid_profile_shared_by_all_axes");
        const s = Object.fromEntries(sw.settings.map((x) => [x.name, x]));
        expect(s.chirp_frequency_start_deci_hz).toMatchObject({
            current: 2,
            proposed: 20,
            unit: "dHz",
            hz: { current: 0.2, proposed: 2 },
            changed: true,
        });
        // yaw has no advice: its planner top 180 Hz decides the shared end (rounded up to 10 Hz).
        expect(s.chirp_frequency_end_deci_hz).toMatchObject({
            current: 6000,
            proposed: 1800,
            hz: { current: 600, proposed: 180 },
            changed: true,
        });
        expect(s.chirp_time_seconds).toMatchObject({ current: 20, proposed: 20, changed: false });
        expect(sw.amplitudes.map((a) => [a.name, a.current, a.proposed, a.changed])).toEqual([
            ["chirp_amplitude_roll", 230, 230, false],
            ["chirp_amplitude_pitch", 230, 230, false],
            ["chirp_amplitude_yaw", 180, 180, false],
        ]);
        expect(sw.cli).toEqual([
            "set debug_mode = CHIRP",
            "set blackbox_sample_rate = 1/1",
            "set chirp_frequency_start_deci_hz = 20",
            "set chirp_frequency_end_deci_hz = 1800",
            "set chirp_time_seconds = 20",
            "save",
        ]);
        expect(sw.coverage.map((c) => [c.axis, c.covered])).toEqual([
            ["roll", true],
            ["pitch", true],
            ["yaw", true],
        ]);
        expect(sw.coverage.find((c) => c.axis === "pitch")!.plannerBandHz).toEqual([6, 109]);
        expect(sw.valid).toBe(true);
        expect(sw.firmwareChecks.every((c) => c.startsWith("ok:"))).toBe(true);
        // Narrower band, same 20 s: more excitation per octave than the 0.2–600 Hz sweep.
        expect(sw.excitationGainDb!).toBeGreaterThan(0);
    });

    it("firmware limits: an end above 1000 Hz is clamped and the axis is named not covered; a time other than 20 s is reset", () => {
        const p = plan({
            headers: { ...HEADERS, chirp_time_seconds: "30" },
            plannerBandsHz: { roll: [[6, 1200]] },
        });
        const s = Object.fromEntries(p.sweep!.settings.map((x) => [x.name, x]));
        expect(s.chirp_frequency_end_deci_hz.proposed).toBe(10000);
        expect(p.sweep!.coverage.find((c) => c.axis === "roll")!.covered).toBe(false);
        expect(p.sweep!.coverage.find((c) => c.axis === "pitch")!.covered).toBeNull();
        expect(p.sweep!.valid).toBe(true);
        expect(s.chirp_time_seconds).toMatchObject({ current: 30, proposed: 20, changed: true });
    });

    it("the start follows a planner band low under the advice start; a miss names whether a firmware clamp cut it", () => {
        const p = plan({ advice: { roll: advice(1200) }, plannerBandsHz: { roll: [[1.5, 66]] } });
        const s = Object.fromEntries(p.sweep!.settings.map((x) => [x.name, x]));
        expect(s.chirp_frequency_start_deci_hz.proposed).toBe(10);
        expect(p.sweep!.coverage.find((c) => c.axis === "roll")!.covered).toBe(true);
        const cut = plan({ plannerBandsHz: { roll: [[6, 1200]] } });
        expect(cut.sweep!.coverage.find((c) => c.axis === "roll")!.basis).toContain("cut by the firmware range");
    });

    it("a wrong debug mode and log rate are named as changes", () => {
        const p = plan({ headers: { ...HEADERS, debug_mode: "0", "P interval": "1/2" } });
        const s = Object.fromEntries(p.sweep!.settings.map((x) => [x.name, x]));
        expect(s.debug_mode).toMatchObject({ current: "0", proposed: "CHIRP", changed: true });
        expect(s.blackbox_sample_rate).toMatchObject({ current: "1/2", proposed: "1/1", changed: true });
    });

    it("existing data apart: complete, incomplete (five activations, one stopped early) and no rounds", () => {
        const full = plan();
        expect(full.existing.rounds).toMatchObject({ required: 2, complete: 2, usable: 2, state: "complete" });
        const five = plan({ sweeps: rounds(2, 2, 1) });
        expect(five.existing.rounds).toMatchObject({ complete: 1, state: "incomplete" });
        const early = plan({ sweeps: rounds(2, 1, 2, [2, 2, 2]) });
        expect(early.existing.rounds).toMatchObject({ complete: 1, state: "incomplete" });
        expect(early.existing.rounds.perAxis.find((a) => a.axis === "pitch")).toMatchObject({
            present: 2,
            complete: 1,
        });
        // Both rounds flown, one sweep excluded: not "rounds absent".
        const excluded = plan({
            sweeps: { ...rounds(2, 2, 2), pitch: { present: 2, complete: 2, usableComplete: 1 } },
        });
        expect(excluded.existing.rounds).toMatchObject({ complete: 2, usable: 1, state: "complete_not_usable" });
        const none = plan({ sweeps: {} });
        expect(none.existing.rounds).toMatchObject({ complete: 0, state: "none" });
        // The existing settings are as logged, with Hz beside dHz; they are not the proposal.
        const e = Object.fromEntries(full.existing.settings.map((x) => [x.name, x]));
        expect(e.chirp_frequency_end_deci_hz).toMatchObject({ current: "6000", hz: { current: 600 }, changed: false });
    });

    it("second flight: absent = unknown (not passed), consistent, inconsistent", () => {
        expect(plan().existing.secondFlight).toMatchObject({ flights: 0, state: "unknown" });
        const ok = { flights: 1, consistency: "consistent" as const };
        expect(plan({ crossFlight: { roll: ok, pitch: ok, yaw: ok } }).existing.secondFlight.state).toBe("consistent");
        expect(plan({ crossFlight: { roll: ok } }).existing.secondFlight.state).toBe("unknown");
        expect(
            plan({ crossFlight: { roll: ok, pitch: { flights: 1, consistency: "inconsistent" } } }).existing
                .secondFlight.state,
        ).toBe("inconsistent");
    });

    it("missing frequencies per axis and route reach the plan; a search limit or a candidate asks for no sweep", () => {
        const hole = {
            kind: "decision_band_hole" as const,
            fromHz: 12.2,
            toHz: 14.6,
            bins: 3,
            reason: "coherence" as const,
            value: 0.61,
            unit: "γ²",
            threshold: "γ² ≥ 0.8",
        };
        const p = plan({
            decisions: {
                roll: { primary: decision("plant_band_insufficient", { missing: [hole] }), jio: null },
                pitch: {
                    primary: decision("measurement_rejected_by_quality_gate"),
                    jio: decision("search_limit_max_step", {
                        route: "jio",
                        searchRan: true,
                        candidatesTried: 169,
                        candidatesUsable: 102,
                    }),
                },
                yaw: { primary: decision("candidate_found"), jio: null },
            },
        });
        expect(p.axes.map((a) => [a.axis, a.kind])).toEqual([
            ["roll", "record"],
            ["pitch", "search_limit"],
            ["yaw", "candidate"],
        ]);
        expect(p.axes[0].missing).toEqual([{ route: "primary", intervals: [hole] }]);
        expect(p.axes[1].note).toContain("More data does not lift this");
        expect(p.recordingNeeded).toBe(true);
        const none = plan({
            decisions: {
                pitch: {
                    primary: decision("search_constrained_by_verified_tune", {
                        firstCause: {
                            rule: "verified_tune_segment",
                            ref: "x",
                            value: "f_pitch:120->140",
                            unit: "",
                            threshold: "t",
                            result: "fail",
                            consequence: "c",
                        },
                    }),
                    jio: null,
                },
                roll: { primary: decision("candidate_found"), jio: null },
                yaw: { primary: decision("no_change_needed"), jio: null },
            },
        });
        expect(none.recordingNeeded).toBe(false);
        expect(none.sweep).toBeNull();
        expect(none.procedure).toEqual([]);
        expect(none.axes[1].note).toContain("gain_change_flight_with_feedforward_unchanged");
    });

    it("band shortfall: never an inverted interval when the first bin outside lies past the planner top", () => {
        const bin = (f: number, coherence: number) => ({
            frequencyHz: f,
            status: "ok",
            G: { re: 1, im: 0 },
            coherence,
        });
        const loop = {
            plant: { bins: [bin(60, 0.9), bin(62, 0.9), bin(64, 0.9), bin(66, 0.5)] },
            support: null,
            uncertainty: null,
        } as unknown as AxisLoop;
        const [iv] = bandShortfall(loop, [60, 64], [60, 65]);
        expect(iv).toMatchObject({
            kind: "above_identified_band",
            fromHz: 64,
            toHz: 65,
            reason: "coherence",
            value: 0.5,
        });
        const [wide] = bandShortfall(loop, [60, 62], [60, 70]);
        expect(wide).toMatchObject({ fromHz: 64, toHz: 70 });
    });

    it("frequency display: dHz with Hz beside it", () => {
        expect(deciHzText(1900)).toBe("1900 dHz (190.0 Hz)");
        expect(deciHzText(20)).toBe("20 dHz (2.0 Hz)");
        expect(deciHzText(null)).toBe("unknown");
    });
});

describe("experimental proposal from measured in-band candidates", () => {
    const cand = (axis: AxisPidProposal["axis"], p: number): AxisPidProposal => ({
        axis,
        current: { p: 56, i: 79, d: 0, dMax: 0 },
        proposed: { p, i: 95, d: 0, dMax: 0 },
        changed: true,
        currentMargins: margins({}),
        proposedMargins: margins({}),
        outcome: "improved",
        status: "BLOCKED",
        reasons: ["experimental_search_on_measured_margins", "margin_evidence:MEASURED"],
    });
    const buildProposal = (selected: ProposalItem[]): AbsoluteProposal => ({
        id: "v2-x",
        createdAt: "2026-11-03T00:00:00Z",
        log: { sha256: "d".repeat(64), logIndex: 0, headerPairs: [] },
        change: Object.fromEntries(selected.map((s) => [s.key, s.to])),
        items: selected,
        release: {
            measurement: { valid: false, reasons: ["chirp_rejected:roll"] },
            model: { status: "PARTIAL", reasons: [] },
            margins: [],
            independentValidation: null,
            safetyAnalysisEvidence: "not_available",
            safetyReasons: [],
        },
    });

    it("a primary measured candidate is offered with its limitation; the measurement validity follows the item source", () => {
        const strict = {
            ...cand("yaw", 56),
            changed: false,
            outcome: "targets_not_reachable" as const,
            reasons: ["no_candidate_meets_all_targets"],
        };
        const out = buildExperimentalProposal({
            primaryItems: [],
            primaryPid: [strict],
            jio: null,
            decisions: {
                yaw: {
                    primary: decision("candidate_found", { candidate: cand("yaw", 67), searchRan: true }),
                    jio: null,
                },
            },
            buildProposal,
        });
        const x = out.proposal!;
        expect(x.items.map((i) => [i.key, i.from, i.to, i.source])).toEqual([
            ["p_yaw", 56, 67, "primary_route"],
            ["i_yaw", 79, 95, "primary_route"],
        ]);
        expect(x.limitations).toContain("experimental:yaw:margins_measured_in_band_not_bounded");
        expect(x.proposal.release.measurement.valid).toBe(true);
    });

    it("a primary measured candidate on an unusable measurement is not offered; a JIO one is, resting on the JIO record", () => {
        const out = buildExperimentalProposal({
            primaryItems: [],
            primaryPid: [],
            jio: {
                chain: {
                    roll: {
                        axis: "roll",
                        margins: null,
                        candidate: null,
                        plan: null,
                        tuningComputable: true,
                        reasons: ["stationarity_unknown:single_sweep"],
                    },
                },
            } as never,
            decisions: {
                roll: {
                    primary: decision("candidate_found", { candidate: cand("roll", 50), measurementUsable: false }),
                    jio: decision("candidate_found", { route: "jio", candidate: cand("roll", 52) }),
                },
            },
            buildProposal,
        });
        const x = out.proposal!;
        expect(x.items.every((i) => i.source === "jio_route")).toBe(true);
        expect(x.items[0].to).toBe(52);
        expect(x.proposal.release.measurement).toEqual({ valid: true, reasons: ["jio_route_measurement_used:roll"] });
    });

    it("withheld names each route's status and the failing rule with its value; a non-finite candidate is never offered", () => {
        const bad = { ...cand("pitch", 60), proposed: { p: Number.NaN, i: 95, d: 0, dMax: 0 } };
        const out = buildExperimentalProposal({
            primaryItems: [],
            primaryPid: [],
            jio: null,
            decisions: {
                roll: { primary: decision("plant_band_insufficient"), jio: null },
                pitch: { primary: decision("candidate_found", { candidate: bad }), jio: null },
            },
            buildProposal,
        });
        expect(out.proposal).toBeNull();
        const roll = out.withheld.find((w) => w.key === "pid_roll")!;
        expect(roll.reasons).toContain("primary:plant_band_insufficient");
        expect(roll.reasons.some((r) => r.startsWith("gain_margin_shown_by_band=2.86 dB"))).toBe(true);
        expect(out.withheld.some((w) => w.key === "pid_pitch")).toBe(true);
    });
});
