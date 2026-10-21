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
 * GF-1 M4.1: encoded blackbox bytes -> Blackbox Viewer FlightLog -> M4.
 * SYNTHETIC logs only (the AIR65 run is air65_m4_bbl.local.test.ts).
 */

import { createApp, h } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
};

const picked = vi.hoisted(() => ({ bytes: new Uint8Array() as Uint8Array, name: "flight.bbl" }));
const msp = vi.hoisted(() => ({ calls: 0 }));

vi.mock("../../src/js/FileSystem", () => ({
    default: {
        pickOpenFile: async () => ({ name: picked.name }),
        readFileAsBlob: async () => ({ arrayBuffer: async () => picked.bytes.slice().buffer }),
    },
}));

vi.mock("../../src/js/localization", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/js/localization")>()),
    i18n: { getMessage: (key: string) => key },
}));

// Any flight-controller write would go through MSP; M4 must never reach it.
vi.mock("../../src/js/msp", () => ({
    default: new Proxy(
        {},
        {
            get: () => () => {
                msp.calls++;
            },
        },
    ),
}));

import UApp from "@nuxt/ui/components/App.vue";
import { analyzeM4BblFile } from "../../src/js/blackbox/m4_bbl_integration";
import { useM4FlightMetricsStore } from "../../src/gyrocore/stores/m4FlightMetrics";
import { useChirpQualificationStore } from "../../src/gyrocore/stores/chirpQualification";
import { useAutotuneStore } from "../../src/stores/autotune";
import M4FlightMetricsPanel from "../../src/gyrocore/components/M4FlightMetricsPanel.vue";
import { CHIRP_FLAG, encodeLog, type SyntheticFrame } from "./harness/bblWriter";
import { concatLogs, encodeChirpLog, simulateChirp } from "./harness/chirpSim";
import { readFixtureBytes } from "./harness/fixtures";

const FILTER_HEADERS = [
    "gyro_lpf1_static_hz:150",
    "gyro_lpf2_static_hz:300",
    "dterm_lpf1_static_hz:75",
    "dterm_lpf2_static_hz:150",
    "dyn_notch_count:2",
    "rpm_filter_harmonics:2",
    "motor_poles:12",
];
const D_FIELDS = ["axisD[0]", "axisD[1]", "axisD[2]"];
const ERPM_FIELDS = ["eRPM[0]", "eRPM[1]", "eRPM[2]", "eRPM[3]"];
const LOGGED_ERPM = 1500; // Betaflight logs eRPM / 100
const ARM_FLAG = 1; // flightModeFlags bit 0 = ARM box

/** 6 s of 1 kHz armed acro stick flight: square-wave sticks, first-order gyro lag, a D-like signal. */
function stickFrames(withD: boolean[] = [true, true, true], withErpm = true, rateScale = 1): SyntheticFrame[] {
    const n = 6000;
    const frames: SyntheticFrame[] = [];
    let y = 0;
    let prevY = 0;
    for (let i = 0; i < n; i++) {
        const sp = i % 400 < 200 ? 300 : -150;
        y = y * 0.85 + sp * 0.15;
        const d = Math.round(-(y - prevY) * 4);
        prevY = y;
        const extra: number[] = [];
        withD.forEach((on) => on && extra.push(d));
        if (withErpm) {
            extra.push(LOGGED_ERPM, LOGGED_ERPM + 10, LOGGED_ERPM - 10, LOGGED_ERPM + 20);
        }
        extra.push(1400); // rcCommand[3]: throttle up for the whole log
        frames.push({
            time: 1_000_000 + i * 1000,
            setpoint: [sp * rateScale, sp * rateScale, Math.round(sp / 3) * rateScale],
            gyro: [Math.round(y) * rateScale, Math.round(y) * rateScale, Math.round(y / 3) * rateScale],
            debug: [0, 0, 0, 0],
            motors: [1200, 1210, 1190, 1205],
            extra,
        });
    }
    return frames;
}

