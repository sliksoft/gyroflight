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
                            :data-status="cap.status"
                            class="flex items-start gap-2"
                        >
                            <UIcon :name="CAPABILITY_STATUS_ICON[cap.status]" class="size-4 shrink-0 mt-0.5" />
                            <span>
                                {{ $t(cap.label) }} — {{ $t(`gyroflightStatus_${cap.status}`) }}
                                <span v-if="cap.detail" class="block text-xs text-muted">{{ $t(cap.detail) }}</span>
                            </span>
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
import { CAPABILITY_STATUS_ICON, gyroflightCapabilities as capabilities } from "../capabilities";
</script>
