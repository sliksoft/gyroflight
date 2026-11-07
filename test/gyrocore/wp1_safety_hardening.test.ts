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
 * WP1 safety hardening (2026-10-24), on the P0 harness (p0_write_authority.test.ts): the residual
 * findings of the P0 review. A confirmation without the preview hash is refused on every route; a
 * refusal at the last check, or a failed SET on a craft that can no longer be read, leaves no
 * proposal value in the shared FC store (where the PID tab's Save would write it); a decoded input
 * deleted in place is seen by the recheck.
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
    previewAbsoluteTune,
    restoreAbsoluteTune,
    TuneWriteError,
} from "../../src/composables/useTuneApply";
import { ApplyBlockedError } from "../../src/gyrocore/chirp/applyGate";
import { useAutotuneV2Store } from "../../src/gyrocore/stores/autotuneV2";
import { useTuneBackupStore } from "../../src/gyrocore/stores/tuneBackup";
import {
    consumeConfirmation,
    issueConfirmation,
    resetConfirmations,
} from "../../src/gyrocore/tuning/applyConfirmation";
import { useFlightControllerStore } from "../../src/stores/fc";
import { valuesFromStore } from "../../src/gyrocore/tuning/absoluteTune";

import type { AbsoluteProposal } from "../../src/gyrocore/releaseGate/releaseContract";
import type { AutotuneLogInput, AutotuneV2Result } from "../../src/gyrocore/engine/autotuneV2";
import type { AbsoluteValues } from "../../src/gyrocore/tuning/absoluteTune";
import { air65FirmwareState, createFirmwareFc, FIRMWARE_WRITE_CODES, type FirmwareState } from "./harness/mspFirmware";
import { FAULT_FREE_FIRMWARE, previewedHash } from "./harness/previewConfirmation";

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

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    resetConfirmations();
    gate.fc = createFirmwareFc();
    Object.assign(gate, { binding: true, release: true, safety: true, product: true, safetyFor: null, fresh: null });
});

const storeValues = () => {
    const fc = useFlightControllerStore();
    return valuesFromStore(
        {
            pids: fc.pids,
            advancedTuning: fc.advancedTuning as unknown as Record<string, unknown>,
            filterConfig: fc.filterConfig as unknown as Record<string, unknown>,
        },
        gate.fc.apiVersion,
    );
};

describe("every route needs the preview hash in its confirmation", () => {
    it.each([
        ["absent", undefined],
        ["empty", ""],
    ])("an absolute Apply with the hash %s is refused before any MSP", async (_name, preview) => {
        const p = proposal();
        const token = issueConfirmation({
            kind: "absolute",
            proposalId: p.id,
            change: { ...p.change },
            preview: preview as unknown as string,
        });
        const err = await denial(applyAbsoluteTune(p, token));
        expect(err.reasons).toEqual(["apply:confirmation_without_preview"]);
        nothingReachedTheCraft();
    });

    it("an absolute Restore with no preview hash is refused before any write", async () => {
        const res = await apply(proposal());
        gate.fc.calls = [];
        const token = issueConfirmation({ kind: "restore", backupId: res.backupId } as never);
        const err = await denial(restoreAbsoluteTune(res.backupId, token));
        expect(err.reasons).toEqual(["apply:confirmation_without_preview"]);
        expect(codes()).toEqual([]);
    });

    it("the token check itself, for every kind: a matching subject without a hash is not a confirmation", () => {
        for (const subject of [
            { kind: "apply", compositeId: "c", sliders: { a: 1 } },
            { kind: "absolute", proposalId: "p", change: { p_roll: 1 } },
            { kind: "restore", backupId: "b" },
        ] as const) {
            const token = issueConfirmation(subject as never);
            expect(() => consumeConfirmation(token, subject)).toThrow(/confirmation_without_preview/);
        }
    });
});

describe("no proposal value stays in the shared FC store after a refused or failed write", () => {
    it("the last check refuses at the first SET: the store holds the craft's values, not the proposal's", async () => {
        const p = proposal();
        const live = (await previewAbsoluteTune(p)).before;
        gate.fc.calls = [];
        gate.fc.disconnectWhen = () => {
            if (useTuneBackupStore().backups.length) gate.product = false;
            return false;
        };
        const err = await proposalFailure(apply(p));
        expect(err).toMatchObject({ stage: "prepare", saved: "no" });
        expect(writes()).toEqual([]);
        const now = storeValues();
        for (const key of Object.keys(CHANGE)) expect(now[key]).toBe(live.values[key]);
        expect(
            pick(
                useFlightControllerStore().tuningSliders as unknown as Record<string, unknown>,
                Object.keys(live.sliders),
            ),
        ).toEqual(live.sliders);
    });

    it("the craft stops answering at a SET: the store holds the backup, not the proposal", async () => {
        const p = proposal();
        const live = (await previewAbsoluteTune(p)).before;
        gate.fc.calls = [];
        gate.fc.disconnectWhen = (_fc, code) => code === MSPCodes.MSP_SET_PID;
        const err = await proposalFailure(apply(p));
        expect(err).toMatchObject({ stage: "write", saved: "no", changedFromBackup: null });
        const now = storeValues();
        for (const key of Object.keys(CHANGE)) expect(now[key]).toBe(live.values[key]);
    });
});

describe("the recheck sees a decoded input deleted in place", () => {
    it("a hole left by delete (same length) stops the Apply before any write", async () => {
        gate.binding = false;
        const p = proposal();
        analysed(p);
        gate.fc.disconnectWhen = (_fc, code) => {
            if (code === MSPCodes.MSP_PID) {
                // Production publishes the inputs frozen; the binding must catch an in-place edit regardless.
                delete (useAutotuneV2Store().inputs as AutotuneLogInput[])[0];
            }
            return false;
        };
        const err = await denial(apply(p));
        expect(err.reasons).toEqual(["binding:analysis_changed_since_authorization"]);
        expect(writes()).toEqual([]);
    });
});

async function proposalFailure(p: Promise<unknown>): Promise<TuneWriteError> {
    const err = await p.then(
        () => null,
        (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TuneWriteError);
    return err as TuneWriteError;
}

function pick(o: Record<string, unknown>, keys: string[]) {
    return Object.fromEntries(keys.map((k) => [k, o[k]]));
}
