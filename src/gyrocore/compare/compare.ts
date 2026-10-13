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
 * The cross-flight comparison engine (docs/gyrocore/CROSS_FLIGHT_COMPARISON.md).
 * Pure and read-only: it re-runs WU4 abVerification (WU3 flightPairEvidence,
 * WU1 checkIndependentFlights) for the session and selection it is given, and
 * only an ELIGIBLE pair gets any measurement compared. Numbers come from the
 * stored Quality V2 reports as Betaflight computed them; nothing is
 * re-analysed, interpolated, resampled or matched to a nearest bin.
 */

import { AXIS_NAMES, type ChirpAxisName } from "../chirp/constants";
import type { BinStatus, ChirpQualityV2, Metric, QualityTopic } from "../chirp/qualityV2/contract";
import type { LoadResult, StoredChirp, StoredFlight } from "../session/contract";
import { abVerification, sessionFlights, type AbSelection } from "../session/selection";
import { compareConfig, configBlockers } from "./config";
import {
    CMP_REASONS as R,
    CROSS_FLIGHT_AUTHORIZATION,
    REPEATABILITY_NOT_ESTABLISHED,
    type AxisComparison,
    type BinComparison,
    type ChirpPairComparison,
    type ChirpRef,
    type ComparisonDiagnostics,
    type ConfigComparison,
    type CrossFlightComparison,
    type DeltaSummary,
    type QualityRowComparison,
    type QualityValue,
} from "./contract";

type Side = "a" | "b";

const BIN_STATUSES: readonly BinStatus[] = ["USABLE", "WEAK_COHERENCE", "NO_INPUT_POWER", "OUTSIDE_ANALYSIS_BAND"];
const QUALIFIED_STATES = ["usable", "usable_with_warnings"];

/** A copy per result, so a caller that edits one result cannot widen the next. */
function notAuthorized(): typeof CROSS_FLIGHT_AUTHORIZATION {
    return { status: CROSS_FLIGHT_AUTHORIZATION.status, reasons: [...CROSS_FLIGHT_AUTHORIZATION.reasons] } as never;
}

function notEstablished(): typeof REPEATABILITY_NOT_ESTABLISHED {
    return {
        status: REPEATABILITY_NOT_ESTABLISHED.status,
        reasons: [...REPEATABILITY_NOT_ESTABLISHED.reasons],
    } as never;
}

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

// ---------------------------------------------------------------------------
// Quality, side by side

function metricValue(m: Metric<number> | undefined, verdict: QualityValue["verdict"]): QualityValue {
    const measured = m?.availability === "MEASURED" && finite(m.value);
    return {
        availability: m?.availability ?? "UNAVAILABLE",
        role: m?.role ?? null,
        // A value that is not MEASURED is never shown as one.
        value: measured ? (m.value as number) : null,
        unit: m?.unit ?? null,
        verdict,
    };
}

function plainValue(
    value: number | string | null,
    verdict: QualityValue["verdict"] = null,
    unit: string | null = null,
) {
    const ok = typeof value === "string" || finite(value);
    return {
        availability: ok ? "MEASURED" : "UNAVAILABLE",
        role: null,
        value: ok ? value : null,
        unit,
        verdict,
    } satisfies QualityValue;
}

