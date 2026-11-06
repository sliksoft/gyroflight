<template>
    <UiBox :title="title ?? $t('gyroflightV2Title')" type="neutral" data-gyrocore="autotune-v2">
        <p v-if="show('analyze')" class="text-sm text-dimmed mb-2">{{ $t("gyroflightV2Intro") }}</p>

        <!-- 1. Analyze: the imported logs ("sources"), Calculate ("analyze") and Verified Tune ("verifiedTune") -->
        <template v-if="show('analyze') || show('sources') || show('verifiedTune')">
            <h4 v-if="show('analyze')" class="font-bold mt-2" data-step="v2-analyze">
                1. {{ $t("gyroflightStepAnalyze") }}
            </h4>
            <template v-if="show('sources')">
                <h4 class="font-bold mt-2" data-step="v2-sources">{{ $t("gyroflightV2SourcesHeading") }}</h4>
                <p class="text-sm text-dimmed">{{ $t("gyroflightV2SourcesHelp") }}</p>
                <p v-if="!v2.sources.length" class="text-sm text-dimmed" data-gyrocore="v2-no-source">
                    {{ $t("gyroflightV2NoSource") }}
                </p>
                <ul v-else class="list-disc ps-5 text-sm" data-gyrocore="v2-sources">
                    <li v-for="s in v2.sources" :key="s.filename" :data-source="s.filename">
                        {{ s.filename }} · {{ summary(s) }}
                        <span
                            v-if="recordingConfig(s)"
                            class="text-dimmed"
                            data-gyrocore="v2-recording-config"
                            :data-role="recordingConfig(s)!.role"
                        >
                            · {{ recordingConfig(s)!.text }}
                        </span>
                    </li>
                </ul>
                <p v-if="v2.sources.length || result" class="text-sm text-dimmed" data-gyrocore="v2-compare-loop">
                    {{ $t("gyroflightV2CompareLoop") }}
                </p>
            </template>
            <UButton
                v-if="show('analyze')"
                size="xs"
                class="mt-1"
                data-gyrocore="v2-calculate"
                :loading="v2.state === 'calculating'"
                :disabled="!v2.sources.length || v2.state === 'calculating'"
                @click="calculate"
            >
                {{ $t("gyroflightV2Calculate") }}
            </UButton>
            <template v-if="show('verifiedTune')">
                <h4 class="font-bold mt-3" data-step="v2-verified-tune">{{ $t("gyroflightV2VerifiedTuneHeading") }}</h4>
                <p class="text-sm" data-gyrocore="v2-verified-tune-not-ab">{{ $t("gyroflightV2VerifiedTuneNotAb") }}</p>
                <UButton
                    size="xs"
                    variant="outline"
                    class="mt-1"
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
            </template>
            <!-- Once per section: with Calculate or Verified Tune, not again beside the log list. -->
            <p v-if="v2.progressMessage && (show('analyze') || show('verifiedTune'))" class="text-sm text-dimmed">
                {{ v2.progressMessage }}
            </p>
            <p
                v-if="v2.state === 'error' && (show('analyze') || show('verifiedTune'))"
                class="text-sm text-red-500"
                data-gyrocore="v2-error"
            >
                {{ v2.errorMessage }}
            </p>
        </template>

        <template v-if="result">
            <!-- 2. Calculate -->
            <h4 v-if="show('parts')" class="font-bold mt-3" data-step="v2-calculate">
                2. {{ $t("gyroflightStepCalculate") }}
            </h4>
            <div v-if="show('parts')" class="overflow-x-auto max-w-full [&_td.text-dimmed]:[overflow-wrap:anywhere]">
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
            </div>

            <template v-if="show('margins')">
                <p class="text-sm font-bold mt-2">{{ $t("gyroflightV2Margins") }}</p>
                <p class="text-sm text-dimmed">{{ $t("gyroflightV2MarginsColumnsHelp") }}</p>
                <div class="overflow-x-auto max-w-full [&_td.text-dimmed]:[overflow-wrap:anywhere]">
                    <table class="gyroflight-workflow-table text-sm" data-gyrocore="v2-margins">
                        <thead>
                            <tr>
                                <th rowspan="2">{{ $t("gyroflightV2Axis") }}</th>
                                <th rowspan="2">{{ $t("gyroflightV2ChainFit") }}</th>
                                <th rowspan="2">{{ $t("gyroflightV2Crossover") }}</th>
                                <th colspan="3" class="text-center">{{ $t("gyroflightV2MarginsMeasuredGroup") }}</th>
                                <th colspan="3" class="text-center">{{ $t("gyroflightV2MarginsBoundGroup") }}</th>
                                <th colspan="3" class="text-center">{{ $t("gyroflightV2MarginsValidationGroup") }}</th>
                            </tr>
                            <tr>
                                <th>PM</th>
                                <th>GM</th>
                                <th>|S|</th>
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
                                <td data-kind="measured">{{ row.pmMeasured }}</td>
                                <td data-kind="measured">{{ row.gmMeasured }}</td>
                                <td data-kind="measured">{{ row.sMeasured }}</td>
                                <td data-kind="bound">{{ boundText(row.pm) }}</td>
                                <td data-kind="bound">{{ boundText(row.gm) }}</td>
                                <td data-kind="bound">{{ boundText(row.s) }}</td>
                                <td>{{ row.resolution }}</td>
                                <td :class="evidenceClass(row.evidence)" class="font-bold">{{ row.evidence }}</td>
                                <td :class="row.validated ? 'text-green-500' : 'text-yellow-500'">
                                    {{ row.status }}
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <p class="text-sm text-dimmed" data-gyrocore="v2-evidence-legend">
                    {{ $t("gyroflightV2EvidenceLegend") }}
                </p>
                <details class="mt-1">
                    <summary class="cursor-pointer text-sm font-bold">{{ $t("gyroflightV2MarginsDetails") }}</summary>
                    <ul class="text-sm flex flex-col gap-1" data-gyrocore="v2-margin-evidence">
                        <li
                            v-for="row in marginRows"
                            :key="row.axis"
                            :data-axis="row.axis"
                            :data-evidence="row.evidence"
                        >
                            <span v-for="(line, k) in row.details" :key="k" class="block">{{ line }}</span>
                        </li>
                    </ul>
                </details>
            </template>
            <template v-if="show('multi') && result.multiRecording">
                <p class="font-bold text-sm mt-2">{{ $t("gyroflightV2MultiRecordingTitle") }}</p>
                <p class="text-sm text-dimmed">{{ $t("gyroflightV2MultiRecordingHelp") }}</p>
                <p class="text-sm" data-gyrocore="v2-multi-recording-contributors">
                    {{ $t("gyroflightV2MultiRecordingContributors") }}:
                    {{ result.multiRecording.contributors.map(shortId).join(", ") || "--" }}
                </p>
                <p
                    v-if="result.multiRecording.rejected.length"
                    class="text-sm text-dimmed"
                    data-gyrocore="v2-multi-recording-rejected"
                >
                    {{ $t("gyroflightV2MultiRecordingRejected") }}:
                    {{ result.multiRecording.rejected.slice(0, 8).join("; ") }}
                </p>
            </template>

            <!-- The planner table on its own, when the recording plan is not shown beside it. -->
            <template v-if="show('measurementPlan') && !planShown && result.measurementPlan?.length">
                <p class="font-bold text-sm mt-2">{{ $t("gyroflightV2PlanTitle") }}</p>
                <p class="text-sm text-dimmed">{{ $t("gyroflightV2PlanHelp") }}</p>
                <MeasurementPlanTable :plan="result.measurementPlan" />
            </template>

            <!-- CHIRP + JIO (experimental): the route's table, with the two candidate searches in their own columns. -->
            <template v-if="show('jio') && result.jio">
                <p class="font-bold text-sm mt-2" data-gyrocore="v2-jio-title">
                    {{ $t("gyroflightV2JioTitle") }}
                    <span
                        :class="result.jio.status === 'DIAGNOSTIC' ? 'text-yellow-500' : 'text-red-500'"
                        data-gyrocore="v2-jio-status"
                    >
                        {{ result.jio.status }}
                    </span>
                </p>
                <p class="text-sm">{{ $t("gyroflightV2JioSearchesHelp") }}</p>
                <p
                    v-if="result.jio.analysis.blockers.length"
                    class="text-sm text-red-500"
                    data-gyrocore="v2-jio-blockers"
                >
                    {{ $t("gyroflightV2JioBlocked") }}: {{ result.jio.analysis.blockers.join(", ") }}
                </p>
                <div
                    class="overflow-x-auto max-w-full [&_td.text-dimmed]:[overflow-wrap:anywhere]"
                    v-if="jioRows.length"
                >
                    <table class="gyroflight-workflow-table text-sm" data-gyrocore="v2-jio">
                        <thead>
                            <tr>
                                <th>{{ $t("gyroflightV2Axis") }}</th>
                                <th>{{ $t("gyroflightV2JioRecords") }}</th>
                                <th>{{ $t("gyroflightV2JioRepeats") }}</th>
                                <th>{{ $t("gyroflightV2JioCrossFlight") }}</th>
                                <th>{{ $t("gyroflightV2JioBand") }}</th>
                                <th>{{ $t("gyroflightV2JioMissing") }}</th>
                                <th>{{ $t("gyroflightV2Crossover") }} / PM</th>
                                <th>1. {{ $t("gyroflightV2JioCandidate") }}</th>
                                <th>2. {{ $t("gyroflightV2JioMeasuredSearch") }}</th>
                                <th>{{ $t("gyroflightV2JioTuning") }}</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr
                                v-for="row in jioRows"
                                :key="row.axis"
                                :data-axis="row.axis"
                                :data-computable="row.computable ? 'yes' : 'no'"
                                :data-repeats="row.consistency"
                                :data-cross-flight="row.crossFlightConsistency"
                            >
                                <td>{{ row.axis }}</td>
                                <td>{{ row.records }}</td>
                                <td>{{ row.repeats }}</td>
                                <td>{{ row.crossFlight }}</td>
                                <td>{{ row.band }}</td>
                                <td class="text-dimmed">{{ row.missing }}</td>
                                <td>{{ row.margins }}</td>
                                <td class="[overflow-wrap:anywhere]" data-gyrocore="v2-jio-candidate">
                                    {{ row.candidate }}
                                </td>
                                <td class="[overflow-wrap:anywhere]">
                                    <span data-gyrocore="v2-jio-measured-search">
                                        <span class="sr-only">{{ $t("gyroflightV2JioMeasuredSearch") }}: </span
                                        >{{ row.measuredSearch }}
                                    </span>
                                </td>
                                <td :class="row.computable ? 'text-yellow-500' : 'text-red-500'">{{ row.tuning }}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                <details class="text-sm mt-1">
                    <summary class="cursor-pointer font-bold">{{ $t("gyroflightV2JioAbout") }}</summary>
                    <p class="text-dimmed">{{ $t("gyroflightV2JioHelp") }}</p>
                    <p class="text-dimmed" data-gyrocore="v2-jio-method">
                        {{ $t("gyroflightV2JioMethod") }}: {{ result.jio.analysis.method }};
                        {{ $t("gyroflightV2JioFirmware") }}: {{ result.jio.analysis.firmwareRevision ?? "--" }};
                        {{ $t("gyroflightV2JioLimitations") }}: {{ result.jio.analysis.limitations.join(", ") }}
                    </p>
                </details>
            </template>

            <!-- The measurement set per axis: sweeps, repeats within this flight, flights compared, what is missing. -->
            <template v-if="show('jioSet') && result.jio">
                <template v-if="jioProgress.length">
                    <p class="text-sm font-bold mt-1">{{ $t("gyroflightV2JioProgressTitle") }}</p>
                    <p class="text-sm text-dimmed">{{ $t("gyroflightV2JioProgressHelp") }}</p>
                    <ul class="text-sm list-disc pl-5 flex flex-col gap-1">
                        <li
                            v-for="pr in jioProgress"
                            :key="pr.axis"
                            data-gyrocore="v2-jio-progress"
                            :data-axis="pr.axis"
                            :data-complete="pr.complete ? 'yes' : 'no'"
                        >
                            <span class="font-bold">{{ pr.axis }}</span
                            >: {{ pr.text }}
                            <span v-if="pr.next" class="block text-dimmed"
                                >{{ $t("gyroflightV2JioProgressNext") }}: {{ pr.next }}</span
                            >
                            <span
                                v-if="pr.supplementary"
                                class="block text-dimmed"
                                data-gyrocore="v2-jio-supplementary"
                            >
                                {{ $t("gyroflightV2JioSupplementary") }}: {{ pr.supplementary }}</span
                            >
                        </li>
                    </ul>
                </template>
                <details class="text-sm mt-1">
                    <summary class="cursor-pointer font-bold">{{ $t("gyroflightV2JioNeeds") }}</summary>
                    <p class="text-dimmed" data-gyrocore="v2-jio-needs">
                        {{ $t("gyroflightV2JioNeeds") }}:
                        {{ jioNeeds.required.map(measurementText).join("; ") || "--" }}
                        <template v-if="jioNeeds.supplementary.length">
                            · {{ $t("gyroflightV2JioSupplementary") }}:
                            {{ jioNeeds.supplementary.map(measurementText).join("; ") }}
                        </template>
                    </p>
                </details>
            </template>

            <!-- The JIO plots, then the sweep advice, the other flights and the 3×3 coupling (diagnostic). -->
            <template v-if="show('jioPlots') && result.jio">
                <p v-if="jioPlots.length" class="text-sm text-dimmed">{{ $t("gyroflightV2JioPlotHelp") }}</p>
                <div v-if="jioPlots.length" class="grid gap-3 max-w-full @3xl:grid-cols-2 @7xl:grid-cols-3">
                    <figure
                        v-for="pl in jioPlots"
                        :key="pl.axis"
                        class="text-xs min-w-0"
                        data-gyrocore="v2-jio-plot"
                        :data-axis="pl.axis"
                        :data-points="pl.dots.length"
                    >
                        <figcaption class="font-bold text-sm">
                            {{ pl.axis }}: {{ $t("gyroflightV2JioPlot") }}
                        </figcaption>
                        <svg
                            :viewBox="`0 0 ${pl.w} ${pl.h}`"
                            class="block w-full h-auto max-w-[560px]"
                            role="img"
                            :aria-label="`${pl.axis}: ${$t('gyroflightV2JioPlot')}`"
                        >
                            <rect
                                :x="pl.x0"
                                :y="pl.y0"
                                :width="pl.pw"
                                :height="pl.ph"
                                fill="none"
                                stroke="currentColor"
                                opacity="0.35"
                            />
                            <template v-for="tk in pl.ticks" :key="tk.hz">
                                <line
                                    :x1="tk.x"
                                    :x2="tk.x"
                                    :y1="pl.y0"
                                    :y2="pl.y0 + pl.ph"
                                    stroke="currentColor"
                                    opacity="0.15"
                                />
                                <text
                                    :x="tk.x"
                                    :y="pl.y0 + pl.ph + 13"
                                    font-size="11"
                                    text-anchor="middle"
                                    fill="currentColor"
                                >
                                    {{ tk.hz }}
                                </text>
                            </template>
                            <template v-for="tk in pl.dbTicks" :key="`db${tk.v}`">
                                <line
                                    :x1="pl.x0"
                                    :x2="pl.x0 + pl.pw"
                                    :y1="tk.y"
                                    :y2="tk.y"
                                    stroke="currentColor"
                                    opacity="0.1"
                                />
                                <text :x="pl.x0 - 4" :y="tk.y + 4" font-size="11" text-anchor="end" fill="currentColor">
                                    {{ tk.v }}
                                </text>
                            </template>
                            <text
                                v-for="tk in pl.cohTicks"
                                :key="`c${tk.v}`"
                                :x="pl.x0 + pl.pw + 4"
                                :y="tk.y + 4"
                                font-size="11"
                                fill="currentColor"
                                opacity="0.7"
                            >
                                {{ tk.v }}
                            </text>
                            <text
                                :x="pl.x0 + pl.pw / 2"
                                :y="pl.h - 3"
                                font-size="11"
                                text-anchor="middle"
                                fill="currentColor"
                            >
                                {{ $t("gyroflightV2JioAxisHz") }}
                            </text>
                            <text
                                :transform="`translate(11 ${pl.y0 + pl.ph / 2}) rotate(-90)`"
                                font-size="11"
                                text-anchor="middle"
                                fill="currentColor"
                            >
                                {{ $t("gyroflightV2JioAxisDb") }}
                            </text>
                            <text
                                :transform="`translate(${pl.w - 6} ${pl.y0 + pl.ph / 2}) rotate(90)`"
                                font-size="11"
                                text-anchor="middle"
                                fill="currentColor"
                                opacity="0.7"
                            >
                                {{ $t("gyroflightV2JioAxisCoherence") }}
                            </text>
                            <polyline
                                :points="pl.coherence"
                                fill="none"
                                stroke="currentColor"
                                stroke-dasharray="3 2"
                                opacity="0.5"
                            />
                            <circle
                                v-for="(d, i) in pl.dots"
                                :key="i"
                                :cx="d.x"
                                :cy="d.y"
                                r="2"
                                :fill="d.sup ? 'currentColor' : 'none'"
                                stroke="currentColor"
                                :opacity="d.sup ? 0.9 : 0.3"
                            />
                        </svg>
                    </figure>
                </div>
                <details v-if="jioAdvice.length" class="text-sm mt-2">
                    <summary class="cursor-pointer font-bold">{{ $t("gyroflightV2JioAdviceTitle") }}</summary>
                    <p class="text-dimmed" data-gyrocore="v2-jio-preparation">
                        {{ $t("gyroflightV2JioPreparation") }}
                    </p>
                    <p
                        v-for="adv in jioAdvice"
                        :key="adv.axis"
                        class="text-dimmed"
                        data-gyrocore="v2-jio-advice"
                        :data-axis="adv.axis"
                    >
                        {{ adv.text }}
                    </p>
                </details>
                <details v-if="jioCandidates.length || jioMimoText" class="text-sm mt-1">
                    <summary class="cursor-pointer font-bold">{{ $t("gyroflightV2JioOtherFlightsTitle") }}</summary>
                    <p v-if="jioCandidates.length" class="text-dimmed" data-gyrocore="v2-jio-cross">
                        {{ $t("gyroflightV2JioCandidates") }}: {{ jioCandidates.join(" | ") }}
                    </p>
                    <p v-if="jioMimoText" class="text-dimmed" data-gyrocore="v2-jio-mimo">{{ jioMimoText }}</p>
                </details>
            </template>

            <template v-if="show('qualification') && v2.qualification">
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
            <template v-if="show('compare')">
                <h4 class="font-bold mt-3" data-step="v2-compare">3. {{ $t("gyroflightStepCompare") }}</h4>
                <p v-if="!result.proposal" class="text-sm text-dimmed" data-gyrocore="v2-no-change">
                    {{ $t("gyroflightV2NoChange") }}
                </p>
                <div class="overflow-x-auto max-w-full [&_td.text-dimmed]:[overflow-wrap:anywhere]" v-else>
                    <table class="gyroflight-workflow-table text-sm" data-gyrocore="v2-compare">
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
                </div>
                <p v-if="result.proposal" class="text-sm text-dimmed">{{ $t("gyroflightV2NotValidatedNote") }}</p>
            </template>

            <!-- 4. Apply -->
            <template v-if="show('apply')">
                <h4 class="font-bold mt-3" data-step="v2-apply">4. {{ $t("gyroflightStepApply") }}</h4>
                <ul class="text-sm" data-gyrocore="v2-contract">
                    <li v-for="c in contract" :key="c.name" :data-condition="c.name" :data-ok="c.passed ? 'yes' : 'no'">
                        <span :class="c.passed ? 'text-green-500' : 'text-red-500'" class="font-bold">
                            {{ c.passed ? "✓" : "✗" }}
                        </span>
                        {{ $t(`gyroflightV2Cond_${c.name}`) }}
                        <span v-if="c.reasons.length" class="text-dimmed"
                            >({{ c.reasons.slice(0, 4).join("; ") }})</span
                        >
                    </li>
                    <li v-for="name in LIVE_CONDITIONS" :key="name" :data-condition="name" data-ok="live">
                        <span class="font-bold">·</span> {{ $t(`gyroflightV2Cond_${name}`) }}
                    </li>
                </ul>
                <p v-if="safetyChecks.length" class="text-sm font-bold mt-1">
                    {{ $t("gyroflightV2SafetyChecksTitle") }}
                </p>
                <ul class="text-sm" data-gyrocore="v2-safety-checks">
                    <li v-for="c in safetyChecks" :key="c.name" :data-check="c.name" :data-status="c.status">
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
                            ({{ c.reasons.slice(0, 3).join("; ") }})</span
                        >
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
                <UButton
                    size="xs"
                    class="mt-1"
                    data-gyrocore="v2-apply"
                    :disabled="!canApply || v2.busy"
                    @click="onApply"
                >
                    {{ $t("gyroflightApplyReview") }}
                </UButton>
                <div
                    v-if="v2.preview"
                    class="text-sm mt-2"
                    data-gyrocore="v2-preview-result"
                    :data-status="v2.preview.status"
                >
                    <p class="font-bold">{{ $t("gyroflightPreviewTitle") }}</p>
                    <div
                        class="overflow-x-auto max-w-full [&_td.text-dimmed]:[overflow-wrap:anywhere]"
                        v-if="v2.preview.status === 'ok'"
                    >
                        <table class="gyroflight-workflow-table">
                            <tbody>
                                <tr v-for="r in v2.preview.changes" :key="r.key" :data-preview="r.key">
                                    <td>{{ r.key }}</td>
                                    <td>{{ r.from ?? "?" }}</td>
                                    <td>{{ r.to ?? "?" }}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    <ul v-else class="list-disc ps-5">
                        <li v-for="r in v2.preview.reasons" :key="r" class="text-red-500">{{ r }}</li>
                    </ul>
                </div>
            </template>
        </template>

        <!-- 4b. Experimental tuning: the values the measurement supports, written only on an explicit acknowledgement. -->
        <template v-if="show('experimental') && result">
            <h4 class="font-bold mt-3" data-step="v2-experimental">4b. {{ $t("gyroflightV2ExperimentalTitle") }}</h4>
            <details class="text-sm">
                <summary class="cursor-pointer text-dimmed">{{ $t("gyroflightV2ExperimentalAbout") }}</summary>
                <p class="text-dimmed">{{ $t("gyroflightV2ExperimentalHelp") }}</p>
            </details>
            <p
                v-if="!experimental"
                class="text-sm"
                data-gyrocore="v2-experimental-none"
                :data-withheld="experimentalWithheld.length"
            >
                {{ $t("gyroflightV2ExperimentalNone") }}
            </p>
            <template v-else>
                <p class="text-sm" data-gyrocore="v2-experimental-status" data-status="EXPERIMENTAL">
                    <span class="font-bold text-yellow-500">EXPERIMENTAL</span> ·
                    {{ $t("gyroflightV2ExperimentalNotValidated") }}
                </p>
                <div class="overflow-x-auto max-w-full [&_td.text-dimmed]:[overflow-wrap:anywhere]">
                    <table class="gyroflight-workflow-table text-sm" data-gyrocore="v2-experimental-items">
                        <thead>
                            <tr>
                                <th>{{ $t("gyroflightCompareSetting") }}</th>
                                <th>{{ $t("gyroflightPreviewNow") }}</th>
                                <th>{{ $t("gyroflightPreviewAfter") }}</th>
                                <th>{{ $t("gyroflightV2ExperimentalSource") }}</th>
                                <th>{{ $t("gyroflightV2ExperimentalEvidence") }}</th>
                                <th>{{ $t("gyroflightV2ExperimentalWhy") }}</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr
                                v-for="it in experimental.items"
                                :key="it.key"
                                :data-key="it.key"
                                :data-source="it.source"
                                :data-status="it.status"
                            >
                                <td>{{ it.key }}</td>
                                <td>{{ it.from }}</td>
                                <td>{{ it.to }}</td>
                                <td>{{ $t(`gyroflightV2ExperimentalSource_${it.source}`) }}</td>
                                <td>{{ it.evidence }} ({{ it.status }})</td>
                                <td class="text-dimmed">{{ it.qualificationGaps.join("; ") }}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </template>
            <details v-if="experimentalWithheld.length" class="text-sm mt-1">
                <summary class="cursor-pointer">
                    {{
                        t("gyroflightV2ExperimentalWithheldToggle", [experimentalWithheld.map((w) => w.key).join(", ")])
                    }}
                </summary>
                <ul class="list-disc ps-5 [overflow-wrap:anywhere]" data-gyrocore="v2-experimental-withheld">
                    <li v-for="w in experimentalWithheld" :key="w.key" :data-key="w.key">
                        {{ w.key }}: {{ $t("gyroflightV2ExperimentalWithheld") }} ({{ w.reasons.join("; ") }})
                    </li>
                </ul>
            </details>
            <template v-if="experimental">
                <p class="text-sm text-dimmed" data-gyrocore="v2-experimental-limits">
                    {{ $t("gyroflightV2ExperimentalLimits") }}: {{ experimental.limitations.join(", ") }}
                </p>
                <ul class="text-sm" data-gyrocore="v2-experimental-checks">
                    <li
                        v-for="s in experimentalDecision?.steps ?? []"
                        :key="s.name"
                        :data-step="s.name"
                        :data-ok="s.passed ? 'yes' : 'no'"
                    >
                        <span :class="s.passed ? 'text-green-500' : 'text-red-500'" class="font-bold">
                            {{ s.passed ? "✓" : "✗" }}
                        </span>
                        {{ $t(`gyroflightV2ExpStep_${s.name}`) }}
                        <span v-if="s.reasons.length" class="text-dimmed"
                            >({{ s.reasons.slice(0, 4).join("; ") }})</span
                        >
                    </li>
                    <li v-for="name in LIVE_CONDITIONS" :key="name" :data-condition="name" data-ok="live">
                        <span class="font-bold">·</span> {{ $t(`gyroflightV2Cond_${name}`) }}
                    </li>
                </ul>
                <p class="text-sm text-dimmed" data-gyrocore="v2-experimental-waived">
                    {{ $t("gyroflightV2ExperimentalWaived") }}: {{ (experimentalDecision?.waived ?? []).join(", ") }}
                </p>
                <label class="text-sm flex items-center gap-2 mt-1">
                    <input
                        v-model="experimentalAck"
                        type="checkbox"
                        data-gyrocore="v2-experimental-ack"
                        :disabled="v2.busy"
                    />
                    {{ $t("gyroflightV2ExperimentalAck") }}
                </label>
                <UButton
                    size="xs"
                    variant="outline"
                    class="mt-1 me-2"
                    data-gyrocore="v2-experimental-preview"
                    :disabled="!canPreviewExperimental || v2.busy"
                    @click="onPreviewExperimental"
                >
                    {{ $t("gyroflightPreviewButton") }}
                </UButton>
                <UButton
                    size="xs"
                    color="warning"
                    class="mt-1"
                    data-gyrocore="v2-experimental-apply"
                    :disabled="!canApplyExperimental || v2.busy"
                    @click="onApplyExperimental"
                >
                    {{ $t("gyroflightV2ExperimentalApply") }}
                </UButton>
                <p v-if="experimentalBlocks.length" class="text-sm text-dimmed" data-gyrocore="v2-experimental-blocks">
                    {{ experimentalBlocks.join("; ") }}
                </p>
            </template>
        </template>

        <!-- 4c. Per axis: why there is (no) experimental candidate, and the recording the failed check asks for. -->
        <template v-if="decisionRows.length">
            <template v-if="show('decisions')">
                <h4 class="font-bold mt-3" data-step="v2-decisions">4c. {{ $t("gyroflightV2DecisionTitle") }}</h4>
                <p class="text-sm text-dimmed">{{ $t("gyroflightV2DecisionHelp") }}</p>
                <div class="overflow-x-auto max-w-full [&_td.text-dimmed]:[overflow-wrap:anywhere]">
                    <table class="gyroflight-workflow-table text-sm" data-gyrocore="v2-decisions">
                        <thead>
                            <tr>
                                <th>{{ $t("gyroflightV2Axis") }}</th>
                                <th>{{ $t("gyroflightV2DecisionRoute") }}</th>
                                <th>{{ $t("gyroflightV2DecisionPlant") }}</th>
                                <th>{{ $t("gyroflightV2DecisionSearch") }}</th>
                                <th>{{ $t("gyroflightV2DecisionStatus") }}</th>
                                <th>{{ $t("gyroflightV2DecisionCause") }}</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr
                                v-for="row in decisionRows"
                                :key="`${row.axis}-${row.route}`"
                                :data-axis="row.axis"
                                :data-route="row.route"
                                :data-status="row.status"
                            >
                                <td>{{ row.axis }}</td>
                                <td>{{ row.route }}</td>
                                <td>{{ row.plant }}</td>
                                <td>{{ row.search }}</td>
                                <td>{{ row.status }}</td>
                                <td class="text-dimmed">{{ row.cause }}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </template>
            <div
                v-if="show('recordingPlan') && plan"
                class="text-sm mt-2 flex flex-col gap-3"
                data-gyrocore="v2-recording-plan"
                :data-needed="plan.recordingNeeded ? 'yes' : 'no'"
            >
                <!-- A. The imported recording: complete sweeps and, per axis, the information still missing. -->
                <section data-gyrocore="v2-plan-current">
                    <h4 class="font-bold">{{ $t("gyroflightV2PlanCurrentTitle") }}</h4>
                    <p data-gyrocore="v2-plan-rounds" :data-state="plan.existing.rounds.state">{{ planRoundsText }}</p>
                    <p data-gyrocore="v2-plan-second-flight" :data-state="plan.existing.secondFlight.state">
                        {{ planSecondFlightText }}
                    </p>
                    <div
                        v-for="ax in planAxes"
                        :key="ax.axis"
                        class="mt-1"
                        data-gyrocore="v2-recording-axis"
                        :data-axis="ax.axis"
                        :data-kind="ax.kind"
                    >
                        <p>
                            <span class="font-bold">{{ ax.axis }}</span
                            >: {{ ax.note }}
                        </p>
                        <details v-if="ax.missing.length">
                            <summary class="cursor-pointer text-dimmed">
                                {{ t("gyroflightV2PlanMissingToggle", [ax.missing.length]) }}
                            </summary>
                            <ul class="list-disc ps-5">
                                <li
                                    v-for="(m, i) in ax.missing"
                                    :key="i"
                                    data-gyrocore="v2-missing-interval"
                                    :data-route="m.route"
                                    :data-kind="m.kind"
                                >
                                    {{ m.text }}
                                </li>
                            </ul>
                        </details>
                    </div>
                </section>

                <!-- B. Settings: what the log holds beside what the next flight should use. -->
                <section data-gyrocore="v2-plan-settings-block">
                    <h4 class="font-bold">{{ $t("gyroflightV2PlanSettingsTitle") }}</h4>
                    <p class="font-bold" data-gyrocore="v2-plan-not-written">{{ $t("gyroflightV2PlanNotWritten") }}</p>
                    <p v-if="plan.sweep" class="text-dimmed">{{ $t("gyroflightV2PlanShared") }}</p>
                    <div class="overflow-x-auto max-w-full [&_td.text-dimmed]:[overflow-wrap:anywhere]">
                        <table
                            class="gyroflight-workflow-table"
                            :data-gyrocore="plan.sweep ? 'v2-plan-settings' : undefined"
                        >
                            <thead>
                                <tr>
                                    <th>{{ $t("gyroflightCompareSetting") }}</th>
                                    <th>{{ $t("gyroflightV2PlanFromLog") }}</th>
                                    <th v-if="plan.sweep">{{ $t("gyroflightV2PlanProposedValue") }}</th>
                                    <th v-if="plan.sweep">{{ $t("gyroflightV2PlanBasis") }}</th>
                                </tr>
                            </thead>
                            <tbody data-gyrocore="v2-plan-existing">
                                <tr
                                    v-for="row in planSettingRows"
                                    :key="row.name"
                                    :data-setting="row.name"
                                    :data-changed="row.proposed ? (row.proposed.changed ? 'yes' : 'no') : undefined"
                                    :class="row.proposed?.changed ? 'bg-yellow-500/10' : ''"
                                >
                                    <td>{{ row.label }}</td>
                                    <td>{{ row.current }}</td>
                                    <td v-if="plan.sweep" :class="row.proposed?.changed ? 'font-bold' : ''">
                                        {{ row.proposed ? row.proposed.text : "--" }}
                                        <UBadge
                                            v-if="row.proposed?.changed"
                                            color="warning"
                                            variant="subtle"
                                            size="sm"
                                            class="ms-1"
                                            data-gyrocore="v2-plan-changed"
                                            >{{ $t("gyroflightV2PlanChanged") }}</UBadge
                                        >
                                    </td>
                                    <td v-if="plan.sweep" class="text-dimmed">{{ row.proposed?.basis ?? "" }}</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                    <template v-if="plan.sweep">
                        <p class="mt-2">{{ $t("gyroflightV2PlanCliHelp") }}</p>
                        <pre
                            class="text-xs overflow-x-auto max-w-full rounded-md border border-default p-2"
                            data-gyrocore="v2-plan-cli"
                            >{{ plan.sweep.cli.join("\n") }}</pre>
                    </template>
                </section>

                <!-- C. The next flight: the agreed two complete CHIRP rounds, with the time it takes. -->
                <section data-gyrocore="v2-plan-next">
                    <h4 class="font-bold">{{ $t("gyroflightV2PlanNextTitle") }}</h4>
                    <p>{{ $t("gyroflightV2PlanAgreement") }}</p>
                    <template v-if="plan.sweep">
                        <p class="font-bold" data-gyrocore="v2-recording-timing">{{ planTimingText }}</p>
                        <ol class="list-decimal ps-5" data-gyrocore="v2-plan-procedure">
                            <li v-for="(step, i) in plan.procedure" :key="i">{{ step }}</li>
                        </ol>
                    </template>
                    <p data-gyrocore="v2-plan-second-flight-help">{{ plan.secondFlight }}</p>
                </section>

                <!-- D. Technical basis: frequencies, measured values, thresholds and tables. -->
                <details data-gyrocore="v2-plan-technical">
                    <summary class="cursor-pointer font-bold">{{ $t("gyroflightV2PlanTechnicalTitle") }}</summary>
                    <template v-if="show('measurementPlan') && result?.measurementPlan?.length">
                        <p class="font-bold mt-2">{{ $t("gyroflightV2PlanTitle") }}</p>
                        <p class="text-dimmed">{{ $t("gyroflightV2PlanHelp") }}</p>
                        <MeasurementPlanTable :plan="result.measurementPlan" />
                    </template>
                    <p
                        v-if="plan.sweep"
                        class="text-dimmed mt-2"
                        data-gyrocore="v2-plan-coverage"
                        :data-valid="plan.sweep.valid ? 'yes' : 'no'"
                    >
                        {{ planCoverageText }}
                    </p>
                    <p class="text-dimmed mt-2">
                        {{ $t("gyroflightV2RecordingChecks") }}: {{ plan.completionChecks.join(" ") }}
                    </p>
                    <p class="text-dimmed">{{ plan.notChanged.join("; ") }}</p>
                    <p class="text-dimmed" data-gyrocore="v2-plan-note">{{ plan.note }}</p>
                </details>
            </div>
        </template>

        <!-- 5. Verify -->
        <template v-if="show('verify')">
            <h4 class="font-bold mt-3" data-step="v2-verify">5. {{ $t("gyroflightStepVerify") }}</h4>
            <p v-if="!outcome" class="text-sm text-dimmed">{{ $t("gyroflightVerifyNone") }}</p>
            <div v-else-if="outcome.status === 'verified'" class="text-sm" data-gyrocore="v2-verified">
                <p class="font-bold text-green-500">
                    {{ $t(outcome.action === "apply" ? "gyroflightVerifiedApply" : "gyroflightVerifiedRestore") }}
                </p>
                <p
                    v-if="outcome.mode === 'experimental'"
                    class="text-yellow-500"
                    data-gyrocore="v2-verified-experimental"
                >
                    {{ $t("gyroflightV2VerifiedExperimental") }}
                </p>
                <p v-if="outcome.rebootRequired" class="text-yellow-500" data-gyrocore="v2-reboot">
                    {{ $t("gyroflightV2RebootRequired") }}
                </p>
            </div>
            <div
                v-else
                class="text-sm"
                data-gyrocore="v2-failed"
                :data-status="outcome.status"
                :data-saved="outcome.saved"
            >
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
                    <p
                        v-else-if="outcome.changedFromBackup === null"
                        class="text-yellow-500"
                        data-gyrocore="v2-fc-unknown"
                    >
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
        </template>

        <!-- 6. Restore -->
        <template v-if="show('restore')">
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
        </template>
    </UiBox>
