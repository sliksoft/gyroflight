<template>
    <UiBox :title="$t('gyroflightSitlTitle')" type="neutral" data-gyrocore="sitl-session" :data-state="panelState">
        <p class="text-sm text-dimmed">{{ $t("gyroflightSitlIntro") }}</p>

        <!-- Bench connection -->
        <p class="text-sm mt-2" data-gyrocore="sitl-bench" :data-connected="s.connected">
            <span class="font-bold">{{ $t("gyroflightSitlBench") }}:</span>
            {{ s.benchUrl ?? url }} —
            <span v-if="s.connected">
                {{ msg("gyroflightSitlBenchConnected", [s.hello?.scenario?.id ?? "?", String(s.hello?.seed ?? "?")]) }}
            </span>
            <span v-else>{{ $t("gyroflightSitlBenchNotConnected") }}</span>
            <UButton v-if="!s.connected" size="xs" class="ms-2" data-gyrocore="sitl-connect" @click="onConnect">
                {{ $t("gyroflightSitlConnect") }}
            </UButton>
        </p>
        <p v-if="s.scripted" class="text-sm text-yellow-500 mt-1" data-gyrocore="sitl-scripted">
            {{ $t("gyroflightSitlScripted") }} {{ scriptedText }}
        </p>

        <div class="flex gap-2 mt-2">
            <UButton
                size="sm"
                :disabled="!s.connected || s.running || restoreUnconfirmed"
                data-gyrocore="sitl-start"
                @click="session.start()"
            >
                {{ $t("gyroflightSitlStart") }}
            </UButton>
            <UButton
                size="sm"
                color="error"
                :disabled="!s.running || s.stopping"
                data-gyrocore="sitl-stop"
                @click="session.stop()"
            >
                {{ $t("gyroflightSitlStop") }}
            </UButton>
        </div>

        <!-- Progress -->
        <p
            v-if="s.running"
            class="text-sm mt-2"
            data-gyrocore="sitl-progress"
            :data-phase="s.event?.phase"
            :data-step="s.event?.step"
        >
            {{ $t(`gyroflightSitlPhase_${s.event?.phase ?? "reading_active"}`) }} —
            {{ msg("gyroflightSitlProgressStep", [String(s.event?.step ?? 0), String(P.policy.maxTrialSteps)]) }}
            <span v-if="s.progress && s.event?.phase === 'measuring' && s.progress.label !== 'restore'">
                · {{ msg("gyroflightSitlProgressRun", [String(s.progress.run), String(s.progress.of)]) }}
            </span>
            <span
                v-if="
                    s.progress?.label === 'restore' && (s.event?.phase === 'restoring' || s.event?.phase === 'stopping')
                "
                data-gyrocore="sitl-restore-attempt"
            >
                · {{ msg("gyroflightSitlProgressAttempt", [String(s.progress.run), String(s.progress.of)]) }}
            </span>
            · {{ elapsed }}
        </p>
        <p v-if="s.error" class="text-sm text-red-500 mt-2" data-gyrocore="sitl-error">{{ s.error }}</p>

        <!-- Steps -->
        <div v-if="s.steps.length" class="overflow-x-auto max-w-full mt-3">
            <table class="gyroflight-workflow-table text-sm" data-gyrocore="sitl-steps">
                <thead>
                    <tr>
                        <th>#</th>
                        <th>{{ $t("gyroflightSitlColAxis") }}</th>
                        <th>{{ $t("gyroflightSitlColChange") }}</th>
                        <th>{{ $t("gyroflightSitlColPredicted") }}</th>
                        <th>{{ $t("gyroflightSitlColMeasured") }}</th>
                        <th>{{ $t("gyroflightSitlColSteps") }}</th>
                        <th>{{ $t("gyroflightSitlColMotors") }}</th>
                        <th>{{ $t("gyroflightSitlColReadback") }}</th>
                        <th>{{ $t("gyroflightSitlColDecision") }}</th>
                    </tr>
                </thead>
                <tbody>
                    <tr
                        v-for="r in stepRows"
                        :key="r.index"
                        data-gyrocore="sitl-step"
                        :data-index="r.index"
                        :data-axis="r.axis"
                        :data-verdict="r.verdict"
                        :data-scripted="r.scripted"
                        :data-base="r.base"
                    >
                        <td>{{ r.index }}</td>
                        <td>{{ r.axis }}</td>
                        <td data-cell="change">{{ r.change }}</td>
                        <td data-cell="predicted">{{ r.predicted }}</td>
                        <td data-cell="measured">{{ r.measured }}</td>
                        <td data-cell="steps">{{ r.steps }}</td>
                        <td data-cell="motors">{{ r.motors }}</td>
                        <td data-cell="readback">{{ r.readback }}</td>
                        <td data-cell="decision">
                            <UBadge :color="r.color" variant="solid">{{ r.verdict }}</UBadge>
                            <ul class="list-disc ps-4 mt-1">
                                <li v-for="w in r.why" :key="w.rule" :data-rule="w.rule">{{ msg(w.key, w.params) }}</li>
                            </ul>
                            <p v-if="r.restore" class="mt-1" data-cell="restore">{{ r.restore }}</p>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>

        <!-- Result: start against best -->
        <template v-if="s.result">
            <p
                class="text-sm mt-3"
                data-gyrocore="sitl-stop-reason"
                :data-reason="s.result.stopReason"
                :data-status="s.result.status"
            >
                <span class="font-bold">{{ $t("gyroflightSitlStopReason") }}:</span>
                {{ $t(stopKey(s.result.stopReason)) }}
                <span v-if="s.result.stopDetail.length" class="text-dimmed"
                    >({{ s.result.stopDetail.join("; ") }})</span
                >
            </p>
            <div v-if="finalRows.length" class="overflow-x-auto max-w-full mt-2">
                <table class="gyroflight-workflow-table text-sm" data-gyrocore="sitl-final">
                    <thead>
                        <tr>
                            <th>{{ $t("gyroflightSitlColQuantity") }}</th>
                            <th>{{ $t("gyroflightSitlColStart") }}</th>
                            <th>{{ $t("gyroflightSitlColBest") }}</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="r in finalRows" :key="r.key" :data-key="r.key">
                            <td>{{ r.label }}</td>
                            <td>{{ r.start }}</td>
                            <td class="font-bold">{{ r.best }}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <p class="text-sm mt-1" data-gyrocore="sitl-final-active">
                {{ $t("gyroflightSitlFinalActive") }} {{ tuneText(s.result.finalActive?.tune ?? null) }}
            </p>
            <p
                v-if="restoreUnconfirmed"
                class="text-sm text-red-500 font-bold mt-1"
                data-gyrocore="sitl-restore-unconfirmed"
            >
                {{ $t("gyroflightSitlRestoreUnconfirmedAccepted") }} {{ tuneText(s.result.best?.tune ?? null) }}
            </p>
            <p class="text-sm text-dimmed mt-1">{{ $t("gyroflightSitlFinalNote") }}</p>
        </template>
    </UiBox>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import UiBox from "@/components/elements/UiBox.vue";
