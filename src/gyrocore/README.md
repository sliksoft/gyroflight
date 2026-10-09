# src/gyrocore — GyroCore extension namespace

GyroCore-specific code lives here, beside the Betaflight App. Betaflight's own
implementations (Firmware Flasher, Blackbox Viewer, Autotune, serial/USB
transports, PWA, MSP) stay where upstream keeps them and are used unchanged.

See `docs/gyrocore/UPSTREAM.md` for the rules and `docs/gyrocore/ARCHITECTURE.md`
for how this namespace plugs into the app.

## Current contents

| Path                   | Purpose                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `tabs.ts`              | Tab metadata (key, sidebar item, allowed-tab list). No Vue imports, safe for `gui.js`.       |
| `components.ts`        | Tab component map spread into `src/js/vue_tab_registry.js`; registers GyroCore strings.      |
| `i18n.ts`              | Merges `locales/en.json` into the English fallback bundle without overwriting upstream keys. |
| `locales/en.json`      | GyroCore English strings (kept out of upstream `locales/en/messages.json`).                  |
| `capabilities.ts`      | Read-only capability statements shown on the GyroCore tab.                                   |
| `tabs/GyroCoreTab.vue` | Foundation proof tab.                                                                        |

## Planned subdirectories (created when first used)

| Path           | For                                                                |
| -------------- | ------------------------------------------------------------------ |
| `components/`  | Shared GyroCore Vue components                                     |
| `composables/` | GyroCore composables                                               |
| `stores/`      | GyroCore Pinia stores                                              |
| `analysis/`    | Flight-log analysis (consumes upstream `FlightLog` / chirp parser) |
| `safety/`      | Safety validation of proposed tunes                                |
| `compare/`     | Log / tune comparison                                              |
| `integration/` | Adapters onto upstream modules (blackbox, autotune, MSP)           |

Tests go in `test/gyrocore/`.
