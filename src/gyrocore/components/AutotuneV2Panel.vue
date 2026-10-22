<template>
    <UiBox :title="$t('gyroflightV2Title')" type="neutral" data-gyrocore="autotune-v2">
        <p class="text-sm text-dimmed mb-2">{{ $t("gyroflightV2Intro") }}</p>

        <!-- 1. Analyze -->
        <h4 class="font-bold mt-2" data-step="v2-analyze">1. {{ $t("gyroflightStepAnalyze") }}</h4>
        <p v-if="!v2.sources.length" class="text-sm text-dimmed" data-gyrocore="v2-no-source">
            {{ $t("gyroflightV2NoSource") }}
        </p>
        <ul v-else class="list-disc ps-5 text-sm" data-gyrocore="v2-sources">
            <li v-for="s in v2.sources" :key="s.filename" :data-source="s.filename">
                {{ s.filename }} · {{ summary(s) }}
            </li>
        </ul>
        <UButton
            size="xs"
            class="mt-1"
            data-gyrocore="v2-calculate"
            :loading="v2.state === 'calculating'"
            :disabled="!v2.sources.length || v2.state === 'calculating'"
            @click="calculate"
        >
            {{ $t("gyroflightV2Calculate") }}
        </UButton>
        <UButton
            size="xs"
            variant="outline"
            class="mt-1 ms-2"
            data-gyrocore="v2-verified-tune"
            :disabled="v2.sources.length < 2 || v2.state === 'calculating'"
            @click="createVerifiedTune"
        >
            {{ $t("gyroflightV2CreateVerifiedTune") }}
        </UButton>
        <p class="text-sm text-dimmed">{{ $t("gyroflightV2VerifiedTuneHelp") }}</p>
        <div
            v-if="v2.verifiedTuneAttempt"
            class="text-sm"
            data-gyrocore="v2-verified-tune-result"
            :data-verdict="v2.verifiedTuneAttempt.verdict"
        >
            <span
                :class="v2.verifiedTuneAttempt.verdict === 'PASS' ? 'text-green-500' : 'text-red-500'"
                class="font-bold"
            >
                {{ $t(`gyroflightV2VerifiedTune_${v2.verifiedTuneAttempt.verdict}`) }}
            </span>
            <span v-if="v2.verifiedTuneAttempt.reasons.length" class="text-dimmed">
                ({{ v2.verifiedTuneAttempt.reasons.join("; ") }})
            </span>
        </div>
        <p v-if="v2.progressMessage" class="text-sm text-dimmed">{{ v2.progressMessage }}</p>
        <p v-if="v2.state === 'error'" class="text-sm text-red-500" data-gyrocore="v2-error">{{ v2.errorMessage }}</p>

        <template v-if="result">
            <!-- 2. Calculate -->
            <h4 class="font-bold mt-3" data-step="v2-calculate">2. {{ $t("gyroflightStepCalculate") }}</h4>
            <table class="gyroflight-workflow-table text-sm" data-gyrocore="v2-parts">
                <thead>
                    <tr>
                        <th>{{ $t("gyroflightPart") }}</th>
                        <th>{{ $t("gyroflightPartState") }}</th>
                        <th>{{ $t("gyroflightPartMissing") }}</th>
                        <th>{{ $t("gyroflightPartEvidence") }}</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="p in result.parts" :key="p.part" :data-part="p.part" :data-state="p.status">
                        <td>{{ $t(`gyroflightV2Part_${p.part}`) }}</td>
                        <td :class="stateClass(p.status)" class="font-bold">{{ p.status }}</td>
                        <td class="text-dimmed">
                            {{ p.requiredMeasurements.map(measurementText).join("; ") || "--" }}
                        </td>
                        <td class="text-dimmed">
                            {{ p.reasons.filter((r) => !r.includes("required_measurement:")).join(", ") || "--" }}
                        </td>
                    </tr>
                </tbody>
            </table>

            <p class="text-sm font-bold mt-2">{{ $t("gyroflightV2Margins") }}</p>
            <table class="gyroflight-workflow-table text-sm" data-gyrocore="v2-margins">
                <thead>
                    <tr>
                        <th>{{ $t("gyroflightV2Axis") }}</th>
                        <th>{{ $t("gyroflightV2ChainFit") }}</th>
                        <th>{{ $t("gyroflightV2Crossover") }}</th>
                        <th>PM</th>
                        <th>GM</th>
                        <th>|S|</th>
                        <th>{{ $t("gyroflightPartState") }}</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="row in marginRows" :key="row.axis" :data-axis="row.axis">
                        <td>{{ row.axis }}</td>
                        <td>{{ row.chain }}</td>
                        <td>{{ row.fc }}</td>
                        <td>{{ row.pm }}</td>
                        <td>{{ row.gm }}</td>
                        <td>{{ row.s }}</td>
                        <td :class="row.status === 'VALIDATED' ? 'text-green-500' : 'text-yellow-500'">
                            {{ row.status }}
                        </td>
                    </tr>
                </tbody>
            </table>

            <!-- 3. Compare -->
            <h4 class="font-bold mt-3" data-step="v2-compare">3. {{ $t("gyroflightStepCompare") }}</h4>
            <p v-if="!result.proposal" class="text-sm text-dimmed" data-gyrocore="v2-no-change">
                {{ $t("gyroflightV2NoChange") }}
            </p>
            <table v-else class="gyroflight-workflow-table text-sm" data-gyrocore="v2-compare">
                <thead>
                    <tr>
                        <th>{{ $t("gyroflightCompareSetting") }}</th>
                        <th>{{ $t("gyroflightCompareCurrent") }}</th>
                        <th>{{ $t("gyroflightCompareProposed") }}</th>
                        <th>{{ $t("gyroflightPartState") }}</th>
                        <th>{{ $t("gyroflightV2Written") }}</th>
                    </tr>
                </thead>
                <tbody>
                    <tr
                        v-for="it in result.proposal.items"
                        :key="it.key"
                        :data-item="it.key"
                        :data-state="it.status"
                        :title="it.reasons.join('\n')"
                    >
                        <td>{{ it.key }}</td>
                        <td>{{ it.from }}</td>
                        <td class="font-bold">{{ it.to }}</td>
                        <td :class="stateClass(it.status)">{{ it.status }}</td>
                        <td>{{ released && released.change[it.key] !== undefined ? "✓" : "✗" }}</td>
                    </tr>
                </tbody>
            </table>
            <p v-if="result.proposal" class="text-sm text-dimmed">{{ $t("gyroflightV2NotValidatedNote") }}</p>

            <!-- 4. Apply -->
            <h4 class="font-bold mt-3" data-step="v2-apply">4. {{ $t("gyroflightStepApply") }}</h4>
            <ul class="text-sm" data-gyrocore="v2-contract">
                <li v-for="c in contract" :key="c.name" :data-condition="c.name" :data-ok="c.passed ? 'yes' : 'no'">
                    <span :class="c.passed ? 'text-green-500' : 'text-red-500'" class="font-bold">
                        {{ c.passed ? "✓" : "✗" }}
                    </span>
                    {{ $t(`gyroflightV2Cond_${c.name}`) }}
                    <span v-if="c.reasons.length" class="text-dimmed">({{ c.reasons.slice(0, 4).join("; ") }})</span>
                </li>
                <li v-for="name in LIVE_CONDITIONS" :key="name" :data-condition="name" data-ok="live">
                    <span class="font-bold">·</span> {{ $t(`gyroflightV2Cond_${name}`) }}
                </li>
            </ul>
            <p class="text-sm text-dimmed">{{ $t("gyroflightApplyOnClick") }}</p>
            <UButton
                size="xs"
                variant="outline"
                class="mt-1 me-2"
                data-gyrocore="v2-preview"
                :disabled="!canPreview || v2.busy"
                @click="onPreview"
            >
                {{ $t("gyroflightPreviewButton") }}
            </UButton>
            <UButton size="xs" class="mt-1" data-gyrocore="v2-apply" :disabled="!canApply || v2.busy" @click="onApply">
                {{ $t("gyroflightApplyReview") }}
            </UButton>
            <div
                v-if="v2.preview"
                class="text-sm mt-2"
                data-gyrocore="v2-preview-result"
                :data-status="v2.preview.status"
            >
                <p class="font-bold">{{ $t("gyroflightPreviewTitle") }}</p>
                <table v-if="v2.preview.status === 'ok'" class="gyroflight-workflow-table">
                    <tbody>
                        <tr v-for="r in v2.preview.changes" :key="r.key" :data-preview="r.key">
                            <td>{{ r.key }}</td>
                            <td>{{ r.from ?? "?" }}</td>
                            <td>{{ r.to ?? "?" }}</td>
                        </tr>
                    </tbody>
                </table>
                <ul v-else class="list-disc ps-5">
                    <li v-for="r in v2.preview.reasons" :key="r" class="text-red-500">{{ r }}</li>
                </ul>
            </div>
        </template>

        <!-- 5. Verify -->
        <h4 class="font-bold mt-3" data-step="v2-verify">5. {{ $t("gyroflightStepVerify") }}</h4>
        <p v-if="!outcome" class="text-sm text-dimmed">{{ $t("gyroflightVerifyNone") }}</p>
        <div v-else-if="outcome.status === 'verified'" class="text-sm" data-gyrocore="v2-verified">
            <p class="font-bold text-green-500">
                {{ $t(outcome.action === "apply" ? "gyroflightVerifiedApply" : "gyroflightVerifiedRestore") }}
            </p>
            <p v-if="outcome.rebootRequired" class="text-yellow-500" data-gyrocore="v2-reboot">
                {{ $t("gyroflightV2RebootRequired") }}
            </p>
        </div>
        <div v-else class="text-sm" data-gyrocore="v2-failed" :data-status="outcome.status" :data-saved="outcome.saved">
            <p class="font-bold text-red-500">
                {{ outcome.status === "blocked" ? $t("gyroflightApplyBlocked") : $t("gyroflightApplyFailed") }}
            </p>
            <!-- Where it stopped and why: the write route's phase and the error itself. -->
            <p v-if="outcome.stage" data-gyrocore="v2-stage" :data-stage="outcome.stage">
                {{ $t("gyroflightV2FailedStage") }}: {{ $t(`gyroflightV2Stage_${outcome.stage}`) }}
            </p>
            <p v-if="outcome.status === 'failed' && outcome.message" data-gyrocore="v2-cause">
                {{ $t("gyroflightV2FailedCause") }}: {{ outcome.message }}
            </p>
            <p v-if="outcome.status === 'failed'">{{ $t(`gyroflightV2Saved_${outcome.saved ?? "unknown"}`) }}</p>
            <ul class="list-disc ps-5">
                <li v-for="r in outcome.reasons" :key="r">{{ r }}</li>
                <li v-for="m in outcome.mismatches" :key="m">{{ m }}</li>
            </ul>
            <!-- What the flight controller holds now, against the backup taken before the write. -->
            <template v-if="outcome.status === 'failed'">
                <p v-if="!outcome.stage" data-gyrocore="v2-nothing-written">{{ $t("gyroflightV2NothingWritten") }}</p>
                <p v-else-if="outcome.changedFromBackup === null" class="text-yellow-500" data-gyrocore="v2-fc-unknown">
                    {{ $t("gyroflightV2CurrentUnknown") }}
                </p>
                <p v-else-if="!outcome.changedFromBackup.length" data-gyrocore="v2-fc-as-backup">
                    {{ $t("gyroflightV2CurrentAsBackup") }}
                </p>
                <div v-else data-gyrocore="v2-partial">
                    {{ $t("gyroflightV2PartialWrite") }}
                    <ul class="list-disc ps-5">
                        <li v-for="d in outcome.changedFromBackup" :key="d">{{ d }}</li>
                    </ul>
                </div>
                <p v-if="outcome.backupId" class="text-dimmed" data-gyrocore="v2-failed-backup">
                    {{ $t("gyroflightV2FailedBackup") }} {{ outcome.backupId }}
                </p>
            </template>
        </div>

        <!-- 6. Restore -->
        <h4 class="font-bold mt-3" data-step="v2-restore">6. {{ $t("gyroflightStepRestore") }}</h4>
        <p v-if="!connected" class="text-sm text-dimmed">{{ $t("gyroflightRestoreConnect") }}</p>
        <p v-else-if="!backups.length" class="text-sm text-dimmed">{{ $t("gyroflightRestoreNone") }}</p>
        <ul v-else class="text-sm" data-gyrocore="v2-backups">
            <li v-for="b in backups" :key="b.id" :data-backup="b.id" class="flex items-center gap-2">
                <span>{{ b.createdAt }} · {{ $t(`gyroflightBackupReason_${b.reason}`) }} · {{ b.firmware }}</span>
                <UButton size="xs" :disabled="v2.busy" data-gyrocore="v2-restore" @click="onRestore(b)">
                    {{ $t("gyroflightRestore") }}
                </UButton>
            </li>
        </ul>
    </UiBox>
