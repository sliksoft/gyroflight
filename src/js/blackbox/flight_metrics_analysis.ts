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
 * GF-1 M4: offline feedforward / D-effectiveness / filter measurement analysis.
 *
 * Provenance (GPL-3.0 compatible reference ports — not FPVPIDlab):
 *   - GyroCore `core/gyrocore/analysis/metrics_engine.py` (_tracking_block, overshoot)
 *   - GyroCore `core/gyrocore/analysis/d_effectiveness_analysis.py` (windowed D utility)
 *   - GyroCore `core/gyrocore/filter_evidence/` (noise floors / peaks; actionable=false)
 *   - AeroTuner donor noted in GyroCore PROVENANCE.txt (same algorithms, GPL via GyroCore)
 *
 * Offline only. Never enables Apply / automatic PID or filter recommendations.
 * CHIRP logs are not treated as stick-tracking data for feedforward optimization.
 */

import { ComplexFFT } from "./fft";
import { AIR65_EXTERNAL_BLOCKERS } from "./betaflight_open_loop";

export type AxisName = "roll" | "pitch" | "yaw";
export const AXIS_NAMES: AxisName[] = ["roll", "pitch", "yaw"];

export type Reliability = "high" | "medium" | "low" | "insufficient";
export type AdviceKind = "measurement_only" | "informational_candidate" | "not_advised" | "blocked";

export interface FlightMetricsMeta {
    firmwareVersion?: string;
    /** Blackbox debug_mode; 96 = DEBUG_CHIRP on pinned BF. */
    debugMode?: number;
    /** True when the analysed segment is a CHIRP sweep (not stick flight). */
    chirpActive?: boolean;
    gyroLpf1Hz?: number;
    gyroLpf2Hz?: number;
    dtermLpf1Hz?: number;
    dtermLpf2Hz?: number;
    dynNotchCount?: number;
    rpmFilterHarmonics?: number;
    /** Override sample rate when timeUs is unavailable / irregular. */
    sampleRateHz?: number;
    betaflightMajorMinor?: string;
}

export interface FlightMetricsInput {
    timeUs: ArrayLike<number>;
    gyro: [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>];
    setpoint: [ArrayLike<number>, ArrayLike<number>, ArrayLike<number>];
    /** Logged axisD[0..2] when present. */
    dTerm?: [ArrayLike<number> | null, ArrayLike<number> | null, ArrayLike<number> | null];
    motors?: ArrayLike<number>[];
    throttle?: ArrayLike<number>;
    /** Per-motor eRPM when present. */
    erpm?: ArrayLike<number>[];
    /** Optional feedforward debug / axisF when present. */
    axisF?: [ArrayLike<number> | null, ArrayLike<number> | null, ArrayLike<number> | null];
    meta?: FlightMetricsMeta;
}

export interface MetricField<T> {
    value: T;
    reliability: Reliability;
    source: string;
    limitations: string[];
}

export interface AxisTrackingMetrics {
    axis: AxisName;
    meanAbsError: MetricField<number>;
    trackingScore: MetricField<number>;
    latencyMs: MetricField<number>;
    leadingEdgeOvershoot: MetricField<number>;
    smallStickMeanAbsError: MetricField<number | null>;
    largeStickMeanAbsError: MetricField<number | null>;
    sampleCount: number;
}

export interface FeedforwardAnalysis {
    executable: boolean;
    advice: AdviceKind;
    reliability: Reliability;
    reason: string;
    chirpRejectedForStickFf: boolean;
    missingStickSignals: boolean;
    axes: AxisTrackingMetrics[];
    aggregate: {
        meanError: number;
        latencyMs: number;
        overshoot: number;
        score: number;
    } | null;
    /** Optimal FF is never emitted when evidence is insufficient. */
    optimalFeedforward: null;
    informationalNotes: string[];
}

export interface AxisDEffectiveness {
    axis: AxisName;
    applied: boolean;
    signalSource: "axis_d" | "proxy_error_derivative" | "missing";
    score: number;
    responseCorrelation: number;
    noisePenalty: number;
    /** Proxy motor-stress bias — NOT measured motor temperature. */
    motorStressProxy: number;
    utility: number;
    confidence: number;
    eventCount: number;
    usableWindowCount: number;
    label: string;
    text: string;
    reliability: Reliability;
    limitations: string[];
}

export interface DTermEffectivenessAnalysis {
    executable: boolean;
    advice: AdviceKind;
    reliability: Reliability;
    missingDTerm: boolean;
    axes: AxisDEffectiveness[];
    notes: string[];
}

export interface SpectralPeak {
    frequencyHz: number;
    amplitude: number;
}

export interface AxisFilterSpectrum {
    axis: AxisName;
    noiseFloorDb: number | null;
    bandEnergy: { low: number; resonance: number; high: number };
    peaks: SpectralPeak[];
    reliability: Reliability;
}

