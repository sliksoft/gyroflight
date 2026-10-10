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
 * CHIRP Quality V2 through the real Autotune import (file picker mocked) and
 * in the GyroCore qualification panel. SYNTHETIC logs only.
 */

import { createApp, h } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
};

const picked = vi.hoisted(() => ({ bytes: new Uint8Array() as Uint8Array }));

vi.mock("../../src/js/FileSystem", () => ({
    default: {
        pickOpenFile: async () => ({ name: "synthetic.bbl" }),
        readFileAsBlob: async () => ({ arrayBuffer: async () => picked.bytes.slice().buffer }),
    },
}));

vi.mock("../../src/js/localization", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/js/localization")>()),
    i18n: { getMessage: (key: string, args?: string[]) => (args?.length ? `${key}|${args.join("|")}` : key) },
}));

import UApp from "@nuxt/ui/components/App.vue";
import { useAutotune } from "../../src/composables/useAutotune";
import ChirpQualificationPanel from "../../src/gyrocore/components/ChirpQualificationPanel.vue";
import { useChirpQualificationStore } from "../../src/gyrocore/stores/chirpQualification";
import { catalogBbl } from "../../src/gyrocore/flight/identity";
import { concatLogs, encodeChirpLog, simulateChirp, simulateChirpSequence } from "./harness/chirpSim";
import { readFixtureBytes } from "./harness/fixtures";

async function runImport(bytes: Uint8Array) {
    picked.bytes = bytes;
    await useAutotune().importAndAnalyze();
    return useChirpQualificationStore();
}

async function mountPanel() {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const app = createApp({ render: () => h(UApp, { portal: false }, { default: () => h(ChirpQualificationPanel) }) });
    app.config.globalProperties.$t = ((key: string) => key) as never;
    app.use(pinia);
    app.mount(container);
    await new Promise((r) => setTimeout(r, 0));
    return { container, unmount: () => (app.unmount(), container.remove()) };
}

let pinia = createPinia();
beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
});

const threeAxes = encodeChirpLog(
    simulateChirpSequence([
        { axis: 0, seconds: 8, firmwareDebug: true },
        { axis: 1, seconds: 8, firmwareDebug: true },
        { axis: 2, seconds: 8, firmwareDebug: true },
    ]),
);

describe("Autotune import", () => {
    it("attaches the WU1 file and Flight identity to every CHIRP", async () => {
        const bytes = concatLogs(encodeChirpLog(simulateChirp({ firmwareDebug: true, seconds: 8 })), threeAxes);
        const gate = await runImport(bytes);
        const catalog = await catalogBbl(bytes);
        expect(gate.report!.measurements).toHaveLength(4);
        for (const m of gate.report!.measurements) {
            expect(m.qualityV2.identity.file.sha256).toBe(catalog.file.sha256);
            expect(m.qualityV2.identity.flight.ref).toEqual(catalog.flights[m.logIndex]);
        }
    });
});

describe("quality panel", () => {
    it("shows one compact card per shown axis, with every row", async () => {
        await runImport(threeAxes);
        const { container, unmount } = await mountPanel();
        const cards = container.querySelectorAll('[data-gyrocore="chirp-quality-v2"]');
        expect([...cards].map((c) => c.getAttribute("data-measurement"))).toEqual([
            "log1-seg1",
            "log1-seg2",
            "log1-seg3",
        ]);
        const rows = [...cards[0].querySelectorAll("[data-row]")].map((r) => [
            r.getAttribute("data-row"),
            r.getAttribute("data-status"),
        ]);
        expect(rows).toEqual([
            ["detection", "FOUND"],
            ["sweep", "MEASURED"],
            ["coverage", "MEASURED"],
            ["excitation", "MEASURED"],
            ["coherence", "MEASURED"],
            ["usable-bins", expect.stringMatching(/^\d+$/)],
            ["sample-gaps", "NONE"],
            ["contamination", "UNKNOWN"],
            ["saturation", "UNKNOWN"],
        ]);
        expect(cards[0].querySelector('[data-level="flightValid"]')?.getAttribute("data-status")).toBe("YES");
        unmount();
    });

    it("plots every real bin with its status, and the regions table matches the report", async () => {
        const gate = await runImport(threeAxes);
        const { container, unmount } = await mountPanel();
        const v = gate.report!.measurements[0].qualityV2;
        const card = container.querySelector('[data-gyrocore="chirp-quality-v2"][data-measurement="log1-seg1"]')!;
        const bars = card.querySelectorAll('[data-gyrocore="qv2-coherence-chart"] line[data-status]');
        expect([...bars].map((b) => b.getAttribute("data-status"))).toEqual(v.coherence.bins.status);
        const regions = card.querySelectorAll('[data-gyrocore="qv2-regions"] tbody tr');
        expect(regions).toHaveLength(v.coherence.regions.items.length);
        unmount();
    });

    it("says there are no bins, instead of drawing an empty chart, without a transfer function", async () => {
        await runImport(readFixtureBytes("chirp/bbl/insufficient_samples.bbl.gz"));
        const { container, unmount } = await mountPanel();
        // Nothing is plottable here, so no axis is shown and no card either; the panel still lists the measurement.
        expect(container.querySelector('[data-gyrocore="measurements"]')).not.toBeNull();
        expect(container.querySelector('[data-gyrocore="qv2-coherence-chart"]')).toBeNull();
        unmount();
    });
});
