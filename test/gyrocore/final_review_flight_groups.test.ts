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
 * Codex final review F-01: three exports of one continuous gyro stream. A covers 0–11 s, C 11–22 s
 * and B 7–15 s: B shares four seconds with A and four with C, A and C share nothing. Deduplication
 * dropped B after comparing it with A, its link to C was lost, and A and C counted as two
 * independent flights: the release contract released on the primary's own flight. Flights are now
 * connected groups over every imported fragment (logInput.ts flightGroups), the kept file carries
 * the group's identity, and the engine groups its own inputs as well.
 *
 * Everything here runs the real pickPrimary → runAutotuneV2 → evaluateRelease route.
 */

import { describe, expect, it } from "vitest";
import { runAutotuneV2, type AutotuneLogInput } from "../../src/gyrocore/engine/autotuneV2";
import {
    crossLogReferenceIssues,
    flightGroups,
    pickPrimary,
    sameFlight,
    uniqueFlights,
} from "../../src/gyrocore/engine/logInput";
import { verifiedTuneFromLogs } from "../../src/gyrocore/engine/verifiedTuneFromLogs";
import { evaluateRelease } from "../../src/gyrocore/releaseGate/releaseContract";
import { simulatedQualificationLog, syntheticLogInput } from "./harness/syntheticLog";
import { verifiedTuneAllAxesFixture } from "./harness/verifiedTuneFixture";

const AT = "2026-10-23T00:00:00Z";
// SIMULATION: a synthetic finer second flight qualifies the margins' model class (contract logic only).
const QUALIFICATION = simulatedQualificationLog();
const released = (logs: AutotuneLogInput[]) => {
    const picked = pickPrimary(logs)!;
    const r = runAutotuneV2({
        ...picked,
        verifiedTune: verifiedTuneAllAxesFixture(0.9, 0.7),
        modelClassQualification: QUALIFICATION,
        createdAt: AT,
    });
    return { picked, r, released: !!r.releasableProposal && evaluateRelease(r.releasableProposal).released };
};

type Ch = AutotuneLogInput["channels"];
const SPLIT = 28000; // A's samples from here on are the bridge's first part (4 s at 4 kHz)
const TAKE = 16000; // C's first samples are the bridge's second part

/** A (0–11 s), C (the same stream continued, 11–22 s) and the bridge B (7–15 s) of `pids`' tune. */
function chain(
    seedA: string,
    seedC: string,
    pids?: Partial<Record<"roll" | "pitch" | "yaw", [number, number, number]>>,
) {
    const opts = pids ? { pids } : {};
    const a = { ...syntheticLogInput(seedA, opts), order: 1 };
    const c0 = syntheticLogInput(seedC, opts);
    // C continues A's session: A's clock 11 s on, and its first frame is not the session's first
    // (an export from inside the session; logInput.ts flightRelation).
    const t0 = a.channels.timeUs[0] + 11_000_000 - c0.channels.timeUs[0];
    const c: AutotuneLogInput = {
        ...c0,
        order: 3,
        channels: { ...c0.channels, timeUs: Float64Array.from(c0.channels.timeUs, (t) => t + t0) },
        session: { firstIteration: 11 * 4000, startDatetime: null },
    };
    const join = (x: ArrayLike<number>, y: ArrayLike<number>) =>
        Float64Array.from([...Array.from(x).slice(SPLIT), ...Array.from(y).slice(0, TAKE)]);
    const ca: Ch = a.channels;
    const cc: Ch = c.channels;
    const three = (x: Ch["gyroAdc"], y: Ch["gyroAdc"]) =>
        [join(x[0], y[0]), join(x[1], y[1]), join(x[2], y[2])] as Ch["gyroAdc"];
    const roll = c.chirp.roll!;
    const yaw = a.chirp.yaw!;
    const b: AutotuneLogInput = {
        ...a,
        sha256: `b${seedA.slice(1)}`,
        order: 2,
        // B starts inside the session too (at A's sample SPLIT).
        session: { firstIteration: SPLIT, startDatetime: null },
        channels: {
            ...ca,
            timeUs: join(ca.timeUs, cc.timeUs),
            gyroAdc: three(ca.gyroAdc, cc.gyroAdc),
            gyroUnfilt: ca.gyroUnfilt && cc.gyroUnfilt ? three(ca.gyroUnfilt, cc.gyroUnfilt) : null,
            rcThrottle: join(ca.rcThrottle, cc.rcThrottle),
            erpm: ca.erpm.map((v, i) => join(v, cc.erpm[i])),
            motors: ca.motors && cc.motors ? ca.motors.map((v, i) => join(v, cc.motors![i])) : null,
            axisD: null,
        },
        // Complete sweeps on both sides: C's roll sweep and A's yaw sweep, re-indexed.
        chirp: {
            roll: {
                ...roll,
                start: roll.start + (ca.timeUs.length - SPLIT),
                end: roll.end + (ca.timeUs.length - SPLIT),
            },
            yaw: { ...yaw, start: yaw.start - SPLIT, end: yaw.end - SPLIT },
        },
    };
    return { a, b, c };
}

