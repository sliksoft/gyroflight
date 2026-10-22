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
 * Codex review P1-05: Apply, its backup and Restore are bound to the PID profile they act on.
 * MSP_PID / _PID_ADVANCED and the D-term part of MSP_FILTER_CONFIG write currentPidProfile
 * (msp.c), so a Restore after a profile switch would put profile 0's values into profile 1 and
 * leave profile 0 changed. The simulated FC has four profiles (harness/mspFirmware.ts); the
 * user's switch is MSP_SELECT_SETTING's effect (selectPidProfile), never sent by the route.
 */

import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FirmwareFc } from "./harness/mspFirmware";

const route = vi.hoisted(() => ({ fc: undefined as unknown as FirmwareFc }));
vi.mock("../../src/js/msp", () => ({
    default: {
        promise: vi.fn(async (code: number, data?: number[]) =>
            (await import("./harness/mspFirmware")).firmwarePromise(route.fc, code, data),
        ),
    },
}));
vi.mock("@/gyrocore/releaseGate/releaseContract", async () => ({
    ...(await vi.importActual<typeof import("../../src/gyrocore/releaseGate/releaseContract")>(
        "@/gyrocore/releaseGate/releaseContract",
    )),
    assertAbsoluteReleased: () => undefined,
}));

import MSPCodes from "../../src/js/msp/MSPCodes";
import {
    applyAbsoluteTune,
    previewAbsoluteRestore,
    previewAbsoluteTune,
    restoreAbsoluteTune,
    TuneWriteError,
} from "../../src/composables/useTuneApply";
import { ApplyBlockedError } from "../../src/gyrocore/chirp/applyGate";
import { useTuneBackupStore } from "../../src/gyrocore/stores/tuneBackup";
import { issueConfirmation, resetConfirmations } from "../../src/gyrocore/tuning/applyConfirmation";
import type { AbsoluteProposal } from "../../src/gyrocore/releaseGate/releaseContract";
import {
    air65FirmwareState,
    createFirmwareFc,
    FIRMWARE_WRITE_CODES,
    profilePart,
    selectPidProfile,
    type FirmwareState,
} from "./harness/mspFirmware";

function headersFor(s: FirmwareState): [string, string][] {
    return [
        ["Firmware revision", "Betaflight 2026.6.2 (43875a55a) STM32G474"],
        ["Board information", "BEFH BETAFPVG473"],
        ["DeviceUID", "003e00213841501220343141"],
        ["rollPID", s.pids[0].join(",")],
        ["pitchPID", s.pids[1].join(",")],
        ["yawPID", s.pids[2].join(",")],
    ];
}

function proposal(change: Record<string, number> = { p_roll: 60, gyro_lpf2_static_hz: 280 }): AbsoluteProposal {
    return {
        id: `profile-${Object.keys(change).join("-")}`,
        createdAt: "2026-10-22T00:00:00Z",
        log: { sha256: "a".repeat(64), logIndex: 0, headerPairs: headersFor(air65FirmwareState()) },
        change,
        items: [],
        release: {
            measurement: { valid: true, reasons: [] },
            model: { status: "VALIDATED", reasons: [] },
            margins: [],
            independentValidation: null,
            safetyAnalysisEvidence: "available",
            safetyReasons: [],
        },
    };
}

const writes = () => route.fc.calls.map((c) => c.code).filter((c) => FIRMWARE_WRITE_CODES.has(c));
const failure = (p: Promise<unknown>) =>
    p.then(
        () => null,
        (e: unknown) => e,
    );

async function applyInProfile0(p = proposal()) {
    const pv = await previewAbsoluteTune(p);
    return applyAbsoluteTune(
        p,
        issueConfirmation({ kind: "absolute", proposalId: p.id, change: { ...p.change }, preview: pv.hash }),
    );
}

/** Profile 1 holds a different tune than profile 0 (as on a real craft with two profiles in use). */
function twoProfiles() {
    const fc = createFirmwareFc();
    fc.profiles[1].pids[0] = [40, 60, 20];
    fc.profiles[1].p.dterm_lpf1_static_hz = 90;
    fc.eepromProfiles = structuredClone(fc.profiles);
    return fc;
}

beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    resetConfirmations();
    route.fc = twoProfiles();
});

describe("P1-05: the backup names its PID profile", () => {
    it("an absolute backup stores the active profile index from MSP_STATUS_EX", async () => {
        const res = await applyInProfile0();
        const backup = useTuneBackupStore().get(res.backupId)!;
        expect(backup.absolute!.pidProfile).toBe(0);
    });
});

