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
 * LOCAL ONLY: Blackbox parser qualification on the real AIR65 three-log CHIRP
 * flight. The log is private and not committed; the test is skipped unless
 *   GYROFLIGHT_AIR65_BBL      path to the AIR65 .BBL (sha256 checked)
 *   GYROFLIGHT_AIR65_REF_DIR  directory with native_log{1,2,3}.csv from GyroCore's
 *                             patched blackbox_decode (see harness/nativeCsv.ts)
 * are set. See docs/gyrocore/BLACKBOX_CHIRP_PARITY.md for how to reproduce.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findLogBoundaries, parseChirpLog } from "../../src/js/blackbox/chirp_bbl_parser";
import { FlightLogEvent } from "../../src/blackbox-viewer/flightlog_fielddefs.js";
import { AIR65_GYROCORE_FRAMES, AIR65_SHA256, localAir65, sha256, writeReport } from "./harness/fixtures";
import { compareRows, readNativeCsv } from "./harness/nativeCsv";
import { decodeWithViewer } from "./harness/viewerDecode";

const air65 = localAir65();
const EVENT_NAMES = Object.fromEntries(Object.entries(FlightLogEvent).map(([k, v]) => [v, k]));

describe.skipIf(!air65)("AIR65 blackbox parser qualification (local only)", () => {
    const bytes = air65?.bbl ?? new Uint8Array();

    it("uses the exact GyroCore AIR65 fixture", () => {
        expect(sha256(bytes)).toBe(AIR65_SHA256);
    });

    it("Betaflight decoders reproduce GyroCore's corrected frame counts and values", () => {
        const summary = decodeWithViewer(bytes, { keepRows: false });
        const boundaries = findLogBoundaries(bytes);
        const report: Record<string, unknown>[] = [];
        expect(summary.logCount).toBe(3);
        expect(boundaries).toHaveLength(3);

        for (const log of summary.logs) {
            const chirp = parseChirpLog(bytes, boundaries[log.logIndex].start, boundaries[log.logIndex].end);
            const entry: Record<string, unknown> = {
                logIndex: log.logIndex,
                error: log.error,
                sysConfig: log.sysConfig,
                fieldCount: log.mainFieldNames.length,
                slowFields: log.slowFieldNames,
                viewer: {
                    validI: log.validI,
                    validP: log.validP,
                    validMain: log.validI + log.validP,
                    flightLogFrames: log.flightLogFrames,
                    invalidMainDelivered: log.invalidMainDelivered,
                    corruptFrames: log.corruptFrames,
                    desyncFrames: log.desyncFrames,
                    intentionallyAbsentIterations: log.intentionallyAbsentIterations,
                    firstTime: log.firstTime,
                    lastTime: log.lastTime,
                    flightLogMinTime: log.flightLogMinTime,
                    flightLogMaxTime: log.flightLogMaxTime,
                    timeResets: log.timeResets,
                    iterationResets: log.iterationResets,
                    events: log.events.map((e) => ({ ...e, name: EVENT_NAMES[e.type] })),
                },
                autotuneParser: {
                    totalFrames: chirp.chirpData.totalFrames,
                    corruptFrames: chirp.chirpData.corruptFrames,
                    sampleCount: chirp.chirpData.sampleCount,
                    segments: chirp.chirpData.segments,
                },
                gyrocoreFrames: AIR65_GYROCORE_FRAMES[log.logIndex],
            };

            if (air65?.refDir) {
                const rowsLog = decodeWithViewer(bytes, { only: log.logIndex, flightLog: false }).logs[0];
                const native = readNativeCsv(join(air65.refDir, `native_log${log.logIndex + 1}.csv`));
                // energyCumulative is computed by blackbox_decode itself, not decoded from the log.
                const parity = compareRows(
                    [...rowsLog.mainFieldNames, ...rowsLog.slowFieldNames],
                    rowsLog.rows,
                    native,
                    ["energyCumulative"],
                );
                entry.nativeParity = {
                    ...parity,
                    nativeFirstTime: native.rows[0]?.[1],
                    nativeLastTime: native.rows.at(-1)?.[1],
                    columns: parity.columns.filter((c) => c.mismatches > 0),
                    columnsCompared: parity.columns.length,
                    columnsExact: parity.columns.filter((c) => c.mismatches === 0).length,
                };
            }
            report.push(entry);
        }
        writeReport("air65_blackbox", report);

        for (const [i, entry] of report.entries()) {
            const viewer = entry.viewer as { validMain: number; flightLogFrames: number; timeResets: number };
            const autotune = entry.autotuneParser as { totalFrames: number };
            expect(viewer.validMain, `log ${i + 1} viewer frames`).toBe(AIR65_GYROCORE_FRAMES[i]);
            expect(viewer.flightLogFrames, `log ${i + 1} FlightLog frames`).toBe(AIR65_GYROCORE_FRAMES[i]);
            expect(autotune.totalFrames, `log ${i + 1} autotune-parser frames`).toBe(AIR65_GYROCORE_FRAMES[i]);
            expect(viewer.timeResets).toBe(0);
            const parity = entry.nativeParity as
                { viewerOnly: number; nativeOnly: number; columnsCompared: number; columnsExact: number } | undefined;
            if (parity) {
                expect(parity.viewerOnly, `log ${i + 1} viewer-only rows`).toBe(0);
                expect(parity.nativeOnly, `log ${i + 1} native-only rows`).toBe(0);
                expect(parity.columnsExact, `log ${i + 1} exact columns`).toBe(parity.columnsCompared);
            }
        }
    }, 600_000);
});
