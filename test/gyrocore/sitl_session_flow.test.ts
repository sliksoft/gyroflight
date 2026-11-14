/**
 * Block 14: the AutoTune session's state machine (session.ts) against a fake bench and a fake analysis.
 * The fake bench behaves like bench_server.mjs: a flash holding the active tune, an accepted (restore) tune, a restore
 * of up to three attempts (each read back; all failed → restore_unconfirmed and tuning actions refused), and an abort
 * that stops the running operation and restores the same way.
 */
import { describe, expect, it } from "vitest";
import {
    runSession,
    type ActiveRead,
    type Analyzer,
    type Bench,
    type BenchRestore,
    type BenchRun,
    type Tune,
} from "../../src/gyrocore/sitlSession/session";
import type { RunRead } from "../../src/gyrocore/sitlSession/decision";
import type { SessionSearchResult } from "../../src/gyrocore/engine/sessionSearch";
import { shortfallOf } from "../../src/gyrocore/engine/sessionSearch";

const T0: Tune = {
    roll: { p: 100, i: 80, d: 30, dMax: 40 },
    pitch: { p: 80, i: 110, d: 60, dMax: 0 },
    yaw: { p: 56, i: 79, d: 0, dMax: 0 },
};
const key = (t: Tune) => JSON.stringify(t);

/** What the fake plant "measures" for a tune: roll PM rises as roll P falls; motors rise with roll D. */
type Plant = (t: Tune) => { pmRoll: number; motor: number; overshoot: number };
const defaultPlant: Plant = (t) => ({
    pmRoll: 40 + (100 - t.roll.p) * 0.5,
    motor: 7.8 * (t.roll.d / 30) ** 2,
    overshoot: 0.1,
});

class FakeBench implements Bench {
    flash: Tune = T0;
    accepted: { tune: Tune; measurementId: string } | null = null;
    log: string[] = [];
    measureGate: Promise<void> | null = null;
    corruptSet = false;
    corruptRestore = false;
    /** The first N restore attempts fail before writing (bench --inject restore_fail_first:N). */
    restoreFailFirst = 0;
    restoreFailAlways = false;
    locked = false;
    private restoreCalls = 0;
    private seq = 0;
    private rejectRunning: ((e: Error) => void) | null = null;
    constructor(readonly plant: Plant = defaultPlant) {}
    private read(t: Tune): ActiveRead {
        return { tune: JSON.parse(key(t)), pidProfile: 0, armed: false };
    }
    async readActive() {
        this.log.push("readActive");
        return this.read(this.flash);
    }
    private refuseWhenLocked(op: string) {
        if (this.locked) {
            this.log.push(`refused:${op}`);
            throw new Error("restore_unconfirmed_locked");
        }
    }
    async setTune(t: Tune) {
        this.refuseWhenLocked("setTune");
        this.log.push(`setTune:${t.roll.p}`);
        this.flash = t;
        if (this.corruptSet) return this.read({ ...t, roll: { ...t.roll, dMax: 0 } });
        return this.read(t);
    }
    private restoreAttempts(): BenchRestore {
        for (let n = 1; n <= 3; n++) {
            this.restoreCalls++;
            const fail = this.restoreFailAlways || this.restoreCalls <= this.restoreFailFirst;
            this.log.push(`restoreAttempt:${n}:${fail ? "fail" : "ok"}`);
            if (fail) continue;
            this.flash = this.accepted!.tune;
            // a bench that calls a different read exact (the app's own check must catch it)
            const t = this.corruptRestore
                ? { ...this.flash, roll: { ...this.flash.roll, p: this.flash.roll.p + 1 } }
                : this.flash;
            this.locked = false;
            return { restored: this.read(t), error: null, attempts: n };
        }
        this.locked = true;
        return { restored: this.read(this.flash), error: "restore_unconfirmed", attempts: 3 };
    }
    async restore() {
        this.log.push("restore");
        return this.restoreAttempts();
    }
    async commitAccepted(t: Tune, measurementId: string) {
        this.refuseWhenLocked("commitAccepted");
        this.log.push(`commit:${t.roll.p}:${measurementId}`);
        this.accepted = { tune: t, measurementId };
        return { ...this.accepted };
    }
    async measure(label: string) {
        this.refuseWhenLocked("measure");
        this.log.push(`measure:${label}`);
        if (this.measureGate) {
            await new Promise<void>((resolve, reject) => {
                this.rejectRunning = reject;
                this.measureGate!.then(resolve);
            });
        }
        const runs: BenchRun[] = [0, 1, 2].map((k) => ({
            start: 400 + 50 * k,
            status: "ok",
            reason: null,
            log: new Uint8Array([1]),
            logSha256: `${label}-${++this.seq}-${key(this.flash)}`.padEnd(12, "x"),
            active: this.read(this.flash),
            plant: { maxAbsRollDeg: 15, maxAbsPitchDeg: 15, minZ: 1.4, finite: true },
        }));
        return { runs };
    }
    async abort() {
        this.log.push("abort");
        this.rejectRunning?.(new Error("stopped_by_abort"));
        return { helperStopped: true, ...this.restoreAttempts() };
    }
}

