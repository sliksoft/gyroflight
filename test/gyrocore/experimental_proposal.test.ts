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
 * EXPERIMENTAL proposal (block 5): which values the engine offers when only qualification is
 * missing, which it withholds when the measurement does not support them, how the JIO route fills
 * in, and that nothing of it reaches proposal / releasableProposal. Plus the experimental authority
 * against the real analysis binding (store state). SIMULATION ONLY.
 */

import { createHash } from "node:crypto";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import { buildLogInputs } from "../../src/gyrocore/engine/logInput";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import {
    runAutotuneV2,
    type AutotuneLogInput,
    type AutotuneV2Result,
    type JioRouteResult,
} from "../../src/gyrocore/engine/autotuneV2";
import { buildExperimentalProposal, dataInsufficientReasons } from "../../src/gyrocore/engine/experimentalProposal";
import type { AxisPidProposal } from "../../src/gyrocore/engine/pidOptimizer";
import type { LoopMargins } from "../../src/gyrocore/engine/loopModel";
import type { AbsoluteProposal, ProposalItem } from "../../src/gyrocore/releaseGate/releaseContract";
import { experimentalWriteDecision } from "../../src/gyrocore/releaseGate/experimentalAuthority";
import { useAutotuneV2Store } from "../../src/gyrocore/stores/autotuneV2";
import { closedLoopChirpLog, ratePlant, type ClosedLoopLogOptions } from "./harness/closedLoopBbl";

function decoded(o: ClosedLoopLogOptions, name: string): AutotuneLogInput {
    const bytes = closedLoopChirpLog(o);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const [log] = buildLogInputs(bytes, sha, qualifyChirpFile(bytes, name, 45, AUTOTUNE_MATH), null);
    expect(log, name).toBeDefined();
    return log;
}
const run = (primary: AutotuneLogInput, others: AutotuneLogInput[] = []): AutotuneV2Result =>
    runAutotuneV2({ primary, others, verifiedTune: null, createdAt: "2026-11-03T00:00:00Z" });

const margins = (level: string, status: LoopMargins["status"] = "NOT_VALIDATED"): LoopMargins =>
    ({
        status,
        crossoverHz: 25,
        phaseMarginDeg: 45,
        gainMarginDb: 8,
        sensitivityPeakDb: 5,
        measured: { phaseMarginDeg: 45, gainMarginDb: 8, sensitivityPeakDb: 5 },
        evidence: { level },
        reasons: [],
    }) as unknown as LoopMargins;

function pidCandidate(
    axis: AxisPidProposal["axis"],
    outcome: AxisPidProposal["outcome"],
    proposed: Partial<AxisPidProposal["proposed"]> = {},
    reasons: string[] = [],
): AxisPidProposal {
    const current = { p: 45, i: 80, d: 30, dMax: 40 };
    const next = { ...current, ...proposed };
    const changed = JSON.stringify(next) !== JSON.stringify(current);
    return {
        axis,
        current,
        proposed: next,
        changed,
        currentMargins: margins("MEASURED"),
        proposedMargins: margins("MEASURED"),
        outcome,
        status:
            outcome === "targets_not_reachable" || outcome === "not_computable"
                ? "BLOCKED"
                : changed
                  ? "BLOCKED"
                  : "PARTIAL",
        reasons,
    };
}

const buildProposal = (selected: ProposalItem[]): AbsoluteProposal | null =>
    selected.length
        ? {
              id: `v2-${selected.map((s) => `${s.key}=${s.to}`).join(",")}`,
              createdAt: "2026-11-03T00:00:00Z",
              log: { sha256: "c".repeat(64), logIndex: 0, headerPairs: [] },
              change: Object.fromEntries(selected.map((s) => [s.key, s.to])),
              items: selected,
              release: {
                  measurement: { valid: true, reasons: [] },
                  model: { status: "PARTIAL", reasons: [] },
                  margins: [],
                  independentValidation: null,
                  safetyAnalysisEvidence: "not_available",
                  safetyReasons: [],
              },
          }
        : null;

