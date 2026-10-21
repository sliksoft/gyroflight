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
 * The tune workflow (tuneWorkflow.ts + TuneWorkflowPanel.vue): what each tuning part
 * really has, the comparison, and that the panel writes only after the user confirmed
 * the full change, shows a failed write as a failure, and restores only this craft's
 * backups. Apply/Restore themselves are mocked here (tune_apply_route.test.ts tests them).
 */

import { createApp, h } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    applyGains: vi.fn(),
    restoreTune: vi.fn(),
    showYesNo: vi.fn(),
    connected: true,
    virtual: false,
}));

vi.mock("@/composables/useAutotune", () => ({
    useAutotune: () => ({ applyGains: mocks.applyGains, recomputeGains: vi.fn(), importAndAnalyze: vi.fn() }),
}));
vi.mock("@/composables/useTuneApply", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/composables/useTuneApply")>()),
    restoreTune: mocks.restoreTune,
}));
vi.mock("@/composables/useDialog", () => ({ useDialog: () => ({ showYesNo: mocks.showYesNo }) }));
vi.mock("@/stores/connection", () => ({
    useConnectionStore: () => ({ connectionValid: mocks.connected, virtualMode: mocks.virtual }),
}));
vi.mock("@/js/localization", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/js/localization")>()),
    i18n: { getMessage: (key: string, args?: string[]) => (args?.length ? `${key}|${args.join("|")}` : key) },
}));

import UApp from "@nuxt/ui/components/App.vue";
import TuneWorkflowPanel from "../../src/gyrocore/components/TuneWorkflowPanel.vue";
import { useChirpQualificationStore } from "../../src/gyrocore/stores/chirpQualification";
import { useM4FlightMetricsStore } from "../../src/gyrocore/stores/m4FlightMetrics";
import { compareRows, tuneParts } from "../../src/gyrocore/tuning/tuneWorkflow";
import { qualifiedReportFor } from "./harness/qualifiedReport";
import type { M4BblReport } from "../../src/js/blackbox/m4_bbl_integration";

const PROPOSED = {
    slider_master_multiplier: 100,
    slider_pi_gain: 110,
    slider_i_gain: 100,
    slider_d_gain: 105,
    slider_feedforward_gain: 100,
    slider_dterm_filter_multiplier: 100,
};

/** The AIR65 BBL18 M4.2 result, reduced to what the workflow reads. */
const AIR65_M4 = {
    filename: "BTFL_BLACKBOX_LOG_AIR65_C_20261018_231421_BETAFPVG473.BBL",
    error: null,
    logs: [
        {
            logIndex: 0,
            error: null,
            result: {
                feedforward: {
                    stickSource: "isolated_segments",
                    stickDurationS: 0,
                    advice: "blocked",
                    reason: "no_valid_stick_segments",
                },
                dTerm: { advice: "not_advised" },
                filters: {
                    gyroLpf: {
                        configuredHz: { lpf1: 150, lpf2: 300 },
                        measurement: { reliability: "high", peaksReported: true },
                        spectrum: [
                            { axis: "roll", peaks: [] },
                            { axis: "pitch", peaks: [{ frequencyHz: 31.5, prominenceDb: 9.2 }] },
                            { axis: "yaw", peaks: [] },
                        ],
                        notes: [],
                    },
                    dtermLpf: { configuredHz: { lpf1: 75, lpf2: 150 }, notes: [] },
                    rpmFilter: { estimatedFundamentalHz: 443.3 },
                },
            },
        },
    ],
} as unknown as M4BblReport;

const button = (c: Element) => c.querySelector('[data-gyrocore="workflow-apply"]') as HTMLButtonElement;

