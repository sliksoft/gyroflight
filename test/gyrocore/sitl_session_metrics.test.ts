/**
 * Block 14: the session's step-block and per-motor hover metrics (metrics.ts) on a synthetic 1 kHz log.
 */
import { describe, expect, it } from "vitest";
import { runMetrics, stepBlockLayout } from "../../src/gyrocore/sitlSession/metrics";
import { SESSION_PROTOCOL as P } from "../../src/gyrocore/sitlSession/protocol";
import type { AutotuneLogInput } from "../../src/gyrocore/engine/autotuneV2";

const FS = 1000;

function synthLog(o: { tauMs: number; motorAmp: number; blockNoiseAmp: number; withBlock?: boolean }) {
    const n = 30_000;
    const timeUs = Float64Array.from({ length: n }, (_, k) => k * 1000);
    const sp = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
    const dbgAxis = new Float64Array(n).fill(-1);
    const freq = new Float64Array(n);
    // CHIRP active 3–10 s on roll.
    for (let k = 3000; k < 10_000; k++) {
        dbgAxis[k] = 0;
        freq[k] = 20 + k / 100;
        sp[0][k] = 30 * Math.sin((2 * Math.PI * k) / 200);
    }
    const blockStart = 15_000;
    const perTick = FS / 100;
    const amp = P.measurement.stepAmplitudeDps;
    if (o.withBlock !== false)
        for (const d of stepBlockLayout()) {
            const ai = d.axis === "roll" ? 0 : 1;
            const k0 = blockStart + d.offsetTicks * perTick;
            const sign =
                stepBlockLayout()
                    .filter((x) => x.axis === d.axis)
                    .indexOf(d) === 0
                    ? 1
                    : -1;
            for (let k = 0; k < P.measurement.stepHalfTicks * perTick; k++) sp[ai][k0 + k] = sign * amp;
            for (let k = P.measurement.stepHalfTicks * perTick; k < 2 * P.measurement.stepHalfTicks * perTick; k++)
                sp[ai][k0 + k] = -sign * amp;
        }
    // Gyro: first-order lag of the setpoint.
    const a = Math.exp(-1 / (FS * (o.tauMs / 1000)));
    const gy = sp.map((s) => {
        const g = new Float64Array(n);
        for (let k = 1; k < n; k++) g[k] = a * g[k - 1] + (1 - a) * s[k];
        return g;
    });
    const layout = stepBlockLayout();
    const blockEnd =
        blockStart + (layout[layout.length - 1].offsetTicks + layout[layout.length - 1].lengthTicks) * perTick;
    // Motors: idle 1000 for the first 1.5 s (disarmed), then hover 1300 + a 200 Hz tone; a strong 300 Hz tone only in the block.
    const motors = [0, 1, 2, 3].map((m) =>
        Float64Array.from({ length: n }, (_, k) =>
            k < 1500
                ? 1000
                : 1300 +
                  o.motorAmp * Math.sin((2 * Math.PI * 200 * k) / FS + m) +
                  (k >= blockStart && k < blockEnd ? o.blockNoiseAmp * Math.sin((2 * Math.PI * 300 * k) / FS) : 0),
        ),
    );
    const log = {
        sha256: "x",
        logIndex: 0,
        headerPairs: [],
        sampleRateHz: FS,
        channels: {
            timeUs,
            gyroAdc: gy as unknown as [Float64Array, Float64Array, Float64Array],
            gyroUnfilt: null,
            erpm: [],
            rcThrottle: new Float64Array(n).fill(1300),
            axisD: null,
            motors,
            jio: {
                setpoint: sp,
                axisP: null,
                axisI: null,
                axisF: null,
                debugAxis: dbgAxis,
                excitation: null,
                frequencyDeciHz: freq,
            },
        },
        chirp: {},
        stick: { acroSeconds: 0, latencyMs: {} },
        noiseFloorKnown: false,
    } as unknown as AutotuneLogInput;
    return { log, blockStart };
}