function stickLog(
    o: {
        withD?: boolean[];
        withErpm?: boolean;
        headers?: string[];
        flags?: number;
        debugMode?: number;
        rateScale?: number;
    } = {},
) {
    const withD = o.withD ?? [true, true, true];
    const withErpm = o.withErpm ?? true;
    return encodeLog(stickFrames(withD, withErpm, o.rateScale ?? 1), {
        iInterval: 32,
        flightModeFlags: o.flags ?? ARM_FLAG,
        debugMode: o.debugMode ?? 0,
        motorCount: 4,
        extraHeaders: o.headers ?? FILTER_HEADERS,
        extraFields: [...D_FIELDS.filter((_, i) => withD[i]), ...(withErpm ? ERPM_FIELDS : []), "rcCommand[3]"],
    });
}

let pinia = createPinia();
beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    msp.calls = 0;
});

describe("normal BBL import", () => {
    it("decodes with the Viewer and runs every M4 part on a stick-flight log", () => {
        const report = analyzeM4BblFile(stickLog(), "stick.bbl");
        expect(report.error).toBeNull();
        expect(report.decoder).toBe("betaflight-blackbox-viewer");
        expect(report.logCount).toBe(1);
        const log = report.logs[0];
        expect(log.error).toBeNull();
        expect(log.frameCount).toBe(6000);
        // 0.5 s take-off and landing trims; the rest is one acro stick segment.
        expect(log.segmentation!.stick).toEqual([{ start: 500, end: 5500 }]);
        expect(log.chirp.status).toBe("no_chirp");
        expect(log.signals.missing).toEqual(["axisF[0]", "axisF[1]", "axisF[2]"]);
        expect(log.signals.missingHeaders).toEqual([]);

        const r = log.result!;
        expect(r.sampleRateHz).toBeCloseTo(1000, 0);
        expect(r.meta.chirpActive).toBe(false);
        expect(r.feedforward.chirpRejectedForStickFf).toBe(false);
        expect(r.feedforward.executable).toBe(true);
        expect(r.feedforward.advice).toBe("measurement_only");
        expect(r.feedforward.optimalFeedforward).toBeNull();
        // Gyro lags the steps by a first-order filter: tracking is measurably imperfect.
        expect(r.feedforward.axes[0].meanAbsError.value).toBeGreaterThan(1);
        expect(r.feedforward.axes[0].trackingScore.value).toBeLessThan(100);

        expect(r.dTerm.missingDTerm).toBe(false);
        expect(r.dTerm.axes.map((a) => a.signalSource)).toEqual(["axis_d", "axis_d", "axis_d"]);
        expect(r.dTerm.axes[0].usableWindowCount).toBeGreaterThan(0);

        expect(r.meta).toMatchObject({
            gyroLpf1Hz: 150,
            gyroLpf2Hz: 300,
            dtermLpf1Hz: 75,
            dtermLpf2Hz: 150,
            dynNotchCount: 2,
            rpmFilterHarmonics: 2,
            motorPoles: 12,
        });
        // Upper median of equal-count 1490/1500/1510/1520 logged (x100 eRPM), 12-pole motors: Viewer's conversion.
        expect(r.filters.rpmFilter.estimatedFundamentalHz).toBeCloseTo((1510 * 200) / 60 / 12, 6);
        expect(r.filters.dynamicNotch.advice).toBe("blocked");
        expect(r.m2m3Safety).toMatchObject({
            applyAllowed: false,
            recommendationsEnabled: false,
            independentPidValidation: "BLOCKED",
        });
    });

    it("scales setpoint and gyro by the high-resolution factor like CHIRP extraction", () => {
        // High resolution logs deg/s x 10: the same flight logged x10 must measure the same.
        const lo = analyzeM4BblFile(stickLog(), "a.bbl").logs[0].result!;
        const hi = analyzeM4BblFile(
            stickLog({ headers: [...FILTER_HEADERS, "blackbox_high_resolution:1"], rateScale: 10 }),
            "b.bbl",
        ).logs[0].result!;
        expect(hi.feedforward.stickSegmentCount).toBe(1);
        expect(hi.feedforward.axes[0].meanAbsError.value).toBeCloseTo(lo.feedforward.axes[0].meanAbsError.value, 6);
    });
});

