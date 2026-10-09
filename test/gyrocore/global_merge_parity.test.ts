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
 * WU3: the TypeScript port of GyroCore's global-slider merge against the
 * Python reference (core/gyrocore/autotune/merge.py at d2e60f7), evaluated by
 * test/gyrocore/tools/gc_merge_reference.py into fixtures/merge/merge_reference.json.
 * The merge is integer logic only, so parity is exact (deep equality), including
 * which invalid inputs raise.
 */

import { describe, expect, it } from "vitest";
import {
    mergeAutotuneSliders,
    POLICY_ID,
    type MergeAxisInput,
    type SimplifiedSliders,
} from "../../src/gyrocore/tuning/merge";
import { readFixtureJson } from "./harness/fixtures";

interface ReferenceCase {
    case_id: string;
    input: {
        axes: { axis: number; blocked: boolean; proposed: Record<string, number | "NaN"> | null }[];
        current: SimplifiedSliders;
    };
    expected: Record<string, unknown> | null;
    error: string | null;
}

const reference = readFixtureJson<{ gyrocore_commit: string; policy_id: string; cases: ReferenceCase[] }>(
    "merge/merge_reference.json",
);

function decode(axes: ReferenceCase["input"]["axes"]): MergeAxisInput[] {
    return axes.map((a) => ({
        axis: a.axis,
        blocked: a.blocked,
        proposed: a.proposed
            ? Object.fromEntries(Object.entries(a.proposed).map(([k, v]) => [k, v === "NaN" ? Number.NaN : v]))
            : null,
    }));
}

describe("global-slider merge parity with GyroCore Python", () => {
    it("reference generated from GyroCore d2e60f7, same policy", () => {
        expect(reference.gyrocore_commit).toBe("d2e60f7");
        expect(reference.policy_id).toBe(POLICY_ID);
        expect(reference.cases.length).toBeGreaterThanOrEqual(20);
    });

    for (const c of reference.cases) {
        it(c.case_id, () => {
            const run = () => mergeAutotuneSliders(decode(c.input.axes), c.input.current);
            if (c.error) {
                expect(run).toThrow(new RegExp(`^${c.error}`));
                return;
            }
            expect(JSON.parse(JSON.stringify(run()))).toEqual(c.expected);
        });
    }
});
