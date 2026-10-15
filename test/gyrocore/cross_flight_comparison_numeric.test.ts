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
 * WU5 final fix: input-power evidence of a bin and floating-point overflow.
 * SYNTHETIC logs through the real analysis; the bins are then edited in memory.
 * Expected values are written out here, never taken from the production helpers.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { AUTOTUNE_MATH } from "../../src/composables/useAutotune";
import { qualifyChirpFile } from "../../src/gyrocore/chirp/qualification";
import type { CoherenceBinsV2 } from "../../src/gyrocore/chirp/qualityV2/contract";
import { attachChirpFlightIdentity } from "../../src/gyrocore/chirp/qualityV2/identity";
import { compareFlights } from "../../src/gyrocore/compare/compare";
import type { ChirpPairComparison } from "../../src/gyrocore/compare/contract";
import { lineChart } from "../../src/gyrocore/compare/view";
import { addFlights, flightsFromReport, newTuneSession } from "../../src/gyrocore/session/build";
import type { StoredFlight, TuneSession } from "../../src/gyrocore/session/contract";
import { encodeChirpLog, FULL_TUNE_HEADERS, simulateChirpSequence } from "./harness/chirpSim";

const T0 = "2026-10-13T19:30:00.000Z";
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

const HEADERS = [
    ...FULL_TUNE_HEADERS,
    "chirp_amplitude_roll:200",
    "chirp_amplitude_pitch:200",
    "chirp_amplitude_yaw:200",
    "Board information:SYNT SYNTHETIC",
    "Craft name:SYNTHETIC",
    "Firmware date:Jun  1 2026 12:00:00",
    "Firmware API version:1.48.0",
];

async function flight(crossoverHz: number, start: string, fileName: string): Promise<StoredFlight> {
    const bytes = encodeChirpLog(simulateChirpSequence([{ seconds: 6, firmwareDebug: true, axis: 0, crossoverHz }]), [
        ...HEADERS,
        `Log start datetime:${start}`,
    ]);
    const r = qualifyChirpFile(bytes, fileName, 60, AUTOTUNE_MATH);
    await attachChirpFlightIdentity(r, bytes);
    return flightsFromReport(r, { fileName, analyzedAt: T0 }).flights[0];
}

let flightA: StoredFlight;
let flightB: StoredFlight;

beforeAll(async () => {
    flightA = await flight(40, "2026-10-13T10:00:00.000+00:00", "a.bbl");
    flightB = await flight(30, "2026-10-13T10:10:00.000+00:00", "b.bbl");
}, 60_000);

/** A session whose B roll-1 bins start as a copy of A's; `edit` then changes A and B. */
function pair(edit: (a: CoherenceBinsV2, b: CoherenceBinsV2) => void): ChirpPairComparison {
    const s: TuneSession = json(
        addFlights(newTuneSession({ id: "s", name: "s", now: T0 }), [flightA, flightB], T0).session,
    );
    const a = s.flights[0].chirps[0].qualityV2.coherence;
    const b = s.flights[1].chirps[0].qualityV2.coherence;
    b.bins = json(a.bins);
    edit(a.bins, b.bins);
    const r = compareFlights(
        { status: "ok", session: s, rejected: [], migratedFrom: null },
        {
            sessionId: s.id,
            a: s.flights[0].key,
            b: s.flights[1].key,
            cleared: [],
        },
    );
    expect(r.abStatus).toBe("ELIGIBLE");
    // Whatever the edit, the result is plain finite JSON.
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    return r.axes[0].pairs[0];
}

const usable = (b: CoherenceBinsV2) => b.status.flatMap((s, i) => (s === "USABLE" ? [i] : []));

describe("the SYNTHETIC fixture", () => {
    it("matches the Quality V2 producer: in band, a magnitude means USABLE or WEAK_COHERENCE, none means NO_INPUT_POWER", () => {
        const b = flightA.chirps[0].qualityV2.coherence.bins;
        b.status.forEach((s, i) => {
            if (s === "USABLE" || s === "WEAK_COHERENCE") {
                expect(Number.isFinite(b.magnitudeDb[i])).toBe(true);
            }
            if (s === "NO_INPUT_POWER") {
                expect(b.magnitudeDb[i]).toBeNull();
            }
        });
        expect(usable(b).length).toBeGreaterThan(20);
    });
});

