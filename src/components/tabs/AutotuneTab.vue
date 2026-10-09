<template>
    <BaseTab tab-name="autotune">
        <div class="content_wrapper grid-box col1">
            <!-- Import Section (always visible) -->
            <AutotuneImport />

            <!-- Gyroflight: GyroCore verdict on every CHIRP measurement (also shown when none is usable) -->
            <ChirpQualificationPanel />

            <!-- Analysis Results (visible after successful analysis) -->
            <template v-if="store.analysisState === 'done' && store.analysisResult">
                <BodePlot />
                <SpectrogramPlot />
                <GainRecommendation />
            </template>
        </div>
    </BaseTab>
</template>

<script setup lang="ts">
import BaseTab from "./BaseTab.vue";
import AutotuneImport from "./autotune/AutotuneImport.vue";
import BodePlot from "./autotune/BodePlot.vue";
import SpectrogramPlot from "./autotune/SpectrogramPlot.vue";
import GainRecommendation from "./autotune/GainRecommendation.vue";
import ChirpQualificationPanel from "@/gyrocore/components/ChirpQualificationPanel.vue";
import { useAutotuneStore } from "@/stores/autotune";

const store = useAutotuneStore();
</script>
