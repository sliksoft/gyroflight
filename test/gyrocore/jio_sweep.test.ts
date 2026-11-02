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
 * CHIRP + JIO route (jioSweep.ts) on simulated closed-loop Blackbox bytes: the whole software chain
 * (decoder → qualification → buildLogInputs → engine). Every fixture is a real sweep of honest length
 * at the encoder's 1 kHz with the firmware's exponential chirp and phaseComp; nothing is declared.
 * SIMULATION ONLY: no AIR65 or other hardware evidence.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { phaseCompCoeffs } from "../../src/js/blackbox/betaflight_digital_controller";
import { buildLogInputs } from "../../src/gyrocore/engine/logInput";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import {
    controllerConfigFromHeaders,
    runAutotuneV2,
    type AutotuneLogInput,
} from "../../src/gyrocore/engine/autotuneV2";
import {
    crossFlightRepeatabilityZ,
    estimateSweepColumn,
    FIRMWARE_CHIRP,
    JIO_SWEEP,
    sweepAdviceFor,
    reconstructChirpReference,
    relativeSd,
    repeatabilityZ,
    smoothLength,
} from "../../src/gyrocore/engine/jioSweep";
import { closedLoopChirpLog, ratePlant, type ClosedLoopLogOptions, type Plant } from "./harness/closedLoopBbl";
import { BETAFLIGHT_TUNE_HEADERS } from "./harness/chirpSim";

const AIR65_LIKE = { K: 60, motorHz: 40, delayS: 0.002 };
const G: Plant = ratePlant(AIR65_LIKE);
/** A 20 % gain change: what one sweep cannot see and two repeats must. */
const G_STEP: Plant = ratePlant({ ...AIR65_LIKE, K: 72 });

function decoded(o: ClosedLoopLogOptions, name: string): AutotuneLogInput {
    const bytes = closedLoopChirpLog(o);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const [log] = buildLogInputs(bytes, sha, qualifyChirpFile(bytes, name, 45, AUTOTUNE_MATH), null);
    expect(log, name).toBeDefined();
    return log;
}

const run = (log: AutotuneLogInput, others: AutotuneLogInput[] = []) =>
    runAutotuneV2({ primary: log, others, verifiedTune: null });

/** |G_est / G_true| in dB and ∠ in degrees at the supported points of one axis within [lo, hi] Hz. */
function plantError(
    pts: NonNullable<ReturnType<typeof run>["jio"]["analysis"]["axes"]["roll"]>["points"],
    truth: Plant,
    lo: number,
    hi: number,
) {
    const db: number[] = [];
    const deg: number[] = [];
    for (let i = 0; i < pts!.frequencyHz.length; i++) {
        const f = pts!.frequencyHz[i];
        if (!pts!.supported[i] || f < lo || f > hi) continue;
        const g = truth(f);
        const qRe = (pts!.gRe[i] * g.re + pts!.gIm[i] * g.im) / (g.re * g.re + g.im * g.im);
        const qIm = (pts!.gIm[i] * g.re - pts!.gRe[i] * g.im) / (g.re * g.re + g.im * g.im);
        db.push(Math.abs(20 * Math.log10(Math.hypot(qRe, qIm))));
        deg.push(Math.abs((Math.atan2(qIm, qRe) * 180) / Math.PI));
    }
    const med = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
    return { n: db.length, medianDb: med(db), medianDeg: med(deg) };
}

/**
 * Gyro-like output disturbance fed back through the loop (3 °/s rms, PT1 300 Hz). The loop of the
 * AIR65-like plant responds little above ≈ 40 Hz, so the chirp's r→y coherence drops there as on
 * the real logs; the direct setpoint→gyro qualification rejects these sweeps on mean coherence.
 */
const JIO_FIX = { disturbance: { sd: 3, poleHz: 300 } };
const AMP = 150;

