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
 * Multi-recording combination (completion program 2026-10-28, phase 4; block 8).
 *
 * Independent CHIRP recordings of the same craft / firmware / configuration may stand beside the
 * primary flight (eligibleRecordings). They are never concatenated across discontinuities: each
 * recording keeps its own sweep, window and noise assessment. Since block 8 another flight's
 * averages count only together with its measured values, where those agree (combineRecordings, the
 * experimental decision); no route sums average counts alone. A duplicated recording (same content)
 * never counts twice. Mismatched identity or configuration fails closed and improves nothing.
 */

import type { TransferFunction } from "@/js/blackbox/spectral_analysis";
import type { AutotuneLogInput } from "./autotuneV2";
import { crossLogReferenceIssues, flightRelation, sameFlight } from "./logInput";
import { sweepAverages, type AnalysisProvenance, type FrequencySupport, type SweepInfo } from "./loopModel";

/**
 * Same published closed-loop FRF (same object, bit-equal bins, or equal after float32 round-trip).
 * Used to refuse a duplicated measurement that flight-window identity missed (re-scaled gyro,
 * restarted clock, or a sub-ulp H rescale that is not a new identification).
 *
 * Float32 equality is serialization / round-trip identity — not a scientific plant-similarity
 * tolerance and not proof of flight independence (flightRelation / sameFlight remain primary).
 */
export function transferFunctionValuesIdentical(a: TransferFunction, b: TransferFunction): boolean {
    if (a === b) return true;
    const n = a.frequencies.length;
    if (b.frequencies.length !== n) return false;
    for (let i = 0; i < n; i++) {
        if (a.frequencies[i] !== b.frequencies[i]) return false;
        const ar = a.hReal[i]!;
        const br = b.hReal[i]!;
        const ai = a.hImag[i]!;
        const bi = b.hImag[i]!;
        if (ar === br && ai === bi) continue;
        // Sub-ulp / re-export noise: IEEE float32 collapses 1+1e-12 rescales of typical H bins.
        if (Math.fround(ar) === Math.fround(br) && Math.fround(ai) === Math.fround(bi)) continue;
        return false;
    }
    return true;
}

export interface RecordingAverageClaim {
    /** Stable id for this recording (sha256 + logIndex). */
    id: string;
    sha256: string;
    logIndex: number;
    hz: number;
    averages: number;
    /** Content fingerprint: duplicate claims with the same fingerprint do not stack. */
    contentKey: string;
}

export interface AggregateAveragesResult {
    hz: number;
    /** Sum of unique recordings' whole-segment averages. */
    averages: number;
    contributors: string[];
    rejected: string[];
}

/**
 * Sample-identity key for a claim. Acquisition settings alone must not collide independent
 * flights that happen to share the same sweep parameters (Codex final 2026-10-28, P2).
 * Identical bytes share sha256; that is the duplicate detector.
 */
export function claimContentKey(sha256: string): string {
    return sha256;
}

/**
 * Build a claim from one recording's analysis at `hz`. Returns null when the count is zero.
 */
export function averageClaimAt(
    log: AutotuneLogInput,
    hz: number,
    analysis: AnalysisProvenance,
    sweep: SweepInfo,
): RecordingAverageClaim | null {
    const n = sweepAverages(hz, analysis, sweep, analysis.windowSamples);
    if (n < 1) return null;
    return {
        id: `${log.sha256}:${log.logIndex}`,
        sha256: log.sha256,
        logIndex: log.logIndex,
        hz,
        averages: n,
        contentKey: claimContentKey(log.sha256),
    };
}

/**
 * Sum whole-segment averages at one frequency across claims. Duplicate sample identity (sha256)
 * is counted once. Independent recordings with identical acquisition settings still sum.
 * Callers must only pass claims that already passed identity / config checks.
 */
export function aggregateAverageClaims(hz: number, claims: RecordingAverageClaim[]): AggregateAveragesResult {
    const rejected: string[] = [];
    const seenSha = new Set<string>();
    let sum = 0;
    const contributors: string[] = [];
    for (const c of claims) {
        if (c.hz !== hz) {
            rejected.push(`frequency_mismatch:${c.id}:${c.hz}`);
            continue;
        }
        if (seenSha.has(c.sha256)) {
            rejected.push(`duplicate_sha256:${c.id}`);
            continue;
        }
        if (!(Number.isInteger(c.averages) && c.averages >= 1)) {
            rejected.push(`non_positive_averages:${c.id}`);
            continue;
        }
        seenSha.add(c.sha256);
        sum += c.averages;
        contributors.push(c.id);
    }
    return { hz, averages: sum, contributors, rejected };
}

