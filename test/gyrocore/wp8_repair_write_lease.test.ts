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
 * Audit WP8-F02: the write lease (fcWriteLease.ts). Several "pages" are lease instances sharing one
 * lock manager (harness/webLocks.ts, the specification's queue rules) and a real BroadcastChannel,
 * as the tabs of one origin share the browser's. The second part runs this page's real guard and
 * msp.ts against another page's transaction. Real browser tabs: test/browser (separate report).
 */

import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    createWriteLease,
    FC_WRITE_LEASE_CHANNEL,
    WRITE_LEASE_NOT_HELD,
    WRITE_LEASE_TIMEOUT,
    WRITE_LEASE_UNAVAILABLE,
    WRITE_LEASE_NOT_EXCLUSIVE,
    type WriteLease,
} from "../../src/composables/fcWriteLease";
import { createLockManager, type LockManagerShim } from "./harness/webLocks";
import MSP from "../../src/js/msp";
import MSPCodes from "../../src/js/msp/MSPCodes";
import { serial } from "../../src/js/serial";
import { useConnectionStore } from "../../src/stores/connection";
import { useFlightControllerStore } from "../../src/stores/fc";
import { mspRequestRefusal, withFcWriteLock } from "../../src/composables/fcWriteGuard";
import { ApplyBlockedError } from "../../src/gyrocore/chirp/applyGate";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const refused = (e: unknown) => (e instanceof ApplyBlockedError ? e.reasons : [String(e)]);

let pages: WriteLease[];
let channelName: string;

function page(locks: LockManagerShim | undefined, opts = { quietMs: 40, waitMs: 600 }) {
    const p = createWriteLease(
        {
            locks: () => locks as never,
            channel: () => new BroadcastChannel(channelName) as never,
            now: () => Date.now(),
        },
        opts,
    );
    p.start();
    pages.push(p);
    return p;
}

async function until(cond: () => boolean, ms = 1000) {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) throw new Error("condition not reached");
        await wait(5);
    }
}

beforeEach(() => {
    pages = [];
    channelName = `${FC_WRITE_LEASE_CHANNEL}.test.${Math.random()}`;
});

afterEach(() => {
    for (const p of pages) p.stop();
});

