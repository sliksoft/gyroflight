/*
 * This file is part of Gyroflight, a derivative of the Betaflight App.
 *
 * Gyroflight is free software. You can redistribute this software
 * and/or modify this software under the terms of the GNU General
 * Public License as published by the Free Software Foundation,
 * either version 3 of the License, or (at your option) any later
 * version.
 *
 * Gyroflight is distributed in the hope that it will be useful,
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

/*
 * WU2: Autotune's CHIRP input path. The app decodes with the Blackbox Viewer
 * (not Autotune's own chirp_bbl_parser, which mis-decodes predicted fields),
 * analyses every embedded log and every segment, and only lets Betaflight
 * recommend gains for a measurement GyroCore qualified.
 */

import { createApp, h } from "vue";
import { createPinia, getActivePinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
};

const picked = vi.hoisted(() => ({ bytes: new Uint8Array() as Uint8Array, name: "test.bbl" }));
const autotuneParser = vi.hoisted(() => ({ calls: 0 }));

vi.mock("../../src/js/FileSystem", () => ({
    default: {
        pickOpenFile: async () => ({ name: picked.name }),
        readFileAsBlob: async () => ({ arrayBuffer: async () => picked.bytes.slice().buffer }),
    },
}));

vi.mock("../../src/js/localization", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/js/localization")>()),
    i18n: { getMessage: (key: string, args?: string[]) => (args?.length ? `${key}|${args.join("|")}` : key) },
}));

// Autotune's duplicate decoder must not be on the app's path at all.
vi.mock("../../src/js/blackbox/chirp_bbl_parser", async (importOriginal) => {
    const real = await importOriginal<typeof import("../../src/js/blackbox/chirp_bbl_parser")>();
    return {
        ...real,
        findLogBoundaries: (...args: Parameters<typeof real.findLogBoundaries>) => {
            autotuneParser.calls++;
            return real.findLogBoundaries(...args);
        },
        parseChirpLog: (...args: Parameters<typeof real.parseChirpLog>) => {
            autotuneParser.calls++;
            return real.parseChirpLog(...args);
        },
    };
});

import UApp from "@nuxt/ui/components/App.vue";
import { findLogBoundaries, parseChirpLog } from "../../src/js/blackbox/chirp_bbl_parser";
import { FlightLog } from "../../src/blackbox-viewer/flightlog.js";
import { AUTOTUNE_MATH, useAutotune } from "../../src/composables/useAutotune";
import { useAutotuneStore } from "../../src/stores/autotune";
import { PHASE_MARGIN_PRESETS } from "../../src/js/blackbox/spectral_analysis";
import ChirpQualificationPanel from "../../src/gyrocore/components/ChirpQualificationPanel.vue";
import { chirpFramesFromFlightLog, extractChirp, type FlightLogFrames } from "../../src/gyrocore/chirp/extraction";
import { parseLoggedHeaders, readHeaderPairs } from "../../src/gyrocore/chirp/headers";
import { qualifyChirpFile, recomputeRecommendations } from "../../src/gyrocore/chirp/qualification";
import { useChirpQualificationStore } from "../../src/gyrocore/stores/chirpQualification";
import { CHIRP_FLAG, encodeLog, type SyntheticFrame } from "./harness/bblWriter";
import { concatLogs, encodeChirpLog, simulateChirp } from "./harness/chirpSim";
import { readFixtureBytes } from "./harness/fixtures";
import { MERGE_E2E_CASES } from "./harness/mergeE2eCases";

async function runImport(bytes: Uint8Array, name = "test.bbl") {
    picked.bytes = bytes;
    picked.name = name;
    await useAutotune().importAndAnalyze();
    return { store: useAutotuneStore(), gate: useChirpQualificationStore() };
}

beforeEach(() => {
    setActivePinia(createPinia());
    autotuneParser.calls = 0;
});

