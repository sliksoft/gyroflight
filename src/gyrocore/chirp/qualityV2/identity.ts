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
 * Links every CHIRP Quality V2 report to the WU1 file and Flight identity.
 * Hashing is asynchronous (Web Crypto), so this runs after qualifyChirpFile.
 */

import { catalogBbl, type BblCatalog } from "@/gyrocore/flight/identity";
import { Sha256UnavailableError } from "@/gyrocore/flight/sha256";
import type { ChirpMeasurement, ChirpQualificationReport } from "../qualification";
import { refreshReasons } from "./analyze";
import { QV2_REASONS as R, type ChirpQualityV2 } from "./contract";

function attachOne(v2: ChirpQualityV2, catalog: BblCatalog | null, reason: string | null): void {
    const flight = catalog?.flights[v2.identity.logIndex] ?? null;
    if (!catalog || reason) {
        const reasons = [reason ?? R.identityNotAttached];
        v2.identity.file = { availability: "UNKNOWN", sha256: null, byteLength: null, reasons };
        v2.identity.flight = { availability: "UNKNOWN", ref: null, reasons };
        v2.levels.bblValid = { status: "UNKNOWN", role: "DIAGNOSTIC", reasons };
        v2.levels.flightValid = { status: "UNKNOWN", role: "DIAGNOSTIC", reasons };
    } else {
        v2.identity.file = {
            availability: "MEASURED",
            sha256: catalog.file.sha256,
            byteLength: catalog.file.byteLength,
            reasons: [],
        };
        v2.identity.flight = flight
            ? { availability: "MEASURED", ref: flight, reasons: [] }
            : { availability: "UNKNOWN", ref: null, reasons: [R.identityLogCountMismatch] };
        const bblOk = catalog.status === "valid";
        v2.levels.bblValid = { status: bblOk ? "YES" : "NO", role: "DIAGNOSTIC", reasons: bblOk ? [] : [R.bblInvalid] };
        v2.levels.flightValid = flight
            ? {
                  status: flight.status === "valid" ? "YES" : "NO",
                  role: "DIAGNOSTIC",
                  reasons: flight.status === "valid" ? [] : [R.flightInvalid],
              }
            : { status: "UNKNOWN", role: "DIAGNOSTIC", reasons: [R.identityLogCountMismatch] };
    }
    refreshReasons(v2);
}

/**
 * Catalog the file (WU1) and attach its identity to every measurement's
 * Quality V2 report. Never throws for a missing SHA-256: the identity stays
 * UNKNOWN with a reason. Returns the catalog, or null when it could not be built.
 */
export async function attachChirpFlightIdentity(
    report: ChirpQualificationReport,
    bytes: Uint8Array,
): Promise<BblCatalog | null> {
    let catalog: BblCatalog | null = null;
    let reason: string | null = null;
    try {
        catalog = await catalogBbl(bytes);
    } catch (err) {
        if (!(err instanceof Sha256UnavailableError)) {
            throw err;
        }
        reason = R.identityHashUnavailable;
    }
    if (catalog && catalog.flights.length !== report.logCount) {
        reason = R.identityLogCountMismatch;
    }
    for (const m of report.measurements) {
        attachOne(m.qualityV2, catalog, reason);
    }
    return reason ? null : catalog;
}

/** Keep the TUNING AUTHORIZED level in step after recommendations are recomputed. */
export function refreshAuthorizationLevel(m: Pick<ChirpMeasurement, "apply" | "qualityV2">): void {
    const allowed = m.apply.allowed;
    m.qualityV2.levels.tuningAuthorized = {
        status: allowed ? "YES" : "NO",
        role: "ACTIVE_GATE",
        reasons: allowed ? [] : [R.tuningBlocked],
    };
    refreshReasons(m.qualityV2);
}