</template>

<script lang="ts">
/** The panel's parts, in template order; the Autotune tab shows each in its own section. */
export type AutotuneV2Part =
    | "sources"
    | "analyze"
    | "verifiedTune"
    | "parts"
    | "margins"
    | "multi"
    | "measurementPlan"
    | "jio"
    | "jioSet"
    | "jioPlots"
    | "qualification"
    | "compare"
    | "apply"
    | "experimental"
    | "decisions"
    | "recordingPlan"
    | "verify"
    | "restore";
</script>

<script setup lang="ts">
/*
 * Autotune engine v2: Analyze -> Calculate -> Compare -> Apply -> Verify -> Restore for
 * absolute PID, feedforward and filter values. Every part shows its status and the
 * measurement it still needs; only VALIDATED values under a released contract can be
 * applied, and only by the user's click (useAutotuneV2).
 */
import { computed, ref } from "vue";
import UiBox from "@/components/elements/UiBox.vue";
import { i18n } from "@/js/localization";
import { useConnectionStore } from "@/stores/connection";
import { useFlightControllerStore } from "@/stores/fc";
import { useAutotuneV2 } from "@/composables/useAutotuneV2";
import { useAutotuneV2Store, type AutotuneV2Source } from "@/gyrocore/stores/autotuneV2";
import { restoreTargetIssue, useTuneBackupStore, type TuneBackup } from "@/gyrocore/stores/tuneBackup";
import { useFcTransactionStore } from "@/gyrocore/stores/fcTransactionState";
import UncertainStateNotice from "@/gyrocore/components/UncertainStateNotice.vue";
import MeasurementPlanTable from "@/gyrocore/components/MeasurementPlanTable.vue";
import { evaluateRelease, LIVE_CONDITIONS } from "@/gyrocore/releaseGate/releaseContract";
import { absoluteWriteDecision } from "@/gyrocore/releaseGate/writeAuthority";
import { experimentalWriteDecision } from "@/gyrocore/releaseGate/experimentalAuthority";
import { expectedValues } from "@/gyrocore/tuning/absoluteTune";
import { logIdentity as recordingIdentity } from "@/gyrocore/tuning/fcIdentity";
import { evaluateAbsoluteSafety } from "@/gyrocore/safety/absoluteEvaluate";
import { useVerifiedTuneStore } from "@/gyrocore/stores/verifiedTunes";
import { logIdentity } from "@/gyrocore/tuning/fcIdentity";
import { loggedAbsoluteValues } from "@/gyrocore/tuning/absoluteTune";
import { RESOLVED_FEATURE_BINS, type LoopMargins } from "@/gyrocore/engine/loopModel";
import { SUPPLEMENTARY_MEASUREMENT } from "@/gyrocore/engine/recordingInstruction";

