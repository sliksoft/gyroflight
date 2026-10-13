# Cross-flight Comparison (WU5)

The Cross-flight Comparison shows, side by side, the stored CHIRP measurements of Flight A (baseline) and Flight B
(comparison) of one Tune Session, and the per-bin differences where they can be computed safely. It is a
**diagnostic, read-only view**. It reads stored results; it re-analyses nothing, stores nothing and writes nothing.

A comparison is **not** a Verified Tune. It proves no repeatability, approves no PID, filter or feedforward value,
creates no tuning authorization, releases no Safety gate and no Apply. The product lock `full_safety_engine_pending`
stays in force, and every result carries
`authorization: { status: "NOT_AUTHORIZED", reasons: ["cross_flight_comparison_is_not_a_verified_tune", "full_safety_engine_pending"] }`
and `repeatability: { status: "NOT_ESTABLISHED", ... }`.

## Where

| File                                                | Role                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `src/gyrocore/compare/contract.ts`                  | Result contract and stable reason codes (`CMP_REASONS`)                                          |
| `src/gyrocore/compare/compare.ts`                   | Pure engine: `compareFlights(load, selection)`                                                   |
| `src/gyrocore/compare/config.ts`                    | Logged configuration comparison (`compareConfig`)                                                |
| `src/gyrocore/compare/view.ts`                      | Chart geometry (log-frequency lines, gaps for missing values)                                    |
| `src/gyrocore/components/CrossFlightComparison.vue` | The section under the A/B Verification Status                                                    |
| `src/gyrocore/components/CrossFlightChart.vue`      | One labelled SVG line chart                                                                      |
| `src/gyrocore/components/FlightAbSelector.vue`      | GyroCore file: renders `<CrossFlightComparison>` below the A/B status (no upstream file changed) |

No upstream Betaflight file is changed by WU5. No new dependency is added; the charts are plain SVG like the
Quality V2 coherence chart.

## The gate: WU4 first, every time

`compareFlights(load, selection)` starts by running WU4 `abVerification(session, selection)` again on the session
and selection it is given (which uses WU3 `flightPairEvidence` and WU1 `checkIndependentFlights`). WU5 has no
independence or firmware logic of its own.

| WU4 status   | WU5 status                     | What is shown                                                                                           |
| ------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `INCOMPLETE` | `INCOMPLETE`                   | "Choose Flight A and Flight B" (`ab_selection_incomplete`, `session_not_loaded`)                        |
| `BLOCKED`    | `BLOCKED`                      | the WU4 blocking reasons (`ab_pair_blocked` + WU4 blockers); no measurement, no configuration, no chart |
| `ELIGIBLE`   | `COMPARED` or `NOT_COMPARABLE` | per-axis measurements; differences only for CHIRP pairs that pass every check below                     |

`UNKNOWN` never becomes `MATCH`, `PASS` or `ELIGIBLE`. `COMPARED` only means that at least one CHIRP pair has a numeric
difference; it is not a verdict on the tune.

## Data contract

`CrossFlightComparison` (contract.ts):

| Field                                           | Meaning                                                                                              |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `status`                                        | `INCOMPLETE`, `BLOCKED`, `NOT_COMPARABLE`, `COMPARED`                                                |
| `abStatus`, `ab`                                | WU4's verdict and full verification, recomputed for this session and selection                       |
| `sessionId`, `sessionUpdatedAt`, `keyA`, `keyB` | what the result belongs to                                                                           |
| `blockers`                                      | INCOMPLETE/BLOCKED: why. ELIGIBLE: problems of the loaded data (`flight_chirps_rejected:<a\|b>:<n>`) |
| `missingEvidence`                               | WU4 missing evidence plus the data problems above                                                    |
| `config`                                        | `ConfigComparison` (below); `null` unless ELIGIBLE                                                   |
| `axes`                                          | roll, pitch, yaw: `{ axisName, chirpsA, chirpsB, pairs }`                                            |
| `diagnostics`                                   | what is compared, what is not, Quality V2 limits, what is missing                                    |
| `repeatability`, `authorization`                | always `NOT_ESTABLISHED` and `NOT_AUTHORIZED` (fresh copies per result)                              |

`ChirpPairComparison`: `id` (`<axis>-<occurrence>`), `status` (`COMPARED`, `NOT_COMPARABLE`, `UNPAIRED`), `reasons`
(why there is no difference), `notes` (facts that limit a difference without blocking it), `a` and `b` (measurement id,
axis, occurrence, qualification state, analysis version), `quality` (side-by-side rows), `bins`, `magnitudeDelta`,
`coherenceDelta`.

