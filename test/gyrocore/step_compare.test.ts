/*
 * Step-response A/B (src/gyrocore/stepResponse/stepCompare.ts, stepSettings.ts, stores/stepResponse.ts):
 * the same tune, one expected change, an extra change, UNKNOWN, not comparable, a flight imported twice.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { analyzeStepFile, type StepLogResult } from "@/gyrocore/stepResponse/stepLog";
import { compareStepLogs, controlSpread } from "@/gyrocore/stepResponse/stepCompare";
import { checkIntent, compareSettings } from "@/gyrocore/stepResponse/stepSettings";
import { useStepResponseStore } from "@/gyrocore/stores/stepResponse";
import { concatLogs } from "./harness/chirpSim";
import { acroLog, type AcroLogOptions } from "./harness/stepBbl";

const PLANT = { fnHz: 20, zeta: 0.5, delayMs: 5, gain: 1 };
let shaSeq = 0;
function flight(o: AcroLogOptions): StepLogResult {
    return analyzeStepFile(acroLog({ seconds: 20, noise: 0.1, ...o }), "f.bbl", `sha${++shaSeq}`)[0];
}
const A = flight({ seed: 1, startUs: 4_000_000, plant: PLANT });
const B_SAME = flight({ seed: 2, startUs: 7_000_000, plant: PLANT });
// roll P 56 → 45: a less damped loop in the synthetic plant (lower ζ) — the effect is synthetic
const B_P = flight({ seed: 3, startUs: 9_000_000, plant: { ...PLANT, zeta: 0.35 }, headers: { rollPID: "45,79,30" } });

describe("same tune (no-change control)", () => {
    const cmp = compareStepLogs(A, B_SAME, { kind: "none" });
    it("all pair checks pass and every axis and threshold gets a delta", () => {
        expect(cmp.status).toBe("COMPARED");
        expect(cmp.pairChecks.every((c) => c.status === "PASS")).toBe(true);
        expect(cmp.axes).toHaveLength(6);
        expect(cmp.axes.every((x) => x.delta !== null)).toBe(true);
        expect(cmp.authorization.status).toBe("NOT_AUTHORIZED");
    });
    it("the flight-to-flight spread of the same tune is small", () => {
        for (const s of controlSpread(cmp)) {
            expect(s.overshoot).toBeLessThan(0.08);
            expect(s.finalValue).toBeLessThan(0.05);
        }
    });
    it("any change fails the no-change intent", () => {
        const c = compareStepLogs(A, B_P, { kind: "none" });
        expect(c.status).toBe("NOT_COMPARABLE");
        expect(c.intentCheck!.reasons.join()).toMatch(/unexpected_change:roll_p/);
        expect(c.axes.every((x) => x.delta === null)).toBe(true);
    });
});

describe("one expected change", () => {
    const cmp = compareStepLogs(A, B_P, { kind: "group", group: "p" });
    it("P changed, nothing else: compared, and the delta shows the larger overshoot", () => {
        expect(cmp.status).toBe("COMPARED");
        expect(cmp.intentCheck!.changed.map((r) => r.id)).toEqual(["roll_p"]);
        const roll = cmp.axes.find((x) => x.axis === "roll" && x.thresholdDegS === 80)!;
        expect(roll.delta!.overshoot.delta!).toBeGreaterThan(0.08);
        // and it exceeds the spread of the no-change control
        const spread = controlSpread(compareStepLogs(A, B_SAME, { kind: "none" })).find(
            (s) => s.axis === "roll" && s.thresholdDegS === 80,
        )!;
        expect(roll.delta!.overshoot.delta!).toBeGreaterThan(spread.overshoot * 2);
    });
    it("the wrong group: the expected change is missing and P is an extra change", () => {
        const c = compareStepLogs(A, B_P, { kind: "group", group: "d" });
        expect(c.intentCheck!.reasons).toEqual(["expected_change_missing:d", "extra_change:roll_p"]);
        expect(c.status).toBe("NOT_COMPARABLE");
    });
});

describe("an extra change", () => {
    it("P and feedforward changed while P was intended: no delta, the extra change is named", () => {
        const b = flight({ seed: 4, startUs: 11_000_000, headers: { rollPID: "45,79,30", ff_weight: "30,32,22" } });
        const c = compareStepLogs(A, b, { kind: "group", group: "p" });
        expect(c.status).toBe("NOT_COMPARABLE");
        expect(c.intentCheck!.reasons).toEqual(["extra_change:ff_weight"]);
        const cell = c.axes.find((x) => x.axis === "pitch" && x.thresholdDegS === 40)!;
        expect(cell.delta).toBeNull();
        expect(cell.noDeltaReasons.join()).toMatch(/settings_as_intended:extra_change:ff_weight/);
        // the curves stay available
        expect(cell.a?.curve).toBeTruthy();
        expect(cell.b?.curve).toBeTruthy();
    });
});

describe("UNKNOWN is not MATCH", () => {
    it("a setting missing from one log fails both intents", () => {
        const b = { ...B_SAME, headerPairs: B_SAME.headerPairs.filter(([k]) => k !== "tpa_rate") };
        const rows = compareSettings(A.headerPairs, b.headerPairs);
        expect(rows.find((r) => r.id === "tpa_rate")!.status).toBe("UNKNOWN");
        expect(checkIntent(rows, { kind: "none" }).reasons).toEqual(["settings_unknown:tpa_rate"]);
        expect(checkIntent(rows, { kind: "group", group: "tpa" }).passed).toBe(false);
        expect(compareStepLogs(A, b, { kind: "none" }).status).toBe("NOT_COMPARABLE");
    });
    it("a group setting absent from both logs is UNKNOWN; an 'other' setting absent from both is not logged", () => {
        const strip = (l: StepLogResult) => l.headerPairs.filter(([k]) => k !== "tpa_rate" && k !== "abs_control_gain");
        const rows = compareSettings(strip(A), strip(B_SAME));
        expect(rows.find((r) => r.id === "tpa_rate")!.status).toBe("UNKNOWN");
        expect(rows.find((r) => r.id === "abs_control_gain")!.status).toBe("NOT_LOGGED");
    });
    it("d_min (Betaflight 4.5) and d_max name the same D Max setting", () => {
        const rows = compareSettings([["d_min", "37,57,0"]], [["d_min", "37,57,0"]]);
        expect(rows.find((r) => r.id === "d_max")!.status).toBe("MATCH");
    });
});

describe("not comparable measurements", () => {
    it("another craft", () => {
        const b = flight({ seed: 5, startUs: 13_000_000, headers: { DeviceUID: "0000000000000000000000bb" } });
        const c = compareStepLogs(A, b, { kind: "none" });
        expect(c.pairChecks.find((x) => x.id === "same_craft")!.status).toBe("FAIL");
    });
    it("other firmware", () => {
        const b = analyzeStepFile(
            acroLog({
                seconds: 20,
                seed: 6,
                startUs: 15_000_000,
                firmwareRevision: "Betaflight 2026.6.1 (other) STM32F7X2",
            }),
            "fw.bbl",
            "shafw",
        )[0];
        expect(compareStepLogs(A, b, { kind: "none" }).pairChecks.find((x) => x.id === "same_firmware")!.status).toBe(
            "FAIL",
        );
    });
    it("another logging rate", () => {
        const b = flight({ seed: 7, startUs: 17_000_000, dtUs: 500 });
        const c = compareStepLogs(A, b, { kind: "none" });
        expect(c.pairChecks.find((x) => x.id === "same_logging_rate")!.status).toBe("FAIL");
    });
    it("excitation not comparable: much larger stick moves in B", () => {
        const big = analyzeStepFile(acroLog({ seconds: 20, seed: 8, startUs: 19_000_000 }), "x.bbl", "shabig")[0];
        // A's moves are 120–300 deg/s; give A small ones instead
        const small = analyzeStepFile(
            acroLog({ seconds: 20, seed: 9, startUs: 21_000_000, headers: {} }),
            "y.bbl",
            "shasmall",
        )[0];
        const roll = (l: StepLogResult) => l.axes.roll!.thresholds[1];
        const scaled = {
            ...small,
            axes: {
                ...small.axes,
                roll: {
                    ...small.axes.roll!,
                    thresholds: small.axes.roll!.thresholds.map((t) => ({
                        ...t,
                        excitation: t.excitation && {
                            ...t.excitation,
                            medianPeakDegS: t.excitation.medianPeakDegS / 3,
                        },
                    })),
                },
            },
        };
        const c = compareStepLogs(scaled, big, { kind: "none" });
        const cell = c.axes.find((x) => x.axis === "roll" && x.thresholdDegS === 80)!;
        expect(cell.checks.find((x) => x.id === "comparable_excitation")!.status).toBe("FAIL");
        expect(cell.delta).toBeNull();
        expect(roll(big).status).toBe("MEASURED");
    });
    it("MEASURED against INSUFFICIENT: no delta for that axis, with the reason", () => {
        const b = flight({ seed: 10, startUs: 23_000_000, seconds: 4 } as AcroLogOptions);
        const c = compareStepLogs(A, b, { kind: "none" });
        const cell = c.axes.find((x) => x.axis === "yaw" && x.thresholdDegS === 80)!;
        expect(cell.delta).toBeNull();
        expect(cell.noDeltaReasons.join()).toMatch(/both_measured:MEASURED \/ INSUFFICIENT/);
    });
});

describe("the same flight never is A and B", () => {
    it("the same log: NOT_COMPARABLE", () => {
        expect(compareStepLogs(A, A, { kind: "none" }).pairChecks[0].detail).toBe("ab_same_flight_selected:same_log");
    });
    it("a flight imported twice (another file): flightRelation SAME, no delta", () => {
        const bytes = acroLog({ seconds: 20, seed: 1, startUs: 4_000_000, noise: 0.1, plant: PLANT });
        const copy = analyzeStepFile(concatLogs(acroLog({ seconds: 5, seed: 99 }), bytes), "copy.bbl", "shacopy")[1];
        const c = compareStepLogs(A, copy, { kind: "none" });
        const ind = c.pairChecks.find((x) => x.id === "independent_flights")!;
        expect(ind.status).toBe("FAIL");
        expect(ind.detail).toMatch(/^ab_same_flight_selected/);
        expect(c.axes.every((x) => x.delta === null)).toBe(true);
    });
});

describe("store: imports in memory, selection over unique flights", () => {
    beforeEach(() => setActivePinia(createPinia()));
    it("a flight carried by two files is offered once; one log cannot be A and B", async () => {
        const store = useStepResponseStore();
        const f1 = acroLog({ seconds: 20, seed: 1, startUs: 4_000_000 });
        const f2 = concatLogs(acroLog({ seconds: 5, seed: 99, flags: 3 }), f1);
        await store.addFile(f1, "one.bbl");
        await store.addFile(f1, "one-again.bbl"); // the same bytes: kept once
        await store.addFile(f2, "two.bbl");
        await store.analyzePending();
        expect(store.files).toHaveLength(2);
        const dup = store.options.filter((o) => o.reasons.includes("duplicate_flight_of_another_import"));
        expect(dup).toHaveLength(1);
        const first = store.options.find((o) => o.selectable)!;
        store.select("a", first.key);
        store.select("b", first.key);
        expect(store.selection.b).toBeNull();
        store.select("b", dup[0].key);
        expect(store.selection.b).toBeNull();
    });
});