export interface FilterAnalysis {
    gyroLpf: {
        configuredHz: { lpf1?: number; lpf2?: number };
        spectrum: AxisFilterSpectrum[];
        advice: AdviceKind;
        notes: string[];
    };
    dtermLpf: {
        configuredHz: { lpf1?: number; lpf2?: number };
        advice: AdviceKind;
        notes: string[];
    };
    rpmFilter: {
        configuredHarmonics?: number;
        erpmPresent: boolean;
        estimatedFundamentalHz: number | null;
        harmonicPeaksHz: number[];
        advice: AdviceKind;
        notes: string[];
        /** schedule unknown → keep M2 blocker semantics */
        scheduleUnknown: boolean;
    };
    dynamicNotch: {
        configuredCount?: number;
        centresKnown: false;
        advice: AdviceKind;
        notes: string[];
    };
    /** Informational only — never definitive CLI. */
    informationalCandidates: Array<{
        kind: string;
        suggestion: string;
        confidence: Reliability;
        reason: string;
    }>;
}

export interface M4FlightAnalysisResult {
    provenance: {
        adaptedFrom: string[];
        license: "GPL-3.0";
        fpvpidlabCopied: false;
    };
    meta: FlightMetricsMeta;
    sampleRateHz: number;
    sampleCount: number;
    feedforward: FeedforwardAnalysis;
    dTerm: DTermEffectivenessAnalysis;
    filters: FilterAnalysis;
    m2m3Safety: {
        externalBlockers: readonly string[];
        applyAllowed: false;
        recommendationsEnabled: false;
        independentPidValidation: "BLOCKED";
    };
}

// --- numeric helpers (GyroCore-style) ---

function asArray(x: ArrayLike<number>): Float64Array {
    if (x instanceof Float64Array) return x;
    const out = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) out[i] = Number(x[i]);
    return out;
}

function finiteCopy(x: ArrayLike<number>): Float64Array {
    const a = asArray(x);
    const out = new Float64Array(a.length);
    for (let i = 0; i < a.length; i++) {
        const v = a[i];
        out[i] = Number.isFinite(v) ? v : 0;
    }
    return out;
}

function mean(xs: ArrayLike<number>): number {
    const n = xs.length;
    if (!n) return 0;
    let s = 0;
    let c = 0;
    for (let i = 0; i < n; i++) {
        const v = xs[i];
        if (!Number.isFinite(v)) continue;
        s += v;
        c++;
    }
    return c ? s / c : 0;
}

function std(xs: ArrayLike<number>): number {
    const n = xs.length;
    if (n < 2) return 0;
    const m = mean(xs);
    let s = 0;
    let c = 0;
    for (let i = 0; i < n; i++) {
        const v = xs[i];
        if (!Number.isFinite(v)) continue;
        s += (v - m) * (v - m);
        c++;
    }
    return c > 1 ? Math.sqrt(s / c) : 0;
}

function percentileAbs(xs: ArrayLike<number>, p: number): number {
    const vals: number[] = [];
    for (let i = 0; i < xs.length; i++) {
        const v = Math.abs(xs[i]);
        if (Number.isFinite(v)) vals.push(v);
    }
    if (!vals.length) return 0;
    vals.sort((a, b) => a - b);
    const idx = Math.min(vals.length - 1, Math.max(0, Math.floor((p / 100) * (vals.length - 1))));
    return vals[idx];
}

function corr(a: ArrayLike<number>, b: ArrayLike<number>): number {
    const n = Math.min(a.length, b.length);
    if (n < 8) return 0;
    let sa = 0;
    let sb = 0;
    let c = 0;
    for (let i = 0; i < n; i++) {
        if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) continue;
        sa += a[i];
        sb += b[i];
        c++;
    }
    if (c < 8) return 0;
    const ma = sa / c;
    const mb = sb / c;
    let num = 0;
    let da = 0;
    let db = 0;
    for (let i = 0; i < n; i++) {
        if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) continue;
        const xa = a[i] - ma;
        const xb = b[i] - mb;
        num += xa * xb;
        da += xa * xa;
        db += xb * xb;
    }
    if (da < 1e-18 || db < 1e-18) return 0;
    return Math.max(-1, Math.min(1, num / Math.sqrt(da * db)));
}

function movingMean(x: Float64Array, win: number): Float64Array {
    const w = Math.max(1, Math.floor(win));
    const out = new Float64Array(x.length);
    if (w === 1) {
        out.set(x);
        return out;
    }
    let sum = 0;
    for (let i = 0; i < x.length; i++) {
        sum += x[i];
        if (i >= w) sum -= x[i - w];
        const n = i < w ? i + 1 : w;
        out[i] = sum / n;
    }
    return out;
}

function estimateSampleRateHz(timeUs: ArrayLike<number>, fallback?: number): number {
    if (fallback && fallback > 0 && Number.isFinite(fallback)) return fallback;
    const n = timeUs.length;
    if (n < 3) return 500;
    const dts: number[] = [];
    for (let i = 1; i < n; i++) {
        const d = Number(timeUs[i]) - Number(timeUs[i - 1]);
        if (Number.isFinite(d) && d > 0) dts.push(d);
    }
    if (!dts.length) return 500;
    dts.sort((a, b) => a - b);
    const med = dts[Math.floor(dts.length / 2)];
    const fs = 1e6 / med;
    return Number.isFinite(fs) && fs > 0 ? fs : 500;
}

