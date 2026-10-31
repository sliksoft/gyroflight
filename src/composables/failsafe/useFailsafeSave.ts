/*
 * This file is part of Betaflight.
 *
 * Betaflight is free software. You can redistribute this software
 * and/or modify this software under the terms of the GNU General
 * Public License as published by the Free Software Foundation,
 * either version 3 of the License, or (at your option) any later
 * version.
 *
 * Betaflight is distributed in the hope that it will be useful,
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

import semver from "semver";
import MSPCodes from "../../js/msp/MSPCodes";
import { confirmedWrite, mspHelper } from "../../js/msp/MSPHelper";
import { isMspCancelled } from "../../js/msp/mspErrors";
import { API_VERSION_1_41 } from "../../js/data_storage";
import { i18n } from "../../js/localization";
import { useFlightControllerStore } from "@/stores/fc";
import { useSaving, withSaveFailureMessage } from "@/composables/useSaving";
import { useReboot } from "@/composables/useReboot";

/**
 * Save path for the Failsafe tab: send the edited store sections to the FC, then save to
 * EEPROM and reboot.
 * @param captureBaseline takes the tab's values now and returns what makes them its clean
 *   baseline. Gyroflight (audit WP8-F06): taken when the save starts, together with every payload
 *   it sends (the fields stay editable meanwhile), and applied only once the firmware acknowledged
 *   the EEPROM save, so a failed or unconfirmed save, or an edit made during it, stays pending.
 */
export function useFailsafeSave(captureBaseline: () => () => void) {
    const fcStore = useFlightControllerStore();
    const { isSaving, runSave } = useSaving();
    const { saveAndReboot } = useReboot();

    const saveConfig = () =>
        runSave(async () => {
            const commitBaseline = captureBaseline();
            const rxConfig = mspHelper.crunch(MSPCodes.MSP_SET_RX_CONFIG);
            const failsafeConfig = mspHelper.crunch(MSPCodes.MSP_SET_FAILSAFE_CONFIG);
            const rxFail = fcStore.rxFailConfig.map((c) => ({ mode: c.mode, value: c.value }));
            const featureConfig = mspHelper.crunch(MSPCodes.MSP_SET_FEATURE_CONFIG);
            const gpsRescue = semver.gte(fcStore.config.apiVersion, API_VERSION_1_41)
                ? mspHelper.crunch(MSPCodes.MSP_SET_GPS_RESCUE)
                : null;
            try {
                // Gyroflight hook (docs/gyrocore/UPSTREAM.md): each write must be acknowledged (the
                // firmware's error answer, a refusal, no answer or a refused retry ends the save,
                // WP8-F05).
                await confirmedWrite(MSPCodes.MSP_SET_RX_CONFIG, rxConfig);
                await confirmedWrite(MSPCodes.MSP_SET_FAILSAFE_CONFIG, failsafeConfig);
                await new Promise<void>((resolve, reject) => {
                    mspHelper.sendRxFailConfig(resolve, reject, rxFail);
                });
                await confirmedWrite(MSPCodes.MSP_SET_FEATURE_CONFIG, featureConfig);
                if (gpsRescue) {
                    await confirmedWrite(MSPCodes.MSP_SET_GPS_RESCUE, gpsRescue);
                }

                await saveAndReboot({ onSaved: commitBaseline });
            } catch (err) {
                // Cut short (tab switch, link lost) after a write may have gone out: the FC's RAM may
                // hold part of it. Shown, not swallowed as a harmless cancellation.
                if (isMspCancelled(err)) {
                    throw withSaveFailureMessage(
                        new Error("Failsafe save interrupted", { cause: err }),
                        i18n.getMessage("gyroflightSaveInterrupted"),
                    );
                }
                throw err;
            }
        });

    return { saveConfig, isSaving };
}
