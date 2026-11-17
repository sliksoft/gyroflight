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
 * Step-response A/B of two flights (docs/gyrocore/STEP_RESPONSE.md §5). Diagnosis only: a delta
 * here is a measured difference between two flights, never a tune, a Verified Tune or an Apply.
 *
 * A numeric delta is given for one axis and threshold only when both results are MEASURED and
 * every check passes; otherwise the curves stay visible and the failed checks are the reason.
 */

import { flightRelation } from "../engine/logInput";
import type { StepLogResult, StepAxis } from "./stepLog";
import { STEP_AXES } from "./stepLog";
import type { StepMetrics, StepThreshold, StepThresholdResult } from "./stepResponse";
import { STEP_METHOD } from "./stepResponse";
import { checkIntent, compareSettings, type AbIntent, type IntentCheck, type SettingRow } from "./stepSettings";

export const STEP_COMPARE = Object.freeze({
    /** Measured sample rates of A and B may differ by at most this fraction (FC clock drift). */
    sampleRateTolerance: 0.02,
    /** Median manoeuvre peak |setpoint| and median 100 ms change of B over A must lie in this range. */
    excitationRatio: Object.freeze([2 / 3, 3 / 2] as const),
    /** Header keys that set the logging rate; they must be equal. */
    loggingKeys: Object.freeze([
        "looptime",
        "pid_process_denom",
        "P interval",
        "P ratio",
        "I interval",
        "blackbox_high_resolution",
    ] as const),
});

export type CheckStatus = "PASS" | "FAIL";

export interface AbCheck {
    id: string;
    status: CheckStatus;
    detail: string;
}

export interface MetricDelta {
    a: number | null;
    b: number | null;
    delta: number | null;
}

export interface AxisThresholdComparison {
    axis: StepAxis;
    thresholdDegS: StepThreshold;
    a: StepThresholdResult | null;
    b: StepThresholdResult | null;
    checks: AbCheck[];
    /** Present only when both are MEASURED and every check (pair and axis) passes. */
    delta: Record<keyof StepMetrics, MetricDelta> | null;
    /** Why there is no delta (empty when there is one). */
    noDeltaReasons: string[];
}

export interface StepComparison {
    /**
     * INCOMPLETE: A or B not chosen. NOT_COMPARABLE: a pair check failed. COMPARABLE_NO_DELTA: the
     * pair checks pass but no axis and threshold has a delta (e.g. nothing MEASURED). COMPARED: at
     * least one delta.
     */
    status: "INCOMPLETE" | "NOT_COMPARABLE" | "COMPARABLE_NO_DELTA" | "COMPARED";
    pairChecks: AbCheck[];
    intent: AbIntent;
    intentCheck: IntentCheck | null;
    settings: SettingRow[];
    axes: AxisThresholdComparison[];
    authorization: { status: "NOT_AUTHORIZED"; reasons: string[] };
}

const head = (l: StepLogResult, key: string) => l.headerPairs.find(([k]) => k === key)?.[1]?.trim() ?? null;

const uidText = (l: StepLogResult) => (l.identity.uid ? l.identity.uid.join(":") : null);

function check(id: string, ok: boolean, detail: string): AbCheck {
    return { id, status: ok ? "PASS" : "FAIL", detail };
}

/** Pair-level checks: different flights, same craft, firmware and logging rate, settings as intended. */
function pairChecks(a: StepLogResult, b: StepLogResult, intentCheck: IntentCheck): AbCheck[] {
    const out: AbCheck[] = [];
    out.push(check("both_analysed", a.status === "ANALYSED" && b.status === "ANALYSED", `${a.status} / ${b.status}`));
    if (a.flight && b.flight) {
        const rel = flightRelation(a.flight, b.flight);
        out.push(
            check(
                "independent_flights",
                rel.relation === "INDEPENDENT",
                rel.relation === "SAME"
                    ? `ab_same_flight_selected:${rel.reasons.join(",")}`
                    : `${rel.relation}${rel.reasons.length ? `:${rel.reasons.join(",")}` : ""}`,
            ),
        );
    } else out.push(check("independent_flights", false, "flight_identity_missing"));
    const same = (x: string | null, y: string | null) => x !== null && y !== null && x === y;
    out.push(
        check(
            "same_craft",
            same(uidText(a), uidText(b)) && same(a.identity.board, b.identity.board),
            uidText(a) === null || uidText(b) === null
                ? "device_uid_unknown"
                : same(uidText(a), uidText(b))
                  ? "uid_and_board"
                  : "different_device",
        ),
    );
    out.push(
        check(
            "same_firmware",
            same(a.identity.firmwareRevision, b.identity.firmwareRevision),
            `${a.identity.firmwareRevision ?? "?"} / ${b.identity.firmwareRevision ?? "?"}`,
        ),
    );
    const keysOk = STEP_COMPARE.loggingKeys.every((k) => head(a, k) === head(b, k));
    const fa = a.sampleRateHz;
    const fb = b.sampleRateHz;
    const rateOk = !!fa && !!fb && Math.abs(fa / fb - 1) <= STEP_COMPARE.sampleRateTolerance;
    out.push(
        check(
            "same_logging_rate",
            keysOk && rateOk,
            `${fa ? Math.round(fa) : "?"} Hz / ${fb ? Math.round(fb) : "?"} Hz${keysOk ? "" : "; logging headers differ"}`,
        ),
    );
    out.push(
        check(
            "saturation_known",
            a.saturation === "KNOWN" && b.saturation === "KNOWN",
            `${a.saturation} / ${b.saturation}`,
        ),
    );
    out.push(check("settings_as_intended", intentCheck.passed, intentCheck.reasons.join("; ") || "ok"));
    return out;
}

