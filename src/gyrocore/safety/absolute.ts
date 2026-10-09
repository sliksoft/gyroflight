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
 * Current absolute tune and the non-actionable absolute proposal, ported from
 * GyroCore core/gyrocore/autotune/absolute.py + current_tune.py (d2e60f7),
 * BBL-header path only (Gyroflight has no CLI dump; the CLI path is class B).
 *
 * Reference-compatible by option, with four Gyroflight adaptations that are on
 * by default and documented in docs/gyrocore/SAFETY_ENGINE.md:
 *
 *  - readBetaflightCsvHeaders (D2): the reference reads F, d_max and the
 *    dynamic LPF min/max only under CLI names (f_roll, d_max_roll,
 *    dterm_lpf1_dyn_min_hz, ...). Betaflight >= 2025.12 logs them as the CSV
 *    header lines `ff_weight:r,p,y`, `d_max:r,p,y`, `dterm_lpf1_dyn_hz:min,max`,
 *    `gyro_lpf1_dyn_hz:min,max` (blackbox.c), so header-only, the reference
 *    loses them. Values the reference finds are never overridden.
 *  - seedUndrivenAxesFromCurrent (D3): the reference seeds the mapping with
 *    zeroed axes, so in RP mode it proposes yaw P/I/F = 0. The firmware leaves
 *    an axis the mode does not drive unchanged; so does this, or marks it
 *    missing when its current value is not logged.
 *  - failClosedOnBadInput (E1, E2): a non-numeric element in `rollPID` and a gyro
 *    filter ON with no multiplier crash the reference (ValueError, TypeError);
 *    here they become a missing value and the block
 *    `proposed_gyro_sliders_incomplete:<names>`.
 *  - The reference's `d_min_*` alias for d_max (D1) is a CLI name and is not
 *    ported at all.
 */

import type { GlobalSliderMerge, SimplifiedSliders } from "@/gyrocore/tuning/merge";
import { MERGE_REQUIRES_REVIEW } from "@/gyrocore/tuning/merge";
import { jsParseInt, normalizeFieldKey } from "@/gyrocore/chirp/headers";
import {
    AXES,
    FILTER_FIELDS,
    PID_FIELDS,
    PID_SIMPLIFIED_TUNING_OFF,
    applySimplifiedTuning,
    missingForDterm,
    missingForGyro,
    missingForPids,
    slidersOutsideCliRange,
    validateSimplifiedTuning,
    type Axis,
    type AxisPid,
    type FilterField,
    type FilterSet,
    type GyroConfigState,
    type PidField,
    type PidProfileState,
    type SliderValidity,
} from "./simplifiedTuning";

export type ValueSource = "parsed" | "defaulted" | "inferred" | "missing";

/** current_tune.TuneValue. `value` is a number, a PID triple (header), or null. */
export interface TuneValue {
    name: string;
    value: number | number[] | null;
    source: ValueSource;
    origin: string;
    raw: string | number | null;
    note: string;
}

export const isPresent = (tv: TuneValue) => tv.source === "parsed" || tv.source === "inferred";

export type AbsoluteAxis = Record<PidField, TuneValue>;
export type AbsoluteFilters = Record<FilterField, TuneValue>;

export interface AbsoluteTune {
    sliders: SimplifiedSliders;
    roll: AbsoluteAxis;
    pitch: AbsoluteAxis;
    yaw: AbsoluteAxis;
    dterm: AbsoluteFilters;
    gyro: AbsoluteFilters;
    warnings: string[];
    sourcesUsed: string[];
}

export interface ExtractOptions {
    readBetaflightCsvHeaders: boolean;
    failClosedOnBadInput: boolean;
}

export interface ProposeOptions {
    seedUndrivenAxesFromCurrent: boolean;
    failClosedOnBadInput: boolean;
}

export const GYROFLIGHT_EXTRACT: ExtractOptions = { readBetaflightCsvHeaders: true, failClosedOnBadInput: true };
export const REFERENCE_EXTRACT: ExtractOptions = { readBetaflightCsvHeaders: false, failClosedOnBadInput: false };
export const GYROFLIGHT_PROPOSE: ProposeOptions = { seedUndrivenAxesFromCurrent: true, failClosedOnBadInput: true };
export const REFERENCE_PROPOSE: ProposeOptions = { seedUndrivenAxesFromCurrent: false, failClosedOnBadInput: false };

