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
 * WU4A: the deterministic Safety foundation against GyroCore's Python
 * reference (d2e60f7; test/gyrocore/tools/gc_safety_reference.py) and the
 * Betaflight firmware matrix (fixtures/betaflight_sim/bf_matrix.json).
 *
 * Absolute-proposal cases with a BBL header run the TS extraction itself in
 * reference-compatible mode. Cases whose reference input is a CLI dump (no CLI
 * parser in Gyroflight; class B) inject the reference's current tune and run
 * the TS merge, mapping, validity, deltas and status on it.
 */

import { describe, expect, it } from "vitest";
import { mergeAutotuneSliders, type MergeAxisInput, type SimplifiedSliders } from "../../src/gyrocore/tuning/merge";
import { readHeaderPairs } from "../../src/gyrocore/chirp/headers";
import {
    applySimplifiedTuning,
    calculateNewPidValues,
    firmwareDefaultGyro,
    firmwareDefaultPidProfile,
    slidersOutsideCliRange,
    validateSimplifiedTuning,
} from "../../src/gyrocore/safety/simplifiedTuning";
import {
    REFERENCE_EXTRACT,
    REFERENCE_PROPOSE,
    extractAbsoluteTune,
    proposeAbsoluteTune,
    type AbsoluteTune,
    type AbsoluteTuneProposal,
    type TuneValue,
} from "../../src/gyrocore/safety/absolute";
import { scaleMaxDelta, valuesWithinFirmware } from "../../src/gyrocore/safety/pipeline";
import { readFixtureJson } from "./harness/fixtures";

// Fixture JSON from the Python generator: shape checked by the assertions themselves.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const ref = readFixtureJson<Json>("safety/safety_foundation_reference.json");
const bf = readFixtureJson<Json>("betaflight_sim/bf_matrix.json");
const F = ref.foundation;

/** The generator writes non-finite floats as strings. */
function decode(v: unknown): Json[string] {
    if (v === "NaN") {
        return Number.NaN;
    }
    if (v === "Infinity") {
        return Number.POSITIVE_INFINITY;
    }
    if (v === "-Infinity") {
        return Number.NEGATIVE_INFINITY;
    }
    if (Array.isArray(v)) {
        return v.map(decode);
    }
    if (v && typeof v === "object") {
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x)]));
    }
    return v;
}

const AXES = ["roll", "pitch", "yaw"] as const;
const PID = ["p", "i", "d", "f", "d_max"] as const;
const FILT = ["lpf1_dyn_min_hz", "lpf1_dyn_max_hz", "lpf1_static_hz", "lpf2_static_hz"] as const;

const pairsOf = (text: string) => readHeaderPairs(new TextEncoder().encode(text), 0, text.length);

/** The reference's AbsoluteTune, from the generator's full projection (CLI cases). */
function injectCurrent(e: Json): AbsoluteTune {
    const full = e.current_full as Record<string, Json>;
    const tv = (k: string): TuneValue => ({ ...full[k] }) as TuneValue;
    const axis = (a: string) => Object.fromEntries(PID.map((c) => [c, tv(`${a}.${c}`)]));
    const filters = (p: string) => Object.fromEntries(FILT.map((c) => [c, tv(`${p}.${c}`)]));
    return {
        sliders: e.current_sliders as SimplifiedSliders,
        roll: axis("roll"),
        pitch: axis("pitch"),
        yaw: axis("yaw"),
        dterm: filters("dterm"),
        gyro: filters("gyro"),
        warnings: e.current_warnings,
        sourcesUsed: ["reference"],
    } as unknown as AbsoluteTune;
}

function mergeInputs(axes: Json[]): MergeAxisInput[] {
    return axes.map((a) => ({ axis: a.axis, blocked: a.blocked, proposed: a.blocked ? null : decode(a.proposed) }));
}

const recFor = (axes: Json[]) => ({
    blockedReasons: axes.some((a) => a.blocked) ? ["sysid_unusable"] : [],
    warnings: [],
    withWarnings: false,
});

function flat(t: AbsoluteTune | null, full = false): Json | null {
    if (!t) {
        return null;
    }
    const out: Json = {};
    const view = (x: TuneValue) =>
        full
            ? x.source === "parsed" || x.source === "inferred"
                ? { value: x.value, source: x.source }
                : { value: null, source: x.source, note: x.note }
            : x.source === "parsed" || x.source === "inferred"
              ? x.value
              : null;
    for (const a of AXES) {
        for (const c of PID) {
            out[`${a}.${c}`] = view(t[a][c]);
        }
    }
    for (const p of ["dterm", "gyro"] as const) {
        for (const c of FILT) {
            out[`${p}.${c}`] = view(t[p][c]);
        }
    }
    return out;
}

function projection(p: AbsoluteTuneProposal): Json {
    return {
        status: p.status,
        blocked_reasons: p.blockedReasons,
        review_reasons: p.reviewReasons,
        warnings: p.warnings,
        merge_status: p.merge.status,
        merged_sliders: p.merge.proposed_sliders,
        current_sliders: p.current.sliders,
        current: flat(p.current, true),
        proposed: flat(p.proposed),
        current_validity: p.currentValidity,
        proposed_validity: p.proposedValidity,
        deltas: p.deltas,
    };
}

function expectedProjection(e: Json): Json {
    const { current_warnings: _w, current_full: _f, ...rest } = e;
    return rest;
}

