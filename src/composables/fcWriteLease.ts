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
 * The write lease (audit WP8-F02): every write admission of every tab of this browser origin takes
 * part in one Web Lock, FC_WRITE_LEASE.
 *
 *   - Each page holds the lease in shared mode for as long as it runs, and admits a write that is
 *     not part of a Gyroflight transaction (fcWriteGuard foreign writes: SETs, saves, CLI writes)
 *     only while it holds it. The check is synchronous: `held` is set when the lock is granted and
 *     cleared before it is released.
 *   - A Gyroflight write transaction or read-only check (fcWriteGuard.withFcWriteLock) takes the
 *     lease in exclusive mode for its whole run, reads included. The exclusive grant means no other
 *     page of this origin holds it, so none admits a write until the transaction ends.
 *   - To get it, the transaction's page drops its own shared hold first (or it would wait on
 *     itself), aborts its own pending shared request, queues its exclusive request and asks the
 *     other pages to yield (BroadcastChannel), again every YIELD_REPEAT_MS until granted. A page
 *     yields once it is quiet: nothing it sent still with the transport, no write of its own still
 *     awaiting its answer, no save in progress (useSaving), and none admitted in the last QUIET_MS.
 *     It then asks for the shared lease again, which Web Locks grants after an exclusive request
 *     queued before it (one queued later is asked again). The exclusive request gives up after
 *     LEASE_WAIT_MS (a page that never gets quiet, a frozen page): the transaction is refused,
 *     never run without it.
 *   - Without Web Locks no page holds the lease: every such write is refused (fail-closed).
 *
 * What it cannot do: it covers this browser origin only (not another browser, another origin, an
 * installed copy, another device or program). Requests the guard does not count as writes (reads,
 * and the runtime requests: RTC, arming flag, motor test, reboot) are not held back. A page that
 * closes mid-write releases its locks; what it sent stays sent.
 */

/** The Web Lock every page holds shared while it may write, and a Gyroflight transaction exclusive. */
export const FC_WRITE_LEASE = "gyroflight.fcWrite.lease";
/** Where a transaction asks the other pages to yield. */
export const FC_WRITE_LEASE_CHANNEL = "gyroflight.fcWrite.lease";
/** This page does not hold the lease now (another page's transaction runs, or it is being granted). */
export const WRITE_LEASE_NOT_HELD = "fc:write_lease_not_held";
/** A transaction did not get the lease in time: another page did not yield. */
export const WRITE_LEASE_TIMEOUT = "fc:write_lease_timeout";
/** No Web Locks: no page can take part, so none writes. */
export const WRITE_LEASE_UNAVAILABLE = "fc:write_lease_unavailable";
/** A transaction's own write while its page does not hold the lease exclusively. */
export const WRITE_LEASE_NOT_EXCLUSIVE = "fc:write_lease_not_exclusive";

/** How long a page must have admitted no write before it yields (the gap between a save's steps). */
export const QUIET_MS = 300;
/** How long a transaction waits for the other pages to yield. */
export const LEASE_WAIT_MS = 8000;
/** How often a waiting transaction asks the other pages again. */
const YIELD_REPEAT_MS = 250;

interface LockOptions {
    mode?: "shared" | "exclusive";
    ifAvailable?: boolean;
    signal?: AbortSignal;
}

interface LockManagerLike {
    request<T>(name: string, options: LockOptions, cb: (lock: unknown) => Promise<T> | T): Promise<T>;
}

interface ChannelLike {
    postMessage(message: unknown): void;
    addEventListener(type: "message", listener: (e: MessageEvent) => void): void;
    close(): void;
}

export interface WriteLeaseEnv {
    locks: () => LockManagerLike | undefined;
    channel: () => ChannelLike | undefined;
    now: () => number;
}

