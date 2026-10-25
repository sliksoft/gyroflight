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
 * Audit WP8-F02 in a real browser: the write lease between real tabs (pages of one browser
 * context, so one origin with its Web Locks, localStorage and BroadcastChannel) of the running app
 * (Vite dev server). Each page runs the app; the test drives the app's own module instances
 * (fcWriteGuard, fcWriteLease, msp, serial) in each tab. The flight controller is a fake transport
 * object put in place of the serial protocol of the tab under test; nothing reaches hardware.
 *
 * Not part of `npm run test` (vitest): run with
 *   GF_URL=http://127.0.0.1:5299/ PLAYWRIGHT_CORE=<path to playwright-core> node test/browser/crossTabWriteLease.browser.mjs
 * against `npx vite --port 5299 --strictPort --host 127.0.0.1`. Prints one line per scenario and
 * exits non-zero when any fails.
 */

/* global window -- the page.evaluate callbacks run in the browser tab */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const URL = process.env.GF_URL ?? "http://127.0.0.1:5299/";
const MSP_SET_PID = 202;
const MSP_STATUS = 101;

const results = [];
const check = (name, ok, detail = "") => {
    results.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function openTab(context) {
    const page = await context.newPage();
    await page.goto(URL, { waitUntil: "load", timeout: 120000 });
    await page.waitForFunction(() => typeof window.MSP === "object", null, { timeout: 120000 });
    await page.evaluate(async () => {
        // The exact URLs the app loaded (Vite may add ?t=...): any other URL would be a second,
        // separate module instance, not the app's.
        const loaded = performance.getEntriesByType("resource").map((e) => e.name);
        const url = (path) => {
            const hit = loaded.find((n) => new URL(n).pathname === path);
            if (!hit) throw new Error(`the app did not load ${path}`);
            return hit;
        };
        window.gf = {
            guard: await import(url("/composables/fcWriteGuard.ts")),
            lease: await import(url("/composables/fcWriteLease.ts")),
            msp: (await import(url("/js/msp.ts"))).default,
            serial: (await import(url("/js/serial.ts"))).serial,
        };
        window.gfSent = [];
    });
    return page;
}

/** The write check's answer for an ordinary SET in `page` (null: admitted). */
const refusal = (page) => page.evaluate((code) => window.gf.guard.mspRequestRefusal(code, [1]), MSP_SET_PID);

async function until(fn, ms = 3000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (await fn()) return true;
        await new Promise((r) => setTimeout(r, 50));
    }
    return false;
}

/** Start a Gyroflight transaction in `page` (the app's withFcWriteLock) that waits until released. */
async function startTransaction(page) {
    await page.evaluate(() => {
        window.gfTx = { entered: false, outcome: null };
        window.gf.guard
            .withFcWriteLock(
                () =>
                    new Promise((resolve) => {
                        window.gfTx.entered = true;
                        window.gfTx.release = resolve;
                    }),
            )
            .then(
                () => (window.gfTx.outcome = "done"),
                (e) => (window.gfTx.outcome = e?.reasons ?? [String(e)]),
            );
    });
}
const entered = (page) => page.evaluate(() => window.gfTx?.entered === true);
const outcome = (page) => page.evaluate(() => window.gfTx?.outcome);
const release = (page) => page.evaluate(() => window.gfTx?.release?.());

/** Put a fake transport behind this tab's serial facade (records what would reach the FC). */
const fakeTransport = (page) =>
    page.evaluate(() => {
        window.gf.serial._protocol = {
            connected: true,
            send: async (d) => {
                window.gfSent.push(Array.from(new Uint8Array(d)));
                return { bytesSent: d.byteLength };
            },
        };
    });