describe("jioSweep estimator", () => {
    it("smoothLength is the largest 5-smooth length not above n", () => {
        expect(smoothLength(20500)).toBe(20480);
        expect(smoothLength(20480)).toBe(20480);
        expect(smoothLength(7)).toBe(6);
    });

    it("relativeSd follows Bendat & Piersol and is infinite without coherence", () => {
        expect(relativeSd(1, 25)).toBe(0);
        expect(relativeSd(0.5, 25)).toBeCloseTo(Math.sqrt(0.5 / (50 * 0.5)), 12);
        expect(relativeSd(0, 25)).toBe(Infinity);
    });

    it("reconstructs the firmware's shaped chirp from debug[3] and ignores another axis's excitation", () => {
        const pc = phaseCompCoeffs(3, 30, 1000)!;
        const n = 2000;
        const exc = new Float64Array(n);
        const axis = new Float64Array(n);
        for (let k = 0; k < n; k++) {
            exc[k] = Math.round(1000 * Math.cos(0.05 * k));
            axis[k] = k < 1500 ? 1 : 2; // the record's tail already holds axis 2's sweep
        }
        const r = reconstructChirpReference(exc, axis, 1, 0, n, 230, 3, 30, 1000)!;
        let x1 = 0;
        let y1 = 0;
        for (let k = 0; k < 1500; k++) {
            const x = exc[k] / 1000;
            const y = pc.b0 * x + pc.b1 * x1 - pc.a1 * y1;
            x1 = x;
            y1 = y;
            expect(r[k]).toBeCloseTo(230 * y, 9);
        }
        // Past the axis change the input is 0: the 3 Hz lag rings out, nothing of axis 2 enters.
        expect(Math.abs(r[1999])).toBeLessThan(Math.abs(r[1510]) * 1e-3);
        expect(Math.abs(r[1999])).toBeLessThan(0.1);
        expect(reconstructChirpReference(exc, axis, 1, 0, n, 230, 0, 30, 1000)).toBeNull();
    });

    it("recovers a known plant from r, u, y with a disturbance that biases the direct T → G path", () => {
        // Discrete simulation at 1 kHz: closed loop with the header controller; output disturbance fed
        // back through the loop. u = C_ref r − C_fb y is logged; the plant seen is y = G u + d.
        const fs = 1000;
        const n = 20480;
        const h = Object.fromEntries(
            [
                "rollPID:45,80,30",
                "looptime:125",
                "pid_process_denom:8",
                "dterm_lpf1_static_hz:75",
                "dterm_lpf2_static_hz:150",
            ].map((l) => l.split(":") as [string, string]),
        );
        const cfg = controllerConfigFromHeaders(h, 0)!;
        // Frequency-domain simulation on the record grid (circular, but the sweep record is zero at both ends).
        const r = new Float64Array(n);
        const f0 = 2;
        const f1 = 200;
        const T = 20;
        const beta = Math.pow(f1 / f0, 1 / T);
        for (let k = 0; k < Math.round(T * fs); k++) {
            const tt = k / fs;
            r[k] = 200 * Math.cos(((2 * Math.PI) / Math.log(beta)) * (f0 * Math.pow(beta, tt) - f0));
        }
        let seed = 11;
        const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
        const d = Float64Array.from(
            { length: n },
            () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd()),
        );
        // Time-domain closed loop: a discrete rate plant (integrator, motor PT1, 2 ms delay) under the
        // header's P + I (D = 0 for this check), the disturbance added at the plant output.
        const cfgPI = { ...cfg, axis: { ...cfg.axis, d: 0 } };
        const Kp = 0.032029 * cfgPI.axis.p;
        const Ki = 0.244381 * cfgPI.axis.i;
        const K = 60;
        const wm = 2 * Math.PI * 40;
        const delay = 2; // samples = 2 ms
        const u = new Float64Array(n);
        const y = new Float64Array(n);
        let integ = 0;
        let rate = 0; // plant state: rate (°/s)
        let motor = 0; // motor state
        const ubuf = new Float64Array(delay + 1);
        for (let k = 0; k < n; k++) {
            const e = r[k] - y[k > 0 ? k - 1 : 0];
            integ += (Ki * e) / fs;
            u[k] = Kp * e + integ;
            // delayed input
            ubuf[k % (delay + 1)] = u[k];
            const ud = ubuf[(k + 1) % (delay + 1)];
            // motor PT1 then integrator: rate' = K * motor
            motor += (wm / fs) * (ud - motor);
            rate += (K * motor) / fs;
            y[k] = rate + 40 * d[k];
        }
        const col = estimateSweepColumn(
            r,
            [u, new Float64Array(n), new Float64Array(n)],
            [y, new Float64Array(n), new Float64Array(n)],
            fs,
        );
        // Truth of the simulated discrete plant: G(z) = K/fs · 1/(1−z⁻¹) · (wm/fs)/(1−(1−wm/fs)z⁻¹) · z^{−delay}.
        const truth = (f: number) => {
            const w = (2 * Math.PI * f) / fs;
            const z = { re: Math.cos(-w), im: Math.sin(-w) };
            const cm = (a: { re: number; im: number }, b: { re: number; im: number }) => ({
                re: a.re * b.re - a.im * b.im,
                im: a.re * b.im + a.im * b.re,
            });
            const inv = (a: { re: number; im: number }) => ({
                re: a.re / (a.re ** 2 + a.im ** 2),
                im: -a.im / (a.re ** 2 + a.im ** 2),
            });
            const one = { re: 1, im: 0 };
            const integr = inv({ re: one.re - z.re, im: one.im - z.im });
            const a = wm / fs;
            const mot = cm({ re: a, im: 0 }, inv({ re: 1 - (1 - a) * z.re, im: -(1 - a) * z.im }));
            let zd = one;
            for (let i = 0; i < delay; i++) zd = cm(zd, z);
            return cm(cm(cm({ re: K / fs, im: 0 }, integr), mot), zd);
        };
        let nSup = 0;
        const errs: number[] = [];
        for (let i = 0; i < col.f.length; i++) {
            const f = col.f[i];
            if (f < 4 || f > 150) continue;
            const sdU = relativeSd(col.g2u[i * 3], col.nEff);
            const sdY = relativeSd(col.g2y[i * 3], col.nEff);
            if (Math.max(sdU, sdY) > JIO_SWEEP.maxRelativeSd) continue;
            nSup++;
            const g = truth(f);
            const hru = { re: col.hruRe[i * 3], im: col.hruIm[i * 3] };
            const hry = { re: col.hryRe[i * 3], im: col.hryIm[i * 3] };
            const den = hru.re ** 2 + hru.im ** 2;
            const gj = { re: (hry.re * hru.re + hry.im * hru.im) / den, im: (hry.im * hru.re - hry.re * hru.im) / den };
            errs.push(Math.abs(20 * Math.log10(Math.hypot(gj.re, gj.im) / Math.hypot(g.re, g.im))));
        }
        expect(nSup).toBeGreaterThan(40);
        const med = [...errs].sort((a, b) => a - b)[Math.floor(errs.length / 2)];
        expect(med).toBeLessThan(1.0);
    });

    it("repeatability z stays near 1 for the same plant and rises for a gain step", () => {
        const fs = 1000;
        const n = 20480;
        const mk = (K: number, seed: number) => {
            const r = new Float64Array(n);
            const beta = Math.pow(100, 1 / 20);
            for (let k = 0; k < 20000; k++)
                r[k] = 200 * Math.cos(((2 * Math.PI) / Math.log(beta)) * (2 * Math.pow(beta, k / fs) - 2));
            let s = seed;
            const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
            const u = new Float64Array(n);
            const y = new Float64Array(n);
            let integ = 0;
            let rate = 0;
            let motor = 0;
            for (let k = 0; k < n; k++) {
                const e = r[k] - (k ? y[k - 1] : 0);
                integ += (0.244381 * 80 * e) / fs;
                u[k] = 0.032029 * 45 * e + integ;
                motor += ((2 * Math.PI * 40) / fs) * (u[k] - motor);
                rate += (K * motor) / fs;
                y[k] = rate + 30 * (Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd()));
            }
            return estimateSweepColumn(
                r,
                [u, new Float64Array(n), new Float64Array(n)],
                [y, new Float64Array(n), new Float64Array(n)],
                fs,
            );
        };
        const a = mk(60, 1);
        const b = mk(60, 2);
        const c = mk(72, 3);
        const inBand = Uint8Array.from(a.f, (f) => (f >= 4 && f <= 100 ? 1 : 0));
        const same = repeatabilityZ(a, b, 0, inBand)!;
        const step = repeatabilityZ(a, c, 0, inBand)!;
        expect(same).toBeLessThan(JIO_SWEEP.repeatZThreshold);
        expect(step).toBeGreaterThan(JIO_SWEEP.repeatZThreshold);
        expect(step).toBeGreaterThan(same);
    });
});