function qualityValues(c: StoredChirp): Record<string, QualityValue> {
    const q = c.qualityV2;
    const verdict = (topic: QualityTopic) => q?.verdicts?.[topic]?.verdict ?? null;
    const usable = q?.sweep?.usable;
    const usableMeasured = usable?.availability === "MEASURED";
    const gaps = q?.sampleGaps;
    const gapsMeasured = gaps?.availability === "MEASURED";
    return {
        qualification: { ...plainValue(c.qualification?.state ?? null), role: "ACTIVE_GATE" },
        analysisVersion: plainValue(typeof q?.analysisVersion === "string" ? q.analysisVersion : null),
        meanBandCoherence: metricValue(q?.coherence?.meanBandCoherence, verdict("coherence")),
        usableBins: metricValue(q?.coherence?.usableBinCount, verdict("usableBins")),
        usableStartHz: {
            availability: usable?.availability ?? "UNAVAILABLE",
            role: usable?.role ?? null,
            value: usableMeasured && finite(usable.startHz) ? usable.startHz : null,
            unit: "Hz",
            verdict: null,
        },
        usableEndHz: {
            availability: usable?.availability ?? "UNAVAILABLE",
            role: usable?.role ?? null,
            value: usableMeasured && finite(usable.endHz) ? usable.endHz : null,
            unit: "Hz",
            verdict: null,
        },
        sampleGaps: {
            availability: gaps?.availability ?? "UNAVAILABLE",
            role: gaps?.role ?? null,
            value: gaps?.status ?? null,
            unit: null,
            verdict: verdict("sampleGaps"),
        },
        missingSamples: {
            availability: gaps?.availability ?? "UNAVAILABLE",
            role: gaps?.role ?? null,
            value: gapsMeasured && finite(gaps.missingSamplesEstimate) ? gaps.missingSamplesEstimate : null,
            unit: "samples",
            verdict: null,
        },
        missingFraction: {
            availability: gaps?.availability ?? "UNAVAILABLE",
            role: gaps?.role ?? null,
            value: gapsMeasured && finite(gaps.missingFraction) ? gaps.missingFraction : null,
            unit: null,
            verdict: null,
        },
        setpointRms: metricValue(q?.excitation?.setpointRms, verdict("excitation")),
        sweep: { ...plainValue(q?.sweep?.observed?.availability ?? null, verdict("sweep")), role: "DIAGNOSTIC" },
        saturation: {
            availability: q?.saturation ? "MEASURED" : "UNAVAILABLE",
            role: q?.saturation?.role ?? null,
            value: q?.saturation?.status ?? null,
            unit: null,
            verdict: verdict("saturation"),
        },
        contamination: {
            availability: q?.contamination?.availability ?? "UNAVAILABLE",
            role: q?.contamination?.role ?? null,
            value: q?.contamination?.status ?? null,
            unit: null,
            verdict: verdict("contamination"),
        },
        warningGates: plainValue(
            Array.isArray(c.qualification?.warningGates) ? c.qualification.warningGates.join(", ") : null,
        ),
        sampleRateHz: plainValue(q?.provenance?.sampleRateHz ?? null, null, "Hz"),
        welchSegments: plainValue(q?.provenance?.welchSegments ?? null),
    };
}

export const QUALITY_ROW_ORDER = [
    "qualification",
    "analysisVersion",
    "meanBandCoherence",
    "usableBins",
    "usableStartHz",
    "usableEndHz",
    "sampleGaps",
    "missingSamples",
    "missingFraction",
    "setpointRms",
    "sweep",
    "saturation",
    "contamination",
    "warningGates",
    "sampleRateHz",
    "welchSegments",
] as const;

function qualityRows(a: StoredChirp | null, b: StoredChirp | null): QualityRowComparison[] {
    const va = a ? qualityValues(a) : null;
    const vb = b ? qualityValues(b) : null;
    return QUALITY_ROW_ORDER.map((id) => ({ id, a: va?.[id] ?? null, b: vb?.[id] ?? null }));
}

// ---------------------------------------------------------------------------
// Checks before any per-bin difference

function chirpRef(c: StoredChirp): ChirpRef {
    return {
        measurementId: c.measurementId,
        axisName: c.axisName,
        axisOccurrence: c.axisOccurrence,
        qualificationState: c.qualification?.state,
        analysisVersion: String(c.qualityV2?.analysisVersion),
    };
}

