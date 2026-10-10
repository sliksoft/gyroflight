<template>
    <div
        class="logo gyroflight-logo"
        :class="`gyroflight-logo--${variant}`"
        :title="tooltip"
        :data-variant="variant"
        data-gyroflight="logo"
    >
        <!-- One raster logo for every size. The frame crops only the PNG's transparent top and
             bottom margin (object-fit: cover keeps the aspect ratio; no artwork is cut). -->
        <span class="gyroflight-logo__frame">
            <img class="gyroflight-logo__image" :src="logoUrl" :alt="$t('gyroflightLogoAlt')" draggable="false" />
        </span>
    </div>
</template>

<script setup lang="ts">
/*
 * Gyroflight product logo (src/gyroflight/branding/logo-Gyrofly.png). Used in the app shell
 * (sidebar, mobile top bar) in place of Betaflight's <betaflight-logo>, with the same props
 * and version tooltip, and as the Home hero. The artwork already reads "GYROFLIGHT by Redline
 * Dynamics", so no text wordmark is rendered next to it.
 */
import { computed } from "vue";
import { i18n } from "@/js/localization";
import logoUrl from "./logo-Gyrofly.png";

const props = withDefaults(
    defineProps<{
        configuratorVersion?: string;
        firmwareVersion?: string;
        firmwareId?: string;
        hardwareId?: string;
        variant?: "sidebar" | "hero" | "mobile";
    }>(),
    { configuratorVersion: "", firmwareVersion: "", firmwareId: "", hardwareId: "", variant: "sidebar" },
);

const tooltip = computed(() => {
    if (props.variant === "hero") {
        return undefined;
    }
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
/*
 * logo-Gyrofly.png is 2172 x 724 with the artwork in roughly y 168..530, so a 2172:400 frame
 * centred on the image keeps all of it. The PNG is transparent and is shown as it is, directly
 * on the page (honeycomb or plain); the frame adds no fill, border or rounded box.
 */
.gyroflight-logo {
    display: flex;
    justify-content: center;
    line-height: 0;
}

.gyroflight-logo__frame {
    display: block;
    box-sizing: border-box;
    width: 100%;
    aspect-ratio: 2172 / 400;
    overflow: hidden;
}

.gyroflight-logo__image {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: center;
    user-select: none;
}

/* Sidebar: compact, sidebar width, no extra height. */
.tab_container .gyroflight-logo--sidebar {
    padding: 0.25rem 0 0.5rem;
    margin-bottom: 0.5rem;
}
.gyroflight-logo--sidebar .gyroflight-logo__frame {
    padding: 0.25rem 0.375rem;
}

/* Home hero: large and centred, capped so it does not take over the page. */
.gyroflight-logo--hero .gyroflight-logo__frame {
    width: min(100%, 44rem);
    padding: 0.75rem 1.25rem;
}

/* Mobile top bar on Home. */
.gyroflight-logo--mobile {
    flex: 1;
    min-width: 0;
    height: 2.5rem;
}
.gyroflight-logo--mobile .gyroflight-logo__frame {
    width: auto;
    height: 100%;
    padding: 0.125rem 0.5rem;
}

/*
 * Same breakpoint at which Betaflight switches to its short logo: show only the emblem.
 * The emblem occupies about x 55..540, y 175..505 of the 2172 x 724 PNG. Its right-hand rings
 * reach past x 515, where the "G" starts (y 265..435 only), so no rectangle shows all of the
 * emblem without part of the G: the image is scaled so x 55..540 fills 44 px of the 48 px
 * square (197 x 66 px, 2 px inset) and clip-path hides just the G's band. Aspect ratio unchanged.
 */
@media (max-width: 1055px) {
    .tab_container .gyroflight-logo--sidebar .gyroflight-logo__frame {
        position: relative;
        width: 48px;
        height: 48px;
        aspect-ratio: auto;
        padding: 0;
    }
    .tab_container .gyroflight-logo--sidebar .gyroflight-logo__image {
        position: absolute;
        left: -3px;
        top: -6.8px;
        width: 197px;
        height: auto;
        max-width: none;
        object-fit: fill;
        clip-path: polygon(0 0, 100% 0, 100% 36.6%, 23.7% 36.6%, 23.7% 60.1%, 100% 60.1%, 100% 100%, 0 100%);
    }
}
</style>
