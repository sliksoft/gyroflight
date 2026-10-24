<template>
    <div
        v-if="open.length || states.unreadable"
        class="text-sm mt-2"
        role="alert"
        data-gyrocore="uncertain-state"
        :data-count="open.length"
    >
        <p class="font-bold text-red-500">{{ $t("gyroflightUncertainTitle") }}</p>
        <p v-if="states.unreadable">{{ $t("gyroflightUncertainUnreadable") }}</p>
        <ul class="list-disc ps-5">
            <li v-for="e in open" :key="e.backupId + e.at" :data-backup="e.backupId">
                {{ entryText(e) }}
            </li>
        </ul>
        <p>{{ $t("gyroflightUncertainText") }}</p>
        <UButton
            size="xs"
            variant="outline"
            class="mt-1"
            data-gyrocore="uncertain-state-check"
            :disabled="checking || !open.length"
            @click="onCheck"
        >
            {{ $t("gyroflightUncertainCheck") }}
        </UButton>
        <ul
            v-if="lastCheck && !lastCheck.resolved"
            class="list-disc ps-5 text-dimmed"
            data-gyrocore="uncertain-state-why"
        >
            <li v-for="r in lastCheck.reasons" :key="r">{{ r }}</li>
        </ul>
    </div>
</template>

<script setup lang="ts">
/*
 * A write on the connected craft that ended in a state nobody verified (fcTransactionState): every
 * Apply on it is refused until a verified Restore or a read-only check shows its state again.
 */
import { computed, ref } from "vue";
import { i18n } from "@/js/localization";
import { useFlightControllerStore } from "@/stores/fc";
import { useFcTransactionStore, type UncertainTransaction } from "@/gyrocore/stores/fcTransactionState";
import { checkTransactionState, type TransactionStateCheck } from "@/composables/useTuneApply";

const states = useFcTransactionStore();
const fc = useFlightControllerStore();
const open = computed(() => states.forUid(fc.config.uid));
const checking = ref(false);
const lastCheck = ref<TransactionStateCheck | null>(null);

const entryText = (e: UncertainTransaction) =>
    i18n.getMessage("gyroflightUncertainEntry", [e.at, e.stage, e.saved, e.backupId]);

async function onCheck() {
    checking.value = true;
    try {
        lastCheck.value = await checkTransactionState();
    } catch (err) {
        const reasons =
            err && typeof err === "object" && Array.isArray(Reflect.get(err, "reasons"))
                ? (Reflect.get(err, "reasons") as string[])
                : [String(err instanceof Error ? err.message : err)];
        lastCheck.value = { resolved: false, reasons };
    } finally {
        checking.value = false;
    }
}
</script>
