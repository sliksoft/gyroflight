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
 * Verified Tune: independent validation of the plant-fixed PID prediction (plan V2-E).
 *
 * A baseline CHIRP log identifies the plant G. The prediction T_candidate = G·C_ref /
 * (1 + G·C_fb) for a candidate PID set (betaflight_open_loop.plantFixedWhatIf) is then
 * compared with the T measured in a second CHIRP log flown with that candidate — logs the
 * prediction never saw. Agreement within the log-to-log scatter (measured from a baseline
 * repeat when one exists, M5-A bands otherwise) on every changed axis, with a change large
 * enough to be resolved at all, is the only way a record gets verdict PASS.
 *
 * The record names both logs by SHA-256, the craft by UID / board / firmware, and carries
 * its own integrity hash; verifiedTuneIssues re-checks all of it wherever it is used.
 *
 * What a record covers (validatedRegionIssues): only changes that start from exactly the
 * baseline's logged configuration and lie on the measured segment baseline → candidate, with one
 * common fraction per axis for P, I, D, F and d_max. A reverse step, a step past the candidate,
 * another combination of terms, or any step from another starting point (the candidate itself
 * included) is not covered: a new starting point needs its own gain-change flight.
 */

import {
    cmag,
    cmul,
    cdiv,
    csub,
    cphaseDeg,
    evaluateControllerFrf,
    type Complex,
    type DigitalControllerConfig,
} from "@/js/blackbox/betaflight_digital_controller";
import { plantFixedWhatIf, type IdentifiedPlant } from "@/js/blackbox/betaflight_open_loop";
import type { TransferFunction } from "@/js/blackbox/spectral_analysis";

/**
 * v3: bound to the absolute logged configurations, with an independent, whole-configuration baseline
 * repeat and a bounded tolerance (v1 records carried relative limits and are refused).
 */
export const VERIFIED_TUNE_KIND = "gyroflight.verified_tune.v3";
/**
 * Records built under earlier producer rules: v2 records may have taken a repeat of another
 * configuration, a scatter-widened tolerance without bound, or a flight whose independence was
 * never shown (audit 2026-10-23 P1-4, F-01). They are refused by name, never reinterpreted.
 */
export const SUPERSEDED_VERIFIED_TUNE_KINDS: readonly string[] = ["gyroflight.verified_tune.v2"];
const AXES = ["roll", "pitch", "yaw"] as const;
type Axis = (typeof AXES)[number];

/** Comparison band; above it the plant estimate is too uncertain to validate a prediction. */
export const VALIDATION_MAX_HZ = 40;
/** Minimum coherence of a measured bin used for comparison. */
export const VALIDATION_MIN_COHERENCE = 0.8;
/** Tolerance floor per bin (M5-A reproducibility: <20 Hz tight, 20–40 Hz wider). */
export function toleranceFloor(freqHz: number): { magDb: number; phaseDeg: number } {
    return freqHz < 20 ? { magDb: 0.5, phaseDeg: 5 } : { magDb: 1.5, phaseDeg: 10 };
}
/**
 * Loop-domain check: the plant extracted from the candidate log, times the candidate C_fb,
 * against the prediction L = G_baseline · C_fb, where |L| is within ×4 of 1 (the crossover
 * neighbourhood that decides the phase margin). At high loop gain T ≈ C_ref / C_fb and hides
 * plant errors; L does not.
 */
export const LOOP_BAND = { minMag: 0.25, maxMag: 4 } as const;
export function loopToleranceFloor(): { magDb: number; phaseDeg: number } {
    return { magDb: 1.5, phaseDeg: 8 };
}
/**
 * Upper bound of a scatter-derived tolerance, as a multiple of its floor (audit P1-4). Twice the
 * baseline-repeat scatter widens the tolerance, but a repeat that scatters more than this says the
 * flights are not reproducible enough to confirm a prediction at all: such a bin is not compared
 * against a wider band, it counts as unresolvable (INSUFFICIENT when too many are). Design
 * parameter: 3 × the M5-A floor (a repeat ≈ 50 % less reproducible than the reference crafts),
 * not calibrated across craft classes.
 */
export const MAX_REPEAT_TOLERANCE_FACTOR = 3;
/** A compared bin counts as resolved when the predicted change exceeds the tolerance there. */
export const MIN_DETECTABLE_BINS = 3;
/** Share of compared bins that must lie inside the tolerance; none may exceed twice it. */
export const MIN_WITHIN_SHARE = 0.8;

export interface LoggedPids {
    p: number;
    i: number;
    d: number;
    f: number;
}

