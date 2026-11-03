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
 * Recording instruction per axis (block 6), generated from the check that stopped the candidate
 * (candidateDecision.ts). Firmware facts at betaflight 43875a55a:
 *   - debug_mode CHIRP (build/debug.c "CHIRP", index 96 in build/debug.h): debug[0] phase,
 *     debug[1] axis, debug[2] frequency in dHz (lrintf(10·fchirp)), debug[3] excitation ×1000.
 *   - blackbox_sample_rate 1/1 (cli/settings.c, BLACKBOX_RATE_ONE): the log at the PID rate
 *     (looptime × pid_process_denom), which the JIO route requires.
 *   - flight/pid.c 1149–1170: the generator runs while CHIRP_MODE is on; on the first !CHIRP_MODE after
 *     an activation the axis advances roll → pitch → yaw → roll and the generator resets. chirp.c:
 *     f = f0·(f1/f0)^(t/T), it stops itself after chirp_time_seconds (exc = fchirp = 0).
 *   - cli/settings.c ranges: chirp_frequency_start_deci_hz 1–1000, chirp_frequency_end_deci_hz
 *     1–10000, chirp_time_seconds 1–255, chirp_amplitude_* 0–500 (deg/s).
 * Nothing is changed on the craft here: the instruction lists settings for the user to make.
 * Durations that follow from the sweep design (T, activations) are firm; the lead-in, settle and
 * pause times and the repeat counts are experimental requirements, named as such.
 */

type AxisName = "roll" | "pitch" | "yaw";
import type { RouteDecision } from "@/gyrocore/engine/candidateDecision";
import type { JioSweepAdvice } from "@/gyrocore/engine/jioSweep";
import { JIO_SWEEP } from "@/gyrocore/engine/jioSweep";
import { MEAN_COHERENCE_BAND_HZ, MIN_MEAN_BAND_COHERENCE } from "@/gyrocore/chirp/quality";
import { LOOP_MIN_COHERENCE } from "@/gyrocore/engine/loopModel";

export const CHIRP_DEBUG_MODE = Object.freeze({ name: "CHIRP", index: 96, firmware: "betaflight 43875a55a" });

/** Experimental timing around each sweep (s): not firmware facts. */
export const RECORDING_TIMING = Object.freeze({
    /** Steady hover before switching CHIRP_MODE on. */
    leadInS: 2,
    /** Keep the mode on after the generator stopped (the JIO record's settle tail is 0.5 s). */
    settleS: JIO_SWEEP.tailS,
    /** CHIRP_MODE off before the next activation (separates the segments: debug[1] = −1). */
    pauseS: 1,
    /** Complete sweeps per axis in one flight (stationarity check; experimental). */
    sweepsPerAxisPerFlight: 2,
    /** Independent flights with the same settings (reproducibility; experimental). */
    flights: 2,
});

export interface InstructionSetting {
    name: string;
    current: string | number | null;
    required: string | number;
    unit: string;
    changed: boolean;
    basis: string;
}

export interface RecordingInstruction {
    axis: AxisName;
    /** The decision that triggered it: route, status and the failing rule. */
    trigger: {
        route: "primary" | "jio";
        status: string;
        rule: string | null;
        value: number | string | null;
        threshold: string | null;
    };
    /** "record": new data needed; "none_search_limit": the plant is usable, more data does not help. */
    kind: "record" | "none_search_limit";
    settings: InstructionSetting[];
    procedure: string[];
    timing: {
        sweepS: number;
        activationsPerFlight: number;
        perActivationS: number;
        chirpTimePerFlightS: number;
        flights: number;
        totalChirpTimeS: number;
        firm: string[];
        experimental: string[];
    } | null;
    completionChecks: string[];
    notChanged: string[];
    note: string;
}

const AXES: readonly AxisName[] = ["roll", "pitch", "yaw"];

function header(h: Record<string, string>, k: string): string | null {
    return h[k] ?? null;
}

/** Which route decides the axis's instruction: a found candidate needs none; a usable plant whose search failed says so. */
function decisive(d: { primary: RouteDecision | null; jio: RouteDecision | null }): RouteDecision | null {
    const routes = [d.primary, d.jio].filter((r): r is RouteDecision => !!r);
    if (routes.some((r) => r.status === "candidate_found" || r.status === "no_change_needed")) return null;
    const searchFailed = routes.find(
        (r) => r.status === "search_limit_max_step" || r.status === "targets_not_reachable",
    );
    if (searchFailed) return searchFailed;
    return d.primary ?? d.jio;
}

