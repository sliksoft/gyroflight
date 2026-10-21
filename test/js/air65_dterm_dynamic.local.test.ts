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
 * LOCAL ONLY (M5-B): the firmware D path, driven by the logged gyroADC and
 * rcCommand[3], against the logged axisD of both private AIR65 CHIRP flights.
 * Skipped unless GYROFLIGHT_AIR65_BBL18 / GYROFLIGHT_AIR65_BBL19 point at the
 * files (sha256 checked). GYROFLIGHT_QUAL_OUT receives a JSON summary.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FlightLog } from "../../src/blackbox-viewer/flightlog.js";
import { FlightLogIndex } from "../../src/blackbox-viewer/flightlog_index.js";
import { readHeaderPairs } from "../../src/gyrocore/chirp/headers";
import { extractOptionalBlackboxChannels } from "../../src/js/blackbox/flight_metrics_analysis";
import {
    dtermConfigFromHeaders,
    dtermFitAccepted,
    fitDterm,
    simulateDterm,
    summarizeCutoff,
} from "../../src/js/blackbox/betaflight_dterm_dynamic";
import { writeReport } from "../gyrocore/harness/fixtures";

const FILES = {
    bbl18: {
        path: process.env.GYROFLIGHT_AIR65_BBL18,
        sha256: "dfe82bca2aaabbc2f53a20a93756137546cc648196226af622d43874eed7efcb",
    },
    bbl19: {
        path: process.env.GYROFLIGHT_AIR65_BBL19,
        sha256: "4dd55164ddadb529816d52c3709376defe265cf2efdd6b8c31738bd3b26361c7",
    },
};

/** Timestamp rate of both logs (M4.2: 4032.3 Hz, uniform). */
const SAMPLE_RATE_HZ = 4032.3;
const FLIGHT_THROTTLE = 1150;

for (const [key, file] of Object.entries(FILES)) {
    const present = !!file.path && existsSync(file.path);

    describe.skipIf(!present)(`AIR65 ${key}: dynamic D path vs logged axisD (local only)`, () => {
        it("reproduces axisD with the throttle-scheduled lpf1 and D_max; the static 75 Hz model does not", () => {
            const bytes = new Uint8Array(readFileSync(file.path!));
            expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
            const index = new FlightLogIndex(bytes);
            const end = index.getLogCount() > 1 ? index.getLogBeginOffset(1) : bytes.length;
            const headers = Object.fromEntries(readHeaderPairs(bytes, index.getLogBeginOffset(0), end));
            const log = new FlightLog(bytes);
            log.openLog(0);
            const ch = extractOptionalBlackboxChannels(log, {
                fields: ["time", "gyroADC[0]", "gyroADC[1]", "axisD[0]", "axisD[1]", "rcCommand[3]"],
            }).named;
            const rc = ch["rcCommand[3]"]!;

            const out: Record<string, unknown> = {};
            for (const axis of [0, 1] as const) {
                const cfg = dtermConfigFromHeaders(headers, axis, 250e-6);
                expect(cfg).not.toBeNull();
                const input = { timeUs: ch.time!, gyro: ch[`gyroADC[${axis}]`]!, rcThrottle: rc };
                const fit = (variant: Parameters<typeof simulateDterm>[2], c = cfg!) => {
                    const sim = simulateDterm(input, c, variant);
                    // Flight only: on the ground the firmware zeroes or resets the PID terms.
                    for (let k = 0; k < rc.length; k++) if (rc[k] < FLIGHT_THROTTLE) sim.valid[k] = 0;
                    return { sim, fit: fitDterm(sim, ch[`axisD[${axis}]`]!, SAMPLE_RATE_HZ) };
                };
                const dynamic = fit({ kind: "dynamic" });
                const stat = fit({ kind: "fixed", hz: cfg!.dtermLpf1StaticHz });
                const noDmax = fit({ kind: "dynamic" }, { ...cfg!, dMax: 0 });

                expect(dynamic.sim.notes).toEqual([]);
                expect(dtermFitAccepted(dynamic.fit, stat.fit)).toBe(true);
                expect(dtermFitAccepted(stat.fit, dynamic.fit)).toBe(false);
                expect(dynamic.fit!.nrmse).toBeLessThan(0.06);
                expect(stat.fit!.nrmse).toBeGreaterThan(2 * dynamic.fit!.nrmse);
                const cut = summarizeCutoff(dynamic.sim)!;
                // At hover throttle (~1345) the firmware sits near 109 Hz, far from the static 75 Hz.
                expect(cut.medianHz).toBeGreaterThan(100);
                expect(cut.medianHz).toBeLessThan(120);
                if (axis === 0) {
                    // Roll has d_max 40 > D 30: leaving the boost out is measurably worse.
                    expect(noDmax.fit!.nrmse).toBeGreaterThan(dynamic.fit!.nrmse * 1.3);
                }
                out[axis === 0 ? "roll" : "pitch"] = {
                    cutoffHz: cut,
                    dynamic: dynamic.fit,
                    static: stat.fit,
                    withoutDMax: noDmax.fit,
                };
            }
            writeReport(`air65_dterm_dynamic_${key}`, out);
        }, 600_000);
    });
}
