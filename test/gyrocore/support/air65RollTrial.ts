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
 * The pre-registered rules of the AIR65 roll trial P56 → P45 (PROEFPLAN.md §4–§5, preregistration v2),
 * pure so that CI tests them: which logged settings must hold, the exact change in A and B, the
 * flight mode during the roll sweep, which bins a comparison tested, and the peak conclusion.
 *
 * Stricter than the app on purpose: the app's Verified Tune refuses non-PID changes only for the
 * keys of loggedAbsoluteValues (no CHIRP, rate, angle, I-relax or debug keys). A log that fails here
 * is NONE for the trial, whatever the app shows.
 */

import type { AxisBinTrace, AxisComparison } from "../../../src/gyrocore/releaseGate/verifiedTune";

export const TRIAL = {
    baseline: { sha256: "5654476ad783f1fa241d9fe6e8ae5f978c3d5cef6b417d0d93a59e26ed2b9894", logIndex: 0 },
    repeat: { sha256: "eb8ad42e2010e88b6c2bed7e2be4b316993dd38ad86f1438907355d8d5d923a7", logIndex: 0 },
    rollPidReference: "56,79,30",
    rollPidTrial: "45,79,30",
    /** The predicted peak of |T| (§3); grid of the 5 Nov plant. */
    peakBinsHz: [25.391, 27.344, 29.297],
} as const;

/**
 * Header keys that differ between flights of one tune because the firmware measures them at run time
 * (battery reference at arming, rc_smoothing's auto cutoffs from the measured RX rate). Fixed before
 * the flight from the three reference logs; never extended after seeing a trial log.
 */
export const RUNTIME_HEADER_KEYS: readonly string[] = [
    "vbatref",
    "rc_smoothing_active_cutoffs_ff_sp_thr",
    "rc_smoothing_rx_smoothed",
];

/** The PID family: a difference there is a PID change, not a configuration change. */
const PID_KEYS = new Set(["rollPID", "pitchPID", "yawPID", "levelPID", "magPID", "d_max", "ff_weight"]);

/** The reference settings PROEFPLAN §4 names, each verified from the log header. */
export const REPORTED_SETTINGS: readonly string[] = [
    "rollPID",
    "d_max",
    "chirp_frequency_start_deci_hz",
    "chirp_frequency_end_deci_hz",
    "chirp_time_seconds",
    "chirp_amplitude_roll",
    "levelPID",
    "angle_limit",
    "debug_mode",
    "P interval",
    "iterm_relax",
    "iterm_relax_type",
    "iterm_relax_cutoff",
    "Firmware revision",
];

export interface HeaderCheck {
    issues: string[];
    settings: Record<string, { reference: string | null; log: string | null }>;
}

/**
 * Every logged header value of `log` must equal the registered baseline's, except the run-time keys
 * and rollPID, which must be exactly `expectedRollPid`. The baseline itself must log the reference
 * rollPID. Missing values are missing evidence, never a match.
 */
export function trialHeaderCheck(
    baseline: readonly (readonly [string, string])[],
    log: readonly (readonly [string, string])[],
    expectedRollPid: string,
): HeaderCheck {
    const b = new Map(baseline);
    const l = new Map(log);
    const issues: string[] = [];
    const settings: HeaderCheck["settings"] = {};
    for (const k of REPORTED_SETTINGS) settings[k] = { reference: b.get(k) ?? null, log: l.get(k) ?? null };

    if (b.get("rollPID") !== TRIAL.rollPidReference) {
        issues.push(`baseline_roll_pid_not_registered:${b.get("rollPID") ?? "missing"}`);
    }
    const got = l.get("rollPID");
    if (got === undefined) {
        issues.push("header_missing:rollPID");
    } else if (got !== expectedRollPid) {
        const [ep, ...eid] = expectedRollPid.split(",").map((v) => v.trim());
        const [gp, ...gid] = got.split(",").map((v) => v.trim());
        if (gp !== ep) issues.push(`roll_p_expected_${ep}:${gp}`);
        if (eid.join(",") !== gid.join(",")) issues.push(`pid_changed:rollPID_i_d:${eid.join(",")}:${gid.join(",")}`);
    }
    for (const k of new Set([...b.keys(), ...l.keys()])) {
        if (k === "rollPID" || RUNTIME_HEADER_KEYS.includes(k)) continue;
        const bv = b.get(k);
        const lv = l.get(k);
        if (bv === undefined || lv === undefined) {
            issues.push(`header_missing:${k}`);
        } else if (bv !== lv) {
            issues.push(`${PID_KEYS.has(k) ? "pid_changed" : "header_changed"}:${k}:${bv}:${lv}`);
        }
    }
    return { issues, settings };
}

/** ANGLE (BOXANGLE, bit 1 of the logged rcModeActivationMask) must be active over the whole roll sweep. */
export function angleThroughSweep(
    mask: ArrayLike<number> | null | undefined,
    sweep: { start: number; end: number } | null | undefined,
): string[] {
    if (!sweep) return ["roll_sweep_missing"];
    if (!mask) return ["flight_mode_not_logged"];
    let off = 0;
    for (let i = sweep.start; i < sweep.end; i++) if (!((mask[i] ?? 0) & 2)) off++;
    return off ? [`angle_not_active_during_roll_sweep:${off}_of_${sweep.end - sweep.start}_samples`] : [];
}

/**
 * The trial log of a file: exactly one log with a roll sweep, and not a reference log. A file with
 * older flights still on the flash could otherwise pass an old P56 flight as the new reference.
 */
