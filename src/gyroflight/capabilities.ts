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

// Read-only capability statements for the Gyroflight tab. "available" entries are
// upstream Betaflight features used unchanged; nothing here performs analysis.
export interface GyroflightCapability {
    key: string;
    label: string;
    available: boolean;
}

export const gyroflightCapabilities: readonly GyroflightCapability[] = [
    { key: "firmware_flasher", label: "gyroflightCapFirmwareFlasher", available: true },
    { key: "blackbox_viewer", label: "gyroflightCapBlackboxViewer", available: true },
    { key: "autotune", label: "gyroflightCapAutotune", available: true },
    { key: "analysis", label: "gyroflightCapAnalysis", available: false },
    { key: "safety", label: "gyroflightCapSafety", available: false },
    { key: "compare", label: "gyroflightCapCompare", available: false },
];
