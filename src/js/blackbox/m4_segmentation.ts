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
 * GF-1 M4.2: split one decoded log into flight / CHIRP / stick / excluded segments.
 *
 * Betaflight does not log "airborne". The only logged evidence used here:
 *   - flightModeFlags (rcModeActivationMask): ARM, ANGLE, HORIZON, CHIRP box bits
 *   - rcCommand[3]: throttle stick
 *   - failsafePhase
 *   - time: gaps (dropped frames) split every analysis range; long gaps also end flight runs
 * Motor output and eRPM are never used as flight evidence. "flight" therefore
 * means "arm box active with throttle above the take-off threshold, sustained,
 * with take-off / landing transitions trimmed" — an inference, reported as such.
 * Without the mode-flag or throttle column the log is "unclassifiable" and
 * nothing downstream treats any sample as flight or stick data.
 */

import { FLIGHT_LOG_FLIGHT_MODE_NAME_POST_4_5 } from "@/blackbox-viewer/flightlog_fielddefs.js";
import { BOXCHIRP_BIT } from "@/gyrocore/chirp/constants";
import { SPACING_GAP_FACTOR } from "@/gyrocore/chirp/sampleRate";

/** Index range into the log's frame arrays, end exclusive. */
export interface SampleRange {
    start: number;
    end: number;
}

export type SegmentKind =
    | "invalid"
    | "ground_or_disarmed"
    | "armed_low_throttle"
    | "flight_transition"
    | "chirp"
    | "chirp_guard"
    | "flight_self_level"
    | "flight_no_stick_input"
    | "stick";

export interface FlightSegment extends SampleRange {
    kind: SegmentKind;
    startTimeUs: number;
    endTimeUs: number;
    durationS: number;
    reasons: string[];
}

export interface SegmentationInput {
    timeUs: ArrayLike<number>;
    /** -1 where the Viewer had no S-frame yet; null when the column is absent. */
    flightModeFlags: ArrayLike<number> | null;
    /** rcCommand[3] (1000..2000); null when absent. */
    throttle: ArrayLike<number> | null;
    /** null when absent (treated as no failsafe evidence, reported). */
    failsafePhase: ArrayLike<number> | null;
    /** setpoint[0..1] in deg/s, for stick-activity checks. */
    setpoint: [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>];
    sampleRateHz: number;
}

export interface Segmentation {
    status: "segmented" | "unclassifiable";
    reasons: string[];
    segments: FlightSegment[];
    /** All inferred flight samples, CHIRP included (eRPM, overview). */
    flight: SampleRange[];
    chirp: SampleRange[];
    /** Acro, CHIRP-free, stick-active flight. The only input to stick FF / D. */
    stick: SampleRange[];
    /** CHIRP-free flight (stick, hover, self-level), for the gyro spectrum. */
    spectrum: SampleRange[];
    durationsS: Record<SegmentKind, number>;
    /** Gaps > SPACING_GAP_FACTOR x median spacing; every range is split at each one. */
    gapCount: number;
    /** Gaps longer than maxBridgedGapS (or non-increasing time): flight state unknown, runs end there. */
    longGapCount: number;
    thresholds: typeof SEGMENTATION_THRESHOLDS;
}

export const SEGMENTATION_THRESHOLDS = {
    /** rcCommand[3] at or above which an armed sample may be flight (15 % stick). */
    takeoffThrottle: 1150,
    /** A throttle-up run shorter than this is not accepted as flight. */
    minFlightS: 1.0,
    /** Trimmed from both ends of every flight run (take-off / landing / gap edges). */
    transitionS: 0.5,
    /** Excluded around every CHIRP run (sweep start / settling). */
    chirpGuardS: 0.25,
    /** Minimum length of one stick segment. */
    minStickSegmentS: 1.0,
    /** p95 |setpoint| on roll or pitch at or above this, per window, is stick activity (deg/s). */
    stickActivityDegS: 50,
    stickWindowS: 0.5,
    /** Longer gaps end a flight run (state during the gap is unknown). */
    maxBridgedGapS: 0.02,
} as const;

const MODE = FLIGHT_LOG_FLIGHT_MODE_NAME_POST_4_5 as readonly string[];
const ARM_BIT = 1 << MODE.indexOf("ARM");
const SELF_LEVEL_BITS = (1 << MODE.indexOf("ANGLE")) | (1 << MODE.indexOf("HORIZON"));
const CHIRP_BIT = 1 << BOXCHIRP_BIT;

const KINDS: SegmentKind[] = [
    "invalid",
    "ground_or_disarmed",
    "armed_low_throttle",
    "flight_transition",
    "chirp",
    "chirp_guard",
    "flight_self_level",
    "flight_no_stick_input",
    "stick",
];

function zeroDurations(): Record<SegmentKind, number> {
    return Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<SegmentKind, number>;
}