describe("session metrics (session_v1)", () => {
    it("finds the step block after the last CHIRP and reads tracking, overshoot, rise and oscillation per axis", () => {
        const { log, blockStart } = synthLog({ tauMs: 10, motorAmp: 5, blockNoiseAmp: 0 });
        const m = runMetrics(log);
        expect(m.issues).toEqual([]);
        expect(m.blockStartSample).toBe(blockStart);
        for (const axis of ["roll", "pitch"] as const) {
            const s = m.steps[axis]!;
            // A first-order lag never overshoots and reaches 90 % after τ·ln 10 ≈ 23 ms (steps of 2A and A alternate).
            expect(s.overshoot).toBeLessThan(1e-6);
            expect(s.riseMs).toBeGreaterThan(20);
            expect(s.riseMs).toBeLessThan(26);
            expect(s.trackingRel).toBeGreaterThan(0.2);
            expect(s.trackingRel).toBeLessThan(0.6);
            expect(s.oscillation).toBeLessThan(0.05);
        }
        // A slower response tracks worse and rises later.
        const slow = runMetrics(synthLog({ tauMs: 20, motorAmp: 5, blockNoiseAmp: 0 }).log);
        expect(slow.steps.roll!.trackingRel).toBeGreaterThan(m.steps.roll!.trackingRel);
        expect(slow.steps.roll!.riseMs).toBeGreaterThan(m.steps.roll!.riseMs);
    });

    it("motor band power in hover outside the CHIRP and outside the step block (± guards), per motor", () => {
        const a = runMetrics(synthLog({ tauMs: 10, motorAmp: 5, blockNoiseAmp: 0 }).log);
        const b = runMetrics(synthLog({ tauMs: 10, motorAmp: 5, blockNoiseAmp: 200 }).log);
        const c = runMetrics(synthLog({ tauMs: 10, motorAmp: 10, blockNoiseAmp: 0 }).log);
        // A tone of amplitude A has power A²/2 (Hann window, density scaling): 12.5.
        for (const p of a.motors!.bandPower) expect(p!).toBeCloseTo(12.5, 0);
        // The block's own load does not enter the hover read; the hover tone does, ×4 for twice the amplitude.
        b.motors!.bandPower.forEach((p, k) => expect(p!).toBeCloseTo(a.motors!.bandPower[k]!, 6));
        c.motors!.bandPower.forEach((p, k) => expect(p! / a.motors!.bandPower[k]!).toBeCloseTo(4, 2));
        expect(a.motors!.clip).toBe(0);
        // Hover: from 1 s after arming (2.5 s) to the end, minus CHIRP ± 0.5 s and the block with lead, tail and guard.
        const blockS = 0.001 * (stepBlockLayout().at(-1)!.offsetTicks + stepBlockLayout().at(-1)!.lengthTicks) * 10;
        const expected = 30 - 2.5 - (7 + 1) - (blockS + 0.6 + 0.2 + 1);
        expect(a.motors!.hoverSamples / 1000).toBeCloseTo(expected, 1);
        expect(a.blockExclusion).not.toBeNull();
    });

    it("names what is missing: no step block, no setpoint, not four motors", () => {
        const { log } = synthLog({ tauMs: 10, motorAmp: 5, blockNoiseAmp: 0, withBlock: false });
        expect(runMetrics(log).issues).toContain("step_block_not_found");
        const noSp = { ...log, channels: { ...log.channels, jio: null } } as AutotuneLogInput;
        expect(runMetrics(noSp).issues).toEqual(
            expect.arrayContaining(["setpoint_not_logged", "chirp_debug_not_logged"]),
        );
        const three = {
            ...log,
            channels: { ...log.channels, motors: log.channels.motors!.slice(0, 3) },
        } as AutotuneLogInput;
        expect(runMetrics(three).issues).toContain("four_motors_not_logged");
    });
});