function field<T>(value: T, reliability: Reliability, source: string, limitations: string[] = []): MetricField<T> {
    return { value, reliability, source, limitations };
}

function leadingEdgeOvershoot(sp: Float64Array, gy: Float64Array): number {
    if (sp.length < 64 || gy.length < 64) return 0;
    const n = Math.min(sp.length, gy.length);
    const d = new Float64Array(n - 1);
    for (let i = 0; i < n - 1; i++) d[i] = sp[i + 1] - sp[i];
    const sd = std(d) + 1e-12;
    const edges: number[] = [];
    for (let i = 0; i < d.length; i++) {
        if (Math.abs(d[i]) > 2 * sd) edges.push(i);
    }
    if (!edges.length) return 0;
    const W = Math.min(25, Math.max(5, Math.floor(n / 40)));
    const vals: number[] = [];
    for (let e = 0; e < Math.min(50, edges.length); e++) {
        const idx = edges[e];
        const i0 = idx + 1;
        const i1 = Math.min(n, i0 + W);
        if (i1 <= i0) continue;
        const target = sp[Math.min(i0, n - 1)];
        let ex = 0;
        if (d[idx] > 0) {
            let mx = -Infinity;
            for (let i = i0; i < i1; i++) mx = Math.max(mx, gy[i]);
            ex = mx - target;
        } else {
            let mn = Infinity;
            for (let i = i0; i < i1; i++) mn = Math.min(mn, gy[i]);
            ex = target - mn;
        }
        if (Number.isFinite(ex)) vals.push(Math.max(0, ex));
    }
    return vals.length ? mean(vals) : 0;
}

function crossCorrLatencyMs(sp: Float64Array, gy: Float64Array, fs: number): number {
    const m = Math.min(sp.length, gy.length);
    if (m < 33) return 0;
    const sp1 = sp.subarray(0, m);
    const g1 = gy.subarray(0, m);
    const ms = mean(sp1);
    const mg = mean(g1);
    const ss = std(sp1) + 1e-9;
    const sg = std(g1) + 1e-9;
    const a = new Float64Array(m);
    const b = new Float64Array(m);
    for (let i = 0; i < m; i++) {
        a[i] = (sp1[i] - ms) / ss;
        b[i] = (g1[i] - mg) / sg;
    }
    // Restricted lag search ±50 ms
    const maxLag = Math.min(Math.floor(m / 4), Math.max(1, Math.floor(0.05 * fs)));
    let bestLag = 0;
    let best = -Infinity;
    for (let lag = -maxLag; lag <= maxLag; lag++) {
        let s = 0;
        let c = 0;
        for (let i = 0; i < m; i++) {
            const j = i + lag;
            if (j < 0 || j >= m) continue;
            s += a[i] * b[j];
            c++;
        }
        if (c < 16) continue;
        const v = s / c;
        if (v > best) {
            best = v;
            bestLag = lag;
        }
    }
    return Math.min(100, Math.abs(bestLag) / fs * 1000);
}

function analyzeAxisTracking(
    axis: AxisName,
    spIn: ArrayLike<number>,
    gyIn: ArrayLike<number>,
    fs: number,
): AxisTrackingMetrics {
    const sp = finiteCopy(spIn);
    const gy = finiteCopy(gyIn);
    const n = Math.min(sp.length, gy.length);
    const limitations: string[] = [];
    if (n < 8) {
        return {
            axis,
            meanAbsError: field(0, "insufficient", "too_few_samples", ["n<8"]),
            trackingScore: field(50, "insufficient", "too_few_samples", ["n<8"]),
            latencyMs: field(0, "insufficient", "too_few_samples", ["n<8"]),
            leadingEdgeOvershoot: field(0, "insufficient", "too_few_samples", ["n<8"]),
            smallStickMeanAbsError: field(null, "insufficient", "too_few_samples", ["n<8"]),
            largeStickMeanAbsError: field(null, "insufficient", "too_few_samples", ["n<8"]),
            sampleCount: n,
        };
    }
    const errAbs = new Float64Array(n);
    for (let i = 0; i < n; i++) errAbs[i] = Math.abs(sp[i] - gy[i]);
    const meanError = mean(errAbs);
    const maxSp = percentileAbs(sp, 100) + 1e-6;
    const score = Math.max(0, Math.min(100, 100 - (meanError / maxSp) * 100));
    const latencyMs = crossCorrLatencyMs(sp, gy, fs);
    const overshoot = leadingEdgeOvershoot(sp, gy);

    const thr = percentileAbs(sp, 60);
    let smallSum = 0;
    let smallN = 0;
    let largeSum = 0;
    let largeN = 0;
    for (let i = 0; i < n; i++) {
        const a = Math.abs(sp[i]);
        if (a < thr) {
            smallSum += errAbs[i];
            smallN++;
        } else {
            largeSum += errAbs[i];
            largeN++;
        }
    }
    if (smallN < 16) limitations.push("few_small_stick_samples");
    if (largeN < 16) limitations.push("few_large_stick_samples");

    const rel: Reliability = n >= 2000 ? "high" : n >= 200 ? "medium" : "low";
    return {
        axis,
        meanAbsError: field(meanError, rel, "setpoint_minus_gyro", limitations),
        trackingScore: field(score, rel, "normalized_mean_abs_error", limitations),
        latencyMs: field(latencyMs, rel, "cross_correlation_lag", limitations),
        leadingEdgeOvershoot: field(overshoot, rel, "setpoint_edge_excess", limitations),
        smallStickMeanAbsError: field(smallN >= 16 ? smallSum / smallN : null, smallN >= 16 ? rel : "insufficient", "percentile_split", limitations),
        largeStickMeanAbsError: field(largeN >= 16 ? largeSum / largeN : null, largeN >= 16 ? rel : "insufficient", "percentile_split", limitations),
        sampleCount: n,
    };
}

