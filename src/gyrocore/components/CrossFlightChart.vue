<template>
    <figure class="mb-2" :data-gyrocore="`cfc-chart-${id}`" :data-points="chart ? totalPoints : 0">
        <figcaption class="text-xs font-bold mb-0.5">{{ title }}</figcaption>
        <p v-if="!chart" class="text-xs text-dimmed" data-gyrocore="cfc-chart-empty">{{ emptyText }}</p>
        <svg
            v-else
            :viewBox="`0 0 ${W + PAD_L + 4} ${H + PAD_B + 4}`"
            class="w-full h-auto"
            role="img"
            :aria-label="title"
        >
            <g :transform="`translate(${PAD_L},2)`">
                <line :x1="0" :x2="W" :y1="H" :y2="H" class="stroke-current text-dimmed" stroke-width="1" />
                <line
                    v-if="chart.zeroY !== null"
                    :x1="0"
                    :x2="W"
                    :y1="chart.zeroY"
                    :y2="chart.zeroY"
                    class="stroke-current text-dimmed"
                    stroke-width="1"
                    stroke-dasharray="4 3"
                    data-gyrocore="cfc-chart-zero"
                />
                <text
                    v-for="t in chart.ticksY"
                    :key="`y${t.y}`"
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
                    v-for="p in chart.paths"
                    :key="p.id"
                    :d="p.d"
                    fill="none"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    :stroke-dasharray="styleOf(p.id).dashed ? '4 2' : undefined"
                    :class="['stroke-current', styleOf(p.id).cls]"
                    :data-series="p.id"
                    :data-points="p.points"
                />
            </g>
        </svg>
        <div v-if="chart" class="flex flex-wrap gap-3 text-[11px] text-dimmed" data-gyrocore="cfc-chart-legend">
            <span v-for="s in series" :key="s.id" class="inline-flex items-center gap-1">
                <svg width="16" height="6" aria-hidden="true">
                    <line
                        x1="0"
                        x2="16"
                        y1="3"
                        y2="3"
                        stroke-width="2"
                        :stroke-dasharray="s.dashed ? '4 2' : undefined"
                        :class="['stroke-current', s.cls]"
                    />
                </svg>
                {{ s.label }}
            </span>
            <span>{{ axesText }}</span>
        </div>
    </figure>
</template>

<script setup lang="ts">
/*
 * One labelled line chart of the cross-flight comparison: values over the
 * shared frequency bins (log axis). Missing values are gaps, never zeros.
 */
import { computed } from "vue";
import { lineChart } from "@/gyrocore/compare/view";

export interface ChartSeriesProp {
    id: string;
    label: string;
    cls: string;
    dashed?: boolean;
    values: (number | null)[];
}

const props = defineProps<{
    id: string;
    title: string;
    axesText: string;
    emptyText: string;
    frequencyHz: number[];
    series: ChartSeriesProp[];
    range?: [number, number];
    includeZero?: boolean;
    digits?: number;
}>();

const W = 520;
const H = 110;
const PAD_L = 30;
const PAD_B = 14;

const chart = computed(() =>
    lineChart(props.frequencyHz, props.series, W, H, {
        range: props.range,
        includeZero: props.includeZero,
        digits: props.digits,
    }),
);
const totalPoints = computed(() => chart.value?.paths.reduce((n, p) => n + p.points, 0) ?? 0);

function styleOf(id: string) {
    return props.series.find((s) => s.id === id) ?? { cls: "", dashed: false };
}
</script>
