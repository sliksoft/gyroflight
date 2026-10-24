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

import { ref, type Ref } from "vue";
import semver from "semver";
import MSP from "../js/msp";
import { useFlightControllerStore } from "@/stores/fc";
import { cancelRebootReconnect, scheduleRebootReconnect } from "../js/serial_backend";
import { WriteRefusedError } from "./fcWriteGuard";
import { gui_log } from "../js/gui_log";
import { i18n } from "../js/localization";

const DEFAULT_COMMAND_TIMEOUT_MS = 2000;
const SAVE_COMMAND_TIMEOUT_MS = 5000;
const DUMP_READ_TIMEOUT_MS = 10000;
const LINE_DELAY_MS = 15;
const PROFILE_COMMAND_DELAY_MS = 100;
const ERROR_PREFIX = "###ERROR";

export const MIN_FC_VERSION_FOR_MSP_CLI = "4.5.4";

export interface SendOptions {
    timeoutMs?: number;
}

export interface CliSettingRange {
    min: number;
    max: number;
}

/**
 * Gyroflight (audit WP8-F01): what is known of a CLI `save`. "confirmed": the firmware printed what it
 * prints only after writing EEPROM (cliSaveConfirmed); "not_verified": the whole command went out
 * and the FC went away without that; "not_saved": it was not sent, or the firmware answered without
 * saving; "unknown": only part of it may have gone out.
 */
export type CliSavePersistence = "confirmed" | "not_verified" | "not_saved" | "unknown";

export interface SaveAndReconnectResult {
    ok: boolean;
    error: unknown;
    persistence: CliSavePersistence;
}

/**
 * Whether the firmware's own output shows a CLI `save` wrote EEPROM. cli.c cliSave prints "# saving"
 * (not on MINIMAL_CLI builds) and cliRebootEx "Rebooting" only after writeEEPROM() returned, and
 * writeEEPROM() returns only once the stored config reads back valid (config_eeprom.c
 * writeConfigToEEPROM; otherwise failureMode). Firmware source 4.3 to master reviewed, not run on
 * hardware.
 */
export function cliSaveConfirmed(lines: readonly string[] | null | undefined): boolean {
    return (lines ?? []).some((line) => {
        const text = line.trim();
        return text === "# saving" || text.startsWith("Rebooting");
    });
}

/** The CLI text a command had received when it ended without its answer (port closed, timeout). */
function outputSoFar(error: unknown): string[] {
    const output = Reflect.get(Object(error), "output");
    return Array.isArray(output) ? output : [];
}

/** Whether a command that ended without its answer had gone out whole (msp.ts sets `delivered`). */
function deliveredWhole(error: unknown): boolean {
    return Reflect.get(Object(error), "delivered") === true;
}

export interface BatchProgress {
    /** 1-based position in the batch, counting skipped blank and comment lines. */
    index: number;
    total: number;
    sent: number;
    errorCount: number;
}

/** One command of a batch that failed: refused by the FC, or never answered. */
export interface BatchFailure {
    command: string;
    /** The FC's reply, or the transport error's message when there was none. */
    response: string[];
    errors: string[];
}

export interface BatchOptions {
    onProgress?: (progress: BatchProgress) => void;
    onError?: (failure: BatchFailure) => void;
    commandTimeoutMs?: number;
}

export interface BatchResult {
    sent: number;
    total: number;
    errors: BatchFailure[];
    cancelled: boolean;
}

export interface MspCliSession {
    isBatchRunning: Ref<boolean>;
    send: typeof send;
    sendSave: typeof sendSave;
    readDumpAll: typeof readDumpAll;
    runBatch: (commands: string[], options?: BatchOptions) => Promise<BatchResult>;
    cancel: () => void;
}

