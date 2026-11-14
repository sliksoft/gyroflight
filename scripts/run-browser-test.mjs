#!/usr/bin/env node
/*
 * Reproducible browser gate for Autotune v2 (Grokbot F7).
 *
 * Starts Vite on 127.0.0.1:5299, runs one Playwright harness, tears down Vite.
 * No hidden env required: uses playwright-core from node_modules when present.
 *
 * Usage:
 *   node scripts/run-browser-test.mjs crossTabWriteLease
 *   node scripts/run-browser-test.mjs autotuneV2Worker
 *   npm run test:browser
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const which = process.argv[2];
const harnesses = {
    crossTabWriteLease: "test/browser/crossTabWriteLease.browser.mjs",
    autotuneV2Worker: "test/browser/autotuneV2Worker.browser.mjs",
};
const harness = harnesses[which];
if (!harness) {
    console.error(`Usage: node scripts/run-browser-test.mjs <${Object.keys(harnesses).join("|")}>`);
    process.exit(2);
}

try {
    require.resolve("playwright-core");
} catch {
    console.error("playwright-core is not installed. Run: npm i -D playwright-core && npx playwright install chromium");
    process.exit(1);
}

const PORT = Number(process.env.GF_BROWSER_PORT || 5299);
const URL = `http://127.0.0.1:${PORT}/`;
const viteLog = [];

const vite = spawn(
    process.execPath,
    [path.join(root, "node_modules/vite/bin/vite.js"), "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"],
    { cwd: root, env: { ...process.env, BROWSER: "none" }, stdio: ["ignore", "pipe", "pipe"] },
);
vite.stdout.on("data", (b) => viteLog.push(String(b)));
vite.stderr.on("data", (b) => viteLog.push(String(b)));

async function waitReady(ms = 120_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        try {
            const r = await fetch(URL, { signal: AbortSignal.timeout(2000) });
            if (r.ok || r.status === 404) return;
        } catch {
            /* retry */
        }
        if (vite.exitCode != null) throw new Error(`vite exited early: ${vite.exitCode}\n${viteLog.join("")}`);
        await delay(500);
    }
    throw new Error(`vite not ready at ${URL}\n${viteLog.slice(-20).join("")}`);
}

let code = 1;
try {
    await waitReady();
    const child = spawn(process.execPath, [path.join(root, harness)], {
        cwd: root,
        env: {
            ...process.env,
            GF_URL: URL,
            // Prefer an explicit path; otherwise the harness requires("playwright-core").
            ...(process.env.PLAYWRIGHT_CORE ? { PLAYWRIGHT_CORE: process.env.PLAYWRIGHT_CORE } : {}),
        },
        stdio: "inherit",
    });
    code = await new Promise((resolve) => child.on("exit", (c) => resolve(c ?? 1)));
} catch (err) {
    console.error(err instanceof Error ? err.message : err);
    code = 1;
} finally {
    vite.kill("SIGTERM");
    await Promise.race([
        new Promise((r) => vite.on("exit", r)),
        delay(5000).then(() => {
            try {
                vite.kill("SIGKILL");
            } catch {
                /* ignore */
            }
        }),
    ]);
}
process.exit(code);
