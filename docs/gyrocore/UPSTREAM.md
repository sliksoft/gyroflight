# GyroCore App — upstream tracking and provenance

GyroCore App is a fork of the Betaflight App. We add GyroCore features beside
Betaflight's code and keep consuming upstream updates. We do **not** contribute
this fork back upstream (no upstream PRs, no pushes to upstream).

## Provenance

| Item                     | Value                                                                       |
| ------------------------ | --------------------------------------------------------------------------- |
| Upstream repository      | https://github.com/betaflight/betaflight-configurator                       |
| Upstream default branch  | `master`                                                                    |
| Fork base commit         | `d85e797e8674e3059cc3172e38df831e46a5250c` (upstream `master`, 2026-10-09)  |
| Upstream version at base | `2026.12.0-alpha` (package.json)                                            |
| Fork repository          | https://github.com/sliksoft/gyrocore-app (GitHub fork of the upstream repo) |
| Fork default branch      | `master`: an exact mirror of upstream, never committed to directly          |
| GyroCore work branches   | `gyrocore/*`, first: `gyrocore/pwa-foundation`                              |
| Licence                  | GPL-3.0-or-later, inherited from upstream (`LICENSE`, `DEFAULT_LICENSE.md`) |

Toolchain at the base commit (from upstream `package.json` `engines` and `.nvmrc`):
Node `24.21.0` (`^24.21.0`), npm `11.19.0` (`>=11.19.0`).

## Remotes

```
origin    git@github.com:sliksoft/gyrocore-app.git              (fetch/push)
upstream  https://github.com/betaflight/betaflight-configurator.git (fetch only)
```

Push to `upstream` is disabled locally (`git remote set-url --push upstream DISABLED_NO_UPSTREAM_PUSH`).
Set the same on any new clone.

## Licensing rules (GPL-3.0)

- Keep `LICENSE`, `DEFAULT_LICENSE.md`, every existing copyright/"This file is part of Betaflight" header,
  and the CC-BY model notices in `resources/models/*.license.txt`.
- New GyroCore source files start with the GPL header adapted to "This file is part of GyroCore App,
  a derivative of the Betaflight App" (see any file in `src/gyrocore/`).
- The app must keep visible attribution to the Betaflight App and a link to this fork's source.
  This is currently on the GyroCore tab; Betaflight's own landing/help attribution text is left as is.
- Distribution of builds (including the PWA at https://app.gyrocore.dev/) requires the corresponding
  source to be available: the public `sliksoft/gyrocore-app` repository satisfies this.

## Rules for changing the fork

1. **Prefer additions under `src/gyrocore/`** (tests under `test/gyrocore/`, docs under `docs/gyrocore/`).
2. **Minimise edits to upstream files.** When an upstream file must change, make it a small, append-only
   hook (an import plus a spread) and keep GyroCore logic in `src/gyrocore/`.
3. **Never move or rewrite Betaflight implementations** (Firmware Flasher, Blackbox Viewer, Autotune,
   serial/USB/Bluetooth transports, MSP, PWA). Wrap or consume them; don't fork their code into our namespace.
4. **GyroCore strings live in `src/gyrocore/locales/en.json`**, not `locales/en/messages.json`
   (the most frequently changed upstream file). Keys are prefixed `gyrocore` and must never shadow an
   upstream key (tested).
5. **Record every upstream-file modification below.** If a file is copied from upstream into
   `src/gyrocore/` and modified, note the source path and upstream commit in its header.
6. Do not edit `src/dist/`, `node_modules/`, generated files, or non-English locale files.

### Upstream files modified by GyroCore

| File                                                                        | Change                                                          | Why                                                                  |
| --------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------- |
| `src/js/vue_tab_registry.js`                                                | import + `...gyrocoreTabComponents`                             | register GyroCore tab components                                     |
| `src/components/sidebar/sidebar_items.js`                                   | import + `...gyrocoreSidebarItems` appended after Blackbox      | sidebar entries (index 0/1 order is tested)                          |
| `src/js/gui.js`                                                             | import + `...gyrocoreAllowedTabs` in both default allowed lists | `switchTab` rejects tabs not in `allowedTabs`                        |
| `package.json`                                                              | `productName`, `displayName`, `description`                     | app identity; feeds the PWA manifest                                 |
| `src/index.html`                                                            | `<title>`, meta description                                     | app identity                                                         |
| `src/images/pwa/pwa-192-192.png`, `pwa-512-512.png`, `apple-touch-icon.png` | replaced with the GyroCore/Redline mark                         | installed-PWA icon (filenames kept so `vite.config.js` is untouched) |

Everything else (header logo, `favicon.ico`, Tauri/Capacitor identity, welcome text) is still upstream's.

## Updating from upstream

Merge, don't rebase: GyroCore branches are shared and long-lived, and rebasing ~100 upstream commits a
month re-resolves the same conflicts repeatedly.

```bash
git config rerere.enabled true            # once per clone
nvm use                                   # Node from .nvmrc
git fetch upstream --tags

# 1. keep master an exact mirror
git switch master
git merge --ff-only upstream/master
git push origin master

# 2. merge into the GyroCore branch (or a release tag, e.g. 2026.12.0, for release builds)
git switch gyrocore/<branch>
git merge upstream/master                 # or: git merge <tag>

# 3. resolve, then verify
npm ci
npm run typecheck && npx eslint src scripts *.mjs && npx vitest run && npm run build
```

Then smoke the PWA (`npm run preview`): Firmware Flasher, Blackbox Viewer, Autotune (Expert mode) and the
GyroCore tab load with no page errors; the manifest still says GyroCore.

Expected conflict hotspots: `package.json` / `package-lock.json` (take upstream's lockfile, re-apply our
fields, `npm install`), `src/js/gui.js` allowed-tab lists, `sidebar_items.js`, `vue_tab_registry.js`.
After a merge, check upstream's release notes for MSP, blackbox-parser or autotune changes that GyroCore
code depends on, and update the base commit in the provenance table.

### Cadence

- Upstream ships two releases a year (`YYYY.6`, `YYYY.12`, with RCs) from `YYYY.M-maintenance` branches,
  and `master` moves about 100 commits a month.
- Development branches: merge `upstream/master` at least monthly to keep conflicts small.
- Release builds of GyroCore: base on the latest upstream release tag or maintenance branch.

## CI on the fork

Upstream workflows are kept unmodified so they never conflict. GitHub Actions starts disabled on new
forks; leave it that way, or enable only `test.yml` / `build.yml` and **disable** `deploy.yml`,
`deploy_cloudflare.yml`, `build-release.yml`, `tauri-nightly.yml`, `tauri-release-assets.yml`,
`android-play-release.yml`, `translations-*.yml`, `stale.yaml`, `auto-close.yml` and
`hide-artifact-links.yml` in the Actions UI (they need upstream secrets or act on issues/PRs).
`test.yml` only runs on PRs and on pushes to `master` / `*-maintenance`, so pushes to `gyrocore/*` run
nothing until a GyroCore workflow is added.

The local pre-commit hook (husky → lint-staged) runs prettier, `eslint --fix` and `vue-tsc` with whatever
Node is on `PATH`; use Node 24.
