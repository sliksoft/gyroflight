<template>
    <div v-if="gate.report">
        <UiBox :title="$t('gyrocoreGlobalTitle')" type="neutral" collapsible data-gyrocore="global-tune">
            <p class="text-sm mb-2">{{ $t("gyrocoreGlobalIntro") }}</p>

            <p v-if="!composite" class="text-sm font-bold text-red-500" data-gyrocore="global-none">
                {{ $t("gyrocoreGlobalNone") }}
            </p>

            <template v-else>
                <div class="flex items-center gap-3 mb-2" :data-composite="composite.id">
                    <UBadge
                        :color="composite.authorized ? 'success' : 'error'"
                        variant="solid"
                        data-gyrocore="global-status"
                        :data-authorized="composite.authorized ? 'yes' : 'no'"
                    >
                        {{ $t(composite.authorized ? "gyrocoreGlobalValid" : "gyrocoreGlobalNotValid") }}
                    </UBadge>
                    <span class="text-sm text-dimmed">
                        {{ logLabel }} · {{ composite.firmwareRevision ?? "--" }} · {{ composite.merge.policy_id }}
                    </span>
                </div>

                <div class="overflow-x-auto">
                    <table class="autotune-table w-full" data-gyrocore="global-sliders">
                        <thead>
                            <tr>
                                <th scope="col"></th>
                                <th scope="col">{{ $t("gyrocoreGlobalCurrent") }}</th>
                                <th v-for="axis in participating" :key="axis" scope="col">
                                    {{ axisLabel(axis) }} — {{ $t("gyrocoreGlobalEvidence") }}
                                </th>
                                <th scope="col">{{ $t("gyrocoreGlobalFinal") }}</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="s in composite.sliders" :key="s.key" :data-slider="s.key">
                                <td class="font-bold text-dimmed">{{ sliderLabel(s.key) }}</td>
                                <td class="text-dimmed">{{ s.current ?? "--" }}</td>
                                <td v-for="axis in participating" :key="axis">
                                    {{ s.perAxis[axis] ?? "--" }}
                                    <span v-if="s.requestedByAxis[axis] !== undefined" class="text-[10px] opacity-70">
                                        ({{ s.requestedByAxis[axis]?.toFixed(1) }})
                                    </span>
                                </td>
                                <td class="font-bold" :class="s.reason ? 'text-red-500' : ''" data-gyrocore="final">
                                    {{ s.final ?? "--" }}
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                <p class="text-sm font-bold mt-2">{{ $t("gyrocoreGlobalSources") }}</p>
                <ul class="list-disc ps-5 text-sm">
                    <li
                        v-for="src in composite.sources"
                        :key="src.measurementId"
                        :data-source="src.measurementId"
                        :data-role="src.role"
                    >
                        {{ src.measurementId }} · {{ axisLabel(src.axisName) }} ·
                        {{ $t(`gyrocoreGlobalRole_${src.role}`) }}
                        <span v-if="src.reasons.length" class="text-dimmed">
                            ({{ src.reasons.map((r) => describeCompositeReason(r)).join("; ") }})
                        </span>
                    </li>
                </ul>

                <p
                    class="text-sm mt-2"
                    data-gyrocore="axis-coverage"
                    :data-mode="composite.coverage.modeName"
                    :data-missing="composite.coverage.missingAxes.join(',')"
                >
                    <span class="font-bold">{{ $t("gyrocoreGlobalCoverage") }}</span>
                    {{ coverageText.mode }} · {{ coverageText.required }} · {{ coverageText.covered }}
                    <span v-if="coverageText.missing" class="text-red-500">· {{ coverageText.missing }}</span>
                </p>

                <div v-if="composite.blocked.length" class="text-sm mt-2" data-gyrocore="global-blocked">
                    <p class="font-bold text-red-500">{{ $t("gyrocoreGlobalBlocked") }}</p>
                    <ul class="list-disc ps-5">
                        <li v-for="code in composite.blocked" :key="code" :data-reason="code">
                            {{ describeCompositeReason(code) }}
                        </li>
                    </ul>
                </div>
                <div v-if="composite.warnings.length" class="text-sm mt-2 text-dimmed" data-gyrocore="global-warnings">
                    <p class="font-bold">{{ $t("gyrocoreChirpWarnings") }}</p>
                    <ul class="list-disc ps-5">
                        <li v-for="code in composite.warnings" :key="code" :data-warning="code">
                            {{ describeCompositeReason(code) }}
                        </li>
                    </ul>
                </div>
            </template>
        </UiBox>
        <!-- GyroCore Safety on this global recommendation (WU4) -->
        <SafetyPanel />
    </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import UiBox from "@/components/elements/UiBox.vue";
import SafetyPanel from "./SafetyPanel.vue";
import { i18n } from "@/js/localization";
import type { ChirpAxisName } from "@/gyrocore/chirp/constants";
import { useChirpQualificationStore } from "@/gyrocore/stores/chirpQualification";
import { describeCompositeReason } from "@/gyrocore/tuning/reasons";

const gate = useChirpQualificationStore();
const composite = computed(() => gate.composite);

const AXIS_LABEL_KEYS: Record<ChirpAxisName, string> = {
    roll: "autotuneAxisRoll",
    pitch: "autotuneAxisPitch",
    yaw: "autotuneAxisYaw",
};
const SLIDER_LABEL_KEYS: Record<string, string> = {
    slider_master_multiplier: "autotuneSliderMasterMultiplier",
    slider_pi_gain: "autotuneSliderPIGain",
    slider_i_gain: "autotuneSliderIGain",
    slider_d_gain: "autotuneSliderDGain",
    slider_feedforward_gain: "autotuneSliderFeedforward",
    slider_dterm_filter_multiplier: "autotuneSliderDTermFilter",
};

const participating = computed(() => (composite.value?.merge.participating_axes ?? []) as ChirpAxisName[]);
const logLabel = computed(() => i18n.getMessage("gyrocoreChirpLog", [String((composite.value?.logIndex ?? 0) + 1)]));

const coverageText = computed(() => {
    const c = composite.value?.coverage;
    if (!c) {
        return { mode: "", required: "", covered: "", missing: "" };
    }
    const axes = (list: ChirpAxisName[]) => list.map(axisLabel).join(", ") || "--";
    return {
        mode: i18n.getMessage("gyrocoreGlobalCoverageMode", [c.modeName]),
        required: `${i18n.getMessage("gyrocoreGlobalCoverageRequired")} ${axes(c.requiredAxes)}`,
        covered: `${i18n.getMessage("gyrocoreGlobalCoverageCovered")} ${
            c.coveredAxes.map((a) => `${axisLabel(a)} (${c.sourceByAxis[a]})`).join(", ") || "--"
        }`,
        missing: c.missingAxes.length
            ? `${i18n.getMessage("gyrocoreGlobalCoverageMissing")} ${axes(c.missingAxes)}`
            : "",
    };
});

function axisLabel(axis: ChirpAxisName) {
    return i18n.getMessage(AXIS_LABEL_KEYS[axis]);
}

function sliderLabel(key: string) {
    return i18n.getMessage(SLIDER_LABEL_KEYS[key] ?? key);
}
</script>
