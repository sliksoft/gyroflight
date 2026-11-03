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
 * Block 6: the per-axis candidate decision (candidateDecision.ts), the recording instructions it
 * drives (recordingInstruction.ts) and the experimental proposal built from measured in-band
 * margins. A missing plant, an insufficient band and a real search failure are separate statuses;
 * unknown is never a zero; nothing is fabricated. SIMULATION ONLY.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildLogInputs } from "../../src/gyrocore/engine/logInput";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { runAutotuneV2, type AutotuneLogInput } from "../../src/gyrocore/engine/autotuneV2";
import { decideAxis, metricStates, type RouteDecision } from "../../src/gyrocore/engine/candidateDecision";
import { recordingInstructions, RECORDING_TIMING } from "../../src/gyrocore/engine/recordingInstruction";
import { buildExperimentalProposal } from "../../src/gyrocore/engine/experimentalProposal";
import type { LoopMargins } from "../../src/gyrocore/engine/loopModel";
import type { AxisPidProposal } from "../../src/gyrocore/engine/pidOptimizer";
import type { AbsoluteProposal, ProposalItem } from "../../src/gyrocore/releaseGate/releaseContract";
import type { JioSweepAdvice } from "../../src/gyrocore/engine/jioSweep";
import { closedLoopChirpLog, ratePlant } from "./harness/closedLoopBbl";

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

const advice = (end: number): JioSweepAdvice => ({
    current: { f0Hz: 0.2, f1Hz: 600, durationS: 20, secondsPerOctave: 1.7, octavesAboveSupport: 3 },
    tuningBandHz: [6, 77],
    bandSufficientForTuning: false,
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
        waived: [],
        ...extra,
    };
}

describe("recordingInstructions follow the failed check", () => {
    it("band insufficient: firmware-settable sweep in dHz, debug mode, log rate, axis order, timing; nothing silently changed", () => {
        const [ins] = recordingInstructions({
            decisions: { roll: { primary: decision("plant_band_insufficient"), jio: null } },
            headers: HEADERS,
            advice: { roll: advice(1200) },
        });
        expect(ins.kind).toBe("record");
        expect(ins.trigger).toMatchObject({
            route: "primary",
            status: "plant_band_insufficient",
            rule: "gain_margin_shown_by_band",
            value: 2.86,
        });
        const s = Object.fromEntries(ins.settings.map((x) => [x.name, x]));
        expect(s.debug_mode).toMatchObject({ current: "96", changed: false });
        expect(s.blackbox_sample_rate.changed).toBe(false);
        expect(s.chirp_frequency_end_deci_hz).toMatchObject({
            current: 6000,
            required: 1200,
            unit: "dHz (0.1 Hz)",
            changed: true,
        });
        expect(s.chirp_frequency_start_deci_hz).toMatchObject({ current: 2, required: 20, changed: true });
        expect(s.chirp_time_seconds).toMatchObject({ current: 20, required: 20, changed: false });
        expect(s.chirp_amplitude_roll).toMatchObject({ current: "230", required: "230", changed: false });
        expect(ins.procedure.some((p) => p.includes("roll → pitch → yaw → roll"))).toBe(true);
        const per = RECORDING_TIMING.leadInS + 20 + RECORDING_TIMING.settleS + RECORDING_TIMING.pauseS;
        expect(ins.timing).toMatchObject({
            activationsPerFlight: 6,
            sweepS: 20,
            perActivationS: per,
            chirpTimePerFlightS: 6 * per,
            flights: 2,
            totalChirpTimeS: 12 * per,
        });
        expect(ins.timing!.experimental.some((e) => e.includes("not known to the app"))).toBe(true);
        expect(ins.completionChecks.some((c) => c.includes("γ² ≥ 0.8"))).toBe(true);
        expect(ins.notChanged.join(" ")).toContain("anti-gravity");
        expect(ins.note).toContain("no guarantee of a proposal");
    });

    it("a wrong debug mode and log rate are named as changes", () => {
        const [ins] = recordingInstructions({
            decisions: { pitch: { primary: decision("plant_not_identified"), jio: null } },
            headers: { ...HEADERS, debug_mode: "0", "P interval": "1/2" },
            advice: {},
        });
        const s = Object.fromEntries(ins.settings.map((x) => [x.name, x]));
        expect(s.debug_mode.changed).toBe(true);
        expect(s.blackbox_sample_rate.changed).toBe(true);
        expect(s.chirp_frequency_end_deci_hz).toMatchObject({ required: 6000, changed: false });
    });

    it("a usable plant whose search fails asks for no data; a found candidate needs no instruction", () => {
        const out = recordingInstructions({
            decisions: {
                roll: {
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
            headers: HEADERS,
            advice: {},
        });
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ axis: "roll", kind: "none_search_limit", settings: [], timing: null });
        expect(out[0].note).toContain("More data does not lift this");
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
