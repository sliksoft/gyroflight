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
 * Multi-recording average aggregation: independent claims sum; duplicates and mismatches do not.
 * SIMULATION only.
 */

import { describe, expect, it } from "vitest";
import {
    aggregateAverageClaims,
    averageClaimAt,
    multiRecordingIssues,
    type RecordingAverageClaim,
} from "../../src/gyrocore/engine/multiRecording";
import { syntheticLogInput } from "./harness/syntheticLog";

const ANALYSIS = { segmentSamples: 512, sampleRateHz: 4000, windowSamples: 80_000, segments: 18 };
const SWEEP = { f0Hz: 1, f1Hz: 200, durationS: 20 };

describe("aggregateAverageClaims", () => {
    it("sums distinct recordings and rejects duplicate sha or content", () => {
        const a: RecordingAverageClaim = {
            id: "a:0",
            sha256: "a".repeat(64),
            logIndex: 0,
            hz: 26,
            averages: 3,
            contentKey: "k1",
        };
        const b: RecordingAverageClaim = {
            id: "b:0",
            sha256: "b".repeat(64),
            logIndex: 0,
            hz: 26,
            averages: 4,
            contentKey: "k2",
        };
        const dupSha: RecordingAverageClaim = { ...a, id: "a:1", logIndex: 1, averages: 9 };
        const dupContent: RecordingAverageClaim = {
            id: "c:0",
            sha256: "c".repeat(64),
            logIndex: 0,
            hz: 26,
            averages: 4,
            contentKey: "k2",
        };
        const r = aggregateAverageClaims(26, [a, b, dupSha, dupContent]);
        expect(r.averages).toBe(7);
        expect(r.contributors).toEqual(["a:0", "b:0"]);
        expect(r.rejected).toEqual(["duplicate_sha256:a:1", "duplicate_content:c:0"]);
    });

    it("averageClaimAt returns null when the window holds no whole segment at hz", () => {
        const log = syntheticLogInput("d".repeat(64));
        // Short window on a long header: high-frequency dwell never observed.
        const short = { ...ANALYSIS, windowSamples: 2_000 };
        expect(averageClaimAt(log, 100, short, { f0Hz: 1, f1Hz: 200, durationS: 86_400 })).toBeNull();
    });
});

describe("multiRecordingIssues", () => {
    it("the same log cannot contribute twice; an independent synthetic flight is accepted by identity rules", () => {
        const a = syntheticLogInput("e".repeat(64));
        const b = syntheticLogInput("f".repeat(64));
        expect(multiRecordingIssues(a, a)).toContain("multi_recording_same_log");
        // Distinct hashes and sessions: the synthetic logs are independent under flightRelation.
        expect(multiRecordingIssues(a, b)).toEqual([]);
    });
});