describe("firmware slider mapping (simplified_tuning.py) vs Python", () => {
    for (const c of F.simplified_tuning as Json[]) {
        it(c.case_id, () => {
            const base = firmwareDefaultPidProfile();
            const sliders = { ...base.sliders, ...c.input.slider_overrides };
            const profile = { ...base, sliders };
            const gyro = { ...firmwareDefaultGyro(), sliders };
            const [mp, mg] = applySimplifiedTuning(profile, gyro);
            expect(sliders).toEqual(c.expected.sliders);
            expect(mp).toEqual(c.expected.profile);
            expect(mg).toEqual(c.expected.gyro);
            expect(validateSimplifiedTuning(mp, mg)).toEqual(c.expected.validity_of_mapped);
            expect(validateSimplifiedTuning(profile, gyro)).toEqual(c.expected.validity_of_unmapped_defaults);
            expect(slidersOutsideCliRange(sliders)).toEqual(c.expected.outside_cli_range);
        });
    }

    it(`PID mapping sweep: ${F.mapping_sweep.rows.length} slider sets, every value exact`, () => {
        const names = F.mapping_sweep.slider_order as (keyof SimplifiedSliders)[];
        const base = firmwareDefaultPidProfile();
        const mismatches: unknown[] = [];
        for (const [row, expected] of F.mapping_sweep.rows as [number[], number[]][]) {
            const sliders = { ...base.sliders };
            names.forEach((n, i) => (sliders[n] = row[i]));
            const p = calculateNewPidValues({ ...base, sliders });
            const got = AXES.flatMap((a) => PID.map((c) => p[a][c]));
            if (got.join() !== expected.join()) {
                mismatches.push({ row, got, expected });
            }
        }
        expect(mismatches).toEqual([]);
        expect(F.mapping_sweep.rows.length).toBe(8 * 256 + 2000);
    });
});

describe("firmware slider mapping vs current Betaflight (bf_matrix.json)", () => {
    expect(bf.firmware.sha).toBe("4fc1520c5a5decddc8ef07ad57c0e766ea8747ba");
    const KEY: Record<string, keyof SimplifiedSliders> = {
        simplified_pids_mode: "pids_mode",
        simplified_master_multiplier: "master_multiplier",
        simplified_pi_gain: "pi_gain",
        simplified_i_gain: "i_gain",
        simplified_d_gain: "d_gain",
        simplified_feedforward_gain: "feedforward_gain",
        simplified_d_max_gain: "d_max_gain",
        "simplified_pitch_d_gain(roll_pitch_ratio)": "pitch_d_gain",
        simplified_pitch_pi_gain: "pitch_pi_gain",
    };
    const portFor = (cfg: Json) => {
        const base = firmwareDefaultPidProfile();
        const sliders = { ...base.sliders };
        for (const [k, v] of Object.entries(cfg.sliders)) {
            if (KEY[k]) {
                sliders[KEY[k]] = v as number;
            }
        }
        return calculateNewPidValues({ ...base, sliders });
    };
    const asBf = (a: Json) => ({ P: a.p, I: a.i, D: a.d, F: a.f, d_max: a.d_max });

    it("equals the plain C source (fw_strict) on every matrix config", () => {
        for (const cfg of bf.pid_configs as Json[]) {
            const p = portFor(cfg);
            for (const a of AXES) {
                if (cfg.axes[a]) {
                    expect(asBf(p[a]), `${cfg.name} ${a}`).toEqual(cfg.axes[a].fw_strict);
                }
            }
        }
    });

    it("is NOT the shipped firmware: the compiled F405 binary differs (fast-math), as recorded", () => {
        const divergent = (bf.pid_configs as Json[])
            .filter((cfg) =>
                AXES.some(
                    (a) =>
                        cfg.axes[a] &&
                        JSON.stringify(asBf(portFor(cfg)[a])) !== JSON.stringify(cfg.axes[a].fw_real_f405),
                ),
            )
            .map((cfg) => cfg.name);
        expect(divergent).toEqual(["dmax_gain200", "master125_pi125_i80_d110_ff90_dg50"]);
        expect(bf.real_firmware_check.real_vs_strict).toBe(243867);
        expect(bf.real_firmware_check.axes).toBe(3005043);
    });
});

/** An error case records no output; take the current tune from a case with the same CLI input. */
const sameCliCase = (c: Json): Json => (F.absolute as Json[]).find((x) => x.expected && x.input.cli === c.input.cli)!;

describe("absolute proposal (absolute.py) vs Python", () => {
    for (const c of F.absolute as Json[]) {
        it(`${c.case_id}: ${c.branch}`, () => {
            const axes = mergeInputs(c.input.axes);
            const run = () => {
                const current = c.input.headers
                    ? extractAbsoluteTune(pairsOf(c.input.headers), REFERENCE_EXTRACT)
                    : injectCurrent(c.expected ?? sameCliCase(c).expected);
                const merge = mergeAutotuneSliders(axes, current.sliders);
                return proposeAbsoluteTune(current, merge, recFor(c.input.axes), REFERENCE_PROPOSE);
            };
            if (c.error) {
                // ValueError (int(nan)), TypeError (int(None)).
                expect(run).toThrow(c.error);
                return;
            }
            const p = run();
            expect(JSON.parse(JSON.stringify(projection(p)))).toEqual(expectedProjection(c.expected));
            if (c.input.headers) {
                expect(p.current.warnings).toEqual(c.expected.current_warnings);
            }
        });
    }
});

describe("pure stages vs Python", () => {
    for (const c of F.stages.scale_max_delta as Json[]) {
        it(`scale_max_delta(${c.scale})`, () => {
            expect(scaleMaxDelta(decode(c.scale))).toEqual(c.expected);
        });
    }
    for (const c of F.stages.values_within_firmware as Json[]) {
        it(`values_within_firmware ${c.case_id}`, () => {
            expect(valuesWithinFirmware(decode(c.config))).toEqual(c.expected);
        });
    }
});