/** The CHIRP's own fields and its Quality V2 identity must name the same axis and occurrence. */
function identityProblems(c: StoredChirp, side: Side): string[] {
    const id = c.qualityV2?.identity;
    const axisIndex = (AXIS_NAMES as readonly string[]).indexOf(c.axisName);
    const ok =
        axisIndex >= 0 &&
        c.axis === axisIndex &&
        id?.axis === c.axis &&
        id?.axisName === c.axisName &&
        id?.axisOccurrence === c.axisOccurrence &&
        id?.measurementId === c.measurementId &&
        Number.isInteger(c.axisOccurrence) &&
        c.axisOccurrence >= 1;
    return ok ? [] : [`${R.identityContradiction}:${side}`];
}

function qualificationProblems(c: StoredChirp, side: Side): string[] {
    const out: string[] = [];
    const q = c.qualityV2;
    if (!QUALIFIED_STATES.includes(c.qualification?.state)) {
        out.push(`${R.notQualified}:${side}`);
    }
    if (q?.levels?.chirpQualified?.status !== "YES") {
        out.push(`${R.notQualified}:${side}:quality_v2_level`);
    }
    // A failed gate cannot sit under a qualified state; contradicting metadata is never read as qualified.
    for (const [topic, v] of Object.entries(q?.verdicts ?? {})) {
        if (v?.verdict === "FAIL") {
            out.push(`${R.notQualified}:${side}:verdict_fail:${topic}`);
        }
    }
    return out;
}

/** Structural problems of the stored per-bin arrays; any one makes the bins unusable for a difference. */
export function binProblems(q: ChirpQualityV2 | undefined): string[] {
    const bins = q?.coherence?.bins;
    if (q?.levels?.chirpQualityAvailable?.status !== "YES" || bins?.availability !== "MEASURED") {
        return [R.qualityUnavailable];
    }
    const { frequencyHz: f, coherence: c, magnitudeDb: m, status: s } = bins;
    if (![f, c, m, s].every(Array.isArray)) {
        return [`${R.binsInvalid}:not_arrays`];
    }
    if (!f.length) {
        return [R.qualityUnavailable];
    }
    if (c.length !== f.length || m.length !== f.length || s.length !== f.length) {
        return [`${R.binsInvalid}:length`];
    }
    const out = new Set<string>();
    const usableMin = q.coherence.criteria?.usableBinCoherenceMin;
    for (let i = 0; i < f.length; i++) {
        if (!finite(f[i]) || f[i] <= 0 || (i > 0 && !(f[i] > f[i - 1]))) {
            out.add(`${R.binsInvalid}:frequency_order`);
        }
        if (!finite(c[i]) || c[i] < 0 || c[i] > 1) {
            out.add(`${R.binsInvalid}:coherence`);
        }
        if (m[i] !== null && !finite(m[i])) {
            out.add(`${R.binsInvalid}:magnitude`);
        }
        if (!BIN_STATUSES.includes(s[i])) {
            out.add(`${R.binsInvalid}:status`);
        } else if (s[i] === "USABLE" && (m[i] === null || !finite(usableMin) || !(c[i] >= usableMin))) {
            // A bin marked usable without a magnitude, or below the stored criterion, contradicts itself.
            out.add(`${R.binsInvalid}:status_contradiction`);
        }
    }
    return [...out];
}