export function trialLogIssues(
    logs: readonly { sha256: string; logIndex: number; hasRollSweep: boolean }[],
    forbiddenSha: readonly string[],
): string[] {
    const out: string[] = [];
    const swept = logs.filter((l) => l.hasRollSweep);
    if (!logs.length) out.push("log_missing");
    else if (!swept.length) out.push("roll_sweep_missing");
    else if (swept.length > 1) out.push(`file_holds_${swept.length}_logs_with_a_roll_sweep:erase_the_flash_first`);
    if (logs.some((l) => forbiddenSha.includes(l.sha256))) out.push("file_is_a_reference_or_other_trial_log");
    return out;
}

export interface BinCoverage {
    frequencyHz: number;
    testedInT: boolean;
    testedInLoop: boolean;
    /** Why the bin was not tested in T (null: tested). */
    reason: string | null;
    /** Why the bin was not tested in the loop domain (null: tested). */
    loopReason: string | null;
    tExcess: number | null;
    candidateCoherence: number | null;
    repeatCoherence: number | null;
}

/** Which bins up to `maxHz` a comparison tested in T, and why the others were left out. */
export function coverage(trace: readonly AxisBinTrace[], maxHz = 40): BinCoverage[] {
    return trace
        .filter((t) => t.frequencyHz <= maxHz)
        .map((t) => ({
            frequencyHz: t.frequencyHz,
            testedInT: !t.excluded && !t.tExcluded,
            testedInLoop: !t.excluded && !t.loopExcluded,
            reason: t.excluded ?? t.tExcluded ?? null,
            loopReason: t.excluded ?? t.loopExcluded ?? null,
            tExcess: t.tExcess,
            candidateCoherence: t.candidateCoherence,
            repeatCoherence: t.repeatCoherence,
        }));
}

/** The bin of `trace` nearest `hz`, within half a bin of the 1.953 Hz grid. */
export function binAt<T extends { frequencyHz: number }>(rows: readonly T[], hz: number): T | null {
    let best: T | null = null;
    for (const r of rows) {
        if (
            Math.abs(r.frequencyHz - hz) < 0.5 &&
            (!best || Math.abs(r.frequencyHz - hz) < Math.abs(best.frequencyHz - hz))
        )
            best = r;
    }
    return best;
}

/** The trace's aggregates must be the record's comparison, or the trace is not what decided. */
export function traceMatches(trace: readonly AxisBinTrace[], cmp: AxisComparison): boolean {
    const t = trace.filter((x) => !x.excluded && !x.tExcluded && x.tExcess !== null);
    const l = trace.filter((x) => !x.excluded && !x.loopExcluded && x.loopExcess !== null);
    const max = (v: number[]) => v.reduce((a, b) => Math.max(a, b), 0);
    return (
        t.length === cmp.comparedBins &&
        t.filter((x) => x.detectable).length === cmp.detectableBins &&
        l.length === cmp.loopBins &&
        Math.abs(max(t.map((x) => x.tExcess!)) - cmp.maxExcess) < 1e-12 &&
        Math.abs(max(l.map((x) => x.loopExcess!)) - cmp.loopMaxExcess) < 1e-12
    );
}

export type PeakOutcome = "PEAK_CONSISTENT" | "PEAK_INCONSISTENT" | "PEAK_UNRESOLVED" | "NOT_ASSESSED";

export interface PeakInput {
    /** null: the log's comparison is invalid or absent for the trial (NONE). */
    coverage: readonly BinCoverage[] | null;
    traceMatches: boolean;
}

/**
 * The pre-registered peak conclusion, separate from the app verdict and the decision table. Only
 * with the condition REPRODUCED, valid comparisons, a trace equal to the record, and all three peak
 * bins tested in T in both A and B; otherwise NOT_ASSESSED, also when the app shows PASS. Uses only
 * the app's own per-bin tolerance (excess ≤ 1 is within).
 *   CONSISTENT    every peak bin within in A and in B
 *   INCONSISTENT  at least two of the three peak bins outside in A and in B
 *   UNRESOLVED    anything else
 */
export function peakAssessment(
    condition: string,
    a: PeakInput,
    b: PeakInput,
): { outcome: PeakOutcome; reasons: string[]; bins: Record<"A" | "B", (BinCoverage | null)[]> } {
    const reasons: string[] = [];
    const rows = (p: PeakInput) => TRIAL.peakBinsHz.map((hz) => (p.coverage ? binAt(p.coverage, hz) : null));
    const bins = { A: rows(a), B: rows(b) };
    if (condition !== "REPRODUCED") reasons.push(`condition_${condition.toLowerCase()}`);
    for (const [name, p] of [
        ["A", a],
        ["B", b],
    ] as const) {
        if (!p.coverage) {
            reasons.push(`${name}:comparison_not_valid`);
            continue;
        }
        if (!p.traceMatches) reasons.push(`${name}:trace_differs_from_record`);
        bins[name].forEach((r, i) => {
            if (!r || !r.testedInT)
                reasons.push(`${name}:${TRIAL.peakBinsHz[i]}_hz_not_tested:${r?.reason ?? "no_bin"}`);
        });
    }
    if (reasons.length) return { outcome: "NOT_ASSESSED", reasons, bins };
    const outside = (r: (BinCoverage | null)[]) => r.filter((x) => x!.tExcess! > 1).length;
    const oa = outside(bins.A);
    const ob = outside(bins.B);
    const outcome: PeakOutcome =
        oa === 0 && ob === 0 ? "PEAK_CONSISTENT" : oa >= 2 && ob >= 2 ? "PEAK_INCONSISTENT" : "PEAK_UNRESOLVED";
    return { outcome, reasons: [`outside_A:${oa}`, `outside_B:${ob}`], bins };
}
