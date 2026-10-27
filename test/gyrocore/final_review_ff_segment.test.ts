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
 * Codex re-review P3-c: a Verified Tune whose gain-change flight also moved feedforward covers
 * only points where F moves along with P, I, D and d_max. The PID search does not move F (a
 * feedforward step is not a loop-margin change), so it found no point on that segment and
 * reported "no_candidate_meets_all_targets", which was not the cause. It now says what the cause
 * is and which measurement would remove it. The validated region is not widened: the release
 * contract still refuses a P-only step on such a record (codex_review_verified_tune.test.ts).
 */

import { describe, expect, it } from "vitest";
import { declaredSupport } from "./harness/frequencySupport";
import { declaredConvergence } from "./harness/resolutionConvergence";
import { air65RollConfig, evaluateControllerFrf } from "../../src/js/blackbox/betaflight_digital_controller";
import { closedLoopFromPlant, plantFrf, syntheticTransferFunction } from "../../src/js/blackbox/betaflight_open_loop";
import { buildAxisLoop } from "../../src/gyrocore/engine/loopModel";
import { optimizeAxisPid, type ValidatedSegment } from "../../src/gyrocore/engine/pidOptimizer";
import { axisKeys, validatedRegionIssues } from "../../src/gyrocore/releaseGate/verifiedTune";
import type { EffectiveChain } from "../../src/gyrocore/engine/gyroChain";
import { verifiedTuneAllAxesFixture } from "./harness/verifiedTuneFixture";

const UNITY_CHAIN: EffectiveChain = {
    samples: 1,
    frf: () => ({ re: 1, im: 0 }),
    spread: () => ({ phaseDeg: 0, gainDb: 0 }),
    medianLpf1Hz: 0,
    dynNotchHz: [],
};

/** The AIR65 roll loop on a smooth plant, identified to 200 Hz, chain validated and attested. */
function rollLoop() {
    const cfg = air65RollConfig();
    const freqs = Array.from({ length: 400 }, (_, i) => 0.5 + i * 0.5);
    const tf = syntheticTransferFunction(freqs, (f) => {
        const frf = evaluateControllerFrf(cfg, f);
        return closedLoopFromPlant(plantFrf(f, { K: 30, motorHz: 40, delayS: 0.002 }), frf.cReference, frf.cFeedback);
    });
    return buildAxisLoop(0, tf, cfg, UNITY_CHAIN, true, true, null, {
        support: declaredSupport(tf),
        resolution: declaredConvergence(),
    });
}

function segmentOf(record: ReturnType<typeof verifiedTuneAllAxesFixture>, fStep = 0): ValidatedSegment {
    const keys = axisKeys("roll");
    const base = { ...record.baseline.values };
    const cand = { ...record.candidate.values, f_roll: record.candidate.values.f_roll + fStep };
    return { keys, base, cand };
}

describe("P3-c: a segment that moves feedforward", () => {
    const record = verifiedTuneAllAxesFixture(1.3, 0.7);
    const current = {
        p: record.baseline.values.p_roll,
        i: record.baseline.values.i_roll,
        d: record.baseline.values.d_roll,
        dMax: record.baseline.values.d_max_roll,
    };

    it("the record's segment with F moved: the search names the cause and the measurement, no candidate", () => {
        const seg = segmentOf(record, 20);
        const r = optimizeAxisPid(rollLoop(), current, seg);
        expect(r.status).toBe("BLOCKED");
        expect(r.changed).toBe(false);
        expect(r.outcome).toBe("not_computable");
        expect(r.reasons).toContain(
            `verified_tune_segment_moves_feedforward:f_roll:${seg.base.f_roll}->${seg.cand.f_roll}`,
        );
        expect(r.reasons).toContain("required_measurement:gain_change_flight_with_feedforward_unchanged");
        expect(r.reasons).not.toContain("no_candidate_meets_all_targets");
    });

    it("the region is not widened: a P/I/D step without the F step is still outside the segment", () => {
        const seg = segmentOf(record, 20);
        // A record whose candidate values carry the F step as well as the P/I/D step.
        const rec = {
            ...record,
            baseline: { ...record.baseline, values: seg.base },
            candidate: { ...record.candidate, values: seg.cand },
        };
        const mid = (k: string) => Math.round((seg.base[k] + seg.cand[k]) / 2);
        const pidOnly = { p_roll: mid("p_roll"), i_roll: mid("i_roll"), d_roll: mid("d_roll") };
        expect(validatedRegionIssues(rec as never, seg.base, pidOnly)).toEqual([
            "verified_tune:change_outside_validated:roll",
        ]);
        expect(validatedRegionIssues(rec as never, seg.base, { ...pidOnly, f_roll: mid("f_roll") })).toEqual([]);
    });

    it("positive: the same record without an F step is searched along its segment as before", () => {
        const seg = segmentOf(record, 0);
        const r = optimizeAxisPid(rollLoop(), current, seg);
        expect(r.reasons.some((x) => x.startsWith("verified_tune_segment_moves_feedforward"))).toBe(false);
        expect(r.outcome).not.toBe("not_computable");
        // Every proposed value lies on the segment (the contract's own predicate).
        const target = {
            p_roll: r.proposed.p,
            i_roll: r.proposed.i,
            d_roll: r.proposed.d,
            d_max_roll: r.proposed.dMax,
        };
        const rec = {
            ...record,
            baseline: { ...record.baseline, values: seg.base },
            candidate: { ...record.candidate, values: seg.cand },
        };
        expect(validatedRegionIssues(rec as never, seg.base, target)).toEqual([]);
    });
});
