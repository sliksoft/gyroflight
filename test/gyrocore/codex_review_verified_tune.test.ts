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
 * Codex review P1-01: a Verified Tune confirms one measured change, from one measured
 * configuration, and nothing else. The records come from the real producer (fixtures); the
 * proposals are written by hand with the values the review used (roll P 56 → 73 confirmed).
 * Only the independent_validation condition is asserted, so other conditions cannot make a
 * case pass or fail by accident.
 */

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import {
    evaluateRelease,
    type AbsoluteProposal,
    type AbsoluteReleaseEvidence,
} from "../../src/gyrocore/releaseGate/releaseContract";
import { verifiedTuneHash, verifiedTuneIssues, type VerifiedTune } from "../../src/gyrocore/releaseGate/verifiedTune";
import { useVerifiedTuneStore } from "../../src/gyrocore/stores/verifiedTunes";
import { loggedAbsoluteValues } from "../../src/gyrocore/tuning/absoluteTune";
import {
    FIXTURE_FIRMWARE,
    FIXTURE_UID,
    fixtureHeaders,
    verifiedTuneAllAxesFixture,
    verifiedTuneFixture,
} from "./harness/verifiedTuneFixture";

type Pids = Partial<Record<"roll" | "pitch" | "yaw", [number, number, number]>>;

function proposal(record: VerifiedTune, logged: Pids, change: Record<string, number>): AbsoluteProposal {
    const release: AbsoluteReleaseEvidence = {
        measurement: { valid: true, reasons: [] },
        model: { status: "VALIDATED", reasons: [] },
        margins: [],
        independentValidation: record,
        safetyAnalysisEvidence: "available",
        safetyReasons: [],
    };
    return {
        id: "p",
        createdAt: "2026-10-22T00:00:00Z",
        log: { sha256: "d".repeat(64), logIndex: 0, headerPairs: fixtureHeaders(logged) },
        change,
        items: [],
        release,
    };
}

function independent(p: AbsoluteProposal) {
    return evaluateRelease(p).conditions.find((c) => c.name === "independent_validation")!;
}

describe("P1-01: the validated region is the measured segment, from the measured baseline", () => {
    const v = verifiedTuneFixture(); // roll P 56 → 73 confirmed, nothing else changed
    const BASE: Pids = { roll: [56, 79, 30] };
    const CAND: Pids = { roll: [73, 79, 30] };

    it("the record is the review's: roll P 56 → 73, PASS", () => {
        expect(v.verdict).toBe("PASS");
        expect(v.baseline.pids.roll.p).toBe(56);
        expect(v.candidate.pids.roll.p).toBe(73);
    });

    it("valid: from the baseline, the confirmed step and any point on it are covered", () => {
        expect(independent(proposal(v, BASE, { p_roll: 73 })).reasons).toEqual([]);
        expect(independent(proposal(v, BASE, { p_roll: 64 })).reasons).toEqual([]);
    });

    it("review counterexample: the reverse step 56 → 40 is refused", () => {
        const c = independent(proposal(v, BASE, { p_roll: 40 }));
        expect(c.passed).toBe(false);
        expect(c.reasons).toContain("verified_tune:change_outside_validated:roll");
    });

    it("review counterexample: extrapolation 73 → 95 from the candidate is refused", () => {
        const c = independent(proposal(v, CAND, { p_roll: 95 }));
        expect(c.passed).toBe(false);
        expect(c.reasons).toContain("verified_tune:baseline_mismatch:p_roll");
    });

    it("repeated application: once from the baseline is covered, the same step again from the result is not", () => {
        expect(independent(proposal(v, BASE, { p_roll: 73 })).passed).toBe(true);
        const again = independent(proposal(v, CAND, { p_roll: 90 }));
        expect(again.passed).toBe(false);
        expect(again.reasons).toContain("verified_tune:baseline_mismatch:p_roll");
    });

    it("beyond the confirmed value in the confirmed direction is refused", () => {
        expect(independent(proposal(v, BASE, { p_roll: 80 })).reasons).toContain(
            "verified_tune:change_outside_validated:roll",
        );
    });

    it("a term the validation never changed may not move (here roll D)", () => {
        expect(independent(proposal(v, BASE, { p_roll: 73, d_roll: 34 })).reasons).toContain(
            "verified_tune:change_outside_validated:roll",
        );
    });

    it("an axis the validation never changed may not move (here pitch P)", () => {
        expect(independent(proposal(v, BASE, { p_pitch: 90 })).reasons).toContain(
            "verified_tune:change_outside_validated:pitch",
        );
    });
});