describe("WP8-F02 the write lease between pages of one origin", () => {
    it("every page holds the lease shared and may write", async () => {
        const locks = createLockManager();
        const a = page(locks);
        const b = page(locks);
        await until(() => a.issues().length === 0 && b.issues().length === 0);
    });

    it("while one page's transaction runs, no other page may write; afterwards it may again", async () => {
        const locks = createLockManager();
        const a = page(locks);
        const b = page(locks);
        await until(() => b.issues().length === 0);
        let during: string[] = [];
        let ownDuring: string[] = [];
        await a.exclusive(
            async () => {
                during = b.issues();
                ownDuring = a.issues();
                expect(a.transactionIssues()).toEqual([]);
            },
            (r) => new ApplyBlockedError(r),
        );
        expect(during).toEqual([WRITE_LEASE_NOT_HELD]);
        expect(ownDuring).toEqual([WRITE_LEASE_NOT_HELD]);
        await until(() => b.issues().length === 0 && a.issues().length === 0);
        expect(a.transactionIssues()).toEqual([WRITE_LEASE_NOT_EXCLUSIVE]);
    });

    it("a page in the middle of a save keeps the lease until the save ends, then yields", async () => {
        const locks = createLockManager();
        const a = page(locks);
        const b = page(locks);
        await until(() => b.issues().length === 0);
        b.noteSave(1);
        let ran = false;
        const tx = a.exclusive(
            async () => {
                ran = true;
            },
            (r) => new ApplyBlockedError(r),
        );
        await wait(150);
        expect(ran).toBe(false);
        expect(b.issues()).toEqual([]); // the save goes on
        b.noteSave(-1);
        await tx;
        expect(ran).toBe(true);
    });

    it("a page with a write awaiting its answer, or one admitted just now, does not yield yet", async () => {
        const locks = createLockManager();
        const a = page(locks);
        const b = page(locks);
        await until(() => b.issues().length === 0);
        let busy = true;
        b.setBusyProbe(() => busy);
        b.noteAdmitted();
        let ran = false;
        const tx = a.exclusive(
            async () => {
                ran = true;
            },
            (r) => new ApplyBlockedError(r),
        );
        await wait(150);
        expect(ran).toBe(false);
        busy = false;
        await tx;
        expect(ran).toBe(true);
    });

    it("a page that never gets quiet: the transaction is refused (timeout), never run without the lease", async () => {
        const locks = createLockManager();
        const a = page(locks);
        const b = page(locks);
        await until(() => b.issues().length === 0);
        b.noteSave(1);
        let ran = false;
        const err = await a
            .exclusive(
                async () => {
                    ran = true;
                },
                (r) => new ApplyBlockedError(r),
            )
            .catch((e: unknown) => e);
        expect(refused(err)).toEqual([WRITE_LEASE_TIMEOUT]);
        expect(ran).toBe(false);
        expect(b.issues()).toEqual([]);
        await until(() => a.issues().length === 0);
    });

    it("a transaction right after its page started (its own shared request still pending) does not wait on itself", async () => {
        const locks = createLockManager();
        const a = page(locks);
        let ran = false;
        await a.exclusive(
            async () => {
                ran = true;
            },
            (r) => new ApplyBlockedError(r),
        );
        expect(ran).toBe(true);
    });

    it("a page that starts while a transaction runs gets the lease only after it", async () => {
        const locks = createLockManager();
        const a = page(locks);
        await until(() => a.issues().length === 0);
        let late: WriteLease | null = null;
        await a.exclusive(
            async () => {
                late = page(locks);
                await wait(50);
                expect(late.issues()).toEqual([WRITE_LEASE_NOT_HELD]);
            },
            (r) => new ApplyBlockedError(r),
        );
        await until(() => late!.issues().length === 0);
    });

    it("a failing transaction gives the lease back to everyone", async () => {
        const locks = createLockManager();
        const a = page(locks);
        const b = page(locks);
        await until(() => b.issues().length === 0);
        await expect(
            a.exclusive(
                async () => {
                    throw new Error("boom");
                },
                (r) => new ApplyBlockedError(r),
            ),
        ).rejects.toThrow("boom");
        await until(() => a.issues().length === 0 && b.issues().length === 0);
    });

    // Codex review round 2: a yield request that arrives before the exclusive request is queued.
    it("a page that took the lease back before the request was queued is asked again", async () => {
        const locks = createLockManager();
        // The transaction's request reaches the lock manager 100 ms late (a descheduled page).
        const late = {
            request: (name: string, opts: never, cb: never) =>
                new Promise((resolve, reject) =>
                    setTimeout(() => (locks.request(name, opts, cb) as Promise<unknown>).then(resolve, reject), 100),
                ),
        };
        const a = page(late as never, { quietMs: 10, waitMs: 1500 });
        const b = page(locks, { quietMs: 10, waitMs: 1500 });
        await until(() => b.issues().length === 0);
        let ran = false;
        await a.exclusive(
            async () => {
                ran = true;
            },
            (r) => new ApplyBlockedError(r),
        );
        expect(ran).toBe(true);
    });

    it("without Web Locks nothing may write and no transaction runs (fail-closed)", async () => {
        const a = page(undefined);
        expect(a.issues()).toEqual([WRITE_LEASE_UNAVAILABLE]);
        const err = await a
            .exclusive(
                async () => 1,
                (r) => new ApplyBlockedError(r),
            )
            .catch((e: unknown) => e);
        expect(refused(err)).toEqual([WRITE_LEASE_UNAVAILABLE]);
    });

    it("a lock manager without shared mode: the lease is never held, so nothing writes (fail-closed)", async () => {
        const exclusiveOnly = {
            request: (_n: string, o: { mode?: string }) =>
                o.mode === "shared" ? Promise.reject(new Error("unsupported")) : Promise.resolve(undefined),
        };
        const a = page(exclusiveOnly as never);
        await wait(30);
        expect(a.issues()).toEqual([WRITE_LEASE_NOT_HELD]);
    });
});

