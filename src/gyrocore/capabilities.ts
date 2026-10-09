/*
 * This file is part of GyroCore App, a derivative of the Betaflight App.
 *
 * GyroCore App is free software. You can redistribute this software
 * and/or modify this software under the terms of the GNU General
 * Public License as published by the Free Software Foundation,
 * either version 3 of the License, or (at your option) any later
 * version.
 *
 * GyroCore App is distributed in the hope that it will be useful,
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

// Read-only capability statements for the GyroCore tab. "available" entries are
// upstream Betaflight features used unchanged; nothing here performs analysis.
export interface GyroCoreCapability {
    key: string;
    label: string;
    available: boolean;
}

export const gyrocoreCapabilities: readonly GyroCoreCapability[] = [
    { key: "firmware_flasher", label: "gyrocoreCapFirmwareFlasher", available: true },
    { key: "blackbox_viewer", label: "gyrocoreCapBlackboxViewer", available: true },
    { key: "autotune", label: "gyrocoreCapAutotune", available: true },
    { key: "analysis", label: "gyrocoreCapAnalysis", available: false },
    { key: "safety", label: "gyrocoreCapSafety", available: false },
    { key: "compare", label: "gyrocoreCapCompare", available: false },
];
