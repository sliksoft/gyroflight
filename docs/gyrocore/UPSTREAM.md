# Gyroflight — upstream tracking and provenance

## Names

| Name                 | What it is                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **Gyroflight**       | The application / PWA: this repository, a fork of the Betaflight App. Target URL https://app.gyrocore.dev/                   |
| **GyroCore**         | The Redline Dynamics analysis / safety / tuning engine, being migrated into Gyroflight from the separate GyroCore repository |
| **Betaflight App**   | The upstream application and platform Gyroflight is built on                                                                 |
| **Redline Dynamics** | Parent brand ("Gyroflight by Redline Dynamics")                                                                              |

We add Gyroflight/GyroCore code beside Betaflight's code and keep consuming upstream updates. We do **not** contribute
this fork back upstream (no upstream PRs, no pushes to upstream).

## Provenance

| Item                     | Value                                                                                                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Upstream repository      | https://github.com/betaflight/betaflight-configurator                                                                       |
| Upstream default branch  | `master`                                                                                                                    |
| Fork base commit         | `d85e797e8674e3059cc3172e38df831e46a5250c` (upstream `master`, 2026-10-09)                                                  |
| Upstream version at base | `2026.12.0-alpha` (package.json)                                                                                            |
| Last upstream sync       | `81e43bb57705f510da8a027126dbbf528a68e824` (upstream `master`), merged in five stages S1–S5 (`gyroflight/upstream-sync-s5`) |
| Fork repository          | https://github.com/sliksoft/gyroflight (GitHub fork of the upstream repo; renamed from `gyrocore-app` on 2026-10-09)        |
| Fork default branch      | `gyroflight/main` — Gyroflight development head and GitHub default (set 2026-10-15)                                         |
| Upstream mirror branch   | `master` — exact mirror of upstream Betaflight App; never commit Gyroflight work here                                       |
| Work branches            | `gyroflight/*` and `gyrocore/*`; first: `gyrocore/pwa-foundation`                                                           |
| Local checkout           | `~/Gyroflight` (convention)                                                                                                 |
| Licence                  | GPL-3.0-or-later, inherited from upstream (`LICENSE`, `DEFAULT_LICENSE.md`)                                                 |

Toolchain at the base commit (from upstream `package.json` `engines` and `.nvmrc`):
Node `24.21.0` (`^24.21.0`), npm `11.19.0` (`>=11.19.0`).

## Remotes

```
origin    git@github.com:sliksoft/gyroflight.git                (fetch/push)
upstream  https://github.com/betaflight/betaflight-configurator.git (fetch only)
```

Push to `upstream` is disabled locally (`git remote set-url --push upstream DISABLED_NO_UPSTREAM_PUSH`).
Set the same on any new clone.

## Licensing rules (GPL-3.0)

- Keep `LICENSE`, `DEFAULT_LICENSE.md`, every existing copyright/"This file is part of Betaflight" header,
  and the CC-BY model notices in `resources/models/*.license.txt`.
- New source files start with the GPL header adapted to "This file is part of Gyroflight, a derivative
  of the Betaflight App" (see any file in `src/gyroflight/`).
- The app must keep visible attribution to the Betaflight App and a link to this fork's source.
  This is currently on the Gyroflight tab; Betaflight's own landing/help attribution text is left as is.