describe("CHIRP detection keeps stick feedforward blocked", () => {
    it("blocks FF on a CHIRP-mode log", () => {
        const report = analyzeM4BblFile(encodeChirpLog(simulateChirp({ seconds: 8, firmwareDebug: true })), "c.bbl");
        const log = report.logs[0];
        expect(log.chirp.status).toBe("chirp");
        expect(log.chirp.evidence).toEqual(expect.arrayContaining(["debug_mode_chirp", "boxchirp_flag_seen"]));
        expect(log.chirp.segmentCount).toBeGreaterThan(0);
        expect(log.result!.feedforward.chirpRejectedForStickFf).toBe(true);
        expect(log.result!.feedforward.advice).toBe("blocked");
        expect(log.result!.feedforward.optimalFeedforward).toBeNull();
    });

    it("treats a BOXCHIRP flag as CHIRP even when debug_mode is not DEBUG_CHIRP", () => {
        const log = analyzeM4BblFile(stickLog({ flags: ARM_FLAG | CHIRP_FLAG, debugMode: 0 }), "f.bbl").logs[0];
        expect(log.chirp.status).toBe("chirp");
        expect(log.chirp.evidence).toContain("boxchirp_flag_seen");
        // Every flight row is CHIRP: nothing is left for stick FF.
        expect(log.segmentation!.chirp.length).toBeGreaterThan(0);
        expect(log.segmentation!.stick).toEqual([]);
        expect(log.result!.feedforward.advice).toBe("blocked");
        expect(log.result!.feedforward.reason).toBe("no_valid_stick_segments");
        expect(log.result!.feedforward.chirpSamplesExcluded).toBe(true);
        expect(log.result!.feedforward.axes).toEqual([]);
    });

    it("debug_mode CHIRP without any BOXCHIRP row: log flagged CHIRP, stick rows still isolated", () => {
        // The generator runs only while BOXCHIRP is active; per-row flags prove it never did.
        const log = analyzeM4BblFile(stickLog({ debugMode: 96 }), "d.bbl").logs[0];
        expect(log.chirp.status).toBe("chirp");
        expect(log.chirp.evidence).toEqual(["debug_mode_chirp"]);
        expect(log.segmentation!.chirp).toEqual([]);
        expect(log.result!.feedforward.stickSource).toBe("isolated_segments");
        expect(log.result!.feedforward.chirpRejectedForStickFf).toBe(false);
        expect(log.result!.feedforward.advice).toBe("measurement_only");
    });

    it("judges every embedded log on its own", () => {
        const bytes = concatLogs(stickLog(), encodeChirpLog(simulateChirp({ seconds: 8, firmwareDebug: true })));
        const report = analyzeM4BblFile(bytes, "mixed.bbl");
        expect(report.logCount).toBe(2);
        expect(report.logs.map((l) => l.chirp.status)).toEqual(["no_chirp", "chirp"]);
        expect(report.logs[0].result!.feedforward.chirpRejectedForStickFf).toBe(false);
        expect(report.logs[1].result!.feedforward.chirpRejectedForStickFf).toBe(true);
    });
});