const props = defineProps<{
    /** The parts to show; every part when absent. */
    parts?: AutotuneV2Part[];
    /** The box title; the engine's name when absent. */
    title?: string;
}>();
const show = (part: AutotuneV2Part) => !props.parts || props.parts.includes(part);

const v2 = useAutotuneV2Store();
const connection = useConnectionStore();
const fc = useFlightControllerStore();
const backupStore = useTuneBackupStore();
const transactionStates = useFcTransactionStore();
const verifiedTunes = useVerifiedTuneStore();
const {
    calculate,
    createVerifiedTune,
    preview,
    releasedProposal,
    experimentalProposal,
    confirmAndApply,
    confirmAndApplyExperimental,
    confirmAndRestore,
} = useAutotuneV2();

const result = computed(() => v2.result);
const t = (key: string, params?: (string | number)[]) => i18n.getMessage(key, params?.map(String));
const num = (x: number | null | undefined, digits: number) =>
    x == null || !Number.isFinite(x) ? "--" : x.toFixed(digits);
const band = (b: [number, number] | null) => (b ? `${num(b[0], 1)}–${num(b[1], 1)}` : "--");
/** The experimental CHIRP + JIO route per axis: what was measured, what is missing, what it says. */
const jioRows = computed(() => {
    const jio = result.value?.jio;
    if (!jio) return [];
    return (["roll", "pitch", "yaw"] as const).flatMap((axis) => {
        const a = jio.analysis.axes[axis];
        if (!a) return [];
        const c = jio.chain[axis];
        const used = a.records.filter((r) => r.used).length;
        const flags = a.records.flatMap((r) => r.flags);
        const reasons = Object.entries(a.reasons).map(([k, v]) => `${k}:${v}`);
        const m = c?.margins ?? null;
        const cf = jio.crossFlight.axes[axis];
        return [
            {
                axis,
                records: `${used}/${a.records.length}${flags.length ? ` (${flags.join(", ")})` : ""}`,
                consistency: a.repeats.consistency,
                repeats: `${a.repeats.count}: ${a.repeats.consistency}${a.repeats.z !== null ? ` z=${a.repeats.z.toFixed(2)}` : ""}`,
                crossFlightConsistency: cf?.consistency ?? "none",
                crossFlight: cf
                    ? `${cf.flights}: ${cf.consistency} z=${cf.zMax!.toFixed(2)} (plant z=${num(cf.zPlantMax, 2)}; ${i18n.getMessage("gyroflightV2JioCrossFlightHelp")})`
                    : jio.crossFlight.candidates.length
                      ? i18n.getMessage("gyroflightV2JioCrossFlightNone")
                      : "--",
                band: a.band
                    ? `${band(a.band.supportedHz)} Hz (${Math.round(100 * a.band.supportedFraction)} %, ${a.band.gapPoints} ${i18n.getMessage("gyroflightV2JioGapPoints")})`
                    : "--",
                missing: reasons.join(", ") || "--",
                margins: m
                    ? `${num(m.crossoverHz, 1)} Hz / ${num(m.phaseMarginDeg ?? m.measured.phaseMarginDeg, 0)}° (${m.evidence.level})`
                    : "--",
                // Two searches read this route: the release optimiser on bounded margins (jio.chain) and the
                // experimental measured-margin search (candidateDecisions, also in 4c and the overview).
                candidate: c?.candidate ? `${c.candidate.status}: ${c.candidate.outcome}` : "--",
                measuredSearch: jioSearchText(result.value?.candidateDecisions[axis]?.jio ?? null),
                computable: !!c?.tuningComputable,
                tuning: c
                    ? c.tuningComputable
                        ? i18n.getMessage("gyroflightV2JioDiagnosticOnly")
                        : `${i18n.getMessage("gyroflightV2JioNotComputable")}: ${c.reasons.join(", ")}`
                    : a.blockers.join(", "),
            },
        ];
    });
});
/** The measured-margin search on the JIO plant (candidateDecision.ts): its status and how far it ran. */
function jioSearchText(
    r: { status: string; searchRan: boolean; candidatesTried: number; candidatesUsable: number } | null,
) {
    if (!r) return "--";
    const ran = r.searchRan
        ? i18n.getMessage("gyroflightV2JioSearchRan", [r.candidatesUsable, r.candidatesTried])
        : i18n.getMessage("gyroflightV2JioSearchNotRun");
    return `${r.status} (${ran})`;
}
/** The next sweep per axis: the firmware's own exponential sweep with a band-matched end frequency. */
const jioAdvice = computed(() => {
    const jio = result.value?.jio;
    if (!jio) return [];
    return (["roll", "pitch", "yaw"] as const).flatMap((axis) => {
        const adv = jio.analysis.axes[axis]?.sweepAdvice;
        if (!adv) return [];
        const cur = `${num(adv.current.f0Hz, 1)}–${num(adv.current.f1Hz, 0)} Hz over ${num(adv.current.durationS, 0)} s (${num(adv.current.secondsPerOctave, 2)} s per octave, ${num(adv.current.octavesAboveSupport, 1)} octaves above the supported band)`;
        const sg = adv.suggested;
        const text = sg
            ? i18n.getMessage("gyroflightV2JioAdvice", [
                  axis,
                  cur,
                  `chirp_frequency_start_deci_hz=${sg.chirp_frequency_start_deci_hz}, chirp_frequency_end_deci_hz=${sg.chirp_frequency_end_deci_hz}, chirp_time_seconds=${sg.chirp_time_seconds} (${num(sg.secondsPerOctave, 2)} s per octave; excitation per octave +${num(sg.excitationGainDb, 1)} dB from the shorter band, not an amplitude setting)`,
                  adv.basis.join(", "),
              ])
            : i18n.getMessage("gyroflightV2JioAdviceNone", [axis, cur, adv.basis.join(", ")]);
        return [{ axis, text }];
    });
});
/** Every other log offered as a cross-flight repeat: usable with its per-axis z, or why not. */
const jioCandidates = computed(() => {
    const jio = result.value?.jio;
    if (!jio) return [];
    return jio.crossFlight.candidates.map((c) => {
        const id = `${c.sha256.slice(0, 12)}#${c.logIndex + 1}`;
        if (!c.usable) return `${id}: ${c.issues.join(", ")}`;
        // "setting_not_logged_in_either:<key>" shows as the key; "setting_not_in_firmware:<key>:<hash>" says so.
        const keys = c.notes.map((n) =>
            n.startsWith("setting_not_in_firmware:")
                ? `${n.split(":")[1]} (${i18n.getMessage("gyroflightV2JioCandidateNotInFirmware")} ${n.split(":")[2]})`
                : n.replace("setting_not_logged_in_either:", ""),
        );
        const notes = keys.length
            ? ` [${i18n.getMessage("gyroflightV2JioCandidateNotLogged")}: ${keys.slice(0, 4).join(", ")}${keys.length > 4 ? ` +${keys.length - 4}` : ""}]`
            : "";
        const axes = (["roll", "pitch", "yaw"] as const).map((axis) => {
            const a = c.axes[axis];
            if (!a) return `${axis} --`;
            return a.z !== null
                ? `${axis} ${a.consistency} z=${a.z.toFixed(2)} (plant z=${num(a.zPlant, 2)}, ${a.matchedPoints} pts)`
                : `${axis} ${a.consistency}: ${a.reasons.join(", ")}`;
        });
        return `${id}: ${axes.join("; ")}${notes}`;
    });
});
/**
 * The measurement set per axis: sweeps present / complete / usable, repeats within this flight and
 * flights compared, the bands, and the recordings still missing (this axis's own needs). A set that
 * is complete here is a measurement set, not validation: the route stays diagnostic.
 */