const missing = (name: string, note = ""): TuneValue => ({
    name,
    value: null,
    source: "missing",
    origin: "none",
    raw: null,
    note,
});

const SLIDER_HEADER_KEYS = [
    ["master_multiplier", "simplified_master_multiplier"],
    ["pi_gain", "simplified_pi_gain"],
    ["i_gain", "simplified_i_gain"],
    ["d_gain", "simplified_d_gain"],
    ["feedforward_gain", "simplified_feedforward_gain"],
    ["dterm_filter_multiplier", "simplified_dterm_filter_multiplier"],
] as const;
type HeaderSlider = (typeof SLIDER_HEADER_KEYS)[number][0];

const EXTRA_SLIDER_KEYS: [keyof SimplifiedSliders, string[]][] = [
    ["d_max_gain", ["simplified_d_max_gain", "simplified_dmax_gain"]],
    ["pitch_pi_gain", ["simplified_pitch_pi_gain"]],
    ["pitch_d_gain", ["simplified_pitch_d_gain", "simplified_roll_pitch_ratio"]],
    ["gyro_filter_multiplier", ["simplified_gyro_filter_multiplier"]],
];
const ON_OFF: Record<string, number> = { OFF: 0, ON: 1, "0": 0, "1": 1 };
const PIDS_MODE_BY_NAME: Record<string, number> = { OFF: 0, RP: 1, RPY: 2 };
const ON_OFF_BY_NAME: Record<string, number> = { OFF: 0, ON: 1 };

const PID_KEYS: Record<Axis, Record<"p" | "i" | "d", string[]>> = {
    roll: { p: ["p_roll", "roll_p"], i: ["i_roll", "roll_i"], d: ["d_roll", "roll_d"] },
    pitch: { p: ["p_pitch", "pitch_p"], i: ["i_pitch", "pitch_i"], d: ["d_pitch", "pitch_d"] },
    yaw: { p: ["p_yaw", "yaw_p"], i: ["i_yaw", "yaw_i"], d: ["d_yaw", "yaw_d"] },
};
const FF_KEYS: Record<Axis, string[]> = {
    roll: ["f_roll", "ff_roll", "roll_ff", "roll_f"],
    pitch: ["f_pitch", "ff_pitch", "pitch_ff", "pitch_f"],
    yaw: ["f_yaw", "ff_yaw", "yaw_ff", "yaw_f"],
};
/** The reference also accepts d_min_* here (a pre-2025.12 CLI name meaning the lower D): not ported (D1). */
const DMAX_KEYS: Record<Axis, string[]> = { roll: ["d_max_roll"], pitch: ["d_max_pitch"], yaw: ["d_max_yaw"] };

/** `Number(text)` for one CSV element ("" -> 0, junk -> NaN). */
function jsNumber(text: string): number {
    const s = text.trim();
    if (s === "") {
        return 0;
    }
    const n = Number(s);
    return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) || /^[+-]?(inf|infinity|nan)$/i.test(s) ? n : NaN;
}

function sliderFromRaw(name: string, raw: string, origin: string): TuneValue {
    const parsed = jsParseInt(raw);
    if (parsed === null) {
        return { name, value: NaN, source: "parsed", origin, raw, note: "not an integer (upstream NaN -> 100)" };
    }
    return { name, value: parsed, source: "parsed", origin, raw, note: "" };
}

function modeFromRaw(name: string, raw: string, origin: string, names: Record<string, number>): TuneValue {
    const text = raw
        .trim()
        .replace(/^"+|"+$/g, "")
        .toUpperCase();
    if (text in names) {
        return { name, value: names[text], source: "parsed", origin, raw, note: "" };
    }
    const parsed = jsParseInt(text);
    if (parsed === null) {
        return { name, value: null, source: "missing", origin, raw, note: "unrecognized value" };
    }
    return { name, value: parsed, source: "parsed", origin, raw, note: "" };
}

function intTv(name: string, raw: string, origin: string): TuneValue {
    const parsed = jsParseInt(raw.trim());
    if (parsed === null) {
        return { name, value: null, source: "missing", origin, raw, note: "unparseable" };
    }
    return { name, value: parsed, source: "parsed", origin, raw, note: "" };
}

