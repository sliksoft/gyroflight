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
 * Local Tune Session storage in IndexedDB. Local only: nothing is uploaded.
 * Records are validated on every read and write; a damaged record is reported
 * and left as it is, never repaired or overwritten without being asked.
 */

import { addFlights, newTuneSession, TuneSessionDataError } from "./build";
import type { LoadResult, SessionSummary, StoredFlight, TuneSession } from "./contract";
import {
    migrateTuneSession,
    plainJsonProblems,
    TUNE_SESSION_MIGRATIONS,
    validateTuneSession,
    type Migration,
} from "./validate";

export const TUNE_SESSION_DB_NAME = "gyroflight-gyrocore";
export const TUNE_SESSION_DB_VERSION = 1;
export const TUNE_SESSION_STORE = "tuneSessions";

export type TuneSessionStorageErrorCode =
    | "unavailable"
    | "blocked"
    | "quota_exceeded"
    | "io"
    | "invalid_session"
    | "already_exists"
    | "not_found"
    | "damaged_record";

export class TuneSessionStorageError extends Error {
    constructor(
        readonly code: TuneSessionStorageErrorCode,
        readonly problems: string[] = [],
        options?: { cause?: unknown },
    ) {
        super(`tune session storage: ${code}${problems.length ? ` (${problems.join(", ")})` : ""}`, options);
        this.name = "TuneSessionStorageError";
    }
}

export interface TuneSessionStoreOptions {
    indexedDB?: IDBFactory | null;
    now?: () => Date;
    newId?: () => string;
    migrations?: Readonly<Record<number, Migration>>;
}

export interface TuneSessionStore {
    create(name: string, flights?: StoredFlight[]): Promise<TuneSession>;
    load(id: string): Promise<LoadResult>;
    list(): Promise<SessionSummary[]>;
    /** Write a full session. Refuses an invalid one, and refuses to overwrite a damaged record unless asked. */
    save(session: TuneSession, opts?: { replaceDamaged?: boolean }): Promise<TuneSession>;
    remove(id: string): Promise<void>;
    close(): void;
}

function storageError(err: unknown): TuneSessionStorageError {
    if (err instanceof TuneSessionStorageError) {
        return err;
    }
    const name = (err as { name?: string } | null)?.name;
    return new TuneSessionStorageError(name === "QuotaExceededError" ? "quota_exceeded" : "io", [], { cause: err });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(storageError(req.error));
    });
}

function done(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(storageError(tx.error));
        tx.onabort = () => reject(storageError(tx.error));
    });
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        let req: IDBOpenDBRequest;
        try {
            req = factory.open(TUNE_SESSION_DB_NAME, TUNE_SESSION_DB_VERSION);
        } catch (err) {
            reject(new TuneSessionStorageError("unavailable", [], { cause: err }));
            return;
        }
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(TUNE_SESSION_STORE)) {
                db.createObjectStore(TUNE_SESSION_STORE, { keyPath: "id" });
            }
        };
        req.onblocked = () => reject(new TuneSessionStorageError("blocked"));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(new TuneSessionStorageError("unavailable", [], { cause: req.error }));
    });
}

/** Migrate and validate one stored record. */
export function readRecord(
    id: string,
    raw: unknown,
    migrations: Readonly<Record<number, Migration>> = TUNE_SESSION_MIGRATIONS,
): LoadResult {
    const plainProblems = plainJsonProblems(raw);
    if (plainProblems.length || !raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { status: "corrupt", id, problems: plainProblems.length ? plainProblems : ["not_an_object"] };
    }
    const migrated = migrateTuneSession(raw as Record<string, unknown>, migrations);
    if (migrated.status === "unsupported_version") {
        return { status: "unsupported_version", id, schemaVersion: migrated.schemaVersion };
    }
    if (migrated.status === "failed") {
        return { status: "corrupt", id, problems: [`migration_failed:${migrated.from}`] };
    }
    const v = validateTuneSession(migrated.raw);
    if (!v.ok) {
        return { status: "corrupt", id, problems: v.problems };
    }
    if (v.session.id !== id) {
        return { status: "corrupt", id, problems: ["id"] };
    }
    return {
        status: "ok",
        session: v.session,
        rejected: v.rejected,
        migratedFrom: migrated.status === "migrated" ? migrated.from : null,
    };
}