/** The route's measurement codes, required apart from supplementary (a second flight: block 7 agreement). */
const jioNeeds = computed(() => {
    const all = result.value?.jio.requiredMeasurements ?? [];
    return {
        required: all.filter((r) => !SUPPLEMENTARY_MEASUREMENT.test(r)),
        supplementary: all.filter((r) => SUPPLEMENTARY_MEASUREMENT.test(r)),
    };
});
const jioProgress = computed(() => {
    const jio = result.value?.jio;
    if (!jio) return [];
    return (["roll", "pitch", "yaw"] as const).flatMap((axis) => {
        const p = jio.progress[axis];
        if (!p) return [];
        const sw = p.sweeps;
        const excluded = sw.excluded.length
            ? ` (${i18n.getMessage("gyroflightV2JioProgressExcluded")}: ${sw.excluded.join("; ")})`
            : "";
        const within = `${p.withinFlight.repeats}: ${p.withinFlight.consistency}${p.withinFlight.z !== null ? ` z=${p.withinFlight.z.toFixed(2)}` : ""}`;
        // No "/" in i18n arguments: the substitution HTML-escapes it (seen in the browser run).
        const across = `${p.acrossFlights.flights} of ${p.acrossFlights.offered}: ${p.acrossFlights.consistency}${p.acrossFlights.zMax !== null ? ` z=${p.acrossFlights.zMax.toFixed(2)}` : ""}`;
        const reached =
            p.bandHz.reached !== null
                ? ` (${i18n.getMessage("gyroflightV2JioProgressReached")} ${num(p.bandHz.reached, 0)} Hz)`
                : "";
        const goal = p.bandHz.tuningGoal
            ? `${band(p.bandHz.tuningGoal)} Hz: ${p.bandHz.sufficientForTuning ? i18n.getMessage("gyroflightV2JioProgressGoalMet") : `${i18n.getMessage("gyroflightV2JioProgressGoalShort")}, ${i18n.getMessage("gyroflightV2JioProgressMissing")} ${p.bandHz.missing.map((b) => `${band(b)} Hz`).join(", ")}`}`
            : "--";
        const text = i18n.getMessage("gyroflightV2JioProgress", [
            `${sw.present} ${i18n.getMessage("gyroflightV2JioProgressPresent")}, ${sw.complete} ${i18n.getMessage("gyroflightV2JioProgressComplete")}, ${sw.usable} ${i18n.getMessage("gyroflightV2JioProgressUsable")}${excluded}`,
            within,
            across,
            `${band(p.bandHz.supported)} Hz${reached}`,
            goal,
        ]);
        // The agreed plan: two complete rounds in one flight. A second flight is supplementary: its
        // absence leaves the cross-flight check unknown and does not keep the set incomplete.
        const complete =
            sw.complete >= 2 && p.withinFlight.consistency === "consistent" && p.bandHz.sufficientForTuning === true;
        return [
            {
                axis,
                text,
                next: p.nextSteps.map(measurementText).join("; "),
                supplementary: (p.supplementary ?? []).map(measurementText).join("; "),
                complete,
            },
        ];
    });
});
/**
 * |G| (dB) over log frequency, filled where supported, with the r→y coherence as a dashed line
 * (0–1 over the plot height, scale on the right). Axis titles and tick labels sit outside the plot.
 */
