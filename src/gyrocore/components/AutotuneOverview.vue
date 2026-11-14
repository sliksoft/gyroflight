<template>
    <UiBox :title="$t('gyroflightOverviewTitle')" type="neutral" data-gyrocore="autotune-overview">
        <!-- The flight this overview reads: once calculated, the primary flight the engine used. -->
        <p v-if="!filename" class="text-sm text-dimmed" data-gyrocore="overview-no-log">
            {{ $t("gyroflightOverviewNoLog") }}
        </p>
        <div v-else class="flex flex-wrap gap-x-6 gap-y-1 text-sm" data-gyrocore="overview-flight">
            <span v-if="primary" data-gyrocore="overview-primary-flight">
                <span class="text-dimmed">{{ $t("gyroflightOverviewPrimaryFlight") }}: </span>
                <span class="font-bold break-all">{{ primary.file ?? "--" }}</span>
                <span v-if="(primary.report?.logCount ?? 1) > 1">
                    · {{ t("gyrocoreChirpLog", [primary.logIndex + 1]) }}</span
                >
            </span>
            <span v-else>
                <span class="text-dimmed">{{ $t("gyroflightOverviewFlight") }}: </span>
                <span class="font-bold break-all">{{ filename }}</span>
            </span>
            <span v-if="shownReport">
                <span class="text-dimmed">{{ $t("gyroflightOverviewChirp") }}: </span>
                {{ t("gyroflightOverviewChirpCount", [shownReport.measurements.length, shownReport.logCount]) }}
            </span>
            <span v-if="v2.sources.length > 1" data-gyrocore="overview-sources">
                <span class="text-dimmed">{{ $t("gyroflightOverviewSources") }}: </span>
                {{ v2.sources.length }}
            </span>
            <!-- CHIRP quality and Graphs show the file selected there: named when it is not the primary. -->
            <span v-if="shownElsewhere" class="basis-full text-dimmed" data-gyrocore="overview-shown-elsewhere">
                {{ t("gyroflightOverviewShownElsewhere", [shownElsewhere]) }}
            </span>
        </div>

        <p class="text-sm text-dimmed mt-2">{{ $t("gyroflightOverviewColumnsHelp") }}</p>
        <div class="overflow-x-auto max-w-full [&_td.text-dimmed]:[overflow-wrap:anywhere]">
            <table class="gyroflight-workflow-table text-sm w-full" data-gyrocore="overview-axes">
                <thead>
                    <tr>
                        <th>{{ $t("gyroflightV2Axis") }}</th>
                        <th>{{ $t("gyroflightOverviewMeasurement") }}</th>
                        <th>{{ $t("gyroflightOverviewTuning") }}</th>
                        <th>{{ $t("gyroflightOverviewApply") }}</th>
                    </tr>
                </thead>
                <tbody>
                    <tr
                        v-for="row in rows"
                        :key="row.axis"
                        :data-axis="row.axis"
                        :data-measurement="row.measurement.state"
                        :data-tuning="row.tuning.state"
                        :data-apply="row.apply.state"
                    >
                        <td class="font-bold">{{ axisLabel(row.axis) }}</td>
                        <td>
                            <span :class="row.measurement.cls" class="font-bold">{{ row.measurement.label }}</span>
                            <span v-if="row.measurement.detail" class="block text-dimmed">{{
                                row.measurement.detail
                            }}</span>
                        </td>
                        <td>
                            <span :class="row.tuning.cls" class="font-bold">{{ row.tuning.label }}</span>
                            <span v-if="row.tuning.detail" class="block text-dimmed">{{ row.tuning.detail }}</span>
                        </td>
                        <td>
                            <span :class="row.apply.cls" class="font-bold">{{ row.apply.label }}</span>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>

        <!-- A usable measurement is not yet a proposal: two separate assessments. -->
        <p class="text-sm mt-2 rounded-md border border-default p-2" data-gyrocore="overview-two-assessments">
            {{ $t("gyroflightOverviewTwoAssessments") }}
        </p>

        <!-- Per axis: why there is (no) proposal in one sentence, the next step, and the deciding check behind a toggle. -->
        <template v-if="result">
            <p class="text-sm font-bold mt-3">{{ $t("gyroflightOverviewReasonTitle") }}</p>
            <ul class="text-sm flex flex-col gap-2" data-gyrocore="overview-reasons">
                <li v-for="r in reasons" :key="r.axis" :data-axis="r.axis" :data-kind="r.kind">
                    <span class="font-bold">{{ axisLabel(r.axis) }}:</span>
                    {{ r.summary }}
                    <span v-if="r.next" class="block">
                        <span class="text-dimmed">{{ $t("gyroflightOverviewNext") }}:</span>
                        {{ r.next }}
                        <UButton
                            v-if="r.section"
                            size="xs"
                            variant="link"
                            class="p-0 ms-1"
                            :data-gyrocore="`overview-open-${r.section}`"
                            @click="emit('open', r.section)"
                        >
                            {{ $t(`gyroflightOverviewOpen_${r.section}`) }}
                        </UButton>
                    </span>
                    <details v-if="r.technical || r.note" class="mt-0.5" data-gyrocore="overview-reason-details">
                        <summary class="cursor-pointer text-dimmed">{{ $t("gyroflightTechnicalReason") }}</summary>
                        <span v-if="r.technical" class="block [overflow-wrap:anywhere]">{{ r.technical }}</span>
                        <span v-if="r.note" class="block text-dimmed [overflow-wrap:anywhere]">{{ r.note }}</span>
                    </details>
                </li>
            </ul>
        </template>
        <p v-else-if="v2.sources.length" class="text-sm text-dimmed mt-2" data-gyrocore="overview-not-calculated">
            {{ $t("gyroflightOverviewNotCalculated") }}
        </p>
    </UiBox>
