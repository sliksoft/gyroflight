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
        <UButton
            size="xs"
            variant="outline"
            class="mt-1 ms-1"
            data-gyrocore="uncertain-state-diagnose"
            :disabled="!open.length"
            @click="onDiagnose"
        >
            {{ $t("gyroflightRecoveryDiagnose") }}
        </UButton>
        <div v-if="diagnosis" class="mt-1" data-gyrocore="uncertain-state-diagnosis">
            <p class="text-dimmed">{{ $t("gyroflightRecoveryNotEvidence") }}</p>
            <div v-for="d in diagnosis" :key="d.entry.id ?? d.entry.backupId" :data-backup="d.entry.backupId">
                <p class="font-bold">{{ d.entry.backupId }}</p>
                <ul class="list-disc ps-5" data-gyrocore="diagnosis-findings">
                    <li v-for="f in d.findings" :key="f" :data-finding="f">
                        {{ $t(`gyroflightRecoveryFinding_${f}`) }}
                    </li>
                </ul>
                <p :data-recovery="d.recovery.join(',')">
                    {{ d.recovery.map((r) => $t(`gyroflightRecoveryAvailable_${r}`)).join(" ") }}
                </p>
                <ol class="list-decimal ps-5" data-gyrocore="diagnosis-steps">
                    <li v-for="step in d.nextSteps" :key="step">{{ $t(step) }}</li>
                </ol>
            </div>
        </div>
    </div>
</template>

<script setup lang="ts">
/*
 * A write on the connected craft that ended in a state nobody verified (fcTransactionState): every
 * Apply on it is refused until a verified Restore or a read-only check shows its state again. The
 * diagnosis (audit WP8-F07) lists per entry what is unknown, which of those two can prove it, or
 * that none can and what to do then; it reads only and clears nothing.
 */
import { computed, ref } from "vue";
import { i18n } from "@/js/localization";
import { useFlightControllerStore } from "@/stores/fc";
import { useFcTransactionStore, type UncertainTransaction } from "@/gyrocore/stores/fcTransactionState";
import { checkTransactionState, type TransactionStateCheck } from "@/composables/useTuneApply";
import { useTuneBackupStore } from "@/gyrocore/stores/tuneBackup";
import { diagnoseCraft, transactionOwnerActive, type EntryDiagnosis } from "@/gyrocore/recovery/transactionDiagnosis";

const states = useFcTransactionStore();
const fc = useFlightControllerStore();
const open = computed(() => states.forUid(fc.config.uid));
const checking = ref(false);
const lastCheck = ref<TransactionStateCheck | null>(null);
const diagnosis = ref<EntryDiagnosis[] | null>(null);

/** Read-only (audit WP8-F07): what is unknown and which recovery could prove it; changes nothing. */
async function onDiagnose() {
    const backups = useTuneBackupStore();
    backups.reload();
    states.sync();
    diagnosis.value = diagnoseCraft(states.forUid(fc.config.uid), {
        backups: backups.forUid(fc.config.uid),
        ownerActive: await transactionOwnerActive(),
    });
}

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
