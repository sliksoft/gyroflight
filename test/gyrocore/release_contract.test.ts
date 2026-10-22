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
 * Release contract v2 (releaseGate/releaseContract.ts) and its independent-validation
 * evidence (releaseGate/verifiedTune.ts). The contract must be satisfiable by real evidence
 * (a record from the producer, margins above target) and must refuse each missing or forged
 * piece on its own.
 */

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it } from "vitest";
import {
    evaluateRelease,
    RELEASE_TARGETS,
    type AbsoluteProposal,
    type AbsoluteReleaseEvidence,
} from "../../src/gyrocore/releaseGate/releaseContract";
import { verifiedTuneIssues, type VerifiedTune } from "../../src/gyrocore/releaseGate/verifiedTune";
import { productApplyBlocks } from "../../src/gyrocore/productLock/productApply";
import { useVerifiedTuneStore } from "../../src/gyrocore/stores/verifiedTunes";
import { FIXTURE_FIRMWARE, FIXTURE_UID, verifiedTuneFixture } from "./harness/verifiedTuneFixture";

const HEADERS: [string, string][] = [
    ["Firmware revision", `Betaflight ${FIXTURE_FIRMWARE} (43875a55a) STM32G474`],
    ["Board information", "BEFH BETAFPVG473"],
    ["DeviceUID", "0a1b2c3d4e5f607112233445"],
    ["rollPID", "56,79,30"],
    ["pitchPID", "82,117,61"],
    ["yawPID", "56,79,0"],
    ["ff_weight", "22,32,22"],
];

function margins(axis: "roll" | "pitch" | "yaw", pm = 50, gm = 9, s = 4) {
    return {
        axis,
        status: "VALIDATED" as const,
        phaseMarginDeg: pm,
        gainMarginDb: gm,
        sensitivityPeakDb: s,
        reasons: [],
    };
}

function evidence(over: Partial<AbsoluteReleaseEvidence> = {}): AbsoluteReleaseEvidence {
    return {
        measurement: { valid: true, reasons: [] },
        model: { status: "VALIDATED", reasons: [] },
        margins: [margins("roll"), margins("pitch"), margins("yaw")],
        independentValidation: verifiedTuneFixture(),
        safetyAnalysisEvidence: "available",
        safetyReasons: [],
        ...over,
    };
}

function proposal(change: Record<string, number> = { p_roll: 64 }, ev = evidence()): AbsoluteProposal {
    return {
        id: "p1",
        createdAt: "2026-10-22T00:00:00Z",
        log: { sha256: "d".repeat(64), logIndex: 0, headerPairs: HEADERS },
        change,
        items: [],
        release: ev,
    };
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
});

describe("Verified Tune producer", () => {
    it("a correct prediction across a real gain change gives PASS with the validated range", () => {
        const v = verifiedTuneFixture();
        expect(v.verdict).toBe("PASS");
        expect(v.comparisons[0]).toMatchObject({ axis: "roll", verdict: "PASS" });
        expect(v.comparisons[0].detectableBins).toBeGreaterThanOrEqual(3);
        expect(v.comparisons[0].loopBins).toBeGreaterThanOrEqual(3);
        expect(v.validatedRelativeChange.roll.p).toBeCloseTo(17 / 56, 6);
        expect(verifiedTuneIssues(v, { uid: FIXTURE_UID, firmware: FIXTURE_FIRMWARE })).toEqual([]);
    });

    it("a prediction the candidate flight contradicts is FAIL: plant off by 20 %, or 1 ms unmodelled delay", () => {
        for (const v of [
            verifiedTuneFixture({ truePlantScale: 1.2 }),
            verifiedTuneFixture({ candidateExtraDelayS: 0.001 }),
        ]) {
            expect(v.verdict).toBe("FAIL");
            expect(v.reasons).toContain("verified_tune:roll:fail");
            expect(v.comparisons[0].loopWithinShare).toBeLessThan(0.8);
        }
    });

    it("a change too small to resolve cannot validate anything", () => {
        const v = verifiedTuneFixture({ candidateP: 60 });
        expect(v.verdict).toBe("FAIL");
        expect(v.reasons).toContain("verified_tune:roll:not_detectable");
    });

    it("the same log twice is not independent", () => {
        expect(verifiedTuneFixture({ sameLog: true }).reasons).toContain("verified_tune:same_log");
    });

    it("a forged or edited record fails its integrity check; another craft or firmware is refused", () => {
        const v = verifiedTuneFixture();
        const edited: VerifiedTune = {
            ...v,
            validatedRelativeChange: { ...v.validatedRelativeChange, roll: { p: 5, i: 5, d: 5 } },
        };
        expect(verifiedTuneIssues(edited, { uid: FIXTURE_UID, firmware: FIXTURE_FIRMWARE })).toContain(
            "verified_tune:integrity",
        );
        expect(verifiedTuneIssues(v, { uid: [1, 2, 3], firmware: FIXTURE_FIRMWARE })).toContain(
            "verified_tune:different_craft",
        );
        expect(verifiedTuneIssues(v, { uid: FIXTURE_UID, firmware: "2026.12.0" })).toContain(
            "verified_tune:different_firmware",
        );
        expect(
            verifiedTuneIssues({ id: "vt-x" } as unknown as VerifiedTune, {
                uid: FIXTURE_UID,
                firmware: FIXTURE_FIRMWARE,
            }),
        ).toEqual(["independent_pid_validation_missing"]);
    });

    it("the store keeps passing records only", () => {
        const store = useVerifiedTuneStore();
        expect(store.save(verifiedTuneFixture({ truePlantScale: 1.4 }))).toBe(false);
        expect(store.save(verifiedTuneFixture())).toBe(true);
        expect(store.forCraft(FIXTURE_UID, FIXTURE_FIRMWARE)?.verdict).toBe("PASS");
        expect(store.forCraft([1, 2, 3], FIXTURE_FIRMWARE)).toBeNull();
    });
});

