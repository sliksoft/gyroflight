#!/usr/bin/env node
/*
 * SITL bench server for the GyroFlight AutoTune session (block 14; SITL only, local only).
 *
 *   node scripts/sim/session/bench_server.mjs --dir <session dir> --scenario <scenario.json> --seed N
 *        [--starts 400,450,500] [--port 5299] [--start-tune <tune.json>]
 *
 * The bench is the SITL craft: one persistent flash (EEPROM) per session dir, the tune the bench restores on Stop or a
 * lost connection (accepted.json, written before it is echoed), and a journal (journal.jsonl) of every operation.
 * Every operation runs scripts/sim/session/sitl_bench.py (one process per action). The bench decides nothing.
 *
 * WebSocket on 127.0.0.1 only; one client at a time; requests {id, method, params} → {id, ok, result | error};
 * notifications {event: "progress", ...}. Methods:
 *   hello                         → session, scenario, accepted tune, protocol of the measurement
 *   readActive                    → the active tune read over MSP from a booted SITL
 *   setTune {tune}                → write into the flash (Betaflight CLI), then read back over MSP
 *   commitAccepted {tune, measurementId} → record the restore tune; echo it
 *   measure {label}               → one run per start tick (MSP read before arming each), logs as base64
 *   restore {why}                 → restore the accepted tune (the app after a rejected step); see "Restore" below
 *   abort                         → stop the running helper (process group; no SITL left), restore the accepted
 *                                   tune and read it back
 *   finish                        → the session ended normally; no restore on disconnect afterwards
 * A connection that closes while the session is open is handled as abort (journal: connection_lost).
 *
 * Restore (one path for restore, abort and a lost connection): up to RESTORE_ATTEMPTS attempts without waiting for the
 * app to reconnect (restore and Stop: on the open connection; a lost connection: after it closed), RESTORE_WAIT_MS between
 * them, no new attempt starts after RESTORE_DEADLINE_MS (an attempt already started finishes). Each attempt writes the
 * accepted tune (Betaflight CLI) and reads the active tune over MSP; only an exact read (same tune, PID profile 0,
 * disarmed) succeeds. Every attempt is journalled (restore_attempt) and announced to the app (progress, label "restore").
 * When all fail, the restore is unconfirmed: the bench then refuses setTune, measure and commitAccepted
 * (restore_unconfirmed_locked) and does not close the session on finish, until a later restore succeeds; a lost
 * connection tries once more. While an abort runs, the same actions are refused too (abort_in_progress).
 * --start-tune provisions that tune into a fresh flash before the server listens (the craft's tune before the session).
 */

import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    appendFileSync,
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
    renameSync,
    fsyncSync,
    openSync,
    closeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const HERE = dirname(fileURLToPath(import.meta.url));