/** Per axis and threshold: both MEASURED, the same flight mode, comparable excitation. */
function axisChecks(ra: StepThresholdResult | null, rb: StepThresholdResult | null): AbCheck[] {
    const out: AbCheck[] = [];
    out.push(
        check(
            "both_measured",
            ra?.status === "MEASURED" && rb?.status === "MEASURED",
            `${ra?.status ?? "—"} / ${rb?.status ?? "—"}`,
        ),
    );
    if (!ra || !rb) return out;
    const modes = (r: StepThresholdResult) => r.modeWords.join(",");
    out.push(
        check(
            "same_flight_mode",
            ra.modeWords.length > 0 && modes(ra) === modes(rb),
            `${modes(ra) || "—"} / ${modes(rb) || "—"}`,
        ),
    );
    const [lo, hi] = STEP_COMPARE.excitationRatio;
    if (ra.excitation && rb.excitation) {
        const rp = rb.excitation.medianPeakDegS / ra.excitation.medianPeakDegS;
        const rc = rb.excitation.medianChangeDegS / ra.excitation.medianChangeDegS;
        out.push(
            check(
                "comparable_excitation",
                rp >= lo && rp <= hi && rc >= lo && rc <= hi,
                `peak ×${rp.toFixed(2)}, change ×${rc.toFixed(2)}`,
            ),
        );
        // Coverage: both directions of the stick in both flights, or one direction in both.
        const dirs = (r: StepThresholdResult) =>
            `${r.excitation!.positive > 0 ? "+" : ""}${r.excitation!.negative > 0 ? "-" : ""}`;
        out.push(check("comparable_coverage", dirs(ra) === dirs(rb), `${dirs(ra)} / ${dirs(rb)}`));
    } else out.push(check("comparable_excitation", false, "no_manoeuvres"));
    return out;
}

/** A against B for every axis and threshold. `a` and `b` are embedded logs of imported files. */
export function compareStepLogs(a: StepLogResult | null, b: StepLogResult | null, intent: AbIntent): StepComparison {
    const authorization = {
        status: "NOT_AUTHORIZED" as const,
        reasons: ["step_response_ab_is_a_diagnosis_not_a_tune"],
    };
    if (!a || !b) {
        return {
            status: "INCOMPLETE",
            pairChecks: [],
            intent,
            intentCheck: null,
            settings: [],
            axes: [],
            authorization,
        };
    }
    if (a.key === b.key) {
        return {
            status: "NOT_COMPARABLE",
            pairChecks: [check("independent_flights", false, "ab_same_flight_selected:same_log")],
            intent,
            intentCheck: null,
            settings: [],
            axes: [],
            authorization,
        };
    }
    const settings = compareSettings(a.headerPairs, b.headerPairs);
    const intentCheck = checkIntent(settings, intent);
    const pc = pairChecks(a, b, intentCheck);
    const pairOk = pc.every((c) => c.status === "PASS");
    const axes: AxisThresholdComparison[] = [];
    for (const axis of STEP_AXES) {
        for (const thr of STEP_METHOD.thresholdsDegS) {
            const ra = a.axes[axis]?.thresholds.find((t) => t.thresholdDegS === thr) ?? null;
            const rb = b.axes[axis]?.thresholds.find((t) => t.thresholdDegS === thr) ?? null;
            const checks = axisChecks(ra, rb);
            const failed = [...pc, ...checks].filter((c) => c.status === "FAIL");
            let delta: AxisThresholdComparison["delta"] = null;
            if (!failed.length && ra?.metrics && rb?.metrics) {
                const d = (k: keyof StepMetrics): MetricDelta => {
                    const x = ra.metrics![k];
                    const y = rb.metrics![k];
                    return { a: x, b: y, delta: x === null || y === null ? null : y - x };
                };
                delta = {
                    overshoot: d("overshoot"),
                    peakTimeMs: d("peakTimeMs"),
                    t50Ms: d("t50Ms"),
                    finalValue: d("finalValue"),
                };
            }
            axes.push({
                axis,
                thresholdDegS: thr,
                a: ra,
                b: rb,
                checks,
                delta,
                noDeltaReasons: delta ? [] : failed.map((c) => `${c.id}:${c.detail}`),
            });
        }
    }
    return {
        status: !pairOk ? "NOT_COMPARABLE" : axes.some((x) => x.delta) ? "COMPARED" : "COMPARABLE_NO_DELTA",
        pairChecks: pc,
        intent,
        intentCheck,
        settings,
        axes,
        authorization,
    };
}

/** For a no-change control pair: the per-metric spread the flights show between themselves. */
export function controlSpread(cmp: StepComparison): {
    axis: StepAxis;
    thresholdDegS: number;
    overshoot: number;
    t50Ms: number | null;
    peakTimeMs: number;
    finalValue: number;
}[] {
    if (cmp.intent.kind !== "none") return [];
    return cmp.axes
        .filter((x) => x.delta)
        .map((x) => ({
            axis: x.axis,
            thresholdDegS: x.thresholdDegS,
            overshoot: Math.abs(x.delta!.overshoot.delta!),
            t50Ms: x.delta!.t50Ms.delta === null ? null : Math.abs(x.delta!.t50Ms.delta),
            peakTimeMs: Math.abs(x.delta!.peakTimeMs.delta!),
            finalValue: Math.abs(x.delta!.finalValue.delta!),
        }));
}
