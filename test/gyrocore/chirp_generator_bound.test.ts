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
 * DEBUG_CHIRP generator bounding: exclude post-completion zeros from the
 * measurement window without treating the drop to 0 Hz as a second sweep.
 */

import { describe, expect, it, vi } from "vitest";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { activeGeneratorRange } from "../../src/gyrocore/chirp/extraction";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { MIN_MEAN_BAND_COHERENCE, MIN_USABLE_BINS, USABLE_COHERENCE_MIN } from "../../src/gyrocore/chirp/quality";
import { QV2_REASONS } from "../../src/gyrocore/chirp/qualityV2/contract";
import { qualityRows } from "../../src/gyrocore/chirp/qualityV2/view";
import { PRODUCT_APPLY_PENDING, productApplyBlocks } from "../../src/gyrocore/productLock/productApply";
import { encodeChirpLog, FULL_TUNE_HEADERS, simulateChirp, type SimOptions } from "./harness/chirpSim";
import type { SyntheticFrame } from "./harness/bblWriter";

vi.mock("../../src/js/localization", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/js/localization")>()),
    i18n: { getMessage: (key: string, args?: (string | number)[]) => `${key}:${(args ?? []).join(",")}` },
}));

const qualify = (bytes: Uint8Array) => qualifyChirpFile(bytes, "bound.bbl", 60, AUTOTUNE_MATH);

/** Append idle frames that mimic firmware after chirpUpdate finishes (f=0, exc=0, axis still set). */
function withPostCompletionTail(frames: SyntheticFrame[], tailSamples: number, axis = 0): SyntheticFrame[] {
    const last = frames.at(-1)!;
    const dt = frames.length > 1 ? frames[1].time - frames[0].time : 1000;
    const tail: SyntheticFrame[] = [];
    for (let i = 1; i <= tailSamples; i++) {
        tail.push({
            time: last.time + i * dt,
            setpoint: [0, 0, 0],
            gyro: [0, 0, 0],
            debug: [0, axis, 0, 0],
        });
    }
    return [...frames, ...tail];
}

function sweep(opts: SimOptions = {}) {
    return simulateChirp({ seconds: 2, rateHz: 1000, firmwareDebug: true, ...opts });
}

describe("activeGeneratorRange", () => {
    it("trims trailing zero frequency/excitation after a completed sweep", () => {
        const freq = [2, 10, 100, 6000, 0, 0, 0];
        const exc = [100, -50, 80, -20, 0, 0, 0];
        expect(activeGeneratorRange(freq, exc, 0, 6)).toEqual({ startIdx: 0, endIdx: 3 });
    });

    it("keeps intermediate settle zeros when a real restart follows", () => {
        const freq = [2, 100, 6000, 0, 0, 2, 100, 6000, 0, 0];
        const exc = [10, 20, 30, 0, 0, 10, 20, 30, 0, 0];
        expect(activeGeneratorRange(freq, exc, 0, 9)).toEqual({ startIdx: 0, endIdx: 7 });
    });

    it("does not trim when DEBUG_CHIRP is constant zeros", () => {
        const z = new Float32Array(20);
        expect(activeGeneratorRange(z, z, 0, 19)).toBeNull();
    });

    it("does not trim a premature stop with no post-completion tail", () => {
        const freq = [2, 10, 50, 100];
        const exc = [1, -1, 2, -2];
        expect(activeGeneratorRange(freq, exc, 0, 3)).toBeNull();
    });
});

describe("completed sweep with post-completion zero excitation", () => {
    it("excludes the tail from duration/samples and reports one run ending at the real peak", () => {
        const active = sweep({ seconds: 3, endHz: 200 });
        const bytes = encodeChirpLog(withPostCompletionTail(active, 1500));
        const m = qualify(bytes).measurements[0];
        expect(m.sampleCount).toBe(active.length);
        expect(m.modeSampleCount).toBe(active.length + 1500);
        expect(m.boundSource).toBe("firmware_debug_chirp");
        expect(m.durationS).toBeCloseTo(2.999, 2);
        expect(m.modeDurationS).toBeGreaterThan(m.durationS + 1);
        const o = m.qualityV2.sweep.observed;
        expect(o.availability).toBe("MEASURED");
        expect(o.runs).toBe(1);
        expect(o.reasons).not.toContain(QV2_REASONS.observedRestarted);
        expect(o.minHz).toBeGreaterThan(0);
        expect(o.endHz).toBeGreaterThan(100);
        expect(o.maxHz).toBeCloseTo(o.endHz!, 5);
    });
});

describe("premature stop", () => {
    it("keeps the partial BOXCHIRP window and flags below-requested end", () => {
        const bytes = encodeChirpLog(sweep({ seconds: 2, endHz: 40 }));
        const m = qualify(bytes).measurements[0];
        expect(m.boundSource).toBe("mode_flag_only");
        expect(m.sampleCount).toBe(m.modeSampleCount);
        expect(m.qualityV2.sweep.observed.availability).toBe("MEASURED");
        expect(m.qualityV2.sweep.observed.runs).toBe(1);
        expect(m.qualityV2.sweep.observed.reasons).toContain(QV2_REASONS.observedBelowRequestedEnd);
        expect(m.qualityV2.sweep.observed.maxHz!).toBeLessThanOrEqual(40.05);
    });
});

