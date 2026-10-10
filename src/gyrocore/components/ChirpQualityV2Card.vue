<template>
    <section
        class="rounded-md border border-default p-3"
        :data-gyrocore="'chirp-quality-v2'"
        :data-measurement="v.identity.measurementId"
    >
        <h4 class="text-sm font-bold mb-1">
            {{ t("gyrocoreQv2Title", [axisLabel, v.identity.measurementId]) }}
        </h4>
        <p class="text-[11px] text-dimmed mb-2">{{ $t("gyrocoreQv2DiagnosticNote") }}</p>

        <table class="w-full text-xs mb-2" data-gyrocore="qv2-rows">
            <tbody>
                <tr v-for="row in rows" :key="row.id" :data-row="row.id" :data-status="row.status">
                    <th scope="row" class="text-start font-normal text-dimmed pe-2 py-0.5 whitespace-nowrap">
                        {{ $t(row.label) }}
                    </th>
                    <td class="pe-2 py-0.5 whitespace-nowrap">
                        <UBadge :color="toneColor(row.tone)" variant="subtle" size="sm">{{ row.status }}</UBadge>
                    </td>
                    <td class="py-0.5">{{ row.detail }}</td>
                </tr>
            </tbody>
        </table>

        <div class="flex flex-wrap gap-1 mb-2" data-gyrocore="qv2-levels">
            <UBadge
                v-for="key in LEVEL_ORDER"
                :key="key"
                :color="levelColor(v.levels[key].status)"
                variant="outline"
                size="sm"
                :data-level="key"
                :data-status="v.levels[key].status"
            >
                {{ $t(`gyrocoreQv2Level_${key}`) }}: {{ v.levels[key].status }}
            </UBadge>
        </div>

        <figure v-if="plot" class="mb-2">
            <svg
                :viewBox="`0 0 ${W + PAD_L + 4} ${H + PAD_B + 4}`"
                class="w-full h-auto"
                role="img"
                :aria-label="t('gyrocoreQv2ChartLabel', [v.identity.measurementId])"
                data-gyrocore="qv2-coherence-chart"
            >
                <g :transform="`translate(${PAD_L},2)`">
                    <line :x1="0" :x2="W" :y1="H" :y2="H" class="stroke-current text-dimmed" stroke-width="1" />
                    <line
                        :x1="0"
                        :x2="W"
                        :y1="plot.thresholdY"
                        :y2="plot.thresholdY"
                        class="stroke-current text-dimmed"
                        stroke-width="1"
                        stroke-dasharray="4 3"
                    />
                    <text
                        :x="-4"
                        :y="0"
                        text-anchor="end"
                        dominant-baseline="hanging"
                        class="fill-current text-dimmed text-[9px]"
                    >
                        1
                    </text>
                    <text
                        :x="-4"
                        :y="plot.thresholdY"
                        text-anchor="end"
                        dominant-baseline="middle"
                        class="fill-current text-dimmed text-[9px]"
                    >
                        0.5
                    </text>
                    <text :x="-4" :y="H" text-anchor="end" class="fill-current text-dimmed text-[9px]">0</text>
                    <g v-for="t in plot.ticks" :key="t.label">
                        <line :x1="t.x" :x2="t.x" :y1="H" :y2="H + 3" class="stroke-current text-dimmed" />
                        <text :x="t.x" :y="H + 12" text-anchor="middle" class="fill-current text-dimmed text-[9px]">
                            {{ t.label }}
                        </text>
                    </g>
                    <line
                        v-for="(b, i) in plot.bars"
                        :key="i"
                        :x1="b.x"
                        :x2="b.x"
                        :y1="H"
                        :y2="b.y"
                        stroke-width="2"
                        stroke-linecap="round"
                        :class="['stroke-current', statusClass(b.status)]"
                        :data-status="b.status"
                    >
                        <title>{{ binTitle(b) }}</title>
                    </line>
                </g>
            </svg>
            <figcaption class="flex flex-wrap gap-3 text-[11px] text-dimmed">
                <span v-for="s in BIN_STATUS_ORDER" :key="s" class="inline-flex items-center gap-1">
                    <span :class="['inline-block w-2.5 h-2.5 rounded-sm bg-current', statusClass(s)]" />
                    {{ $t(`gyrocoreQv2Bin_${s}`) }}
                </span>
                <span>{{ $t("gyrocoreQv2ChartAxes") }}</span>
            </figcaption>
        </figure>
        <p v-else class="text-xs text-dimmed mb-2" data-gyrocore="qv2-no-bins">{{ $t("gyrocoreQv2NoBins") }}</p>

        <details class="text-xs">
            <summary class="cursor-pointer text-dimmed">{{ $t("gyrocoreQv2RegionsTitle") }}</summary>
            <table class="w-full mt-1" data-gyrocore="qv2-regions">
                <thead>
                    <tr class="text-dimmed">
                        <th scope="col" class="text-start">{{ $t("gyrocoreQv2ColFrequency") }}</th>
                        <th scope="col" class="text-start">{{ $t("gyrocoreQv2ColBins") }}</th>
                        <th scope="col" class="text-start">{{ $t("gyrocoreQv2ColCoherence") }}</th>
                        <th scope="col" class="text-start">{{ $t("gyrocoreQv2ColDiagnostic") }}</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="r in v.coherence.regions.items" :key="r.fromHz" :data-status="r.status">
                        <td>{{ hz(r.fromHz) }}–{{ hz(r.toHz) }}</td>
                        <td>{{ r.binCount }}</td>
                        <td>
                            {{ r.meanCoherence.toFixed(2) }} ({{ r.minCoherence.toFixed(2) }}–{{
                                r.maxCoherence.toFixed(2)
                            }})
                        </td>
                        <td>{{ $t(`gyrocoreQv2Bin_${r.status}`) }}</td>
                    </tr>
                </tbody>
            </table>
            <ul class="list-disc ps-4 mt-2 text-dimmed" data-gyrocore="qv2-reasons">
                <li v-for="code in v.reasons" :key="code" :data-reason="code">{{ code }}</li>
            </ul>
        </details>
    </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { i18n } from "@/js/localization";
