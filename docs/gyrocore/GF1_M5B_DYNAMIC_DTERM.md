# GF-1 M5-B — Dynamic D-term path

Offline only. No MSP, no recommendation, no Apply path; `applyAllowed` and `recommendationsEnabled`
stay false everywhere and the phase margin stays `NOT_VALIDATED`.

## Why

M1 models `dterm_lpf1` at `dterm_lpf1_static_hz` (AIR65: 75 Hz). With `dterm_lpf1_dyn_min_hz > 0`
Betaflight moves that cutoff with throttle, and on an axis with `d_max > D` it scales Kd with the
D_max boost. On the AIR65 logs the static model was 20 % off the logged D path (M5-A), and the plant
`G` that M3 inverts moved by 7–10 % because of it.

## Firmware path (Betaflight 2026.6.2)

| Step          | Source                                                                                                                       | Modelled as                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Throttle      | `mixer.c` normal mode: `(rcCommand[3] − 1000 + throttleAngleCorrection) / 1000`, clamped                                     | logged `rcCommand[3]`; angle correction assumed 0 (not logged, firmware default)             |
| Cutoff update | `updateDynLpfCutoffs`: throttle quantized to 1/100, at most every 5 ms, only on change; runs in the mixer after the PID loop | same; the new cutoff acts on the next sample                                                 |
| Cutoff        | `dynLpfCutoffFreq` (expo > 0) or `max(dynThrottle(t)·max, min)`                                                              | `dynLpfCutoffHz`                                                                             |
| D input       | `lpf2(lpf1(notch(gyroADCf)))`, then `−Δ·pidFrequency`                                                                        | logged `gyroADC` (rounded to integers by the blackbox)                                       |
| D_max         | `pt2(85 Hz)` of Δ × `0.00008·d_max_gain/35`, setpoint part, `pt2(35 Hz)`, capped at `d_max/D`                                | gyro part; in ANGLE the setpoint part is 0 (`pid.c`), in acro it is reported as not modelled |
| TPA           | `getTpaFactorClassic`, always on D                                                                                           | same, including the low-breakpoint fade                                                      |

Unsupported options return no simulation instead of an approximation: non-PT1 `dterm_lpf1/2`, a D-term
notch, `throttle_limit_type ≠ OFF`. Every dropped frame restarts the filters, and 0.1 s of warm-up is
discarded.

## Validation against the logged axisD (AIR65 BBL18 / BBL19, flight samples)

| Model                                    | NRMSE         | gain / phase 2–20 Hz | 20–80 Hz          | 80–200 Hz            |
| ---------------------------------------- | ------------- | -------------------- | ----------------- | -------------------- |
| Static 75 Hz (M1)                        | 10.0–13.5 %   | +0.8 %, +2.7°        | +9.4 %, +8.1–8.4° | +24–26 %, +8.6°      |
| **Dynamic (this module)**                | **3.6–4.3 %** | 0.0 %, 0.0°          | −0.2 %, ≤ 0.03°   | −1.0…−2.1 %, ≤ 0.06° |
| Dynamic without D_max (roll)             | 6.8–6.9 %     | +5.5 %, −0.55°       | +2.4 %, −0.2°     | +0.1…−0.8 %          |
| Fixed 110 Hz (M5-A fit, comparison only) | 3.6–4.3 %     | 0.0 %                | −0.2…−0.3 %       | −1.2…−2.2 %          |

The remaining 4 % is mostly the integer rounding of the logged `gyroADC` and `axisD`.

The cutoff in force was 90–118 Hz (median 108.9 / 109.8 Hz); throttle hardly moved during these
flights. A fixed 110 Hz therefore fits almost as well: these logs confirm the firmware formula at
hover throttle, but they test the throttle-dependence itself only weakly. A flight with real throttle
changes is needed for that.

## Use in M1–M3

`effectiveDtermOverWindow(sim, start, end)` gives the median cutoff and the mean D_max × TPA scale over
a window, and `withEffectiveDterm(cfg, eff)` returns the M1 config with those values. Per CHIRP sweep
(AIR65):

|                                                | Roll 18             | Pitch 18            | Roll 19             | Pitch 19            |
| ---------------------------------------------- | ------------------- | ------------------- | ------------------- | ------------------- |
| Effective cutoff (Hz)                          | 108.9               | 108.9               | 108.9               | 109.8               |
| Kd scale (mean; p5–p95)                        | 1.017 (0.984–1.072) | 0.996 (0.982–1.000) | 1.018 (0.984–1.075) | 0.997 (0.984–1.000) |
| LTI D-path error 10–150 Hz, static → effective | 20.8 % → 1.7 %      | 19.9 % → 0.7 %      | 20.5 % → 2.1 %      | 19.7 % → 1.3 %      |
| Plant G shift                                  | 7.7 %               | 10.0 %              | 7.3 %               | 9.0 %               |
| Diagnostic PM (NOT_VALIDATED)                  | 15.4° → 15.0°       | 17.7° → 17.0°       | 15.9° → 15.4°       | 19.4° → 18.8°       |
| \|S\| peak                                     | 13.84 → 13.78 dB    | 13.04 → 12.98 dB    | 12.62 → 12.48 dB    | 11.58 → 11.51 dB    |

Cross-log plant reproducibility is unchanged (roll 4.3 % → 4.4 %, pitch 4.0 % → 4.1 %). The static
`air65*Config()` header configs are unchanged; callers opt in with `withEffectiveDterm`.

## Limits

- The roll D_max boost is state-dependent. The LTI stand-in uses its mean (≈ 1.02); its p95 is 1.07.
- In acro the setpoint (feedforward) part of D_max is not modelled.
- The dynamic gyro LPF1 (150–300 Hz) is still modelled at 150 Hz in M1. It sits inside the measured `T`,
  so it does not enter the plant inversion, but it matters for a predicted `T`.
- Dyn-notch centres and the RPM-filter schedule are still unknown, so the phase margin stays
  `NOT_VALIDATED` and Apply stays blocked.

## Tests

- `test/js/betaflight_dterm_dynamic_m5b.test.ts` (CI): firmware formulas, quantization, the 5 ms rate
  limit, TPA and D_max on D itself, gap handling, the M1 FRF at the throttle's cutoff (not 75 Hz), and
  acceptance only for the model that produced a synthetic log.
- `test/js/air65_dterm_dynamic.local.test.ts` (local, `GYROFLIGHT_AIR65_BBL18/19`): the acceptance above
  on the real logs.
