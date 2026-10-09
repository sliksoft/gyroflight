# Gyroflight — architecture and extension points

Gyroflight is the application (this repository, a fork of the Betaflight App). GyroCore is the
Redline Dynamics analysis/safety engine being migrated into Gyroflight. Betaflight remains the upstream
application and platform.

Gyroflight = the Betaflight App, unchanged where it already works, plus application glue in
`src/gyroflight/` and the GyroCore engine in `src/gyrocore/`. This document says where those plug in. Rules for touching upstream
files are in [UPSTREAM.md](UPSTREAM.md).

## What Betaflight provides (used as-is)

| Capability                   | Upstream location                                                                                                                                                   | Needs an FC?                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| Firmware Flasher             | `src/components/tabs/FirmwareFlasherTab.vue`, `tabs/firmware-flasher/`, `composables/useFirmwareFlashing.ts`, `js/protocols/{webstm32.ts,usbdfu.js,esp32.js}`       | no (disconnected tab)           |
| Blackbox Viewer              | `src/components/tabs/BlackboxViewerTab.vue` → `src/blackbox-viewer/` (`flightlog.js`, `flightlog_parser.js`, …)                                                     | no (`shared`)                   |
| Autotune (CHIRP / system-ID) | `src/components/tabs/AutotuneTab.vue`, `tabs/autotune/`, `composables/useAutotune.ts`, `stores/autotune`, `js/blackbox/{chirp_bbl_parser,spectral_analysis,fft}.ts` | no (`shared`, Expert mode only) |
| Device communication         | `src/js/protocols/` (WebSerial, WebBluetooth, WebUSB DFU, WebSocket, Virtual, Tauri/Capacitor variants), `js/serial.js`, `js/serial_backend.ts`, `js/msp/`          | —                               |
| Configuration tabs           | `src/components/tabs/*Tab.vue`, `src/stores/`, `src/js/fc.js`, `MSPHelper.js`                                                                                       | yes                             |
| PWA                          | `vite.config.js` `VitePWA({ registerType: "prompt" })`, `src/images/pwa/`                                                                                           | —                               |

## How tabs work (upstream)

There is no router. `Sidebar.vue` → `switchTab(key, { mode })` (`js/tab_switch.js`) → checks
`GUI.allowedTabs` → `mountVueTab()` (`js/vue_tab_mounter.js`) → `App.vue` renders
`VueTabComponents[key]` inside `<keep-alive>`. Sidebar `mode` decides visibility:
`disconnected`, `connected`, `shared` (always), `cli`, `loggedin`.

## Gyroflight extension points

```
src/gyroflight/tabs.ts ──► src/components/sidebar/sidebar_items.js   (...gyroflightSidebarItems)
                      └──► src/js/gui.js                             (...gyroflightAllowedTabs, both lists)
src/gyroflight/components.ts ──► src/js/vue_tab_registry.js         (...gyroflightTabComponents)
src/gyroflight/i18n.ts ──► i18next "en" fallback bundle (from src/gyroflight/locales/en.json)
```

Adding a tab therefore means: add the component (under `src/gyroflight/`, or `src/gyrocore/` for an
engine view), add one entry to `gyroflightSidebarItems` / `gyroflightAllowedTabs` /
`gyroflightTabComponents`, add its strings to `src/gyroflight/locales/en.json`. No further upstream edits.

`tabs.ts` deliberately has no Vue imports: `gui.js` imports it early, and pulling components in there
would create import cycles.

## Where future GyroCore features fit in Gyroflight

Target navigation is Betaflight's sidebar plus Gyroflight/GyroCore entries appended after Blackbox Viewer.
Nothing in upstream's navigation is replaced.

| Future feature                 | Integration                                                                                                                                                                  | Builds on (upstream)                                       |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Gyroflight tab (exists, proof) | `shared` tab `gyroflight`                                                                                                                                                    | —                                                          |
| Analysis                       | `shared` tab; `src/gyrocore/analysis/` + store; consumes logs via the Blackbox Viewer's `FlightLog` rather than a second parser                                              | `src/blackbox-viewer/flightlog*.js`                        |
| Safety                         | `src/gyrocore/safety/`: a validation step that runs on any proposed tune before it can be applied; surfaced in Analysis / Autotune review                                    | Autotune `GainRecommendation`, MSP write path (via stores) |
| Compare                        | `shared` tab; compares two logs / two tunes                                                                                                                                  | `FlightLog`, autotune results                              |
| Autotune evidence / review     | panel or tab that reads `stores/autotune` results and adds measurement qualification, consistency checks and explanations ([TUNING_ARCHITECTURE.md](TUNING_ARCHITECTURE.md)) | `stores/autotune`, `spectral_analysis.ts`                  |
| CLI / tune output              | safe CLI snippet generation after Safety passes; applied through upstream's CLI tab or MSP stores                                                                            | `CliTab.vue`, `src/stores/`                                |

Upstream's AGENTS.md rules apply to GyroCore code too: no MSP calls from components (go through a
store or composable), Pinia for state, `@nuxt/ui` components, no hard-coded colours, Vitest tests.

## Firmware Flasher policy

Gyroflight uses the **normal Betaflight Firmware Flasher and build infrastructure unchanged**
(`build.betaflight.com`, upstream targets and release lists).

- No custom firmware repository, no Redline/VliegAI firmware source, no hidden or alternative target source.
- No Gyroflight changes to `FirmwareFlasherTab.vue`, `tabs/firmware-flasher/`, `BuildApi.js` or the
  flashing protocols. Upstream fixes arrive through normal upstream merges.

## Deployment notes for https://app.gyrocore.dev/

- `vite.config.js` uses `base: "./"`, so the build works at the domain root. The manifest's `start_url`
  and `scope` are `./`. Icons are referenced as `/images/pwa/…`.
- **Betaflight accounts (login, passkeys) are hidden** because they cannot work from our origin, and
  **upstream analytics are disabled**. See UPSTREAM.md, "Privacy and accounts".
- Anonymous cloud build and flash must still be checked against `build.betaflight.com` CORS from the
  deployed origin.
- Upstream deploy workflows target Betaflight's Cloudflare project; a Gyroflight deploy needs its own
  workflow (see UPSTREAM.md → CI).
