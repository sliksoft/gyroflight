# CHIRP qualification gate (WU2)

Gyroflight's Autotune now reads CHIRP data through the Betaflight Blackbox Viewer decode. GyroCore's
measurement-quality and safety gates run before Betaflight Autotune may recommend or apply gains.

**Betaflight is authoritative for decoding and for the tuning math.** That covers the Blackbox Viewer
`FlightLog`, CHIRP segment detection, the transfer function, magnitude, phase, coherence, sensitivity, step
response and spectrogram, and the recommendation itself (`recommendGains()`).

**GyroCore is authoritative for measurement qualification and safety gating.** It decides whether a
measurement is valid for tuning, whether its sample rate can be trusted, whether the current tune can carry
the recommendation, and whether Apply Gains may run.

The evidence for this split is in [BLACKBOX_CHIRP_PARITY.md](BLACKBOX_CHIRP_PARITY.md) (WU1). Branch:
`gyrocore/chirp-qualification-gate`, from `b6e8e9b9`. GyroCore reference: `~/GyroCore` at `d2e60f7`, read
only.

## Data flow

```
BBL bytes
  -> Blackbox Viewer FlightLog, every embedded log            Betaflight  (src/blackbox-viewer, unmodified)
  -> CHIRP segments per log and axis, every one kept          Betaflight rule (BOXCHIRP + debug[1]), GyroCore port
  -> sample rate from headers, cross-checked with timestamps  GyroCore
  -> timestamp spacing: gaps, non-uniform, backwards time     GyroCore
  -> welchTransferFunction / computeSensitivity /
     computeStepResponse / computeSpectrogram                 Betaflight  (spectral_analysis.ts, unmodified)
  -> measurement-quality gates                                GyroCore
  -> recommendGains(), only for a usable measurement          Betaflight  (unmodified)
  -> current-tune gates + slider-translation guard            GyroCore
  -> Apply authorization, enforced inside the Apply action    GyroCore
```

Code: `src/gyrocore/chirp/` holds the logic. Its `numeric.ts` has only NumPy-compatible mean/median/rint
for the gate statistics, not spectral math. `src/gyrocore/stores/chirpQualification.ts` holds every
measurement and the selection shown. `src/gyrocore/components/` holds the qualification panel, the
diagnostic-only banner and the Apply notice.

### Why Autotune's own decoder was dropped, not patched

Upstream `src/js/blackbox/chirp_bbl_parser.ts` contains a second blackbox decoder. Its `handleIFrame` keeps
the previous P-frame as `previous2` instead of the I-frame, unlike the firmware, the Viewer and
`blackbox_decode`. As a result it mis-decodes about 38 % of AIR65 gyro samples, by up to 78 raw units. The
Viewer's `FlightLog` decodes the same bytes bit-exactly (WU1), and it already exposes everything Autotune
reads.

The app therefore takes its samples from `FlightLog`, and no patch was needed. The Autotune file is left as
it is upstream. Gyroflight imports only its `SysConfig` type, and `chirp_parser_history.test.ts` still pins
the bug, so an upstream fix will be noticed.
`chirp_qualification_pipeline.test.ts` proves two things: the app's samples equal what the firmware logged
on a log that triggers the bug, and `importAndAnalyze` never calls `findLogBoundaries` or `parseChirpLog`.

### Sample rate given to Betaflight's math

The math runs at the rate GyroCore resolved. That is the header rate when timestamps confirm it within 5 %,
otherwise the timestamp rate. Betaflight's own header-only formula (`computeSampleRate`) is still evaluated
for each measurement. If it disagrees with the resolved rate, or the rate is not header-confirmed, Apply is
blocked (`sample_rate_contract:*`). This affects legacy logs: on `pnum_pdenom` Betaflight assumes 666.7 Hz
for a 1000 Hz log, and on `malformed_missing_rate_headers` it assumes 8 kHz for a 1 kHz log.

## Multiple logs and segments

Every embedded log is decoded, and every CHIRP segment becomes one measurement:

- `id` (`log<N>-seg<M>`), log index, segment index, axis, and its occurrence count on that axis;
- start/end timestamp, duration, sample count;
- the resolved sample rate, Betaflight's header rate, and the timing analysis;
- the quality report, state, Betaflight diagnostics, recommendation (or `null`) and Apply authorization.

Nothing overwrites anything: upstream Autotune analysed only the first log with CHIRP and kept the last
segment per axis. The plots and gain table (Betaflight components) still show one measurement per axis
from one log, because sliders and current PIDs are per log. The GyroCore panel lists every measurement, and
any one can be selected for display. The default selection prefers measurements that are Apply-eligible,
then usable, then usable with warnings, then diagnostic only. Ties go to the later segment, as upstream did.

## Autotune states

