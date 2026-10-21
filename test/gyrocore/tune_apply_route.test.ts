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
 * The Apply / Verify / Restore route (src/composables/useTuneApply.ts) against a
 * simulated Betaflight FC (harness/mspCraft.ts). Composite gate, Safety and the
 * product release are released by their explicit test harnesses so the route behind
 * them is reachable; with GF-1 every real composite is held at its current sliders,
 * so the composite handed to the route carries a changed `final` (route.change).
 * Each case states what reaches the craft: reads only, a write that is not saved,
 * or a verified, saved write.
 */

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Craft } from "./harness/mspCraft";

const route = vi.hoisted(() => ({
    craft: undefined as unknown as Craft,
    change: null as null | Record<string, number>,
    picked: new Uint8Array() as Uint8Array,
}));

// The Apply route checks the craft against the log's DeviceUID / board: give these logs one.
vi.mock("./harness/chirpSim", async (importOriginal) =>
    (await importOriginal<typeof import("./harness/chirpSim")>()).withIdentityHeaders(
        await importOriginal<typeof import("./harness/chirpSim")>(),
    ),
);
vi.mock("../../src/js/FileSystem", () => ({
    default: {
        pickOpenFile: async () => ({ name: "route.bbl" }),
        readFileAsBlob: async () => ({ arrayBuffer: async () => route.picked.slice().buffer }),
    },
}));
vi.mock("../../src/js/localization", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/js/localization")>()),
    i18n: { getMessage: (key: string) => key },
}));
vi.mock("../../src/js/msp", () => ({
    default: {
        promise: vi.fn(async (code: number, data?: number[]) =>
            (await import("./harness/mspCraft")).craftPromise(route.craft, code, data),
        ),
    },
}));
vi.mock("@/gyrocore/productLock/productApply", async () =>
    (await import("./harness/productRelease")).releasedProductApply(),
);
vi.mock("@/gyrocore/safety/authorize", async () => (await import("./harness/safetyRelease")).releasedSafety());
// The real composite gate, with the composite's final replaced by route.change (see above).
vi.mock("@/gyrocore/tuning/authorize", async () => {
    const actual =
        await vi.importActual<typeof import("../../src/gyrocore/tuning/authorize")>("@/gyrocore/tuning/authorize");
    const { ApplyBlockedError: Blocked } =
        await vi.importActual<typeof import("../../src/gyrocore/chirp/applyGate")>("@/gyrocore/chirp/applyGate");
    return {
        ...actual,
        assertCompositeApplyAuthorized: (...args: Parameters<typeof actual.assertCompositeApplyAuthorized>) => {
            const [state, id, sliders] = args;
            if (!route.change) {
                return actual.assertCompositeApplyAuthorized(state, id, sliders);
            }
            const held = actual.authorizeCompositeApply(state, id, undefined).composite;
            const composite = actual.assertCompositeApplyAuthorized(state, id, held?.final);
            if (JSON.stringify(sliders) !== JSON.stringify(route.change)) {
                throw new Blocked(["apply:sliders_differ_from_composite"]);
            }
            return { ...composite, final: { ...route.change } };
        },
    };
});

import MSPCodes from "../../src/js/msp/MSPCodes";
import { useConnectionStore } from "../../src/stores/connection";
import { useAutotune } from "../../src/composables/useAutotune";
import { restoreTune, TuneWriteError } from "../../src/composables/useTuneApply";
import { ApplyBlockedError } from "../../src/gyrocore/chirp/applyGate";
import { useChirpQualificationStore } from "../../src/gyrocore/stores/chirpQualification";
import { useTuneBackupStore, BACKUP_STORAGE_KEY } from "../../src/gyrocore/stores/tuneBackup";
import {
    CONFIRMATION_TTL_MS,
    issueConfirmation,
    resetConfirmations,
} from "../../src/gyrocore/tuning/applyConfirmation";
import { clearPhaseMarginForGate } from "./harness/clearPhaseMarginBlock";
import { MERGE_E2E_CASES } from "./harness/mergeE2eCases";
import { FULL_TUNE_HEADERS, simulateChirpSequence } from "./harness/chirpSim";
import {
    APPLY_IDENTITY_READS,
    APPLY_SUCCESS_SEQUENCE,
    createCraft,
    firmwareDterm,
    firmwarePids,
    WRITE_CODES,
} from "./harness/mspCraft";

const CHANGE = {
    slider_master_multiplier: 100,
    slider_pi_gain: 110,
    slider_i_gain: 100,
    slider_d_gain: 105,
    slider_feedforward_gain: 100,
    slider_dterm_filter_multiplier: 110,
};

