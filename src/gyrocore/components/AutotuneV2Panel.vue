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
                        <th>{{ $t("gyroflightV2Resolution") }}</th>
                        <th>{{ $t("gyroflightV2Evidence") }}</th>
                        <th>{{ $t("gyroflightPartState") }}</th>
                    </tr>
                </thead>
                <tbody>
                    <tr
                        v-for="row in marginRows"
                        :key="row.axis"
                        :data-axis="row.axis"
                        :data-evidence="row.evidence"
                        :data-state="row.status"
                    >
                        <td>{{ row.axis }}</td>
                        <td>{{ row.chain }}</td>
                        <td>{{ row.fc }}</td>
                        <td>
                            {{ row.pm }}<br /><span class="text-dimmed"
                                >{{ $t("gyroflightV2Measured") }} {{ row.pmMeasured }}</span
                            >
                        </td>
                        <td>
                            {{ row.gm }}<br /><span class="text-dimmed"
                                >{{ $t("gyroflightV2Measured") }} {{ row.gmMeasured }}</span
                            >
                        </td>
                        <td>
                            {{ row.s }}<br /><span class="text-dimmed"
                                >{{ $t("gyroflightV2Measured") }} {{ row.sMeasured }}</span
                            >
                        </td>
                        <td>{{ row.resolution }}</td>
                        <td :class="evidenceClass(row.evidence)" class="font-bold">{{ row.evidence }}</td>
                        <td :class="row.validated ? 'text-green-500' : 'text-yellow-500'">
                            {{ row.status }}
                        </td>
                    </tr>
                </tbody>
            </table>
            <p class="text-sm text-dimmed" data-gyrocore="v2-evidence-legend">{{ $t("gyroflightV2EvidenceLegend") }}</p>
            <ul class="text-sm" data-gyrocore="v2-margin-evidence">
                <li v-for="row in marginRows" :key="row.axis" :data-axis="row.axis" :data-evidence="row.evidence">
                    <span v-for="(line, k) in row.details" :key="k" class="block">{{ line }}</span>
                </li>
            </ul>

            <template v-if="result.measurementPlan?.length">
                <p class="font-bold text-sm mt-2">{{ $t("gyroflightV2PlanTitle") }}</p>
                <p class="text-sm text-dimmed">{{ $t("gyroflightV2PlanHelp") }}</p>
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
                        <tr v-for="p in result.measurementPlan" :key="p.axis" :data-axis="p.axis">
                            <td>{{ p.axis }}</td>
                            <td>{{ band(p.bandHz.primary) }}</td>
                            <td>
                                {{ num(p.resolutionHz.now, 2) }} / {{ num(p.resolutionHz.primary, 2) }} /
                                {{ num(p.resolutionHz.qualification, 3) }}
                            </td>
                            <td>
                                {{ p.segmentSamples.primary ?? "--" }} / {{ p.segmentSamples.qualification ?? "--" }}
                            </td>
                            <td>{{ p.averages.now ?? "--" }} / {{ p.averages.needed ?? "--" }}</td>
                            <td>
                                {{ p.sweep ? `${num(p.sweep.durationS, 0)} × ${p.sweep.repeats}` : "--" }};
                                {{
                                    p.qualificationSweep
                                        ? `${num(p.qualificationSweep.durationS, 0)} × ${p.qualificationSweep.repeats}`
                                        : "--"
                                }}
                            </td>
                            <td>{{ p.diagnostics.join(", ") || "--" }}</td>
                        </tr>
                    </tbody>
                </table>
            </template>

            <template v-if="v2.qualification">
                <p class="font-bold text-sm mt-2">{{ $t("gyroflightV2QualTitle") }}</p>
                <p class="text-sm text-dimmed">{{ $t("gyroflightV2QualHelp") }}</p>
                <p class="text-sm" data-gyrocore="v2-qualification-source">
                    {{
                        v2.qualification.source
                            ? qualSourceText(v2.qualification.source)
                            : $t("gyroflightV2QualNoSource")
                    }}
                </p>
                <ul class="text-sm" data-gyrocore="v2-qualification-criteria">
                    <li
                        v-for="c in v2.qualification.criteria"
                        :key="c.name"
                        :data-criterion="c.name"
                        :data-status="c.status"
                    >
                        <span
                            :class="
                                c.status === 'PASS'
                                    ? 'text-green-500'
                                    : c.status === 'FAIL'
                                      ? 'text-red-500'
                                      : 'text-yellow-500'
                            "
                        >
                            {{ c.status }}
                        </span>
                        {{ c.name
                        }}<span v-if="c.reasons.length" class="text-dimmed">
                            ({{ c.reasons.slice(0, 6).join("; ") }})</span
                        >
                    </li>
                </ul>
                <ul class="text-sm" data-gyrocore="v2-qualification-axes">
                    <li v-for="a in v2.qualification.axes" :key="a.axis" :data-axis="a.axis" :data-level="a.level">
                        {{ a.axis }}: {{ a.level }} · {{ a.status }} · {{ a.verdict ?? "--" }}
                    </li>
                </ul>
            </template>

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
            <UncertainStateNotice />
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
                <!--
                    Stage "prepare": no SET was sent (a check or a fresh read failed first). No stage: an
                    error outside the write route's stages, where a sent SET is not recorded either way.
                    Neither says what the craft holds now: nothing was read back after the failure, and
                    another PID profile may be active.
                -->
                <div v-if="!outcome.stage || outcome.stage === 'prepare'" data-gyrocore="v2-nothing-written">
                    <p :data-gyrocore="outcome.stage ? 'v2-no-set' : 'v2-set-unrecorded'">
                        {{ $t(outcome.stage ? "gyroflightV2NothingWritten" : "gyroflightV2StageUnknownWrite") }}
                    </p>
                    <p class="text-yellow-500" data-gyrocore="v2-not-reverified">
                        {{ $t("gyroflightV2NotReverified") }}
                    </p>
                    <p v-if="prepareProfileText" class="text-yellow-500" data-gyrocore="v2-prepare-profile">
                        {{ prepareProfileText }}
                    </p>
                    <p v-if="backupKeptText" data-gyrocore="v2-backup-kept">{{ backupKeptText }}</p>
                </div>
                <!-- A SET was sent and the craft could not be read back afterwards. -->
                <p v-else-if="outcome.changedFromBackup === null" class="text-yellow-500" data-gyrocore="v2-fc-unknown">
                    {{
                        outcome.stage === "write"
                            ? $t("gyroflightV2SetResultUnknown")
                            : $t("gyroflightV2CurrentUnknown")
                    }}
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
                <!-- A PID profile switch after a SET: the other profile may hold the write in RAM. -->
                <div
                    v-if="outcome.profileSwitch && profileSwitchText"
                    class="text-yellow-500"
                    data-gyrocore="v2-profile-switch"
                    :data-from="outcome.profileSwitch.from"
                    :data-to="outcome.profileSwitch.to ?? ''"
                >
                    <p>{{ profileSwitchText.ram }}</p>
                    <p>{{ profileSwitchText.saved }}</p>
                    <p class="font-bold">{{ profileSwitchText.noSave }}</p>
                    <p>{{ profileSwitchText.recovery }}</p>
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
import { useFcTransactionStore } from "@/gyrocore/stores/fcTransactionState";
import UncertainStateNotice from "@/gyrocore/components/UncertainStateNotice.vue";
import { evaluateRelease, LIVE_CONDITIONS } from "@/gyrocore/releaseGate/releaseContract";
import { absoluteWriteDecision } from "@/gyrocore/releaseGate/writeAuthority";
import { RESOLVED_FEATURE_BINS, type LoopMargins } from "@/gyrocore/engine/loopModel";

