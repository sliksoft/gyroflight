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
 * The recording plan (block 7): the agreed AIR65 measurement — two complete CHIRP rounds
 * roll → pitch → yaw, roll → pitch → yaw in one flight, six activations of chirp_time_seconds 20 s,
 * 120 s of excitation — with one sweep configuration for all axes, per axis the frequencies the
 * existing data does not show (candidateDecision.ts missing), and the existing data kept apart from
 * the proposed settings. Firmware facts at betaflight 43875a55a:
 *   - debug_mode CHIRP (build/debug.c "CHIRP", index 96 in build/debug.h): debug[0] phase,
 *     debug[1] axis, debug[2] frequency in dHz (lrintf(10·fchirp)), debug[3] excitation ×1000.
 *   - blackbox_sample_rate 1/1 (cli/settings.c, BLACKBOX_RATE_ONE): the log at the PID rate
 *     (looptime × pid_process_denom), which the JIO route requires.
 *   - chirp_frequency_start_deci_hz, chirp_frequency_end_deci_hz and chirp_time_seconds are
 *     PROFILE_VALUEs of pidProfile_t (cli/settings.c 1293–1295): one value per PID profile, shared
 *     by all three axes. Only chirp_amplitude_roll/pitch/yaw are per axis.
 *   - flight/pid.c 1149–1170: the generator runs while CHIRP_MODE is on; on the first !CHIRP_MODE after
 *     an activation the axis advances roll → pitch → yaw → roll and the generator resets, also after a
 *     sweep switched off early. chirpAxis is a static that starts at roll after power-up. chirp.c:
 *     f = f0·(f1/f0)^(t/T), it stops itself after chirp_time_seconds (exc = fchirp = 0).
 *   - cli/settings.c ranges: start 1–1000 dHz, end 1–10000 dHz, chirp_time_seconds 1–255,
 *     chirp_amplitude_* 0–500 (deg/s).
 * Nothing is changed on the craft here: the plan lists settings for the user to make. Durations that
 * follow from the agreement (20 s, six activations) are firm; the lead-in, settle and pause times
 * are experimental, named as such. A second independent flight is supplementary evidence: without
 * it the cross-flight check stays unknown, which is neither a pass nor a requirement.
 */

type AxisName = "roll" | "pitch" | "yaw";
import type { MissingInterval, RouteDecision } from "@/gyrocore/engine/candidateDecision";
import type { JioSweepAdvice } from "@/gyrocore/engine/jioSweep";
import { FIRMWARE_CHIRP, JIO_SWEEP } from "@/gyrocore/engine/jioSweep";
import { MEAN_COHERENCE_BAND_HZ, MIN_MEAN_BAND_COHERENCE } from "@/gyrocore/chirp/quality";
import { LOOP_MIN_COHERENCE } from "@/gyrocore/engine/loopModel";

export const CHIRP_DEBUG_MODE = Object.freeze({ name: "CHIRP", index: 96, firmware: "betaflight 43875a55a" });

/** The agreed measurement (product agreement, block 7): not derived from the data. */
export const MEASUREMENT_AGREEMENT = Object.freeze({
    order: Object.freeze(["roll", "pitch", "yaw"] as const),
    /** Complete rounds roll → pitch → yaw in one flight. */
    rounds: 2,
    /** chirp_time_seconds per activation. */
    sweepS: 20,
    activations: 6,
    activeExcitationS: 120,
    /** A second independent flight: supplementary evidence, not a step the experimental flow requires. */
    secondFlight: "supplementary" as const,
});

/**
 * Measurement codes that are supplementary evidence under the agreement: a second independent
 * flight. Absent, the cross-flight check stays unknown; it is not a step the experimental flow requires.
 */
export const SUPPLEMENTARY_MEASUREMENT = /_repeat_flight_for_reproducibility$/;

/** Experimental timing around each sweep (s): not firmware facts. */
export const RECORDING_TIMING = Object.freeze({
    /** Steady hover before switching CHIRP_MODE on. */
    leadInS: 2,
    /** Keep the mode on after the generator stopped (the JIO record's settle tail is 0.5 s). */
    settleS: JIO_SWEEP.tailS,
    /** CHIRP_MODE off before the next activation (separates the segments: debug[1] = −1). */
    pauseS: 1,
});

