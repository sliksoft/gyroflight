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
 * Mode-event regression (GyroCore WU, commit 8c075e7 in the GyroCore repo).
 *
 * The native blackbox_decode tool once skipped the payload of FLIGHT_MODE and
 * DISARM event frames, so the unread payload bytes were taken for frame data
 * and every frame until the next I-frame was lost (578 instead of 640 frames
 * in this fixture). This proves both decoders in the Betaflight App read those
 * payloads and lose no frames:
 *   - the Blackbox Viewer parser (src/blackbox-viewer/flightlog_parser.js);
 *   - the Autotune chirp parser (src/js/blackbox/chirp_bbl_parser.ts), which is
 *     a separate decoder and is what CHIRP mode switching actually feeds.
 */

import { describe, expect, it } from "vitest";
import { findLogBoundaries, parseChirpLog } from "../../src/js/blackbox/chirp_bbl_parser";
import { FlightLogEvent } from "../../src/blackbox-viewer/flightlog_fielddefs.js";
import { decodeWithViewer } from "./harness/viewerDecode";
import { readFixtureBytes, readFixtureJson, sha256 } from "./harness/fixtures";

interface ModeEventsSpec {
    frame_count: number;
    i_interval: number;
    events: Record<string, { type: number; payload: number[] }>;
    unpatched_native_frame_count: number;
}

const BBL_SHA256 = "c38ba1ae68973a9e75083ecc6a7f00d3c9f799c4df9c1587034783800830f797";
const bytes = readFixtureBytes("decode/mode_events.bbl.gz");
const spec = readFixtureJson<ModeEventsSpec>("decode/mode_events.json");

/** The same log with debug_mode set to CHIRP, so the Autotune parser accepts and decodes it. */
function asChirpLog(source: Uint8Array) {
    // Patch bytes, not text: TextDecoder("latin1") is windows-1252 and would rewrite 0x80-0x9F.
    const from = new TextEncoder().encode("H debug_mode:0\n");
    const to = new TextEncoder().encode("H debug_mode:96\n");
    const at = indexOfBytes(source, from);
    expect(at).toBeGreaterThan(0);
    const out = new Uint8Array(source.length + to.length - from.length);
    out.set(source.subarray(0, at), 0);
    out.set(to, at);
    out.set(source.subarray(at + from.length), at + to.length);
    return out;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array) {
    outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
        for (let j = 0; j < needle.length; j++) {
            if (haystack[i + j] !== needle[j]) {
                continue outer;
            }
        }
        return i;
    }
    return -1;
}

describe("GyroCore mode-event regression", () => {
    it("uses the committed GyroCore fixture", () => {
        expect(sha256(bytes)).toBe(BBL_SHA256);
        expect(spec.frame_count).toBe(640);
        expect(spec.unpatched_native_frame_count).toBeLessThan(spec.frame_count);
    });

    it("Blackbox Viewer parser keeps every frame across FLIGHT_MODE and DISARM events", () => {
        const { logCount, logs } = decodeWithViewer(bytes);
        expect(logCount).toBe(1);
        const [log] = logs;
        expect(log.error).toBeNull();
        expect(log.corruptFrames).toBe(0);
        expect(log.invalidMainDelivered).toBe(0);
        expect(log.validI + log.validP).toBe(spec.frame_count);
        expect(log.flightLogFrames).toBe(spec.frame_count);

        const iterations = log.rows.map((row) => row[0]);
        expect(iterations).toEqual(Array.from({ length: spec.frame_count }, (_, i) => i));
        expect(log.timeResets).toBe(0);

        // The generator also writes a DISARM (reason 4) after the last frame, before LOG_END
        // (GyroCore tools/decode_reference/make_mode_event_fixture.py); mode_events.json lists only mid-log events.
        const expected = [
            ...Object.entries(spec.events).map(([frame, ev]) => ({ frame: Number(frame), ...ev })),
            { frame: spec.frame_count, type: FlightLogEvent.DISARM, payload: [4] },
        ];
        const seen = log.events.filter((e) => e.type !== FlightLogEvent.LOG_END);
        expect(seen.map((e) => e.type)).toEqual(expected.map((e) => e.type));
        for (const [i, ev] of expected.entries()) {
            expect(seen[i].beforeFrame).toBe(ev.frame);
            if (ev.type === FlightLogEvent.FLIGHT_MODE) {
                expect(seen[i].data).toEqual({ newFlags: ev.payload[0], lastFlags: ev.payload[1] });
            } else {
                expect(seen[i].data).toEqual({ reason: ev.payload[0] });
            }
        }
    });

    it("Autotune chirp parser keeps every frame across FLIGHT_MODE and DISARM events", () => {
        const chirpBytes = asChirpLog(bytes);
        const [boundary, ...rest] = findLogBoundaries(chirpBytes);
        expect(rest).toHaveLength(0);
        const { chirpData } = parseChirpLog(chirpBytes, boundary.start, boundary.end, "1.49.0");
        expect(chirpData.totalFrames).toBe(spec.frame_count);
        expect(chirpData.corruptFrames).toBe(0);
    });
});