function analyzeFeedforward(input: FlightMetricsInput, fs: number): FeedforwardAnalysis {
    const meta = input.meta ?? {};
    const chirpRejected = meta.chirpActive === true || meta.debugMode === 96;
    const sp0 = input.setpoint[0];
    const missingStick = !sp0 || sp0.length < 8;

    const informationalNotes: string[] = [
        "optimal_ff_not_computed_without_sufficient_stick_evidence",
        "ff_uses_rc_route_not_chirp_injection_path",
    ];

    if (chirpRejected) {
        informationalNotes.push("chirp_log_not_suitable_for_stick_feedforward_tuning");
        // Still report tracking vs chirp setpoint as diagnostic measurement_only.
        const axes = AXIS_NAMES.map((ax, i) =>
            analyzeAxisTracking(ax, input.setpoint[i], input.gyro[i], fs),
        );
        return {
            executable: true,
            advice: "blocked",
            reliability: "insufficient",
            reason: "CHIRP data must not be treated as stick-tracking data for feedforward optimization",
            chirpRejectedForStickFf: true,
            missingStickSignals: missingStick,
            axes,
            aggregate: null,
            optimalFeedforward: null,
            informationalNotes,
        };
    }

    if (missingStick) {
        return {
            executable: false,
            advice: "blocked",
            reliability: "insufficient",
            reason: "missing_or_empty_setpoint_stick_signals",
            chirpRejectedForStickFf: false,
            missingStickSignals: true,
            axes: [],
            aggregate: null,
            optimalFeedforward: null,
            informationalNotes,
        };
    }

    const axes = AXIS_NAMES.map((ax, i) => analyzeAxisTracking(ax, input.setpoint[i], input.gyro[i], fs));
    const agg = {
        meanError: mean(axes.map((a) => a.meanAbsError.value)),
        latencyMs: mean(axes.map((a) => a.latencyMs.value)),
        overshoot: mean(axes.map((a) => a.leadingEdgeOvershoot.value)),
        score: mean(axes.map((a) => a.trackingScore.value)),
    };
    const enoughManeuvers = axes.every((a) => a.sampleCount >= 200);
    return {
        executable: true,
        advice: enoughManeuvers ? "measurement_only" : "not_advised",
        reliability: enoughManeuvers ? "medium" : "low",
        reason: enoughManeuvers
            ? "tracking_metrics_computed_no_optimal_ff"
            : "insufficient_maneuver_density_for_ff_advice",
        chirpRejectedForStickFf: false,
        missingStickSignals: false,
        axes,
        aggregate: agg,
        optimalFeedforward: null,
        informationalNotes,
    };
}

function dtMsFromTime(timeUs: ArrayLike<number>): number {
    const n = timeUs.length;
    if (n < 2) return 2;
    const dts: number[] = [];
    for (let i = 1; i < n; i++) {
        const d = Number(timeUs[i]) - Number(timeUs[i - 1]);
        if (d > 0) dts.push(d / 1000);
    }
    if (!dts.length) return 2;
    dts.sort((a, b) => a - b);
    return Math.max(0.25, Math.min(20, dts[Math.floor(dts.length / 2)]));
}

function windowCandidates(sp: Float64Array, dtMs: number): number[] {
    const n = sp.length;
    if (n < 80) return [];
    const smooth = movingMean(sp, Math.max(3, Math.round(8 / Math.max(dtMs, 0.25))));
    const dsp = new Float64Array(n - 1);
    for (let i = 0; i < n - 1; i++) dsp[i] = Math.abs(smooth[i + 1] - smooth[i]);
    const med = percentileAbs(dsp, 50);
    const p95 = percentileAbs(dsp, 95);
    const span = percentileAbs(smooth, 95);
    const thr = Math.max(6, med * 5, p95 * 0.45, span * 0.03);
    const raw: number[] = [];
    for (let i = 0; i < dsp.length; i++) if (dsp[i] >= thr) raw.push(i + 1);
    if (!raw.length) return [];
    const minGap = Math.max(8, Math.round(36 / Math.max(dtMs, 0.25)));
    const out: number[] = [];
    let last = -minGap;
    for (const idx of raw) {
        if (idx - last < minGap) continue;
        if (idx < 20 || idx + 80 >= n) continue;
        out.push(idx);
        last = idx;
        if (out.length >= 40) break;
    }
    return out;
}

