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
 * The Autotune tab's sections: the navigation, that switching sections (and leaving the tab) keeps
 * the imported log and the analysis results, that each section shows its own parts of the engine
 * v2 panel, and that the overview keeps measurement, tuning result and Apply apart per axis.
 */

import { createApp, h, type Component } from "vue";
import { createPinia, getActivePinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
};

const picked = vi.hoisted(() => ({ bytes: new Uint8Array() as Uint8Array, name: "test.bbl" }));

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

import UApp from "@nuxt/ui/components/App.vue";
import AutotuneTab from "../../src/components/tabs/AutotuneTab.vue";
import AutotuneV2Panel from "../../src/gyrocore/components/AutotuneV2Panel.vue";
import AutotuneOverview from "../../src/gyrocore/components/AutotuneOverview.vue";
import { useAutotune } from "../../src/composables/useAutotune";
import { useAutotuneStore } from "../../src/stores/autotune";
import { useAutotuneV2Store } from "../../src/gyrocore/stores/autotuneV2";
import { useChirpQualificationStore } from "../../src/gyrocore/stores/chirpQualification";
import { AUTOTUNE_SECTIONS, useAutotuneSectionStore } from "../../src/gyroflight/autotune/sections";
import type { AutotuneV2Result } from "../../src/gyrocore/engine/autotuneV2";
import { encodeChirpLog, simulateChirp } from "./harness/chirpSim";
import { experimentalFixture } from "./harness/experimentalFixture";

const flush = () => new Promise((r) => setTimeout(r, 0));

function mountComponent(component: Component, props: Record<string, unknown> = {}) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const app = createApp({
        render: () => h(UApp, { portal: false }, { default: () => h(component, props) }),
    });
    app.config.globalProperties.$t = ((key: string) => key) as never;
    app.use(getActivePinia()!);
    app.mount(container);
    return { container, unmount: () => (app.unmount(), container.remove()) };
}

async function importLog() {
    picked.bytes = encodeChirpLog(simulateChirp());
    picked.name = "air65.bbl";
    await useAutotune().importAndAnalyze();
}

/** A per-axis recording plan decision, as recordingInstruction.ts produces it. */
const planAxis = (
    axis: string,
    kind: "record" | "search_limit" | "candidate",
    trigger: { route: string; status: string; rule: string; value: string | number | null; threshold: string },
    note: string,
) => ({ axis, kind, trigger, missing: [], plannerBandsHz: [], note });

/** A result with only what the overview and the section filter read. */
function resultWith(extra: Partial<Record<string, unknown>>): AutotuneV2Result {
    return {
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
        ...extra,
    } as unknown as AutotuneV2Result;
}

beforeEach(() => {
    setActivePinia(createPinia());
});

