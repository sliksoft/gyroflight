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
 * WP6: GyroCore Safety for absolute proposals (safety/absoluteEvaluate.ts). It evaluates every
 * requirement of an absolute write and names what fails; it never authorizes while the hardware
 * validation is NOT_EXECUTED, not even on a proposal whose software evidence passes everything.
 * SIMULATION evidence only (synthetic logs, a synthetic qualification, a fixture record).
 */

import { beforeAll, describe, expect, it } from "vitest";
import { runAutotuneV2, type AutotuneV2Result } from "../../src/gyrocore/engine/autotuneV2";
import {
    ABSOLUTE_SAFETY_NOT_HARDWARE_VALIDATED,
    ABSOLUTE_SAFETY_POLICY,
    evaluateAbsoluteSafety,
} from "../../src/gyrocore/safety/absoluteEvaluate";
import { absoluteSafetyAuthorization } from "../../src/gyrocore/safety/authorize";
import type { AbsoluteProposal } from "../../src/gyrocore/releaseGate/releaseContract";
import { simulatedQualificationLog, syntheticLogInput } from "./harness/syntheticLog";
import { verifiedTuneAllAxesFixture } from "./harness/verifiedTuneFixture";

const record = () => verifiedTuneAllAxesFixture(0.9, 0.7);
let qualified: AutotuneV2Result;

beforeAll(() => {
    qualified = runAutotuneV2({
        primary: syntheticLogInput("e".repeat(64)),
        others: [syntheticLogInput("f".repeat(64))],
        verifiedTune: record(),
        modelClassQualification: simulatedQualificationLog(),
        createdAt: "2026-10-24T00:00:00Z",
    });
}, 600_000);

const statuses = (p: AbsoluteProposal, verifiedTune = record()) =>
    Object.fromEntries(evaluateAbsoluteSafety(p, { verifiedTune }).checks.map((c) => [c.name, c.status]));

describe("every software check can pass; the write is still not authorized", () => {
    it("SIMULATION: the qualified proposal passes every software check; hardware NOT_EXECUTED blocks", () => {
        const p = qualified.releasableProposal!;
        expect(statuses(p)).toEqual({
            validated_starting_configuration: "PASS",
            absolute_values_in_range: "PASS",
            plausible_step: "PASS",
            dynamic_margins: "PASS",
            fc_identity_binding: "PASS",
            live_recheck: "PASS",
            human_confirmation: "PASS",
            rollback: "NOT_VALIDATED",
            hardware_validation: "NOT_EXECUTED",
        });
        const e = evaluateAbsoluteSafety(p, { verifiedTune: record() });
        expect(e.blocks).toEqual([ABSOLUTE_SAFETY_NOT_HARDWARE_VALIDATED]);
        expect(e.analysisEvidence).toBe("available");
        const a = absoluteSafetyAuthorization(p, { verifiedTune: record() });
        expect(a).toMatchObject({ status: "BLOCK", authorized: false, proposalId: p.id, blocks: e.blocks });
        expect(ABSOLUTE_SAFETY_POLICY.hardwareValidated).toBe(false);
    });
});

describe("each requirement fails on its own", () => {
    it("no Verified Tune this browser holds: the starting configuration is not validated", () => {
        const p = qualified.releasableProposal!;
        const e = evaluateAbsoluteSafety(p, { verifiedTune: null });
        expect(e.checks.find((c) => c.name === "validated_starting_configuration")).toMatchObject({
            status: "FAIL",
            reasons: ["no_verified_tune"],
        });
    });

    it("a value outside the firmware's range, and a step larger than the search's", () => {
        const p = structuredClone(qualified.releasableProposal!);
        const key = Object.keys(p.change).find((k) => k.startsWith("p_"))!;
        p.change[key] = 1000;
        const e = evaluateAbsoluteSafety(p, { verifiedTune: record() });
        const by = Object.fromEntries(e.checks.map((c) => [c.name, c]));
        expect(by.absolute_values_in_range.status).toBe("FAIL");
        expect(by.absolute_values_in_range.reasons.some((r) => r.startsWith(`absolute:out_of_range:${key}:1000`))).toBe(
            true,
        );
        expect(by.plausible_step.status).toBe("FAIL");
        expect(by.plausible_step.reasons[0]).toMatch(new RegExp(`^step_too_large:${key}:\\d+->1000$`));
    });

    it("margins without their evidence, or below target, fail the dynamic check (read from the evidence itself)", () => {
        const p = structuredClone(qualified.releasableProposal!);
        p.release.margins = p.release.margins.map((m) => ({ ...m, evidence: { ...m.evidence, uncertainty: null } }));
        expect(statuses(p).dynamic_margins).toBe("FAIL");
        const q = structuredClone(qualified.releasableProposal!);
        q.release.margins = q.release.margins.map((m) => ({ ...m, phaseMarginDeg: 20 }));
        const e = evaluateAbsoluteSafety(q, { verifiedTune: record() });
        expect(e.checks.find((c) => c.name === "dynamic_margins")!.reasons).toContain(
            `pm_below_target:${q.release.margins[0].axis}`,
        );
        expect(e.analysisEvidence).toBe("not_available");
    });

    it("a log that does not name the craft cannot bind the write to it", () => {
        const p = structuredClone(qualified.releasableProposal!);
        p.log.headerPairs = p.log.headerPairs.filter(([k]) => k !== "DeviceUID");
        expect(statuses(p).fc_identity_binding).toBe("FAIL");
    });
});