import type { BinStatus, ChirpQualityV2, LevelStatus } from "@/gyrocore/chirp/qualityV2/contract";
import {
    BIN_STATUS_ORDER,
    coherencePlot,
    LEVEL_ORDER,
    qualityRows,
    type RowTone,
} from "@/gyrocore/chirp/qualityV2/view";

const props = defineProps<{ quality: ChirpQualityV2 }>();

const W = 520;
const H = 110;
const PAD_L = 22;
const PAD_B = 14;

const AXIS_LABEL_KEYS = { roll: "autotuneAxisRoll", pitch: "autotuneAxisPitch", yaw: "autotuneAxisYaw" } as const;

const v = computed(() => props.quality);
const t = (key: string, args: (string | number)[] = []) => i18n.getMessage(key, args.map(String));
const rows = computed(() => qualityRows(v.value, t));
const plot = computed(() => coherencePlot(v.value, W, H));
const axisLabel = computed(() => i18n.getMessage(AXIS_LABEL_KEYS[v.value.identity.axisName]).toUpperCase());

function toneColor(tone: RowTone) {
    return ({ good: "success", warn: "warning", bad: "error", unknown: "neutral", neutral: "neutral" } as const)[tone];
}

function levelColor(status: LevelStatus) {
    return status === "YES" ? ("success" as const) : status === "NO" ? ("error" as const) : ("neutral" as const);
}

function statusClass(status: BinStatus) {
    return {
        USABLE: "text-success",
        WEAK_COHERENCE: "text-warning",
        NO_INPUT_POWER: "text-error",
        OUTSIDE_ANALYSIS_BAND: "text-dimmed",
    }[status];
}

function hz(f: number) {
    return f < 10 ? f.toFixed(1) : String(Math.round(f));
}

function binTitle(b: { frequencyHz: number; coherence: number; status: BinStatus }) {
    return `${b.frequencyHz.toFixed(1)} Hz: ${b.coherence.toFixed(2)} (${i18n.getMessage(`gyrocoreQv2Bin_${b.status}`)})`;
}
</script>