/** Provenance fields that must be equal and known on both sides for bins to be the same quantity. */
function provenanceProblems(qa: ChirpQualityV2, qb: ChirpQualityV2): string[] {
    const out: string[] = [];
    const pa = qa.provenance ?? ({} as ChirpQualityV2["provenance"]);
    const pb = qb.provenance ?? ({} as ChirpQualityV2["provenance"]);
    const fields: [string, unknown, unknown][] = [
        ["decoder", pa.decoder, pb.decoder],
        ["transferFunction", pa.transferFunction, pb.transferFunction],
        ["inputField", pa.inputField, pb.inputField],
        ["outputField", pa.outputField, pb.outputField],
        ["flagGating", pa.flagGating, pb.flagGating],
        ["highResolutionScale", pa.highResolutionScale, pb.highResolutionScale],
        ["sampleRateHz", pa.sampleRateHz, pb.sampleRateHz],
        ["sampleRateSource", pa.sampleRateSource, pb.sampleRateSource],
        ["sampleRateStatus", pa.sampleRateStatus, pb.sampleRateStatus],
        ["segmentSize", pa.segmentSize, pb.segmentSize],
        ["welchOverlap", pa.welchOverlap, pb.welchOverlap],
        ["binWidthHz", pa.binWidthHz, pb.binWidthHz],
        ["bins.binWidthHz", qa.coherence?.bins?.binWidthHz, qb.coherence?.bins?.binWidthHz],
        [
            "powerScale.segmentSize",
            qa.coherence?.bins?.powerScale?.segmentSize,
            qb.coherence?.bins?.powerScale?.segmentSize,
        ],
        [
            "criteria.usableBinCoherenceMin",
            qa.coherence?.criteria?.usableBinCoherenceMin,
            qb.coherence?.criteria?.usableBinCoherenceMin,
        ],
        ["criteria.inputPowerFloor", qa.coherence?.criteria?.inputPowerFloor, qb.coherence?.criteria?.inputPowerFloor],
    ];
    for (const [name, a, b] of fields) {
        const known = (x: unknown) => (typeof x === "string" && x.length > 0) || finite(x);
        if (!known(a) || !known(b)) {
            out.push(`${R.provenanceUnknown}:${name}`);
        } else if (a !== b) {
            out.push(`${R.provenance}:${name}`);
        }
    }
    // A different segment count is a note (pairNotes); an unknown one is not evidence of anything.
    if (!finite(pa.welchSegments) || !finite(pb.welchSegments)) {
        out.push(`${R.provenanceUnknown}:welchSegments`);
    }
    // The bins' segment size is what the transfer function used; it must agree with the logged setting.
    if (finite(pa.segmentSize) && pa.segmentSize !== qa.coherence?.bins?.powerScale?.segmentSize) {
        out.push(`${R.provenance}:segmentSize_inconsistent:a`);
    }
    if (finite(pb.segmentSize) && pb.segmentSize !== qb.coherence?.bins?.powerScale?.segmentSize) {
        out.push(`${R.provenance}:segmentSize_inconsistent:b`);
    }
    return out;
}

/** Facts about a CHIRP that limit a difference without making it invalid. */
function pairNotes(a: StoredChirp, b: StoredChirp): string[] {
    const out: string[] = [];
    for (const [side, c] of [
        ["a", a],
        ["b", b],
    ] as const) {
        if (c.qualityV2.sampleGaps?.status === "DETECTED") {
            out.push(`${R.sampleGapsDetected}:${side}`);
        }
        if (c.qualityV2.saturation?.status === "DETECTED") {
            out.push(`${R.saturationDetected}:${side}`);
        }
        for (const g of Array.isArray(c.qualification.warningGates) ? c.qualification.warningGates : []) {
            out.push(`qualification_warning:${g}:${side}`);
        }
    }
    const wa = a.qualityV2.provenance.welchSegments;
    const wb = b.qualityV2.provenance.welchSegments;
    if (wa !== wb) {
        // More segments average more; the grid is the same, the estimate's variance is not.
        out.push(`${R.welchSegmentsDiffer}:${wa}:${wb}`);
    }
    const ba = a.qualityV2.sweep?.analysisBandHz;
    const bb = b.qualityV2.sweep?.analysisBandHz;
    if (JSON.stringify(ba) !== JSON.stringify(bb)) {
        out.push("analysis_band_differs");
    }
    return out;
}

// ---------------------------------------------------------------------------
// Per-bin differences

const hasInput = (s: BinStatus) => s === "USABLE" || s === "WEAK_COHERENCE";

