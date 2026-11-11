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
 * Block 12: joint PID + filter search (jointSearch.ts) on a stand-in loop model and chain simulation.
 * The margins are a function of the P scale, the gyro lowpass scale (read from the candidate chain the
 * search hands loopMargins) and the D-term lowpass scale (read from the controller's dtermLpf1Hz); the
 * chain simulation scales the logged gyroUnfilt by √(gyro scale), so less filtering costs noise.
 */

import { describe, expect, it, vi } from "vitest";
import type { AxisLoop, LoopMargins } from "../../src/gyrocore/engine/loopModel";
import type { DigitalControllerConfig } from "../../src/js/blackbox/betaflight_digital_controller";
import type { RouteDecision } from "../../src/gyrocore/engine/candidateDecision";
import type { DtermDynamicConfig } from "../../src/js/blackbox/betaflight_dterm_dynamic";
import type { GyroChainConfig } from "../../src/gyrocore/engine/gyroChain";

const P0 = 100;
const LPF1 = 100;
const DLPF1 = 50;
const FC0 = 30;

// pm(P scale, gyro scale, D-LPF scale); GM and |S| always met; crossover follows P.
let model: (ps: number, sg: number, sd: number) => { pm: number; gm: number; s: number; fc: number } = (
    ps,
    sg,
    sd,
) => ({
    pm: 28 + 40 * (sg - 1) - 30 * (ps - 1) + 0 * (sd - 1),
    gm: 10,
    s: 5,
    fc: FC0 * ps,
});

vi.mock("../../src/gyrocore/engine/loopModel", async (importOriginal) => {
    const orig = await importOriginal<typeof import("../../src/gyrocore/engine/loopModel")>();
    return {
        ...orig,
        loopMargins: (
            loop: AxisLoop,
            cand?: { cfg: DigitalControllerConfig; chain?: { lpf1: number } | null },
        ): LoopMargins => {
            const cfg = cand?.cfg ?? loop.cfg;
            const sg = cand?.chain ? cand.chain.lpf1 / LPF1 : 1;
            const sd = (cfg.dtermLpf1Hz ?? DLPF1) / DLPF1;
            const m = model(cfg.axis.p / P0, sg, sd);
            return {
                status: "NOT_VALIDATED",
                crossoverHz: m.fc,
                phaseMarginDeg: m.pm,
                gainMarginDb: null,
                sensitivityPeakDb: null,
                delayMarginMs: null,
                chainSpreadDeg: null,
                okBins: 20,
                evidence: {
                    level: "MEASURED",
                    resolutionHz: 1.95,
                    bandHz: [7.8, 97],
                    minFeatureWidthHz: null,
                    assumptions: [],
                    qualification: null,
                },
                measured: { phaseMarginDeg: m.pm, gainMarginDb: m.gm, sensitivityPeakDb: m.s },
                reasons: [],
            } as unknown as LoopMargins;
        },
    };
});

vi.mock("../../src/gyrocore/engine/gyroChain", async (importOriginal) => {
    const orig = await importOriginal<typeof import("../../src/gyrocore/engine/gyroChain")>();
    return {
        ...orig,
        // Less filtering: the gyro the controller sees carries more of the logged (unfiltered) noise.
        simulateGyroChain: (input: { gyroUnfilt: ArrayLike<number>[] }, cfg: GyroChainConfig) => {
            const k = Math.sqrt(cfg.lpf1StaticHz / LPF1);
            const n = input.gyroUnfilt[0].length;
            const out = [0, 1, 2].map((a) =>
                Float64Array.from({ length: n }, (_, i) => Number(input.gyroUnfilt[a][i]) * k),
            );
            return { out, valid: new Uint8Array(n).fill(1), runs: 1, notes: [] };
        },
        effectiveChainFrf: (_sim: unknown, cfg: GyroChainConfig) => ({
            lpf1: cfg.lpf1StaticHz,
            frf: () => ({ re: 1, im: 0 }),
        }),
    };
});

vi.mock("../../src/js/blackbox/betaflight_dterm_dynamic", async (importOriginal) => {
    const orig = await importOriginal<typeof import("../../src/js/blackbox/betaflight_dterm_dynamic")>();
    return {
        ...orig,
        // D output: a fraction of the gyro input, growing with the D-LPF cutoff (less filtering).
        simulateDterm: (input: { gyro: ArrayLike<number> }, cfg: DtermDynamicConfig) => {
            const n = input.gyro.length;
            const k = 0.02 * (cfg.dtermLpf1StaticHz / DLPF1);
            return {
                d: Float64Array.from({ length: n }, (_, i) => Number(input.gyro[i]) * k),
                valid: new Uint8Array(n).fill(1),
                runs: 1,
                notes: [],
            };
        },
    };
});

import { jointSearch, JOINT_SEARCH, type JointAxisInput } from "../../src/gyrocore/engine/jointSearch";
import { buildExperimentalProposal } from "../../src/gyrocore/engine/experimentalProposal";
import type { ProposalItem } from "../../src/gyrocore/releaseGate/releaseContract";

const N = 8192;
const FS = 1000;
// Deterministic broadband "noise" (a fixed pseudo-random sequence) so the Welch band power is non-zero.
let seed = 12345;
const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
};
const unfilt = [0, 1, 2].map(() => Float64Array.from({ length: N }, () => 200 * rnd()));
const timeUs = Float64Array.from({ length: N }, (_, i) => i * 1000);
const rcThrottle = new Float64Array(N).fill(1300);
const mask = new Uint8Array(N).fill(1);

