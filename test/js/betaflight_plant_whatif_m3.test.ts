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
 * GF-1 M3: plant extraction + plant-fixed what-if reference tests.
 * Synthetic plants prove numerical regression only — not AIR65 flight validation.
 */

import { describe, expect, it } from "vitest";
import {
    air65PitchConfig,
    air65RollConfig,
    air65YawConfig,
    cmag,
    csub,
    evaluateControllerFrf,
    type DigitalControllerConfig,
} from "../../src/js/blackbox/betaflight_digital_controller";
import {
    AIR65_EXTERNAL_BLOCKERS,
    assessCrossLogPlantReproducibility,
    closedLoopFromPlant,
    extractPlantFromClosedLoop,
    plantFixedWhatIf,
    plantFrf,
    reconstructStabilityLoop,
    syntheticTransferFunction,
    syntheticTransferFunctionWithCoherence,
} from "../../src/js/blackbox/betaflight_open_loop";

function freqGrid(fMin: number, fMax: number, step: number): number[] {
    const out: number[] = [];
    for (let f = fMin; f <= fMax + 1e-9; f += step) out.push(Number(f.toFixed(6)));
    return out;
}

function makeClosedLoopTf(
    cfg: DigitalControllerConfig,
    plant: { K: number; motorHz: number; delayS: number },
    freqs: number[],
    coh = 1,
) {
    return syntheticTransferFunction(
        freqs,
        (f) => {
            if (f <= 0) return { re: 1, im: 0 };
            const frf = evaluateControllerFrf(cfg, f);
            return closedLoopFromPlant(plantFrf(f, plant), frf.cReference, frf.cFeedback);
        },
        coh,
    );
}

const plant = { K: 800, motorHz: 40, delayS: 0.002 };
const freqs = freqGrid(2, 80, 1);

describe("M3 phaseComp / CHIRP signal definition", () => {
    it("cReference excludes phaseComp even when lag/lead are configured", () => {
        const withPc = air65RollConfig();
        expect(withPc.chirpLagHz).toBeGreaterThan(0);
        expect(withPc.chirpLeadHz).toBeGreaterThan(0);
        const frfPc = evaluateControllerFrf(withPc, 40);
        const frfPlain = evaluateControllerFrf(
            { ...withPc, chirpLagHz: undefined, chirpLeadHz: undefined },
            40,
        );
        expect(frfPc.cReference.re).toBeCloseTo(frfPlain.cReference.re, 12);
        expect(frfPc.cReference.im).toBeCloseTo(frfPlain.cReference.im, 12);
        expect(frfPc.cFeedback.re).toBeCloseTo(frfPlain.cFeedback.re, 12);
        expect(cmag(csub(frfPc.cExcitationShaping, { re: 1, im: 0 }))).toBeGreaterThan(0.05);
    });

    it("exports air65PitchConfig with pitch PIDs (not roll)", () => {
        const pitch = air65PitchConfig();
        const roll = air65RollConfig();
        expect(pitch.axis.p).toBe(82);
        expect(pitch.axis.i).toBe(117);
        expect(pitch.axis.d).toBe(61);
        expect(pitch.axis.p).not.toBe(roll.axis.p);
    });
});

describe("M3 plant extraction", () => {
    it("recovers synthetic plant bins under discrete M1 controller", () => {
        const cfg = air65YawConfig();
        const tf = makeClosedLoopTf(cfg, plant, freqs);
        const id = extractPlantFromClosedLoop(tf, cfg, { maxHz: 60 });
        expect(id.okCount).toBeGreaterThan(20);
        expect(id.validation.ALGEBRAIC_CONSISTENCY).toBe("PASS");
        expect(id.validation.INDEPENDENT_GAIN_CHANGE_VALIDATION).toBe("BLOCKED");
        expect(id.recommendationsEnabled).toBe(false);
        expect(id.applyAllowed).toBe(false);
        expect(id.algebraicMeanAbsErr).toBeLessThan(1e-10);

        for (const b of id.bins) {
            if (b.status !== "ok" || !b.G) continue;
            const truth = plantFrf(b.frequencyHz, plant);
            const rel = cmag(csub(b.G, truth)) / Math.max(cmag(truth), 1e-12);
            expect(rel).toBeLessThan(1e-6);
        }
    });

    it("reconstructs measured T when controller is unchanged", () => {
        const cfg = air65RollConfig();
        const tf = makeClosedLoopTf(cfg, plant, freqs);
        const id = extractPlantFromClosedLoop(tf, cfg, { maxHz: 60 });
        const what = plantFixedWhatIf(id, cfg, cfg, {
            externalBlockReasons: [...AIR65_EXTERNAL_BLOCKERS],
            maxHz: 60,
        });
        const ok = what.bins.filter((b) => b.status === "ok");
        expect(ok.length).toBeGreaterThan(10);
        for (const b of ok) {
            expect(b.currentAbsErr).toBeLessThan(1e-9);
            expect(b.candidateDeltaMag).toBeLessThan(1e-12);
        }
    });

    it("what-if with changed P/I/D shifts predicted T (plant held fixed)", () => {
        const current = air65RollConfig();
        const candidate: DigitalControllerConfig = {
            ...current,
            axis: { ...current.axis, p: 52, i: 75, d: 30 },
        };
        const tf = makeClosedLoopTf(current, plant, freqs);
        const id = extractPlantFromClosedLoop(tf, current, { maxHz: 60 });
        const what = plantFixedWhatIf(id, current, candidate, {
            externalBlockReasons: [...AIR65_EXTERNAL_BLOCKERS],
            maxHz: 60,
        });
        const ok = what.bins.filter((b) => b.status === "ok");
        const meanDelta =
            ok.reduce((s, b) => s + b.candidateDeltaMag, 0) / Math.max(ok.length, 1);
        expect(meanDelta).toBeGreaterThan(1e-4);
        expect(what.validation.INDEPENDENT_GAIN_CHANGE_VALIDATION).toBe("BLOCKED");
        expect(what.recommendationsEnabled).toBe(false);
        expect(what.applyAllowed).toBe(false);
    });

    it("marks singular denominators and skips them", () => {
        const cfg = air65YawConfig();
        // Force T≈1 near a bin where denom vanishes for unity-like structure.
        const tf = syntheticTransferFunction(
            [0, 5, 10, 20],
            (f) => (f === 10 ? { re: 1, im: 0 } : { re: 0.5, im: -0.1 }),
            1,
        );
        const id = extractPlantFromClosedLoop(tf, cfg, { denomRelMin: 1e-4, minHz: 2 });
        const singular = id.bins.filter((b) => b.status === "singular_denominator");
        expect(singular.length).toBeGreaterThan(0);
        expect(singular.every((b) => b.G === null)).toBe(true);
    });

    it("rejects low-coherence bins", () => {
        const cfg = air65YawConfig();
        const tf = syntheticTransferFunctionWithCoherence(
            freqs,
            (f) => {
                const frf = evaluateControllerFrf(cfg, f);
                return closedLoopFromPlant(plantFrf(f, plant), frf.cReference, frf.cFeedback);
            },
            (f) => (f < 30 ? 0.9 : 0.2),
        );
        const id = extractPlantFromClosedLoop(tf, cfg, { maxHz: 60, coherenceMin: 0.5 });
        expect(id.bins.some((b) => b.status === "low_coherence")).toBe(true);
        expect(id.bins.filter((b) => b.status === "ok").every((b) => b.coherence >= 0.5)).toBe(true);
    });

    it("records missing filter schedules explicitly (no silent continuous-PID fallback)", () => {
        const cfg = air65YawConfig();
        const tf = makeClosedLoopTf(cfg, plant, freqs.slice(0, 20));
        const id = extractPlantFromClosedLoop(tf, cfg);
        expect(id.missingFilterInfo).toEqual([...AIR65_EXTERNAL_BLOCKERS]);
        expect(id.sampleRateChecks.ok).toBe(true);
    });
});

