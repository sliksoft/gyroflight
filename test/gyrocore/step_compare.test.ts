/*
 * Step-response A/B (src/gyrocore/stepResponse/stepCompare.ts, stepSettings.ts, stores/stepResponse.ts):
 * the same tune, one expected change, an extra change, UNKNOWN, not comparable, a flight imported twice.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { analyzeStepFile, type StepLogResult } from "@/gyrocore/stepResponse/stepLog";
import { compareStepLogs, controlSpread } from "@/gyrocore/stepResponse/stepCompare";
import {
    checkIntent,
    compareSettings,
    GROUP_SETTINGS,
    NOT_COMPARED_KEYS,
    SETTING_GROUPS,
} from "@/gyrocore/stepResponse/stepSettings";
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
    it("a setting absent from both logs is not logged (the firmware has none): no UNKNOWN, the A/B stays possible", () => {
        const strip = (l: StepLogResult) => l.headerPairs.filter(([k]) => k !== "tpa_rate" && k !== "abs_control_gain");
        const rows = compareSettings(strip(A), strip(B_SAME));
        expect(rows.find((r) => r.id === "tpa_rate")!.status).toBe("NOT_LOGGED");
        expect(rows.find((r) => r.id === "abs_control_gain")!.status).toBe("NOT_LOGGED");
        expect(checkIntent(rows, { kind: "none" }).passed).toBe(true);
        // a group whose settings this firmware does not log cannot be the intended change
        const tpaGone = (l: StepLogResult) => l.headerPairs.filter(([k]) => !k.startsWith("tpa_"));
        expect(
            checkIntent(compareSettings(tpaGone(A), tpaGone(B_SAME)), { kind: "group", group: "tpa" }).reasons,
        ).toEqual(["expected_change_missing:tpa"]);
    });
    it("fail closed: a difference in any logged setting outside the lists fails 'no change'", () => {
        const yawHold = flight({ seed: 31, startUs: 31_000_000, headers: { feedforward_yaw_hold_gain: "20" } });
        const base = flight({ seed: 32, startUs: 33_000_000, headers: { feedforward_yaw_hold_gain: "15" } });
        const c = compareStepLogs(base, yawHold, { kind: "none" });
        expect(c.intentCheck!.reasons).toEqual(["unexpected_change:feedforward_yaw_hold_gain"]);
        expect(compareStepLogs(base, yawHold, { kind: "group", group: "feedforward" }).intentCheck!.passed).toBe(true);
        const rows = compareSettings([["some_new_setting", "1"]], [["some_new_setting", "2"]]);
        expect(rows.find((r) => r.id === "some_new_setting")).toMatchObject({ group: "other", status: "DIFF" });
        expect(compareSettings([["some_new_setting", "1"]], []).find((r) => r.id === "some_new_setting")!.status).toBe(
            "UNKNOWN",
        );
    });
    it("compared after Grok r4: the active FF cutoff, the link rate and the vbat keys", () => {
        for (const [key, va, vb] of [
            ["rc_smoothing_active_cutoffs_ff_sp_thr", "106,106", "53,53"],
            ["rc_smoothing_rx_smoothed", "250", "500"],
            ["vbatcellvoltage", "310,330,440", "300,330,440"],
            ["vbat_scale", "110", "115"],
        ] as const) {
            const rows = compareSettings([[key, va]], [[key, vb]]);
            expect(rows.find((r) => r.id === key)!.status).toBe("DIFF");
        }
    });
    it("link-derived cutoffs: jitter within 5 % on one link matches, a link change is a difference", () => {
        const st = (va: string, vb: string) =>
            compareSettings(
                [["rc_smoothing_active_cutoffs_ff_sp_thr", va]],
                [["rc_smoothing_active_cutoffs_ff_sp_thr", vb]],
            ).find((r) => r.id === "rc_smoothing_active_cutoffs_ff_sp_thr")!.status;
        expect(st("106,106", "107,107")).toBe("MATCH");
        expect(st("53,53", "106,106")).toBe("DIFF");
        // other settings stay exact
        expect(
            compareSettings([["iterm_windup", "80"]], [["iterm_windup", "81"]]).find((r) => r.id === "iterm_windup")!
                .status,
        ).toBe("DIFF");
    });
    it("vbatref is the battery voltage at arming (flight state), not a setting: not compared", () => {
        expect(
            compareSettings([["vbatref", "418"]], [["vbatref", "377"]]).find((r) => r.id === "vbatref"),
        ).toBeUndefined();
    });
    it("a key logged twice with different values is UNKNOWN, never MATCH", () => {
        const rows = compareSettings(
            [
                ["tpa_rate", "60"],
                ["tpa_rate", "70"],
                ["iterm_windup", "80"],
                ["iterm_windup", "85"],
            ],
            [
                ["tpa_rate", "60"],
                ["iterm_windup", "80"],
            ],
        );
        expect(rows.find((r) => r.id === "tpa_rate")).toMatchObject({ status: "UNKNOWN", a: "duplicate_key_conflict" });
        expect(rows.find((r) => r.id === "iterm_windup")!.status).toBe("UNKNOWN");
        const same = compareSettings(
            [
                ["tpa_rate", "60"],
                ["tpa_rate", "60"],
            ],
            [["tpa_rate", "60"]],
        );
        expect(same.find((r) => r.id === "tpa_rate")!.status).toBe("MATCH");
    });
    it("no key of a selectable group is ever excluded from the comparison", () => {
        for (const group of SETTING_GROUPS) {
            for (const def of GROUP_SETTINGS[group]) {
                for (const key of [def.key, ...(def.aliases ?? [])]) {
                    expect(
                        NOT_COMPARED_KEYS.some((k) => (typeof k === "string" ? k === key : k.test(key))),
                        key,
                    ).toBe(false);
                }
            }
        }
    });
    it("motor_poles and dshot_bidir count as 'other' (they also drive dynamic idle)", () => {
        for (const [key, va, vb] of [
            ["dshot_bidir", "1", "0"],
            ["motor_poles", "12", "14"],
        ] as const) {
            expect(compareSettings([[key, va]], [[key, vb]]).find((r) => r.id === key)).toMatchObject({
                group: "other",
                status: "DIFF",
            });
        }
    });
    it("a log with both d_max and its alias d_min is ambiguous: UNKNOWN", () => {
        const rows = compareSettings(
            [
                ["d_max", "40,0,0"],
                ["d_min", "20,0,0"],
            ],
            [["d_max", "40,0,0"]],
        );
        expect(rows.find((r) => r.id === "d_max")).toMatchObject({ status: "UNKNOWN", a: "duplicate_key_conflict" });
    });
    it("link tolerance: rx_smoothed too, the 5 % boundary, and empty or non-decimal elements compare exactly", () => {
        const st = (key: string, va: string, vb: string) =>
            compareSettings([[key, va]], [[key, vb]]).find((r) => r.id === key)!.status;
        expect(st("rc_smoothing_rx_smoothed", "250", "245")).toBe("MATCH");
        expect(st("rc_smoothing_rx_smoothed", "125", "250")).toBe("DIFF");
        expect(st("rc_smoothing_active_cutoffs_ff_sp_thr", "100,100", "105,100")).toBe("MATCH");
        expect(st("rc_smoothing_active_cutoffs_ff_sp_thr", "100,100", "106,100")).toBe("DIFF");
        expect(st("rc_smoothing_active_cutoffs_ff_sp_thr", "106,", "106,0")).toBe("DIFF");
        expect(st("rc_smoothing_rx_smoothed", "", "0")).toBe("DIFF");
        expect(st("rc_smoothing_rx_smoothed", "0x6A", "106")).toBe("DIFF");
        expect(st("rc_smoothing_active_cutoffs_ff_sp_thr", "106,106", "106")).toBe("DIFF");
    });
    it("identity, logging, measurement, derived and self-level-only keys are not compared", () => {
        const rows = compareSettings(
            [
                ["Craft name", "A"],
                ["debug_mode", "96"],
                ["chirp_time_seconds", "20"],
                ["simplified_i_gain", "80"],
                ["levelPID", "90,75,75"],
            ],
            [
                ["Craft name", "B"],
                ["debug_mode", "6"],
                ["chirp_time_seconds", "30"],
                ["simplified_i_gain", "90"],
                ["levelPID", "70,70,75"],
            ],
        );
        expect(rows.filter((r) => r.status === "DIFF")).toEqual([]);
    });
    it("d_min (Betaflight 4.5) and d_max name the same D Max setting", () => {
        const rows = compareSettings([["d_min", "37,57,0"]], [["d_min", "37,57,0"]]);
        expect(rows.find((r) => r.id === "d_max")!.status).toBe("MATCH");
    });
});

describe("battery state during the used windows (Grok r6/r7)", () => {
    const battery = (c: ReturnType<typeof compareStepLogs>, axis = "roll", thr = 80) =>
        c.axes
            .find((x) => x.axis === axis && x.thresholdDegS === thr)!
            .checks.find((x) => x.id === "comparable_battery")!;
    it("a voltage more than 5 % apart fails comparable_battery; within 5 % passes", () => {
        const fresh = flight({ seed: 41, startUs: 41_000_000, vbat: 420 });
        const close = flight({ seed: 42, startUs: 43_000_000, vbat: 405 });
        const sagging = flight({ seed: 43, startUs: 45_000_000, vbat: 370 });
        expect(fresh.battery.medianInFlight).toBe(420);
        expect(fresh.axes.roll!.thresholds[1].batteryMedian).toBe(420);
        expect(battery(compareStepLogs(fresh, close, { kind: "none" })).status).toBe("PASS");
        const c = compareStepLogs(fresh, sagging, { kind: "none" });
        expect(battery(c).status).toBe("FAIL");
        expect(c.axes.every((x) => x.delta === null)).toBe(true);
    });
    it("the check is symmetric: A and B swapped give the same verdict", () => {
        // 400 vs 421: the old one-sided ratio gave 5.25 % one way (FAIL) and 4.99 % the other (PASS)
        const a = flight({ seed: 44, startUs: 47_000_000, vbat: 400 });
        const b = flight({ seed: 45, startUs: 49_000_000, vbat: 421 });
        expect(battery(compareStepLogs(a, b, { kind: "none" })).status).toBe("PASS");
        expect(battery(compareStepLogs(a, b, { kind: "none" })).status).toBe(
            battery(compareStepLogs(b, a, { kind: "none" })).status,
        );
    });
    it("the voltage of the used windows counts, not the median of the whole flight", () => {
        // The same flight with two batteries: equal whole-flight median, but the manoeuvres fall on 420 in A and 380 in B.
        const a = flight({ seed: 46, startUs: 51_000_000, vbat: 420 });
        const b = flight({ seed: 47, startUs: 53_000_000, vbat: 380 });
        const sameWholeFlight = { ...b, battery: { medianInFlight: a.battery.medianInFlight } };
        expect(battery(compareStepLogs(a, sameWholeFlight, { kind: "none" })).status).toBe("FAIL");
    });
    it("battery voltage not logged: unknown, FAIL, and no delta", () => {
        const strip = (l: StepLogResult): StepLogResult => ({
            ...l,
            axes: Object.fromEntries(
                Object.entries(l.axes).map(([k, v]) => [
                    k,
                    { ...v!, thresholds: v!.thresholds.map((t) => ({ ...t, batteryMedian: null })) },
                ]),
            ),
        });
        const c = compareStepLogs(A, strip(B_SAME), { kind: "none" });
        expect(battery(c)).toMatchObject({ status: "FAIL", detail: "battery_voltage_unknown" });
        expect(c.axes.every((x) => x.delta === null)).toBe(true);
    });
    it("a logging key repeated with different values fails same_logging_rate", () => {
        const b = { ...B_SAME, headerPairs: [...B_SAME.headerPairs, ["P ratio", "64"] as const] };
        expect(
            compareStepLogs(A, b, { kind: "none" }).pairChecks.find((x) => x.id === "same_logging_rate")!.status,
        ).toBe("FAIL");
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
    it("a file added while the analysis runs is analysed too (Grok r1 SHOULD-FIX-2)", async () => {
        const store = useStepResponseStore();
        await store.addFile(acroLog({ seconds: 10, seed: 1 }), "first.bbl");
        const running = store.analyzePending();
        expect(store.analyzing).toBe(true);
        await store.addFile(acroLog({ seconds: 10, seed: 2, startUs: 9_000_000 }), "second.bbl");
        // the card's watch calls again; while a pass runs that call returns at once
        const refused = store.analyzePending();
        await refused;
        await running;
        expect(store.pending).toBe(false);
        expect(store.files.every((f) => f.logs)).toBe(true);
    });
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