describe("FIX 1: input-power evidence", () => {
    it("WEAK_COHERENCE without a magnitude contradicts the input-power evidence: no coherence difference", () => {
        const p = pair((_a, b) => {
            const i = usable(b)[3];
            b.status[i] = "WEAK_COHERENCE";
            b.coherence[i] = 0.3;
            b.magnitudeDb[i] = null;
        });
        expect(p.status).toBe("NOT_COMPARABLE");
        expect(p.reasons).toEqual(["quality_v2_bins_invalid:input_power_contradiction:b"]);
        expect(p.bins).toBeNull();
        expect(p.coherenceDelta).toBeNull();
    });

    it("NO_INPUT_POWER with a magnitude is the same contradiction", () => {
        const p = pair((a) => {
            const i = usable(a)[5];
            a.status[i] = "NO_INPUT_POWER";
            a.coherence[i] = 0;
        });
        expect(p.reasons).toEqual(["quality_v2_bins_invalid:input_power_contradiction:a"]);
        expect(p.bins).toBeNull();
    });

    it("a valid WEAK_COHERENCE bin (with a magnitude) keeps its coherence difference, and has no magnitude difference", () => {
        let i = -1;
        const p = pair((a, b) => {
            i = usable(a)[4];
            a.status[i] = b.status[i] = "WEAK_COHERENCE";
            a.coherence[i] = 0.4;
            b.coherence[i] = 0.25;
        });
        expect(p.status).toBe("COMPARED");
        expect(p.bins!.coherenceDelta[i]).toBeCloseTo(-0.15, 12);
        expect(p.bins!.magnitudeDeltaDb[i]).toBeNull();
    });

    it("NO_INPUT_POWER on either or both sides never gives a coherence or magnitude difference", () => {
        let one = -1;
        let both = -1;
        const p = pair((a, b) => {
            [one, both] = [usable(a)[6], usable(a)[7]];
            for (const [bins, i] of [
                [a, one],
                [a, both],
                [b, both],
            ] as const) {
                bins.status[i] = "NO_INPUT_POWER";
                bins.magnitudeDb[i] = null;
                bins.coherence[i] = 0;
            }
        });
        expect(p.status).toBe("COMPARED");
        for (const i of [one, both]) {
            expect(p.bins!.coherenceDelta[i]).toBeNull();
            expect(p.bins!.magnitudeDeltaDb[i]).toBeNull();
        }
    });

    it("no bin with input power on one side: no difference at all, NOT_COMPARABLE", () => {
        const p = pair((a) => {
            a.status.forEach((s, i) => {
                if (s === "USABLE" || s === "WEAK_COHERENCE") {
                    a.status[i] = "NO_INPUT_POWER";
                    a.magnitudeDb[i] = null;
                    a.coherence[i] = 0;
                }
            });
        });
        expect(p).toMatchObject({ status: "NOT_COMPARABLE", reasons: ["no_shared_valid_bins"], bins: null });
    });
});