const chainCfg: GyroChainConfig = {
    gyroDt: 0.001,
    pidDt: 0.001,
    lpf1Type: 0,
    lpf1StaticHz: LPF1,
    lpf1DynMinHz: LPF1,
    lpf1DynMaxHz: 2 * LPF1,
    lpf1DynExpo: 5,
    lpf2Type: 0,
    lpf2StaticHz: 2 * LPF1,
    notch1Hz: 0,
    notch2Hz: 0,
    rpmHarmonics: 0,
    rpmMinHz: 100,
    rpmFadeRangeHz: 50,
    rpmQ: 500,
    rpmWeights: [100, 100, 100],
    rpmLpfHz: 150,
    motorPoles: 14,
    dynNotchCount: 0,
    dynNotchQ: 300,
    dynNotchMinHz: 100,
    dynNotchMaxHz: 600,
};
const dterm: DtermDynamicConfig = {
    pidDt: 0.001,
    d: 30,
    dMax: 40,
    dMaxGain: 20,
    dMaxAdvance: 35,
    dtermLpf1Type: 0,
    dtermLpf1StaticHz: DLPF1,
    dtermLpf1DynMinHz: DLPF1,
    dtermLpf1DynMaxHz: 2 * DLPF1,
    dtermLpf1DynExpo: 5,
    dtermLpf2Type: 0,
    dtermLpf2StaticHz: 2 * DLPF1,
    dtermNotchHz: 0,
    tpaRate: 60,
    tpaBreakpoint: 1350,
    tpaLowRate: 20,
    tpaLowBreakpoint: 1050,
    tpaLowAlways: false,
    throttleLimitType: 0,
};
const current = { p: P0, i: 79, d: 30, dMax: 40 };
const loop = {
    axis: 0,
    cfg: {
        axis: { p: P0, i: 79, d: 30 },
        pidDt: 0.001,
        gyroDt: 0.001,
        dtermLpf1Hz: DLPF1,
        dtermLpf2Hz: 2 * DLPF1,
    } as unknown as DigitalControllerConfig,
    chain: { lpf1: LPF1 },
    chainValidated: true,
    plant: { bins: [] },
} as unknown as AxisLoop;

