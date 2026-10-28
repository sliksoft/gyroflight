/*
 * This file is part of Gyroflight, a derivative of the Betaflight App.
 *
 * Gyroflight is free software. You can redistribute this software
 * and/or modify this software under the terms of the GNU General
 * Public License as published by the Free Software Foundation,
 * either version 3 of the License, or (at your option) any later
 * version.
 *
 * Gyroflight is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 *
 * See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public
 * License along with this software.
 *
 * If not, see <http://www.gnu.org/licenses/>.
 */

/*
 * Autotune v2 Web Worker browser gate (full release gate 2026-10-28).
 *
 * Run against the Vite *dev* server (source modules + /test harness):
 *   npx vite --port 5299 --strictPort --host 127.0.0.1
 *   GF_URL=http://127.0.0.1:5299/ PLAYWRIGHT_CORE=<playwright-core> \
 *     node test/browser/autotuneV2Worker.browser.mjs
 *
 * Compares worker vs sync numerical safety decisions and probes cancel / stale /
 * crash / invalid message. No flight-controller access.
 */

/* global window, Worker, ErrorEvent, performance, AbortController -- page.evaluate browser APIs */

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const URL = process.env.GF_URL ?? "http://127.0.0.1:5299/";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/** Vite SPA middleware swallows `/test/...`; load the harness via `@fs`. */
const SYNTH_URL = `/@fs${path.join(REPO_ROOT, "test/gyrocore/harness/syntheticLog.ts")}`;

const results = [];
const check = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function loadEngine(page) {
    await page.evaluate(async (synthUrl) => {
        const clientMod = await import(
            new URL("/src/gyrocore/engine/autotuneV2WorkerClient.ts", window.location.origin).href
        );
        const eng = await import(new URL("/src/gyrocore/engine/autotuneV2.ts", window.location.origin).href);
        const synth = await import(new URL(synthUrl, window.location.origin).href);
        window.gfAt = { client: clientMod, eng, synth };
    }, SYNTH_URL);
}

async function openPage(browser) {
    const page = await browser.newPage();
    page.on("pageerror", (err) => console.error("PAGEERROR", err.message));
    await page.goto(URL, { waitUntil: "load", timeout: 120000 });
    await page.waitForFunction(() => typeof window.document !== "undefined", null, { timeout: 60000 });
    await loadEngine(page);
    return page;
}

