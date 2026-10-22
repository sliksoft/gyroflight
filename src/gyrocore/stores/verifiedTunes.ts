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
 * Verified Tune records in this browser (localStorage, per craft). Only records that pass
 * verifiedTuneIssues for their own craft are stored or returned; every consumer checks the
 * record again against the craft it is about to write to.
 */

import { defineStore } from "pinia";
import { ref } from "vue";
import { verifiedTuneIssues, type VerifiedTune } from "@/gyrocore/releaseGate/verifiedTune";

export const VERIFIED_TUNE_STORAGE_KEY = "gyroflight.verifiedTunes.v1";
const PER_CRAFT = 10;

function readStorage(): VerifiedTune[] {
    try {
        const raw = globalThis.localStorage?.getItem(VERIFIED_TUNE_STORAGE_KEY);
        const list = raw ? (JSON.parse(raw) as unknown) : [];
        return Array.isArray(list) ? (list as VerifiedTune[]) : [];
    } catch {
        return [];
    }
}

const sameUid = (a: readonly number[] | null | undefined, b: readonly number[] | null | undefined) =>
    !!a && !!b && a.length === 3 && b.length === 3 && a.every((w, i) => w === b[i]);

export const useVerifiedTuneStore = defineStore("gyroflightVerifiedTunes", () => {
    const records = ref<VerifiedTune[]>(readStorage());

    /** Stores a passing record; false (nothing stored) for any record that does not pass. */
    function save(record: VerifiedTune): boolean {
        if (
            verifiedTuneIssues(record, { uid: record.craft?.uid ?? null, firmware: record.craft?.firmware ?? null })
                .length
        ) {
            return false;
        }
        const others = records.value.filter((r) => r.id !== record.id);
        const same = [record, ...others.filter((r) => sameUid(r.craft.uid, record.craft.uid))].slice(0, PER_CRAFT);
        const next = [...same, ...others.filter((r) => !sameUid(r.craft.uid, record.craft.uid))];
        try {
            globalThis.localStorage.setItem(VERIFIED_TUNE_STORAGE_KEY, JSON.stringify(next));
        } catch {
            return false;
        }
        records.value = next;
        return true;
    }

    /** The newest record that is valid evidence for this craft and firmware, or null. */
    function forCraft(uid: readonly number[] | null, firmware: string | null): VerifiedTune | null {
        return records.value.find((r) => verifiedTuneIssues(r, { uid, firmware }).length === 0) ?? null;
    }

    function reload() {
        records.value = readStorage();
    }

    return { records, save, forCraft, reload };
});