describe("Autotune tab sections", () => {
    it("opens the overview first, with no navigation column of its own (the sections are in the main sidebar)", async () => {
        const { container, unmount } = mountComponent(AutotuneTab);
        await flush();
        expect(container.querySelector("nav")).toBeNull();
        expect(container.querySelector("[data-autotune-section]")).toBeNull();
        expect(container.querySelector('[data-gyroflight="autotune-section"]')!.getAttribute("data-section")).toBe(
            "overview",
        );
        expect(container.querySelector('[data-gyroflight="autotune-section-title"]')!.textContent).toContain(
            "gyroflightAutotuneSection_overview",
        );
        expect(container.querySelector('[data-gyrocore="autotune-overview"]')).not.toBeNull();
        unmount();
    });

    it("switching sections keeps the imported log and the analysis; the import box stays in every section", async () => {
        await importLog();
        const autotune = useAutotuneStore();
        const gate = useChirpQualificationStore();
        const v2 = useAutotuneV2Store();
        expect(autotune.analysisState).toBe("done");
        const report = gate.report;
        const result = autotune.analysisResult;
        const sources = v2.sources.length;
        expect(sources).toBe(1);

        const { container, unmount } = mountComponent(AutotuneTab);
        await flush();
        const expected: Record<string, string> = {
            overview: '[data-gyrocore="autotune-overview"]',
            chirp: '[data-gyrocore="chirp-qualification"]',
            graphs: '[data-gyrocore="autotune-v2"], .bode-svg',
            tuning: '[data-gyrocore="tune-workflow"]',
            compare: '[data-gyrocore="v2-sources"]',
            plan: '[data-gyroflight="autotune-needs-calculate"]',
            technical: '[data-gyrocore="m4-flight-metrics"]',
        };
        const sections = useAutotuneSectionStore();
        for (const section of AUTOTUNE_SECTIONS) {
            sections.open(section);
            await flush();
            const content = container.querySelector('[data-gyroflight="autotune-section"]')!;
            expect(content.getAttribute("data-section")).toBe(section);
            expect(content.querySelector(expected[section]), section).not.toBeNull();
            // The log is imported once: the file summary stays, nothing was re-imported or reset.
            expect(content.textContent).toContain("air65.bbl");
            expect(autotune.analysisState).toBe("done");
            expect(autotune.analysisResult).toBe(result);
            expect(gate.report).toBe(report);
            expect(v2.sources.length).toBe(sources);
        }
        unmount();
    });

    it("the open section survives leaving and reopening the tab", async () => {
        const first = mountComponent(AutotuneTab);
        await flush();
        useAutotuneSectionStore().open("plan");
        await flush();
        first.unmount();
        const second = mountComponent(AutotuneTab);
        await flush();
        expect(
            second.container.querySelector('[data-gyroflight="autotune-section"]')!.getAttribute("data-section"),
        ).toBe("plan");
        second.unmount();
    });

    it("each engine v2 action has one place: Calculate in the overview, the logs and Verified Tune in Compare", async () => {
        await importLog();
        const sections = useAutotuneSectionStore();
        const { container, unmount } = mountComponent(AutotuneTab);
        await flush();
        const content = () => container.querySelector('[data-gyroflight="autotune-section"]')!;
        const count = (sel: string) => content().querySelectorAll(sel).length;
        expect(count('[data-gyrocore="v2-calculate"]')).toBe(1);
        expect(count('[data-gyrocore="v2-verified-tune"]')).toBe(0);
        expect(count('[data-gyrocore="v2-sources"]')).toBe(0);
        sections.open("compare");
        await flush();
        expect(count('[data-gyrocore="v2-calculate"]')).toBe(0);
        expect(count('[data-gyrocore="v2-verified-tune"]')).toBe(1);
        expect(count('[data-gyrocore="v2-sources"]')).toBe(1);
        // Compare points back to the overview for Calculate.
        (content().querySelector('[data-gyroflight="autotune-compare-open-overview"]') as HTMLButtonElement).click();
        await flush();
        expect(sections.active).toBe("overview");
        for (const section of AUTOTUNE_SECTIONS.filter((s) => s !== "overview" && s !== "compare")) {
            sections.open(section);
            await flush();
            expect(count('[data-gyrocore="v2-calculate"], [data-gyrocore="v2-verified-tune"]'), section).toBe(0);
        }
        unmount();
    });

    it("the graphs section asks for an import instead of showing empty plots", async () => {
        useAutotuneSectionStore().open("graphs");
        const { container, unmount } = mountComponent(AutotuneTab);
        await flush();
        expect(container.querySelector('[data-gyroflight="autotune-needs-import"]')).not.toBeNull();
        expect(container.querySelector(".bode-svg")).toBeNull();
        unmount();
    });
});

