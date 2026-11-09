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
 * Block 9b: the outcome "Create Verified Tune" shows. The stored record is PASS / FAIL only; an axis
 * that was not detectable or had insufficient data must not be shown as a failed prediction.
 */

import { describe, expect, it } from "vitest";
import { verifiedTuneOutcome, type VerifiedTuneAttempt } from "../../src/gyrocore/engine/verifiedTuneFromLogs";
import type { AxisComparison, VerifiedTune } from "../../src/gyrocore/releaseGate/verifiedTune";

const cmp = (axis: AxisComparison["axis"], verdict: AxisComparison["verdict"]): AxisComparison => ({
    axis,
    loopBins: 0,
    loopWithinShare: 0,
    loopMaxExcess: 0,
    comparedBins: 0,
    detectableBins: 0,
    withinShare: 0,
    maxExcess: 0,
    maxMagErrDb: 0,
    maxPhaseErrDeg: 0,
    toleranceSource: "baseline_repeat",
    verdict,
});
// As buildVerifiedTune records it: one reason per axis that is not PASS, plus any `extra` reasons.
const attempt = (
    verdict: "PASS" | "FAIL",
    comparisons: AxisComparison[],
    extra: string[] = [],
): VerifiedTuneAttempt => {
    const reasons = [
        ...extra,
        ...comparisons
            .filter((c) => c.verdict !== "PASS")
            .map((c) => `verified_tune:${c.axis}:${c.verdict.toLowerCase()}`),
    ];
    return { record: { verdict, comparisons, reasons } as unknown as VerifiedTune, reasons };
};

describe("verifiedTuneOutcome", () => {
    it("PASS stays PASS; no record is NONE", () => {
        expect(verifiedTuneOutcome(attempt("PASS", [cmp("roll", "PASS")]))).toBe("PASS");
        expect(verifiedTuneOutcome({ record: null, reasons: ["verified_tune:needs_two_tunes"] })).toBe("NONE");
    });
    it("a failed comparison is FAIL, whatever the other axes say", () => {
        expect(verifiedTuneOutcome(attempt("FAIL", [cmp("roll", "FAIL"), cmp("pitch", "INSUFFICIENT")]))).toBe("FAIL");
    });
    it("not detectable / insufficient are not a failed prediction", () => {
        expect(verifiedTuneOutcome(attempt("FAIL", [cmp("roll", "NOT_DETECTABLE")]))).toBe("NOT_DETECTABLE");
        expect(verifiedTuneOutcome(attempt("FAIL", [cmp("roll", "INSUFFICIENT")]))).toBe("INSUFFICIENT");
        expect(
            verifiedTuneOutcome(
                attempt("FAIL", [cmp("roll", "PASS"), cmp("pitch", "NOT_DETECTABLE"), cmp("yaw", "INSUFFICIENT")]),
            ),
        ).toBe("INSUFFICIENT");
    });
    it("a refusal without any comparison (another craft, a non-PID change) is NONE", () => {
        expect(verifiedTuneOutcome(attempt("FAIL", []))).toBe("NONE");
    });
    // GBR-BLK-9-e26aaac-01: buildVerifiedTune still compares the axes when the comparison itself is
    // invalid; such a record must not read as a failed (or merely undetectable) prediction.
    it.each([
        "verified_tune:non_pid_value_changed:gyro_lpf1_static_hz",
        "verified_tune:repeat_not_independent",
        "verified_tune:log_hash_invalid",
        "verified_tune:same_log",
        "verified_tune:no_pid_change_between_logs",
        "verified_tune:logged_values_missing",
        "verified_tune:axis_not_measured:pitch",
    ])("an invalid comparison (%s) is NONE, whatever the axes say", (reason) => {
        expect(verifiedTuneOutcome(attempt("FAIL", [cmp("roll", "FAIL")], [reason]))).toBe("NONE");
        expect(verifiedTuneOutcome(attempt("FAIL", [cmp("roll", "INSUFFICIENT")], [reason]))).toBe("NONE");
        expect(verifiedTuneOutcome(attempt("FAIL", [cmp("roll", "NOT_DETECTABLE")], [reason]))).toBe("NONE");
        expect(verifiedTuneOutcome(attempt("FAIL", [cmp("roll", "PASS")], [reason]))).toBe("NONE");
    });
});
