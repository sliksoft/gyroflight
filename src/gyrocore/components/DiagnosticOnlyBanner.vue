<template>
    <div
        v-if="axes.length"
        class="rounded border-2 border-orange-500 px-3 py-2 text-sm font-bold text-orange-500"
        role="alert"
        data-gyrocore="diagnostic-banner"
    >
        {{ message }}
    </div>
</template>

<script setup lang="ts">
// Shown directly above Betaflight's Autotune plots, outside any collapsible
// box, whenever a plotted axis is a measurement GyroCore rejected.
import { computed } from "vue";
import { i18n } from "@/js/localization";
import { useChirpQualificationStore } from "@/gyrocore/stores/chirpQualification";
import { useAutotuneStore } from "@/stores/autotune";

const AXIS_LABEL_KEYS = { roll: "autotuneAxisRoll", pitch: "autotuneAxisPitch", yaw: "autotuneAxisYaw" } as const;

const gate = useChirpQualificationStore();
const autotune = useAutotuneStore();

const axes = computed(() => {
    void gate.revision;
    const plotted = autotune.analysisResult?.axes ?? {};
    return Object.entries(gate.selectedMeasurements)
        .filter(([axis, m]) => m?.state === "rejected" && plotted[axis as keyof typeof plotted])
        .map(([axis, m]) => `${i18n.getMessage(AXIS_LABEL_KEYS[axis as keyof typeof AXIS_LABEL_KEYS])} (${m?.id})`);
});

const message = computed(() => i18n.getMessage("gyrocoreChirpDiagnosticBanner", [axes.value.join(", ")]));
</script>
