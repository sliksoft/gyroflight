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

/** Flight-mode flag bit that carries BOXCHIRP (blackbox-tools FLIGHT_LOG_FLIGHT_MODE_NAME bit 6, "HEADFREE"). */
export const BOXCHIRP_BIT = 6;

export const AXIS_NAMES = ["roll", "pitch", "yaw"] as const;
export type ChirpAxisName = (typeof AXIS_NAMES)[number];
