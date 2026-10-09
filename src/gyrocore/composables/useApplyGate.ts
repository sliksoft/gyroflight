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
 * Apply Gains authorization for Betaflight's Autotune panel, for display:
 * the global (composite) recommendation, whether it is authorized, its GyroCore
 * Safety result, and the product release lock. The same checks run again
 * inside the Apply action.
 */

import { computed } from "vue";
import { useChirpQualificationStore } from "@/gyrocore/stores/chirpQualification";
import { authorizeCompositeApply } from "@/gyrocore/tuning/authorize";
import { productApplyBlocks } from "@/gyrocore/productLock/productApply";
import { safetyForComposite } from "@/gyrocore/safety/authorize";

export function useApplyGate() {
    const gate = useChirpQualificationStore();

    const composite = computed(() => gate.composite);

    const authorization = computed(() => {
        void gate.revision;
        const c = composite.value;
        return authorizeCompositeApply(gate.gateState(), c?.id, c?.final);
    });

    // Not a verdict on the tune: the product write is not released yet.
    const productLock = productApplyBlocks();

    const safety = computed(() => {
        void gate.revision;
        return safetyForComposite(gate.gateState(), composite.value);
    });

    const applyAllowed = computed(
        () => authorization.value.allowed && safety.value.authorized && productLock.length === 0,
    );

    return { composite, authorization, safety, productLock, applyAllowed };
}