/** dHz with Hz beside it: "1900 dHz (190.0 Hz)". */
export function deciHzText(dHz: number | null): string {
    return dHz === null ? "unknown" : `${dHz} dHz (${(dHz / 10).toFixed(1)} Hz)`;
}

export interface PlanSetting {
    /** The exact CLI name. */
    name: string;
    /** As logged in the existing data (header); null: not logged. */
    current: string | number | null;
    proposed: string | number;
    unit: string;
    /** Both values in Hz for a dHz setting. */
    hz: { current: number | null; proposed: number } | null;
    changed: boolean;
    basis: string;
}

export interface AxisRecordingNeed {
    axis: AxisName;
    /** The decision that decides the axis: route, status and the first failing rule. */
    trigger: {
        route: "primary" | "jio";
        status: string;
        rule: string | null;
        value: number | string | null;
        threshold: string | null;
    } | null;
    /**
     * "record": the data lacks information (the missing frequencies below); "search_limit": the plant
     * is usable and more data does not help; "candidate": a candidate or no change, nothing missing.
     */
    kind: "record" | "search_limit" | "candidate";
    /** Per route, the frequencies the existing data does not show (candidateDecision missing). */
    missing: { route: "primary" | "jio"; intervals: MissingInterval[] }[];
    /** The planner bands this axis's data must cover (primary and JIO plans). */
    plannerBandsHz: [number, number][];
    note: string;
}

export interface RecordingPlan {
    /** Some axis lacks information a new recording can give. */
    recordingNeeded: boolean;
    axes: AxisRecordingNeed[];
    /** What the imported data already contains: kept apart from the proposed settings. */
    existing: {
        settings: PlanSetting[];
        rounds: {
            required: number;
            /** Complete rounds flown: the smallest number of complete sweeps over the three axes. */
            complete: number;
            /** Complete rounds whose sweeps were also used (not excluded). */
            usable: number;
            perAxis: { axis: AxisName; present: number; complete: number; usableComplete: number }[];
            /** complete_not_usable: both rounds flown, but a sweep was excluded (not usable). */
            state: "complete" | "complete_not_usable" | "incomplete" | "none";
        };
        secondFlight: {
            flights: number;
            perAxis: { axis: AxisName; consistency: "unknown" | "consistent" | "inconsistent" }[];
            /** "unknown" when no comparable flight was imported: not passed, and not required. */
            state: "unknown" | "consistent" | "inconsistent";
        };
    };
    /** The one sweep configuration for the next flight; null when no axis needs a recording. */
    sweep: {
        scope: "pid_profile_shared_by_all_axes";
        settings: PlanSetting[];
        amplitudes: PlanSetting[];
        cli: string[];
        coverage: { axis: AxisName; plannerBandHz: [number, number] | null; covered: boolean | null; basis: string }[];
        /** 10·log10 of the excitation per octave against the existing sweep (same T, amplitude unchanged). */
        excitationGainDb: number | null;
        /** Firmware range checks of the combined values; every entry must be "ok:…". */
        firmwareChecks: string[];
        valid: boolean;
    } | null;
    procedure: string[];
    timing: {
        sweepS: number;
        activations: number;
        activeExcitationS: number;
        perActivationS: number;
        sequenceS: number;
        firm: string[];
        experimental: string[];
    };
    secondFlight: string;
    completionChecks: string[];
    notChanged: string[];
    note: string;
}

const AXES = MEASUREMENT_AGREEMENT.order;

/** Which route decides the axis: a found candidate needs nothing; a usable plant whose search failed says so. */
function decisive(d: { primary: RouteDecision | null; jio: RouteDecision | null }): RouteDecision | null {
    const routes = [d.primary, d.jio].filter((r): r is RouteDecision => !!r);
    const found = routes.find((r) => r.status === "candidate_found" || r.status === "no_change_needed");
    if (found) return found;
    const searchFailed = routes.find(
        (r) =>
            r.status === "search_limit_max_step" ||
            r.status === "targets_not_reachable" ||
            r.status === "search_constrained_by_verified_tune",
    );
    if (searchFailed) return searchFailed;
    return d.primary ?? d.jio;
}

