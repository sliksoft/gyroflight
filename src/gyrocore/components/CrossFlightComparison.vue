<template>
    <section
        class="rounded-md border border-default p-3 mt-3"
        data-gyrocore="cross-flight-comparison"
        :data-status="r.status"
        :data-session="r.sessionId ?? ''"
        :data-a="r.keyA ?? ''"
        :data-b="r.keyB ?? ''"
    >
        <h4 class="text-sm font-bold mb-1">{{ $t("gyrocoreCfcTitle") }}</h4>
        <p class="text-sm font-bold mb-2" role="note" data-gyrocore="cfc-not-verified-tune">
            {{ t("gyrocoreCfcNotVerifiedTune", [PRODUCT_APPLY_PENDING]) }}
        </p>

        <dl class="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-xs mb-2 [&>dt]:text-dimmed">
            <dt>{{ $t("gyrocoreCfcFlightA") }}</dt>
            <dd data-gyrocore="cfc-flight-a">{{ flightLabel(r.keyA) }}</dd>
            <dt>{{ $t("gyrocoreCfcFlightB") }}</dt>
            <dd data-gyrocore="cfc-flight-b">{{ flightLabel(r.keyB) }}</dd>
        </dl>

        <UBadge :color="statusColor" variant="subtle" class="mb-2" data-gyrocore="cfc-status-badge">
            {{ $t(`gyrocoreCfcStatus_${r.status}`) }}
        </UBadge>

        <p v-if="r.status === 'INCOMPLETE'" class="text-sm text-dimmed" data-gyrocore="cfc-incomplete">
            {{ $t("gyrocoreCfcIncomplete") }}
        </p>

        <div v-else-if="r.status === 'BLOCKED'" data-gyrocore="cfc-blocked" role="alert">
            <p class="text-sm text-error">{{ $t("gyrocoreCfcBlocked") }}</p>
            <ul class="text-xs list-disc ps-5">
                <li v-for="b in r.blockers" :key="b" :data-reason="b">{{ b }}</li>
            </ul>
        </div>

        <template v-else>
            <ul
                v-if="r.blockers.length"
                class="text-xs text-warning list-disc ps-5 mb-2"
                data-gyrocore="cfc-data-problems"
            >
                <li v-for="b in r.blockers" :key="b" :data-reason="b">{{ t("gyrocoreCfcDataProblem", [b]) }}</li>
            </ul>

            <!-- Configuration -->
            <section v-if="r.config" class="mb-3" data-gyrocore="cfc-config" :data-status="r.config.status">
                <h5 class="text-xs font-bold mb-1">
                    {{ $t("gyrocoreCfcConfigHead") }}
                    <UBadge :color="tone(r.config.status)" variant="outline" size="sm" class="ms-1">{{
                        r.config.status
                    }}</UBadge>
                </h5>
                <p class="text-xs text-dimmed mb-1">{{ $t("gyrocoreCfcConfigNote") }}</p>
                <div v-for="cat in CATEGORIES" :key="cat" class="mb-1" :data-category="cat">
                    <template v-if="itemsOf(cat).length">
                        <p class="text-xs font-bold">{{ $t(`gyrocoreCfcConfigCat_${cat}`) }}</p>
                        <table v-if="notMatching(cat).length" class="w-full text-xs">
                            <thead>
                                <tr class="text-dimmed">
                                    <th class="text-start font-normal">{{ $t("gyrocoreCfcConfigKey") }}</th>
                                    <th class="text-start font-normal">{{ $t("gyrocoreCfcColA") }}</th>
                                    <th class="text-start font-normal">{{ $t("gyrocoreCfcColB") }}</th>
                                    <th class="text-start font-normal">{{ $t("gyrocoreCfcConfigStatus") }}</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr
                                    v-for="i in notMatching(cat)"
                                    :key="i.key"
                                    :data-key="i.key"
                                    :data-status="i.status"
                                    :data-blocks="i.blocksDifference ? 'yes' : 'no'"
                                >
                                    <td class="pe-2">{{ i.key }}</td>
                                    <td class="pe-2">{{ i.a ?? $t("gyrocoreCfcNotLogged") }}</td>
                                    <td class="pe-2">{{ i.b ?? $t("gyrocoreCfcNotLogged") }}</td>
                                    <td>
                                        <UBadge :color="tone(i.status)" variant="outline" size="sm">{{
                                            i.status
                                        }}</UBadge>
                                        <span v-if="i.blocksDifference" class="ms-1 text-error">{{
                                            $t("gyrocoreCfcConfigBlocks")
                                        }}</span>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                        <details v-if="matching(cat).length" class="text-xs">
                            <summary class="cursor-pointer text-dimmed">
                                {{ t("gyrocoreCfcConfigMatching", [matching(cat).length]) }}
                            </summary>
                            <ul class="ps-4">
                                <li v-for="i in matching(cat)" :key="i.key" :data-key="i.key" data-status="MATCH">
                                    {{ i.key }}: {{ i.a }}
                                </li>
                            </ul>
                        </details>
                    </template>
                </div>
                <p v-if="configDifferences.length" class="text-xs text-warning" data-gyrocore="cfc-config-confounder">
                    {{ t("gyrocoreCfcConfigConfounder", [configDifferences.join(", ")]) }}
                </p>
                <p class="text-xs text-dimmed">{{ $t("gyrocoreCfcConfigNotConditions") }}</p>
            </section>

            <!-- Per axis -->
            <section
                v-for="axis in r.axes"
                :key="axis.axisName"
                class="mb-3"
                :data-axis="axis.axisName"
                data-gyrocore="cfc-axis"
            >
                <h5 class="text-xs font-bold mb-1">
                    {{ axisLabel(axis.axisName) }}
                    <span class="font-normal text-dimmed">{{
                        t("gyrocoreCfcAxisCounts", [axis.chirpsA, axis.chirpsB])
                    }}</span>
                </h5>
                <p v-if="!axis.pairs.length" class="text-xs text-dimmed" data-gyrocore="cfc-axis-empty">
                    {{ $t("gyrocoreCfcAxisNone") }}
                </p>
                <article
                    v-for="p in axis.pairs"
                    :key="p.id"
                    class="rounded border border-default p-2 mb-2"
                    data-gyrocore="cfc-pair"
                    :data-pair="p.id"
                    :data-status="p.status"
                >
                    <p class="text-xs mb-1">
                        <span class="font-bold">{{
                            t("gyrocoreCfcPairHead", [axisLabel(p.axisName), p.axisOccurrence])
                        }}</span>
                        · A {{ p.a?.measurementId ?? "—" }} · B {{ p.b?.measurementId ?? "—" }}
                        <UBadge
                            :color="p.status === 'COMPARED' ? 'neutral' : 'warning'"
                            variant="subtle"
                            size="sm"
                            class="ms-1"
                            >{{ $t(`gyrocoreCfcPair_${p.status}`) }}</UBadge
                        >
                    </p>
                    <ul
                        v-if="p.reasons.length"
                        class="text-xs text-warning list-disc ps-5 mb-1"
                        data-gyrocore="cfc-pair-reasons"
                    >
                        <li v-for="x in p.reasons" :key="x" :data-reason="x">{{ x }}</li>
                    </ul>
                    <ul
                        v-if="p.notes.length"
                        class="text-xs text-dimmed list-disc ps-5 mb-1"
                        data-gyrocore="cfc-pair-notes"
                    >
                        <li v-for="x in p.notes" :key="x" :data-note="x">{{ x }}</li>
                    </ul>

                    <table class="w-full text-xs mb-2" data-gyrocore="cfc-quality">
                        <thead>
                            <tr class="text-dimmed">
                                <th class="text-start font-normal">{{ $t("gyrocoreCfcQualityHead") }}</th>
                                <th class="text-start font-normal">{{ $t("gyrocoreCfcColA") }}</th>
                                <th class="text-start font-normal">{{ $t("gyrocoreCfcColB") }}</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="row in p.quality" :key="row.id" :data-row="row.id">
                                <th scope="row" class="text-start font-normal text-dimmed pe-2">
                                    {{ $t(`gyrocoreCfcQ_${row.id}`) }}
                                </th>
                                <td v-for="side in SIDES" :key="side" class="pe-2" :data-side="side">
                                    <span>{{ valueText(row.id, row[side]) }}</span>
                                    <span v-if="row[side]?.verdict" class="ms-1 text-dimmed"
                                        >({{ $t(`gyrocoreQv2Verdict_${row[side]!.verdict}`) }})</span
                                    >
                                </td>
                            </tr>
                        </tbody>
                    </table>

                    <template v-if="p.status === 'COMPARED' && p.bins">
                        <CrossFlightChart
                            :id="`${p.id}-magnitude`"
                            :title="$t('gyrocoreCfcChartMagnitude')"
                            :axes-text="$t('gyrocoreCfcChartAxesDb')"
                            :empty-text="$t('gyrocoreCfcChartEmpty')"
                            :frequency-hz="p.bins.frequencyHz"
                            :series="[
                                {
                                    id: 'a',
                                    label: $t('gyrocoreCfcSeriesA'),
                                    cls: 'text-highlighted',
                                    dashed: true,
                                    values: usableOnly(p.bins.magnitudeDbA, p.bins.statusA),
                                },
                                {
                                    id: 'b',
                                    label: $t('gyrocoreCfcSeriesB'),
                                    cls: 'text-primary',
                                    values: usableOnly(p.bins.magnitudeDbB, p.bins.statusB),
                                },
                            ]"
                        />
                        <CrossFlightChart
                            :id="`${p.id}-magnitude-delta`"
                            :title="$t('gyrocoreCfcChartMagnitudeDelta')"
                            :axes-text="$t('gyrocoreCfcChartAxesDeltaDb')"
                            :empty-text="$t('gyrocoreCfcChartEmpty')"
                            :frequency-hz="p.bins.frequencyHz"
                            include-zero
                            :series="[
                                {
                                    id: 'delta',
                                    label: $t('gyrocoreCfcSeriesDelta'),
                                    cls: 'text-primary',
                                    values: p.bins.magnitudeDeltaDb,
                                },
                            ]"
                        />
                        <p class="text-xs mb-2" data-gyrocore="cfc-magnitude-summary">
                            {{ summaryText(p.magnitudeDelta, "dB") }}
                        </p>
                        <CrossFlightChart
                            :id="`${p.id}-coherence`"
                            :title="$t('gyrocoreCfcChartCoherence')"
                            :axes-text="$t('gyrocoreCfcChartAxesCoherence')"
                            :empty-text="$t('gyrocoreCfcChartEmpty')"
                            :frequency-hz="p.bins.frequencyHz"
                            :range="[0, 1]"
                            :digits="2"
                            :series="[
                                {
                                    id: 'a',
                                    label: $t('gyrocoreCfcSeriesA'),
                                    cls: 'text-highlighted',
                                    dashed: true,
                                    values: withInput(p.bins.coherenceA, p.bins.statusA),
                                },
                                {
                                    id: 'b',
                                    label: $t('gyrocoreCfcSeriesB'),
                                    cls: 'text-primary',
                                    values: withInput(p.bins.coherenceB, p.bins.statusB),
                                },
                            ]"
                        />
                        <CrossFlightChart
                            :id="`${p.id}-coherence-delta`"
                            :title="$t('gyrocoreCfcChartCoherenceDelta')"
                            :axes-text="$t('gyrocoreCfcChartAxesDeltaCoherence')"
                            :empty-text="$t('gyrocoreCfcChartEmpty')"
                            :frequency-hz="p.bins.frequencyHz"
                            :range="[-1, 1]"
                            :digits="2"
                            :series="[
                                {
                                    id: 'delta',
                                    label: $t('gyrocoreCfcSeriesDelta'),
                                    cls: 'text-primary',
                                    values: p.bins.coherenceDelta,
                                },
                            ]"
                        />
                        <p class="text-xs mb-1" data-gyrocore="cfc-coherence-summary">
                            {{ summaryText(p.coherenceDelta, "") }}
                        </p>
                        <p v-if="p.bins.unmatchedBinsA || p.bins.unmatchedBinsB" class="text-xs text-dimmed">
                            {{ t("gyrocoreCfcUnmatchedBins", [p.bins.unmatchedBinsA, p.bins.unmatchedBinsB]) }}
                        </p>
                    </template>
                </article>
            </section>

            <!-- What this pair says, and what it does not -->
            <section v-if="r.diagnostics" class="text-xs" data-gyrocore="cfc-diagnostics">
                <h5 class="font-bold mb-1">{{ $t("gyrocoreCfcDiagnosticsHead") }}</h5>
                <dl class="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 [&>dt]:text-dimmed">
                    <dt>{{ $t("gyrocoreCfcDiagCompared") }}</dt>
                    <dd data-diag="compared">{{ r.diagnostics.compared.join(", ") || $t("gyrocoreCfcNone") }}</dd>
                    <dt>{{ $t("gyrocoreCfcDiagNotComparable") }}</dt>
                    <dd data-diag="not-comparable">
                        <span v-if="!r.diagnostics.notComparable.length">{{ $t("gyrocoreCfcNone") }}</span>
                        <ul v-else class="list-disc ps-4">
                            <li v-for="n in r.diagnostics.notComparable" :key="n.id" :data-pair="n.id">
                                {{ n.id }}: {{ n.reasons.join(", ") }}
                            </li>
                        </ul>
                    </dd>
                    <dt>{{ $t("gyrocoreCfcDiagAxesMissing") }}</dt>
                    <dd data-diag="axes-missing">
                        {{
                            r.diagnostics.axesMissing.map((x) => `${x.axisName}: ${x.reason}`).join(", ") ||
                            $t("gyrocoreCfcNone")
                        }}
                    </dd>
                    <dt>{{ $t("gyrocoreCfcDiagQualityLimits") }}</dt>
                    <dd data-diag="quality-limits">{{ r.diagnostics.qualityLimits.join(", ") }}</dd>
                    <dt>{{ $t("gyrocoreCfcDiagMissing") }}</dt>
                    <dd data-diag="missing">
                        <ul class="list-disc ps-4">
                            <li v-for="m in r.diagnostics.missingForStrongerConclusions" :key="m" :data-reason="m">
                                {{ m }}
                            </li>
                        </ul>
                    </dd>
                    <dt>{{ $t("gyrocoreCfcDiagRepeatability") }}</dt>
                    <dd data-diag="repeatability" :data-status="r.repeatability.status">
                        {{ r.repeatability.status }} ({{ r.repeatability.reasons.join(", ") }})
                    </dd>
                </dl>
                <p class="text-dimmed mt-1">{{ $t("gyrocoreCfcInterpretation") }}</p>
            </section>
        </template>
    </section>
