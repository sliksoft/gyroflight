<template>
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
</template>

<script setup lang="ts">
import { describeCompositeReason } from "@/gyrocore/tuning/reasons";
import type { CompositeAuthorization } from "@/gyrocore/tuning/authorize";
import type { CompositeRecommendation } from "@/gyrocore/tuning/composite";

defineProps<{
    composite: CompositeRecommendation | null;
    authorization: CompositeAuthorization;
}>();
</script>