/**
 * Whether `other` may contribute averages toward the same craft measurement as `primary`.
 * Uses the production cross-log identity rules; returns reasons when not.
 * `pool` is the full set of candidate others so peer duplicates linked through overlapping
 * fragments are visible to `crossLogReferenceIssues` (Grokbot local review P1, 2026-10-30).
 */
export function multiRecordingIssues(
    primary: AutotuneLogInput,
    other: AutotuneLogInput,
    pool: readonly AutotuneLogInput[] = [],
): string[] {
    if (primary.sha256 === other.sha256 && primary.logIndex === other.logIndex) {
        return ["multi_recording_same_log"];
    }
    const rel = flightRelation(primary, other);
    if (rel.relation !== "INDEPENDENT") {
        return rel.reasons.map((r) => `multi_recording_not_independent:${r}`);
    }
    return crossLogReferenceIssues(primary, other, pool).map((r) => `multi_recording_rejected:${r}`);
}

/** Stable order so contributor selection does not depend on import order. */
function byRecordingId(a: AutotuneLogInput, b: AutotuneLogInput): number {
    return a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : a.logIndex - b.logIndex;
}

/**
 * The other recordings that may stand beside the primary on this axis: an independent flight of the
 * same craft, firmware and configuration whose measurement of the axis was not rejected, and not the
 * primary's or a kept peer's measurement again.
 */
export function eligibleRecordings(
    primary: AutotuneLogInput,
    others: readonly AutotuneLogInput[],
    axis: "roll" | "pitch" | "yaw",
): { eligible: AutotuneLogInput[]; rejected: string[] } {
    // Same underlying measurement support counts at most once: peer sameFlight / bit-identical FRF
    // against primary or an already-kept peer (Grokbot P1: B + B′ must not double averages).
    const eligible: AutotuneLogInput[] = [];
    const rejected: string[] = [];
    const pool = others;
    for (const other of [...others].sort(byRecordingId)) {
        const issues = multiRecordingIssues(primary, other, pool);
        if (issues.length) {
            rejected.push(...issues.map((r) => `${r}:${other.sha256}:${other.logIndex}`));
            continue;
        }
        const chirp = other.chirp[axis];
        if (!chirp || chirp.state === "rejected" || !chirp.analysis) {
            rejected.push(`multi_recording_axis_unusable:${axis}:${other.sha256}:${other.logIndex}`);
            continue;
        }
        const primaryChirp = primary.chirp[axis];
        if (primaryChirp && transferFunctionValuesIdentical(primaryChirp.tf, chirp.tf)) {
            rejected.push(`multi_recording_identical_measurement:${other.sha256}:${other.logIndex}`);
            continue;
        }
        const peerFlight = eligible.find((kept) => sameFlight(kept, other));
        if (peerFlight) {
            rejected.push(
                `multi_recording_duplicate_peer:${other.sha256}:${other.logIndex}:of:${peerFlight.sha256}:${peerFlight.logIndex}`,
            );
            continue;
        }
        const peerTf = eligible.find((kept) => {
            const kc = kept.chirp[axis];
            return !!kc && transferFunctionValuesIdentical(kc.tf, chirp.tf);
        });
        if (peerTf) {
            rejected.push(
                `multi_recording_identical_peer_measurement:${other.sha256}:${other.logIndex}:of:${peerTf.sha256}:${peerTf.logIndex}`,
            );
            continue;
        }
        eligible.push(other);
    }
    return { eligible, rejected };
}

/** Sweep from Betaflight chirp headers (deci-Hz start/end + duration), same contract as the engine. */
export function otherSweep(log: AutotuneLogInput): SweepInfo | null {
    const h = new Map(log.headerPairs);
    const f0 = Number(h.get("chirp_frequency_start_deci_hz"));
    const f1 = Number(h.get("chirp_frequency_end_deci_hz"));
    const durationS = Number(h.get("chirp_time_seconds"));
    if (!(Number.isFinite(f0) && Number.isFinite(f1) && Number.isFinite(durationS))) return null;
    if (!(f1 > f0 && f0 > 0 && durationS > 0)) return null;
    return { f0Hz: f0 / 10, f1Hz: f1 / 10, durationS };
}

