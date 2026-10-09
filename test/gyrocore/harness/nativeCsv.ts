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
 * Reads the GyroCore reference decode: CSV written by GyroCore's patched native
 * blackbox_decode (mode-event fix, GyroCore commit 8c075e7) with
 *   blackbox_decode --stdout --unit-vbat raw --unit-amperage raw --unit-flags raw --index N
 * GyroCore proved its browser decoder bit-exact against this output
 * (GyroCore src/decode/parity.ts), so it stands for GyroCore's canonical decode.
 */

import { readFileSync } from "node:fs";

export interface NativeCsv {
    /** Column names with unit suffixes removed ("time (us)" -> "time"). */
    columns: string[];
    rows: number[][];
}

export function readNativeCsv(path: string): NativeCsv {
    const text = readFileSync(path, "utf8");
    const lines = text.split("\n");
    const columns = lines[0].split(",").map((c) => c.trim().replace(/ \(.*\)$/, ""));
    const rows: number[][] = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) {
            continue;
        }
        rows.push(line.split(",").map(Number));
    }
    return { columns, rows };
}

export interface ColumnDiff {
    column: string;
    compared: number;
    mismatches: number;
    maxAbsError: number;
    firstMismatch: { iteration: number; time: number; viewer: number; native: number } | null;
}

export interface RowParity {
    viewerRows: number;
    nativeRows: number;
    matchedRows: number;
    viewerOnly: number;
    nativeOnly: number;
    firstViewerOnly: [number, number] | null;
    firstNativeOnly: [number, number] | null;
    columns: ColumnDiff[];
    /** Columns present on one side only. */
    viewerOnlyColumns: string[];
    nativeOnlyColumns: string[];
}

/**
 * Joins rows on (loopIteration, time) and compares every column the two
 * decoders share, as GyroCore's own parity harness does.
 */
export function compareRows(
    viewerColumns: string[],
    viewerRows: number[][],
    native: NativeCsv,
    skipColumns: string[] = [],
): RowParity {
    const key = (row: number[]) => `${row[0]}:${row[1]}`;
    const nativeByKey = new Map<string, number[]>();
    for (const row of native.rows) {
        nativeByKey.set(key(row), row);
    }
    const shared = viewerColumns
        .map((name, vi) => ({ name, vi, ni: native.columns.indexOf(name) }))
        .filter((c) => c.ni >= 0 && !skipColumns.includes(c.name));
    const diffs: ColumnDiff[] = shared.map((c) => ({
        column: c.name,
        compared: 0,
        mismatches: 0,
        maxAbsError: 0,
        firstMismatch: null,
    }));

    let matched = 0;
    let viewerOnly = 0;
    let firstViewerOnly: [number, number] | null = null;
    const seen = new Set<string>();
    for (const row of viewerRows) {
        const k = key(row);
        const other = nativeByKey.get(k);
        if (!other) {
            viewerOnly++;
            firstViewerOnly ??= [row[0], row[1]];
            continue;
        }
        seen.add(k);
        matched++;
        for (const [i, c] of shared.entries()) {
            const d = diffs[i];
            const a = row[c.vi];
            const b = other[c.ni];
            d.compared++;
            if (a !== b) {
                d.mismatches++;
                d.maxAbsError = Math.max(d.maxAbsError, Math.abs(a - b));
                d.firstMismatch ??= { iteration: row[0], time: row[1], viewer: a, native: b };
            }
        }
    }
    let nativeOnly = 0;
    let firstNativeOnly: [number, number] | null = null;
    for (const row of native.rows) {
        if (!seen.has(key(row))) {
            nativeOnly++;
            firstNativeOnly ??= [row[0], row[1]];
        }
    }
    return {
        viewerRows: viewerRows.length,
        nativeRows: native.rows.length,
        matchedRows: matched,
        viewerOnly,
        nativeOnly,
        firstViewerOnly,
        firstNativeOnly,
        columns: diffs,
        viewerOnlyColumns: viewerColumns.filter((c) => !native.columns.includes(c)),
        nativeOnlyColumns: native.columns.filter((c) => !viewerColumns.includes(c)),
    };
}
