# src/gyrocore — GyroCore engine namespace

GyroCore is the Redline Dynamics analysis, safety and tuning engine. It is being
migrated into Gyroflight (the Betaflight-based app) from the separate GyroCore
repository; see `docs/gyrocore/MIGRATION_MAP.md`. Migrated so far: the CHIRP qualification gate in
front of Betaflight Autotune (`docs/gyrocore/CHIRP_QUALIFICATION.md`) and the global-slider merge
with composite Apply authorization (`docs/gyrocore/GLOBAL_TUNE_MERGE.md`).

Engine code consumes upstream Betaflight modules (Blackbox `FlightLog`, the
Autotune chirp parser and results, MSP via stores) and never replaces them.
Application glue (tabs, strings, product policy) belongs in `src/gyroflight/`.

## Subdirectories

| Path           | Contents                                                                                                                                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `flight/`      | File and Flight identity: SHA-256 per file and per log section, A/B independence check (`docs/gyrocore/FLIGHT_IDENTITY.md`)                                                                                           |
| `chirp/`       | CHIRP extraction from `FlightLog`, sample-rate/timing checks, quality and tune gates, Apply gate; `qualityV2/` diagnostics (`docs/gyrocore/CHIRP_QUALITY_V2.md`)                                                      |
| `session/`     | Tune Session storage: versioned contract, validation, migrations, local IndexedDB store, A/B evidence (`docs/gyrocore/TUNE_SESSION.md`); Flight A/B selection (`selection.ts`, `docs/gyrocore/FLIGHT_AB_SELECTOR.md`) |
| `tuning/`      | GyroCore global-slider merge (port of `merge.py`), composite recommendation, axis coverage, Apply gate v2                                                                                                             |
| `safety/`      | GyroCore Safety, deterministic foundation (WU4A): firmware slider mapping, absolute tune, staged pipeline without analysis evidence                                                                                   |
| `productLock/` | product Apply lock (`full_safety_engine_pending`) until the Safety engine is migrated (WU4)                                                                                                                           |
| `components/`  | `ChirpQualificationPanel.vue`, `ChirpQualityV2Card.vue`, `DiagnosticOnlyBanner.vue`, `GlobalTunePanel.vue`, `ApplyGateNotice.vue`, `FlightAbSelector.vue`                                                             |
| `composables/` | `useApplyGate`, `useFlightAbSelector`                                                                                                                                                                                 |
| `stores/`      | `chirpQualification` (every measurement, and which ones Autotune shows)                                                                                                                                               |

## Planned subdirectories (created when first used)

| Path           | For                                                                |
| -------------- | ------------------------------------------------------------------ |
| `analysis/`    | Flight-log analysis (consumes upstream `FlightLog` / chirp parser) |
| `safety/`      | Safety validation of proposed tunes                                |
| `compare/`     | Log / tune comparison                                              |
| `integration/` | Adapters onto upstream modules (blackbox, autotune, MSP)           |

Tests go in `test/gyrocore/`.
