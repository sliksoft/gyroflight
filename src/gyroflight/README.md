# src/gyroflight — Gyroflight application integration

Gyroflight is the Betaflight-based application and PWA. This directory holds the
product-level glue that plugs Gyroflight into the Betaflight App: tab
registration, strings, the product tab and fork policy flags. The GyroCore
engine itself (analysis, safety, compare) lives in `src/gyrocore/`.

Betaflight's own implementations (Firmware Flasher, Blackbox Viewer, Autotune,
serial/USB transports, PWA, MSP) stay where upstream keeps them.

| Path                      | Purpose                                                                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tabs.ts`                 | Tab metadata (key, sidebar item, allowed-tab list). No Vue imports, safe for `gui.js`.                                                                                                         |
| `components.ts`           | Tab component map spread into `src/js/vue_tab_registry.js`; registers Gyroflight strings.                                                                                                      |
| `i18n.ts`                 | Merges `locales/en.json` into the English fallback bundle without overwriting upstream keys; `locales/en.overrides.json` deliberately replaces a few upstream English labels (product naming). |
| `navigation.ts`           | Sidebar policy: sets upstream's `hideInSidebar` on Pre-Flight and Flight Plan (hook in `sidebar_items.js`).                                                                                    |
| `branding/`               | `GyroflightLogo.vue` (text wordmark; swap in an SVG later) and `gyroflight-theme.css` (cyan primary for the default theme).                                                                    |
| `tabs/GyroflightHome.vue` | Product Home, registered as `landing` in place of Betaflight's Welcome tab.                                                                                                                    |
| `locales/en.json`         | Gyroflight English strings (kept out of upstream `locales/en/messages.json`).                                                                                                                  |
| `capabilities.ts`         | Truthful capability statuses (available / implemented / incomplete / locked / not started) shown on the Gyroflight tab.                                                                        |
| `tabs/GyroflightTab.vue`  | Compact status overview: what Gyroflight provides today, and attribution.                                                                                                                      |

Tests go in `test/gyroflight/`. See `docs/gyrocore/ARCHITECTURE.md` and `docs/gyrocore/UPSTREAM.md`.
