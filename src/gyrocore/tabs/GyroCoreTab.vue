<template>
    <BaseTab tab-name="gyrocore">
        <div class="content_wrapper">
            <div class="tab_title">{{ $t("gyrocoreTabTitle") }}</div>
            <p class="text-sm text-muted">{{ $t("gyrocoreParentBrand") }}</p>
            <p>{{ $t("gyrocoreIntro") }}</p>
            <div class="grid-row grid-box col2">
                <UiBox :title="$t('gyrocoreCapabilitiesHead')" type="neutral">
                    <ul>
                        <li
                            v-for="cap in capabilities"
                            :key="cap.key"
                            :data-capability="cap.key"
                            class="flex items-center gap-2"
                        >
                            <UIcon
                                :name="cap.available ? 'i-lucide-check-circle' : 'i-lucide-clock'"
                                class="size-4 shrink-0"
                            />
                            {{ $t(cap.label) }} —
                            {{ $t(cap.available ? "gyrocoreStatusAvailable" : "gyrocoreStatusPending") }}
                        </li>
                    </ul>
                </UiBox>
                <UiBox :title="$t('gyrocoreAttributionHead')" type="neutral">
                    <p>{{ $t("gyrocoreAttribution") }}</p>
                    <ul>
                        <li>
                            <a href="https://github.com/sliksoft/gyrocore-app" target="_blank" rel="noopener">{{
                                $t("gyrocoreSourceLink")
                            }}</a>
                        </li>
                        <li>
                            <a
                                href="https://github.com/betaflight/betaflight-configurator"
                                target="_blank"
                                rel="noopener"
                                >{{ $t("gyrocoreUpstreamLink") }}</a
                            >
                        </li>
                    </ul>
                </UiBox>
            </div>
        </div>
    </BaseTab>
</template>

<script setup lang="ts">
import BaseTab from "@/components/tabs/BaseTab.vue";
import UiBox from "@/components/elements/UiBox.vue";
import { gyrocoreCapabilities as capabilities } from "../capabilities";
</script>
