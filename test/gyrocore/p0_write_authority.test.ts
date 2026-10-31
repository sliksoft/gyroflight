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
 * P0 (audit 2026-10-23): applyAbsoluteTune wrote behind the release contract alone. It now goes
 * through the write authority (releaseGate/writeAuthority.ts): analysis binding, release
 * contract, GyroCore Safety, product lock, then again right before the first SET.
 *
 * Every step can be switched between real and released (`gate.*`), so each case denies with
 * exactly one step real and all others released: a denial then shows that step alone blocks,
 * not that something else already did. The control case releases all and shows the write does
 * happen, so "no write" below means the authority stopped it. The engine's recomputation is
 * replaced by `gate.fresh` (the real engine runs in p0_write_authority_engine.test.ts).
 */

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FirmwareFc } from "./harness/mspFirmware";

const gate = vi.hoisted(() => ({
    fc: undefined as unknown as FirmwareFc,
    binding: true,
    release: true,
    safety: true,
    product: true,
    /** When set, the released Safety result is bound to this proposal id instead of the one asked about. */
    safetyFor: null as string | null,
    /** What the engine's recomputation returns as the releasable proposal; "throw" makes it fail. */
    fresh: null as unknown,
}));

vi.mock("../../src/js/msp", () => ({
    default: {
        promise: vi.fn(async (code: number, data?: number[]) =>
            (await import("./harness/mspFirmware")).firmwarePromise(gate.fc, code, data),
        ),
    },
}));
vi.mock("@/composables/useDialog", () => ({ useDialog: () => ({ showYesNo: async () => true }) }));
vi.mock("@/gyrocore/engine/autotuneV2", async () => ({
    ...(await vi.importActual<typeof import("../../src/gyrocore/engine/autotuneV2")>("@/gyrocore/engine/autotuneV2")),
    runAutotuneV2: () => {
        if (gate.fresh === "throw") throw new Error("engine failed");
        return { releasableProposal: structuredClone(gate.fresh) };
    },
}));
vi.mock("@/gyrocore/engine/logInput", async () => ({
    ...(await vi.importActual<typeof import("../../src/gyrocore/engine/logInput")>("@/gyrocore/engine/logInput")),
    pickPrimary: (logs: unknown[]) => (logs.length ? { primary: logs[0], others: logs.slice(1) } : null),
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
vi.mock("@/gyrocore/releaseGate/releaseContract", async () => {
    const actual = await vi.importActual<typeof import("../../src/gyrocore/releaseGate/releaseContract")>(
        "@/gyrocore/releaseGate/releaseContract",
    );
    return {
        ...actual,
        evaluateRelease: (p: Parameters<typeof actual.evaluateRelease>[0]) =>
            gate.release ? { released: true, conditions: [], blocks: [] } : actual.evaluateRelease(p),
    };
});
vi.mock("@/gyrocore/safety/authorize", async () => {
    const actual =
        await vi.importActual<typeof import("../../src/gyrocore/safety/authorize")>("@/gyrocore/safety/authorize");
    return {
        ...actual,
        absoluteSafetyAuthorization: (p: Parameters<typeof actual.absoluteSafetyAuthorization>[0]) =>
            gate.safety
                ? {
                      ...actual.absoluteSafetyAuthorization(p),
                      status: "PASS" as const,
                      blocks: [],
                      authorized: true,
                      proposalId: gate.safetyFor ?? p.id,
                  }
                : actual.absoluteSafetyAuthorization(p),
    };
});
vi.mock("@/gyrocore/productLock/productApply", async () => {
    const actual = await vi.importActual<typeof import("../../src/gyrocore/productLock/productApply")>(
        "@/gyrocore/productLock/productApply",
    );
    return {
        ...actual,
        productApplyBlocks: (e: Parameters<typeof actual.productApplyBlocks>[0]) =>
            gate.product ? [] : actual.productApplyBlocks(e),
    };
});

import MSPCodes from "../../src/js/msp/MSPCodes";
import {
    applyAbsoluteTune,
    previewAbsoluteRestore,
    previewAbsoluteTune,
    restoreAbsoluteTune,
    TuneWriteError,
    useTuneApply,
} from "../../src/composables/useTuneApply";
import { useAutotuneV2 } from "../../src/composables/useAutotuneV2";
import { ApplyBlockedError } from "../../src/gyrocore/chirp/applyGate";
import { useAutotuneV2Store } from "../../src/gyrocore/stores/autotuneV2";
import { useTuneBackupStore } from "../../src/gyrocore/stores/tuneBackup";
import { useVerifiedTuneStore } from "../../src/gyrocore/stores/verifiedTunes";
import { issueConfirmation, resetConfirmations } from "../../src/gyrocore/tuning/applyConfirmation";

import { absoluteWriteDecision } from "../../src/gyrocore/releaseGate/writeAuthority";
import { analysisBindingIssues, canonicalText, plainCopy } from "../../src/gyrocore/releaseGate/analysisBinding";
import {
    RELEASE_INDEPENDENT_VALIDATION_NOT_CURRENT,
    type ProductReleaseEvidence,
} from "../../src/gyrocore/productLock/productApply";
import type { AbsoluteProposal } from "../../src/gyrocore/releaseGate/releaseContract";
import type { AutotuneLogInput, AutotuneV2Result } from "../../src/gyrocore/engine/autotuneV2";
import type { AbsoluteValues } from "../../src/gyrocore/tuning/absoluteTune";
import { air65FirmwareState, createFirmwareFc, FIRMWARE_WRITE_CODES, type FirmwareState } from "./harness/mspFirmware";
import { FAULT_FREE_FIRMWARE, previewedHash } from "./harness/previewConfirmation";
import { FIXTURE_FIRMWARE, FIXTURE_UID, verifiedTuneAllAxesFixture } from "./harness/verifiedTuneFixture";

function headersFor(s: FirmwareState): [string, string][] {
    const p = s.p;
    return [
        ["Firmware revision", "Betaflight 2026.6.2 (43875a55a) STM32G474"],
        ["Board information", "BEFH BETAFPVG473"],
        ["DeviceUID", "0a1b2c3d4e5f607112233445"],
        ["rollPID", s.pids[0].join(",")],
        ["pitchPID", s.pids[1].join(",")],
        ["yawPID", s.pids[2].join(",")],
        ["ff_weight", `${p.f_roll},${p.f_pitch},${p.f_yaw}`],
        ["d_max", `${p.d_max_roll},${p.d_max_pitch},${p.d_max_yaw}`],
        ["d_max_gain", String(p.d_max_gain)],
        ["gyro_lpf1_static_hz", String(p.gyro_lpf1_static_hz)],
        ["gyro_lpf1_dyn_hz", `${p.gyro_lpf1_dyn_min_hz},${p.gyro_lpf1_dyn_max_hz}`],
        ["dterm_lpf1_static_hz", String(p.dterm_lpf1_static_hz)],
        ["dterm_lpf1_dyn_hz", `${p.dterm_lpf1_dyn_min_hz},${p.dterm_lpf1_dyn_max_hz}`],
        ["dyn_notch_count", String(p.dyn_notch_count)],
        ["dyn_notch_q", String(p.dyn_notch_q)],
        ["rpm_filter_harmonics", String(p.rpm_filter_harmonics)],
        ["rpm_filter_q", String(p.rpm_filter_q)],
        ["rpm_filter_weights", s.rpmWeights.join(",")],
    ];
}

/** A PID, a feedforward and a filter value: every kind of change the absolute route writes. */
const CHANGE: AbsoluteValues = { p_roll: 60, d_roll: 32, f_pitch: 40, dterm_lpf1_static_hz: 80 };

function proposal(change: AbsoluteValues = CHANGE, createdAt = "2026-10-22T00:00:00Z"): AbsoluteProposal {
    return {
        id: `prop-${Object.entries(change).join("|")}`,
        createdAt,
        log: { sha256: "a".repeat(64), logIndex: 0, headerPairs: headersFor(air65FirmwareState()) },
        change: { ...change },
        items: [],
        release: {
            measurement: { valid: false, reasons: ["test"] },
            model: { status: "BLOCKED", reasons: ["test"] },
            margins: [],
            independentValidation: null,
            safetyAnalysisEvidence: "not_available",
            safetyReasons: [],
        },
    };
}

/** The store as after Calculate produced `p`; the engine reproduces it unless `gate.fresh` is changed. */
function analysed(p: AbsoluteProposal) {
    const store = useAutotuneV2Store();
    store.inputs = [{ headerPairs: p.log.headerPairs } as unknown as AutotuneLogInput];
    store.result = {
        proposal: structuredClone(p),
        releasableProposal: structuredClone(p),
    } as unknown as AutotuneV2Result;
    store.state = "done";
    gate.fresh = structuredClone(p);
}

const codes = () => gate.fc.calls.map((c) => c.code);
const writes = () => codes().filter((c) => FIRMWARE_WRITE_CODES.has(c));
const backups = () => useTuneBackupStore().backups;
/** The user's confirmation of `p`, bound to the read-only preview of the craft as it is now. */
const confirm = async (p: AbsoluteProposal) =>
    issueConfirmation({
        kind: "absolute",
        proposalId: p.id,
        change: { ...p.change },
        preview: await previewedHash(gate.fc, FAULT_FREE_FIRMWARE(), () => previewAbsoluteTune(p)),
    });
const apply = async (p: AbsoluteProposal) => applyAbsoluteTune(p, await confirm(p));

async function denial(p: Promise<unknown>): Promise<ApplyBlockedError> {
    const err = await p.then(
        () => null,
        (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ApplyBlockedError);
    return err as ApplyBlockedError;
}

/** Nothing reached the craft: not one MSP request, no backup taken. */
function nothingReachedTheCraft() {
    expect(codes()).toEqual([]);
    expect(backups()).toEqual([]);
}

function failedSteps(p: AbsoluteProposal) {
    return absoluteWriteDecision(p, { recompute: true })
        .steps.filter((s) => !s.passed)
        .map((s) => s.name);
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    resetConfirmations();
    gate.fc = createFirmwareFc();
    Object.assign(gate, { binding: true, release: true, safety: true, product: true, safetyFor: null, fresh: null });
});

describe("control: with every step released the absolute route writes", () => {
    it("writes, verifies and saves (so the denials below are the authority's doing)", async () => {
        const r = await apply(proposal());
        expect(r.status).toBe("verified");
        expect(writes()).toEqual(expect.arrayContaining([MSPCodes.MSP_SET_PID, MSPCodes.MSP_EEPROM_WRITE]));
    });

    it("with the real binding too, when the proposal is the analysis's own and the engine reproduces it", async () => {
        gate.binding = false;
        const p = proposal();
        analysed(p);
        expect((await apply(p)).status).toBe("verified");
    });
});

describe("each step alone denies, before any MSP and without a backup", () => {
    const cases: [string, () => void, string, string[]][] = [
        [
            "analysis binding (no analysis at all)",
            () => (gate.binding = false),
            "analysis_binding",
            ["binding:analysis_not_done:idle"],
        ],
        ["release contract", () => (gate.release = false), "release_contract", ["measurement:measurement_invalid"]],
        [
            // WP6: Safety now evaluates absolute values (absoluteEvaluate.ts) and still never
            // authorizes while the hardware validation has not been executed.
            "GyroCore Safety (evaluated, not hardware-validated)",
            () => (gate.safety = false),
            "gyrocore_safety",
            [
                "safety:absolute_safety:validated_starting_configuration:no_verified_tune",
                "safety:absolute_safety:not_hardware_validated",
            ],
        ],
        [
            "a released Safety result bound to another proposal",
            () => (gate.safetyFor = "another-proposal"),
            "gyrocore_safety",
            ["safety:result_not_bound_to_proposal"],
        ],
        [
            "product lock",
            () => (gate.product = false),
            "product_lock",
            ["full_safety_engine_pending", "independent_pid_validation_missing"],
        ],
    ];

    it.each(cases)("%s", async (_name, close, step, reasons) => {
        close();
        const p = proposal();
        expect(failedSteps(p)).toEqual([step]);
        const err = await denial(apply(p));
        expect(err.reasons).toEqual(expect.arrayContaining(reasons));
        nothingReachedTheCraft();
    });

    it("the exported useTuneApply() object goes through the same authority", async () => {
        gate.safety = false;
        const p = proposal();
        await denial(useTuneApply().applyAbsoluteTune(p, await confirm(p)));
        nothingReachedTheCraft();
    });
});

describe("analysis binding: the proposal is the current analysis's own (composite step)", () => {
    beforeEach(() => {
        gate.binding = false;
    });

    it("a proposal from an earlier calculation is refused once the analysis was recalculated", async () => {
        const old = proposal();
        analysed(proposal(CHANGE, "2026-10-23T09:00:00Z"));
        const token = await confirm(old);
        const err = await denial(applyAbsoluteTune(old, token));
        expect(err.reasons).toEqual(["binding:proposal_differs_from_analysis"]);
        nothingReachedTheCraft();
    });

    it.each([
        ["a PID value", { p_roll: 61 }],
        ["a feedforward value", { f_pitch: 41 }],
        ["a filter value", { dterm_lpf1_static_hz: 81 }],
        ["an extra value", { i_roll: 90 }],
    ])("%s changed after the calculation is refused", async (_name, edit) => {
        const p = proposal();
        analysed(p);
        const edited = { ...p, change: { ...p.change, ...edit } };
        const err = await denial(apply(edited));
        expect(err.reasons).toEqual(["binding:proposal_differs_from_analysis"]);
        nothingReachedTheCraft();
    });

    it("evidence edited after the calculation (a qualification added to a margin) is refused", async () => {
        const p = proposal();
        analysed(p);
        const edited = structuredClone(p);
        edited.release.safetyAnalysisEvidence = "available";
        edited.release.margins = [{ axis: "roll" } as AbsoluteProposal["release"]["margins"][number]];
        await denial(apply(edited));
        nothingReachedTheCraft();
    });

    it("a stored result the engine does not reproduce from the current inputs is refused", async () => {
        const p = proposal();
        analysed(p);
        gate.fresh = proposal({ ...CHANGE, p_roll: 58 });
        const err = await denial(apply(p));
        expect(err.reasons).toEqual(["binding:analysis_not_reproduced"]);
        nothingReachedTheCraft();
    });

    it("an analysis that now produces nothing releasable is refused", async () => {
        const p = proposal();
        analysed(p);
        gate.fresh = null;
        expect((await denial(apply(p))).reasons).toEqual(["binding:analysis_not_reproduced"]);
        nothingReachedTheCraft();
    });

    it("a failing recomputation is refused, never treated as a match", async () => {
        const p = proposal();
        analysed(p);
        gate.fresh = "throw";
        expect((await denial(apply(p))).reasons).toEqual(["binding:analysis_recompute_failed"]);
        nothingReachedTheCraft();
    });

    it.each([
        [
            "a running calculation",
            () => (useAutotuneV2Store().state = "calculating"),
            "binding:analysis_not_done:calculating",
        ],
        ["a failed calculation", () => (useAutotuneV2Store().state = "error"), "binding:analysis_not_done:error"],
        ["no decoded inputs", () => (useAutotuneV2Store().inputs = null), "binding:analysis_inputs_missing"],
        [
            "no releasable proposal",
            () => (useAutotuneV2Store().result = { proposal: null, releasableProposal: null } as never),
            "binding:no_releasable_proposal",
        ],
    ])("%s is refused", async (_name, change, reason) => {
        const p = proposal();
        analysed(p);
        change();
        expect((await denial(apply(p))).reasons).toEqual([reason]);
        nothingReachedTheCraft();
    });

    it("canonical comparison tells undefined, NaN and Infinity apart from null and ignores key order", () => {
        expect(canonicalText({ a: undefined })).not.toBe(canonicalText({}));
        expect(canonicalText({ a: undefined })).not.toBe(canonicalText({ a: null }));
        expect(canonicalText({ a: NaN })).not.toBe(canonicalText({ a: null }));
        expect(canonicalText({ a: Infinity })).not.toBe(canonicalText({ a: -Infinity }));
        expect(canonicalText({ a: 1, b: { c: 2, d: 3 } })).toBe(canonicalText({ b: { d: 3, c: 2 }, a: 1 }));
        expect(canonicalText([1, 2])).not.toBe(canonicalText([2, 1]));
    });
});

describe("direct calls without valid gates", () => {
    it("a hand-built proposal with fabricated 'available' evidence is refused by every real step", async () => {
        Object.assign(gate, { binding: false, release: false, safety: false, product: false });
        const p = proposal();
        p.release = {
            measurement: { valid: true, reasons: [] },
            model: { status: "VALIDATED", reasons: [] },
            margins: [],
            independentValidation: null,
            safetyAnalysisEvidence: "available",
            safetyReasons: [],
        };
        expect(failedSteps(p)).toEqual(["analysis_binding", "release_contract", "gyrocore_safety", "product_lock"]);
        await denial(apply(p));
        nothingReachedTheCraft();
    });

    it.each([
        ["without release evidence", (p: AbsoluteProposal) => Reflect.deleteProperty(p, "release")],
        ["without its log", (p: AbsoluteProposal) => Reflect.deleteProperty(p, "log")],
    ])("a malformed proposal (%s) is refused, not crashed through", async (_name, damage) => {
        Object.assign(gate, { binding: false, release: false, safety: false, product: false });
        const p = proposal();
        damage(p);
        const err = await denial(apply(p));
        expect(err.reasons.length).toBeGreaterThan(0);
        nothingReachedTheCraft();
    });

    it("without a confirmation nothing reaches the craft even when every step is released", async () => {
        const err = await denial(applyAbsoluteTune(proposal(), null));
        expect(err.reasons).toEqual(["apply:confirmation_missing"]);
        nothingReachedTheCraft();
    });
});

describe("the authority again, right before the craft changes", () => {
    it("a step that closes during the live reads stops the Apply before the backup", async () => {
        gate.fc.disconnectWhen = (_fc, code) => {
            if (code === MSPCodes.MSP_FILTER_CONFIG) gate.safety = false;
            return false;
        };
        const err = await denial(apply(proposal()));
        expect(err.reasons).toEqual(expect.arrayContaining(["safety:absolute_safety:not_hardware_validated"]));
        expect(writes()).toEqual([]);
        expect(backups()).toEqual([]);
    });

    it("a step that closes after the backup stops the Apply before the first SET (stage prepare, nothing saved)", async () => {
        gate.fc.disconnectWhen = () => {
            if (useTuneBackupStore().backups.length) gate.product = false;
            return false;
        };
        const err = await proposalFailure(apply(proposal()));
        expect(err).toBeInstanceOf(TuneWriteError);
        expect(err).toMatchObject({ stage: "prepare", saved: "no" });
        expect(err.message).toContain("full_safety_engine_pending");
        expect(writes()).toEqual([]);
    });

    it("a recalculation during the reads (the binding no longer holds) stops the Apply", async () => {
        gate.binding = false;
        const p = proposal();
        analysed(p);
        gate.fc.disconnectWhen = (_fc, code) => {
            if (code === MSPCodes.MSP_PID) useAutotuneV2Store().state = "calculating";
            return false;
        };
        const err = await denial(apply(p));
        expect(err.reasons).toEqual(["binding:analysis_not_done:calculating"]);
        expect(writes()).toEqual([]);
    });
});

describe("craft and configuration are checked against the log on the click", () => {
    it.each([
        ["another craft", (fc: FirmwareFc) => (fc.uid = [1, 2, 3]), "fc:identity_uid_mismatch"],
        ["armed", (fc: FirmwareFc) => (fc.armed = true), "fc:armed"],
        [
            "a live PID that is not the logged one",
            (fc: FirmwareFc) => (fc.ram.pids[0][0] = 57),
            "fc:live_differs_from_log:p_roll",
        ],
    ])("%s: refused with every gate released, nothing written", async (_name, change, reason) => {
        change(gate.fc);
        const err = await denial(apply(proposal()));
        expect(err.reasons).toContain(reason);
        expect(writes()).toEqual([]);
        expect(backups()).toEqual([]);
    });
});

describe("a partial transaction is never shown as a successful Apply", () => {
    it("a SET that fails after an earlier one was accepted: write error, no EEPROM, not verified", async () => {
        gate.fc.faultsAfterWrites = [{ after: 1, code: MSPCodes.MSP_SET_PID_ADVANCED, fault: "timeout" }];
        const err = await proposalFailure(apply(proposal()));
        expect(err).toBeInstanceOf(TuneWriteError);
        expect(err).toMatchObject({ stage: "write" });
        expect(codes()).not.toContain(MSPCodes.MSP_EEPROM_WRITE);
    });
});

describe("product lock: the Verified Tune this browser holds now", () => {
    const base = async (): Promise<(e: ProductReleaseEvidence) => string[]> =>
        (
            await vi.importActual<typeof import("../../src/gyrocore/productLock/productApply")>(
                "@/gyrocore/productLock/productApply",
            )
        ).productApplyBlocks;
    const craft = { uid: FIXTURE_UID, firmware: FIXTURE_FIRMWARE };

    it("a record the proposal carries but the browser no longer holds (deleted, replaced) blocks", async () => {
        const blocks = await base();
        const stored = verifiedTuneAllAxesFixture(0.9, 0.7);
        const other = verifiedTuneAllAxesFixture(0.8, 0.7);
        expect(stored.id).not.toBe(other.id);
        const evidence = { safetyAnalysisEvidence: "available", independentPidValidation: stored, craft };
        expect(blocks(evidence)).toEqual([]);
        expect(blocks({ ...evidence, carriedPidValidation: stored })).toEqual([]);
        expect(blocks({ ...evidence, carriedPidValidation: other })).toEqual([
            RELEASE_INDEPENDENT_VALIDATION_NOT_CURRENT,
        ]);
        expect(blocks({ ...evidence, independentPidValidation: null, carriedPidValidation: stored })).toEqual(
            expect.arrayContaining(["independent_pid_validation_missing", RELEASE_INDEPENDENT_VALIDATION_NOT_CURRENT]),
        );
    });

    it("the write path takes the stored record, not the carried one", async () => {
        gate.product = false;
        const p = proposal();
        p.release.independentValidation = verifiedTuneAllAxesFixture(0.9, 0.7);
        expect(useVerifiedTuneStore().records).toEqual([]);
        const err = await denial(apply(p));
        expect(err.reasons).toEqual(
            expect.arrayContaining(["independent_pid_validation_missing", RELEASE_INDEPENDENT_VALIDATION_NOT_CURRENT]),
        );
        nothingReachedTheCraft();
    });
});

describe("the interface offers Apply only when the authority allows it", () => {
    it("releasedProposal() is null while any step denies and the proposal once all hold", () => {
        Object.assign(gate, { binding: false, safety: false });
        const p = proposal();
        analysed(p);
        const ui = useAutotuneV2();
        expect(ui.releasedProposal()).toBeNull();
        gate.safety = true;
        expect(ui.releasedProposal()).toEqual(p);
        gate.product = false;
        expect(ui.releasedProposal()).toBeNull();
    });
});

async function proposalFailure(p: Promise<unknown>): Promise<Error & { stage?: string; saved?: string }> {
    return p.then(
        () => {
            throw new Error("expected the Apply to fail");
        },
        (e: unknown) => e as Error,
    );
}

// Negative cases designed by the independent review (Codex, 2026-10-23) against 63a7e2df.
describe("independent review: attempts to get past the authority", () => {
    it("a proposal shared with the store and changed after the confirmation is refused before any write", async () => {
        gate.binding = false;
        analysed(proposal());
        const p = useAutotuneV2Store().result!.releasableProposal!;
        const token = await confirm(p);
        let changed = false;
        gate.fc.disconnectWhen = (_fc, code) => {
            if (!changed && code === MSPCodes.MSP_API_VERSION) {
                changed = true;
                p.change.p_roll = 61;
            }
            return false;
        };
        const err = await denial(applyAbsoluteTune(p, token));
        expect(err.reasons).toEqual(["binding:proposal_differs_from_analysis"]);
        expect(writes()).toEqual([]);
        expect(gate.fc.ram.pids[0][0]).not.toBe(61);
    });

    it("decoded inputs that vanish after the backup stop the Apply before the first SET", async () => {
        gate.binding = false;
        const p = proposal();
        analysed(p);
        let changed = false;
        gate.fc.disconnectWhen = () => {
            if (!changed && backups().length > 0) {
                changed = true;
                useAutotuneV2Store().inputs = null;
                gate.fresh = null;
            }
            return false;
        };
        const err = await proposalFailure(apply(p));
        expect(err).toMatchObject({ stage: "prepare", saved: "no" });
        expect(err.message).toContain("binding:analysis_changed_since_authorization");
        expect(writes()).toEqual([]);
    });

    it("a result replaced by an identical recalculation after the authorization stops the Apply", async () => {
        gate.binding = false;
        const p = proposal();
        analysed(p);
        gate.fc.disconnectWhen = (_fc, code) => {
            if (code === MSPCodes.MSP_PID) analysed(p);
            return false;
        };
        const err = await denial(apply(p));
        expect(err.reasons).toEqual(["binding:analysis_changed_since_authorization"]);
        expect(writes()).toEqual([]);
    });

    it("decoded inputs emptied in place during the live reads stop the Apply (round 2)", async () => {
        gate.binding = false;
        const p = proposal();
        analysed(p);
        let changed = false;
        gate.fc.disconnectWhen = (_fc, code) => {
            if (!changed && code === MSPCodes.MSP_PID) {
                changed = true;
                // Production publishes the inputs frozen; the binding must catch an in-place edit regardless.
                (useAutotuneV2Store().inputs as AutotuneLogInput[]).length = 0;
                gate.fresh = null;
            }
            return false;
        };
        const err = await denial(apply(p));
        expect(err.reasons).toEqual(["binding:analysis_changed_since_authorization"]);
        expect(writes()).toEqual([]);
    });

    it("a decoded input replaced in place during the live reads stops the Apply (round 2)", async () => {
        gate.binding = false;
        const p = proposal();
        analysed(p);
        gate.fc.disconnectWhen = (_fc, code) => {
            if (code === MSPCodes.MSP_PID) {
                const inputs = useAutotuneV2Store().inputs as AutotuneLogInput[];
                inputs[0] = { ...inputs[0] };
            }
            return false;
        };
        const err = await denial(apply(p));
        expect(err.reasons).toEqual(["binding:analysis_changed_since_authorization"]);
        expect(writes()).toEqual([]);
    });

    it("a sparse array whose hole is filled by a named property is not plain data (round 2)", () => {
        const malformed: unknown[] = [1, , 3];
        Object.defineProperty(malformed, "extra", { value: 2, enumerable: true });
        expect(() => canonicalText(malformed)).toThrow(TypeError);
        expect(() => plainCopy(malformed)).toThrow(TypeError);
        const named: unknown[] = [1, 2];
        Object.defineProperty(named, "x", { value: 3, enumerable: true });
        expect(() => canonicalText(named)).toThrow(TypeError);
    });

    it("a proposal whose toJSON impersonates the analysis is refused", async () => {
        gate.binding = false;
        const original = proposal();
        analysed(original);
        const forged = structuredClone(original);
        forged.change.p_roll = 250;
        Object.defineProperty(forged, "toJSON", { value: () => original });
        expect(() => analysisBindingIssues(forged, { recompute: true })).toThrow(TypeError);
        expect(failedSteps(forged)).toContain("analysis_binding");
        const err = await denial(applyAbsoluteTune(forged, await confirm(forged)));
        expect(err.reasons).toEqual(["apply:proposal_not_plain_data"]);
        nothingReachedTheCraft();
    });

    it("a proposal with a getter or a function inside is refused before any MSP", async () => {
        const p = proposal();
        Object.defineProperty(p.change, "p_roll", { get: () => 60, enumerable: true });
        (p as unknown as { hook: () => void }).hook = () => undefined;
        const err = await denial(apply(p));
        expect(err.reasons).toEqual(["apply:proposal_not_plain_data"]);
        nothingReachedTheCraft();
    });

    it("a Verified Tune lookup that throws denies (product_lock:evaluation_failed), nothing reaches the craft", async () => {
        gate.product = false;
        const spy = vi.spyOn(useVerifiedTuneStore(), "forCraft").mockImplementation(() => {
            throw new Error("store failure");
        });
        try {
            const err = await denial(apply(proposal()));
            expect(err.reasons).toContain("product_lock:evaluation_failed");
            nothingReachedTheCraft();
        } finally {
            spy.mockRestore();
        }
    });

    it("one token, two concurrent Applies: the second is refused", async () => {
        const p = proposal();
        const token = await confirm(p);
        const first = applyAbsoluteTune(p, token);
        const second = applyAbsoluteTune(p, token);
        // WP8: the origin's write lock refuses it now, before it could reach the token.
        expect((await denial(second)).reasons).toEqual(["fc:write_lock_busy"]);
        expect((await first).status).toBe("verified");
        // The token stays single-use: the first Apply used it.
        expect((await denial(applyAbsoluteTune(p, token))).reasons).toEqual(["apply:confirmation_unknown_or_used"]);
    });

    it("a proposal carrying a Verified Tune from the reactive store is copied, not refused", async () => {
        const { reactive } = await import("vue");
        const p = proposal();
        const records = reactive({ list: [verifiedTuneAllAxesFixture(0.9, 0.7)] });
        p.release.independentValidation = records.list.filter(() => true)[0];
        expect(() => structuredClone(p)).toThrow();
        const copy = plainCopy(p);
        expect(canonicalText(copy)).toBe(canonicalText(p));
        copy.release.independentValidation!.id = "changed";
        expect(p.release.independentValidation!.id).not.toBe("changed");
        expect((await apply(p)).status).toBe("verified");
    });

    it("canonical text cannot be made to collide or to read through accessors", () => {
        expect(canonicalText(undefined)).not.toBe(canonicalText("\u0000undefined"));
        expect(canonicalText(NaN)).not.toBe(canonicalText("\u0000number:NaN"));
        expect(canonicalText(1)).not.toBe(canonicalText("1"));
        expect(canonicalText(null)).not.toBe(canonicalText("null"));
        const withGetter = {};
        Object.defineProperty(withGetter, "a", { get: () => 1, enumerable: true });
        expect(() => canonicalText(withGetter)).toThrow(TypeError);
        expect(() => canonicalText(new Map())).toThrow(TypeError);
        expect(() => canonicalText(new Float64Array(2))).toThrow(TypeError);
        expect(() => canonicalText([1, , 3])).toThrow(TypeError);
        expect(() => canonicalText({ f: () => 1 })).toThrow(TypeError);
    });
});

describe("Restore writes what the user confirmed", () => {
    async function seed() {
        const res = await apply(proposal());
        const pv = await previewAbsoluteRestore(res.backupId);
        const token = issueConfirmation({ kind: "restore", backupId: res.backupId, preview: pv.hash });
        gate.fc.calls = [];
        return { backupId: res.backupId, token };
    }

    it("a backup target replaced after the preview is refused, nothing written", async () => {
        const { backupId, token } = await seed();
        const store = useTuneBackupStore();
        const changed = structuredClone(store.get(backupId)!);
        changed.absolute!.values.p_roll = 61;
        expect(store.save(changed)).toBe(true);
        const err = await denial(restoreAbsoluteTune(backupId, token));
        expect(err.reasons).toEqual(["restore:preview_changed"]);
        expect(writes()).toEqual([]);
    });

    it("a backup replaced in storage while the Restore runs does not change what is written", async () => {
        const { backupId, token } = await seed();
        const store = useTuneBackupStore();
        const original = store.get(backupId)!.absolute!.values.p_roll;
        gate.fc.disconnectWhen = (_fc, code) => {
            if (code === MSPCodes.MSP_SET_SIMPLIFIED_TUNING) {
                const changed = structuredClone(store.get(backupId)!);
                changed.absolute!.values.p_roll = 61;
                store.save(changed);
            }
            return false;
        };
        const r = await restoreAbsoluteTune(backupId, token);
        expect(r.status).toBe("verified");
        expect(store.get(backupId)!.absolute!.values.p_roll).toBe(61);
        expect(gate.fc.ram.pids[0][0]).toBe(original);
    });
});
