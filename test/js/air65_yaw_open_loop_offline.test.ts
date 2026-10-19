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
 * GF-1 M2 offline AIR65 yaw open-loop probe (local BBL only).
 *
 * Does not wire into recommendGains. Reports reconstructed fc/PM under the
 * structure-aware formula, then keeps status NOT_VALIDATED because dyn_notch /
 * rpm_filter centres are not recoverable from the log.
 */

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { air65YawConfig, air65RollConfig } from "../../src/js/blackbox/betaflight_digital_controller";
import {
    AIR65_EXTERNAL_BLOCKERS,
    evaluateStructureAwarePhaseMargin,
    findGainCrossover,
    reconstructStabilityLoop,
    unityFeedbackL,
} from "../../src/js/blackbox/betaflight_open_loop";
import { cmag, csub } from "../../src/js/blackbox/betaflight_digital_controller";

const DEFAULT_BBL =
    "<windows-home>/Downloads/drone/BTFL_BLACKBOX_LOG_AIR65_C_20261018_231421_BETAFPVG473.BBL";
const EXPECTED_SHA256 = "dfe82bca2aaabbc2f53a20a93756137546cc648196226af622d43874eed7efcb";

function loadAir65(): Uint8Array | null {
    const path = process.env.GYROFLIGHT_AIR65_OCT18_BBL || process.env.GYROFLIGHT_AIR65_BBL || DEFAULT_BBL;
    if (!existsSync(path)) return null;
    const bytes = new Uint8Array(readFileSync(path));
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== EXPECTED_SHA256 && !process.env.GYROFLIGHT_AIR65_BBL_ALLOW_ANY) {
        // Wrong file — skip rather than invent results.
        return null;
    }
    return bytes;
}

