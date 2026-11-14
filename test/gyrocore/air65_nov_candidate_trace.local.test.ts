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
 * LOCAL trace (not a regression): the AIR65 CHIRP logs of 5 and 6 November 2026 through the product
 * route, each log on its own and each with the other flight as an independent recording, per axis
 * and per route (primary / JIO): the values the candidate decision rests on, written as JSON to
 * GYROFLIGHT_TRACE_OUT. Skipped without GYROFLIGHT_AIR65_NOV05 / NOV06 (private files, hashes checked).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { buildLogInputs, pickPrimary } from "../../src/gyrocore/engine/logInput";
import { analyzeM4BblFile } from "../../src/js/blackbox/m4_bbl_integration";
import { runAutotuneV2 } from "../../src/gyrocore/engine/autotuneV2";
import type { AutotuneLogInput } from "../../src/gyrocore/engine/autotuneV2";

const FILES = {
    nov05: {
        path: process.env.GYROFLIGHT_AIR65_NOV05,
        sha256: "5654476ad783f1fa241d9fe6e8ae5f978c3d5cef6b417d0d93a59e26ed2b9894",
    },
    nov06: {
        path: process.env.GYROFLIGHT_AIR65_NOV06,
        sha256: "eb8ad42e2010e88b6c2bed7e2be4b316993dd38ad86f1438907355d8d5d923a7",
    },
};
const present = Object.values(FILES).every((f) => !!f.path && existsSync(f.path));
const AXES = ["roll", "pitch", "yaw"] as const;

function load(name: keyof typeof FILES): { log: AutotuneLogInput; qual: ReturnType<typeof qualifyChirpFile> } {
    const f = FILES[name];
    const bytes = new Uint8Array(readFileSync(f.path!));
    const sha = createHash("sha256").update(bytes).digest("hex");
    expect(sha).toBe(f.sha256);
    const qual = qualifyChirpFile(bytes, `${name}.bbl`, 45, AUTOTUNE_MATH);
    // As the app builds it (useAutotuneV2 buildInputs): with the M4 report.
    const [log] = buildLogInputs(bytes, sha, qual, analyzeM4BblFile(bytes, `${name}.bbl`));
    return { log, qual };
}

function trace(
    name: string,
    primary: AutotuneLogInput,
    qual: ReturnType<typeof qualifyChirpFile>,
    others: AutotuneLogInput[],
) {
    const t0 = performance.now();
    const r = runAutotuneV2({ primary, others, verifiedTune: null, createdAt: "2026-11-08T00:00:00Z" });
    const elapsedMs = Math.round(performance.now() - t0);
    return {
        run: name,
        elapsedMs,
        primarySha256: primary.sha256,
        others: others.map((o) => o.sha256),
        sampleRateHz: primary.sampleRateHz,
        primaryLogIndex: primary.logIndex,
        measurements: (qual.logs.find((l) => l.logIndex === primary.logIndex) ?? qual.logs[0]).measurements.map(
            (m) => ({
                id: m.id,
                axis: m.axisName,
                occurrence: m.axisOccurrence,
                state: m.state,
                durationS: (m.endTimeUs - m.startTimeUs) / 1e6,
                quality: m.quality ?? null,
                gates: (m as unknown as { gates?: unknown }).gates ?? null,
            }),
        ),
        chirpPerAxis: Object.fromEntries(
            Object.entries(primary.chirp).map(([a, c]) => [a, { state: c!.state, reasons: c!.qualificationReasons }]),
        ),
        primary: AXES.map((axis) => {
            const pid = r.pid.find((p) => p.axis === axis);
            const m = r.margins[axis]?.current ?? null;
            return {
                axis,
                outcome: pid?.outcome ?? null,
                status: pid?.status ?? null,
                reasons: pid?.reasons ?? null,
                current: pid?.current ?? null,
                proposed: pid?.proposed ?? null,
                margins: m && {
                    status: m.status,
                    crossoverHz: m.crossoverHz,
                    phaseMarginDeg: m.phaseMarginDeg,
                    gainMarginDb: m.gainMarginDb,
                    sensitivityPeakDb: m.sensitivityPeakDb,
                    measured: m.measured,
                    evidence: m.evidence,
                    reasons: m.reasons,
                },
            };
        }),
        jio: {
            status: r.jio.status,
            blockers: r.jio.analysis.blockers,
            crossFlight: (r.jio as unknown as { crossFlight?: unknown }).crossFlight ?? null,
            axes: AXES.map((axis) => {
                const a = r.jio.analysis.axes[axis];
                const c = r.jio.chain[axis];
                return {
                    axis,
                    band: a?.band ?? null,
                    blockers: a?.blockers ?? null,
                    reasons: a?.reasons ?? null,
                    chainReasons: c?.reasons ?? null,
                    margins: c?.margins && {
                        crossoverHz: c.margins.crossoverHz,
                        phaseMarginDeg: c.margins.phaseMarginDeg,
                        gainMarginDb: c.margins.gainMarginDb,
                        sensitivityPeakDb: c.margins.sensitivityPeakDb,
                        measured: c.margins.measured,
                        reasons: c.margins.reasons,
                    },
                };
            }),
        },
        multiRecording: r.multiRecording,
        crossLogPlant: r.crossLogPlant,
        crossLogRejected: r.crossLogRejected,
        candidateDecisions: r.candidateDecisions,
        joint: r.joint,
        chain: {
            validation: r.chain.validation.map((v) => ({
                axis: v.axis,
                controlBand: v.controlBand,
                noiseBand: v.noiseBand,
                reasons: v.reasons,
            })),
            notes: r.chain.notes,
        },
        filters: r.filters,
        pid: r.pid.map((p) => ({ axis: p.axis, outcome: p.outcome, status: p.status, proposed: p.proposed })),
        proposal: r.proposal,
        recordingPlan: r.recordingPlan,
        jioProgress: r.jio.progress,
        experimental: r.experimental,
        experimentalWithheld: r.experimentalWithheld,
        itermRelax: r.itermRelax,
        dterm: r.dterm,
    };
}