function enumTv(name: string, raw: string, origin: string, table: Record<string, number>): TuneValue {
    const key = raw.trim();
    if (key in table) {
        return { name, value: table[key], source: "parsed", origin, raw, note: "" };
    }
    if (key.toUpperCase() in table) {
        return { name, value: table[key.toUpperCase()], source: "parsed", origin, raw, note: "" };
    }
    const parsed = jsParseInt(key);
    if (parsed !== null) {
        return { name, value: parsed, source: "parsed", origin, raw, note: "" };
    }
    return { name, value: null, source: "missing", origin, raw, note: "unparseable" };
}

/** `_pick_header_or_cli` with no CLI: first of `keys` present in the header. */
function pick(cfg: Map<string, string>, keys: string[], name: string, table?: Record<string, number>): TuneValue {
    for (const key of keys) {
        const raw = cfg.get(key.toLowerCase());
        if (raw !== undefined) {
            const origin = `bbl_header:${key.toLowerCase()}`;
            return table ? enumTv(name, raw, origin, table) : intTv(name, raw, origin);
        }
    }
    return missing(name);
}

/** One element of a Betaflight CSV header line (adaptation D2). */
function csvElement(cfg: Map<string, string>, key: string, index: number, name: string): TuneValue | null {
    const raw = cfg.get(key);
    if (raw === undefined) {
        return null;
    }
    const parts = raw.split(",");
    if (index >= parts.length) {
        return missing(name, `${key} has no element ${index}`);
    }
    return intTv(name, parts[index], `bbl_header:${key}[${index}]`);
}

/**
 * The current absolute tune of one log, from its raw `H key:value` pairs (in
 * log order). Missing values stay missing; nothing is defaulted.
 */