const browser = await chromium.launch({ headless: true });
try {
    // 1. Every tab may write; while another tab's transaction runs, it may not.
    {
        const context = await browser.newContext();
        const a = await openTab(context);
        const b = await openTab(context);
        check(
            "both tabs hold the lease and admit an ordinary SET",
            (await until(async () => (await refusal(a)) === null && (await refusal(b)) === null)) === true,
        );
        await startTransaction(a);
        check("tab A's transaction gets the lease while tab B is idle", await until(() => entered(a)));
        const bRefusal = await refusal(b);
        check(
            "tab B's SET is refused while A's transaction runs",
            Array.isArray(bRefusal) && bRefusal.includes("fc:write_lease_not_held"),
            JSON.stringify(bRefusal),
        );
        await fakeTransport(b);
        const bResult = await b.evaluate(async (code) => {
            try {
                await window.gf.msp.promise(code, [1, 2, 3]);
                return "sent";
            } catch (e) {
                return e?.name ?? String(e);
            }
        }, MSP_SET_PID);
        check(
            "tab B's MSP SET through the real msp.ts is refused and nothing reaches its transport",
            bResult === "WriteRefusedError" && (await b.evaluate(() => window.gfSent.length)) === 0,
            bResult,
        );
        // Awaited until its retries ran out (no FC answers): the read went out, every attempt a STATUS.
        await b.evaluate((code) => window.gf.msp.promise(code).catch(() => undefined), MSP_STATUS);
        const codes = await b.evaluate(() => window.gfSent.map((f) => f[4]));
        check(
            "tab B's reads still go out meanwhile (and no SET)",
            codes.length >= 1 && codes.every((c) => c === MSP_STATUS),
            JSON.stringify(codes),
        );
        const aOwn = await refusal(a);
        check(
            "tab A's own ordinary SET is refused during its transaction",
            Array.isArray(aOwn) && aOwn.length > 0,
            JSON.stringify(aOwn),
        );
        await startTransaction(b);
        check(
            "a second transaction (tab B) is refused, not queued",
            await until(async () => JSON.stringify(await outcome(b)) === JSON.stringify(["fc:write_lock_busy"])),
            JSON.stringify(await outcome(b)),
        );
        await release(a);
        check("after A's transaction tab B may write again", await until(async () => (await refusal(b)) === null));
        await context.close();
    }

    // 2. A tab in the middle of a save keeps the lease until the save ends.
    {
        const context = await browser.newContext();
        const a = await openTab(context);
        const b = await openTab(context);
        await until(async () => (await refusal(b)) === null);
        await b.evaluate(() => window.gf.lease.writeLease.noteSave(1));
        await startTransaction(a);
        await new Promise((r) => setTimeout(r, 1000));
        check("A's transaction waits while tab B saves", (await entered(a)) === false);
        check("tab B's save goes on (B still admits its writes)", (await refusal(b)) === null);
        await b.evaluate(() => window.gf.lease.writeLease.noteSave(-1));
        check("A's transaction starts once B's save ended", await until(() => entered(a)));
        await release(a);
        await context.close();
    }

    // 3. A tab that never gets quiet: the transaction is refused after the wait, never run.
    {
        const context = await browser.newContext();
        const a = await openTab(context);
        const b = await openTab(context);
        await until(async () => (await refusal(b)) === null);
        await b.evaluate(() => window.gf.lease.writeLease.noteSave(1));
        await startTransaction(a);
        const ok = await until(async () => (await outcome(a)) !== null, 12000);
        check(
            "a tab that never yields: A's transaction is refused (fc:write_lease_timeout) and never ran",
            ok &&
                JSON.stringify(await outcome(a)) === JSON.stringify(["fc:write_lease_timeout"]) &&
                !(await entered(a)),
            JSON.stringify(await outcome(a)),
        );
        check("tab B kept its lease", (await refusal(b)) === null);
        await context.close();
    }

    // 4. Closing the tab whose transaction holds the lease frees it for the others.
    {
        const context = await browser.newContext();
        const a = await openTab(context);
        const b = await openTab(context);
        await until(async () => (await refusal(b)) === null);
        await startTransaction(a);
        await until(() => entered(a));
        check("B refused while A's transaction runs", (await refusal(b)) !== null);
        await a.close();
        check(
            "after tab A closed mid-transaction tab B may write again",
            await until(async () => (await refusal(b)) === null),
        );
        await context.close();
    }

    // 5. A frozen tab in the middle of a save (it cannot and would not yield): the browser keeps its
    //    lock, so the transaction is refused, fail-closed; thawed, the tab still holds its lease.
    {
        const context = await browser.newContext();
        const a = await openTab(context);
        const b = await openTab(context);
        await until(async () => (await refusal(b)) === null);
        await b.evaluate(() => window.gf.lease.writeLease.noteSave(1));
        const cdp = await context.newCDPSession(b);
        await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
        await new Promise((r) => setTimeout(r, 300));
        await startTransaction(a);
        const ok = await until(async () => (await outcome(a)) !== null, 12000);
        check(
            "a frozen tab holding the lease: A's transaction is refused, never run",
            ok &&
                JSON.stringify(await outcome(a)) === JSON.stringify(["fc:write_lease_timeout"]) &&
                !(await entered(a)),
            JSON.stringify(await outcome(a)),
        );
        await cdp.send("Page.setWebLifecycleState", { state: "active" });
        check("the thawed tab still holds its lease (the browser did not take it away)", (await refusal(b)) === null);
        await context.close();
    }

    // 5b. A frozen idle tab: if the transaction gets the lease, the thawed tab must not admit a write
    //     while it runs (its own flag says it does not hold the lease).
    {
        const context = await browser.newContext();
        const a = await openTab(context);
        const b = await openTab(context);
        await until(async () => (await refusal(b)) === null);
        const cdp = await context.newCDPSession(b);
        await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
        await new Promise((r) => setTimeout(r, 300));
        await startTransaction(a);
        const ran = await until(() => entered(a), 12000);
        await cdp.send("Page.setWebLifecycleState", { state: "active" });
        if (ran) {
            const thawed = await refusal(b);
            check(
                "frozen idle tab: A's transaction ran; the thawed tab B refuses writes while it runs",
                Array.isArray(thawed) && thawed.includes("fc:write_lease_not_held"),
                JSON.stringify(thawed),
            );
            await release(a);
            check("…and may write again afterwards", await until(async () => (await refusal(b)) === null));
        } else {
            check(
                "frozen idle tab: A's transaction was refused (timeout), never run",
                JSON.stringify(await outcome(a)) === JSON.stringify(["fc:write_lease_timeout"]),
                JSON.stringify(await outcome(a)),
            );
        }
        await context.close();
    }

    // 6. The documented limit: another browser profile (a separate context) is not covered.
    {
        const one = await browser.newContext();
        const two = await browser.newContext();
        const a = await openTab(one);
        const c = await openTab(two);
        await startTransaction(a);
        await until(() => entered(a));
        check(
            "NON-CLAIM: a tab of another browser profile (separate context) is not held back",
            (await refusal(c)) === null,
        );
        await release(a);
        await one.close();
        await two.close();
    }
} finally {
    await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`RESULT ${results.length - failed.length}/${results.length} PASS`);
process.exit(failed.length ? 1 : 0);
