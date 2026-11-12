/**
 * Block 14: the app's session constants (protocol.ts) and the bench schedule (schedule.py) equal the pre-registered
 * protocol session_v1 (scripts/sim/e2e/protocols/session_protocol_v1.json).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SESSION_PROTOCOL as P } from "../../src/gyrocore/sitlSession/protocol";

const J = JSON.parse(readFileSync("scripts/sim/e2e/protocols/session_protocol_v1.json", "utf8"));

describe("session_v1 protocol constants", () => {
    it("targets, tolerances, validity, guards, improvement and policy are the pre-registered ones", () => {
        expect(P.version).toBe(J.version);
        expect(P.targets).toEqual(J.targets);
        expect(P.tolerance).toEqual(J.tolerance);
        expect(P.validity).toEqual(J.validity);
        expect(P.guards).toEqual(J.guards);
        expect(P.improvement).toEqual(J.improvement);
        expect(P.policy).toEqual(J.policy);
        expect(P.measurement.runs).toBe(J.measurement.runs);
        expect(J.measurement.sessionStarts).toHaveLength(P.measurement.runs);
        expect(J.measurement.finalStarts).toHaveLength(P.measurement.runs);
    });

    it("the bench schedule's step block and harness pilot match the app's layout and the protocol", () => {
        const py = readFileSync("scripts/sim/session/schedule.py", "utf8");
        const m =
            /def build\(start: int, amp: float = ([\d.]+), half: int = (\d+), gap: int = (\d+), total: int = (\d+)\)/.exec(
                py,
            )!;
        expect(Number(m[1])).toBe(P.measurement.stepAmplitudeDps);
        expect(Number(m[2])).toBe(P.measurement.stepHalfTicks);
        expect(Number(m[3])).toBe(P.measurement.stepGapTicks);
        expect(Number(m[4])).toBe(6000);
        const pilot = JSON.parse(/PILOT = (\{[^}]*\})/s.exec(py)![1].replace(/\s+/g, " "));
        expect(pilot).toEqual(J.measurement.pilot);
        // angle off from a-60, re-grant tick a-30: the app's acro lead (0.6 s) covers both.
        expect(py).toMatch(/"angleOffTicks": list\(range\(a - 60, end \+ 20\)\)/);
        expect(P.measurement.acroLeadS).toBe(0.6);
        expect(P.measurement.acroTailS).toBe(0.2);
    });
});
