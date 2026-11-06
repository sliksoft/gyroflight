<template>
    <!-- A column beside the content when the tab is wide; a wrapping row above it when narrow. -->
    <nav
        :aria-label="$t('gyroflightAutotuneNavLabel')"
        class="flex flex-row flex-wrap gap-1 @4xl:flex-col @4xl:flex-nowrap @4xl:w-44 @4xl:shrink-0 @4xl:sticky @4xl:top-0 @4xl:self-start"
        data-gyroflight="autotune-nav"
    >
        <button
            v-for="s in AUTOTUNE_SECTIONS"
            :key="s"
            type="button"
            class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-left cursor-pointer"
            :class="sections.active === s ? 'bg-primary/15 text-primary font-bold' : 'text-default hover:bg-elevated'"
            :aria-current="sections.active === s ? 'page' : undefined"
            :data-autotune-section="s"
            @click="sections.open(s)"
        >
            <UIcon :name="AUTOTUNE_SECTION_ICONS[s]" class="size-4 shrink-0" />
            <span>{{ $t(`gyroflightAutotuneSection_${s}`) }}</span>
        </button>
    </nav>
</template>

<script setup lang="ts">
import { AUTOTUNE_SECTIONS, AUTOTUNE_SECTION_ICONS, useAutotuneSectionStore } from "./sections";

const sections = useAutotuneSectionStore();
</script>
