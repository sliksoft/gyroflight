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
                        <p class="text-sm text-dimmed mt-3" data-gyroflight="autotune-graphs-bode-help">
                            {{ $t("gyroflightGraphsBodeHelp") }}
                        </p>
                        <!-- Gyroflight: rejected measurements are plotted as diagnostics only (right above the plots) -->
                        <DiagnosticOnlyBanner />
                        <BodePlot />
                        <p class="text-sm text-dimmed mt-3" data-gyroflight="autotune-graphs-spectrogram-help">
                            {{ $t("gyroflightGraphsSpectrogramHelp") }}
                        </p>
                        <SpectrogramPlot />
                        <!-- Gyroflight: the per-axis slider calculation sits with the plots it is read from -->
                        <p
                            class="text-sm font-bold mt-3 rounded-md border border-default p-2"
                            data-gyroflight="autotune-graphs-gain-note"
                        >
                            {{ $t("gyroflightGraphsGainNote") }}
                        </p>
                        <GainRecommendation />
                    </template>
                    <p v-else class="text-sm text-dimmed mt-3" data-gyroflight="autotune-needs-import">
                        {{ $t("gyroflightAutotuneNeedsImport") }}
                    </p>
                </template>

                <template v-else-if="active === 'tuning'">
                    <!-- Gyroflight: first whether there is a proposal, then the three routes, each with its own checks -->
                    <TuningStatusPanel @open="sections.open" />
                    <template v-if="v2.result">
                        <h3 class="text-base font-bold mt-3" data-gyrocore="route-heading" data-route="absolute">
                            {{ $t("gyroflightTuningRouteHeading_absolute") }}
                        </h3>
                        <AutotuneV2Panel
                            :title="$t('gyroflightAutotuneTuningV2Title')"
                            :parts="['parts', 'compare', 'apply']"
                        />
                        <h3 class="text-base font-bold mt-3" data-gyrocore="route-heading" data-route="experimental">
                            {{ $t("gyroflightTuningRouteHeading_experimental") }}
                        </h3>
                        <AutotuneV2Panel
                            :title="$t('gyroflightAutotuneTuningExperimentalTitle')"
                            :parts="['experimental']"
                        />
                    </template>
                    <AutotuneV2Panel
                        :title="$t('gyroflightAutotuneTuningVerifyTitle')"
                        :parts="['verify', 'restore']"
                    />
                    <!-- Gyroflight: the slider route (global tune, workflow); folded when the log's slider mode is off -->
                    <SliderRoutePanel>
                        <!-- Gyroflight: the one global slider set Apply may write -->
                        <GlobalTunePanel v-if="store.analysisState === 'done' && store.analysisResult" />
                        <!-- Gyroflight: analyze -> calculate -> compare -> apply -> verify -> restore (sliders) -->
                        <TuneWorkflowPanel />
                    </SliderRoutePanel>
                </template>

                <template v-else-if="active === 'compare'">
                    <p class="text-sm text-dimmed mt-3">{{ $t("gyroflightAutotuneCompareHelp") }}</p>
                    <!-- Gyroflight: 1. the imported logs (this browser) apart from the saved Tune Sessions (this device) -->
                    <AutotuneV2Panel :title="$t('gyroflightAutotuneCompareLogsTitle')" :parts="['sources']" />
                    <UButton
                        size="xs"
                        variant="link"
                        class="p-0 self-start"
                        data-gyroflight="autotune-compare-open-overview"
                        @click="sections.open('overview')"
                    >
                        {{ $t("gyroflightAutotuneCompareOpenOverview") }}
                    </UButton>
                    <!-- Gyroflight: saved session, Flight A/B, comparability and the diagnostic comparison (no tuning) -->
                    <FlightAbSelector />
                    <AutotuneV2Panel
                        :title="$t('gyroflightAutotuneCompareV2Title')"
                        :parts="['verifiedTune', 'multi']"
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
                    <template v-if="v2.result">
                        <AutotuneV2Panel :title="$t('gyroflightTechnicalMarginsTitle')" :parts="['margins']" />
                        <AutotuneV2Panel
                            v-if="Object.keys(v2.result.candidateDecisions ?? {}).length"
                            :title="$t('gyroflightTechnicalSearchesTitle')"
                            :parts="['decisions']"
                        />
                        <AutotuneV2Panel
                            v-if="v2.result.jio"
                            :title="$t('gyroflightTechnicalJioTitle')"
                            :parts="['jio']"
                        />
                        <AutotuneV2Panel
                            v-if="v2.result.jio"
                            :title="$t('gyroflightTechnicalSetTitle')"
                            :parts="['jioSet']"
                        />
                        <AutotuneV2Panel
                            v-if="v2.result.jio"
                            :title="$t('gyroflightTechnicalPlotsTitle')"
                            :parts="['jioPlots']"
                        />
                        <AutotuneV2Panel
                            v-if="v2.qualification"
                            :title="$t('gyroflightTechnicalQualificationTitle')"
                            :parts="['qualification']"
                        />
                    </template>
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
import TuningStatusPanel from "@/gyrocore/components/TuningStatusPanel.vue";
import SliderRoutePanel from "@/gyrocore/components/SliderRoutePanel.vue";
import { AUTOTUNE_SECTION_ICONS, useAutotuneSectionStore } from "@/gyroflight/autotune/sections";
import { useAutotuneStore } from "@/stores/autotune";
import { useAutotuneV2Store } from "@/gyrocore/stores/autotuneV2";

const store = useAutotuneStore();
const v2 = useAutotuneV2Store();
const sections = useAutotuneSectionStore();
const active = computed(() => sections.active);
</script>