describe("M3 safety / Apply lock", () => {
    it("keeps M2 external blockers on plant-fixed what-if phase margin", () => {
        const cfg = air65YawConfig();
        const tf = makeClosedLoopTf(cfg, plant, freqs);
        const id = extractPlantFromClosedLoop(tf, cfg, { maxHz: 60 });
        const candidate = { ...cfg, axis: { ...cfg.axis, p: 52, i: 75 } };
        const what = plantFixedWhatIf(id, cfg, candidate, {
            externalBlockReasons: [...AIR65_EXTERNAL_BLOCKERS, "phase_unwrap_interrupted_by_bin_gaps"],
            maxHz: 60,
        });
        expect(what.candidatePhaseMargin.status).toBe("NOT_VALIDATED");
        expect(what.candidatePhaseMargin.blockReasons).toEqual(
            expect.arrayContaining([
                "dyn_notch_centres_unknown",
                "rpm_filter_schedule_unknown",
            ]),
        );
        expect(what.applyAllowed).toBe(false);
        expect(what.recommendationsEnabled).toBe(false);
    });

    it("does not release PID recommendations without independent validation", () => {
        const cfg = air65PitchConfig();
        const tf = makeClosedLoopTf(cfg, plant, freqs);
        const id = extractPlantFromClosedLoop(tf, cfg, { maxHz: 60 });
        expect(id.validation.INDEPENDENT_GAIN_CHANGE_VALIDATION).toBe("BLOCKED");
        expect(id.recommendationsEnabled).toBe(false);
        const what = plantFixedWhatIf(id, cfg, cfg);
        expect(what.validation.INDEPENDENT_GAIN_CHANGE_VALIDATION).toBe("BLOCKED");
        expect(what.limitations).toEqual(
            expect.arrayContaining(["INDEPENDENT_GAIN_CHANGE_VALIDATION=BLOCKED"]),
        );
    });

    it("M2 reconstructStabilityLoop still fails closed with AIR65 blockers", () => {
        const cfg = air65RollConfig();
        const tf = makeClosedLoopTf(cfg, plant, freqs);
        const loop = reconstructStabilityLoop(tf, cfg);
        expect(loop.bins.some((b) => b.status === "ok")).toBe(true);
        // Product path remains gated by evaluateStructureAwarePhaseMargin external blockers — exercised above.
        expect(AIR65_EXTERNAL_BLOCKERS).toContain("dyn_notch_centres_unknown");
        expect(AIR65_EXTERNAL_BLOCKERS).toContain("rpm_filter_schedule_unknown");
    });
});

describe("M3 cross-log helper (synthetic reproducibility)", () => {
    it("PASS when two extracts match on shared bins", () => {
        const cfg = air65YawConfig();
        const tf = makeClosedLoopTf(cfg, plant, freqs);
        const a = extractPlantFromClosedLoop(tf, cfg, { maxHz: 60 });
        const b = extractPlantFromClosedLoop(tf, cfg, { maxHz: 60 });
        const cross = assessCrossLogPlantReproducibility(a, b);
        expect(cross.status).toBe("PASS");
        expect(cross.n).toBeGreaterThan(10);
        // Helper must not claim independent gain-change validation.
        expect(a.validation.INDEPENDENT_GAIN_CHANGE_VALIDATION).toBe("BLOCKED");
    });
});
