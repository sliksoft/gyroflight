<template>
    <UiBox :title="$t('gyrocoreStepTitle')" type="neutral" collapsible data-gyrocore="step-response-card">
        <p class="text-sm text-dimmed mb-1">{{ $t("gyrocoreStepIntro") }}</p>
        <p class="text-sm font-bold mb-3" role="note" data-gyrocore="step-not-a-tune">
            {{ $t("gyrocoreStepNotATune") }}
        </p>

        <!-- Imported logs -->
        <section class="mb-3" data-gyrocore="step-logs">
            <h4 class="text-sm font-bold mb-1">{{ $t("gyrocoreStepLogsHead") }}</h4>
            <p v-if="!store.files.length" class="text-sm text-dimmed" data-gyrocore="step-logs-empty">
                {{ $t("gyrocoreStepLogsEmpty") }}
            </p>
            <p v-if="store.analyzing || store.pending" class="text-sm text-dimmed" data-gyrocore="step-analyzing">
                {{ $t("gyrocoreStepAnalyzing") }}
            </p>
            <p
                v-for="f in store.files.filter((x) => x.error)"
                :key="f.sha256"
                class="text-sm text-error"
                data-gyrocore="step-file-error"
            >
                {{ t("gyrocoreStepFileError", [f.fileName, f.error ?? ""]) }}
            </p>
            <ul class="text-sm list-disc ps-5">
                <li
                    v-for="o in store.options"
                    :key="o.key"
                    :data-log="o.key"
                    :data-status="o.log.status"
                    :data-selectable="o.selectable ? 'yes' : 'no'"
                >
                    {{ logLabel(o.log) }} ·
                    <span :class="o.log.status === 'BLOCKED' ? 'text-error' : ''">{{ o.log.status }}</span>
                    <template v-if="o.log.status === 'ANALYSED'">
                        · {{ t("gyrocoreStepLogFacts", logFacts(o.log)) }}
                    </template>
                    <span v-if="o.reasons.length" class="text-error"> · {{ o.reasons.join(", ") }}</span>
                    <span v-if="o.log.notes.length" class="block text-xs text-dimmed" data-gyrocore="step-log-notes">
                        {{ o.log.notes.join(", ") }}
                    </span>
                </li>
            </ul>
            <UButton
                v-if="store.files.length"
                size="xs"
                variant="link"
                class="p-0"
                data-gyrocore="step-clear"
                @click="store.clear()"
            >
                {{ $t("gyrocoreStepClear") }}
            </UButton>
        </section>

        <!-- A/B selection -->
        <section v-if="store.options.length" class="mb-3" data-gyrocore="step-ab">
            <h4 class="text-sm font-bold mb-1">{{ $t("gyrocoreStepAbHead") }}</h4>
            <p class="text-xs text-dimmed mb-2">{{ $t("gyrocoreStepAbHelp") }}</p>
            <div class="grid gap-2 md:grid-cols-3">
                <label v-for="side in SIDES" :key="side" class="text-sm flex flex-col gap-0.5">
                    {{ $t(side === "a" ? "gyrocoreStepFlightA" : "gyrocoreStepFlightB") }}
                    <select
                        class="rounded border border-default bg-default px-1.5 py-0.5 text-sm"
                        :data-gyrocore="`step-select-${side}`"
                        :value="store.selection[side] ?? ''"
                        @change="onSelect(side, $event)"
                    >
                        <option value="">{{ $t("gyrocoreStepNone") }}</option>
                        <option
                            v-for="o in store.options"
                            :key="o.key"
                            :value="o.key"
                            :disabled="!o.selectable || o.key === store.selection[side === 'a' ? 'b' : 'a']"
                        >
                            {{ logLabel(o.log) }}
                        </option>
                    </select>
                </label>
                <label class="text-sm flex flex-col gap-0.5">
                    {{ $t("gyrocoreStepIntent") }}
                    <select
                        class="rounded border border-default bg-default px-1.5 py-0.5 text-sm"
                        data-gyrocore="step-intent"
                        :value="intentValue"
                        @change="onIntent($event)"
                    >
                        <option value="none">{{ $t("gyrocoreStepIntentNone") }}</option>
                        <option v-for="g in SETTING_GROUPS" :key="g" :value="g">
                            {{ t("gyrocoreStepIntentGroup", [$t(`gyrocoreStepGroup_${g}`)]) }}
                        </option>
                    </select>
                </label>
            </div>
        </section>

        <!-- Comparison status and pair checks -->
        <section
            v-if="cmp.status !== 'INCOMPLETE'"
            class="rounded-md border border-default p-3 mb-3"
            data-gyrocore="step-ab-status"
            :data-status="cmp.status"
        >
            <UBadge
                :color="
                    cmp.status === 'COMPARED' ? 'success' : cmp.status === 'COMPARABLE_NO_DELTA' ? 'neutral' : 'warning'
                "
                variant="subtle"
                class="mb-2"
                data-gyrocore="step-ab-badge"
            >
                {{ $t(`gyrocoreStepAb_${cmp.status}`) }}
            </UBadge>
            <table class="w-full text-xs" data-gyrocore="step-pair-checks">
                <tbody>
                    <tr v-for="c in cmp.pairChecks" :key="c.id" :data-check="c.id" :data-status="c.status">
                        <th scope="row" class="text-start font-normal text-dimmed pe-2">
                            {{ $t(`gyrocoreStepCheck_${c.id}`) }}
                        </th>
                        <td class="pe-2">
                            <UBadge :color="c.status === 'PASS' ? 'success' : 'error'" variant="outline" size="sm">{{
                                c.status
                            }}</UBadge>
                        </td>
                        <td class="break-all">{{ c.detail }}</td>
                    </tr>
                </tbody>
            </table>
            <p v-if="cmp.intentCheck?.changed.length" class="text-xs mt-2" data-gyrocore="step-changed-settings">
                {{
                    t("gyrocoreStepChanged", [
                        cmp.intentCheck.changed.map((r) => `${r.id}: ${r.a} → ${r.b}`).join("; "),
                    ])
                }}
            </p>
            <p
                v-if="cmp.intentCheck?.unknown.length"
                class="text-xs mt-1 text-warning"
                data-gyrocore="step-unknown-settings"
            >
                {{ t("gyrocoreStepUnknownSettings", [cmp.intentCheck.unknown.map((r) => r.id).join(", ")]) }}
            </p>
        </section>

        <!-- Per axis and threshold: curves, numbers, delta or the reason it is missing -->
        <template v-if="shown.length">
            <section v-for="axis in AXES" :key="axis" class="mb-3" :data-gyrocore="`step-axis-${axis}`">
                <h4 class="text-sm font-bold mb-1">{{ $t(AXIS_KEYS[axis]) }}</h4>
                <div class="grid gap-3 md:grid-cols-2">
                    <div
                        v-for="thr in THRESHOLDS"
                        :key="thr"
                        class="rounded-md border border-default p-2"
                        :data-gyrocore="`step-cell-${axis}-${thr}`"
                    >
                        <StepResponseChart
                            :id="`${axis}-${thr}`"
                            :title="t('gyrocoreStepChartTitle', [thr])"
                            :empty-text="$t('gyrocoreStepChartEmpty')"
                            :axes-text="$t('gyrocoreStepChartAxes')"
                            :series="seriesFor(axis, thr)"
                        />
                        <table class="w-full text-xs" :data-gyrocore="`step-table-${axis}-${thr}`">
                            <thead>
                                <tr class="text-dimmed">
                                    <th class="text-start font-normal"></th>
                                    <th v-for="s in shown" :key="s.side" class="text-end font-normal">{{ s.label }}</th>
                                    <th v-if="deltaOf(axis, thr)" class="text-end font-normal">Δ B−A</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr data-row="status">
                                    <th scope="row" class="text-start font-normal text-dimmed">
                                        {{ $t("gyrocoreStepStatus") }}
                                    </th>
                                    <td
                                        v-for="s in shown"
                                        :key="s.side"
                                        class="text-end"
                                        :data-side="s.side"
                                        :data-status="res(s, axis, thr)?.status ?? 'BLOCKED'"
                                    >
                                        {{ res(s, axis, thr)?.status ?? "BLOCKED" }}
                                    </td>
                                    <td v-if="deltaOf(axis, thr)"></td>
                                </tr>
                                <tr v-for="m in METRICS" :key="m.key" :data-row="m.key">
                                    <th scope="row" class="text-start font-normal text-dimmed">{{ $t(m.label) }}</th>
                                    <td v-for="s in shown" :key="s.side" class="text-end" :data-side="s.side">
                                        {{ metricText(res(s, axis, thr), m.key) }}
                                    </td>
                                    <td v-if="deltaOf(axis, thr)" class="text-end" data-side="delta">
                                        {{ deltaText(deltaOf(axis, thr)![m.key].delta, m.key) }}
                                    </td>
                                </tr>
                                <tr data-row="windows">
                                    <th scope="row" class="text-start font-normal text-dimmed">
                                        {{ $t("gyrocoreStepWindows") }}
                                    </th>
                                    <td v-for="s in shown" :key="s.side" class="text-end" :data-side="s.side">
                                        {{
                                            res(s, axis, thr)
                                                ? `${res(s, axis, thr)!.windowsUsed} / ${res(s, axis, thr)!.windowsTotal}`
                                                : "—"
                                        }}
                                    </td>
                                    <td v-if="deltaOf(axis, thr)"></td>
                                </tr>
                                <tr data-row="manoeuvres">
                                    <th scope="row" class="text-start font-normal text-dimmed">
                                        {{ $t("gyrocoreStepManoeuvres") }}
                                    </th>
                                    <td v-for="s in shown" :key="s.side" class="text-end" :data-side="s.side">
                                        {{ res(s, axis, thr)?.manoeuvres ?? "—" }}
                                    </td>
                                    <td v-if="deltaOf(axis, thr)"></td>
                                </tr>
                                <tr data-row="outliers">
                                    <th scope="row" class="text-start font-normal text-dimmed">
                                        {{ $t("gyrocoreStepOutliers") }}
                                    </th>
                                    <td v-for="s in shown" :key="s.side" class="text-end" :data-side="s.side">
                                        {{ outlierText(res(s, axis, thr)) }}
                                    </td>
                                    <td v-if="deltaOf(axis, thr)"></td>
                                </tr>
                            </tbody>
                        </table>
                        <p
                            v-if="
                                shown.some(
                                    (s) => res(s, axis, thr)?.metrics && res(s, axis, thr)?.status !== 'MEASURED',
                                )
                            "
                            class="text-xs text-dimmed mt-1"
                            :data-gyrocore="`step-indication-${axis}-${thr}`"
                        >
                            {{ t("gyrocoreStepIndicationOnly", [MIN_MANOEUVRES]) }}
                        </p>
                        <details class="text-xs mt-1" :data-gyrocore="`step-rejections-${axis}-${thr}`">
                            <summary class="cursor-pointer text-dimmed">{{ $t("gyrocoreStepRejections") }}</summary>
                            <div v-for="s in shown" :key="s.side" :data-side="s.side">
                                <span class="font-bold">{{ s.label }}:</span>
                                {{ rejectionText(res(s, axis, thr)) }}
                            </div>
                        </details>
                        <p
                            v-if="cmpCell(axis, thr) && !cmpCell(axis, thr)!.delta"
                            class="text-xs text-warning mt-1"
                            :data-gyrocore="`step-no-delta-${axis}-${thr}`"
                        >
                            {{ t("gyrocoreStepNoDelta", [cmpCell(axis, thr)!.noDeltaReasons.join("; ")]) }}
                        </p>
                    </div>
                </div>
            </section>

            <!-- What the log says about the loop: iterm_relax and feedforward -->
            <section class="text-xs mb-1" data-gyrocore="step-loop-info">
                <h4 class="text-sm font-bold mb-1">{{ $t("gyrocoreStepLoopHead") }}</h4>
                <p class="text-dimmed mb-1">{{ $t("gyrocoreStepLoopNote") }}</p>
                <p v-for="s in shown" :key="s.side" :data-side="s.side">
                    <span class="font-bold">{{ s.label }}:</span>
                    {{ t("gyrocoreStepLoopItermRelax", itermRelaxArgs(s.log)) }} ·
                    {{ t("gyrocoreStepLoopFeedforward", feedforwardArgs(s.log)) }}
                </p>
            </section>
        </template>
    </UiBox>