export function extractAbsoluteTune(
    rawPairs: [string, string][],
    opts: ExtractOptions = GYROFLIGHT_EXTRACT,
): AbsoluteTune {
    const pairs = rawPairs.map(([k, v]): [string, string] => [normalizeFieldKey(k), v]);
    const cfg = new Map(pairs);

    // current_tune._from_headers (later lines win, as the reference's dict does).
    const hdrSliders = new Map<HeaderSlider, TuneValue>();
    const hdrPids = new Map<Axis, TuneValue>();
    let pidsMode: TuneValue | null = null;
    let dtermMode: TuneValue | null = null;
    for (const [key, raw] of pairs) {
        const origin = `bbl_header:${key}`;
        for (const [name, hk] of SLIDER_HEADER_KEYS) {
            if (key === hk) {
                hdrSliders.set(name, sliderFromRaw(name, raw, origin));
            }
        }
        if (key === "rollpid" || key === "pitchpid" || key === "yawpid") {
            const axis = key.slice(0, -3) as Axis;
            hdrPids.set(axis, {
                name: axis,
                value: raw.split(",").map(jsNumber),
                source: "parsed",
                origin: `bbl_header:${axis}PID`,
                raw,
                note: "[P, I, D]",
            });
        } else if (key === "simplified_pids_mode") {
            pidsMode = modeFromRaw(key, raw, origin, PIDS_MODE_BY_NAME);
        } else if (key === "simplified_dterm_filter") {
            dtermMode = modeFromRaw(key, raw, origin, ON_OFF_BY_NAME);
        }
    }
    const warnings: string[] = [];
    const tuneSliders = new Map<HeaderSlider, TuneValue>();
    for (const [name, hk] of SLIDER_HEADER_KEYS) {
        tuneSliders.set(name, hdrSliders.get(name) ?? missing(name, `no ${hk} in BBL header or CLI`));
    }
    for (const [name] of SLIDER_HEADER_KEYS) {
        if (tuneSliders.get(name)!.source === "missing") {
            warnings.push(`slider_missing:${name}`);
        }
    }
    const pidsModeTv = pidsMode ?? missing("simplified_pids_mode", "not logged / not in CLI");
    const dtermModeTv = dtermMode ?? missing("simplified_dterm_filter", "not logged / not in CLI");

    // absolute.extract_absolute_tune
    const extra = new Map<keyof SimplifiedSliders, TuneValue>();
    for (const [name, keys] of EXTRA_SLIDER_KEYS) {
        extra.set(name, pick(cfg, keys, name));
    }
    extra.set("gyro_filter", pick(cfg, ["simplified_gyro_filter"], "gyro_filter", ON_OFF));
    extra.set(
        "dterm_filter",
        isPresent(dtermModeTv) ? dtermModeTv : pick(cfg, ["simplified_dterm_filter"], "dterm_filter", ON_OFF),
    );
    const sliderInt = (name: HeaderSlider): number | null => {
        const tv = tuneSliders.get(name)!;
        // Python int(tv.value): NaN raises and is caught -> None.
        return isPresent(tv) && typeof tv.value === "number" && Number.isFinite(tv.value) ? Math.trunc(tv.value) : null;
    };
    const extraInt = (name: keyof SimplifiedSliders): number | null => {
        const tv = extra.get(name)!;
        return isPresent(tv) && typeof tv.value === "number" ? Math.trunc(tv.value) : null;
    };
    const sliders: SimplifiedSliders = {
        pids_mode: isPresent(pidsModeTv) ? Math.trunc(pidsModeTv.value as number) : null,
        master_multiplier: sliderInt("master_multiplier"),
        i_gain: sliderInt("i_gain"),
        d_gain: sliderInt("d_gain"),
        pi_gain: sliderInt("pi_gain"),
        d_max_gain: extraInt("d_max_gain"),
        feedforward_gain: sliderInt("feedforward_gain"),
        pitch_d_gain: extraInt("pitch_d_gain"),
        pitch_pi_gain: extraInt("pitch_pi_gain"),
        dterm_filter: isPresent(dtermModeTv) ? Math.trunc(dtermModeTv.value as number) : extraInt("dterm_filter"),
        dterm_filter_multiplier: sliderInt("dterm_filter_multiplier"),
        gyro_filter: extraInt("gyro_filter"),
        gyro_filter_multiplier: extraInt("gyro_filter_multiplier"),
    };

    const pidComponent = (axis: Axis, comp: "p" | "i" | "d"): TuneValue => {
        const tv = hdrPids.get(axis);
        if (!tv) {
            return pick(cfg, PID_KEYS[axis][comp], `${axis}.${comp}`);
        }
        const name = `${axis}.${comp}`;
        const idx = { p: 0, i: 1, d: 2 }[comp];
        const values = tv.value as number[];
        if (values.length < idx + 1) {
            return missing(name, "not in BBL header or CLI");
        }
        const v = values[idx];
        if (!Number.isFinite(v)) {
            if (!opts.failClosedOnBadInput) {
                throw new RangeError("ValueError: cannot convert float NaN to integer");
            }
            return { ...missing(name, "unparseable"), origin: tv.origin, raw: tv.raw };
        }
        return { name, value: Math.trunc(v), source: tv.source, origin: tv.origin, raw: tv.raw, note: tv.note };
    };

    const csvFill = (tv: TuneValue, key: string, index: number): TuneValue => {
        if (!opts.readBetaflightCsvHeaders || isPresent(tv)) {
            return tv;
        }
        return csvElement(cfg, key, index, tv.name) ?? tv;
    };

    const axis = (name: Axis, i: number): AbsoluteAxis => ({
        p: pidComponent(name, "p"),
        i: pidComponent(name, "i"),
        d: pidComponent(name, "d"),
        f: csvFill(pick(cfg, FF_KEYS[name], `${name}.f`), "ff_weight", i),
        d_max: csvFill(pick(cfg, DMAX_KEYS[name], `${name}.d_max`), "d_max", i),
    });
    const filters = (prefix: "dterm" | "gyro"): AbsoluteFilters => {
        const p = (f: FilterField) => pick(cfg, [`${prefix}_${f}`], `${prefix}.${f}`);
        return {
            lpf1_dyn_min_hz: csvFill(p("lpf1_dyn_min_hz"), `${prefix}_lpf1_dyn_hz`, 0),
            lpf1_dyn_max_hz: csvFill(p("lpf1_dyn_max_hz"), `${prefix}_lpf1_dyn_hz`, 1),
            lpf1_static_hz: p("lpf1_static_hz"),
            lpf2_static_hz: p("lpf2_static_hz"),
        };
    };

    for (const n of [...missingForPids(sliders), ...missingForDterm(sliders), ...missingForGyro(sliders)]) {
        warnings.push(`slider_missing:${n}`);
    }
    return {
        sliders,
        roll: axis("roll", 0),
        pitch: axis("pitch", 1),
        yaw: axis("yaw", 2),
        dterm: filters("dterm"),
        gyro: filters("gyro"),
        warnings: [...new Set(warnings)],
        sourcesUsed: ["bbl_header"],
    };
}

