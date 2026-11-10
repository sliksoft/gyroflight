/*
 * High-resolution Blackbox logs (blackbox_high_resolution ON): the firmware writes gyroADC, gyroUnfilt,
 * rcCommand and setpoint ×10. The engine must read the same throttle, gyro and setpoint from a
 * standard and a high-resolution log of the same flight, and its loop must come out the same.
 * Found by the SITL loop-reference test of 10 Nov 2026: the raw throttle (13 680) drove the TPA factor
 * to its minimum and the D-path simulation to half the real D.
 *
 * Also: a D-path simulation that does not reproduce the logged axisD may not replace the headers' D;
 * the fallback is named in the decision checks.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { buildLogInputs } from "../../src/gyrocore/engine/logInput";
import {
    analyzeAxisController,
    DTERM_FALLBACK,
    flightMask,
    runAutotuneV2,
    type AutotuneLogInput,
} from "../../src/gyrocore/engine/autotuneV2";
import { descaleHighResolution, parseLoggedHeaders } from "../../src/gyrocore/chirp/headers";
import { closedLoopChirpLog, ratePlant, type ClosedLoopLogOptions } from "./harness/closedLoopBbl";
import { BETAFLIGHT_TUNE_HEADERS } from "./harness/chirpSim";

/** The D-path settings dtermConfigFromHeaders needs (AIR65 values), on top of the harness tune. */
const DTERM_HEADERS = [
    ...BETAFLIGHT_TUNE_HEADERS,
    "d_max_gain:20",
    "d_max_advance:35",
    "dterm_lpf1_type:0",
    "dterm_lpf1_dyn_expo:5",
    "dterm_lpf2_type:0",
    "dterm_notch_hz:0",
    "tpa_rate:60",
    "tpa_breakpoint:1350",
    "tpa_low_rate:20",
    "tpa_low_breakpoint:1050",
    "tpa_low_always:0",
    "throttle_limit_type:0",
];

const PLANT = ratePlant({ K: 60, motorHz: 40, delayS: 0.002 });

function decoded(o: ClosedLoopLogOptions): AutotuneLogInput {
    const bytes = closedLoopChirpLog(o);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const report = qualifyChirpFile(bytes, "sim.bbl", 45, AUTOTUNE_MATH);
    const [log] = buildLogInputs(bytes, sha, report, null);
    expect(log).toBeDefined();
    return log;
}

const headersOf = (log: AutotuneLogInput) =>
    Object.fromEntries(log.headerPairs.map(([k, v]) => [k, v])) as Record<string, string>;

function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
    expect(a.length).toBe(b.length);
    let m = 0;
    for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
    return m;
}

describe("high-resolution channels", () => {
    it("divides exactly the firmware's ×10 fields back, nothing else", () => {
        const named = {
            "gyroADC[0]": new Float64Array([100, -250]),
            "gyroUnfilt[2]": new Float64Array([30]),
            "rcCommand[3]": new Float64Array([13680]),
            "setpoint[1]": new Float64Array([-4200]),
            "axisD[0]": new Float64Array([120]),
            "debug[2]": new Float64Array([250]),
            "motor[0]": new Float64Array([1433]),
            missing: null,
        };
        const hi = parseLoggedHeaders([["blackbox_high_resolution", "1"]]);
        const out = descaleHighResolution(named, hi);
        expect(Array.from(out["gyroADC[0]"]!)).toEqual([10, -25]);
        expect(Array.from(out["gyroUnfilt[2]"]!)).toEqual([3]);
        expect(Array.from(out["rcCommand[3]"]!)).toEqual([1368]);
        expect(Array.from(out["setpoint[1]"]!)).toEqual([-420]);
        expect(out["axisD[0]"]).toBe(named["axisD[0]"]);
        expect(out["debug[2]"]).toBe(named["debug[2]"]);
        expect(out["motor[0]"]).toBe(named["motor[0]"]);
        expect(out.missing).toBeNull();
        // a standard log is returned as is (no copies, no scaling)
        expect(descaleHighResolution(named, parseLoggedHeaders([["blackbox_high_resolution", "0"]]))).toBe(named);
        expect(descaleHighResolution(named, parseLoggedHeaders([]))).toBe(named);
    });

    it("reads the same throttle, gyro and setpoint from a standard and a high-resolution log of one flight", () => {
        const base: ClosedLoopLogOptions = { plants: [PLANT, PLANT, null], sweepS: 8, seed: 11 };
        const std = decoded(base);
        const hi = decoded({ ...base, highResolution: true });
        expect(headersOf(hi).blackbox_high_resolution).toBe("1");
        expect(headersOf(std).blackbox_high_resolution).toBeUndefined();
        // throttle: identical (1400 µs in the harness), never 14 000
        expect(maxAbsDiff(std.channels.rcThrottle, hi.channels.rcThrottle)).toBe(0);
        expect(Math.max(...Array.from(hi.channels.rcThrottle))).toBeLessThan(2100);
        // gyro and setpoint: the same values within the standard log's 1 deg/s quantisation
        for (const a of [0, 1]) {
            expect(maxAbsDiff(std.channels.gyroAdc[a], hi.channels.gyroAdc[a])).toBeLessThanOrEqual(0.5);
            const spStd = std.channels.jio?.setpoint?.[a] ?? null;
            const spHi = hi.channels.jio?.setpoint?.[a] ?? null;
            expect(spStd && spHi).toBeTruthy();
            expect(maxAbsDiff(spStd as Float64Array, spHi as Float64Array)).toBeLessThanOrEqual(0.5);
        }
        // the flight mask (armed, in flight) and the chirp windows agree
        expect(Array.from(flightMask(hi.channels.rcThrottle))).toEqual(Array.from(flightMask(std.channels.rcThrottle)));
        expect(hi.chirp.roll?.start).toBe(std.chirp.roll?.start);
    });

    it("reads the same roll loop from both logs", () => {
        const base: ClosedLoopLogOptions = { plants: [PLANT, PLANT, null], sweepS: 8, seed: 11 };
        const std = runAutotuneV2({
            primary: decoded(base),
            others: [],
            verifiedTune: null,
            createdAt: "2026-11-10T00:00:00Z",
        });
        const hi = runAutotuneV2({
            primary: decoded({ ...base, highResolution: true }),
            others: [],
            verifiedTune: null,
            createdAt: "2026-11-10T00:00:00Z",
        });
        const a = std.margins.roll!.current;
        const b = hi.margins.roll!.current;
        expect(a.crossoverHz).not.toBeNull();
        expect(Math.abs(b.crossoverHz! / a.crossoverHz! - 1)).toBeLessThan(0.02);
        expect(Math.abs(b.measured.phaseMarginDeg! - a.measured.phaseMarginDeg!)).toBeLessThan(1);
        // the D path sees the same throttle: same acceptance and the same fallback decision
        const da = std.dterm.find((d) => d.axis === "roll");
        const db = hi.dterm.find((d) => d.axis === "roll");
        expect(db?.applied).toBe(da?.applied);
        expect(db?.fallback).toBe(da?.fallback);
    });
});

