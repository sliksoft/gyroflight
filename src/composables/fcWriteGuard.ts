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
 * The one write check of the app (audit WP8): every request that can change the flight controller's
 * configuration passes it on its way to the port, whoever sends it.
 *
 *   - MSP requests: msp.ts calls mspRequestRefusal() when a request is queued, when a parked one is
 *     released and before each retry. Each code is classified (classifyMsp): "read" (the firmware only answers),
 *     "runtime" (changes nothing that is stored or that a later read of the tune shows: the clock,
 *     the arming-disable flag, motor test outputs, a reboot) or "write". A code this table does not
 *     know is a write.
 *   - CLI: msp.ts (MSP CLI: Presets, Backups, AutoRestore, flight plan, VTX, ports, power, sensors,
 *     the flasher's config lines) calls cliInputRefusal(); the CLI tab's raw serial line (useCli.ts,
 *     AutoBackup.ts) calls interactiveCliText(), which also clears the firmware's line first. Each
 *     line the text ends (comments from '#' cut, as cli.c does) counts as a read only when its
 *     command is in READ_CLI; text that is not printable ASCII and line ends, and tab completion,
 *     are refused: what the firmware would then run was never checked.
 *
 * A write is refused while the connected craft has an open uncertain entry in fcTransactionState
 * (or its UID is unknown while any entry is open, or that storage is unreadable), and while a
 * Gyroflight write transaction of this page is open (withFcWriteLock): nothing else may write in
 * between its reads and its writes. The transaction's own writes carry its WritePermit, which checks
 * right before every SET and MSP_EEPROM_WRITE that the transaction still owns its pending entry and
 * that no entry it does not cover has appeared.
 *
 * Gyroflight's write transactions (useTuneApply.ts) and its read-only check run one at a time per
 * browser origin under the Web Lock FC_WRITE_LOCK (navigator.locks, exclusive, never queued): a
 * second one is refused, never deferred. Without navigator.locks none starts (fail-closed).
 *
 * What this cannot do: the lock and the entries are this browser's. Another browser, another device
 * or another program connected to the same craft sees neither, and localStorage between tabs is not
 * strictly consistent (a tab may read another's change late); Web Serial lets one page at a time
 * open a port. Nothing here is a craft-wide lock.
 */

import { getActivePinia } from "pinia";
import MSPCodes from "@/js/msp/MSPCodes";
import { gui_log } from "@/js/gui_log";
import { ApplyBlockedError } from "@/gyrocore/chirp/applyGate";
import { connectedCraftWriteIssues, useFcTransactionStore } from "@/gyrocore/stores/fcTransactionState";

/** The Web Lock every Gyroflight write transaction and read-only check of this origin holds. */
export const FC_WRITE_LOCK = "gyroflight.fcWrite";
export const WRITE_LOCK_BUSY = "fc:write_lock_busy";
export const WRITE_LOCK_UNAVAILABLE = "fc:write_lock_unavailable";
/** No Pinia (the app's state) to check against: refused rather than unchecked. */
export const WRITE_GUARD_UNAVAILABLE = "fc:write_guard_unavailable";

/** Refused by the write check before anything was sent: the craft did not receive this request. */
export class WriteRefusedError extends ApplyBlockedError {
    readonly notSent = true;

    constructor(reasons: string[]) {
        super(reasons);
        this.name = "WriteRefusedError";
    }
}

export const writeRefused = (reasons: string[]) => new WriteRefusedError(reasons);

/**
 * A write that went out once and whose retransmission the write check refused: the craft may have
 * run it (its answer was lost), so this is not "not sent" (no WriteRefusedError).
 */
export class WriteRetryRefusedError extends ApplyBlockedError {
    constructor(reasons: string[]) {
        super([...reasons, "fc:write_retry_refused"]);
        this.name = "WriteRetryRefusedError";
    }
}

/**
 * A Gyroflight write transaction's authority for its own writes: why the write with `code` must not
 * go out now (empty: it may). Asked right before the request is queued and when a parked one is
 * released.
 */
export interface WritePermit {
    issues(code: number): string[];
}

/** Answers only (msp.c mspFcProcessOutCommand / ...WithArg / mspCommonProcessOutCommand). */
const READ_MSP_CODES: ReadonlySet<number> = new Set([
    MSPCodes.MSP_API_VERSION,
    MSPCodes.MSP_FC_VARIANT,
    MSPCodes.MSP_FC_VERSION,
    MSPCodes.MSP_BOARD_INFO,
    MSPCodes.MSP_BUILD_INFO,
    MSPCodes.MSP_NAME,
    MSPCodes.MSP_BATTERY_CONFIG,
    MSPCodes.MSP_MODE_RANGES,
    MSPCodes.MSP_FEATURE_CONFIG,
    MSPCodes.MSP_BOARD_ALIGNMENT_CONFIG,
    MSPCodes.MSP_CURRENT_METER_CONFIG,
    MSPCodes.MSP_MIXER_CONFIG,
    MSPCodes.MSP_RX_CONFIG,
    MSPCodes.MSP_LED_COLORS,
    MSPCodes.MSP_LED_STRIP_CONFIG,
    MSPCodes.MSP_RSSI_CONFIG,
    MSPCodes.MSP_ADJUSTMENT_RANGES,
    MSPCodes.MSP_CF_SERIAL_CONFIG,
    MSPCodes.MSP_VOLTAGE_METER_CONFIG,
    MSPCodes.MSP_SONAR_ALTITUDE,
    MSPCodes.MSP_PID_CONTROLLER,
    MSPCodes.MSP_ARMING_CONFIG,
    MSPCodes.MSP_RX_MAP,
    MSPCodes.MSP_DATAFLASH_SUMMARY,
    MSPCodes.MSP_DATAFLASH_READ,
    MSPCodes.MSP_FAILSAFE_CONFIG,
    MSPCodes.MSP_RXFAIL_CONFIG,
    MSPCodes.MSP_SDCARD_SUMMARY,
    MSPCodes.MSP_BLACKBOX_CONFIG,
    MSPCodes.MSP_OSD_CONFIG,
    MSPCodes.MSP_OSD_CHAR_READ,
    MSPCodes.MSP_VTX_CONFIG,
    MSPCodes.MSP_ADVANCED_CONFIG,
    MSPCodes.MSP_FILTER_CONFIG,
    MSPCodes.MSP_PID_ADVANCED,
    MSPCodes.MSP_SENSOR_CONFIG,
    MSPCodes.MSP_STATUS,
    MSPCodes.MSP_RAW_IMU,
    MSPCodes.MSP_SERVO,
    MSPCodes.MSP_MOTOR,
    MSPCodes.MSP_RC,
    MSPCodes.MSP_RAW_GPS,
    MSPCodes.MSP_COMP_GPS,
    MSPCodes.MSP_ATTITUDE,
    MSPCodes.MSP_ALTITUDE,
    MSPCodes.MSP_ANALOG,
    MSPCodes.MSP_RC_TUNING,
    MSPCodes.MSP_PID,
    MSPCodes.MSP_BOXNAMES,
    MSPCodes.MSP_PIDNAMES,
    MSPCodes.MSP_WP,
    MSPCodes.MSP_BOXIDS,
    MSPCodes.MSP_SERVO_CONFIGURATIONS,
    MSPCodes.MSP_MOTOR_3D_CONFIG,
    MSPCodes.MSP_RC_DEADBAND,
    MSPCodes.MSP_SENSOR_ALIGNMENT,
    MSPCodes.MSP_LED_STRIP_MODECOLOR,
    MSPCodes.MSP_VOLTAGE_METERS,
    MSPCodes.MSP_CURRENT_METERS,
    MSPCodes.MSP_BATTERY_STATE,
    MSPCodes.MSP_MOTOR_CONFIG,
    MSPCodes.MSP_GPS_CONFIG,
    MSPCodes.MSP_COMPASS_CONFIG,
    MSPCodes.MSP_GPS_RESCUE,
    MSPCodes.MSP_VTXTABLE_BAND,
    MSPCodes.MSP_VTXTABLE_POWERLEVEL,
    MSPCodes.MSP_MOTOR_TELEMETRY,
    MSPCodes.MSP_SIMPLIFIED_TUNING,
    // Computed on a copy of the profile (tempPidProfile / tempGyroConfig); nothing is stored.
    MSPCodes.MSP_CALCULATE_SIMPLIFIED_PID,
    MSPCodes.MSP_CALCULATE_SIMPLIFIED_GYRO,
    MSPCodes.MSP_CALCULATE_SIMPLIFIED_DTERM,
    MSPCodes.MSP_VALIDATE_SIMPLIFIED_TUNING,
    MSPCodes.MSP_STATUS_EX,
    MSPCodes.MSP_UID,
    MSPCodes.MSP_GPSSVINFO,
    MSPCodes.MSP_ATTITUDE_QUATERNION,
    MSPCodes.MSP_PITOT,
    MSPCodes.MSP_WING,
    MSPCodes.MSP_OSD_CANVAS,
    MSPCodes.MSP_BEEPER_CONFIG,
    // Runs only out commands for each code it carries (mspFcProcessOutCommand, no in commands).
    MSPCodes.MSP_MULTIPLE_MSP,
    MSPCodes.MSP_MODE_RANGES_EXTRA,
    MSPCodes.MSP_ACC_TRIM,
    MSPCodes.MSP_SERVO_MIX_RULES,
    MSPCodes.MSP_RTC,
    MSPCodes.MSP_DEBUGMSG,
    MSPCodes.MSP_DEBUG,
    MSPCodes.MSP2_COMMON_SERIAL_CONFIG,
    MSPCodes.MSP2_MOTOR_OUTPUT_REORDERING,
    MSPCodes.MSP2_GET_VTX_DEVICE_STATUS,
    MSPCodes.MSP2_GET_OSD_WARNINGS,
    MSPCodes.MSP2_GET_TEXT,
    MSPCodes.MSP2_GET_LED_STRIP_CONFIG_VALUES,
    MSPCodes.MSP2_SENSOR_CONFIG_ACTIVE,
    MSPCodes.MSP2_MCU_INFO,
    MSPCodes.MSP2_GYRO_SENSOR_ACTIVE,
    MSPCodes.MSP2_CLI_SETTING_INFO,
]);

/**
 * Allowed while the state is uncertain: nothing they change is stored or shows in a read of the
 * tune. The connect sequence sends MSP_SET_RTC, every save first sets arming-disabled, a motor stop
 * must never be refused, and a reboot reloads the stored config (it proves nothing either way).
 */
export const RUNTIME_MSP_CODES: ReadonlySet<number> = new Set([
    MSPCodes.MSP_SET_RTC,
    MSPCodes.MSP_SET_ARMING_DISABLED,
    MSPCodes.MSP_SET_MOTOR,
    MSPCodes.MSP_REBOOT,
]);

export type MspClass = "read" | "runtime" | "write";

/**
 * What a request does to the craft. MSP2_CLI_SETTING sets a value when it carries "=" (msp.c),
 * judged on the bytes msp.ts encodes: each value goes out as its low byte (0x13d is "=").
 */
export function classifyMsp(code: number, data: ArrayLike<number> | false | undefined): MspClass {
    if (code === MSPCodes.MSP2_CLI_SETTING) {
        return data && Array.prototype.some.call(data, (v: number) => (v & 0xff) === 0x3d) ? "write" : "read";
    }
    if (READ_MSP_CODES.has(code)) return "read";
    if (RUNTIME_MSP_CODES.has(code)) return "runtime";
    return "write";
}

/** CLI commands that only print (cli.c); exit reboots without saving. Every other command is a write. */
const READ_CLI: ReadonlySet<string> = new Set([
    "get",
    "dump",
    "diff",
    "version",
    "status",
    "help",
    "tasks",
    "sensor_hardware",
    "exit",
]);

/** Why a write by anyone but a Gyroflight transaction must not go out now; empty when it may. */
function foreignWriteIssues(): string[] {
    return getActivePinia() ? connectedCraftWriteIssues() : [WRITE_GUARD_UNAVAILABLE];
}

/** Why msp.ts must not send this request now (null: send it). See the header. */
export function mspRequestRefusal(
    code: number,
    data: ArrayLike<number> | false | undefined,
    permit?: WritePermit,
): string[] | null {
    if (classifyMsp(code, data) !== "write") return null;
    const issues = permit ? permit.issues(code) : foreignWriteIssues();
    return issues.length ? issues : null;
}

/** A refused request that has no error path (msp.ts send_message): shown in the log, never as success. */
export function reportRefusedWrite(what: string, reasons: string[]): void {
    const text = `Gyroflight: ${what} not sent (${reasons.join(", ")})`;
    console.warn(text);
    gui_log(text);
}

/** The command of one CLI line as the firmware runs it: up to '#', trimmed; "" when nothing runs. */
function cliCommand(line: string): string {
    const hash = line.indexOf("#");
    return (hash === -1 ? line : line.slice(0, hash)).trim();
}

/**
 * Why `text` must not be sent to a CLI whose line buffer holds `pending` (null: send it). While a
 * write would be refused, every line `text` ends must be a read, and `text` must hold printable
 * ASCII (0x20-0x7e) and line ends only, so the characters checked here are the bytes the firmware
 * gets: the MSP CLI encoder keeps each code point's low byte (U+010A goes out as LF), the CLI tab
 * sends UTF-8 the firmware drops, and Unicode spaces split a command here but not in cli.c. The
 * firmware's editing differs by mode (interactive: 0x7f deletes, 0x08 is dropped; MSP CLI: both
 * dropped; cli.c processCharacterInteractive / processCharacter), so an edited line is refused
 * rather than guessed at. Tab completion is refused the same way.
 */
export function cliInputRefusal(pending: string, text: string): string[] | null {
    const issues = foreignWriteIssues();
    return issues.length ? cliLineRefusal(issues, pending, text, false) : null;
}

function cliLineRefusal(issues: string[], pending: string, text: string, interactive: boolean): string[] | null {
    let line = pending;
    for (const ch of text) {
        if (ch === "\r" || ch === "\n") {
            const cmd = cliCommand(line);
            const name = cmd.split(/\s+/)[0]?.toLowerCase() ?? "";
            if (cmd && !READ_CLI.has(name)) return [...issues, `cli:not_read_only:${name}`];
            line = "";
        } else if (ch === "\t" || (interactive && ch === "?")) {
            return [...issues, "cli:completion"];
        } else if (ch < " " || ch > "~") {
            return [...issues, "cli:edit_control_or_non_ascii_character"];
        } else {
            line += ch;
        }
    }
    // What stays in the buffer runs with a later line end; that text is checked then (pending).
    return null;
}

/** One MSP CLI command (msp.ts send_cli_command adds the line end). */
export const cliCommandRefusal = (command: string) => cliInputRefusal("", `${command}\n`);

/**
 * Empties an interactive CLI's line buffer whatever it holds: there 0x7f deletes one character and
 * does nothing on an empty buffer, which holds at most CLI_IN_BUFFER_SIZE - 1 (cli.h 256; cli.c
 * processCharacterInteractive, processCharacter).
 */
export const CLI_CLEAR_LINE = "\u007f".repeat(256);

/** Whether a write by anyone but a Gyroflight transaction would be refused now. */
export const foreignWritesRefused = (): boolean => foreignWriteIssues().length > 0;

/**
 * What a raw serial line into an interactive CLI (the CLI tab, AutoBackup) sends for `text`, or why
 * it must not. While writes may go out: `text` unchanged. Otherwise `text` is checked from an empty
 * line and goes out behind CLI_CLEAR_LINE, so nothing the firmware already holds joins it: what this
 * page knows of that buffer is the echo, which can lag (a completion sent before the state turned
 * uncertain, its echo still on its way). '?' completes like a tab there and is refused like one.
 */
export function interactiveCliText(text: string): { text: string; refused: null } | { text: null; refused: string[] } {
    const issues = foreignWriteIssues();
    if (!issues.length) return { text, refused: null };
    const refused = cliLineRefusal(issues, "", text, true);
    return refused ? { text: null, refused } : { text: CLI_CLEAR_LINE + text, refused: null };
}

interface LockManagerLike {
    request<T>(name: string, options: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<T>): Promise<T>;
}

/**
 * Run `fn` holding FC_WRITE_LOCK, or refuse (ApplyBlockedError) when another transaction or check of
 * this origin holds it, or when the browser has no Web Locks. While it runs, no write but its own
 * (carrying its WritePermit) leaves this page.
 */
export async function withFcWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const locks = (globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks;
    if (!locks || typeof locks.request !== "function") throw new ApplyBlockedError([WRITE_LOCK_UNAVAILABLE]);
    const states = useFcTransactionStore();
    const out = await locks.request(FC_WRITE_LOCK, { ifAvailable: true }, async (lock) => {
        if (!lock) return { busy: true as const };
        states.localWrites++;
        try {
            return { busy: false as const, value: await fn() };
        } finally {
            states.localWrites--;
        }
    });
    if (out.busy) throw new ApplyBlockedError([WRITE_LOCK_BUSY]);
    return out.value;
}