export interface VerifiedTuneLogRef {
    sha256: string;
    logIndex: number;
    pids: Record<Axis, LoggedPids>;
    /** Every logged absolute value (absoluteTune.loggedAbsoluteValues of the log header). */
    values: Record<string, number>;
}

export interface AxisComparison {
    axis: Axis;
    /** Loop-domain bins compared (crossover neighbourhood) and their agreement. */
    loopBins: number;
    loopWithinShare: number;
    loopMaxExcess: number;
    comparedBins: number;
    detectableBins: number;
    withinShare: number;
    maxExcess: number;
    maxMagErrDb: number;
    maxPhaseErrDeg: number;
    toleranceSource: "baseline_repeat" | "m5a_bands";
    /** Bins whose repeat scatter exceeded MAX_REPEAT_TOLERANCE_FACTOR × the floor (not compared). */
    scatterCappedBins?: number;
    verdict: "PASS" | "FAIL" | "NOT_DETECTABLE" | "INSUFFICIENT";
}

export interface VerifiedTune {
    kind: typeof VERIFIED_TUNE_KIND;
    id: string;
    createdAt: string;
    craft: { uid: [number, number, number]; board: string; firmware: string };
    baseline: VerifiedTuneLogRef;
    candidate: VerifiedTuneLogRef;
    baselineRepeat: { sha256: string; logIndex: number } | null;
    comparisons: AxisComparison[];
    verdict: "PASS" | "FAIL";
    reasons: string[];
}

export interface AxisInput {
    plant: IdentifiedPlant;
    baselineCfg: DigitalControllerConfig;
    candidateCfg: DigitalControllerConfig;
    /** T measured in the candidate log. */
    candidateT: TransferFunction;
    /** T measured in a baseline repeat (same tune as the baseline), when flown. */
    baselineRepeatT?: TransferFunction;
}

export interface VerifiedTuneInput {
    craft: VerifiedTune["craft"];
    baseline: VerifiedTuneLogRef;
    candidate: VerifiedTuneLogRef;
    baselineRepeat?: { sha256: string; logIndex: number };
    axes: Partial<Record<Axis, AxisInput>>;
    createdAt?: string;
}

const SHA256 = /^[0-9a-f]{64}$/;

function db(c: Complex): number {
    return 20 * Math.log10(Math.max(cmag(c), 1e-12));
}
function phaseDiff(a: Complex, b: Complex): number {
    let d = cphaseDeg(a) - cphaseDeg(b);
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    return d;
}

function measuredAt(tf: TransferFunction, f: number): { T: Complex; coherence: number } | null {
    let best = -1;
    for (let k = 0; k < tf.frequencies.length; k++) {
        if (best < 0 || Math.abs(tf.frequencies[k] - f) < Math.abs(tf.frequencies[best] - f)) best = k;
    }
    if (best < 0 || Math.abs(tf.frequencies[best] - f) > 1e-6 * Math.max(1, f)) return null;
    return { T: { re: tf.hReal[best], im: tf.hImag[best] }, coherence: tf.coherence[best] };
}

function pidsDiffer(a: LoggedPids, b: LoggedPids): boolean {
    return a.p !== b.p || a.i !== b.i || a.d !== b.d;
}

/** The per-axis keys a Verified Tune can cover (one common segment fraction per axis). */
export function axisKeys(axis: Axis): string[] {
    return [`p_${axis}`, `i_${axis}`, `d_${axis}`, `f_${axis}`, `d_max_${axis}`];
}
const AXIS_KEY = /^(p|i|d|f|d_max)_(roll|pitch|yaw)$/;

/**
 * Is `target` (values of one axis' keys) on the segment base → cand with one common fraction
 * t ∈ [0, 1]? Integer rounding of each term is allowed (±0.5). A key equal in base and cand must
 * stay exactly at base.
 */
export function onValidatedSegment(
    base: Record<string, number>,
    cand: Record<string, number>,
    target: Record<string, number>,
    keys: readonly string[],
): boolean {
    let lo = 0;
    let hi = 1;
    for (const k of keys) {
        const b = base[k];
        const c = cand[k];
        const x = target[k] ?? b;
        if (!Number.isFinite(b) || !Number.isFinite(c) || !Number.isFinite(x)) {
            if (x !== b) return false;
            continue;
        }
        if (b === c) {
            if (x !== b) return false;
            continue;
        }
        const t1 = (x - 0.5 - b) / (c - b);
        const t2 = (x + 0.5 - b) / (c - b);
        lo = Math.max(lo, Math.min(t1, t2));
        hi = Math.min(hi, Math.max(t1, t2));
    }
    return lo <= hi + 1e-9;
}

