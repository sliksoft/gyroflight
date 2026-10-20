<template>
    <UiBox :title="$t('gyrocoreM4Title')" type="neutral" collapsible data-gyrocore="m4-flight-metrics">
        <p class="text-sm text-dimmed">{{ $t("gyrocoreM4Intro") }}</p>
        <p class="text-sm font-bold text-orange-500" role="note" data-gyrocore="m4-no-apply">
            {{ $t("gyrocoreM4NoApply") }}
        </p>

        <div class="flex items-center gap-3">
            <UButton size="xs" :loading="busy" :disabled="busy" data-gyrocore="m4-open" @click="m4.importAndAnalyze()">
                {{ $t("gyrocoreM4Open") }}
            </UButton>
            <span v-if="busy" class="text-sm">{{ $t("gyrocoreM4Analyzing") }} {{ m4.progressMessage }}</span>
            <span v-else-if="m4.report" class="text-sm text-dimmed" data-gyrocore="m4-file">
                {{ m4.report.filename }} ({{ m4.report.decoder }})
            </span>
        </div>

        <p v-if="m4.state === 'error'" class="text-sm font-bold text-red-500" role="alert" data-gyrocore="m4-error">
            {{ $t("gyrocoreM4Error") }}: {{ m4.errorMessage }}
        </p>

        <section
            v-for="log in m4.report?.logs ?? []"
            :key="log.logIndex"
            class="flex flex-col gap-2 text-sm"
            :data-m4-log="log.logIndex"
        >
            <h4 class="font-bold">
                {{ $t("gyrocoreM4Log") }} {{ log.logIndex + 1 }} · {{ log.firmwareRevision ?? "?" }}
            </h4>
            <p v-if="log.error" class="font-bold text-red-500" role="alert" data-gyrocore="m4-log-error">
                {{ $t("gyrocoreM4LogError") }}: {{ log.error }}
            </p>

            <div class="flex flex-wrap items-center gap-2" data-gyrocore="m4-chirp" :data-status="log.chirp.status">
                <UBadge :color="log.chirp.status === 'no_chirp' ? 'neutral' : 'warning'" variant="solid">
                    {{ $t(CHIRP_KEYS[log.chirp.status]) }}
                </UBadge>
                <span class="text-dimmed">{{ log.chirp.evidence.join(", ") }}</span>
            </div>
            <p
                v-if="log.chirp.status !== 'no_chirp'"
                class="font-bold text-orange-500"
                data-gyrocore="m4-ff-chirp-blocked"
            >
                {{ $t("gyrocoreM4FfChirpBlocked") }}
            </p>

            <p v-if="log.signals.missing.length || log.signals.missingHeaders.length" data-gyrocore="m4-missing">
                <span v-if="log.signals.missing.length" data-gyrocore="m4-missing-signals">
                    {{ $t("gyrocoreM4MissingSignals") }}: {{ log.signals.missing.join(", ") }}.
                </span>
                <span v-if="log.signals.missingHeaders.length" data-gyrocore="m4-missing-headers">
                    {{ $t("gyrocoreM4MissingHeaders") }}: {{ log.signals.missingHeaders.join(", ") }}.
                </span>
            </p>
            <p v-else class="text-dimmed" data-gyrocore="m4-missing">{{ $t("gyrocoreM4NoMissing") }}</p>
            <p v-if="log.warnings.length" class="text-dimmed" data-gyrocore="m4-warnings">
                {{ $t("gyrocoreM4Warnings") }}: {{ log.warnings.join(", ") }}
            </p>

            <template v-if="log.result">
                <p class="text-dimmed">
                    {{ log.frameCount }} frames · {{ fmt(log.durationS, 1) }} s ·
                    {{ fmt(log.result.sampleRateHz, 0) }} Hz
                </p>

                <h5 class="font-bold">{{ $t("gyrocoreM4Feedforward") }}</h5>
                <p data-gyrocore="m4-ff" :data-advice="log.result.feedforward.advice">
                    {{ log.result.feedforward.advice }} · {{ log.result.feedforward.reason }}
                </p>
                <div v-if="log.result.feedforward.axes.length" class="overflow-x-auto">
                    <table class="autotune-table w-full" data-gyrocore="m4-ff-table">
                        <thead>
                            <tr>
                                <th scope="col">{{ $t("gyrocoreM4ColAxis") }}</th>
                                <th scope="col">{{ $t("gyrocoreM4ColMeanError") }}</th>
                                <th scope="col">{{ $t("gyrocoreM4ColTracking") }}</th>
                                <th scope="col">{{ $t("gyrocoreM4ColLatency") }}</th>
                                <th scope="col">{{ $t("gyrocoreM4ColOvershoot") }}</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="a in log.result.feedforward.axes" :key="a.axis">
                                <td>{{ a.axis }}</td>
                                <td>{{ fmt(a.meanAbsError.value, 1) }}</td>
                                <td>{{ fmt(a.trackingScore.value, 1) }}</td>
                                <td>{{ fmt(a.latencyMs.value, 1) }}</td>
                                <td>{{ fmt(a.leadingEdgeOvershoot.value, 1) }}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                <h5 class="font-bold">{{ $t("gyrocoreM4DTerm") }}</h5>
                <p data-gyrocore="m4-d" :data-advice="log.result.dTerm.advice">
                    {{ log.result.dTerm.advice }} · {{ log.result.dTerm.notes.join(", ") }}
                </p>
                <div class="overflow-x-auto">
                    <table class="autotune-table w-full" data-gyrocore="m4-d-table">
                        <thead>
                            <tr>
                                <th scope="col">{{ $t("gyrocoreM4ColAxis") }}</th>
                                <th scope="col">{{ $t("gyrocoreM4ColSource") }}</th>
                                <th scope="col">{{ $t("gyrocoreM4ColVerdict") }}</th>
                                <th scope="col">{{ $t("gyrocoreM4ColWindows") }}</th>
                                <th scope="col">{{ $t("gyrocoreM4ColReliability") }}</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="a in log.result.dTerm.axes" :key="a.axis" :data-d-source="a.signalSource">
                                <td>{{ a.axis }}</td>
                                <td>{{ a.signalSource }}</td>
                                <td>{{ a.label }}</td>
                                <td>{{ a.usableWindowCount }}</td>
                                <td>{{ a.reliability }}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                <h5 class="font-bold">{{ $t("gyrocoreM4Filters") }}</h5>
                <ul class="list-disc pl-5" data-gyrocore="m4-filters">
                    <li data-filter="gyro-lpf">
                        Gyro LPF: {{ hz(log.result.filters.gyroLpf.configuredHz.lpf1) }} /
                        {{ hz(log.result.filters.gyroLpf.configuredHz.lpf2) }} ·
                        {{ log.result.filters.gyroLpf.advice }} ·
                        <span v-for="s in log.result.filters.gyroLpf.spectrum" :key="s.axis">
                            {{ s.axis }}:
                            {{
                                s.peaks
                                    .slice(0, 3)
                                    .map((p) => fmt(p.frequencyHz, 0))
                                    .join("/") || "—"
                            }}
                            Hz;
                        </span>
                    </li>
                    <li data-filter="dterm-lpf">
                        D-term LPF: {{ hz(log.result.filters.dtermLpf.configuredHz.lpf1) }} /
                        {{ hz(log.result.filters.dtermLpf.configuredHz.lpf2) }} ·
                        {{ log.result.filters.dtermLpf.advice }}
                    </li>
                    <li data-filter="rpm" :data-advice="log.result.filters.rpmFilter.advice">
                        RPM: {{ log.result.filters.rpmFilter.advice }} ·
                        {{ hz(log.result.filters.rpmFilter.estimatedFundamentalHz) }} ·
                        {{ log.result.filters.rpmFilter.notes.join(", ") }}
                    </li>
                    <li data-filter="dyn-notch" :data-advice="log.result.filters.dynamicNotch.advice">
                        Dynamic notch: {{ log.result.filters.dynamicNotch.advice }} ·
                        {{ log.result.filters.dynamicNotch.notes.join(", ") }}
                    </li>
                    <li v-for="(c, i) in log.result.filters.informationalCandidates" :key="i" class="text-dimmed">
                        {{ c.suggestion }}
                    </li>
                </ul>

                <p class="text-dimmed" data-gyrocore="m4-safety">
                    Apply: {{ log.result.m2m3Safety.applyAllowed ? "allowed" : "disabled" }} · recommendations:
                    {{ log.result.m2m3Safety.recommendationsEnabled ? "enabled" : "disabled" }} · PID validation:
                    {{ log.result.m2m3Safety.independentPidValidation }} ·
                    {{ log.result.m2m3Safety.externalBlockers.join(", ") }}
                </p>
            </template>
        </section>
    </UiBox>
</template>

<script setup lang="ts">
// GF-1 M4.1: read-only M4 report for a blackbox file. Deliberately has no
// Apply, copy-to-CLI or recommendation control.
import { computed } from "vue";
import UiBox from "@/components/elements/UiBox.vue";
import type { M4ChirpStatus } from "@/js/blackbox/m4_bbl_integration";
import { useM4FlightMetricsStore } from "@/gyrocore/stores/m4FlightMetrics";

const CHIRP_KEYS: Record<M4ChirpStatus, string> = {
    chirp: "gyrocoreM4ChirpDetected",
    no_chirp: "gyrocoreM4ChirpNone",
    unknown: "gyrocoreM4ChirpUnknown",
};

const m4 = useM4FlightMetricsStore();
const busy = computed(() => m4.state === "importing" || m4.state === "analyzing");

function fmt(v: number | null | undefined, digits: number): string {
    return typeof v === "number" && Number.isFinite(v) ? v.toFixed(digits) : "—";
}

function hz(v: number | null | undefined): string {
    return typeof v === "number" && Number.isFinite(v) ? `${v.toFixed(0)} Hz` : "—";
}
</script>