`BinComparison` holds parallel arrays over the bins shared by both CHIRPs: `frequencyHz`, `magnitudeDbA/B`,
`magnitudeDeltaDb`, `coherenceA/B`, `coherenceDelta`, `statusA/B`, and `unmatchedBinsA/B` (bins stored by one CHIRP
only, never compared). `DeltaSummary` gives the count, range, minimum and maximum (with their frequency) and mean
absolute value of a difference series. No tolerance, score or verdict is attached to them.

The result is never stored: there is no IndexedDB write, and the Tune Session schema stays version 1.

## Quality V2 fields used

| Use                  | Field                                                                                                                                                                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pairing              | `StoredChirp.axisName`, `axisOccurrence`, checked against `axis` and `qualityV2.identity.{axis, axisName, axisOccurrence, measurementId}`                                                                                                                            |
| Qualification        | `StoredChirp.qualification.state`, `qualityV2.levels.chirpQualified`, `qualityV2.verdicts.*`                                                                                                                                                                         |
| Bins                 | `qualityV2.levels.chirpQualityAvailable`, `coherence.bins.{availability, frequencyHz, coherence, magnitudeDb, status, binWidthHz, powerScale.segmentSize}`, `coherence.criteria`                                                                                     |
| Grid and provenance  | `provenance.{decoder, transferFunction, inputField, outputField, flagGating, highResolutionScale, sampleRateHz, sampleRateSource, sampleRateStatus, segmentSize, welchOverlap, binWidthHz, welchSegments}`                                                           |
| Quality side by side | `coherence.meanBandCoherence`, `coherence.usableBinCount`, `sweep.usable`, `sampleGaps`, `excitation.setpointRms`, `sweep.observed`, `saturation`, `contamination`, `qualification.warningGates`, with each value's `availability`, `role` and the topic's `verdict` |
| Not used             | `inputRelativePowerDb`, `outputRelativePowerDb`, `snrDb`, `excitation.inputRelativePowerPeakDb`: relative spectral power is not a calibrated PSD and depends on the segment size, so it is never compared between Flights                                            |

A value whose `availability` is not `MEASURED` is shown as its availability (`UNKNOWN`, `UNAVAILABLE`, ...), never as a
number. A verdict is shown as stored; `NOT_EVALUATED` stays "Diagnostic only".

## Axis matching

CHIRPs are paired per axis (roll, pitch, yaw) by `axisOccurrence`: roll-1 of A with roll-1 of B, roll-2 with roll-2. A
roll CHIRP is never paired with pitch or yaw, and the stored order of the CHIRPs does not matter.

- Several CHIRPs of one axis give several pairs. Nothing is averaged and no CHIRP is picked.
- An occurrence in one Flight only is `UNPAIRED` (`chirp_only_in_flight_a`/`_b`): shown, never compared.
- Two CHIRPs of one Flight with the same axis and occurrence are `NOT_COMPARABLE` (`axis_occurrence_duplicate:<side>`).
- A CHIRP whose `axisName` is not roll, pitch or yaw, or whose `axisOccurrence` is not a positive integer, is never
  paired; it is reported as `chirp_identity_contradiction:<side>:axis_name` or `:axis_occurrence`.
- A CHIRP whose own fields and Quality V2 identity disagree is `NOT_COMPARABLE` (`chirp_identity_contradiction:<side>`).

## When a pair gets a numeric difference

All of these must hold; otherwise the pair is `NOT_COMPARABLE` with every reason that applies, and both measurements
stay visible in the quality table:

1. **Qualified:** both CHIRPs have qualification state `usable` or `usable_with_warnings`, Quality V2
   `levels.chirpQualified` `YES`, and no topic verdict `FAIL` (`chirp_not_qualified:<side>[:...]`). A failed verdict
   under a usable state is contradicting metadata and is not read as qualified. An ELIGIBLE Flight pair therefore does
   not make every CHIRP usable.
2. **Bins present and well-formed:** `chirpQualityAvailable` `YES` and bins `MEASURED` (`quality_v2_bins_unavailable`);
   equal-length arrays, finite strictly increasing positive frequencies, coherence in [0, 1], magnitude finite or
   `null`, known statuses, and no `USABLE` bin without a magnitude or below the stored criterion
   (`quality_v2_bins_invalid:<problem>:<side>`).