describe("buildExperimentalProposal: computable values offered, unsupported ones withheld, nothing invented", () => {
    it("an improved primary candidate with MEASURED evidence is offered with its qualification gaps", () => {
        const x = buildExperimentalProposal({
            primaryItems: [],
            primaryPid: [
                pidCandidate("roll", "improved", { p: 52, d: 34 }, [
                    "margins:evidence_measured",
                    "required_measurement:x",
                ]),
            ],
            jio: null,
            buildProposal,
        }).proposal!;
        expect(x.status).toBe("EXPERIMENTAL");
        expect(x.hardwareValidated).toBe(false);
        expect(x.proposal.id.startsWith("v2x-")).toBe(true);
        expect(x.items.map((i) => [i.key, i.from, i.to, i.source])).toEqual([
            ["p_roll", 45, 52, "primary_route"],
            ["d_roll", 30, 34, "primary_route"],
        ]);
        expect(x.items[0].evidence).toBe("MEASURED");
        expect(x.items[0].qualificationGaps).toContain("required_measurement:x");
        expect(x.proposal.change).toEqual({ p_roll: 52, d_roll: 34 });
        expect(x.limitations).toContain("experimental:roll:margin_evidence_MEASURED");
        expect(x.withheld).toEqual([]);
    });

    it("targets not reachable or not computable: withheld with the data reason, never a value", () => {
        const x = buildExperimentalProposal({
            primaryItems: [],
            primaryPid: [
                pidCandidate("roll", "targets_not_reachable", { p: 40 }, ["no_candidate_meets_all_targets"]),
                pidCandidate("pitch", "not_computable", {}, ["current_loop_margins_not_computable"]),
                pidCandidate("yaw", "improved", { p: 50 }),
            ],
            jio: null,
            buildProposal,
        }).proposal!;
        expect(x.items.map((i) => i.key)).toEqual(["p_yaw"]);
        expect(x.withheld.map((w) => w.key)).toEqual(["pid_roll", "pid_pitch"]);
        expect(x.withheld[0].reasons).toContain("no_candidate_meets_all_targets");
        expect(x.withheld[1].reasons).toContain("primary:not_computable");
        // Nothing withheld leaks into the change.
        expect(Object.keys(x.proposal.change)).toEqual(["p_yaw"]);
    });

    it("no computable value anywhere: no experimental proposal at all", () => {
        expect(
            buildExperimentalProposal({
                primaryItems: [
                    {
                        key: "gyro_lpf1_static_hz",
                        part: "gyro_filter",
                        from: 250,
                        to: 300,
                        status: "BLOCKED",
                        reasons: ["chain_model_not_validated_on_this_log"],
                    },
                ],
                primaryPid: [pidCandidate("roll", "targets_not_reachable", {}, ["no_candidate_meets_all_targets"])],
                jio: null,
                buildProposal,
            }).proposal,
        ).toBeNull();
        // The reasons stay visible even without a proposal.
        const none = buildExperimentalProposal({
            primaryItems: [],
            primaryPid: [pidCandidate("roll", "targets_not_reachable", {}, ["no_candidate_meets_all_targets"])],
            jio: null,
            buildProposal,
        });
        expect(none.proposal).toBeNull();
        expect(none.withheld.map((w) => w.key)).toEqual(["pid_roll"]);
    });

    it("a JIO candidate fills an axis the primary route cannot, named as such with its limitations", () => {
        const jio = {
            status: "DIAGNOSTIC",
            chain: {
                roll: {
                    axis: "roll",
                    margins: null,
                    candidate: pidCandidate("roll", "restores_margins", { p: 48, i: 84 }, [
                        "jio_experimental_never_validated",
                    ]),
                    plan: null,
                    tuningComputable: true,
                    reasons: ["stationarity_unknown:single_sweep", "cross_flight_repeat:none"],
                },
            },
        } as unknown as JioRouteResult;
        const x = buildExperimentalProposal({
            primaryItems: [],
            primaryPid: [pidCandidate("roll", "targets_not_reachable", {}, ["no_candidate_meets_all_targets"])],
            jio,
            buildProposal,
        }).proposal!;
        expect(x.items.map((i) => [i.key, i.to, i.source])).toEqual([
            ["p_roll", 48, "jio_route"],
            ["i_roll", 84, "jio_route"],
        ]);
        expect(x.items[0].reasons).toContain("jio_uncertainty_n_eff_not_calibrated");
        expect(x.items[0].qualificationGaps).toContain("stationarity_unknown:single_sweep");
        expect(x.limitations).toContain("experimental:roll:values_from_jio_route_uncalibrated_uncertainty");
        expect(x.withheld).toEqual([]);
    });

    it("a JIO candidate blocked by inconsistent repeats or cross-flight disagreement is withheld", () => {
        const jio = {
            status: "DIAGNOSTIC",
            chain: {
                roll: {
                    axis: "roll",
                    margins: null,
                    candidate: pidCandidate("roll", "improved", { p: 48 }, ["jio_cross_flight_inconsistent"]),
                    plan: null,
                    tuningComputable: true,
                    reasons: ["jio_cross_flight_inconsistent:z:3.10:plant_z:2.50"],
                },
            },
        } as unknown as JioRouteResult;
        const none = buildExperimentalProposal({ primaryItems: [], primaryPid: [], jio, buildProposal });
        expect(none.proposal).toBeNull();
        expect(none.withheld[0].reasons).toContain("jio_cross_flight_inconsistent");
        expect(dataInsufficientReasons(["jio_cross_flight_inconsistent:z:3.10"])).toHaveLength(1);
    });

    it("a JIO candidate is refused when the chain itself carries a data blocker, whatever the candidate says", () => {
        const jio = {
            status: "DIAGNOSTIC",
            chain: {
                roll: {
                    axis: "roll",
                    margins: null,
                    candidate: pidCandidate("roll", "improved", { p: 48 }),
                    plan: null,
                    tuningComputable: true,
                    reasons: ["jio_repeats_inconsistent"],
                },
            },
        } as unknown as JioRouteResult;
        const none = buildExperimentalProposal({ primaryItems: [], primaryPid: [], jio, buildProposal });
        expect(none.proposal).toBeNull();
        expect(none.withheld[0].reasons).toContain("jio_repeats_inconsistent");
    });

    it("an axis unchanged on one route but unreachable on the other is still withheld", () => {
        const jio = {
            status: "DIAGNOSTIC",
            chain: {
                roll: {
                    axis: "roll",
                    margins: null,
                    candidate: pidCandidate("roll", "no_change_needed"),
                    plan: null,
                    tuningComputable: true,
                    reasons: [],
                },
            },
        } as unknown as JioRouteResult;
        const none = buildExperimentalProposal({
            primaryItems: [],
            primaryPid: [pidCandidate("roll", "targets_not_reachable", {}, ["no_candidate_meets_all_targets"])],
            jio,
            buildProposal,
        });
        expect(none.withheld.map((w) => w.key)).toEqual(["pid_roll"]);
    });

    it("filters and feedforward: PARTIAL is offered, BLOCKED withheld; an axis with no change is not withheld", () => {
        const x = buildExperimentalProposal({
            primaryItems: [
                {
                    key: "dterm_lpf1_static_hz",
                    part: "dterm_filter",
                    from: 75,
                    to: 90,
                    status: "PARTIAL",
                    reasons: ["dterm_path_measured_only"],
                },
                {
                    key: "f_pitch",
                    part: "feedforward",
                    from: 120,
                    to: 130,
                    status: "BLOCKED",
                    reasons: ["stick_latency_not_measured"],
                },
            ],
            primaryPid: [pidCandidate("roll", "no_change_needed")],
            jio: null,
            buildProposal,
        }).proposal!;
        expect(x.items.map((i) => i.key)).toEqual(["dterm_lpf1_static_hz"]);
        expect(x.withheld.map((w) => w.key)).toEqual(["f_pitch"]);
    });
});

