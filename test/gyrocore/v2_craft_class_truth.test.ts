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
 * Two craft classes against their own analytic truth (SIMULATION, not flight evidence).
 *
 * wp7_end_to_end compares a 7-inch-like loop with an AIR65-like one only relatively. Here each
 * simulated flight (Blackbox bytes → Viewer decode → CHIRP qualification → engine) is compared with
 * the loop it was made from, L = G · C_fb from the logged controller: for both classes the measured
 * crossover must lie within the resolution the evidence reports and the measurement plan must follow
 * from that crossover; for the AIR65-like class, which the analysis resolves, the crossover must also
 * be within 5 % and the phase margin within 3° of the truth (the 7-inch-like phase margin is not
 * compared: its loop is not resolved, below),
 * and a sweep that never reaches the crossover must stop with a named reason. One synthetic class is
 * not evidence for the other; each is checked against its own truth.
 *
 * The harness logs at 1 kHz, so the standard analysis has 512-sample segments (1.95 Hz bins) on
 * every craft. The 7-inch-like crossover (≈ 7 Hz) is then resolved too coarsely: the engine says
 * so (MEASURED, gaps in the band, a finer analysis named) rather than claiming the AIR65-like
 * accuracy. The analysis segment does not adapt to the craft; only the plan does.
 */

import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { buildLogInputs } from "../../src/gyrocore/engine/logInput";
import {
    controllerConfigFromHeaders,
    runAutotuneV2,
    type AutotuneLogInput,
    type AutotuneV2Result,
} from "../../src/gyrocore/engine/autotuneV2";
import { cmul, evaluateControllerFrf } from "../../src/js/blackbox/betaflight_digital_controller";
import { closedLoopChirpLog, ratePlant, type ClosedLoopLogOptions, type Plant } from "./harness/closedLoopBbl";
import { BETAFLIGHT_TUNE_HEADERS, SIM_IDENTITY_HEADERS } from "./harness/chirpSim";

// SIMULATION: rate-plant parameters per craft class are assumptions, not calibrated craft.
// AIR65-like crosses ≈ 26 Hz, 5-inch-like ≈ 13 Hz (continuation B5), 7-inch-like ≈ 6.8 Hz.
const CLASSES = {
    air65: { K: 60, motorHz: 40, delayS: 0.002 },
    fiveInch: { K: 45, motorHz: 25, delayS: 0.003 },
    sevenInch: { K: 30, motorHz: 15, delayS: 0.004 },
} as const;

/** The header map closedLoopChirpLog builds its controller from (1 kHz: looptime 125 × denom 8). */
const HEADERS = Object.fromEntries([
    ...[...SIM_IDENTITY_HEADERS, ...BETAFLIGHT_TUNE_HEADERS].map((l) => [
        l.slice(0, l.indexOf(":")),
        l.slice(l.indexOf(":") + 1),
    ]),
    ["looptime", "125"],
    ["pid_process_denom", "8"],
]);

/** Crossover and phase margin of the true loop G · C_fb (roll controller), on a 0.01 Hz grid. */
function truth(G: Plant) {
    const cfg = controllerConfigFromHeaders(HEADERS, 0)!;
    const L = (f: number) => cmul(G(f), evaluateControllerFrf(cfg, f).cFeedback);
    let prevPhase = Math.atan2(L(0.5).im, L(0.5).re);
    let unwrapped = prevPhase;
    for (let f = 0.51; f < 400; f += 0.01) {
        const l = L(f);
        const p = Math.atan2(l.im, l.re);
        let d = p - prevPhase;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        unwrapped += d;
        prevPhase = p;
        if (Math.hypot(l.re, l.im) <= 1) return { crossoverHz: f, pmDeg: 180 + (unwrapped * 180) / Math.PI };
    }
    throw new Error("no crossover below 400 Hz");
}

function decoded(o: ClosedLoopLogOptions, name: string): AutotuneLogInput {
    const bytes = closedLoopChirpLog(o);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const [log] = buildLogInputs(bytes, sha, qualifyChirpFile(bytes, name, 45, AUTOTUNE_MATH), null);
    expect(log, name).toBeDefined();
    return log;
}
const engine = (primary: AutotuneLogInput) =>
    runAutotuneV2({ primary, others: [], verifiedTune: null, createdAt: "2026-10-25T00:00:00Z" });

