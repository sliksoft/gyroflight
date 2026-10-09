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

| Item                     | Value                                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Upstream repository      | https://github.com/betaflight/betaflight-configurator                                                                |
| Upstream default branch  | `master`                                                                                                             |
| Fork base commit         | `d85e797e8674e3059cc3172e38df831e46a5250c` (upstream `master`, 2026-10-09)                                           |
| Upstream version at base | `2026.12.0-alpha` (package.json)                                                                                     |
| Fork repository          | https://github.com/sliksoft/gyroflight (GitHub fork of the upstream repo; renamed from `gyrocore-app` on 2026-10-09) |
| Fork default branch      | `master`: an exact mirror of upstream, never committed to directly                                                   |
| Work branches            | `gyroflight/*` and `gyrocore/*`; first: `gyrocore/pwa-foundation`                                                    |
| Local checkout           | `~/Gyroflight` (convention)                                                                                          |
| Licence                  | GPL-3.0-or-later, inherited from upstream (`LICENSE`, `DEFAULT_LICENSE.md`)                                          |

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

| File                                                                        | Change                                                                                                                                                                           | Why                                                                                                                                                    |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/js/vue_tab_registry.js`                                                | import + `...gyroflightTabComponents`                                                                                                                                            | register Gyroflight tab components                                                                                                                     |
| `src/components/sidebar/sidebar_items.js`                                   | import + `...gyroflightSidebarItems` appended after Blackbox                                                                                                                     | sidebar entries (index 0/1 order is tested)                                                                                                            |
| `src/js/gui.js`                                                             | import + `...gyroflightAllowedTabs` in both default allowed lists                                                                                                                | `switchTab` rejects tabs not in `allowedTabs`                                                                                                          |
| `package.json`                                                              | `productName`, `displayName`, `description`                                                                                                                                      | app identity; feeds the PWA manifest                                                                                                                   |
| `src/index.html`                                                            | `<title>`, meta description                                                                                                                                                      | app identity                                                                                                                                           |
| `src/images/pwa/pwa-192-192.png`, `pwa-512-512.png`, `apple-touch-icon.png` | replaced with the Redline Dynamics mark                                                                                                                                          | installed-PWA icon (filenames kept so `vite.config.js` is untouched)                                                                                   |
| `src/js/Analytics.ts`                                                       | `send()` returns early unless `UPSTREAM_ANALYTICS_ENABLED`                                                                                                                       | no usage data to `analytics.betaflight.com` (see below)                                                                                                |
| `src/components/dialogs/OptionsDialog.vue`                                  | analytics opt-out row behind `UPSTREAM_ANALYTICS_ENABLED`                                                                                                                        | the toggle would control nothing                                                                                                                       |
| `src/components/tabs/LandingTab.vue`                                        | statistics disclaimer column behind `UPSTREAM_ANALYTICS_ENABLED`                                                                                                                 | it claims Betaflight collects data and links Betaflight's privacy policy                                                                               |
| `src/components/sidebar/Sidebar.vue`, `src/App.vue`                         | `<UserSession>` behind `BETAFLIGHT_ACCOUNTS_ENABLED`                                                                                                                             | Betaflight login/passkeys cannot work from our origin (see below)                                                                                      |
| `src/js/main.js`                                                            | `/delete` account deep link behind `BETAFLIGHT_ACCOUNTS_ENABLED`                                                                                                                 | it opens the (now unreachable) account profile                                                                                                         |
| `.prettierignore`                                                           | ignore `test/gyrocore/fixtures/`                                                                                                                                                 | copied GyroCore fixtures are pinned by sha256 and must not be reformatted                                                                              |
| `src/composables/useAutotune.ts`                                            | CHIRP input via GyroCore qualification; `applyGains(sliders, compositeId)` gate; GyroCore Safety step; product Apply lock                                                        | Viewer decode (WU2); Apply writes only an authorized GyroCore composite, live FC recheck (WU3); Safety must pass (WU4A); no write until Safety (WU3.1) |
| `src/components/tabs/autotune/GainRecommendation.vue`                       | hide axes without gains; "apply from axis" selector removed; Apply sends the composite; gate notice (with the Safety result); Apply also disabled by Safety and the product lock | per-axis gains are evidence; sliders are global (WU2, WU3); Safety (WU4A); product lock (WU3.1)                                                        |
| `src/components/tabs/AutotuneTab.vue`                                       | imports + `<ChirpQualificationPanel />`, `<DiagnosticOnlyBanner />`, `<GlobalTunePanel />`                                                                                       | measurement states, diagnostic label, global tune (WU2, WU3)                                                                                           |
| `test/components/autotuneApplyGate.test.ts`                                 | seed a GyroCore-qualified report (roll, pitch, yaw); expect the composite id; explicit test-only `vi.mock`s releasing GyroCore Safety and the product Apply lock                 | Apply requires an authorized, axis-covered composite; the button's wiring is still tested behind the lock; same assertions otherwise (WU2, WU3, WU3.1) |

Everything else (header logo, `favicon.ico`, Tauri/Capacitor identity, welcome text) is still upstream's.
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
profile, cloud backups and account deletion (`LoginApi.js`, `UserApi.js`, `LoginManager.js`,
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

Merge, don't rebase: our branches are shared and long-lived, and rebasing ~100 upstream commits a
month re-resolves the same conflicts repeatedly.

```bash
git config rerere.enabled true            # once per clone
nvm use                                   # Node from .nvmrc
git fetch upstream --tags