let unmount: (() => void) | null = null;
function mount() {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const app = createApp({ render: () => h(UApp, { portal: false }, { default: () => h(TuneWorkflowPanel) }) });
    app.config.globalProperties.$t = ((key: string) => key) as never;
    app.use(getPinia());
    app.mount(container);
    unmount = () => (app.unmount(), container.remove());
    return container;
}
let pinia: ReturnType<typeof createPinia>;
const getPinia = () => pinia;
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    localStorage.clear();
    mocks.applyGains.mockReset();
    mocks.restoreTune.mockReset();
    mocks.showYesNo.mockReset();
    mocks.connected = true;
    mocks.virtual = false;
});
afterEach(() => unmount?.());

describe("what each tuning part has (pure)", () => {
    it("PID is blocked by the phase-margin gate and the release conditions; nothing else is calculated", () => {
        useChirpQualificationStore().setReport(qualifiedReportFor(PROPOSED, ["phase_margin_not_validated"]));
        const c = useChirpQualificationStore().composite!;
        const parts = tuneParts({
            composite: c,
            safety: null,
            releaseBlocks: ["independent_pid_validation_missing"],
            m4: AIR65_M4,
        });
        const by = Object.fromEntries(parts.map((p) => [p.key, p]));
        expect(by.pid.state).toBe("BLOCKED");
        expect(by.pid.missing).toEqual(
            expect.arrayContaining(["phase_margin_not_validated", "independent_pid_validation_missing"]),
        );
        expect(by.feedforward).toMatchObject({ state: "BLOCKED", proposal: null });
        expect(by.feedforward.missing).toContain("no_valid_stick_segments");
        expect(by.gyro_filters).toMatchObject({ state: "PARTIAL", proposal: null });
        expect(by.dterm_filters.evidence).toContain("m5b_dynamic_dterm_model_offline");
        expect(by.rpm_dynamic_notch.missing).toEqual(
            expect.arrayContaining(["dyn_notch_centres_unknown", "rpm_filter_schedule_unknown"]),
        );
        expect(by.resonances.evidence).toEqual(["pitch:31.5Hz+9.2dB"]);
        expect(parts.filter((p) => p.key !== "pid").every((p) => p.proposal === null)).toBe(true);
        expect(parts.some((p) => p.state === "VALIDATED")).toBe(false);
    });

    it("without flight metrics FF and filters say so instead of guessing", () => {
        const parts = tuneParts({ composite: null, safety: null, releaseBlocks: [], m4: null });
        expect(parts.map((p) => p.state)).toEqual(["BLOCKED", "BLOCKED", "BLOCKED", "BLOCKED", "BLOCKED", "BLOCKED"]);
        expect(parts[0].missing).toEqual(["no_qualified_chirp_composite"]);
        expect(parts[1].missing).toEqual(["m4_flight_metrics_not_analysed"]);
    });

    it("compares current against proposed; PIDs come from the FC when sliders change", () => {
        useChirpQualificationStore().setReport(qualifiedReportFor(PROPOSED, []));
        const c = useChirpQualificationStore().composite!;
        const headers = useChirpQualificationStore().report!.logs[0].headerPairs!;
        const rows = compareRows(c, headers);
        const row = (k: string) => rows.find((r) => `${r.group}:${r.key}` === k)!;
        expect(row("slider:slider_pi_gain")).toMatchObject({ current: 100, proposed: 110, changed: true });
        expect(row("slider:slider_i_gain")).toMatchObject({ current: 100, proposed: 100, changed: false });
        expect(row("pid:roll:P")).toMatchObject({ current: 45, proposed: "fc", changed: true });
        expect(row("filter:dterm_lpf1_static_hz")).toMatchObject({ current: 75, proposed: "same", changed: false });
    });
});