const codes = () => route.craft.calls.map((c) => c.code);
const writes = () => codes().filter((c) => WRITE_CODES.has(c));

async function load(bytes: Uint8Array = MERGE_E2E_CASES.three_axis_agree()) {
    route.picked = bytes;
    await useAutotune().importAndAnalyze();
    const gate = useChirpQualificationStore();
    clearPhaseMarginForGate(gate);
    return gate.composite!;
}

function confirmApply(id: string, sliders: Record<string, number> = CHANGE) {
    return issueConfirmation({ kind: "apply", compositeId: id, sliders: { ...sliders } });
}

async function apply(id: string, token: string | null = confirmApply(id)) {
    return useAutotune().applyGains(CHANGE, id, token);
}

async function failure(p: Promise<unknown>) {
    return p.then(
        () => null,
        (e: unknown) => e,
    );
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    resetConfirmations();
    route.craft = createCraft();
    route.change = { ...CHANGE };
});

describe("the user's confirmation", () => {
    it("is required: without it nothing reaches the craft", async () => {
        const c = await load();
        const err = await failure(apply(c.id, null));
        expect((err as ApplyBlockedError).reasons).toEqual(["apply:confirmation_missing"]);
        expect(codes()).toEqual([]);
    });

    it("must confirm exactly this change, once, and recently", async () => {
        const c = await load();
        const other = confirmApply(c.id, { ...CHANGE, slider_pi_gain: 120 });
        expect(((await failure(apply(c.id, other))) as ApplyBlockedError).reasons).toEqual([
            "apply:confirmation_mismatch",
        ]);
        const restoreToken = issueConfirmation({ kind: "restore", backupId: "x" });
        expect(((await failure(apply(c.id, restoreToken))) as ApplyBlockedError).reasons).toEqual([
            "apply:confirmation_mismatch",
        ]);
        const old = issueConfirmation(
            { kind: "apply", compositeId: c.id, sliders: { ...CHANGE } },
            Date.now() - CONFIRMATION_TTL_MS - 1,
        );
        expect(((await failure(apply(c.id, old))) as ApplyBlockedError).reasons).toEqual([
            "apply:confirmation_expired",
        ]);
        expect(codes()).toEqual([]);
        const ok = confirmApply(c.id);
        await apply(c.id, ok);
        expect(((await failure(apply(c.id, ok))) as ApplyBlockedError).reasons).toEqual([
            "apply:confirmation_unknown_or_used",
        ]);
    });
});

describe("FC identity, firmware and state, read fresh before anything else", () => {
    const cases: [string, (craft: Craft) => void, string][] = [
        ["another craft (UID)", (k) => (k.uid = [1, 2, 3]), "fc:identity_uid_mismatch"],
        ["another board", (k) => (k.boardName = "MATEKF405"), "fc:identity_board_mismatch"],
        ["other firmware", (k) => (k.version = "2025.12.1"), "fc:identity_firmware_mismatch"],
        ["not Betaflight", (k) => (k.variant = "INAV"), "fc:identity_not_betaflight"],
        ["API without simplified tuning", (k) => (k.apiVersion = "1.43.0"), "fc:api_version_unsupported"],
        ["armed", (k) => (k.armed = true), "fc:armed"],
        ["UID read fails (CRC)", (k) => (k.faults[MSPCodes.MSP_UID] = "crc"), "fc:identity_readback_missing"],
        [
            "board read refused",
            (k) => (k.faults[MSPCodes.MSP_BOARD_INFO] = "unsupported"),
            "fc:identity_readback_missing",
        ],
    ];
    for (const [name, mutate, reason] of cases) {
        it(`${name} -> ${reason}, reads only`, async () => {
            const c = await load();
            mutate(route.craft);
            const err = await failure(apply(c.id));
            expect(err).toBeInstanceOf(ApplyBlockedError);
            expect((err as ApplyBlockedError).reasons).toContain(reason);
            expect(writes()).toEqual([]);
            expect(codes().every((code) => APPLY_IDENTITY_READS.includes(code))).toBe(true);
            expect(useTuneBackupStore().backups).toEqual([]);
        });
    }

    it("a log without DeviceUID cannot prove the craft", async () => {
        // The unmocked encoder: no identity headers are added.
        const real = await vi.importActual<typeof import("./harness/chirpSim")>("./harness/chirpSim");
        const c = await load(
            real.encodeChirpLog(
                simulateChirpSequence(
                    ([0, 1, 2] as const).map((axis) => ({ crossoverHz: 40, delaySamples: 2, seconds: 8, axis })),
                ),
                FULL_TUNE_HEADERS.filter((h) => !h.startsWith("DeviceUID:")),
            ),
        );
        expect(((await failure(apply(c.id))) as ApplyBlockedError).reasons).toContain("fc:identity_log_uid_missing");
        expect(writes()).toEqual([]);
    });

    it("Virtual Mode ends blocked, before any MSP", async () => {
        const c = await load();
        useConnectionStore().virtualMode = true;
        expect(((await failure(apply(c.id))) as ApplyBlockedError).reasons).toEqual(["fc:virtual_mode"]);
        expect(codes()).toEqual([]);
    });

    it("the craft's PIDs must still be the logged ones", async () => {
        const c = await load();
        route.craft.pids[1] = [50, 84, 34];
        expect(((await failure(apply(c.id))) as ApplyBlockedError).reasons).toEqual(["fc:pids_differ_from_log:pitch"]);
        expect(writes()).toEqual([]);
    });
});