describe("P1-01: combined P/I/D changes stay on the confirmed combination", () => {
    const v = verifiedTuneAllAxesFixture(); // every axis: P and I × 1.3, D × 0.7, together
    const BASE: Pids = { roll: [56, 79, 30], pitch: [82, 117, 61], yaw: [56, 79, 0] };
    const c = v.candidate.pids.roll;

    it("valid: the confirmed combination and its midpoint", () => {
        expect(independent(proposal(v, BASE, { p_roll: c.p, i_roll: c.i, d_roll: c.d })).reasons).toEqual([]);
        const mid = (a: number, b: number) => Math.round((a + b) / 2);
        expect(
            independent(proposal(v, BASE, { p_roll: mid(56, c.p), i_roll: mid(79, c.i), d_roll: mid(30, c.d) }))
                .reasons,
        ).toEqual([]);
    });

    it("each term inside its own range, but not together: P up without I and D is refused", () => {
        const r = independent(proposal(v, BASE, { p_roll: c.p }));
        expect(r.passed).toBe(false);
        expect(r.reasons).toContain("verified_tune:change_outside_validated:roll");
    });

    it("full P with half D (off the confirmed combination) is refused", () => {
        const r = independent(proposal(v, BASE, { p_roll: c.p, i_roll: c.i, d_roll: Math.round((30 + c.d) / 2) }));
        expect(r.reasons).toContain("verified_tune:change_outside_validated:roll");
    });

    it("P up and D up (opposite to the confirmed D step) is refused", () => {
        expect(c.d).toBeLessThan(30);
        const r = independent(proposal(v, BASE, { p_roll: c.p, i_roll: c.i, d_roll: 35 }));
        expect(r.reasons).toContain("verified_tune:change_outside_validated:roll");
    });

    it("a d_max change the validation never made is refused", () => {
        const r = independent(proposal(v, BASE, { p_roll: c.p, i_roll: c.i, d_roll: c.d, d_max_roll: 60 }));
        expect(r.reasons).toContain("verified_tune:change_outside_validated:roll");
    });
});

describe("P1-01: record selection and old records", () => {
    beforeEach(() => {
        setActivePinia(createPinia());
        localStorage.clear();
    });

    it("the store prefers a record measured from the log's own configuration over a newer one", () => {
        const store = useVerifiedTuneStore();
        const bound = verifiedTuneFixture(); // measured from the AIR65 tune
        // A newer, intact record measured from another configuration (roll P 60).
        const o = verifiedTuneAllAxesFixture(0.9, 0.7);
        const { id: _id, ...body } = {
            ...o,
            baseline: { ...o.baseline, values: { ...o.baseline.values, p_roll: 60 } },
        };
        const foreign = { ...body, id: verifiedTuneHash(body) } as VerifiedTune;
        expect(verifiedTuneIssues(foreign, { uid: FIXTURE_UID, firmware: FIXTURE_FIRMWARE })).toEqual([]);
        expect(store.save(bound)).toBe(true);
        expect(store.save(foreign)).toBe(true);
        expect(store.forCraft(FIXTURE_UID, FIXTURE_FIRMWARE)?.id).toBe(foreign.id);
        const air65 = loggedAbsoluteValues(fixtureHeaders());
        expect(store.forCraft(FIXTURE_UID, FIXTURE_FIRMWARE, air65)?.id).toBe(bound.id);
        // The foreign record covers nothing from the AIR65 tune.
        expect(independent(proposal(foreign, {}, { p_roll: 50 })).reasons).toEqual([
            "verified_tune:baseline_mismatch:p_roll",
        ]);
    });

    it("a v1 record (relative limits, no logged values) is refused, not reinterpreted", () => {
        const v = verifiedTuneFixture();
        const { values: _b, ...baseline } = v.baseline;
        const { values: _c, ...candidate } = v.candidate;
        const v1 = {
            ...v,
            kind: "gyroflight.verified_tune.v1",
            baseline,
            candidate,
            validatedRelativeChange: { roll: { p: 0.3, i: 0, d: 0 } },
        } as unknown as VerifiedTune;
        expect(verifiedTuneIssues(v1, { uid: FIXTURE_UID, firmware: FIXTURE_FIRMWARE })).toEqual([
            "independent_pid_validation_missing",
        ]);
        expect(independent(proposal(v1, {}, { p_roll: 64 })).passed).toBe(false);
    });
});
