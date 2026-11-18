/*
 * Step response from ordinary flights on the existing AIR65 logs (local only).
 *
 *   GYROFLIGHT_STEP_DIR=<folder with the .BBL files>  GYROFLIGHT_STEP_OUT=<report folder> \
 *   npx vitest run test/gyrocore/air65_step_response.local.test.ts
 *
 * Without GYROFLIGHT_STEP_DIR the file is skipped. With it, every listed file must be there with
 * the recorded sha256: a missing or changed file fails the run (no silent skip of evidence).
 * The report (per file, log, axis and threshold: status, windows, manoeuvres, rejections, metrics)
 * is written to GYROFLIGHT_STEP_OUT; nothing is written into the repository.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeStepFile, type StepLogResult } from "@/gyrocore/stepResponse/stepLog";
import { compareStepLogs } from "@/gyrocore/stepResponse/stepCompare";
import { STEP_METHOD, STEP_WINDOW_REASONS } from "@/gyrocore/stepResponse/stepResponse";

const DIR = process.env.GYROFLIGHT_STEP_DIR;
const OUT = process.env.GYROFLIGHT_STEP_OUT;

/** The five AIR65 reference logs (43875a55a) and the older logs of the same craft. */
const FILES: { id: string; file: string; sha256: string; role: string }[] = [
    {
        id: "20261018_231421",
        file: "BTFL_BLACKBOX_LOG_AIR65_C_20261018_231421_BETAFPVG473.BBL",
        sha256: "dfe82bca2aaabbc2f53a20a93756137546cc648196226af622d43874eed7efcb",
        role: "reference",
    },
    {
        id: "20261019_205011",
        file: "BTFL_BLACKBOX_LOG_AIR65_C_20261019_205011_BETAFPVG473.BBL",
        sha256: "4dd55164ddadb529816d52c3709376defe265cf2efdd6b8c31738bd3b26361c7",
        role: "reference",
    },
    {
        id: "20261105_225413",
        file: "BTFL_BLACKBOX_LOG_AIR65_C_20261105_225413_BETAFPVG473.BBL",
        sha256: "5654476ad783f1fa241d9fe6e8ae5f978c3d5cef6b417d0d93a59e26ed2b9894",
        role: "reference",
    },
    {
        id: "20261106_000921",
        file: "BTFL_BLACKBOX_LOG_AIR65_C_20261106_000921_BETAFPVG473.BBL",
        sha256: "eb8ad42e2010e88b6c2bed7e2be4b316993dd38ad86f1438907355d8d5d923a7",
        role: "reference",
    },
    {
        id: "20261106_011849",
        file: "BTFL_BLACKBOX_LOG_AIR65_C_20261106_011849_BETAFPVG473.BBL",
        sha256: "2d0f567f07ae04a19c4d3b15c10e306408575079b57a704b46e3d594ae97be29",
        role: "reference",
    },
    {
        id: "20261005_224215",
        file: "BTFL_BLACKBOX_LOG_AIR65_C_20261005_224215_BETAFPVG473.BBL",
        sha256: "97245445111bbfead8e2f3864dac92e24e70986ef2dce82e0fbf8679bda7b072",
        role: "other build",
    },
    {
        id: "20260928_114919",
        file: "BTFL_BLACKBOX_LOG_AIR65_C_20260928_114919_BETAFPVG473.BBL",
        sha256: "a2352a1802a952b184aa3797e710a1cd2346575f698b8082bf2cd4f124526ccd",
        role: "other firmware",
    },
    {
        id: "20260928_192547",
        file: "BTFL_BLACKBOX_LOG_AIR65_C_20260928_192547_BETAFPVG473.BBL",
        sha256: "759c2baec84cf98c90ae92626015380d45a843b196cd6e4e86e4fc6813d68163",
        role: "other firmware",
    },
];

