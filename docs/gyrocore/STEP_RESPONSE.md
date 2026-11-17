# Step response from ordinary flights (WU "Staprespons uit gewone vluchten" v3)

**Status:** diagnosis. The card shows how the loop responded to the stick in two ordinary Acro flights. It writes nothing and saves nothing. It is not a tune, a Verified Tune or an Apply, and it is not a Safety release.

**Code:**

| file                                           | role                                |
| ---------------------------------------------- | ----------------------------------- |
| `src/gyrocore/stepResponse/stepResponse.ts`    | pure computation                    |
| `stepLog.ts`                                   | Blackbox file → evidence per sample |
| `stepSettings.ts`                              | setting groups                      |
| `stepCompare.ts`                               | A/B                                 |
| `stepView.ts`                                  | chart geometry                      |
| `src/gyrocore/stores/stepResponse.ts`          | in-memory store                     |
| `src/gyrocore/components/StepResponseCard.vue` | the card, in Autotune → Compare     |

**Tests:** `test/gyrocore/step_response.test.ts`, `step_log.test.ts`, `step_compare.test.ts`, `step_response_card.test.ts`, and `air65_step_response.local.test.ts` (local logs).

## 1. Method references

These sources were used for the method only. This is an independent TypeScript implementation; no code was copied.

**PIDscope v26.10.1** (`github.com/dzikus/PIDscope`, tag `83cdd17d`), `src/core/PSstepcalc.m` (Brian White, PIDtoolbox lineage; the repository is GPL-3.0, the file itself Beerware). Taken from it:

- 2 s segments every 0.4 s (`subsampleFactor` 5);
- Hann window, zero padding;
- H = Y·conj(X)/(|X|²+ε), cumulative sum of the impulse response;
- 500 ms response, peak |setpoint| 40–500 deg/s.

**OpenPID PR #143** (`github.com/Rufics/OpenPID/pull/143`, head `47bb38d8`, closed without merge, MIT), `crates/openpid-analysis/src/step.rs` and `openpid-dsp/src/deconv.rs`. Taken from it:

- the threshold of 80 deg/s;
- a settle range of 0.5–1.5 as a check on each window.

**Deliberate differences from both:**

- **No Y correction.** The curve is never scaled to 1: the estimated steady-state gain is part of the result.
- **Final value outside 0.5–1.5 is flagged, not dropped.** The window stays in the primary result, and a second result without those windows is reported next to it.
- **Manoeuvres.** Windows are grouped into manoeuvres, and every manoeuvre weighs the same (no weighting by input amplitude).
- **ε.** ε is relative to the window's own AC input power (§2).
- **Excitation.** Besides the peak there is a 100 ms change test (§3).

## 2. Computation per window (`deconvolveStep`)

**Signals:** setpoint[a] and gyroADC[a] in deg/s, after the high-resolution descale (`descaleHighResolution`). Both use the same units, so the curve has no units, and 1 is the commanded step.

1. **Window:** N = round(2 s · fs) samples; a window starts every round(0.4 s · fs) samples. A window must lie entirely inside the log.
2. **Taper:** symmetric Hann over N samples (as `hann(N)`), applied to both signals.
3. **Zero padding:** both signals are padded at the end to N_fft, the smallest power of two ≥ N + L. L = floor(0.5 s · fs) + 1 is the length of the curve. For example: 4 kHz gives N_fft = 16384, 1 kHz gives 4096. The circular result therefore never wraps into 0–500 ms.
4. **FFT normalisation:** X and Y are unnormalised DFTs. The normalisation cancels in H, because ε is relative.
5. **Regularisation:** ε = 1e-3 · mean over k ≠ 0 of |X_k|². This is the mean AC input power of the padded window, excluding the DC bin. As a result ε does not depend on N_fft, on the units, or on a setpoint offset.
    - Test, noise at 20 dB SNR:
        - 1e-3 gives an overshoot error < 0.001;
        - 1e-1 flattens the overshoot by about 0.08;
        - 1e-5 lets the noise through (+0.17).
6. **Transfer function:** H_k = Y_k·conj(X_k) / (|X_k|² + ε).
7. **Impulse response:** h = real(IDFT(H)) / N_fft.
    - **Time zero:** h[0] is lag 0, so t = 0 ms; h[k] lies at k/fs.
    - **Negative lags:** the upper half of the circular result is negative lag. It is not summed.
8. **Step:** step[k] = Σ_{j≤k} h[j], for k = 0…L−1, which is 0…500 ms.
9. **DC:** no detrending. The DC bin is part of H like every other bin, so the curve keeps the estimated steady-state gain. Test: an offset of 150 deg/s changes the final value and the overshoot by less than 0.02.
10. A result that is not finite is rejected as `deconvolution_failed`.

