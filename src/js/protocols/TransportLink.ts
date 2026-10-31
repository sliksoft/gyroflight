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
 * Gyroflight hook (docs/gyrocore/UPSTREAM.md, audit WP8 transport closure): one connection of a
 * transport, as far as is proven whether it can still put bytes on the wire. A transport makes a
 * new link for every connection it opens and only it changes the state. serial.ts reads the link
 * a send was handed to: a page yields the write lease while a send is unfinished only once that
 * send's own link is CLOSED_CONFIRMED. A disconnect event, a timeout or an error is no such proof.
 */

/**
 * - OPEN: the connection is up; bytes handed to it may go out.
 * - CLOSING: a teardown runs; an earlier write may still go out.
 * - CLOSED_CONFIRMED: the transport proved the connection closed: it can send no more bytes and no
 *   write handed to it can still reach this or a later connection. Final.
 * - CLOSE_FAILED: the close failed; the connection may still send. A later close may succeed.
 */
export type TransportLinkState = "OPEN" | "CLOSING" | "CLOSED_CONFIRMED" | "CLOSE_FAILED";

export class TransportLink {
    #state: TransportLinkState = "OPEN";

    get state(): TransportLinkState {
        return this.#state;
    }

    /** A teardown starts, or starts again after a failed close. */
    closing(): void {
        if (this.#state !== "CLOSED_CONFIRMED") this.#state = "CLOSING";
    }

    /** Only once the transport has proof that this connection can send nothing more. */
    closed(): void {
        this.#state = "CLOSED_CONFIRMED";
    }

    closeFailed(): void {
        if (this.#state !== "CLOSED_CONFIRMED") this.#state = "CLOSE_FAILED";
    }
}
