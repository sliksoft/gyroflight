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
 * AutotuneV2Panel.vue with real engine results (synthetic log) and the absolute route on the
 * byte-level Betaflight simulation: what each part shows, that nothing unvalidated can be
 * applied, that the read-only preview writes nothing, and that Apply writes only after the
 * user's yes in a dialog listing every change; a "no" writes nothing; Restore asks too.
 */

import { createApp, h } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FirmwareFc } from "./harness/mspFirmware";

const mocks = vi.hoisted(() => ({
    fc: undefined as unknown as FirmwareFc,
    showYesNo: vi.fn(),
    connected: true,
    virtual: false,
}));

vi.mock("../../src/js/msp", () => ({
    default: {
        promise: vi.fn(async (code: number, data?: number[]) =>
            (await import("./harness/mspFirmware")).firmwarePromise(mocks.fc, code, data),
        ),
    },
}));
// The write authority's steps other than the release contract (writeAuthority.ts), released.
vi.mock("@/gyrocore/releaseGate/analysisBinding", async () =>
    (await import("./harness/analysisBindingRelease")).releasedAnalysisBinding(),
);
vi.mock("@/gyrocore/safety/authorize", async () => (await import("./harness/safetyRelease")).releasedSafety());
vi.mock("@/gyrocore/productLock/productApply", async () =>
    (await import("./harness/productRelease")).releasedProductApply(),
);
vi.mock("@/composables/useDialog", () => ({ useDialog: () => ({ showYesNo: mocks.showYesNo }) }));
vi.mock("@/stores/connection", () => ({
    useConnectionStore: () => ({ connectionValid: mocks.connected, virtualMode: mocks.virtual }),
}));
vi.mock("@/js/localization", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/js/localization")>()),
    i18n: { getMessage: (key: string, args?: string[]) => (args?.length ? `${key}|${args.join("|")}` : key) },
}));

import UApp from "@nuxt/ui/components/App.vue";
import MSPCodes from "../../src/js/msp/MSPCodes";
import AutotuneV2Panel from "../../src/gyrocore/components/AutotuneV2Panel.vue";
import { useAutotuneV2Store } from "../../src/gyrocore/stores/autotuneV2";
import { useTuneBackupStore } from "../../src/gyrocore/stores/tuneBackup";
import { runAutotuneV2, type AutotuneV2Result } from "../../src/gyrocore/engine/autotuneV2";
import { recordingPlan } from "../../src/gyrocore/engine/recordingInstruction";
import { resetConfirmations } from "../../src/gyrocore/tuning/applyConfirmation";
import { useFlightControllerStore } from "../../src/stores/fc";
import { createFirmwareFc, FIRMWARE_WRITE_CODES } from "./harness/mspFirmware";
import { runSoftwareQualifiedAutotuneV2 } from "./harness/softwareQualifiedResult";
import { syntheticLogInput } from "./harness/syntheticLog";
import { closedLoopChirpLog, ratePlant } from "./harness/closedLoopBbl";
import { buildLogInputs } from "../../src/gyrocore/engine/logInput";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { createHash } from "node:crypto";
import { verifiedTuneAllAxesFixture } from "./harness/verifiedTuneFixture";

let blocked: AutotuneV2Result;
let released: AutotuneV2Result;

beforeAll(() => {
    const primary = syntheticLogInput("e".repeat(64));
    const repeat = syntheticLogInput("f".repeat(64));
    blocked = runAutotuneV2({ primary, others: [repeat], verifiedTune: null, createdAt: "2026-10-22T00:00:00Z" });
    // SIMULATION: software-only VALIDATED evidence (no fictitious qualification flight).
    released = runSoftwareQualifiedAutotuneV2({
        primary,
        others: [repeat],
        // A measured gain reduction from the logged tune: its segment carries the released proposal.
        verifiedTune: verifiedTuneAllAxesFixture(0.9, 0.7),
        createdAt: "2026-10-22T00:00:00Z",
    });
}, 600_000);

let pinia: ReturnType<typeof createPinia>;
import { experimentalFixture, headersFor } from "./harness/experimentalFixture";
import { air65FirmwareState } from "./harness/mspFirmware";