const jioPlots = computed(() => {
    const jio = result.value?.jio;
    if (!jio) return [];
    const w = 520;
    const h = 230;
    const x0 = 52;
    const y0 = 8;
    const pw = w - x0 - 40;
    const ph = h - y0 - 38;
    return (["roll", "pitch", "yaw"] as const).flatMap((axis) => {
        const a = jio.analysis.axes[axis];
        const pts = a?.points;
        const band = a?.band?.analysedHz;
        if (!pts || !band || !(band[1] > band[0])) return [];
        const lo = Math.log10(band[0]);
        const hi = Math.log10(band[1]);
        const x = (f: number) => x0 + (pw * (Math.log10(f) - lo)) / (hi - lo);
        const idx: number[] = [];
        for (let i = 0; i < pts.frequencyHz.length; i++)
            if (pts.frequencyHz[i] >= band[0] && pts.frequencyHz[i] <= band[1]) idx.push(i);
        const db = (i: number) => 20 * Math.log10(Math.hypot(pts.gRe[i], pts.gIm[i]));
        const sup = idx
            .filter((i) => pts.supported[i])
            .map(db)
            .filter(Number.isFinite);
        const ref = sup.length ? sup : idx.map(db).filter(Number.isFinite);
        if (!ref.length) return [];
        const dbMin = Math.floor(Math.min(...ref) - 6);
        const dbMax = Math.ceil(Math.max(...ref) + 6);
        const y = (v: number) => y0 + ph * (1 - Math.min(1, Math.max(0, (v - dbMin) / (dbMax - dbMin))));
        const stride = Math.max(1, Math.ceil(idx.length / 400));
        const dots: { x: number; y: number; sup: boolean }[] = [];
        const coh: string[] = [];
        for (let k = 0; k < idx.length; k += stride) {
            const i = idx[k];
            const v = db(i);
            if (Number.isFinite(v))
                dots.push({ x: +x(pts.frequencyHz[i]).toFixed(1), y: +y(v).toFixed(1), sup: pts.supported[i] === 1 });
            const g2 = Math.min(1, Math.max(0, pts.coherenceRy[i]));
            coh.push(`${x(pts.frequencyHz[i]).toFixed(1)},${(y0 + ph * (1 - g2)).toFixed(1)}`);
        }
        const ticks = [1, 2, 5, 10, 20, 50, 100, 200, 500]
            .filter((f) => f >= band[0] && f <= band[1])
            .map((hz) => ({ hz, x: +x(hz).toFixed(1) }));
        const step = niceStep((dbMax - dbMin) / 5);
        const dbTicks: { v: number; y: number }[] = [];
        for (let v = Math.ceil(dbMin / step) * step; v <= dbMax; v += step) dbTicks.push({ v, y: +y(v).toFixed(1) });
        const cohTicks = [0, 0.5, 1].map((v) => ({ v, y: +(y0 + ph * (1 - v)).toFixed(1) }));
        return [{ axis, w, h, x0, y0, pw, ph, dbMin, dbMax, dots, coherence: coh.join(" "), ticks, dbTicks, cohTicks }];
    });
});
/** A 1-2-5 step at or above `raw`, for the dB scale. */
function niceStep(raw: number): number {
    const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)));
    return [1, 2, 5, 10].map((m) => m * p).find((v) => v >= raw) ?? 10 * p;
}
const jioMimoText = computed(() => {
    const m = result.value?.jio?.analysis.mimo;
    return m
        ? i18n.getMessage("gyroflightV2JioMimo", [String(m.pointsWellConditioned), band(m.bandHz), m.notes.join(", ")])
        : null;
});
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

