<template>
    <div
        class="logo gyroflight-logo"
        :class="`gyroflight-logo--${variant}`"
        :title="tooltip"
        :data-variant="variant"
        data-gyroflight="logo"
    >
        <!-- One raster logo for every size, scaled with object-fit: contain; nothing is cropped
             (except in the compact sidebar, which shows the whole emblem only). -->
        <span class="gyroflight-logo__frame">
            <img class="gyroflight-logo__image" :src="logoUrl" :alt="$t('gyroflightLogoAlt')" draggable="false" />
        </span>
    </div>
</template>

<script setup lang="ts">
/*
 * Gyroflight product logo. logo-gyroflight-trimmed.png is logo-Gyrofly.png cropped losslessly to
 * its visible artwork (every pixel with alpha >= 2) plus a 16 px transparent margin; the pixels
 * are identical to the original. Used in the app shell
 * (sidebar, mobile top bar) in place of Betaflight's <betaflight-logo>, with the same props
 * and version tooltip, and as the Home hero. The artwork already reads "GYROFLIGHT by Redline
 * Dynamics", so no text wordmark is rendered next to it.
 */
import { computed } from "vue";
import { i18n } from "@/js/localization";
import logoUrl from "./logo-gyroflight-trimmed.png";

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
 * logo-gyroflight-trimmed.png is 2106 x 421 and holds the whole artwork with a transparent
 * margin. It is shown at its own aspect ratio (object-fit: contain), directly on the page:
 * no frame crops it and no fill, border or rounded box is added.
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
}

.gyroflight-logo__image {
    display: block;
    width: 100%;
    height: auto;
    aspect-ratio: 2106 / 421;
    object-fit: contain;
    user-select: none;
}

/* Sidebar: compact, sidebar width, no extra height. */
.tab_container .gyroflight-logo--sidebar {
    padding: 0.25rem 0 0.5rem;
    margin-bottom: 0.5rem;
}
.gyroflight-logo--sidebar .gyroflight-logo__frame {
    padding: 0 0.25rem;
}

/* Home hero: large and centred, capped so it does not take over the page. */
.gyroflight-logo--hero .gyroflight-logo__frame {
    width: min(100%, 42rem);
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
.gyroflight-logo--mobile .gyroflight-logo__image {
    width: auto;
    height: 100%;
}

/*
 * Same breakpoint at which Betaflight switches to its short logo: show only the emblem.
 * In the trimmed PNG the emblem spans x 16..501, y 16..390 (all pixels with alpha >= 2). Its
 * right-hand rings reach past x 476, where the "G" starts (y 127..297 only), so no rectangle
 * holds the whole emblem without part of the G: the image is scaled so the emblem's 485 px
 * width fits 44 px of the 48 px square (191 x 38 px, 2 px inset, emblem centred vertically)
 * and clip-path hides just the G's band. Aspect ratio unchanged; the emblem is never cut.
 */
@media (max-width: 1055px) {
    .tab_container .gyroflight-logo--sidebar .gyroflight-logo__frame {
        position: relative;
        width: 48px;
        height: 48px;
        padding: 0;
        overflow: hidden;
    }
    .tab_container .gyroflight-logo--sidebar .gyroflight-logo__image {
        position: absolute;
        left: 0.55px;
        top: 5.6px;
        width: 191px;
        height: auto;
        max-width: none;
        object-fit: fill;
        clip-path: polygon(0 0, 100% 0, 100% 30.2%, 22.6% 30.2%, 22.6% 70.5%, 100% 70.5%, 100% 100%, 0 100%);
    }
}
</style>
