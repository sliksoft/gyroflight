<template>
    <BaseTab tab-name="autotune">
        <div class="content_wrapper grid-box col1">
            <!-- Import Section (always visible) -->
            <AutotuneImport />

            <!-- Gyroflight: GyroCore verdict on every CHIRP measurement (also shown when none is usable) -->
            <ChirpQualificationPanel />

            <!-- Gyroflight: choose Flight A/B from a saved Tune Session (selection only, no tuning) -->
            <FlightAbSelector />

            <!-- Analysis Results (visible after successful analysis) -->
            <template v-if="store.analysisState === 'done' && store.analysisResult">
                <!-- Gyroflight: rejected measurements are plotted as diagnostics only -->
                <DiagnosticOnlyBanner />
                <BodePlot />
                <SpectrogramPlot />
                <!-- Gyroflight: the one global slider set Apply may write -->
                <GlobalTunePanel />
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
import DiagnosticOnlyBanner from "@/gyrocore/components/DiagnosticOnlyBanner.vue";
import GlobalTunePanel from "@/gyrocore/components/GlobalTunePanel.vue";
import FlightAbSelector from "@/gyrocore/components/FlightAbSelector.vue";
import { useAutotuneStore } from "@/stores/autotune";

const store = useAutotuneStore();
</script>