const intOrNull = (tv: TuneValue) => (isPresent(tv) && typeof tv.value === "number" ? Math.trunc(tv.value) : null);

function axisPidOrNull(ax: AbsoluteAxis): AxisPid | null {
    const vals = PID_FIELDS.map((f) => intOrNull(ax[f]));
    return vals.some((v) => v === null)
        ? null
        : { p: vals[0]!, i: vals[1]!, d: vals[2]!, f: vals[3]!, d_max: vals[4]! };
}

function filterSetOrNull(f: AbsoluteFilters): FilterSet | null {
    const vals = FILTER_FIELDS.map((k) => intOrNull(f[k]));
    return vals.some((v) => v === null)
        ? null
        : { lpf1_dyn_min_hz: vals[0]!, lpf1_dyn_max_hz: vals[1]!, lpf1_static_hz: vals[2]!, lpf2_static_hz: vals[3]! };
}

export function toPidProfile(t: AbsoluteTune): PidProfileState | null {
    const axes = AXES.map((a) => axisPidOrNull(t[a]));
    const dterm = filterSetOrNull(t.dterm);
    if (axes.some((a) => a === null) || !dterm) {
        return null;
    }
    return { roll: axes[0]!, pitch: axes[1]!, yaw: axes[2]!, dterm, sliders: t.sliders };
}

export function toGyro(t: AbsoluteTune): GyroConfigState | null {
    const filters = filterSetOrNull(t.gyro);
    return filters ? { filters, sliders: t.sliders } : null;
}

const ZERO_AXIS: AxisPid = { p: 0, i: 0, d: 0, f: 0, d_max: 0 };
const ZERO_FILTERS: FilterSet = { lpf1_dyn_min_hz: 0, lpf1_dyn_max_hz: 0, lpf1_static_hz: 0, lpf2_static_hz: 0 };

/** absolute._validity_for: MSP_VALIDATE equivalent on the current tune, with skip reasons. */
export function validityFor(tune: AbsoluteTune): SliderValidity {
    const skipped: string[] = [];
    const profile = toPidProfile(tune);
    const gyro = toGyro(tune);
    if (!profile) {
        skipped.push("current_pid_or_dterm_incomplete");
    }
    if (!gyro) {
        skipped.push("current_gyro_incomplete");
    }
    if (profile && !gyro) {
        const r = validateSimplifiedTuning(profile, { filters: ZERO_FILTERS, sliders: tune.sliders });
        return {
            ...r,
            slider_gyro_valid: false,
            gyro_mismatches: [],
            skipped_reasons: [...skipped, ...r.skipped_reasons],
        };
    }
    if (gyro && !profile) {
        const dummy: PidProfileState = {
            roll: ZERO_AXIS,
            pitch: ZERO_AXIS,
            yaw: ZERO_AXIS,
            dterm: ZERO_FILTERS,
            sliders: tune.sliders,
        };
        const r = validateSimplifiedTuning(dummy, gyro);
        return {
            slider_pids_valid: false,
            slider_gyro_valid: r.slider_gyro_valid,
            slider_dterm_valid: false,
            pid_mismatches: [],
            gyro_mismatches: r.gyro_mismatches,
            dterm_mismatches: [],
            skipped_reasons: [...skipped, ...r.skipped_reasons],
        };
    }
    if (!profile || !gyro) {
        return {
            slider_pids_valid: false,
            slider_gyro_valid: false,
            slider_dterm_valid: false,
            pid_mismatches: [],
            gyro_mismatches: [],
            dterm_mismatches: [],
            skipped_reasons: skipped,
        };
    }
    return validateSimplifiedTuning(profile, gyro);
}

export interface Delta {
    current: number;
    proposed: number;
    delta: number;
}

export interface AbsoluteTuneProposal {
    status: "proposed" | "proposed_with_warnings" | "blocked" | typeof MERGE_REQUIRES_REVIEW;
    current: AbsoluteTune;
    merge: GlobalSliderMerge;
    proposed: AbsoluteTune | null;
    currentValidity: SliderValidity;
    proposedValidity: SliderValidity | null;
    deltas: Record<string, Delta>;
    warnings: string[];
    blockedReasons: string[];
    reviewReasons: string[];
    /** Always false: a proposal is not a tune. */
    actionable: false;
}

