import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    MeasurementInvalid,
    SAMPLES_PER_TICK,
    absoluteRejections,
    buildSchedule,
    compareToReference,
    dMaxFor,
    envelopeFailures,
    manoeuvreMetrics,
    roundCandidates,
    runStartTune,
    setpointLag,
    validateMeasurement,
    type Measure,
    type Measurement,
    type Preregistration,
    type RollPid,
    type Schedule,
    type SetMetrics,
} from "../../src/gyrocore/tuning/simRollAutotune";

const PRE = JSON.parse(
    readFileSync(resolve(__dirname, "../../scripts/sim/air65_roll_autotune_prereg.json"), "utf8"),
) as Preregistration;
const T = PRE.thresholds;
const SEARCH = buildSchedule(PRE.searchManoeuvres, PRE.leadTicks, PRE.settleTicks);
const HOLDOUT = buildSchedule(PRE.holdoutManoeuvres, PRE.leadTicks, PRE.settleTicks);

const BASE_HEADER: Record<string, string> = {
    rollPID: "56,79,30",
    pitchPID: "82,117,61",
    yawPID: "56,79,0",
    d_max: "40,0,0",
    looptime: "1000",
    blackbox_high_resolution: "1",
    gyro_lpf1_static_hz: "150",
    rc_smoothing_rx_smoothed: "110",
};

function header(pid: RollPid, dMax: number, extra: Record<string, string> = {}) {
    return {
        values: { ...BASE_HEADER, rollPID: `${pid.p},${pid.i},${pid.d}`, d_max: `${dMax},0,0`, ...extra },
        duplicates: [],
    };
}

interface Response {
    wn: number;
    zeta: number;
    /** motor command per unit of (setpoint - gyro) */
    gain?: number;
}

/** A second-order response to the logged setpoint (commands one tick late), with motors around hover. */
function synthetic(pid: RollPid, dMax: number, schedule: Schedule, r: Response, lagTicks = 1): Measurement {
    const n = schedule.rollDps.length * SAMPLES_PER_TICK;
    const sp: number[] = [];
    for (let k = 0; k < n; k++) {
        const tick = Math.floor(k / SAMPLES_PER_TICK) - lagTicks;
        sp.push(tick >= 0 ? schedule.rollDps[tick] : 0);
    }
    const dt = 0.001;
    let x = 0;
    let v = 0;
    const gy: number[] = [];
    const motors: number[][] = [];
    for (let k = 0; k < n; k++) {
        const a = r.wn * r.wn * (sp[k] - x) - 2 * r.zeta * r.wn * v;
        v += a * dt;
        x += v * dt;
        gy.push(x);
        const u = Math.max(-378, Math.min(567, (r.gain ?? 0.5) * (sp[k] - x)));
        motors.push([1433 - u, 1433 - u, 1433 + u, 1433 + u]);
    }
    return {
        status: "ok",
        reason: null,
        header: header(pid, dMax),
        trace: { dtS: dt, setpointDps: sp, gyroDps: gy, motors },
        plant: { maxAbsRollDeg: 30, minZ: 1, finite: true },
    };
}

/** A synthetic plant: P makes it faster, D damps it, P without D rings; the optimum lies inside the box. */
function bowl(pid: RollPid): Response {
    const wn = 40 + 1.5 * pid.p - Math.abs(pid.i - 90) / 20;
    const zeta = Math.max(0.15, Math.min(1.5, 0.45 + 0.025 * pid.d - 0.004 * (pid.p - 20)));
    return { wn, zeta };
}

function measureWith(response: (pid: RollPid, schedule: Schedule) => Response, calls: string[] = []): Measure {
    return async (pid, dMax, schedule, label) => {
        calls.push(label);
        return synthetic(pid, dMax, schedule, response(pid, schedule));
    };
}

const metric = (over: Partial<SetMetrics>): SetMetrics => ({
    tracking: 0.5,
    overshoot: 0.05,
    riseMs: 30,
    oscillation: 0.02,
    saturationShare: 0.01,
    cost: 0.55,
    perManoeuvre: [],
    ...over,
});

