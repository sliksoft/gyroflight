<template>
    <UiBox :title="$t('gyroflightWorkflowTitle')" type="neutral" data-gyrocore="tune-workflow">
        <p class="text-sm text-dimmed mb-2">{{ $t("gyroflightWorkflowIntro") }}</p>

        <!-- 1. Analyze -->
        <h4 class="font-bold mt-2" data-step="analyze">1. {{ $t("gyroflightStepAnalyze") }}</h4>
        <ul class="list-disc ps-5 text-sm" data-gyrocore="workflow-analyze">
            <li data-source="chirp">
                {{ $t("gyroflightAnalyzeChirp") }}:
                <template v-if="gate.report"> {{ gate.report.filename }} · {{ measurementSummary }} </template>
                <template v-else>{{ $t("gyroflightAnalyzeMissing") }}</template>
            </li>
            <li data-source="m4">
                {{ $t("gyroflightAnalyzeM4") }}:
                <template v-if="m4.report">{{ m4.report.filename }}</template>
                <template v-else>{{ $t("gyroflightAnalyzeM4Missing") }}</template>
            </li>
        </ul>

        <!-- 2. Calculate -->
        <h4 class="font-bold mt-3" data-step="calculate">2. {{ $t("gyroflightStepCalculate") }}</h4>
        <table class="gyroflight-workflow-table text-sm" data-gyrocore="workflow-parts">
            <thead>
                <tr>
                    <th>{{ $t("gyroflightPart") }}</th>
                    <th>{{ $t("gyroflightPartState") }}</th>
                    <th>{{ $t("gyroflightPartProposal") }}</th>
                    <th>{{ $t("gyroflightPartEvidence") }}</th>
                    <th>{{ $t("gyroflightPartMissing") }}</th>
                </tr>
            </thead>
            <tbody>
                <tr v-for="part in parts" :key="part.key" :data-part="part.key" :data-state="part.state">
                    <td>{{ $t(`gyroflightPart_${part.key}`) }}</td>
                    <td :class="stateClass(part.state)" class="font-bold">{{ part.state }}</td>
                    <td>{{ part.proposal ?? "--" }}</td>
                    <td class="text-dimmed">{{ part.evidence.join(", ") || "--" }}</td>
                    <td class="text-dimmed">{{ missingText(part).join("; ") || "--" }}</td>
                </tr>
            </tbody>
        </table>

        <!-- 3. Compare -->
        <h4 class="font-bold mt-3" data-step="compare">3. {{ $t("gyroflightStepCompare") }}</h4>
        <p v-if="!composite" class="text-sm text-dimmed">{{ $t("gyroflightCompareNone") }}</p>
        <table v-else class="gyroflight-workflow-table text-sm" data-gyrocore="workflow-compare">
            <thead>
                <tr>
                    <th>{{ $t("gyroflightCompareSetting") }}</th>
                    <th>{{ $t("gyroflightCompareCurrent") }}</th>
                    <th>{{ $t("gyroflightCompareProposed") }}</th>
                </tr>
            </thead>
            <tbody>
                <tr
                    v-for="row in rows"
                    :key="`${row.group}:${row.key}`"
                    :data-row="`${row.group}:${row.key}`"
                    :class="row.changed ? 'font-bold' : ''"
                >
                    <td>{{ compareLabel(row.key) }}</td>
                    <td>{{ row.current ?? "?" }}</td>
                    <td>{{ proposedText(row.proposed) }}</td>
                </tr>
            </tbody>
        </table>

        <!-- 4. Apply -->
        <h4 class="font-bold mt-3" data-step="apply">4. {{ $t("gyroflightStepApply") }}</h4>
        <ul class="text-sm" data-gyrocore="workflow-checklist">
            <li v-for="item in checklist" :key="item.key" :data-check="item.key" :data-ok="item.ok ? 'yes' : 'no'">
                <span :class="item.ok ? 'text-green-500' : 'text-red-500'" class="font-bold">
                    {{ item.ok ? "✓" : "✗" }}
                </span>
                {{ $t(`gyroflightCheck_${item.key}`) }}
                <span v-if="item.reasons.length" class="text-dimmed">({{ item.reasons.join("; ") }})</span>
            </li>
        </ul>
        <p class="text-sm text-dimmed">{{ $t("gyroflightApplyOnClick") }}</p>
        <UButton
            size="xs"
            class="mt-1"
            data-gyrocore="workflow-apply"
            :disabled="!canApply || workflow.busy"
            @click="onApply"
        >
            {{ $t("gyroflightApplyReview") }}
        </UButton>

        <!-- 5. Verify -->
        <h4 class="font-bold mt-3" data-step="verify">5. {{ $t("gyroflightStepVerify") }}</h4>
        <p v-if="!outcome" class="text-sm text-dimmed">{{ $t("gyroflightVerifyNone") }}</p>
        <div v-else-if="outcome.status === 'verified'" data-gyrocore="workflow-verified" class="text-sm">
            <p class="font-bold text-green-500">
                {{ $t(outcome.action === "apply" ? "gyroflightVerifiedApply" : "gyroflightVerifiedRestore") }}
            </p>
            <table class="gyroflight-workflow-table">
                <thead>
                    <tr>
                        <th>{{ $t("gyroflightCompareSetting") }}</th>
                        <th>{{ $t("gyroflightVerifyExpected") }}</th>
                        <th>{{ $t("gyroflightVerifyRead") }}</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="v in verifiedRows" :key="v.key" :data-verify="v.key">
                        <td>{{ compareLabel(v.key) }}</td>
                        <td>{{ v.expected }}</td>
                        <td>{{ v.read }}</td>
                    </tr>
                </tbody>
            </table>
        </div>
        <div v-else data-gyrocore="workflow-failed" :data-status="outcome.status" class="text-sm">
            <p class="font-bold text-red-500">
                {{ outcome.status === "blocked" ? $t("gyroflightApplyBlocked") : $t("gyroflightApplyFailed") }}
            </p>
            <p v-if="outcome.status === 'failed'" data-gyrocore="workflow-saved" :data-saved="outcome.saved">
                {{
                    outcome.saved === "no"
                        ? $t("gyroflightNothingSaved")
                        : t("gyroflightMaybeSaved", [outcome.stage ?? "?"])
                }}
            </p>
            <ul class="list-disc ps-5">
                <li v-for="r in outcome.reasons" :key="r">{{ r }}</li>
                <li v-for="m in outcome.mismatches" :key="m">{{ m }}</li>
            </ul>
            <p class="text-dimmed">{{ outcome.message }}</p>
        </div>

        <!-- 6. Restore -->
        <h4 class="font-bold mt-3" data-step="restore">6. {{ $t("gyroflightStepRestore") }}</h4>
        <p v-if="!connected" class="text-sm text-dimmed">{{ $t("gyroflightRestoreConnect") }}</p>
        <p v-else-if="!backups.length" class="text-sm text-dimmed">{{ $t("gyroflightRestoreNone") }}</p>
        <ul v-else class="text-sm" data-gyrocore="workflow-backups">
            <li v-for="b in backups" :key="b.id" :data-backup="b.id" class="flex items-center gap-2">
                <span>{{ b.createdAt }} · {{ $t(`gyroflightBackupReason_${b.reason}`) }} · {{ b.firmware }}</span>
                <UButton size="xs" :disabled="workflow.busy" data-gyrocore="workflow-restore" @click="onRestore(b)">
                    {{ $t("gyroflightRestore") }}
                </UButton>
                <a
                    class="underline"
                    :href="downloadHref(b)"
                    :download="`${b.id}.json`"
                    data-gyrocore="workflow-backup-download"
                    >{{ $t("gyroflightBackupDownload") }}</a
                >
            </li>
        </ul>
    </UiBox>
