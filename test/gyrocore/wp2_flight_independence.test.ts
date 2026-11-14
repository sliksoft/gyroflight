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
 * WP2 flight independence (audit F-01 / P1-1): two logs count as independent flights only on
 * positive evidence of two recording sessions (logInput.ts flightRelation). Overlap proves one
 * flight; the absence of an overlap proves nothing, so every case without session evidence is
 * UNKNOWN, and UNKNOWN is never a cross-log reference, a model-class qualification or a Verified
 * Tune repeat. (Synthetic logs: they exercise the identity rules, not the physics.)
 */

import { describe, expect, it } from "vitest";
import { runAutotuneV2, type AutotuneLogInput } from "../../src/gyrocore/engine/autotuneV2";
import {
    crossLogReferenceIssues,
    FLIGHT_WINDOW,
    flightRelation,
    logStartDatetime,
    uniqueFlights,
} from "../../src/gyrocore/engine/logInput";
import { verifiedTuneFromLogs } from "../../src/gyrocore/engine/verifiedTuneFromLogs";
import { simulatedQualificationLog, syntheticIdentityLog } from "./harness/syntheticLog";

const FS = 4000;
const A = syntheticIdentityLog("1".repeat(64));
const D = syntheticIdentityLog("2".repeat(64));
const id = (l: AutotuneLogInput) => `${l.sha256}:${l.logIndex}`;

type Ch = AutotuneLogInput["channels"];
type Arr = ArrayLike<number> | null | undefined;
/** Samples [from, to) of `log` as another file, with that file's session evidence. */
function excerpt(
    log: AutotuneLogInput,
    sha256: string,
    from: number,
    to: number,
    session: AutotuneLogInput["session"],
): AutotuneLogInput {
    const cut = (a: Arr) => (a ? Float64Array.from(a).slice(from, to) : null);
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
        if (c && c.start >= from && c.end <= to)
            chirp[k as keyof typeof chirp] = { ...c, start: c.start - from, end: c.end - from };
    }
    return { ...log, sha256, channels, chirp, session };
}

describe("the three relations", () => {
    it("SAME: the same log, a copy, an overlapping export", () => {
        expect(flightRelation(A, A).relation).toBe("SAME");
        expect(
            flightRelation(A, { ...A, sha256: "9".repeat(64), channels: structuredClone(A.channels) }).relation,
        ).toBe("SAME");
        const overlap = excerpt(A, "8".repeat(64), 10 * FS, 11 * FS, { firstIteration: 10 * FS, startDatetime: null });
        expect(flightRelation(A, overlap).relation).toBe("SAME");
    });

    it("INDEPENDENT: two complete recording sessions without a shared sample", () => {
        expect(flightRelation(A, D)).toEqual({ relation: "INDEPENDENT", reasons: [] });
        expect(crossLogReferenceIssues(A, D)).toEqual([]);
    });

    it("INDEPENDENT also for two logs of one file (one per arming), each from its first frame", () => {
        const second = { ...D, sha256: A.sha256, logIndex: 1 };
        expect(flightRelation(A, second).relation).toBe("INDEPENDENT");
    });
});