</template>

<script setup lang="ts">
/*
 * The Autotune overview: the selected flight, and per axis three separate answers: what the
 * measurement shows, what tuning it gives, and whether anything can be applied. It reads the
 * results the CHIRP qualification and Autotune v2 already computed; nothing is calculated here.
 */
import { computed } from "vue";
import UiBox from "@/components/elements/UiBox.vue";
import { i18n } from "@/js/localization";
import { useAutotuneStore } from "@/stores/autotune";
import { useChirpQualificationStore } from "@/gyrocore/stores/chirpQualification";
import { useAutotuneV2Store } from "@/gyrocore/stores/autotuneV2";
import { AXES, axisDecisionTexts, type Axis } from "@/gyroflight/autotune/axisDecision";
import type { AutotuneSection } from "@/gyroflight/autotune/sections";

const emit = defineEmits<{ open: [section: AutotuneSection] }>();

const autotune = useAutotuneStore();
const gate = useChirpQualificationStore();
const v2 = useAutotuneV2Store();

const report = computed(() => {
    void gate.revision;
    return gate.report;
});
const result = computed(() => v2.result);
const filename = computed(() => autotune.analysisResult?.filename ?? v2.sources[0]?.filename ?? null);

/**
 * The primary flight the calculation used (logInput.ts pickPrimary, named in the result): its file,
 * log and own CHIRP report. Once calculated the measurement column reads this flight, the one every
 * tuning answer rests on, not the file imported last (block 8).
 */
const primary = computed(() => {
    const ps = result.value?.primarySource;
    if (!ps) return null;
    const file = v2.inputFiles.get(ps.sha256) ?? null;
    const report = (file && v2.sources.find((s) => s.filename === file)?.report) || null;
    return { file, logIndex: ps.logIndex, report, ids: ps.measurementIds };
});
const shownReport = computed(() => primary.value?.report ?? report.value);
/** The file CHIRP quality and Graphs show, when it is not the primary flight's log. */
const shownElsewhere = computed(() => {
    const p = primary.value;
    const g = report.value;
    if (!p || !g) return "";
    if (g.filename === p.file && gate.selectedLogIndex === p.logIndex) return "";
    return g.logCount > 1 && gate.selectedLogIndex !== null
        ? `${g.filename} · ${t("gyrocoreChirpLog", [gate.selectedLogIndex + 1])}`
        : g.filename;
});