describe("the panel", () => {
    function seed(blocked: string[] = []) {
        useChirpQualificationStore().setReport(qualifiedReportFor(PROPOSED, blocked));
        useM4FlightMetricsStore().report = AIR65_M4;
    }

    it("in production the release conditions keep Apply disabled, and say which", async () => {
        seed();
        const c = mount();
        await flush();
        expect(c.querySelector('[data-part="pid"]')?.getAttribute("data-state")).toBe("BLOCKED");
        const release = c.querySelector('[data-check="release"]')!;
        expect(release.getAttribute("data-ok")).toBe("no");
        expect(release.textContent).toContain("full_safety_engine_pending");
        expect(release.textContent).toContain("independent_pid_validation_missing");
        expect(button(c).disabled).toBe(true);
        button(c).click();
        await flush();
        expect(mocks.showYesNo).not.toHaveBeenCalled();
        expect(mocks.applyGains).not.toHaveBeenCalled();
    });
});

describe("the panel with every gate released (test harnesses)", () => {
    beforeEach(async () => {
        vi.resetModules();
    });

    async function mountReleased(blocked: string[] = []) {
        vi.doMock("@/gyrocore/productLock/productApply", async () =>
            (await import("./harness/productRelease")).releasedProductApply(),
        );
        vi.doMock("@/gyrocore/safety/authorize", async () =>
            (await import("./harness/safetyRelease")).releasedSafety(),
        );
        const { default: Panel } = await import("../../src/gyrocore/components/TuneWorkflowPanel.vue");
        const { useChirpQualificationStore: gateStore } = await import("../../src/gyrocore/stores/chirpQualification");
        const { useFlightControllerStore: fcStore } = await import("../../src/stores/fc");
        const { useTuneBackupStore: backups } = await import("../../src/gyrocore/stores/tuneBackup");
        const { default: App } = await import("@nuxt/ui/components/App.vue");
        const { createPinia: cp, setActivePinia: sp } = await import("pinia");
        pinia = cp();
        sp(pinia);
        gateStore().setReport(qualifiedReportFor(PROPOSED, blocked));
        fcStore().config.uid = [1, 2, 3];
        const container = document.createElement("div");
        document.body.appendChild(container);
        const app = createApp({ render: () => h(App, { portal: false }, { default: () => h(Panel) }) });
        app.config.globalProperties.$t = ((key: string) => key) as never;
        app.use(pinia);
        app.mount(container);
        unmount = () => (app.unmount(), container.remove());
        await flush();
        // Error classes from the same (reset) module graph the panel uses, so instanceof holds.
        const { TuneWriteError: WriteError } = await import("../../src/composables/useTuneApply");
        const { ApplyBlockedError: Blocked } = await import("../../src/gyrocore/chirp/applyGate");
        return { c: container, backups: backups(), WriteError, Blocked };
    }

    it("Apply opens the full comparison; declining writes nothing", async () => {
        mocks.showYesNo.mockResolvedValue(false);
        const { c } = await mountReleased();
        expect(button(c).disabled).toBe(false);
        button(c).click();
        await flush();
        expect(mocks.showYesNo).toHaveBeenCalledTimes(1);
        const text = mocks.showYesNo.mock.calls[0][1] as string;
        expect(text).toContain('data-row="slider:slider_pi_gain"');
        expect(text).toContain('data-row="pid:yaw:D"');
        expect(text).toContain("gyroflightApplyProcedure");
        expect(mocks.applyGains).not.toHaveBeenCalled();
    });

    it("confirming applies exactly the composite with a fresh token and shows the verified read-back", async () => {
        mocks.showYesNo.mockResolvedValue(true);
        const snap = {
            sliders: { slider_pi_gain: 110 },
            filters: { dterm_lowpass_hz: 75 },
            pids: [
                [50, 88, 32],
                [52, 92, 36],
                [50, 88, 0],
            ],
            advanced: {},
        };
        mocks.applyGains.mockResolvedValue({ status: "verified", backupId: "bk-1", expected: snap, readback: snap });
        const { c } = await mountReleased();
        button(c).click();
        await flush();
        await flush();
        expect(mocks.applyGains).toHaveBeenCalledTimes(1);
        const [sliders, id, token] = mocks.applyGains.mock.calls[0];
        expect(sliders).toEqual(PROPOSED);
        expect(id).toMatch(/^composite-log1-/);
        expect(token).toMatch(/^[0-9a-f]{32}$/);
        const verified = c.querySelector('[data-gyrocore="workflow-verified"]')!;
        expect(verified.querySelector('[data-verify="roll:P"]')?.textContent).toContain("50");
        expect(c.querySelector('[data-gyrocore="workflow-failed"]')).toBeNull();
    });

    it("a failed write is shown as a failure with what was saved, never as verified", async () => {
        mocks.showYesNo.mockResolvedValue(true);
        const { c, WriteError } = await mountReleased();
        mocks.applyGains.mockRejectedValue(
            new WriteError("verify", "no", "bk-2", "mismatch", ["pid:roll:P expected 50 read 51"]),
        );
        button(c).click();
        await flush();
        await flush();
        const failed = c.querySelector('[data-gyrocore="workflow-failed"]')!;
        expect(failed.getAttribute("data-status")).toBe("failed");
        expect(failed.querySelector('[data-gyrocore="workflow-saved"]')?.getAttribute("data-saved")).toBe("no");
        expect(failed.textContent).toContain("pid:roll:P expected 50 read 51");
        expect(c.querySelector('[data-gyrocore="workflow-verified"]')).toBeNull();
    });

    it("a blocked Apply lists the reasons and claims nothing was written", async () => {
        mocks.showYesNo.mockResolvedValue(true);
        const { c, Blocked } = await mountReleased();
        mocks.applyGains.mockRejectedValue(new Blocked(["fc:identity_uid_mismatch"]));
        button(c).click();
        await flush();
        await flush();
        const failed = c.querySelector('[data-gyrocore="workflow-failed"]')!;
        expect(failed.getAttribute("data-status")).toBe("blocked");
        expect(failed.textContent).toContain("fc:identity_uid_mismatch");
    });

    it("lists only this craft's backups and restores after confirmation", async () => {
        const { c, backups } = await mountReleased();
        const snapshot = { sliders: {}, filters: {}, pids: [], advanced: {} };
        const base = {
            createdAt: "2026-10-21T20:00:00.000Z",
            reason: "before_apply" as const,
            board: "B",
            firmware: "2026.6.2",
            compositeId: null,
            snapshot,
        };
        backups.save({ ...base, id: "bk-mine", uid: [1, 2, 3] });
        backups.save({ ...base, id: "bk-other", uid: [7, 8, 9] });
        await flush();
        const list = [...c.querySelectorAll("[data-backup]")].map((li) => li.getAttribute("data-backup"));
        expect(list).toEqual(["bk-mine"]);
        mocks.showYesNo.mockResolvedValue(false);
        (c.querySelector('[data-gyrocore="workflow-restore"]') as HTMLButtonElement).click();
        await flush();
        expect(mocks.restoreTune).not.toHaveBeenCalled();
        mocks.showYesNo.mockResolvedValue(true);
        mocks.restoreTune.mockResolvedValue({
            status: "verified",
            backupId: "bk-3",
            expected: snapshot,
            readback: snapshot,
        });
        (c.querySelector('[data-gyrocore="workflow-restore"]') as HTMLButtonElement).click();
        await flush();
        await flush();
        expect(mocks.restoreTune).toHaveBeenCalledWith("bk-mine", expect.stringMatching(/^[0-9a-f]{32}$/));
        expect(c.querySelector('[data-gyrocore="workflow-verified"]')).not.toBeNull();
    });

    it("Virtual Mode or no connection keeps Apply disabled", async () => {
        mocks.virtual = true;
        const { c } = await mountReleased();
        expect(c.querySelector('[data-check="connection"]')?.getAttribute("data-ok")).toBe("no");
        expect(button(c).disabled).toBe(true);
    });
});