</template>

<script setup lang="ts">
/*
 * Step response from ordinary Acro flights (docs/gyrocore/STEP_RESPONSE.md): per axis and threshold
 * the mean curve 0–500 ms with its 25–75 % band, overshoot, peak time, t50, final value, windows,
 * manoeuvres and rejections; Flight A/B over the imported logs with the comparability checks and a
 * delta only when they all pass. Diagnosis only: nothing is saved or written.
 */
import { computed, onMounted, watch } from "vue";
import UiBox from "@/components/elements/UiBox.vue";
import { i18n } from "@/js/localization";
import StepResponseChart from "./StepResponseChart.vue";
import { useStepResponseStore } from "@/gyrocore/stores/stepResponse";
import {
    STEP_METHOD,
    STEP_WINDOW_REASONS,
    type StepMetrics,
    type StepThresholdResult,
} from "@/gyrocore/stepResponse/stepResponse";
import { STEP_AXES, type StepAxis, type StepLogResult } from "@/gyrocore/stepResponse/stepLog";
import { SETTING_GROUPS, type SettingGroup } from "@/gyrocore/stepResponse/stepSettings";

/**
 * Positional message arguments ($1, $2 …) without i18next's HTML escaping: Vue renders the result
 * as text and escapes it itself, so escaping here would show "&#x2F;" for a "/" in a file name,
 * firmware revision or reason.
 */