/** GyroCore Safety's checks of that proposal (absoluteEvaluate.ts), against the record this browser holds. */
const safetyChecks = computed(() => {
    const p = v2.result?.releasableProposal ?? v2.result?.proposal;
    if (!p) return [];
    const id = logIdentity(p.log.headerPairs);
    const verifiedTune = verifiedTunes.forCraft(
        id.uid,
        id.firmwareRevision?.split(/\s+/)[1] ?? null,
        loggedAbsoluteValues(p.log.headerPairs),
    );
    return evaluateAbsoluteSafety(p, { verifiedTune }).checks;
});

const canPreview = computed(() => !!v2.result?.proposal && connected.value && !connection.virtualMode);
// An earlier write on this craft whose outcome nobody verified refuses every Apply (fcTransactionState).
const stateBlocks = computed(() => transactionStates.blocks(fc.config.uid));
const canApply = computed(
    () => !!released.value && connected.value && !connection.virtualMode && !stateBlocks.value.length,
);

/**
 * EXPERIMENTAL route: the analysis's experimental proposal (its own status, never the releasable
 * one), the technical decision of its own authority, and the user's acknowledgement. A missing
 * release or hardware validation does not disable it; a technical block, an armed or other craft,
 * an unverified earlier write, or no acknowledgement does.
 */
