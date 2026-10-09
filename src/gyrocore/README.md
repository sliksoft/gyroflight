# src/gyrocore — GyroCore engine namespace

GyroCore is the Redline Dynamics analysis, safety and tuning engine. It is being
migrated into Gyroflight (the Betaflight-based app) from the separate GyroCore
repository; see `docs/gyrocore/MIGRATION_MAP.md`. Migrated so far: the CHIRP qualification gate in
front of Betaflight Autotune (`docs/gyrocore/CHIRP_QUALIFICATION.md`).

Engine code consumes upstream Betaflight modules (Blackbox `FlightLog`, the
Autotune chirp parser and results, MSP via stores) and never replaces them.
Application glue (tabs, strings, product policy) belongs in `src/gyroflight/`.

## Subdirectories

| Path           | Contents                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------ |
| `chirp/`       | CHIRP extraction from `FlightLog`, sample-rate/timing checks, quality and tune gates, Apply gate |
| `components/`  | `ChirpQualificationPanel.vue`, `DiagnosticOnlyBanner.vue`, `ApplyGateNotice.vue`                 |
| `composables/` | `useApplyGate`                                                                                   |
| `stores/`      | `chirpQualification` (every measurement, and which ones Autotune shows)                          |

## Planned subdirectories (created when first used)

| Path           | For                                                                |
| -------------- | ------------------------------------------------------------------ |
| `analysis/`    | Flight-log analysis (consumes upstream `FlightLog` / chirp parser) |
| `safety/`      | Safety validation of proposed tunes                                |
| `compare/`     | Log / tune comparison                                              |
| `integration/` | Adapters onto upstream modules (blackbox, autotune, MSP)           |

Tests go in `test/gyrocore/`.