const v2 = useAutotuneV2Store();
const connection = useConnectionStore();
const fc = useFlightControllerStore();
const backupStore = useTuneBackupStore();
const transactionStates = useFcTransactionStore();
const { calculate, createVerifiedTune, preview, releasedProposal, confirmAndApply, confirmAndRestore } =
    useAutotuneV2();

const result = computed(() => v2.result);
const num = (x: number | null | undefined, digits: number) =>
    x == null || !Number.isFinite(x) ? "--" : x.toFixed(digits);
const band = (b: [number, number] | null) => (b ? `${num(b[0], 1)}–${num(b[1], 1)}` : "--");
const qualSourceText = (s: { sha256: string; logIndex: number }) =>
    i18n.getMessage("gyroflightV2QualSource", [s.sha256.slice(0, 12), String(s.logIndex + 1)]);
const outcome = computed(() => v2.outcome);

/** The profile-switch warning of a failed write: which profile may hold it, and how to recover. */
const profileSwitchText = computed(() => {
    const o = outcome.value;
    if (!o || o.status === "verified" || !o.profileSwitch) return null;
    const to = o.profileSwitch.to === null ? "?" : String(o.profileSwitch.to + 1);
    const from = String(o.profileSwitch.from + 1);
    return {
        ram: i18n.getMessage("gyroflightV2ProfileSwitchRam", [to, from]),
        saved: i18n.getMessage(
            o.saved === "no" ? "gyroflightV2ProfileSwitchNotSaved" : "gyroflightV2ProfileSwitchSaveUnknown",
        ),
        noSave: i18n.getMessage("gyroflightV2ProfileSwitchNoSave"),
        recovery: i18n.getMessage("gyroflightV2ProfileSwitchRecovery", [to, from]),
    };
});
/** A profile switch seen before the first SET: nothing written, but the active profile is not the backed-up one. */
const prepareProfileText = computed(() => {
    const o = outcome.value;
    if (!o || o.status === "verified" || !o.prepareProfileSwitch) return null;
    const { from, to } = o.prepareProfileSwitch;
    return i18n.getMessage("gyroflightV2PrepareProfileSwitch", [String(from + 1), to === null ? "?" : String(to + 1)]);
});
/** The backup taken before the failed attempt, with the PID profile it holds (only when one was taken). */
const backupKeptText = computed(() => {
    const o = outcome.value;
    if (!o || o.status === "verified" || !o.backupId) return null;
    const profile = backupStore.backups.find((b) => b.id === o.backupId)?.absolute?.pidProfile;
    return i18n.getMessage("gyroflightV2BackupKept", [profile == null ? "?" : String(profile + 1)]);
});
const released = computed(() => (v2.result ? releasedProposal() : null));
const connected = computed(() => !!connection.connectionValid);

