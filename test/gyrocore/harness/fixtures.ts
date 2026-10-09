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
 * Fixture access for the GyroCore qualification harness (WU1).
 *
 * Committed fixtures live in test/gyrocore/fixtures/ (copied from the GyroCore
 * repository, see fixtures/PROVENANCE.md). The real AIR65 flight log is private
 * and never committed: the local-only tests read it from the path in
 * GYROFLIGHT_AIR65_BBL and skip when it is not set.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

export const FIXTURE_DIR = join(import.meta.dirname, "..", "fixtures");

export function sha256(bytes: Uint8Array | string): string {
    return createHash("sha256").update(bytes).digest("hex");
}

export function readFixtureBytes(relPath: string): Uint8Array {
    const raw = readFileSync(join(FIXTURE_DIR, relPath));
    return new Uint8Array(relPath.endsWith(".gz") ? gunzipSync(raw) : raw);
}

export function readFixtureJson<T = unknown>(relPath: string): T {
    return JSON.parse(new TextDecoder().decode(readFixtureBytes(relPath))) as T;
}

export function readJsonFile<T = unknown>(path: string): T {
    const raw = readFileSync(path);
    return JSON.parse(new TextDecoder().decode(path.endsWith(".gz") ? gunzipSync(raw) : raw)) as T;
}

/** Real AIR65 three-log CHIRP flight (private, local only). */
export const AIR65_SHA256 = "97245445111bbfead8e2f3864dac92e24e70986ef2dce82e0fbf8679bda7b072";

/** GyroCore's corrected full-frame counts for the AIR65 file (GyroCore d2e60f7, src/decode/parity.test.ts). */
export const AIR65_GYROCORE_FRAMES = [51669, 36657, 246358];

export interface LocalAir65 {
    bbl: Uint8Array;
    /** Directory with GyroCore reference outputs generated outside both repositories. */
    refDir: string | null;
}

export function localAir65(): LocalAir65 | null {
    const path = process.env.GYROFLIGHT_AIR65_BBL;
    if (!path || !existsSync(path)) {
        return null;
    }
    const refDir = process.env.GYROFLIGHT_AIR65_REF_DIR;
    return {
        bbl: new Uint8Array(readFileSync(path)),
        refDir: refDir && existsSync(refDir) ? refDir : null,
    };
}

/**
 * Writes a qualification report (JSON) when GYROFLIGHT_QUAL_OUT names a directory.
 * Used to record the numbers in docs/gyrocore/BLACKBOX_CHIRP_PARITY.md; never written by CI.
 */
export function writeReport(name: string, data: unknown) {
    const dir = process.env.GYROFLIGHT_QUAL_OUT;
    if (!dir) {
        return;
    }
    mkdirSync(dir, { recursive: true });
    const replacer = (_key: string, value: unknown) =>
        typeof value === "number" && !Number.isFinite(value) ? String(value) : value;
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(data, replacer, 1));
}