const { a: A, b: B, c: C } = chain("1".repeat(64), "2".repeat(64));
const ORDERS: [string, AutotuneLogInput[]][] = [
    ["A,B,C", [A, B, C]],
    ["A,C,B", [A, C, B]],
    ["B,A,C", [B, A, C]],
    ["B,C,A", [B, C, A]],
    ["C,A,B", [C, A, B]],
    ["C,B,A", [C, B, A]],
];

describe("F-01: overlapping fragments are one flight, transitively", () => {
    it("the fixture is the review's: A–B and B–C overlap, A–C do not", () => {
        expect(sameFlight(A, B)).toBe(true);
        expect(sameFlight(B, C)).toBe(true);
        expect(sameFlight(A, C)).toBe(false);
    });

    for (const [name, logs] of ORDERS) {
        it(`import order ${name}: one group, one kept file, no cross-log reference, nothing released`, () => {
            expect(flightGroups(logs)).toHaveLength(1);
            const unique = uniqueFlights(logs);
            expect(unique).toHaveLength(1);
            // The choice does not depend on the order: longest, then file hash (A and C tie in length).
            expect(unique[0].sha256).toBe(A.sha256);
            expect(unique[0].flightGroup!.map((f) => f.sha256).sort()).toEqual([A, B, C].map((l) => l.sha256).sort());
            const { picked, r, released: ok } = released(logs);
            expect(picked.others).toEqual([]);
            expect(r.crossLogPlant).toEqual({});
            expect(ok).toBe(false);
        }, 600_000);
    }

    it("the kept file keeps the group's identity: the dropped bridge still links it to C", () => {
        const kept = uniqueFlights([A, B])[0];
        expect(kept.flightGroup).toHaveLength(2);
        expect(sameFlight(kept, C)).toBe(true);
        expect(uniqueFlights([kept, C])).toHaveLength(1);
        expect(pickPrimary([kept, C])!.others).toEqual([]);
    });

    it("the engine groups its own inputs: C is the primary's flight through B, even when handed over directly", () => {
        // The pair alone shows no overlap, which proves nothing: independence unproven (audit P1-1).
        expect(crossLogReferenceIssues(A, C)).toEqual([
            `cross_log_independence_unproven:session_start_not_in_log:${C.sha256}:0`,
        ]);
        expect(crossLogReferenceIssues(A, C, [B, C])).toEqual([`cross_log_duplicate_of_primary:${C.sha256}:0`]);
        const r = runAutotuneV2({
            primary: A,
            others: [B, C],
            verifiedTune: verifiedTuneAllAxesFixture(0.9, 0.7),
            createdAt: AT,
        });
        expect(r.crossLogRejected).toEqual(
            expect.arrayContaining([
                `cross_log_duplicate_of_primary:${B.sha256}:0`,
                `cross_log_duplicate_of_primary:${C.sha256}:0`,
            ]),
        );
        expect(r.crossLogPlant).toEqual({});
        expect(!!r.releasableProposal && evaluateRelease(r.releasableProposal).released).toBe(false);
    }, 600_000);

    it("subranges of one flight chain the same way (0–5 s, 2.5–7.5 s, 5.5–11 s)", () => {
        const base = syntheticLogInput("3".repeat(64));
        const range = (from: number, to: number, sha: string): AutotuneLogInput => {
            const cut = (g: ArrayLike<number>) => Float64Array.from(g).slice(from, to);
            return {
                ...base,
                sha256: sha,
                channels: {
                    ...base.channels,
                    timeUs: Float64Array.from(base.channels.timeUs).slice(from, to),
                    gyroAdc: [
                        cut(base.channels.gyroAdc[0]),
                        cut(base.channels.gyroAdc[1]),
                        cut(base.channels.gyroAdc[2]),
                    ],
                },
            };
        };
        const a = range(0, 20000, "a".repeat(64));
        const b = range(10000, 30000, "b".repeat(64));
        const c = range(22000, 44000, "c".repeat(64));
        expect(sameFlight(a, c)).toBe(false);
        for (const logs of [
            [a, b, c],
            [a, c, b],
            [c, a, b],
        ]) {
            expect(uniqueFlights(logs).map((l) => l.sha256)).toEqual([c.sha256]); // the longest
        }
        // Without the bridge nothing shows they are one flight; they are not merged (nor independent).
        expect(uniqueFlights([a, c])).toHaveLength(2);
    });
});

