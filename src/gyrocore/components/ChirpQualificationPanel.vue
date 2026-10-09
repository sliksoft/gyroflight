<template>
    <UiBox
        v-if="report"
        :title="$t('gyrocoreChirpTitle')"
        type="neutral"
        collapsible
        data-gyrocore="chirp-qualification"
    >
        <p class="text-sm text-dimmed mb-2">{{ $t("gyrocoreChirpIntro") }}</p>

        <div class="flex items-center gap-3 mb-3" :data-state="report.state">
            <UBadge :color="stateColor(report.state)" variant="solid" size="lg" data-gyrocore="overall-state">
                {{ stateLabel(report.state) }}
            </UBadge>
            <span class="text-sm">{{ stateText }}</span>
        </div>

        <p
            v-if="diagnosticAxes.length"
            class="text-sm font-bold text-orange-500 mb-3"
            role="alert"
            data-gyrocore="diagnostic-only"
        >
            {{ diagnosticMessage }}
        </p>

        <ul v-for="log in report.logs" :key="log.logIndex" class="text-sm">
            <li v-if="log.error" class="text-dimmed" :data-log="log.logIndex">
                {{ logLine("gyrocoreChirpLogError", log.logIndex, log.error) }}
            </li>
            <li v-else-if="!log.measurements.length" class="text-dimmed" :data-log="log.logIndex">
                {{ logLine("gyrocoreChirpLogNoChirp", log.logIndex) }}
            </li>
        </ul>

        <div v-if="report.measurements.length" class="overflow-x-auto">
            <table class="autotune-table w-full" data-gyrocore="measurements">
                <thead>
                    <tr>
                        <th scope="col">{{ $t("gyrocoreChirpColShown") }}</th>
                        <th scope="col">{{ $t("gyrocoreChirpColLog") }}</th>
                        <th scope="col">{{ $t("gyrocoreChirpColAxis") }}</th>
                        <th scope="col">{{ $t("gyrocoreChirpColTime") }}</th>
                        <th scope="col">{{ $t("gyrocoreChirpColSamples") }}</th>
                        <th scope="col">{{ $t("gyrocoreChirpColRate") }}</th>
                        <th scope="col">{{ $t("gyrocoreChirpColCoherence") }}</th>
                        <th scope="col">{{ $t("gyrocoreChirpColState") }}</th>
                        <th scope="col">{{ $t("gyrocoreChirpColApply") }}</th>
                        <th scope="col">{{ $t("gyrocoreChirpReasons") }}</th>
                    </tr>
                </thead>
                <tbody>
                    <tr
                        v-for="m in report.measurements"
                        :key="m.id"
                        :data-measurement="m.id"
                        :data-state="m.state"
                        :data-apply="m.apply.allowed ? 'allowed' : 'blocked'"
                    >
                        <td>
                            <input
                                type="radio"
                                :name="`gyrocore-chirp-${m.axisName}`"
                                :checked="gate.selection[m.axisName] === m.id"
                                :disabled="!m.diagnostics"
                                :aria-label="`${m.id}`"
                                @change="gate.selectMeasurement(m.id)"
                            />
                        </td>
                        <td>{{ m.logIndex + 1 }}</td>
                        <td>{{ axisLabel(m.axisName) }} #{{ m.axisOccurrence }}</td>
                        <td>{{ seconds(m.startTimeUs) }}–{{ seconds(m.endTimeUs) }} ({{ m.durationS.toFixed(2) }})</td>
                        <td>{{ m.sampleCount }}</td>
                        <td>{{ m.sampleRate.effectiveRateHz ? Math.round(m.sampleRate.effectiveRateHz) : "--" }}</td>
                        <td>{{ coherence(m.quality.meanBandCoherence) }}</td>
                        <td>
                            <UBadge :color="stateColor(m.state)" variant="subtle">{{ stateLabel(m.state) }}</UBadge>
                            <div v-if="m.state === 'rejected' && m.diagnostics" class="text-[10px] text-dimmed">
                                {{ $t("gyrocoreChirpDiagnosticOnly") }}
                            </div>
                        </td>
                        <td :class="m.apply.allowed ? 'text-green-500 font-bold' : 'text-red-500 font-bold'">
                            {{ $t(m.apply.allowed ? "gyrocoreChirpApplyAllowed" : "gyrocoreChirpApplyBlocked") }}
                        </td>
                        <td>
                            <ul class="list-disc ps-4">
                                <li v-for="code in m.apply.blocked" :key="code" :data-reason="code">
                                    {{ describeReason(code, m) }}
                                </li>
                            </ul>
                            <ul v-if="m.apply.warnings.length" class="list-disc ps-4 text-dimmed">
                                <li v-for="code in m.apply.warnings" :key="code" :data-warning="code">
                                    {{ describeReason(code, m) }}
                                </li>
                            </ul>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
    </UiBox>
</template>

<script setup lang="ts">
import { computed } from "vue";
import UiBox from "@/components/elements/UiBox.vue";
import { i18n } from "@/js/localization";
import type { QualificationState } from "@/gyrocore/chirp/qualification";
import { describeReason } from "@/gyrocore/chirp/reasons";
import { useChirpQualificationStore } from "@/gyrocore/stores/chirpQualification";

const gate = useChirpQualificationStore();

const report = computed(() => {
    void gate.revision;
    return gate.report;
});

const STATE_KEYS: Record<QualificationState, [string, string]> = {
    no_chirp: ["gyrocoreChirpStateNoChirp", "gyrocoreChirpStateNoChirpText"],
    rejected: ["gyrocoreChirpStateRejected", "gyrocoreChirpStateRejectedText"],
    usable_with_warnings: ["gyrocoreChirpStateWarn", "gyrocoreChirpStateWarnText"],
    usable: ["gyrocoreChirpStateUsable", "gyrocoreChirpStateUsableText"],
};

const AXIS_LABEL_KEYS = { roll: "autotuneAxisRoll", pitch: "autotuneAxisPitch", yaw: "autotuneAxisYaw" } as const;

function stateLabel(state: QualificationState) {
    return i18n.getMessage(STATE_KEYS[state][0]);
}

function stateColor(state: QualificationState) {
    if (state === "usable") {
        return "success" as const;
    }
    if (state === "usable_with_warnings") {
        return "warning" as const;
    }
    return state === "rejected" ? ("error" as const) : ("neutral" as const);
}

function axisLabel(axis: keyof typeof AXIS_LABEL_KEYS) {
    return i18n.getMessage(AXIS_LABEL_KEYS[axis]);
}

function logLine(key: string, logIndex: number, detail = "") {
    return i18n.getMessage(key, [String(logIndex + 1), detail]);
}

function seconds(us: number) {
    return Number.isFinite(us) ? (us / 1e6).toFixed(2) : "--";
}

function coherence(v: number | null) {
    return v === null || !Number.isFinite(v) ? "--" : v.toFixed(2);
}

const stateText = computed(() =>
    report.value ? i18n.getMessage(STATE_KEYS[report.value.state][1], [report.value.logCount]) : "",
);

// Axes whose plots show a measurement GyroCore rejected.
const diagnosticAxes = computed(() =>
    Object.entries(gate.selectedMeasurements)
        .filter(([, m]) => m?.state === "rejected" && m.diagnostics)
        .map(([axis, m]) => `${axisLabel(axis as keyof typeof AXIS_LABEL_KEYS)} (${m?.id})`),
);

const diagnosticMessage = computed(() =>
    i18n.getMessage("gyrocoreChirpDiagnosticAxes", [diagnosticAxes.value.join(", ")]),
);
</script>
