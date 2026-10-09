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

// Read-only capability statements for the Gyroflight tab: what exists today, stated
// truthfully. Nothing here performs analysis or changes behaviour.
//
//   available    upstream Betaflight feature, used unchanged
//   implemented  GyroCore layer in Gyroflight, in use
//   incomplete   partly migrated; does not yet authorize anything on its own
//   locked       deliberately disabled
//   not_started  not implemented yet

export type CapabilityStatus = "available" | "implemented" | "incomplete" | "locked" | "not_started";

export interface GyroflightCapability {
    key: string;
    label: string;
    status: CapabilityStatus;
    /** Optional one-line detail shown under the label. */
    detail?: string;
}

export const gyroflightCapabilities: readonly GyroflightCapability[] = [
    { key: "firmware_flasher", label: "gyroflightCapFirmwareFlasher", status: "available" },
    { key: "blackbox_viewer", label: "gyroflightCapBlackboxViewer", status: "available" },
    { key: "autotune", label: "gyroflightCapAutotune", status: "available" },
    { key: "chirp_qualification", label: "gyroflightCapChirpQualification", status: "implemented" },
    { key: "global_tune", label: "gyroflightCapGlobalTune", status: "implemented" },
    { key: "safety_foundation", label: "gyroflightCapSafetyFoundation", status: "implemented" },
    {
        key: "safety_full",
        label: "gyroflightCapSafetyFull",
        status: "incomplete",
        detail: "gyroflightCapSafetyFullDetail",
    },
    {
        key: "physical_apply",
        label: "gyroflightCapPhysicalApply",
        status: "locked",
        detail: "gyroflightCapPhysicalApplyDetail",
    },
    { key: "tune_session", label: "gyroflightCapTuneSession", status: "not_started" },
];

export const CAPABILITY_STATUS_ICON: Record<CapabilityStatus, string> = {
    available: "i-lucide-check-circle",
    implemented: "i-lucide-check-circle",
    incomplete: "i-lucide-circle-dashed",
    locked: "i-lucide-lock",
    not_started: "i-lucide-clock",
};
