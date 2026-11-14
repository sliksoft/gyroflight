/*
 * GyroFlight roll autotune demo against the AIR65 Betaflight lockstep SITL (simulator only).
 *
 *   node_modules/.bin/jiti scripts/sim/air65RollAutotune.ts --out <new directory> [--only T1_air65_current,...]
 *
 * For every pre-registered start tune GyroFlight measures the start, chooses roll P/I/D
 * candidates itself (src/gyrocore/tuning/simRollAutotune.ts), measures each in the SITL
 * through scripts/sim/air65_roll_sitl.py and keeps the best measured tune only if it is
 * also better on the held-out manoeuvres. Nothing is written to a flight controller.
 *
 * Refuses to run when the pre-registration, the loop or the adapter differ from the
 * committed version, when the VliegAI checkout is not the registered commit, when a
 * measurement ran another ELF than the pinned one, or when the output directory exists.
 */

import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
    MeasurementInvalid,
    runStartTune,
    type Measure,
    type Measurement,
    type Preregistration,
    type StartTuneResult,
} from "../../src/gyrocore/tuning/simRollAutotune";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const PREREG = join(HERE, "air65_roll_autotune_prereg.json");
const ADAPTER = join(HERE, "air65_roll_sitl.py");
const LOOP = join(REPO, "src/gyrocore/tuning/simRollAutotune.ts");
const SELF = fileURLToPath(import.meta.url);

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

function stop(message: string): never {
    console.error(`STOP: ${message}`);
    process.exit(2);
}

interface Environment {
    vliegaiRoot: string;
    vliegaiHead: string;
    python: string;
    baseOverlay: string;
    elfSha256: string;
    runtimeRoot: string;
}

async function main(): Promise<void> {
    const outArg = arg("--out");
    if (!outArg) stop("--out <new directory> is required");
    const out = resolve(outArg);
    if (existsSync(out)) stop(`output_dir_exists:${out}`);

    // Provenance: the registered files are the committed ones, and the simulator is the registered checkout.
    const tracked = [PREREG, ADAPTER, LOOP, SELF];
    const dirty = git(REPO, "status", "--porcelain", "--", ...tracked);
    if (dirty) stop(`registered files differ from HEAD:\n${dirty}`);
    const pre = JSON.parse(readFileSync(PREREG, "utf8").replace(/"~\//g, `"${process.env.HOME}/`)) as Preregistration & { environment: Environment };
    const env = pre.environment;
    const vliegaiHead = git(env.vliegaiRoot, "rev-parse", "HEAD");
    if (vliegaiHead !== env.vliegaiHead) stop(`vliegai_head:${vliegaiHead}!=${env.vliegaiHead}`);
    const only = arg("--only")?.split(",");
    const tunes = pre.startTunes.filter((t) => !only || only.includes(t.id));
    if (!tunes.length) stop("no start tune selected");

    mkdirSync(join(out, "runs"), { recursive: true });
    const provenance = {
        startedAt: new Date().toISOString(),
        gyroflightHead: git(REPO, "rev-parse", "HEAD"),
        preregSha256: sha256(PREREG),
        adapterSha256: sha256(ADAPTER),
        loopSha256: sha256(LOOP),
        cliSha256: sha256(SELF),
        vliegaiHead,
        vliegaiStatus: git(env.vliegaiRoot, "status", "--porcelain", "--untracked-files=no"),
        elfSha256: env.elfSha256,
        argv: process.argv.slice(2),
    };
    writeFileSync(join(out, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
    const logLines: string[] = [];
    const log = (line: string) => {
        const stamped = `${new Date().toISOString()} ${line}`;
        logLines.push(stamped);
        console.log(stamped);
        writeFileSync(join(out, "loop.log"), `${logLines.join("\n")}\n`);
    };

    let measurements = 0;
    const measure: Measure = async (pid, dMax, schedule, label) => {
        measurements++;
        const dir = join(
            out,
            "runs",
            `${String(measurements).padStart(3, "0")}_${label.replace(/[^A-Za-z0-9_.-]/g, "_")}`,
        );
        const request = {
            vliegaiRoot: env.vliegaiRoot,
            baseOverlay: join(env.vliegaiRoot, env.baseOverlay),
            rollPid: { ...pid, dMax },
            rollScheduleDps: schedule.rollDps,
            outDir: dir,
            runtimeRoot: env.runtimeRoot,
            label,
        };
        mkdirSync(env.runtimeRoot, { recursive: true });
        const requestPath = `${dir}.request.json`;
        writeFileSync(requestPath, `${JSON.stringify(request)}\n`);
        const code = await new Promise<number>((done) => {
            const child = spawn(env.python, [ADAPTER, requestPath], {
                cwd: env.vliegaiRoot,
                env: { ...process.env, CUDA_VISIBLE_DEVICES: "" },
                stdio: ["ignore", "ignore", "pipe"],
            });
            const err: Buffer[] = [];
            child.stderr.on("data", (b: Buffer) => err.push(b));
            child.on("close", (c) => {
                writeFileSync(`${dir}.stderr.log`, Buffer.concat(err));
                done(c ?? -1);
            });
        });
        const resultPath = join(dir, "result.json");
        if (code !== 0 || !existsSync(resultPath)) return { status: "harness_error", reason: `adapter_exit_${code}` };
        const m = JSON.parse(readFileSync(resultPath, "utf8")) as Measurement & { elf_sha256?: string };
        if (m.status === "ok" && m.elf_sha256 !== env.elfSha256)
            stop(`${label}: elf ${m.elf_sha256} != ${env.elfSha256}`);
        return m;
    };

    // The base header is the run's first measurement (the first start tune on the search manoeuvres); every later
    // measurement must equal it except roll PID, d_max_roll and the run-time keys.
    let baseHeader: Record<string, string> | null = null;

    const results: (StartTuneResult | { id: string; start: unknown; decision: "blocked"; reason: string })[] = [];
    for (const tune of tunes) {
        log(`== ${tune.id} start ${tune.pid.p},${tune.pid.i},${tune.pid.d}`);
        try {
            const r = await runStartTune(tune.id, tune.pid, pre, measure, baseHeader, log);
            baseHeader = r.baseHeader;
            results.push(r);
            log(`== ${tune.id} ${r.decision}: ${r.final.p},${r.final.i},${r.final.d} (${r.reason})`);
        } catch (error) {
            if (!(error instanceof MeasurementInvalid)) throw error;
            results.push({ id: tune.id, start: tune.pid, decision: "blocked", reason: error.message });
            log(`== ${tune.id} BLOCKED: ${error.message}`);
        }
        writeFileSync(join(out, "results.json"), `${JSON.stringify({ provenance, results }, null, 2)}\n`);
    }
    writeFileSync(join(out, "results.json"), `${JSON.stringify({ provenance, measurements, results }, null, 2)}\n`);
    log(`done: ${results.map((r) => `${r.id}=${r.decision}`).join(" ")}`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