function decision(candidateFound: boolean): RouteDecision {
    const cur = model(1, 1, 1);
    const cand = candidateFound ? { p: 80, i: 79, d: 30, dMax: 40 } : null;
    const cm = cand ? model(0.8, 1, 1) : null;
    return {
        route: "primary",
        plant: "present_with_limitation",
        bandHz: [7.8, 97],
        metrics: null,
        current: { crossoverHz: cur.fc, pmDeg: cur.pm, gmDb: cur.gm, sDb: cur.s },
        checks: [],
        searchRan: true,
        candidatesTried: 2197,
        candidatesUsable: 2197,
        status: candidateFound ? "candidate_found" : "targets_not_reachable",
        firstCause: null,
        candidate: cand
            ? ({
                  axis: "roll",
                  current,
                  proposed: cand,
                  changed: true,
                  outcome: "restores_margins",
                  status: "BLOCKED",
                  reasons: [],
                  currentMargins: { evidence: { level: "MEASURED" }, reasons: [] },
                  proposedMargins: {
                      crossoverHz: cm!.fc,
                      phaseMarginDeg: cm!.pm,
                      gainMarginDb: null,
                      sensitivityPeakDb: null,
                      measured: { gainMarginDb: cm!.gm, sensitivityPeakDb: cm!.s },
                      evidence: { level: "MEASURED" },
                      reasons: [],
                  },
              } as unknown as RouteDecision["candidate"])
            : null,
        measurementUsable: true,
        missing: [],
        waived: [],
    } as unknown as RouteDecision;
}

const axisInput = (dec: RouteDecision, over: Partial<JointAxisInput> = {}): JointAxisInput => ({
    axis: "roll",
    loop,
    current,
    decision: dec,
    window: [0, N],
    dterm,
    dtermValidated: true,
    chainValidated: true,
    gyroAdc: unfilt[0],
    ...over,
});
const input = (dec: RouteDecision, over: Partial<Parameters<typeof jointSearch>[0]> = {}) => ({
    axes: [axisInput(dec)],
    chainCfg,
    chainInput: { timeUs, gyroUnfilt: unfilt as [Float64Array, Float64Array, Float64Array], erpm: [], rcThrottle },
    baseSim: null,
    sampleRateHz: FS,
    flightMask: mask,
    ...over,
});

