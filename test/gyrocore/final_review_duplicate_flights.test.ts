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
 * Codex re-review R-1: a copy of the same flight that is trimmed, re-exported (a sub-range) or
 * time-shifted was not the same flight to the whole-file fingerprint, so it counted as the
 * independent repeat the release needs and the engine released on it (crossLogPlant PASS with
 * meanAbsGRel 0). Flight identity is now the set of content-anchored gyroADC windows
 * (logInput.ts FLIGHT_WINDOW): any shared stretch of the gyro stream identifies the flight,
 * whatever the file boundaries or time base; constant stretches are never counted, so two
 * flights that both sat still on the bench are not confused.
 */

import { describe, expect, it } from "vitest";
import type { AutotuneLogInput } from "../../src/gyrocore/engine/autotuneV2";
import { evaluateRelease } from "../../src/gyrocore/releaseGate/releaseContract";
import { verifiedTuneFromLogs } from "../../src/gyrocore/engine/verifiedTuneFromLogs";
import {
    crossLogReferenceIssues,
    FLIGHT_WINDOW,
    flightFingerprint,
    flightWindows,
    pickPrimary,
    flightRelation,
    sameFlight,
    sharedWindows,
    uniqueFlights,
} from "../../src/gyrocore/engine/logInput";
import { runSoftwareQualifiedAutotuneV2 } from "./harness/softwareQualifiedResult";
import { syntheticLogInput } from "./harness/syntheticLog";
import { verifiedTuneAllAxesFixture } from "./harness/verifiedTuneFixture";

const AT = "2026-10-22T00:00:00Z";
// SIMULATION: software-only VALIDATED evidence (no fictitious qualification flight).
const run = (primary: AutotuneLogInput, others: AutotuneLogInput[]) =>
    runSoftwareQualifiedAutotuneV2({
        primary,
        others,
        verifiedTune: verifiedTuneAllAxesFixture(0.9, 0.7),
        createdAt: AT,
    });
const released = (r: ReturnType<typeof run>) =>
    !!r.releasableProposal && evaluateRelease(r.releasableProposal).released;
const duplicate = (r: ReturnType<typeof run>, sha: string) =>
    r.crossLogRejected.includes(`cross_log_duplicate_of_primary:${sha}:0`);

type Ch = AutotuneLogInput["channels"];
type Arr = ArrayLike<number> | null | undefined;
/** The same flight as another file: samples [dropStart, n − dropEnd), fresh arrays, another hash. */
function subRange(log: AutotuneLogInput, sha256: string, dropStart: number, dropEnd: number): AutotuneLogInput {
    const n = log.channels.timeUs.length;
    const cut = (a: Arr) => (a ? Float64Array.from(a).slice(dropStart, n - dropEnd) : null);
    const cutAll = (as: Arr[] | null | undefined) => (as ? as.map(cut) : null);
    const ch = log.channels as unknown as Record<string, Arr | Arr[]>;
    const channels = {
        ...log.channels,
        timeUs: cut(ch.timeUs as Arr),
        gyroAdc: cutAll(ch.gyroAdc as Arr[]),
        gyroUnfilt: cutAll(ch.gyroUnfilt as Arr[] | null),
        erpm: cutAll(ch.erpm as Arr[] | null),
        rcThrottle: cut(ch.rcThrottle as Arr),
        axisD: cutAll(ch.axisD as Arr[] | null),
        motors: cutAll(ch.motors as Arr[] | null),
    } as unknown as Ch;
    const chirp: AutotuneLogInput["chirp"] = {};
    for (const [k, c] of Object.entries(log.chirp)) {
        if (c) chirp[k as keyof typeof chirp] = { ...c, start: c.start - dropStart, end: c.end - dropStart };
    }
    return { ...log, sha256, channels, chirp };
}
/** The same flight with its time base shifted (as an export that restarts the clock would be). */
function timeShifted(log: AutotuneLogInput, sha256: string, byUs: number): AutotuneLogInput {
    const channels = structuredClone(log.channels);
    channels.timeUs = Float64Array.from(channels.timeUs, (v) => v + byUs);
    return { ...log, sha256, channels };
}
/** `seconds` of standstill (gyro exactly 0) at the start, as a log that began on the bench. */
function withStandstill(log: AutotuneLogInput, seconds: number): AutotuneLogInput {
    const channels = structuredClone(log.channels);
    const n = Math.round(seconds * log.sampleRateHz);
    for (const g of channels.gyroAdc) (g as Float64Array).fill(0, 0, n);
    return { ...log, channels };
}