describe("sim roll autotune: pre-registration", () => {
    it("keeps search and holdout manoeuvres apart and the start tunes inside the box", () => {
        const s = new Set(PRE.searchManoeuvres.map((m) => JSON.stringify(m.segments)));
        for (const m of PRE.holdoutManoeuvres) expect(s.has(JSON.stringify(m.segments))).toBe(false);
        expect(PRE.startTunes.length).toBeGreaterThanOrEqual(3);
        expect(PRE.startTunes.some((t) => t.pid.p === 56 && t.pid.i === 79 && t.pid.d === 30)).toBe(true);
        for (const t of PRE.startTunes) {
            for (const k of ["p", "i", "d"] as const) {
                expect(t.pid[k]).toBeGreaterThanOrEqual(PRE.search.bounds[k][0]);
                expect(t.pid[k]).toBeLessThanOrEqual(PRE.search.bounds[k][1]);
            }
        }
        expect(dMaxFor(30, PRE.search.dMaxRatio)).toBe(40);
    });
});

describe("sim roll autotune: metrics and validity", () => {
    it("measures overshoot, rise and residual oscillation of a known step", () => {
        const sp = [0, ...Array(99).fill(100)];
        const gy = sp.map((_, k) => (k < 10 ? (k * 100) / 10 : k < 20 ? 110 : 100));
        const m = manoeuvreMetrics(
            "x",
            sp,
            gy,
            sp.map(() => [1433, 1433, 1433, 1433]),
            0.001,
            { ...T, settleDelayMs: 30 },
        );
        expect(m.overshoot).toBeCloseTo(0.1, 10);
        expect(m.riseMs).toBeCloseTo(8, 10);
        expect(m.oscillation).toBe(0);
        expect(m.saturationShare).toBe(0);
    });

    it("finds a constant command delay of up to two ticks and refuses anything else", () => {
        const pid = { p: 56, i: 79, d: 30 };
        for (const lag of [0, 1, 2]) {
            const m = synthetic(pid, 40, SEARCH, { wn: 100, zeta: 0.7 }, lag);
            expect(setpointLag(m.trace!.setpointDps, SEARCH)).toBe(lag * SAMPLES_PER_TICK);
        }
        const late = synthetic(pid, 40, SEARCH, { wn: 100, zeta: 0.7 }, 3);
        expect(setpointLag(late.trace!.setpointDps, SEARCH)).toBeNull();
        expect(validateMeasurement(late, pid, 40, SEARCH, BASE_HEADER)).toContain("setpoint_not_schedule");
    });

    it("calls a setpoint mismatch a harness fault only when a logged command phase slip explains it", () => {
        const pid = { p: 56, i: 79, d: 30 };
        const m = synthetic(pid, 40, SEARCH, { wn: 100, zeta: 0.7 });
        // from sample 800 on, every command arrives one PID tick later (as in demo1 run 051)
        const sp = m.trace!.setpointDps;
        for (let k = sp.length - 1; k > 800; k--) sp[k] = sp[k - 1];
        expect(validateMeasurement(m, pid, 40, SEARCH, BASE_HEADER)).toEqual(["setpoint_not_schedule"]);
        // the shift starts at sample 800 (command 79 starts there with the one-tick delay, command 80 one sample late): a slip after command 79 explains it
        m.commandPhaseSlips = [[79, 11]];
        expect(validateMeasurement(m, pid, 40, SEARCH, BASE_HEADER)).toEqual(["harness:command_phase_slip:79+11"]);
        // a slip that does not account for the mismatch (wrong place or size) leaves it a wrong setpoint
        m.commandPhaseSlips = [[150, 11]];
        expect(validateMeasurement(m, pid, 40, SEARCH, BASE_HEADER)).toEqual(["setpoint_not_schedule"]);
        m.commandPhaseSlips = [[79, 12]];
        expect(validateMeasurement(m, pid, 40, SEARCH, BASE_HEADER)).toEqual(["setpoint_not_schedule"]);
    });

    it("accepts exactly the requested roll PID and d_max and nothing else changed", () => {
        const pid = { p: 70, i: 79, d: 33 };
        const ok = synthetic(pid, 44, SEARCH, { wn: 100, zeta: 0.7 });
        expect(validateMeasurement(ok, pid, 44, SEARCH, BASE_HEADER)).toEqual([]);
        // run-time key may differ
        ok.header!.values.rc_smoothing_rx_smoothed = "109";
        expect(validateMeasurement(ok, pid, 44, SEARCH, BASE_HEADER)).toEqual([]);
        expect(validateMeasurement(ok, { ...pid, p: 71 }, 44, SEARCH, BASE_HEADER)).toContain(
            "roll_pid_expected_71,79,33:70,79,33",
        );
        expect(validateMeasurement(ok, pid, 45, SEARCH, BASE_HEADER)).toContain("d_max_roll_expected_45:44");
        ok.header!.values.pitchPID = "82,117,62";
        ok.header!.values.d_max = "44,1,0";
        ok.header!.values.blackbox_high_resolution = "0";
        const issues = validateMeasurement(ok, pid, 44, SEARCH, BASE_HEADER);
        expect(issues).toContain("header_changed:pitchPID:82,117,61:82,117,62");
        expect(issues).toContain("header_changed:d_max_pitch_yaw:40,0,0:44,1,0");
        expect(issues).toContain("blackbox_not_high_resolution");
        delete ok.header!.values.gyro_lpf1_static_hz;
        expect(validateMeasurement(ok, pid, 44, SEARCH, BASE_HEADER)).toContain("header_missing:gyro_lpf1_static_hz");
    });

    it("treats a lost manoeuvre as a candidate failure, not as a harness fault", () => {
        const m = synthetic({ p: 56, i: 79, d: 30 }, 40, SEARCH, { wn: 100, zeta: 0.7 });
        m.plant = { maxAbsRollDeg: 120, minZ: 0.1, finite: true };
        expect(validateMeasurement(m, { p: 56, i: 79, d: 30 }, 40, SEARCH, BASE_HEADER)).toEqual([]);
        expect(envelopeFailures(m, T)).toEqual(["roll_angle_120.0_deg", "height_0.10_m"]);
    });
});