3. **Same analysis version** (`analysis_version_differs`; WU4 already blocks a Flight pair with different versions).
4. **Same provenance:** every field in the table above equal and known on both sides (`provenance_differs:<field>`,
   `provenance_unknown:<field>`), and the logged segment size equal to the transfer function's
   (`provenance_differs:segmentSize_inconsistent:<side>`). So a different sample rate, Welch segment size, overlap,
   bin width, input or output field, decoder or flag gating is refused.
5. **Same frequency grid:** on the bins both CHIRPs stored, every frequency is exactly equal (`===`). Betaflight
   computes bin k as `k · fs / N`, so the same rate and segment size give bit-identical frequencies. Any difference is
   `frequency_grid_mismatch`. There is no interpolation, extrapolation, resampling or nearest-bin matching. Bins beyond
   the shared range (a longer requested sweep) are counted in `unmatchedBins*` and not compared.
6. **Configuration does not block** (see below).

An unknown Welch segment count on either side is `provenance_unknown:welchSegments`. A different **Welch segment count** (a longer or shorter CHIRP) keeps the same grid and is allowed, with the note
`welch_segment_count_differs:<a>:<b>`: the estimates average a different number of segments. A different analysis
band is noted as `analysis_band_differs`.

## Per-bin differences

On the shared bins:

- `Magnitude difference (dB) = Flight B − Flight A`, only where **both** bins are `USABLE` (in the analysis band,
  above Betaflight's input floor, coherence ≥ the stored usable criterion, 0.50) with a finite magnitude.
- `Coherence difference = Flight B − Flight A`, only where both bins are in the analysis band with input power
  (`USABLE` or `WEAK_COHERENCE`). Coherence is a measured quantity there even when it is weak, and that is where a
  change in coherence is informative.

Everywhere else the difference is `null`: a bin below the input-power floor (`NO_INPUT_POWER`, magnitude `null`),
outside the analysis band, or weakly coherent for the magnitude. `null` is never turned into 0, and a gap is never
bridged in the chart. A pair whose difference series are both empty is `NOT_COMPARABLE` (`no_shared_valid_bins`); a
pair with coherence but no magnitude differences carries the note `no_shared_usable_magnitude_bins`.

## Configuration comparison

`compareConfig(a, b)` compares `StoredFlight.logHeaders` (the `H key:value` lines as logged) **as text**. Nothing is
parsed into a value, and nothing is filled in from a firmware default; this code has no firmware-default table and
builds none. Each item is `MATCH`, `MISMATCH` or `UNKNOWN`:

| Status     | When                                                                                                                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MATCH`    | both Flights logged the same text                                                                                                                                                               |
| `MISMATCH` | both logged it, with different text                                                                                                                                                             |
| `UNKNOWN`  | logged by one Flight only, by neither, logged twice with contradicting values, or the header block is unavailable (not stored, or any malformed line in it: then no line of that block is used) |

Items are grouped as:

- **Measurement settings** (loop, logging and CHIRP): `looptime`, `pid_process_denom`, `I interval`, `P interval`,
  `debug_mode`, `blackbox_high_resolution`, `chirp_frequency_start_deci_hz`, `chirp_frequency_end_deci_hz`,
  `chirp_time_seconds`, `chirp_lag_freq_hz`, `chirp_lead_freq_hz`, `chirp_amplitude_<axis>` (the keys headers.ts and
  sampleRate.ts already read).
- **Tune settings**: `rollPID`, `pitchPID`, `yawPID`, `d_max`, `ff_weight`, the `simplified_*` keys and the dterm/gyro
  lowpass keys that headers.ts and safety/absolute.ts already read.
- **Other logged settings**: every other logged key.

Not compared: the firmware identity (`Firmware type`, `Firmware revision`, `Firmware date`, `Firmware API version`,
`Board information`, `Craft name`, `Product`, `Data version`: WU4 checks these), `Log start datetime`, the frame
definitions (`Field *`) and `vbatref`, the battery voltage Betaflight measures when the battery is connected (it differs
by pack and charge, not by setting).

### What blocks a numeric difference

Sander's decision (2026-10-10): a configuration difference that affects system identification makes the comparison
non-comparable, and UNKNOWN is never MATCH. The closed-loop response measured by a CHIRP depends on the loop and
logging rate, the excitation and every tune and filter setting, so WU5 treats the whole logged configuration as
system-ID relevant:

- any `MISMATCH` (`config_mismatch:<key>`);
- any `UNKNOWN` where at least one Flight logged the key, or logged it with contradicting values (`config_unknown:<key>`);
- an `UNKNOWN` required key not logged by either Flight (`config_unknown:<key>`): `looptime`, `pid_process_denom`,
  the three CHIRP sweep keys, `chirp_amplitude_<axis>`, and `rollPID`, `pitchPID`, `yawPID`.

`chirp_amplitude_<axis>` blocks only that axis's pairs (only one axis is excited per CHIRP); every other key blocks all
pairs. A known key that neither Flight logged (for example a lowpass key an older firmware does not write) is listed
as `UNKNOWN` (`config_not_logged_in_either_flight:<key>`), keeps the overall configuration status `UNKNOWN`, appears
under "missing for stronger conclusions", and does not block on its own.

### Intentional tuning changes

A logged tune change between A and B (for example `rollPID`) is never hidden as measurement noise: it is listed as
`MISMATCH`, it closes the numeric differences of the affected pairs (`config_mismatch:rollPID`), and the view states that
the difference may explain or confound the differences between the separate measurements, without claiming cause and
effect. Both measurements stay visible side by side. This follows the fail-closed decision above. It means WU5 shows
**numeric differences only between Flights with the same logged configuration**: before/after comparisons of a tune
change are shown as separate measurements plus the named configuration difference, not as a delta curve. Whether a
tune change should get its own labelled delta is a product decision for a later WU.

A full configuration match is not evidence that motors, propellers, battery, frame, weather or other external
conditions were the same (`external_conditions_not_logged`); the view says so.

## Missing data

- `null`, `NaN`, `Infinity`, missing arrays, unequal lengths, unsorted or non-positive frequencies, unknown statuses
  and self-contradicting bins make the bins invalid for a difference; nothing is repaired, dropped or sorted.
- A CHIRP or Flight rejected when the session was loaded (WU3 validation) is reported
  (`flight_chirps_rejected:<side>:<count>` in `blockers` and `missingEvidence`). Its counterpart is `UNPAIRED`.
  Nothing is repaired or re-saved, and the stored record stays as it was.
- A `corrupt`, `unsupported_version` or `not_found` session gives `INCOMPLETE` (`session_not_loaded`).
- Quality values that are not `MEASURED` are shown as their availability.

## Repeatability and its limits

WU5 compares two Flights. It reports, per CHIRP pair, where the stored measurements differ and by how much, which pairs
cannot be compared and why, which Quality V2 limits apply, and what is missing for a stronger conclusion
(`diagnostics`). It does not claim repeatability:

- `repeatability.status` is always `NOT_ESTABLISHED`: `pairwise_comparison_only:two_flights`,
  `no_validated_acceptance_criteria`, `real_flight_validation_pending`.
- No percentage, score, tolerance, quality threshold or PASS/FAIL limit is introduced. Without a validated tolerance
  WU5 cannot label a bin as "agreeing"; it reports the difference values and their range instead. A difference of
  exactly 0 means identical stored values.
- Quality V2 limits listed with every comparison: `relative_power_not_cross_flight_calibrated`,
  `contamination_unknown:no_validated_detector`, `gyro_clipping_unknown:sensor_range_not_logged`, and detected motor
  saturation per side.
- Missing for stronger conclusions: `more_independent_repeats_needed`, `no_validated_acceptance_criteria`,
  `real_flight_validation_pending`, `external_conditions_not_logged`, unlogged configuration, rejected CHIRPs and axes
  measured in one Flight only.

A lower magnitude, a higher coherence or a changed response is not better by itself, and the view says so. No PID
values are recommended.

## UI

The section **Cross-flight Comparison** sits under the A/B Verification Status inside the Flight A/B Selector, so it
exists only in Expert Mode (the selector and the Autotune tab are Expert Mode only). It shows:

- the not-a-Verified-Tune notice, with `full_safety_engine_pending`;
- Flight A — baseline and Flight B — comparison (file and flight number);
- the comparison status, and for BLOCKED the real blocking reasons and nothing else;
- the logged configuration per group: differing and unknown settings in a table, matching ones collapsed;
- per axis and CHIRP pair: status, reasons, notes, the quality table (A and B side by side), and for a compared pair
  four labelled charts: magnitude (dB) A and B on usable bins, magnitude difference B − A (dB), coherence A and B on
  bins with input power, coherence difference B − A, each with legend, axis units and a dashed zero line for the
  differences, plus a one-line summary of each difference;
- the diagnostics: compared pairs, pairs not compared with reasons, axes not measured in both, Quality V2 limits,
  missing evidence and `NOT_ESTABLISHED` repeatability.

The view derives the result from the loaded session and the current selection on every render. When the session is
switched, reloaded or closed, a Flight is removed, or A or B changes, the previous comparison is gone at once: WU4 clears
the selection and drops stale loads, and the comparison of the new state is `INCOMPLETE` until both Flights are chosen
again.

## Safety boundaries

WU5 does not change PID, filter or feedforward recommendations; create tuning authorization; change the Safety engine or
any gate; change CHIRP qualification or Quality V2 limits; release the physical Apply button; send MSP commands; flash
firmware; upload BBL files; or modify stored analyses. `full_safety_engine_pending` stays. The Tune Session schema stays
version 1 and WU4 `addFlightsAtomic()` is unchanged. The compare module imports no MSP, Apply, tuning, Safety, store or
storage code (tested), and no gate imports the compare module (tested).

## Diagnostic comparison versus Verified Tuning

| Diagnostic comparison (WU5)   | Verified Tuning (later WUs)                                |
| ----------------------------- | ---------------------------------------------------------- |
| two Flights, pairwise         | enough independent repeats (WU6 repeatability)             |
| facts: values and differences | validated acceptance criteria, calibrated on real flights  |
| no threshold, no verdict      | verified RP/RPY tune (WU7), Safety evidence (WU8)          |
| never authorizes              | final tested Safety/Apply flow with live FC readback (WU9) |

## Tests

`test/gyrocore/cross_flight_comparison.test.ts` (SYNTHETIC logs through the real decode, Quality V2 and WU1 identity;
expected values computed in the test from the stored arrays and the edits made to them):

1. two valid independent Flights are compared per pair; differences equal B − A of the stored bins;
2. identical measurements give exactly 0, only on valid bins;
3. +3 dB and −0.05 coherence on known bins come back as exactly those differences;
4. roll, pitch and yaw are never swapped, whatever the stored order;
5. two roll CHIRPs stay two pairs; unpaired occurrences and one-sided axes are shown;
6. invalid and missing bins give `null`, never 0 (also adversarial);
7. different grids and provenance (sample rate, bin width, segment size, output field) are refused;
8. a different Welch segment count is a note; another analysis version is blocked by WU4;
9. rejected CHIRPs and contradicting FAIL verdicts are not compared;
10. the same Flight twice is blocked;
11. a copy in another file and a repackaged copy are rejected by WU1;
12. unlogged firmware stays UNKNOWN; configuration MATCH/MISMATCH/UNKNOWN, tune changes, axis-scoped amplitude,
    one-sided keys, required keys, `vbatref`;
13. a CHIRP damaged in IndexedDB is reported and nothing is repaired;
14. slow session loads, switching B or the session, and removed Flights never show an earlier comparison;
15. the stored authorization stays `NOT_STORED`, inputs are not mutated, results carry `NOT_AUTHORIZED`;
16. the product Apply lock still blocks; the compare code imports no MSP, Apply, tuning, Safety or storage code;

and the component: Expert Mode only, placement under the A/B status, labelled charts with legends, blocked state
without measurements, tune difference named as a possible explanation, no stale comparison after switching.

`test/gyrocore/cross_flight_comparison_adversarial.test.ts`: written against this document and the contract,
without reading the engine: missing and invalid arrays, `NaN`/`Infinity`/`null`, unequal lengths, unsorted or
duplicate frequencies, contradicting statuses and metadata, grid offsets, duplicate occurrences, contradicting
header lines, and the chart geometry's gaps.

## Open: AIR65 validation

All tests use SYNTHETIC logs; they test the comparison rules and are not evidence of performance on real flights. Still
to do with real, repeated AIR65 flights of one configuration (local only):

1. that two real CHIRPs of the same axis and configuration share the exact frequency grid (same sample rate, segment
   size and bin frequencies), so pairs are actually comparable;
2. which header keys a real AIR65 log writes, whether any other key besides `vbatref` changes between flights without
   a configuration change (it would close every difference until classified), and whether the required keys are all
   logged;
3. the size of the magnitude and coherence differences between repeated flights of an unchanged tune: the input for
   WU6 repeatability criteria;
4. the Quality V2 AIR65 checks still open in CHIRP_QUALITY_V2.md.