**Metrics** (`stepMetrics`):

| metric          | definition                                                                                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **overshoot**   | max(curve over 0–500 ms) − 1, relative to the commanded step, not to the final value; can be negative                                                                                       |
| **peak time**   | the time of that maximum                                                                                                                                                                    |
| **t50**         | the first time the curve reaches 0.5 (half the commanded step), linearly interpolated between samples. If the curve never reaches it, there is no value ("not reached"); never 0, never 500 |
| **final value** | mean of the curve over 200–500 ms, both ends included: the estimated steady-state gain                                                                                                      |

## 3. Window selection

Every result is given per axis for both lower bounds, **40 and 80 deg/s**. A window is counted under the **first** reason that applies, in this order, so the reasons plus the used windows add up to the windows examined:

| #   | reason                     | when                                                                                                                                                                                                                                                                   |
| --- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `not_airborne`             | a sample outside a flight run. This reuses the M4 `segmentFlightLog` "flight" ranges: ARM set, rcCommand[3] ≥ 1150, no failsafe, 0.5 s trimmed at take-off, landing and long gaps. Flags before the first S-frame count as unknown, so not in flight                   |
| 2   | `frame_gap`                | a timestamp step inside the window > `SPACING_GAP_FACTOR` (1.5) × the median step, or ≤ 0. This is the same rule as `analyzeTimestampSpacing`. A local gap excludes only the windows over it                                                                           |
| 3   | `non_finite`               | NaN or Inf in the setpoint or gyro                                                                                                                                                                                                                                     |
| 4   | `chirp_active`             | the BOXCHIRP flag, where the firmware has the box, or a sweep segment from the existing `extractChirp`, where the debug mode is CHIRP. Plus 0.25 s guard on both sides (`SEGMENTATION_THRESHOLDS.chirpGuardS`). **A CHIRP debug mode without a sweep is not activity** |
| 5   | `mode_change`              | a change in the flight-relevant boxes inside the window: the boxes of 6, plus ARM, AIRMODE, ANTIGRAVITY and CHIRP                                                                                                                                                      |
| 6   | `self_level_or_automation` | ANGLE, HORIZON, MAG, ALTHOLD, BARO, HEADFREE, PASSTHRU, FAILSAFE, POSHOLD, GPSHOME, GPSHOLD, GPSRESCUE, AUTOPILOT, 3D, FPVANGLEMIX, FLIPOVERAFTERCRASH, ACROTRAINER, LAUNCHCONTROL                                                                                     |
| 7   | `saturation`               | a motor at either end of `motorOutput` (min or max)                                                                                                                                                                                                                    |
| 8   | `input_below_threshold`    | peak \|setpoint\| < threshold                                                                                                                                                                                                                                          |
| 9   | `input_above_max`          | peak \|setpoint\| > 500 deg/s                                                                                                                                                                                                                                          |
| 10  | `insufficient_change`      | the largest change of the setpoint (max − min) within any 100 ms stretch of the window is < threshold                                                                                                                                                                  |
| 11  | `deconvolution_failed`     | the result is not finite                                                                                                                                                                                                                                               |

**Mode names are read by name, per firmware.** They come from the Viewer's `FLIGHT_LOG_FLIGHT_MODE_NAME`, which `adjustFieldDefsList` sets for the firmware version of each log. The bit positions are not hardcoded.

- In Betaflight 4.5, bit 6 is FAILSAFE. From 2025.12 on it is CHIRP. A test covers this.
- Only bits 0–31 of the box mask are logged. ACROTRAINER and LAUNCHCONTROL lie beyond that and are listed as not logged in the log notes.

**Why the excitation is measured with the 100 ms change:** the curve describes the first 500 ms after a change of the setpoint. A window without such a change carries no information about it:

- A near-constant input above 80 deg/s (holding a roll rate) passes the peak test and fails the change test.
- A slow ramp from 0 to 200 deg/s over 2 s passes the peak test, has a 100 ms change of only 10 deg/s, and fails.
- Forced through the deconvolution, that ramp misses the true curve by > 0.2. A stick flick misses it by < 0.1.

All three are tests.

**Missing signals:**

| missing                                            | treated as                            | consequence                                                                                                      |
| -------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `flightModeFlags`                                  | the mode is unknown                   | **BLOCKED**: Acro cannot be confirmed                                                                            |
| `time`, setpoint or gyroADC                        | required                              | **BLOCKED**                                                                                                      |
| `rcCommand[3]`                                     | required for the flight runs          | **BLOCKED**                                                                                                      |
| motors, or the `motorOutput` header                | saturation unknown                    | windows are **not** excluded; the result says "saturation unknown", and an A/B requires saturation known in both |
| `failsafePhase`                                    | the failsafe phase is not checked     | the FAILSAFE box still counts; listed in the notes                                                               |
| CHIRP box (Betaflight 4.5) and no CHIRP debug mode | the firmware cannot run a CHIRP sweep | not counted as activity                                                                                          |