const experimental = computed(() => v2.result?.experimental ?? null);
const experimentalWithheld = computed(() => v2.result?.experimentalWithheld ?? []);
const experimentalDecision = computed(() =>
    experimental.value ? experimentalWriteDecision(experimental.value, { recompute: false }) : null,
);
// Local on purpose: the acknowledgement is asked again whenever the Tuning and apply section is reopened.
const experimentalAck = ref(false);
const experimentalBlocks = computed(() => [
    ...(experimentalDecision.value?.blocks ?? []),
    ...stateBlocks.value,
    ...(connected.value ? [] : ["fc:not_connected"]),
    ...(connection.virtualMode ? ["fc:virtual_mode"] : []),
    ...(experimentalAck.value ? [] : ["experimental:not_acknowledged"]),
]);
const canPreviewExperimental = computed(() => !!experimental.value && connected.value && !connection.virtualMode);
const canApplyExperimental = computed(
    () =>
        !!experimentalProposal() &&
        experimentalAck.value &&
        connected.value &&
        !connection.virtualMode &&
        !stateBlocks.value.length,
);

/** Per axis and route the candidate decision (engine candidateDecision.ts) as table rows. */
const decisionRows = computed(() => {
    const d = v2.result?.candidateDecisions;
    if (!d) return [];
    const val = (v: number | string | null) => (v === null ? "unknown" : typeof v === "number" ? v.toFixed(3) : v);
    return (["roll", "pitch", "yaw"] as const).flatMap((axis) =>
        (["primary", "jio"] as const).flatMap((route) => {
            const r = d[axis]?.[route];
            if (!r) return [];
            const fc = r.firstCause;
            const waived = r.checks
                .filter((c) => c.result === "waived")
                .map((c) => `${c.rule}: waived (${c.consequence})`)
                .join("; ");
            return [
                {
                    axis,
                    route,
                    status: r.status,
                    plant: `${r.plant}${r.bandHz ? ` (${band(r.bandHz)} Hz)` : ""}`,
                    search: r.searchRan ? `${r.candidatesUsable} of ${r.candidatesTried}` : "not run",
                    cause:
                        [
                            fc
                                ? `${fc.rule}: ${val(fc.value)}${fc.unit ? ` ${fc.unit}` : ""}; ${fc.threshold}; ${fc.result}; ${fc.consequence}`
                                : "",
                            waived,
                        ]
                            .filter(Boolean)
                            .join(" | ") || "--",
                },
            ];
        }),
    );
});
/** The agreed measurement plan (engine recordingInstruction.ts): missing frequencies, existing data, proposed settings. */
const plan = computed(() => v2.result?.recordingPlan ?? null);
/** A setting's value with its unit, and Hz beside a dHz value. */
function settingValue(v: string | number | null, unit: string, hz: number | null): string {
    if (v === null) return "unknown";
    return `${v}${unit ? ` ${unit}` : ""}${hz !== null ? ` (${num(hz, 1)} Hz)` : ""}`;
}
/** The recording plan is rendered (it sits with the decisions, so it needs them); it then carries the planner table. */
const planShown = computed(() => show("recordingPlan") && !!plan.value && decisionRows.value.length > 0);
/**
 * One row per setting: the value the imported flight logged beside the proposed one. The proposed
 * sweep names blackbox_sample_rate by its CLI name; the log names it by its header field.
 */
