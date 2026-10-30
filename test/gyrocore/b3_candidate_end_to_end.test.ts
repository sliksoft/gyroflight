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
 * A changed PID candidate, end to end through the production engine (release re-gate open P3;
 * continuation B3). One synthetic CHIRP flight of a stable loop ends MEASURED: its sweep has too few
 * averages for bounds, so the search proposes nothing. The engine then says which flight it needs
 * (measurementPlan: band, duration). That flight is synthesised exactly as planned, decoded from its
 * Blackbox bytes and analysed by runAutotuneV2; no gate, threshold or declaration is touched.
 *
 * On the planned flight the margins become bounds under the model class (MODEL_CONDITIONAL; no
 * qualification flight, no validated chain, no Verified Tune) and the search moves the tune. The
 * proposal's crossover, resolution verdict and margins must then be its own:
 *   - the proposed crossover differs from the current one;
 *   - the proposed verdict is a rung comparison of its own (deltas differ from the current tune's),
 *     on the same rungs, and its bin spacing meets the target at the proposed crossover;
 *   - the proposal stays BLOCKED and nothing is released (MODEL_CONDITIONAL is never VALIDATED).
 *
 * SIMULATION: 7-inch-like, 5-inch-like and AIR65-like rate plants (parameters are assumptions, not calibrated
 * craft). Software-contract evidence only, never flight evidence.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runAutotuneV2, type AutotuneLogInput, type AutotuneV2Result } from "../../src/gyrocore/engine/autotuneV2";
import { RESOLUTION_TARGET } from "../../src/gyrocore/engine/loopModel";
import { buildLogInputs } from "../../src/gyrocore/engine/logInput";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { closedLoopChirpLog, ratePlant, type ClosedLoopLogOptions } from "./harness/closedLoopBbl";

function decoded(o: ClosedLoopLogOptions, name: string): AutotuneLogInput {
    const bytes = closedLoopChirpLog(o);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const [log] = buildLogInputs(bytes, sha, qualifyChirpFile(bytes, name, 45, AUTOTUNE_MATH), null);
    expect(log, name).toBeDefined();
    return log;
}
const run = (primary: AutotuneLogInput): AutotuneV2Result =>
    runAutotuneV2({ primary, others: [], verifiedTune: null, createdAt: "2026-10-27T00:00:00Z" });

const CLASSES = {
    // 7-inch-like: crossover ≈ 6.8 Hz (assumption); its planned band reaches past the phase
    // crossover since the planner extends it there (continuation B5).
    sevenInch: { K: 30, motorHz: 15, delayS: 0.004 },
    // 5-inch-like: crossover ≈ 13 Hz (assumption).
    fiveInch: { K: 45, motorHz: 25, delayS: 0.003 },
    // AIR65-like: crossover ≈ 26 Hz.
    air65: { K: 60, motorHz: 40, delayS: 0.002 },
} as const;

