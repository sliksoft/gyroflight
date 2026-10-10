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
 * Exact shapes of the nested records a session stores: the WU1 FlightRef and
 * the Quality V2 report per analysis version. Every object is closed (no field
 * beyond the contract) and every string is short, so file bytes cannot ride
 * along in a stored record under a field nobody reads.
 */

import { FLIGHT_IDENTITY_SCHEMA, IDENTITY_HEADER_KEYS } from "@/gyrocore/flight/identity";
import { AXIS_NAMES } from "../chirp/constants";
import { CHIRP_QUALITY_V2_SCHEMA } from "../chirp/qualityV2/contract";

/** Longest string inside a FlightRef or Quality V2 report: reason codes, field names, header values. */
export const MAX_SHAPE_STRING_CHARS = 1024;

export type Shape = (v: unknown) => boolean;

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export const num: Shape = (v) => typeof v === "number" && Number.isFinite(v);
export const int: Shape = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export const str: Shape = (v) => typeof v === "string" && v.length <= MAX_SHAPE_STRING_CHARS;
export const bool: Shape = (v) => typeof v === "boolean";
export const lit =
    (...values: unknown[]): Shape =>
    (v) =>
        values.includes(v);
export const nullable =
    (s: Shape): Shape =>
    (v) =>
        v === null || s(v);
export const arr =
    (s: Shape): Shape =>
    (v) =>
        Array.isArray(v) && v.every(s);
export const tuple =
    (...shapes: Shape[]): Shape =>
    (v) =>
        Array.isArray(v) && v.length === shapes.length && shapes.every((s, i) => s(v[i]));
/** Exactly these fields, each matching its shape. */
export const obj =
    (fields: Record<string, Shape>): Shape =>
    (v) =>
        isPlainObject(v) &&
        Object.keys(v).length === Object.keys(fields).length &&
        Object.entries(fields).every(([k, s]) => Object.prototype.hasOwnProperty.call(v, k) && s(v[k]));

const strs = arr(str);
const sha256 = (v: unknown) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

export const flightRefShape: Shape = obj({
    schema: lit(FLIGHT_IDENTITY_SCHEMA),
    locationId: str,
    file: obj({ sha256, byteLength: int }),
    logIndex: int,
    logCount: int,
    section: obj({ sha256, byteBegin: int, byteEnd: int }),
    header: obj({
        sha256,
        byteLength: int,
        fields: obj(Object.fromEntries(IDENTITY_HEADER_KEYS.map((k) => [k, nullable(str)]))),
    }),
    bodyPrefix: obj({ sha256, byteLength: int }),
    status: lit("valid", "invalid"),
    reasons: strs,
    timeRangeUs: nullable(obj({ min: num, max: num })),
});

const availability = lit("MEASURED", "UNKNOWN", "UNAVAILABLE", "NOT_APPLICABLE");
const role = lit("DIAGNOSTIC", "ACTIVE_GATE");
const metric = (value: Shape) =>
    obj({ availability, role, value: nullable(value), unit: nullable(str), reasons: strs });
const level = obj({ status: lit("YES", "NO", "UNKNOWN"), role, reasons: strs });
const binStatus = lit("USABLE", "WEAK_COHERENCE", "NO_INPUT_POWER", "OUTSIDE_ANALYSIS_BAND");
const evidenceStatus = lit("DETECTED", "NOT_DETECTED", "UNKNOWN");
const verdict = obj({
    verdict: lit("PASS", "FAIL", "WARNING", "NOT_EVALUATED"),
    basis: lit("EXISTING_GATE", "DOCUMENTED_DIAGNOSTIC", "NONE"),
    codes: strs,
    value: nullable(num),
    threshold: nullable(num),
    comparator: nullable(lit("MIN", "MAX")),
});
const topics = [
    "detection",
    "sweep",
    "coverage",
    "excitation",
    "coherence",
    "usableBins",
    "sampleGaps",
    "contamination",
    "saturation",
];
const sweepRange = { startHz: nullable(num), endHz: nullable(num) };
const sampleFraction = metric(obj({ samples: num, fraction: num }));

const binsShape = obj({
    availability,
    kind: lit("MEASURED_BINS"),
    binWidthHz: nullable(num),
    frequencyHz: arr(num),
    coherence: arr(num),
    magnitudeDb: arr(nullable(num)),
    inputRelativePowerDb: arr(nullable(num)),
    outputRelativePowerDb: arr(nullable(num)),
    powerScale: obj({
        quantity: lit("RELATIVE_SPECTRAL_POWER"),
        isPsd: lit(false),
        definition: lit("mean_over_welch_segments_of_abs_fft_hann_squared"),
        unit: lit("dB re 1 (signal unit)^2"),
        window: lit("hann (betaflight hanningWindow), unnormalised"),
        segmentSize: nullable(num),
        numSegments: nullable(num),
        spectrogramFloorRemoved: num,
    }),
    snrDb: arr(nullable(num)),
    status: arr(binStatus),
    omittedBinCount: int,
    reasons: strs,
});

/** The per-bin arrays are parallel: one entry per bin, all the same length. */
const parallelBins: Shape = (v) => {
    const b = v as Record<string, unknown[]>;
    const n = b.frequencyHz.length;
    return ["coherence", "magnitudeDb", "inputRelativePowerDb", "outputRelativePowerDb", "snrDb", "status"].every(
        (k) => b[k].length === n,
    );
};