function causeText(r: RouteDecision): string {
    const fc = r.firstCause;
    if (!fc) return `${r.route} route: ${r.status}`;
    const v = fc.value === null ? "unknown" : typeof fc.value === "number" ? +fc.value.toFixed(3) : fc.value;
    return `${r.route} route: ${r.status} — ${fc.rule} = ${v} ${fc.unit}; required: ${fc.threshold}; ${fc.consequence}`;
}

function axisNeed(
    axis: AxisName,
    d: { primary: RouteDecision | null; jio: RouteDecision | null } | undefined,
    bands: [number, number][],
): AxisRecordingNeed {
    const r = d ? decisive(d) : null;
    const missing = d
        ? ([d.primary, d.jio].filter((x): x is RouteDecision => !!x && x.missing.length > 0) as RouteDecision[]).map(
              (x) => ({ route: x.route, intervals: x.missing }),
          )
        : [];
    const trigger = r
        ? {
              route: r.route,
              status: r.status,
              rule: r.firstCause?.rule ?? null,
              value: r.firstCause?.value ?? null,
              threshold: r.firstCause?.threshold ?? null,
          }
        : null;
    if (!r)
        return {
            axis,
            trigger,
            kind: "record",
            missing,
            plannerBandsHz: bands,
            note: `No decision for ${axis} in the existing data (no sweep of this axis analysed): the next flight's two rounds measure it.`,
        };
    if (r.status === "candidate_found" || r.status === "no_change_needed")
        return {
            axis,
            trigger,
            kind: "candidate",
            missing,
            plannerBandsHz: bands,
            note: `${axis}: ${r.status} on the ${r.route} route; the existing data is enough for that decision.`,
        };
    if (r.status === "search_constrained_by_verified_tune")
        return {
            axis,
            trigger,
            kind: "search_limit",
            missing,
            plannerBandsHz: bands,
            note: `${axis}: the bound Verified Tune's gain-change flight also moved feedforward (${r.firstCause?.value ?? "unknown"}), so the search finds no point on its segment. A new CHIRP sweep does not lift this; a gain-change flight with feedforward unchanged does (release route: required_measurement:gain_change_flight_with_feedforward_unchanged).`,
        };
    if (r.status === "search_limit_max_step" || r.status === "targets_not_reachable")
        return {
            axis,
            trigger,
            kind: "search_limit",
            missing,
            plannerBandsHz: bands,
            note:
                r.status === "search_limit_max_step"
                    ? `${axis}: the ${r.route} plant is usable (${r.candidatesUsable} of ${r.candidatesTried} candidates have in-band margins) and the best candidate lies on the ±30 % step edge. The current search found no suitable candidate within its limits (one step of at most ±30 %); new data can still change this assessment.`
                    : `${axis}: the ${r.route} plant is usable and no candidate in the search grid meets the targets. The current search found no suitable candidate within its limits; new data can still change this assessment.`,
        };
    return {
        axis,
        trigger,
        kind: "record",
        missing,
        plannerBandsHz: bands,
        note: `${causeText(r)}.`,
    };
}

/** The logged debug_mode with its name when it is CHIRP ("96 (CHIRP)"). */
const debugModeText = (v: string | null) =>
    v === String(CHIRP_DEBUG_MODE.index) ? `${v} (${CHIRP_DEBUG_MODE.name})` : v;

const num = (s: string | null) => (s === null || s.trim() === "" || !Number.isFinite(Number(s)) ? null : Number(s));

/**
 * The one sweep configuration: start, end and time are shared by all axes (pidProfile_t), so the
 * axes' band-matched targets (jioSweep sweepAdviceFor target) are combined — the lowest start, the
 * highest end, rounded up to FIRMWARE_CHIRP.endRoundHz — and the end never drops below any axis's
 * planner band top. chirp_time_seconds is the agreed 20 s; amplitudes stay as logged.
 */
