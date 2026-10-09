# GyroCore App — tuning architecture

## Decision

**Betaflight Autotune is the primary Betaflight-specific tuning baseline** wherever it applies
(CHIRP / system-identification logs, Expert mode). GyroCore does not replace it. GyroCore adds the
layers around it that make a proposed tune trustworthy and reviewable.

```
 blackbox log (CHIRP flight)
        │
        ▼
 Betaflight Autotune (upstream, unchanged)
   chirp_bbl_parser.ts → spectral_analysis.ts → recommendGains → stores/autotune
        │  proposed gains + Bode / spectrogram data
        ▼
 GyroCore (src/gyrocore/, later)
   1. measurement qualification   is this log fit to tune from?
   2. consistency checks          do axes / repeats / slider merge agree?
   3. safety validation           clamps and limits on the proposal
   4. evidence & explanation      why each change is proposed
   5. proposed-tune review        accept / reject per change
   6. safe output & rollback      (later) CLI snippet / MSP apply + saved previous tune
```

## Responsibilities

| Concern                                                                          | Owner                                                                       |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| CHIRP log parsing, transfer-function estimation                                  | Betaflight (`chirp_bbl_parser.ts`, `spectral_analysis.ts`)                  |
| Gain recommendation                                                              | Betaflight (`recommendGains`)                                               |
| Autotune UI (import, Bode, spectrogram, gains)                                   | Betaflight (`AutotuneTab.vue`, `tabs/autotune/`)                            |
| Measurement qualification (coverage, sample rate, debug mode, saturation, noise) | GyroCore (from `app/src/chirp/quality.ts`, `sampleRate.ts`, `sysconfig.ts`) |
| Global-slider merge / `MERGE_REQUIRES_REVIEW`                                    | GyroCore (from `core/gyrocore/autotune/merge.py`)                           |
| Safety validation                                                                | GyroCore (from `core/gyrocore/safety/`)                                     |
| Evidence / explanations / review                                                 | GyroCore                                                                    |
| Safe output, apply and rollback                                                  | GyroCore, through upstream stores / CLI; later                              |

GyroCore reads Autotune's results from `stores/autotune` and does not patch Autotune's code. If a
GyroCore check disagrees with upstream's output, the result is a review warning, not a silent override.

## The old GyroCore / AeroTuner tuner

The earlier custom tuner (AeroTuner `tuning_engine_v2`, `tuning_safe_v2*`, decision engines; and in
GyroCore the frozen legacy goldens, `safety/clamps.py`, `analysis/problem_detection_engine.py`) is
**not deleted and not ported as the primary tuner**.

- It stays a reference/regression implementation.
- It must not replace Betaflight Autotune without evidence. Evidence means a documented comparison on
  real logs (e.g. AIR65 and the CHIRP goldens) showing where it is better and that it is safe.
- Parts already identified as GyroCore-specific value (safety clamps, global-slider merge, filter evidence)
  migrate as _layers on top of_ Autotune, per [MIGRATION_MAP.md](MIGRATION_MAP.md).

## Non-CHIRP logs

Autotune only covers CHIRP logs. Tuning advice from ordinary flight logs (noise/filter analysis, step
response) comes later through GyroCore Analysis. It goes through the same Safety → review → safe output
path and is labelled as GyroCore analysis, not Betaflight Autotune.