const FS = 4000;
const primary = syntheticLogInput("1".repeat(64));
const other = syntheticLogInput("2".repeat(64));

describe("R-1: flight identity by gyro windows", () => {
    it("an exact copy under another hash shares every window; an independent flight shares none", () => {
        const copy = { ...primary, sha256: "9".repeat(64), channels: structuredClone(primary.channels) };
        expect(flightWindows(primary).size).toBeGreaterThan(100);
        expect(sharedWindows(primary, copy)).toBe(flightWindows(primary).size);
        expect(sharedWindows(primary, other)).toBe(0);
        expect(sameFlight(primary, copy)).toBe(true);
        expect(sameFlight(primary, other)).toBe(false);
    });

    it("trimmed at the start, at the end, by one sample, and a middle sub-range: the same flight", () => {
        const cases = [
            ["end-1", subRange(primary, "8".repeat(64), 0, 1)],
            ["start-2000", subRange(primary, "7".repeat(64), 2000, 0)],
            ["end-4000", subRange(primary, "6".repeat(64), 0, 4000)],
            ["middle-half", subRange(primary, "5".repeat(64), Math.round(2.5 * FS), Math.round(2.5 * FS))],
        ] as const;
        for (const [name, copy] of cases) {
            expect(flightFingerprint(copy), name).not.toBe(flightFingerprint(primary));
            expect(sharedWindows(primary, copy), name).toBeGreaterThanOrEqual(FLIGHT_WINDOW.minShared * 10);
            expect(sameFlight(primary, copy), name).toBe(true);
            expect(crossLogReferenceIssues(primary, copy)[0], name).toMatch(/^cross_log_duplicate_of_primary:/);
        }
    });

    it("a time-shifted copy (same gyro, clock restarted) is the same flight", () => {
        const copy = timeShifted(primary, "4".repeat(64), 1_000_000);
        expect(flightFingerprint(copy)).not.toBe(flightFingerprint(primary));
        expect(sameFlight(primary, copy)).toBe(true);
    });

    it("overlapping windows: two sub-ranges of one flight that overlap only in the middle are the same flight", () => {
        const a = subRange(primary, "a".repeat(64), 0, Math.round(5 * FS)); // seconds 0–6
        const b = subRange(primary, "b".repeat(64), Math.round(4 * FS), 0); // seconds 4–11
        expect(sameFlight(a, b)).toBe(true);
        // and two sub-ranges that do not overlap are not told to be the same by the windows alone
        const c = subRange(primary, "c".repeat(64), 0, Math.round(7 * FS)); // seconds 0–4
        const d = subRange(primary, "d".repeat(64), Math.round(5 * FS), 0); // seconds 5–11
        expect(sharedWindows(c, d)).toBe(0);
    });

    it("no false positive: two independent flights that both start with 2 s of standstill", () => {
        const a = withStandstill(primary, 2);
        const b = withStandstill(other, 2);
        expect(sharedWindows(a, b)).toBe(0);
        expect(sameFlight(a, b)).toBe(false);
        expect(crossLogReferenceIssues(a, b)).toEqual([]);
    });

    it("uniqueFlights keeps one file per flight, the longest; pickPrimary sees no repeat in a copy", () => {
        const trimmed = subRange(primary, "8".repeat(64), 0, 4000);
        expect(uniqueFlights([trimmed, primary]).map((l) => l.sha256)).toEqual([primary.sha256]);
        expect(uniqueFlights([primary, trimmed, other]).map((l) => l.sha256)).toEqual([primary.sha256, other.sha256]);
        expect(pickPrimary([primary, trimmed])!.others).toEqual([]);
    });
});

