<template>
    <BaseTab tab-name="landing">
        <div class="gyroflight-home">
            <section class="gyroflight-home__hero">
                <div class="gyroflight-home__eyebrow">{{ $t("gyroflightHomeParent") }}</div>
                <h1>GYRO<span>FLIGHT</span></h1>
                <p class="gyroflight-home__lead">{{ $t("gyroflightHomeLead") }}</p>
                <p class="gyroflight-home__upstream">{{ $t("gyroflightHomeUpstream") }}</p>
            </section>

            <section class="gyroflight-home__grid">
                <UiBox :title="$t('gyroflightHomeConnectTitle')" type="neutral">
                    <p>{{ $t("gyroflightHomeConnectText") }}</p>
                </UiBox>
                <UiBox :title="$t('gyroflightHomeBlackboxTitle')" type="neutral">
                    <p>{{ $t("gyroflightHomeBlackboxText") }}</p>
                    <UButton class="mt-3" color="primary" variant="soft" size="sm" icon="i-lucide-line-chart" @click="openBlackbox">
                        {{ $t("gyroflightHomeOpenBlackbox") }}
                    </UButton>
                </UiBox>
                <UiBox :title="$t('gyroflightHomeFirmwareTitle')" type="neutral">
                    <p>{{ $t("gyroflightHomeFirmwareText") }}</p>
                    <UButton class="mt-3" color="primary" variant="soft" size="sm" icon="i-lucide-zap" @click="openFirmware">
                        {{ $t("gyroflightHomeOpenFirmware") }}
                    </UButton>
                </UiBox>
                <UiBox :title="$t('gyroflightHomeAutotuneTitle')" type="neutral">
                    <p>{{ $t("gyroflightHomeAutotuneText") }}</p>
                </UiBox>
            </section>

            <footer class="gyroflight-home__footer">{{ $t("gyroflightHomeAttribution") }}</footer>
        </div>
    </BaseTab>
</template>

<script setup lang="ts">
import BaseTab from "@/components/tabs/BaseTab.vue";
import UiBox from "@/components/elements/UiBox.vue";
import { switchTab } from "@/js/tab_switch";

function openBlackbox() {
    switchTab("blackbox_viewer", { mode: "shared" });
}
function openFirmware() {
    switchTab("firmware_flasher", { mode: "disconnected" });
}
</script>

<style scoped>
.gyroflight-home {
    min-height: 100%;
    overflow-y: auto;
    padding: clamp(1.25rem, 4vw, 3.5rem);
    background:
        radial-gradient(circle at 50% 0%, rgba(34, 211, 238, 0.09), transparent 36rem),
        var(--surface-100);
}
.gyroflight-home__hero { max-width: 860px; margin: 0 auto 2.25rem; text-align: center; }
.gyroflight-home__eyebrow {
    margin-bottom: 0.65rem;
    color: var(--primary-500);
    font-size: 0.72rem;
    font-weight: 800;
    letter-spacing: 0.22em;
}
.gyroflight-home h1 {
    margin: 0;
    color: var(--text);
    font-size: clamp(2.7rem, 8vw, 5.5rem);
    font-weight: 850;
    letter-spacing: 0.04em;
    line-height: 0.95;
}
.gyroflight-home h1 span { color: var(--primary-500); }
.gyroflight-home__lead {
    margin: 1.1rem auto 0;
    max-width: 700px;
    color: var(--text);
    font-size: clamp(1rem, 2vw, 1.25rem);
}
.gyroflight-home__upstream { margin-top: 0.5rem; color: var(--surface-700); font-size: 0.85rem; }
.gyroflight-home__grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem;
    max-width: 980px;
    margin: 0 auto;
}
.gyroflight-home__grid p { color: var(--surface-800); line-height: 1.55; }
.gyroflight-home__footer {
    max-width: 980px;
    margin: 2rem auto 0;
    padding-top: 1rem;
    border-top: 1px solid var(--surface-300);
    color: var(--surface-700);
    font-size: 0.75rem;
    text-align: center;
}
@media (max-width: 720px) {
    .gyroflight-home__grid { grid-template-columns: 1fr; }
}
</style>
