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
 * The Web Locks API (navigator.locks) for the test environment: jsdom has none. This stands in for
 * the browser primitive, not for Gyroflight's locks: it implements the part of the specification
 * Gyroflight uses (https://w3c.github.io/web-locks/): per name a queue of requests granted in
 * order; an exclusive lock conflicts with every other, shared locks only with exclusive ones; a
 * request is granted only when it conflicts with no held lock and no request queued before it (so
 * a shared request behind a pending exclusive one waits); `ifAvailable` (granted at once or the
 * callback gets null); `signal` (aborting a request not yet granted rejects it with an AbortError);
 * a lock held until the callback's promise settles. `steal` is not modelled. All "pages" of a test
 * share it, as all tabs of one origin share the browser's.
 *
 * What it cannot show: that a real browser keeps a lock until the page closes and releases it then,
 * across processes. The real-browser check is test/browser/crossTabWriteLease.browser.mjs.
 */

type Mode = "exclusive" | "shared";
type Grant = { name: string; mode: Mode };
type Callback = (lock: Grant | null) => unknown;

interface Request {
    name: string;
    mode: Mode;
    run: () => void;
}

export interface LockManagerShim {
    request(
        name: string,
        a: Callback | { ifAvailable?: boolean; mode?: Mode; signal?: AbortSignal },
        b?: Callback,
    ): Promise<unknown>;
    query(): Promise<{ held: Grant[]; pending: Grant[] }>;
}

export function createLockManager(): LockManagerShim {
    const held: Grant[] = [];
    const queue: Request[] = [];

    const conflicts = (name: string, mode: Mode, against: readonly { name: string; mode: Mode }[]) =>
        against.some((o) => o.name === name && (mode === "exclusive" || o.mode === "exclusive"));

    const grantable = (name: string, mode: Mode, before: readonly Request[]) =>
        !conflicts(name, mode, held) && !conflicts(name, mode, before);

    function pump(): void {
        for (let i = 0; i < queue.length;) {
            const r = queue[i];
            if (grantable(r.name, r.mode, queue.slice(0, i))) {
                queue.splice(i, 1);
                r.run();
            } else {
                i++;
            }
        }
    }

    const hold = (name: string, mode: Mode, cb: Callback): Promise<unknown> => {
        const grant = { name, mode };
        held.push(grant);
        return Promise.resolve()
            .then(() => cb(grant))
            .finally(() => {
                held.splice(held.indexOf(grant), 1);
                pump();
            });
    };

    return {
        request(name, a, b) {
            const options = typeof a === "function" ? {} : a;
            const cb = (typeof a === "function" ? a : b)!;
            const mode: Mode = options.mode ?? "exclusive";
            const abortError = () => Object.assign(new Error("The request was aborted."), { name: "AbortError" });
            if (options.signal?.aborted) return Promise.reject(abortError());
            if (grantable(name, mode, queue)) return hold(name, mode, cb);
            if (options.ifAvailable) return Promise.resolve().then(() => cb(null));
            return new Promise((resolve, reject) => {
                const r: Request = { name, mode, run: () => void hold(name, mode, cb).then(resolve, reject) };
                queue.push(r);
                options.signal?.addEventListener("abort", () => {
                    const i = queue.indexOf(r);
                    if (i === -1) return;
                    queue.splice(i, 1);
                    reject(abortError());
                    pump();
                });
            });
        },
        async query() {
            return {
                held: held.map((g) => ({ ...g })),
                pending: queue.map((r) => ({ name: r.name, mode: r.mode })),
            };
        },
    };
}

/** Install the shim as navigator.locks when the environment has none; returns the one in use. */
export function installWebLocks(): unknown {
    const nav = globalThis.navigator as unknown as { locks?: unknown } | undefined;
    if (nav && !nav.locks) {
        Object.defineProperty(nav, "locks", { value: createLockManager(), configurable: true, writable: true });
    }
    return nav?.locks;
}