**BLOCKED** (the whole log, all axes) applies when:

- the log is unreadable;
- the firmware is not Betaflight, or its version is unknown;
- a required field is missing (see the table above);
- the time base is unusable. That is the case when the median Δt is unknown, or when `analyzeTimestampSpacing` is not `uniform`: fewer than 90 % uniform steps, or a step ≤ 0. Too many gaps also make the remaining windows unreliable;
- the header and timestamp rates disagree by more than 5 % (`resolveChirpSampleRate` "mismatch"), or no rate can be established;
- the sample rate is below 500 Hz.

## 4. Manoeuvres and aggregation

- **A manoeuvre** is a run of samples with |setpoint| ≥ threshold. Runs less than 0.2 s apart are merged (a stick reversal). A run longer than 2 s is split into pieces of at most 2 s, so a long freestyle stretch counts as several manoeuvres.
- **Assigning windows:** a window belongs to the manoeuvre that contains its sample of largest |setpoint|. A window over several manoeuvres is therefore counted once, under its strongest manoeuvre; the others are covered by their own windows. One manoeuvre in five overlapping windows counts as **1** (test).
- **Aggregation:**
    1. one curve per manoeuvre, the mean of its windows;
    2. across manoeuvres, with equal weight per manoeuvre: the mean curve, and the 25th and 75th percentile per time sample (linear interpolation);
    3. overshoot, peak time, t50 and final value are taken from the **mean curve**. The quartiles of the per-manoeuvre metrics are kept as spread.

**Status per axis and threshold:**

| status           | when                                   |
| ---------------- | -------------------------------------- |
| **MEASURED**     | at least 5 manoeuvres                  |
| **INSUFFICIENT** | fewer (`manoeuvres_below_minimum:n<5`) |
| **BLOCKED**      | see §3                                 |

**Why the minimum is 5.** A seeded Monte Carlo was run on the known second-order system at 14 dB SNR (1 kHz, 600 runs). It gives the 90th-percentile error of the overshoot, by manoeuvre count:

| manoeuvres | 90th-percentile overshoot error |
| ---------- | ------------------------------- |
| 1–3        | 0.17–0.20                       |
| 4          | 0.12                            |
| 5          | 0.10                            |
| 6–9        | 0.07–0.10                       |

- From 5 on the error levels off. t50 behaves the same: the 90th percentile is ≤ 1.4 ms from 5 on.
- A test keeps the property: at 5 or more manoeuvres the 90th percentile is ≤ 0.12, and at 3 or fewer it is clearly larger.
- This is a minimum on synthetic data. It has not yet been validated on real flights (§8).

**Final value outside 0.5–1.5.** The window is flagged and stays in the primary result. The card also reports the full aggregation **without** those windows. Manoeuvres can disappear there, and the status can drop to INSUFFICIENT.

## 5. A/B (`stepCompare.ts`, `stepSettings.ts`)

**Choosing A and B.** The card has its own Flight A/B over the logs imported in this browser tab.

- The Tune Session A/B (`FlightAbSelector`) only offers flights with a valid CHIRP, so an ordinary Acro flight cannot be chosen there, and its storage gets no schema change in this WU.
- From the existing selection, the card reuses:
    - the A/B model;
    - the rule that one flight cannot be A and B (`ab_same_flight_selected`);
    - `uniqueFlights`, so a flight imported in several files is offered once (the longest copy) and the other copies are not selectable;
    - `flightRelation` for independence.
- **Not gated behind expert mode, deliberately.** The card saves nothing and writes nothing; `FlightAbSelector` is gated because it saves Tune Sessions.

**Intent.** The user states what the A/B tests:

- **"no change":** a control on the spread between flights;
- **a group:** P, I, D, D Max, feedforward, D-term filter, gyro filter, TPA, iterm_relax or rates.

**How settings are compared:**

- Settings are compared as logged header text. PID values are split per axis and term (`roll_p`, …).
- `d_min` (Betaflight 4.5) and `d_max` count as the same D Max setting.
- The `simplified_*` slider keys are not compared. The firmware logs the PID, D Max, feedforward and filter values the sliders produce, so a slider move shows up in the group whose values changed.
- A group setting absent from either log is **UNKNOWN**. **UNKNOWN never counts as MATCH**, and it fails both intents.
- **"Other":** looptime, pid_process_denom, anti-gravity, I windup, pidsum limits, motor and idle settings, rc smoothing, deadband, throttle limits and similar settings must always MATCH. A key that is absent from both logs there is "not logged" (this firmware does not have it).
- **Rule per intent:**
    - "No change" requires every relevant setting to MATCH.
    - A group requires at least one DIFF in that group and MATCH everywhere else. A change elsewhere is named as `extra_change:…`.