| State                    | Meaning                                                                      | UI                                                                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **NO CHIRP**             | no CHIRP segment in any embedded log (or the log is not a CHIRP log)         | error line "No CHIRP sweep found in any of N embedded logs"; panel shows NO CHIRP and each log's reason                                                                       |
| **REJECTED**             | CHIRP exists but no measurement passes the measurement-quality gates         | plots shown when computable, under a non-collapsible "Diagnostic only — not valid for tuning" banner directly above the Bode plot (and in the panel); no gains, Apply blocked |
| **USABLE WITH WARNINGS** | at least one measurement passes the blocking gates but raises a warning gate | recommendation shown; Apply still subject to the Apply gate                                                                                                                   |
| **USABLE**               | at least one measurement passes every measurement gate without warnings      | recommendation shown; Apply still subject to the Apply gate                                                                                                                   |

The overall state is the best of the measurements. Every measurement also carries its own state, Apply
verdict and reasons in the panel. A REJECTED file with nothing plottable, such as `insufficient_samples`,
shows "CHIRP found, but no measurement is valid for tuning" and is never called "No CHIRP".

## Measurement-quality gates

These are ported unchanged from GyroCore `chirp/quality.py`, `quality.ts` and `sample_rate.py` (same codes,
thresholds, severities). They are computed on Betaflight's transfer function. Betaflight does not return
Sxx, but it zeroes the coherence of every bin below the same 1e-20 floor GyroCore uses, so the usable-bin
test is unchanged.

| Code                              | Severity | Rule                                                                             |
| --------------------------------- | -------- | -------------------------------------------------------------------------------- |
| `invalid_sample_rate`             | blocking | no trustworthy rate from headers or timestamps                                   |
| `non_uniform_sampling`            | blocking | < 90 % of timestamp deltas within ±10 % of the median, or any non-positive delta |
| `excessive_gaps`                  | blocking | more than 1 % of samples missing (deltas > 1.5 × median)                         |
| `insufficient_samples`            | blocking | segment shorter than the Welch segment, or fewer than 4 Welch segments           |
| `insufficient_excitation`         | blocking | setpoint RMS < 5                                                                 |
| `low_coherence`                   | blocking | mean coherence over 5–100 Hz (within the CHIRP band) < 0.6                       |
| `unusable_frequency_range`        | blocking | fewer than 8 in-band bins with coherence ≥ 0.5 above the Sxx floor               |
| `timestamp_gaps_present`          | warning  | any gap at all                                                                   |
| `sample_rate_crosscheck`          | warning  | header and timestamp rates not confirmed equal within 5 %                        |
| `chirp_band_unknown_default_used` | warning  | no CHIRP band headers; 5–100 Hz assumed                                          |
| `chirp_band_near_nyquist`         | warning  | CHIRP band ends above 0.9 × Nyquist                                              |

Header and debug-mode validation (`not_chirp_debug_mode`, `chirp_debug_mode_unsupported_api`,
`missing_required_field:*`) is per log. An invalid log yields no measurements.

## Apply Gains hard gate

> **Superseded in WU3** for what Apply may write: Apply now writes only a GyroCore composite (global)
> recommendation, never a single measurement's sliders. See [GLOBAL_TUNE_MERGE.md](GLOBAL_TUNE_MERGE.md).
> The per-measurement checks below still decide whether a measurement may contribute to it.

`useAutotune().applyGains(proposed, measurementId)` calls `assertApplyAuthorized()` before any
flight-controller access. The button is also disabled and lists the reasons, but the action enforces the gate
itself. It throws `ApplyBlockedError` unless all of the following hold:

1. the measurement belongs to the current analysis, and the sliders are exactly the ones recommended for it
   (`apply:*`);
2. it has a Betaflight transfer function and passes every blocking measurement gate (`measurement:*`);
3. the sample-rate contract holds: header confirmed by timestamps, and Betaflight's rate equal to the
   resolved rate (`sample_rate_contract:*`);
4. the logged current tune can carry a slider recommendation: every slider is logged, readable and non-zero,
   and `simplified_pids_mode` is logged and not OFF (and not RP for yaw) (`current_tune_*`,
   `simplified_pids_mode_off`, `simplified_pids_mode_unknown`, `yaw_not_under_slider_control`);
5. a Betaflight recommendation exists (`recommendation:not_produced`), and the slider guard below passes;
6. Betaflight does not report an unreachable robustness bound (`autotune_sensitivity_bound_unreachable`).

Only then does the action touch the craft. Apply now makes one MSP read before writing: it reads the live
slider state with `MSP.promise(MSPCodes.MSP_SIMPLIFIED_TUNING)`, the same call the PID Tuning tab makes
(`PidTuningTab.vue`). `MSPHelper` fills `FC.TUNING_SLIDERS` from the reply. Apply refuses if the connected
craft's slider mode is OFF, unknown, or RP for a yaw measurement (`fc:*`). The read also means the write
that follows keeps the live values of slider fields the proposal does not set. Upstream wrote whatever
`FC.TUNING_SLIDERS` held, which is all zeros until the PID tab loads it.