</template>

<script setup lang="ts">
/*
 * Gyroflight tune workflow: Analyze -> Calculate -> Compare -> Apply -> Verify -> Restore.
 * Shows what the existing analysis produced and what blocks it (tuneWorkflow.ts); writes
 * only through useTuneWorkflow (full comparison, user confirmation, then useTuneApply.ts).
 */
import { computed } from "vue";
import UiBox from "@/components/elements/UiBox.vue";
import { i18n } from "@/js/localization";
import { useConnectionStore } from "@/stores/connection";
import { useFlightControllerStore } from "@/stores/fc";
import { useTuneWorkflow } from "@/composables/useTuneWorkflow";
import { useApplyGate } from "@/gyrocore/composables/useApplyGate";
import { useChirpQualificationStore } from "@/gyrocore/stores/chirpQualification";
import { useM4FlightMetricsStore } from "@/gyrocore/stores/m4FlightMetrics";
import { useTuneBackupStore, type TuneBackup } from "@/gyrocore/stores/tuneBackup";
import { useTuneWorkflowStore } from "@/gyrocore/stores/tuneWorkflow";
import { describeCompositeReasons } from "@/gyrocore/tuning/reasons";
import {
    applyChecklist,
    compareRows,
    tuneParts,
    type CompareRow,
    type PartState,
    type TunePart,
} from "@/gyrocore/tuning/tuneWorkflow";
import { AXES } from "@/gyrocore/tuning/tuneSnapshot";