function medianDt(timeUs: ArrayLike<number>): number | null {
    const d: number[] = [];
    for (let i = 1; i < timeUs.length; i++) {
        const v = timeUs[i] - timeUs[i - 1];
        if (Number.isFinite(v) && v > 0) {
            d.push(v);
        }
    }
    if (!d.length) {
        return null;
    }
    d.sort((a, b) => a - b);
    return d[Math.floor(d.length / 2)];
}

function percentileAbs(x: ArrayLike<number>, start: number, end: number, p: number): number {
    const v: number[] = [];
    for (let i = start; i < end; i++) {
        const a = Math.abs(x[i]);
        if (Number.isFinite(a)) {
            v.push(a);
        }
    }
    if (!v.length) {
        return 0;
    }
    v.sort((a, b) => a - b);
    return v[Math.min(v.length - 1, Math.floor((p / 100) * (v.length - 1)))];
}

/** Contiguous runs of equal labels, also split wherever `breakAt[i]` (gap before sample i). */
function runs<T>(
    labels: T[],
    breakAt: Uint8Array,
    start = 0,
    end = labels.length,
): { label: T; start: number; end: number }[] {
    const out: { label: T; start: number; end: number }[] = [];
    let s = start;
    for (let i = start + 1; i <= end; i++) {
        if (i === end || labels[i] !== labels[s] || breakAt[i]) {
            out.push({ label: labels[s], start: s, end: i });
            s = i;
        }
    }
    return out;
}

