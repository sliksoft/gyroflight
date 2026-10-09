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
 * Drives the Blackbox Viewer's own parser (src/blackbox-viewer/, unmodified)
 * headlessly and records what it decodes, for comparison with GyroCore.
 *
 * Two views are taken of each embedded log:
 *   - the raw parser view: every frame FlightLogParser hands to onFrameReady,
 *     with validity, as decoded integers (predictors applied, no scaling);
 *   - the FlightLog view: the frames the Blackbox Viewer actually shows
 *     (getChunksInTimeRange over the whole log), which is what GyroCore's
 *     frame counts were measured on.
 */

import { FlightLog } from "../../../src/blackbox-viewer/flightlog.js";
import { FlightLogIndex } from "../../../src/blackbox-viewer/flightlog_index.js";
import { FlightLogParser } from "../../../src/blackbox-viewer/flightlog_parser.js";

export interface ViewerEvent {
    type: number;
    data: Record<string, unknown>;
    /** Time of the event if the payload carries one, else the time of the preceding valid main frame. */
    time: number | null;
    /** Index of the next valid main frame after the event (in decode order). */
    beforeFrame: number;
}

export interface ViewerLog {
    logIndex: number;
    error: string | null;
    sysConfig: Record<string, unknown>;
    mainFieldNames: string[];
    slowFieldNames: string[];
    /** Valid I/P frames in decode order, each followed by the last S-frame values (as blackbox_decode merges them). */
    rows: number[][];
    validI: number;
    validP: number;
    /** Frames delivered with frameValid=false (stream invalidated, waiting for the next I-frame). */
    invalidMainDelivered: number;
    corruptFrames: number;
    desyncFrames: number;
    intentionallyAbsentIterations: number;
    events: ViewerEvent[];
    firstTime: number | null;
    lastTime: number | null;
    /** Places where time or loopIteration went backwards between consecutive valid main frames. */
    timeResets: number;
    iterationResets: number;
    /** Frames the FlightLog (Blackbox Viewer) view exposes across the whole log. */
    flightLogFrames: number | null;
    flightLogMinTime: number | null;
    flightLogMaxTime: number | null;
}

/** The parts of FlightLogParser (untyped JS) this harness reads, after parseHeader(). */
interface ParserView {
    parseHeader(start: number, end: number): void;
    parseLogData(raw: boolean, start?: number, end?: number): void;
    onFrameReady: ((valid: boolean, frame: unknown, type: string, offset: number, size: number) => void) | null;
    sysConfig: Record<string, unknown>;
    frameDefs: Record<string, { name: string[] } | undefined>;
    stats: { totalCorruptFrames: number; intentionallyAbsentIterations: number; frame: Record<string, FrameStats> };
}

interface FrameStats {
    validCount?: number;
    corruptCount?: number;
    desyncCount?: number;
}

const ITERATION = 0;
const TIME = 1;

function pick(sysConfig: Record<string, unknown>, keys: string[]) {
    // sysConfig keeps its defaults on the prototype, so read keys individually.
    const out: Record<string, unknown> = {};
    for (const key of keys) {
        out[key] = sysConfig[key];
    }
    return out;
}

const SYS_KEYS = [
    "firmwareVersion",
    "looptime",
    "gyro_sync_denom",
    "pid_process_denom",
    "frameIntervalI",
    "frameIntervalPNum",
    "frameIntervalPDenom",
    "debug_mode",
    "debug_mode_name",
    "motorOutput",
];

export function decodeWithViewer(
    bytes: Uint8Array,
    opts: { keepRows?: boolean; flightLog?: boolean; only?: number } = {},
) {
    const keepRows = opts.keepRows ?? true;
    const index = new FlightLogIndex(bytes);
    const logCount: number = index.getLogCount();
    const logs: ViewerLog[] = [];

    for (let i = 0; i < logCount; i++) {
        if (opts.only !== undefined && i !== opts.only) {
            continue;
        }
        const start = index.getLogBeginOffset(i);
        const end = index.getLogBeginOffset(i + 1);
        const parser = new FlightLogParser(bytes) as unknown as ParserView;
        const log: ViewerLog = {
            logIndex: i,
            error: null,
            sysConfig: {},
            mainFieldNames: [],
            slowFieldNames: [],
            rows: [],
            validI: 0,
            validP: 0,
            invalidMainDelivered: 0,
            corruptFrames: 0,
            desyncFrames: 0,
            intentionallyAbsentIterations: 0,
            events: [],
            firstTime: null,
            lastTime: null,
            timeResets: 0,
            iterationResets: 0,
            flightLogFrames: null,
            flightLogMinTime: null,
            flightLogMaxTime: null,
        };
        logs.push(log);

        try {
            parser.parseHeader(start, end);
        } catch (e) {
            log.error = String(e);
            continue;
        }
        log.sysConfig = pick(parser.sysConfig, SYS_KEYS);
        log.mainFieldNames = [...parser.frameDefs.I!.name];
        log.slowFieldNames = parser.frameDefs.S ? [...parser.frameDefs.S.name] : [];

        let lastSlow: number[] = log.slowFieldNames.map(() => 0);
        let mainCount = 0;
        let prevTime = -1;
        let prevIter = -1;

        parser.onFrameReady = (valid: boolean, frame: unknown, type: string) => {
            if (type === "I" || type === "P") {
                if (!valid) {
                    log.invalidMainDelivered++;
                    return;
                }
                const values = frame as ArrayLike<number>;
                const time = values[TIME];
                const iter = values[ITERATION];
                if (type === "I") {
                    log.validI++;
                } else {
                    log.validP++;
                }
                if (log.firstTime === null) {
                    log.firstTime = time;
                }
                if (prevTime !== -1 && time < prevTime) {
                    log.timeResets++;
                }
                if (prevIter !== -1 && iter < prevIter) {
                    log.iterationResets++;
                }
                prevTime = time;
                prevIter = iter;
                log.lastTime = time;
                if (keepRows) {
                    log.rows.push([...Array.from(values).slice(0, log.mainFieldNames.length), ...lastSlow]);
                }
                mainCount++;
            } else if (type === "S" && valid) {
                lastSlow = Array.from(frame as ArrayLike<number>).slice(0, log.slowFieldNames.length);
            } else if (type === "E") {
                const event = frame as { event: number; data: Record<string, unknown>; time?: number };
                log.events.push({
                    type: event.event,
                    data: { ...event.data },
                    time: event.time ?? (prevTime === -1 ? null : prevTime),
                    beforeFrame: mainCount,
                });
            }
        };

        try {
            parser.parseLogData(false, undefined, undefined);
        } catch (e) {
            log.error = String(e);
        }
        log.corruptFrames = parser.stats.totalCorruptFrames;
        log.intentionallyAbsentIterations = parser.stats.intentionallyAbsentIterations;
        log.desyncFrames = Object.values(parser.stats.frame).reduce((sum, s) => sum + (s.desyncCount ?? 0), 0);
    }

    if (opts.flightLog ?? true) {
        const flightLog = new FlightLog(bytes);
        for (const log of logs) {
            if (log.error || !flightLog.openLog(log.logIndex)) {
                continue;
            }
            const min = flightLog.getMinTime(log.logIndex);
            const max = flightLog.getMaxTime(log.logIndex);
            log.flightLogMinTime = min;
            log.flightLogMaxTime = max;
            const chunks = flightLog.getChunksInTimeRange(min, max) as { frames: unknown[] }[];
            log.flightLogFrames = chunks.reduce((sum, c) => sum + c.frames.length, 0);
        }
    }

    return { logCount, logs };
}
