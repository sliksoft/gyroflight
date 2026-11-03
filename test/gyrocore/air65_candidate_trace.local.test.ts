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
 * LOCAL trace (not a regression): the real AIR65 logs through the product route, per axis and per
 * route (primary / JIO), every value the candidate decision rests on, written as JSON to
 * GYROFLIGHT_TRACE_OUT. Skipped without GYROFLIGHT_AIR65_BBL18/19 (private files, hashes checked).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { buildLogInputs } from "../../src/gyrocore/engine/logInput";
import { runAutotuneV2 } from "../../src/gyrocore/engine/autotuneV2";

const FILES = {
    bbl18: {
        path: process.env.GYROFLIGHT_AIR65_BBL18,
        sha256: "dfe82bca2aaabbc2f53a20a93756137546cc648196226af622d43874eed7efcb",
    },
    bbl19: {
        path: process.env.GYROFLIGHT_AIR65_BBL19,
        sha256: "4dd55164ddadb529816d52c3709376defe265cf2efdd6b8c31738bd3b26361c7",
    },
};
const present = Object.values(FILES).every((f) => !!f.path && existsSync(f.path));

describe.skipIf(!present)("AIR65 candidate trace (local)", () => {
    it.each(["bbl18", "bbl19"] as const)(
        "%s",
        (name) => {
            const f = FILES[name];
            const bytes = new Uint8Array(readFileSync(f.path!));
            const sha = createHash("sha256").update(bytes).digest("hex");
            expect(sha).toBe(f.sha256);
            const qual = qualifyChirpFile(bytes, `${name}.bbl`, 45, AUTOTUNE_MATH);
            const [log] = buildLogInputs(bytes, sha, qual, null);
            const r = runAutotuneV2({
                primary: log,
                others: [],
                verifiedTune: null,
                createdAt: "2026-11-03T00:00:00Z",
            });
            const trace = {
                file: name,
                sha256: sha,
                firmware: log.headerPairs.find(([k]) => k === "Firmware revision")?.[1] ?? null,
                sampleRateHz: log.sampleRateHz,
                measurements: qual.logs[0].measurements.map((m) => ({
                    id: m.id,
                    axis: m.axisName,
                    occurrence: m.axisOccurrence,
                    state: m.state,
                    durationS: (m.endTimeUs - m.startTimeUs) / 1e6,
                    sampleCount: m.sampleCount,
                    boundSource: m.boundSource,
                    blocked: m.apply.blocked,
                    quality: m.quality ?? null,
                    qualityV2: m.qualityV2 ?? null,
                    gates: (m as unknown as { gates?: unknown }).gates ?? null,
                })),
                chirpPerAxis: Object.fromEntries(
                    Object.entries(log.chirp).map(([a, c]) => [
                        a,
                        {
                            state: c!.state,
                            qualificationReasons: c!.qualificationReasons,
                            start: c!.start,
                            end: c!.end,
                        },
                    ]),
                ),
                primary: (["roll", "pitch", "yaw"] as const).map((axis) => {
                    const pid = r.pid.find((p) => p.axis === axis);
                    const m = r.margins[axis]?.current ?? null;
                    return {
                        axis,
                        pidCalled: pid ? !pid.reasons.includes("chirp_measurement_rejected") : false,
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
                            okBins: m.okBins,
                            evidence: m.evidence,
                            reasons: m.reasons,
                        },
                    };
                }),
                jio: {
                    status: r.jio.status,
                    blockers: r.jio.analysis.blockers,
                    axes: (["roll", "pitch", "yaw"] as const).map((axis) => {
                        const a = r.jio.analysis.axes[axis];
                        const c = r.jio.chain[axis];
                        return {
                            axis,
                            band: a?.band ?? null,
                            grid: a?.grid ?? null,
                            blockers: a?.blockers ?? null,
                            reasons: a?.reasons ?? null,
                            chainReasons: c?.reasons ?? null,
                            tuningComputable: c?.tuningComputable ?? null,
                            margins: c?.margins && {
                                status: c.margins.status,
                                crossoverHz: c.margins.crossoverHz,
                                phaseMarginDeg: c.margins.phaseMarginDeg,
                                gainMarginDb: c.margins.gainMarginDb,
                                sensitivityPeakDb: c.margins.sensitivityPeakDb,
                                measured: c.margins.measured,
                                evidence: c.margins.evidence,
                                reasons: c.margins.reasons,
                            },
                            candidate: c?.candidate && {
                                outcome: c.candidate.outcome,
                                status: c.candidate.status,
                                changed: c.candidate.changed,
                                current: c.candidate.current,
                                proposed: c.candidate.proposed,
                                reasons: c.candidate.reasons,
                            },
                            plan: c?.plan ?? null,
                        };
                    }),
                },
                candidateDecisions: r.candidateDecisions,
                recordingInstructions: r.recordingInstructions,
                experimental: r.experimental,
                experimentalWithheld: r.experimentalWithheld,
                requiredMeasurements: r.jio.requiredMeasurements,
            };
            const out = process.env.GYROFLIGHT_TRACE_OUT;
            if (out) {
                mkdirSync(out, { recursive: true });
                writeFileSync(path.join(out, `air65_trace_${name}.json`), JSON.stringify(trace, null, 1));
            }
        },
        300_000,
    );
});