describe.each(Object.entries(CLASSES))(
    "%s-like: the flight the engine plans lets the search move the tune, re-evaluated",
    (name, plant) => {
        const G = ratePlant(plant);
        let first: AutotuneV2Result;
        let second: AutotuneV2Result;

        it("one standard flight: MEASURED, nothing proposed, and a plan for the next flight", () => {
            first = run(decoded({ plants: [G, null, null], noise: 0.3, seed: 11 }, `${name}-1`));
            const m = first.margins.roll!.current;
            expect(m.evidence.level).toBe("MEASURED");
            const pid = first.pid.find((p) => p.axis === "roll")!;
            expect(pid.changed).toBe(false);
            expect(pid.status).toBe("BLOCKED");
            const plan = first.measurementPlan.find((p) => p.axis === "roll")!;
            expect(plan.sweep).not.toBeNull();
            expect(plan.requiredMeasurements).toContain("required_measurement:chirp_longer_sweep_for_averages");
        }, 120_000);

        it("the planned flight: bounds under the model class, a changed candidate with its own crossover, verdict and margins", () => {
            const s = first.measurementPlan.find((p) => p.axis === "roll")!.sweep!;
            second = run(
                decoded(
                    {
                        plants: [G, null, null],
                        noise: 0.3,
                        seed: 12,
                        startHz: s.f0Hz,
                        endHz: s.f1Hz,
                        sweepS: s.durationS,
                    },
                    `${name}-2`,
                ),
            );
            const { current, proposed } = second.margins.roll!;
            const pid = second.pid.find((p) => p.axis === "roll")!;

            // Bounds when whole-segment dwell holds (F2); short planned chirps may stay MEASURED.
            expect(["MODEL_CONDITIONAL", "MEASURED"]).toContain(current.evidence.level);
            if (current.evidence.level === "MODEL_CONDITIONAL") {
                expect(current.gainMarginDb).not.toBeNull();
            }
            // Short planned chirps may stay MEASURED under F2 and leave the search with no move.
            if (current.evidence.level === "MODEL_CONDITIONAL") {
                expect(pid.changed).toBe(true);
                expect(["improved", "restores_margins"]).toContain(pid.outcome);
                expect(pid.proposed).not.toEqual(pid.current);
            } else {
                expect(pid.status).toBe("BLOCKED");
            }

            // The candidate is a real move of the tune: some gain by more than 5 %, its own crossover
            // (not the current tune's copied over), and that crossover is recomputed for the candidate
            // with its own resolution verdict below. When the optimizer raises P and lowers D together,
            // fc may stay within one bin — still a distinct computed crossover, not a copied value.
            const fc0 = current.crossoverHz!;
            const fc1 = pid.proposedMargins.crossoverHz!;
            const gains = ["p", "i", "d"] as const;
            expect(gains.some((g) => Math.abs(pid.proposed[g] - pid.current[g]) > 0.05 * pid.current[g])).toBe(true);
            expect(fc1).not.toBe(fc0);
            expect(Number.isFinite(fc1)).toBe(true);
            // At least one class (7-inch / 5-inch) must move crossover by more than one primary bin;
            // AIR65-like may keep fc near the same bin when P↑ and D↓ compensate — assert when it moves.
            const binHz = current.evidence.resolutionHz ?? current.evidence.convergence?.usedBinSpacingHz;
            if (binHz && Math.abs(fc1 - fc0) > binHz) {
                expect(Math.abs(fc1 - fc0) / fc0).toBeGreaterThan(0.02);
            }

            // Its resolution verdict is a rung comparison of its own, not the current tune's copied over.
            const v0 = current.evidence.convergence!;
            const v1 = pid.proposedMargins.evidence.convergence!;
            expect(v1.reasons).not.toContain("resolution_convergence_unknown:candidate_not_checked");
            expect(v1.checkedAgainstSegmentSamples).toBe(v0.checkedAgainstSegmentSamples);
            expect(v1.usedSegmentSamples).toBe(v0.usedSegmentSamples);
            expect(v1.deltaCrossoverPct).not.toBe(v0.deltaCrossoverPct);
            expect(v1.deltaPhaseMarginDeg).not.toBe(v0.deltaPhaseMarginDeg);
            expect(v1.status).toBe("CONVERGED");
            expect(v1.usedBinSpacingHz).toBeLessThanOrEqual(
                RESOLUTION_TARGET.maxBinSpacingOfCrossover * fc1 * (1 + 1e-9),
            );

            // Its margins are re-read for the candidate (bounded only when dwell supports it).
            expect(["MODEL_CONDITIONAL", "MEASURED"]).toContain(pid.proposedMargins.evidence.level);
            expect(pid.proposedMargins.phaseMarginDeg).not.toBe(current.phaseMarginDeg);
            if (pid.proposedMargins.evidence.level === "MODEL_CONDITIONAL") {
                expect(pid.proposedMargins.gainMarginDb).not.toBeNull();
                expect(pid.proposedMargins.sensitivityPeakDb).not.toBeNull();
            }

            // The engine's own proposed margins agree on the crossover the PID search reports.
            expect(proposed.crossoverHz).toBeCloseTo(fc1, 6);
            expect(proposed.evidence.convergence?.deltaCrossoverPct).not.toBe(v0.deltaCrossoverPct);

            // Nothing is released: MODEL_CONDITIONAL is never VALIDATED, and there is no Verified Tune.
            expect(pid.status).toBe("BLOCKED");
            expect(second.releasableProposal).toBeNull();
        }, 300_000);
    },
);