function extractG(T: Complex, cfg: DigitalControllerConfig, f: number): Complex | null {
    const frf = evaluateControllerFrf(cfg, f);
    const den = csub(frf.cReference, cmul(T, frf.cFeedback));
    return cmag(den) > 1e-9 ? cdiv(T, den) : null;
}

/** Compare predicted and measured T, and the predicted and measured loop, for one axis. Pure. */
export function compareAxis(axis: Axis, input: AxisInput): AxisComparison {
    const whatIf = plantFixedWhatIf(input.plant, input.baselineCfg, input.candidateCfg);
    let compared = 0;
    let detectable = 0;
    let within = 0;
    let maxExcess = 0;
    let maxMag = 0;
    let maxPhase = 0;
    let loopBins = 0;
    let loopWithin = 0;
    let loopMaxExcess = 0;
    let capped = 0;
    let candidates = 0;
    // Twice the repeat scatter, never below the floor; null above the bound (the bin cannot confirm).
    const scatterTolerance = (floor: { magDb: number; phaseDeg: number }, magDb: number, phaseDeg: number) => {
        const tol = { magDb: Math.max(floor.magDb, 2 * magDb), phaseDeg: Math.max(floor.phaseDeg, 2 * phaseDeg) };
        return tol.magDb > MAX_REPEAT_TOLERANCE_FACTOR * floor.magDb ||
            tol.phaseDeg > MAX_REPEAT_TOLERANCE_FACTOR * floor.phaseDeg
            ? null
            : tol;
    };
    for (const b of whatIf.bins) {
        if (b.status !== "ok" || !b.T_candidate || !b.T_current || !b.T_measured || !b.G) continue;
        const meas = measuredAt(input.candidateT, b.frequencyHz);
        if (!meas || !(meas.coherence >= VALIDATION_MIN_COHERENCE)) continue;
        const rep = input.baselineRepeatT ? measuredAt(input.baselineRepeatT, b.frequencyHz) : null;
        if (input.baselineRepeatT && (!rep || !(rep.coherence >= VALIDATION_MIN_COHERENCE))) continue;

        // Loop domain, wherever the plant is identified.
        const cfb = evaluateControllerFrf(input.candidateCfg, b.frequencyHz).cFeedback;
        const Lpred = cmul(b.G, cfb);
        const Gmeas = extractG(meas.T, input.candidateCfg, b.frequencyHz);
        if (Gmeas && cmag(Lpred) >= LOOP_BAND.minMag && cmag(Lpred) <= LOOP_BAND.maxMag) {
            let tol: { magDb: number; phaseDeg: number } | null = loopToleranceFloor();
            const Grep = rep ? extractG(rep.T, input.baselineCfg, b.frequencyHz) : null;
            if (Grep) {
                tol = scatterTolerance(tol, Math.abs(db(Grep) - db(b.G)), Math.abs(phaseDiff(Grep, b.G)));
            }
            candidates++;
            if (!tol) {
                capped++;
                continue;
            }
            const Lmeas = cmul(Gmeas, cfb);
            const excess = Math.max(
                Math.abs(db(Lmeas) - db(Lpred)) / tol.magDb,
                Math.abs(phaseDiff(Lmeas, Lpred)) / tol.phaseDeg,
            );
            loopBins++;
            loopMaxExcess = Math.max(loopMaxExcess, excess);
            if (excess <= 1) loopWithin++;
        }

        // Closed-loop T, in the band where the CHIRP plant estimate is tight.
        if (b.frequencyHz > VALIDATION_MAX_HZ) continue;
        let tol: { magDb: number; phaseDeg: number } | null = toleranceFloor(b.frequencyHz);
        if (rep) {
            // Twice the observed log-to-log scatter, never tighter than the floor, never above the bound.
            tol = scatterTolerance(
                tol,
                Math.abs(db(rep.T) - db(b.T_measured)),
                Math.abs(phaseDiff(rep.T, b.T_measured)),
            );
        }
        candidates++;
        if (!tol) {
            capped++;
            continue;
        }
        compared++;
        const changeMag = Math.abs(db(b.T_candidate) - db(b.T_current));
        const changePhase = Math.abs(phaseDiff(b.T_candidate, b.T_current));
        if (changeMag > tol.magDb || changePhase > tol.phaseDeg) detectable++;
        const errMag = Math.abs(db(meas.T) - db(b.T_candidate));
        const errPhase = Math.abs(phaseDiff(meas.T, b.T_candidate));
        maxMag = Math.max(maxMag, errMag);
        maxPhase = Math.max(maxPhase, errPhase);
        const excess = Math.max(errMag / tol.magDb, errPhase / tol.phaseDeg);
        maxExcess = Math.max(maxExcess, excess);
        if (excess <= 1) within++;
    }
    const withinShare = compared ? within / compared : 0;
    const loopWithinShare = loopBins ? loopWithin / loopBins : 0;
    let verdict: AxisComparison["verdict"];
    // Too many bins the repeat could not bound: the flights do not reproduce well enough to confirm.
    const tooScattered = candidates > 0 && capped > (1 - MIN_WITHIN_SHARE) * candidates;
    if (compared < MIN_DETECTABLE_BINS * 2 || loopBins < MIN_DETECTABLE_BINS || tooScattered) verdict = "INSUFFICIENT";
    else if (detectable < MIN_DETECTABLE_BINS) verdict = "NOT_DETECTABLE";
    else
        verdict =
            withinShare >= MIN_WITHIN_SHARE &&
            maxExcess <= 2 &&
            loopWithinShare >= MIN_WITHIN_SHARE &&
            loopMaxExcess <= 2
                ? "PASS"
                : "FAIL";
    return {
        axis,
        loopBins,
        loopWithinShare,
        loopMaxExcess,
        comparedBins: compared,
        detectableBins: detectable,
        withinShare,
        maxExcess,
        maxMagErrDb: maxMag,
        maxPhaseErrDeg: maxPhase,
        toleranceSource: input.baselineRepeatT ? "baseline_repeat" : "m5a_bands",
        scatterCappedBins: capped,
        verdict,
    };
}