describe("sim roll autotune: rejection and comparison", () => {
    it("rejects oscillation and motor saturation beyond the absolute limits", () => {
        expect(absoluteRejections(metric({ oscillation: 0.09 }), T)).toEqual(["oscillation_0.090>0.08"]);
        expect(absoluteRejections(metric({ saturationShare: 0.05 }), T)).toEqual(["motor_saturation_0.050>0.04"]);
        expect(absoluteRejections(metric({}), T)).toEqual([]);
    });

    it("needs a lower cost, no worse tracking or overshoot and no slower response", () => {
        const ref = metric({});
        expect(compareToReference(metric({ tracking: 0.45, cost: 0.5 }), ref, T)).toEqual([]);
        expect(compareToReference(metric({ tracking: 0.495, cost: 0.545 }), ref, T)[0]).toMatch(/^cost_not_lower/);
        expect(compareToReference(metric({ tracking: 0.53, overshoot: 0.0, cost: 0.53 }), ref, T)).toEqual([
            expect.stringMatching(/^tracking_worse/),
        ]);
        expect(compareToReference(metric({ tracking: 0.4, overshoot: 0.07, cost: 0.47 }), ref, T)).toEqual([
            expect.stringMatching(/^overshoot_worse/),
        ]);
        expect(compareToReference(metric({ tracking: 0.4, cost: 0.45, riseMs: 37 }), ref, T)).toEqual([
            "slower_37.0ms>36.5ms",
        ]);
        expect(compareToReference(metric({ tracking: 0.4, cost: 0.45, oscillation: 0.2 }), ref, T)).toEqual([
            "oscillation_0.200>0.08",
        ]);
    });
});