describe("F-01: independent flights still count; unproven ones do not", () => {
    // Audit P1-1 (2026-10-23): this case released before. Two fragments of one flight without the
    // bridge share no sample, so the absence of an overlap proves nothing; C does not hold its
    // session's start, so its independence from A is unproven and it is no reference.
    it("A and C without the bridge: independence unproven, C is no reference, nothing released", () => {
        const { picked, r, released: ok } = released([A, C]);
        expect(picked.others).toHaveLength(1);
        expect(r.crossLogRejected).toContain(`cross_log_independence_unproven:session_start_not_in_log:${C.sha256}:0`);
        expect(Object.keys(r.crossLogPlant)).toEqual([]);
        expect(ok).toBe(false);
    }, 600_000);

    it("the A–B–C flight plus a truly independent flight D: D is the reference and the proposal releases", () => {
        const D = { ...syntheticLogInput("4".repeat(64)), order: 4 };
        for (const logs of [
            [A, B, C, D],
            [D, C, B, A],
        ]) {
            expect(uniqueFlights(logs)).toHaveLength(2);
            const { picked, r, released: ok } = released(logs);
            expect([picked.primary.sha256, ...picked.others.map((l) => l.sha256)].sort()).toEqual(
                [A.sha256, D.sha256].sort(),
            );
            expect(r.crossLogRejected).toEqual([]);
            expect(ok).toBe(true);
        }
    }, 600_000);
});

describe("F-01: a bridge between baseline and would-be repeat removes the repeat", () => {
    const CAND: Record<"roll" | "pitch", [number, number, number]> = { roll: [50, 71, 21], pitch: [74, 105, 43] };
    const candidate = { ...syntheticLogInput("a".repeat(64), { pids: CAND }), order: 4 };

    it("baseline A, repeat C and the bridge B: one baseline flight, no repeat", () => {
        const r = verifiedTuneFromLogs([candidate, A, B, C]);
        expect(r.record?.baselineRepeat ?? null).toBeNull();
        expect(r.reasons).toContain("verified_tune:no_baseline_repeat_m5a_floors_used");
    }, 600_000);

    // Audit P1-1: before, C counted as A's repeat here. Unproven independence is no repeat.
    it("without the bridge, C is no repeat either: its independence from A is unproven", () => {
        const r = verifiedTuneFromLogs([candidate, A, C]);
        expect(r.record?.baselineRepeat ?? null).toBeNull();
        expect(r.reasons).toContain(
            `verified_tune:repeat_rejected:cross_log_independence_unproven:session_start_not_in_log:${C.sha256}:0`,
        );
    }, 600_000);
});