</template>

<script setup lang="ts">
/*
 * Cross-flight Comparison (WU5): a read-only, diagnostic view of Flight A and B,
 * under the A/B Verification Status. The result is derived from the loaded
 * session and selection on every render, so a changed session or choice can
 * never leave an earlier comparison on screen. Nothing is stored or written.
 */
import { computed } from "vue";
import { i18n } from "@/js/localization";
import type { BinStatus } from "@/gyrocore/chirp/qualityV2/contract";
import { compareFlights } from "@/gyrocore/compare/compare";
import type { ConfigCategory, DeltaSummary, QualityValue } from "@/gyrocore/compare/contract";
import { PRODUCT_APPLY_PENDING } from "@/gyrocore/productLock/productApply";
import type { LoadResult, MatchStatus } from "@/gyrocore/session/contract";
import type { AbSelection } from "@/gyrocore/session/selection";
import CrossFlightChart from "./CrossFlightChart.vue";

const props = defineProps<{ load: LoadResult | null; selection: AbSelection }>();

const SIDES = ["a", "b"] as const;
const CATEGORIES: ConfigCategory[] = ["MEASUREMENT", "TUNING", "OTHER"];
const AXIS_LABEL_KEYS = { roll: "autotuneAxisRoll", pitch: "autotuneAxisPitch", yaw: "autotuneAxisYaw" } as const;