function sharedSweep(
    h: Record<string, string>,
    advice: Partial<Record<AxisName, JioSweepAdvice | null>>,
    bands: Record<AxisName, [number, number][]>,
): NonNullable<RecordingPlan["sweep"]> {
    const f0 = num(h.chirp_frequency_start_deci_hz ?? null);
    const f1 = num(h.chirp_frequency_end_deci_hz ?? null);
    const T = num(h.chirp_time_seconds ?? null);
    const round = 10 * FIRMWARE_CHIRP.endRoundHz;
    const starts: number[] = [];
    const ends: number[] = [];
    const coverage: NonNullable<RecordingPlan["sweep"]>["coverage"] = [];
    const basis: string[] = [];
    for (const axis of AXES) {
        const adv = advice[axis] ?? null;
        const b = bands[axis];
        const top = b.length ? Math.max(...b.map((x) => x[1])) : null;
        const lo = b.length ? Math.min(...b.map((x) => x[0])) : null;
        if (adv) {
            starts.push(adv.target.chirp_frequency_start_deci_hz);
            ends.push(adv.target.chirp_frequency_end_deci_hz);
            basis.push(
                `${axis}: ${deciHzText(adv.target.chirp_frequency_start_deci_hz)}–${deciHzText(adv.target.chirp_frequency_end_deci_hz)}`,
            );
        } else basis.push(`${axis}: no band-matched advice (no supported JIO band); planner band used`);
        if (top !== null) ends.push(Math.ceil((10 * top) / round) * round);
        // The start never lies above a planner band's low end (rounded down to whole Hz); without
        // advice it is at most the analysis's lowest frequency.
        if (lo !== null) starts.push(10 * Math.floor(lo));
        if (lo !== null && !adv) starts.push(10 * JIO_SWEEP.lowestHz);
    }
    const lowest = 10 * JIO_SWEEP.lowestHz;
    const wantStart = starts.length ? Math.min(...starts) : (f0 ?? lowest);
    const wantEnd = ends.length ? Math.max(...ends) : (f1 ?? FIRMWARE_CHIRP.endDeciHz[1]);
    const start = Math.min(Math.max(wantStart, FIRMWARE_CHIRP.startDeciHz[0]), FIRMWARE_CHIRP.startDeciHz[1]);
    const end = Math.min(Math.max(wantEnd, 2 * start), FIRMWARE_CHIRP.endDeciHz[1]);
    const clamped = start !== wantStart || end < wantEnd;
    const sweepS = MEASUREMENT_AGREEMENT.sweepS;
    const firmwareChecks = [
        start >= FIRMWARE_CHIRP.startDeciHz[0] && start <= FIRMWARE_CHIRP.startDeciHz[1]
            ? `ok:chirp_frequency_start_deci_hz ${start} in ${FIRMWARE_CHIRP.startDeciHz.join("–")}`
            : `out_of_range:chirp_frequency_start_deci_hz ${start}`,
        end >= FIRMWARE_CHIRP.endDeciHz[0] && end <= FIRMWARE_CHIRP.endDeciHz[1]
            ? `ok:chirp_frequency_end_deci_hz ${end} in ${FIRMWARE_CHIRP.endDeciHz.join("–")}`
            : `out_of_range:chirp_frequency_end_deci_hz ${end}`,
        end > start ? `ok:end ${end} above start ${start}` : `end_not_above_start:${end}<=${start}`,
        sweepS >= FIRMWARE_CHIRP.timeS[0] && sweepS <= FIRMWARE_CHIRP.timeS[1]
            ? `ok:chirp_time_seconds ${sweepS} in ${FIRMWARE_CHIRP.timeS.join("–")}`
            : `out_of_range:chirp_time_seconds ${sweepS}`,
    ];
    for (const axis of AXES) {
        const b = bands[axis];
        if (!b.length) {
            coverage.push({ axis, plannerBandHz: null, covered: null, basis: "planner band unknown for this axis" });
            continue;
        }
        const need: [number, number] = [Math.min(...b.map((x) => x[0])), Math.max(...b.map((x) => x[1]))];
        const covered = start <= 10 * need[0] + 1e-9 && end >= 10 * need[1] - 1e-9;
        coverage.push({
            axis,
            plannerBandHz: need,
            covered,
            basis: covered
                ? `${(start / 10).toFixed(1)}–${(end / 10).toFixed(1)} Hz covers ${need[0].toFixed(1)}–${need[1].toFixed(1)} Hz`
                : `${(start / 10).toFixed(1)}–${(end / 10).toFixed(1)} Hz does not cover ${need[0].toFixed(1)}–${need[1].toFixed(1)} Hz (${clamped ? "cut by the firmware range" : "not reached by the combined range"})`,
        });
    }
    const gain =
        f0 !== null && f1 !== null && T !== null && f1 > f0 && T > 0
            ? 10 * Math.log10((Math.log(f1 / f0) * sweepS) / (Math.log(end / start) * T))
            : null;
    const setting = (name: string, cur: number | null, prop: number, dHz: boolean, why: string): PlanSetting => ({
        name,
        current: cur,
        proposed: prop,
        unit: dHz ? "dHz" : "s",
        hz: dHz ? { current: cur === null ? null : cur / 10, proposed: prop / 10 } : null,
        changed: cur !== prop,
        basis: why,
    });
    const settings: PlanSetting[] = [
        {
            name: "debug_mode",
            current: debugModeText(h.debug_mode ?? null),
            proposed: CHIRP_DEBUG_MODE.name,
            unit: "",
            hz: null,
            changed: (h.debug_mode ?? null) !== String(CHIRP_DEBUG_MODE.index),
            basis: `DEBUG_CHIRP (index ${CHIRP_DEBUG_MODE.index}): debug[1] axis, debug[2] frequency, debug[3] excitation`,
        },
        {
            name: "blackbox_sample_rate",
            current: h["P interval"] ?? null,
            proposed: "1/1",
            unit: "",
            hz: null,
            changed: !["1", "1/1"].includes(h["P interval"] ?? "1/1"),
            basis: "log at the PID rate (JIO: log rate within 2 % of the PID rate)",
        },
        setting(
            "chirp_frequency_start_deci_hz",
            f0,
            start,
            true,
            `lowest axis target; analysis starts at ${JIO_SWEEP.lowestHz} Hz (${basis.join("; ")})`,
        ),
        setting(
            "chirp_frequency_end_deci_hz",
            f1,
            end,
            true,
            `highest axis target, at least every planner band top, rounded up to ${FIRMWARE_CHIRP.endRoundHz} Hz`,
        ),
        setting("chirp_time_seconds", T, sweepS, false, "the agreed 20 s per activation (6 × 20 s = 120 s excitation)"),
    ];
    const amplitudes: PlanSetting[] = AXES.map((axis) => {
        const a = num(h[`chirp_amplitude_${axis}`] ?? null);
        return {
            name: `chirp_amplitude_${axis}`,
            current: a,
            proposed: a ?? "unchanged",
            unit: "deg/s",
            hz: null,
            changed: false,
            basis: "not changed by the app; raising it is your decision and is not assumed to fix the coherence",
        };
    });
    const cli = [
        `set debug_mode = ${CHIRP_DEBUG_MODE.name}`,
        "set blackbox_sample_rate = 1/1",
        `set chirp_frequency_start_deci_hz = ${start}`,
        `set chirp_frequency_end_deci_hz = ${end}`,
        `set chirp_time_seconds = ${sweepS}`,
        "save",
    ];
    return {
        scope: "pid_profile_shared_by_all_axes",
        settings,
        amplitudes,
        cli,
        coverage,
        excitationGainDb: gain,
        firmwareChecks,
        valid: firmwareChecks.every((c) => c.startsWith("ok:")),
    };
}

