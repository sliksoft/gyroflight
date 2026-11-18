/*
 * Blackbox file → step response (src/gyrocore/stepResponse/stepLog.ts): the real decode path on
 * synthetic Acro BBLs (harness/stepBbl.ts) with a known response, and every log-level exclusion.
 */
import { describe, expect, it } from "vitest";
import { analyzeStepFile, type StepLogResult } from "@/gyrocore/stepResponse/stepLog";
import { stepMetrics } from "@/gyrocore/stepResponse/stepResponse";
import { concatLogs } from "./harness/chirpSim";
import { acroLog, ANGLE_FLAG, ARM_FLAG, CHIRP_FLAG, HORIZON_FLAG } from "./harness/stepBbl";
import { trueStep } from "./harness/stepSynth";

const one = (bytes: Uint8Array) => analyzeStepFile(bytes, "synthetic.bbl", "sha-test")[0];
const cell = (r: StepLogResult, axis: "roll" | "pitch" | "yaw", thr: 40 | 80) =>
    r.axes[axis]!.thresholds.find((t) => t.thresholdDegS === thr)!;

describe("synthetic Acro flight through the Blackbox decoder", () => {
    const plant = { fnHz: 20, zeta: 0.5, delayMs: 5, gain: 0.85 };
    const r = one(acroLog({ seconds: 20, seed: 3, noise: 0.1, plant }));
    it("is analysed at the logged rate, armed, Acro, saturation known", () => {
        expect(r.status).toBe("ANALYSED");
        expect(r.sampleRateHz).toBeCloseTo(1000, 6);
        expect(r.modesSeen).toEqual(["ARM"]);
        expect(r.saturation).toBe("KNOWN");
        expect(r.logNumber).toBe(1);
        expect(r.logCount).toBe(1);
        expect(r.flight?.session?.firstIteration).toBe(0);
    });
    it("measures every axis at both thresholds and keeps the gain (0.85, not 1)", () => {
        const ref = stepMetrics(trueStep(1000, plant), 1000);
        for (const axis of ["roll", "pitch", "yaw"] as const) {
            for (const thr of [40, 80] as const) {
                const t = cell(r, axis, thr);
                expect(t.status).toBe("MEASURED");
                expect(Math.abs(t.metrics!.finalValue - 0.85)).toBeLessThanOrEqual(0.06);
                expect(Math.abs(t.metrics!.overshoot - ref.overshoot)).toBeLessThanOrEqual(0.06);
                expect(Math.abs(t.metrics!.t50Ms! - ref.t50Ms!)).toBeLessThanOrEqual(4);
            }
        }
    });
    it("reports what the log says about iterm_relax and feedforward", () => {
        expect(r.loop.itermRelax).toEqual({ mode: "1", type: "1", cutoffHz: "25" });
        expect(r.loop.feedforward.weights).toBe("22,32,22");
        expect(r.loop.axisFLogged).toEqual([false, false, false]);
    });
});

