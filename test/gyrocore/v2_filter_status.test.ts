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
 * The filter recommendations (engine/filterOptimizer.ts) through the engine, on a SIMULATED log
 * (harness/syntheticLog.ts: the gyro chain and the D path validate by construction). A filter
 * result is a simulation on the logged data: it is never VALIDATED and never part of what Apply
 * may write, a rejected roll / pitch measurement blocks the D-term filter, and a gyro chain that
 * does not reproduce the logged gyroADC blocks every gyro-side filter group.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { runAutotuneV2, type AutotuneLogInput } from "../../src/gyrocore/engine/autotuneV2";
import { syntheticLogInput } from "./harness/syntheticLog";

const FILTER_PARTS = ["rpm_filter", "dynamic_notch", "gyro_filter", "dterm_filter"];
const run = (primary: AutotuneLogInput) =>
    runAutotuneV2({ primary, others: [], verifiedTune: null, createdAt: "2026-10-25T00:00:00Z" });
const log = syntheticLogInput("f".repeat(64));

describe("filter recommendations are simulations, never release evidence", () => {
    let r: ReturnType<typeof run>;
    beforeAll(() => {
        r = run(log);
    }, 120_000);

    it("every filter group is evaluated and stays PARTIAL on the simulated log", () => {
        expect(r.filters.map((g) => g.group)).toEqual(FILTER_PARTS);
        for (const g of r.filters) {
            expect(g.status, g.group).toBe("PARTIAL");
            expect(g.reasons, g.group).toContain("simulated_on_logged_data");
        }
    });

    it("no filter part is VALIDATED and no filter value reaches the releasable proposal", () => {
        for (const p of r.parts.filter((x) => FILTER_PARTS.includes(x.part)))
            expect(p.status, p.part).not.toBe("VALIDATED");
        const releasable = r.releasableProposal?.items ?? [];
        expect(releasable.filter((i) => /filter|notch|lpf|rpm/i.test(JSON.stringify(i)))).toEqual([]);
    });

    it("the dynamic notch names its replica and the flight that would check it directly", () => {
        const notch = r.filters.find((g) => g.group === "dynamic_notch")!;
        expect(notch.reasons).toContain("dyn_notch_centres_reconstructed_by_firmware_replica");
        expect(notch.reasons).toContain("required_measurement:fft_freq_debug_flight_for_direct_centre_check");
    });
});

describe("filter recommendations stop with a reason when their evidence is missing", () => {
    it("roll and pitch measurements rejected: the D-term filter is BLOCKED and asks for qualified sweeps", () => {
        const rejected: AutotuneLogInput = {
            ...log,
            chirp: {
                ...log.chirp,
                roll: { ...log.chirp.roll!, state: "rejected" },
                pitch: { ...log.chirp.pitch!, state: "rejected" },
            },
        };
        const d = run(rejected).filters.find((g) => g.group === "dterm_filter")!;
        expect(d.status).toBe("BLOCKED");
        expect(d.reasons).toEqual([
            "d_term_axes_measurement_rejected",
            "required_measurement:qualified_chirp_on_roll_and_pitch",
        ]);
    }, 120_000);

    it("a gyro chain that does not reproduce gyroADC: the gyro-side groups are BLOCKED", () => {
        const unfilt = log.channels.gyroUnfilt!;
        const scaled = unfilt.map((c) => Float64Array.from(c, (v) => 3 * v)) as unknown as typeof unfilt;
        const broken: AutotuneLogInput = { ...log, channels: { ...log.channels, gyroUnfilt: scaled } };
        const r = run(broken);
        expect(r.chain.validation.some((v) => v.reasons.length > 0)).toBe(true);
        for (const g of r.filters.filter((x) => x.group !== "dterm_filter")) {
            expect(g.status, g.group).toBe("BLOCKED");
            expect(g.reasons[0], g.group).toBe("chain_model_not_validated_on_this_log");
        }
    }, 120_000);
});