export function openTuneSessionStore(opts: TuneSessionStoreOptions = {}): TuneSessionStore {
    const factory = opts.indexedDB === undefined ? globalThis.indexedDB : opts.indexedDB;
    const now = () => (opts.now ?? (() => new Date()))().toISOString();
    const newId = opts.newId ?? (() => crypto.randomUUID());
    const migrations = opts.migrations ?? TUNE_SESSION_MIGRATIONS;
    let dbPromise: Promise<IDBDatabase> | null = null;

    const db = () => {
        if (!factory) {
            return Promise.reject(new TuneSessionStorageError("unavailable"));
        }
        dbPromise ??= openDb(factory).catch((err) => {
            dbPromise = null;
            throw err;
        });
        return dbPromise;
    };

    async function readRaw(id: string): Promise<unknown> {
        const tx = (await db()).transaction(TUNE_SESSION_STORE, "readonly");
        return request(tx.objectStore(TUNE_SESSION_STORE).get(id));
    }

    /** Validate fully, with no part left out: a session is only written whole. */
    function checked(session: TuneSession): TuneSession {
        const v = validateTuneSession(session);
        if (!v.ok) {
            throw new TuneSessionStorageError("invalid_session", v.problems);
        }
        if (v.rejected.length) {
            throw new TuneSessionStorageError(
                "invalid_session",
                v.rejected.flatMap((r) => r.problems.map((p) => `${r.path}:${p}`)),
            );
        }
        return JSON.parse(JSON.stringify(session)) as TuneSession;
    }

    async function write(session: TuneSession, mode: "add" | "put"): Promise<void> {
        try {
            const tx = (await db()).transaction(TUNE_SESSION_STORE, "readwrite");
            const store = tx.objectStore(TUNE_SESSION_STORE);
            const req = mode === "add" ? store.add(session) : store.put(session);
            const written = done(tx);
            req.onerror = (e) => {
                if (req.error?.name === "ConstraintError") {
                    e.preventDefault();
                    tx.abort();
                }
            };
            await written.catch((err: TuneSessionStorageError) => {
                throw req.error?.name === "ConstraintError" ? new TuneSessionStorageError("already_exists") : err;
            });
        } catch (err) {
            throw storageError(err);
        }
    }

    return {
        async create(name, flights = []) {
            const t = now();
            let session: TuneSession;
            try {
                session = checked(addFlights(newTuneSession({ id: newId(), name, now: t }), flights, t).session);
            } catch (err) {
                throw err instanceof TuneSessionDataError
                    ? new TuneSessionStorageError("invalid_session", err.problems)
                    : err;
            }
            await write(session, "add");
            return session;
        },

        async load(id) {
            const raw = await readRaw(id).catch((err) => {
                throw storageError(err);
            });
            return raw === undefined ? { status: "not_found", id } : readRecord(id, raw, migrations);
        },

        async list() {
            const tx = (await db()).transaction(TUNE_SESSION_STORE, "readonly");
            const store = tx.objectStore(TUNE_SESSION_STORE);
            const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
            return values.map((raw, i): SessionSummary => {
                const id = String(keys[i]);
                const r = readRecord(id, raw, migrations);
                if (r.status !== "ok") {
                    return {
                        id,
                        status: r.status === "unsupported_version" ? "unsupported_version" : "corrupt",
                        name: null,
                        updatedAt: null,
                        flightCount: null,
                        chirpCount: null,
                    };
                }
                return {
                    id,
                    status: "ok",
                    name: r.session.name,
                    updatedAt: r.session.updatedAt,
                    flightCount: r.session.flights.length,
                    chirpCount: r.session.flights.reduce((n, f) => n + f.chirps.length, 0),
                };
            });
        },

        async save(session, saveOpts = {}) {
            const next = checked({ ...session, updatedAt: now() });
            const existing = await this.load(next.id);
            if (existing.status === "not_found") {
                throw new TuneSessionStorageError("not_found");
            }
            // Writing would drop the parts that failed validation, or a record this code cannot read.
            const damaged = existing.status !== "ok" || existing.rejected.length > 0;
            if (damaged && !saveOpts.replaceDamaged) {
                throw new TuneSessionStorageError(
                    "damaged_record",
                    existing.status === "corrupt" ? existing.problems : [],
                );
            }
            await write(next, "put");
            return next;
        },

        async remove(id) {
            try {
                const tx = (await db()).transaction(TUNE_SESSION_STORE, "readwrite");
                tx.objectStore(TUNE_SESSION_STORE).delete(id);
                await done(tx);
            } catch (err) {
                throw storageError(err);
            }
        },

        close() {
            void dbPromise?.then((d) => d.close()).catch(() => undefined);
            dbPromise = null;
        },
    };
}