const t = (key: string, params?: (string | number)[]) => i18n.getMessage(key, params?.map(String));
const axisLabel = (axis: Axis) => t(`autotuneAxis${axis[0].toUpperCase()}${axis.slice(1)}`);
const ofAxis = (key: string, axis: Axis) => key.endsWith(`_${axis}`);
const num = (x: number | null | undefined, d: number) => (x == null || !Number.isFinite(x) ? "--" : x.toFixed(d));

const GREEN = "text-green-500";
const YELLOW = "text-yellow-500";
const RED = "text-red-500";
const DIM = "text-dimmed";

function measurementOf(axis: Axis) {
    const p = primary.value;
    const m = p ? (p.report?.measurements.find((x) => x.id === p.ids[axis]) ?? null) : gate.selectedMeasurements[axis];
    if (!m) return { state: "none", label: t("gyroflightOverviewNotMeasured"), cls: DIM, detail: "" };
    const label = {
        usable: t("gyrocoreChirpStateUsable"),
        usable_with_warnings: t("gyrocoreChirpStateWarn"),
        rejected: t("gyrocoreChirpStateRejected"),
    }[m.state];
    const cls = m.state === "usable" ? GREEN : m.state === "usable_with_warnings" ? YELLOW : RED;
    const band = result.value?.candidateDecisions[axis]?.primary?.bandHz ?? null;
    const detail = [
        `${m.id}, ${num(m.durationS, 1)} s, ${t("gyroflightOverviewCoherence")} ${num(m.quality.meanBandCoherence, 2)}`,
        band ? `${t("gyroflightOverviewBand")} ${num(band[0], 1)}–${num(band[1], 1)} Hz` : "",
    ]
        .filter(Boolean)
        .join(" · ");
    return { state: m.state, label, cls, detail };
}

function tuningOf(axis: Axis) {
    const r = result.value;
    if (!r) return { state: "not_calculated", label: t("gyroflightOverviewTuningNone"), cls: DIM, detail: "" };
    const released = r.releasableProposal?.items.filter((it) => ofAxis(it.key, axis)) ?? [];
    if (released.length) {
        return {
            state: "validated",
            label: t("gyroflightOverviewTuningValidated"),
            cls: GREEN,
            detail: released.map((it) => `${it.key} ${it.from} → ${it.to}`).join(", "),
        };
    }
    const exp = r.experimental?.items.filter((it) => ofAxis(it.key, axis)) ?? [];
    if (exp.length) {
        return {
            state: "experimental",
            label: t("gyroflightOverviewTuningExperimental"),
            cls: YELLOW,
            detail: exp.map((it) => `${it.key} ${it.from} → ${it.to}`).join(", "),
        };
    }
    const withheld = r.experimentalWithheld.filter((w) => ofAxis(w.key, axis));
    if (withheld.length) {
        // A search that ran on a usable plant and found no value is not missing information (block 8).
        const searched = r.recordingPlan?.axes.find((a) => a.axis === axis)?.kind === "search_limit";
        return {
            state: "withheld",
            label: t(searched ? "gyroflightOverviewTuningNoValueMeetsTargets" : "gyroflightOverviewTuningWithheld"),
            cls: RED,
            detail: withheld.map((w) => w.key).join(", "),
        };
    }
    return { state: "no_change", label: t("gyroflightOverviewTuningNoChange"), cls: DIM, detail: "" };
}

function applyOf(tuningState: string) {
    if (tuningState === "validated")
        return { state: "released", label: t("gyroflightOverviewApplyReleased"), cls: GREEN };
    if (tuningState === "experimental") {
        return { state: "experimental", label: t("gyroflightOverviewApplyExperimental"), cls: YELLOW };
    }
    return { state: "nothing", label: t("gyroflightOverviewApplyNothing"), cls: DIM };
}

const rows = computed(() =>
    AXES.map((axis) => {
        const tuning = tuningOf(axis);
        return { axis, measurement: measurementOf(axis), tuning, apply: applyOf(tuning.state) };
    }),
);

/** The recording plan's per-axis decision (recordingInstruction.ts), in words, with the deciding check apart. */
const reasons = computed(() => axisDecisionTexts(result.value, t));
</script>