function analyzeAxisD(
    axis: AxisName,
    spIn: ArrayLike<number>,
    gyIn: ArrayLike<number>,
    dIn: ArrayLike<number> | null | undefined,
    motors: ArrayLike<number>[] | undefined,
    timeUs: ArrayLike<number>,
): AxisDEffectiveness {
    const sp = finiteCopy(spIn);
    const gy = finiteCopy(gyIn);
    const n = Math.min(sp.length, gy.length);
    const hasD =
        dIn &&
        dIn.length >= n &&
        percentileAbs(finiteCopy(dIn).subarray(0, n), 90) > 1e-6;
    const signalSource: AxisDEffectiveness["signalSource"] = hasD
        ? "axis_d"
        : dIn
          ? "proxy_error_derivative"
          : "missing";
    const limitations: string[] = [];
    if (!hasD) limitations.push("d_term_missing_or_near_zero_using_proxy_or_blocked");
    limitations.push("motor_stress_is_proxy_not_measured_temperature");

    if (n < 80) {
        return {
            axis,
            applied: false,
            signalSource,
            score: 50,
            responseCorrelation: 0,
            noisePenalty: 0,
            motorStressProxy: 0,
            utility: 0,
            confidence: 0,
            eventCount: 0,
            usableWindowCount: 0,
            label: "insufficient_signal",
            text: "Too few samples for D-effectiveness",
            reliability: "insufficient",
            limitations: [...limitations, "n<80"],
        };
    }

    const dtMs = dtMsFromTime(timeUs);
    const dtS = Math.max(1e-4, dtMs / 1000);
    const windows = windowCandidates(sp, dtMs);
    if (!windows.length) {
        return {
            axis,
            applied: false,
            signalSource,
            score: 50,
            responseCorrelation: 0,
            noisePenalty: 0,
            motorStressProxy: 0,
            utility: 0,
            confidence: 0,
            eventCount: 0,
            usableWindowCount: 0,
            label: "insufficient_signal",
            text: "No usable D windows (too few maneuvers)",
            reliability: "insufficient",
            limitations: [...limitations, "no_usable_d_windows"],
        };
    }

    const error = new Float64Array(n);
    for (let i = 0; i < n; i++) error[i] = sp[i] - gy[i];
    const errSmooth = movingMean(error, Math.max(3, Math.round(6 / Math.max(dtMs, 0.25))));
    const errRate = new Float64Array(n);
    for (let i = 1; i < n - 1; i++) errRate[i] = (errSmooth[i + 1] - errSmooth[i - 1]) / (2 * dtS);
    errRate[0] = errRate[1];
    errRate[n - 1] = errRate[n - 2];

    let dSig: Float64Array;
    if (hasD && dIn) {
        dSig = movingMean(finiteCopy(dIn).subarray(0, n), Math.max(1, Math.round(4 / Math.max(dtMs, 0.25))));
    } else {
        dSig = new Float64Array(n);
        for (let i = 0; i < n; i++) dSig[i] = -errRate[i];
        dSig = movingMean(dSig, Math.max(2, Math.round(4 / Math.max(dtMs, 0.25))));
        if (signalSource === "missing") {
            return {
                axis,
                applied: false,
                signalSource: "missing",
                score: 50,
                responseCorrelation: 0,
                noisePenalty: 0,
                motorStressProxy: 0,
                utility: 0,
                confidence: 0,
                eventCount: windows.length,
                usableWindowCount: 0,
                label: "insufficient_signal",
                text: "D-term channel missing — no effectiveness score",
                reliability: "insufficient",
                limitations,
            };
        }
    }

    const corrs: number[] = [];
    const noisePens: number[] = [];
    const heats: number[] = [];
    const utils: number[] = [];
    let usable = 0;
    const evalWin = Math.max(45, Math.round(165 / Math.max(dtMs, 0.25)));

    for (const idx of windows) {
        const end = Math.min(n, idx + evalWin);
        if (end - idx < 24) continue;
        const dSeg = dSig.subarray(idx, end);
        const eSeg = errRate.subarray(idx, end);
        // Correlate D with future error-rate reduction proxy (−errRate)
        const target = new Float64Array(eSeg.length);
        for (let i = 0; i < eSeg.length; i++) target[i] = -eSeg[i];
        const c = corr(dSeg, target);
        const dRms = Math.sqrt(mean(Array.from(dSeg, (v) => v * v)));
        const eRms = Math.sqrt(mean(Array.from(eSeg, (v) => v * v))) + 1e-9;
        const noisePen = Math.max(0, Math.min(1, dRms / (eRms * 3)));
        let heat = 0;
        if (motors && motors.length) {
            let mSum = 0;
            let mC = 0;
            for (const m of motors) {
                for (let i = idx; i < end && i < m.length; i++) {
                    const v = Number(m[i]);
                    if (Number.isFinite(v)) {
                        mSum += v * v;
                        mC++;
                    }
                }
            }
            const mRms = mC ? Math.sqrt(mSum / mC) : 0;
            heat = Math.max(0, Math.min(1, mRms / 2000));
        }
        const utility = Math.max(0, Math.min(1, (c + 1) / 2 * (1 - 0.5 * noisePen)));
        corrs.push(c);
        noisePens.push(noisePen);
        heats.push(heat);
        utils.push(utility);
        usable++;
    }

    if (!usable) {
        return {
            axis,
            applied: false,
            signalSource,
            score: 50,
            responseCorrelation: 0,
            noisePenalty: 0,
            motorStressProxy: 0,
            utility: 0,
            confidence: 0,
            eventCount: windows.length,
            usableWindowCount: 0,
            label: "insufficient_signal",
            text: "Windows found but none usable",
            reliability: "insufficient",
            limitations,
        };
    }

    const correlation = mean(corrs);
    const noisePenalty = mean(noisePens);
    const motorStressProxy = mean(heats);
    const utility = mean(utils);
    const confidence = Math.max(0, Math.min(1, usable / 12));
    const score = Math.max(
        0,
        Math.min(100, 50 + correlation * 35 + utility * 25 - noisePenalty * 20 - motorStressProxy * 15),
    );

    let label = "d_low_value";
    let text = "D contribution looks weak relative to the observed response";
    if (confidence < 0.28) {
        label = "insufficient_signal";
        text = "D-effectiveness signal is too weak for a strong conclusion";
    } else if (score >= 58 && utility >= 0.58 && correlation >= 0.28) {
        if (noisePenalty >= 0.56 || motorStressProxy >= 0.56) {
            label = "d_helping_but_limited";
            text = "D is helping, but noise or motor-stress proxy limits headroom";
        } else {
            label = "d_helping_and_usable";
            text = "D is contributing useful damping with usable headroom";
        }
    } else if (motorStressProxy >= 0.76 || (noisePenalty >= 0.72 && utility < 0.56)) {
        label = "d_risky";
        text = "Current D behavior looks expensive relative to noise / motor-stress proxy";
    }

    const reliability: Reliability =
        confidence >= 0.55 && hasD ? "medium" : confidence >= 0.28 ? "low" : "insufficient";

    return {
        axis,
        applied: hasD,
        signalSource,
        score,
        responseCorrelation: correlation,
        noisePenalty,
        motorStressProxy,
        utility,
        confidence,
        eventCount: windows.length,
        usableWindowCount: usable,
        label,
        text,
        reliability,
        limitations,
    };
}

