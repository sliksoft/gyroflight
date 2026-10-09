<template>
    <div class="logo gyroflight-logo" :class="`gyroflight-logo--${variant}`" :title="tooltip" data-gyroflight="logo">
        <!-- Text wordmark until a final Gyroflight logo exists: replace this span with an <img> of the SVG. -->
        <span class="gyroflight-logo__wordmark" :aria-label="$t('gyroflightProductName')">
            <span class="gyroflight-logo__full">{{ $t("gyroflightProductWordmark") }}</span>
            <span class="gyroflight-logo__short" aria-hidden="true">{{ $t("gyroflightProductWordmarkShort") }}</span>
        </span>
        <span v-if="variant === 'sidebar'" class="gyroflight-logo__parent">{{ $t("gyroflightParentBrand") }}</span>
    </div>
</template>

<script setup lang="ts">
/*
 * Gyroflight product logo for the app shell (sidebar and mobile top bar), in place of
 * Betaflight's <betaflight-logo>. Same props and the same version tooltip, so the shell
 * passes exactly what it passed before.
 */
import { computed } from "vue";
import { i18n } from "@/js/localization";

const props = withDefaults(
    defineProps<{
        configuratorVersion?: string;
        firmwareVersion?: string;
        firmwareId?: string;
        hardwareId?: string;
        variant?: "sidebar" | "mobile";
    }>(),
    { configuratorVersion: "", firmwareVersion: "", firmwareId: "", hardwareId: "", variant: "sidebar" },
);

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

<style>
.gyroflight-logo {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 0.125rem;
    line-height: 1;
}

.tab_container .gyroflight-logo {
    min-height: 48px;
}

.gyroflight-logo__wordmark {
    font-weight: 800;
    letter-spacing: 0.14em;
    font-size: 1.375rem;
    color: var(--ui-text-highlighted, currentColor);
}

.gyroflight-logo__wordmark {
    border-bottom: 2px solid var(--ui-primary);
    align-self: flex-start;
    padding-bottom: 0.125rem;
}

.gyroflight-logo--mobile .gyroflight-logo__wordmark {
    align-self: center;
}

.gyroflight-logo__short {
    display: none;
}

.gyroflight-logo__parent {
    font-size: 0.75rem;
    letter-spacing: 0.04em;
    color: var(--ui-text-muted, currentColor);
}

.gyroflight-logo--mobile {
    align-items: center;
}

.gyroflight-logo--mobile .gyroflight-logo__wordmark {
    font-size: 1.25rem;
}

/* Same breakpoint at which Betaflight switches to its short logo. */
@media (max-width: 1055px) {
    .tab_container .gyroflight-logo {
        align-items: center;
    }
    .tab_container .gyroflight-logo__full,
    .tab_container .gyroflight-logo__parent {
        display: none;
    }
    .tab_container .gyroflight-logo__short {
        display: inline;
    }
}
</style>
