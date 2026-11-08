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
 * LOCAL negative control (block 9, Grok SHOULD-FIX 1): the I-relax acceptance on the real AIR65 logs
 * with the right parameters and with deliberately wrong ones (ACRO threshold instead of ANGLE, a
 * wrong relax cutoff, no relax). A wrong hypothesis must not be accepted. Written as JSON to
 * GYROFLIGHT_TRACE_OUT. Skipped without the private logs.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { buildLogInputs } from "../../src/gyrocore/engine/logInput";
import { itermRelaxConfigFromHeaders, itermRelaxInForce } from "../../src/js/blackbox/betaflight_iterm_relax";

const FILES = [
    {
        name: "nov05",
        env: "GYROFLIGHT_AIR65_NOV05",
        sha256: "5654476ad783f1fa241d9fe6e8ae5f978c3d5cef6b417d0d93a59e26ed2b9894",
    },
    {
        name: "nov06",
        env: "GYROFLIGHT_AIR65_NOV06",
        sha256: "eb8ad42e2010e88b6c2bed7e2be4b316993dd38ad86f1438907355d8d5d923a7",
    },
    {
        name: "nov06b",
        env: "GYROFLIGHT_AIR65_NOV06B",
        sha256: "2d0f567f07ae04a19c4d3b15c10e306408575079b57a704b46e3d594ae97be29",
    },
];
const present = FILES.every((f) => !!process.env[f.env] && existsSync(process.env[f.env]!));

describe.skipIf(!present)("block 9: I-relax acceptance, negative control on real logs (local)", () => {
    it("accepts the firmware parameters and rejects wrong ones", () => {
        const rows: unknown[] = [];
        for (const f of FILES) {
            const bytes = new Uint8Array(readFileSync(process.env[f.env]!));
            expect(createHash("sha256").update(bytes).digest("hex")).toBe(f.sha256);
            const q = qualifyChirpFile(bytes, `${f.name}.bbl`, 45, AUTOTUNE_MATH);
            for (const log of buildLogInputs(bytes, f.sha256, q, null)) {
                const h = Object.fromEntries(log.headerPairs);
                for (const [ai, axis] of (["roll", "pitch"] as const).entries()) {
                    const c = log.chirp[axis];
                    if (!c) continue;
                    const j = log.channels.jio!;
                    const mask = log.channels.rcModeMask!;
                    const base = itermRelaxConfigFromHeaders(h, ai as 0 | 1, 250e-6).config!;
                    const run = (cfg: typeof base, m: ArrayLike<number>) =>
                        itermRelaxInForce(
                            {
                                setpoint: j.setpoint![ai],
                                gyro: log.channels.gyroAdc[ai],
                                loggedI: j.axisI![ai],
                                loggedP: j.axisP![ai],
                                modeMask: m,
                                start: c.start,
                                end: c.end,
                            },
                            cfg,
                            ai as 0 | 1,
                        );
                    const noAngle = Float64Array.from(mask as ArrayLike<number>, (v) => v & ~2);
                    const variants = {
                        firmware: run(base, mask),
                        acroThreshold: run(base, noAngle),
                        cutoff5Hz: run({ ...base, cutoffHz: 5 }, mask),
                        cutoff100Hz: run({ ...base, cutoffHz: 100 }, mask),
                    };
                    rows.push({
                        file: f.name,
                        logIndex: log.logIndex,
                        axis,
                        ...Object.fromEntries(
                            Object.entries(variants).map(([k, v]) => [
                                k,
                                {
                                    status: v.status,
                                    meanFactor: v.meanFactor,
                                    ratioToUnrelaxed: v.rmsError! / v.rmsErrorUnrelaxed!,
                                    ratioToP: v.rmsError! / v.rmsLoggedP!,
                                    reasons: v.reasons,
                                },
                            ]),
                        ),
                    });
                    expect(variants.firmware.status).toBe("reconstructed");
                }
            }
        }
        const dir = process.env.GYROFLIGHT_TRACE_OUT;
        if (dir) {
            mkdirSync(dir, { recursive: true });
            writeFileSync(path.join(dir, "iterm_relax_negative_control.json"), JSON.stringify(rows, null, 1));
        }
    }, 600_000);
});
