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
 * P0 write authority with the real engine and the real release contract (synthetic logs; the
 * model-class qualification is SIMULATED, as in autotune_v2_end_to_end.test.ts, since the app has
 * no producer for it). GyroCore Safety and the product lock are released by their harnesses so
 * that the binding and the release contract are what decide; `gate.binding` switches the
 * binding between real and released.
 *
 * The control case writes the qualified proposal when the binding is released, so each denial
 * below is the named step's.
 */

import { createPinia, setActivePinia } from "pinia";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FirmwareFc } from "./harness/mspFirmware";

const gate = vi.hoisted(() => ({ fc: undefined as unknown as FirmwareFc, binding: true }));

vi.mock("../../src/js/msp", () => ({
    default: {
        promise: vi.fn(async (code: number, data?: number[]) =>
            (await import("./harness/mspFirmware")).firmwarePromise(gate.fc, code, data),
        ),
    },
}));
vi.mock("@/gyrocore/releaseGate/analysisBinding", async () => {
    const actual = await vi.importActual<typeof import("../../src/gyrocore/releaseGate/analysisBinding")>(
        "@/gyrocore/releaseGate/analysisBinding",
    );
    return {
        ...actual,
        analysisBindingIssues: (...a: Parameters<typeof actual.analysisBindingIssues>) =>
            gate.binding ? [] : actual.analysisBindingIssues(...a),
    };
});
vi.mock("@/gyrocore/safety/authorize", async () => (await import("./harness/safetyRelease")).releasedSafety());
vi.mock("@/gyrocore/productLock/productApply", async () =>
    (await import("./harness/productRelease")).releasedProductApply(),
);

import { applyAbsoluteTune } from "../../src/composables/useTuneApply";
import { ApplyBlockedError } from "../../src/gyrocore/chirp/applyGate";
import { runAutotuneV2, type AutotuneV2Result } from "../../src/gyrocore/engine/autotuneV2";
import { evaluateRelease, type AbsoluteProposal } from "../../src/gyrocore/releaseGate/releaseContract";
import { analysisBindingIssues, currentAnalysisInput } from "../../src/gyrocore/releaseGate/analysisBinding";
import { useAutotuneV2Store } from "../../src/gyrocore/stores/autotuneV2";
import { useTuneBackupStore } from "../../src/gyrocore/stores/tuneBackup";
import { useVerifiedTuneStore } from "../../src/gyrocore/stores/verifiedTunes";
import { issueConfirmation, resetConfirmations } from "../../src/gyrocore/tuning/applyConfirmation";
import { createFirmwareFc, FIRMWARE_WRITE_CODES } from "./harness/mspFirmware";
import { simulatedQualificationLog, syntheticLogInput } from "./harness/syntheticLog";
import { verifiedTuneAllAxesFixture } from "./harness/verifiedTuneFixture";

const AT = "2026-10-22T00:00:00Z";
const record = () => verifiedTuneAllAxesFixture(0.9, 0.7);
const primary = syntheticLogInput("e".repeat(64));
const repeat = syntheticLogInput("f".repeat(64));
let qualified: AutotuneV2Result;

beforeAll(() => {
    qualified = runAutotuneV2({
        primary,
        others: [repeat],
        verifiedTune: record(),
        // SIMULATION: a synthetic finer second flight qualifies the margins' model class.
        modelClassQualification: simulatedQualificationLog(),
        createdAt: AT,
    });
}, 600_000);

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    resetConfirmations();
    gate.fc = createFirmwareFc();
    gate.binding = true;
});

const writes = () => gate.fc.calls.map((c) => c.code).filter((c) => FIRMWARE_WRITE_CODES.has(c));
const apply = (p: AbsoluteProposal) =>
    applyAbsoluteTune(p, issueConfirmation({ kind: "absolute", proposalId: p.id, change: { ...p.change } }));

