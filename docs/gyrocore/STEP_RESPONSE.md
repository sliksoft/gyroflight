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
| 7   | `saturation`               | a motor at either end of `motorOutput` (min or max), or a motor value that is not finite                                                                                                                                                                               |
| 8   | `input_below_threshold`    | peak \|setpoint\| < threshold                                                                                                                                                                                                                                          |
| 9   | `input_above_max`          | peak \|setpoint\| > 500 deg/s                                                                                                                                                                                                                                          |
| 10  | `insufficient_change`      | the largest change of the setpoint (max − min) within any 100 ms stretch of the window is < threshold                                                                                                                                                                  |
| 11  | `peak_off_centre`          | the sample of largest \|setpoint\| lies outside 40–70 % of the window (see below)                                                                                                                                                                                      |
| 12  | `deconvolution_failed`     | the result is not finite                                                                                                                                                                                                                                               |

**Why the peak must lie in the centre of the window.** Hann on both signals is exact only where the taper is nearly flat over the 500 ms response. A single flick with its onset in the outer quarter of the window is biased by the taper and the cut-off tail: overshoot and final value deviate by 0.03–0.12, against ≤ 0.03 over the band (Grok review rounds 1 and 2, reproduced in the test "window position"). A window is therefore used only when its sample of largest |setpoint| lies at 40–70 % of the window.

What the rule costs (Grok review round 2):

- **Isolated flicks keep a window**, away from the edges below. The band is 0.6 s wide, wider than the hop of 0.4 s, so every sample lies in the band of at least one window.
- **A smaller flick next to a larger one is lost.** A flick within about 1–1.4 s of a larger one is never the largest |setpoint| of a window that has it in its band, so it is not counted (test "a smaller flick next to a larger one"). Fewer manoeuvres make INSUFFICIENT more likely (conservative). Of two flicks closer than that, only the larger one counts, so the mean leans toward larger flicks: with a linear loop that changes nothing; with TPA, motor limits or feedforward shaping the response can depend on amplitude.
- **Edges.** A flick whose peak lies in the first ~0.8 s or the last ~0.6 s of a usable stretch (log start or end, next to a frame gap, mode change, CHIRP or ground) is not counted.
- **Remaining bias over the band:** +0.015 at 40 % to −0.022 at 70 % for a 150 ms flick, up to +0.03 for long holds whose peak falls late. That is below the 90th-percentile noise error of about 0.09 at 5 manoeuvres.

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

**Why the minimum is 5.** A seeded Monte Carlo was run on the known second-order system at 14 dB SNR (1 kHz, 600 runs, with the centre-band rule of §3). It gives the 90th-percentile error by manoeuvre count:

| manoeuvres | overshoot error | t50 error  |
| ---------- | --------------- | ---------- |
| 1          | 0.23            | 3.0 ms     |
| 2          | 0.15            | 2.0 ms     |
| 3          | 0.12            | 1.5 ms     |
| 4          | 0.10            | 1.3 ms     |
| 5          | 0.09            | 1.3 ms     |
| 6–8        | 0.08–0.10       | 1.0–1.1 ms |