describe("the CHIRP input is the Blackbox Viewer decode", () => {
    // A curving gyro trace with an I-frame every 4 frames: Autotune's own parser
    // mis-decodes it from the first P-frame after the second I-frame.
    const frames: SyntheticFrame[] = Array.from({ length: 24 }, (_, n) => ({
        time: 1_000_000 + n * 1000,
        setpoint: [100 + n, 0, 0],
        gyro: [10 * n * n, 0 - 7 * n * n, 3 * n],
        debug: [0, 0, 0, 0],
    }));
    const bytes = encodeLog(frames, { iInterval: 4, flightModeFlags: CHIRP_FLAG });

    it("extracted gyro samples equal what the firmware logged", () => {
        const flightLog = new FlightLog(bytes) as unknown as FlightLogFrames & { openLog(i: number): boolean };
        expect(flightLog.openLog(0)).toBe(true);
        const headers = parseLoggedHeaders(readHeaderPairs(bytes, 0, bytes.length));
        const extraction = extractChirp(chirpFramesFromFlightLog(flightLog), headers);
        expect(extraction.errors).toEqual([]);
        expect(Array.from(extraction.gyro[0])).toEqual(frames.map((f) => f.gyro[0]));
        expect(Array.from(extraction.gyro[1])).toEqual(frames.map((f) => f.gyro[1]));
        expect(Array.from(extraction.setpoint[0])).toEqual(frames.map((f) => f.setpoint[0]));
    });

    it("differs from Autotune's own (buggy) decode of the same bytes", () => {
        const [b] = findLogBoundaries(bytes);
        const { chirpData } = parseChirpLog(bytes, b.start, b.end, "1.49.0");
        expect(Array.from(chirpData.gyro[0])).not.toEqual(frames.map((f) => f.gyro[0]));
    });

    it("importAndAnalyze never calls Autotune's duplicate decoder", async () => {
        const { store, gate } = await runImport(encodeChirpLog(simulateChirp()));
        expect(store.analysisState).toBe("done");
        expect(gate.report?.decoder).toBe("betaflight-blackbox-viewer");
        expect(autotuneParser.calls).toBe(0);
    });
});

describe("every embedded log and every segment is analysed", () => {
    const rollLog = encodeChirpLog(simulateChirp({ axis: 0, seconds: 8 }));
    const pitchLog = encodeChirpLog(simulateChirp({ axis: 1, seconds: 8, startTimeUs: 30_000_000 }));
    const rollAgain = encodeChirpLog(simulateChirp({ axis: 0, seconds: 8, startTimeUs: 60_000_000 }));

    it("multi-log: measurements keep their log index, axis, times, samples and source", () => {
        const report = qualifyChirpFile(concatLogs(rollLog, pitchLog, rollAgain), "multi.bbl", 60, AUTOTUNE_MATH);
        expect(report.logCount).toBe(3);
        expect(report.logs.map((l) => l.error)).toEqual([null, null, null]);
        expect(report.measurements.map((m) => [m.id, m.logIndex, m.axisName, m.sampleCount])).toEqual([
            ["log1-seg1", 0, "roll", 8000],
            ["log2-seg1", 1, "pitch", 8000],
            ["log3-seg1", 2, "roll", 8000],
        ]);
        const [, pitch, roll3] = report.measurements;
        expect(pitch.startTimeUs).toBe(30_000_000);
        expect(roll3.startTimeUs).toBe(60_000_000);
        expect(roll3.endTimeUs).toBe(60_000_000 + 7999 * 1000);
        expect(roll3.durationS).toBeCloseTo(7.999, 9);
        expect(report.logs.map((l) => l.firmwareRevision)).toEqual(
            Array(3).fill("Betaflight 2026.6.2 (synthetic) STM32F7X2"),
        );
        for (const m of report.measurements) {
            expect(m.state).toBe("usable");
            expect(m.apply.allowed).toBe(true);
        }
    });

    it("a later sweep on the same axis does not overwrite an earlier one", async () => {
        const { store, gate } = await runImport(concatLogs(rollLog, pitchLog, rollAgain));
        const roll = gate.report!.measurements.filter((m) => m.axisName === "roll");
        expect(roll.map((m) => m.id)).toEqual(["log1-seg1", "log3-seg1"]);
        // One log is shown at a time; both roll sweeps stay listed and selectable.
        expect(gate.selectedLogIndex).toBe(0);
        expect(Object.keys(store.analysisResult!.axes)).toEqual(["roll"]);
        gate.selectMeasurement("log3-seg1");
        expect(gate.selectedLogIndex).toBe(2);
        expect(gate.selection.roll).toBe("log3-seg1");
        expect(store.analysisResult!.axes.roll!.sampleCount).toBe(8000);
        gate.selectMeasurement("log2-seg1");
        expect(Object.keys(store.analysisResult!.axes)).toEqual(["pitch"]);
        expect(gate.report!.measurements).toHaveLength(3);
    });
});

