<template>
    <div v-if="!authorization.allowed" class="text-sm mt-2" role="status" data-gyrocore="apply-blocked">
        <p class="font-bold text-red-500">
            {{ measurement ? $t("gyrocoreApplyBlockedTitle") : $t("gyrocoreApplyNoAxis") }}
        </p>
        <ul v-if="measurement" class="list-disc ps-5">
            <li v-for="code in authorization.blocked" :key="code" :data-reason="code">
                {{ describeReason(code, measurement) }}
            </li>
        </ul>
    </div>
</template>

<script setup lang="ts">
import type { ApplyAuthorization, ChirpMeasurement } from "@/gyrocore/chirp/qualification";
import { describeReason } from "@/gyrocore/chirp/reasons";

defineProps<{
    measurement: ChirpMeasurement | null;
    authorization: ApplyAuthorization;
}>();
</script>
