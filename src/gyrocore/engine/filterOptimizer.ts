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
 * Gyro / D-term lowpass, RPM filter and dynamic notch settings (plan V2-G).
 *
 * Every candidate is run through the notch-aware chain (gyroChain.ts) on this log's own
 * gyroUnfilt / eRPM / throttle, so its noise is what this craft's noise would have been
 * with it; its delay enters the loop model (loopModel.ts) as the chain ratio at the sweep.
 * A group (RPM → dynamic notch → gyro LPF → D-term LPF, each on the previous winners) moves
 * only when the worst axis' phase margin improves by at least MIN_PM_GAIN_DEG while the
 * noise above NOISE_BAND_HZ does not grow by more than NOISE_ALLOWANCE.
 *
 * Results are simulations on logged data. With the chain validated on this log they are
 * PARTIAL (a flight with the proposal has to confirm them); without it BLOCKED.
 */

import { cdiv, cphaseDeg, type DigitalControllerConfig } from "@/js/blackbox/betaflight_digital_controller";
import { simulateDterm, type DtermDynamicConfig } from "@/js/blackbox/betaflight_dterm_dynamic";
import { welchPowerSpectrum } from "@/js/blackbox/spectral_analysis";
import {
    effectiveChainFrf,
    simulateGyroChain,
    type ChainInput,
    type ChainSimulation,
    type GyroChainConfig,
} from "./gyroChain";
import { loopMargins, type AxisLoop, type LoopMargins } from "./loopModel";

export const NOISE_BAND_HZ: [number, number] = [100, 1000];
export const NOISE_ALLOWANCE = 0.1;
export const MIN_PM_GAIN_DEG = 1;

export type FilterGroup = "rpm_filter" | "dynamic_notch" | "gyro_filter" | "dterm_filter";

export interface FilterAxisContext {
    loop: AxisLoop;
    /** CHIRP sweep sample range [start, end) of this axis. */
    window: [number, number];
    /** D-term path of this axis (M5-B); null for an axis without D. */
    dterm: DtermDynamicConfig | null;
    /** The CHIRP measurement passed qualification. Only such axes set the delay budget. */
    qualified: boolean;
}

export interface FilterContext {
    input: ChainInput;
    cfg: GyroChainConfig;
    sampleRateHz: number;
    /** In-flight samples (noise is measured there only). */
    flightMask: Uint8Array;
    axes: FilterAxisContext[];
    /** Logged gyroADC per axis (D-term noise runs on what the firmware differentiated). */
    gyroAdc: [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>];
    chainValidated: boolean;
    /** The M5-B D path reproduced this log's axisD (dtermFitAccepted). */
    dtermValidated: boolean;
}

export interface FilterGroupResult {
    group: FilterGroup;
    current: Record<string, number>;
    proposed: Record<string, number>;
    changed: boolean;
    /** Noise above NOISE_BAND_HZ relative to now (gyroADCf; D-term output for dterm_filter). */
    noiseRatio: number | null;
    worstPmBeforeDeg: number | null;
    worstPmAfterDeg: number | null;
    /** Phase change of the gyro chain at each axis' crossover (°, + = less lag). */
    phaseGainDeg: number[];
    candidatesEvaluated: number;
    status: "VALIDATED" | "PARTIAL" | "BLOCKED";
    reasons: string[];
}

interface Eval {
    cfg: GyroChainConfig;
    sim: ChainSimulation;
    noise: number;
    margins: LoopMargins[];
    phaseGain: number[];
}

/** Welch segment of the noise estimate (samples). */
export const NOISE_WELCH_SEGMENT = 1024;

function bandPower(signal: Float64Array, fs: number): number | null {
    const ps = welchPowerSpectrum(signal, fs, NOISE_WELCH_SEGMENT, 0.5);
    if (!ps) return null;
    let p = 0;
    for (let k = 0; k < ps.frequencies.length; k++) {
        if (ps.frequencies[k] >= NOISE_BAND_HZ[0] && ps.frequencies[k] <= NOISE_BAND_HZ[1]) p += ps.psd[k];
    }
    return p * (ps.frequencies[1] - ps.frequencies[0]);
}

/**
 * Noise-band power of `x` over the samples that are both valid and in flight (`valid`, `mask`),
 * estimated per contiguous run of such samples and averaged over the runs, each weighted by the
 * Welch segments it holds (measurement audit B6). Concatenating the runs before one Welch estimate
 * would splice unrelated samples together: every splice is a step the window turns into broadband
 * power inside the noise band, which is then charged to the filters. A run shorter than one Welch
 * segment carries no estimate; null when no run is long enough (the caller treats that as unknown).
 * Exported for its test.
 */