describe("D-path fit gating", () => {
    const base: ClosedLoopLogOptions = { plants: [PLANT, PLANT, null], sweepS: 8, seed: 11, headers: DTERM_HEADERS };

    it("keeps the headers' D when the simulation does not reproduce the logged axisD, and names the fallback", () => {
        const log = decoded(base);
        const h = headersOf(log);
        const headerD = Number(h.rollPID.split(",")[2]);
        expect(headerD).toBeGreaterThan(0);
        // a logged axisD the simulation cannot match: five times whatever the gyro path gives
        const wrong = Float64Array.from(log.channels.gyroAdc[0], (g) => 5 * g);
        const broken: AutotuneLogInput = {
            ...log,
            channels: {
                ...log.channels,
                axisD: [wrong, log.channels.axisD?.[1] ?? null, log.channels.axisD?.[2] ?? null],
            },
        };
        const ctl = analyzeAxisController(broken, h, 0, broken.chirp.roll!, flightMask(broken.channels.rcThrottle));
        expect(ctl).not.toBeNull();
        expect(ctl!.dterm).not.toBeNull();
        expect(ctl!.accepted).toBe(false);
        expect(ctl!.dtermApplied).toBe(false);
        expect(ctl!.cfg.axis.d).toBe(headerD);
        expect(ctl!.cfg.dtermLpf1Hz).toBe(Number(h.dterm_lpf1_static_hz));
        // visible in the decision checks of the normal run
        const r = runAutotuneV2({ primary: broken, others: [], verifiedTune: null, createdAt: "2026-11-10T00:00:00Z" });
        const d = r.dterm.find((x) => x.axis === "roll")!;
        expect(d.accepted).toBe(false);
        expect(d.applied).toBe(false);
        expect(d.fallback).toBe(DTERM_FALLBACK);
        const check = r.candidateDecisions.roll?.primary?.checks.find((c) => c.rule === "dterm_path_fit");
        expect(check?.result).toBe("waived");
        expect(check?.consequence).toContain(DTERM_FALLBACK);
        // never the first cause of a decision
        expect(r.candidateDecisions.roll?.primary?.firstCause?.rule).not.toBe("dterm_path_fit");
    });

    it("applies the effective D only when the fit is accepted", () => {
        const log = decoded(base);
        const h = headersOf(log);
        const ctl = analyzeAxisController(log, h, 0, log.chirp.roll!, flightMask(log.channels.rcThrottle));
        expect(ctl).not.toBeNull();
        expect(ctl!.dtermApplied).toBe(ctl!.accepted);
        // either the effective D replaced the headers' D, or the headers' D stands: never a third value
        const headerD = Number(h.rollPID.split(",")[2]);
        expect(
            ctl!.dtermApplied
                ? ctl!.cfg.axis.d !== headerD || ctl!.cfg.dtermLpf1Hz !== Number(h.dterm_lpf1_static_hz)
                : ctl!.cfg.axis.d === headerD,
        ).toBe(true);
        const r = runAutotuneV2({ primary: log, others: [], verifiedTune: null, createdAt: "2026-11-10T00:00:00Z" });
        const check = r.candidateDecisions.roll?.primary?.checks.find((c) => c.rule === "dterm_path_fit");
        expect(check).toBeDefined();
        expect(check!.result).toBe(ctl!.dtermApplied ? "pass" : "waived");
    });
});