/** Reads the tune from the run's sha label (the fake bench encodes the flash in it). */
function tuneOfRun(r: BenchRun): Tune {
    return JSON.parse(r.logSha256!.slice(r.logSha256!.indexOf("{")));
}

function fakeAnalyzer(plant: Plant, candidates: (base: Tune) => Tune["roll"][], seen: string[] = []): Analyzer {
    return {
        async runs(runs) {
            return runs.map((r): RunRead => {
                const t = tuneOfRun(r);
                const m = plant(t);
                return {
                    margins: {
                        roll: { crossoverHz: 30, pmDeg: m.pmRoll, gmDb: 12, sDb: 5.5, gmHz: 67, gmSigmaDb: 0.5 },
                        pitch: { crossoverHz: 36, pmDeg: 50, gmDb: 10, sDb: 5, gmHz: 73, gmSigmaDb: 0.5 },
                    },
                    steps: {
                        roll: { trackingRel: 0.47, overshoot: m.overshoot, riseMs: 14, oscillation: 0.02 },
                        pitch: { trackingRel: 0.54, overshoot: 0.05, riseMs: 34, oscillation: 0.04 },
                    },
                    motors: { bandPower: [m.motor, m.motor, m.motor, m.motor], hoverSamples: 11000, clip: 0 },
                    issues: [],
                };
            });
        },
        async search(runs, rho): Promise<SessionSearchResult> {
            const base = tuneOfRun(runs[0]);
            seen.push(runs.map((r) => r.logSha256!.slice(0, 12)).join("+"));
            const cur = plant(base);
            const mk = (v: Tune["roll"]) => {
                const pm = plant({ ...base, roll: v }).pmRoll;
                const ratio = plant({ ...base, roll: v }).motor / cur.motor;
                return {
                    values: v,
                    change: { p: v.p / base.roll.p - 1, i: 0, d: v.d / base.roll.d - 1 },
                    predicted: { crossoverHz: 30, pmDeg: pm, gmDb: 12, sDb: 5.5 },
                    shortfall: shortfallOf(pm, 12, 5.5),
                    meets: { pm: pm >= 45, gm: true, s: true },
                    motorRatios: [ratio, ratio, ratio, ratio],
                };
            };
            return {
                axes: [
                    {
                        axis: "roll",
                        status: "searched",
                        reasons: [],
                        current: base.roll,
                        currentRead: {
                            crossoverHz: 30,
                            pmDeg: cur.pmRoll,
                            gmDb: 12,
                            sDb: 5.5,
                            gmHz: 67,
                            gmSigmaDb: 0.5,
                        },
                        rho: rho.roll,
                        tried: 1,
                        readable: 1,
                        candidates: candidates(base).map(mk),
                    },
                    {
                        axis: "pitch",
                        status: "searched",
                        reasons: [],
                        current: base.pitch,
                        currentRead: { crossoverHz: 36, pmDeg: 50, gmDb: 10, sDb: 5, gmHz: 73, gmSigmaDb: 0.5 },
                        rho: rho.pitch,
                        tried: 0,
                        readable: 0,
                        candidates: [],
                    },
                ],
                motorModel: { assessable: true, reasons: [], limitations: [] },
            };
        },
    };
}