async function denial(p: Promise<unknown>): Promise<ApplyBlockedError> {
    const err = await p.then(
        () => null,
        (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApplyBlockedError);
    return err as ApplyBlockedError;
}

function nothingReachedTheCraft() {
    expect(gate.fc.calls).toEqual([]);
    expect(useTuneBackupStore().backups).toEqual([]);
}

/** The qualified proposal with every axis' qualification replaced by `q(old)`. */
function withQualification(
    q: (old: Record<string, unknown>, p: AbsoluteProposal) => Record<string, unknown> | null,
): AbsoluteProposal {
    const p = structuredClone(qualified.releasableProposal!);
    for (const m of p.release.margins) {
        const ev = m.evidence as unknown as { qualification: Record<string, unknown> | null };
        ev.qualification = q(ev.qualification!, p);
    }
    return p;
}

describe("control", () => {
    it("the qualified proposal passes the real release contract and is written when the binding is released", async () => {
        const p = qualified.releasableProposal!;
        expect(evaluateRelease(p)).toMatchObject({ released: true, blocks: [] });
        expect((await apply(p)).status).toBe("verified");
        expect(writes().length).toBeGreaterThan(0);
    });
});

describe("model-class qualification at the write point (real release contract)", () => {
    it("missing: refused, nothing reaches the craft", async () => {
        const err = await denial(apply(withQualification(() => null)));
        expect(err.reasons.some((r) => r.includes("model_class_qualification_missing"))).toBe(true);
        nothingReachedTheCraft();
    });

    it.each([
        ["verdict FAIL", (q: Record<string, unknown>) => ({ ...q, verdict: "FAIL" }), "model_class_qualification_fail"],
        [
            "verdict INSUFFICIENT",
            (q: Record<string, unknown>) => ({ ...q, verdict: "INSUFFICIENT" }),
            "model_class_qualification_insufficient",
        ],
        [
            "taken from the proposal's own log",
            (q: Record<string, unknown>, p: AbsoluteProposal) => ({
                ...q,
                source: { sha256: p.log.sha256, logIndex: p.log.logIndex },
            }),
            "model_class_qualification_is_proposal_log",
        ],
        [
            "not finer than the measurement",
            (q: Record<string, unknown>) => ({ ...q, resolutionHz: 100 }),
            "model_class_qualification_not_finer",
        ],
    ])("invalid (%s): refused, nothing reaches the craft", async (_name, edit, reason) => {
        const err = await denial(apply(withQualification(edit)));
        expect(err.reasons.some((r) => r.includes(reason))).toBe(true);
        nothingReachedTheCraft();
    });
});

describe("analysis binding with the real engine", () => {
    it("a qualified proposal put into the store is not what the app's own analysis computes: refused", async () => {
        gate.binding = false;
        const store = useAutotuneV2Store();
        expect(useVerifiedTuneStore().save(record())).toBe(true);
        store.inputs = [primary, repeat];
        store.result = qualified;
        store.state = "done";
        // The app's input carries no model-class qualification (no producer exists).
        expect(currentAnalysisInput()?.modelClassQualification).toBeUndefined();
        const p = qualified.releasableProposal!;
        expect(analysisBindingIssues(p, { recompute: false })).toEqual([]);
        const err = await denial(apply(p));
        expect(err.reasons).toEqual(["binding:analysis_not_reproduced"]);
        nothingReachedTheCraft();
    }, 600_000);

    it("a qualification changed after the calculation no longer matches the analysis: refused", async () => {
        gate.binding = false;
        const store = useAutotuneV2Store();
        store.inputs = [primary, repeat];
        store.result = qualified;
        store.state = "done";
        const edited = withQualification((q) => ({ ...q, phaseMarginDeg: Number(q.phaseMarginDeg) + 10 }));
        const err = await denial(apply(edited));
        expect(err.reasons).toContain("binding:proposal_differs_from_analysis");
        nothingReachedTheCraft();
    });
});