**Comparability checks.** All of these must pass for a delta.

**Per pair:**

| check                  | rule                                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `both_analysed`        | neither log is BLOCKED                                                                                                                          |
| `independent_flights`  | `flightRelation` is INDEPENDENT. SAME (the same log, the same samples, ≥ 4 shared gyro windows) and UNKNOWN both give no delta, with the reason |
| `same_craft`           | DeviceUID and board equal                                                                                                                       |
| `same_firmware`        | firmware revision equal, including the build hash                                                                                               |
| `same_logging_rate`    | looptime, pid_process_denom, P interval, P ratio, I interval and blackbox_high_resolution equal, and the measured rates within 2 %              |
| `saturation_known`     | known in both                                                                                                                                   |
| `settings_as_intended` | as above                                                                                                                                        |

**Per axis and threshold:**

| check                   | rule                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `both_measured`         | both MEASURED                                                                           |
| `same_flight_mode`      | the same set of flight-relevant box words in the used windows, e.g. ARM+AIRMODE in both |
| `comparable_excitation` | median manoeuvre peak \|setpoint\| and median 100 ms change of B within ×2/3…×3/2 of A  |
| `comparable_coverage`   | the same stick directions present (+, −, or both)                                       |

**Delta:** B − A for overshoot, peak time, t50 and final value, only for the same axis and threshold, when both are MEASURED and every check passes.

- Otherwise the card shows the curves that exist, plus the exact failed checks as the reason the delta is missing.
- A t50 that one side does not reach gives no t50 delta.

**Pair status:**

| status | meaning |
|---|---|
| INCOMPLETE | A or B not chosen |
| NOT_COMPARABLE | a pair check failed |
| COMPARABLE_NO_DELTA | the pair checks pass, but no axis and threshold has a delta (for example nothing is MEASURED) |
| COMPARED | at least one delta |

**Flight-to-flight spread.** A "no change" pair gives the spread between flights (`controlSpread`). A change counts as above the spread only when its delta clearly exceeds the spread measured on comparable flights. One control pair is a first indication, not a distribution.

## 6. iterm_relax and feedforward

The card shows from the log header:

- `iterm_relax`, `iterm_relax_type` and `iterm_relax_cutoff`;
- `ff_weight` and the feedforward settings;
- whether `axisF` is logged.

The curve describes the response of the **active** loop during that flight: P, I, D, D Max, feedforward, iterm_relax, TPA and filters as they acted then, from setpoint to gyro. It does not separate those parts, and it does not describe the plant alone.

## 7. Acceptance criteria and tests

These were fixed before verification (dossier `PLAN.md`, 17 November 2026). All are covered by `step_response.test.ts`.

| criterion             | requirement                                                                                                 | result                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| synthetic, noise-free | second order (ζ 0.5, fn 20 Hz, delay 5 ms, K 1.0 and 0.8): final ±0.03, overshoot ±0.03, peak and t50 ±2 ms | met                                                |
| with noise, 20 dB SNR | ±0.06 and ±4 ms                                                                                             | met                                                |
| ε                     | the chosen ε gives an error ≤ 0.03; 100× larger and 100× smaller are both worse by > 0.03                   | met                                                |
| exclusions            | each rule gives the right reason; a local gap excludes exactly the windows over it                          | met (`step_log.test.ts` decodes real BBLs)         |
| manoeuvres            | one manoeuvre in five windows counts as 1; the status follows the manoeuvre count                           | met                                                |
| A/B                   | same tune, one expected change, an extra change, UNKNOWN, not comparable, a flight imported twice           | `step_compare.test.ts`                             |
| UI                    | through the normal import, a file without CHIRP reaches the card, which shows status, curves and rejections | `step_response_card.test.ts` and the browser check |

## 8. Limits and open validation

- **The minimum of 5 manoeuvres** and the excitation ratio ×2/3…×3/2 are justified on synthetic data. They have not yet been checked against real flights.
- **The flight runs reuse the M4 take-off threshold** (rcCommand[3] ≥ 1150). A craft that hovers below it is counted as on the ground.
- **The M4 segmentation hardcodes the 2025.12+ bit positions** for ANGLE/HORIZON/CHIRP. Only its flight ranges are used here, and those rely on ARM (bit 0 in every table) and the throttle. The mode exclusions are read by name per firmware. The M4 issue itself is outside this WU.
- **Box bits beyond 31 are not logged:** ACROTRAINER and LAUNCHCONTROL.
- **Not in this WU:** the throttle heatmap, a second CHIRP estimator, validation with pichim's logs, and permanent storage.