describe("WP8-F02 this page's guard and msp.ts against another page's transaction", () => {
    const UID: [number, number, number] = [3, 3, 3];
    let sent: number[][];

    beforeEach(() => {
        setActivePinia(createPinia());
        localStorage.clear();
        sent = [];
        (serial as unknown as { _protocol: unknown })._protocol = { connected: true };
        vi.spyOn(serial, "send").mockImplementation(async (d) => {
            sent.push(Array.from(new Uint8Array(d as ArrayBuffer)));
            return { bytesSent: (d as ArrayBuffer).byteLength };
        });
        useConnectionStore().virtualMode = false;
        useFlightControllerStore().config.uid = [...UID];
        MSP.callbacks = [];
        MSP.write_transmissions.clear();
        MSP.parked.clear();
    });

    afterEach(() => {
        MSP.callbacks_cleanup();
        vi.restoreAllMocks();
    });

    /** Another page of this origin (it shares navigator.locks and the real channel name). */
    function otherPage() {
        const p = createWriteLease({
            locks: () => (navigator as unknown as { locks: never }).locks,
            channel: () => new BroadcastChannel(FC_WRITE_LEASE_CHANNEL) as never,
            now: () => Date.now(),
        });
        p.start();
        pages.push(p);
        return p;
    }

    it("before the other page's transaction stored any entry (its reads), this page's SET is refused and not sent", async () => {
        await until(() => mspRequestRefusal(MSPCodes.MSP_SET_PID, [1]) === null);
        const other = otherPage();
        let release!: () => void;
        let inside!: () => void;
        const entered = new Promise<void>((r) => (inside = r));
        const tx = other.exclusive(
            () =>
                new Promise<void>((r) => {
                    release = r;
                    inside();
                }),
            (r) => new ApplyBlockedError(r),
        );
        await entered;
        expect(localStorage.length).toBe(0); // no pending entry: the phase before it is stored
        const err = await MSP.promise(MSPCodes.MSP_SET_PID, [1]).catch((e: unknown) => e);
        expect(refused(err)).toContain(WRITE_LEASE_NOT_HELD);
        expect(sent).toEqual([]);
        // Reads still go out.
        void MSP.promise(MSPCodes.MSP_PID).catch(() => undefined);
        expect(sent).toHaveLength(1);
        release();
        await tx;
        await until(() => mspRequestRefusal(MSPCodes.MSP_SET_PID, [1]) === null);
    });

    it("a CLI write of this page is refused too (only reads, behind the line clearing)", async () => {
        await until(() => mspRequestRefusal(MSPCodes.MSP_SET_PID, [1]) === null);
        const other = otherPage();
        let release!: () => void;
        let inside!: () => void;
        const entered = new Promise<void>((r) => (inside = r));
        const tx = other.exclusive(
            () =>
                new Promise<void>((r) => {
                    release = r;
                    inside();
                }),
            (r) => new ApplyBlockedError(r),
        );
        await entered;
        const results: unknown[] = [];
        MSP.send_cli_command("set p_roll = 99", (_l, e) => results.push(e));
        expect(refused(results[0])).toContain(WRITE_LEASE_NOT_HELD);
        expect(sent).toEqual([]);
        release();
        await tx;
    });

    // Codex review round 2: busy is what is still with the transport, not an MSP retry timer.
    it("this page keeps the lease while a send of it is still with the transport (its request gave up)", async () => {
        await until(() => mspRequestRefusal(MSPCodes.MSP_SET_PID, [1]) === null);
        vi.mocked(serial.send).mockRestore();
        let finish!: (r: { bytesSent: number }) => void;
        (serial as unknown as { _protocol: unknown })._protocol = {
            connected: true,
            send: () => new Promise((resolve) => (finish = resolve)),
        };
        void serial.send(new Uint8Array([0x23]).buffer); // raw CLI text, not in any MSP queue
        const other = createWriteLease(
            {
                locks: () => (navigator as unknown as { locks: never }).locks,
                channel: () => new BroadcastChannel(FC_WRITE_LEASE_CHANNEL) as never,
                now: () => Date.now(),
            },
            { waitMs: 800 },
        );
        other.start();
        pages.push(other);
        await wait(700); // well past QUIET_MS
        const err = await other
            .exclusive(
                async () => 1,
                (r) => new ApplyBlockedError(r),
            )
            .catch((e: unknown) => e);
        expect(refused(err)).toEqual([WRITE_LEASE_TIMEOUT]);
        finish({ bytesSent: 1 });
    });

    it("this page's own transaction waits for the other page's save to end before it reads anything", async () => {
        await until(() => mspRequestRefusal(MSPCodes.MSP_SET_PID, [1]) === null);
        const other = otherPage();
        await until(() => other.issues().length === 0);
        other.noteSave(1);
        let ran = false;
        const tx = withFcWriteLock(async () => {
            ran = true;
            expect(other.issues()).toEqual([WRITE_LEASE_NOT_HELD]);
        });
        await wait(500);
        expect(ran).toBe(false);
        other.noteSave(-1);
        await tx;
        expect(ran).toBe(true);
    });
});