const t = (key: string, args: (string | number)[] = []) => i18n.getMessage(key, args.map(String));
const gate = useChirpQualificationStore();
const m4 = useM4FlightMetricsStore();
const connection = useConnectionStore();
const fc = useFlightControllerStore();
const backupStore = useTuneBackupStore();
const workflow = useTuneWorkflowStore();
const { composite, authorization, safety, productLock } = useApplyGate();
const { confirmAndApply, confirmAndRestore } = useTuneWorkflow();

const headerPairs = computed(
    () => gate.report?.logs.find((l) => l.logIndex === composite.value?.logIndex)?.headerPairs ?? [],
);
const measurementSummary = computed(() => {
    const ms = gate.report?.measurements ?? [];
    const by = (s: string) => ms.filter((m) => m.state === s).length;
    return i18n.getMessage("gyroflightAnalyzeChirpSummary", [
        String(ms.length),
        String(by("usable") + by("usable_with_warnings")),
        String(by("rejected")),
    ]);
});

const parts = computed(() =>
    tuneParts({
        composite: composite.value,
        safety: composite.value ? safety.value : null,
        releaseBlocks: productLock.value,
        m4: m4.report,
    }),
);
const rows = computed(() => compareRows(composite.value, headerPairs.value));
const connected = computed(() => !!connection.connectionValid);
const checklist = computed(() =>
    applyChecklist({
        composite: composite.value,
        compositeBlocks: authorization.value.blocked,
        safety: composite.value ? safety.value : null,
        releaseBlocks: productLock.value,
        connected: connected.value,
        virtualMode: !!connection.virtualMode,
    }),
);
const canApply = computed(() => !!composite.value?.final && checklist.value.every((c) => c.ok));
const outcome = computed(() => workflow.outcome);

const backups = computed(() => (connected.value ? backupStore.forUid(fc.config.uid) : []));

function measurementById(id: string) {
    return gate.report?.measurements.find((m) => m.id === id) ?? null;
}
function missingText(part: TunePart): string[] {
    return part.key === "pid" ? describeCompositeReasons(part.missing, measurementById) : part.missing;
}
function stateClass(state: PartState) {
    return state === "VALIDATED" ? "text-green-500" : state === "BLOCKED" ? "text-red-500" : "text-yellow-500";
}
function compareLabel(key: string) {
    const text = i18n.getMessage(`gyroflightCompare_${key.replace(/:/g, "_")}`);
    return text && !text.startsWith("gyroflightCompare_") ? text : key;
}
function proposedText(p: CompareRow["proposed"]) {
    if (p === "fc") {
        return i18n.getMessage("gyroflightCompareByFc");
    }
    if (p === "same") {
        return i18n.getMessage("gyroflightCompareSame");
    }
    return p ?? "--";
}

const verifiedRows = computed(() => {
    const o = workflow.outcome;
    if (!o || o.status !== "verified") {
        return [];
    }
    const out: { key: string; expected: number | undefined; read: number | undefined }[] = [];
    for (const k of Object.keys(o.expected.sliders)) {
        out.push({ key: k, expected: o.expected.sliders[k], read: o.readback.sliders[k] });
    }
    AXES.forEach((axis, i) =>
        ["P", "I", "D"].forEach((t, j) =>
            out.push({ key: `${axis}:${t}`, expected: o.expected.pids[i]?.[j], read: o.readback.pids[i]?.[j] }),
        ),
    );
    for (const k of Object.keys(o.expected.filters)) {
        out.push({ key: k, expected: o.expected.filters[k], read: o.readback.filters[k] });
    }
    return out;
});

function downloadHref(b: TuneBackup) {
    return `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(b, null, 2))}`;
}

async function onApply() {
    if (composite.value && canApply.value) {
        await confirmAndApply(composite.value, headerPairs.value);
        backupStore.reload();
    }
}

async function onRestore(b: TuneBackup) {
    await confirmAndRestore(b);
    backupStore.reload();
}
</script>

<style>
.gyroflight-workflow-table {
    border-collapse: collapse;

    th,
    td {
        padding: 3px 8px;
        text-align: start;
        border-bottom: 1px solid var(--surface-200);
        vertical-align: top;
    }
}
</style>