describe("backup before the write", () => {
    it("no write when the browser does not keep the backup", async () => {
        const c = await load();
        const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("QuotaExceededError");
        });
        const err = await failure(apply(c.id));
        spy.mockRestore();
        expect((err as ApplyBlockedError).reasons).toEqual(["apply:backup_not_stored"]);
        expect(writes()).toEqual([]);
    });

    it("stores the craft's own pre-write values, bound to its UID", async () => {
        const c = await load();
        const before = { sliders: { ...route.craft.sliders }, pids: route.craft.pids.map((r) => [...r]) };
        const result = await apply(c.id);
        const backup = useTuneBackupStore().get(result.backupId)!;
        expect(backup.reason).toBe("before_apply");
        expect(backup.uid).toEqual(route.craft.uid);
        expect(backup.board).toBe("BEFH BETAFPVG473");
        expect(backup.compositeId).toBe(c.id);
        expect(backup.snapshot.sliders.slider_pi_gain).toBe(before.sliders.slider_pi_gain);
        expect(backup.snapshot.pids.slice(0, 3)).toEqual(before.pids.slice(0, 3));
        expect(JSON.parse(localStorage.getItem(BACKUP_STORAGE_KEY)!)[0].id).toBe(result.backupId);
    });
});

describe("write, read back, verify, save", () => {
    it("a verified write: exact sequence, payload, firmware-calculated values, EEPROM saved", async () => {
        const c = await load();
        const result = await apply(c.id);
        expect(result.status).toBe("verified");
        expect(codes()).toEqual(APPLY_SUCCESS_SEQUENCE);
        const set = route.craft.calls.find((x) => x.code === MSPCodes.MSP_SET_SIMPLIFIED_TUNING)!;
        expect(set.data).toHaveLength(53);
        expect(set.data!.slice(0, 9)).toEqual([2, 100, 100, 100, 105, 110, 100, 100, 100]);
        expect(set.data![18]).toBe(110); // D-term filter multiplier
        // The craft now holds what its own firmware calculates for the new sliders.
        const want = firmwarePids({ ...route.craft.sliders }, route.craft.pids, route.craft.advanced).pids;
        expect(route.craft.pids.slice(0, 3)).toEqual(want.slice(0, 3));
        expect(route.craft.pids[0]).toEqual([50, 88, 32]);
        expect(route.craft.filters.dterm_lowpass_hz).toBe(
            firmwareDterm(route.craft.sliders, route.craft.filters).dterm_lowpass_hz,
        );
        expect(route.craft.eeprom?.pids[0]).toEqual([50, 88, 32]);
        expect(result.readback.pids[0]).toEqual([50, 88, 32]);
        expect(result.expected).toEqual(result.readback);
    });

    const failures: [string, (k: Craft) => void, string, "no" | "unknown"][] = [
        ["the craft ignores the write", (k) => (k.ignoreWrites = true), "verify", "no"],
        ["a value comes back different (partial write)", (k) => (k.skewAfterWrite = true), "verify", "no"],
        ["the firmware rejects the sliders", (k) => (k.validateInvalid = true), "validate", "no"],
        [
            "read-back after the write fails (CRC)",
            (k) => (k.faultsAfterWrite[MSPCodes.MSP_PID] = "crc"),
            "verify",
            "no",
        ],
        [
            "read-back after the write times out",
            (k) => (k.faultsAfterWrite[MSPCodes.MSP_PID_ADVANCED] = "timeout"),
            "verify",
            "no",
        ],
        [
            "disconnect during the write",
            (k) => (k.faults[MSPCodes.MSP_SET_SIMPLIFIED_TUNING] = "disconnect"),
            "write",
            "no",
        ],
        [
            "disconnect at save",
            (k) => (k.faultsAfterWrite[MSPCodes.MSP_EEPROM_WRITE] = "disconnect"),
            "eeprom",
            "unknown",
        ],
    ];
    for (const [name, mutate, stage, saved] of failures) {
        it(`${name}: reported as a failed write (${stage}), never as success`, async () => {
            const c = await load();
            mutate(route.craft);
            const err = await failure(apply(c.id));
            expect(err).toBeInstanceOf(TuneWriteError);
            expect((err as TuneWriteError).stage).toBe(stage);
            expect((err as TuneWriteError).saved).toBe(saved);
            expect((err as TuneWriteError).backupId).toMatch(/^bk-/);
            if (saved === "no") {
                expect(route.craft.eeprom).toBeNull();
            }
            if (stage === "verify" || stage === "validate" || stage === "write") {
                expect(codes()).not.toContain(MSPCodes.MSP_EEPROM_WRITE);
            }
        });
    }

    it("a mismatch names the field", async () => {
        const c = await load();
        route.craft.skewAfterWrite = true;
        const err = (await failure(apply(c.id))) as TuneWriteError;
        expect(err.mismatches).toEqual(["pid:roll:P expected 50 read 51"]);
    });
});