/**
 * Agreement between independent recordings of one axis (block 8). An average from another flight
 * describes the primary's estimate only where the two flights measured the same thing: per bin,
 * |H_a − H_b| / √((ε_a|H_a|)² + (ε_b|H_b|)²) with each flight's own ε = √((1−γ²)/(2nγ²))
 * (Bendat & Piersol, H1 random error; n its own whole-segment averages) at most `maxBinZ` (the
 * coverage factor the uncertainty bound uses, UNCERTAINTY.coverage), and over the axis the median
 * of that statistic on the bins both identify at most `maxAxisMedianZ` (the experimental
 * cross-flight threshold of the JIO route, JIO_SWEEP.repeatZThreshold: ≈ 1 for the same loop twice).
 */
export const RECORDING_AGREEMENT = Object.freeze({ maxBinZ: 2, maxAxisMedianZ: 2.0, minCommonBins: 5 });

/** How one bin of the combined estimate was formed. */
export type CombinedBinUse =
    /** The primary and the other flights that agree with it there: values weighted by their averages, averages summed. */
    | "pooled"
    /**
     * The primary has no testable estimate (γ² below the loop minimum, or no whole-segment averages) and
     * the other flights that identify the bin agree among themselves: their values, pooled by averages.
     */
    | "other_flight"
    /** The primary identifies the bin with its averages and every other flight there disagrees: the primary's values. */
    | "disagree_primary_kept"
    /**
     * The primary has no testable estimate and the other flights that identify the bin disagree among
     * themselves or cannot be compared (an average count unknown): nothing taken, the primary's values.
     */
    | "others_disagree"
    /** The primary is below the loop minimum and no consistent other flight identifies the bin. */
    | "not_filled";

export interface CombinedBin {
    frequencyHz: number;
    use: CombinedBinUse;
    /** γ² of the primary and the lowest γ² of the other flights at this bin. */
    coherence: [number, number];
    /** The largest agreement statistic computed at this bin (null where none could be computed). */
    z: number | null;
    /** The other flights whose values are in this bin ("sha256:logIndex"). */
    flights: string[];
    /** The other flights that disagreed here (or could not be compared) and are not in it. */
    disagreeing: string[];
}

export interface RecordingCombination {
    axis: "roll" | "pitch" | "yaw";
    /** The other recordings that took part ("sha256:logIndex"). */
    contributors: string[];
    rejected: string[];
    /** Median per-bin z over the bins both flights identify; null with fewer than minCommonBins. */
    medianZ: number | null;
    commonBins: number;
    /**
     * true: at least one other flight measured the same loop (median z within maxAxisMedianZ against the
     * primary's own measurement); false: none did and one disagreed; null: agreement not shown.
     */
    consistent: boolean | null;
    /** Each other flight on its own: compared with the primary's own measurement, never with the combination. */
    flights: {
        id: string;
        medianZ: number | null;
        commonBins: number;
        verdict: "used" | "consistent_unused" | "disagrees" | "too_few_common_bins" | "grid_differs";
    }[];
    /** The bins this combination changed or deliberately left alone (the primary's other bins are unchanged). */
    bins: CombinedBin[];
    /** The combined estimate on the primary's grid (null when nothing was combined). */
    tf: TransferFunction | null;
    /** Whole-segment averages behind each changed bin (every estimate pooled into it). */
    averagesByHz: Map<number, number>;
    /** The primary's per-bin support; a bin taken from other flights carries their most conservative verdict. */
    support: FrequencySupport | null;
}

function relErrOf(g2: number, n: number): number {
    if (!(g2 > 0) || !(n >= 1)) return Infinity;
    const c = Math.min(g2, 1);
    return Math.sqrt((1 - c) / (2 * n * c));
}

export interface RecordingRung {
    log: AutotuneLogInput;
    tf: TransferFunction;
    analysis: AnalysisProvenance;
    sweep: SweepInfo;
    support: FrequencySupport | null;
}

/**
 * The primary's chosen analysis combined with the same analysis (same segment length and sample
 * rate, so the same frequency grid) of independent recordings of this axis. Nothing is interpolated
 * and no recording is concatenated. Each flight is first judged over the axis against the primary's
 * own measurement; then, per bin and over all consistent flights at once (so their order changes
 * nothing): pooled with the primary where they agree with its value, taken from the other flights
 * only where the primary has no testable estimate and they identify the bin (excitation not shown
 * absent, the loop's own support rule) and agree among themselves, and otherwise left as the primary
 * measured it. `minCoherence` is the loop's own minimum (LOOP_MIN_COHERENCE).
 */
