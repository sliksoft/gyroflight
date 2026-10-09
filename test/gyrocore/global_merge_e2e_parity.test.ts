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
 * WU3 end-to-end parity: generated CHIRP flights through Gyroflight (Viewer
 * decode -> GyroCore qualification -> Betaflight recommendGains -> GyroCore
 * merge) against GyroCore's Python engine + merge on the same bytes
 * (fixtures/merge/merge_e2e_reference.json, tools/gc_merge_e2e.py).
 *
 * Exact: which axes take part, every per-axis slider integer and the merge
 * result. The final authorization differs where Gyroflight is deliberately
 * stricter than the Python engine (docs/gyrocore/GLOBAL_TUNE_MERGE.md):
 * EXPECTED_AUTHORIZATION records it case by case.
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

/** Gyroflight's verdict, and the reason where it is stricter than the Python engine's proposal. */
const EXPECTED_AUTHORIZATION: Record<string, { authorized: boolean; stricterBecause?: string }> = {
    three_axis_agree: { authorized: true },
    rp_mode_yaw_excluded: { authorized: true },
    single_roll: { authorized: true },
    roll_pitch_conflict: { authorized: false },
    pids_mode_off: { authorized: false },
    // Python merges roll alone and proposes; its safety-pipeline test blocks an unusable axis, so Gyroflight does.
    roll_ok_pitch_rejected: { authorized: false, stricterBecause: "system_id_unusable" },
    // Python only warns on a slider clamp; WU2/WU3 block a reduction turned into an increase.
    ff_floor_three_axis: {
        authorized: false,
        stricterBecause: "composite_clamp_changes_direction:slider_feedforward_gain",
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

            // Same per-axis Betaflight recommendations, and the same axes left out.
            for (const [axis, py] of Object.entries(ref.axes)) {
                const source = composite.sources.find((s) => s.axisName === axis)!;
                expect(source.role === "participating", `${axis} participates`).toBe(py.status !== "blocked");
                if (py.proposed) {
                    expect(source.proposed).toEqual(py.proposed);
                }
            }
            // Identical merge output.
            expect(JSON.parse(JSON.stringify(composite.merge))).toEqual(ref.merge);

            const expected = EXPECTED_AUTHORIZATION[ref.case_id];
            expect(composite.authorized).toBe(expected.authorized);
            if (expected.stricterBecause) {
                expect(ref.proposal_status).not.toBe("blocked");
                expect(ref.proposal_status).not.toBe("MERGE_REQUIRES_REVIEW");
                expect(composite.blocked).toContain(expected.stricterBecause);
            }
        });
    }
});
