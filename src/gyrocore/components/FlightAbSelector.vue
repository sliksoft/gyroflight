<template>
    <UiBox
        v-if="expertMode"
        :title="$t('gyrocoreAbTitle')"
        type="neutral"
        collapsible
        data-gyrocore="flight-ab-selector"
    >
        <p class="text-sm text-dimmed mb-2">{{ $t("gyrocoreAbIntro") }}</p>
        <p class="text-sm font-bold mb-3" role="note" data-gyrocore="ab-not-verified-tune">
            {{ t("gyrocoreAbNotVerifiedTune", [PRODUCT_APPLY_PENDING]) }}
        </p>

        <!-- Tune Session -->
        <section class="mb-3" data-gyrocore="ab-session">
            <h4 class="text-sm font-bold mb-1">{{ $t("gyrocoreAbSessionHead") }}</h4>
            <p v-if="sel.listState.value === 'loading'" class="text-sm text-dimmed" data-gyrocore="ab-sessions-loading">
                {{ $t("gyrocoreAbSessionsLoading") }}
            </p>
            <p
                v-else-if="sel.listState.value === 'error'"
                class="text-sm text-error"
                role="alert"
                data-gyrocore="ab-sessions-error"
                :data-reason="sel.listError.value"
            >
                {{ t("gyrocoreAbSessionsError", [sel.listError.value ?? ""]) }}
            </p>
            <p
                v-else-if="sel.listState.value === 'ready' && !sel.sessions.value.length"
                class="text-sm text-dimmed"
                data-gyrocore="ab-sessions-empty"
            >
                {{ $t("gyrocoreAbSessionsEmpty") }}
            </p>
            <div v-if="sel.sessions.value.length" class="flex flex-wrap items-center gap-2">
                <label class="text-sm" for="gyrocore-ab-session">{{ $t("gyrocoreAbSessionLabel") }}</label>
                <select
                    id="gyrocore-ab-session"
                    class="rounded border border-default bg-default px-1.5 py-0.5 text-sm"
                    data-gyrocore="ab-session-select"
                    :value="sel.sessionId.value ?? ''"
                    @change="onSessionChange"
                >
                    <option value="">{{ $t("gyrocoreAbSessionNone") }}</option>
                    <option
                        v-for="s in sel.sessions.value"
                        :key="s.id"
                        :value="s.id"
                        :disabled="s.status !== 'ok'"
                        :data-session="s.id"
                        :data-status="s.status"
                    >
                        {{ sessionLabel(s) }}
                    </option>
                </select>
                <UButton size="xs" variant="outline" data-gyrocore="ab-sessions-refresh" @click="refresh">
                    {{ $t("gyrocoreAbRefresh") }}
                </UButton>
            </div>
            <ul
                v-if="damagedSessions.length"
                class="text-sm text-warning list-disc ps-5 mt-1"
                data-gyrocore="ab-sessions-damaged"
            >
                <li v-for="s in damagedSessions" :key="s.id" :data-session="s.id" :data-status="s.status">
                    {{
                        t(s.status === "corrupt" ? "gyrocoreAbSessionCorrupt" : "gyrocoreAbSessionUnsupported", [s.id])
                    }}
                </li>
            </ul>

            <p v-if="sel.loadState.value === 'loading'" class="text-sm text-dimmed" data-gyrocore="ab-session-loading">
                {{ $t("gyrocoreAbSessionLoading") }}
            </p>
            <p
                v-else-if="loadProblem"
                class="text-sm text-error"
                role="alert"
                data-gyrocore="ab-session-problem"
                :data-status="loadProblem.status"
            >
                {{ t("gyrocoreAbSessionProblem", [loadProblem.status, loadProblem.detail]) }}
            </p>

            <!-- Saving happens only on this explicit action; nothing is saved or uploaded automatically. -->
            <div v-if="gate.report" class="flex flex-wrap items-center gap-2 mt-2" data-gyrocore="ab-save">
                <input
                    v-model="saveName"
                    class="rounded border border-default bg-default px-1.5 py-0.5 text-sm"
                    type="text"
                    maxlength="200"
                    :aria-label="$t('gyrocoreAbSaveName')"
                    :placeholder="$t('gyrocoreAbSaveName')"
                    data-gyrocore="ab-save-name"
                />
                <UButton
                    size="xs"
                    variant="outline"
                    :disabled="sel.saving.value"
                    data-gyrocore="ab-save-new"
                    @click="save(false)"
                >
                    {{ $t("gyrocoreAbSaveNew") }}
                </UButton>
                <UButton
                    v-if="sel.session.value"
                    size="xs"
                    variant="outline"
                    :disabled="sel.saving.value || hasRejectedParts"
                    data-gyrocore="ab-save-into"
                    @click="save(true)"
                >
                    {{ $t("gyrocoreAbSaveInto") }}
                </UButton>
                <span
                    v-if="saveMessage"
                    class="text-sm"
                    data-gyrocore="ab-save-result"
                    :data-status="saveMessage.status"
                    >{{ saveMessage.text }}</span
                >
            </div>
        </section>

        <template v-if="sel.session.value">
            <!-- Every Flight of the session, selectable or not, with the reason -->
            <section class="mb-3" data-gyrocore="ab-flights">
                <h4 class="text-sm font-bold mb-1">{{ $t("gyrocoreAbFlightsHead") }}</h4>
                <p
                    v-if="!sel.flights.value.options.length && !sel.flights.value.rejected.length"
                    class="text-sm text-dimmed"
                    data-gyrocore="ab-flights-empty"
                >
                    {{ $t("gyrocoreAbFlightsEmpty") }}
                </p>
                <p
                    v-else-if="selectableCount < 2"
                    class="text-sm text-warning"
                    data-gyrocore="ab-flights-too-few"
                    :data-count="selectableCount"
                >
                    {{ t("gyrocoreAbFlightsTooFew", [selectableCount]) }}
                </p>
                <ul class="text-sm list-disc ps-5">
                    <li
                        v-for="o in sel.flights.value.options"
                        :key="o.key"
                        :data-flight="o.key"
                        :data-selectable="o.selectable ? 'yes' : 'no'"
                    >
                        {{ flightLabel(o) }}
                        <span v-if="!o.selectable" class="text-error">
                            · {{ t("gyrocoreAbNotSelectable", [o.reasons.join(", ")]) }}</span
                        >
                        <span v-if="o.rejectedChirpCount" class="text-warning">
                            · {{ t("gyrocoreAbChirpsRejected", [o.rejectedChirpCount]) }}</span
                        >
                    </li>
                    <li
                        v-for="r in sel.flights.value.rejected"
                        :key="r.path"
                        class="text-error"
                        :data-rejected="r.path"
                        data-selectable="no"
                    >
                        {{ t("gyrocoreAbFlightRejected", [r.path, r.problems.join(", ")]) }}
                    </li>
                </ul>
            </section>

            <div class="grid gap-3 md:grid-cols-2 mb-3">
                <section
                    v-for="side in SIDES"
                    :key="side"
                    class="rounded-md border border-default p-3"
                    :data-gyrocore="`ab-flight-${side}`"
                >
                    <h4 class="text-sm font-bold mb-1">
                        {{ $t(side === "a" ? "gyrocoreAbFlightA" : "gyrocoreAbFlightB") }}
                    </h4>
                    <select
                        class="rounded border border-default bg-default px-1.5 py-0.5 text-sm mb-2 w-full"
                        :aria-label="$t(side === 'a' ? 'gyrocoreAbFlightA' : 'gyrocoreAbFlightB')"
                        :data-gyrocore="`ab-select-${side}`"
                        :value="sel.selection.value[side] ?? ''"
                        @change="onFlightChange(side, $event)"
                    >
                        <option value="">{{ $t("gyrocoreAbFlightNone") }}</option>
                        <option
                            v-for="o in sel.flights.value.options"
                            :key="o.key"
                            :value="o.key"
                            :disabled="!o.selectable"
                        >
                            {{ flightLabel(o) }}
                        </option>
                    </select>
                    <dl
                        v-if="chosen[side]"
                        class="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-xs [&>dt]:text-dimmed"
                        :data-flight="chosen[side]!.key"
                    >
                        <dt>{{ $t("gyrocoreAbFile") }}</dt>
                        <dd data-field="file">{{ chosen[side]!.fileName ?? $t("gyrocoreAbUnknown") }}</dd>
                        <dt>{{ $t("gyrocoreAbFlightNumber") }}</dt>
                        <dd data-field="flight">{{ chosen[side]!.logNumber }} / {{ chosen[side]!.logCount }}</dd>
                        <dt>{{ $t("gyrocoreAbLogStart") }}</dt>
                        <dd data-field="logStart">{{ chosen[side]!.logStart ?? $t("gyrocoreAbUnknown") }}</dd>
                        <dt>{{ $t("gyrocoreAbFirmware") }}</dt>
                        <dd data-field="firmware">{{ firmwareLabel(chosen[side]!) }}</dd>
                        <dt>{{ $t("gyrocoreAbBoard") }}</dt>
                        <dd data-field="board">
                            {{ chosen[side]!.firmware.boardInformation ?? $t("gyrocoreAbUnknown") }}
                        </dd>
                        <dt>{{ $t("gyrocoreAbChirps") }}</dt>
                        <dd data-field="chirps">{{ chosen[side]!.chirpCount }}</dd>
                        <dt>{{ $t("gyrocoreAbAxes") }}</dt>
                        <dd data-field="axes">{{ axesLabel(chosen[side]!) }}</dd>
                        <dt>{{ $t("gyrocoreAbAnalysisVersion") }}</dt>
                        <dd data-field="analysis">
                            {{ chosen[side]!.analysisVersions.join(", ") || $t("gyrocoreAbUnknown") }}
                            ({{ chosen[side]!.analysisStatus }})
                        </dd>
                    </dl>
                </section>
            </div>

            <section class="rounded-md border border-default p-3" data-gyrocore="ab-status" :data-status="v.status">
                <h4 class="text-sm font-bold mb-1">{{ $t("gyrocoreAbStatusHead") }}</h4>
                <UBadge
                    :color="v.status === 'ELIGIBLE' ? 'success' : v.status === 'BLOCKED' ? 'error' : 'neutral'"
                    variant="subtle"
                    class="mb-2"
                    data-gyrocore="ab-pair-status"
                >
                    {{ $t(`gyrocoreAbPair_${v.status}`) }}
                </UBadge>
                <table class="w-full text-xs" data-gyrocore="ab-status-rows">
                    <tbody>
                        <tr data-row="independence" :data-status="v.independence">
                            <th scope="row" class="text-start font-normal text-dimmed pe-2">
                                {{ $t("gyrocoreAbIndependence") }}
                            </th>
                            <td>
                                <UBadge :color="tone(v.independence)" variant="outline" size="sm">{{
                                    v.independence
                                }}</UBadge>
                            </td>
                        </tr>
                        <tr data-row="analysisVersion" :data-status="v.analysisVersion">
                            <th scope="row" class="text-start font-normal text-dimmed pe-2">
                                {{ $t("gyrocoreAbAnalysisVersion") }}
                            </th>
                            <td>
                                <UBadge :color="tone(v.analysisVersion)" variant="outline" size="sm">{{
                                    v.analysisVersion
                                }}</UBadge>
                            </td>
                        </tr>
                        <tr data-row="firmware" :data-status="v.firmware">
                            <th scope="row" class="text-start font-normal text-dimmed pe-2">
                                {{ $t("gyrocoreAbFirmwareCompat") }}
                            </th>
                            <td>
                                <UBadge :color="tone(v.firmware)" variant="outline" size="sm">{{ v.firmware }}</UBadge>
                                <span v-if="v.firmwareFields" class="ms-2">
                                    <span
                                        v-for="(status, field) in v.firmwareFields"
                                        :key="field"
                                        class="me-2"
                                        :data-field="field"
                                        :data-status="status"
                                        >{{ field }}: {{ status }}</span
                                    >
                                </span>
                            </td>
                        </tr>
                        <tr data-row="missing">
                            <th scope="row" class="text-start font-normal text-dimmed pe-2">
                                {{ $t("gyrocoreAbMissing") }}
                            </th>
                            <td>
                                <span v-if="!v.missingEvidence.length">{{
                                    v.status === "INCOMPLETE" ? "—" : $t("gyrocoreAbNone")
                                }}</span>
                                <ul v-else class="list-disc ps-4">
                                    <li v-for="r in v.missingEvidence" :key="r" :data-reason="r">{{ r }}</li>
                                </ul>
                            </td>
                        </tr>
                        <tr data-row="blockers">
                            <th scope="row" class="text-start font-normal text-dimmed pe-2">
                                {{ $t("gyrocoreAbBlockers") }}
                            </th>
                            <td>
                                <span v-if="!v.blockers.length">{{
                                    v.status === "INCOMPLETE" ? "—" : $t("gyrocoreAbNone")
                                }}</span>
                                <ul v-else class="list-disc ps-4">
                                    <li v-for="r in v.blockers" :key="r" :data-reason="r">{{ r }}</li>
                                </ul>
                            </td>
                        </tr>
                    </tbody>
                </table>
                <p
                    v-if="sel.selection.value.cleared.length"
                    class="text-xs text-warning mt-2"
                    data-gyrocore="ab-cleared"
                >
                    {{ t("gyrocoreAbCleared", [sel.selection.value.cleared.join(", ")]) }}
                </p>
            </section>
        </template>
    </UiBox>