export function maskedBandPower(x: ArrayLike<number>, valid: Uint8Array, mask: Uint8Array, fs: number): number | null {
    let weighted = 0;
    let weight = 0;
    let run: number[] = [];
    const flush = () => {
        if (run.length >= NOISE_WELCH_SEGMENT) {
            const p = bandPower(Float64Array.from(run), fs);
            if (p !== null) {
                // welchPowerSpectrum's segment count at 50 % overlap.
                const segments = Math.floor((run.length - NOISE_WELCH_SEGMENT) / (NOISE_WELCH_SEGMENT / 2)) + 1;
                weighted += p * segments;
                weight += segments;
            }
        }
        run = [];
    };
    for (let k = 0; k < valid.length; k++) {
        if (valid[k] && mask[k] && Number.isFinite(x[k])) run.push(Number(x[k]));
        else flush();
    }
    flush();
    return weight > 0 ? weighted / weight : null;
}

/** Worst phase margin over the qualified axes (a rejected measurement never drives a proposal). */
function worst(ms: LoopMargins[], qualified: readonly boolean[]): number | null {
    const used = ms.filter((_, i) => qualified[i]);
    const pms = used.map((m) => m.phaseMarginDeg).filter((v): v is number => v !== null);
    return pms.length === used.length && pms.length ? Math.min(...pms) : null;
}

function evaluateChain(ctx: FilterContext, cfg: GyroChainConfig, base: Eval | null): Eval {
    const sim = simulateGyroChain(ctx.input, cfg);
    let noise = 0;
    for (let a = 0; a < 3; a++)
        noise += maskedBandPower(sim.out[a], sim.valid, ctx.flightMask, ctx.sampleRateHz) ?? Number.NaN;
    const margins: LoopMargins[] = [];
    const phaseGain: number[] = [];
    for (const ax of ctx.axes) {
        const eff = effectiveChainFrf(sim, cfg, ax.loop.axis, ax.window[0], ax.window[1], 30);
        const m = loopMargins(ax.loop, { cfg: ax.loop.cfg, chain: eff });
        margins.push(m);
        const fc = (base?.margins[margins.length - 1] ?? m).crossoverHz;
        phaseGain.push(fc && eff && ax.loop.chain ? cphaseDeg(cdiv(eff.frf(fc), ax.loop.chain.frf(fc))) : 0);
    }
    return { cfg, sim, noise, margins, phaseGain };
}

/** `noiseRef`: the noise before any group moved, so the allowance does not compound. */
function pick(base: Eval, candidates: Eval[], noiseRef: number, q: readonly boolean[]): Eval {
    const pmBase = worst(base.margins, q);
    let best = base;
    for (const c of candidates) {
        const pm = worst(c.margins, q);
        if (pm === null || pmBase === null || !Number.isFinite(c.noise)) continue;
        if (c.noise > noiseRef * (1 + NOISE_ALLOWANCE)) continue;
        const bestPm = worst(best.margins, q)!;
        if (pm >= pmBase + MIN_PM_GAIN_DEG && pm > bestPm) best = c;
    }
    return best;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(v)));

function values(group: FilterGroup, c: GyroChainConfig): Record<string, number> {
    switch (group) {
        case "rpm_filter":
            return { rpm_filter_harmonics: c.rpmHarmonics, rpm_filter_q: c.rpmQ, rpm_filter_min_hz: c.rpmMinHz };
        case "dynamic_notch":
            return { dyn_notch_count: c.dynNotchCount, dyn_notch_q: c.dynNotchQ };
        case "gyro_filter":
            return {
                gyro_lpf1_static_hz: c.lpf1StaticHz,
                gyro_lpf1_dyn_min_hz: c.lpf1DynMinHz,
                gyro_lpf1_dyn_max_hz: c.lpf1DynMaxHz,
                gyro_lpf2_static_hz: c.lpf2StaticHz,
            };
        default:
            return {};
    }
}

