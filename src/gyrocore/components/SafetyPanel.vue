<template>
    <UiBox v-if="gate.report" :title="$t('gyrocoreSafetyTitle')" type="neutral" collapsible data-gyrocore="safety">
        <div class="flex items-center gap-3 mb-2">
            <UBadge
                :color="safety.status === 'PASS' ? 'success' : safety.status === 'WARN' ? 'warning' : 'error'"
                variant="solid"
                data-gyrocore="safety-status"
                :data-status="safety.status"
            >
                {{ $t(`gyrocoreSafetyStatus_${safety.status}`) }}
            </UBadge>
            <span v-if="safety.compositeId" class="text-sm text-dimmed">{{ safety.compositeId }}</span>
        </div>

        <p v-if="safety.status === 'NOT_EVALUATED'" class="text-sm" data-gyrocore="safety-not-evaluated">
            {{ $t("gyrocoreSafetyNotEvaluated") }}
        </p>
        <p v-else-if="safety.analysisEvidence === 'not_available'" class="text-sm" data-gyrocore="safety-no-analysis">
            {{ $t("gyrocoreSafetyNoAnalysis") }}
        </p>

        <div v-if="rows.length" class="overflow-x-auto">
            <table class="autotune-table w-full" data-gyrocore="safety-values">
                <thead>
                    <tr>
                        <th scope="col"></th>
                        <th scope="col">{{ $t("gyrocoreSafetyCurrent") }}</th>
                        <th scope="col">{{ $t("gyrocoreSafetyProposed") }}</th>
                        <th scope="col">{{ $t("gyrocoreSafetyDelta") }}</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="row in rows" :key="row.key" :data-field="row.key">
                        <td class="font-bold text-dimmed">{{ row.key }}</td>
                        <td>{{ row.current ?? "--" }}</td>
                        <td>{{ row.proposed ?? "--" }}</td>
                        <td :class="row.delta ? 'font-bold' : 'text-dimmed'">{{ row.deltaText }}</td>
                    </tr>
                </tbody>
            </table>
        </div>

        <div v-if="safety.blocks.length" class="text-sm mt-2" data-gyrocore="safety-blocked">
            <p class="font-bold text-red-500">{{ $t("gyrocoreSafetyBlocked") }}</p>
            <ul class="list-disc ps-5">
                <li v-for="code in safety.blocks" :key="code" :data-reason="code">
                    {{ describeSafetyReason(code) }}
                </li>
            </ul>
        </div>
        <div v-if="safety.warnings.length" class="text-sm mt-2 text-dimmed" data-gyrocore="safety-warnings">
            <p class="font-bold">{{ $t("gyrocoreChirpWarnings") }}</p>
            <ul class="list-disc ps-5">
                <li v-for="code in safety.warnings" :key="code" :data-warning="code">
                    {{ describeSafetyReason(code) }}
                </li>
            </ul>
        </div>
    </UiBox>
</template>

<script setup lang="ts">
import { computed } from "vue";
import UiBox from "@/components/elements/UiBox.vue";
import { useChirpQualificationStore } from "@/gyrocore/stores/chirpQualification";
import { useApplyGate } from "@/gyrocore/composables/useApplyGate";
import { describeSafetyReason } from "@/gyrocore/safety/reasons";
import { AXES, FILTER_FIELDS, PID_FIELDS } from "@/gyrocore/safety/simplifiedTuning";
import { isPresent, type TuneValue } from "@/gyrocore/safety/absolute";

const gate = useChirpQualificationStore();
const { safety } = useApplyGate();

const value = (tv: TuneValue | undefined) => (tv && isPresent(tv) ? (tv.value as number) : null);

/** Current vs proposed absolute values; rows where nothing is known are left out. */
const rows = computed(() => {
    const s = safety.value;
    if (!s.current) {
        return [];
    }
    const keys = [
        ...AXES.flatMap((a) => PID_FIELDS.map((f) => [`${a}.${f}`, s.current![a][f], s.proposed?.[a][f]] as const)),
        ...(["dterm", "gyro"] as const).flatMap((p) =>
            FILTER_FIELDS.map((f) => [`${p}.${f}`, s.current![p][f], s.proposed?.[p][f]] as const),
        ),
    ];
    return keys
        .map(([key, cur, prop]) => {
            const d = s.deltas[key];
            return {
                key,
                current: value(cur),
                proposed: value(prop),
                delta: d?.delta ?? 0,
                deltaText: d ? `${d.delta > 0 ? "+" : ""}${d.delta}` : "--",
            };
        })
        .filter((r) => r.current !== null || r.proposed !== null);
});
</script>