export function recordingInstructions(o: {
    decisions: Partial<Record<AxisName, { primary: RouteDecision | null; jio: RouteDecision | null }>>;
    headers: Record<string, string>;
    advice: Partial<Record<AxisName, JioSweepAdvice | null>>;
}): RecordingInstruction[] {
    const h = o.headers;
    const out: RecordingInstruction[] = [];
    for (const axis of AXES) {
        const d = o.decisions[axis];
        if (!d) continue;
        const r = decisive(d);
        if (!r) continue;
        const fc = r.firstCause;
        const trigger = {
            route: r.route,
            status: r.status,
            rule: fc?.rule ?? null,
            value: fc?.value ?? null,
            threshold: fc?.threshold ?? null,
        };
        if (r.status === "search_limit_max_step" || r.status === "targets_not_reachable") {
            out.push({
                axis,
                trigger,
                kind: "none_search_limit",
                settings: [],
                procedure: [],
                timing: null,
                completionChecks: [],
                notChanged: [],
                note:
                    r.status === "search_limit_max_step"
                        ? `No new recording requested for ${axis}: the ${r.route} plant is usable (${r.candidatesUsable} of ${r.candidatesTried} candidates have in-band margins) and the best candidate lies on the ±30 % step edge. More data does not lift this; a change larger than one step is outside this search.`
                        : `No new recording requested for ${axis}: the ${r.route} plant is usable and no candidate in the search grid meets the targets.`,
            });
            continue;
        }
        const adv = o.advice[axis] ?? null;
        const f0 = Number(header(h, "chirp_frequency_start_deci_hz"));
        const f1 = Number(header(h, "chirp_frequency_end_deci_hz"));
        const T = Number(header(h, "chirp_time_seconds"));
        const amp = header(h, `chirp_amplitude_${axis}`);
        const sg = adv?.suggested ?? null;
        const newF0 = sg?.chirp_frequency_start_deci_hz ?? (Number.isFinite(f0) ? f0 : null);
        const newF1 = sg?.chirp_frequency_end_deci_hz ?? (Number.isFinite(f1) ? f1 : null);
        const newT = sg?.chirp_time_seconds ?? (Number.isFinite(T) ? T : null);
        const debugMode = header(h, "debug_mode");
        const pInterval = header(h, "P interval");
        const settings: InstructionSetting[] = [
            {
                name: "debug_mode",
                current: debugMode,
                required: `${CHIRP_DEBUG_MODE.name} (index ${CHIRP_DEBUG_MODE.index})`,
                unit: "",
                changed: debugMode !== String(CHIRP_DEBUG_MODE.index),
                basis: "DEBUG_CHIRP channels debug[1..3] (build/debug.h at 43875a55a)",
            },
            {
                name: "blackbox_sample_rate",
                current: pInterval === null ? null : `P interval ${pInterval}`,
                required: "1/1 (log at the PID rate)",
                unit: "",
                changed: pInterval !== null && pInterval !== "1" && pInterval !== "1/1",
                basis: "JIO needs the log on the PID grid (jioSweep maxRateMismatch 2 %)",
            },
            {
                name: "chirp_frequency_start_deci_hz",
                current: Number.isFinite(f0) ? f0 : null,
                required: newF0 ?? "unknown",
                unit: "dHz (0.1 Hz)",
                changed: newF0 !== null && newF0 !== f0,
                basis: sg ? "band-matched sweep advice (start ≥ 2 Hz analysed)" : "unchanged",
            },
            {
                name: "chirp_frequency_end_deci_hz",
                current: Number.isFinite(f1) ? f1 : null,
                required: newF1 ?? "unknown",
                unit: "dHz (0.1 Hz)",
                changed: newF1 !== null && newF1 !== f1,
                basis: sg
                    ? `band-matched advice: ${adv!.basis.filter((b) => /^(end_|tuning_band|supported_band)/.test(b)).join(", ")}`
                    : "unchanged (no advice for this axis)",
            },
            {
                name: "chirp_time_seconds",
                current: Number.isFinite(T) ? T : null,
                required: newT ?? "unknown",
                unit: "s",
                changed: newT !== null && newT !== T,
                basis: "same duration (more excitation per octave from the narrower band, not a longer sweep)",
            },
            {
                name: `chirp_amplitude_${axis}`,
                current: amp,
                required: amp ?? "unchanged",
                unit: "deg/s",
                changed: false,
                basis: "not changed by the app; raising it is your decision and is not assumed to fix the coherence",
            },
        ];
        const sweepS = newT ?? (Number.isFinite(T) ? T : 0);
        const activations = AXES.length * RECORDING_TIMING.sweepsPerAxisPerFlight;
        const perActivation = RECORDING_TIMING.leadInS + sweepS + RECORDING_TIMING.settleS + RECORDING_TIMING.pauseS;
        const perFlight = activations * perActivation;
        const procedure = [
            `Set the settings above in the CLI yourself (the app writes none of them); debug_mode = CHIRP and blackbox_sample_rate = 1/1 on every flight.`,
            `Arm and take off; hover steadily for at least ${RECORDING_TIMING.leadInS} s before the first activation; keep the sticks still during each sweep.`,
            `Switch CHIRP_MODE on and keep it on for the whole sweep (${sweepS} s); the generator stops itself; keep the mode on ${RECORDING_TIMING.settleS} s longer, then switch it off.`,
            `Wait at least ${RECORDING_TIMING.pauseS} s with CHIRP_MODE off. Each switch-off advances the axis roll → pitch → yaw → roll (pid.c): the first activation after power-up is roll.`,
            `Repeat until every axis has ${RECORDING_TIMING.sweepsPerAxisPerFlight} complete sweeps in this flight (${activations} activations: roll, pitch, yaw, roll, pitch, yaw). A sweep switched off early is incomplete and does not count.`,
            `Fly a second, independent flight with exactly the same settings (reproducibility between flights).`,
            `Import both logs into Autotune and Calculate; the checks below decide whether the axis is complete.`,
        ];
        const completionChecks = [
            `debug_mode CHIRP and the axisP/I/D/F, debug[1..3] fields present (jioSweep jio_channel_missing).`,
            `Log rate equals the PID rate within 2 % (jio_log_rate_not_pid_rate).`,
            `Each sweep excited for ≥ ${Math.round(JIO_SWEEP.completeSweepFraction * 100)} % of chirp_time_seconds (sweep_incomplete) and debug[2] follows the firmware law (debug2_frequency_mismatch).`,
            `Primary quality gate: mean γ² over ${MEAN_COHERENCE_BAND_HZ[0]}–${MEAN_COHERENCE_BAND_HZ[1]} Hz ≥ ${MIN_MEAN_BAND_COHERENCE} (chirp/quality.ts low_coherence).`,
            `Identified band (bins with γ² ≥ ${LOOP_MIN_COHERENCE}) reaches the planner band top, so the phase crossing and the |S| peak lie inside it (gain_margin_shown_by_band, sensitivity_peak_shown_by_band).`,
            `${RECORDING_TIMING.sweepsPerAxisPerFlight} complete sweeps of the axis agree within the flight (repeat z ≤ ${JIO_SWEEP.repeatZThreshold}, experimental) and the second flight agrees (experimental).`,
        ];
        out.push({
            axis,
            trigger,
            kind: "record",
            settings,
            procedure,
            timing: {
                sweepS,
                activationsPerFlight: activations,
                perActivationS: perActivation,
                chirpTimePerFlightS: perFlight,
                flights: RECORDING_TIMING.flights,
                totalChirpTimeS: perFlight * RECORDING_TIMING.flights,
                firm: [
                    `chirp_time_seconds ${sweepS} s per sweep (generator)`,
                    `${activations} activations per flight (3 axes × ${RECORDING_TIMING.sweepsPerAxisPerFlight}; the axis advances on every switch-off)`,
                ],
                experimental: [
                    `lead-in ${RECORDING_TIMING.leadInS} s, settle ${RECORDING_TIMING.settleS} s, pause ${RECORDING_TIMING.pauseS} s per activation`,
                    `${RECORDING_TIMING.sweepsPerAxisPerFlight} sweeps per axis per flight and ${RECORDING_TIMING.flights} flights (repeat checks are experimental)`,
                    `take-off, climb and landing come on top; whether ${Math.round(perFlight)} s of CHIRP fits one AIR65 pack is not known to the app: if not, split the flights, but keep both sweeps of an axis in the same flight`,
                ],
            },
            completionChecks,
            notChanged: [
                "flight mode, anti-gravity, TPA, I-term relax, filters and PIDs: not changed (a change makes the logs incomparable as repeats)",
                `chirp_amplitude_${axis}: not changed by the app`,
            ],
            note: `Triggered by the ${r.route} route: ${r.status}${fc ? ` — ${fc.rule} = ${fc.value === null ? "unknown" : fc.value} ${fc.unit} (${fc.threshold})` : ""}. A recording of this design is no guarantee of a proposal: the new data must pass these checks.`,
        });
    }
    return out;
}
