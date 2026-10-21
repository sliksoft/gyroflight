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
 * WU3 end-to-end cases: generated CHIRP flights through Gyroflight (Viewer
 * decode -> qualification -> recommendGains -> merge).
 *
 * GF-1: phase-margin shaping via L = T/(1-T) is unvalidated for Betaflight's
 * rate PID, so proposals are held at the logged slider currents. Per-axis
 * integers therefore diverge from GyroCore's Python reference
 * (fixtures/merge/merge_e2e_reference.json); this suite pins the GF-1 hold
 * contract and still checks BBL sha256 + axis participation + authorization.
 */

import { describe, expect, it, vi } from "vitest";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { buildComposite } from "../../src/gyrocore/tuning/composite";
import { readFixtureJson, sha256 } from "./harness/fixtures";
import { MERGE_E2E_CASES } from "./harness/mergeE2eCases";

vi.mock("../../src/js/localization", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/js/localization")>()),
    i18n: { getMessage: (key: string) => key },
}));

interface E2eCase {
    case_id: string;
    bbl_sha256: string;
    axes: Record<string, { status: string; blocked: string[]; proposed: Record<string, number> | null }>;
    merge: Record<string, unknown> & { participating_axes: string[] };
    proposal_status: string;
}

const reference = readFixtureJson<{ gyrocore_commit: string; cases: E2eCase[] }>("merge/merge_e2e_reference.json");

/** Held simplified-tuning integers under GF-1 (logged defaults are 100). */
const HELD_DEFAULT = {
    slider_master_multiplier: 100,
    slider_pi_gain: 100,
    slider_i_gain: 100,
    slider_d_gain: 100,
    slider_feedforward_gain: 100,
    slider_dterm_filter_multiplier: 100,
};

/** Logged FF 15 is floored to 25 by buildProposedSliders even when scales are held. */
const HELD_FF_FLOOR = { ...HELD_DEFAULT, slider_feedforward_gain: 25 };

const EXPECTED: Record<
    string,
    {
        authorized: boolean;
        participating: string[];
        proposed: Record<string, number>;
        blockedContains?: string[];
        warningsContains?: string[];
    }
> = {
    three_axis_agree: {
        authorized: false,
        participating: ["roll", "pitch", "yaw"],
        proposed: HELD_DEFAULT,
        blockedContains: ["phase_margin_not_validated"],
    },
    rp_mode_yaw_excluded: {
        authorized: false,
        participating: ["roll", "pitch"],
        proposed: HELD_DEFAULT,
        blockedContains: ["phase_margin_not_validated"],
    },
    single_roll: {
        authorized: false,
        participating: ["roll"],
        proposed: HELD_DEFAULT,
        blockedContains: ["missing_axis_evidence:pitch", "phase_margin_not_validated"],
    },
    roll_pitch_conflict: {
        authorized: false,
        participating: ["roll", "pitch"],
        proposed: HELD_DEFAULT,
        blockedContains: ["missing_axis_evidence:yaw", "phase_margin_not_validated"],
    },
    pids_mode_off: {
        authorized: false,
        participating: [],
        proposed: HELD_DEFAULT,
        blockedContains: ["simplified_pids_mode_off"],
    },
    roll_ok_pitch_rejected: {
        authorized: false,
        participating: ["roll"],
        proposed: HELD_DEFAULT,
        blockedContains: ["system_id_unusable", "phase_margin_not_validated"],
    },
    ff_floor_three_axis: {
        authorized: false,
        participating: ["roll", "pitch", "yaw"],
        proposed: HELD_FF_FLOOR,
        blockedContains: ["composite_clamp_changes_direction:slider_feedforward_gain", "phase_margin_not_validated"],
    },
};

describe("end-to-end merge parity with GyroCore's Python engine", () => {
    it("covers every generated case, from GyroCore d2e60f7", () => {
        expect(reference.gyrocore_commit).toBe("d2e60f7");
        expect(reference.cases.map((c) => c.case_id).sort()).toEqual(Object.keys(MERGE_E2E_CASES).sort());
    });

    for (const ref of reference.cases) {
        it(ref.case_id, () => {
            const bytes = MERGE_E2E_CASES[ref.case_id]();
            expect(sha256(bytes)).toBe(ref.bbl_sha256);
            const report = qualifyChirpFile(bytes, ref.case_id, 60, AUTOTUNE_MATH);
            const composite = buildComposite(report, 0, {}, {})!;
            const expected = EXPECTED[ref.case_id];

            expect(composite.merge.participating_axes).toEqual(expected.participating);
            for (const axis of expected.participating) {
                const source = composite.sources.find((s) => s.axisName === axis)!;
                expect(source.role).toBe("participating");
                expect(source.proposed).toEqual(expected.proposed);
            }
            if (composite.final) {
                expect(composite.final).toEqual(expected.proposed);
            }
            expect(composite.authorized).toBe(expected.authorized);
            if (expected.blockedContains) {
                for (const reason of expected.blockedContains) {
                    expect(composite.blocked).toContain(reason);
                }
            }
            if (expected.warningsContains) {
                for (const reason of expected.warningsContains) {
                    expect(composite.warnings).toContain(reason);
                }
            }
            // GF-1: proposals diverge from the Python L=T/(1-T) reference on purpose.
            if (ref.axes.roll?.proposed && expected.participating.includes("roll")) {
                expect(composite.sources.find((s) => s.axisName === "roll")!.proposed).not.toEqual(
                    ref.axes.roll.proposed,
                );
            }
        });
    }
});