describe("release contract", () => {
    it("is satisfiable: real evidence on every condition releases", () => {
        const d = evaluateRelease(proposal());
        expect(d.blocks).toEqual([]);
        expect(d.released).toBe(true);
        expect(d.conditions.map((c) => c.name)).toEqual([
            "measurement",
            "model_quality",
            "phase_margin",
            "robustness",
            "independent_validation",
            "safety_evidence",
        ]);
    });

    const cases: [string, Partial<AbsoluteReleaseEvidence>, string][] = [
        [
            "invalid measurement",
            { measurement: { valid: false, reasons: ["coherence_low:roll"] } },
            "measurement:coherence_low:roll",
        ],
        ["model only partial", { model: { status: "PARTIAL", reasons: [] } }, "model_quality:model_partial"],
        [
            "PM not validated",
            { margins: [{ ...margins("roll"), status: "NOT_VALIDATED", reasons: ["dyn_notch_centres_unknown"] }] },
            "phase_margin:pm_not_validated:roll",
        ],
        [
            "PM below target",
            { margins: [margins("roll", RELEASE_TARGETS.minPhaseMarginDeg - 1)] },
            "phase_margin:pm_below_target:roll:39",
        ],
        ["gain margin low", { margins: [margins("roll", 50, 4)] }, "robustness:gain_margin_below_target:roll:4"],
        ["|S| peak high", { margins: [margins("roll", 50, 9, 7)] }, "robustness:sensitivity_peak_above_target:roll:7"],
        [
            "no Verified Tune",
            { independentValidation: null },
            "independent_validation:independent_pid_validation_missing",
        ],
        [
            "failed Verified Tune",
            { independentValidation: verifiedTuneFixture({ truePlantScale: 1.4 }) },
            "independent_validation:verified_tune:not_passed",
        ],
        [
            "Verified Tune of other firmware",
            { independentValidation: verifiedTuneFixture({ firmware: "2026.12.0" }) },
            "independent_validation:verified_tune:different_firmware",
        ],
        [
            "no Safety evidence",
            { safetyAnalysisEvidence: "not_available", safetyReasons: [] },
            "safety_evidence:safety_evidence_not_available",
        ],
    ];
    for (const [name, over, reason] of cases) {
        it(`${name} blocks on its own`, () => {
            const d = evaluateRelease(proposal({ p_roll: 64 }, evidence(over)));
            expect(d.released).toBe(false);
            expect(d.blocks).toContain(reason);
        });
    }

    it("refuses a PID change larger than the one the Verified Tune confirmed (no extrapolation)", () => {
        const d = evaluateRelease(proposal({ p_roll: 90 }));
        expect(d.blocks).toEqual(["independent_validation:verified_tune:change_outside_validated:roll:p"]);
    });

    it("a filter change needs margins on every axis", () => {
        const d = evaluateRelease(proposal({ dterm_lpf1_static_hz: 80 }, evidence({ margins: [margins("roll")] })));
        expect(d.blocks).toEqual(
            expect.arrayContaining(["phase_margin:margins_missing:pitch", "phase_margin:margins_missing:yaw"]),
        );
    });
});

describe("v1 product release uses the same evidence", () => {
    const craft = { uid: FIXTURE_UID, firmware: FIXTURE_FIRMWARE };
    it("a real Verified Tune for this craft lifts independent_pid_validation_missing", () => {
        expect(
            productApplyBlocks({
                safetyAnalysisEvidence: "available",
                independentPidValidation: verifiedTuneFixture(),
                craft,
            }),
        ).toEqual([]);
    });
    it("a record for another craft, or without a craft to check it against, does not", () => {
        expect(
            productApplyBlocks({
                safetyAnalysisEvidence: "available",
                independentPidValidation: verifiedTuneFixture(),
                craft: { uid: [1, 2, 3], firmware: FIXTURE_FIRMWARE },
            }),
        ).toEqual(["independent_pid_validation_missing", "verified_tune:different_craft"]);
        expect(
            productApplyBlocks({
                safetyAnalysisEvidence: "available",
                independentPidValidation: verifiedTuneFixture(),
            }),
        ).toContain("independent_pid_validation_missing");
    });
});