describe("log-level exclusions", () => {
    it("ANGLE for the whole flight: every airborne window is self-levelling", () => {
        const r = one(acroLog({ flags: ARM_FLAG | ANGLE_FLAG }));
        const t = cell(r, "roll", 80);
        expect(t.windowsUsed).toBe(0);
        expect(t.rejected.self_level_or_automation).toBeGreaterThan(0);
        expect(r.modesSeen).toEqual(["ARM", "ANGLE"]);
    });
    it("a switch to HORIZON mid-flight: the windows over the switch are mode changes, after it self-levelling", () => {
        const r = one(acroLog({ seconds: 20, flagChanges: [{ at: 10_000, flags: ARM_FLAG | HORIZON_FLAG }] }));
        const t = cell(r, "roll", 80);
        expect(t.rejected.mode_change).toBeGreaterThan(0);
        expect(t.rejected.self_level_or_automation).toBeGreaterThan(0);
        expect(t.windowsUsed).toBeGreaterThan(0);
    });
    it("an active CHIRP (BOXCHIRP) excludes its windows plus the guard band", () => {
        const r = one(
            acroLog({
                seconds: 20,
                debugMode: 96,
                flagChanges: [
                    { at: 8000, flags: ARM_FLAG | CHIRP_FLAG },
                    { at: 12_000, flags: ARM_FLAG },
                ],
            }),
        );
        expect(r.chirp.boxSeen).toBe(true);
        expect(cell(r, "pitch", 80).rejected.chirp_active).toBeGreaterThan(0);
        expect(r.seconds.chirp).toBeGreaterThan(4);
    });
    it("a CHIRP debug mode without a sweep is not CHIRP activity", () => {
        const r = one(acroLog({ seconds: 20, debugMode: 96 }));
        expect(r.chirp.debugModeChirp).toBe(true);
        expect(r.chirp.segments).toBe(0);
        expect(r.seconds.chirp).toBe(0);
        expect(cell(r, "roll", 80).rejected.chirp_active).toBe(0);
        expect(cell(r, "roll", 80).status).toBe("MEASURED");
    });
    it("in Betaflight 4.5 bit 6 is FAILSAFE, not CHIRP: read by name from the Viewer's table for that version", () => {
        const r = one(
            acroLog({
                seconds: 20,
                flags: ARM_FLAG | CHIRP_FLAG,
                firmwareRevision: "Betaflight 4.5.1 (synthetic) STM32G47X",
            }),
        );
        expect(r.firmwareVersion).toBe("4.5.1");
        expect(r.modesSeen).toContain("FAILSAFE");
        expect(r.chirp.boxInFirmware).toBe(false);
        expect(r.seconds.chirp).toBe(0);
        expect(cell(r, "roll", 80).rejected.self_level_or_automation).toBeGreaterThan(0);
    });
    it("a local frame gap excludes only the windows over it", () => {
        const r = one(acroLog({ seconds: 20, gapsAt: [{ at: 10_000, frames: 3 }] }));
        expect(r.status).toBe("ANALYSED");
        expect(r.timestamps!.gapCount).toBe(1);
        const t = cell(r, "roll", 80);
        expect(t.rejected.frame_gap).toBe(5);
        expect(t.status).toBe("MEASURED");
    });
    it("a time base with gaps everywhere is BLOCKED (timebase_unusable)", () => {
        const gapsAt = Array.from({ length: 3000 }, (_, k) => ({ at: 5 + 5 * k, frames: 1 }));
        const r = one(acroLog({ seconds: 20, gapsAt }));
        expect(r.status).toBe("BLOCKED");
        expect(r.blockedReasons).toContain("timebase_unusable");
    });
    it("below 500 Hz is BLOCKED", () => {
        const r = one(acroLog({ seconds: 20, dtUs: 2500 }));
        expect(r.status).toBe("BLOCKED");
        expect(r.blockedReasons.join()).toMatch(/sample_rate_below_minimum:400<500/);
    });
    it("a motor at the top of its range excludes the windows over it", () => {
        const r = one(acroLog({ seconds: 20, saturateAt: [{ start: 9000, end: 9100 }] }));
        expect(cell(r, "yaw", 80).rejected.saturation).toBeGreaterThan(0);
        expect(r.seconds.saturated).toBeCloseTo(0.1, 2);
    });
    it("bit 31 of the box mask (PREARM) does not turn the flags into 'unknown'", () => {
        const r = one(acroLog({ seconds: 20, flags: ARM_FLAG | 0x80000000 }));
        expect(cell(r, "roll", 80).status).toBe("MEASURED");
        expect(cell(r, "roll", 80).rejected.not_airborne).toBeLessThan(cell(r, "roll", 80).windowsTotal);
    });
    it("no flightModeFlags: the mode is unknown, so the log is BLOCKED", () => {
        const r = one(acroLog({ seconds: 10, slowFields: false }));
        expect(r.status).toBe("BLOCKED");
        expect(r.blockedReasons).toContain("missing_required_field:flightModeFlags");
    });
    it("on the ground (throttle below take-off): not airborne", () => {
        const r = one(acroLog({ seconds: 10, throttle: 1050 }));
        expect(cell(r, "roll", 40).rejected.not_airborne).toBe(cell(r, "roll", 40).windowsTotal);
    });
});

describe("files with several logs", () => {
    it("every embedded log is analysed on its own and numbered as the app does (Log 1 of 2 …)", () => {
        const bytes = concatLogs(
            acroLog({ seconds: 10, seed: 1, flags: ARM_FLAG | ANGLE_FLAG }),
            acroLog({ seconds: 10, seed: 2 }),
        );
        const logs = analyzeStepFile(bytes, "two.bbl", "sha2");
        expect(logs.map((l) => `${l.logNumber}/${l.logCount}`)).toEqual(["1/2", "2/2"]);
        expect(cell(logs[0], "roll", 80).windowsUsed).toBe(0);
        expect(cell(logs[1], "roll", 80).windowsUsed).toBeGreaterThan(0);
        expect(logs[1].key).toBe("sha2:1");
    });
});