function canonical(v: Omit<VerifiedTune, "id">): string {
    return JSON.stringify(v, (_k, val) =>
        val && typeof val === "object" && !Array.isArray(val)
            ? Object.fromEntries(
                  Object.keys(val)
                      .sort()
                      .map((k) => [k, val[k]]),
              )
            : val,
    );
}

export function verifiedTuneHash(v: Omit<VerifiedTune, "id">): string {
    const text = canonical(v);
    let h1 = 0x811c9dc5;
    let h2 = 0x01000193;
    for (let i = 0; i < text.length; i++) {
        h1 = Math.imul(h1 ^ text.charCodeAt(i), 0x01000193);
        h2 = Math.imul(h2 ^ text.charCodeAt(i), 0x5bd1e995);
    }
    return `vt-${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`;
}

/** The producer: compares every axis whose PIDs changed between the two logs. */
export function buildVerifiedTune(input: VerifiedTuneInput): VerifiedTune {
    const reasons: string[] = [];
    if (!SHA256.test(input.baseline.sha256) || !SHA256.test(input.candidate.sha256)) {
        reasons.push("verified_tune:log_hash_invalid");
    }
    if (input.baseline.sha256 === input.candidate.sha256 && input.baseline.logIndex === input.candidate.logIndex) {
        reasons.push("verified_tune:same_log");
    }
    if (input.baselineRepeat && !repeatIndependent(input.baselineRepeat, input.baseline, input.candidate)) {
        reasons.push("verified_tune:repeat_not_independent");
    }
    const changedAxes = AXES.filter((a) => pidsDiffer(input.baseline.pids[a], input.candidate.pids[a]));
    if (!changedAxes.length) {
        reasons.push("verified_tune:no_pid_change_between_logs");
    }
    if (!valuesComplete(input.baseline.values) || !valuesComplete(input.candidate.values)) {
        reasons.push("verified_tune:logged_values_missing");
    } else {
        // Only PID-family values may differ: a filter or other change would make the comparison
        // confirm something other than the PID prediction it is used for.
        for (const k of new Set([...Object.keys(input.baseline.values), ...Object.keys(input.candidate.values)])) {
            if (!AXIS_KEY.test(k) && input.baseline.values[k] !== input.candidate.values[k]) {
                reasons.push(`verified_tune:non_pid_value_changed:${k}`);
            }
        }
    }
    const comparisons: AxisComparison[] = [];
    for (const axis of changedAxes) {
        const ax = input.axes[axis];
        if (!ax) {
            reasons.push(`verified_tune:axis_not_measured:${axis}`);
            continue;
        }
        const cmp = compareAxis(axis, ax);
        comparisons.push(cmp);
        if (cmp.verdict !== "PASS") {
            reasons.push(`verified_tune:${axis}:${cmp.verdict.toLowerCase()}`);
        }
    }
    const body: Omit<VerifiedTune, "id"> = {
        kind: VERIFIED_TUNE_KIND,
        createdAt: input.createdAt ?? new Date().toISOString(),
        craft: input.craft,
        baseline: input.baseline,
        candidate: input.candidate,
        baselineRepeat: input.baselineRepeat ?? null,
        comparisons,
        verdict: reasons.length ? "FAIL" : "PASS",
        reasons,
    };
    return { ...body, id: verifiedTuneHash(body) };
}

