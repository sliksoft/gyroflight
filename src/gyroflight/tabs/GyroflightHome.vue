<template>
    <BaseTab tab-name="landing">
        <div class="content_wrapper gyroflight-home" data-gyroflight="home">
            <header class="gyroflight-home__hero">
                <h1 class="gyroflight-home__title">{{ $t("gyroflightProductWordmark") }}</h1>
                <p class="gyroflight-home__parent">{{ $t("gyroflightParentBrand") }}</p>
                <p class="gyroflight-home__tagline">{{ $t("gyroflightHomeTagline") }}</p>
                <p class="gyroflight-home__foundation">{{ $t("gyroflightHomeBuiltOn") }}</p>
            </header>

            <div class="grid-row grid-box col2 gyroflight-home__start">
                <UiBox :title="$t('gyroflightHomeConnectHead')" type="neutral" data-gyroflight="home-connect">
                    <p>{{ $t("gyroflightHomeConnectText") }}</p>
                </UiBox>
                <UiBox :title="$t('tabBlackboxViewer')" type="neutral" data-gyroflight="home-blackbox">
                    <p>{{ $t("gyroflightHomeBlackboxText") }}</p>
                    <div class="mt-2">
                        <UButton @click="open('blackbox_viewer')">{{ $t("gyroflightHomeOpen") }}</UButton>
                    </div>
                </UiBox>
                <UiBox :title="$t('tabFirmwareFlasher')" type="neutral" data-gyroflight="home-flasher">
                    <p>{{ $t("gyroflightHomeFlasherText") }}</p>
                    <div class="mt-2">
                        <UButton @click="open('firmware_flasher')">{{ $t("gyroflightHomeOpen") }}</UButton>
                    </div>
                </UiBox>
                <UiBox :title="$t('tabAutotune')" type="neutral" data-gyroflight="home-autotune">
                    <p>{{ $t("gyroflightHomeAutotuneText") }}</p>
                    <!-- Autotune is an Expert Mode tab upstream; Home only links to it when Expert Mode is on. -->
                    <div v-if="expertMode" class="mt-2">
                        <UButton data-gyroflight="home-autotune-open" @click="open('autotune')">
                            {{ $t("gyroflightHomeOpen") }}
                        </UButton>
                    </div>
                    <p v-else class="text-sm text-muted mt-2" data-gyroflight="home-autotune-expert">
                        {{ $t("gyroflightHomeAutotuneExpert") }}
                    </p>
                </UiBox>
            </div>

            <footer class="gyroflight-home__attribution" data-gyroflight="home-attribution">
                <p>{{ $t("gyroflightHomeAttribution") }}</p>
                <p>
                    <a href="https://github.com/sliksoft/gyroflight" target="_blank" rel="noopener">{{
                        $t("gyroflightSourceLink")
                    }}</a>
                    ·
                    <a href="https://github.com/betaflight/betaflight-configurator" target="_blank" rel="noopener">{{
                        $t("gyroflightUpstreamLink")
                    }}</a>
                </p>
            </footer>
        </div>
    </BaseTab>
</template>

<script setup lang="ts">
/*
 * Gyroflight Home: replaces Betaflight's Welcome (landing) tab through the Gyroflight
 * tab-component registry (src/gyroflight/components.ts). Betaflight's LandingTab.vue is
 * left unchanged. The start areas only switch to existing tabs; Autotune keeps its
 * upstream Expert Mode requirement.
 */
import { onMounted, onUnmounted, ref } from "vue";
import BaseTab from "@/components/tabs/BaseTab.vue";
import UiBox from "@/components/elements/UiBox.vue";
import { switchTab } from "@/js/tab_switch.js";
import { sidebarItems } from "@/components/sidebar/sidebar_items.js";
import { i18n } from "@/js/localization";
import { isExpertModeEnabled } from "@/js/utils/isExpertModeEnabled";
import { EventBus } from "@/components/eventBus.js";

const expertMode = ref(isExpertModeEnabled());
const onExpertModeChange = (enabled: boolean) => {
    expertMode.value = enabled;
};

onMounted(() => {
    expertMode.value = isExpertModeEnabled();
    EventBus.$on("expert-mode-change", onExpertModeChange);
});
onUnmounted(() => EventBus.$off("expert-mode-change", onExpertModeChange));

/** Switch exactly as the sidebar entry would (its mode and label). */
function open(key: string) {
    const item = sidebarItems.find((i) => i.key === key);
    switchTab(key, item ? { mode: item.mode, label: i18n.getMessage(item.i18n) } : {});
}
</script>

<style>
.gyroflight-home__hero {
    padding: 2rem 0 1.5rem;
}
.gyroflight-home__title {
    font-size: 2.5rem;
    font-weight: 800;
    letter-spacing: 0.14em;
    line-height: 1.1;
    border-bottom: 3px solid var(--ui-primary);
    display: inline-block;
    padding-bottom: 0.25rem;
}
.gyroflight-home__parent {
    margin-top: 0.5rem;
    color: var(--ui-text-muted);
}
.gyroflight-home__tagline {
    margin-top: 1rem;
    font-size: 1.125rem;
}
.gyroflight-home__foundation {
    margin-top: 0.25rem;
    font-size: 0.875rem;
    color: var(--ui-text-muted);
}
.gyroflight-home__attribution {
    margin-top: 2rem;
    font-size: 0.8125rem;
    color: var(--ui-text-muted);
}
</style>