const t = (key: string, args: (string | number)[] = []) => i18n.getMessage(key, args.map(String));

const r = computed(() => compareFlights(props.load, props.selection));

const STATUS_COLOR = {
    INCOMPLETE: "neutral",
    BLOCKED: "error",
    NOT_COMPARABLE: "warning",
    COMPARED: "neutral",
} as const;
const statusColor = computed(() => STATUS_COLOR[r.value.status]);

const itemsOf = (cat: ConfigCategory) => r.value.config?.items.filter((i) => i.category === cat) ?? [];
const notMatching = (cat: ConfigCategory) => itemsOf(cat).filter((i) => i.status !== "MATCH");
const matching = (cat: ConfigCategory) => itemsOf(cat).filter((i) => i.status === "MATCH");
const configDifferences = computed(
    () => r.value.config?.items.filter((i) => i.status === "MISMATCH").map((i) => i.key) ?? [],
);

function flightLabel(key: string | null) {
    if (key === null) {
        return i18n.getMessage("gyrocoreCfcNotChosen");
    }
    const f = props.load?.status === "ok" ? props.load.session.flights.find((x) => x.key === key) : undefined;
    return f ? t("gyrocoreCfcFlightLabel", [f.fileName ?? "?", f.ref.logIndex + 1, f.ref.logCount]) : key;
}