/** Why `v` is not usable release evidence for this craft (empty: it is). */
export function verifiedTuneIssues(
    v: VerifiedTune | null | undefined,
    craft: { uid: readonly number[] | null; firmware: string | null },
): string[] {
    if (v && typeof v === "object" && SUPERSEDED_VERIFIED_TUNE_KINDS.includes(v.kind)) {
        return ["independent_pid_validation_missing", `verified_tune:built_under_superseded_rules:${v.kind}`];
    }
    if (!v || typeof v !== "object" || v.kind !== VERIFIED_TUNE_KIND) {
        return ["independent_pid_validation_missing"];
    }
    const out: string[] = [];
    const { id, ...body } = v;
    if (verifiedTuneHash(body) !== id) out.push("verified_tune:integrity");
    if (v.verdict !== "PASS" || v.reasons?.length) out.push("verified_tune:not_passed");
    if (!SHA256.test(v.baseline?.sha256 ?? "") || !SHA256.test(v.candidate?.sha256 ?? "")) {
        out.push("verified_tune:log_hash_invalid");
    }
    if (!valuesComplete(v.baseline?.values) || !valuesComplete(v.candidate?.values)) {
        out.push("verified_tune:logged_values_missing");
    }
    if (v.baselineRepeat && !repeatIndependent(v.baselineRepeat, v.baseline, v.candidate)) {
        out.push("verified_tune:repeat_not_independent");
    }
    if (
        !AXES.some(
            (a) =>
                v.baseline?.pids?.[a] && v.candidate?.pids?.[a] && pidsDiffer(v.baseline.pids[a], v.candidate.pids[a]),
        )
    ) {
        out.push("verified_tune:no_pid_change_between_logs");
    }
    if (!v.comparisons?.length || v.comparisons.some((c) => c.verdict !== "PASS")) {
        out.push("verified_tune:comparison_not_passed");
    }
    const uid = craft.uid;
    if (!uid || uid.length !== 3 || v.craft?.uid?.some((w, i) => w !== uid[i]))
        out.push("verified_tune:different_craft");
    if (!craft.firmware || v.craft?.firmware !== craft.firmware) out.push("verified_tune:different_firmware");
    return out;
}

type LogId = { sha256: string; logIndex: number };
function repeatIndependent(repeat: LogId, baseline: LogId, candidate: LogId): boolean {
    return [baseline, candidate].every((l) => !(l?.sha256 === repeat.sha256 && l?.logIndex === repeat.logIndex));
}

function valuesComplete(values: Record<string, number> | undefined): boolean {
    return (
        !!values &&
        typeof values === "object" &&
        AXES.every((a) => [`p_${a}`, `i_${a}`, `d_${a}`].every((k) => Number.isFinite(values[k])))
    );
}

/**
 * What a record does not cover in `change` applied to the logged configuration `from` (empty:
 * covered). `from` must be exactly the record's baseline; every changed axis must stay on the
 * measured segment; any other key is never covered.
 */
export function validatedRegionIssues(
    v: VerifiedTune,
    from: Record<string, number>,
    change: Record<string, number>,
): string[] {
    const base = v.baseline.values;
    const cand = v.candidate.values;
    const mismatch = [...new Set([...Object.keys(base), ...Object.keys(from)])]
        .filter((k) => base[k] !== from[k])
        .sort()
        .map((k) => `verified_tune:baseline_mismatch:${k}`);
    if (mismatch.length) return mismatch;
    const out: string[] = [];
    for (const axis of AXES) {
        const keys = axisKeys(axis);
        if (!keys.some((k) => k in change && change[k] !== from[k])) continue;
        if (!onValidatedSegment(base, cand, change, keys)) out.push(`verified_tune:change_outside_validated:${axis}`);
    }
    for (const k of Object.keys(change)) {
        if (!AXIS_KEY.test(k) && change[k] !== from[k]) out.push(`verified_tune:change_outside_validated:${k}`);
    }
    return out;
}