describe("CHIRP + JIO route through the whole software chain", () => {
    const nominal = decoded(
        { plants: [G, G, G], sweepS: 20, amplitude: AMP, seed: 3, jio: JIO_FIX },
        "jio-nominal.bbl",
    );
    const result = run(nominal);

    it("recovers the plant per axis with a fed-back disturbance, as a DIAGNOSTIC result", () => {
        expect(result.jio.diagnosticOnly).toBe(true);
        expect(result.jio.analysis.blockers).toEqual([]);
        expect(result.jio.status).toBe("DIAGNOSTIC");
        for (const axis of ["roll", "pitch", "yaw"] as const) {
            const a = result.jio.analysis.axes[axis]!;
            expect(a.method).toBe("chirp_jio_sweep_fft_daniell");
            expect(a.records).toHaveLength(1);
            expect(a.records[0].used).toBe(true);
            expect(a.repeats).toMatchObject({ count: 1, consistency: "unknown", z: null });
            expect(a.band!.supportedFraction).toBeGreaterThan(0.3);
            expect(a.band!.supportedHz![0]).toBeLessThan(5);
            expect(a.band!.supportedHz![1]).toBeGreaterThan(30);
            expect(a.reasons.uncertainty_too_large).toBeGreaterThan(0);
            const err = plantError(a.points, G, 5, 40);
            expect(err.n).toBeGreaterThan(15);
            expect(err.medianDb).toBeLessThan(1.0);
            expect(err.medianDeg).toBeLessThan(10);
            const c = result.jio.chain[axis]!;
            expect(c.tuningComputable).toBe(true);
            expect(c.margins!.evidence.level).not.toBe("VALIDATED");
            expect(c.margins!.status).not.toBe("VALIDATED");
            expect(c.candidate!.status).not.toBe("VALIDATED");
            expect(c.reasons).toContain("stationarity_unknown:single_sweep");
            expect(c.plan).not.toBeNull();
        }
        expect(result.jio.requiredMeasurements).toContain(
            "required_measurement:chirp_roll_repeated_sweep_for_stationarity",
        );
        // The direct-method engine with the header controller agrees with the JIO plant on this LTI sim.
        const agree = result.jio.analysis.axes.roll!.controllerModelAgreement!;
        expect(agree.points).toBeGreaterThan(15);
        expect(agree.medianAbsDb).toBeLessThan(1.5);
    });

    it("changes nothing in the primary route's proposal, release evidence or write authority", () => {
        const strip = (r: typeof result) => ({
            pid: r.pid,
            margins: r.margins,
            proposal: r.proposal,
            releasable: r.releasableProposal,
            parts: r.parts,
            safety: r.safety,
        });
        // The same input without the JIO channels: the primary route must give the identical result.
        const stripped: AutotuneLogInput = { ...nominal, channels: { ...nominal.channels, jio: null }, sweeps: [] };
        const without = run(stripped);
        expect(without.jio.status).toBe("BLOCKED");
        expect(without.jio.analysis.blockers).toContain("jio_channels_missing");
        expect(strip(result)).toEqual(strip(without));
        expect(result.releasableProposal).toBeNull();
        // And on a disturbance-free sweep the primary route qualifies: still identical with and without.
        const clean = decoded({ plants: [G, G, G], sweepS: 20, amplitude: AMP, seed: 9, jio: {} }, "jio-clean.bbl");
        expect(Object.values(clean.chirp).map((c) => c.state)).toEqual(["usable", "usable", "usable"]);
        const withJio = run(clean);
        const noJio = run({ ...clean, channels: { ...clean.channels, jio: null }, sweeps: [] });
        expect(withJio.jio.status).toBe("DIAGNOSTIC");
        expect(strip(withJio)).toEqual(strip(noJio));
        expect(withJio.releasableProposal).toEqual(noJio.releasableProposal);
        for (const c of Object.values(withJio.jio.chain)) expect(c!.candidate?.status).not.toBe("VALIDATED");
    });

    it("names missing debug and controller-term channels instead of assuming them", () => {
        const noPid = run(
            decoded(
                {
                    plants: [G, null, null],
                    sweepS: 12,
                    amplitude: AMP,
                    seed: 4,
                    jio: { ...JIO_FIX, omit: ["axisI", "axisF"] },
                },
                "jio-nopid.bbl",
            ),
        );
        expect(noPid.jio.status).toBe("BLOCKED");
        expect(noPid.jio.analysis.blockers).toEqual(
            expect.arrayContaining(["jio_channel_missing:axisI", "jio_channel_missing:axisF"]),
        );
        expect(noPid.jio.requiredMeasurements).toContain("required_measurement:log_pid_terms_and_debug_chirp");
        const noD = run(
            decoded(
                { plants: [G, null, null], sweepS: 12, amplitude: AMP, seed: 4, jio: { ...JIO_FIX, omit: ["axisD"] } },
                "jio-nod.bbl",
            ),
        );
        expect(noD.jio.analysis.blockers).toContain("jio_channel_missing:axisD:roll");
        const wrongRate = run(
            decoded(
                {
                    plants: [G, null, null],
                    sweepS: 12,
                    amplitude: AMP,
                    seed: 4,
                    jio: { ...JIO_FIX, pidProcessDenomHeader: 4 },
                },
                "jio-rate.bbl",
            ),
        );
        expect(wrongRate.jio.analysis.blockers.some((b) => b.startsWith("jio_log_rate_not_pid_rate"))).toBe(true);
        expect(wrongRate.jio.requiredMeasurements).toContain("required_measurement:log_at_pid_rate");
    });

    it("reports a hole in the excitation as unsupported points inside the band", () => {
        const holed = run(
            decoded(
                {
                    plants: [G, null, null],
                    sweepS: 20,
                    seed: 5,
                    jio: JIO_FIX,
                    amplitude: AMP,
                    envelope: (f) => (f > 10 && f < 20 ? 0 : 1),
                },
                "jio-hole.bbl",
            ),
        );
        const a = holed.jio.analysis.axes.roll!;
        expect(a.band!.gapPoints).toBeGreaterThan(5);
        expect(a.reasons.excitation_hole).toBeGreaterThanOrEqual(4);
        const inHole = Array.from(a.points!.frequencyHz)
            .map((f, i) => [f, a.points!.supported[i]] as const)
            .filter(([f]) => f > 12.5 && f < 18);
        expect(inHole.length).toBeGreaterThan(0);
        expect(inHole.every(([, s]) => s === 0)).toBe(true);
    });

    it("groups two consistent repeats of one axis and combines them", () => {
        const rep = run(
            decoded(
                { plants: [G, null, null], sweepS: 12, amplitude: AMP, seed: 6, jio: { ...JIO_FIX, repeats: 2 } },
                "jio-rep.bbl",
            ),
        );
        const a = rep.jio.analysis.axes.roll!;
        expect(a.records).toHaveLength(2);
        expect(a.records.every((r) => r.used)).toBe(true);
        expect(a.repeats.count).toBe(2);
        expect(a.repeats.consistency).toBe("consistent");
        expect(a.repeats.z).toBeLessThan(JIO_SWEEP.repeatZThreshold);
        expect(a.grid!.nEff).toBe(2 * (2 * JIO_SWEEP.daniellHalfWidthBins + 1));
        expect(rep.jio.chain.roll!.tuningComputable).toBe(true);
        expect(rep.jio.chain.roll!.reasons).not.toContain("stationarity_unknown:single_sweep");
        expect(rep.jio.requiredMeasurements).not.toContain(
            "required_measurement:chirp_roll_repeated_sweep_for_stationarity",
        );
    });

    it("flags a plant change between repeats and hands the tuning chain nothing", () => {
        const step = run(
            decoded(
                {
                    plants: [G, null, null],
                    sweepS: 12,
                    amplitude: AMP,
                    seed: 7,
                    jio: { ...JIO_FIX, repeats: 2, plantsAfter: [G_STEP, null, null] },
                },
                "jio-step.bbl",
            ),
        );
        const a = step.jio.analysis.axes.roll!;
        expect(a.repeats.consistency).toBe("inconsistent");
        expect(a.repeats.z).toBeGreaterThan(JIO_SWEEP.repeatZThreshold);
        expect(a.blockers).toContain("jio_repeats_inconsistent");
        expect(a.engineInput).toBeNull();
        // The individual responses stay visible.
        expect(a.points).not.toBeNull();
        expect(step.jio.chain.roll!.tuningComputable).toBe(false);
        expect(step.jio.status).toBe("BLOCKED");
        expect(step.jio.requiredMeasurements).toContain("required_measurement:chirp_roll_repeated_sweep_consistent");
    });

    it("rejects an exact copy of a sweep as a repeat", () => {
        const dup = run(
            decoded(
                {
                    plants: [G, null, null],
                    sweepS: 12,
                    amplitude: AMP,
                    seed: 8,
                    jio: { ...JIO_FIX, repeats: 2, duplicateRepeat: true },
                },
                "jio-dup.bbl",
            ),
        );
        const a = dup.jio.analysis.axes.roll!;
        expect(a.records).toHaveLength(2);
        expect(a.records[1].used).toBe(false);
        expect(a.records[1].flags.some((f) => f.startsWith("duplicate_recording:"))).toBe(true);
        expect(a.repeats.count).toBe(1);
        expect(a.repeats.consistency).toBe("unknown");
        expect(a.grid!.nEff).toBe(2 * JIO_SWEEP.daniellHalfWidthBins + 1);
    });

    it("leaves the 3×3 combination a diagnostic with unproven stationarity", () => {
        const m = result.jio.analysis.mimo!;
        expect(m.notes).toContain("diagnostic_only");
        expect(m.notes.some((n) => n.startsWith("stationarity_unproven:roll"))).toBe(true);
        expect(m.pointsWellConditioned).toBeGreaterThan(10);
        expect(m.conditionMedian).toBeLessThan(JIO_SWEEP.maxCondition);
        expect(m.bandHz![0]).toBeLessThan(10);
    });

    it("survives the worker's structured clone", () => {
        const clone = structuredClone(result.jio);
        expect(clone.analysis.axes.roll!.points!.frequencyHz.length).toBe(
            result.jio.analysis.axes.roll!.points!.frequencyHz.length,
        );
    });
});

