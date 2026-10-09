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
 * Apply Gains authorization for the axis selected in Betaflight's Autotune
 * table, for display. The same check runs again inside the Apply action.
 */

import { computed, type Ref } from "vue";
import type { AxisName } from "@/composables/useAutotune";
import { authorizeApply } from "@/gyrocore/chirp/applyGate";
import { useChirpQualificationStore } from "@/gyrocore/stores/chirpQualification";

export function useApplyGate(selectedAxisKey: Ref<AxisName | null>) {
    const gate = useChirpQualificationStore();

    const measurement = computed(() => {
        void gate.revision;
        return selectedAxisKey.value ? (gate.selectedMeasurements[selectedAxisKey.value] ?? null) : null;
    });

    const measurementId = computed(() => measurement.value?.id ?? null);

    const authorization = computed(() => {
        void gate.revision;
        const m = measurement.value;
        return authorizeApply(gate.report, m?.id, m?.recommendation?.result.proposed);
    });

    return { measurement, measurementId, authorization };
}
