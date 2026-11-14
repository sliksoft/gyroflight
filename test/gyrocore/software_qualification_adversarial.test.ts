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
 * End-to-end software qualification adversarial cases (completion program 2026-10-28, phase 5).
 * SIMULATION ONLY: invalid or ambiguous evidence must not produce a releasable proposal.
 * Passing these tests never authorizes physical use (hardwareValidated stays false).
 */

import { describe, expect, it } from "vitest";
import { runAutotuneV2 } from "../../src/gyrocore/engine/autotuneV2";
import { evaluateRelease } from "../../src/gyrocore/releaseGate/releaseContract";
import { ABSOLUTE_SAFETY_POLICY } from "../../src/gyrocore/safety/absoluteEvaluate";
import { averageClaimAt, aggregateAverageClaims, multiRecordingIssues } from "../../src/gyrocore/engine/multiRecording";
import { mismatchedQualificationLog, syntheticIdentityLog, syntheticLogInput } from "./harness/syntheticLog";
import { verifiedTuneAllAxesFixture } from "./harness/verifiedTuneFixture";

const AT = "2026-10-28T00:00:00Z";
const released = (r: ReturnType<typeof runAutotuneV2>) =>
    !!r.releasableProposal && evaluateRelease(r.releasableProposal).released;

describe("adversarial software qualification (SIMULATION)", () => {
    it("keeps Absolute Apply / hardware gates blocked", () => {
        expect(ABSOLUTE_SAFETY_POLICY.hardwareValidated).toBe(false);
    });

    it("mismatched day-long qualification header in a short window is not VALIDATED / not released", () => {
        const primary = syntheticLogInput("a".repeat(64));
        const qual = mismatchedQualificationLog();
        const r = runAutotuneV2({
            primary,
            others: [qual],
            modelClassQualification: qual,
            verifiedTune: verifiedTuneAllAxesFixture(0.9, 0.7),
            createdAt: AT,
        });
        expect(released(r)).toBe(false);
        expect(r.releasableProposal).toBeNull();
        for (const m of Object.values(r.margins)) {
            expect(m!.current.evidence.level).not.toBe("VALIDATED");
        }
    }, 120_000);

    it("duplicate sha256 does not stack; distinct hashes with the same settings do", () => {
        // Aggregation-only: short identity buffer; claim windows are synthetic.
        const log = syntheticIdentityLog("b".repeat(64));
        const analysis = { segmentSamples: 512, sampleRateHz: 4000, windowSamples: 80_000, segments: 18 };
        const sweep = { f0Hz: 1, f1Hz: 200, durationS: 20 };
        const a = averageClaimAt(log, 5, analysis, sweep);
        expect(a).not.toBeNull();
        const sameSha = { ...a!, id: "other-id", logIndex: 1 };
        const otherSha = { ...a!, id: "c:0", sha256: "c".repeat(64), contentKey: "c".repeat(64) };
        expect(aggregateAverageClaims(5, [a!, sameSha]).averages).toBe(a!.averages);
        expect(aggregateAverageClaims(5, [a!, otherSha]).averages).toBe(2 * a!.averages);
    });

    it("incompatible configuration cannot improve multi-recording qualification", () => {
        // PID mismatch: flight-identity helpers suffice (no full-chain dwell).
        const a = syntheticIdentityLog("d".repeat(64));
        const b = syntheticIdentityLog("e".repeat(64), {
            pids: { roll: [80, 80, 40], pitch: [80, 80, 40], yaw: [80, 80, 0] },
        });
        const issues = multiRecordingIssues(a, b);
        expect(issues.length).toBeGreaterThan(0);
    });

    it("realistic short primary without qualification never releases", () => {
        // Named short: identity buffer, not the 120 s full-chain default.
        const primary = syntheticIdentityLog("f".repeat(64));
        const r = runAutotuneV2({
            primary,
            others: [],
            verifiedTune: null,
            createdAt: AT,
        });
        expect(released(r)).toBe(false);
        expect(r.releasableProposal).toBeNull();
        expect(r.measurementStrategy.length).toBeGreaterThan(0);
        expect(r.measurementStrategy.some((s) => s.sessions.length > 0 || s.blockedWithout.length > 0)).toBe(true);
    }, 120_000);
});