/**
 * Repeats across independent flights: the same craft, firmware, configuration and sweep settings
 * (the primary route's identity rules), a different recording (seed, start time). Nothing is
 * averaged across flights; the plant of one is compared with the plant of the other.
 */
describe("CHIRP + JIO repeats across independent flights", () => {
    const flight = (
        seed: number,
        plants: [Plant | null, Plant | null, Plant | null],
        extra: Partial<ClosedLoopLogOptions> = {},
    ) =>
        decoded(
            {
                plants,
                sweepS: 20,
                amplitude: AMP,
                seed,
                startTimeUs: 2_000_000 + seed * 1_000_000,
                jio: JIO_FIX,
                ...extra,
            },
            `jio-flight-${seed}.bbl`,
        );
    const primary = flight(21, [G, G, G]);
    const same = flight(22, [G, G, G]);
    const changed = flight(23, [G_STEP, G, G]);

    it("a comparable second flight of the same plant counts as a consistent repeat, nothing averaged", () => {
        const r = run(primary, [same]);
        expect(r.jio.crossFlight.candidates).toHaveLength(1);
        const c = r.jio.crossFlight.candidates[0];
        expect(c.issues).toEqual([]);
        expect(c.usable).toBe(true);
        for (const axis of ["roll", "pitch", "yaw"] as const) {
            expect(c.axes[axis]!.consistency).toBe("consistent");
            expect(c.axes[axis]!.z).toBeLessThan(JIO_SWEEP.repeatZThreshold);
            expect(c.axes[axis]!.zPlant).toBeLessThan(JIO_SWEEP.repeatZThreshold);
            expect(c.axes[axis]!.reasons.some((x) => x.startsWith("plant_z:"))).toBe(true);
            expect(c.axes[axis]!.matchedPoints).toBeGreaterThanOrEqual(JIO_SWEEP.crossFlightMinPoints);
            expect(r.jio.crossFlight.axes[axis]).toMatchObject({ flights: 1, consistency: "consistent" });
            // The primary's own estimate is unchanged: one sweep in this log, n_eff of one record.
            const a = r.jio.analysis.axes[axis]!;
            expect(a.repeats).toMatchObject({ count: 1, consistency: "unknown" });
            expect(a.grid!.nEff).toBe(2 * JIO_SWEEP.daniellHalfWidthBins + 1);
            const ch = r.jio.chain[axis]!;
            expect(ch.reasons).toContain("stationarity_unknown:single_sweep");
            expect(ch.reasons.some((x) => x.startsWith("cross_flight_repeat:consistent:flights:1:z:"))).toBe(true);
            expect(ch.candidate!.status).not.toBe("VALIDATED");
        }
        // The stationarity need is met by the other flight's sweep; the route still releases nothing.
        expect(r.jio.requiredMeasurements.some((m) => m.includes("repeated_sweep_for_stationarity"))).toBe(false);
        expect(r.jio.diagnosticOnly).toBe(true);
        expect(r.releasableProposal).toBeNull();
        // The same analysis with no other log says so.
        const alone = run(primary);
        expect(alone.jio.crossFlight.candidates).toEqual([]);
        expect(alone.jio.chain.roll!.reasons).toContain("cross_flight_repeat:none");
        expect(alone.jio.analysis.axes.roll!.points!.gRe).toEqual(r.jio.analysis.axes.roll!.points!.gRe);
    }, 120_000);

    it("a plant change between flights is inconsistent on that axis only and blocks its candidate", () => {
        const r = run(primary, [changed]);
        const c = r.jio.crossFlight.candidates[0];
        expect(c.usable).toBe(true);
        expect(c.axes.roll!.consistency).toBe("inconsistent");
        expect(c.axes.roll!.z).toBeGreaterThan(JIO_SWEEP.repeatZThreshold);
        expect(c.axes.pitch!.consistency).toBe("consistent");
        expect(c.axes.yaw!.consistency).toBe("consistent");
        expect(r.jio.chain.roll!.candidate!.status).toBe("BLOCKED");
        expect(r.jio.chain.roll!.candidate!.reasons).toContain("jio_cross_flight_inconsistent");
        expect(r.jio.chain.roll!.reasons.some((x) => x.startsWith("jio_cross_flight_inconsistent:z:"))).toBe(true);
        expect(r.jio.chain.pitch!.candidate!.reasons).not.toContain("jio_cross_flight_inconsistent");
        expect(r.jio.requiredMeasurements).toContain("required_measurement:chirp_roll_repeated_sweep_consistent");
        expect(r.jio.requiredMeasurements).not.toContain("required_measurement:chirp_pitch_repeated_sweep_consistent");
        // The primary's margins are still this flight's reading, visible, MEASURED at most.
        expect(r.jio.chain.roll!.margins!.status).not.toBe("VALIDATED");
    }, 120_000);

    it("rejects the primary's own flight under another hash, a different sweep setting, and a different tune", () => {
        const bytes = closedLoopChirpLog({
            plants: [G, G, G],
            sweepS: 20,
            amplitude: AMP,
            seed: 21,
            startTimeUs: 23_000_000,
            jio: JIO_FIX,
        });
        const [copy] = buildLogInputs(
            bytes,
            "0".repeat(64),
            qualifyChirpFile(bytes, "copy.bbl", 45, AUTOTUNE_MATH),
            null,
        );
        const otherAmp = flight(24, [G, G, G], { amplitude: AMP + 10 });
        const otherTune = flight(25, [G, G, G], {
            headers: ["rollPID:50,80,30", ...BETAFLIGHT_TUNE_HEADERS.filter((h) => !h.startsWith("rollPID:"))],
        });
        const r = run(primary, [copy, otherAmp, otherTune]);
        const [c0, c1, c2] = r.jio.crossFlight.candidates;
        expect(c0.usable).toBe(false);
        expect(c0.issues.some((i) => i.startsWith("cross_log_duplicate_of_primary:"))).toBe(true);
        expect(c1.usable).toBe(false);
        expect(c1.issues).toContain("jio_cross_flight_sweep_differs:chirp_amplitude_roll");
        expect(c2.usable).toBe(false);
        expect(c2.issues.some((i) => i.startsWith("cross_log_config_differs:"))).toBe(true);
        expect(r.jio.crossFlight.axes).toEqual({});
        expect(r.jio.chain.roll!.reasons).toContain("cross_flight_repeat:none:see_crossFlight_candidates");
        expect(r.jio.requiredMeasurements).toContain("required_measurement:chirp_roll_repeated_sweep_for_stationarity");
    }, 120_000);

    // Different record lengths (a generator that stopped early on one flight) are exercised on the real
    // AIR65 pair in air65_jio.local.test.ts (bbl19's clipped record, step ratio 1.17) and below on points.
    it("crossFlightRepeatabilityZ gives no verdict on incomparable grids or too few common points", () => {
        const pts = (step: number, n: number, sup: number) => ({
            frequencyHz: Float64Array.from({ length: n }, (_, i) => (i + 1) * step),
            gRe: new Float64Array(n).fill(1),
            gIm: new Float64Array(n),
            tRe: new Float64Array(n).fill(0.5),
            tIm: new Float64Array(n),
            uRe: new Float64Array(n),
            uIm: new Float64Array(n),
            coherenceRu: new Float64Array(n).fill(0.9),
            coherenceRy: new Float64Array(n).fill(0.9),
            relativeSd: new Float64Array(n).fill(0.1),
            excitationRelDb: new Float64Array(n),
            supported: Uint8Array.from({ length: n }, (_, i) => (i < sup ? 1 : 0)),
            reason: new Array<string>(n).fill(""),
        });
        expect(crossFlightRepeatabilityZ(pts(1, 100, 100), pts(3, 30, 30), 25, 25, 2, 90).reasons[0]).toMatch(
            /grids_incomparable/,
        );
        const few = crossFlightRepeatabilityZ(pts(1, 100, 3), pts(1, 100, 100), 25, 25, 2, 90);
        expect(few.z).toBeNull();
        expect(few.reasons.some((x) => x.startsWith("too_few_common_supported_points:"))).toBe(true);
        const ok = crossFlightRepeatabilityZ(pts(1, 100, 100), pts(1.5, 60, 60), 25, 25, 2, 90);
        expect(ok.z).toBe(0);
        expect(ok.zPlant).toBe(0);
        expect(ok.matched).toBeGreaterThan(JIO_SWEEP.crossFlightMinPoints);
    });
});

