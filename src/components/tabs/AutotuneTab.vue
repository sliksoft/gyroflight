<template>
    <BaseTab tab-name="autotune">
        <!-- Gyroflight: the tab is split into sections, listed in the main sidebar under Autotune; every
             section reads the one imported log and the analysis stores, so switching keeps the log and the results. -->
        <div class="content_wrapper @container">
            <div class="min-w-0 flex flex-col" data-gyroflight="autotune-section" :data-section="active">
                <h2 class="flex items-center gap-2 text-lg font-bold" data-gyroflight="autotune-section-title">
                    <UIcon :name="AUTOTUNE_SECTION_ICONS[active]" class="size-5 shrink-0" />
                    <span>{{ $t(`gyroflightAutotuneSection_${active}`) }}</span>
                </h2>
                <!-- Import Section (always visible: the log is imported once for every section) -->
                <AutotuneImport />

                <template v-if="active === 'overview'">
                    <AutotuneOverview @open="sections.open" />
                    <!-- Gyroflight autotune engine v2: the calculation (the logs are listed in Compare) -->
                    <AutotuneV2Panel :parts="['analyze']" />
                </template>

                <!-- Gyroflight: GyroCore verdict on every CHIRP measurement (also shown when none is usable) -->
                <ChirpQualificationPanel v-else-if="active === 'chirp'" />

                <template v-else-if="active === 'graphs'">
                    <template v-if="store.analysisState === 'done' && store.analysisResult">
                        <!-- Gyroflight: rejected measurements are plotted as diagnostics only -->
                        <DiagnosticOnlyBanner />
                        <BodePlot />
                        <SpectrogramPlot />
                    </template>
                    <p v-else class="text-sm text-dimmed mt-3" data-gyroflight="autotune-needs-import">
                        {{ $t("gyroflightAutotuneNeedsImport") }}
                    </p>
                </template>

                <template v-else-if="active === 'tuning'">
                    <p class="text-sm text-dimmed mt-3">{{ $t("gyroflightAutotuneTuningIntro") }}</p>
                    <!-- Gyroflight autotune engine v2: absolute PID / feedforward / filter values -->
                    <AutotuneV2Panel
                        :title="$t('gyroflightAutotuneTuningV2Title')"
                        :parts="['parts', 'compare', 'apply', 'experimental', 'decisions', 'verify', 'restore']"
                    />
                    <template v-if="store.analysisState === 'done' && store.analysisResult">
                        <!-- Gyroflight: the one global slider set Apply may write -->
                        <GlobalTunePanel />
                        <GainRecommendation />
                    </template>
                    <!-- Gyroflight: analyze -> calculate -> compare -> apply -> verify -> restore (sliders) -->
                    <TuneWorkflowPanel />
                </template>

                <template v-else-if="active === 'compare'">
                    <p class="text-sm text-dimmed mt-3">{{ $t("gyroflightAutotuneCompareHelp") }}</p>
                    <!-- Gyroflight: choose Flight A/B from a saved Tune Session (selection only, no tuning) -->
                    <FlightAbSelector />
                    <UButton
                        size="xs"
                        variant="link"
                        class="p-0 self-start"
                        data-gyroflight="autotune-compare-open-overview"
                        @click="sections.open('overview')"
                    >
                        {{ $t("gyroflightAutotuneCompareOpenOverview") }}
                    </UButton>
                    <AutotuneV2Panel
                        :title="$t('gyroflightAutotuneCompareV2Title')"
                        :parts="['sources', 'verifiedTune', 'multi']"
                    />
                </template>

                <template v-else-if="active === 'plan'">
                    <AutotuneV2Panel
                        v-if="v2.result"
                        :title="$t('gyroflightAutotunePlanTitle')"
                        :parts="['recordingPlan', 'measurementPlan']"
                    />
                    <p v-else class="text-sm text-dimmed mt-3" data-gyroflight="autotune-needs-calculate">
                        {{ $t("gyroflightAutotuneNeedsCalculate") }}
                    </p>
                </template>

                <template v-else-if="active === 'technical'">
                    <AutotuneV2Panel
                        v-if="v2.result"
                        :title="$t('gyroflightAutotuneTechnicalTitle')"
                        :parts="['margins', 'jio', 'qualification']"
                    />
                    <p v-else class="text-sm text-dimmed mt-3" data-gyroflight="autotune-needs-calculate">
                        {{ $t("gyroflightAutotuneNeedsCalculate") }}
                    </p>
                    <!-- Gyroflight GF-1 M4.1: offline FF / D-term / filter measurement of any BBL (no Apply) -->
                    <M4FlightMetricsPanel />
                </template>
            </div>
        </div>
    </BaseTab>
</template>

<script setup lang="ts">
import { computed } from "vue";
import BaseTab from "./BaseTab.vue";
import AutotuneImport from "./autotune/AutotuneImport.vue";
import BodePlot from "./autotune/BodePlot.vue";
import SpectrogramPlot from "./autotune/SpectrogramPlot.vue";
import GainRecommendation from "./autotune/GainRecommendation.vue";
import ChirpQualificationPanel from "@/gyrocore/components/ChirpQualificationPanel.vue";
import DiagnosticOnlyBanner from "@/gyrocore/components/DiagnosticOnlyBanner.vue";
import GlobalTunePanel from "@/gyrocore/components/GlobalTunePanel.vue";
import FlightAbSelector from "@/gyrocore/components/FlightAbSelector.vue";
import M4FlightMetricsPanel from "@/gyrocore/components/M4FlightMetricsPanel.vue";
import TuneWorkflowPanel from "@/gyrocore/components/TuneWorkflowPanel.vue";
import AutotuneV2Panel from "@/gyrocore/components/AutotuneV2Panel.vue";
import AutotuneOverview from "@/gyrocore/components/AutotuneOverview.vue";
import { AUTOTUNE_SECTION_ICONS, useAutotuneSectionStore } from "@/gyroflight/autotune/sections";
import { useAutotuneStore } from "@/stores/autotune";
import { useAutotuneV2Store } from "@/gyrocore/stores/autotuneV2";

const store = useAutotuneStore();
const v2 = useAutotuneV2Store();
const sections = useAutotuneSectionStore();
const active = computed(() => sections.active);
</script>