describe("experimental proposal through the engine on simulated flights", () => {
    const G = ratePlant({ K: 60, motorHz: 40, delayS: 0.002 });

    it("never enters proposal / releasableProposal, mirrors the primary candidates, withholds the unreachable", () => {
        const r = run(
            decoded(
                { plants: [G, G, null], sweepS: 12, seed: 121, jio: { disturbance: { sd: 3, poleHz: 300 } } },
                "x.bbl",
            ),
        );
        const x = r.experimental;
        expect(r.releasableProposal).toBeNull();
        for (const axis of ["roll", "pitch"] as const) {
            const pid = r.pid.find((p) => p.axis === axis)!;
            const computable = pid.changed && ["improved", "restores_margins"].includes(pid.outcome);
            const jioCand = r.jio.chain[axis]?.candidate ?? null;
            const jioComputable =
                !!jioCand && jioCand.changed && ["improved", "restores_margins"].includes(jioCand.outcome);
            const keys = x?.items.filter((i) => i.key.endsWith(`_${axis}`)).map((i) => i.key) ?? [];
            if (computable) {
                expect(keys.length).toBeGreaterThan(0);
                for (const it of x!.items.filter((i) => i.key.endsWith(`_${axis}`))) {
                    expect(it.source).toBe("primary_route");
                    const k = it.key.replace(`_${axis}`, "") as "p" | "i" | "d" | "d_max";
                    expect(it.to).toBe(k === "d_max" ? pid.proposed.dMax : pid.proposed[k]);
                }
            } else if (jioComputable) {
                expect(keys.length).toBeGreaterThan(0);
                expect(x!.items.filter((i) => i.key.endsWith(`_${axis}`)).every((i) => i.source === "jio_route")).toBe(
                    true,
                );
            } else {
                expect(keys).toEqual([]);
                if (pid.outcome !== "no_change_needed" && jioCand?.outcome !== "no_change_needed")
                    expect(r.experimentalWithheld.some((w) => w.key === `pid_${axis}`)).toBe(true);
            }
        }
        if (x) {
            expect(x.proposal.id.startsWith("v2x-")).toBe(true);
            expect(JSON.stringify(x)).not.toContain('"VALIDATED"');
            expect(x.hardwareValidated).toBe(false);
            expect(r.proposal?.id).not.toBe(x.proposal.id);
        }
    }, 120_000);
});