function analyzeDTerm(input: FlightMetricsInput): DTermEffectivenessAnalysis {
    const missing =
        !input.dTerm ||
        input.dTerm.every((d) => !d || d.length === 0 || percentileAbs(finiteCopy(d), 90) <= 1e-6);
    const axes = AXIS_NAMES.map((ax, i) =>
        analyzeAxisD(
            ax,
            input.setpoint[i],
            input.gyro[i],
            input.dTerm?.[i],
            input.motors,
            input.timeUs,
        ),
    );
    const anyUsable = axes.some((a) => a.usableWindowCount > 0 && a.confidence > 0);
    return {
        executable: anyUsable,
        advice: missing ? "blocked" : anyUsable ? "measurement_only" : "not_advised",
        reliability: missing
            ? "insufficient"
            : axes.some((a) => a.reliability === "medium")
              ? "medium"
              : "low",
        missingDTerm: missing,
        axes,
        notes: [
            "motor_stress_proxy_is_not_motor_temperature",
            "no_automatic_d_gain_recommendation",
            ...(missing ? ["axisD_channel_missing_or_near_zero"] : []),
        ],
    };
}

function nextPow2(n: number): number {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
}

function axisSpectrum(series: ArrayLike<number>, fs: number): AxisFilterSpectrum & { axis: AxisName } {
    // Placeholder axis filled by caller
    const x = finiteCopy(series);
    const n = Math.min(x.length, 4096);
    const axis = "roll" as AxisName;
    if (n < 64 || !(fs > 0)) {
        return {
            axis,
            noiseFloorDb: null,
            bandEnergy: { low: 0, resonance: 0, high: 0 },
            peaks: [],
            reliability: "insufficient",
        };
    }
    const N = nextPow2(Math.min(n, 2048));
    const slice = x.subarray(x.length - N);
    // remove DC
    const m = mean(slice);
    const input = new Float64Array(N);
    for (let i = 0; i < N; i++) input[i] = slice[i] - m;
    const fft = new ComplexFFT(N, false);
    const out = new Float64Array(N * 2);
    fft.simple(out, input, "real");
    const half = Math.floor(N / 2);
    const mags = new Float64Array(half);
    for (let k = 0; k < half; k++) {
        const re = out[2 * k];
        const im = out[2 * k + 1];
        mags[k] = Math.hypot(re, im) / N;
    }
    const freqOf = (k: number) => (k * fs) / N;
    let low = 0;
    let res = 0;
    let high = 0;
    for (let k = 1; k < half; k++) {
        const f = freqOf(k);
        const p = mags[k] * mags[k];
        if (f < 80) low += p;
        else if (f < 300) res += p;
        else high += p;
    }
    const peaks: SpectralPeak[] = [];
    for (let k = 2; k < half - 2; k++) {
        const f = freqOf(k);
        if (f < 30 || f > 500) continue;
        if (mags[k] > mags[k - 1] && mags[k] > mags[k + 1] && mags[k] > mags[k - 2] && mags[k] > mags[k + 2]) {
            peaks.push({ frequencyHz: f, amplitude: mags[k] });
        }
    }
    peaks.sort((a, b) => b.amplitude - a.amplitude);
    const top = peaks.slice(0, 5);
    const floorMag = percentileAbs(mags, 20) + 1e-15;
    const noiseFloorDb = 20 * Math.log10(floorMag);
    return {
        axis,
        noiseFloorDb,
        bandEnergy: { low, resonance: res, high },
        peaks: top,
        reliability: n >= 1024 ? "medium" : "low",
    };
}