</template>

<script setup lang="ts">
/*
 * Autotune engine v2: Analyze -> Calculate -> Compare -> Apply -> Verify -> Restore for
 * absolute PID, feedforward and filter values. Every part shows its status and the
 * measurement it still needs; only VALIDATED values under a released contract can be
 * applied, and only by the user's click (useAutotuneV2).
 */
import { computed } from "vue";
import UiBox from "@/components/elements/UiBox.vue";
import { i18n } from "@/js/localization";
import { useConnectionStore } from "@/stores/connection";
import { useFlightControllerStore } from "@/stores/fc";
import { useAutotuneV2 } from "@/composables/useAutotuneV2";
import { useAutotuneV2Store, type AutotuneV2Source } from "@/gyrocore/stores/autotuneV2";
import { useTuneBackupStore, type TuneBackup } from "@/gyrocore/stores/tuneBackup";
import { evaluateRelease, LIVE_CONDITIONS } from "@/gyrocore/releaseGate/releaseContract";

const v2 = useAutotuneV2Store();
const connection = useConnectionStore();
const fc = useFlightControllerStore();
const backupStore = useTuneBackupStore();
const { calculate, createVerifiedTune, preview, releasedProposal, confirmAndApply, confirmAndRestore } =
    useAutotuneV2();

