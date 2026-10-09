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
   (the most frequently changed upstream file). Keys are prefixed `gyroflight` and must never shadow an
   upstream key (tested).
5. **Record every upstream-file modification below.** If a file is copied from upstream into
   our namespaces and modified, note the source path and upstream commit in its header.
6. Do not edit `src/dist/`, `node_modules/`, generated files, or non-English locale files.

### Upstream files modified by Gyroflight

| File                                                                        | Change                                                            | Why                                                                  |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------- |
| `src/js/vue_tab_registry.js`                                                | import + `...gyroflightTabComponents`                             | register Gyroflight tab components                                   |
| `src/components/sidebar/sidebar_items.js`                                   | import + `...gyroflightSidebarItems` appended after Blackbox      | sidebar entries (index 0/1 order is tested)                          |
| `src/js/gui.js`                                                             | import + `...gyroflightAllowedTabs` in both default allowed lists | `switchTab` rejects tabs not in `allowedTabs`                        |
| `package.json`                                                              | `productName`, `displayName`, `description`                       | app identity; feeds the PWA manifest                                 |
| `src/index.html`                                                            | `<title>`, meta description                                       | app identity                                                         |
| `src/images/pwa/pwa-192-192.png`, `pwa-512-512.png`, `apple-touch-icon.png` | replaced with the Redline Dynamics mark                           | installed-PWA icon (filenames kept so `vite.config.js` is untouched) |

Everything else (header logo, `favicon.ico`, Tauri/Capacitor identity, welcome text) is still upstream's.

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
fields, `npm install`), `src/js/gui.js` allowed-tab lists, `sidebar_items.js`, `vue_tab_registry.js`.
After a merge, check upstream's release notes for MSP, blackbox-parser or autotune changes that GyroCore
code depends on, and update the base commit in the provenance table.

### Cadence

- Upstream ships two releases a year (`YYYY.6`, `YYYY.12`, with RCs) from `YYYY.M-maintenance` branches,
  and `master` moves about 100 commits a month.
- Development branches: merge `upstream/master` at least monthly to keep conflicts small.
- Release builds of Gyroflight: base on the latest upstream release tag or maintenance branch.

## CI on the fork

Upstream workflows are kept unmodified so they never conflict. GitHub Actions starts disabled on new
forks; leave it that way, or enable only `test.yml` / `build.yml` and **disable** `deploy.yml`,
`deploy_cloudflare.yml`, `build-release.yml`, `tauri-nightly.yml`, `tauri-release-assets.yml`,
`android-play-release.yml`, `translations-*.yml`, `stale.yaml`, `auto-close.yml` and
`hide-artifact-links.yml` in the Actions UI (they need upstream secrets or act on issues/PRs).
`test.yml` only runs on PRs and on pushes to `master` / `*-maintenance`, so pushes to our branches run
nothing until a fork workflow is added.

The local pre-commit hook (husky → lint-staged) runs prettier, `eslint --fix` and `vue-tsc` with whatever
Node is on `PATH`; use Node 24.