describe.skipIf(!present)("AIR65 candidate trace, 5 and 6 November (local)", () => {
    it("each log alone and with the other flight", () => {
        const a = load("nov05");
        const b = load("nov06");
        // The app's own choice of primary (pickPrimary, both imported; 6 November imported last).
        const picked = pickPrimary([
            { ...a.log, order: 1 },
            { ...b.log, order: 2 },
        ])!;
        const pickedQual = picked.primary.sha256 === a.log.sha256 ? a.qual : b.qual;
        const runs = [
            trace(
                `app:${picked.primary.sha256 === a.log.sha256 ? "nov05" : "nov06"}-primary`,
                picked.primary,
                pickedQual,
                picked.others,
            ),
            trace("nov05", a.log, a.qual, []),
            trace("nov06", b.log, b.qual, []),
            trace("nov05+nov06", a.log, a.qual, [b.log]),
            trace("nov06+nov05", b.log, b.qual, [a.log]),
        ];
        // Optional: the third file of 6 November (two sessions), imported as well.
        const extra = process.env.GYROFLIGHT_AIR65_NOV06B;
        if (extra && existsSync(extra)) {
            const bytes = new Uint8Array(readFileSync(extra));
            const sha = createHash("sha256").update(bytes).digest("hex");
            expect(sha).toBe("2d0f567f07ae04a19c4d3b15c10e306408575079b57a704b46e3d594ae97be29");
            const q = qualifyChirpFile(bytes, "nov06b.bbl", 45, AUTOTUNE_MATH);
            const more = buildLogInputs(bytes, sha, q, analyzeM4BblFile(bytes, "nov06b.bbl"));
            const all = pickPrimary([
                { ...a.log, order: 1 },
                { ...b.log, order: 2 },
                ...more.map((l) => ({ ...l, order: 3 })),
            ])!;
            const qualOf = (l: AutotuneLogInput) =>
                l.sha256 === a.log.sha256 ? a.qual : l.sha256 === b.log.sha256 ? b.qual : q;
            runs.push(trace("app:all-three-files", all.primary, qualOf(all.primary), all.others));
            for (const l of more) runs.push(trace(`nov06b-log${l.logIndex}`, l, q, []));
        }
        const out = process.env.GYROFLIGHT_TRACE_OUT;
        if (out) {
            mkdirSync(out, { recursive: true });
            for (const t of runs)
                writeFileSync(path.join(out, `air65_trace_${t.run}.json`), JSON.stringify(t, null, 1));
        }
        expect(runs.length).toBeGreaterThanOrEqual(5);
    }, 900_000);
});
