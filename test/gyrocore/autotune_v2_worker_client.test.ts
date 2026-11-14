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
 * Worker client contract (completion program 2026-10-28, phase 6): in Node/Vitest, Worker is
 * typically unavailable, so the client falls back to the main-thread engine. Abort before start
 * must fail closed.
 */

import { describe, expect, it } from "vitest";
import { runAutotuneV2Cancellable } from "../../src/gyrocore/engine/autotuneV2WorkerClient";
import { runAutotuneV2, type AutotuneLogInput } from "../../src/gyrocore/engine/autotuneV2";
import { syntheticIdentityLog } from "./harness/syntheticLog";

describe("runAutotuneV2Cancellable", () => {
    it("matches the synchronous engine on the sync fallback path", async () => {
        // Node/Vitest has no Worker: short identity log exercises sync_fallback without 120 s CPU.
        const primary = syntheticIdentityLog("1".repeat(64));
        const input = {
            primary,
            others: [] as AutotuneLogInput[],
            verifiedTune: null,
            createdAt: "2026-10-28T00:00:00Z",
        };
        const sync = runAutotuneV2(input);
        const async = await runAutotuneV2Cancellable(input);
        expect(async.execution).toBe("sync_fallback");
        expect(async.result.safety).toEqual(sync.safety);
        expect(async.result.pid.map((p) => p.status)).toEqual(sync.pid.map((p) => p.status));
        expect(async.result.releasableProposal).toEqual(sync.releasableProposal);
        expect(async.qualification.connectedToApply).toBe(false);
    }, 120_000);

    it("rejects when already aborted", async () => {
        const primary = syntheticIdentityLog("2".repeat(64));
        const input = { primary, others: [] as AutotuneLogInput[], verifiedTune: null };
        const abort = new AbortController();
        abort.abort();
        await expect(runAutotuneV2Cancellable(input, abort.signal)).rejects.toMatchObject({ name: "AbortError" });
    });
});
