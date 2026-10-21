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
| Fork default branch      | `gyroflight/main` — Gyroflight development head and GitHub default (set 2026-10-15)                                  |
| Upstream mirror branch   | `master` — exact mirror of upstream Betaflight App; never commit Gyroflight work here                                |
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

| File                                                                        | Change                                                                                                                                                                            | Why                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/js/vue_tab_registry.js`                                                | import + `...gyroflightTabComponents`                                                                                                                                             | register Gyroflight tab components                                                                                                                                                                                                                                                                       |
| `src/components/sidebar/sidebar_items.js`                                   | import + `...gyroflightSidebarItems` appended after Blackbox; the list is wrapped in `applyGyroflightSidebarPolicy([...])`                                                        | sidebar entries (index 0/1 order is tested); the policy (`src/gyroflight/navigation.ts`) only sets upstream's `hideInSidebar` on Pre-Flight, both Flight Plan entries, Documentation & Support (`help`) and the Gyroflight status tab. Tabs, components, `expert`, `mode` and allowed tabs are unchanged |
| `src/stores/navigation.ts`                                                  | import + `...gyroflightAllowedTabs` in `DEFAULT_ALLOWED_TABS_WHEN_DISCONNECTED` and `DEFAULT_ALLOWED_TABS`                                                                        | `switchTab` rejects tabs not in `allowedTabs`                                                                                                                                                                                                                                                            |
| `package.json`                                                              | `productName`, `displayName`, `description`                                                                                                                                       | app identity; feeds the PWA manifest                                                                                                                                                                                                                                                                     |
| `src/index.html`                                                            | `<title>`, meta description                                                                                                                                                       | app identity                                                                                                                                                                                                                                                                                             |
| `src/images/pwa/pwa-192-192.png`, `pwa-512-512.png`, `apple-touch-icon.png` | replaced with the Redline Dynamics mark                                                                                                                                           | installed-PWA icon (filenames kept so `vite.config.js` is untouched)                                                                                                                                                                                                                                     |
| `src/js/Analytics.ts`                                                       | `send()` returns early unless `UPSTREAM_ANALYTICS_ENABLED`                                                                                                                        | no usage data to `analytics.betaflight.com` (see below)                                                                                                                                                                                                                                                  |
| `src/components/dialogs/OptionsDialog.vue`                                  | analytics opt-out row behind `UPSTREAM_ANALYTICS_ENABLED`                                                                                                                         | the toggle would control nothing                                                                                                                                                                                                                                                                         |
| `src/components/tabs/LandingTab.vue`                                        | statistics disclaimer column behind `UPSTREAM_ANALYTICS_ENABLED`                                                                                                                  | it claims Betaflight collects data and links Betaflight's privacy policy                                                                                                                                                                                                                                 |
| `src/components/sidebar/Sidebar.vue`, `src/App.vue`                         | `<UserSession>` behind `BETAFLIGHT_ACCOUNTS_ENABLED`                                                                                                                              | Betaflight login/passkeys cannot work from our origin (see below)                                                                                                                                                                                                                                        |
| `src/App.vue`                                                               | `<GyroflightLogo>` (same props; the Gyroflight PNG logo) in place of `<betaflight-logo>` in the sidebar, and in the mobile top bar in place of the Betaflight logo image          | product identity in the app shell. `BetaflightLogo.vue` and the `bf_logo_*` assets are kept, untouched                                                                                                                                                                                                   |
| `src/js/main.ts`                                                            | `/delete` account deep link behind `BETAFLIGHT_ACCOUNTS_ENABLED`                                                                                                                  | it opens the (now unreachable) account profile                                                                                                                                                                                                                                                           |
| `.prettierignore`                                                           | ignore `test/gyrocore/fixtures/`                                                                                                                                                  | copied GyroCore fixtures are pinned by sha256 and must not be reformatted                                                                                                                                                                                                                                |
| `src/composables/useAutotune.ts`                                            | CHIRP input via GyroCore qualification; `applyGains(sliders, compositeId)` gate; GyroCore Safety step; product Apply lock; `attachChirpFlightIdentity(report, data)` after import | Viewer decode (WU2); Apply writes only an authorized GyroCore composite, live FC recheck (WU3); Safety must pass (WU4A); no write until Safety (WU3.1)                                                                                                                                                   |
| `src/components/tabs/autotune/GainRecommendation.vue`                       | hide axes without gains; "apply from axis" selector removed; Apply sends the composite; gate notice (with the Safety result); Apply also disabled by Safety and the product lock  | per-axis gains are evidence; sliders are global (WU2, WU3); Safety (WU4A); product lock (WU3.1)                                                                                                                                                                                                          |
| `src/components/tabs/AutotuneTab.vue`                                       | imports + `<ChirpQualificationPanel />`, `<FlightAbSelector />`, `<DiagnosticOnlyBanner />`, `<GlobalTunePanel />`                                                                | measurement states, Flight A/B selection from a saved Tune Session (new WU4; the WU5 Cross-flight Comparison renders inside it, no further upstream change), diagnostic label, global tune (WU2, WU3)                                                                                                    |
| `test/components/autotuneApplyGate.test.ts`                                 | seed a GyroCore-qualified report (roll, pitch, yaw); expect the composite id; explicit test-only `vi.mock`s releasing GyroCore Safety and the product Apply lock                  | Apply requires an authorized, axis-covered composite; the button's wiring is still tested behind the lock; same assertions otherwise (WU2, WU3, WU3.1)                                                                                                                                                   |

Gyroflight UI layer that needs **no** upstream edit:

- **Home:** `src/gyroflight/tabs/GyroflightHome.vue` replaces the Welcome tab through `landing` in
  `gyroflightTabComponents`. `vue_tab_registry.js` spreads that map after its own entries, so the Gyroflight
  key wins. `LandingTab.vue`, its sponsor, community and donation content, and its language links are left
  unchanged and are simply not mounted.
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

Everything else (`favicon.ico`, Tauri/Capacitor identity, `LandingTab.vue`) is still upstream's.
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
fields, `npm install`), `src/stores/navigation.ts` allowed-tab lists, `sidebar_items.js`, `vue_tab_registry.js`,
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
deployments, nightly/release builds, Crowdin sync, stale-issue closing or auto-close of PRs:

`deploy.yml`, `deploy_cloudflare.yml`, `build-release.yml`, `tauri-nightly.yml`,
`tauri-release-assets.yml`, `android-play-release.yml`, `translations-pr.yml`,
`translations-upload.yml`, `stale.yaml`, `auto-close.yml`, `hide-artifact-links.yml`,
`manual-build.yml`.

Verify with `gh workflow list --all --repo sliksoft/gyroflight`. If an upstream sync re-enables one,
disable it again:

```bash
for w in deploy.yml deploy_cloudflare.yml build-release.yml tauri-nightly.yml tauri-release-assets.yml \
         android-play-release.yml translations-pr.yml translations-upload.yml stale.yaml auto-close.yml \
         hide-artifact-links.yml manual-build.yml; do
  gh workflow disable "$w" --repo sliksoft/gyroflight
done
```

The local pre-commit hook (husky → lint-staged) runs prettier, `eslint --fix` and `vue-tsc` with whatever
Node is on `PATH`; use Node 24.