describe("Autotune states", () => {
    it("NO CHIRP: no sweep in any log", async () => {
        const bytes = readFixtureBytes("decode/mode_events.bbl.gz");
        const { store, gate } = await runImport(bytes);
        expect(gate.report?.state).toBe("no_chirp");
        expect(store.analysisState).toBe("error");
        expect(store.errorMessage).toContain("gyrocoreChirpNoChirpError");
        expect(store.analysisResult).toBeNull();
    });

    it("REJECTED: CHIRP exists, diagnostics shown, no gains, never called 'no CHIRP'", async () => {
        const { store, gate } = await runImport(readFixtureBytes("chirp/bbl/poor_coherence.bbl.gz"));
        expect(gate.report?.state).toBe("rejected");
        expect(store.analysisState).toBe("done");
        const roll = store.analysisResult!.axes.roll!;
        expect(roll.transferFunction.coherence.length).toBeGreaterThan(0);
        expect(roll.gains).toBeNull();
        expect(store.errorMessage).toBe("");
    });

    it("REJECTED without anything plottable is still not 'no CHIRP'", async () => {
        const { store, gate } = await runImport(readFixtureBytes("chirp/bbl/insufficient_samples.bbl.gz"));
        expect(gate.report?.state).toBe("rejected");
        expect(store.analysisState).toBe("error");
        expect(store.errorMessage).toBe("gyrocoreChirpRejectedError");
    });

    it("USABLE WITH WARNINGS", async () => {
        const { gate } = await runImport(readFixtureBytes("chirp/bbl/chirp_near_nyquist.bbl.gz"));
        expect(gate.report?.state).toBe("usable_with_warnings");
    });

    it("USABLE: Betaflight's recommendation is shown for a qualified measurement", async () => {
        const { store, gate } = await runImport(encodeChirpLog(simulateChirp()));
        expect(gate.report?.state).toBe("usable");
        expect(store.analysisResult!.axes.roll!.gains?.proposed.slider_pi_gain).toBeGreaterThan(100);
    });
});

describe("a recommendation requires a usable measurement", () => {
    it("rejected measurements get no recommendation, at any phase-margin target", () => {
        const report = qualifyChirpFile(
            readFixtureBytes("chirp/bbl/weak_excitation.bbl.gz"),
            "weak.bbl",
            60,
            AUTOTUNE_MATH,
        );
        for (const target of Object.values(PHASE_MARGIN_PRESETS)) {
            recomputeRecommendations(report, target, AUTOTUNE_MATH);
            expect(report.measurements[0].recommendation).toBeNull();
            expect(report.measurements[0].apply.blocked).toContain("recommendation:not_produced");
        }
    });

    it("recomputing for a new target updates the shown gains and the authorization", async () => {
        const { store, gate } = await runImport(encodeChirpLog(simulateChirp({ crossoverHz: 40, delaySamples: 2 })));
        const before = store.analysisResult!.axes.roll!.gains!.proposed.slider_pi_gain;
        useAutotune().recomputeGains(PHASE_MARGIN_PRESETS.CONSERVATIVE);
        const after = store.analysisResult!.axes.roll!.gains!.proposed;
        expect(after.slider_pi_gain).toBeLessThan(before);
        expect(gate.report!.measurements[0].recommendation!.result.proposed).toEqual(after);
        expect(gate.report!.targetPhaseMarginDeg).toBe(PHASE_MARGIN_PRESETS.CONSERVATIVE);
    });
});

describe("diagnostic-only banner on the Autotune tab", () => {
    async function mountTab() {
        const { default: AutotuneTab } = await import("../../src/components/tabs/AutotuneTab.vue");
        const container = document.createElement("div");
        document.body.appendChild(container);
        const app = createApp({ render: () => h(UApp, { portal: false }, { default: () => h(AutotuneTab) }) });
        app.config.globalProperties.$t = ((key: string) => key) as never;
        app.use(getActivePinia()!);
        app.mount(container);
        await new Promise((r) => setTimeout(r, 0));
        return { container, unmount: () => (app.unmount(), container.remove()) };
    }

    it("labels rejected plots outside the collapsible panel, directly above the Bode plot", async () => {
        await runImport(readFixtureBytes("chirp/bbl/poor_coherence.bbl.gz"));
        const { container, unmount } = await mountTab();
        const banner = container.querySelector('[data-gyrocore="diagnostic-banner"]');
        expect(banner?.textContent).toContain("gyrocoreChirpDiagnosticBanner");
        expect(banner?.closest('[data-gyrocore="chirp-qualification"]')).toBeNull();
        // The next element is Betaflight's Bode plot box.
        expect(banner?.nextElementSibling?.textContent).toContain("autotuneBodePlotTitle");
        unmount();
    });

    it("is absent when every plotted measurement is qualified", async () => {
        await runImport(encodeChirpLog(simulateChirp()));
        const { container, unmount } = await mountTab();
        expect(container.textContent).toContain("autotuneBodePlotTitle");
        expect(container.querySelector('[data-gyrocore="diagnostic-banner"]')).toBeNull();
        unmount();
    });
});

