# Gyroflight — tuning architecture

Gyroflight is the application (this repository, a fork of the Betaflight App). GyroCore is the
Redline Dynamics analysis/safety engine being migrated into Gyroflight. Betaflight remains the upstream
application and platform.

## Decision

**Betaflight Autotune is the primary Betaflight-specific tuning baseline** wherever it applies
(CHIRP / system-identification logs, Expert mode). GyroCore does not replace it. GyroCore adds the
layers around it that make a proposed tune trustworthy and reviewable.

Authority chain, as implemented (WU1–WU3):

```
 blackbox log (CHIRP flight)
        │
        ▼
 Betaflight Blackbox Viewer parser (FlightLog)                 decode               Betaflight
        │  every embedded log, every CHIRP segment
        ▼
 GyroCore measurement qualification (src/gyrocore/chirp/)      valid for tuning?    GyroCore
        │  usable measurements only
        ▼
 Betaflight tuning math (spectral_analysis.ts, recommendGains) per-axis proposal   Betaflight
        │  per-axis recommendations = evidence
        ▼
 GyroCore global merge (src/gyrocore/tuning/merge.ts)          one global set       GyroCore
        │  composite recommendation
        ▼
 GyroCore axis-coverage authorization (src/gyrocore/tuning/)  complete & current? GyroCore
        │  every axis the slider mode drives has its own evidence;
        │  composite gate + live flight-controller recheck
        ▼
 GyroCore Safety [WU4 pending] (src/gyrocore/productLock/)         may it be written?   GyroCore
        │  until migrated: product Apply lock, full_safety_engine_pending
        ▼
 FC Apply (MSP_SET_SIMPLIFIED_TUNING, EEPROM)                  write                Betaflight MSP
```

The axis-coverage authorization is not the Safety engine. Until GyroCore's Safety engine
(`core/gyrocore/safety/`) is migrated and qualified (WU4), the product Apply lock keeps Gyroflight from
writing any tune to a craft. Still to come after that: evidence and per-change review, rollback.
Details: [CHIRP_QUALIFICATION.md](CHIRP_QUALIFICATION.md) (WU2) and
[GLOBAL_TUNE_MERGE.md](GLOBAL_TUNE_MERGE.md) (WU3, WU3.1).

## Responsibilities

| Concern                                                                        | Owner                                                                       |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| CHIRP log decoding                                                             | Betaflight Blackbox Viewer `FlightLog` (not `chirp_bbl_parser.ts`, WU1/WU2) |
| Transfer-function estimation, per-axis gain recommendation                     | Betaflight (`spectral_analysis.ts`, `recommendGains`)                       |
| Autotune UI (import, Bode, spectrogram, per-axis gains)                        | Betaflight (`AutotuneTab.vue`, `tabs/autotune/`)                            |
| Measurement qualification (coverage, sample rate, debug mode, gaps, coherence) | GyroCore, `src/gyrocore/chirp/` (WU2)                                       |
| Global-slider merge / `MERGE_REQUIRES_REVIEW`                                  | GyroCore, `src/gyrocore/tuning/` (WU3, from `autotune/merge.py`)            |
| Apply authorization (composite gate, live FC recheck)                          | GyroCore, `src/gyrocore/tuning/authorize.ts` (WU3)                          |
| Full safety validation                                                         | GyroCore (from `core/gyrocore/safety/`), later                              |
| Evidence / explanations / review                                               | GyroCore                                                                    |
| Rollback                                                                       | GyroCore, later                                                             |

GyroCore does not change Betaflight's math. It decides which measurements Betaflight may recommend from,
merges the per-axis recommendations into the one global slider set the firmware actually has, and
decides whether that set may be written. When a check disagrees with upstream's output, the result is a
visible block or review, never a silent override. The small hooks in Autotune's own files are listed
in [UPSTREAM.md](UPSTREAM.md).

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