/** A result with nothing to release: the template reads only what is present. */
const emptyResult = () => ({
    chain: { config: null, validation: [], notes: [] },
    dterm: [],
    margins: {},
    pid: [],
    filters: [],
    feedforward: [],
    crossLogPlant: {},
    crossLogRejected: [],
    multiRecording: { contributors: [], rejected: [] },
    safety: null,
    parts: [],
    proposal: null,
    releasableProposal: null,
    measurementPlan: [],
    measurementStrategy: [],
    jio: null,
    experimental: null,
    experimentalWithheld: [],
    candidateDecisions: {},
    recordingPlan: null,
});

let unmount: (() => void) | null = null;
const flush = () => new Promise((r) => setTimeout(r, 0));
const writes = () => mocks.fc.calls.map((c) => c.code).filter((c) => FIRMWARE_WRITE_CODES.has(c));
const q = (c: Element, sel: string) => c.querySelector(sel) as HTMLElement | null;

function mount(result: AutotuneV2Result | null) {
    const store = useAutotuneV2Store();
    store.result = result;
    store.state = result ? "done" : "idle";
    const container = document.createElement("div");
    document.body.appendChild(container);
    const app = createApp({ render: () => h(UApp, { portal: false }, { default: () => h(AutotuneV2Panel) }) });
    app.config.globalProperties.$t = ((key: string) => key) as never;
    app.use(pinia);
    app.mount(container);
    unmount = () => (app.unmount(), container.remove());
    return container;
}

beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    localStorage.clear();
    resetConfirmations();
    mocks.fc = createFirmwareFc();
    mocks.showYesNo.mockReset();
    mocks.connected = true;
    mocks.virtual = false;
    useFlightControllerStore().config.uid = [...mocks.fc.uid];
});
afterEach(() => {
    unmount?.();
    unmount = null;
});