import { i18n } from "@/js/localization";
import { benchUrlFromLocation, useSitlSession } from "@/composables/useSitlSession";
import { SESSION_PROTOCOL as P } from "@/gyrocore/sitlSession/protocol";
import { measuredShortfall, type MeasurementSummary } from "@/gyrocore/sitlSession/decision";
import { stepWhy, stopKey } from "@/gyrocore/sitlSession/explain";
import type { Tune } from "@/gyrocore/sitlSession/session";
import type { PidValues } from "@/gyrocore/engine/pidOptimizer";

// Positional parameters without i18next's HTML escaping: Vue's text interpolation already renders them as plain text.
const msg = (key: string, params: string[]) =>
    i18n.getMessage(key, {
        ...Object.fromEntries(params.map((v, k) => [String(k + 1), v])),
        interpolation: { escapeValue: false },
    });
const session = useSitlSession();
const s = session.state;
const url = benchUrlFromLocation();
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
    timer = setInterval(() => (now.value = Date.now()), 1000);
    if (url && !s.connected) void onConnect();
});
onUnmounted(() => timer && clearInterval(timer));

async function onConnect() {
    if (!url) return;
    try {
        await session.connect(url);
    } catch (e) {
        s.error = String(e instanceof Error ? e.message : e);
    }
}

/** The bench could not confirm its restore: no new session from this panel (the bench refuses tuning actions too). */
const restoreUnconfirmed = computed(() => s.result?.stopReason === "restore_unconfirmed");
const panelState = computed(() =>
    s.running ? "running" : s.result ? s.result.status : s.connected ? "ready" : "offline",
);
const elapsed = computed(() => {
    if (!s.startedAt) return "";
    const t = Math.round((now.value - s.startedAt) / 1000);
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
});
const pid = (v: PidValues) => `${v.p}/${v.i}/${v.d}/${v.dMax}`;
function tuneText(t: Tune | null): string {
    return t ? `roll ${pid(t.roll)}, pitch ${pid(t.pitch)}, yaw ${pid(t.yaw)}` : "?";
}
const scriptedText = computed(() =>
    (s.scripted?.steps ?? [])
        .map((x) => `step ${x.step}: ${x.axis} ${x.to ? pid(x.to) : `D ×${x.dScale} of the accepted tune`}`)
        .join("; "),
);
const n = (x: number | null | undefined, d = 1) =>
    x === null || x === undefined || !Number.isFinite(x) ? "–" : x.toFixed(d);

function axisRead(m: MeasurementSummary | null | undefined, axis: "roll" | "pitch"): string {
    const a = m?.axes[axis];
    return a
        ? `PM ${n(a.pm.median)}°, GM ≥ ${n(a.gmLow)} dB, |S| ${n(a.s.median, 2)} dB, fc ${n(a.fc.median)} Hz`
        : "–";
}

