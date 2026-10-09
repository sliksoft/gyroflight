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
 * Error thrown by the Apply action when GyroCore does not authorize it. The
 * gate itself is the composite (global) authorization in
 * src/gyrocore/tuning/authorize.ts.
 */

export class ApplyBlockedError extends Error {
    readonly reasons: string[];

    constructor(reasons: string[]) {
        super(`Apply Gains blocked by GyroCore: ${reasons.join(", ")}`);
        this.name = "ApplyBlockedError";
        this.reasons = reasons;
    }
}