describe("experimental authority against the real analysis binding", () => {
    beforeEach(() => {
        setActivePinia(createPinia());
    });

    it("refuses when the analysis is not done, binds to the experimental proposal, refuses a differing one", () => {
        const x = buildExperimentalProposal({
            primaryItems: [],
            primaryPid: [pidCandidate("roll", "improved", { p: 52 }, ["margins:evidence_measured"])],
            jio: null,
            buildProposal: (sel) => {
                const p = buildProposal(sel)!;
                return {
                    ...p,
                    log: {
                        ...p.log,
                        headerPairs: [
                            ["Firmware revision", "Betaflight 2026.6.2 (43875a55a) STM32G474"],
                            ["Board information", "BEFH BETAFPVG473"],
                            ["DeviceUID", "0a1b2c3d4e5f607112233445"],
                            ["rollPID", "45,80,30"],
                            ["pitchPID", "47,84,34"],
                            ["yawPID", "45,80,0"],
                        ],
                    },
                };
            },
        }).proposal!;
        const store = useAutotuneV2Store();
        let d = experimentalWriteDecision(x, { recompute: false });
        expect(d.verdict).toBe("EXPERIMENTAL_APPLY_DENIED");
        expect(d.blocks).toContain("binding:analysis_not_done:idle");
        store.state = "done";
        store.result = { experimental: x, releasableProposal: null } as unknown as AutotuneV2Result;
        d = experimentalWriteDecision(x, { recompute: false });
        expect(d.steps.find((s) => s.name === "analysis_binding")!.passed).toBe(true);
        expect(d.steps.find((s) => s.name === "computable_items")!.passed).toBe(true);
        const other = { ...x, proposal: { ...x.proposal, id: "v2x-other" } };
        d = experimentalWriteDecision(other, { recompute: false });
        expect(d.blocks).toContain("binding:proposal_differs_from_analysis");
        // A releasable proposal in the store never satisfies the experimental binding.
        store.result = { experimental: null, releasableProposal: x.proposal } as unknown as AutotuneV2Result;
        d = experimentalWriteDecision(x, { recompute: false });
        expect(d.blocks).toContain("binding:no_experimental_proposal");
    });
});