const result = computed(() => v2.result);
const outcome = computed(() => v2.outcome);
const released = computed(() => (v2.result ? releasedProposal() : null));
const connected = computed(() => !!connection.connectionValid);

/** The contract of what Apply would write: the releasable part, or the whole proposal when nothing is. */
const contract = computed(() => {
    const p = v2.result?.releasableProposal ?? v2.result?.proposal;
    return p ? evaluateRelease(p).conditions : [];
});

const canPreview = computed(() => !!v2.result?.proposal && connected.value && !connection.virtualMode);
const canApply = computed(() => !!released.value && connected.value && !connection.virtualMode);

function summary(s: AutotuneV2Source) {
    const ms = s.report.measurements;
    return i18n.getMessage("gyroflightAnalyzeChirpSummary", [
        String(ms.length),
        String(ms.filter((m) => m.state !== "rejected").length),
        String(ms.filter((m) => m.state === "rejected").length),
    ]);
}

const fmt = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? "?" : v.toFixed(d));

const marginRows = computed(() => {
    const r = v2.result;
    if (!r) return [];
    return (["roll", "pitch", "yaw"] as const).flatMap((axis, i) => {
        const m = r.margins[axis];
        if (!m) return [];
        const chain = r.chain.validation[i];
        const band = chain?.fit?.bands.find((b) => b.loHz === 20);
        return [
            {
                axis,
                chain: chain
                    ? `${chain.controlBand}${band?.phaseDeg !== null && band ? ` (${band.phaseDeg.toFixed(1)}°)` : ""}`
                    : "--",
                fc: `${fmt(m.current.crossoverHz)} → ${fmt(m.proposed.crossoverHz)} Hz`,
                pm: `${fmt(m.current.phaseMarginDeg)} → ${fmt(m.proposed.phaseMarginDeg)}°`,
                gm: `${fmt(m.current.gainMarginDb)} → ${fmt(m.proposed.gainMarginDb)} dB`,
                s: `${fmt(m.current.sensitivityPeakDb)} → ${fmt(m.proposed.sensitivityPeakDb)} dB`,
                status: m.proposed.status,
            },
        ];
    });
});

const backups = computed(() => (connected.value ? backupStore.forUid(fc.config.uid).filter((b) => !!b.absolute) : []));

function stateClass(state: string) {
    return state === "VALIDATED" ? "text-green-500" : state === "BLOCKED" ? "text-red-500" : "text-yellow-500";
}

function measurementText(code: string) {
    const key = `gyroflightV2Need_${code.replace("required_measurement:", "")}`;
    const text = i18n.getMessage(key);
    return text && text !== key ? text : code.replace("required_measurement:", "");
}

async function onPreview() {
    if (canPreview.value && !v2.busy) {
        v2.busy = true;
        try {
            await preview();
        } finally {
            v2.busy = false;
        }
    }
}

async function onApply() {
    if (canApply.value) {
        await confirmAndApply();
        backupStore.reload();
    }
}

async function onRestore(b: TuneBackup) {
    await confirmAndRestore(b);
    backupStore.reload();
}
</script>