describe("engine v2 panel parts", () => {
    const x = () => experimentalFixture();
    const plan = () => ({
        recordingNeeded: true,
        axes: [planAxis("roll", "record", { route: "primary", status: "s", rule: "r", value: 1, threshold: "t" }, "n")],
        existing: {
            settings: [],
            rounds: { required: 2, complete: 1, usable: 1, perAxis: [], state: "incomplete" },
            secondFlight: { state: "none", comparable: 0, perAxis: [] },
        },
        sweep: null,
        procedure: [],
        secondFlight: "",
        completionChecks: [],
        notChanged: [],
        note: "plan note",
    });
    const decisions = () => ({
        roll: {
            primary: {
                route: "primary",
                plant: "present",
                bandHz: [5, 50],
                checks: [],
                searchRan: false,
                candidatesTried: 0,
                candidatesUsable: 0,
                status: "plant_band_insufficient",
                firstCause: null,
            },
            jio: null,
        },
    });

    it("shows every part without a filter (unchanged default)", async () => {
        const v2 = useAutotuneV2Store();
        v2.result = resultWith({ experimental: x(), recordingPlan: plan(), candidateDecisions: decisions() });
        v2.state = "done";
        const { container, unmount } = mountComponent(AutotuneV2Panel);
        await flush();
        for (const sel of [
            '[data-gyrocore="v2-calculate"]',
            '[data-step="v2-compare"]',
            '[data-gyrocore="v2-apply"]',
            '[data-gyrocore="v2-experimental-items"]',
            '[data-gyrocore="v2-decisions"]',
            '[data-gyrocore="v2-recording-plan"]',
            '[data-step="v2-verify"]',
            '[data-step="v2-restore"]',
        ]) {
            expect(container.querySelector(sel), sel).not.toBeNull();
        }
        unmount();
    });

    it("shows only the requested parts", async () => {
        const v2 = useAutotuneV2Store();
        v2.result = resultWith({ experimental: x(), recordingPlan: plan(), candidateDecisions: decisions() });
        v2.state = "done";
        const { container, unmount } = mountComponent(AutotuneV2Panel, {
            parts: ["recordingPlan"],
            title: "Plan box",
        });
        await flush();
        expect(container.textContent).toContain("Plan box");
        expect(container.querySelector('[data-gyrocore="v2-recording-plan"]')).not.toBeNull();
        for (const sel of [
            '[data-gyrocore="v2-calculate"]',
            '[data-gyrocore="v2-apply"]',
            '[data-gyrocore="v2-experimental-apply"]',
            '[data-gyrocore="v2-decisions"]',
            '[data-step="v2-verify"]',
            '[data-step="v2-restore"]',
        ]) {
            expect(container.querySelector(sel), sel).toBeNull();
        }
        unmount();
    });

    it("the tuning section keeps the experimental route's acknowledgement, Apply, verify and restore together", async () => {
        const v2 = useAutotuneV2Store();
        v2.result = resultWith({ experimental: x(), recordingPlan: plan(), candidateDecisions: decisions() });
        v2.state = "done";
        useAutotuneSectionStore().open("tuning");
        const { container, unmount } = mountComponent(AutotuneTab);
        await flush();
        const content = container.querySelector('[data-gyroflight="autotune-section"]')!;
        for (const sel of [
            '[data-gyrocore="v2-compare"], [data-gyrocore="v2-no-change"]',
            '[data-gyrocore="v2-preview"]',
            '[data-gyrocore="v2-apply"]',
            '[data-gyrocore="v2-experimental-ack"]',
            '[data-gyrocore="v2-experimental-apply"]',
            '[data-step="v2-verify"]',
            '[data-step="v2-restore"]',
        ]) {
            expect(content.querySelector(sel), sel).not.toBeNull();
        }
        // The plan lives in its own section.
        expect(content.querySelector('[data-gyrocore="v2-recording-plan"]')).toBeNull();
        unmount();
    });
});

