<template>
    <BaseTab tab-name="gyroflight">
        <div class="content_wrapper">
            <div class="tab_title">{{ $t("gyroflightTabTitle") }}</div>
            <p class="text-sm text-muted">{{ $t("gyroflightParentBrand") }}</p>
            <p>{{ $t("gyroflightIntro") }}</p>
            <div class="grid-row grid-box col2">
                <UiBox :title="$t('gyroflightCapabilitiesHead')" type="neutral">
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
                            {{ $t(cap.available ? "gyroflightStatusAvailable" : "gyroflightStatusPending") }}
                        </li>
                    </ul>
                </UiBox>
                <UiBox :title="$t('gyroflightAttributionHead')" type="neutral">
                    <p>{{ $t("gyroflightAttribution") }}</p>
                    <ul>
                        <li>
                            <a href="https://github.com/sliksoft/gyroflight" target="_blank" rel="noopener">{{
                                $t("gyroflightSourceLink")
                            }}</a>
                        </li>
                        <li>
                            <a
                                href="https://github.com/betaflight/betaflight-configurator"
                                target="_blank"
                                rel="noopener"
                                >{{ $t("gyroflightUpstreamLink") }}</a
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
import { gyroflightCapabilities as capabilities } from "../capabilities";
</script>