# 1. keep master an exact mirror
git switch master
git merge --ff-only upstream/master
git push origin master

# 2. merge into the work branch (or a release tag, e.g. 2026.12.0, for release builds)
git switch gyroflight/<branch>
git merge upstream/master                 # or: git merge <tag>

# 3. resolve, then verify
npm ci
npm run typecheck && npx eslint src scripts *.mjs && npx vitest run && npm run build
```

Then smoke the PWA (`npm run preview`): Firmware Flasher, Blackbox Viewer, Autotune (Expert mode) and the
Gyroflight tab load with no page errors; the manifest still says Gyroflight.

Expected conflict hotspots: `package.json` / `package-lock.json` (take upstream's lockfile, re-apply our
fields, `npm install`), `src/js/gui.js` allowed-tab lists, `sidebar_items.js`, `vue_tab_registry.js`,
and the Autotune files above (`useAutotune.ts` most of all; see CHIRP_QUALIFICATION.md).
After a merge, check upstream's release notes for MSP, blackbox-parser or autotune changes that GyroCore
code depends on, and update the base commit in the provenance table.

### Cadence

- Upstream ships two releases a year (`YYYY.6`, `YYYY.12`, with RCs) from `YYYY.M-maintenance` branches,
  and `master` moves about 100 commits a month.
- Development branches: merge `upstream/master` at least monthly to keep conflicts small.
- Release builds of Gyroflight: base on the latest upstream release tag or maintenance branch.

## CI on the fork

`.github/workflows/gyroflight-ci.yml` (ours) runs typecheck, eslint, Vitest and the production build on
pushes to `gyroflight/**` and `gyrocore/**` and on pull requests into `master`, `gyroflight/**` or
`gyrocore/**`. It has read-only permissions, uses no secrets and uploads or publishes nothing.

Upstream workflows are kept unmodified so they never conflict. GitHub Actions is **enabled** on this
repository (verified 2026-10-09: the first push of `gyroflight-ci.yml` ran immediately). Upstream
workflows are not registered yet because none of their triggers has fired, but the next push to
`master` (an upstream sync) will fire `deploy.yml` and `translations-upload.yml`. Without Betaflight's
secrets they fail and cannot deploy anything, but they should not run at all. Right after the first
`master` sync (or once they appear in `gh workflow list --all`), disable the upstream automation:

```bash
for w in deploy.yml deploy_cloudflare.yml build-release.yml tauri-nightly.yml tauri-release-assets.yml \
         android-play-release.yml translations-pr.yml translations-upload.yml stale.yaml auto-close.yml \
         hide-artifact-links.yml manual-build.yml; do
  gh workflow disable "$w" --repo sliksoft/gyroflight
done
```

`test.yml` and `build.yml` are harmless (no secrets, no publishing) and may stay enabled. Never add
upstream's secrets (Cloudflare, Crowdin, signing keys) to this repository.

The local pre-commit hook (husky → lint-staged) runs prettier, `eslint --fix` and `vue-tsc` with whatever
Node is on `PATH`; use Node 24.


## Gyroflight product UI layer

Gyroflight deliberately keeps Betaflight behavior and implementation structure wherever possible.

- The product home is supplied from `src/gyroflight/tabs/GyroflightLandingTab.vue` by overriding only the
  `landing` component in the existing Gyroflight component spread. Upstream `LandingTab.vue` remains
  present and unmodified.
- The app shell swaps the visual Betaflight wordmark for the Gyroflight / Redline Dynamics brand; FC
  connection, status, transport and tab behavior are unchanged.
- The default product accent is the GyroCore cyan palette in `src/gyroflight/theme.css`. Warning, error
  and success semantics remain Betaflight-compatible. Amber and contrast themes remain available.
- Pre-Flight and Flight Plan are hidden by product sidebar policy only. Their upstream components stay in
  the tree for easy upstream synchronization.
- Autotune remains an Expert Mode feature. Gyroflight must not bypass or relax that upstream visibility
  rule as part of branding work.