describe("AutotuneV2Panel", () => {
    it("shows the experimental CHIRP + JIO route as a diagnostic, blocked without its channels, never as a release path", async () => {
        // Synthetic engine input without the JIO channels: the route names what is missing.
        const c = mount(blocked);
        await flush();
        expect(q(c, '[data-gyrocore="v2-jio-status"]')!.textContent!.trim()).toBe("BLOCKED");
        expect(q(c, '[data-gyrocore="v2-jio-blockers"]')!.textContent).toContain("jio_channels_missing");
        expect(q(c, '[data-gyrocore="v2-jio-method"]')!.textContent).toContain("chirp_jio_sweep_fft_daniell");
        expect(q(c, '[data-gyrocore="v2-jio-method"]')!.textContent).toContain("no_release_evidence:diagnostic_only");
        unmount?.();
        unmount = null;
        // Simulated closed-loop Blackbox bytes with the controller terms: a DIAGNOSTIC result per axis,
        // with its band, repeats and the reason tuning is not computed from it. Apply stays as before.
        const G = ratePlant({ K: 60, motorHz: 40, delayS: 0.002 });
        const bytes = closedLoopChirpLog({
            plants: [G, G, null],
            sweepS: 12,
            amplitude: 150,
            seed: 21,
            jio: { disturbance: { sd: 3, poleHz: 300 } },
        });
        const sha = createHash("sha256").update(bytes).digest("hex");
        const [log] = buildLogInputs(bytes, sha, qualifyChirpFile(bytes, "jio.bbl", 45, AUTOTUNE_MATH), null);
        // A second independent flight of the same craft and settings: a cross-flight repeat.
        const bytes2 = closedLoopChirpLog({
            plants: [G, G, null],
            sweepS: 12,
            amplitude: 150,
            seed: 22,
            startTimeUs: 9_000_000,
            jio: { disturbance: { sd: 3, poleHz: 300 } },
        });
        const sha2 = createHash("sha256").update(bytes2).digest("hex");
        const [log2] = buildLogInputs(bytes2, sha2, qualifyChirpFile(bytes2, "jio2.bbl", 45, AUTOTUNE_MATH), null);
        const diag = runAutotuneV2({
            primary: log,
            others: [log2],
            verifiedTune: null,
            createdAt: "2026-11-02T00:00:00Z",
        });
        expect(diag.jio.status).toBe("DIAGNOSTIC");
        const d = mount(diag);
        await flush();
        expect(q(d, '[data-gyrocore="v2-jio-status"]')!.textContent!.trim()).toBe("DIAGNOSTIC");
        const rows = d.querySelectorAll('[data-gyrocore="v2-jio"] tbody tr');
        expect(rows).toHaveLength(2);
        const roll = q(d, '[data-gyrocore="v2-jio"] tr[data-axis="roll"]')!;
        expect(roll.getAttribute("data-repeats")).toBe("unknown");
        expect(roll.getAttribute("data-computable")).toBe("yes");
        expect(roll.textContent).toContain("MEASURED");
        expect(roll.textContent).toContain("gyroflightV2JioDiagnosticOnly");
        expect(roll.textContent).not.toContain("VALIDATED");
        // The other flight is a consistent repeat: the row says so and the stationarity need is gone.
        expect(roll.getAttribute("data-cross-flight")).toBe("consistent");
        expect(roll.textContent).toMatch(/1: consistent z=\d/);
        expect(q(d, '[data-gyrocore="v2-jio-cross"]')!.textContent).toContain(`${sha2.slice(0, 12)}#1`);
        expect(q(d, '[data-gyrocore="v2-jio-cross"]')!.textContent).toContain("plant z=");
        expect(q(d, '[data-gyrocore="v2-jio-needs"]')!.textContent).toContain("repeated_sweep_for_stationarity");
        expect(q(d, '[data-gyrocore="v2-jio-needs"]')!.textContent).not.toContain("repeat_flight_for_reproducibility");
        expect(roll.textContent).toContain("gyroflightV2JioCrossFlightHelp");
        // The plot per analysed axis: dots for the evaluation points, and the sweep advice per axis.
        const plots = d.querySelectorAll('[data-gyrocore="v2-jio-plot"]');
        expect(plots).toHaveLength(2);
        expect(Number(plots[0].getAttribute("data-points"))).toBeGreaterThan(50);
        expect(plots[0].querySelectorAll("circle").length).toBe(Number(plots[0].getAttribute("data-points")));
        expect(plots[0].querySelector("polyline")!.getAttribute("points")!.length).toBeGreaterThan(100);
        const advice = d.querySelectorAll('[data-gyrocore="v2-jio-advice"]');
        expect(advice).toHaveLength(2);
        expect(advice[0].textContent).toMatch(/gyroflightV2JioAdvice(None)?\|roll\|/);
        // The measurement set per axis: counts, repeats within and across flights, bands, and the axis's needs.
        const progress = d.querySelectorAll('[data-gyrocore="v2-jio-progress"]');
        expect(progress).toHaveLength(2);
        const pRoll = q(d, '[data-gyrocore="v2-jio-progress"][data-axis="roll"]')!;
        expect(pRoll.textContent).toContain(
            "gyroflightV2JioProgress|1 gyroflightV2JioProgressPresent, 1 gyroflightV2JioProgressComplete, 1 gyroflightV2JioProgressUsable|1: unknown|1 of 1: consistent z=",
        );
        // No "/" reaches an i18n argument (the real app HTML-escapes it).
        expect(pRoll.textContent).not.toMatch(/\d\/\d/);
        expect(pRoll.textContent).toContain("gyroflightV2JioProgressNext");
        expect(pRoll.textContent).toContain("repeated_sweep_for_stationarity");
        expect(pRoll.textContent).not.toContain("pitch");
        expect(pRoll.getAttribute("data-complete")).toBe("no");
        // The preparation label: software only, the trial not flown; a goal not covered names the missing band.
        expect(q(d, '[data-gyrocore="v2-jio-preparation"]')!.textContent).toContain("gyroflightV2JioPreparation");
        for (const el of progress)
            if (el.textContent!.includes("gyroflightV2JioProgressGoalShort"))
                expect(el.textContent).toMatch(/gyroflightV2JioProgressMissing [\d.]+–[\d.]+ Hz/);
        // Keys the synthetic headers do not carry are named as not compared on the candidate line.
        expect(q(d, '[data-gyrocore="v2-jio-cross"]')!.textContent).toContain("gyroflightV2JioCandidateNotLogged");
        expect(q(d, '[data-gyrocore="v2-jio-cross"]')!.textContent).toContain("anti_gravity_gain");
        expect(q(d, '[data-gyrocore="v2-jio-mimo"]')).toBeNull();
        expect((q(d, '[data-gyrocore="v2-apply"]') as HTMLButtonElement).disabled).toBe(true);
        // Block 5: the experimental section is its own status; its Apply needs the acknowledgement and the
        // technical decision, never the release; the comparison loop and the recording labels are shown.
        expect(q(d, '[data-step="v2-experimental"]')).not.toBeNull();
        expect(q(d, '[data-gyrocore="v2-compare-loop"]')!.textContent).toContain("gyroflightV2CompareLoop");
        if (diag.experimental) {
            expect(q(d, '[data-gyrocore="v2-experimental-status"]')!.getAttribute("data-status")).toBe("EXPERIMENTAL");
            expect(d.querySelectorAll('[data-gyrocore="v2-experimental-items"] tbody tr').length).toBe(
                diag.experimental.items.length,
            );
            expect(q(d, '[data-gyrocore="v2-experimental-waived"]')!.textContent).toContain("product_lock");
            const ack = q(d, '[data-gyrocore="v2-experimental-ack"]') as HTMLInputElement;
            expect(ack.checked).toBe(false);
            expect((q(d, '[data-gyrocore="v2-experimental-apply"]') as HTMLButtonElement).disabled).toBe(true);
            expect(q(d, '[data-gyrocore="v2-experimental-blocks"]')!.textContent).toContain(
                "experimental:not_acknowledged",
            );
            expect(q(d, '[data-gyrocore="v2-experimental-items"]')!.textContent).not.toContain("VALIDATED (");
        } else {
            expect(q(d, '[data-gyrocore="v2-experimental-none"]')).not.toBeNull();
        }
        expect(q(d, '[data-gyrocore="v2-experimental-status"]')?.textContent ?? "").not.toContain("releasable");
        expect(writes()).toEqual([]);
    });

    it("experimental Apply: own status, acknowledgement required, writes through the technical checks, labels the next recording", async () => {
        // The standard release is unavailable (no releasable proposal); the experimental proposal is the
        // analysis's own (store.result.experimental). The product lock and Safety mocks of this file release
        // nothing for the experimental route: it has its own authority.
        const x = experimentalFixture();
        const r = {
            ...emptyResult(),
            experimental: x,
            experimentalWithheld: [
                { key: "pid_yaw", part: "pid", source: "primary_route", reasons: ["no_candidate_meets_all_targets"] },
            ],
        } as unknown as AutotuneV2Result;
        const d = mount(r);
        await flush();
        expect((q(d, '[data-gyrocore="v2-apply"]') as HTMLButtonElement).disabled).toBe(true);
        expect(q(d, '[data-gyrocore="v2-experimental-status"]')!.getAttribute("data-status")).toBe("EXPERIMENTAL");
        expect(d.querySelectorAll('[data-gyrocore="v2-experimental-items"] tbody tr')).toHaveLength(3);
        expect(q(d, '[data-gyrocore="v2-experimental-withheld"]')!.textContent).toContain("pid_yaw");
        const apply = q(d, '[data-gyrocore="v2-experimental-apply"]') as HTMLButtonElement;
        const ack = q(d, '[data-gyrocore="v2-experimental-ack"]') as HTMLInputElement;
        expect(apply.disabled).toBe(true);
        ack.click();
        await flush();
        expect(ack.checked).toBe(true);
        expect(apply.disabled).toBe(false);
        // No: nothing written. Yes: written, verified, saved; the outcome says experimental; backup with provenance.
        mocks.showYesNo.mockResolvedValueOnce(false);
        apply.click();
        await flush();
        await flush();
        expect(writes()).toEqual([]);
        mocks.showYesNo.mockResolvedValueOnce(true);
        apply.click();
        for (let i = 0; i < 20 && !q(d, '[data-gyrocore="v2-verified"]'); i++) await flush();
        expect(mocks.showYesNo.mock.calls.at(-1)![0]).toBe("gyroflightV2ExperimentalConfirmTitle");
        expect(String(mocks.showYesNo.mock.calls.at(-1)![1])).toContain("experimental:not_hardware_validated");
        expect(q(d, '[data-gyrocore="v2-verified"]')).not.toBeNull();
        expect(q(d, '[data-gyrocore="v2-verified-experimental"]')).not.toBeNull();
        expect(writes()).toContain(MSPCodes.MSP_EEPROM_WRITE);
        expect(mocks.fc.eeprom.pids[0]).toEqual([60, 79, 32]);
        const backup = useTuneBackupStore().backups[0];
        expect(backup.reason).toBe("before_experimental_apply");
        expect(backup.provenance?.route).toBe("experimental");
        expect(backup.provenance?.hardwareValidated).toBe(false);
        // The next recording with the written values is labelled as the experimental configuration;
        // one with the backup's values as the reference.
        const store = useAutotuneV2Store();
        const written = { ...air65FirmwareState() };
        written.pids = [[60, 79, 32], ...written.pids.slice(1)];
        written.p = { ...written.p, dterm_lpf1_static_hz: 80 };
        store.sources = [
            {
                filename: "after.bbl",
                bytes: new Uint8Array(),
                uid: null,
                report: { logs: [{ headerPairs: headersFor(written) }], measurements: [] } as never,
            },
            {
                filename: "before.bbl",
                bytes: new Uint8Array(),
                uid: null,
                report: { logs: [{ headerPairs: headersFor(air65FirmwareState()) }], measurements: [] } as never,
            },
        ];
        await flush();
        const roles = [...d.querySelectorAll('[data-gyrocore="v2-recording-config"]')].map((e) =>
            e.getAttribute("data-role"),
        );
        expect(roles).toEqual(["experimental", "reference"]);
        // The Restore of that backup is offered (its own route and confirmation).
        expect(q(d, `[data-gyrocore="v2-backups"] [data-backup="${backup.id}"]`)).not.toBeNull();
    });

    it("section 4c: per axis the decision, the missing frequencies, existing data apart from the one shared sweep configuration", async () => {
        const fail = {
            rule: "identified_band_top",
            ref: "loopModel",
            value: 37.109,
            unit: "Hz",
            threshold: "≥ 66.0 Hz (planner band 9.8–66.0 Hz); next bin 39.1 Hz: γ² 0.620 < LOOP_MIN_COHERENCE 0.8",
            result: "fail",
            consequence: "record a sweep whose coherence reaches the planner band",
        } as const;
        const primary = {
            route: "primary" as const,
            plant: "present_with_limitation" as const,
            bandHz: [9.8, 37.1] as [number, number],
            metrics: null,
            current: null,
            checks: [fail],
            searchRan: false,
            candidatesTried: 0,
            candidatesUsable: 0,
            status: "plant_band_insufficient" as const,
            firstCause: fail,
            candidate: null,
            measurementUsable: true,
            missing: [
                {
                    kind: "decision_band_hole" as const,
                    fromHz: 12.2,
                    toHz: 14.6,
                    bins: 3,
                    reason: "coherence" as const,
                    value: 0.612,
                    unit: "γ²",
                    threshold: "γ² ≥ 0.8",
                },
                {
                    kind: "above_identified_band" as const,
                    fromHz: 39.1,
                    toHz: 66,
                    bins: null,
                    reason: "coherence" as const,
                    value: 0.62,
                    unit: "γ²",
                    threshold: "γ² ≥ 0.8 (first bin outside the identified band: 39.1 Hz)",
                },
            ],
            waived: [],
        };
        const decisions = { roll: { primary, jio: null } };
        const r = {
            ...emptyResult(),
            candidateDecisions: decisions,
            recordingPlan: recordingPlan({
                decisions,
                headers: {
                    debug_mode: "96",
                    "P interval": "1",
                    chirp_frequency_start_deci_hz: "2",
                    chirp_frequency_end_deci_hz: "6000",
                    chirp_time_seconds: "20",
                    chirp_amplitude_roll: "230",
                    chirp_amplitude_pitch: "230",
                    chirp_amplitude_yaw: "180",
                },
                advice: {},
                plannerBandsHz: { roll: [[9.8, 66]], pitch: [[6, 109]] },
                sweeps: {
                    roll: { present: 2, complete: 2, usableComplete: 2 },
                    pitch: { present: 2, complete: 2, usableComplete: 2 },
                    yaw: { present: 1, complete: 1, usableComplete: 1 },
                },
                crossFlight: {},
            }),
        } as unknown as AutotuneV2Result;
        const d = mount(r);
        await flush();
        const row = q(d, '[data-gyrocore="v2-decisions"] tr[data-axis="roll"][data-route="primary"]')!;
        expect(row.getAttribute("data-status")).toBe("plant_band_insufficient");
        expect(row.textContent).toContain("identified_band_top: 37.109 Hz");
        expect(row.textContent).toContain("γ² 0.620 < LOOP_MIN_COHERENCE 0.8");
        expect(row.textContent).toContain("not run");
        const pl = q(d, '[data-gyrocore="v2-recording-plan"]')!;
        expect(pl.getAttribute("data-needed")).toBe("yes");
        // Per axis: the exact missing intervals with reason, value and threshold.
        const roll = q(pl, '[data-gyrocore="v2-recording-axis"][data-axis="roll"]')!;
        expect(roll.getAttribute("data-kind")).toBe("record");
        const ivs = [...roll.querySelectorAll('[data-gyrocore="v2-missing-interval"]')].map((e) =>
            e.textContent!.trim(),
        );
        expect(ivs[0]).toBe(
            "primary: 12.2–14.6 Hz (3 bins), inside the decision band: coherence 0.612 γ²; required γ² ≥ 0.8",
        );
        expect(ivs[1]).toContain("primary: 39.1–66.0 Hz, planner band above the identified band: coherence 0.620 γ²");
        // Existing data apart: five activations (yaw once) = one complete round; second flight unknown, not passed.
        expect(q(pl, '[data-gyrocore="v2-plan-rounds"]')!.getAttribute("data-state")).toBe("incomplete");
        expect(q(pl, '[data-gyrocore="v2-plan-rounds"]')!.textContent).toContain("gyroflightV2PlanRounds|1|2|1|");
        expect(q(pl, '[data-gyrocore="v2-plan-second-flight"]')!.getAttribute("data-state")).toBe("unknown");
        expect(q(pl, '[data-gyrocore="v2-plan-second-flight"]')!.textContent).toContain(
            "gyroflightV2PlanSecondFlight_unknown",
        );
        expect(
            q(pl, '[data-gyrocore="v2-plan-existing"] [data-setting="chirp_frequency_end_deci_hz"]')!.textContent,
        ).toContain("6000 dHz (600.0 Hz)");
        // The one proposed configuration: dHz with Hz, exact CLI lines, 20 s, amplitudes unchanged.
        const end = q(pl, '[data-gyrocore="v2-plan-settings"] [data-setting="chirp_frequency_end_deci_hz"]')!;
        expect(end.getAttribute("data-changed")).toBe("yes");
        expect(end.textContent).toContain("1100 dHz (110.0 Hz)");
        expect(
            q(pl, '[data-gyrocore="v2-plan-settings"] [data-setting="chirp_time_seconds"]')!.getAttribute(
                "data-changed",
            ),
        ).toBe("no");
        expect(
            q(pl, '[data-gyrocore="v2-plan-settings"] [data-setting="chirp_amplitude_yaw"]')!.getAttribute(
                "data-changed",
            ),
        ).toBe("no");
        expect(q(pl, '[data-gyrocore="v2-plan-cli"]')!.textContent).toBe(
            "set debug_mode = CHIRP\nset blackbox_sample_rate = 1/1\nset chirp_frequency_start_deci_hz = 20\nset chirp_frequency_end_deci_hz = 1100\nset chirp_time_seconds = 20\nsave",
        );
        expect(q(pl, '[data-gyrocore="v2-plan-coverage"]')!.getAttribute("data-valid")).toBe("yes");
        expect(q(pl, '[data-gyrocore="v2-recording-timing"]')!.textContent).toContain(
            "gyroflightV2PlanTiming|6|20|120|141|",
        );
        expect(q(pl, '[data-gyrocore="v2-plan-second-flight-help"]')!.textContent).toMatch(/^\s*Optional/);
        expect(q(pl, '[data-gyrocore="v2-plan-note"]')!.textContent).toContain("no guarantee of a tuning proposal");
    });

    it("experimental Apply is refused when the craft is armed, without a write and without a backup", async () => {
        const r = {
            ...emptyResult(),
            experimental: experimentalFixture(),
            experimentalWithheld: [],
        } as unknown as AutotuneV2Result;
        const d = mount(r);
        await flush();
        (q(d, '[data-gyrocore="v2-experimental-ack"]') as HTMLInputElement).click();
        await flush();
        mocks.fc.armed = true;
        mocks.showYesNo.mockResolvedValueOnce(true);
        (q(d, '[data-gyrocore="v2-experimental-apply"]') as HTMLButtonElement).click();
        for (let i = 0; i < 20 && !q(d, '[data-gyrocore="v2-failed"]'); i++) await flush();
        expect(q(d, '[data-gyrocore="v2-failed"]')!.getAttribute("data-status")).toBe("blocked");
        expect(q(d, '[data-gyrocore="v2-failed"]')!.textContent).toContain("fc:armed");
        expect(writes()).toEqual([]);
        expect(useTuneBackupStore().backups).toEqual([]);
    });

    it("without an imported CHIRP file: nothing to calculate", async () => {
        const c = mount(null);
        await flush();
        expect(q(c, '[data-gyrocore="v2-no-source"]')).not.toBeNull();
        expect((q(c, '[data-gyrocore="v2-calculate"]') as HTMLButtonElement).disabled).toBe(true);
    });

    it("shows every part's status and missing measurement; unvalidated values are never applied", async () => {
        const c = mount(blocked);
        await flush();
        expect(c.querySelectorAll('[data-gyrocore="v2-parts"] tbody tr')).toHaveLength(9);
        const ff = q(c, '[data-part="feedforward"]')!;
        expect(ff.getAttribute("data-state")).toBe("BLOCKED");
        expect(ff.textContent).toContain("acro_stick_flight");
        expect(q(c, '[data-part="independent_gain_prediction"]')!.getAttribute("data-state")).toBe("BLOCKED");
        // Compare lists every proposed value, none of them marked as applied.
        const items = c.querySelectorAll('[data-gyrocore="v2-compare"] tbody tr');
        expect(items.length).toBe(blocked.proposal!.items.length);
        for (const row of items) expect(row.textContent).toContain("✗");
        expect(q(c, '[data-condition="independent_validation"]')!.getAttribute("data-ok")).toBe("no");
        const apply = q(c, '[data-gyrocore="v2-apply"]') as HTMLButtonElement;
        expect(apply.disabled).toBe(true);
        apply.click();
        await flush();
        expect(mocks.showYesNo).not.toHaveBeenCalled();
        expect(mocks.fc.calls).toEqual([]);
    });

    it("the read-only preview reads the craft and writes nothing", async () => {
        const c = mount(blocked);
        await flush();
        (q(c, '[data-gyrocore="v2-preview"]') as HTMLButtonElement).click();
        for (let i = 0; i < 20 && !q(c, '[data-gyrocore="v2-preview-result"]'); i++) await flush();
        expect(q(c, '[data-gyrocore="v2-preview-result"]')!.getAttribute("data-status")).toBe("ok");
        expect(writes()).toEqual([]);
        expect(mocks.fc.calls.length).toBeGreaterThan(0);
    });

    it("Apply asks with every change listed; no writes nothing; yes writes, verifies, saves; Restore asks too", async () => {
        const c = mount(released);
        await flush();
        const apply = q(c, '[data-gyrocore="v2-apply"]') as HTMLButtonElement;
        expect(apply.disabled).toBe(false);

        mocks.showYesNo.mockResolvedValueOnce(false);
        apply.click();
        for (let i = 0; i < 30 && !mocks.showYesNo.mock.calls.length; i++) await flush();
        await flush();
        expect(mocks.showYesNo).toHaveBeenCalledTimes(1);
        const html = String(mocks.showYesNo.mock.calls[0][1]);
        for (const key of Object.keys(released.releasableProposal!.change)) expect(html).toContain(key);
        expect(writes()).toEqual([]);

        mocks.showYesNo.mockResolvedValueOnce(true);
        apply.click();
        for (let i = 0; i < 60 && !q(c, '[data-gyrocore="v2-verified"]'); i++) await flush();
        expect(q(c, '[data-gyrocore="v2-verified"]')).not.toBeNull();
        expect(writes().at(-1)).toBe(MSPCodes.MSP_EEPROM_WRITE);
        for (const [k, v] of Object.entries(released.releasableProposal!.change)) {
            const [term, axis] = [k.split("_")[0], k.split("_").slice(1).join("_")];
            const row = ["roll", "pitch", "yaw"].indexOf(axis);
            if (["p", "i", "d"].includes(term) && row >= 0)
                expect(mocks.fc.eeprom.pids[row]["pid".indexOf(term)], k).toBe(v);
        }

        await flush();
        const restore = q(c, '[data-gyrocore="v2-restore"]') as HTMLButtonElement;
        expect(restore).not.toBeNull();
        mocks.showYesNo.mockResolvedValueOnce(true);
        const before = mocks.fc.calls.length;
        restore.click();
        for (let i = 0; i < 60 && mocks.showYesNo.mock.calls.length < 3; i++) await flush();
        for (
            let i = 0;
            i < 60 && mocks.fc.calls.slice(before).filter((x) => x.code === MSPCodes.MSP_EEPROM_WRITE).length === 0;
            i++
        )
            await flush();
        expect(mocks.showYesNo).toHaveBeenCalledTimes(3);
        expect(mocks.fc.eeprom.pids[0]).toEqual([56, 79, 30]);
    });

    it("a write that ended unverified: the panel names it, Apply is not offered, a Restore clears it (F-03)", async () => {
        const c = mount(released);
        await flush();
        const apply = q(c, '[data-gyrocore="v2-apply"]') as HTMLButtonElement;
        expect(q(c, '[data-gyrocore="uncertain-state"]')).toBeNull();
        // The firmware saves, its answer arrives corrupt: the saved state is unknown.
        mocks.fc.corruptReplyAfterExecute = new Set([MSPCodes.MSP_EEPROM_WRITE]);
        mocks.showYesNo.mockResolvedValue(true);
        apply.click();
        for (let i = 0; i < 60 && !q(c, '[data-gyrocore="uncertain-state"]'); i++) await flush();
        mocks.fc.corruptReplyAfterExecute = new Set();
        const notice = q(c, '[data-gyrocore="uncertain-state"]')!;
        expect(notice).not.toBeNull();
        expect(notice.textContent).toContain("gyroflightUncertainEntry|");
        expect(notice.textContent).toContain("|eeprom|unknown|");
        expect(apply.disabled).toBe(true);
        // A read-back cannot show what EEPROM holds: the check says so and the notice stays.
        (q(c, '[data-gyrocore="uncertain-state-check"]') as HTMLButtonElement).click();
        for (let i = 0; i < 60 && !q(c, '[data-gyrocore="uncertain-state-why"]'); i++) await flush();
        expect(q(c, '[data-gyrocore="uncertain-state-why"]')!.textContent).toContain(
            "eeprom_state_unknown_restore_required",
        );
        // Restore (verified and saved) makes the state known: the notice goes, Apply is offered again.
        const restore = q(c, '[data-gyrocore="v2-restore"]') as HTMLButtonElement;
        restore.click();
        for (let i = 0; i < 80 && q(c, '[data-gyrocore="uncertain-state"]'); i++) await flush();
        expect(q(c, '[data-gyrocore="uncertain-state"]')).toBeNull();
        expect(apply.disabled).toBe(false);
    });

    it("in virtual mode neither preview nor Apply is offered", async () => {
        mocks.virtual = true;
        const c = mount(released);
        await flush();
        expect((q(c, '[data-gyrocore="v2-preview"]') as HTMLButtonElement).disabled).toBe(true);
        expect((q(c, '[data-gyrocore="v2-apply"]') as HTMLButtonElement).disabled).toBe(true);
    });

    it("margin evidence: MODEL_CONDITIONAL bounds are never green and say what they assume and need (F-02)", async () => {
        const c = mount(blocked);
        await flush();
        const rows = c.querySelectorAll('[data-gyrocore="v2-margins"] tbody tr');
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
            // Proposed PID can drop fc below what the ladder resolves → MEASURED on that axis;
            // neither MEASURED nor MODEL_CONDITIONAL is shown green.
            expect(["MODEL_CONDITIONAL", "MEASURED"]).toContain(row.getAttribute("data-evidence"));
            expect(row.getAttribute("data-state")).toBe("NOT_VALIDATED");
            expect(row.querySelector(".text-green-500")).toBeNull();
            expect(row.textContent).toContain("gyroflightV2Measured");
        }
        // Pitch proposed stays MODEL_CONDITIONAL (fc still resolved on the 2 Hz rung).
        const pitch = q(c, '[data-gyrocore="v2-margin-evidence"] [data-axis="pitch"]')!;
        expect(pitch.getAttribute("data-evidence")).toBe("MODEL_CONDITIONAL");
        expect(pitch.textContent).toContain("gyroflightV2EvidenceConditional");
        expect(pitch.textContent).toContain(
            "gyroflightV2EvidenceNeeded|chirp_finer_resolution_model_class_qualification",
        );
        expect(q(c, '[data-gyrocore="v2-evidence-legend"]')).not.toBeNull();
    });

    it("margin evidence: a qualified model shows VALIDATED in green with its qualification (SIMULATION)", async () => {
        const c = mount(released);
        await flush();
        const roll = q(c, '[data-gyrocore="v2-margins"] tbody tr[data-axis="roll"]')!;
        expect(roll.getAttribute("data-evidence")).toBe("VALIDATED");
        expect(roll.querySelector(".text-green-500")).not.toBeNull();
        const detail = q(c, '[data-gyrocore="v2-margin-evidence"] [data-axis="roll"]')!;
        // SIMULATED_QUALIFICATION_SHA is "5".repeat(64); the panel shows the first 8 hex chars.
        // Qualification claims 1/5 of the primary resolution (marginEvidenceFixture).
        expect(detail.textContent).toContain("gyroflightV2EvidenceQualified|55555555|0.800|3.609");
        expect(detail.textContent).not.toContain("gyroflightV2EvidenceNeeded");
    });
});