describe("joint PID + filter search (block 12)", () => {
    it("finds a candidate only with a filter change, within the noise and bandwidth rules, and names the space", () => {
        const r = jointSearch(input(decision(false)));
        expect(r.status).toBe("candidate_found");
        expect(r.chosen).not.toBeNull();
        const ch = r.chosen!;
        // PM meets only with the gyro lowpass raised: ×1.5 at P ×0.8 (the ×1.25 combination's only readable
        // meeting point, P ×0.7, falls under the bandwidth floor).
        expect(ch.gyroScale).toBe(1.5);
        // The D-term lowpass adds nothing to this model: the tie goes to no change in that group.
        expect(ch.dtermScale).toBe(1);
        expect(Object.keys(ch.filters).every((k) => k.startsWith("gyro_"))).toBe(true);
        expect(ch.axes.roll!.read.pid.p).toBe(80);
        expect(ch.axes.roll!.read.meetsTargets).toBe(true);
        expect(ch.axes.roll!.read.noise.ratio!).toBeLessThanOrEqual(JOINT_SEARCH.maxNoiseRatio);
        expect(ch.axes.roll!.read.crossoverGain!).toBeGreaterThanOrEqual(JOINT_SEARCH.minCrossoverKeep);
        expect(ch.reason).toBe("more_axes_meet_targets");
        expect(ch.filters.gyro_lpf1_static_hz).toEqual({ from: LPF1, to: 150 });
        expect(ch.filters.gyro_lpf2_static_hz).toEqual({ from: 200, to: 300 });
        expect(ch.axes.roll!.proposal.status).toBe("BLOCKED");
        expect(ch.axes.roll!.proposal.reasons).toContain("joint_pid_filter_search_on_measured_margins");
        // Every PID point of the joint grid is a point of the ±30 % grid (0.1 steps on 0.7..1.3).
        expect(r.searched.pidScales).toEqual([0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3]);
        // Budget: every combination screened on the coarse grid, three refined on the full grid; the gyro ×1.5
        // combinations (the only ones with an eligible coarse point, P ×0.7 and ×1.0 meeting but ×0.7 under
        // the bandwidth floor and ×1.0 over the noise allowance... P ×0.8 is a full-grid point) are kept.
        expect(r.combos.filter((c) => c.searched)).toHaveLength(3);
        expect(r.combos.filter((c) => c.searched).every((c) => c.gyroScale === 1.5)).toBe(true);
        const c125 = r.combos.find((c) => c.gyroScale === 1.25 && c.dtermScale === 1)!;
        expect(c125.searched).toBe(false);
        expect(c125.axes[0].screen.meeting).toBeGreaterThan(0);
        expect(c125.axes[0].best).toBeNull();
        // Points meeting the targets but excluded: for bandwidth (P ×0.7, crossover 21 < 0.8 × 30) and for noise
        // (the raised cutoff at full P).
        const kept = r.combos.find((c) => c.gyroScale === 1.5 && c.dtermScale === 1)!;
        expect(kept.axes[0].excludedForBandwidth).toBeGreaterThan(0);
        expect(kept.axes[0].excludedForNoise).toBeGreaterThan(0);
        expect(r.parameters.filter((p) => p.searched).map((p) => p.key)).toEqual([
            "gyro_lpf1_static_hz",
            "gyro_lpf1_dyn_min_hz",
            "gyro_lpf1_dyn_max_hz",
            "gyro_lpf2_static_hz",
            "dterm_lpf1_static_hz",
            "dterm_lpf1_dyn_min_hz",
            "dterm_lpf1_dyn_max_hz",
            "dterm_lpf2_static_hz",
        ]);
        expect(r.parameters.find((p) => p.key === "dyn_notch_count")!.searched).toBe(false);
        expect(r.candidatesTried).toBe(15 * 63 + 3 * 343);
    });

    it("the PID-only candidate stands when the filters add no axis and no 1.03× crossover gain", () => {
        // PID alone reaches the targets at P ×0.8 (pm 46, crossover 24 Hz); with the gyro lowpass raised the
        // targets are met at P ×0.9 (crossover 27 Hz ≥ 1.03 × 24): the filter change wins on bandwidth.
        model = (ps, sg, sd) => ({ pm: 40 + 30 * (1 - ps) + 10 * (sg - 1) + 2 * (sd - 1), gm: 10, s: 5, fc: FC0 * ps });
        const r = jointSearch(input(decision(true)));
        expect(r.pidOnly.roll!.meetsTargets).toBe(true);
        expect(r.status).toBe("candidate_found");
        expect(r.chosen!.reason).toBe("higher_crossover_at_equal_axes");
        expect(r.chosen!.axes.roll!.read.crossoverHz!).toBeGreaterThanOrEqual(24 * JOINT_SEARCH.minGainOverPidOnly);
        // Same model with the filter gain removed: every combination's best is the same P ×0.8 point, no
        // 1.03× crossover gain over the PID-only candidate: it stands.
        model = (ps) => ({ pm: 40 + 30 * (1 - ps), gm: 10, s: 5, fc: FC0 * ps });
        const r2 = jointSearch(input(decision(true)));
        expect(r2.status).toBe("pid_only_stands");
        expect(r2.chosen).toBeNull();
        expect(r2.reasons.join(" ")).toMatch(/pid_only_candidate_stands/);
    });

    it("without gyroUnfilt the gyro lowpass is not searched (evidence named) and the D-term lowpass still is", () => {
        model = (ps, sg, sd) => ({
            pm: 28 - 30 * (ps - 1) + 40 * (sg - 1) + 60 * (sd - 1),
            gm: 10,
            s: 5,
            fc: FC0 * ps,
        });
        const r = jointSearch(input(decision(false), { chainInput: null }));
        const gyro = r.parameters.find((p) => p.key === "gyro_lpf1_static_hz")!;
        expect(gyro.searched).toBe(false);
        expect(gyro.missing).toContain("gyro_unfilt_not_logged");
        expect(r.reasons).toContain("gyro_lowpass_not_searched");
        expect(r.parameters.find((p) => p.key === "dterm_lpf1_static_hz")!.searched).toBe(true);
        // Without the chain simulation the noise is not computable, so no candidate is eligible.
        expect(r.status).toBe("no_candidate_meets_targets_within_rules");
        expect(r.combos.every((c) => c.gyroScale === 1)).toBe(true);
    });

    it("an unvalidated chain or D path leaves its group out; nothing supported means not run", () => {
        const r = jointSearch(
            input(decision(false), {
                axes: [axisInput(decision(false), { chainValidated: false, dtermValidated: false })],
            }),
        );
        expect(r.status).toBe("not_run");
        expect(r.reasons[0]).toBe("no_filter_parameter_supported_by_this_log");
        expect(r.parameters.find((p) => p.key === "gyro_lpf1_static_hz")!.missing).toContain(
            "chain_model_not_validated_on_this_log:roll",
        );
        expect(r.parameters.find((p) => p.key === "dterm_lpf2_static_hz")!.missing).toContain(
            "dterm_model_not_validated_on_this_log:roll",
        );
    });

    it("the experimental proposal takes the joint candidate: PID items of the axis replaced, filter items added, source joint_search", () => {
        model = (ps, sg) => ({
            pm: 28 + 40 * (sg - 1) - 30 * (ps - 1),
            gm: 10,
            s: 5,
            fc: FC0 * ps,
        });
        const dec = decision(false);
        const joint = jointSearch(input(dec));
        expect(joint.status).toBe("candidate_found");
        const built = buildExperimentalProposal({
            primaryItems: [
                {
                    key: "gyro_lpf1_static_hz",
                    part: "gyro_filter",
                    from: LPF1,
                    to: 115,
                    status: "PARTIAL",
                    reasons: ["simulated_on_logged_data"],
                },
            ],
            primaryPid: [],
            jio: null,
            decisions: { roll: { primary: dec, jio: null } },
            joint,
            buildProposal: (selected: ProposalItem[]) =>
                ({
                    id: "v2-test",
                    createdAt: "2026-11-11T00:00:00Z",
                    log: { sha256: "x", logIndex: 1, headerPairs: [] },
                    change: Object.fromEntries(selected.map((i) => [i.key, i.to])),
                    items: selected,
                    release: {
                        measurement: { valid: true, reasons: [] },
                        model: { status: "PARTIAL", reasons: [] },
                        margins: [],
                        independentValidation: null,
                        safetyAnalysisEvidence: "",
                        safetyReasons: [],
                    },
                }) as never,
        });
        expect(built.proposal).not.toBeNull();
        const items = built.proposal!.items;
        const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
        expect(byKey.p_roll.to).toBe(80);
        expect(byKey.p_roll.source).toBe("joint_search");
        expect(byKey.gyro_lpf1_static_hz).toMatchObject({
            from: LPF1,
            to: 150,
            source: "joint_search",
            status: "BLOCKED",
            part: "gyro_filter",
        });
        expect(items.filter((i) => i.key === "gyro_lpf1_static_hz")).toHaveLength(1);
        expect(byKey.gyro_lpf2_static_hz.part).toBe("gyro_filter");
        expect(built.withheld.find((w) => w.key === "pid_roll")).toBeUndefined();
        expect(built.proposal!.limitations).toContain(
            "experimental:joint_pid_filter_candidate_measured_margins_and_simulated_noise",
        );
        expect(built.proposal!.proposal.release.measurement.valid).toBe(true);
        // Without a joint candidate the axis is withheld as before.
        const none = buildExperimentalProposal({
            primaryItems: [],
            primaryPid: [],
            jio: null,
            decisions: { roll: { primary: dec, jio: null } },
            joint: null,
            buildProposal: () => null,
        });
        expect(none.proposal).toBeNull();
        expect(none.withheld.map((w) => w.key)).toContain("pid_roll");
    });
});
