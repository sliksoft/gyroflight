<template>
    <div class="overflow-x-auto max-w-full [&_td.text-dimmed]:[overflow-wrap:anywhere]">
        <table class="gyroflight-workflow-table text-sm" data-gyrocore="v2-measurement-plan">
            <thead>
                <tr>
                    <th>{{ $t("gyroflightV2PlanAxis") }}</th>
                    <th>{{ $t("gyroflightV2PlanBand") }}</th>
                    <th>{{ $t("gyroflightV2PlanResolution") }}</th>
                    <th>{{ $t("gyroflightV2PlanSegment") }}</th>
                    <th>{{ $t("gyroflightV2PlanAverages") }}</th>
                    <th>{{ $t("gyroflightV2PlanSweep") }}</th>
                    <th>{{ $t("gyroflightV2PlanDiagnostics") }}</th>
                </tr>
            </thead>
            <tbody>
                <tr v-for="p in plan" :key="p.axis" :data-axis="p.axis">
                    <td>{{ p.axis }}</td>
                    <td>{{ band(p.bandHz.primary) }}</td>
                    <td>
                        {{ num(p.resolutionHz.now, 2) }} / {{ num(p.resolutionHz.primary, 2) }} /
                        {{ num(p.resolutionHz.qualification, 3) }}
                    </td>
                    <td>{{ p.segmentSamples.primary ?? "--" }} / {{ p.segmentSamples.qualification ?? "--" }}</td>
                    <td>{{ p.averages.now ?? "--" }} / {{ p.averages.needed ?? "--" }}</td>
                    <td>
                        {{ p.sweep ? num(p.sweep.durationS, 0) : "--" }};
                        {{ p.qualificationSweep ? num(p.qualificationSweep.durationS, 0) : "--" }}
                    </td>
                    <td class="[overflow-wrap:anywhere]">{{ p.diagnostics.join(", ") || "--" }}</td>
                </tr>
            </tbody>
        </table>
    </div>
</template>

<script setup lang="ts">
/* The per-axis measurement planner table (measurementPlan.ts), shown as the plan's technical basis. */
import type { AxisMeasurementPlan } from "@/gyrocore/engine/measurementPlan";

defineProps<{ plan: AxisMeasurementPlan[] }>();

const num = (x: number | null | undefined, digits: number) =>
    x == null || !Number.isFinite(x) ? "--" : x.toFixed(digits);
const band = (b: [number, number] | null) => (b ? `${num(b[0], 1)}–${num(b[1], 1)}` : "--");
</script>