describe.skipIf(!DIR)("AIR65: step response from ordinary flights (local only)", () => {
    const results: { id: string; role: string; logs: StepLogResult[] }[] = [];

    it(
        "every file is present with the recorded sha256, and every embedded log is analysed",
        { timeout: 900_000 },
        () => {
            for (const f of FILES) {
                const path = join(DIR!, f.file);
                expect(existsSync(path), `${f.file} missing`).toBe(true);
                const bytes = new Uint8Array(readFileSync(path));
                expect(createHash("sha256").update(bytes).digest("hex"), `${f.file} changed`).toBe(f.sha256);
                const logs = analyzeStepFile(bytes, f.file, f.sha256);
                expect(logs.length).toBeGreaterThan(0);
                results.push({ id: f.id, role: f.role, logs });
            }
        },
    );

    it("011849: Log 1 is the hover without CHIRP, Log 2 holds the CHIRP sweeps", () => {
        const logs = results.find((r) => r.id === "20261106_011849")!.logs;
        expect(logs.map((l) => `${l.logNumber}/${l.logCount}`)).toEqual(["1/2", "2/2"]);
        expect(logs[0].chirp.segments).toBe(0);
        expect(logs[1].chirp.segments).toBeGreaterThan(0);
    });

    it("writes the report", () => {
        const rows: string[] = [];
        const json = results.map((r) => ({
            id: r.id,
            role: r.role,
            logs: r.logs.map((l) => ({
                log: `${l.logNumber}/${l.logCount}`,
                status: l.status,
                blockedReasons: l.blockedReasons,
                firmware: l.identity.firmwareRevision,
                sampleRateHz: l.sampleRateHz,
                durationS: l.durationS,
                seconds: l.seconds,
                gaps: l.timestamps?.gapCount ?? null,
                modesSeen: l.modesSeen,
                chirp: l.chirp,
                saturation: l.saturation,
                notes: l.notes,
                axes: Object.fromEntries(
                    Object.entries(l.axes).map(([axis, a]) => [
                        axis,
                        a!.thresholds.map((t) => ({
                            threshold: t.thresholdDegS,
                            status: t.status,
                            windows: `${t.windowsUsed}/${t.windowsTotal}`,
                            manoeuvres: t.manoeuvres,
                            rejected: Object.fromEntries(Object.entries(t.rejected).filter(([, v]) => v)),
                            metrics: t.metrics,
                            finalValueOutliers: t.finalValueOutliers,
                        })),
                    ]),
                ),
            })),
        }));
        for (const r of results) {
            for (const l of r.logs) {
                rows.push(
                    `| ${r.id} | Log ${l.logNumber}/${l.logCount} | ${l.status}${l.blockedReasons.length ? ` (${l.blockedReasons.join(", ")})` : ""} | ${l.sampleRateHz ? Math.round(l.sampleRateHz) : "–"} | ${l.durationS.toFixed(1)} | ${l.seconds.airborne.toFixed(1)} | ${l.seconds.selfLevel.toFixed(1)} | ${l.seconds.chirp.toFixed(1)} | ${l.timestamps?.gapCount ?? "–"} | ${l.modesSeen.join("+") || "–"} |`,
                );
            }
        }
        const axisRows: string[] = [];
        for (const r of results) {
            for (const l of r.logs) {
                for (const [axis, a] of Object.entries(l.axes)) {
                    for (const t of a!.thresholds) {
                        const rej = STEP_WINDOW_REASONS.filter((k) => t.rejected[k])
                            .map((k) => `${k} ${t.rejected[k]}`)
                            .join(", ");
                        axisRows.push(
                            `| ${r.id} | ${l.logNumber}/${l.logCount} | ${axis} | ${t.thresholdDegS} | ${t.status} | ${t.windowsUsed}/${t.windowsTotal} | ${t.manoeuvres} | ${rej || "–"} |`,
                        );
                    }
                }
            }
        }
        // Same-tune control pairs and one-change pairs among the analysed logs, as the card would judge them.
        const analysed = results.flatMap((r) =>
            r.logs.filter((l) => l.status === "ANALYSED").map((l) => ({ id: `${r.id} Log ${l.logNumber}`, l })),
        );
        const pairs: string[] = [];
        for (let i = 0; i < analysed.length; i++) {
            for (let j = i + 1; j < analysed.length; j++) {
                const c = compareStepLogs(analysed[i].l, analysed[j].l, { kind: "none" });
                const deltas = c.axes.filter((x) => x.delta).length;
                const failed = c.pairChecks.filter((x) => x.status === "FAIL").map((x) => x.id);
                const settings = c.intentCheck?.reasons.join("; ") || "–";
                const absent = c.intentCheck?.notInFirmware.map((r) => `${r.id} (${r.firmware?.build})`).join(", ");
                pairs.push(
                    `| ${analysed[i].id} | ${analysed[j].id} | ${c.status} | ${failed.join(", ") || "–"} | ${settings} | ${absent || "–"} | ${deltas} |`,
                );
            }
        }
        const md = [
            `# AIR65: step response from ordinary flights (${STEP_METHOD.version})`,
            "",
            "## Logs",
            "| file | log | status | fs Hz | duration s | airborne s | self-level s | CHIRP s | gaps | modes |",
            "|---|---|---|---|---|---|---|---|---|---|",
            ...rows,
            "",
            "## Per axis and threshold",
            "| file | log | axis | deg/s | status | windows used/total | manoeuvres | rejections |",
            "|---|---|---|---|---|---|---|---|",
            ...axisRows,
            "",
            "## Pairs as a no-change control",
            "| A | B | status | failed pair checks | settings (intent: no change) | not in this build | deltas |",
            "|---|---|---|---|---|---|---|",
            ...pairs,
            "",
        ].join("\n");
        if (OUT) {
            mkdirSync(OUT, { recursive: true });
            writeFileSync(join(OUT, "air65_step_response.md"), md);
            writeFileSync(join(OUT, "air65_step_response.json"), JSON.stringify(json, null, 1));
        }
        expect(rows.length).toBeGreaterThan(0);
    });
});