describe.each(Object.entries(CLASSES))("%s-like loop against its analytic truth", (name, params) => {
    const G = ratePlant(params);
    const t = truth(G);
    let r: AutotuneV2Result;
    beforeAll(() => {
        r = engine(decoded({ plants: [G, null, null], noise: 0.3, seed: 21 }, `${name}.bbl`));
    }, 600_000);

    it("the measured crossover lies within the resolution the evidence reports", () => {
        const m = r.margins.roll!.current;
        expect(m.evidence.resolutionHz).not.toBeNull();
        expect(Math.abs(m.crossoverHz! - t.crossoverHz)).toBeLessThanOrEqual(m.evidence.resolutionHz!);
    });

    it("the plan follows from that crossover: band from fc/4, the duration its averages need", () => {
        const p = r.measurementPlan.find((x) => x.axis === "roll")!;
        const fc = p.crossoverHz!;
        expect(p.bandHz.primary![0]).toBeGreaterThanOrEqual(fc / 4 - 1e-9);
        expect(p.bandHz.primary![0]).toBeLessThan(fc);
        expect(p.bandHz.primary![1]).toBeGreaterThan(fc);
        const Ts = p.segmentSamples.primary! / 1000;
        expect(p.sweep!.durationS).toBeCloseTo(
            Math.max(p.averages.needed! * Ts * Ts * fc * Math.log(p.sweep!.f1Hz / p.sweep!.f0Hz), (Ts * 9) / 2),
            6,
        );
    });

    it("no validation is claimed from this one flight", () => {
        expect(r.margins.roll!.current.status).not.toBe("VALIDATED");
        expect(r.margins.roll!.current.evidence.level).not.toBe("VALIDATED");
        expect(r.releasableProposal).toBeNull();
    });

    if (name === "air65") {
        it("AIR65-like: resolved; crossover within 5 % and phase margin within 3° of the truth", () => {
            const m = r.margins.roll!.current;
            expect(Math.abs(m.crossoverHz! - t.crossoverHz) / t.crossoverHz).toBeLessThan(0.05);
            expect(Math.abs(m.measured.phaseMarginDeg! - t.pmDeg)).toBeLessThan(3);
            expect(m.reasons).not.toContain("identified_band_has_gaps");
        });
    } else if (name === "fiveInch") {
        it("5-inch-like: read on a finer rung than the standard 512 samples; crossover within 3 % and phase margin within 2° of the truth (B5)", () => {
            const m = r.margins.roll!.current;
            const conv = m.evidence.convergence!;
            expect(conv.usedSegmentSamples).toBeGreaterThanOrEqual(1024);
            expect(conv.usedBinSpacingHz).toBeLessThanOrEqual(0.1 * m.crossoverHz! * 1.001);
            expect(Math.abs(m.crossoverHz! - t.crossoverHz) / t.crossoverHz).toBeLessThan(0.03);
            expect(Math.abs(m.measured.phaseMarginDeg! - t.pmDeg)).toBeLessThan(2);
            expect(m.evidence.level).not.toBe("VALIDATED");
            const p = r.measurementPlan.find((x) => x.axis === "roll")!;
            expect(p.segmentSamples.primary).toBe(conv.usedSegmentSamples);
        });
    } else {
        it("7-inch-like: read on a finer rung than the standard 512 samples; crossover within 3 % and phase margin within 2° of the truth (B4)", () => {
            // Audit B4: an absolute tolerance on fc and a PM comparison, not "within the reported
            // resolution" (which held with a 9 % error). The standard analysis read this loop 9 % high.
            const m = r.margins.roll!.current;
            const conv = m.evidence.convergence!;
            expect(conv.usedSegmentSamples).toBeGreaterThanOrEqual(2048);
            expect(conv.usedBinSpacingHz).toBeLessThanOrEqual(0.1 * m.crossoverHz! * 1.001);
            expect(Math.abs(m.crossoverHz! - t.crossoverHz) / t.crossoverHz).toBeLessThan(0.03);
            expect(Math.abs(m.measured.phaseMarginDeg! - t.pmDeg)).toBeLessThan(2);
            // One flight never validates; whatever the rung, the status says why.
            expect(m.evidence.level).not.toBe("VALIDATED");
            const p = r.measurementPlan.find((x) => x.axis === "roll")!;
            expect(p.segmentSamples.primary).toBe(conv.usedSegmentSamples);
            // Its phase falls late: the planned band reaches 1.5 × the phase crossover (B5), where the
            // gain margin is read, instead of stopping at the −12 dB point.
            const ext = p.diagnostics.find((x) => x.startsWith("band_extended_past_phase_crossover:"));
            expect(ext).toBeDefined();
            const fpc = Number(ext!.split(":")[1].replace("Hz", ""));
            // The diagnostic gives fpc to 0.1 Hz.
            expect(Math.abs(p.bandHz.primary![1] - 1.5 * fpc)).toBeLessThanOrEqual(1.5 * 0.05 + 1e-9);
        });
    }
});

describe("the classes need different measurements, each from its own loop", () => {
    it("the 7-inch-like loop crosses lower and needs a longer sweep than the AIR65-like one", () => {
        const air = truth(ratePlant(CLASSES.air65));
        const seven = truth(ratePlant(CLASSES.sevenInch));
        expect(seven.crossoverHz).toBeLessThan(air.crossoverHz);
        const plan = (G: Plant, seed: number) =>
            engine(decoded({ plants: [G, null, null], noise: 0.3, seed }, `p${seed}.bbl`)).measurementPlan.find(
                (x) => x.axis === "roll",
            )!;
        const pa = plan(ratePlant(CLASSES.air65), 22);
        const ps = plan(ratePlant(CLASSES.sevenInch), 23);
        expect(ps.sweep!.durationS).toBeGreaterThan(pa.sweep!.durationS);
        expect(ps.bandHz.primary![1]).toBeLessThan(pa.bandHz.primary![1]);
    }, 600_000);
});

describe("a sweep that never reaches the crossover stops with a named reason", () => {
    it("7-inch-like loop swept only to below its crossover: no margins, and the plan asks to cover it", () => {
        const t = truth(ratePlant(CLASSES.sevenInch));
        const r = engine(
            decoded(
                { plants: [ratePlant(CLASSES.sevenInch), null, null], noise: 0.3, seed: 24, endHz: t.crossoverHz / 3 },
                "short.bbl",
            ),
        );
        const m = r.margins.roll?.current;
        expect(m?.status ?? "NONE").not.toBe("VALIDATED");
        expect(m?.measured.phaseMarginDeg ?? null).toBeNull();
        const needs = [
            ...r.parts.flatMap((p) => p.requiredMeasurements),
            ...r.measurementPlan.flatMap((p) => p.requiredMeasurements),
        ];
        expect(
            needs.some((n) => /chirp_covering_the_crossover|chirp_.*meeting_qualification|chirp_flight/.test(n)),
        ).toBe(true);
        expect(r.releasableProposal).toBeNull();
    }, 600_000);
});