- From 5 on the error levels off; 5 is a soft knee, not a sharp optimum.
- A test keeps the property: at 5 or more manoeuvres the 90th percentile is ≤ 0.12, and at 3 or fewer it is clearly larger.
- This is a minimum on synthetic data (linear plant, white noise). It has not yet been validated on real flights (§8).
- With fewer manoeuvres the card still shows the curve and the numbers, in brackets and marked as an indication only.

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
- `d_min` (Betaflight 4.5) and `d_max` count as the same D Max setting, and so do `dshot_idle_value` (Betaflight 4.5) and `motor_idle` (renamed in firmware 5ffeea6ab, #13936).
- The `simplified_*` slider keys are not compared. The firmware logs the PID, D Max, feedforward and filter values the sliders produce, so a slider move shows up in the group whose values changed.
- **A setting whose value is missing is UNKNOWN**, whether it is missing from one log or from both. **UNKNOWN never counts as MATCH**, and it fails both intents; two missing values are never two equal values. An empty value, or an empty element of a list (`rollPID:56,79`), counts as missing. The card labels the setting "Not logged in A", "Not logged in B" or "Not logged (A and B)", keeps both curves and gives no delta. The reason is `settings_not_logged:<ids>` (missing from both) or `settings_unknown:<ids>` (missing from one, or a conflicting duplicate). Decision of 2026-11-18; until then a setting missing from both logs counted as "not logged" and did not block the A/B.
- **The one exception: a setting the logged build does not have.** `STEP_FIRMWARE_ABSENT` lists, per build hash, settings that the firmware source shows that build lacks (checked in `src/main/cli/settings.c`, `parameter_names.h` and `blackbox.c` at that hash, and in the AIR65 headers of that build). A setting missing from both logs is `NOT_IN_FIRMWARE`, and not compared, only when **both** logs name the same listed build as a delimited token in "Firmware revision", and only for the listed setting. Any other build, a longer hex string, or a setting not listed, stays UNKNOWN. The card lists these settings separately. The entries:

    | build                                      | not in the build                     | firmware source                                                                                                                                                                                                          |
    | ------------------------------------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
    | `43875a55a`, `3356aeb02` (2026.6.2, AIR65) | `abs_control_gain`                   | removed in 19ddd692c "Remove absolute control" (#15023)                                                                                                                                                                  |
    | `43875a55a`, `3356aeb02`                   | `rc_smoothing_feedforward_cutoff`    | removed in 67abb0d1e (#14411). The feedforward is then smoothed with the setpoint cutoff (`rc.c`, `pt3K_SP`), which is logged and compared as `rc_smoothing_setpoint_cutoff` and `rc_smoothing_active_cutoffs_ff_sp_thr` |
    | `77d01ba3b` (4.5.1)                        | `feedforward_yaw_hold_gain`, `_time` | added in f2bd6e69b (#13576), first in 2026.6.0                                                                                                                                                                           |

    A build is added only after the same source check. The table is local to the step A/B; the autotune engine's own table (`autotuneV2.ts`) is unchanged.

- A group whose settings are all missing cannot be the intended change: the reasons are `settings_not_logged` and `expected_change_missing`.
- **Fail closed: every logged key is compared.** Besides the named groups, every further header key present in either log counts under **"other"** and must MATCH: looptime, pid_process_denom, anti-gravity, I windup, pidsum limits, motor and idle settings, rc smoothing, deadband, throttle limits, acc limits, airmode and EZ-landing settings, `features`, and any key this list does not know. A key that differs is a change; a key in one log only is UNKNOWN.
- **Group mapping of less obvious keys:** `feedforward_yaw_hold_gain` / `_time` count as feedforward; `gyro_hardware_lpf` counts as gyro filter. `motor_poles` and `dshot_bidir` count as "other": besides the RPM filter they also drive dynamic idle, so a change there is never a pure filter change (Grok review round 4).
- **Not compared** (`NOT_COMPARED_KEYS`), because they are not tune settings or have no effect on the Acro windows used:
    - identity, format and logging: product, firmware, board, craft name, DeviceUID, field definitions, I/P interval and ratio, `blackbox_high_resolution` (identity and logging rate are separate checks);
    - measurement set-up: `chirp_*`, `debug_mode`, `fields_disabled_mask`, the debug-axis keys;
    - sensor scales without effect on the rate loop: `gyro_scale`, `acc_1G`, `currentSensor`. `vbat_scale` and `vbatcellvoltage` **are** compared, because vbat sag compensation uses them (Grok review round 4). `vbatref` is not compared as a setting: it is the battery voltage sampled when the log starts, a flight state like the charge level, and it differs between every two flights (AIR65: 377–423). The battery state is checked instead by the measured `comparable_battery` check per axis and threshold below;
    - the slider inputs `simplified_*` (their results are compared). The active rc smoothing cutoffs and the link rate (`rc_smoothing_active_cutoffs*`, `rc_smoothing_rx_smoothed`) **are** compared: the feedforward cutoff acts between the logged setpoint and the motors, so two flights on different radio links are not a control pair (Grok review round 4). Because the firmware computes these from the measured RX frame rate, they jitter on one link (AIR65 20261106_011849: 106 and 107 Hz); each element is compared with a 5 % relative tolerance, so a link change of a factor 2 stays a difference. That tolerance was chosen after seeing the jitter on the AIR65 logs. Every other setting is compared exactly;
    - self-levelling and autopilot only: `levelPID`, `angle_*`, `horizon_*`, `ap_*`, `altitude_*` (windows in those modes are excluded).
- **A key logged twice with different values**, or a log carrying both a key and its alias (`d_max` and `d_min`), is UNKNOWN (`duplicate_key_conflict`), never a value. The logging-rate keys of `same_logging_rate` follow the same rule.
- **Link tolerance, details:** only plain decimal elements are compared numerically; an empty, hexadecimal or exponent element, or a different number of elements, is compared as exact text. The 5 % rests on one observed jitter pair (1 %); it should be re-examined if a same-link pair ever differs by more than about 3 %.
- **On the AIR65 logs:** besides `chirp_*` (measurement set-up), 20261106_011849 was flown on another radio link than the earlier logs: `rc_smoothing_rx_smoothed` 250 instead of 125 Hz, so the active feedforward cutoff is 106 instead of 53 Hz. Those pairs are therefore no control pairs; that is intended.
- **Rule per intent:**
    - "No change" requires every relevant setting to MATCH.
    - A group requires at least one DIFF in that group and MATCH everywhere else. A change elsewhere is named as `extra_change:…`.

**Comparability checks.** All of these must pass for a delta.

**Per pair:**

| check                  | rule                                                                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `both_analysed`        | neither log is BLOCKED                                                                                                                             |
| `independent_flights`  | `flightRelation` is INDEPENDENT. SAME (the same log, the same samples, ≥ 4 shared gyro windows) and UNKNOWN both give no delta, with the reason    |
| `same_craft`           | DeviceUID and board equal                                                                                                                          |
| `same_firmware`        | firmware revision equal, including the build hash                                                                                                  |
| `same_logging_rate`    | looptime, pid_process_denom, P interval, P ratio, P num, P denom, I interval and blackbox_high_resolution equal, and the measured rates within 2 % |
| `saturation_known`     | known in both                                                                                                                                      |
| `settings_as_intended` | as above                                                                                                                                           |

**Per axis and threshold:**

| check                   | rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `both_measured`         | both MEASURED                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `same_flight_mode`      | the same set of flight-relevant box words in the used windows, e.g. ARM+AIRMODE in both                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `comparable_excitation` | median manoeuvre peak \|setpoint\| and median 100 ms change of B within ×2/3…×3/2 of A                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `comparable_coverage`   | the same stick directions present (+, −, or both)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `comparable_battery`    | the median logged battery voltage (`vbatLatest`) over the samples of the **used windows** of this axis and threshold, A against B, within 5 % of the larger (symmetric); not logged: fail (Grok review rounds 6 and 7). At a fixed motor command thrust scales roughly with V², so 5 % voltage is about 10 % actuator authority: a delta that is not clearly larger than that effect cannot be attributed to the tune. The whole-flight median is shown per log in the card's log list, for information only; a battery signal of another length than the log gives no value |

**Delta:** B − A for overshoot, peak time, t50 and final value, only for the same axis and threshold, when both are MEASURED and every check passes.

- Otherwise the card shows the curves that exist, plus the exact failed checks as the reason the delta is missing.
- A t50 that one side does not reach gives no t50 delta.

**Pair status:**

| status              | meaning                                                                                       |
| ------------------- | --------------------------------------------------------------------------------------------- |
| INCOMPLETE          | A or B not chosen                                                                             |
| NOT_COMPARABLE      | a pair check failed                                                                           |
| COMPARABLE_NO_DELTA | the pair checks pass, but no axis and threshold has a delta (for example nothing is MEASURED) |
| COMPARED            | at least one delta                                                                            |

**Flight-to-flight spread.** A "no change" pair gives the spread between flights (`controlSpread`). A change counts as above the spread only when its delta clearly exceeds the spread measured on comparable flights. One control pair is a first indication, not a distribution.

## 6. iterm_relax and feedforward

The card shows from the log header:

- `iterm_relax`, `iterm_relax_type` and `iterm_relax_cutoff`;
- `ff_weight` and the feedforward settings;
- whether `axisF` is logged.

The curve describes the response of the **active** loop during that flight: P, I, D, D Max, feedforward, iterm_relax, TPA and filters as they acted then, from setpoint to gyro. It does not separate those parts, and it does not describe the plant alone.

## 7. Acceptance criteria and tests

These were fixed before verification (dossier `PLAN.md`, 17 November 2026). All are covered by `step_response.test.ts`.

| criterion             | requirement                                                                                                                                                                                                                                                                                                                           | result                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| synthetic, noise-free | second order (ζ 0.5, fn 20 Hz, delay 5 ms, K 1.0 and 0.8): final ±0.03, overshoot ±0.03, peak and t50 ±2 ms                                                                                                                                                                                                                           | met                                                |
| with noise, 20 dB SNR | ±0.06 and ±4 ms                                                                                                                                                                                                                                                                                                                       | met                                                |
| ε                     | the chosen ε gives an error ≤ 0.03; 100× larger and 100× smaller are both worse by > 0.03                                                                                                                                                                                                                                             | met                                                |
| exclusions            | each rule gives the right reason; a local gap excludes exactly the windows over it                                                                                                                                                                                                                                                    | met (`step_log.test.ts` decodes real BBLs)         |
| manoeuvres            | one manoeuvre in five windows counts as 1; the status follows the manoeuvre count                                                                                                                                                                                                                                                     | met                                                |
| A/B                   | same tune, one expected change, an extra change, UNKNOWN, not comparable, a flight imported twice; a setting missing from both logs, from one log, an empty value, the firmware table (listed build, other build, unlisted setting), the alias `motor_idle`, the exclusion list, and a positive control pair with every setting known | `step_compare.test.ts`                             |
| UI, not logged        | through the normal import: missing from both logs and from one log name the setting and side, keep both curves and show no delta                                                                                                                                                                                                      | `step_response_card.test.ts`                       |
| UI                    | through the normal import, a file without CHIRP reaches the card, which shows status, curves and rejections                                                                                                                                                                                                                           | `step_response_card.test.ts` and the browser check |

## 8. Limits and open validation

- **The minimum of 5 manoeuvres** and the excitation ratio ×2/3…×3/2 are justified on synthetic data. They have not yet been checked against real flights.
- **The flight runs reuse the M4 take-off threshold** (rcCommand[3] ≥ 1150). A craft that hovers below it is counted as on the ground.
- **The M4 segmentation hardcodes the 2025.12+ bit positions** for ANGLE/HORIZON/CHIRP. Only its flight ranges are used here, and those rely on ARM (bit 0 in every table) and the throttle. The mode exclusions are read by name per firmware. The M4 issue itself is outside this WU.
- **Box bits beyond 31 are not logged:** ACROTRAINER and LAUNCHCONTROL. Bit 31 itself (PREARM in 2025.12+) is cleared before use, so it cannot read as the "no S-frame yet" marker.
- **Not in this WU:** the throttle heatmap, a second CHIRP estimator, validation with pichim's logs, and permanent storage.
- **The next practical step (not yet flown)** is a control pair on the AIR65: two ordinary Acro recordings with the same tune and no CHIRP. They show per axis how many usable manoeuvres an ordinary flight gives, and the natural flight-to-flight spread of overshoot and t50. Whether a third flight with one tune change follows, and which change, is decided from that control pair: only when the axis has ≥ 5 manoeuvres in both flights and the spread is known. The browser demo of this WU uses synthetic files: it is evidence for the software, not an AIR65 measurement.