describe("CHIRP + JIO sweep advice (firmware-settable exponential sweep only)", () => {
    it("suggests a lower end frequency within the firmware's ranges when the coherence is lost early", () => {
        const sweep = { f0Hz: 0.2, f1Hz: 600, durationS: 20 };
        const band = {
            analysedHz: [2, 450] as [number, number],
            supportedHz: [3.1, 67] as [number, number],
            supportedFraction: 0.3,
            gapPoints: 0,
            largestGapPoints: 0,
            longestRunHz: [3.1, 67] as [number, number],
        };
        const adv = sweepAdviceFor(sweep, band)!;
        expect(adv.current.secondsPerOctave).toBeCloseTo(20 / Math.log2(3000), 6);
        expect(adv.suggested).not.toBeNull();
        const sg = adv.suggested!;
        expect(sg.chirp_frequency_end_deci_hz).toBe(1100); // ceil(1.5 × 67 / 10) × 10 = 110 Hz
        expect(sg.chirp_frequency_start_deci_hz).toBe(20);
        expect(sg.chirp_time_seconds).toBe(20);
        expect(sg.chirp_frequency_end_deci_hz).toBeGreaterThanOrEqual(FIRMWARE_CHIRP.endDeciHz[0]);
        expect(sg.chirp_frequency_end_deci_hz).toBeLessThanOrEqual(FIRMWARE_CHIRP.endDeciHz[1]);
        expect(sg.secondsPerOctave).toBeGreaterThan(adv.current.secondsPerOctave);
        expect(sg.excitationGainDb).toBeGreaterThan(0);
        expect(adv.basis).toContain("sweep_law:exponential:chirp.c");
        expect(adv.basis).toContain("start_raised_to_lowest_analysed:2Hz");
        expect(adv.basis.some((b) => b.startsWith("experimental_not_validated"))).toBe(true);
    }, 120_000);

    it("leaves a sweep alone that already ends near the supported band, and gives none without a band", () => {
        const sweep = { f0Hz: 2, f1Hz: 100, durationS: 20 };
        const band = {
            analysedHz: [2, 100] as [number, number],
            supportedHz: [2.5, 80] as [number, number],
            supportedFraction: 0.9,
            gapPoints: 0,
            largestGapPoints: 0,
            longestRunHz: [2.5, 80] as [number, number],
        };
        const adv = sweepAdviceFor(sweep, band)!;
        expect(adv.suggested).toBeNull();
        expect(adv.basis).toContain("current_sweep_already_band_matched");
        expect(sweepAdviceFor(sweep, { ...band, supportedHz: null })).toBeNull();
        expect(sweepAdviceFor(sweep, null)).toBeNull();
    }, 120_000);

    it("the nominal fixture's advice is attached per axis and surfaces as a measurement need", () => {
        const r = run(
            decoded({ plants: [G, null, null], sweepS: 12, amplitude: AMP, seed: 31, jio: JIO_FIX }, "jio-adv.bbl"),
        );
        const a = r.jio.analysis.axes.roll!;
        expect(a.sweepAdvice).not.toBeNull();
        if (a.sweepAdvice!.suggested) {
            expect(a.sweepAdvice!.suggested.chirp_frequency_end_deci_hz).toBeLessThan(2000);
            expect(r.jio.requiredMeasurements).toContain("required_measurement:chirp_roll_band_matched_sweep");
        } else {
            expect(r.jio.requiredMeasurements).not.toContain("required_measurement:chirp_roll_band_matched_sweep");
        }
    });
});