const t = (key: string, args: (string | number)[] = []) =>
    i18n.getMessage(key, {
        ...Object.fromEntries(args.map((a, i) => [String(i + 1), String(a)])),
        interpolation: { escapeValue: false },
    });

const store = useStepResponseStore();
const SIDES = ["a", "b"] as const;
const AXES = STEP_AXES;
const THRESHOLDS = STEP_METHOD.thresholdsDegS;
const MIN_MANOEUVRES = STEP_METHOD.minManoeuvres;
const AXIS_KEYS = { roll: "autotuneAxisRoll", pitch: "autotuneAxisPitch", yaw: "autotuneAxisYaw" } as const;
const METRICS: { key: keyof StepMetrics; label: string }[] = [
    { key: "overshoot", label: "gyrocoreStepOvershoot" },
    { key: "peakTimeMs", label: "gyrocoreStepPeakTime" },
    { key: "t50Ms", label: "gyrocoreStepT50" },
    { key: "finalValue", label: "gyrocoreStepFinal" },
];

onMounted(() => void store.analyzePending());
watch(
    () => store.files.length,
    () => void store.analyzePending(),
);

const cmp = computed(() => store.comparison);
const intentValue = computed(() => (store.intent.kind === "none" ? "none" : store.intent.group));

const byKey = (k: string | null) => (k ? (store.logs.find((l) => l.key === k) ?? null) : null);
const shown = computed(() =>
    SIDES.flatMap((side) => {
        const log = byKey(store.selection[side]);
        return log ? [{ side, log, label: side === "a" ? "A" : "B" }] : [];
    }),
);