function binComparison(qa: ChirpQualityV2, qb: ChirpQualityV2): BinComparison | string {
    const A = qa.coherence.bins;
    const B = qb.coherence.bins;
    const n = Math.min(A.frequencyHz.length, B.frequencyHz.length);
    for (let i = 0; i < n; i++) {
        // Exact equality: the same rate and segment size give bit-identical k * fs / N.
        if (A.frequencyHz[i] !== B.frequencyHz[i]) {
            return R.gridMismatch;
        }
    }
    const out: BinComparison = {
        frequencyHz: A.frequencyHz.slice(0, n),
        magnitudeDbA: A.magnitudeDb.slice(0, n),
        magnitudeDbB: B.magnitudeDb.slice(0, n),
        magnitudeDeltaDb: [],
        coherenceA: A.coherence.slice(0, n),
        coherenceB: B.coherence.slice(0, n),
        coherenceDelta: [],
        statusA: A.status.slice(0, n),
        statusB: B.status.slice(0, n),
        unmatchedBinsA: A.frequencyHz.length - n,
        unmatchedBinsB: B.frequencyHz.length - n,
    };
    for (let i = 0; i < n; i++) {
        const ma = A.magnitudeDb[i];
        const mb = B.magnitudeDb[i];
        out.magnitudeDeltaDb.push(
            A.status[i] === "USABLE" && B.status[i] === "USABLE" && finite(ma) && finite(mb) ? mb - ma : null,
        );
        out.coherenceDelta.push(
            hasInput(A.status[i]) && hasInput(B.status[i]) ? B.coherence[i] - A.coherence[i] : null,
        );
    }
    return out;
}

export function deltaSummary(frequencyHz: number[], delta: (number | null)[]): DeltaSummary {
    const s: DeltaSummary = {
        binCount: 0,
        fromHz: null,
        toHz: null,
        min: null,
        minAtHz: null,
        max: null,
        maxAtHz: null,
        meanAbs: null,
    };
    let sumAbs = 0;
    delta.forEach((d, i) => {
        if (d === null) {
            return;
        }
        s.binCount++;
        s.fromHz ??= frequencyHz[i];
        s.toHz = frequencyHz[i];
        if (s.min === null || d < s.min) {
            s.min = d;
            s.minAtHz = frequencyHz[i];
        }
        if (s.max === null || d > s.max) {
            s.max = d;
            s.maxAtHz = frequencyHz[i];
        }
        sumAbs += Math.abs(d);
    });
    s.meanAbs = s.binCount ? sumAbs / s.binCount : null;
    return s;
}

function comparePair(id: string, a: StoredChirp, b: StoredChirp, configReasons: string[]): ChirpPairComparison {
    const pair: ChirpPairComparison = {
        id,
        axisName: a.axisName,
        axisOccurrence: a.axisOccurrence,
        status: "NOT_COMPARABLE",
        reasons: [],
        notes: [],
        a: chirpRef(a),
        b: chirpRef(b),
        quality: qualityRows(a, b),
        bins: null,
        magnitudeDelta: null,
        coherenceDelta: null,
    };
    const reasons = [
        ...identityProblems(a, "a"),
        ...identityProblems(b, "b"),
        ...qualificationProblems(a, "a"),
        ...qualificationProblems(b, "b"),
        ...binProblems(a.qualityV2).map((p) => `${p}:a`),
        ...binProblems(b.qualityV2).map((p) => `${p}:b`),
    ];
    const va = a.qualityV2?.analysisVersion;
    const vb = b.qualityV2?.analysisVersion;
    if (typeof va !== "string" || va !== vb) {
        reasons.push(R.analysisVersion);
    }
    if (a.qualityV2?.provenance && b.qualityV2?.provenance) {
        reasons.push(...provenanceProblems(a.qualityV2, b.qualityV2));
    } else {
        reasons.push(`${R.provenanceUnknown}:provenance`);
    }
    reasons.push(...configReasons);
    if (reasons.length) {
        pair.reasons = [...new Set(reasons)];
        return pair;
    }
    pair.notes = pairNotes(a, b);
    const bins = binComparison(a.qualityV2, b.qualityV2);
    if (typeof bins === "string") {
        pair.reasons = [bins];
        return pair;
    }
    const magnitudeDelta = deltaSummary(bins.frequencyHz, bins.magnitudeDeltaDb);
    const coherenceDelta = deltaSummary(bins.frequencyHz, bins.coherenceDelta);
    if (!magnitudeDelta.binCount && !coherenceDelta.binCount) {
        pair.reasons = [R.noSharedBins];
        return pair;
    }
    if (!magnitudeDelta.binCount) {
        pair.notes.push("no_shared_usable_magnitude_bins");
    }
    return { ...pair, status: "COMPARED", bins, magnitudeDelta, coherenceDelta };
}

