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
 * The Web Locks API (navigator.locks) for the test environment: jsdom and Node 22 have none. This
 * stands in for the browser primitive, not for Gyroflight's lock: it implements the part of the
 * specification the write transaction uses (https://w3c.github.io/web-locks/): exclusive locks per
 * name, granted in request order, `ifAvailable` (granted at once or the callback gets null), and a
 * lock held until the callback's promise settles. Shared mode, `steal` and `signal` are not
 * modelled. All "pages" of a test share it, as all tabs of one origin share the browser's.
 *
 * What it cannot show: that a real browser keeps a lock until the page closes and releases it then,
 * across processes. That is NOT_VALIDATED by these tests.
 */

type Grant = { name: string; mode: "exclusive" };
type Callback = (lock: Grant | null) => unknown;

interface Waiter {
    name: string;
    run: () => void;
}

export interface LockManagerShim {
    request(name: string, a: Callback | { ifAvailable?: boolean; mode?: string }, b?: Callback): Promise<unknown>;
    query(): Promise<{ held: Grant[]; pending: Grant[] }>;
}

export function createLockManager(): LockManagerShim {
    const held = new Set<string>();
    const waiting: Waiter[] = [];

    const release = (name: string) => {
        held.delete(name);
        const i = waiting.findIndex((w) => w.name === name);
        if (i !== -1) waiting.splice(i, 1)[0].run();
    };

    const hold = (name: string, cb: Callback): Promise<unknown> => {
        held.add(name);
        return Promise.resolve()
            .then(() => cb({ name, mode: "exclusive" }))
            .finally(() => release(name));
    };

    return {
        request(name, a, b) {
            const options = typeof a === "function" ? {} : a;
            const cb = (typeof a === "function" ? a : b)!;
            if (options.mode && options.mode !== "exclusive") {
                return Promise.reject(new Error("webLocks shim: only exclusive locks are modelled"));
            }
            if (!held.has(name) && !waiting.some((w) => w.name === name)) return hold(name, cb);
            if (options.ifAvailable) return Promise.resolve().then(() => cb(null));
            return new Promise((resolve, reject) => {
                waiting.push({ name, run: () => void hold(name, cb).then(resolve, reject) });
            });
        },
        async query() {
            return {
                held: [...held].map((name) => ({ name, mode: "exclusive" as const })),
                pending: waiting.map((w) => ({ name: w.name, mode: "exclusive" as const })),
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