function logLabel(l: StepLogResult): string {
    return t("gyrocoreStepLogLabel", [l.fileName, l.logNumber, l.logCount]);
}

function logFacts(l: StepLogResult): (string | number)[] {
    return [
        l.sampleRateHz ? Math.round(l.sampleRateHz) : "?",
        l.durationS.toFixed(1),
        l.seconds.airborne.toFixed(1),
        l.timestamps?.gapCount ?? "?",
        l.modesSeen.join("+") || "—",
    ];
}

function res(s: { log: StepLogResult }, axis: StepAxis, thr: number): StepThresholdResult | null {
    return s.log.axes[axis]?.thresholds.find((x) => x.thresholdDegS === thr) ?? null;
}

function seriesFor(axis: StepAxis, thr: number) {
    return shown.value.flatMap((s) => {
        const r = res(s, axis, thr);
        return r?.curve ? [{ id: s.side, label: `${s.label} (${r.status})`, curve: r.curve }] : [];
    });
}

function cmpCell(axis: StepAxis, thr: number) {
    if (cmp.value.status === "INCOMPLETE") return null;
    return cmp.value.axes.find((x) => x.axis === axis && x.thresholdDegS === thr) ?? null;
}

function deltaOf(axis: StepAxis, thr: number) {
    return cmpCell(axis, thr)?.delta ?? null;
}