Every reason is shown in plain language, with the measured value where there is one
(`src/gyrocore/chirp/reasons.ts`; strings in `src/gyroflight/locales/en.json`).

### Feed-forward / slider-floor guard

`buildProposedSliders()` clamps every slider to 25–250 after scaling. WU1 showed a requested FF cut (15 to
8–12) coming out as 25, a +67 % increase, shown with no warning.
`guardRecommendation()` (`src/gyrocore/chirp/recommendationGuard.ts`) reconstructs, for each slider:

- current value, scale and requested value `current × scale × 100`, before the clamp;
- proposed value and whether the slider limit clamped it;
- requested and proposed direction (increase / decrease / hold);
- whether the direction changed, and the reason code.

It blocks Apply when the proposed direction differs from the requested one
(`slider_clamp_changes_direction:<slider>`). That covers a reduction turned into an increase, a requested
change cancelled by the limit, and a held slider moved by the limit. It also blocks when the slider limit
changes the requested value by more than integer rounding (0.5) in the same direction
(`slider_clamp_material:<slider>`), for example FF 15 asked to go to 20.7 (+38 %) and floored to 25 (+67 %).
A clamp within rounding is a warning. Betaflight's math is unchanged.

## Deliberate differences from GyroCore's Python engine

| Topic                               | GyroCore Python (`autotune/engine.py`)  | Gyroflight Apply gate                 | Why                                                                    |
| ----------------------------------- | --------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------- |
| `simplified_pids_mode` absent       | warning                                 | blocks                                | a slider proposal cannot be shown to reach the PIDs                    |
| header/timestamp rate not confirmed | warning (`sample_rate_crosscheck`)      | blocks Apply only                     | WU2 "sample-rate contract invalid"; the measurement state is unchanged |
| slider clamped by the 25–250 limit  | warning (`slider_clamped`)              | blocks unless within integer rounding | WU2 §6 (FF floor)                                                      |
| Betaflight `sensitivityUnreachable` | warning                                 | blocks                                | "recommendation reports unsafe state"                                  |
| repeated segments on one axis       | last one analysed; overall status warns | all analysed; no warning              | no silent overwrite, so nothing is discarded to warn about             |

The measurement gates, per-measurement states and quality numbers are identical to GyroCore's, on all 20
synthetic logs and, locally, on AIR65. The overall state equals GyroCore's overall status in 19 of 20 cases.
`repeated_axis` is the documented exception: GyroCore says `usable_with_warnings` because it discards the
first roll sweep, Gyroflight keeps both and says USABLE. Log-level extraction warnings make every
measurement of that log USABLE WITH WARNINGS, as in GyroCore, and are listed in the panel and in Apply's
warnings (`log:*`). These are skipped malformed rows, dropped out-of-range axis frames, CHIRP detected from
`debug[1]` alone, and a missing CHIRP band.

Not ported, on purpose: GyroCore's Welch, FFT, transfer function, coherence, sensitivity and step math
(`systemId.ts`, `fft.ts`); its `recommend_gains` port; the old AeroTuner tuner; the global-slider merge
(`merge.py`); and the Safety pipeline.

## Results

### Synthetic (20 WU7 logs; `chirp_qualification_synthetic.test.ts`)

All 20 match GyroCore's golden verdicts on segments, failed gates, warning gates, sample-rate status,
effective rate, usable bins and mean coherence (≤ 1e-9).

| Case                             | Upstream Autotune         | Gyroflight now                                                                       |
| -------------------------------- | ------------------------- | ------------------------------------------------------------------------------------ |
| `poor_coherence`                 | recommends                | REJECTED (`low_coherence`, `unusable_frequency_range`), diagnostics only             |
| `weak_excitation`                | recommends                | REJECTED (`insufficient_excitation`), diagnostics only                               |
| `dropped_timestamps`             | recommends                | REJECTED (`excessive_gaps`), diagnostics only                                        |
| `pnum_pdenom`                    | recommends (at 666.7 Hz)  | REJECTED (`non_uniform_sampling`); sample-rate contract broken                       |
| `malformed_missing_rate_headers` | no result (assumes 8 kHz) | USABLE WITH WARNINGS at the timestamp rate; Apply blocked (`sample_rate_contract:*`) |
| `insufficient_samples`           | no result                 | REJECTED, nothing plottable                                                          |
| malformed debug mode / field     | error                     | NO CHIRP with the log's error code                                                   |
| `repeated_axis`                  | last roll sweep only      | both roll sweeps, separately                                                         |
| others                           | recommends                | USABLE / USABLE WITH WARNINGS as GyroCore                                            |

