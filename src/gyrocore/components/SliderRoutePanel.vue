<template>
    <section class="mt-3" data-gyrocore="slider-route" :data-mode="modeName ?? 'unknown'">
        <h3 class="text-base font-bold" data-gyrocore="route-heading" data-route="slider">
            {{ $t("gyroflightTuningRouteHeading_slider") }}
        </h3>
        <!-- Slider mode off in the log: the route does not apply to this flight; everything stays one click away. -->
        <template v-if="modeOff">
            <p class="text-sm rounded-md border border-default p-2" data-gyrocore="slider-route-off">
                {{ $t("gyroflightSliderRouteOff") }}
            </p>
            <details class="mt-2" data-gyrocore="slider-route-details">
                <summary class="cursor-pointer text-sm font-bold">{{ $t("gyroflightSliderRouteShow") }}</summary>
                <slot />
            </details>
        </template>
        <template v-else>
            <p class="text-sm text-dimmed">{{ $t("gyroflightSliderRouteIntro") }}</p>
            <slot />
        </template>
    </section>
</template>

<script setup lang="ts">
/*
 * The slider route (global tune, slider workflow) of Tuning and apply. When the log says the
 * simplified (slider) PID mode is off, the route is folded behind a toggle with the reason; its
 * panels, checks and buttons are the same either way.
 */
import { computed } from "vue";
import { useChirpQualificationStore } from "@/gyrocore/stores/chirpQualification";

const gate = useChirpQualificationStore();
const modeName = computed(() => {
    void gate.revision;
    return gate.composite?.coverage.modeName ?? null;
});
const modeOff = computed(() => modeName.value === "OFF");
</script>