function candidatesFor(group: FilterGroup, c: GyroChainConfig): GyroChainConfig[] {
    const out: GyroChainConfig[] = [];
    if (group === "rpm_filter" && c.rpmHarmonics > 0) {
        for (const h of [c.rpmHarmonics, Math.min(3, c.rpmHarmonics + 1)]) {
            for (const qs of [0.7, 0.85, 1, 1.25, 1.5, 2]) {
                out.push({ ...c, rpmHarmonics: h, rpmQ: clamp(c.rpmQ * qs, 250, 3000) });
            }
        }
    }
    if (group === "dynamic_notch") {
        for (const n of [c.dynNotchCount - 1, c.dynNotchCount, c.dynNotchCount + 1]) {
            if (n < 0 || n > 7) continue;
            for (const qs of n ? [0.75, 1, 1.5] : [1])
                out.push({ ...c, dynNotchCount: n, dynNotchQ: clamp(c.dynNotchQ * qs, 1, 1000) });
        }
    }
    if (group === "gyro_filter") {
        for (const s of [0.8, 0.9, 1.15, 1.3, 1.5]) {
            out.push({
                ...c,
                lpf1StaticHz: clamp(c.lpf1StaticHz * s, 0, 1000),
                lpf1DynMinHz: clamp(c.lpf1DynMinHz * s, 0, 1000),
                lpf1DynMaxHz: clamp(c.lpf1DynMaxHz * s, 0, 1000),
                lpf2StaticHz: clamp(c.lpf2StaticHz * s, 0, 1000),
            });
        }
    }
    return out.filter((x) => JSON.stringify(values(group, x)) !== JSON.stringify(values(group, c)));
}

function statusFor(
    ctx: FilterContext,
    changed: boolean,
    extra: string[] = [],
): Pick<FilterGroupResult, "status" | "reasons"> {
    if (!ctx.chainValidated) return { status: "BLOCKED", reasons: ["chain_model_not_validated_on_this_log", ...extra] };
    return {
        status: "PARTIAL",
        reasons: [
            "simulated_on_logged_data",
            ...(changed ? ["required_measurement:ab_flight_with_proposal"] : []),
            ...extra,
        ],
    };
}

function groupResult(
    group: FilterGroup,
    ctx: FilterContext,
    base: Eval,
    chosen: Eval,
    n: number,
    extra: string[] = [],
): FilterGroupResult {
    const changed = chosen !== base;
    return {
        group,
        current: values(group, base.cfg),
        proposed: values(group, chosen.cfg),
        changed,
        noiseRatio: Number.isFinite(base.noise) && base.noise > 0 ? chosen.noise / base.noise : null,
        worstPmBeforeDeg: worst(
            base.margins,
            ctx.axes.map((a) => a.qualified),
        ),
        worstPmAfterDeg: worst(
            chosen.margins,
            ctx.axes.map((a) => a.qualified),
        ),
        phaseGainDeg: chosen.phaseGain,
        candidatesEvaluated: n,
        ...statusFor(ctx, changed, extra),
    };
}