const CFG = JSON.parse(readFileSync(join(HERE, "bench_config.json"), "utf8").replace(/"~\//g, `"${process.env.HOME}/`));
const args = process.argv.slice(2);
const arg = (k, d = null) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : d;
};
const DIR = resolve(arg("--dir"));
const SCENARIO = JSON.parse(readFileSync(arg("--scenario"), "utf8"));
const SEED = Number(arg("--seed"));
const STARTS = (arg("--starts", "400,450,500") || "").split(",").map(Number);
const PORT = Number(arg("--port", "5299"));
const START_TUNE = arg("--start-tune");
/*
 * Fault injection for the restore-path tests only (off unless named; each one is journalled when armed and when it fires):
 *   end_flash_drift    on the session's second readActive (its end-of-session read) the bench first writes a drifted tune
 *                      (pitch P + 1) into the flash, so the SITL really holds another tune and MSP reads it truthfully;
 *   restore_fail_first:N  the bench's first N restore attempts (1 ≤ N < RESTORE_ATTEMPTS) fail before they write
 *                      anything; each still reads the active tune over MSP (what the SITL holds) and journals it;
 *   restore_fail_always   every restore attempt fails that way (the restore stays unconfirmed).
 */
const RESTORE_ATTEMPTS = 3;
const RESTORE_WAIT_MS = [2000, 5000];
const RESTORE_DEADLINE_MS = 90_000;
const INJECT = new Set(args.flatMap((a, i) => (a === "--inject" ? [args[i + 1]] : [])));
let restoreFailFirst = 0;
for (const f of INJECT) {
    const m = /^restore_fail_first:(\d+)$/.exec(f);
    if (m && Number(m[1]) >= 1 && Number(m[1]) < RESTORE_ATTEMPTS) restoreFailFirst = Number(m[1]);
    else if (!["end_flash_drift", "restore_fail_always"].includes(f)) {
        console.error(`STOP: unknown or invalid --inject ${f}`);
        process.exit(2);
    }
}
/** Restore attempts made so far (the injected failures count them). */
let restoreAttempts = 0;
/** Set when every attempt of a restore failed; cleared by a later exact restore. */
let restoreUnconfirmed = false;
let readActiveCalls = 0;
if (!DIR || !Number.isFinite(SEED)) {
    console.error("usage: bench_server.mjs --dir D --scenario S --seed N");
    process.exit(2);
}
const FLASH = join(DIR, "flash");
const OPS = join(DIR, "ops");
mkdirSync(OPS, { recursive: true });
const JOURNAL = join(DIR, "journal.jsonl");
let opCount = existsSync(JOURNAL) ? readFileSync(JOURNAL, "utf8").split("\n").filter(Boolean).length : 0;

function journal(entry) {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n";
    const fd = openSync(JOURNAL, "a");
    appendFileSync(fd, line);
    fsyncSync(fd);
    closeSync(fd);
}

function sitlRunning() {
    try {
        const out = execFileSync("pgrep", ["-f", "betaflight_SITL.elf --ip"], { encoding: "utf8" });
        return out
            .split("\n")
            .filter(Boolean)
            .filter((p) => Number(p) !== process.pid);
    } catch {
        return [];
    }
}

/** The running helper (one at a time). */
let current = null;

function runHelper(action, extra, label) {
    opCount++;
    const out = join(OPS, `${String(opCount).padStart(3, "0")}_${action}${label ? "_" + label : ""}`);
    const req = {
        vliegaiRoot: CFG.vliegaiRoot,
        elf: CFG.elf,
        elfSha256: CFG.elfSha256,
        betaflightCommit: CFG.betaflightCommit,
        betaflightSource: CFG.betaflightSource,
        baseOverlay: CFG.baseOverlay,
        runtimeRoot: CFG.runtimeRoot,
        fixedSettings: { ...CFG.fixedSettings, ...(SCENARIO.fixedSettings || {}) },
        action,
        outDir: out,
        flashDir: FLASH,
        highResolution: true,
        ...extra,
    };
    mkdirSync(CFG.runtimeRoot, { recursive: true });
    writeFileSync(out + ".request.json", JSON.stringify(req, null, 1));
    return new Promise((resolveP) => {
        const child = spawn(CFG.python, [join(HERE, "sitl_bench.py"), out + ".request.json"], {
            cwd: CFG.vliegaiRoot,
            env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", CUDA_VISIBLE_DEVICES: "" },
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const logs = [];
        child.stdout.on("data", (d) => logs.push(d));
        child.stderr.on("data", (d) => logs.push(d));
        // SITL processes that already ran before this helper are not the bench's to stop (Grok block 14 r1, note 7).
        current = { child, action, out, killed: false, preexisting: new Set(sitlRunning()) };
        child.on("exit", (code, signal) => {
            writeFileSync(out + ".log", Buffer.concat(logs));
            const killed = current?.child === child && current.killed;
            if (current?.child === child) current = null;
            let result = null;
            try {
                result = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
            } catch {
                result = { status: "harness_error", reason: killed ? "stopped" : `no_result:exit_${code}_${signal}` };
            }
            if (killed) result = { ...result, status: "stopped", reason: "stopped_by_abort" };
            resolveP(result);
        });
    });
}

async function stopHelper() {
    const c = current;
    if (!c) return { helperStopped: sitlRunning().length === 0, wasRunning: false };
    const ours = () => sitlRunning().filter((p) => !c.preexisting.has(p));
    c.killed = true;
    const done = new Promise((r) => c.child.once("exit", r));
    try {
        process.kill(-c.child.pid, "SIGTERM");
    } catch {}
    const t = setTimeout(() => {
        try {
            process.kill(-c.child.pid, "SIGKILL");
        } catch {}
    }, 5000);
    await done;
    clearTimeout(t);
    // The SITL process may sit in its own session: anything left running from the bench's ELF is stopped too.
    for (let k = 0; k < 20 && ours().length; k++) {
        for (const pid of ours())
            try {
                process.kill(Number(pid), k < 10 ? "SIGTERM" : "SIGKILL");
            } catch {}
        await new Promise((r) => setTimeout(r, 250));
    }
    return { helperStopped: ours().length === 0, wasRunning: true };
}

const AXES = ["roll", "pitch", "yaw"];
const tuneOf = (decoded) =>
    decoded
        ? Object.fromEntries(
              AXES.map((a) => [a, { p: decoded[a].p, i: decoded[a].i, d: decoded[a].d, dMax: decoded[a].dMax }]),
          )
        : null;
const activeOf = (r) =>
    r?.active?.decoded
        ? {
              tune: tuneOf(r.active.decoded),
              pidProfile: r.active.decoded._pidProfile,
              armed: r.active.decoded._armed,
              raw: r.active.raw,
          }
        : null;

function readAccepted() {
    const p = join(DIR, "accepted.json");
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}
function writeAccepted(v) {
    const p = join(DIR, "accepted.json");
    writeFileSync(p + ".new", JSON.stringify(v, null, 1));
    const fd = openSync(p + ".new", "r");
    fsyncSync(fd);
    closeSync(fd);
    renameSync(p + ".new", p);
}

async function provision(tune, label) {
    const r = await runHelper("provision", { tune }, label);
    if (r.status !== "ok") throw new Error(`provision_${r.status}:${r.reason ?? ""}`);
    return r;
}
async function readActive(label) {
    const r = await runHelper("read", {}, label);
    if (r.status !== "ok") throw new Error(`read_${r.status}:${r.reason ?? ""}:${r.error ?? ""}`);
    return activeOf(r);
}

function specFor(start) {
    const out = execFileSync(
        "python3",
        [
            join(HERE, "schedule.py"),
            String(start),
            JSON.stringify({ stdDps: 2.0, seed: SEED, highpassHz: 150, highpassOrder: 2 }),
        ],
        {
            encoding: "utf8",
        },
    );
    return JSON.parse(out).measure;
}

let sessionOpen = false;
/** Set while an abort runs: an interrupted measurement starts no further run. */
let aborting = false;
let queue = Promise.resolve();
const serial = (fn) => {
    const p = queue.then(fn, fn);
    queue = p.catch(() => {});
    return p;
};

/** One restore attempt: write the accepted tune, read the active tune over MSP; an injected failure writes nothing. */
async function restoreAttempt(acc, why, n) {
    restoreAttempts++;
    const injected = INJECT.has("restore_fail_always") || restoreAttempts <= restoreFailFirst;
    let rb = null;
    let error = null;
    try {
        if (injected) {
            journal({ op: "injected", fault: "restore_failure", why, attempt: n });
            error = "injected_restore_failure";
        } else await provision(acc.tune, `restore_${why}_a${n}`);
        rb = await readActive(`restore_${why}_a${n}`);
    } catch (e) {
        error = error ?? String(e);
    }
    const exact =
        !error && !!rb && rb.pidProfile === 0 && !rb.armed && JSON.stringify(rb.tune) === JSON.stringify(acc.tune);
    if (!exact && !error) error = "restore_readback_differs";
    journal({ op: "restore_attempt", why, n, of: RESTORE_ATTEMPTS, injected, readback: rb, exact, error });
    return { rb, exact, error };
}

/** Restore the accepted tune: bounded attempts (see "Restore" above); notify announces each attempt to the app. */
async function restoreAccepted(why, notify = () => {}) {
    const acc = readAccepted();
    if (!acc) return { restored: null, error: "no_accepted_tune", attempts: 0 };
    const t0 = Date.now();
    let last = null;
    let n = 0;
    while (n < RESTORE_ATTEMPTS && (n === 0 || Date.now() - t0 < RESTORE_DEADLINE_MS)) {
        n++;
        notify({ event: "progress", label: "restore", run: n, of: RESTORE_ATTEMPTS });
        last = await restoreAttempt(acc, why, n);
        if (last.exact) {
            restoreUnconfirmed = false;
            journal({ op: "restore", why, accepted: acc, readback: last.rb, exact: true, attempts: n });
            return { restored: last.rb, error: null, attempts: n };
        }
        if (n < RESTORE_ATTEMPTS) await new Promise((r) => setTimeout(r, RESTORE_WAIT_MS[n - 1]));
    }
    restoreUnconfirmed = true;
    journal({
        op: "restore",
        why,
        accepted: acc,
        readback: last?.rb ?? null,
        exact: false,
        attempts: n,
        error: "restore_unconfirmed",
        lastError: last?.error ?? null,
    });
    return { restored: last?.rb ?? null, error: "restore_unconfirmed", attempts: n };
}

/** Tuning actions the bench refuses while a restore is unconfirmed. */
const LOCKED = new Set(["setTune", "measure", "commitAccepted"]);

const methods = {
    async hello() {
        return { session: DIR, scenario: SCENARIO, seed: SEED, starts: STARTS, accepted: readAccepted() };
    },
    async readActive() {
        readActiveCalls++;
        if (INJECT.has("end_flash_drift") && readActiveCalls === 2) {
            INJECT.delete("end_flash_drift");
            const acc = readAccepted();
            const drift = JSON.parse(JSON.stringify(acc.tune));
            drift.pitch.p += 1;
            await provision(drift, "injected_end_flash_drift");
            journal({ op: "injected", fault: "end_flash_drift", flashTune: drift });
        }
        const a = await readActive("readActive");
        journal({ op: "readActive", active: a });
        sessionOpen = true;
        return a;
    },
    async setTune({ tune }) {
        await provision(tune, "set");
        const a = await readActive("set");
        journal({ op: "setTune", tune, readback: a });
        return a;
    },
    /** The app's restore after a rejected step (RESTORE / INVALID). */
    async restore({ why }, notify) {
        return restoreAccepted(why || "app", notify);
    },
    async commitAccepted({ tune, measurementId }) {
        const v = { tune, measurementId, at: new Date().toISOString() };
        writeAccepted(v);
        const back = readAccepted();
        journal({ op: "commitAccepted", tune, measurementId });
        return { tune: back.tune, measurementId: back.measurementId };
    },
    async measure({ label }, notify) {
        const runs = [];
        for (const [k, s] of STARTS.entries()) {
            if (aborting) throw new Error("stopped_by_abort");
            notify({ event: "progress", label, run: k + 1, of: STARTS.length });
            const r = await runHelper("measure", { measure: specFor(s) }, `${label}_s${s}`);
            if (r.status === "stopped") throw new Error("stopped_by_abort");
            const log = r.blackbox_log && existsSync(r.blackbox_log) ? readFileSync(r.blackbox_log) : null;
            runs.push({
                start: s,
                status: r.status,
                reason: r.reason ?? null,
                logBase64: log ? log.toString("base64") : null,
                logSha256: log ? createHash("sha256").update(log).digest("hex") : null,
                logPath: r.blackbox_log ?? null,
                active: activeOf(r),
                plant: r.plant ?? null,
            });
        }
        journal({ op: "measure", label, runs: runs.map(({ logBase64, ...x }) => x) });
        return { runs };
    },
    /** The app's result for the journal without closing the session (a session that did not end on the accepted tune). */
    async record({ result }) {
        journal({ op: "app_result", result });
        return { ok: true };
    },
    async finish({ result }) {
        // An unconfirmed restore keeps the session open: a lost connection still tries to restore.
        if (restoreUnconfirmed) {
            journal({ op: "finish_refused", reason: "restore_unconfirmed_locked", result });
            throw new Error("restore_unconfirmed_locked");
        }
        sessionOpen = false;
        journal({ op: "finish", result });
        return { ok: true };
    },
};

/** One abort at a time: a second request (Stop, then the page closes) waits for the first and gets its result. */
let abortRunning = null;
function abort(why, notify) {
    if (abortRunning) {
        journal({ op: "abort_joined", why });
        return abortRunning;
    }
    abortRunning = abortOnce(why, notify).finally(() => {
        abortRunning = null;
    });
    return abortRunning;
}

async function abortOnce(why, notify) {
    aborting = true;
    const stop = await stopHelper();
    await queue; // the interrupted operation settles first
    const r = await serial(() => restoreAccepted(why, notify));
    journal({ op: "abort", why, ...stop, restoredExact: !r.error, error: r.error, attempts: r.attempts });
    // Only a verified restore closes the session: otherwise a lost connection still triggers another restore (Grok r2 note A).
    if (!r.error && stop.helperStopped) sessionOpen = false;
    aborting = false;
    return { helperStopped: stop.helperStopped, restored: r.restored, error: r.error, attempts: r.attempts };
}

if (sitlRunning().length) {
    console.error("STOP: a SITL process is already running");
    process.exit(2);
}
if (INJECT.size) journal({ op: "inject_armed", faults: [...INJECT] });
if (START_TUNE) {
    const tune = JSON.parse(readFileSync(START_TUNE, "utf8"));
    await provision(tune, "craft_start_tune");
    journal({ op: "craft_start_tune", tune });
}

const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
wss.on("error", (e) => {
    console.error(`STOP: bench cannot listen on 127.0.0.1:${PORT}: ${e.message}`);
    process.exit(2);
});
wss.on("listening", () => console.log(`bench ready ws://127.0.0.1:${PORT} dir=${DIR}`));
let client = null;
wss.on("connection", (ws) => {
    if (client) {
        ws.close(4000, "one client at a time");
        return;
    }
    client = ws;
    journal({ op: "connected" });
    const notify = (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
    ws.on("message", async (data) => {
        let msg;
        try {
            msg = JSON.parse(String(data));
        } catch {
            return;
        }
        const { id, method, params } = msg;
        const send = (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ id, ...m }));
        try {
            if (method === "abort") return send({ ok: true, result: await abort("stop", notify) });
            if (!methods[method]) return send({ ok: false, error: `unknown_method:${method}` });
            // Checked in turn (a request queued behind a failing restore or an abort is refused too; Grok r7 N1).
            const result = await serial(() => {
                const refuse = !LOCKED.has(method)
                    ? null
                    : restoreUnconfirmed
                      ? "restore_unconfirmed_locked"
                      : aborting
                        ? "abort_in_progress"
                        : null;
                if (refuse) {
                    journal({ op: "refused", method, reason: refuse });
                    throw new Error(refuse);
                }
                return methods[method](params || {}, notify);
            });
            send({ ok: true, result });
        } catch (e) {
            send({ ok: false, error: String(e instanceof Error ? e.message : e) });
        }
    });
    ws.on("close", async () => {
        client = null;
        journal({ op: "disconnected", sessionOpen });
        if (sessionOpen) await abort("connection_lost");
    });
});