export function segmentFlightLog(input: SegmentationInput): Segmentation {
    const T = SEGMENTATION_THRESHOLDS;
    const n = input.timeUs.length;
    const result: Segmentation = {
        status: "unclassifiable",
        reasons: [],
        segments: [],
        flight: [],
        chirp: [],
        stick: [],
        spectrum: [],
        durationsS: zeroDurations(),
        gapCount: 0,
        longGapCount: 0,
        thresholds: T,
    };
    const flags = input.flightModeFlags;
    const thr = input.throttle;
    if (!flags) {
        result.reasons.push("flight_mode_flags_missing_arm_state_unknown");
    }
    if (!thr) {
        result.reasons.push("throttle_rccommand3_missing");
    }
    const dt = medianDt(input.timeUs);
    if (dt === null || n < 2) {
        result.reasons.push("timestamps_unusable");
    }
    if (!(input.sampleRateHz > 0)) {
        result.reasons.push("sample_rate_unknown");
    }
    if (!flags || !thr || dt === null || n < 2 || !(input.sampleRateHz > 0)) {
        return result;
    }
    if (!input.failsafePhase) {
        result.reasons.push("failsafe_phase_missing_not_checked");
    }

    // gapAt[i]: gap before sample i (> SPACING_GAP_FACTOR x median) -> ranges split.
    // breakAt[i]: long gap or non-increasing time -> segment runs end.
    const gapAt = new Uint8Array(n + 1);
    const breakAt = new Uint8Array(n + 1);
    for (let i = 1; i < n; i++) {
        const d = input.timeUs[i] - input.timeUs[i - 1];
        if (!(d > 0) || d > SPACING_GAP_FACTOR * dt) {
            gapAt[i] = 1;
            result.gapCount++;
        }
        if (!(d > 0) || d > T.maxBridgedGapS * 1e6) {
            breakAt[i] = 1;
            result.longGapCount++;
        }
    }
    /** [a, b) split at every gap; no analysis range bridges dropped frames. */
    const splitAtGaps = (a: number, b: number): SampleRange[] => {
        const out: SampleRange[] = [];
        let s0 = a;
        for (let i = a + 1; i < b; i++) {
            if (gapAt[i]) {
                out.push({ start: s0, end: i });
                s0 = i;
            }
        }
        out.push({ start: s0, end: b });
        return out;
    };

    type Base = "invalid_flags" | "failsafe" | "disarmed" | "low" | "up";
    const base: Base[] = new Array(n);
    for (let i = 0; i < n; i++) {
        const f = flags[i];
        const t = thr[i];
        if (!Number.isFinite(f) || f < 0) {
            base[i] = "invalid_flags";
        } else if (input.failsafePhase && Number(input.failsafePhase[i]) > 0) {
            base[i] = "failsafe";
        } else if (!(f & ARM_BIT)) {
            base[i] = "disarmed";
        } else if (!Number.isFinite(t) || t < T.takeoffThrottle) {
            base[i] = "low";
        } else {
            base[i] = "up";
        }
    }

    const fs = input.sampleRateHz;
    const segs: FlightSegment[] = [];
    const push = (kind: SegmentKind, start: number, end: number, reasons: string[]) => {
        if (end <= start) {
            return;
        }
        const startTimeUs = input.timeUs[start];
        const endTimeUs = input.timeUs[end - 1];
        segs.push({ kind, start, end, startTimeUs, endTimeUs, durationS: (end - start) / fs, reasons });
    };

    for (const run of runs(base, breakAt)) {
        if (run.label === "invalid_flags") {
            push("invalid", run.start, run.end, ["mode_flags_unknown"]);
            continue;
        }
        if (run.label === "failsafe") {
            push("invalid", run.start, run.end, ["failsafe_active"]);
            continue;
        }
        if (run.label === "disarmed") {
            push("ground_or_disarmed", run.start, run.end, ["arm_box_inactive"]);
            continue;
        }
        if (run.label === "low") {
            push("armed_low_throttle", run.start, run.end, ["throttle_below_takeoff_threshold"]);
            continue;
        }
        const len = run.end - run.start;
        const trim = Math.round(T.transitionS * fs);
        if (len < Math.round(T.minFlightS * fs) || len <= 2 * trim) {
            push("flight_transition", run.start, run.end, ["throttle_up_too_short_for_flight"]);
            continue;
        }
        push("flight_transition", run.start, run.start + trim, ["takeoff_or_long_gap_edge_trimmed"]);
        classifyFlight(run.start + trim, run.end - trim);
        push("flight_transition", run.end - trim, run.end, ["landing_or_long_gap_edge_trimmed"]);
    }

    function classifyFlight(start: number, end: number) {
        result.flight.push(...splitAtGaps(start, end));
        const guard = Math.round(T.chirpGuardS * fs);
        const label: ("chirp" | "guard" | "self" | "acro")[] = new Array(end - start);
        for (let i = start; i < end; i++) {
            const f = flags![i];
            label[i - start] = f & CHIRP_BIT ? "chirp" : f & SELF_LEVEL_BITS ? "self" : "acro";
        }
        // Guard band on both sides of every CHIRP sample run.
        for (let i = 0; i < label.length; i++) {
            if (label[i] !== "chirp") {
                continue;
            }
            const prevIsChirp = i > 0 && label[i - 1] === "chirp";
            const nextIsChirp = i + 1 < label.length && label[i + 1] === "chirp";
            if (!prevIsChirp) {
                for (let k = Math.max(0, i - guard); k < i; k++) {
                    if (label[k] !== "chirp") label[k] = "guard";
                }
            }
            if (!nextIsChirp) {
                for (let k = i + 1; k <= Math.min(label.length - 1, i + guard); k++) {
                    if (label[k] !== "chirp") label[k] = "guard";
                }
            }
        }
        const local = new Uint8Array(label.length + 1);
        for (let i = 1; i < label.length; i++) local[i] = breakAt[start + i];
        for (const r of runs(label, local)) {
            const a = start + r.start;
            const b = start + r.end;
            if (r.label === "chirp") {
                push("chirp", a, b, ["boxchirp_flag_active"]);
                result.chirp.push(...splitAtGaps(a, b));
            } else if (r.label === "guard") {
                push("chirp_guard", a, b, ["chirp_guard_band"]);
            } else if (r.label === "self") {
                push("flight_self_level", a, b, ["angle_or_horizon_setpoint_is_not_stick_rate"]);
                result.spectrum.push(...splitAtGaps(a, b));
            } else {
                result.spectrum.push(...splitAtGaps(a, b));
                classifyAcro(a, b);
            }
        }
    }

    /** Acro flight: stick activity judged per window, so hover next to stick input is not stick data. */
    function classifyAcro(a: number, b: number) {
        const win = Math.max(1, Math.round(T.stickWindowS * fs));
        const active: boolean[] = [];
        const starts: number[] = [];
        for (let w = a; w < b; w += win) {
            // A short remainder joins the previous window.
            const we = b - (w + win) < win / 2 ? b : Math.min(b, w + win);
            starts.push(w);
            active.push(
                percentileAbs(input.setpoint[0], w, we, 95) >= T.stickActivityDegS ||
                    percentileAbs(input.setpoint[1], w, we, 95) >= T.stickActivityDegS,
            );
            if (we === b) break;
        }
        let i = 0;
        while (i < active.length) {
            let j = i;
            while (j + 1 < active.length && active[j + 1] === active[i]) j++;
            const s0 = starts[i];
            const s1 = j + 1 < starts.length ? starts[j + 1] : b;
            const longEnough = s1 - s0 >= Math.round(T.minStickSegmentS * fs);
            if (active[i] && longEnough) {
                push("stick", s0, s1, ["acro_chirp_free_stick_active"]);
                result.stick.push(...splitAtGaps(s0, s1));
            } else {
                push("flight_no_stick_input", s0, s1, [active[i] ? "too_short_for_stick" : "no_stick_activity"]);
            }
            i = j + 1;
        }
    }

    segs.sort((x, y) => x.start - y.start);
    result.segments = segs;
    for (const s of segs) {
        result.durationsS[s.kind] += s.durationS;
    }
    result.status = "segmented";
    if (!result.flight.length) {
        result.reasons.push("no_inferred_flight_segment");
    }
    return result;
}