describe("sim roll autotune: candidate selection", () => {
    it("orders a round P up, P down, D up, D down, I up, I down inside the box", () => {
        expect(roundCandidates({ p: 56, i: 79, d: 30 }, 1.25, PRE.search)).toEqual([
            { p: 70, i: 79, d: 30 },
            { p: 45, i: 79, d: 30 },
            { p: 56, i: 79, d: 38 },
            { p: 56, i: 79, d: 24 },
            { p: 56, i: 99, d: 30 },
            { p: 56, i: 63, d: 30 },
        ]);
        // at the lower P bound, P down is skipped instead of repeating the incumbent
        expect(roundCandidates({ p: 20, i: 30, d: 15 }, 1.25, PRE.search).map((c) => c.p)).toEqual([
            25, 20, 20, 20, 20,
        ]);
        expect(roundCandidates({ p: 120, i: 160, d: 80 }, 1.25, PRE.search)).toEqual([
            { p: 96, i: 160, d: 80 },
            { p: 120, i: 160, d: 64 },
            { p: 120, i: 128, d: 80 },
        ]);
    });

    it("lets the measured response choose: moves only to better candidates and keeps it when the holdout agrees", async () => {
        const calls: string[] = [];
        const r = await runStartTune(
            "soft",
            { p: 20, i: 30, d: 15 },
            PRE,
            measureWith((pid) => bowl(pid), calls),
            null,
        );
        expect(r.decision).toBe("improved");
        expect(r.final).not.toEqual({ p: 20, i: 30, d: 15 });
        expect(r.final).toEqual(r.searchSelection);
        expect(r.evaluations.length).toBeLessThanOrEqual(PRE.search.budget);
        expect(r.holdout.selected!.cost).toBeLessThan(r.holdout.start!.cost * (1 - T.minRelativeGain));
        // every incumbent change was a candidate that was better than the incumbent of its time
        const accepted = r.evaluations.filter((e) => e.versusIncumbent && !e.versusIncumbent.length);
        expect(accepted.length).toBeGreaterThan(0);
        expect(accepted.some((e) => JSON.stringify(e.pid) === JSON.stringify(r.final))).toBe(true);
        expect(calls.filter((c) => c.includes("holdout")).length).toBe(2 * PRE.holdoutRepeats);
        expect(r.holdout.repeatsIdentical).toBe(true);
    });

    it("rejects a ringing candidate even when its cost is lower", async () => {
        // P up rings (oscillation above the limit) but tracks better; it must never become the incumbent.
        const response = (pid: RollPid): Response => (pid.p > 56 ? { wn: 220, zeta: 0.12 } : { wn: 60, zeta: 0.9 });
        const r = await runStartTune("ring", { p: 56, i: 79, d: 30 }, PRE, measureWith(response), BASE_HEADER);
        const pUp = r.evaluations.find((e) => e.pid.p === 70)!;
        expect(pUp.rejected.some((x) => x.startsWith("oscillation_"))).toBe(true);
        expect(r.final.p).toBeLessThanOrEqual(56);
    });

    it("keeps the start tune when no candidate is better on the search manoeuvres", async () => {
        const start = { p: 56, i: 79, d: 30 };
        const response = (pid: RollPid): Response =>
            pid.p === 56 && pid.i === 79 && pid.d === 30 ? { wn: 120, zeta: 0.8 } : { wn: 70, zeta: 0.6 };
        const calls: string[] = [];
        const r = await runStartTune("opt", start, PRE, measureWith(response, calls), BASE_HEADER);
        expect(r.decision).toBe("kept_no_search_improvement");
        expect(r.final).toEqual(start);
        expect(r.reason).toMatch(/no candidate within budget 12/);
        expect(calls.filter((c) => c.includes("holdout_selected"))).toEqual([]);
    });

    it("keeps the start tune when the improvement does not hold on the held-out manoeuvres", async () => {
        const start = { p: 20, i: 30, d: 15 };
        const response = (pid: RollPid, schedule: Schedule): Response =>
            schedule === HOLDOUT || schedule.rollDps.length === HOLDOUT.rollDps.length
                ? pid.p === 20 && pid.d === 15
                    ? { wn: 120, zeta: 0.8 }
                    : { wn: 60, zeta: 0.4 }
                : bowl(pid);
        const r = await runStartTune("overfit", start, PRE, measureWith(response), BASE_HEADER);
        expect(r.searchSelection).not.toEqual(start);
        expect(r.decision).toBe("kept_holdout_failed");
        expect(r.final).toEqual(start);
        expect(r.reason).toMatch(/did not hold on the held-out manoeuvres/);
    });

    it("keeps the start tune when the selection loses a held-out manoeuvre", async () => {
        const measure: Measure = async (pid, dMax, schedule) => {
            const m = synthetic(pid, dMax, schedule, bowl(pid));
            if (schedule.rollDps.length === HOLDOUT.rollDps.length && pid.p !== 20)
                m.plant = { maxAbsRollDeg: 80, minZ: 1, finite: true };
            return m;
        };
        const r = await runStartTune("lostH", { p: 20, i: 30, d: 15 }, PRE, measure, BASE_HEADER);
        expect(r.searchSelection).not.toEqual({ p: 20, i: 30, d: 15 });
        expect(r.decision).toBe("kept_holdout_failed");
        expect(r.holdout.versusStart![0]).toBe("selection_envelope:repeat1:roll_angle_80.0_deg");
        expect(r.final).toEqual({ p: 20, i: 30, d: 15 });
    });

    it("keeps the start tune when the start itself loses a held-out manoeuvre: no valid reference", async () => {
        const measure: Measure = async (pid, dMax, schedule) => {
            const m = synthetic(pid, dMax, schedule, bowl(pid));
            if (schedule.rollDps.length === HOLDOUT.rollDps.length && pid.p === 20)
                m.plant = { maxAbsRollDeg: 80, minZ: 1, finite: true };
            return m;
        };
        const r = await runStartTune("lostS", { p: 20, i: 30, d: 15 }, PRE, measure, BASE_HEADER);
        expect(r.decision).toBe("kept_holdout_failed");
        expect(r.holdout.startEnvelope).toEqual(["repeat1:roll_angle_80.0_deg", "repeat2:roll_angle_80.0_deg"]);
        expect(r.holdout.versusStart![0]).toBe("start_envelope:repeat1:roll_angle_80.0_deg");
        expect(r.final).toEqual({ p: 20, i: 30, d: 15 });
    });

    it("keeps the start tune without searching when the start itself loses the manoeuvre", async () => {
        const measure: Measure = async (pid, dMax, schedule) => {
            const m = synthetic(pid, dMax, schedule, { wn: 100, zeta: 0.7 });
            m.plant = { maxAbsRollDeg: 90, minZ: 1, finite: true };
            return m;
        };
        const r = await runStartTune("lost", { p: 56, i: 79, d: 30 }, PRE, measure, BASE_HEADER);
        expect(r.decision).toBe("kept_start_rejected");
        expect(r.evaluations).toEqual([]);
        expect(r.holdout.start).toBeNull();
    });

    it("retries a command phase slip once and goes on with the clean repeat", async () => {
        const calls: string[] = [];
        const measure: Measure = async (pid, dMax, schedule, label) => {
            calls.push(label);
            const m = synthetic(pid, dMax, schedule, { wn: 120, zeta: 0.8 });
            if (calls.length === 2) {
                const sp = m.trace!.setpointDps;
                for (let k = sp.length - 1; k > 800; k--) sp[k] = sp[k - 1];
                m.commandPhaseSlips = [[79, 11]];
            }
            return m;
        };
        const r = await runStartTune("slip", { p: 56, i: 79, d: 30 }, PRE, measure, BASE_HEADER);
        expect(calls.slice(0, 3)).toEqual(["slip_start_search", "slip_r1_70,79,30", "slip_r1_70,79,30_retry1"]);
        expect(r.evaluations[0].pid).toEqual({ p: 70, i: 79, d: 30 });
    });

    it("retries a harness fault once and then stops as invalid; a wrong configuration is not retried", async () => {
        const calls: string[] = [];
        const failing: Measure = async (_p, _d, _s, label) => {
            calls.push(label);
            return { status: "harness_error", reason: "sitl_io" };
        };
        await expect(runStartTune("io", { p: 56, i: 79, d: 30 }, PRE, failing, BASE_HEADER)).rejects.toBeInstanceOf(
            MeasurementInvalid,
        );
        expect(calls).toEqual(["io_start_search", "io_start_search_retry1"]);
        const wrongCalls: string[] = [];
        const wrong: Measure = async (pid, dMax, schedule, label) => {
            wrongCalls.push(label);
            return synthetic({ ...pid, p: pid.p + 1 }, dMax, schedule, { wn: 100, zeta: 0.7 });
        };
        await expect(runStartTune("cfg", { p: 56, i: 79, d: 30 }, PRE, wrong, BASE_HEADER)).rejects.toThrow(
            /roll_pid_expected_56,79,30:57,79,30/,
        );
        expect(wrongCalls).toEqual(["cfg_start_search"]);
    });
});
