/*
 * This file is part of Betaflight.
 *
 * Betaflight is free software. You can redistribute this software
 * and/or modify this software under the terms of the GNU General
 * Public License as published by the Free Software Foundation,
 * either version 3 of the License, or (at your option) any later
 * version.
 *
 * Betaflight is distributed in the hope that it will be useful,
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

/**
 * Why an MSP request was cancelled rather than failing: "cleanup" when the queue was cleared on a
 * tab switch, "disconnected" when the link went away (disconnect or reboot).
 */
export type MspCancelReason = "cleanup" | "disconnected";

export class MspError extends Error {
    readonly code?: number;

    constructor(message?: string, code?: number) {
        super(message);
        this.name = "MspError";
        this.code = code;
    }
}

export class MspTimeoutError extends MspError {
    constructor(message?: string, code?: number) {
        super(message, code);
        this.name = "MspTimeoutError";
    }
}

export class MspCancelledError extends MspError {
    readonly reason: MspCancelReason;

    constructor(message?: string, code?: number, reason: MspCancelReason = "cleanup") {
        super(message, code);
        this.name = "MspCancelledError";
        this.reason = reason;
    }
}

/**
 * Gyroflight hook (docs/gyrocore/UPSTREAM.md, audit WP8 review round 2): the firmware answered a
 * write with its error frame ('!', MSP_RESULT_ERROR): it refused the values, nothing of this
 * request was applied. `response` is that answer (its `attempts` says whether an earlier attempt,
 * whose answer was lost, may have been applied).
 */
export class MspFirmwareRefusedError extends MspError {
    readonly response: unknown;

    constructor(message?: string, code?: number, response?: unknown) {
        super(message, code);
        this.name = "MspFirmwareRefusedError";
        this.response = response;
    }
}

export class MspCrcError extends MspError {
    constructor(message?: string, code?: number) {
        super(message, code);
        this.name = "MspCrcError";
    }
}

/**
 * True when an error is a benign MSP request cancellation — the queue was cleared on a tab
 * switch (reason "cleanup") or a disconnect/reboot (reason "disconnected"), not a real request
 * failure (timeout, CRC). Lifecycle code (the live-data poller, the shared save helper) uses
 * this to avoid logging or surfacing an expected cancellation as a failure.
 */
export function isMspCancelled(error: unknown): error is MspCancelledError {
    return error instanceof MspCancelledError;
}