- Distribution of builds (including the PWA at https://app.gyrocore.dev/) requires the corresponding
  source to be available: the public `sliksoft/gyroflight` repository satisfies this.

## Rules for changing the fork

1. **Prefer additions in our namespaces:** `src/gyroflight/` for application glue (tabs, strings,
   product policy) and `src/gyrocore/` for GyroCore engine code (analysis, safety, compare). Tests go in
   `test/gyroflight/` and `test/gyrocore/`, docs in `docs/gyrocore/`.
2. **Minimise edits to upstream files.** When an upstream file must change, make it a small hook
   (an import plus a spread or a flag check) and keep our logic in our namespaces.
3. **Never move or rewrite Betaflight implementations** (Firmware Flasher, Blackbox Viewer, Autotune,
   serial/USB/Bluetooth transports, MSP, PWA). Wrap or consume them; don't fork their code into our namespaces.
4. **Our strings live in `src/gyroflight/locales/en.json`**, not `locales/en/messages.json`
   (the most frequently changed upstream file). Keys are prefixed `gyroflight` (application) or `gyrocore`
   (engine) and must never shadow an upstream key (tested).
5. **Record every upstream-file modification below.** If a file is copied from upstream into
   our namespaces and modified, note the source path and upstream commit in its header.
6. Do not edit `src/dist/`, `node_modules/`, generated files, or non-English locale files.

### Upstream files modified by Gyroflight

| File                                                                                                                                                                                                | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Why                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/js/vue_tab_registry.ts`                                                                                                                                                                        | import + `...gyroflightTabComponents`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | register Gyroflight tab components                                                                                                                                                                                                                                                                       |
| `src/components/sidebar/sidebar_items.ts`                                                                                                                                                           | import + `...gyroflightSidebarItems` appended after Blackbox Viewer and Autotune; the list is wrapped in `applyGyroflightSidebarPolicy([...])`                                                                                                                                                                                                                                                                                                                                                                                | sidebar entries (index 0/1 order is tested); the policy (`src/gyroflight/navigation.ts`) only sets upstream's `hideInSidebar` on Pre-Flight, both Flight Plan entries, Documentation & Support (`help`) and the Gyroflight status tab. Tabs, components, `expert`, `mode` and allowed tabs are unchanged |
| `src/stores/navigation.ts`                                                                                                                                                                          | import + `...gyroflightAllowedTabs` in `DEFAULT_ALLOWED_TABS_WHEN_DISCONNECTED` and `DEFAULT_ALLOWED_TABS`                                                                                                                                                                                                                                                                                                                                                                                                                    | `switchTab` rejects tabs not in `allowedTabs`                                                                                                                                                                                                                                                            |
| `package.json`                                                                                                                                                                                      | `productName`, `displayName`, `description`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | app identity; feeds the PWA manifest                                                                                                                                                                                                                                                                     |
| `src/index.html`                                                                                                                                                                                    | `<title>`, meta description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | app identity                                                                                                                                                                                                                                                                                             |
| `src/images/pwa/pwa-192-192.png`, `pwa-512-512.png`, `apple-touch-icon.png`                                                                                                                         | replaced with the Redline Dynamics mark                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | installed-PWA icon (filenames kept so `vite.config.js` is untouched)                                                                                                                                                                                                                                     |
| `src/js/Analytics.ts`                                                                                                                                                                               | `send()` returns early unless `UPSTREAM_ANALYTICS_ENABLED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | no usage data to `analytics.betaflight.com` (see below)                                                                                                                                                                                                                                                  |
| `src/components/dialogs/OptionsDialog.vue`                                                                                                                                                          | analytics opt-out row behind `UPSTREAM_ANALYTICS_ENABLED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | the toggle would control nothing                                                                                                                                                                                                                                                                         |
| `src/components/tabs/LandingTab.vue`                                                                                                                                                                | statistics disclaimer column behind `UPSTREAM_ANALYTICS_ENABLED`                                                                                                                                                                                                                                                                                                                                                                                                                                                              | it claims Betaflight collects data and links Betaflight's privacy policy                                                                                                                                                                                                                                 |
| `src/components/sidebar/Sidebar.vue`, `src/App.vue`                                                                                                                                                 | `<UserSession>` behind `BETAFLIGHT_ACCOUNTS_ENABLED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Betaflight login/passkeys cannot work from our origin (see below)                                                                                                                                                                                                                                        |
| `src/App.vue`                                                                                                                                                                                       | `<GyroflightLogo>` (same props; the Gyroflight PNG logo) in place of `<betaflight-logo>` in the sidebar, and in the mobile top bar in place of the Betaflight logo image                                                                                                                                                                                                                                                                                                                                                      | product identity in the app shell. `BetaflightLogo.vue` and the `bf_logo_*` assets are kept, untouched                                                                                                                                                                                                   |
| `src/js/main.ts`                                                                                                                                                                                    | `/delete` account deep link behind `BETAFLIGHT_ACCOUNTS_ENABLED`                                                                                                                                                                                                                                                                                                                                                                                                                                                              | it opens the (now unreachable) account profile                                                                                                                                                                                                                                                           |
| `.prettierignore`                                                                                                                                                                                   | ignore `test/gyrocore/fixtures/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | copied GyroCore fixtures are pinned by sha256 and must not be reformatted                                                                                                                                                                                                                                |
| `src/composables/useAutotune.ts`                                                                                                                                                                    | CHIRP input via GyroCore qualification; `attachChirpFlightIdentity(report, data)` after import; `applyGains(sliders, compositeId, confirmation)` delegates to `src/composables/useTuneApply.ts` (composite gate, Safety, release procedure, confirmation, FC identity, backup, firmware-calculated verify, EEPROM only when verified; Restore)                                                                                                                                                                                | Viewer decode (WU2); Apply writes only an authorized GyroCore composite (WU3), Safety must pass (WU4A), nothing is saved unless the read-back matches                                                                                                                                                    |
| `src/components/tabs/autotune/GainRecommendation.vue`                                                                                                                                               | hide axes without gains; "apply from axis" selector removed; Apply sends the composite with a single-use confirmation token; gate notice (with the Safety result); Apply also disabled by Safety and the release procedure                                                                                                                                                                                                                                                                                                    | per-axis gains are evidence; sliders are global (WU2, WU3); Safety (WU4A); release procedure                                                                                                                                                                                                             |
| `src/components/tabs/AutotuneTab.vue`                                                                                                                                                               | imports + `<ChirpQualificationPanel />`, `<FlightAbSelector />`, `<DiagnosticOnlyBanner />`, `<GlobalTunePanel />`, `<TuneWorkflowPanel />`                                                                                                                                                                                                                                                                                                                                                                                   | measurement states, Flight A/B selection from a saved Tune Session (new WU4; the WU5 Cross-flight Comparison renders inside it, no further upstream change), diagnostic label, global tune (WU2, WU3)                                                                                                    |
| `src/components/init.ts`                                                                                                                                                                            | `import "../gyroflight/icons";` before `createApp`                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | registers the bundled Lucide icon set (`@iconify-json/lucide`, already a dependency) so the PWA draws every icon offline and no request goes to `api.iconify.design` (`src/gyroflight/icons.ts`, `test/gyroflight/bundled_icons.test.ts`)                                                                |
| `vite.config.js`                                                                                                                                                                                    | `build.rollupOptions.output.manualChunks`: `@iconify-json/lucide` → `icons-lucide` chunk                                                                                                                                                                                                                                                                                                                                                                                                                                      | keeps `main` below workbox's 5 MB `maximumFileSizeToCacheInBytes`, above which it would silently drop out of the precache and break offline start                                                                                                                                                        |
| `src/components/tabs/autotune/AutotuneImport.vue`                                                                                                                                                   | sample-rate label passes `{ rate }` to `autotuneSampleRate`                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | the message contains `{{rate}}`; upstream passed none and showed the placeholder (`test/gyroflight/web_only_fixes.test.ts`)                                                                                                                                                                              |
| `vite.config.js` (`globPatterns`)                                                                                                                                                                   | adds `woff2,woff`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | the Open Sans webfonts are precached, so the installed PWA keeps its typeface offline                                                                                                                                                                                                                    |
| `src/composables/useReboot.ts` (`saveToEeprom`, `saveAndReboot`), `src/composables/pidTuning/usePidTuningMsp.ts` (`writePidTuningConfig`), `src/stores/osd.ts` (EEPROM save)                        | one call `assertNoUncertainWriteOnConnectedCraft()` (`src/gyrocore/stores/fcTransactionState.ts`) before the first write                                                                                                                                                                                                                                                                                                                                                                                                      | after a Gyroflight write that ended unverified, a tab's Save would write or persist those unverified values (audit 2026-10-24 WP8); refused until a verified Restore or the read-only check. The transport check below covers every other route (CLI `save`, presets, other tabs)                        |
| `src/composables/motors/useMotorsSave.ts` (`saveMotors`), `src/js/msp/MSPHelper.ts` (`writeConfiguration`, optional `onRefused`), `test/js/composables/motors/useMotorsSave.test.ts` (active Pinia) | the same call before the Motors tab's first SET (it writes the shared filter block), and again inside `writeConfiguration`'s 100 ms delay right before `MSP_EEPROM_WRITE`; `saveAndReboot` passes its `reject` as `onRefused`                                                                                                                                                                                                                                                                                                 | the Motors save sent the filter block before any EEPROM guard, and an unverified end during the delay was not seen (audit 2026-10-24 WP8 round 2)                                                                                                                                                        |
| `src/js/msp.ts` (`_transmit`, `_release_parked`, `_on_timeout`, `promise` option `permit`, `send_cli_command` (option `onSent`), `_process_cli_queue`, `MspRequest.recheck`)                        | `mspRequestRefusal()` / `cliCommandRefusal()` (`src/composables/fcWriteGuard.ts`) before a request is queued, again when a parked one is released and before every retry (a refused retry rejects with `WriteRetryRefusedError`: the first attempt may have run), and for a CLI command again when it leaves the queue; a refused awaiter rejects with `WriteRefusedError`, a refused callback request gets no callback (`gui_log` says why); Gyroflight's own SETs and `MSP_EEPROM_WRITE` carry their transaction's `permit` | one write check for every route of every tab: while the connected craft's state is uncertain (or a Gyroflight write of this page is open) no MSP write and no CLI write leaves the app; reads and the runtime commands (RTC, arming-disabled, motor test, reboot) do (audit 2026-10-24 WP8 P0 closure)   |
| `src/composables/useCli.ts` (`send`, `commandAfterBuffer`, `cleanup`), `src/js/utils/AutoBackup.ts` (`sendCommand`)                                                                                 | `interactiveCliText()` before the raw serial write: while writes are refused only reads go out, behind 256 DEL bytes that empty the firmware's line, and the whole command is sent rather than the rest after the echoed buffer; the CLI tab prints a refusal as an `###ERROR` line; a refused `exit` starts no reboot                                                                                                                                                                                                        | these two write CLI text to the serial line without msp.ts; the echo of the firmware's line can lag (a completion sent earlier), so it is emptied rather than trusted                                                                                                                                    |
| `src/js/utils/AutoRestore.ts` (`_finishWithSave`)                                                                                                                                                   | a `save` the write check refuses, or that is dropped before it leaves the CLI queue, ends the restore as failed at once; "saving" (a disconnect then counts as the save's reboot) starts only when `save` leaves the queue for the port (`onSent`)                                                                                                                                                                                                                                                                            | the flasher's config restore otherwise reported success for a save that never ran                                                                                                                                                                                                                        |
| `src/js/msp/MSPHelper.ts` (`sendRxFailConfig`, optional `onRefused`), `src/composables/failsafe/useFailsafeSave.ts` (`saveConfig`)                                                                  | a RXFAIL write the write check refuses (no callback) calls `onRefused`; the Failsafe save rejects and stops saving                                                                                                                                                                                                                                                                                                                                                                                                            | a refused callback write never answers: the save waited on it for good ("Saving…")                                                                                                                                                                                                                       |
| `src/composables/useMspCliSession.ts` (`saveAndReconnect`)                                                                                                                                          | a `save` refused by the write check returns `{ ok: false }` without scheduling the reboot reconnect                                                                                                                                                                                                                                                                                                                                                                                                                           | the FC did not reboot (Presets, Backups)                                                                                                                                                                                                                                                                 |
| `src/js/protocols/WebSerial.ts` (`send`, `batchWrite`) | every send waits for the previous one (a private queue); `batchWrite` returns the bytes written and stops at a failed chunk or a closed port; `send` reports those bytes, 0 when nothing went out | in the AT32/macOS batch mode (63-byte chunks) a second send landed between the chunks of the first, and a failure mid-frame reported 0 bytes although part of the frame was out (audit 2026-10-25 WP8-F03) |
| `src/js/msp.ts` (`read`, `send_cli_command` option `onDelivery`, `_process_cli_queue`, `_finish_cli`, `_cli_drain_expired`, `_drain_cli_queue`, `cliInFlightOutput`, the decoder's ETX step, `CliSessionUncertainError`, `CliDeliveryError`) | the timeout drain decodes MSP frames as usual and ends only on the late reply's ETX in CLI framing; no CLI command leaves while it drains; when the grace period ends without that ETX, or a command reached the transport only in part (bytesSent short of the frame), the CLI session is uncertain and every CLI command is refused until `disconnect_cleanup`; a command is "delivered" only when the transport took its whole frame (`onDelivery`); on disconnect only the command in flight gets the closing error (with `delivered`), queued ones get a "not sent" error (`notSent`) | the drain threw MSP replies away, a new command could start while it ran, and after the grace period a late reply could be taken for the next command's (MSP CLI replies carry no request id); a queued command was reported as closed by the save's reboot although it never left the app (audit 2026-10-25 WP8-F09) |
| `src/js/utils/AutoRestore.ts` (`_finishWithSave`, `_endSave`, `handleDisconnect`, result `persistence`), `src/composables/useMspCliSession.ts` (`cliSaveConfirmed`, `saveAndReconnect` result `persistence`), `src/components/tabs/FirmwareFlasherTab.vue` (restore callback) | a CLI `save` counts as saved only when the firmware's own output shows it wrote EEPROM (`# saving` or `Rebooting`, which cli.c prints only after `writeEEPROM()` returned); a `save` that went out whole without that is `not_verified` (its own message; the flasher keeps the restore available), one refused, never sent or answered without saving is `not_saved`, one the transport did not take whole or never reported on is `unknown`; a disconnect alone is no evidence | AutoRestore reported success when `save` had only left the queue (0 bytes, a failed or stalled send, or a disconnect counted as the save's reboot) and after a 500 ms delay; Presets/Backups took every closed port for an accepted save (audit 2026-10-25 WP8-F01) |
| `src/composables/useCli.ts` (`send` callback `delivered`, `cleanup`, `exitPending`), `src/js/serial_backend.ts` (`disconnectCliModeUnknown`) | the reboot handoff after the CLI tab's `exit` waits for the transport: only an `exit` it took whole (every byte, the 256-DEL prefix included) clears the CLI flags and calls `reinitializeConnection()`; otherwise the flags stay (the FC may still be in its CLI), the user is told, and the link is dropped by `disconnectCliModeUnknown()` (the Disconnect button's path without its MSP_SET_ARMING_DISABLED); a second cleanup while the result is pending sends no second `exit` | a 0-byte, partial or failed send of `exit` still reported a reboot, cleared the CLI flags and started a reconnect, after which MSP frames would reach an FC possibly still in its CLI (audit 2026-10-25 WP8-F10) |
| `src/js/msp/MSPHelper.ts` (`writeConfiguration`), `src/composables/useReboot.ts` (`saveToEeprom`, `saveAndReboot`, `notConfirmed`), `src/stores/osd.ts` (EEPROM save); new `src/js/msp/eepromSave.ts` (`saveEeprom`, `eepromReplyState`, `EepromSaveError`, also used by `useTuneApply`) | every EEPROM save of the tabs goes through `saveEeprom()`: "saved" only on the firmware's ACK of MSP_EEPROM_WRITE; a link lost before it went out or the firmware's error reply rejects with `EepromSaveError` `not_saved`, a lost or corrupt answer, a cleared queue or a refused retry with `unknown`; the tab's save failure then says the FC's RAM may differ from EEPROM (not swallowed as an `MspCancelledError`); `configurationEepromSaved` and the reboot handoff only after the ACK | `writeConfiguration` used a legacy callback that `send_message` also runs, without sending, when the link is down: "EEPROM saved" and a reboot for a save that never went out; `saveToEeprom` logged "saved" on the firmware's refusal (audit 2026-10-25 WP8-F04) |
| `test/components/autotuneApplyGate.test.ts`                                                                                                                                                         | seed a GyroCore-qualified report (roll, pitch, yaw); expect the composite id; explicit test-only `vi.mock`s releasing GyroCore Safety and the product Apply lock                                                                                                                                                                                                                                                                                                                                                              | Apply requires an authorized, axis-covered composite; the button's wiring is still tested behind the lock; same assertions otherwise (WU2, WU3, WU3.1)                                                                                                                                                   |

Gyroflight UI layer that needs **no** upstream edit:

- **Home:** `src/gyroflight/tabs/GyroflightHome.vue` replaces the Welcome tab through `landing` in
  `gyroflightTabComponents`. `vue_tab_registry.ts` spreads that map after its own entries, so the Gyroflight
  key wins. The map types `landing` as optional so TypeScript accepts that override (TS2783). `LandingTab.vue`, its sponsor, community and donation content, and its language links are left
  unchanged and are simply not mounted.
- **Settings search** (upstream, Ctrl/Cmd + K): lists only settings whose tab `useVisibleTabs()` returns,
  and `Sidebar.vue` opens a result only when its tab is in that same list. It therefore follows the
  sidebar policy (`hideInSidebar`), Expert Mode and the allowed-tab lists with no Gyroflight edit; the index
  covers `src/components/tabs/` only, so Gyroflight tabs are never indexed. Tested in
  `test/gyroflight/settings_search_policy.test.ts`.
- **Theme:** `src/gyroflight/branding/gyroflight-theme.css` is imported by `src/gyroflight/components.ts`
  and loaded after `src/css/theme.css`.
    - It remaps only the primary tokens of the default colour theme (stored key `yellow`) to the GyroCore
      cyan family (`#22d3ee`).
    - Amber and High contrast are unchanged.
    - Success, warning and error tokens are never touched.
- **Home label:** `src/gyroflight/locales/all.overrides.json` renames the first sidebar entry (`tabLanding`) to
  "Home" in every language. It is re-applied whenever a language bundle loads; upstream locale files are unchanged.
- **Colour-theme label:** `src/gyroflight/locales/en.overrides.json` relabels the default colour theme as
  "Gyroflight (default)", English only. It is registered with overwrite on, kept apart from `en.json`,
  which must never shadow upstream keys.

Everything else (`favicon.ico`, Capacitor identity, `LandingTab.vue`) is still upstream's.

### Web-only product (divergence from upstream)

Gyroflight ships only as the web app / PWA; there is no Windows or Linux desktop build. Removed:

- `src-tauri/` (the Tauri desktop shell and its bundle configuration);
- `scripts/check-tauri-prereqs.mjs`, `scripts/sync-tauri-version.mjs`, `scripts/rename-tauri-bundles.mjs`;
- the npm scripts `tauri`, `tauri:dev`, `tauri:build`, `tauri:prebuild` and the `@tauri-apps/cli` devDependency;
- `.github/workflows/tauri-nightly.yml`, `.github/workflows/tauri-release-assets.yml`, and the
  `modern_release` job in `build-release.yml` that called the latter;
- the desktop sections of `.devcontainer/README.md` and the `src-tauri/gen/` line in `.prettierignore`.

Kept on purpose: the runtime adapters (`src/js/protocols/Tauri*.ts`, `@tauri-apps/api` and its plugins) and
the `isTauri()` branches, because removing them means editing upstream transport code; in the browser they
are never selected. Capacitor (Android) is unchanged. On an upstream sync, changes to the removed paths
arrive as modify/delete conflicts: resolve them by keeping the deletion.
All policy flags live in `src/gyroflight/policy.ts`; `git grep gyroflight/policy` lists every gated site.

## Privacy and accounts (divergence from upstream)

**Analytics: disabled.** Upstream's `src/js/Analytics.ts` posts settings, app start, tab views, flashing,
save/change events and exceptions to `https://analytics.betaflight.com`, with a random user id, OS and
app name, unless the user opts out. Gyroflight makes `Analytics.send()`, the only network call in that
module, a no-op (`UPSTREAM_ANALYTICS_ENABLED = false`), whatever the opt-out setting says. The tracker
object is still constructed so upstream callers keep working, and it still stores a random `userId` in
local config; that value never leaves the browser. No replacement or Redline telemetry exists. The
opt-out toggle and the landing-page statistics disclaimer are hidden. Tested in
`test/gyroflight/privacy.test.ts`; the browser smoke confirms zero requests to `analytics.betaflight.com`.

**Betaflight accounts: hidden.** Login, passkeys (WebAuthn via `login.betaflight.com`), the user
profile, cloud backups and account deletion (`LoginApi.ts`, `UserApi.ts`, `LoginManager.ts`,
`UserSession.vue`, `UserProfileTab.vue`, `BackupsTab.vue`) are bound to Betaflight's origin and relying
party and cannot work from https://app.gyrocore.dev/. Gyroflight is local-first and needs no accounts, so
`BETAFLIGHT_ACCOUNTS_ENABLED = false` hides the Login button and account menu (sidebar and mobile) and
ignores the `/delete` deep link. The implementation is untouched. With no stored token, `LoginManager`
makes no network calls, and `BuildApi` simply sends no `Authorization` header, so anonymous cloud builds
and flashing are unaffected.

**Still contacted (content, not analytics):** `build.betaflight.com` (flasher targets and builds, device
filters, sponsor tiles and images) and `api.iconify.design` (icons not bundled locally). These requests
carry no user or usage data beyond what any HTTP request carries (IP address, user agent).

## Updating from upstream

Upstream sync is **controlled**: update the `master` mirror first, then merge into a Gyroflight work
branch (or into `gyroflight/main` via PR). Merge, don't rebase: our branches are shared and long-lived,
and rebasing ~100 upstream commits a month re-resolves the same conflicts repeatedly.

```bash
git config rerere.enabled true            # once per clone
nvm use                                   # Node from .nvmrc
git fetch upstream --tags

# 1. keep master an exact upstream mirror (no Gyroflight commits on master)
git switch master
git merge --ff-only upstream/master
git push origin master

# 2. merge into a Gyroflight work branch (or a release tag, e.g. 2026.12.0)
git switch gyroflight/<branch>
git merge upstream/master                 # or: git merge <tag>

# 3. resolve, then verify
npm ci
npm run typecheck && npx eslint src scripts *.mjs && npx vitest run && npm run build
```

Open a PR into `gyroflight/main` (the GitHub default). Do not push Gyroflight product work to `master`.

Then smoke the PWA (`npm run preview`): Firmware Flasher, Blackbox Viewer, Autotune (Expert mode) and the
Gyroflight tab load with no page errors; the manifest still says Gyroflight.

Expected conflict hotspots: `package.json` / `package-lock.json` (take upstream's lockfile, re-apply our
fields, `npm install`), `src/stores/navigation.ts` allowed-tab lists, `sidebar_items.ts`, `vue_tab_registry.ts`,
and the Autotune files above (`useAutotune.ts` most of all; see CHIRP_QUALIFICATION.md).
After a merge, check upstream's release notes for MSP, blackbox-parser or autotune changes that GyroCore
code depends on, and update the base commit in the provenance table.

### Cadence

- Upstream ships two releases a year (`YYYY.6`, `YYYY.12`, with RCs) from `YYYY.M-maintenance` branches,
  and `master` moves about 100 commits a month.
- Development branches: merge `upstream/master` at least monthly to keep conflicts small.
- Release builds of Gyroflight: base on the latest upstream release tag or maintenance branch.

## CI on the fork

GitHub default branch is `gyroflight/main`. New pull requests target that branch by default.

### Active workflows

| Workflow            | Role                                                                                                                                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gyroflight-ci.yml` | Our CI: typecheck, eslint, Vitest, production build on pushes to `gyroflight/**` / `gyrocore/**` and PRs into `master`, `gyroflight/**` or `gyrocore/**`. Read-only permissions; no secrets; uploads or publishes nothing. |
| `test.yml`          | Upstream Test workflow (lint/lockfile/test). Harmless; no publishing.                                                                                                                                                      |
| `build.yml`         | Reusable Build workflow, called only when another workflow invokes it.                                                                                                                                                     |

Normal Gyroflight CI does **not** need Betaflight Cloudflare, Crowdin, Play Store or code-signing secrets.
This repository has none of those secrets; do not add them.

### Disabled upstream automation

Workflow files from Betaflight remain in `.github/workflows/` (do not delete them — that would fight
upstream merges) but are **disabled manually** in GitHub Actions so the fork does not run Betaflight
deployments, nightly/release builds, Crowdin sync, stale-issue closing or auto-close of PRs. The one
exception is the desktop packaging, removed because Gyroflight is web-only (see "Web-only product" below):
`tauri-nightly.yml` and `tauri-release-assets.yml` are deleted and `build-release.yml` no longer calls the latter.

`deploy.yml`, `deploy_cloudflare.yml`, `build-release.yml`, `android-play-release.yml`, `translations-pr.yml`,
`translations-upload.yml`, `stale.yaml`, `auto-close.yml`, `hide-artifact-links.yml`,
`manual-build.yml`, `msp-codes.yml`.

`msp-codes.yml` (upstream `30c8dd87`) is read-only and publishes nothing. Upstream runs it on pull requests
that touch `src/js/msp/MSPCodes.ts`, weekly on a cron, and on manual dispatch. A workflow file added by a PR
already runs on that PR, before `gh workflow disable` can reach it, so Gyroflight keeps it out of automatic
runs in the file itself: `on:` has only `workflow_dispatch` (a local change, expect a small conflict on the
next upstream change to that block). Locally, `npm run check:msp-codes` performs the same check against the
firmware headers. To re-enable the automatic runs, restore the upstream `pull_request` paths and schedule.

Verify with `gh workflow list --all --repo sliksoft/gyroflight`. If an upstream sync re-enables one,
disable it again:

```bash
for w in deploy.yml deploy_cloudflare.yml build-release.yml \
         android-play-release.yml translations-pr.yml translations-upload.yml stale.yaml auto-close.yml \
         hide-artifact-links.yml manual-build.yml msp-codes.yml; do
  gh workflow disable "$w" --repo sliksoft/gyroflight
done
```

The local pre-commit hook (husky → lint-staged) runs prettier, `eslint --fix` and `vue-tsc` with whatever
Node is on `PATH`; use Node 24.