const stepRows = computed(() =>
    s.steps.map((r) => {
        const m = r.measurement?.summary;
        const a = m?.axes[r.axis];
        const motorsVsBase = (() => {
            const ref = baseSummary(r.baseMeasurementId);
            if (!m?.motors || !ref?.motors) return "–";
            const rb = Math.max(...m.motors.map((x, k) => x.median / ref.motors![k].median));
            const st = s.start?.summary.motors ?? null;
            const rs = st ? Math.max(...m.motors.map((x, k) => x.median / st[k].median)) : null;
            return `×${n(rb, 2)} / ×${n(rs, 2)}`;
        })();
        return {
            index: r.index,
            axis: r.axis,
            scripted: r.scripted,
            verdict: r.verdict,
            base: r.baseMeasurementId,
            change: `${pid(r.from[r.axis])} → ${pid(r.to[r.axis])}${r.scripted ? " (scripted)" : ""}`,
            predicted: r.choice
                ? `PM ${n(r.choice.predicted.pmDeg)}°, GM ${n(r.choice.predicted.gmDb)} dB, |S| ${n(r.choice.predicted.sDb, 2)} dB, motors ×${n(r.choice.predictedMotorMax, 2)}`
                : "–",
            measured: a ? `${axisRead(m, r.axis)} (D ${n(measuredShortfall(a), 2)})` : "–",
            steps: a
                ? `tracking ${n(a.tracking.median, 3)}, overshoot ${n(a.overshoot.median * 100)} %, rise ${n(a.riseMs.median)} ms`
                : "–",
            motors: motorsVsBase,
            readback: r.setReadback ? pid(r.setReadback.tune[r.axis]) : "–",
            restore: r.restore
                ? r.restore.exact
                    ? `restored ${tuneText(r.restore.readback?.tune ?? null)} — read back exact${r.restore.attempts ? ` (attempt ${r.restore.attempts})` : ""}`
                    : `restore NOT confirmed${r.restore.attempts ? ` after ${r.restore.attempts} attempts` : ""} — MSP reads ${tuneText(r.restore.readback?.tune ?? null)}`
                : r.commit
                  ? `kept; bench restore tune = this tune (${r.commit.measurementId})`
                  : "",
            why: stepWhy(r),
            color: (r.verdict === "ACCEPT" ? "success" : r.verdict === "RESTORE" ? "warning" : "error") as
                "success" | "warning" | "error",
        };
    }),
);

/** Summaries of the measurements seen so far, by id (the start and every candidate). */
const summaries = computed(() => {
    const out = new Map<string, MeasurementSummary>();
    if (s.start) out.set(s.start.id, s.start.summary);
    for (const r of s.steps) if (r.measurement) out.set(r.measurement.id, r.measurement.summary);
    return out;
});
function baseSummary(id: string): MeasurementSummary | undefined {
    return summaries.value.get(id);
}

const finalRows = computed(() => {
    const st = s.result?.start?.summary;
    const be = s.result?.best?.summary;
    if (!st || !be) return [];
    const rows: { key: string; label: string; start: string; best: string }[] = [
        { key: "tune", label: "tune", start: tuneText(s.result!.start!.tune), best: tuneText(s.result!.best!.tune) },
    ];
    for (const axis of P.axes) {
        const a = st.axes[axis];
        const b = be.axes[axis];
        if (!a || !b) continue;
        rows.push(
            { key: `${axis}-pm`, label: `${axis} PM`, start: `${n(a.pm.median)}°`, best: `${n(b.pm.median)}°` },
            { key: `${axis}-gm`, label: `${axis} GM lower bound`, start: `${n(a.gmLow)} dB`, best: `${n(b.gmLow)} dB` },
            {
                key: `${axis}-s`,
                label: `${axis} |S| peak`,
                start: `${n(a.s.median, 2)} dB`,
                best: `${n(b.s.median, 2)} dB`,
            },
            {
                key: `${axis}-fc`,
                label: `${axis} crossover`,
                start: `${n(a.fc.median)} Hz`,
                best: `${n(b.fc.median)} Hz`,
            },
            {
                key: `${axis}-tracking`,
                label: `${axis} tracking error`,
                start: n(a.tracking.median, 3),
                best: n(b.tracking.median, 3),
            },
            {
                key: `${axis}-overshoot`,
                label: `${axis} overshoot`,
                start: `${n(a.overshoot.median * 100)} %`,
                best: `${n(b.overshoot.median * 100)} %`,
            },
            {
                key: `${axis}-rise`,
                label: `${axis} rise (90 %)`,
                start: `${n(a.riseMs.median)} ms`,
                best: `${n(b.riseMs.median)} ms`,
            },
            {
                key: `${axis}-shortfall`,
                label: `${axis} target shortfall D`,
                start: n(measuredShortfall(a), 2),
                best: n(measuredShortfall(b), 2),
            },
        );
    }
    if (st.motors && be.motors)
        rows.push({
            key: "motors",
            label: "motor band power (best / start)",
            start: "1.00",
            best: be.motors.map((x, k) => `M${k + 1} ×${n(x.median / st.motors![k].median, 2)}`).join(", "),
        });
    return rows;
});
</script>
