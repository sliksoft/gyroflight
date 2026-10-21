# Desktop builds (Tauri)

Gyroflight uses upstream's Tauri setup unchanged: `src-tauri/`, `npm run tauri:build`. Bundle targets
in `src-tauri/tauri.conf.json` are deb, rpm, AppImage, dmg and NSIS. Both procedures below were run on
2026-10-21 from `9a97095a`.

> The bundles still carry upstream's identity: `productName` "Betaflight", identifier
> `com.betaflight.app`, window title "Betaflight". They therefore install as, and share app data with,
> a stock Betaflight App. Choosing Gyroflight's name and identifier is an open product decision; until
> then these builds are for testing only.

## Linux (Ubuntu 24.04 / WSL2)

```bash
npm ci
npm run tauri:build       # runs scripts/check-tauri-prereqs.mjs first
```

`check-tauri-prereqs.mjs` also requires `librsvg2-dev` and `libssl-dev`. They are generic Tauri
prerequisites, but nothing in this app's `Cargo.lock` links them (no `openssl-sys`, no `librsvg`), and
the build and all three bundles succeed without them:

```bash
npm run tauri -- build    # same build, without the prereq gate
```

What the build does need: `libwebkit2gtk-4.1-dev`, `libjavascriptcoregtk-4.1-dev`, `libsoup-3.0-dev`,
`libgtk-3-dev`, `libudev-dev` (serial enumeration), `pkg-config`, a Rust toolchain and Node 24. The
AppImage step downloads linuxdeploy and its plugins from GitHub.

To make the gate pass instead: `sudo apt install -y librsvg2-dev libssl-dev`.

On Linux, `src-tauri/src/lib.rs` sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` unless it is already set. The
WebKit web and network processes of a running build inherit it.

## Windows

Needs Node 24, Rust (`stable-x86_64-pc-windows-msvc`), Visual Studio 2022 or its Build Tools with the
"Desktop development with C++" workload (MSVC + Windows SDK), and the WebView2 runtime (part of
Windows 11).

```bat
git clone <repo> C:\src\gyroflight
cd C:\src\gyroflight
git checkout <branch>
npm ci
npm run tauri:build
```

- **Build from a git clone, not an exported tree.** `vite.config.js` runs `git rev-parse` and fails
  without `.git`.
- **Keep paths short.** A git dependency (`tauri-plugin-blec`) has deep example paths. Under a long
  `CARGO_HOME` (e.g. one under `%LOCALAPPDATA%\Temp\…`) cargo fails with "path too long". The default
  `%USERPROFILE%\.cargo` and a short checkout path work.
- The NSIS step downloads NSIS 3.11 and `nsis_tauri_utils.dll` into `%LOCALAPPDATA%\tauri\NSIS`.
- `package.json` asks for Node `^24.21.0`; an older 24.x only warns (`EBADENGINE`).

Output: `src-tauri\target\release\bundle\nsis\<productName>_<version>_x64-setup.exe`.
