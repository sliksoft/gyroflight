/*
 * This file is part of Betaflight.
 *
 * Betaflight is free software. You can redistribute this software
 * and/or modify this software under the terms of the GNU General
 * Public License as published by the Free Software Foundation,
 * either version 3 of the License, or (at your option) any later
 * version.
 *
 * Betaflight is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 *
 * See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public
 * License along with this software.
 *
 * If not, see <http://www.gnu.org/licenses/>.
 */

import { useAutotuneStore } from "@/stores/autotune";
import FileSystem from "@/js/FileSystem";
import { i18n } from "@/js/localization";
import FC from "@/js/fc";
import MSP from "@/js/msp";
import MSPCodes from "@/js/msp/MSPCodes";
import { mspHelper } from "@/js/msp/MSPHelper";
import type { SysConfig } from "@/js/blackbox/chirp_bbl_parser";
import type {
    CurrentSliders,
    GainRecommendation,
    Sensitivity,
    Spectrogram,
    StepResponse,
    TransferFunction,
} from "@/js/blackbox/spectral_analysis";
import { validateTuningSliders } from "@/composables/useTuningSliders";
// Gyroflight: CHIRP input comes from the Blackbox Viewer decode and is qualified
// by GyroCore before Betaflight's recommendation may be shown or applied.
// See docs/gyrocore/CHIRP_QUALIFICATION.md.
import { qualifyChirpFile, recomputeRecommendations, type AutotuneMath } from "@/gyrocore/chirp/qualification";
import { ApplyBlockedError, assertApplyAuthorized, liveSliderModeBlocks } from "@/gyrocore/chirp/applyGate";
import { useChirpQualificationStore } from "@/gyrocore/stores/chirpQualification";

export type AxisName = "roll" | "pitch" | "yaw";

/** The gains derived for one axis, as the table shows them. */
export type AxisGains = ReturnType<typeof buildGains>;

/**
 * One axis of an analysed log: the measured responses and the recommended gains.
 * `gains` is null when GyroCore rejected the measurement: the plots are then
 * diagnostic only and no recommendation exists.
 */
export interface AxisResult {
    transferFunction: TransferFunction;
    sensitivity: Sensitivity;
    stepResponse: StepResponse;
    spectrogram: Spectrogram;
    gains: AxisGains | null;
    sampleCount: number;
}

/** A whole analysed log, as the autotune store holds it. */
export interface AnalysisResult {
    filename: string;
    sampleRate: number;
    axes: Partial<Record<AxisName, AxisResult>>;
    sysConfig: SysConfig;
    // Kept so the gain recommendation can be recomputed against a different
    // phase-margin target without re-importing the log.
    currentSliders: Required<CurrentSliders>;
}

export type ProposedSliders = GainRecommendation["proposed"];

type AutotuneStore = ReturnType<typeof useAutotuneStore>;

// `err?.name` / `err?.message` for a caught value of unknown type.
function errorField(err: unknown, field: "name" | "message"): string | undefined {
    if (typeof err !== "object" || err === null) {
        return undefined;
    }
    const value: unknown = Reflect.get(err, field);
    return typeof value === "string" ? value : undefined;
}

/**
 * Composable providing autotune import and gain-apply logic.
 */
export function useAutotune() {
    const store = useAutotuneStore();

    async function importAndAnalyze() {
        const gate = useChirpQualificationStore();
        gate.reset();
        store.analysisState = "importing";
        store.errorMessage = "";
        store.progressMessage = "Selecting file...";

        const file = await pickFileOrSetError(store);
        if (!file) {
            return;
        }

        try {
            store.progressMessage = `Reading ${file.name}...`;
            const blob = await FileSystem.readFileAsBlob(file);
            const data = new Uint8Array(await blob.arrayBuffer());

            store.analysisState = "analyzing";
            store.progressMessage = "Decoding logs...";
            const report = qualifyChirpFile(data, file.name, store.targetPhaseMarginDeg, AUTOTUNE_MATH, (i, n) => {
                store.progressMessage = `Analysing log ${i + 1} of ${n}...`;
            });
            if (report.logCount === 0) {
                throw new Error("No log segments found in the file.");
            }
            gate.setReport(report);
            if (report.state === "no_chirp") {
                throw new Error(i18n.getMessage("gyrocoreChirpNoChirpError", [report.logCount]));
            }

            const result = gate.analysisResult();
            if (!result) {
                // CHIRP exists but nothing could even be plotted: still REJECTED, not "no CHIRP".
                throw new Error(i18n.getMessage("gyrocoreChirpRejectedError"));
            }

            store.analysisResult = result;
            store.analysisState = "done";
            store.progressMessage = "";
        } catch (err) {
            store.analysisState = "error";
            store.errorMessage = errorField(err, "message") || "Analysis failed.";
            store.progressMessage = "";
        }
    }

    /**
     * Recompute the gain recommendation against a new phase-margin target.
     *
     * The transfer functions are already in the store, so this is a pure
     * re-derivation — no file access, no re-parse.
     *
     */
    function recomputeGains(targetPhaseMarginDeg: number) {
        const gate = useChirpQualificationStore();
        const result = store.analysisResult;
        if (!gate.report || !result?.axes) {
            return;
        }
        // Recommendations exist only for qualified measurements; rejected ones stay without gains.
        recomputeRecommendations(gate.report, targetPhaseMarginDeg, AUTOTUNE_MATH);
        gate.touch();
        for (const [axisName, axis] of Object.entries(result.axes)) {
            const measurement = gate.selectedMeasurements[axisName as AxisName];
            if (axis && measurement) {
                axis.gains = measurement.recommendation?.gains ?? null;
            }
        }
    }

    return { importAndAnalyze, applyGains, recomputeGains };
}