describe("missing channels are reported, never invented", () => {
    it("lists absent axisD / eRPM / filter headers and blocks what depends on them", () => {
        const log = analyzeM4BblFile(stickLog({ withD: [false, false, false], withErpm: false, headers: [] }), "m.bbl")
            .logs[0];
        expect(log.signals.missing).toEqual(expect.arrayContaining([...D_FIELDS, ...ERPM_FIELDS]));
        expect(log.signals.missingHeaders).toEqual([
            "gyro_lpf1_static_hz",
            "gyro_lpf2_static_hz",
            "dterm_lpf1_static_hz",
            "dterm_lpf2_static_hz",
            "dyn_notch_count",
            "rpm_filter_harmonics",
            "motor_poles",
        ]);
        const r = log.result!;
        expect(r.dTerm.missingDTerm).toBe(true);
        expect(r.dTerm.advice).toBe("blocked");
        expect(r.dTerm.axes.every((a) => a.signalSource === "missing")).toBe(true);
        expect(r.filters.rpmFilter.erpmPresent).toBe(false);
        expect(r.filters.rpmFilter.advice).toBe("blocked");
        expect(r.filters.rpmFilter.estimatedFundamentalHz).toBeNull();
        expect(r.filters.gyroLpf.configuredHz).toEqual({ lpf1: undefined, lpf2: undefined });
        expect(r.filters.dtermLpf.configuredHz).toEqual({ lpf1: undefined, lpf2: undefined });
        expect(r.meta.motorPoles).toBeUndefined();
    });

    it("passes an axis without its own axisD column as missing, not as zeros", () => {
        const r = analyzeM4BblFile(stickLog({ withD: [true, true, false] }), "y.bbl").logs[0];
        expect(r.signals.missing).toContain("axisD[2]");
        expect(r.result!.dTerm.axes.map((a) => a.signalSource)).toEqual(["axis_d", "axis_d", "missing"]);
    });

    it("gives no RPM frequency without motor_poles", () => {
        const headers = FILTER_HEADERS.filter((x) => !x.startsWith("motor_poles"));
        const r = analyzeM4BblFile(stickLog({ headers }), "p.bbl").logs[0];
        expect(r.signals.missingHeaders).toEqual(["motor_poles"]);
        expect(r.result!.filters.rpmFilter.erpmPresent).toBe(true);
        expect(r.result!.filters.rpmFilter.estimatedFundamentalHz).toBeNull();
        expect(r.result!.filters.rpmFilter.harmonicPeaksHz).toEqual([]);
        expect(r.result!.filters.rpmFilter.notes).toContain("motor_poles_missing_no_hz_estimate");
    });

    it("refuses a log without a required debug field and says which", () => {
        const report = analyzeM4BblFile(readFixtureBytes("chirp/bbl/malformed_missing_debug_field.bbl.gz"), "x.bbl");
        const log = report.logs[0];
        expect(log.result).toBeNull();
        expect(log.error).toMatch(/^missing_required_field:.*debug\[/);
        expect(log.signals.missing.some((s) => s.startsWith("debug["))).toBe(true);
        expect(log.chirp.status).toBe("unknown");
    });
});

describe("invalid BBL", () => {
    it.each([
        ["empty", new Uint8Array()],
        ["random bytes", Uint8Array.from({ length: 4096 }, (_, i) => (i * 2654435761) >>> 24)],
        ["text", new TextEncoder().encode("this is not a blackbox log\n".repeat(50))],
    ])("%s: file error, no logs, no throw", (_name, bytes) => {
        const report = analyzeM4BblFile(bytes, "bad.bbl");
        expect(report.error).toBe("no_logs_found");
        expect(report.logs).toEqual([]);
        expect(report.applyAllowed).toBe(false);
    });

    it("a truncated log is either analysed or reported, never thrown", () => {
        const full = stickLog();
        const report = analyzeM4BblFile(full.subarray(0, Math.floor(full.length / 3)), "cut.bbl");
        expect(report.logCount).toBe(1);
        const log = report.logs[0];
        expect(log.error !== null || log.result !== null).toBe(true);
        if (log.result) {
            expect(log.frameCount).toBeLessThan(6000);
        }
    });
});

describe("no automatic recommendations, CLI or Apply", () => {
    it("the report carries no CLI and no enabled recommendation anywhere", () => {
        const report = analyzeM4BblFile(stickLog(), "stick.bbl");
        expect(report.cliOutput).toBeNull();
        expect(report.recommendationsEnabled).toBe(false);
        const json = JSON.stringify(report, (_k, v) => (ArrayBuffer.isView(v) ? undefined : v));
        expect(json).not.toMatch(/"set [a-z_]+ ?=/);
        expect(json).not.toMatch(/"(applyAllowed|recommendationsEnabled)":true/);
        for (const c of report.logs[0].result!.filters.informationalCandidates) {
            expect(c.reason).toContain("not_a_cli");
        }
    });

    it("the store import leaves Autotune, the CHIRP gate and MSP untouched", async () => {
        picked.bytes = stickLog();
        const autotune = useAutotuneStore();
        const gate = useChirpQualificationStore();
        const m4 = useM4FlightMetricsStore();
        await m4.importAndAnalyze();
        expect(m4.state).toBe("done");
        expect(m4.report!.filename).toBe("flight.bbl");
        expect(autotune.analysisResult).toBeNull();
        expect(autotune.analysisState).toBe("idle");
        expect(gate.report).toBeNull();
        expect(msp.calls).toBe(0);
    });

    it("the store reports an invalid file as an error state", async () => {
        picked.bytes = new TextEncoder().encode("garbage");
        const m4 = useM4FlightMetricsStore();
        await m4.importAndAnalyze();
        expect(m4.state).toBe("error");
        expect(m4.errorMessage).toBe("no_logs_found");
    });
});

describe("M4 panel", () => {
    async function mountPanel() {
        const container = document.createElement("div");
        document.body.appendChild(container);
        const app = createApp({ render: () => h(UApp, { portal: false }, { default: () => h(M4FlightMetricsPanel) }) });
        app.config.globalProperties.$t = ((key: string) => key) as never;
        app.use(pinia);
        app.mount(container);
        await new Promise((r) => setTimeout(r, 0));
        return { container, unmount: () => (app.unmount(), container.remove()) };
    }

    it("shows CHIRP block, missing signals and safety, with no Apply / CLI control", async () => {
        const bytes = concatLogs(
            stickLog({ withD: [true, true, false] }),
            encodeChirpLog(simulateChirp({ seconds: 8, firmwareDebug: true })),
        );
        useM4FlightMetricsStore().analyzeBytes(bytes, "mixed.bbl");
        const { container, unmount } = await mountPanel();

        const logs = container.querySelectorAll("[data-m4-log]");
        expect(logs).toHaveLength(2);
        expect(logs[0].querySelector('[data-gyrocore="m4-chirp"]')!.getAttribute("data-status")).toBe("no_chirp");
        expect(logs[0].querySelector('[data-gyrocore="m4-ff-chirp-blocked"]')).toBeNull();
        expect(logs[0].querySelector('[data-gyrocore="m4-missing-signals"]')!.textContent).toContain("axisD[2]");
        expect(logs[0].querySelector('[data-d-source="missing"]')).not.toBeNull();
        expect(logs[1].querySelector('[data-gyrocore="m4-chirp"]')!.getAttribute("data-status")).toBe("chirp");
        expect(logs[1].querySelector('[data-gyrocore="m4-ff-chirp-blocked"]')).not.toBeNull();
        expect(logs[1].querySelector('[data-gyrocore="m4-ff"]')!.getAttribute("data-advice")).toBe("blocked");
        expect(container.querySelector('[data-gyrocore="m4-no-apply"]')).not.toBeNull();
        for (const s of container.querySelectorAll('[data-gyrocore="m4-safety"]')) {
            expect(s.textContent).toMatch(/Apply: disabled/);
            expect(s.textContent).toMatch(/BLOCKED/);
        }

        const buttons = [...container.querySelectorAll("button")].filter((b) => !b.closest('[role="button"]'));
        const labels = buttons.map((b) => b.textContent?.trim());
        expect(labels.filter((l) => l && /apply|cli|copy|save|write/i.test(l))).toEqual([]);
        expect(container.querySelector('[data-gyrocore="m4-open"]')).not.toBeNull();
        unmount();
    });

    it("shows a file-level error", async () => {
        useM4FlightMetricsStore().analyzeBytes(new Uint8Array(), "empty.bbl");
        const { container, unmount } = await mountPanel();
        expect(container.querySelector('[data-gyrocore="m4-error"]')!.textContent).toContain("no_logs_found");
        unmount();
    });
});
