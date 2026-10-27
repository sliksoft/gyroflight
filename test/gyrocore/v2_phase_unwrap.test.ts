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
 * PHASE_CHECKS.maxUnwrapStepDeg (loopModel): a loop phase that moves more than 90° between two
 * adjacent bins cannot be unwrapped unambiguously, so the margins read on it get no bounds. An
 * analytic SIMULATION: a lightly damped plant resonance between two 2 Hz bins turns the phase by
 * about 180° there. wp3_measurement_uncertainty covers the other phase checks.
 */

import { describe, expect, it } from "vitest";
import { declaredSupport } from "./harness/frequencySupport";
import {
    air65RollConfig,
    cdiv,
    evaluateControllerFrf,
    type Complex,
} from "../../src/js/blackbox/betaflight_digital_controller";
import { closedLoopFromPlant, plantFrf, syntheticTransferFunction } from "../../src/js/blackbox/betaflight_open_loop";
import { buildAxisLoop, loopMargins, PHASE_CHECKS } from "../../src/gyrocore/engine/loopModel";
import type { EffectiveChain } from "../../src/gyrocore/engine/gyroChain";

const UNITY_CHAIN: EffectiveChain = {
    samples: 1,
    frf: () => ({ re: 1, im: 0 }),
    spread: () => ({ phaseDeg: 0, gainDb: 0 }),
    medianLpf1Hz: 0,
    dynNotchHz: [],
};
const cfg = air65RollConfig();
const grid = (step: number) => Array.from({ length: 100 }, (_, i) => (i + 1) * step);

function margins(resonance: { hz: number; zeta: number } | null) {
    const g = (f: number): Complex => {
        const base = plantFrf(f, { K: 30, motorHz: 40, delayS: 0.002 });
        if (!resonance) return base;
        const x = f / resonance.hz;
        return cdiv(base, { re: 1 - x * x, im: 2 * resonance.zeta * x });
    };
    const T = (f: number) => {
        const c = evaluateControllerFrf(cfg, f);
        return closedLoopFromPlant(g(f), c.cReference, c.cFeedback);
    };
    const tf = syntheticTransferFunction(grid(2), T);
    return loopMargins(buildAxisLoop(0, tf, cfg, UNITY_CHAIN, true, true, null, { support: declaredSupport(tf) }));
}

describe("an unwrap step larger than PHASE_CHECKS.maxUnwrapStepDeg", () => {
    it("is 90°", () => {
        expect(PHASE_CHECKS.maxUnwrapStepDeg).toBe(90);
    });

    it("a resonance between two bins: the step is named and the margins get no bounds", () => {
        const m = margins({ hz: 91, zeta: 0.002 });
        expect(m.reasons).toContain("phase_unwrap_ambiguous:90.0-92.0Hz");
        expect(m.gainMarginDb).toBeNull();
        expect(m.evidence.level).toBe("MEASURED");
        expect(m.status).not.toBe("VALIDATED");
    });

    it("control: the same loop without the resonance has no ambiguous step", () => {
        const m = margins(null);
        expect(m.reasons.some((r) => r.startsWith("phase_unwrap_ambiguous"))).toBe(false);
    });
});