</template>

<script setup lang="ts">
/*
 * Flight A/B Selector: open a stored Tune Session and choose two Flights for a
 * later cross-flight comparison. Shown only in Expert Mode, like the Autotune
 * tab around it. It reads and, on an explicit click, writes the local session
 * store; it never touches the FC, tuning authorization, Safety or Apply.
 */
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import UiBox from "@/components/elements/UiBox.vue";
import { EventBus } from "@/components/eventBus.js";
import { i18n } from "@/js/localization";
import { isExpertModeEnabled } from "@/js/utils/isExpertModeEnabled";
import { useFlightAbSelector, type SaveOutcome } from "@/gyrocore/composables/useFlightAbSelector";
import { PRODUCT_APPLY_PENDING } from "@/gyrocore/productLock/productApply";
import type { MatchStatus, SessionSummary } from "@/gyrocore/session/contract";
import type { AbSide, FlightOption, IndependenceStatus } from "@/gyrocore/session/selection";
import type { TuneSessionStore } from "@/gyrocore/session/storage";
import { useChirpQualificationStore } from "@/gyrocore/stores/chirpQualification";

const props = defineProps<{ store?: TuneSessionStore }>();

const SIDES: AbSide[] = ["a", "b"];
const AXIS_LABEL_KEYS = { roll: "autotuneAxisRoll", pitch: "autotuneAxisPitch", yaw: "autotuneAxisYaw" } as const;

