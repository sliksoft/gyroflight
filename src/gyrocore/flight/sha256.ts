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
 * SHA-256 through Web Crypto, available in every Gyroflight host (PWA over
 * HTTPS or localhost, Tauri and Capacitor webviews). There is deliberately no
 * fallback hash: an identity that is not SHA-256 must not exist at all.
 */

export class Sha256UnavailableError extends Error {
    constructor() {
        super("sha256_unavailable");
        this.name = "Sha256UnavailableError";
    }
}

/** Lowercase hex SHA-256 of `bytes`. Throws Sha256UnavailableError outside a secure context. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) {
        throw new Sha256UnavailableError();
    }
    // A copy, so a view into a larger buffer hashes only its own bytes.
    const digest = await subtle.digest("SHA-256", bytes.slice());
    let hex = "";
    for (const b of new Uint8Array(digest)) {
        hex += b.toString(16).padStart(2, "0");
    }
    return hex;
}
