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
 * Observed dwell versus CHIRP header (Codex review 2026-10-28, P2): the engine must not count
 * independent averages that were never in the analysed window. Positive analytic qualification
 * (matching window) is covered by t3_frequency_support; this file is the negative / fixture-realism
 * control through runAutotuneV2.
 */

import { describe, expect, it } from "vitest";
import { runAutotuneV2 } from "../../src/gyrocore/engine/autotuneV2";
import { sweepAverages } from "../../src/gyrocore/engine/loopModel";
import { mismatchedQualificationLog, simulatedQualificationLog, syntheticLogInput } from "./harness/syntheticLog";
import { verifiedTuneAllAxesFixture } from "./harness/verifiedTuneFixture";

describe("dwell clipped to the analysed window (fixture realism)", () => {
    it("a matching short qualification log cannot invent VALIDATED evidence", () => {
        const r = runAutotuneV2({
            primary: syntheticLogInput("e".repeat(64)),
            others: [syntheticLogInput("f".repeat(64))],
            verifiedTune: verifiedTuneAllAxesFixture(0.9, 0.7),
            modelClassQualification: simulatedQualificationLog(),
            createdAt: "2026-10-28T00:00:00Z",
        });
        for (const m of Object.values(r.margins)) {
            expect(m!.current.evidence.level).not.toBe("VALIDATED");
        }
        expect(r.releasableProposal).toBeNull();
    }, 600_000);

    it("a day-long header in a 45 s window does not count unobserved high-frequency dwell", () => {
        const q = mismatchedQualificationLog();
        const axis = q.chirp.roll!;
        const analysis = axis.analysis ?? axis.analyses![0].analysis;
        const sweep = {
            f0Hz: Number(Object.fromEntries(q.headerPairs).chirp_frequency_start_deci_hz) / 10,
            f1Hz: Number(Object.fromEntries(q.headerPairs).chirp_frequency_end_deci_hz) / 10,
            durationS: Number(Object.fromEntries(q.headerPairs).chirp_time_seconds),
        };
        expect(sweep.durationS).toBeGreaterThan(3600);
        expect(analysis.windowSamples).toBeLessThan(sweep.durationS * q.sampleRateHz * 0.01);
        // Without a window clip the header would claim ≥1 average at 100 Hz; with the clip it is 0.
        expect(
            sweepAverages(
                100,
                {
                    segmentSamples: analysis.segmentSamples,
                    sampleRateHz: analysis.sampleRateHz,
                    segments: analysis.segments,
                },
                sweep,
            ),
        ).toBeGreaterThanOrEqual(1);
        expect(
            sweepAverages(
                100,
                {
                    segmentSamples: analysis.segmentSamples,
                    sampleRateHz: analysis.sampleRateHz,
                    segments: analysis.segments,
                },
                sweep,
                analysis.windowSamples,
            ),
        ).toBe(0);
        const r = runAutotuneV2({
            primary: syntheticLogInput("e".repeat(64)),
            others: [syntheticLogInput("f".repeat(64))],
            verifiedTune: verifiedTuneAllAxesFixture(0.9, 0.7),
            modelClassQualification: q,
            createdAt: "2026-10-28T00:00:00Z",
        });
        expect(r.releasableProposal).toBeNull();
        for (const m of Object.values(r.margins)) {
            expect(m!.current.evidence.level).not.toBe("VALIDATED");
        }
    }, 600_000);
});
