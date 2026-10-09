# src/gyrocore — GyroCore engine namespace

GyroCore is the Redline Dynamics analysis, safety and tuning engine. It is being
migrated into Gyroflight (the Betaflight-based app) from the separate GyroCore
repository; see `docs/gyrocore/MIGRATION_MAP.md`. Nothing has been migrated yet.

Engine code consumes upstream Betaflight modules (Blackbox `FlightLog`, the
Autotune chirp parser and results, MSP via stores) and never replaces them.
Application glue (tabs, strings, product policy) belongs in `src/gyroflight/`.

## Planned subdirectories (created when first used)

| Path           | For                                                                |
| -------------- | ------------------------------------------------------------------ |
| `analysis/`    | Flight-log analysis (consumes upstream `FlightLog` / chirp parser) |
| `safety/`      | Safety validation of proposed tunes                                |
| `compare/`     | Log / tune comparison                                              |
| `integration/` | Adapters onto upstream modules (blackbox, autotune, MSP)           |
| `components/`  | GyroCore Vue components (evidence, review panels)                  |
| `composables/` | GyroCore composables                                               |
| `stores/`      | GyroCore Pinia stores                                              |

Tests go in `test/gyrocore/`.
