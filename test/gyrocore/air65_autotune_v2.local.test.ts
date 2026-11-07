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
 * Autotune engine v2 on the AIR65 CHIRP logs (local only; needs GYROFLIGHT_AIR65_BBL18/19).
 * The whole Analyze → Calculate path on real data, with each log as the other's cross-log
 * reference. Asserted are the facts the data supports; the full result goes to
 * GYROFLIGHT_QUAL_OUT for the report.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { analyzeM4BblFile } from "../../src/js/blackbox/m4_bbl_integration";
import { buildLogInputs } from "../../src/gyrocore/engine/logInput";
import { runAutotuneV2, type AutotuneLogInput } from "../../src/gyrocore/engine/autotuneV2";
import { evaluateRelease } from "../../src/gyrocore/releaseGate/releaseContract";
import { writeReport } from "./harness/fixtures";

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

function load(key: keyof typeof FILES): AutotuneLogInput[] {
    const f = FILES[key];
    const bytes = new Uint8Array(readFileSync(f.path!));
    const sha = createHash("sha256").update(bytes).digest("hex");
    expect(sha).toBe(f.sha256);
    const report = qualifyChirpFile(bytes, key, 45, AUTOTUNE_MATH);
    const m4 = analyzeM4BblFile(bytes, key);
    return buildLogInputs(bytes, sha, report, m4);
}

function summary(r: ReturnType<typeof runAutotuneV2>) {
    return {
        chain: r.chain.validation.map((v) => ({
            axis: v.axis,
            controlBand: v.controlBand,
            noiseBand: v.noiseBand,
            nrmse: v.fit?.nrmse,
            ablationNrmse: v.ablationNrmse,
            bands: v.fit?.bands,
            reasons: v.reasons,
        })),
        dterm: r.dterm,
        margins: r.margins,
        pid: r.pid,
        filters: r.filters,
        feedforward: r.feedforward,
        crossLogPlant: r.crossLogPlant,
        safety: r.safety,
        parts: r.parts,
        proposal: r.proposal && {
            change: r.proposal.change,
            items: r.proposal.items,
            release: { ...r.proposal.release, independentValidation: null },
        },
        release: r.proposal ? evaluateRelease(r.proposal) : null,
    };
}

describe.skipIf(!present)("AIR65: autotune engine v2 end to end (local only)", () => {
    it("analyses both CHIRP flights, validates the gyro chain, and keeps every unproven part blocked", () => {
        const a = load("bbl18");
        const b = load("bbl19");
        expect(a.length).toBeGreaterThan(0);
        expect(b.length).toBeGreaterThan(0);
        const out: Record<string, unknown> = {};
        for (const [name, primary, others] of [
            ["bbl18", a[0], b],
            ["bbl19", b[0], a],
        ] as const) {
            const r = runAutotuneV2({ primary, others, verifiedTune: null, createdAt: "2026-10-22T00:00:00Z" });
            out[name] = summary(r);
            // The notch-aware chain reproduces the firmware's own gyroADC on roll and pitch.
            expect(r.chain.validation[0].controlBand).toBe("PASS");
            expect(r.chain.validation[1].controlBand).toBe("PASS");
            // ANGLE-mode CHIRP flights carry no PID feedforward: FF stays blocked with the measurement named.
            expect(r.feedforward.every((f) => f.status === "BLOCKED")).toBe(true);
            expect(r.parts.find((p) => p.part === "feedforward")!.requiredMeasurements).toContain(
                "required_measurement:acro_stick_flight",
            );
            // No Verified Tune: independent prediction and the release stay blocked.
            expect(r.parts.find((p) => p.part === "independent_gain_prediction")!.status).toBe("BLOCKED");
            if (r.proposal) expect(evaluateRelease(r.proposal).released).toBe(false);
            // No finer, independent qualification log: no margin is VALIDATED evidence, and each
            // carries its resolution and band (Codex final acceptance F-02).
            for (const m of Object.values(r.margins).flatMap((x) => [x!.current, x!.proposed])) {
                expect(m.evidence.level).not.toBe("VALIDATED");
                expect(m.status).not.toBe("VALIDATED");
                expect(m.evidence.qualification).toBeNull();
                if (m.phaseMarginDeg !== null) expect(m.evidence.resolutionHz).toBeGreaterThan(0);
            }
        }
        writeReport("air65_autotune_v2", out);
    }, 1_800_000);

    it("frequency support and adaptive resolution on the real sweeps (T3 audit, 2026-10-27)", () => {
        const a = load("bbl18")[0];
        const b = load("bbl19")[0];
        const r18 = runAutotuneV2({ primary: a, others: [], verifiedTune: null, createdAt: "2026-10-27T00:00:00Z" });
        const r19 = runAutotuneV2({ primary: b, others: [], verifiedTune: null, createdAt: "2026-10-27T00:00:00Z" });
        for (const [r, log] of [
            [r18, a],
            [r19, b],
        ] as const) {
            for (const axis of ["roll", "pitch", "yaw"] as const) {
                const c = log.chirp[axis]!;
                // DEBUG_CHIRP is logged: the support of every rung is known, the observed generator range too.
                expect(c.support?.observedHz).not.toBeNull();
                expect(c.analyses!.length).toBeGreaterThanOrEqual(3);
                expect(c.analyses![0].analysis.segmentSamples).toBe(2048);
                const m = r.margins[axis]!.current;
                // The crossovers are supported: no unsupported or unknown bin inside the decision band
                // (the T3 audit's finding on these logs), and every rung used converges against the next.
                expect(m.reasons.some((x) => x.startsWith("crossover_band_unsupported"))).toBe(false);
                expect(m.reasons.some((x) => x.startsWith("frequency_support_unknown"))).toBe(false);
                expect(m.evidence.convergence?.status).toBe("CONVERGED");
                expect(m.evidence.convergence!.usedSegmentSamples).toBeGreaterThanOrEqual(2048);
                // One flight, no Verified Tune, margins read on bins only: nothing is proposed.
                expect(m.evidence.level).toBe("MEASURED");
                expect(r.pid.find((p) => p.axis === axis)!.status).toBe("BLOCKED");
            }
            expect(r.releasableProposal).toBeNull();
        }
        // 19 October roll: the one-bin coherence hole near 43 Hz inside the decision band is a gap now.
        expect(r19.margins.roll!.current.reasons.some((x) => x.startsWith("unidentified_bins_inside_band:"))).toBe(
            true,
        );
        // 19 October pitch / yaw: the generator stopped at 206 / 268 Hz of a 600 Hz header. Above
        // 1.5 × the band end it does not touch the margins, and it is said with the evidence.
        for (const axis of ["pitch", "yaw"] as const) {
            const c = b.chirp[axis]!;
            expect(c.support!.observedHz![1]).toBeLessThan(300);
            expect(
                r19.margins[axis]!.current.evidence.assumptions.some((x) =>
                    x.startsWith("sweep_generator_stopped_at:"),
                ),
            ).toBe(true);
        }
        // 18 October: the generator reached the header's end on every axis.
        for (const axis of ["roll", "pitch", "yaw"] as const) {
            expect(a.chirp[axis]!.support!.observedHz![1]).toBeGreaterThan(590);
        }
    }, 1_800_000);
});