function analyzeFilters(input: FlightMetricsInput, fs: number): FilterAnalysis {
    const meta = input.meta ?? {};
    const spectra = AXIS_NAMES.map((ax, i) => {
        const s = axisSpectrum(input.gyro[i], fs);
        s.axis = ax;
        return s;
    });

    const erpmPresent = Boolean(input.erpm && input.erpm.some((e) => e && e.length > 16));
    let estimatedFundamentalHz: number | null = null;
    const harmonicPeaksHz: number[] = [];
    if (erpmPresent && input.erpm) {
        // eRPM / 60 = electrical Hz; / pole-pairs unknown → report raw electrical estimate median
        const vals: number[] = [];
        for (const ch of input.erpm) {
            if (!ch) continue;
            for (let i = 0; i < ch.length; i++) {
                const v = Number(ch[i]);
                if (Number.isFinite(v) && v > 100) vals.push(v / 60); // electrical Hz if eRPM
            }
        }
        if (vals.length >= 32) {
            vals.sort((a, b) => a - b);
            estimatedFundamentalHz = vals[Math.floor(vals.length / 2)];
            for (let h = 1; h <= Math.min(4, meta.rpmFilterHarmonics ?? 2); h++) {
                harmonicPeaksHz.push(estimatedFundamentalHz * h);
            }
        }
    }

    const dynCount = meta.dynNotchCount;
    const informationalCandidates: FilterAnalysis["informationalCandidates"] = [];
    for (const s of spectra) {
        for (const p of s.peaks.slice(0, 2)) {
            if (p.frequencyHz >= 80 && p.frequencyHz <= 300) {
                informationalCandidates.push({
                    kind: "resonance_peak_observed",
                    suggestion: `Informational only: resonance-like peak near ${p.frequencyHz.toFixed(0)} Hz on ${s.axis}`,
                    confidence: s.reliability,
                    reason: "spectral_peak_not_a_cli_recommendation",
                });
            }
        }
    }

    return {
        gyroLpf: {
            configuredHz: { lpf1: meta.gyroLpf1Hz, lpf2: meta.gyroLpf2Hz },
            spectrum: spectra,
            advice: "measurement_only",
            notes: ["gyro_spectrum_from_logged_gyroADCf", "no_automatic_lpf_cli"],
        },
        dtermLpf: {
            configuredHz: { lpf1: meta.dtermLpf1Hz, lpf2: meta.dtermLpf2Hz },
            advice: input.dTerm ? "measurement_only" : "not_advised",
            notes: input.dTerm
                ? ["dterm_lpf_config_from_headers_only_in_this_phase"]
                : ["missing_d_term_for_filter_coupling_analysis"],
        },
        rpmFilter: {
            configuredHarmonics: meta.rpmFilterHarmonics,
            erpmPresent,
            estimatedFundamentalHz,
            harmonicPeaksHz,
            advice: erpmPresent ? "measurement_only" : "blocked",
            notes: erpmPresent
                ? ["erpm_fundamental_is_electrical_hz_estimate", "pole_pairs_unknown"]
                : ["erpm_missing"],
            scheduleUnknown: true,
        },
        dynamicNotch: {
            configuredCount: dynCount,
            centresKnown: false,
            advice: "blocked",
            notes: [
                "dyn_notch_centres_unknown",
                "matches_m2_external_blocker",
                "no_automatic_notch_cli",
            ],
        },
        informationalCandidates: informationalCandidates.slice(0, 6),
    };
}

/**
 * Optional blackbox channels (axisD / eRPM) not included in chirp frame extraction.
 * Same Viewer FlightLog chunk walk as chirp extraction; returns null series when absent.
 */
