<template>
    <p v-if="productLock.length" class="text-sm mt-2 font-bold" role="status" data-gyrocore="product-apply-locked">
        {{ $t("gyrocoreProductApplyPending") }}
    </p>
    <div v-if="!authorization.allowed" class="text-sm mt-2" role="status" data-gyrocore="apply-blocked">
        <p class="font-bold text-red-500">
            {{ composite ? $t("gyrocoreApplyBlockedTitle") : $t("gyrocoreApplyNoComposite") }}
        </p>
        <ul class="list-disc ps-5">
            <li v-for="code in authorization.blocked" :key="code" :data-reason="code">
                {{ describeCompositeReason(code) }}
            </li>
        </ul>
    </div>
    <div
        v-else-if="!safety.authorized"
        class="text-sm mt-2"
        role="status"
        data-gyrocore="safety-apply-blocked"
        :data-status="safety.status"
    >
        <p class="font-bold text-red-500">{{ $t("gyrocoreSafetyApplyBlocked") }}</p>
        <ul class="list-disc ps-5">
            <li v-for="code in safety.blocks" :key="code" :data-reason="code">
                {{ describeSafetyReason(code) }}
            </li>
        </ul>
    </div>
</template>

<script setup lang="ts">
import { describeCompositeReason } from "@/gyrocore/tuning/reasons";
import { describeSafetyReason } from "@/gyrocore/safety/reasons";
import type { SafetyResult } from "@/gyrocore/safety/evaluate";
import type { CompositeAuthorization } from "@/gyrocore/tuning/authorize";
import type { CompositeRecommendation } from "@/gyrocore/tuning/composite";

defineProps<{
    composite: CompositeRecommendation | null;
    authorization: CompositeAuthorization;
    /** GyroCore Safety on the composite (safety/evaluate.ts). */
    safety: SafetyResult;
    /** Product release lock (productLock/productApply.ts): not a rejection of the tune. */
    productLock: string[];
}>();
</script>