describe("Autotune overview", () => {
    it("without a log: says so, and no axis claims a measurement or a value", async () => {
        const { container, unmount } = mountComponent(AutotuneOverview);
        await flush();
        expect(container.querySelector('[data-gyrocore="overview-no-log"]')).not.toBeNull();
        const rows = [...container.querySelectorAll('[data-gyrocore="overview-axes"] tbody tr')];
        expect(rows.map((r) => r.getAttribute("data-measurement"))).toEqual(["none", "none", "none"]);
        expect(rows.map((r) => r.getAttribute("data-tuning"))).toEqual([
            "not_calculated",
            "not_calculated",
            "not_calculated",
        ]);
        expect(rows.map((r) => r.getAttribute("data-apply"))).toEqual(["nothing", "nothing", "nothing"]);
        unmount();
    });

    it("keeps measurement, tuning result and Apply apart per axis, with the deciding check and next step", async () => {
        await importLog();
        const v2 = useAutotuneV2Store();
        v2.result = resultWith({
            // The fixture proposes p_roll and d_roll (and a global filter value).
            experimental: experimentalFixture(),
            experimentalWithheld: [{ key: "pid_pitch", part: "pid", source: "primary_route", reasons: ["x"] }],
            recordingPlan: {
                axes: [
                    planAxis(
                        "roll",
                        "search_limit",
                        {
                            route: "jio",
                            status: "search_limit_max_step",
                            rule: "candidate_search_measured_margins",
                            value: "best PM 29° (P 39, I 55, D 27); P/I/D within ±30 %",
                            threshold: "PM ≥ 45°",
                        },
                        "roll: the jio plant is usable and the best candidate lies on the ±30 % step edge.",
                    ),
                    planAxis(
                        "pitch",
                        "record",
                        {
                            route: "primary",
                            status: "plant_band_insufficient",
                            rule: "decision_band_gaps",
                            value: 3,
                            threshold: "0 unidentified bins",
                        },
                        "pitch note",
                    ),
                ],
            },
        });
        v2.state = "done";
        const opened: string[] = [];
        const { container, unmount } = mountComponent(AutotuneOverview, {
            onOpen: (s: string) => opened.push(s),
        });
        await flush();
        expect(container.querySelector('[data-gyrocore="overview-flight"]')!.textContent).toContain("air65.bbl");

        const row = (axis: string) => container.querySelector(`[data-gyrocore="overview-axes"] [data-axis="${axis}"]`)!;
        // Measurement: the selected CHIRP sweep's own state, apart from any tuning outcome.
        expect(["usable", "usable_with_warnings"]).toContain(row("roll").getAttribute("data-measurement"));
        expect(row("roll").getAttribute("data-tuning")).toBe("experimental");
        expect(row("roll").getAttribute("data-apply")).toBe("experimental");
        expect(row("roll").textContent).toContain("p_roll");
        expect(row("pitch").getAttribute("data-tuning")).toBe("withheld");
        expect(row("pitch").getAttribute("data-apply")).toBe("nothing");
        expect(row("yaw").getAttribute("data-tuning")).toBe("no_change");

        const reason = (axis: string) =>
            container.querySelector(`[data-gyrocore="overview-reasons"] [data-axis="${axis}"]`)!;
        // The measured value reaches the screen as text (no HTML escaping of "/").
        expect(reason("roll").textContent).toContain("P/I/D within ±30 %");
        expect(reason("roll").textContent).not.toContain("&#x2F;");
        expect(reason("roll").textContent).toContain("the jio plant is usable");
        expect(reason("roll").getAttribute("data-kind")).toBe("search_limit");
        expect(reason("pitch").textContent).toContain("decision_band_gaps: 3");
        expect(reason("pitch").textContent).toContain("gyroflightOverviewNextRecord");
        expect(reason("yaw").textContent).toContain("gyroflightOverviewNoDecision");

        (container.querySelector('[data-gyrocore="overview-open-plan"]') as HTMLButtonElement).click();
        await flush();
        expect(opened).toEqual(["plan"]);
        unmount();
    });

    it("a VALIDATED releasable value is reported as such, with the released Apply", async () => {
        const v2 = useAutotuneV2Store();
        v2.result = resultWith({
            releasableProposal: { items: [{ key: "p_yaw", from: 56, to: 50, status: "VALIDATED", reasons: [] }] },
        });
        v2.state = "done";
        const { container, unmount } = mountComponent(AutotuneOverview);
        await flush();
        const yaw = container.querySelector('[data-gyrocore="overview-axes"] [data-axis="yaw"]')!;
        expect(yaw.getAttribute("data-tuning")).toBe("validated");
        expect(yaw.getAttribute("data-apply")).toBe("released");
        expect(yaw.textContent).toContain("p_yaw 56 → 50");
        unmount();
    });
});