describe("R-1: the engine does not release on a copy of its own flight", () => {
    it("review counterexample: a copy trimmed by one sample is rejected, nothing is released", () => {
        const copy = subRange(primary, "8".repeat(64), 0, 1);
        const r = run(primary, [copy]);
        expect(duplicate(r, copy.sha256)).toBe(true);
        expect(r.crossLogPlant).toEqual({});
        expect(released(r)).toBe(false);
    }, 600_000);

    it("review counterexample: a time-shifted copy is rejected, nothing is released", () => {
        const copy = timeShifted(primary, "4".repeat(64), 1_000_000);
        const r = run(primary, [copy]);
        expect(duplicate(r, copy.sha256)).toBe(true);
        expect(r.crossLogPlant).toEqual({});
        expect(released(r)).toBe(false);
    }, 600_000);

    it("a sub-range export of the middle of the flight is rejected too", () => {
        const copy = subRange(primary, "5".repeat(64), Math.round(2.5 * FS), Math.round(2.5 * FS));
        const r = run(primary, [copy]);
        expect(duplicate(r, copy.sha256)).toBe(true);
        expect(released(r)).toBe(false);
    }, 600_000);

    it("a re-identified copy (gyro re-scaled, same T) is not independent: the same session start", () => {
        const channels = structuredClone(primary.channels);
        for (const g of channels.gyroAdc as unknown as Float64Array[]) for (let k = 0; k < g.length; k++) g[k] *= 1.37;
        const copy = { ...primary, sha256: "3".repeat(64), channels };
        expect(sameFlight(primary, copy)).toBe(false); // the windows do not see it ...
        // ... its session evidence does (the same first sample time): independence unproven.
        expect(flightRelation(primary, copy)).toEqual({ relation: "UNKNOWN", reasons: ["same_session_start_time"] });
        const r = run(primary, [copy]);
        expect(r.crossLogRejected).toContain("cross_log_independence_unproven:same_session_start_time");
        expect(released(r)).toBe(false);
    }, 600_000);

    it("a re-identified copy with its clock restarted too is rejected as the identical measurement", () => {
        const channels = structuredClone(primary.channels);
        for (const g of channels.gyroAdc as unknown as Float64Array[]) for (let k = 0; k < g.length; k++) g[k] *= 1.37;
        channels.timeUs = Float64Array.from(channels.timeUs, (v) => v + 3_000_000);
        const copy = { ...primary, sha256: "3".repeat(64), channels };
        expect(flightRelation(primary, copy).relation).toBe("INDEPENDENT"); // windows and session miss it ...
        const r = run(primary, [copy]); // ... the shared/bit-identical closed-loop FRF does: same measurement
        expect(r.crossLogRejected).toContain(`cross_log_identical_measurement:${copy.sha256}:0`);
        expect(r.crossLogPlant.roll).toBeUndefined();
        expect(r.crossLogPlant.pitch).toBeUndefined();
        expect(r.crossLogPlant.yaw).toBeUndefined();
        expect(released(r)).toBe(false);
    }, 600_000);

    it("positive control: a really independent second flight reproduces the plant and releases", () => {
        const r = run(primary, [other]);
        expect(r.crossLogRejected).toEqual([]);
        expect(Object.values(r.crossLogPlant).map((x) => x!.status)).toEqual(["PASS", "PASS", "PASS"]);
        expect(Object.values(r.crossLogPlant).every((x) => x!.meanAbsGRel > 0)).toBe(true);
        expect(released(r)).toBe(true);
    }, 600_000);
});

describe("R-1: the Verified Tune producer", () => {
    it("a trimmed copy of the baseline is not its baseline repeat", () => {
        const candidate = {
            ...syntheticLogInput("c".repeat(64), { pids: { roll: [50, 71, 21], pitch: [74, 105, 43] } }),
            order: 2,
        };
        const baseline = { ...syntheticLogInput("b".repeat(64)), order: 1 };
        const trimmedBaseline = { ...subRange(baseline, "e".repeat(64), 0, 4000), order: 1 };
        const att = verifiedTuneFromLogs([candidate, baseline, trimmedBaseline], AT);
        expect(att.record?.baselineRepeat ?? null).toBeNull();
        // the same logs plus a real repeat flight: that one is taken
        const repeat = { ...syntheticLogInput("f".repeat(64)), order: 1 };
        const att2 = verifiedTuneFromLogs([candidate, baseline, trimmedBaseline, repeat], AT);
        expect(att2.record?.baselineRepeat?.sha256).toBe(repeat.sha256);
    }, 600_000);
});