const t = (key: string, args: (string | number)[] = []) => i18n.getMessage(key, args.map(String));

const sel = useFlightAbSelector({ store: props.store });
const gate = useChirpQualificationStore();
const v = computed(() => sel.verification.value);

const expertMode = ref(isExpertModeEnabled());
const onExpertModeChange = (enabled: boolean) => {
    expertMode.value = enabled;
};
onMounted(() => {
    expertMode.value = isExpertModeEnabled();
    EventBus.$on("expert-mode-change", onExpertModeChange);
});
onUnmounted(() => EventBus.$off("expert-mode-change", onExpertModeChange));
watch(
    expertMode,
    (on) => {
        if (on) {
            void sel.refreshSessions();
        }
    },
    { immediate: true },
);

const damagedSessions = computed(() => sel.sessions.value.filter((s) => s.status !== "ok"));
const selectableCount = computed(() => sel.flights.value.options.filter((o) => o.selectable).length);
const hasRejectedParts = computed(() => sel.loaded.value?.status === "ok" && sel.loaded.value.rejected.length > 0);

const loadProblem = computed(() => {
    if (sel.loadState.value === "error") {
        return { status: "error", detail: sel.loadError.value ?? "" };
    }
    const r = sel.loaded.value;
    if (!r || r.status === "ok") {
        return null;
    }
    if (r.status === "corrupt") {
        return { status: r.status, detail: r.problems.join(", ") };
    }
    if (r.status === "unsupported_version") {
        return { status: r.status, detail: String(r.schemaVersion) };
    }
    return { status: r.status, detail: r.id };
});