describe("GF-1 M2 AIR65 Oct-18 yaw offline open-loop", () => {
    const bytes = loadAir65();
    const maybe = bytes ? it : it.skip;

    maybe("yaw: unity-equivalent reconstruction; dyn blockers → NOT_VALIDATED", () => {
        const report = qualifyChirpFile(bytes!, "AIR65_Oct18.bbl", 60, AUTOTUNE_MATH);
        const yaw = report.measurements.filter((m) => m.axisName === "yaw");
        expect(yaw.length).toBeGreaterThan(0);

        // Prefer the longest usable yaw segment (CHIRP ~20 s).
        const usable = yaw
            .filter((m) => m.state !== "rejected" && m.diagnostics?.transferFunction)
            .sort((a, b) => b.durationS - a.durationS);
        expect(usable.length, "expected at least one usable yaw CHIRP").toBeGreaterThan(0);
        const m = usable[0];

        expect(m.durationS).toBeGreaterThan(19);
        expect(m.durationS).toBeLessThan(21);

        // Mean coherence 5–100 Hz from quality / TF
        const tf = m.diagnostics!.transferFunction;
        let sum = 0;
        let n = 0;
        for (let k = 0; k < tf.frequencies.length; k++) {
            const f = tf.frequencies[k];
            if (f >= 5 && f <= 100 && Number.isFinite(tf.coherence[k])) {
                sum += tf.coherence[k];
                n++;
            }
        }
        const meanCoh = sum / n;
        expect(meanCoh).toBeGreaterThan(0.7);
        // User-reported 0.830 — allow small analysis-band differences
        expect(Math.abs(meanCoh - 0.83)).toBeLessThan(0.08);

        const cfg = {
            ...air65YawConfig(),
            // T uses gyroADCf already; do not double-count gyro LPF in C.
            gyroLpf1Hz: undefined,
            gyroLpf2Hz: undefined,
            // Setpoint is post-phaseComp — omit H_phase from C_reference.
            chirpLagHz: undefined,
            chirpLeadHz: undefined,
        };

        const loop = reconstructStabilityLoop(tf, cfg);
        expect(loop.unityFeedbackEquivalent).toBe(true);

        // Spot-check: structure-aware L ≈ T/(1−T) when Ce cancels.
        let compared = 0;
        for (const bin of loop.bins) {
            if (bin.status !== "ok" || bin.frequencyHz < 10 || bin.frequencyHz > 80) continue;
            const k = tf.frequencies.findIndex((f) => Math.abs(f - bin.frequencyHz) < 1e-9);
            const T = { re: tf.hReal[k], im: tf.hImag[k] };
            const Lu = unityFeedbackL(T);
            if (!Lu || !bin.L) continue;
            expect(cmag(csub(bin.L, Lu)) / Math.max(cmag(Lu), 1e-9)).toBeLessThan(1e-4);
            compared++;
            if (compared >= 8) break;
        }
        expect(compared).toBeGreaterThan(0);

        const xo = findGainCrossover(loop);
        // Report numbers even when neighbourhood is imperfect — status still NOT_VALIDATED.
        const pm = evaluateStructureAwarePhaseMargin(tf, cfg, {
            externalBlockReasons: [...AIR65_EXTERNAL_BLOCKERS],
        });
        expect(pm.status).toBe("NOT_VALIDATED");
        expect(pm.blockReasons).toEqual(
            expect.arrayContaining(["dyn_notch_centres_unknown", "rpm_filter_schedule_unknown"]),
        );

        // Surface for humans / end-report (always printed).
        // eslint-disable-next-line no-console
        console.log(
            JSON.stringify({
                axis: "yaw",
                durationS: m.durationS,
                meanCoh5_100: meanCoh,
                crossoverStatus: xo.status,
                fcHz: xo.frequencyHz,
                pmDeg: xo.phaseMarginDeg,
                coherenceBracket: [xo.coherenceLow, xo.coherenceHigh],
                phaseMarginStatus: pm.status,
                blockReasons: pm.blockReasons,
                unityFeedbackEquivalent: loop.unityFeedbackEquivalent,
            }),
        );

        if (xo.status === "ok") {
            expect(xo.frequencyHz).toBeGreaterThan(5);
            expect(xo.frequencyHz).toBeLessThan(150);
            expect(xo.coherenceLow).toBeGreaterThanOrEqual(0.5);
            expect(xo.coherenceHigh).toBeGreaterThanOrEqual(0.5);
        }
    });

    maybe("roll: method runs but is not unity-equivalent; stays NOT_VALIDATED", () => {
        const report = qualifyChirpFile(bytes!, "AIR65_Oct18.bbl", 60, AUTOTUNE_MATH);
        const roll = report.measurements
            .filter((m) => m.axisName === "roll" && m.diagnostics?.transferFunction)
            .sort((a, b) => b.durationS - a.durationS)[0];
        if (!roll) return;

        const cfg = {
            ...air65RollConfig(),
            gyroLpf1Hz: undefined,
            gyroLpf2Hz: undefined,
            chirpLagHz: undefined,
            chirpLeadHz: undefined,
        };
        const pm = evaluateStructureAwarePhaseMargin(roll.diagnostics!.transferFunction, cfg, {
            externalBlockReasons: [
                ...AIR65_EXTERNAL_BLOCKERS,
                "d_max_state_dependent",
                "iterm_relax_nonlinear",
                "quality_gates_may_reject",
            ],
        });
        expect(pm.unityFeedbackEquivalent).toBe(false);
        expect(pm.status).toBe("NOT_VALIDATED");
        // eslint-disable-next-line no-console
        console.log(
            JSON.stringify({
                axis: "roll",
                state: roll.state,
                durationS: roll.durationS,
                crossoverStatus: pm.crossover?.status,
                fcHz: pm.crossover?.frequencyHz,
                pmDeg: pm.crossover?.phaseMarginDeg,
                phaseMarginStatus: pm.status,
                blockReasons: pm.blockReasons,
            }),
        );
    });
});