const planSettingRows = computed(() => {
    const p = plan.value;
    if (!p) return [];
    const proposed = p.sweep ? [...p.sweep.settings, ...p.sweep.amplitudes] : [];
    const cliName = (name: string) => name.replace(/ \(P interval\)$/, "");
    const rows = p.existing.settings.map((st) => {
        const prop = proposed.find((x) => x.name === cliName(st.name)) ?? null;
        return {
            name: prop?.name ?? st.name,
            label: st.name,
            current: settingValue(st.current, st.unit, st.hz?.current ?? null),
            proposed: prop
                ? {
                      text: settingValue(prop.proposed, prop.unit, prop.hz?.proposed ?? null),
                      changed: prop.changed,
                      basis: prop.basis,
                  }
                : null,
        };
    });
    const extra = proposed
        .filter((x) => !rows.some((r) => r.name === x.name))
        .map((x) => ({
            name: x.name,
            label: x.name,
            current: settingValue(x.current, x.unit, x.hz?.current ?? null),
            proposed: {
                text: settingValue(x.proposed, x.unit, x.hz?.proposed ?? null),
                changed: x.changed,
                basis: x.basis,
            },
        }));
    return [...rows, ...extra];
});
const MISSING_KIND: Record<string, string> = {
    decision_band_hole: "inside the decision band",
    below_identified_band: "planner band below the identified band",
    above_identified_band: "planner band above the identified band",
    quality_gate_band: "quality gate band",
};
const planAxes = computed(() =>
    (plan.value?.axes ?? []).map((ax) => ({
        axis: ax.axis,
        kind: ax.kind,
        note: ax.note,
        missing: ax.missing.flatMap((m) =>
            m.intervals.map((iv) => {
                const at =
                    iv.fromHz === iv.toHz ? `${num(iv.fromHz, 1)} Hz` : `${num(iv.fromHz, 1)}–${num(iv.toHz, 1)} Hz`;
                const bins = iv.bins !== null ? ` (${iv.bins} bin${iv.bins === 1 ? "" : "s"})` : "";
                const value = iv.value === null ? "unknown" : `${num(iv.value, 3)}${iv.unit ? ` ${iv.unit}` : ""}`;
                return {
                    route: m.route,
                    kind: iv.kind,
                    text: `${m.route}: ${at}${bins}, ${MISSING_KIND[iv.kind]}: ${iv.reason} ${value}; required ${iv.threshold}`,
                };
            }),
        ),
    })),
);
const planRoundsText = computed(() => {
    const r = plan.value?.existing.rounds;
    if (!r) return "";
    return i18n.getMessage("gyroflightV2PlanRounds", [
        String(r.complete),
        String(r.required),
        String(r.usable),
        r.perAxis.map((p) => `${p.axis} ${p.complete} of ${p.present} complete, ${p.usableComplete} usable`).join("; "),
        i18n.getMessage(`gyroflightV2PlanRounds_${r.state}`),
    ]);
});
const planSecondFlightText = computed(() => {
    const f = plan.value?.existing.secondFlight;
    if (!f) return "";
    return i18n.getMessage("gyroflightV2PlanSecondFlight", [
        String(f.flights),
        f.perAxis.map((p) => `${p.axis} ${p.consistency}`).join(", "),
        i18n.getMessage(`gyroflightV2PlanSecondFlight_${f.state}`),
    ]);
});
const planCoverageText = computed(() => {
    const sw = plan.value?.sweep;
    if (!sw) return "";
    const cov = sw.coverage.map(
        (c) => `${c.axis}: ${c.covered === null ? "unknown" : c.covered ? "covered" : "not covered"} (${c.basis})`,
    );
    const gain =
        sw.excitationGainDb === null
            ? "unknown"
            : `${sw.excitationGainDb >= 0 ? "+" : ""}${num(sw.excitationGainDb, 1)} dB`;
    return i18n.getMessage("gyroflightV2PlanCoverage", [cov.join("; "), gain, sw.firmwareChecks.join(", ")]);
});
const planTimingText = computed(() => {
    const t = plan.value?.timing;
    if (!t) return "";
    return i18n.getMessage("gyroflightV2PlanTiming", [
        String(t.activations),
        String(t.sweepS),
        String(t.activeExcitationS),
        String(Math.round(t.sequenceS)),
        t.experimental.join("; "),
    ]);
});

/**
 * Which configuration a recording was flown with, from this browser's backups: the reference
 * (its logged values equal a backup's values before an experimental Apply) or the applied
 * experimental tune (its logged values equal the values that Apply wrote). Different
 * configurations are never merged as repeats: the engine's identity rules reject them.
 */
function recordingConfig(s: AutotuneV2Source): { role: "reference" | "experimental" | "other"; text: string } | null {
    const headers = s.report.logs[0]?.headerPairs ?? [];
    if (!headers.length) return null;
    const logged = loggedAbsoluteValues(headers);
    const uid = recordingIdentity(headers).uid;
    const same = (a: Record<string, number>, b: Record<string, number>) => {
        const keys = Object.keys(a).filter((k) => k in b);
        return keys.length > 0 && keys.every((k) => a[k] === b[k]);
    };
    for (const b of backupStore.forUid(uid)) {
        if (!b.absolute || b.reason !== "before_experimental_apply" || !b.provenance) continue;
        if (same(expectedValues(b.absolute.values, b.provenance.change), logged))
            return { role: "experimental", text: i18n.getMessage("gyroflightV2RecordingExperimental", [b.id]) };
        if (same(b.absolute.values, logged))
            return { role: "reference", text: i18n.getMessage("gyroflightV2RecordingReference", [b.id]) };
    }
    return { role: "other", text: i18n.getMessage("gyroflightV2RecordingOther") };
}

function summary(s: AutotuneV2Source) {
    const ms = s.report.measurements;
    return i18n.getMessage("gyroflightAnalyzeChirpSummary", [
        String(ms.length),
        String(ms.filter((m) => m.state !== "rejected").length),
        String(ms.filter((m) => m.state === "rejected").length),
    ]);
}

/** Display rounding: full 1-digit only when evidence is VALIDATED; otherwise coarse / status (Grokbot F6). */
const fmt = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? "?" : v.toFixed(d));
const fmtMargin = (v: number | null | undefined, qualified: boolean, unit: string) => {
    if (v === null || v === undefined || !Number.isFinite(v)) return "?";
    if (qualified) return `${v.toFixed(1)}${unit}`;
    // Unqualified: whole degrees / dB so the UI does not imply measurement precision it lacks.
    return `~${Math.round(v)}${unit}`;
};
/** A bound the evidence cannot give shows "?" in the row text; here it says unknown. */
const boundText = (v: string) => v.replace(/\?/g, i18n.getMessage("gyroflightV2BoundUnknown"));
const shortId = (id: string) => (id.includes(":") ? `${id.slice(0, 8)}…:${id.split(":").pop()}` : id.slice(0, 12));

const marginRows = computed(() => {
    const r = v2.result;
    if (!r) return [];
    return (["roll", "pitch", "yaw"] as const).flatMap((axis, i) => {
        const m = r.margins[axis];
        if (!m) return [];
        const chain = r.chain.validation[i];
        const band = chain?.fit?.bands.find((b) => b.loHz === 20);
        const ev = m.proposed.evidence;
        const q = ev?.level === "VALIDATED" && m.proposed.status === "VALIDATED";
        const qCur = m.current.evidence?.level === "VALIDATED" && m.current.status === "VALIDATED";
        return [
            {
                axis,
                chain: chain
                    ? `${chain.controlBand}${band?.phaseDeg !== null && band ? ` (${band.phaseDeg.toFixed(1)}°)` : ""}`
                    : "--",
                fc: `${fmt(m.current.crossoverHz)} → ${fmt(m.proposed.crossoverHz)} Hz`,
                pm: `${fmtMargin(m.current.phaseMarginDeg, qCur, "°")} → ${fmtMargin(m.proposed.phaseMarginDeg, q, "°")}`,
                gm: `${fmtMargin(m.current.gainMarginDb, qCur, " dB")} → ${fmtMargin(m.proposed.gainMarginDb, q, " dB")}`,
                s: `${fmtMargin(m.current.sensitivityPeakDb, qCur, " dB")} → ${fmtMargin(m.proposed.sensitivityPeakDb, q, " dB")}`,
                pmMeasured: `${fmtMargin(m.current.measured?.phaseMarginDeg, false, "°")} → ${fmtMargin(m.proposed.measured?.phaseMarginDeg, false, "°")}`,
                gmMeasured: `${fmtMargin(m.current.measured?.gainMarginDb, false, " dB")} → ${fmtMargin(m.proposed.measured?.gainMarginDb, false, " dB")}`,
                sMeasured: `${fmtMargin(m.current.measured?.sensitivityPeakDb, false, " dB")} → ${fmtMargin(m.proposed.measured?.sensitivityPeakDb, false, " dB")}`,
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
    "required_measurement:chirp_with_full_band_support",
    "required_measurement:chirp_longer_window_for_resolution",
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

// Only backups a Restore may write back (tuneBackup.ts restoreTargetIssue).
const backups = computed(() =>
    connected.value ? backupStore.forUid(fc.config.uid).filter((b) => !!b.absolute && !restoreTargetIssue(b)) : [],
);

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

async function onPreviewExperimental() {
    if (canPreviewExperimental.value && !v2.busy && experimental.value) {
        v2.busy = true;
        try {
            await preview(experimental.value.proposal);
        } finally {
            v2.busy = false;
        }
    }
}

async function onApplyExperimental() {
    if (canApplyExperimental.value) {
        await confirmAndApplyExperimental(experimentalAck.value);
        backupStore.reload();
    }
}

async function onRestore(b: TuneBackup) {
    await confirmAndRestore(b);
    backupStore.reload();
}
</script>