export function isMspCliSupported(): boolean {
    const fcStore = useFlightControllerStore();
    const version = fcStore.config?.flightControllerVersion;
    if (!version) {
        return false;
    }

    const normalizedVersion = version.replaceAll("_", "-");
    return semver.valid(normalizedVersion) ? semver.gte(normalizedVersion, MIN_FC_VERSION_FOR_MSP_CLI) : false;
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldSkip(line: string): boolean {
    const trimmed = line.trim();
    return !trimmed || trimmed.startsWith("#");
}

function parseErrors(lines: readonly string[]): string[] {
    return lines.filter((line) => line.startsWith(ERROR_PREFIX));
}

function delayAfter(line: string): number {
    return line.toLowerCase().startsWith("profile") ? PROFILE_COMMAND_DELAY_MS : LINE_DELAY_MS;
}

/** A failed command's error as text. `send` rejects with an Error; anything else is shown as JSON. */
function errorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === "string") {
        return error;
    }
    return JSON.stringify(error) ?? "Unknown error";
}

export function send(command: string, { timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS }: SendOptions = {}): Promise<string[]> {
    return new Promise((resolve, reject) => {
        MSP.send_cli_command(
            command,
            (lines, error) => {
                if (error) {
                    reject(error);
                    return;
                }
                resolve(Array.isArray(lines) ? [...lines] : []);
            },
            { timeoutMs },
        );
    });
}

export function sendSave(): Promise<string[]> {
    return send("save", { timeoutMs: SAVE_COMMAND_TIMEOUT_MS });
}

export function readDumpAll(): Promise<string[]> {
    return send("diff all", { timeoutMs: DUMP_READ_TIMEOUT_MS });
}

/**
 * A CLI `save`/`exit` has already rebooted the FC. Hand the wait to serial_backend's reconnect
 * cycle — the same one a Save & Reboot uses, minus the reboot command it does not need to send.
 * The cycle drops the stale link, retries while Auto-Connect is on, and ends the window on a
 * deadline. Previously this path ran its own 500 ms timeout and put the connection state into
 * RECONNECTING with no window, so a device that never came back left the phase there for good.
 */
export function scheduleReconnect(): void {
    scheduleRebootReconnect();
}

/** Abandon that wait (a tab unmounting mid-reconnect). */
export function cancelScheduledReconnect(): void {
    cancelRebootReconnect();
}

// A `save`/`exit` reboots the FC, so the port closes before the command can reply and its
// in-flight promise is drained with a connection-closed error (tagged in MSP.disconnect_cleanup).
// That is the EXPECTED successful outcome — the config is saved and the board is restarting — not
// a failure, so callers should not surface it as an error.
export function isConnectionClosedError(error: unknown): boolean {
    return (
        typeof error === "object" && error !== null && "connectionClosed" in error && error.connectionClosed === true
    );
}

// `send` resolves with whatever the FC replied, and a command the FC refused replies normally —
// the refusal is a line in the response, not a transport error. Callers that need to know whether
// a command took effect have to look for it.
export function findCliError(lines: readonly string[] | null | undefined): string | null {
    return parseErrors(lines ?? [])[0] ?? null;
}

// A numeric setting is printed with its bounds, so the firmware can tell us the limits of a build
// rather than the app having to guess. Prefer getSettingInfo() in useMspSetting where the FC is
// new enough: it reports the same bounds as MSP rather than as prose to be scraped.
export function findCliSettingRange(lines: string[] | null | undefined): CliSettingRange | null {
    for (const line of lines ?? []) {
        const match = /^Allowed range:\s*(-?\d+)\s*-\s*(-?\d+)/.exec(line.trim());
        if (match) {
            return { min: Number(match[1]), max: Number(match[2]) };
        }
    }

    return null;
}

// `get <name>` matches on substring, so the reply can carry several settings, each followed by its
// allowed range and default. Only the line naming the setting exactly holds the current value.
export function findCliSettingValue(lines: string[] | null | undefined, setting: string): string | null {
    for (const line of lines ?? []) {
        const [name, ...rest] = line.split("=");
        if (name.trim() === setting && rest.length) {
            return rest.join("=").trim();
        }
    }

    return null;
}

// A MODE_LOOKUP setting is printed with the names it accepts, so the app can offer exactly those
// rather than carrying its own copy of a firmware table. NULL table entries are skipped by the
// firmware, so the list is not positionally aligned with the enum — names only.
export function findCliSettingAllowedValues(lines: string[] | null | undefined): string[] | null {
    for (const line of lines ?? []) {
        const match = /^Allowed values:(.*)$/.exec(line.trim());
        if (match) {
            return match[1]
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean);
        }
    }

    return null;
}