describe("FIX 2: floating-point overflow", () => {
    it("two finite magnitudes whose difference overflows give null for that bin, with a note; other bins stay", () => {
        let i = -1;
        let j = -1;
        let expectedJ = 0;
        const p = pair((a, b) => {
            [i, j] = [usable(a)[2], usable(a)[3]];
            a.magnitudeDb[i] = -1e308;
            b.magnitudeDb[i] = 1e308;
            expectedJ = (b.magnitudeDb[j] as number) - (a.magnitudeDb[j] as number);
            b.magnitudeDb[j] = (a.magnitudeDb[j] as number) + 2.5;
        });
        expect(p.status).toBe("COMPARED");
        expect(p.bins!.magnitudeDeltaDb[i]).toBeNull();
        expect(p.bins!.magnitudeDeltaDb[j]).toBeCloseTo(expectedJ + 2.5, 9);
        expect(p.notes).toContain("delta_not_finite:magnitude:1");
        for (const v of [p.magnitudeDelta!.min, p.magnitudeDelta!.max, p.magnitudeDelta!.meanAbs]) {
            expect(Number.isFinite(v)).toBe(true);
        }
        expect(p.magnitudeDelta!.binCount).toBe(usable(flightA.chirps[0].qualityV2.coherence.bins).length - 1);
    });

    it("every magnitude difference overflowing leaves no magnitude difference, never Infinity", () => {
        const p = pair((a, b) => {
            for (const i of usable(a)) {
                a.magnitudeDb[i] = -1.5e308;
                b.magnitudeDb[i] = 1.5e308;
            }
        });
        expect(p.magnitudeDelta).toMatchObject({ binCount: 0, min: null, max: null, meanAbs: null });
        expect(p.bins!.magnitudeDeltaDb.every((d) => d === null)).toBe(true);
        expect(p.notes).toEqual(
            expect.arrayContaining([
                `delta_not_finite:magnitude:${usable(flightA.chirps[0].qualityV2.coherence.bins).length}`,
                "no_shared_usable_magnitude_bins",
            ]),
        );
        // Coherence is unaffected and still compared.
        expect(p.coherenceDelta!.binCount).toBeGreaterThan(0);
    });

    it("finite differences whose absolute sum would overflow give a finite, exact mean", () => {
        // 1.5e308 per bin: one bin is finite, the sum of two is Infinity.
        expect(1.5e308 + 1.5e308).toBe(Infinity);
        const p = pair((a, b) => {
            for (const i of usable(a)) {
                a.magnitudeDb[i] = -7.5e307;
                b.magnitudeDb[i] = 7.5e307;
            }
        });
        const each = 7.5e307 - -7.5e307;
        expect(Number.isFinite(each)).toBe(true);
        expect(p.magnitudeDelta!.binCount).toBe(usable(flightA.chirps[0].qualityV2.coherence.bins).length);
        expect(p.magnitudeDelta!.meanAbs).toBe(each);
        expect(p.magnitudeDelta!.min).toBe(each);
        expect(p.magnitudeDelta!.max).toBe(each);
        expect(Number.isFinite(p.magnitudeDelta!.minAtHz)).toBe(true);
    });

    it("meanAbs of ordinary differences is the plain mean of |B − A|", () => {
        let n3 = 0;
        let n1 = 0;
        const p = pair((a, b) => {
            usable(a).forEach((i, k) => {
                if (k % 2) {
                    b.magnitudeDb[i] = (a.magnitudeDb[i] as number) + 3;
                    n3++;
                } else {
                    b.magnitudeDb[i] = (a.magnitudeDb[i] as number) - 1;
                    n1++;
                }
            });
        });
        expect(p.magnitudeDelta!.meanAbs).toBeCloseTo((3 * n3 + 1 * n1) / (n3 + n1), 9);
        expect(p.magnitudeDelta!.min).toBeCloseTo(-1, 9);
        expect(p.magnitudeDelta!.max).toBeCloseTo(3, 9);
    });

    it("charts of overflowing and extreme values contain no Infinity or NaN", () => {
        const p = pair((a, b) => {
            const [i, j] = usable(a);
            a.magnitudeDb[i] = -1e308;
            b.magnitudeDb[i] = 1e308;
            a.magnitudeDb[j] = 1.7e308;
            b.magnitudeDb[j] = 1.7e308;
        });
        const f = p.bins!.frequencyHz;
        const charts = [
            lineChart(
                f,
                [
                    { id: "a", values: p.bins!.magnitudeDbA },
                    { id: "b", values: p.bins!.magnitudeDbB },
                ],
                520,
                110,
            ),
            lineChart(f, [{ id: "d", values: p.bins!.magnitudeDeltaDb }], 520, 110, { includeZero: true }),
            lineChart(f, [{ id: "c", values: [1.7e308, 1.7e308, null, Infinity, NaN] }], 520, 110),
        ];
        for (const c of charts) {
            expect(c).not.toBeNull();
            const text = JSON.stringify(c);
            expect(text).not.toMatch(/NaN|Infinity|null,"label"/);
            for (const path of c!.paths) {
                expect(path.d).not.toMatch(/NaN|Infinity/);
            }
            for (const t of [...c!.ticksY, ...c!.ticksX]) {
                expect(Number.isFinite("y" in t ? t.y : t.x)).toBe(true);
            }
        }
        expect(charts[2]!.paths[0].points).toBe(2);
    });
});
