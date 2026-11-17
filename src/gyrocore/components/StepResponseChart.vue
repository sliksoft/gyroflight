<template>
    <figure class="mb-2" :data-gyrocore="`step-chart-${id}`" :data-series="chart ? chart.lines.length : 0">
        <figcaption class="text-xs font-bold mb-0.5">{{ title }}</figcaption>
        <p v-if="!chart" class="text-xs text-dimmed" data-gyrocore="step-chart-empty">{{ emptyText }}</p>
        <svg
            v-else
            :viewBox="`0 0 ${W + PAD_L + 4} ${H + PAD_B + PAD_T + 2}`"
            class="w-full h-auto"
            role="img"
            :aria-label="title"
        >
            <g :transform="`translate(${PAD_L},${PAD_T})`">
                <line :x1="0" :x2="W" :y1="H" :y2="H" class="stroke-current text-dimmed" stroke-width="1" />
                <line
                    :x1="0"
                    :x2="W"
                    :y1="chart.oneY"
                    :y2="chart.oneY"
                    class="stroke-current text-dimmed"
                    stroke-width="1"
                    stroke-dasharray="4 3"
                />
                <line
                    :x1="0"
                    :x2="W"
                    :y1="chart.halfY"
                    :y2="chart.halfY"
                    class="stroke-current text-dimmed"
                    stroke-width="0.5"
                    stroke-dasharray="2 3"
                />
                <text
                    v-for="t in chart.ticksY"
                    :key="`y${t.label}`"
                    :x="-4"
                    :y="t.y"
                    text-anchor="end"
                    dominant-baseline="middle"
                    class="fill-current text-dimmed text-[9px]"
                >
                    {{ t.label }}
                </text>
                <g v-for="t in chart.ticksX" :key="`x${t.label}`">
                    <line :x1="t.x" :x2="t.x" :y1="H" :y2="H + 3" class="stroke-current text-dimmed" />
                    <text :x="t.x" :y="H + 12" text-anchor="middle" class="fill-current text-dimmed text-[9px]">
                        {{ t.label }}
                    </text>
                </g>
                <path
                    v-for="b in chart.bands"
                    :key="`band-${b.id}`"
                    :d="b.d"
                    :class="['fill-current', styleOf(b.id)]"
                    fill-opacity="0.18"
                    stroke="none"
                    :data-band="b.id"
                />
                <path
                    v-for="l in chart.lines"
                    :key="l.id"
                    :d="l.d"
                    fill="none"
                    stroke-width="1.5"
                    stroke-linejoin="round"
                    :class="['stroke-current', styleOf(l.id)]"
                    :data-line="l.id"
                />
            </g>
        </svg>
        <div v-if="chart" class="flex flex-wrap gap-3 text-[11px] text-dimmed" data-gyrocore="step-chart-legend">
            <span v-for="s in series" :key="s.id" class="inline-flex items-center gap-1">
                <svg width="16" height="6" aria-hidden="true">
                    <line x1="0" x2="16" y1="3" y2="3" stroke-width="2" :class="['stroke-current', styleOf(s.id)]" />
                </svg>
                {{ s.label }}
            </span>
            <span>{{ axesText }}</span>
        </div>
    </figure>
</template>

<script setup lang="ts">
/*
 * One step-response chart: the mean curve of each flight over 0–500 ms with its 25–75 % band
 * across manoeuvres; dashed y = 1 (commanded step), dotted y = 0.5 (t50). Display only.
 */
import { computed } from "vue";
import { stepChart } from "@/gyrocore/stepResponse/stepView";
import type { StepCurve } from "@/gyrocore/stepResponse/stepResponse";

const props = defineProps<{
    id: string;
    title: string;
    emptyText: string;
    axesText: string;
    series: { id: string; label: string; curve: StepCurve }[];
}>();

const W = 360;
const H = 140;
const PAD_L = 28;
const PAD_B = 14;
const PAD_T = 6;

const chart = computed(() => stepChart(props.series, W, H));

function styleOf(id: string): string {
    return id === "b" ? "text-warning" : "text-primary";
}
</script>
