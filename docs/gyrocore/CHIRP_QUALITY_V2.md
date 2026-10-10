# CHIRP Quality V2

CHIRP Quality V2 is a detailed quality report for each CHIRP measurement. It **measures and reports**. It changes no gate, no
threshold and no authorization. The existing qualification ([CHIRP_QUALIFICATION.md](CHIRP_QUALIFICATION.md)) still
decides alone whether a measurement is valid for tuning. Which V2 values may later become gates is decided only after
calibration on real repeated flights.

Code: `src/gyrocore/chirp/qualityV2/` (`contract.ts`, `analyze.ts`, `identity.ts`, `view.ts`). UI:
`src/gyrocore/components/ChirpQualityV2Card.vue`, shown in the GyroCore qualification panel on the Autotune tab.
Tests: `test/gyrocore/chirp_quality_v2.test.ts`, `chirp_quality_v2_ui.test.ts` and
`chirp_quality_v2_adversarial.test.ts`.

## Where the numbers come from

| Value                          | Source                                                                                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| samples, timestamps            | Blackbox Viewer `FlightLog`, via the existing CHIRP extraction                                                                                                 |
| coherence, magnitude per bin   | Betaflight `welchTransferFunction`, the same call and result the gates use                                                                                     |
| input and output power per bin | Betaflight `computeSpectrogram`, with the Welch segment size and overlap, averaged per bin. That is the Welch Sxx and Syy (same Hann window, segments and hop) |
| observed sweep frequency       | firmware `DEBUG_CHIRP` `debug[2]`, the instantaneous sweep frequency in 0.1 Hz (Betaflight `pid.c`)                                                            |
| firmware excitation signal     | firmware `DEBUG_CHIRP` `debug[3]`, the raw excitation × 1000 before the phase-compensation filter                                                              |
| requested sweep                | log headers `chirp_frequency_start_deci_hz`, `chirp_frequency_end_deci_hz`, `chirp_time_seconds`, `chirp_amplitude_<axis>`                                     |
| motor saturation               | optional `motor[0..7]` fields and the `motorOutput` header, as decoded by the Viewer                                                                           |
| file and Flight identity       | WU1 `catalogBbl()` ([FLIGHT_IDENTITY.md](FLIGHT_IDENTITY.md))                                                                                                  |

No spectral, transfer-function or recommendation math is re-implemented. The only derived spectral number is the
per-bin signal-to-noise estimate `10·log10(c / (1 − c))`, from Betaflight's coherence `c`.

## Data contract

`ChirpMeasurement.qualityV2` is a `ChirpQualityV2` object, schema `gyrocore.chirp-quality.v2`, analysis version
`2.0.0`. It is plain JSON: no typed arrays, no `Infinity` or `NaN`, no file bytes. The same file gives the same JSON.
Every value carries:

- `availability`:
    - `MEASURED`: derived from this log's data or headers;
    - `UNKNOWN`: the data is there but does not support a defensible value;
    - `UNAVAILABLE`: the source is not in the log, or could not be computed;
    - `NOT_APPLICABLE`: the question does not apply.

    `value` is `null` unless the value is `MEASURED`.

- `role`: `ACTIVE_GATE` when an existing gate already uses the value, otherwise `DIAGNOSTIC`. `DIAGNOSTIC` values never
  authorize anything.
- `reasons`: stable reason codes (`QV2_REASONS` in `contract.ts`). Codes are only added, never changed in meaning.

There is no overall quality score. Each problem stays visible on its own.

### Sections