describe("P1-05: Restore after a profile switch", () => {
    it("review sequence: backup in profile 0, switch to profile 1, Restore → refused, nothing written", async () => {
        const res = await applyInProfile0();
        const profile1 = structuredClone(route.fc.profiles[1]);
        selectPidProfile(route.fc, 1);
        const before = writes().length;

        const e1 = (await failure(previewAbsoluteRestore(res.backupId))) as ApplyBlockedError;
        expect(e1).toBeInstanceOf(ApplyBlockedError);
        expect(e1.reasons).toContain("restore:pid_profile_changed:0->1");
        const e2 = (await failure(
            restoreAbsoluteTune(res.backupId, issueConfirmation({ kind: "restore", backupId: res.backupId })),
        )) as ApplyBlockedError;
        expect(e2).toBeInstanceOf(ApplyBlockedError);
        expect(writes().length).toBe(before);
        // Profile 1 keeps its own tune; profile 0 still holds what Apply wrote.
        expect(profilePart(route.fc.ram)).toEqual(profile1);
        expect(route.fc.profiles[0].pids[0][0]).toBe(60);
    });

    it("a reconnect with profile 1 active is refused the same way", async () => {
        const res = await applyInProfile0();
        selectPidProfile(route.fc, 1);
        setActivePinia(createPinia()); // a fresh session: nothing cached in the store
        const e = (await failure(previewAbsoluteRestore(res.backupId))) as ApplyBlockedError;
        expect(e.reasons).toContain("restore:pid_profile_changed:0->1");
    });

    it("valid: back in profile 0, Restore restores profile 0 and leaves profile 1 alone", async () => {
        const original = structuredClone(route.fc.ram);
        const res = await applyInProfile0();
        selectPidProfile(route.fc, 1);
        const profile1 = profilePart(route.fc.ram);
        selectPidProfile(route.fc, 0);
        const pv = await previewAbsoluteRestore(res.backupId);
        const back = await restoreAbsoluteTune(
            res.backupId,
            issueConfirmation({ kind: "restore", backupId: res.backupId, preview: pv.hash }),
        );
        expect(back.status).toBe("verified");
        expect(route.fc.ram).toEqual(original);
        expect(route.fc.eepromProfiles[1]).toEqual(profile1);
    });

    it("a backup without a profile index (taken before this fix) is refused", async () => {
        const res = await applyInProfile0();
        const raw = JSON.parse(localStorage.getItem("gyroflight.tuneBackups.v1")!) as Record<string, unknown>[];
        for (const b of raw) delete (b.absolute as Record<string, unknown>).pidProfile;
        localStorage.setItem("gyroflight.tuneBackups.v1", JSON.stringify(raw));
        const e = (await failure(previewAbsoluteRestore(res.backupId))) as ApplyBlockedError;
        expect(e.reasons).toContain("restore:backup_without_pid_profile");
    });
});

describe("P1-05: the profile is checked again during the transaction", () => {
    it("a switch between Preview and Apply (same values in both profiles) → preview_changed, nothing written", async () => {
        route.fc = createFirmwareFc(); // four identical profiles: only the index tells them apart
        const p = proposal();
        const pv = await previewAbsoluteTune(p);
        selectPidProfile(route.fc, 2);
        const e = (await failure(
            applyAbsoluteTune(
                p,
                issueConfirmation({ kind: "absolute", proposalId: p.id, change: { ...p.change }, preview: pv.hash }),
            ),
        )) as ApplyBlockedError;
        expect(e).toBeInstanceOf(ApplyBlockedError);
        expect(e.reasons).toContain("apply:preview_changed");
        expect(writes()).toEqual([]);
    });

    it("a switch after the first write of Apply stops before the next write and before any save", async () => {
        route.fc = createFirmwareFc();
        route.fc.afterWrite = (fc) => {
            if (fc.writes === 1) selectPidProfile(fc, 1);
        };
        const e = (await failure(applyInProfile0())) as TuneWriteError;
        expect(e).toBeInstanceOf(TuneWriteError);
        expect(e.stage).toBe("write");
        expect(e.saved).toBe("no");
        expect(e.message).toContain("pid_profile_changed:0->1");
        // The other profile cannot be read without switching back: the current state is unknown.
        expect(e.changedFromBackup).toBeNull();
        expect(writes()).toHaveLength(1);
        expect(writes()).not.toContain(MSPCodes.MSP_EEPROM_WRITE);
    });

    it("a switch in the middle of Restore stops it the same way", async () => {
        const res = await applyInProfile0();
        const n = route.fc.writes;
        route.fc.afterWrite = (fc) => {
            if (fc.writes === n + 2) selectPidProfile(fc, 1);
        };
        const pv = await previewAbsoluteRestore(res.backupId);
        const e = (await failure(
            restoreAbsoluteTune(
                res.backupId,
                issueConfirmation({ kind: "restore", backupId: res.backupId, preview: pv.hash }),
            ),
        )) as TuneWriteError;
        expect(e).toBeInstanceOf(TuneWriteError);
        expect(e.message).toContain("pid_profile_changed:0->1");
        expect(route.fc.writes).toBe(n + 2);
    });

    it("arming mid-transaction stops the next write", async () => {
        route.fc = createFirmwareFc();
        route.fc.afterWrite = (fc) => {
            if (fc.writes === 1) fc.armed = true;
        };
        const e = (await failure(applyInProfile0())) as TuneWriteError;
        expect(e).toBeInstanceOf(TuneWriteError);
        expect(e.message).toContain("fc:armed");
        expect(writes()).toHaveLength(1);
    });
});

describe("P1-05: profile-bound and global values are told apart", () => {
    it("the preview marks each value's scope; a global filter change reaches every profile", async () => {
        route.fc = createFirmwareFc();
        const pv = await previewAbsoluteTune(proposal());
        const scope = Object.fromEntries(pv.changes.map((r) => [r.key, r.scope]));
        expect(scope).toMatchObject({ p_roll: "profile", gyro_lpf2_static_hz: "global" });
        await applyInProfile0();
        selectPidProfile(route.fc, 1);
        expect(route.fc.ram.p.gyro_lpf2_static_hz).toBe(280); // global
        expect(route.fc.ram.pids[0][0]).toBe(56); // profile 1 untouched
    });
});