/** D-term lowpass: D noise from the firmware D path (M5-B) on the logged gyroADC; delay via C_fb. */
function optimizeDterm(ctx: FilterContext): FilterGroupResult {
    const axes = ctx.axes.filter((a) => a.dterm && a.dterm.d > 0 && a.qualified);
    const current: Record<string, number> = {};
    const first = axes[0]?.dterm;
    if (first) {
        Object.assign(current, {
            dterm_lpf1_static_hz: first.dtermLpf1StaticHz,
            dterm_lpf1_dyn_min_hz: first.dtermLpf1DynMinHz,
            dterm_lpf1_dyn_max_hz: first.dtermLpf1DynMaxHz,
            dterm_lpf2_static_hz: first.dtermLpf2StaticHz,
        });
    }
    const base: FilterGroupResult = {
        group: "dterm_filter",
        current,
        proposed: { ...current },
        changed: false,
        noiseRatio: null,
        worstPmBeforeDeg: worst(
            ctx.axes.map((a) => loopMargins(a.loop)),
            ctx.axes.map((a) => a.qualified),
        ),
        worstPmAfterDeg: null,
        phaseGainDeg: [],
        candidatesEvaluated: 0,
        status: "BLOCKED",
        reasons: [],
    };
    if (!first) {
        const rejected = ctx.axes.some((a) => a.dterm && a.dterm.d > 0 && !a.qualified);
        return {
            ...base,
            reasons: rejected
                ? ["d_term_axes_measurement_rejected", "required_measurement:qualified_chirp_on_roll_and_pitch"]
                : ["no_axis_with_d_term"],
        };
    }
    if (!ctx.dtermValidated) return { ...base, reasons: ["dterm_model_not_validated_on_this_log"] };
    const dNoise = (s: number) => {
        let p = 0;
        for (const a of axes) {
            const c = a.dterm!;
            const cand: DtermDynamicConfig = {
                ...c,
                dtermLpf1StaticHz: c.dtermLpf1StaticHz * s,
                dtermLpf1DynMinHz: c.dtermLpf1DynMinHz * s,
                dtermLpf1DynMaxHz: c.dtermLpf1DynMaxHz * s,
                dtermLpf2StaticHz: c.dtermLpf2StaticHz * s,
            };
            const sim = simulateDterm(
                { timeUs: ctx.input.timeUs, gyro: ctx.gyroAdc[a.loop.axis], rcThrottle: ctx.input.rcThrottle },
                cand,
            );
            p += maskedBandPower(sim.d, sim.valid, ctx.flightMask, ctx.sampleRateHz) ?? Number.NaN;
        }
        return p;
    };
    const marginsFor = (s: number) =>
        ctx.axes.map((a) => {
            const cfg: DigitalControllerConfig = {
                ...a.loop.cfg,
                dtermLpf1Hz: (a.loop.cfg.dtermLpf1Hz ?? 0) * s,
                dtermLpf2Hz: (a.loop.cfg.dtermLpf2Hz ?? 0) * s,
            };
            return loopMargins(a.loop, { cfg });
        });
    const q = ctx.axes.map((a) => a.qualified);
    const noise0 = dNoise(1);
    const pm0 = worst(marginsFor(1), q);
    let best = { s: 1, noise: noise0, pm: pm0 };
    const scales = [0.8, 0.9, 1.15, 1.3, 1.5];
    for (const s of scales) {
        const pm = worst(marginsFor(s), q);
        const noise = dNoise(s);
        if (pm === null || pm0 === null || !Number.isFinite(noise) || noise > noise0 * (1 + NOISE_ALLOWANCE)) continue;
        if (pm >= pm0 + MIN_PM_GAIN_DEG && pm > (best.pm ?? -Infinity)) best = { s, noise, pm };
    }
    const proposed = Object.fromEntries(Object.entries(current).map(([k, v]) => [k, clamp(v * best.s, 0, 1000)]));
    const changed = best.s !== 1;
    return {
        ...base,
        proposed,
        changed,
        noiseRatio: noise0 > 0 ? best.noise / noise0 : null,
        worstPmAfterDeg: best.pm,
        candidatesEvaluated: scales.length,
        // The D path model (M5-B) is validated on its own (axisD fit); the gyro chain is not involved.
        ...(changed
            ? {
                  status: "PARTIAL" as const,
                  reasons: ["simulated_on_logged_data", "required_measurement:ab_flight_with_proposal"],
              }
            : {
                  status: "PARTIAL" as const,
                  reasons: ["simulated_on_logged_data", "no_change_improves_margin_without_more_noise"],
              }),
    };
}

export interface FilterOptimization {
    groups: FilterGroupResult[];
    /** Chain config with every winning group applied. */
    proposedChain: GyroChainConfig;
}

export function optimizeFilters(ctx: FilterContext): FilterOptimization {
    const base = evaluateChain(ctx, ctx.cfg, null);
    const groups: FilterGroupResult[] = [];
    let cur = base;
    for (const group of ["rpm_filter", "dynamic_notch", "gyro_filter"] as const) {
        const cands = candidatesFor(group, cur.cfg).map((c) => evaluateChain(ctx, c, base));
        const chosen = pick(
            cur,
            cands,
            base.noise,
            ctx.axes.map((a) => a.qualified),
        );
        const extra =
            group === "dynamic_notch"
                ? [
                      "dyn_notch_centres_reconstructed_by_firmware_replica",
                      "required_measurement:fft_freq_debug_flight_for_direct_centre_check",
                  ]
                : group === "rpm_filter" && ctx.input.erpm.length === 0
                  ? ["required_measurement:bidirectional_dshot_erpm_logging"]
                  : [];
        if (group === "rpm_filter" && cur.cfg.rpmHarmonics === 0) extra.push("rpm_filter_off_not_proposed");
        groups.push(groupResult(group, ctx, cur, chosen, cands.length, extra));
        cur = chosen;
    }
    groups.push(optimizeDterm(ctx));
    return { groups, proposedChain: cur.cfg };
}
