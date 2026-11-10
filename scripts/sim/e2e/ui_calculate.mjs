/* global document, window */
// E2E roll proof, app step: import the start tune's Blackbox logs through the normal GyroFlight app (Vite dev server
// on http://localhost:5199), click Calculate and record what the user sees under "Tuning and apply": the experimental
// proposal (4b, with its items and the Apply button), the informative improvement step rows and the decision table (4c).
// The script reads the page only; it never ticks the acknowledgement and never clicks Preview or Apply.
// Usage: node scripts/sim/e2e/ui_calculate.mjs <outDir> <bbl> [<bbl> ...]
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";

const [OUT, ...LOGS] = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const b = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
const ctx = await b.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
await ctx.addInitScript(() => {
    delete window.showOpenFilePicker;
    window.showOpenFilePicker = undefined;
});
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(e.message));
await p.goto("http://localhost:5199/", { waitUntil: "load", timeout: 180000 });
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
const t0 = Date.now();
for (const log of LOGS) {
    let btn = p.locator("button", { hasText: /Import Blackbox Log|Import another/i }).first();
    if (!(await btn.count())) btn = p.locator("button", { hasText: /Import/i }).first();
    await btn.scrollIntoViewIfNeeded({ timeout: 30000 });
    const [fc] = await Promise.all([p.waitForEvent("filechooser", { timeout: 30000 }), btn.click({ force: true })]);
    await fc.setFiles(log);
    await p.waitForFunction(() => !/Decoding|Analysing|Reading|Selecting/.test(document.body.innerText), null, {
        timeout: 300000,
    });
    await p.waitForTimeout(1000);
}
const importedMs = Date.now() - t0;
const calc = p.getByRole("button", { name: /Calculate/i }).first();
let calculateMs = null;
if ((await calc.count()) && (await calc.isEnabled())) {
    const t1 = Date.now();
    await calc.click();
    await p.waitForFunction(() => !/Calculating|Analysing/.test(document.body.innerText), null, { timeout: 600000 });
    await p.waitForTimeout(1500);
    calculateMs = Date.now() - t1;
} else console.log("Calculate button missing or disabled");
const tuning = p.getByText("Tuning and apply", { exact: false }).first();
if (await tuning.count()) await tuning.click().catch(() => {});
await p.waitForTimeout(1500);
// Open every <details> in the experimental section so the withheld items and checks are visible in the screenshot.
await p.evaluate(() => document.querySelectorAll("details").forEach((d) => (d.open = true)));
await p.waitForTimeout(500);
const read = await p.evaluate(() => {
    const text = (sel) => [...document.querySelectorAll(sel)].map((e) => e.innerText.trim());
    const cells = (tr) => [...tr.querySelectorAll("td")].map((td) => td.innerText.trim());
    const apply = document.querySelector('[data-gyrocore="v2-experimental-apply"]');
    const preview = document.querySelector('[data-gyrocore="v2-experimental-preview"]');
    const ack = document.querySelector('[data-gyrocore="v2-experimental-ack"]');
    return {
        experimentalNone: text('[data-gyrocore="v2-experimental-none"]'),
        experimentalStatus: text('[data-gyrocore="v2-experimental-status"]'),
        experimentalItems: [...document.querySelectorAll('[data-gyrocore="v2-experimental-items"] tbody tr')].map(
            (tr) => ({
                key: tr.getAttribute("data-key"),
                source: tr.getAttribute("data-source"),
                status: tr.getAttribute("data-status"),
                cells: cells(tr),
            }),
        ),
        withheld: text('[data-gyrocore="v2-experimental-withheld"] li'),
        limits: text('[data-gyrocore="v2-experimental-limits"]'),
        checks: text('[data-gyrocore="v2-experimental-checks"] li'),
        blocks: text('[data-gyrocore="v2-experimental-blocks"]'),
        applyButton: apply
            ? { present: true, disabled: apply.disabled, text: apply.innerText.trim() }
            : { present: false },
        previewButton: preview ? { present: true, disabled: preview.disabled } : { present: false },
        ackCheckbox: ack ? { present: true, checked: ack.checked } : { present: false },
        buttonsInsideStepBlock: document.querySelectorAll('[data-gyrocore="v2-improvement-steps"] button').length,
        decisions: [...document.querySelectorAll('[data-gyrocore="v2-decisions"] tbody tr')].map((tr) => ({
            axis: tr.getAttribute("data-axis"),
            route: tr.getAttribute("data-route"),
            status: tr.getAttribute("data-status"),
            cells: cells(tr),
            values: [...tr.querySelectorAll('[data-gyrocore="v2-decision-values"] span')].map((s) =>
                s.innerText.trim(),
            ),
        })),
        verified: text('[data-gyrocore="v2-verified"]').map((s) => s.slice(0, 300)),
    };
});
read.improvementRows = await p.evaluate(() =>
    [...document.querySelectorAll('[data-gyrocore="v2-improvement-steps"] tbody tr')].map((tr) => ({
        axis: tr.getAttribute("data-axis"),
        state: tr.getAttribute("data-state"),
        source: tr.getAttribute("data-source"),
        text: tr.innerText.trim(),
    })),
);
// What the user sees for roll: a proposal (an experimental item with the Apply route), an informative step only, or a block.
const rollItems = read.experimentalItems.filter((it) => /_roll$/.test(it.key ?? ""));
const rollStep = read.improvementRows.find((r) => r.axis === "roll") ?? null;
const rollDecision = read.decisions.find((r) => r.axis === "roll" && r.route === "primary") ?? null;
read.rollShown = rollItems.length ? "proposal" : rollStep?.state === "step" ? "informative_step_only" : "blocked";
writeFileSync(
    `${OUT}/tuning_and_apply.json`,
    JSON.stringify({ logs: LOGS, errs, importedMs, calculateMs, rollItems, rollStep, rollDecision, read }, null, 1),
);
const section = p.locator('[data-step="v2-experimental"]').first();
if (await section.count()) await section.scrollIntoViewIfNeeded();
await p.screenshot({ path: `${OUT}/tuning_and_apply_viewport.png` });
const items = p.locator('[data-gyrocore="v2-experimental-items"]').first();
if (await items.count()) await items.screenshot({ path: `${OUT}/experimental_items.png` });
const block = p.locator('[data-gyrocore="v2-improvement-steps"]').first();
if (await block.count()) await block.screenshot({ path: `${OUT}/improvement_step.png` });
const dec = p.locator('[data-gyrocore="v2-decisions"]').first();
if (await dec.count()) await dec.screenshot({ path: `${OUT}/decisions.png` });
await p.screenshot({ path: `${OUT}/full_page.png`, fullPage: true });
console.log(
    JSON.stringify(
        {
            errs,
            rollShown: read.rollShown,
            rollItems,
            apply: read.applyButton,
            rollDecisionValues: rollDecision?.values,
        },
        null,
        1,
    ),
);
await b.close();
