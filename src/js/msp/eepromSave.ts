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
 * The one reading of an MSP_EEPROM_WRITE outcome (audit WP8-F04), shared by the tabs' saves
 * (useReboot, MSPHelper.writeConfiguration, the OSD store) and Gyroflight's write transactions.
 *
 * Betaflight's msp.c answers MSP_EEPROM_WRITE only after writeEEPROM() and readEEPROM() returned, and
 * writeEEPROM() returns only once the stored config reads back valid (config_eeprom.c; otherwise
 * failureMode, no answer at all). Armed, it answers with an error frame and writes nothing. So:
 * the firmware's ACK is "saved", its error reply "not saved", and everything else (no answer, a
 * corrupt answer, a lost link after the request went out) leaves it unknown. Exception: a request
 * over MSP-over-telemetry on an RX_SPI build is answered before a deferred write; Gyroflight's
 * transports are not that path. Firmware source 4.3 to master reviewed; not run on hardware.
 */

import MSP from "../msp";
import MSPCodes from "./MSPCodes";
import { serial } from "../serial";
import { useConnectionStore } from "../../stores/connection";
import { WriteRefusedError } from "../../composables/fcWriteGuard";

export type EepromReplyState = "saved" | "no" | "unknown";

/** What an MSP_EEPROM_WRITE answer proves (see the header). */
export function eepromReplyState(
    reply: { crcError?: boolean; unsupported?: number | boolean } | null | undefined,
): EepromReplyState {
    if (!reply || reply.crcError) return "unknown";
    return reply.unsupported ? "no" : "saved";
}

/**
 * An EEPROM save that was not confirmed. `persistence`: "not_saved" when it provably did not run
 * (refused by the write check, never sent, or refused by the firmware), "unknown" when it went out
 * and its answer was lost or unreadable. Either way the FC's RAM may hold changes EEPROM does not.
 * Not an MspCancelledError: a save cut short by a disconnect or a tab switch is reported, not
 * swallowed (useSaving).
 */
export class EepromSaveError extends Error {
    readonly persistence: "not_saved" | "unknown";
    /** useSaving shows this in place of the generic save failure. */
    saveFailureMessage?: string;

    constructor(persistence: "not_saved" | "unknown", detail: string, options?: { cause?: unknown }) {
        super(`EEPROM save not confirmed (${persistence}): ${detail}`, options);
        this.name = "EepromSaveError";
        this.persistence = persistence;
    }
}

/**
 * Sends MSP_EEPROM_WRITE and resolves only on the firmware's ACK; otherwise rejects with an
 * EepromSaveError saying what is known.
 */
export async function saveEeprom(): Promise<void> {
    // The virtual FC has nothing to save (MSP.promise answers nothing there), as before.
    if (useConnectionStore().virtualMode) return;
    if (!serial.connected) {
        throw new EepromSaveError("not_saved", "not connected");
    }
    let reply;
    try {
        reply = await MSP.promise(MSPCodes.MSP_EEPROM_WRITE);
    } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new EepromSaveError(err instanceof WriteRefusedError ? "not_saved" : "unknown", detail, { cause: err });
    }
    const state = eepromReplyState(reply);
    if (state === "no") throw new EepromSaveError("not_saved", "the flight controller refused it (armed?)");
    if (state === "unknown") throw new EepromSaveError("unknown", "no readable answer");
}