Unsafe synthetic measurements accepted: **0**. None of the WU7 logs records slider headers, so none is
Apply-eligible (`current_tune_missing:*`). Apply-eligible and blocked-for-one-reason cases come from
generated closed-loop CHIRP flights (`test/gyrocore/harness/chirpSim.ts`). These cover slider mode OFF, the
FF floor reversal, live slider mode OFF, and yaw in RP mode.

### AIR65 (local only; `air65_qualification.local.test.ts`)

The test runs the real import, with only the file picker and MSP mocked. All 3 embedded logs and all 5
segments are found. Segments, failed gates and mean coherence equal GyroCore's goldens.

| Measurement | Axis  | Samples | Mean coherence | State    | Apply blocked by                                                           |
| ----------- | ----- | ------: | -------------: | -------- | -------------------------------------------------------------------------- |
| log1-seg1   | roll  |  27 136 |          0.354 | REJECTED | `low_coherence`; `simplified_pids_mode_off`; no recommendation             |
| log2-seg1   | pitch |  15 774 |          0.409 | REJECTED | `low_coherence`; `simplified_pids_mode_off`; no recommendation             |
| log3-seg1   | yaw   |  57 009 |          0.534 | REJECTED | `low_coherence`; `simplified_pids_mode_off`; no recommendation             |
| log3-seg2   | roll  |  60 298 |          0.590 | REJECTED | `low_coherence`; `simplified_pids_mode_off`; no recommendation             |
| log3-seg3   | pitch |  76 112 |          0.169 | REJECTED | `low_coherence`, `unusable_frequency_range`; `simplified_pids_mode_off`; … |

Tune-eligible: **0** (upstream: 5). Betaflight's math still produces Bode, step and spectrogram
diagnostics for all five. Calling `applyGains` directly for each measurement throws, and no MSP call is
made. The test asserts only generic properties and GyroCore parity; it does not name AIR65's reasons.

```bash
export GYROFLIGHT_AIR65_BBL=/path/to/BTFL_BLACKBOX_LOG_AIR65_C_20261005_224215_BETAFPVG473.BBL
export GYROFLIGHT_AIR65_REF_DIR=/path/to/gyrocore-reference-outputs   # optional, see BLACKBOX_CHIRP_PARITY.md
npx vitest run test/gyrocore/air65_qualification.local.test.ts
```

## Tests

| File                                                  | Proves                                                                                                                                                                                                          |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/gyrocore/chirp_qualification_synthetic.test.ts` | 20-case parity with GyroCore (per measurement and overall), the four upstream-unsafe cases, fail-safe missing rate headers, log warnings, repeated axis                                                         |
| `test/gyrocore/chirp_qualification_pipeline.test.ts`  | Viewer samples used, buggy decoder never called, multi-log, same-axis across logs, all four states, diagnostic-only banner above the Bode plot and outside the panel, recommendation requires usable, recompute |
| `test/gyrocore/chirp_apply_gate.test.ts`              | handler-level gate: direct calls, no/unknown id, tampered sliders, mode OFF (log and live), yaw in RP, FF reversal, FF floor inflation, every block reason; no write when blocked                               |
| `test/gyrocore/chirp_gates.test.ts`                   | each gate on its own, the slider guard, and an English text for every reason code                                                                                                                               |
| `test/gyrocore/autotune_apply_blocked_ui.test.ts`     | Apply button disabled with reasons; a click cannot reach the action                                                                                                                                             |
| `test/gyrocore/air65_qualification.local.test.ts`     | AIR65 (local only), as above                                                                                                                                                                                    |

MSP is mocked in every test that reaches the Apply action; no test talks to a flight controller.

## Upstream files changed

See [UPSTREAM.md](UPSTREAM.md). In short:

- `src/composables/useAutotune.ts`: decode source, the qualification call, recompute, and the gate in
  `applyGains`; it removes the old decode/analyse helpers and exports `AUTOTUNE_MATH`. Upstream's
  "unsupported DEBUG_CHIRP axis encoding" error is replaced by GyroCore's drop-and-warn
  (`chirp_axis_out_of_range_frames_dropped`).

## Open items

- **Global sliders.** Apply writes one axis's sliders, which are global. GyroCore's three-axis merge
  (`merge.py`, `MERGE_REQUIRES_REVIEW`) is not migrated: it belongs to the Safety/review work.
- **Upstream `chirp_bbl_parser.ts` bug.** It is no longer on Gyroflight's path. Reporting it upstream is
  for the owner to decide; this fork makes no upstream PRs.
- **Diagnosis evidence** (completion %, sweep reached, coherence by band) is reported by CHIRP Quality V2
  (`CHIRP_QUALITY_V2.md`) as diagnostics next to the gates; it does not change them. An end-cause
  classifier from `diagnose_chirp.py` is not ported.