/** The recommendation side the reference reads (AutotuneRecommendationResult). */
export interface RecommendationSummary {
    blockedReasons: string[];
    warnings: string[];
    withWarnings: boolean;
}

function delta(current: TuneValue, proposed: TuneValue): Delta | null {
    if (!isPresent(current) || !isPresent(proposed)) {
        return null;
    }
    const c = current.value as number;
    const p = proposed.value as number;
    return { current: c, proposed: p, delta: p - c };
}

const MAPPED = { source: "inferred" as const, origin: "firmware:applySimplifiedTuning", note: "mapped from sliders" };

/**
 * absolute.propose_absolute_tune, after the merge (Gyroflight's composite has
 * already merged). Never actionable.
 */
export function proposeAbsoluteTune(
    current: AbsoluteTune,
    merge: GlobalSliderMerge,
    rec: RecommendationSummary,
    opts: ProposeOptions = GYROFLIGHT_PROPOSE,
): AbsoluteTuneProposal {
    const warnings = [...current.warnings, ...rec.warnings];
    const blocked = [...rec.blockedReasons];
    const currentValidity = validityFor(current);
    const base = {
        current,
        merge,
        currentValidity,
        deltas: {},
        actionable: false as const,
    };
    if (merge.status === MERGE_REQUIRES_REVIEW) {
        return {
            ...base,
            status: MERGE_REQUIRES_REVIEW,
            proposed: null,
            proposedValidity: null,
            warnings: [...new Set(warnings)],
            blockedReasons: [...new Set(blocked)],
            reviewReasons: [...merge.review_reasons],
        };
    }
    const merged = merge.simplified!;
    const mappingBlock: string[] = [];
    if (merged.pids_mode === PID_SIMPLIFIED_TUNING_OFF) {
        mappingBlock.push("simplified_pids_mode_off");
    }
    if (missingForPids(merged).length) {
        mappingBlock.push(`proposed_pid_sliders_incomplete:${missingForPids(merged).join(",")}`);
    }
    if (missingForDterm(merged).length) {
        mappingBlock.push(`proposed_dterm_sliders_incomplete:${missingForDterm(merged).join(",")}`);
    }
    if (opts.failClosedOnBadInput && merged.gyro_filter && missingForGyro(merged).length) {
        // Adaptation E2: the reference raises TypeError here.
        mappingBlock.push(`proposed_gyro_sliders_incomplete:${missingForGyro(merged).join(",")}`);
    }
    const cliOut = slidersOutsideCliRange(merged);
    if (cliOut.length) {
        warnings.push(`proposed_sliders_outside_cli_minmax:${cliOut.join(",")}`);
    }
    if (mappingBlock.length) {
        return {
            ...base,
            status: "blocked",
            proposed: null,
            proposedValidity: null,
            warnings: [...new Set(warnings)],
            blockedReasons: [...new Set([...blocked, ...mappingBlock])],
            reviewReasons: [],
        };
    }

    const seedFilters = (f: AbsoluteFilters): FilterSet => ({
        lpf1_dyn_min_hz: intOrNull(f.lpf1_dyn_min_hz) || 0,
        lpf1_dyn_max_hz: intOrNull(f.lpf1_dyn_max_hz) || 0,
        lpf1_static_hz: intOrNull(f.lpf1_static_hz) || 0,
        lpf2_static_hz: intOrNull(f.lpf2_static_hz) || 0,
    });
    if (!filterSetOrNull(current.dterm)) {
        warnings.push("proposed_dterm_hz_from_present_or_zero_missing_not_defaulted");
    }
    if (!filterSetOrNull(current.gyro)) {
        warnings.push("proposed_gyro_hz_from_present_or_zero_missing_not_defaulted");
    }
    const mode = merged.pids_mode ?? 0;
    const undriven = (i: number) => i > mode;
    const seedAxis = (a: Axis, i: number): AxisPid =>
        opts.seedUndrivenAxesFromCurrent && undriven(i) ? (axisPidOrNull(current[a]) ?? ZERO_AXIS) : ZERO_AXIS;
    const [mappedProfile, mappedGyro] = applySimplifiedTuning(
        {
            roll: seedAxis("roll", 0),
            pitch: seedAxis("pitch", 1),
            yaw: seedAxis("yaw", 2),
            dterm: seedFilters(current.dterm),
            sliders: merged,
        },
        { filters: seedFilters(current.gyro), sliders: merged },
    );
    const axisTv = (a: Axis, i: number): AbsoluteAxis => {
        const out = {} as AbsoluteAxis;
        for (const f of PID_FIELDS) {
            const name = `${a}.${f}`;
            if (opts.seedUndrivenAxesFromCurrent && undriven(i)) {
                // Adaptation D3: the firmware leaves this axis as it is.
                out[f] = axisPidOrNull(current[a])
                    ? {
                          name,
                          value: mappedProfile[a][f],
                          source: "inferred",
                          origin: "firmware:not_driven_by_pids_mode",
                          raw: mappedProfile[a][f],
                          note: "unchanged: axis not driven by simplified_pids_mode",
                      }
                    : missing(name, "axis not driven by simplified_pids_mode; current value not logged");
            } else {
                out[f] = { name, value: mappedProfile[a][f], raw: mappedProfile[a][f], ...MAPPED };
            }
        }
        return out;
    };
    const filterTv = (prefix: string, set: FilterSet): AbsoluteFilters => {
        const out = {} as AbsoluteFilters;
        for (const f of FILTER_FIELDS) {
            out[f] = { name: `${prefix}.${f}`, value: set[f], raw: set[f], ...MAPPED };
        }
        return out;
    };
    const proposed: AbsoluteTune = {
        sliders: merged,
        roll: axisTv("roll", 0),
        pitch: axisTv("pitch", 1),
        yaw: axisTv("yaw", 2),
        dterm: filterTv("dterm", mappedProfile.dterm),
        gyro: filterTv("gyro", mappedGyro.filters),
        warnings: [],
        sourcesUsed: ["firmware_simplified_tuning", ...current.sourcesUsed],
    };
    const proposedValidity = validateSimplifiedTuning(mappedProfile, mappedGyro);
    const deltas: Record<string, Delta> = {};
    for (const a of AXES) {
        for (const f of PID_FIELDS) {
            const d = delta(current[a][f], proposed[a][f]);
            if (d) {
                deltas[`${a}.${f}`] = d;
            }
        }
    }
    for (const prefix of ["dterm", "gyro"] as const) {
        for (const f of FILTER_FIELDS) {
            const d = delta(current[prefix][f], proposed[prefix][f]);
            if (d) {
                deltas[`${prefix}.${f}`] = d;
            }
        }
    }
    const uniqueWarnings = [...new Set(warnings)];
    return {
        ...base,
        status: blocked.length
            ? "blocked"
            : uniqueWarnings.length || rec.withWarnings
              ? "proposed_with_warnings"
              : "proposed",
        proposed,
        proposedValidity,
        deltas,
        warnings: uniqueWarnings,
        blockedReasons: [...new Set(blocked)],
        reviewReasons: [],
    };
}