function axisLabel(axis: keyof typeof AXIS_LABEL_KEYS) {
    return i18n.getMessage(AXIS_LABEL_KEYS[axis]);
}

function tone(status: MatchStatus) {
    return status === "MATCH" ? "success" : status === "UNKNOWN" ? "warning" : "error";
}

function fmt(v: number, digits: number) {
    return v.toFixed(digits);
}

const DIGITS: Record<string, number> = {
    meanBandCoherence: 2,
    setpointRms: 1,
    missingFraction: 4,
    sampleRateHz: 1,
    usableStartHz: 1,
    usableEndHz: 1,
};

function valueText(id: string, v: QualityValue | null) {
    if (!v) {
        return "—";
    }
    if (v.value === null) {
        // Never a number that was not measured: say what is known instead.
        return v.availability;
    }
    const text = typeof v.value === "number" ? fmt(v.value, DIGITS[id] ?? 0) : v.value || "—";
    // Coherence is dimensionless; the report's unit name is not shown.
    const unit = v.unit === "coherence" ? null : v.unit;
    return typeof v.value === "number" && unit ? `${text} ${unit}` : text;
}

function summaryText(s: DeltaSummary | null, unit: string) {
    if (!s || !s.binCount) {
        return i18n.getMessage("gyrocoreCfcSummaryNone");
    }
    const digits = unit ? 2 : 3;
    const u = unit ? ` ${unit}` : "";
    return t("gyrocoreCfcSummary", [
        s.binCount,
        fmt(s.fromHz!, 1),
        fmt(s.toHz!, 1),
        `${fmt(s.min!, digits)}${u}`,
        fmt(s.minAtHz!, 1),
        `${fmt(s.max!, digits)}${u}`,
        fmt(s.maxAtHz!, 1),
        `${fmt(s.meanAbs!, digits)}${u}`,
    ]);
}

/** Magnitude is drawn only where Betaflight's bin is usable (coherence >= 0.5 with input power). */
function usableOnly(values: (number | null)[], status: BinStatus[]) {
    return values.map((v, i) => (status[i] === "USABLE" ? v : null));
}

/** Coherence is drawn only in the analysis band where there was input power. */
function withInput(values: number[], status: BinStatus[]) {
    return values.map((v, i) => (status[i] === "USABLE" || status[i] === "WEAK_COHERENCE" ? v : null));
}
</script>