/**
 * `save` and, when the FC resets for it, wait for the reconnect. Gyroflight hook
 * (docs/gyrocore/UPSTREAM.md, audit WP8-F01): `ok` only when the firmware confirmed it saved
 * (cliSaveConfirmed); otherwise the result says what is known, and the user is told here, so no
 * caller can present an unconfirmed save as done.
 */
export async function saveAndReconnect(): Promise<SaveAndReconnectResult> {
    const result = await saveOnce();
    const warning = SAVE_WARNINGS[result.persistence];
    if (warning) gui_log(i18n.getMessage(warning));
    return result;
}

const SAVE_WARNINGS: Record<CliSavePersistence, string | null> = {
    confirmed: null,
    not_verified: "gyroflightCliSaveNotVerified",
    not_saved: "gyroflightRestoreSaveNotSaved",
    unknown: "gyroflightRestoreSaveNotDelivered",
};

async function saveOnce(): Promise<SaveAndReconnectResult> {
    try {
        const lines = await sendSave();
        // The firmware answered and did not reset, so it saved only if it said so; no reboot to wait for.
        return cliSaveConfirmed(lines)
            ? { ok: true, error: null, persistence: "confirmed" }
            : { ok: false, error: new Error("save: the firmware did not save"), persistence: "not_saved" };
    } catch (error) {
        if (deliveredWhole(error)) {
            // The whole command went out and no answer ended it: the port closed (the FC is
            // rebooting) or it timed out. Saved only on the firmware's own word.
            scheduleReconnect();
            return cliSaveConfirmed(outputSoFar(error))
                ? { ok: true, error: null, persistence: "confirmed" }
                : { ok: false, error: new Error("save: sent, not confirmed by the FC"), persistence: "not_verified" };
        }
        console.error("sendSave failed:", error);
        if (error instanceof WriteRefusedError || Reflect.get(Object(error), "notSent") === true) {
            // Refused by the write check or never left the queue; the FC does not reboot, so there
            // is no reconnect to wait for.
            return { ok: false, error, persistence: "not_saved" };
        }
        // Part of it may have gone out (it may still reset the FC): the link is set up again.
        scheduleReconnect();
        return { ok: false, error, persistence: "unknown" };
    }
}

export function useMspCliSession(): MspCliSession {
    const isBatchRunning = ref(false);
    let cancelRequested = false;

    async function runBatch(
        commands: string[],
        { onProgress, onError, commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS }: BatchOptions = {},
    ): Promise<BatchResult> {
        cancelRequested = false;
        isBatchRunning.value = true;

        const errors: BatchFailure[] = [];
        const total = commands.length;
        let index = 0;
        let sent = 0;

        try {
            for (const rawLine of commands) {
                if (cancelRequested) {
                    break;
                }

                index++;

                if (shouldSkip(rawLine)) {
                    onProgress?.({ index, total, sent, errorCount: errors.length });
                    continue;
                }

                const line = rawLine.trim();
                let response: string[];
                try {
                    response = await send(line, { timeoutMs: commandTimeoutMs }); // NOSONAR: commands run one at a time, in order
                    sent++;
                } catch (error) {
                    const message = errorMessage(error);
                    const failure = { command: line, response: [message], errors: [message] };
                    errors.push(failure);
                    onError?.(failure);
                    onProgress?.({ index, total, sent, errorCount: errors.length });
                    continue;
                }

                const commandErrors = parseErrors(response);
                if (commandErrors.length > 0) {
                    const failure = { command: line, response, errors: commandErrors };
                    errors.push(failure);
                    onError?.(failure);
                }

                onProgress?.({ index, total, sent, errorCount: errors.length });
                await wait(delayAfter(line)); // NOSONAR: the FC needs this gap before the next command
            }
        } finally {
            isBatchRunning.value = false;
        }

        return { sent, total, errors, cancelled: cancelRequested };
    }

    function cancel() {
        cancelRequested = true;
    }

    return {
        isBatchRunning,
        send,
        sendSave,
        readDumpAll,
        runBatch,
        cancel,
    };
}