const browser = await chromium.launch({ headless: true });
try {
    const page = await openPage(browser);

    // 1. Worker URL constructs and module loads (ConfigStorage must not throw in the worker).
    const workerBoot = await page.evaluate(async () => {
        let workerUrlOk = false;
        let workerError = null;
        try {
            const u = new URL("/src/gyrocore/engine/autotuneV2.worker.ts", window.location.origin);
            const w = new Worker(u.href, { type: "module" });
            const outcome = await new Promise((resolve) => {
                const t = window.setTimeout(() => resolve({ ok: true }), 1500);
                w.addEventListener("error", (ev) => {
                    window.clearTimeout(t);
                    resolve({ ok: false, message: ev.message || "worker_error" });
                });
            });
            workerUrlOk = outcome.ok;
            workerError = outcome.message || null;
            w.terminate();
        } catch (e) {
            workerUrlOk = false;
            workerError = String(e && e.message ? e.message : e);
        }
        return { workerUrlOk, workerError };
    });
    check(
        "worker module URL constructs and loads without window/ConfigStorage crash",
        workerBoot.workerUrlOk,
        workerBoot.workerError || "",
    );

    // 2. Numerical parity + UI responsiveness during analysis.
    const workerMode = await page.evaluate(async () => {
        const payload = {
            primary: window.gfAt.synth.syntheticLogInput("b".repeat(64)),
            others: [],
            verifiedTune: null,
            createdAt: "2026-10-28T00:00:00Z",
        };
        const t0 = performance.now();
        let uiTicks = 0;
        const tick = window.setInterval(() => {
            uiTicks++;
        }, 16);
        const out = await window.gfAt.client.runAutotuneV2Cancellable(payload);
        window.clearInterval(tick);
        const elapsed = performance.now() - t0;
        const sync = window.gfAt.eng.runAutotuneV2(payload);
        return {
            uiTicks,
            elapsed,
            workerSafety: out.result.safety,
            syncSafety: sync.safety,
            workerPid: out.result.pid.map((p) => ({ axis: p.axis, status: p.status })),
            syncPid: sync.pid.map((p) => ({ axis: p.axis, status: p.status })),
            workerReleased: !!out.result.releasableProposal,
            syncReleased: !!sync.releasableProposal,
            qualConnected: out.qualification.connectedToApply,
            workerEvidence: out.result.safety.analysisEvidence,
            syncEvidence: sync.safety.analysisEvidence,
        };
    });

    check(
        "UI event loop kept ticking during analysis (responsiveness)",
        workerMode.uiTicks >= 1 || workerMode.elapsed < 50,
        `ticks=${workerMode.uiTicks} elapsedMs=${workerMode.elapsed.toFixed(0)}`,
    );
    check(
        "worker and sync safety reasons match",
        JSON.stringify(workerMode.workerSafety) === JSON.stringify(workerMode.syncSafety),
    );
    check(
        "worker and sync PID statuses match",
        JSON.stringify(workerMode.workerPid) === JSON.stringify(workerMode.syncPid),
    );
    check("worker and sync releasableProposal agree", workerMode.workerReleased === workerMode.syncReleased);
    check(
        "worker and sync analysisEvidence match",
        workerMode.workerEvidence === workerMode.syncEvidence,
        `w=${workerMode.workerEvidence} s=${workerMode.syncEvidence}`,
    );
    check("qualification remains disconnected from Apply", workerMode.qualConnected === false);

    // 3. Already-aborted signal rejects.
    const abortEarly = await page.evaluate(async () => {
        const payload = {
            primary: window.gfAt.synth.syntheticLogInput("c".repeat(64)),
            others: [],
            verifiedTune: null,
        };
        const ac = new AbortController();
        ac.abort();
        try {
            await window.gfAt.client.runAutotuneV2Cancellable(payload, ac.signal);
            return { rejected: false };
        } catch (e) {
            return { rejected: true, name: e && e.name };
        }
    });
    check("already-aborted signal rejects with AbortError", abortEarly.rejected && abortEarly.name === "AbortError");

    // 4. Mid-flight abort terminates the worker (does not hang waiting for sync compute).
    const abortMid = await page.evaluate(async () => {
        const payload = {
            primary: window.gfAt.synth.syntheticLogInput("e".repeat(64)),
            others: [],
            verifiedTune: null,
            createdAt: "2026-10-28T00:00:00Z",
        };
        const ac = new AbortController();
        const p = window.gfAt.client.runAutotuneV2Cancellable(payload, ac.signal);
        // Abort on next macrotask so the run message is posted first.
        await new Promise((r) => window.setTimeout(r, 0));
        ac.abort();
        const t0 = performance.now();
        try {
            await p;
            return { rejected: false, ms: performance.now() - t0 };
        } catch (e) {
            return { rejected: true, name: e && e.name, ms: performance.now() - t0 };
        }
    });
    check(
        "mid-flight abort rejects promptly with AbortError",
        abortMid.rejected && abortMid.name === "AbortError" && abortMid.ms < 5000,
        `ms=${abortMid.ms?.toFixed?.(0) ?? abortMid.ms}`,
    );

    // 5. Concurrent analyses complete without cross-contamination.
    const concurrent = await page.evaluate(async () => {
        const mk = (h) => ({
            primary: window.gfAt.synth.syntheticLogInput(h),
            others: [],
            verifiedTune: null,
            createdAt: "2026-10-28T00:00:00Z",
        });
        const [a, b] = await Promise.all([
            window.gfAt.client.runAutotuneV2Cancellable(mk("1".repeat(64))),
            window.gfAt.client.runAutotuneV2Cancellable(mk("2".repeat(64))),
        ]);
        return {
            aEvidence: a.result.safety.analysisEvidence,
            bEvidence: b.result.safety.analysisEvidence,
            aConnected: a.qualification.connectedToApply,
            bConnected: b.qualification.connectedToApply,
        };
    });
    check(
        "concurrent analyses both complete",
        typeof concurrent.aEvidence === "string" && typeof concurrent.bEvidence === "string",
    );
    check(
        "concurrent analyses stay disconnected from Apply",
        concurrent.aConnected === false && concurrent.bConnected === false,
    );

    // 5b. Aborting one concurrent request must not leave the sibling pending forever.
    const abortSibling = await page.evaluate(async () => {
        const mk = (h) => ({
            primary: window.gfAt.synth.syntheticLogInput(h),
            others: [],
            verifiedTune: null,
            createdAt: "2026-10-28T00:00:00Z",
        });
        const ac = new AbortController();
        const a = window.gfAt.client.runAutotuneV2Cancellable(mk("7".repeat(64)), ac.signal);
        const b = window.gfAt.client.runAutotuneV2Cancellable(mk("8".repeat(64)));
        await new Promise((r) => window.setTimeout(r, 0));
        ac.abort();
        const settled = await Promise.allSettled([a, b]);
        return {
            aStatus: settled[0].status,
            aName: settled[0].status === "rejected" ? settled[0].reason?.name : null,
            bStatus: settled[1].status,
            bConnected: settled[1].status === "fulfilled" ? settled[1].value.qualification.connectedToApply : null,
        };
    });
    check(
        "aborting one concurrent request rejects it without stranding the sibling",
        abortSibling.aStatus === "rejected" &&
            abortSibling.aName === "AbortError" &&
            abortSibling.bStatus === "fulfilled" &&
            abortSibling.bConnected === false,
        JSON.stringify(abortSibling),
    );

    await page.close();

    // 6. Worker crash on a fresh module instance (cached worker from prior tests must not hide BoomWorker).
    const crashPage = await openPage(browser);
    const crash = await crashPage.evaluate(async () => {
        // Patch Worker BEFORE any further client use; terminate by aborting so the next run constructs anew.
        const RealWorker = window.Worker;
        let boomConstructed = 0;
        window.Worker = class BoomWorker extends RealWorker {
            constructor(url, opts) {
                boomConstructed++;
                super(url, opts);
                queueMicrotask(() => {
                    this.dispatchEvent(new ErrorEvent("error", { message: "injected_worker_crash" }));
                });
            }
        };
        try {
            const ac = new AbortController();
            const warm = window.gfAt.client.runAutotuneV2Cancellable(
                {
                    primary: window.gfAt.synth.syntheticLogInput("9".repeat(64)),
                    others: [],
                    verifiedTune: null,
                },
                ac.signal,
            );
            ac.abort();
            try {
                await warm;
            } catch {
                /* AbortError expected */
            }
            // Module still caches workerFailed=false and worker=null after terminate; next run uses BoomWorker.
            const payload = {
                primary: window.gfAt.synth.syntheticLogInput("d".repeat(64)),
                others: [],
                verifiedTune: null,
                createdAt: "2026-10-28T00:00:00Z",
            };
            const out = await window.gfAt.client.runAutotuneV2Cancellable(payload);
            return {
                ok: true,
                boomConstructed,
                connected: out.qualification.connectedToApply,
                released: !!out.result.releasableProposal,
            };
        } catch (e) {
            return {
                ok: false,
                boomConstructed,
                message: String(e && e.message ? e.message : e),
            };
        } finally {
            window.Worker = RealWorker;
        }
    });
    check(
        "injected BoomWorker was constructed for the crash probe",
        crash.boomConstructed >= 1,
        `boomConstructed=${crash.boomConstructed}`,
    );
    check(
        "worker crash fails closed: sync fallback or error, Apply disconnected",
        (crash.ok && crash.connected === false && crash.released === false) || crash.ok === false,
        crash.message || `released=${crash.released}`,
    );
    await crashPage.close();

    // 7. Reload drops module state — no stale worker results accepted across reload.
    const reloadPage = await openPage(browser);
    await reloadPage.reload({ waitUntil: "load", timeout: 120000 });
    await loadEngine(reloadPage);
    const afterReload = await reloadPage.evaluate(async () => {
        const payload = {
            primary: window.gfAt.synth.syntheticLogInput("f".repeat(64)),
            others: [],
            verifiedTune: null,
            createdAt: "2026-10-28T00:00:00Z",
        };
        const out = await window.gfAt.client.runAutotuneV2Cancellable(payload);
        const sync = window.gfAt.eng.runAutotuneV2(payload);
        return {
            match: JSON.stringify(out.result.safety) === JSON.stringify(sync.safety),
            connected: out.qualification.connectedToApply,
        };
    });
    check(
        "after reload, fresh analysis matches sync and stays Apply-disconnected",
        afterReload.match && afterReload.connected === false,
    );

    await reloadPage.close();
} finally {
    await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`RESULT ${results.length - failed.length}/${results.length} PASS`);
process.exit(failed.length ? 1 : 0);
