/* global document, window */
// AutoTune session in the normal GyroFlight app (block 14): open the app (Vite dev server, http://localhost:5199) with
// ?sitlBench=ws://127.0.0.1:<port>[&sitlScript=<name>], open Autotune → Tuning and apply, press "Start session" in the
// "AutoTune session (SITL)" panel and wait until the session ends. Records what the user sees (panel text, step rows,
// final comparison, screenshots).
// Usage: node scripts/sim/session/session_ui.mjs <outDir> <port> [--script NAME] [--stop-at STEP:RUN] [--disconnect-at STEP:RUN]
//   --stop-at S:R        press "Stop and restore" when trial step S is measuring run R
//   --disconnect-at S:R  close the page (the bench sees the connection drop) when trial step S is measuring run R
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";

const [OUT, PORT, ...rest] = process.argv.slice(2);
const opt = (k) => {
    const i = rest.indexOf(k);
    return i >= 0 ? rest[i + 1] : null;
};
const script = opt("--script");
const stopAt = opt("--stop-at");
const dropAt = opt("--disconnect-at");
mkdirSync(OUT, { recursive: true });
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
const ctx = await b.newContext({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1 });
const p = await ctx.newPage();
const errs = [];
const consoleLines = [];
p.on("pageerror", (e) => errs.push(e.message));
p.on("console", (m) => consoleLines.push(`${m.type()}: ${m.text()}`.slice(0, 400)));
const url = `http://localhost:5199/?sitlBench=${encodeURIComponent(`ws://127.0.0.1:${PORT}`)}${script ? `&sitlScript=${script}` : ""}`;
await p.goto(url, { waitUntil: "load", timeout: 180000 });
await p.waitForTimeout(4000);
for (let i = 0; i < 15; i++) {
    const dlg = p.locator("[role=dialog][data-state=open]");
    if (!(await dlg.count())) break;
    const close = dlg
        .first()
        .getByRole("button", { name: /close|dismiss|ok|got it|later|skip|cancel/i })
        .first();
    if (await close.count()) await close.click().catch(() => {});
    else await p.keyboard.press("Escape");
    await p.waitForTimeout(800);
}
await p
    .locator('[aria-label*="xpert" i]')
    .first()
    .click()
    .catch((e) => console.log("expert", e.message));
await p.waitForTimeout(800);
await p.getByText("Autotune", { exact: true }).first().click();
await p.waitForTimeout(1500);
await p.getByText("Tuning and apply", { exact: false }).first().click();
const panel = p.locator('[data-gyrocore="sitl-session"]');
await panel.waitFor({ timeout: 60000 });
await p.waitForSelector('[data-gyrocore="sitl-bench"][data-connected="true"]', { timeout: 60000 });
await panel.scrollIntoViewIfNeeded();
await panel.screenshot({ path: `${OUT}/01_connected.png` });

const read = () =>
    p.evaluate(() => {
        const el = document.querySelector('[data-gyrocore="sitl-session"]');
        const txt = (q) => el?.querySelector(q)?.textContent?.replace(/\s+/g, " ").trim() ?? null;
        const prog = el?.querySelector('[data-gyrocore="sitl-progress"]');
        return {
            state: el?.getAttribute("data-state"),
            progress: prog
                ? {
                      phase: prog.getAttribute("data-phase"),
                      step: prog.getAttribute("data-step"),
                      text: prog.textContent.replace(/\s+/g, " ").trim(),
                  }
                : null,
            steps: [...(el?.querySelectorAll('[data-gyrocore="sitl-step"]') ?? [])].map((r) => ({
                index: r.getAttribute("data-index"),
                axis: r.getAttribute("data-axis"),
                verdict: r.getAttribute("data-verdict"),
                scripted: r.getAttribute("data-scripted"),
                base: r.getAttribute("data-base"),
                cells: Object.fromEntries(
                    [...r.querySelectorAll("[data-cell]")].map((c) => [
                        c.getAttribute("data-cell"),
                        c.textContent.replace(/\s+/g, " ").trim(),
                    ]),
                ),
                why: [...r.querySelectorAll("li[data-rule]")].map((li) => ({
                    rule: li.getAttribute("data-rule"),
                    text: li.textContent.trim(),
                })),
            })),
            stop: el?.querySelector('[data-gyrocore="sitl-stop-reason"]')
                ? {
                      reason: el.querySelector('[data-gyrocore="sitl-stop-reason"]').getAttribute("data-reason"),
                      status: el.querySelector('[data-gyrocore="sitl-stop-reason"]').getAttribute("data-status"),
                      text: txt('[data-gyrocore="sitl-stop-reason"]'),
                  }
                : null,
            final: [...(el?.querySelectorAll('[data-gyrocore="sitl-final"] tbody tr') ?? [])].map((r) =>
                [...r.children].map((c) => c.textContent.trim()),
            ),
            finalActive: txt('[data-gyrocore="sitl-final-active"]'),
            error: txt('[data-gyrocore="sitl-error"]'),
            scripted: txt('[data-gyrocore="sitl-scripted"]'),
        };
    });

const t0 = Date.now();
await p.locator('[data-gyrocore="sitl-start"]').click();
const timeline = [];
let last = "";
let action = null;
const trigger = stopAt ?? dropAt;
const [tStep, tRun] = trigger ? trigger.split(":").map(Number) : [null, null];
for (;;) {
    await p.waitForTimeout(2000);
    const r = await read();
    const line = `${r.state} ${r.progress?.phase ?? ""} ${r.progress?.step ?? ""} ${r.progress?.text ?? ""}`;
    if (line !== last) {
        timeline.push({ s: Math.round((Date.now() - t0) / 1000), line });
        last = line;
        console.log(timeline.at(-1).s, line);
    }
    if (trigger && !action && r.progress?.phase === "measuring" && Number(r.progress.step) === tStep) {
        const m = /run (\d+) of/.exec(r.progress.text);
        if (m && Number(m[1]) >= tRun) {
            await panel.screenshot({ path: `${OUT}/02_before_${stopAt ? "stop" : "disconnect"}.png` });
            writeFileSync(`${OUT}/before_action.json`, JSON.stringify(r, null, 1));
            if (stopAt) {
                action = { kind: "stop", at: Date.now() - t0, progress: r.progress };
                await p.locator('[data-gyrocore="sitl-stop"]').click();
            } else {
                action = { kind: "disconnect", at: Date.now() - t0, progress: r.progress };
                await p.close();
                break;
            }
        }
    }
    if (r.state !== "running" && r.state !== "ready" && r.stop) break;
    if (Date.now() - t0 > 3 * 3600 * 1000) {
        timeline.push({ s: Math.round((Date.now() - t0) / 1000), line: "TIMEOUT" });
        break;
    }
}
const out = { url, script, stopAt, dropAt, action, ms: Date.now() - t0, errs, timeline };
if (!(action?.kind === "disconnect")) {
    const r = await read();
    out.read = r;
    await p.evaluate(() => document.querySelector('[data-gyrocore="sitl-session"]')?.scrollIntoView());
    await panel.screenshot({ path: `${OUT}/03_session_end.png` });
    await p.screenshot({ path: `${OUT}/04_full_page.png`, fullPage: true });
}
writeFileSync(`${OUT}/session_ui.json`, JSON.stringify(out, null, 1));
writeFileSync(`${OUT}/console.log`, consoleLines.join("\n"));
await b.close();
console.log("done", OUT, out.read?.stop ?? action);