const chosen = computed(() => {
    const find = (key: string | null) => sel.flights.value.options.find((o) => o.key === key) ?? null;
    return { a: find(sel.selection.value.a), b: find(sel.selection.value.b) };
});

function sessionLabel(s: SessionSummary) {
    if (s.status !== "ok") {
        return `${s.id} (${s.status})`;
    }
    return t("gyrocoreAbSessionOption", [s.name || s.id, s.flightCount ?? 0, s.chirpCount ?? 0, s.updatedAt ?? ""]);
}

function flightLabel(o: FlightOption) {
    return t("gyrocoreAbFlightOption", [o.fileName ?? "?", o.logNumber, o.logCount, o.chirpCount]);
}

function firmwareLabel(o: FlightOption) {
    const f = o.firmware;
    const unknown = i18n.getMessage("gyrocoreAbUnknown");
    return `${f.firmwareRevision ?? unknown} · API ${f.apiVersion ?? unknown}`;
}

function axesLabel(o: FlightOption) {
    return o.axes.map((a) => i18n.getMessage(AXIS_LABEL_KEYS[a])).join(", ") || i18n.getMessage("gyrocoreAbUnknown");
}

function tone(status: MatchStatus | IndependenceStatus) {
    return status === "MATCH" || status === "INDEPENDENT" ? "success" : status === "UNKNOWN" ? "warning" : "error";
}

function onSessionChange(e: Event) {
    const id = (e.target as HTMLSelectElement).value;
    void sel.openSession(id || null);
}

function onFlightChange(side: AbSide, e: Event) {
    const el = e.target as HTMLSelectElement;
    if (!sel.select(side, el.value || null)) {
        // Refused (not selectable): show the choice that is still in effect.
        el.value = sel.selection.value[side] ?? "";
    }
}

function refresh() {
    void sel.refreshSessions();
    if (sel.sessionId.value) {
        void sel.reloadSession();
    }
}

const saveName = ref("");
const saveMessage = ref<{ status: SaveOutcome["status"]; text: string } | null>(null);

async function save(intoOpenSession: boolean) {
    const report = gate.report;
    if (!report) {
        return;
    }
    const out = await sel.saveAnalysis(report, { intoOpenSession, name: saveName.value || report.filename });
    const detail =
        out.status === "error"
            ? (out.error ?? "")
            : [...out.skipped.flatMap((s) => s.reasons), ...out.notIndependent.flatMap((n) => n.reasons)].join(", ");
    saveMessage.value = { status: out.status, text: t(`gyrocoreAbSave_${out.status}`, [detail]) };
}
</script>
