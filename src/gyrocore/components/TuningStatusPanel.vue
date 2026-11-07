<template>
    <UiBox
        :title="$t('gyroflightTuningStatusTitle')"
        type="neutral"
        data-gyrocore="tuning-status"
        :data-status="status"
    >
        <p v-if="status === 'not_calculated'" class="text-sm text-dimmed" data-gyrocore="tuning-status-not-calculated">
            {{ $t("gyroflightTuningStatusNotCalculated") }}
            <UButton
                size="xs"
                variant="link"
                class="p-0 ms-1"
                data-gyrocore="tuning-status-open-overview"
                @click="emit('open', 'overview')"
            >
                {{ $t("gyroflightAutotuneCompareOpenOverview") }}
            </UButton>
        </p>
        <template v-else>
            <p class="flex flex-wrap items-center gap-2">
                <UBadge :color="statusColor" variant="solid" data-gyrocore="tuning-status-badge">
                    {{ $t(`gyroflightTuningStatus_${status}`) }}
                </UBadge>
                <span class="text-sm">{{ $t(`gyroflightTuningStatusText_${status}`) }}</span>
            </p>

            <!-- Per axis without a value: the main reason in one sentence. -->
            <ul v-if="missingAxes.length" class="text-sm list-disc ps-5 mt-2" data-gyrocore="tuning-status-reasons">
                <li v-for="r in missingAxes" :key="r.axis" :data-axis="r.axis" :data-kind="r.kind">
                    <span class="font-bold">{{ axisLabel(r.axis) }}:</span> {{ r.summary }}
                </li>
            </ul>
            <p v-if="missingAxes.length" class="text-sm mt-1">
                <UButton
                    size="xs"
                    variant="link"
                    class="p-0 me-3"
                    data-gyrocore="tuning-status-open-technical"
                    @click="emit('open', 'technical')"
                >
                    {{ $t("gyroflightTuningStatusOpenTechnical") }}
                </UButton>
                <UButton
                    size="xs"
                    variant="link"
                    class="p-0"
                    data-gyrocore="tuning-status-open-plan"
                    @click="emit('open', 'plan')"
                >
                    {{ $t("gyroflightOverviewOpen_plan") }}
                </UButton>
            </p>

            <!-- Current and proposed side by side, per route; the routes below keep their own tables and checks. -->
            <div v-if="rows.length" class="overflow-x-auto max-w-full mt-2">
                <table class="gyroflight-workflow-table text-sm" data-gyrocore="tuning-status-values">
                    <thead>
                        <tr>
                            <th>{{ $t("gyroflightCompareSetting") }}</th>
                            <th>{{ $t("gyroflightCompareCurrent") }}</th>
                            <th>{{ $t("gyroflightCompareProposed") }}</th>
                            <th>{{ $t("gyroflightTuningStatusRoute") }}</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="r in rows" :key="`${r.route}-${r.key}`" :data-route="r.route" :data-item="r.key">
                            <td>{{ r.label }}</td>
                            <td>{{ r.from }}</td>
                            <td class="font-bold">{{ r.to }}</td>
                            <td :class="r.route === 'absolute' ? 'text-green-500' : 'text-yellow-500'">
                                {{ $t(`gyroflightTuningRouteName_${r.route}`) }}
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <p class="text-sm text-dimmed mt-2">{{ $t("gyroflightTuningStatusRoutesHelp") }}</p>
        </template>
    </UiBox>
</template>

<script setup lang="ts">
/*
 * Tuning and apply, first: is there a proposal (available, partly, not), the main reason per axis,
 * and current against proposed values per route. It reads the engine v2 result and the slider
 * composite; it computes nothing and gates nothing. Each route below keeps its own checks.
 */
import { computed } from "vue";
import UiBox from "@/components/elements/UiBox.vue";
import { i18n } from "@/js/localization";
import { useAutotuneV2Store } from "@/gyrocore/stores/autotuneV2";
import { useChirpQualificationStore } from "@/gyrocore/stores/chirpQualification";
import { axisDecisionTexts, type Axis } from "@/gyroflight/autotune/axisDecision";
import type { AutotuneSection } from "@/gyroflight/autotune/sections";

const emit = defineEmits<{ open: [section: AutotuneSection] }>();

const v2 = useAutotuneV2Store();
const gate = useChirpQualificationStore();

const t = (key: string, params?: (string | number)[]) => i18n.getMessage(key, params?.map(String));
const axisLabel = (axis: Axis) => t(`autotuneAxis${axis[0].toUpperCase()}${axis.slice(1)}`);
const ofAxis = (key: string, axis: Axis) => key.endsWith(`_${axis}`);

const released = computed(() => v2.result?.releasableProposal?.items ?? []);
const experimental = computed(() => v2.result?.experimental?.items ?? []);
const composite = computed(() => {
    void gate.revision;
    return gate.composite;
});
const sliderAuthorized = computed(() => !!composite.value?.authorized);

/** Axes whose PID got no value on any engine v2 route, with the recording plan's reason. */
const missingAxes = computed(() =>
    axisDecisionTexts(v2.result, t).filter(
        (r) =>
            r.kind !== "candidate" && ![...released.value, ...experimental.value].some((it) => ofAxis(it.key, r.axis)),
    ),
);

/**
 * not_calculated: engine v2 has no result. available: a releasable (VALIDATED) proposal and no axis
 * without a value. partial: some value on some route (experimental, slider, or a releasable one with
 * axes left out). none: no value on any route.
 */
const status = computed(() => {
    if (!v2.result) return "not_calculated";
    const any = released.value.length > 0 || experimental.value.length > 0 || sliderAuthorized.value;
    if (!any) return "none";
    return released.value.length > 0 && !missingAxes.value.length ? "available" : "partial";
});
const statusColor = computed(() =>
    status.value === "available" ? "success" : status.value === "partial" ? "warning" : "error",
);

const SLIDER_LABEL_KEYS: Record<string, string> = {
    slider_master_multiplier: "autotuneSliderMasterMultiplier",
    slider_pi_gain: "autotuneSliderPIGain",
    slider_i_gain: "autotuneSliderIGain",
    slider_d_gain: "autotuneSliderDGain",
    slider_feedforward_gain: "autotuneSliderFeedforward",
    slider_dterm_filter_multiplier: "autotuneSliderDTermFilter",
};

const rows = computed(() => [
    ...released.value.map((it) => ({ route: "absolute", key: it.key, label: it.key, from: it.from, to: it.to })),
    ...experimental.value.map((it) => ({
        route: "experimental",
        key: it.key,
        label: it.key,
        from: it.from,
        to: it.to,
    })),
    ...(sliderAuthorized.value
        ? (composite.value?.sliders ?? []).map((s) => ({
              route: "slider",
              key: s.key,
              label: t(SLIDER_LABEL_KEYS[s.key] ?? s.key),
              from: s.current ?? "--",
              to: s.final ?? "--",
          }))
        : []),
]);
</script>
