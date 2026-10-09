# src/gyroflight — Gyroflight application integration

Gyroflight is the Betaflight-based application and PWA. This directory holds the
product-level glue that plugs Gyroflight into the Betaflight App: tab
registration, strings, the product tab and fork policy flags. The GyroCore
engine itself (analysis, safety, compare) lives in `src/gyrocore/`.

Betaflight's own implementations (Firmware Flasher, Blackbox Viewer, Autotune,
serial/USB transports, PWA, MSP) stay where upstream keeps them.

| Path                     | Purpose                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------- |
| `tabs.ts`                | Tab metadata (key, sidebar item, allowed-tab list). No Vue imports, safe for `gui.js`.       |
| `components.ts`          | Tab component map spread into `src/js/vue_tab_registry.js`; registers Gyroflight strings.    |
| `i18n.ts`                | Merges `locales/en.json` into the English fallback bundle without overwriting upstream keys. |
| `locales/en.json`        | Gyroflight English strings (kept out of upstream `locales/en/messages.json`).                |
| `capabilities.ts`        | Read-only capability statements shown on the Gyroflight tab.                                 |
| `tabs/GyroflightTab.vue` | Foundation proof tab.                                                                        |

Tests go in `test/gyroflight/`. See `docs/gyrocore/ARCHITECTURE.md` and `docs/gyrocore/UPSTREAM.md`.
