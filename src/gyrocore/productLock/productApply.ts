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
 * Product release lock for writing a tune to a flight controller.
 *
 * GyroCore's Safety engine (mechanical safety, safe-tune limits, output
 * safety) is not migrated yet (WU4). Until it is, Gyroflight does not write
 * tuning values to a craft, even when the global tune passes every gate that
 * exists today. This is not a measurement rejection: the tune may be valid,
 * the product write is simply not released.
 *
 * There is deliberately no switch here. Tests that exercise the write path
 * replace this module with test/gyrocore/harness/productRelease.ts.
 */

import { ApplyBlockedError } from "@/gyrocore/chirp/applyGate";

export const PRODUCT_APPLY_PENDING = "full_safety_engine_pending";

/** Why the product may not write a tune to a craft; empty once released. */
export function productApplyBlocks(): string[] {
    return [PRODUCT_APPLY_PENDING];
}

export function assertProductApplyReleased(): void {
    const blocked = productApplyBlocks();
    if (blocked.length) {
        throw new ApplyBlockedError(blocked);
    }
}