function lonePair(id: string, axisName: ChirpAxisName, occ: number, a: StoredChirp | null, b: StoredChirp | null) {
    return {
        id,
        axisName,
        axisOccurrence: occ,
        status: "UNPAIRED",
        reasons: [a ? R.onlyInA : R.onlyInB],
        notes: [],
        a: a ? chirpRef(a) : null,
        b: b ? chirpRef(b) : null,
        quality: qualityRows(a, b),
        bins: null,
        magnitudeDelta: null,
        coherenceDelta: null,
    } satisfies ChirpPairComparison;
}

const validOccurrence = (c: StoredChirp) => Number.isInteger(c.axisOccurrence) && c.axisOccurrence >= 1;

/** CHIRPs of one axis, paired by axisOccurrence; never across axes, never averaged, never picked. */
function compareAxis(axisName: ChirpAxisName, fa: StoredFlight, fb: StoredFlight, config: ConfigComparison) {
    // A CHIRP without a valid occurrence cannot be paired; compareFlights reports it.
    const ca = fa.chirps.filter((c) => c.axisName === axisName && validOccurrence(c));
    const cb = fb.chirps.filter((c) => c.axisName === axisName && validOccurrence(c));
    const occurrences = [...new Set([...ca, ...cb].map((c) => c.axisOccurrence))].sort((x, y) => x - y);
    const blockers = configBlockers(config, axisName);
    const pairs = occurrences.map((occ): ChirpPairComparison => {
        const id = `${axisName}-${occ}`;
        const xa = ca.filter((c) => c.axisOccurrence === occ);
        const xb = cb.filter((c) => c.axisOccurrence === occ);
        if (xa.length > 1 || xb.length > 1) {
            // Two CHIRPs claim one occurrence: which one is meant cannot be told, so neither is used.
            const pair = lonePair(id, axisName, occ, xa.length === 1 ? xa[0] : null, xb.length === 1 ? xb[0] : null);
            return {
                ...pair,
                status: "NOT_COMPARABLE",
                reasons: [
                    ...(xa.length > 1 ? [`${R.duplicateOccurrence}:a`] : []),
                    ...(xb.length > 1 ? [`${R.duplicateOccurrence}:b`] : []),
                ],
            };
        }
        if (!xa.length || !xb.length) {
            return lonePair(id, axisName, occ, xa[0] ?? null, xb[0] ?? null);
        }
        return comparePair(id, xa[0], xb[0], blockers);
    });
    return { axisName, chirpsA: ca.length, chirpsB: cb.length, pairs } satisfies AxisComparison;
}

// ---------------------------------------------------------------------------