/** safe_tune.absolute_tune_to_config: donor-shaped config plus the "axis.comp" missing list. */
export interface TuneConfig {
    pid: Record<Axis, Partial<Record<"p" | "i" | "d" | "ff" | "d_max", number>>>;
    filters: Record<string, number>;
}

const PID_DONOR: [PidField, "p" | "i" | "d" | "ff" | "d_max"][] = [
    ["p", "p"],
    ["i", "i"],
    ["d", "d"],
    ["f", "ff"],
    ["d_max", "d_max"],
];

export function absoluteTuneToConfig(t: AbsoluteTune): { config: TuneConfig; missing: string[] } {
    const missingList: string[] = [];
    const num = (tv: TuneValue) => (isPresent(tv) && typeof tv.value === "number" ? tv.value : null);
    const pid = {} as TuneConfig["pid"];
    for (const a of AXES) {
        pid[a] = {};
        for (const [gc, donor] of PID_DONOR) {
            const v = num(t[a][gc]);
            if (v === null) {
                missingList.push(`${a}.${gc}`);
            } else {
                pid[a][donor] = v;
            }
        }
    }
    const filters: Record<string, number> = {};
    for (const prefix of ["dterm", "gyro"] as const) {
        for (const f of FILTER_FIELDS) {
            const v = num(t[prefix][f]);
            if (v === null) {
                missingList.push(`${prefix}.${f}`);
            } else {
                filters[`${prefix}_${f}`] = v;
            }
        }
    }
    return { config: { pid, filters }, missing: missingList };
}
