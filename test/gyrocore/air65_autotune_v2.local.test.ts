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
        }
        writeReport("air65_autotune_v2", out);
    }, 1_800_000);
});
