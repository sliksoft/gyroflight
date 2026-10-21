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
 * Is the connected flight controller the craft the log was recorded on, running the
 * same firmware? Compared field by field against the blackbox header, which
 * Betaflight writes from the same sources MSP reports (blackbox.c: DeviceUID is
 * "%08x%08x%08x" of U_ID_0..2, exactly MSP_UID's three words; "Board information" is
 * "<manufacturer id> <board name>"). Any difference, or a missing field, blocks.
 */

/** Simplified tuning (MSP_SIMPLIFIED_TUNING and its calculate/validate codes) needs API 1.44. */
export const MIN_SIMPLIFIED_TUNING_API = "1.44.0";

export interface LogIdentity {
    uid: [number, number, number] | null;
    board: string | null;
    firmwareType: string | null;
    firmwareRevision: string | null;
    craftName: string | null;
}

export interface FcIdentity {
    uid: [number, number, number] | null;
    manufacturerId: string;
    boardName: string;
    /** MSP_FC_VARIANT, "BTFL" for Betaflight. */
    variant: string;
    /** MSP_FC_VERSION, e.g. "2026.6.2". */
    version: string;
    /** MSP_API_VERSION, e.g. "1.48.0". */
    apiVersion: string;
    /** MSP_STATUS_EX mode bit 0. */
    armed: boolean;
}

export function parseDeviceUid(hex: string | undefined): [number, number, number] | null {
    if (!hex || !/^[0-9a-fA-F]{24}$/.test(hex.trim())) {
        return null;
    }
    const h = hex.trim();
    return [0, 8, 16].map((i) => Number.parseInt(h.slice(i, i + 8), 16)) as [number, number, number];
}

export function logIdentity(headerPairs: readonly (readonly [string, string])[]): LogIdentity {
    const get = (k: string) => headerPairs.find(([key]) => key === k)?.[1]?.trim() ?? null;
    return {
        uid: parseDeviceUid(get("DeviceUID") ?? undefined),
        board: get("Board information"),
        firmwareType: get("Firmware type"),
        firmwareRevision: get("Firmware revision"),
        craftName: get("Craft name"),
    };
}

function versionAtLeast(v: string, min: string): boolean {
    const a = v.split(".").map(Number);
    const b = min.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
        if ((a[i] || 0) !== (b[i] || 0)) {
            return (a[i] || 0) > (b[i] || 0);
        }
    }
    return true;
}

/** Reasons the connected FC may not receive this log's tune; empty when it is the same craft and firmware. */
export function identityBlocks(log: LogIdentity, fc: FcIdentity): string[] {
    const blocked: string[] = [];
    if (fc.variant !== "BTFL") {
        blocked.push("fc:identity_not_betaflight");
    }
    if (!fc.apiVersion || !versionAtLeast(fc.apiVersion, MIN_SIMPLIFIED_TUNING_API)) {
        blocked.push("fc:api_version_unsupported");
    }
    if (!log.uid) {
        blocked.push("fc:identity_log_uid_missing");
    } else if (!fc.uid) {
        blocked.push("fc:identity_uid_unavailable");
    } else if (log.uid.some((w, i) => w !== fc.uid![i])) {
        blocked.push("fc:identity_uid_mismatch");
    }
    if (!log.board || log.board !== `${fc.manufacturerId} ${fc.boardName}`) {
        blocked.push("fc:identity_board_mismatch");
    }
    // "Betaflight 2026.6.2 (43875a55a) STM32G474": the version must be the FC's, as a whole word.
    // ("Firmware type" is not used: older Betaflight releases write "Cleanflight" there.)
    const rev = log.firmwareRevision ?? "";
    if (!rev.startsWith("Betaflight ") || !fc.version || !rev.split(/\s+/).includes(fc.version)) {
        blocked.push("fc:identity_firmware_mismatch");
    }
    if (fc.armed) {
        blocked.push("fc:armed");
    }
    return blocked;
}