describe("UNKNOWN: no positive evidence of two sessions", () => {
    it("two disjoint fragments of one flight (the missing bridge)", () => {
        const head = excerpt(A, "3".repeat(64), 0, 5 * FS, { firstIteration: 0, startDatetime: null });
        const tail = excerpt(A, "4".repeat(64), 6 * FS, 11 * FS, { firstIteration: 6 * FS, startDatetime: null });
        expect(flightRelation(head, tail)).toEqual({
            relation: "UNKNOWN",
            reasons: [`session_start_not_in_log:${id(tail)}`],
        });
        expect(crossLogReferenceIssues(head, tail)).toEqual([
            `cross_log_independence_unproven:session_start_not_in_log:${id(tail)}`,
        ]);
        // Not merged either: nothing proves one flight.
        expect(uniqueFlights([head, tail])).toHaveLength(2);
    });

    it("several CHIRP segments of one flight exported as separate files", () => {
        const first = excerpt(A, "5".repeat(64), 0, 4.2 * FS, { firstIteration: 0, startDatetime: null });
        const second = excerpt(A, "6".repeat(64), 4.3 * FS, 7.5 * FS, {
            firstIteration: 4.3 * FS,
            startDatetime: null,
        });
        expect(Object.keys(first.chirp)).toEqual(["roll"]);
        expect(Object.keys(second.chirp)).toEqual(["pitch"]);
        expect(flightRelation(first, second).relation).toBe("UNKNOWN");
    });

    it("missing session metadata (an input without session evidence)", () => {
        const bare = { ...D, session: undefined };
        expect(flightRelation(A, bare)).toEqual({
            relation: "UNKNOWN",
            reasons: [`session_evidence_missing:${id(bare)}`],
        });
    });

    it("a few shared samples (below the one-flight threshold) are never two flights", () => {
        // D with one 2-window stretch of A's gyro pasted in: shared raw samples.
        const channels = structuredClone(D.channels);
        const from = 5 * FS;
        for (let a = 0; a < 3; a++) {
            const g = channels.gyroAdc[a] as Float64Array;
            g.set((A.channels.gyroAdc[a] as Float64Array).slice(from, from + 600), from);
        }
        const spliced = { ...D, sha256: "7".repeat(64), channels };
        const v = flightRelation(A, spliced);
        expect(v.relation).toBe("UNKNOWN");
        expect(v.reasons[0]).toMatch(/^samples_in_common:[1-3]_windows$/);
        expect(Number(/:(\d)_/.exec(v.reasons[0])![1])).toBeLessThan(FLIGHT_WINDOW.minShared);
    });

    it("too little movement to tell (a log without active windows)", () => {
        const channels = structuredClone(D.channels);
        for (const g of channels.gyroAdc) (g as Float64Array).fill(0);
        const still = { ...D, sha256: "c".repeat(64), channels };
        expect(flightRelation(A, still).reasons).toContain(`too_little_movement_to_tell:${id(still)}`);
    });

    it("the same session start: equal first sample time, or equal real Log start datetime", () => {
        const sameStart = {
            ...D,
            channels: {
                ...D.channels,
                timeUs: Float64Array.from(D.channels.timeUs, (_, k) => A.channels.timeUs[0] + k * 250),
            },
        };
        expect(flightRelation(A, sameStart).reasons).toEqual(["same_session_start_time"]);
        const at = "2026-10-20T10:00:00.000+02:00";
        const a = { ...A, session: { firstIteration: 0, startDatetime: at } };
        const d = { ...D, session: { firstIteration: 0, startDatetime: at } };
        expect(flightRelation(a, d).reasons).toEqual(["same_session_datetime"]);
    });

    it("the RTC-less placeholder datetime is no evidence at all", () => {
        expect(logStartDatetime([["Log start datetime", "0000-01-01T00:00:00.000+00:00"]])).toBeNull();
        expect(logStartDatetime([["Log start datetime", "garbage"]])).toBeNull();
        expect(logStartDatetime([])).toBeNull();
        expect(logStartDatetime([["Log start datetime", "2026-10-20T10:00:00.000+02:00"]])).toBe(
            "2026-10-20T10:00:00.000+02:00",
        );
    });

    it("session evidence of one fragment counts for the whole flight it belongs to", () => {
        // A's tail as a second file overlaps A: one flight, so A's session start covers it.
        const tail = excerpt(A, "d".repeat(64), 8 * FS, 11 * FS, { firstIteration: 8 * FS, startDatetime: null });
        const [kept] = uniqueFlights([A, tail]);
        expect(flightRelation(kept, D)).toEqual({ relation: "INDEPENDENT", reasons: [] });
    });
});

describe("UNKNOWN is never independent evidence anywhere", () => {
    // Another flight of the same tune whose log does not start at its session's first frame (an
    // export from inside a session): its independence from A is unproven.
    const tail = { ...D, sha256: "e".repeat(64), session: { firstIteration: 6 * FS, startDatetime: null } };

    it("control: the same flight with its session start counts as a reference", () => {
        const r = runAutotuneV2({ primary: A, others: [D], verifiedTune: null });
        expect(r.crossLogPlant.roll?.status).toBe("PASS");
    }, 600_000);

    it("no cross-log plant reference", () => {
        const r = runAutotuneV2({ primary: A, others: [tail], verifiedTune: null });
        expect(r.crossLogPlant).toEqual({});
        expect(r.crossLogRejected).toContain(`cross_log_independence_unproven:session_start_not_in_log:${id(tail)}`);
        // The panel names what is missing.
        expect(r.parts.find((p) => p.part === "plant_identification")!.requiredMeasurements).toContain(
            "required_measurement:complete_log_of_an_independent_flight",
        );
    }, 600_000);

    it("no model-class qualification, even finer and over another band: a dependent measurement", () => {
        // The qualification log is a later export of the primary's own session (another band, finer bins).
        const q = { ...simulatedQualificationLog(), session: { firstIteration: 20 * FS, startDatetime: null } };
        const r = runAutotuneV2({ primary: A, others: [], verifiedTune: null, modelClassQualification: q });
        const part = r.parts.find((p) => p.part === "phase_margin_robustness")!;
        expect(part.reasons).toContain(
            `model_class_qualification_rejected:cross_log_independence_unproven:session_start_not_in_log:${id(q)}`,
        );
        for (const m of Object.values(r.margins)) expect(m!.proposed.evidence.qualification).toBeNull();
    }, 600_000);

    it("no Verified Tune repeat", () => {
        const base = { ...A, order: 1 };
        const repeat = { ...tail, order: 2 };
        const cand = {
            ...syntheticIdentityLog("f".repeat(64), { pids: { roll: [50, 71, 21], pitch: [74, 105, 43] } }),
            order: 3,
        };
        const attempt = verifiedTuneFromLogs([base, repeat, cand]);
        expect(attempt.record?.baselineRepeat ?? null).toBeNull();
        expect(attempt.reasons).toContain(
            `verified_tune:repeat_rejected:cross_log_independence_unproven:session_start_not_in_log:${id(tail)}`,
        );
    }, 600_000);
});