describe("global tune panel (WU3)", () => {
    async function mountGlobal() {
        const { default: GlobalTunePanel } = await import("../../src/gyrocore/components/GlobalTunePanel.vue");
        const container = document.createElement("div");
        document.body.appendChild(container);
        const app = createApp({ render: () => h(UApp, { portal: false }, { default: () => h(GlobalTunePanel) }) });
        app.config.globalProperties.$t = ((key: string) => key) as never;
        app.use(getActivePinia()!);
        app.mount(container);
        await new Promise((r) => setTimeout(r, 0));
        return { container, unmount: () => (app.unmount(), container.remove()) };
    }

    it("shows sources, current, per-axis evidence and the one global value", async () => {
        await runImport(MERGE_E2E_CASES.three_axis_agree());
        const { container, unmount } = await mountGlobal();
        expect(container.textContent).toContain("gyrocoreGlobalIntro");
        expect(container.querySelector('[data-gyrocore="global-status"]')?.getAttribute("data-authorized")).toBe("yes");
        const pi = container.querySelector('[data-slider="slider_pi_gain"]')!;
        const cells = [...pi.querySelectorAll("td")].map((td) => td.textContent?.trim());
        expect(cells[1]).toBe("100");
        expect(cells.slice(2, 5).map((c) => c?.split(" ")[0])).toEqual(["138", "138", "138"]);
        expect(pi.querySelector('[data-gyrocore="final"]')?.textContent?.trim()).toBe("138");
        expect(container.querySelectorAll('[data-role="participating"]')).toHaveLength(3);
        expect(container.querySelector('[data-gyrocore="global-blocked"]')).toBeNull();
        unmount();
    });

    it("explains a conflict and offers no global value", async () => {
        await runImport(MERGE_E2E_CASES.roll_pitch_conflict());
        const { container, unmount } = await mountGlobal();
        expect(container.querySelector('[data-gyrocore="global-status"]')?.getAttribute("data-authorized")).toBe("no");
        expect(
            container.querySelector('[data-slider="slider_pi_gain"] [data-gyrocore="final"]')?.textContent?.trim(),
        ).toBe("--");
        expect(
            container.querySelector(
                '[data-gyrocore="global-blocked"] [data-reason="slider_disagreement:slider_pi_gain"]',
            ),
        ).not.toBeNull();
        unmount();
    });
});

describe("qualification panel", () => {
    function mountPanel() {
        const pinia = createPinia();
        setActivePinia(pinia);
        const container = document.createElement("div");
        document.body.appendChild(container);
        const app = createApp({
            render: () => h(UApp, { portal: false }, { default: () => h(ChirpQualificationPanel) }),
        });
        app.config.globalProperties.$t = ((key: string, args?: unknown[]) =>
            args ? `${key}|${args.join("|")}` : key) as never;
        app.use(pinia);
        return { app, container, pinia };
    }

    it("labels a rejected measurement REJECTED and its plots diagnostic only", async () => {
        const { app, container } = mountPanel();
        await runImport(readFixtureBytes("chirp/bbl/poor_coherence.bbl.gz"));
        app.mount(container);
        await new Promise((r) => setTimeout(r, 0));
        const overall = container.querySelector('[data-gyrocore="overall-state"]');
        expect(overall?.textContent).toContain("gyrocoreChirpStateRejected");
        expect(container.textContent).not.toContain("gyrocoreChirpStateNoChirp");
        expect(container.querySelector('[data-gyrocore="diagnostic-only"]')?.textContent).toContain(
            "gyrocoreChirpDiagnosticAxes",
        );
        const row = container.querySelector('[data-measurement="log1-seg1"]');
        expect(row?.getAttribute("data-state")).toBe("rejected");
        expect(row?.getAttribute("data-apply")).toBe("blocked");
        expect(row?.querySelector('[data-reason="measurement:low_coherence"]')).not.toBeNull();
        app.unmount();
        container.remove();
    });

    it("shows NO CHIRP when no log has a sweep", async () => {
        const { app, container } = mountPanel();
        await runImport(readFixtureBytes("decode/mode_events.bbl.gz"));
        app.mount(container);
        await new Promise((r) => setTimeout(r, 0));
        expect(container.querySelector('[data-gyrocore="overall-state"]')?.textContent).toContain(
            "gyrocoreChirpStateNoChirp",
        );
        expect(container.querySelector('[data-gyrocore="measurements"]')).toBeNull();
        app.unmount();
        container.remove();
    });
});