function diagnostics(
    axes: AxisComparison[],
    config: ConfigComparison,
    a: StoredFlight,
    b: StoredFlight,
    extraMissing: string[],
): ComparisonDiagnostics {
    const pairs = axes.flatMap((x) => x.pairs);
    const compared = pairs.filter((p) => p.status === "COMPARED");
    const chirps = [...a.chirps, ...b.chirps];
    const qualityLimits = [R.relativePowerNotCalibrated as string];
    if (
        chirps.some(
            (c) =>
                c.qualityV2?.contamination?.status !== "DETECTED" &&
                c.qualityV2?.contamination?.status !== "NOT_DETECTED",
        )
    ) {
        qualityLimits.push(R.contaminationUnknown);
    }
    if (chirps.some((c) => c.qualityV2?.saturation?.gyroClipping?.availability !== "MEASURED")) {
        qualityLimits.push(R.gyroClippingUnknown);
    }
    qualityLimits.push(...new Set(compared.flatMap((p) => p.notes.filter((n) => n.startsWith(R.saturationDetected)))));
    const axesMissing = axes.flatMap((x) =>
        !x.chirpsA && !x.chirpsB
            ? [{ axisName: x.axisName, reason: R.axisNotMeasured }]
            : !x.chirpsA || !x.chirpsB
              ? [{ axisName: x.axisName, reason: `${R.axisOnlyInOne}:${x.chirpsA ? "a" : "b"}` }]
              : [],
    );
    return {
        compared: compared.map((p) => p.id),
        notComparable: pairs.filter((p) => p.status !== "COMPARED").map((p) => ({ id: p.id, reasons: p.reasons })),
        axesMissing,
        qualityLimits,
        missingForStrongerConclusions: [
            R.twoFlightsOnly,
            R.noAcceptanceCriteria,
            R.realFlightValidation,
            R.externalConditionsUnknown,
            ...extraMissing,
            ...config.items.filter((i) => i.status === "UNKNOWN").flatMap((i) => i.reasons),
        ].filter((r, i, all) => all.indexOf(r) === i),
    };
}

/**
 * Compare Flight A and B of the loaded session. WU4 decides first: only an
 * ELIGIBLE pair is compared, and even then the result is diagnostic only.
 */
export function compareFlights(load: LoadResult | null, selection: AbSelection): CrossFlightComparison {
    const session = load?.status === "ok" ? load.session : null;
    const ab = abVerification(session, selection);
    const result: CrossFlightComparison = {
        status: "INCOMPLETE",
        abStatus: ab.status,
        sessionId: session?.id ?? null,
        sessionUpdatedAt: session?.updatedAt ?? null,
        keyA: selection.a,
        keyB: selection.b,
        blockers: [],
        missingEvidence: [...ab.missingEvidence],
        ab,
        config: null,
        axes: [],
        diagnostics: null,
        repeatability: notEstablished(),
        authorization: notAuthorized(),
    };
    if (ab.status === "INCOMPLETE") {
        result.blockers = session ? [R.abIncomplete] : [R.sessionNotLoaded, R.abIncomplete];
        return result;
    }
    if (ab.status === "BLOCKED") {
        return { ...result, status: "BLOCKED", blockers: [R.abBlocked, ...ab.blockers] };
    }
    const fa = session!.flights.find((f) => f.key === selection.a)!;
    const fb = session!.flights.find((f) => f.key === selection.b)!;
    // CHIRPs left out on load are reported, never filled in or guessed.
    const options = sessionFlights(load).options;
    const rejectedMissing: string[] = [];
    for (const [side, key] of [
        ["a", selection.a],
        ["b", selection.b],
    ] as const) {
        const n = options.find((o) => o.key === key)?.rejectedChirpCount ?? 0;
        if (n) {
            rejectedMissing.push(`${R.chirpsRejected}:${side}:${n}`);
        }
    }
    const stray = (f: StoredFlight, side: Side) =>
        f.chirps.flatMap((c) =>
            !(AXIS_NAMES as readonly string[]).includes(c.axisName)
                ? [`${R.identityContradiction}:${side}:axis_name`]
                : !validOccurrence(c)
                  ? [`${R.identityContradiction}:${side}:axis_occurrence`]
                  : [],
        );
    const strayChirps = [...stray(fa, "a"), ...stray(fb, "b")];
    const config = compareConfig(fa, fb);
    const axes = AXIS_NAMES.map((axis) => compareAxis(axis, fa, fb, config));
    const extra = [...new Set([...rejectedMissing, ...strayChirps])];
    result.missingEvidence.push(...extra);
    result.blockers = extra;
    result.config = config;
    result.axes = axes;
    result.diagnostics = diagnostics(axes, config, fa, fb, extra);
    result.status = axes.some((x) => x.pairs.some((p) => p.status === "COMPARED")) ? "COMPARED" : "NOT_COMPARABLE";
    return result;
}