| Section         | Contents                                                                                                                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity`      | measurement id, `logIndex`, `chirpIndex` (order within the Flight), axis and its occurrence, start and end time, sample count, WU1 file hash and `FlightRef`                                                                |
| `provenance`    | decoder, Betaflight functions used, firmware channels, input and output fields, firmware revision, API version, sample rate and its source, Welch segment size, overlap and count, bin width                                |
| `levels`        | the evidence ladder below                                                                                                                                                                                                   |
| `sweep`         | `requested`, `observed` and `usable` ranges, the analysis band, and three coverage fractions                                                                                                                                |
| `excitation`    | setpoint RMS (`ACTIVE_GATE`), peak, mean square and energy; gyro RMS and peak; requested amplitude; the firmware excitation's RMS and peak; the in-band input power peak; and the count of in-band bins without input power |
| `coherence`     | mean band coherence and usable bin count (`ACTIVE_GATE`), the existing criteria quoted, **every real bin** and **summary regions**                                                                                          |
| `sampleGaps`    | `NONE`, `DETECTED` or `UNKNOWN`, the counts of the existing spacing analysis, and the gaps themselves                                                                                                                       |
| `contamination` | pilot interference: always `UNKNOWN` in this version (see below)                                                                                                                                                            |
| `saturation`    | `DETECTED`, `NOT_DETECTED` or `UNKNOWN` from motor outputs; gyro clipping `UNKNOWN`                                                                                                                                         |
| `reasons`       | every reason code in the report, once, in section order                                                                                                                                                                     |

## Evidence levels

The levels are separate. A lower level never implies a higher one.

| Level                   | YES when                                                                                                              | Role        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------- |
| `bblValid`              | WU1 BBL VALID. `UNKNOWN` until the identity is attached                                                               | DIAGNOSTIC  |
| `flightValid`           | WU1 FLIGHT VALID for this CHIRP's log section. `UNKNOWN` until attached                                               | DIAGNOSTIC  |
| `blackboxDataUsable`    | the CHIRP's samples have a resolved sample rate                                                                       | DIAGNOSTIC  |
| `chirpDetected`         | always YES: a report exists only for a detected CHIRP segment                                                         | DIAGNOSTIC  |
| `chirpQualityAvailable` | Betaflight computed a transfer function for the segment                                                               | DIAGNOSTIC  |
| `chirpQualified`        | the existing qualification state is not `rejected`                                                                    | ACTIVE_GATE |
| `tuningAuthorized`      | the existing per-measurement Apply authorization allows it. Composite, Safety and the product lock still decide Apply | ACTIVE_GATE |

`tuningAuthorized` is refreshed when recommendations are recomputed for another phase-margin target.

## Sweep

- **REQUESTED** comes from the CHIRP headers. Without valid start and end headers it is `UNKNOWN`
  (`requested_sweep_unknown:headers_missing`). The duration and amplitude have their own `UNKNOWN` reasons.
- **OBSERVED** comes from the firmware frequency channel `debug[2]`. Only a channel that behaves like a sweep counts. It
  is `UNKNOWN` when the channel:
    - is constant (`frequency_channel_constant`; the WU7 fixtures log zeros there);
    - has a negative or non-finite value;
    - rises more than one 0.1 Hz count above the requested end;
    - falls back on more than 1 % of its steps (`frequency_channel_not_monotonic`).

    The 1 % is an interpretation guard for the channel, not a quality threshold. A restart (the firmware's
    `chirp_repeat`) is reported in `runs` with `observed_sweep_restarted`. A sweep whose highest frequency is more than
    one count below the requested end gets `observed_sweep_ended_below_requested`.

- **USABLE** is the existing usable range: in-band bins with coherence ≥ 0.5 above Betaflight's input floor.
- **UNKNOWN** values are never filled in. Coverage needs both sides: `observedOfRequested` is `UNKNOWN` without a
  requested or an observed sweep.

Coverage fractions:

- `observedOfRequested`: the overlap of the observed and requested ranges, as a fraction of the requested range
  (linear Hz);
- `durationOfRequested`: the segment duration over `chirp_time_seconds`;
- `usableOfAnalysisBand`: usable bins over all bins of the analysis band.

## Frequency-dependent coherence

`coherence.bins` holds Betaflight's transfer-function bins as parallel arrays. Each bin has its frequency, coherence,
magnitude (dB), input and output power (dB, Betaflight spectrogram units, relative), the SNR estimate and a status:

| Status                  | Rule (existing criteria only)                                                        |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `OUTSIDE_ANALYSIS_BAND` | outside the existing analysis band                                                   |
| `NO_INPUT_POWER`        | in band, but below Betaflight's input floor (Sxx < 1e-20: magnitude −∞, coherence 0) |
| `USABLE`                | in band, with coherence ≥ 0.5                                                        |
| `WEAK_COHERENCE`        | in band, with coherence < 0.5                                                        |

The number of `USABLE` bins equals the existing `usableBinCount`.

Bins are stored from the first bin above 0 Hz up to the higher of the analysis-band top and the requested end, below
Nyquist. Bins above that are only counted (`omittedBinCount`). The DC bin and Nyquist are never stored.

`coherence.regions` (`kind: "SUMMARY"`) groups consecutive bins with the same status. A region's edges are real bin
frequencies, and it gives mean, minimum and maximum coherence and mean input and output power. Regions are a summary of
real bins. They are never invented frequency bands, and the UI labels them as such.

## Sample gaps

The same rule as the existing spacing analysis: a timestamp step more than 1.5 × the median step is a gap, with
`rint(step / median) − 1` missing samples. Each gap gives:

- its time and the index of the sample before it;
- its length and its missing samples;
- the sweep frequency at the gap, when the observed sweep is `MEASURED`.

At most 32 gaps are listed (`gapsTruncated`); the counts always cover all of them. Timestamps that do not increase
make the status `DETECTED` (`timestamps_not_increasing`). Too few timestamps make it `UNKNOWN`. `expectedDtUs` is the
step at the resolved sample rate.

## Pilot interference (contamination)

The status is always `UNKNOWN` (`contamination_unknown:no_validated_detector`). The firmware adds
`amplitude × phaseComp(chirp)` to the pilot's setpoint. The excitation channel `debug[3]` is logged before the
phase-compensation filter, so the pilot's share cannot be separated without re-implementing that firmware filter. A
`rcCommand`-based detector is possible, but whether logged `rcCommand` is after the stick deadband has not been
verified on real logs. No pilot is told they flew a CHIRP wrongly without a validated detector.

## Saturation

Motor saturation is the only kind with direct evidence in the log: a motor at or above the logged maximum output
(`motorOutput` high), or at or below the minimum, during the CHIRP.

| Result         | When                                                                                           |
| -------------- | ---------------------------------------------------------------------------------------------- |
| `DETECTED`     | the samples are counted per direction                                                          |
| `NOT_DETECTED` | motors were checked and none was at a limit. Always with `saturation_scope:motor_outputs_only` |
| `UNKNOWN`      | no motor fields, no valid `motorOutput` range, or missing motor values                         |

Gyro clipping is always `UNKNOWN`, because the sensor range is not logged. Low coherence is never taken as evidence
of saturation.

## Identity (WU1)

`attachChirpFlightIdentity(report, bytes)` runs after `qualifyChirpFile`. It is the one-line hook in `useAutotune`;
see [UPSTREAM.md](UPSTREAM.md). It catalogs the file with WU1 and gives every CHIRP:

- the file hash;
- the `FlightRef` of its log section;
- the BBL VALID and FLIGHT VALID levels.

CHIRPs of one Flight share one `FlightRef`, so `checkIndependentFlights` never counts two CHIRPs of one Flight as two
flights. Without Web Crypto the identity stays `UNKNOWN` (`identity_unknown:sha256_unavailable`), and the analysis
itself is unaffected.

## UI

Below the measurement table, the qualification panel shows one compact card for each measurement the Autotune plots
currently show (one per axis). Each card has:

- the rows Detection, Sweep, Frequency coverage, Excitation, Coherence, Usable bins, Sample gaps, Contamination and
  Saturation;
- the evidence ladder;
- a coherence-per-bin chart on a log-frequency axis. Each bar is one real bin, coloured by status, with a legend, a
  hover title and a dashed line at the existing 0.5 criterion;
- a collapsible table of the summary regions, with every reason code.

The card states that the values are diagnostics and do not authorize tuning. No new tab, no change to Home, and
Autotune stays an Expert Mode tab.

## What is measured, and what is not yet

| Topic             | Measured now                                                               | Missing evidence                                                                                   |
| ----------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Sweep             | requested (headers), observed (firmware channel), usable (Betaflight bins) | `debug[2]` semantics checked only against current firmware source and synthetic logs, not on AIR65 |
| Coverage          | observed and usable share of the requested range                           | how much coverage a usable measurement needs                                                       |
| Excitation        | setpoint and gyro RMS and peak, firmware excitation, per-bin input power   | which input power or ratio per band is enough                                                      |
| Coherence per bin | every Betaflight bin with status, regions, SNR estimate                    | per-band minimum coherence; whether 0.50 holds per band                                            |
| Sample gaps       | location, length, missing samples, sweep frequency at the gap              | how much loss at which frequency still gives a valid estimate                                      |
| Contamination     | nothing (`UNKNOWN`)                                                        | a validated detector (rcCommand deadband semantics, or the firmware filter)                        |
| Saturation        | motor outputs at the logged limits                                         | gyro sensor range; whether motor saturation of a given fraction invalidates a CHIRP                |

### Criteria to calibrate with real CHIRPs

These need repeated real flights of one craft and configuration (several CHIRPs per axis):

- mean band coherence (now 0.60) and per-bin coherence (now 0.50); whether 0.50 is the right minimum for a usable
  measurement, and what a Verified Tune needs;
- the minimum usable bins (now 8), and the minimum usable range or coverage of the requested sweep;
- the minimum excitation (now setpoint RMS 5), and a per-band input-power criterion;
- the gap tolerance per frequency region (now 1 % missing over the whole CHIRP);
- motor-saturation fractions that make a CHIRP unusable;
- the repeatability of each V2 metric between CHIRPs of the same axis.

The AIR65 file (local only) can verify the `debug[2]` and `debug[3]` interpretation and give the first real V2 values.
Its 5 measurements have mean coherence 0.17–0.59 (CHIRP_QUALIFICATION.md), so the per-bin view shows where they fail.

## Limits of the current Betaflight interfaces

- `welchTransferFunction` does not return Sxx or Syy. V2 recovers them through `computeSpectrogram` with the same
  framing, which costs two more passes over the segment.
- The firmware logs the excitation before the phase-compensation filter, and logs no pilot-only setpoint.
- The gyro sensor range is not in the log header.
- Hashing for the WU1 identity needs Web Crypto, and catalogs the file a second time.

## Recommendations for WU3 (Tune Session storage)

- Store `qualityV2` as it is. It is self-describing (`schema`, `analysisVersion`, `provenance`) and needs no file bytes.
  Large per-bin arrays (about 17 kB of JSON for a 20 s, 1 kHz CHIRP) can be kept or dropped per session, while
  regions and summary values stay.
- Key stored CHIRPs by `identity.flight.ref.locationId` plus `chirpIndex`, and validate the stored `FlightRef` with
  `flightRefProblems` on load.
- Keep `analysisVersion` with each stored report, and re-derive instead of comparing reports of different versions.
- Never store `levels.tuningAuthorized` as a decision: it is a snapshot of the per-measurement verdict at analysis
  time.