async function pickFileOrSetError(store: AutotuneStore) {
    try {
        const file = await FileSystem.pickOpenFile(
            i18n.getMessage("fileSystemPickerFiles", { typeof: "BBL" }),
            [".bbl", ".bfl", ".txt"],
            "autotune-file",
        );
        if (!file) {
            store.analysisState = "idle";
            store.progressMessage = "";
        }
        return file;
    } catch (err) {
        if (errorField(err, "name") === "AbortError" || errorField(err, "message") === "cancelled") {
            store.analysisState = "idle";
            store.progressMessage = "";
            return null;
        }
        store.analysisState = "error";
        store.errorMessage = errorField(err, "message") || "Failed to open file picker.";
        store.progressMessage = "";
        return null;
    }
}

function computeSampleRate(sysConfig: SysConfig) {
    const looptimeUs = sysConfig.looptime || 125;
    const pidDenom = sysConfig.pid_process_denom || 1;
    const bbRate = sysConfig.frameIntervalPDenom || 1;
    return 1e6 / (looptimeUs * pidDenom * bbRate);
}

function chooseSegmentSize(sampleRate: number) {
    let segmentSize = 256;
    while (segmentSize < sampleRate * 0.5) {
        segmentSize <<= 1;
    }
    return Math.min(segmentSize, 4096);
}

function extractCurrentSliders(sysConfig: SysConfig): Required<CurrentSliders> {
    return {
        masterMultiplier: (sysConfig.simplified_master_multiplier || 100) / 100,
        piGain: (sysConfig.simplified_pi_gain || 100) / 100,
        iGain: (sysConfig.simplified_i_gain || 100) / 100,
        dGain: (sysConfig.simplified_d_gain || 100) / 100,
        feedforwardGain: (sysConfig.simplified_feedforward_gain || 100) / 100,
        dtermFilterMultiplier: (sysConfig.simplified_dterm_filter_multiplier || 100) / 100,
    };
}

function buildGains(rec: GainRecommendation, sensitivity: Sensitivity, stepResponse: StepResponse) {
    return {
        proposed: rec.proposed,
        bandwidth: rec.analysis.bandwidthHz,
        crossover: rec.analysis.openLoopCrossoverHz,
        phaseMargin: rec.analysis.phaseMarginDeg,
        targetCrossover: rec.analysis.targetCrossoverHz,
        maxPhaseMargin: rec.analysis.maxAchievablePhaseMarginDeg,
        loopDelay: rec.analysis.loopDelayMs,
        resonantPeak: rec.analysis.resonantPeakDb,
        sensitivityPeak: sensitivity.peakDb,
        predictedSensitivityPeak: rec.analysis.predictedSensitivityPeakDb,
        // Which constraint limited the gain, and whether the recommendation
        // could be delivered in full. The interface reports these so a figure it
        // shows is never one the applied gain does not reach.
        sensitivityBinds: rec.analysis.sensitivityBinds,
        sensitivityUnreachable: rec.analysis.sensitivityUnreachable,
        gainClamped: rec.analysis.gainClamped,
        gainClampLimit: rec.analysis.gainClampLimit,
        requestedGain: rec.analysis.requestedGain,
        appliedGain: rec.analysis.piScale,
        overshoot: stepResponse.overshootPct,
        riseTime: stepResponse.riseTimeMs,
        settlingTime: stepResponse.settlingTimeMs,
        coherencePct: rec.analysis.meanCoherence * 100,
    };
}

/** Betaflight helpers the GyroCore qualification calls instead of re-implementing them. */
export const AUTOTUNE_MATH: AutotuneMath<AxisGains> = {
    computeSampleRate,
    chooseSegmentSize,
    extractCurrentSliders,
    buildGains,
};

async function applyGains(proposed: ProposedSliders, measurementId?: string | null) {
    // GyroCore hard gate, enforced here before any flight-controller access, not
    // only by the disabled button: the measurement must have passed every gate
    // and the sliders must be exactly the ones recommended for it.
    const measurement = assertApplyAuthorized(useChirpQualificationStore().report, measurementId, proposed);
    // Read the craft's live slider state (no write) and refuse if its sliders
    // do not drive the PIDs. This also keeps the slider fields the proposal
    // does not set at their live values in the write below.
    await MSP.promise(MSPCodes.MSP_SIMPLIFIED_TUNING);
    const live = liveSliderModeBlocks(FC.TUNING_SLIDERS.slider_pids_mode, measurement.axis);
    if (live.length) {
        throw new ApplyBlockedError(live);
    }

    // Object.keys widens to string[]; the keys are the proposal's own.
    for (const key of Object.keys(proposed) as (keyof ProposedSliders)[]) {
        if (key in FC.TUNING_SLIDERS) {
            FC.TUNING_SLIDERS[key] = proposed[key];
        }
    }

    await MSP.promise(MSPCodes.MSP_SET_SIMPLIFIED_TUNING, mspHelper.crunch(MSPCodes.MSP_SET_SIMPLIFIED_TUNING));
    await validateTuningSliders();
    if (!FC.TUNING_SLIDERS.slider_pids_valid || !FC.TUNING_SLIDERS.slider_dterm_valid) {
        throw new Error("Recommended autotune sliders did not pass firmware validation.");
    }
    await MSP.promise(MSPCodes.MSP_EEPROM_WRITE);
}