/**
 * The contract of what Apply would write (the releasable part, or the whole proposal when nothing
 * is), then the write authority's other steps: binding, GyroCore Safety, product lock.
 */
const contract = computed(() => {
    const p = v2.result?.releasableProposal ?? v2.result?.proposal;
    if (!p) return [];
    const authority = absoluteWriteDecision(p, { recompute: false }).steps.filter((s) => s.name !== "release_contract");
    return [...evaluateRelease(p).conditions, ...authority];
});

const canPreview = computed(() => !!v2.result?.proposal && connected.value && !connection.virtualMode);
// An earlier write on this craft whose outcome nobody verified refuses every Apply (fcTransactionState).
const stateBlocks = computed(() => transactionStates.blocks(fc.config.uid));
const canApply = computed(
    () => !!released.value && connected.value && !connection.virtualMode && !stateBlocks.value.length,
);

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
        const ev = m.proposed.evidence;
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
                pmMeasured: `${fmt(m.current.measured?.phaseMarginDeg)} → ${fmt(m.proposed.measured?.phaseMarginDeg)}°`,
                gmMeasured: `${fmt(m.current.measured?.gainMarginDb)} → ${fmt(m.proposed.measured?.gainMarginDb)} dB`,
                sMeasured: `${fmt(m.current.measured?.sensitivityPeakDb)} → ${fmt(m.proposed.measured?.sensitivityPeakDb)} dB`,
                resolution: `${fmt(ev?.resolutionHz, 2)} Hz`,
                evidence: ev?.level ?? "INSUFFICIENT",
                status: m.proposed.status,
                // Green only for VALIDATED margins on VALIDATED evidence (never for MODEL_CONDITIONAL).
                validated: m.proposed.status === "VALIDATED" && ev?.level === "VALIDATED",
                details: evidenceDetails(axis, m.proposed, r.pid.find((p) => p.axis === axis)?.reasons ?? []),
            },
        ];
    });
});