const qualityV2_2_1_0: Shape = obj({
    schema: lit(CHIRP_QUALITY_V2_SCHEMA),
    analysisVersion: lit("2.1.0"),
    identity: obj({
        measurementId: str,
        logIndex: int,
        chirpIndex: int,
        axisOccurrence: int,
        axis: int,
        axisName: lit(...AXIS_NAMES),
        startTimeUs: num,
        endTimeUs: num,
        durationS: num,
        sampleCount: int,
        file: obj({ availability, sha256: nullable(sha256), byteLength: nullable(int), reasons: strs }),
        flight: obj({ availability, ref: nullable(flightRefShape), reasons: strs }),
    }),
    provenance: obj({
        decoder: lit("betaflight-blackbox-viewer"),
        transferFunction: lit("betaflight spectral_analysis.welchTransferFunction"),
        relativePowerSpectrum: lit("betaflight spectral_analysis.computeSpectrogram"),
        sweepFrequencySource: lit("firmware DEBUG_CHIRP debug[2] (0.1 Hz)"),
        excitationSource: lit("firmware DEBUG_CHIRP debug[3] (x1000)"),
        inputField: str,
        outputField: str,
        firmwareRevision: nullable(str),
        apiVersion: nullable(str),
        flagGating: lit("none", "flight_mode_flags", "debug_axis_only"),
        highResolutionScale: num,
        sampleRateHz: nullable(num),
        sampleRateSource: str,
        sampleRateStatus: str,
        segmentSize: nullable(num),
        welchOverlap: num,
        welchSegments: nullable(num),
        binWidthHz: nullable(num),
    }),
    levels: obj({
        bblValid: level,
        flightValid: level,
        blackboxDataUsable: level,
        chirpDetected: level,
        chirpQualityAvailable: level,
        chirpQualified: level,
        tuningAuthorized: level,
    }),
    verdicts: obj(Object.fromEntries(topics.map((t) => [t, verdict]))),
    sweep: obj({
        requested: obj({
            availability,
            ...sweepRange,
            durationS: nullable(num),
            amplitude: nullable(num),
            reasons: strs,
        }),
        observed: obj({
            availability,
            ...sweepRange,
            minHz: nullable(num),
            maxHz: nullable(num),
            runs: nullable(num),
            reasons: strs,
        }),
        usable: obj({ availability, role, ...sweepRange, binCount: nullable(num), reasons: strs }),
        analysisBandHz: nullable(tuple(num, num)),
        observedOfRequested: metric(num),
        durationOfRequested: metric(num),
        usableOfAnalysisBand: metric(num),
    }),
    excitation: obj({
        setpointRms: metric(num),
        setpointPeakAbs: metric(num),
        setpointMeanSquare: metric(num),
        setpointEnergy: metric(num),
        gyroRms: metric(num),
        gyroPeakAbs: metric(num),
        requestedAmplitude: metric(num),
        firmwareExcitation: metric(obj({ rms: num, peakAbs: num })),
        inputRelativePowerPeakDb: metric(num),
        noInputPowerBins: metric(num),
    }),
    coherence: obj({
        meanBandCoherence: metric(num),
        usableBinCount: metric(num),
        criteria: obj({
            usableBinCoherenceMin: num,
            meanBandCoherenceMin: num,
            meanBandHz: tuple(num, num),
            minUsableBins: num,
            inputPowerFloor: num,
        }),
        bins: (v) => binsShape(v) && parallelBins(v),
        regions: obj({
            kind: lit("SUMMARY"),
            items: arr(
                obj({
                    fromHz: num,
                    toHz: num,
                    binCount: int,
                    status: binStatus,
                    meanCoherence: num,
                    minCoherence: num,
                    maxCoherence: num,
                    meanInputRelativePowerDb: nullable(num),
                    meanOutputRelativePowerDb: nullable(num),
                }),
            ),
        }),
    }),
    sampleGaps: obj({
        status: lit("NONE", "DETECTED", "UNKNOWN"),
        availability,
        role,
        expectedDtUs: nullable(num),
        medianDtUs: nullable(num),
        gapCount: nullable(num),
        missingSamplesEstimate: nullable(num),
        missingFraction: nullable(num),
        maxGapSamples: nullable(num),
        nonPositiveDeltas: nullable(num),
        gaps: arr(
            obj({
                atTimeUs: num,
                afterSampleIndex: num,
                gapUs: num,
                missingSamples: num,
                sweepFrequencyHz: nullable(num),
            }),
        ),
        gapsTruncated: bool,
        reasons: strs,
    }),
    contamination: obj({ status: evidenceStatus, availability, role, reasons: strs }),
    saturation: obj({
        status: evidenceStatus,
        role,
        motorUpper: sampleFraction,
        motorLower: sampleFraction,
        gyroClipping: sampleFraction,
        reasons: strs,
    }),
    reasons: strs,
});

/**
 * The stored Quality V2 shape per analysis version. A version's shape is frozen
 * once released: when the analysis changes, add the new version here and keep
 * the old one, so stored results stay readable. A version without a shape
 * cannot be checked for stray data and is not stored. Version 2.0.0 predates
 * session storage and was never stored.
 */
export const STORED_QUALITY_V2_SHAPES: Readonly<Record<string, Shape>> = {
    "2.1.0": qualityV2_2_1_0,
};