export function extractOptionalBlackboxChannels(log: {
    getMainFieldNames(): string[];
    getMinTime(): number;
    getMaxTime(): number;
    getChunksInTimeRange(min: number, max: number): { frames: ArrayLike<number | null | undefined>[] }[];
}): {
    present: { axisD: boolean; erpm: boolean };
    dTerm: [Float64Array, Float64Array, Float64Array] | null;
    erpm: Float64Array[] | null;
} {
    const names = log.getMainFieldNames();
    const lower = names.map((n) => n.trim().toLowerCase());
    const find = (want: string) => {
        const w = want.toLowerCase();
        const i = lower.findIndex((n) => n === w || n === w.replaceAll(/[[\]]/g, ""));
        return i >= 0 ? i : undefined;
    };
    // AIR65 / many BF logs omit axisD[2] when yaw D = 0.
    const dIdx = [find("axisD[0]"), find("axisD[1]"), find("axisD[2]")];
    const erpmIdx = [0, 1, 2, 3].map((i) => find(`eRPM[${i}]`) ?? find(`erpm[${i}]`));
    const timeIdx = find("time");
    const hasD = dIdx.some((i) => i !== undefined);
    const hasErpm = erpmIdx.some((i) => i !== undefined);
    if (timeIdx === undefined || (!hasD && !hasErpm)) {
        return { present: { axisD: hasD, erpm: hasErpm }, dTerm: null, erpm: null };
    }
    const min = log.getMinTime();
    const max = log.getMaxTime();
    const chunks =
        Number.isFinite(min) && Number.isFinite(max) && max >= min ? log.getChunksInTimeRange(min, max) : [];
    const total = chunks.reduce((s, c) => s + c.frames.length, 0);
    const dTerm = hasD
        ? [new Float64Array(total), new Float64Array(total), new Float64Array(total)] as [
              Float64Array,
              Float64Array,
              Float64Array,
          ]
        : null;
    const erpmCols = hasErpm ? erpmIdx.map((i) => (i !== undefined ? new Float64Array(total) : null)) : null;
    let n = 0;
    for (const chunk of chunks) {
        for (const frame of chunk.frames) {
            const t = frame[timeIdx];
            if (typeof t !== "number" || !Number.isFinite(t)) continue;
            if (dTerm) {
                for (let a = 0; a < 3; a++) {
                    if (dIdx[a] === undefined) {
                        dTerm[a][n] = 0;
                        continue;
                    }
                    const v = frame[dIdx[a]!];
                    dTerm[a][n] = typeof v === "number" && Number.isFinite(v) ? v : 0;
                }
            }
            if (erpmCols) {
                for (let m = 0; m < erpmCols.length; m++) {
                    const col = erpmCols[m];
                    if (!col || erpmIdx[m] === undefined) continue;
                    const v = frame[erpmIdx[m]!];
                    col[n] = typeof v === "number" && Number.isFinite(v) ? v : 0;
                }
            }
            n++;
        }
    }
    const cut = (a: Float64Array) => (n === total ? a : a.subarray(0, n));
    return {
        present: { axisD: hasD, erpm: hasErpm },
        dTerm: dTerm ? [cut(dTerm[0]), cut(dTerm[1]), cut(dTerm[2])] : null,
        erpm: erpmCols
            ? (erpmCols.filter((c): c is Float64Array => c !== null).map(cut) as Float64Array[])
            : null,
    };
}

/**
 * Offline M4 flight metrics analysis. Does not enable Apply or recommendations.
 */
export function analyzeM4FlightMetrics(input: FlightMetricsInput): M4FlightAnalysisResult {
    const meta = { ...(input.meta ?? {}) };
    const fs = estimateSampleRateHz(input.timeUs, meta.sampleRateHz);
    const sampleCount = Math.min(
        input.gyro[0].length,
        input.gyro[1].length,
        input.gyro[2].length,
        input.setpoint[0].length,
        input.setpoint[1].length,
        input.setpoint[2].length,
    );

    const feedforward = analyzeFeedforward(input, fs);
    const dTerm = analyzeDTerm(input);
    const filters = analyzeFilters(input, fs);

    return {
        provenance: {
            adaptedFrom: [
                "GyroCore/core/gyrocore/analysis/metrics_engine.py",
                "GyroCore/core/gyrocore/analysis/d_effectiveness_analysis.py",
                "GyroCore/core/gyrocore/filter_evidence/",
                "AeroTuner backend/analysis (via GyroCore GPL-3.0 provenance)",
            ],
            license: "GPL-3.0",
            fpvpidlabCopied: false,
        },
        meta,
        sampleRateHz: fs,
        sampleCount,
        feedforward,
        dTerm,
        filters,
        m2m3Safety: {
            externalBlockers: AIR65_EXTERNAL_BLOCKERS,
            applyAllowed: false,
            recommendationsEnabled: false,
            independentPidValidation: "BLOCKED",
        },
    };
}