export function combineRecordings(
    axis: "roll" | "pitch" | "yaw",
    primary: RecordingRung,
    others: readonly RecordingRung[],
    minCoherence: number,
): RecordingCombination {
    const out: RecordingCombination = {
        axis,
        contributors: [],
        rejected: [],
        medianZ: null,
        commonBins: 0,
        consistent: null,
        flights: [],
        bins: [],
        tf: null,
        averagesByHz: new Map(),
        support: null,
    };
    const support: FrequencySupport | null = primary.support
        ? { observedHz: primary.support.observedHz, bins: new Map(primary.support.bins) }
        : null;
    const p = primary.tf;
    const n = p.frequencies.length;
    // The combined estimate: starts as the primary's own measurement.
    const tf: TransferFunction = {
        frequencies: p.frequencies,
        magnitude: Float64Array.from(p.magnitude),
        phase: Float64Array.from(p.phase),
        coherence: Float64Array.from(p.coherence),
        hReal: Float64Array.from(p.hReal),
        hImag: Float64Array.from(p.hImag),
        numSegments: p.numSegments,
    };
    // The primary's own whole-segment averages.
    const nOwn = new Float64Array(n);
    for (let k = 0; k < n; k++) {
        const f = p.frequencies[k];
        nOwn[k] = f > 0 ? sweepAverages(f, primary.analysis, primary.sweep, primary.analysis.windowSamples) : 0;
    }
    // The primary's own bin by the loop's rules: coherence at the minimum, excitation not shown absent.
    const ownOk = (k: number) =>
        p.coherence[k] >= minCoherence && primary.support?.bins.get(p.frequencies[k])?.verdict !== "UNSUPPORTED";
    const byBin = new Map<number, CombinedBin>();
    // z between two estimates of one bin, each with its own γ² and averages (null: an average count unknown).
    const zOf = (
        aRe: number,
        aIm: number,
        aG2: number,
        aN: number,
        bRe: number,
        bIm: number,
        bG2: number,
        bN: number,
    ) => {
        if (!(aN >= 1 && bN >= 1)) return null;
        const ea = relErrOf(aG2, aN) * Math.hypot(aRe, aIm);
        const eb = relErrOf(bG2, bN) * Math.hypot(bRe, bIm);
        const s = Math.hypot(ea, eb);
        return Number.isFinite(s) && s > 0 ? Math.hypot(aRe - bRe, aIm - bIm) / s : null;
    };

    // Pass 1, per flight: consistency over the axis against the primary's OWN measurement, on the bins
    // both identify. Each flight is judged on its own, so no flight's verdict depends on another's.
    interface Gated {
        id: string;
        o: TransferFunction;
        support: FrequencySupport;
        nO: Float64Array;
        ok: Uint8Array;
        used: boolean;
    }
    const gated: Gated[] = [];
    const verdictAt = new Map<string, number>();
    for (const other of [...others].sort((a, b) => byRecordingId(a.log, b.log))) {
        const id = `${other.log.sha256}:${other.log.logIndex}`;
        const o = other.tf;
        if (
            other.analysis.segmentSamples !== primary.analysis.segmentSamples ||
            other.analysis.sampleRateHz !== primary.analysis.sampleRateHz ||
            o.frequencies.length !== n ||
            o.frequencies.some((f, k) => f !== p.frequencies[k])
        ) {
            out.rejected.push(`multi_recording_grid_differs:${axis}:${id}`);
            out.flights.push({ id, medianZ: null, commonBins: 0, verdict: "grid_differs" });
            continue;
        }
        const nO = new Float64Array(n);
        const ok = new Uint8Array(n);
        for (let k = 0; k < n; k++) {
            const f = o.frequencies[k];
            nO[k] = f > 0 ? sweepAverages(f, other.analysis, other.sweep, other.analysis.windowSamples) : 0;
            // The loop's own rule (loopModel binsDroppedForSupport): a bin whose excitation was shown
            // absent is left out; without any support evidence the other flight fills nothing.
            ok[k] =
                f > 0 &&
                o.coherence[k] >= minCoherence &&
                !!other.support &&
                other.support.bins.get(f)?.verdict !== "UNSUPPORTED"
                    ? 1
                    : 0;
        }
        const zs: number[] = [];
        for (let k = 0; k < n; k++) {
            if (!(p.frequencies[k] > 0) || !ownOk(k) || !ok[k]) continue;
            const z = zOf(
                p.hReal[k],
                p.hImag[k],
                p.coherence[k],
                nOwn[k],
                o.hReal[k],
                o.hImag[k],
                o.coherence[k],
                nO[k],
            );
            if (z !== null) zs.push(z);
        }
        zs.sort((a, b) => a - b);
        const median = zs.length >= RECORDING_AGREEMENT.minCommonBins ? zs[Math.floor(zs.length / 2)] : null;
        if (median === null) {
            out.rejected.push(`multi_recording_too_few_common_bins:${axis}:${zs.length}:${id}`);
            out.flights.push({ id, medianZ: null, commonBins: zs.length, verdict: "too_few_common_bins" });
            continue;
        }
        if (median > RECORDING_AGREEMENT.maxAxisMedianZ) {
            out.rejected.push(
                `multi_recording_flights_disagree:${axis}:median_z:${median.toFixed(2)}>${RECORDING_AGREEMENT.maxAxisMedianZ}:${id}`,
            );
            out.flights.push({ id, medianZ: median, commonBins: zs.length, verdict: "disagrees" });
            continue;
        }
        verdictAt.set(id, out.flights.length);
        out.flights.push({ id, medianZ: median, commonBins: zs.length, verdict: "consistent_unused" });
        gated.push({ id, o, support: other.support!, nO, ok, used: false });
    }

    // Pass 2, per bin, over the whole set of consistent flights at once: the result is the same in
    // any order (block 8 review round 2). Pooling is an averages-weighted mean, which no order changes.
    const RANK: Record<string, number> = { UNSUPPORTED: 0, UNKNOWN: 1, SUPPORTED: 2 };
    let changed = false;
    for (let k = 0; k < n; k++) {
        const f = p.frequencies[k];
        if (!(f > 0) || !gated.length) continue;
        const here = gated.filter((g) => g.ok[k]);
        const lowestOther = (gs: Gated[]) => Math.min(...gs.map((g) => g.o.coherence[k]));
        const pool = (gs: Gated[], withPrimary: boolean) => {
            let w = withPrimary ? nOwn[k] : 0;
            let re = withPrimary ? nOwn[k] * p.hReal[k] : 0;
            let im = withPrimary ? nOwn[k] * p.hImag[k] : 0;
            let g2 = withPrimary ? nOwn[k] * p.coherence[k] : 0;
            // Summed in an order the values fix (not the recording ids), so the result is bit-identical in any order.
            const byValue = [...gs].sort(
                (x, y) => x.o.hReal[k] - y.o.hReal[k] || x.o.hImag[k] - y.o.hImag[k] || x.nO[k] - y.nO[k],
            );
            for (const g of byValue) {
                w += g.nO[k];
                re += g.nO[k] * g.o.hReal[k];
                im += g.nO[k] * g.o.hImag[k];
                g2 += g.nO[k] * g.o.coherence[k];
            }
            // An approximation: the averages-weighted mean of the coherences stands for the pooled
            // estimate's (the H1 random error ε = √((1−γ²)/(2nγ²)) is then read with the summed n). The
            // exact pooled coherence needs every flight's auto- and cross-spectra, which the rung does not keep.
            tf.hReal[k] = re / w;
            tf.hImag[k] = im / w;
            tf.coherence[k] = g2 / w;
            tf.magnitude[k] = 20 * Math.log10(Math.hypot(tf.hReal[k], tf.hImag[k]));
            tf.phase[k] = (Math.atan2(tf.hImag[k], tf.hReal[k]) * 180) / Math.PI;
            out.averagesByHz.set(f, w);
            for (const g of gs) g.used = true;
            changed = true;
        };
        const mark = (use: CombinedBinUse, gs: Gated[], z: number | null, disagreeing: Gated[] = []) =>
            byBin.set(f, {
                frequencyHz: f,
                use,
                coherence: [p.coherence[k], gs.length ? lowestOther(gs) : lowestOther(here)],
                z,
                flights: gs.map((g) => g.id),
                disagreeing: disagreeing.map((g) => g.id),
            });

        if (ownOk(k) && nOwn[k] >= 1) {
            // The primary identifies the bin with its own averages: each flight against that value.
            const agree: Gated[] = [];
            const disagree: Gated[] = [];
            let zMax: number | null = null;
            for (const g of here) {
                const z = zOf(
                    p.hReal[k],
                    p.hImag[k],
                    p.coherence[k],
                    nOwn[k],
                    g.o.hReal[k],
                    g.o.hImag[k],
                    g.o.coherence[k],
                    g.nO[k],
                );
                if (z === null) continue;
                if (z > RECORDING_AGREEMENT.maxBinZ) disagree.push(g);
                else agree.push(g);
                zMax = Math.max(zMax ?? 0, z);
            }
            if (agree.length) {
                pool(agree, true);
                mark("pooled", agree, zMax, disagree);
            } else if (disagree.length) mark("disagree_primary_kept", [], zMax, disagree);
            continue;
        }

        // The primary has no testable estimate here (below the loop minimum, or without whole-segment
        // averages): only the other flights can supply it, and only when they agree among themselves.
        if (!here.length) {
            if (!ownOk(k)) mark("not_filled", [], null);
            continue;
        }
        const counted = here.filter((g) => g.nO[k] >= 1);
        if (!counted.length && ownOk(k)) continue; // nothing better supported than the primary's own value
        const set = counted.length ? counted : here;
        let zMax: number | null = null;
        let comparable = true;
        let agreeing = true;
        for (let i = 0; i < set.length; i++)
            for (let j = i + 1; j < set.length; j++) {
                const a = set[i];
                const b = set[j];
                const z = zOf(
                    a.o.hReal[k],
                    a.o.hImag[k],
                    a.o.coherence[k],
                    a.nO[k],
                    b.o.hReal[k],
                    b.o.hImag[k],
                    b.o.coherence[k],
                    b.nO[k],
                );
                if (z === null) comparable = false;
                else {
                    zMax = Math.max(zMax ?? 0, z);
                    if (z > RECORDING_AGREEMENT.maxBinZ) agreeing = false;
                }
            }
        if (!comparable || !agreeing) {
            // Two flights that disagree here, or cannot be compared, decide nothing: no flight is preferred.
            mark("others_disagree", [], zMax, set);
            continue;
        }
        if (set.length === 1) {
            // One flight: its values as measured, with its own averages (0: unknown below one segment).
            const g = set[0];
            tf.hReal[k] = g.o.hReal[k];
            tf.hImag[k] = g.o.hImag[k];
            tf.coherence[k] = g.o.coherence[k];
            tf.magnitude[k] = g.o.magnitude[k];
            tf.phase[k] = g.o.phase[k];
            out.averagesByHz.set(f, g.nO[k]);
            g.used = true;
            changed = true;
        } else pool(set, false);
        mark("other_flight", set, zMax);
        // The bin's values are the other flights': their support evidence goes with them, the most
        // conservative verdict among them (then the lowest excitation coherence), whatever their order.
        if (support) {
            const bins = set.map((g) => g.support.bins.get(f));
            if (bins.some((b) => !b)) support.bins.delete(f);
            else {
                const pick = [...bins].sort(
                    (a, b) =>
                        (RANK[a!.verdict] ?? 0) - (RANK[b!.verdict] ?? 0) ||
                        (a!.excitationCoherence ?? -1) - (b!.excitationCoherence ?? -1),
                )[0]!;
                support.bins.set(f, pick);
            }
        }
    }
    for (const g of gated) {
        if (!g.used) continue;
        out.flights[verdictAt.get(g.id)!].verdict = "used";
        out.contributors.push(g.id);
    }
    // Per flight above; the summary: combined when any flight took part, disagreeing when one disagreed
    // and none took part, unknown otherwise. The median reported is the largest of the flights used.
    const usedFlights = out.flights.filter((x) => x.verdict === "used" || x.verdict === "consistent_unused");
    out.consistent = out.contributors.length
        ? true
        : out.flights.some((x) => x.verdict === "disagrees")
          ? false
          : usedFlights.length
            ? true
            : null;
    const shown = usedFlights.length ? usedFlights : out.flights.filter((x) => x.medianZ !== null);
    out.medianZ = shown.length ? Math.max(...shown.map((x) => x.medianZ!)) : null;
    out.commonBins = shown.length
        ? Math.min(...shown.map((x) => x.commonBins))
        : Math.max(0, ...out.flights.map((x) => x.commonBins));
    out.bins = [...byBin.values()].sort((a, b) => a.frequencyHz - b.frequencyHz);
    out.tf = changed ? tf : null;
    out.support = changed ? support : null;
    return out;
}