describe("Restore", () => {
    function confirmRestore(backupId: string) {
        return issueConfirmation({ kind: "restore", backupId });
    }

    it("puts the backed-up tune back on the same craft, verified and saved, after its own backup", async () => {
        const c = await load();
        const before = route.craft.pids.map((r) => [...r]);
        const applied = await apply(c.id);
        expect(route.craft.pids[0]).not.toEqual(before[0]);
        route.craft.calls = [];
        const restored = await restoreTune(applied.backupId, confirmRestore(applied.backupId));
        expect(restored.status).toBe("verified");
        expect(route.craft.pids.slice(0, 3)).toEqual(before.slice(0, 3));
        expect(route.craft.sliders.slider_pi_gain).toBe(100);
        expect(route.craft.eeprom?.pids.slice(0, 3)).toEqual(before.slice(0, 3));
        const pre = useTuneBackupStore().get(restored.backupId)!;
        expect(pre.reason).toBe("before_restore");
        expect(pre.snapshot.pids[0]).toEqual([50, 88, 32]);
    });

    it("restores PIDs the sliders do not produce, exactly, through MSP_SET_PID", async () => {
        await load();
        const store = useTuneBackupStore();
        const snapshot = {
            sliders: { ...route.craft.sliders },
            filters: { ...route.craft.filters },
            pids: route.craft.pids.map((r, i) => (i === 2 ? [52, 90, 6] : [...r])),
            advanced: { ...route.craft.advanced },
        };
        const backup = {
            id: "bk-manual",
            createdAt: new Date().toISOString(),
            reason: "before_apply" as const,
            uid: [...route.craft.uid] as [number, number, number],
            board: "BEFH BETAFPVG473",
            firmware: "2026.6.2",
            compositeId: null,
            snapshot,
        };
        expect(store.save(backup)).toBe(true);
        await restoreTune("bk-manual", confirmRestore("bk-manual"));
        expect(route.craft.pids[2]).toEqual([52, 90, 6]);
        expect(codes()).toContain(MSPCodes.MSP_SET_PID);
        expect(route.craft.eeprom?.pids[2]).toEqual([52, 90, 6]);
    });

    it("refuses another craft, an armed craft, an unknown backup and a missing confirmation, without writing", async () => {
        const c = await load();
        const applied = await apply(c.id);
        route.craft.calls = [];
        expect(((await failure(restoreTune(applied.backupId, null))) as ApplyBlockedError).reasons).toEqual([
            "apply:confirmation_missing",
        ]);
        expect(
            ((await failure(restoreTune("bk-nope", confirmRestore("bk-nope")))) as ApplyBlockedError).reasons,
        ).toEqual(["restore:backup_not_found"]);
        route.craft.uid = [9, 9, 9];
        expect(
            ((await failure(restoreTune(applied.backupId, confirmRestore(applied.backupId)))) as ApplyBlockedError)
                .reasons,
        ).toEqual(["restore:different_craft"]);
        route.craft.uid = createCraft().uid;
        route.craft.armed = true;
        expect(
            ((await failure(restoreTune(applied.backupId, confirmRestore(applied.backupId)))) as ApplyBlockedError)
                .reasons,
        ).toEqual(["fc:armed"]);
        expect(writes()).toEqual([]);
    });

    it("a restore that does not verify is a failure, not saved", async () => {
        const c = await load();
        const applied = await apply(c.id);
        route.craft.eeprom = null;
        route.craft.written = false;
        route.craft.ignoreWrites = true;
        const err = await failure(restoreTune(applied.backupId, confirmRestore(applied.backupId)));
        expect(err).toBeInstanceOf(TuneWriteError);
        expect(route.craft.eeprom).toBeNull();
    });
});