/** A number from fewer than the minimum of manoeuvres is shown in brackets: an indication only. */
function metricText(r: StepThresholdResult | null, key: keyof StepMetrics): string {
    const m = r?.metrics;
    if (!m) return "—";
    const v = m[key];
    const text =
        v === null
            ? i18n.getMessage("gyrocoreStepNotReached")
            : key === "overshoot" || key === "finalValue"
              ? v.toFixed(3)
              : `${v.toFixed(1)} ms`;
    return r.status === "MEASURED" ? text : `(${text})`;
}

function deltaText(v: number | null, key: keyof StepMetrics): string {
    if (v === null) return i18n.getMessage("gyrocoreStepNotReached");
    const s = v >= 0 ? "+" : "";
    return key === "overshoot" || key === "finalValue" ? `${s}${v.toFixed(3)}` : `${s}${v.toFixed(1)} ms`;
}

function outlierText(r: StepThresholdResult | null): string {
    if (!r) return "—";
    if (!r.finalValueOutliers) return "0";
    const w = r.withoutOutliers;
    return t("gyrocoreStepOutlierDetail", [
        r.finalValueOutliers,
        w.status,
        w.manoeuvres,
        w.metrics ? w.metrics.overshoot.toFixed(3) : "—",
        w.metrics ? `${w.metrics.peakTimeMs.toFixed(1)} ms` : "—",
        w.metrics
            ? w.metrics.t50Ms === null
                ? i18n.getMessage("gyrocoreStepNotReached")
                : `${w.metrics.t50Ms.toFixed(1)} ms`
            : "—",
        w.metrics ? w.metrics.finalValue.toFixed(3) : "—",
    ]);
}

function rejectionText(r: StepThresholdResult | null): string {
    if (!r) return "—";
    const parts = STEP_WINDOW_REASONS.filter((k) => r.rejected[k]).map(
        (k) => `${i18n.getMessage(`gyrocoreStepReason_${k}`)} ${r.rejected[k]}`,
    );
    return parts.length ? parts.join(", ") : i18n.getMessage("gyrocoreStepNoRejections");
}

function itermRelaxArgs(l: StepLogResult): string[] {
    const r = l.loop.itermRelax;
    return [r.mode ?? "?", r.type ?? "?", r.cutoffHz ?? "?"];
}

function feedforwardArgs(l: StepLogResult): string[] {
    const f = l.loop.feedforward;
    return [f.weights ?? "?", f.boost ?? "?", f.smoothFactor ?? "?", l.loop.axisFLogged.every(Boolean) ? "yes" : "no"];
}

function onSelect(side: "a" | "b", e: Event) {
    const v = (e.target as HTMLSelectElement).value;
    store.select(side, v || null);
}

function onIntent(e: Event) {
    const v = (e.target as HTMLSelectElement).value;
    store.setIntent(v === "none" ? { kind: "none" } : { kind: "group", group: v as SettingGroup });
}
</script>