export function recordingPlan(o: {
    decisions: Partial<Record<AxisName, { primary: RouteDecision | null; jio: RouteDecision | null }>>;
    headers: Record<string, string>;
    advice: Partial<Record<AxisName, JioSweepAdvice | null>>;
    /** The planner bands per axis (primary and JIO measurement plans). */
    plannerBandsHz: Partial<Record<AxisName, ([number, number] | null)[]>>;
    /** Sweeps of the imported flight per axis (JIO analysis). */
    sweeps: Partial<Record<AxisName, { present: number; complete: number; usableComplete: number }>>;
    /** Comparable independent flights per axis (JIO cross-flight). */
    crossFlight: Partial<Record<AxisName, { flights: number; consistency: "unknown" | "consistent" | "inconsistent" }>>;
}): RecordingPlan {
    const h = o.headers;
    const bands = Object.fromEntries(
        AXES.map((a) => [a, (o.plannerBandsHz[a] ?? []).filter((b): b is [number, number] => !!b)]),
    ) as Record<AxisName, [number, number][]>;
    const axes = AXES.map((a) => axisNeed(a, o.decisions[a], bands[a]));
    const recordingNeeded = axes.some((a) => a.kind === "record");

    const perAxis = AXES.map((axis) => ({
        axis,
        present: o.sweeps[axis]?.present ?? 0,
        complete: o.sweeps[axis]?.complete ?? 0,
        usableComplete: o.sweeps[axis]?.usableComplete ?? 0,
    }));
    const required = MEASUREMENT_AGREEMENT.rounds;
    const complete = Math.min(required, ...perAxis.map((p) => p.complete));
    const usable = Math.min(required, ...perAxis.map((p) => p.usableComplete));
    const anySweep = perAxis.some((p) => p.present > 0);
    const cross = AXES.map((axis) => ({ axis, consistency: o.crossFlight[axis]?.consistency ?? ("unknown" as const) }));
    const flights = Math.max(0, ...AXES.map((a) => o.crossFlight[a]?.flights ?? 0));
    const crossState = cross.some((c) => c.consistency === "inconsistent")
        ? "inconsistent"
        : flights > 0 && cross.every((c) => c.consistency === "consistent")
          ? "consistent"
          : "unknown";
    const logged = (name: string, unit: string, dHz = false): PlanSetting => {
        const v = h[name] ?? null;
        const n = num(v);
        return {
            name,
            current: v,
            proposed: v ?? "unknown",
            unit,
            hz: dHz && n !== null ? { current: n / 10, proposed: n / 10 } : null,
            changed: false,
            basis: "as logged in the imported flight",
        };
    };
    const existing: RecordingPlan["existing"] = {
        settings: [
            { ...logged("debug_mode", ""), current: debugModeText(h.debug_mode ?? null) },
            { ...logged("P interval", ""), name: "blackbox_sample_rate (P interval)" },
            logged("chirp_frequency_start_deci_hz", "dHz", true),
            logged("chirp_frequency_end_deci_hz", "dHz", true),
            logged("chirp_time_seconds", "s"),
            ...AXES.map((a) => logged(`chirp_amplitude_${a}`, "deg/s")),
        ],
        rounds: {
            required,
            complete,
            usable,
            perAxis,
            state: !anySweep
                ? "none"
                : usable >= required
                  ? "complete"
                  : complete >= required
                    ? "complete_not_usable"
                    : "incomplete",
        },
        secondFlight: { flights, perAxis: cross, state: crossState },
    };

    const sweep = recordingNeeded ? sharedSweep(h, o.advice, bands) : null;
    const perActivation =
        RECORDING_TIMING.leadInS + MEASUREMENT_AGREEMENT.sweepS + RECORDING_TIMING.settleS + RECORDING_TIMING.pauseS;
    const sequence = MEASUREMENT_AGREEMENT.activations * perActivation;
    const procedure = sweep
        ? [
              `In the CLI, in the active PID profile (the chirp frequencies and time are shared by all axes), enter: ${sweep.cli.join(" · ")}. The app writes none of them. save reboots the flight controller; after a reboot the first activation is roll.`,
              `Arm and take off; hover steadily for at least ${RECORDING_TIMING.leadInS} s before each activation; keep the sticks still during each sweep.`,
              `Round 1: switch CHIRP_MODE on and leave it on for the whole ${MEASUREMENT_AGREEMENT.sweepS} s sweep (the generator stops itself), ${RECORDING_TIMING.settleS} s longer, then off; wait at least ${RECORDING_TIMING.pauseS} s. Each switch-off advances the axis: roll, then pitch, then yaw.`,
              `Round 2: the same three activations again: roll, pitch, yaw. Together ${MEASUREMENT_AGREEMENT.activations} complete activations, ${MEASUREMENT_AGREEMENT.activeExcitationS} s of excitation.`,
              `Switched off early: the axis advances anyway (pid.c) and that sweep is incomplete. Continue the cycle: the same axis comes back after three activations. The app reads the axis of every sweep from debug[1], so extra sweeps do no harm.`,
              `Land, import the log and Calculate. The app counts the complete rounds and decides per axis.`,
          ]
        : [];
    return {
        recordingNeeded,
        axes,
        existing,
        sweep,
        procedure,
        timing: {
            sweepS: MEASUREMENT_AGREEMENT.sweepS,
            activations: MEASUREMENT_AGREEMENT.activations,
            activeExcitationS: MEASUREMENT_AGREEMENT.activeExcitationS,
            perActivationS: perActivation,
            sequenceS: sequence,
            firm: [
                `${MEASUREMENT_AGREEMENT.activations} activations × chirp_time_seconds ${MEASUREMENT_AGREEMENT.sweepS} s = ${MEASUREMENT_AGREEMENT.activeExcitationS} s of excitation (2 rounds × 3 axes)`,
            ],
            experimental: [
                `lead-in ${RECORDING_TIMING.leadInS} s, settle ${RECORDING_TIMING.settleS} s and pause ${RECORDING_TIMING.pauseS} s per activation: about ${Math.round(sequence)} s of activation sequence`,
                `take-off, climb and landing come on top; whether that fits one AIR65 pack is not known to the app`,
            ],
        },
        secondFlight: `Optional: a second, independent flight with the same settings and the same two rounds is supplementary evidence (reproducibility between flights). Without it the cross-flight check stays unknown; that is not a pass, and it does not withhold an experimental proposal. A second flight that disagrees does exclude the JIO candidate.`,
        completionChecks: [
            `Blocking (the engine excludes the data): debug_mode CHIRP; setpoint, axisP/I/F, debug[1] and debug[3] logged, axisD when D > 0 (jio_channel_missing); log rate equal to the PID rate within 2 % (jio_log_rate_not_pid_rate); debug[2] against the firmware law when logged (debug2_frequency_mismatch).`,
            `Blocking for the candidate: primary quality gate mean γ² over ${MEAN_COHERENCE_BAND_HZ[0]}–${MEAN_COHERENCE_BAND_HZ[1]} Hz ≥ ${MIN_MEAN_BAND_COHERENCE} (low_coherence; waived for the experimental route only when every other gate passed and the decision band drops no bin for coherence, support or plant status); no unidentified bin inside the decision band (decision_band_gaps); the identified band (bins with γ² ≥ ${LOOP_MIN_COHERENCE}) reaches the planner band top (gain_margin_shown_by_band, sensitivity_peak_shown_by_band); the two sweeps of an axis that disagree (repeat z > ${JIO_SWEEP.repeatZThreshold}, experimental threshold) exclude the JIO candidate.`,
            `Rounds: ${required} complete rounds give each axis two sweeps for the stationarity check. Fewer leave stationarity unknown, named as a limitation, not a block; a sweep below ${Math.round(JIO_SWEEP.completeSweepFraction * 100)} % of chirp_time_seconds is read in and marked incomplete (sweep_incomplete).`,
            `Second flight: supplementary; absent = unknown (not passed, not required); a disagreeing one excludes the JIO candidate.`,
        ],
        notChanged: [
            "flight mode, anti-gravity, TPA, I-term relax, filters and PIDs: not changed (a change makes the sweeps incomparable as repeats)",
            "chirp_amplitude_roll / pitch / yaw: not changed by the app",
        ],
        note: "Existing data and proposed settings are separate: the existing values are what the imported flight logged. A recording with these settings is no guarantee of a tuning proposal: the new data must pass the checks above.",
    };
}
