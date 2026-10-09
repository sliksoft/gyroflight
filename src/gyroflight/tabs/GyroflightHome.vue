<template>
    <BaseTab tab-name="landing">
        <div class="content_wrapper gyroflight-home" data-gyroflight="home">
            <div class="gyroflight-home__inner">
                <header class="gyroflight-home__hero" data-gyroflight="home-hero">
                    <h1 class="sr-only">{{ $t("gyroflightProductName") }}</h1>
                    <GyroflightLogo variant="hero" />
                    <p class="gyroflight-home__tagline">{{ $t("gyroflightHomeTagline") }}</p>
                    <p class="gyroflight-home__foundation">{{ $t("gyroflightHomeBuiltOn") }}</p>
                </header>

                <div class="gyroflight-home__cards" data-gyroflight="home-cards">
                    <UiBox :title="$t('gyroflightHomeConnectHead')" type="neutral" data-gyroflight="home-connect">
                        <p>{{ $t("gyroflightHomeConnectText") }}</p>
                    </UiBox>
                    <UiBox :title="$t('tabBlackboxViewer')" type="neutral" data-gyroflight="home-blackbox">
                        <p>{{ $t("gyroflightHomeBlackboxText") }}</p>
                        <div class="gyroflight-home__action">
                            <UButton @click="open('blackbox_viewer')">{{ $t("gyroflightHomeOpen") }}</UButton>
                        </div>
                    </UiBox>
                    <UiBox :title="$t('tabFirmwareFlasher')" type="neutral" data-gyroflight="home-flasher">
                        <p>{{ $t("gyroflightHomeFlasherText") }}</p>
                        <div class="gyroflight-home__action">
                            <UButton @click="open('firmware_flasher')">{{ $t("gyroflightHomeOpen") }}</UButton>
                        </div>
                    </UiBox>
                    <UiBox :title="$t('tabAutotune')" type="neutral" data-gyroflight="home-autotune">
                        <p>{{ $t("gyroflightHomeAutotuneText") }}</p>
                        <!-- Autotune is an Expert Mode tab upstream; Home only links to it when Expert Mode is on. -->
                        <div v-if="expertMode" class="gyroflight-home__action">
                            <UButton data-gyroflight="home-autotune-open" @click="open('autotune')">
                                {{ $t("gyroflightHomeOpen") }}
                            </UButton>
                        </div>
                        <p
                            v-else
                            class="gyroflight-home__action text-sm text-muted"
                            data-gyroflight="home-autotune-expert"
                        >
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
                        <a
                            href="https://github.com/betaflight/betaflight-configurator"
                            target="_blank"
                            rel="noopener"
                            >{{ $t("gyroflightUpstreamLink") }}</a
                        >
                    </p>
                </footer>
            </div>
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
import GyroflightLogo from "../branding/GyroflightLogo.vue";
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
/* Upstream styles .tab-landing as a flex row (LandingTab.vue): let Home take the full content width. */
.tab-landing > .gyroflight-home {
    flex: 1 1 auto;
    min-width: 0;
}

/* One centred column inside the content area, whatever the window width. */
.gyroflight-home__inner {
    width: 100%;
    max-width: 60rem;
    margin: 0 auto;
    padding: 1.5rem 0 2rem;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 1.75rem;
}

.gyroflight-home__hero {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 0.5rem;
}
.gyroflight-home__tagline {
    margin-top: 0.75rem;
    font-size: 1.125rem;
}
.gyroflight-home__foundation {
    font-size: 0.875rem;
    color: var(--ui-text-muted);
}

/* 2 x 2 on desktop and tablet, one column on narrow screens; equal columns and equal row heights. */
.gyroflight-home__cards {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    grid-auto-rows: 1fr;
    gap: 1.25rem;
}
.gyroflight-home__cards > * {
    height: 100%;
    margin-top: 0;
}
.gyroflight-home__cards > * > div:last-child {
    height: 100%;
}
.gyroflight-home__action {
    margin-top: auto;
    padding-top: 0.5rem;
}
@media (max-width: 640px) {
    .gyroflight-home__cards {
        grid-template-columns: minmax(0, 1fr);
        grid-auto-rows: auto;
    }
}

.gyroflight-home__attribution {
    text-align: center;
    font-size: 0.75rem;
    line-height: 1.5;
    color: var(--ui-text-muted);
}
</style>
