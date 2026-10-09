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
 * Every CHIRP measurement of the analysed file, with GyroCore's verdict on
 * each, and which ones the Autotune plots and table currently show.
 *
 * The plots and table (Betaflight components) take one measurement per axis
 * from one embedded log through the Autotune store's analysisResult; this
 * store decides which, and nothing is dropped: every log and segment stays
 * listed and selectable.
 */

import { defineStore } from "pinia";
import { computed, ref, shallowRef } from "vue";
import type { AnalysisResult, AxisGains, AxisName, AxisResult } from "@/composables/useAutotune";
import { useAutotuneStore } from "@/stores/autotune";
import { AXIS_NAMES } from "@/gyrocore/chirp/constants";
import type { ChirpMeasurement, ChirpQualificationReport } from "@/gyrocore/chirp/qualification";

export type QualifiedReport = ChirpQualificationReport<AxisGains>;
export type QualifiedMeasurement = ChirpMeasurement<AxisGains>;

/** Higher is better: what a user most likely wants shown by default. */
function rank(m: QualifiedMeasurement): number {
    if (m.apply.allowed) {
        return 4;
    }
    if (m.state === "usable") {
        return 3;
    }
    if (m.state === "usable_with_warnings") {
        return 2;
    }
    return m.diagnostics ? 1 : 0;
}

function bestOf(list: QualifiedMeasurement[]): QualifiedMeasurement | null {
    // Ties go to the later segment, as Betaflight Autotune shows the last sweep of an axis.
    let best: QualifiedMeasurement | null = null;
    for (const m of list) {
        if (!best || rank(m) >= rank(best)) {
            best = m;
        }
    }
    return best;
}

export function defaultLogIndex(report: QualifiedReport): number | null {
    let bestLog: number | null = null;
    let bestRank = -1;
    for (const log of report.logs) {
        const top = bestOf(log.measurements);
        if (top && rank(top) > bestRank) {
            bestRank = rank(top);
            bestLog = log.logIndex;
        }
    }
    return bestLog;
}

export function defaultSelection(report: QualifiedReport, logIndex: number): Record<AxisName, string | null> {
    const log = report.logs.find((l) => l.logIndex === logIndex);
    const out: Record<AxisName, string | null> = { roll: null, pitch: null, yaw: null };
    for (const axis of AXIS_NAMES) {
        out[axis] = bestOf(log?.measurements.filter((m) => m.axisName === axis) ?? [])?.id ?? null;
    }
    return out;
}

/** Betaflight's AnalysisResult for the chosen measurements; rejected ones carry no gains. */
export function toAnalysisResult(
    report: QualifiedReport,
    logIndex: number,
    selection: Record<AxisName, string | null>,
): AnalysisResult | null {
    const log = report.logs.find((l) => l.logIndex === logIndex);
    if (!log?.sysConfig || !log.currentSliders) {
        return null;
    }
    const axes: Partial<Record<AxisName, AxisResult>> = {};
    let sampleRate = 0;
    for (const axis of AXIS_NAMES) {
        const m = log.measurements.find((x) => x.id === selection[axis]);
        if (!m?.diagnostics) {
            continue;
        }
        sampleRate ||= m.sampleRate.effectiveRateHz ?? 0;
        axes[axis] = { ...m.diagnostics, gains: m.recommendation?.gains ?? null };
    }
    if (!Object.keys(axes).length) {
        return null;
    }
    return {
        filename: report.filename,
        sampleRate: Math.round(sampleRate),
        axes,
        sysConfig: log.sysConfig,
        currentSliders: log.currentSliders,
    };
}

export const useChirpQualificationStore = defineStore("gyrocoreChirpQualification", () => {
    // Shallow: the report holds large typed arrays that never change in place.
    const report = shallowRef<QualifiedReport | null>(null);
    const selectedLogIndex = ref<number | null>(null);
    const selection = ref<Record<AxisName, string | null>>({ roll: null, pitch: null, yaw: null });
    /** Bumped when recommendations are recomputed in place, so views re-read them. */
    const revision = ref(0);

    const selectedMeasurements = computed(() => {
        void revision.value;
        const out: Partial<Record<AxisName, QualifiedMeasurement>> = {};
        for (const axis of AXIS_NAMES) {
            const m = report.value?.measurements.find((x) => x.id === selection.value[axis]);
            if (m) {
                out[axis] = m;
            }
        }
        return out;
    });

    function setReport(next: QualifiedReport | null) {
        report.value = next;
        selectedLogIndex.value = next ? defaultLogIndex(next) : null;
        selection.value =
            next && selectedLogIndex.value !== null
                ? defaultSelection(next, selectedLogIndex.value)
                : { roll: null, pitch: null, yaw: null };
        revision.value++;
    }

    function selectLog(logIndex: number) {
        if (!report.value) {
            return;
        }
        selectedLogIndex.value = logIndex;
        selection.value = defaultSelection(report.value, logIndex);
        showSelection();
    }

    function selectMeasurement(id: string) {
        const m = report.value?.measurements.find((x) => x.id === id);
        if (!m) {
            return;
        }
        if (m.logIndex !== selectedLogIndex.value) {
            selectLog(m.logIndex);
        }
        selection.value = { ...selection.value, [m.axisName]: id };
        showSelection();
    }

    function analysisResult(): AnalysisResult | null {
        if (!report.value || selectedLogIndex.value === null) {
            return null;
        }
        return toAnalysisResult(report.value, selectedLogIndex.value, selection.value);
    }

    /** Hand the selected measurements to Betaflight's Autotune plots and table. */
    function showSelection() {
        useAutotuneStore().analysisResult = analysisResult();
    }

    function touch() {
        revision.value++;
    }

    function reset() {
        setReport(null);
    }

    return {
        report,
        selectedLogIndex,
        selection,
        revision,
        selectedMeasurements,
        setReport,
        selectLog,
        selectMeasurement,
        analysisResult,
        showSelection,
        touch,
        reset,
    };
});