const browserEnv: WriteLeaseEnv = {
    locks: () => (globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks,
    channel: () =>
        typeof globalThis.BroadcastChannel === "function"
            ? (new globalThis.BroadcastChannel(FC_WRITE_LEASE_CHANNEL) as unknown as ChannelLike)
            : undefined,
    now: () => Date.now(),
};

export type WriteLease = ReturnType<typeof createWriteLease>;

/** One page's lease. The app uses the module's own (writeLease); tests build several to stand for pages. */
export function createWriteLease(
    env: WriteLeaseEnv = browserEnv,
    { quietMs = QUIET_MS, waitMs = LEASE_WAIT_MS }: { quietMs?: number; waitMs?: number } = {},
) {
    const state = {
        held: false,
        exclusive: false,
        /** A transaction of this page wants or holds the exclusive lease: no shared request now. */
        transaction: false,
        release: null as (() => void) | null,
        pending: null as AbortController | null,
        yieldWanted: false,
        yieldTimer: null as ReturnType<typeof setTimeout> | null,
        yieldExpiry: null as ReturnType<typeof setTimeout> | null,
        lastAdmitted: Number.NEGATIVE_INFINITY,
        saving: 0,
        started: false,
    };
    let busy: () => boolean = () => false;
    let channel: ChannelLike | undefined;

    function acquireShared(): void {
        const locks = env.locks();
        if (!locks || state.held || state.pending || state.transaction) return;
        const pending = new AbortController();
        state.pending = pending;
        locks
            .request(FC_WRITE_LEASE, { mode: "shared", signal: pending.signal }, () => {
                // Granted after this page's transaction gave it up (an abort cannot undo a grant
                // whose callback has not run yet): hand it back at once, or that transaction would
                // wait on its own page.
                if (pending.signal.aborted || state.transaction) {
                    if (state.pending === pending) state.pending = null;
                    return undefined;
                }
                return new Promise<void>((release) => {
                    state.pending = null;
                    state.held = true;
                    state.release = () => {
                        // Cleared before the lock goes: from here on this page admits no write.
                        state.held = false;
                        state.release = null;
                        release();
                    };
                    if (state.yieldWanted) tryYield();
                });
            })
            .catch(() => {
                // Aborted for this page's own transaction, or refused: not held.
                if (state.pending === pending) state.pending = null;
            });
    }

    function quiet(): boolean {
        return !busy() && state.saving === 0 && env.now() - state.lastAdmitted >= quietMs;
    }

    function tryYield(): void {
        if (state.yieldTimer) {
            clearTimeout(state.yieldTimer);
            state.yieldTimer = null;
        }
        if (!state.yieldWanted || !state.held || state.transaction) return;
        if (!quiet()) {
            const wait = Math.max(quietMs - (env.now() - state.lastAdmitted), 50);
            state.yieldTimer = setTimeout(tryYield, wait);
            return;
        }
        state.yieldWanted = false;
        state.release?.();
        // Queued behind the exclusive request that asked: granted once that transaction ends.
        acquireShared();
    }

    function onMessage(e: MessageEvent): void {
        if ((e.data as { type?: string } | null)?.type !== "yield") return;
        state.yieldWanted = true;
        // A page that never gets quiet keeps its lease; the transaction gives up after LEASE_WAIT_MS.
        if (state.yieldExpiry) clearTimeout(state.yieldExpiry);
        state.yieldExpiry = setTimeout(() => {
            state.yieldWanted = false;
        }, waitMs);
        tryYield();
    }

    return {
        /** Start holding the lease (once per page). */
        start(): void {
            if (state.started) return;
            state.started = true;
            channel = env.channel();
            channel?.addEventListener("message", onMessage);
            acquireShared();
        },

        /** Why a write that is not part of a Gyroflight transaction must not go out now; [] when it may. */
        issues(): string[] {
            if (!env.locks()) return [WRITE_LEASE_UNAVAILABLE];
            return state.held ? [] : [WRITE_LEASE_NOT_HELD];
        },

        /** Why a transaction's own write must not go out now: its page must hold the lease exclusively. */
        transactionIssues(): string[] {
            return state.exclusive ? [] : [WRITE_LEASE_NOT_EXCLUSIVE];
        },

        /** A write that is not part of a Gyroflight transaction was admitted now. */
        noteAdmitted(): void {
            state.lastAdmitted = env.now();
        },

        /** A save (several writes and the EEPROM save, useSaving) began / ended: no yielding in between. */
        noteSave(delta: 1 | -1): void {
            state.saving = Math.max(0, state.saving + delta);
            if (delta < 0 && state.yieldWanted) tryYield();
        },

        /** Whether a write this page admitted is still awaiting its answer (msp.ts registers it). */
        setBusyProbe(probe: () => boolean): void {
            busy = probe;
        },

        /**
         * Run `fn` holding the lease exclusively, or refuse: no Web Locks, or the other pages did not
         * yield within LEASE_WAIT_MS. Throws `refuse([reason])`.
         */
        async exclusive<T>(fn: () => Promise<T>, refuse: (reasons: string[]) => Error): Promise<T> {
            const locks = env.locks();
            if (!locks) throw refuse([WRITE_LEASE_UNAVAILABLE]);
            state.transaction = true;
            state.yieldWanted = false;
            state.pending?.abort();
            state.pending = null;
            state.release?.();
            const timeout = new AbortController();
            const timer = setTimeout(() => timeout.abort(), waitMs);
            let asking: ReturnType<typeof setInterval> | undefined;
            const exclusive = locks.request(FC_WRITE_LEASE, { mode: "exclusive", signal: timeout.signal }, async () => {
                clearTimeout(timer);
                clearInterval(asking);
                state.exclusive = true;
                try {
                    return await fn();
                } finally {
                    state.exclusive = false;
                }
            });
            // Asked after the request is queued, and again until it is granted: a page that took the
            // lease back before the request was queued, or started meanwhile, is asked again (audit
            // WP8-F02 review).
            channel?.postMessage({ type: "yield" });
            if (!state.exclusive) asking = setInterval(() => channel?.postMessage({ type: "yield" }), YIELD_REPEAT_MS);
            try {
                return await exclusive;
            } catch (err) {
                if (timeout.signal.aborted && !state.exclusive) throw refuse([WRITE_LEASE_TIMEOUT]);
                throw err;
            } finally {
                clearTimeout(timer);
                clearInterval(asking);
                state.transaction = false;
                acquireShared();
            }
        },

        /** For tests and diagnostics. */
        snapshot() {
            return { held: state.held, exclusive: state.exclusive, yieldWanted: state.yieldWanted };
        },

        /** Stop taking part (a test's page "closing"): release and leave the channel. */
        stop(): void {
            state.pending?.abort();
            state.pending = null;
            state.release?.();
            channel?.close();
            channel = undefined;
            state.started = false;
        },
    };
}

/** This page's lease. */
export const writeLease = createWriteLease();