/** The measurements that would give the margins a better basis (loopModel / pidOptimizer name them). */
const MARGIN_NEEDS = new Set([
    "required_measurement:chirp_finer_resolution_model_class_qualification",
    "required_measurement:chirp_with_finer_frequency_resolution",
    "required_measurement:chirp_to_higher_frequency_for_gain_margin",
    "required_measurement:chirp_to_higher_frequency_for_sensitivity_peak",
]);

/**
 * What the proposed margins rest on, in words: range, assumptions, qualification, what is still
 * needed. `pidReasons` adds the needs the PID search derives from the margins (finer resolution,
 * higher CHIRP end).
 */
function evidenceDetails(axis: string, m: LoopMargins, pidReasons: string[]): string[] {
    const ev = m.evidence;
    if (!ev) return [];
    const out: string[] = [];
    if (ev.bandHz) {
        out.push(
            i18n.getMessage("gyroflightV2EvidenceRange", [
                axis,
                fmt(ev.bandHz[0]),
                fmt(ev.bandHz[1]),
                fmt(ev.resolutionHz, 2),
            ]),
        );
    }
    if (ev.level === "MEASURED") out.push(i18n.getMessage("gyroflightV2EvidenceMeasuredOnly"));
    if (ev.level === "MODEL_CONDITIONAL") {
        out.push(i18n.getMessage("gyroflightV2EvidenceConditional", [fmt(ev.minFeatureWidthHz, 2)]));
    }
    const q = ev.qualification;
    if (q && q.verdict === "PASS" && ev.level === "VALIDATED") {
        out.push(
            i18n.getMessage("gyroflightV2EvidenceQualified", [
                q.source.sha256.slice(0, 8),
                fmt(q.resolutionHz, 3),
                fmt(q.resolutionHz === null ? null : q.resolutionHz * RESOLVED_FEATURE_BINS, 3),
            ]),
        );
    } else if (q) {
        out.push(
            i18n.getMessage("gyroflightV2EvidenceQualificationNotPassed", [
                q.source.sha256.slice(0, 8),
                q.verdict,
                q.reasons.slice(0, 3).join(", ") || "--",
            ]),
        );
    }
    if (ev.assumptions.length)
        out.push(i18n.getMessage("gyroflightV2EvidenceAssumptions", [ev.assumptions.join(", ")]));
    const needs = [
        ...new Set(
            [...m.reasons, ...pidReasons].filter(
                (r) =>
                    MARGIN_NEEDS.has(r) ||
                    /^required_measurement:chirp_(roll|pitch|yaw)_meeting_qualification$/.test(r),
            ),
        ),
    ];
    if (ev.level !== "VALIDATED" && needs.length) {
        out.push(i18n.getMessage("gyroflightV2EvidenceNeeded", [needs.map(measurementText).join("; ")]));
    }
    return out;
}

function evidenceClass(level: string) {
    return level === "VALIDATED"
        ? "text-green-500"
        : level === "MODEL_CONDITIONAL"
          ? "text-orange-500"
          : "text-yellow-500";
}

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