describe("real restart inside one BOXCHIRP period", () => {
    it("keeps both runs and still drops only the final post-completion tail", () => {
        const a = sweep({ seconds: 2, endHz: 100 });
        const settle: SyntheticFrame[] = [];
        const dt = a[1].time - a[0].time;
        let t = a.at(-1)!.time;
        for (let i = 0; i < 200; i++) {
            t += dt;
            settle.push({ time: t, setpoint: [0, 0, 0], gyro: [0, 0, 0], debug: [0, 0, 0, 0] });
        }
        const b = sweep({ seconds: 2, endHz: 100, startTimeUs: settle.at(-1)!.time + dt });
        const bytes = encodeChirpLog(withPostCompletionTail([...a, ...settle, ...b], 800));
        const m = qualify(bytes).measurements[0];
        expect(m.boundSource).toBe("firmware_debug_chirp");
        expect(m.sampleCount).toBe(a.length + settle.length + b.length);
        expect(m.modeSampleCount).toBe(m.sampleCount + 800);
        expect(m.qualityV2.sweep.observed.runs).toBe(2);
        expect(m.qualityV2.sweep.observed.reasons).toContain(QV2_REASONS.observedRestarted);
        expect(m.qualityV2.sweep.observed.endHz).not.toBe(0);
    });
});

describe("missing or unreliable DEBUG_CHIRP", () => {
    it("falls back to the mode-flag window and does not invent a MEASURED full sweep", () => {
        // firmwareDebug false → constant zero frequency channel (WU7-style).
        const bytes = encodeChirpLog(withPostCompletionTail(sweep({ firmwareDebug: false, seconds: 2 }), 500));
        const m = qualify(bytes).measurements[0];
        expect(m.boundSource).toBe("mode_flag_only");
        expect(m.sampleCount).toBe(m.modeSampleCount);
        expect(m.qualityV2.sweep.observed.availability).toBe("UNKNOWN");
        expect(m.qualityV2.sweep.observed.runs).toBeNull();
        expect(m.qualityV2.sweep.observed.minHz).toBeNull();
    });
});

describe("thresholds and Safety/Apply lock unchanged", () => {
    it("keeps the existing coherence and usable-bin thresholds", () => {
        expect(USABLE_COHERENCE_MIN).toBe(0.5);
        expect(MIN_MEAN_BAND_COHERENCE).toBe(0.6);
        expect(MIN_USABLE_BINS).toBe(8);
        const m = qualify(encodeChirpLog(sweep({ seconds: 3, endHz: 200 }))).measurements[0];
        expect(m.qualityV2.coherence.criteria).toMatchObject({
            usableBinCoherenceMin: 0.5,
            meanBandCoherenceMin: 0.6,
            minUsableBins: 8,
            meanBandHz: [5, 100],
        });
        const t = (key: string, args?: (string | number)[]) => `${key}:${(args ?? []).join(",")}`;
        const rows = qualityRows(m.qualityV2, t);
        expect(rows.find((r) => r.id === "coherence")!.detail).toContain("0.60");
        expect(rows.find((r) => r.id === "usable-bins")!.detail).toContain("0.50");
        expect(rows.find((r) => r.id === "usable-bins")!.detail).toContain("8");
    });

    it("keeps product Apply blocked behind full_safety_engine_pending", () => {
        expect(productApplyBlocks()).toEqual([PRODUCT_APPLY_PENDING, "independent_pid_validation_missing"]);
        expect(PRODUCT_APPLY_PENDING).toBe("full_safety_engine_pending");
    });
});

describe("Quality V2 2.1.0 / 2.2.0 session compatibility surface", () => {
    it("still emits analysisVersion 2.2.0 with unchanged schema id", async () => {
        const { CHIRP_QUALITY_V2_ANALYSIS_VERSION, CHIRP_QUALITY_V2_SCHEMA } =
            await import("../../src/gyrocore/chirp/qualityV2/contract");
        expect(CHIRP_QUALITY_V2_ANALYSIS_VERSION).toBe("2.2.0");
        expect(CHIRP_QUALITY_V2_SCHEMA).toBe("gyrocore.chirp-quality.v2");
        const m = qualify(encodeChirpLog(sweep({ seconds: 2, endHz: 80 }))).measurements[0];
        expect(m.qualityV2.analysisVersion).toBe("2.2.0");
        expect(m.qualityV2.schema).toBe("gyrocore.chirp-quality.v2");
    });
});

// Silence unused FULL_TUNE_HEADERS import guard if tree-shaken — keep for header stability.
void FULL_TUNE_HEADERS;
