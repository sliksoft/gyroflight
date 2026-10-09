<template>
    <div class="gyroflight-brand" :title="tooltip" aria-label="Gyroflight by Redline Dynamics">
        <div class="gyroflight-brand__full">
            <div class="gyroflight-brand__wordmark">GYRO<span>FLIGHT</span></div>
            <div class="gyroflight-brand__parent">REDLINE DYNAMICS</div>
        </div>
        <div class="gyroflight-brand__short" aria-hidden="true">GF</div>
    </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { i18n } from "@/js/localization";

const props = defineProps({
    configuratorVersion: { type: String, required: true },
    firmwareVersion: { type: String, default: "" },
    firmwareId: { type: String, default: "" },
    hardwareId: { type: String, default: "" },
});

const tooltip = computed(() => {
    const lines = [`${i18n.getMessage("versionLabelConfigurator")}: ${props.configuratorVersion}`];
    if (props.firmwareVersion && props.firmwareId) {
        lines.push(`${i18n.getMessage("versionLabelFirmware")}: ${props.firmwareVersion} ${props.firmwareId}`);
    }
    if (props.hardwareId) {
        lines.push(`${i18n.getMessage("versionLabelTarget")}: ${props.hardwareId}`);
    }
    return lines.join("\n");
});
</script>

<style scoped>
.gyroflight-brand {
    display: flex;
    width: 100%;
    padding: 0.35rem 0 0.65rem;
    margin-bottom: 0.5rem;
    color: var(--text);
    user-select: none;
}
.gyroflight-brand__full { min-width: 0; }
.gyroflight-brand__wordmark {
    color: var(--text);
    font-size: 1.45rem;
    font-weight: 800;
    letter-spacing: 0.08em;
    line-height: 1;
}
.gyroflight-brand__wordmark span { color: var(--primary-500); }
.gyroflight-brand__parent {
    margin-top: 0.32rem;
    color: var(--surface-700);
    font-size: 0.61rem;
    font-weight: 700;
    letter-spacing: 0.2em;
}
.gyroflight-brand__short {
    display: none;
    width: 48px;
    color: var(--primary-500);
    font-size: 1.1rem;
    font-weight: 800;
    letter-spacing: 0.04em;
    text-align: center;
}
@media (max-width: 1055px) {
    .gyroflight-brand { justify-content: center; padding-bottom: 0.5rem; }
    .gyroflight-brand__full { display: none; }
    .gyroflight-brand__short { display: block; }
}
@media all and (max-width: 575px), all and (max-width: 950px) and (max-height: 500px) and (orientation: landscape) {
    .gyroflight-brand { margin: 0; padding: 0; }
    .gyroflight-brand__short { display: block; }
}
</style>