describe("AutoTune session flow (fake bench)", () => {
    it("measures the start, accepts an improvement, restores a rejected step and reads it back, then stops", async () => {
        // The plant model says D 39 is fine (the analysis predicts motors from roll D only via its own model: here it
        // predicts ×1, so the policy proposes it), but the bench measures motors ×1.69: G1 rejects it.
        const plant: Plant = (t) => ({
            pmRoll: 40 + (100 - t.roll.p) * 0.5,
            motor: 7.8 * (t.roll.d / 30) ** 2,
            overshoot: 0.1,
        });
        const predictOnlyP: Plant = (t) => ({ ...plant(t), motor: 7.8 });
        const bench = new FakeBench(plant);
        const seen: string[] = [];
        const analyzer = fakeAnalyzer(
            predictOnlyP,
            (b) => (b.roll.p === 100 ? [{ ...b.roll, p: 92 }] : [{ ...b.roll, p: 88, d: 36, dMax: 48 }]),
            seen,
        );
        // The decision reads the bench's measurement (plant), the policy the prediction (predictOnlyP).
        analyzer.runs = fakeAnalyzer(plant, () => []).runs;
        const r = await runSession({ bench, analyzer });
        expect(r.status).toBe("finished");
        expect(r.steps.map((s) => s.verdict)).toEqual(["ACCEPT", "RESTORE", "ACCEPT"].slice(0, r.steps.length));
        expect(r.steps[0].verdict).toBe("ACCEPT");
        expect(r.steps[0].commit?.echoed).toBe(true);
        expect(r.steps[1].verdict).toBe("RESTORE");
        expect(r.steps[1].reasons.some((x) => x.startsWith("G1_motor"))).toBe(true);
        expect(r.steps[1].restore).toMatchObject({ exact: true });
        expect(r.steps[1].restore!.readback!.tune.roll).toEqual({ ...T0.roll, p: 92 });
        // The step after the restore is chosen on the last accepted measurement (step 1's), not on step 2's logs.
        expect(r.steps[1].baseMeasurementId).toBe(r.steps[0].measurement!.id);
        if (r.steps[2]) expect(r.steps[2].baseMeasurementId).toBe(r.steps[0].measurement!.id);
        expect(seen[1]).toBe(r.steps[0].measurement!.id);
        // After the restore the policy searched again on that same accepted measurement (and found nothing eligible).
        expect(seen[2]).toBe(r.steps[0].measurement!.id);
        expect(r.stopReason).toBe("no_eligible_candidate");
        // Bench order: commit before the next step's set.
        const i = bench.log.indexOf(`commit:92:${r.steps[0].measurement!.id}`);
        expect(i).toBeGreaterThan(0);
        expect(bench.log.slice(i + 1).find((x) => x.startsWith("setTune"))).toBe("setTune:88");
        expect(bench.flash.roll.p).toBe(r.best!.tune.roll.p);
    });

    it("a set that does not read back exactly is INVALID and restored; two in a row end the session", async () => {
        const bench = new FakeBench();
        bench.corruptSet = true;
        const r = await runSession({
            bench,
            analyzer: fakeAnalyzer(defaultPlant, (b) => [{ ...b.roll, p: Math.round(b.roll.p * 0.92) }]),
        });
        expect(r.steps.map((s) => s.verdict)).toEqual(["INVALID", "INVALID"]);
        expect(r.steps[0].reasons).toEqual(["readback_mismatch"]);
        expect(r.stopReason).toBe("measurement_unreliable");
        expect(key(bench.flash)).toBe(key(T0));
    });

    it("a restore that does not read back exactly ends the session as an error", async () => {
        const plant: Plant = (t) => ({ pmRoll: 40, motor: 7.8, overshoot: t.roll.p < 100 ? 0.2 : 0.1 });
        const bench = new FakeBench(plant);
        bench.corruptRestore = true;
        const an = fakeAnalyzer(
            (t) => ({ ...plant(t), pmRoll: 40 + (100 - t.roll.p) }),
            (b) => [{ ...b.roll, p: 92 }],
        );
        an.runs = fakeAnalyzer(plant, () => []).runs;
        const r = await runSession({ bench, analyzer: an });
        expect(r.status).toBe("error");
        expect(r.error).toBe("restore_verification_failed");
        expect(r.steps[0].restore?.exact).toBe(false);
    });

    for (const afterAccept of [false, true])
        it(`Stop during a candidate measurement${afterAccept ? " after an earlier ACCEPT" : ""}: the bench stops, restores the accepted tune and reads it back`, async () => {
            const bench = new FakeBench();
            const abort = new AbortController();
            let release: () => void = () => {};
            const an = fakeAnalyzer(defaultPlant, (b) => [{ ...b.roll, p: Math.round(b.roll.p * 0.95) }]);
            const origMeasure = bench.measure.bind(bench);
            let n = 0;
            bench.measure = async (label: string) => {
                n++;
                if (n === (afterAccept ? 3 : 2)) {
                    bench.measureGate = new Promise<void>((r) => (release = r));
                    setTimeout(() => abort.abort(), 5);
                } else bench.measureGate = null;
                return origMeasure(label);
            };
            const r = await runSession({ bench, analyzer: an, signal: abort.signal });
            release();
            expect(r.status).toBe("aborted");
            expect(bench.log).toContain("abort");
            const last = r.steps[r.steps.length - 1];
            expect(last.verdict).toBe("ABORTED");
            expect(last.restore?.exact).toBe(true);
            const expected = afterAccept ? r.steps[0].to : T0;
            if (afterAccept) expect(r.steps[0].verdict).toBe("ACCEPT");
            expect(key(r.finalActive!.tune)).toBe(key(expected));
            expect(key(bench.flash)).toBe(key(expected));
        });

    it("the commit after an ACCEPT must be echoed: an unconfirmed commit ends in error with the accepted tune restored", async () => {
        const bench = new FakeBench();
        const real = bench.commitAccepted.bind(bench);
        let n = 0;
        bench.commitAccepted = async (t, id) => {
            n++;
            const echo = await real(t, id);
            // the third commit is the one after step 1's ACCEPT: the bench answers with another id
            return n === 3 ? { ...echo, measurementId: "other" } : echo;
        };
        const r = await runSession({ bench, analyzer: fakeAnalyzer(defaultPlant, (b) => [{ ...b.roll, p: 92 }]) });
        expect(r.steps[0].verdict).toBe("ACCEPT");
        expect(r.status).toBe("error");
        expect(r.stopDetail).toContain("commit_not_confirmed_by_bench");
        expect(bench.log).toContain("abort");
        // the bench holds (and restored) what it recorded; the app sees exactly that tune active
        expect(r.activeIsAccepted).toBe(true);
    });

    it("an error after a candidate was set (analysis throws) restores the accepted tune and reads it back (Grok r1 BLOCKER)", async () => {
        const bench = new FakeBench();
        const an = fakeAnalyzer(defaultPlant, (b) => [{ ...b.roll, p: 92 }]);
        const runs = an.runs.bind(an);
        let calls = 0;
        an.runs = async (x) => {
            if (++calls === 2) throw new Error("bench_log_not_decoded");
            return runs(x);
        };
        const r = await runSession({ bench, analyzer: an });
        expect(r.status).toBe("error");
        expect(r.stopDetail).toEqual(["bench_log_not_decoded", "accepted_tune_restored"]);
        expect(bench.log).toContain("abort");
        expect(key(bench.flash)).toBe(key(T0));
        expect(key(r.finalActive!.tune)).toBe(key(T0));
        expect(r.activeIsAccepted).toBe(true);
        expect(r.steps[0].restore).toMatchObject({ exact: true });
    });

    it("a normal end verifies the active tune: another tune active ends in error, and the accepted tune is restored", async () => {
        const bench = new FakeBench();
        const read = bench.readActive.bind(bench);
        let n = 0;
        bench.readActive = async () => {
            const a = await read();
            return ++n === 1 ? a : { ...a, tune: { ...a.tune, pitch: { ...a.tune.pitch, p: a.tune.pitch.p + 1 } } };
        };
        const r = await runSession({ bench, analyzer: fakeAnalyzer(defaultPlant, () => []) });
        expect(r.status).toBe("error");
        expect(r.stopDetail).toEqual(["active_tune_is_not_the_accepted_tune", "accepted_tune_restored"]);
        // handled like any failure: the bench restored the accepted tune and read it back (Grok r2 note B)
        expect(bench.log).toContain("abort");
        expect(r.activeIsAccepted).toBe(true);
    });

    it("a scripted first candidate is decided like any step (the pre-registered restore test)", async () => {
        const bench = new FakeBench();
        const r = await runSession({
            bench,
            analyzer: fakeAnalyzer(defaultPlant, () => []),
            scripted: [{ step: 1, axis: "roll", dScale: 1.3 }],
        });
        expect(r.steps[0].scripted).toBe(true);
        expect(r.steps[0].verdict).toBe("RESTORE");
        expect(r.steps[0].reasons).toContain("G1_motor_vs_accepted:m1");
        expect(r.steps[0].restore).toMatchObject({ exact: true });
        expect(key(bench.flash)).toBe(key(T0));
        expect(r.stopReason).toBe("no_eligible_candidate");
    });

    describe("restore with retries (HERSTELPLAN_SITL: one bench restore path, bounded attempts, same connection)", () => {
        const scripted = [{ step: 1, axis: "roll" as const, dScale: 1.3 }];

        it("H1b: a RESTORE whose first attempt fails goes on only after the second attempt reads the accepted tune back", async () => {
            const bench = new FakeBench();
            bench.restoreFailFirst = 1;
            const r = await runSession({ bench, analyzer: fakeAnalyzer(defaultPlant, () => []), scripted });
            expect(r.steps[0].verdict).toBe("RESTORE");
            expect(r.steps[0].restore).toMatchObject({ exact: true, attempts: 2, error: null });
            expect(key(r.steps[0].restore!.readback!.tune)).toBe(key(T0));
            // the restore goes through bench.restore, never a setTune of the accepted tune
            const i = bench.log.indexOf("restore");
            expect(bench.log.slice(i, i + 3)).toEqual(["restore", "restoreAttempt:1:fail", "restoreAttempt:2:ok"]);
            expect(bench.log.filter((x) => x.startsWith("setTune"))).toEqual([`setTune:${T0.roll.p}`]);
            // nothing else happens on the bench between the request and the exact attempt; the session then goes on
            expect(bench.log.slice(i + 3)).toEqual(["readActive"]);
            expect(r.status).toBe("finished");
            expect(r.activeIsAccepted).toBe(true);
        });

        it("H2 after a RESTORE: every attempt fails → restore_unconfirmed, no next step, the bench refuses tuning actions", async () => {
            const bench = new FakeBench();
            bench.restoreFailAlways = true;
            const r = await runSession({ bench, analyzer: fakeAnalyzer(defaultPlant, () => []), scripted });
            expect(r.status).toBe("error");
            expect(r.stopReason).toBe("restore_unconfirmed");
            expect(r.error).toBe("restore_unconfirmed");
            expect(r.stopDetail).toEqual(["attempts:3"]);
            expect(r.steps).toHaveLength(1);
            expect(r.steps[0].restore).toMatchObject({ exact: false, attempts: 3, error: "restore_unconfirmed" });
            // honest: the candidate is still active, and the result says so
            expect(key(r.finalActive!.tune)).toBe(key(r.steps[0].to));
            expect(r.activeIsAccepted).toBe(false);
            expect(bench.log.at(-1)).toBe("restoreAttempt:3:fail");
            await expect(bench.setTune(T0)).rejects.toThrow("restore_unconfirmed_locked");
            await expect(bench.measure("x")).rejects.toThrow("restore_unconfirmed_locked");
            await expect(bench.commitAccepted(T0, "x")).rejects.toThrow("restore_unconfirmed_locked");
        });

        for (const always of [false, true])
            it(`${always ? "H2" : "H1"}: Stop during a candidate measurement, ${always ? "every attempt fails" : "the first attempt fails"}`, async () => {
                const bench = new FakeBench();
                if (always) bench.restoreFailAlways = true;
                else bench.restoreFailFirst = 1;
                const abort = new AbortController();
                let release: () => void = () => {};
                const an = fakeAnalyzer(defaultPlant, (b) => [{ ...b.roll, p: Math.round(b.roll.p * 0.95) }]);
                const origMeasure = bench.measure.bind(bench);
                let n = 0;
                bench.measure = async (label: string) => {
                    if (++n === 2) {
                        bench.measureGate = new Promise<void>((res) => (release = res));
                        setTimeout(() => abort.abort(), 5);
                    } else bench.measureGate = null;
                    return origMeasure(label);
                };
                const r = await runSession({ bench, analyzer: an, signal: abort.signal });
                release();
                const last = r.steps[r.steps.length - 1];
                expect(last.verdict).toBe("ABORTED");
                if (always) {
                    expect(r.status).toBe("error");
                    expect(r.stopReason).toBe("restore_unconfirmed");
                    expect(last.restore).toMatchObject({ exact: false, attempts: 3, error: "restore_unconfirmed" });
                    expect(key(r.finalActive!.tune)).toBe(key(last.to));
                    expect(r.activeIsAccepted).toBe(false);
                } else {
                    expect(r.status).toBe("aborted");
                    expect(last.restore).toMatchObject({ exact: true, attempts: 2 });
                    expect(key(r.finalActive!.tune)).toBe(key(T0));
                    expect(r.activeIsAccepted).toBe(true);
                }
            });
    });
});
