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
 * The Flight A/B selector's state over the local Tune Session store: list,
 * open, choose A and B, and save the current analysis on request. The A/B
 * decisions are session/selection.ts; this only sequences the IndexedDB calls.
 *
 * Every list and load carries a token; a result that arrives after a newer
 * request was made is dropped, so a slow load of a previous session never
 * replaces the session the user has opened since.
 */

import { computed, getCurrentScope, onScopeDispose, ref, shallowRef } from "vue";
import type { ChirpQualificationReport } from "@/gyrocore/chirp/qualification";
import { addFlights, flightsFromReport, newTuneSession, type AddFlightsResult } from "@/gyrocore/session/build";
import type { LoadResult, SessionSummary, TuneSession } from "@/gyrocore/session/contract";
import {
    abVerification,
    EMPTY_SELECTION,
    reconcileSelection,
    selectFlight,
    selectionForSession,
    sessionFlights,
    type AbSelection,
    type AbSide,
} from "@/gyrocore/session/selection";
import { openTuneSessionStore, TuneSessionStorageError, type TuneSessionStore } from "@/gyrocore/session/storage";

export type AsyncState = "idle" | "loading" | "ready" | "error";

export interface SaveOutcome {
    status: "saved" | "nothing_to_save" | "error";
    sessionId: string | null;
    /** Logs of the analysis that could not be stored, with the reason (WU3 flightsFromReport). */
    skipped: { logIndex: number; reasons: string[] }[];
    /** Stored, but the same recording as a Flight already in the session. */
    notIndependent: AddFlightsResult["notIndependent"];
    error: string | null;
}

function errorCode(err: unknown): string {
    return err instanceof TuneSessionStorageError ? err.code : "io";
}

export function useFlightAbSelector(opts: { store?: TuneSessionStore; now?: () => Date } = {}) {
    let store = opts.store ?? null;
    const now = () => (opts.now ?? (() => new Date()))().toISOString();
    const getStore = () => (store ??= openTuneSessionStore());

    const sessions = ref<SessionSummary[]>([]);
    const listState = ref<AsyncState>("idle");
    const listError = ref<string | null>(null);

    const sessionId = ref<string | null>(null);
    const loaded = shallowRef<LoadResult | null>(null);
    const loadState = ref<AsyncState>("idle");
    const loadError = ref<string | null>(null);

    const selection = ref<AbSelection>(EMPTY_SELECTION);
    const saving = ref(false);

    let listToken = 0;
    let loadToken = 0;

    const session = computed<TuneSession | null>(() =>
        loaded.value?.status === "ok" && loaded.value.session.id === sessionId.value ? loaded.value.session : null,
    );
    const flights = computed(() => sessionFlights(session.value ? loaded.value : null));
    const verification = computed(() => abVerification(session.value, selection.value));

    async function refreshSessions(): Promise<void> {
        const token = ++listToken;
        listState.value = "loading";
        listError.value = null;
        try {
            const items = await getStore().list();
            if (token !== listToken) {
                return;
            }
            sessions.value = [...items].sort((x, y) => (y.updatedAt ?? "").localeCompare(x.updatedAt ?? ""));
            listState.value = "ready";
        } catch (err) {
            if (token !== listToken) {
                return;
            }
            sessions.value = [];
            listError.value = errorCode(err);
            listState.value = "error";
        }
    }

    /**
     * Open a session (null closes it). Another session drops both choices; the
     * same session again is a reload that keeps the choices still selectable.
     */
    async function openSession(id: string | null): Promise<void> {
        const token = ++loadToken;
        sessionId.value = id;
        selection.value = selectionForSession(selection.value, id);
        loaded.value = null;
        loadError.value = null;
        if (id === null) {
            loadState.value = "idle";
            return;
        }
        loadState.value = "loading";
        try {
            const result = await getStore().load(id);
            if (token !== loadToken) {
                return;
            }
            loaded.value = result;
            loadState.value = "ready";
            selection.value = reconcileSelection(
                selection.value,
                id,
                sessionFlights(result.status === "ok" && result.session.id === id ? result : null),
            );
        } catch (err) {
            if (token !== loadToken) {
                return;
            }
            loadError.value = errorCode(err);
            loadState.value = "error";
            selection.value = reconcileSelection(selection.value, id, sessionFlights(null));
        }
    }

    function reloadSession(): Promise<void> {
        return openSession(sessionId.value);
    }

    /** Choose Flight A or B by FlightRef locationId; the other side never changes. */
    function select(side: AbSide, key: string | null): boolean {
        const next = selectFlight(selection.value, session.value?.id ?? null, flights.value, side, key);
        if (next === selection.value) {
            return false;
        }
        selection.value = next;
        return true;
    }

    /**
     * Store the analysed log's Flights, only when the user asks: as a new
     * session, or into the open session (refused when none is open). A damaged
     * record is never written over (the store refuses it).
     */
    async function saveAnalysis(
        report: ChirpQualificationReport,
        target: { intoOpenSession: boolean; name: string },
    ): Promise<SaveOutcome> {
        const t = now();
        const { flights: fresh, skipped } = flightsFromReport(report, { fileName: report.filename, analyzedAt: t });
        const outcome: SaveOutcome = {
            status: "nothing_to_save",
            sessionId: null,
            skipped,
            notIndependent: [],
            error: null,
        };
        if (!fresh.length) {
            return outcome;
        }
        const open = loaded.value;
        const openOk = open?.status === "ok" && open.session.id === sessionId.value;
        if (target.intoOpenSession && !openOk) {
            // Never fall back to a new session: the user asked for this one.
            return { ...outcome, status: "error", error: "no_open_session" };
        }
        saving.value = true;
        try {
            let saved: TuneSession;
            if (target.intoOpenSession && open?.status === "ok") {
                const added = addFlights(open.session, fresh, t);
                outcome.notIndependent = added.notIndependent;
                saved = await getStore().save(added.session);
            } else {
                // Copies within the new analysis itself are reported the same way.
                outcome.notIndependent = addFlights(
                    newTuneSession({ id: "new", name: "", now: t }),
                    fresh,
                    t,
                ).notIndependent;
                saved = await getStore().create(target.name, fresh);
            }
            outcome.status = "saved";
            outcome.sessionId = saved.id;
            await refreshSessions();
            await openSession(saved.id);
        } catch (err) {
            outcome.status = "error";
            outcome.error = errorCode(err);
        } finally {
            saving.value = false;
        }
        return outcome;
    }

    if (getCurrentScope()) {
        onScopeDispose(() => {
            // Results that arrive after unmount are dropped like stale ones.
            listToken++;
            loadToken++;
            if (!opts.store) {
                store?.close();
            }
        });
    }

    return {
        sessions,
        listState,
        listError,
        sessionId,
        loaded,
        loadState,
        loadError,
        session,
        flights,
        selection,
        verification,
        saving,
        refreshSessions,
        openSession,
        reloadSession,
        select,
        saveAnalysis,
    };
}
