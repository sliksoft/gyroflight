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

import { serial } from "./serial";
import { MspCancelledError, MspTimeoutError } from "./msp/mspErrors";
import { MspDataView } from "./msp/mspBytes";
import { useNavigationStore } from "../stores/navigation";
import { useConnectionStore } from "../stores/connection";
import { pinia } from "./pinia_instance";
// Gyroflight hook (docs/gyrocore/UPSTREAM.md): the one write check every request passes.
import {
    classifyMsp,
    cliCommandRefusal,
    mspRequestRefusal,
    reportRefusedWrite,
    writeRefused,
    WriteRetryRefusedError,
    type WritePermit,
} from "../composables/fcWriteGuard";
import { writeLease } from "../composables/fcWriteLease";

/** A request payload: the encoders read `.length` and index it, so an array-like of bytes. */
export type MspPayload = ArrayLike<number> | false | undefined;

/** What a request callback receives once the reply is decoded (built in MSPHelper.process_data). */
export interface MspResponse {
    command: number;
    data: MspDataView;
    length: number;
    crcError: boolean;
    unsupported: number;
    /** Gyroflight: how many times the request went out before this answer (a retry: more than 1). */
    attempts?: number;
    /** Gyroflight: this answer may belong to an earlier transmission of the same write code. */
    ambiguous?: boolean;
}

/**
 * Legacy callbacks are called with the response only. errorAware callbacks (MSP.promise) get
 * `(null, error)` on timeout, cancellation or CRC failure, else `(response, undefined)`.
 */
export type MspCallback = (response: MspResponse | null, error?: Error) => void;

export interface MspRequest {
    code: number;
    requestBuffer: ArrayBuffer;
    callback: MspCallback | false | undefined;
    callbackSent: (() => void) | false | undefined;
    errorAware: boolean;
    notifyTimeout: boolean;
    attempts?: number;
    start?: number;
    timer?: ReturnType<typeof setTimeout> | null;
    /** Gyroflight: the write check again, for a parked request when it is released and before a retry. */
    recheck?: () => string[] | null;
    /** Gyroflight: a write admitted under this page's shared write lease (no transaction permit). */
    foreignWrite?: boolean;
    /** Gyroflight: a write (classifyMsp): the firmware's error answer rejects an awaiter. */
    write?: boolean;
    /** Gyroflight: a legacy request that stopped retrying; its queued bytes no longer go out. */
    exhausted?: boolean;
    /**
     * Gyroflight (audit WP8 integration review): a write whose bytes wait in the transport queue; an
     * answer that comes meanwhile is not its own and does not settle it.
     */
    awaitingWire?: boolean;
    /** Gyroflight: when it went out, an earlier transmission of its code was still unanswered. */
    ambiguous?: boolean;
    /** Gyroflight: transmissions of the identical in-flight request it attached to (that may have run). */
    priorAttempts?: number;
    /**
     * Gyroflight: how many times its bytes were handed to the transport (passed stillWanted); 0 when
     * every attempt was stopped there; unset when the transport never asked.
     */
    wireSends?: number;
}

export type CliCallback = (lines: string[], error?: Error | null) => void;

interface CliQueueEntry {
    command: string;
    callback: CliCallback | undefined;
    timeoutMs: number | undefined;
    /** Gyroflight: runs when the command leaves the queue for the port (it passed the write check). */
    onSent?: () => void;
    /** Gyroflight: told once whether the transport took every byte of the command's frame. */
    onDelivery?: (delivered: boolean) => void;
    /** Gyroflight: set when it leaves the queue; "pending" until the transport reports the bytes sent. */
    delivery?: "pending" | "delivered" | "failed";
    /** Gyroflight: the CLI session (cli_generation) it was sent in. */
    generation?: number;
    /** Gyroflight: its reply, when it came before the transport reported the bytes sent. */
    reply?: string[];
    /** Gyroflight: why the write check stopped it right before its bytes went out. */
    refusedAtWire?: string[];
}

/**
 * Gyroflight (audit WP8-F09): the MSP CLI session is uncertain (a timed-out reply never ended, or a
 * command reached the transport only in part), so no CLI command goes out until the link is set
 * up again. Nothing was sent.
 */
export class CliSessionUncertainError extends Error {
    /** False for the command in flight when the session turned uncertain: it may have gone out. */
    readonly notSent: boolean;

    constructor(command: string, notSent = true) {
        super(
            notSent
                ? `CLI "${command.split(/\s/)[0]}" not sent: the CLI session is uncertain, reconnect first`
                : `CLI "${command.split(/\s/)[0]}" ended: the CLI session became uncertain while it was in flight`,
        );
        this.name = "CliSessionUncertainError";
        this.notSent = notSent;
    }
}

/** Gyroflight: the transport did not take every byte of a CLI command (some may have gone out). */
export class CliDeliveryError extends Error {
    constructor(command: string) {
        super(`CLI "${command.split(/\s/)[0]}" not delivered: the transport did not send the whole command`);
        this.name = "CliDeliveryError";
    }
}

/** The decoder state MSPHelper.process_data reads when a frame completes. */
export interface MspFrame {
    code: number;
    dataView: MspDataView;
    crcError: boolean;
    unsupported: number;
    callbacks: MspRequest[];
    _release_parked?: (code: number) => void;
}

export type MspListener = (frame: MspFrame) => void;

/** Serial read events hand over either the raw bytes or a `{ data }` wrapper. */
type MspReadInfo = ArrayBuffer | ArrayLike<number> | { data: ArrayBuffer | ArrayLike<number> };

type Timer = ReturnType<typeof setTimeout>;

// Only MSP.promise creates errorAware entries, and it always passes a function, so the
// `false` a legacy send_message caller may pass never reaches the errorAware paths.
function errorAwareCallback(entry: MspRequest): MspCallback | undefined {
    return entry.callback as MspCallback | undefined;
}

const MSP = {
    symbols: {
        BEGIN: 0x24, // "$"
        PROTO_V1: 0x4d, // "M"
        PROTO_V2: 0x58, // "X"
        FROM_MWC: 0x3e, // ">"
        TO_MWC: 0x3c, // "<"
        UNSUPPORTED: 0x21, // "!"
        START_OF_TEXT: 0x02,
        END_OF_TEXT: 0x03,
        END_OF_TRANSMISSION: 0x04,
        LINE_FEED: 0x0a,
        CARRIAGE_RETURN: 0x0d,
    },
    constants: {
        PROTOCOL_V1: 1,
        PROTOCOL_V2: 2,
        JUMBO_FRAME_MIN_SIZE: 255,
    },
    decoder_states: {
        IDLE: 0,
        PROTO_IDENTIFIER: 1,
        DIRECTION_V1: 2,
        DIRECTION_V2: 3,
        FLAG_V2: 4,
        PAYLOAD_LENGTH_V1: 5,
        PAYLOAD_LENGTH_JUMBO_LOW: 6,
        PAYLOAD_LENGTH_JUMBO_HIGH: 7,
        PAYLOAD_LENGTH_V2_LOW: 8,
        PAYLOAD_LENGTH_V2_HIGH: 9,
        CODE_V1: 10,
        CODE_JUMBO_V1: 11,
        CODE_V2_LOW: 12,
        CODE_V2_HIGH: 13,
        PAYLOAD_V1: 14,
        PAYLOAD_V2: 15,
        CHECKSUM_V1: 16,
        CHECKSUM_V2: 17,
        CLI_COMMAND: 18,
    },
    state: 0,
    message_direction: 1,
    code: 0,
    // Replaced by every dispatched frame; nothing reads it before the first one.
    dataView: new MspDataView(new ArrayBuffer(0)),
    message_length_expected: 0,
    message_length_received: 0,
    // Sized per frame by _initialize_read_buffer() before any payload byte is stored.
    message_buffer: new ArrayBuffer(0),
    message_buffer_uint8_view: new Uint8Array(0),
    message_checksum: 0,
    crcError: false,

    callbacks: [] as MspRequest[],
    // Gyroflight (audit WP8 integration review): per write code, the transmissions not answered yet
    // (oldest first), for ANSWER_WINDOW_MS; an answer is matched to the oldest.
    write_transmissions: new Map<number, Array<{ owner: MspRequest; at: number }>>(),
    ANSWER_WINDOW_MS: 4000,
    parked: new Map<number, MspRequest[]>(), // errorAware requests parked behind an in-flight same-code request
    onTimeout: null as ((code: number) => void) | null, // invoked with the code when an errorAware request exhausts MAX_RETRIES
    // CRC error count; lives in the connection store so the status bar stays reactive.
    get packet_error(): number {
        return useConnectionStore(pinia).packetErrors;
    },
    set packet_error(value: number) {
        useConnectionStore(pinia).packetErrors = value;
    },
    unsupported: 0,

    TIMEOUT: 1000,
    MAX_RETRIES: 3,

    last_received_timestamp: null as number | null,
    listeners: [] as MspListener[],

    cli_buffer: [] as string[], // buffer for CLI character output
    cli_output: [] as string[],
    cli_callback: null as ((lines: string[]) => void) | null,
    cli_queue: [] as CliQueueEntry[], // pending { command, callback, timeoutMs } entries
    cli_in_flight: null as CliQueueEntry | null,
    cli_timer: null as Timer | null,
    // When a CLI command times out, we don't know whether the firmware is
    // mid-response, about to respond, or silent. Enter a "draining" state
    // in which no CLI command goes out and the late reply's text reaches
    // no caller; the decoder ends it on the reply's ETX (the firmware sends
    // one per command frame, answering ours), so it is consumed in full.
    // Gyroflight hook (docs/gyrocore/UPSTREAM.md, audit WP8-F09): MSP frames
    // received meanwhile are decoded as usual, and when the grace timer
    // expires without that ETX the session is uncertain (a reply without a
    // request id could still come and be taken for the next one's).
    cli_discarding: false,
    cli_drain_timer: null as Timer | null,
    cli_drain_grace_ms: 1000,
    cli_session_uncertain: false,
    // Gyroflight: bumped when the link is set up again; a transport result of an older one is stale.
    cli_generation: 0,

    SDCARD_STATE_NOT_PRESENT: 0,
    SDCARD_STATE_FATAL: 1,
    SDCARD_STATE_CARD_INIT: 2,
    SDCARD_STATE_FS_INIT: 3,
    SDCARD_STATE_READY: 4,

    read(readInfo: MspReadInfo) {
        const connectionStore = useConnectionStore();
        if (connectionStore.virtualMode) {
            return;
        }

        const data = new Uint8Array(
            (readInfo as { data?: ArrayBuffer | ArrayLike<number> }).data ?? (readInfo as ArrayBuffer),
        );

        for (const chunk of data) {
            this._decode_byte(chunk);
        }
        this.last_received_timestamp = Date.now();
    },
    _decode_byte(chunk: number): void {
        const handler = BYTE_HANDLERS[this.state];
        if (handler) {
            handler.call(this, chunk);
        } else {
            console.log(`Unknown state detected: ${this.state}`);
        }
    },
    _initialize_read_buffer() {
        this.message_buffer = new ArrayBuffer(this.message_length_expected);
        this.message_buffer_uint8_view = new Uint8Array(this.message_buffer);
    },

    _dispatch_message(expectedChecksum: number) {
        // Gyroflight hook (docs/gyrocore/UPSTREAM.md, audit WP8-F04 review): a request frame ('<', an
        // echo of what this app sent) is no answer; taken for one it would "acknowledge" a write.
        if (this.message_direction === 0) {
            console.log(`MSP: ignored a request frame (code ${this.code}) on the receive side`);
            this.message_length_received = 0;
            this.state = 0;
            this.crcError = false;
            return;
        }
        if (this.message_checksum === expectedChecksum) {
            // message received, store dataview
            this.dataView = new MspDataView(this.message_buffer, 0, this.message_length_expected);
        } else if (
            (
                serial._protocol as {
                    shouldBypassCrc?: (expectedChecksum: number, computedChecksum: number) => boolean;
                } | null
            )?.shouldBypassCrc?.(expectedChecksum, this.message_checksum)
        ) {
            // Capability check: only the Bluetooth protocols implement shouldBypassCrc,
            // for BT-11/CC2541 bridges that corrupt the MSP checksum to 0xff. Not gated
            // on serial.protocol — that getter returns the lowercased constructor name,
            // never "bluetooth".
            this.dataView = new MspDataView(this.message_buffer, 0, this.message_length_expected);
            this.crcError = false; // Override the CRC error for this specific case
        } else {
            this.packet_error++;
            this.crcError = true;
            this.dataView = new MspDataView(new ArrayBuffer(0));
        }
        this.notify();
        // Reset variables
        this.message_length_received = 0;
        this.state = 0;
        this.crcError = false;
    },
    notify() {
        this.listeners.forEach((listener) => {
            listener(this);
        });
    },
    listen(listener: MspListener) {
        if (!this.listeners.includes(listener)) {
            this.listeners.push(listener);
        }
    },
    clearListeners() {
        this.listeners = [];
    },
    crc8_dvb_s2(crc: number, ch: number): number {
        crc ^= ch;
        for (let ii = 0; ii < 8; ii++) {
            if (crc & 0x80) {
                crc = ((crc << 1) & 0xff) ^ 0xd5;
            } else {
                crc = (crc << 1) & 0xff;
            }
        }
        return crc;
    },
    crc8_dvb_s2_data(data: ArrayLike<number>, start: number, end: number): number {
        let crc = 0;
        for (let ii = start; ii < end; ii++) {
            crc = this.crc8_dvb_s2(crc, data[ii]);
        }
        return crc;
    },
    encode_message_v1(code: number, data: MspPayload): ArrayBuffer {
        const dataLength = data ? data.length : 0;
        // always reserve 6 bytes for protocol overhead !
        const bufferSize = dataLength + 6;
        const bufferOut = new ArrayBuffer(bufferSize);
        const bufView = new Uint8Array(bufferOut);

        bufView[0] = 36; // $
        bufView[1] = 77; // M
        bufView[2] = 60; // <
        bufView[3] = dataLength;
        bufView[4] = code;

        let checksum = bufView[3] ^ bufView[4];

        for (let i = 0; i < dataLength; i++) {
            bufView[i + 5] = (data as ArrayLike<number>)[i];
            checksum ^= bufView[i + 5];
        }

        bufView[5 + dataLength] = checksum;
        return bufferOut;
    },
    encode_message_v2(code: number, data: MspPayload): ArrayBuffer {
        const dataLength = data ? data.length : 0;
        // 9 bytes for protocol overhead
        const bufferSize = dataLength + 9;
        const bufferOut = new ArrayBuffer(bufferSize);
        const bufView = new Uint8Array(bufferOut);
        bufView[0] = 36; // $
        bufView[1] = 88; // X
        bufView[2] = 60; // <
        bufView[3] = 0; // flag
        bufView[4] = code & 0xff;
        bufView[5] = (code >> 8) & 0xff;
        bufView[6] = dataLength & 0xff;
        bufView[7] = (dataLength >> 8) & 0xff;
        for (let ii = 0; ii < dataLength; ii++) {
            bufView[8 + ii] = (data as ArrayLike<number>)[ii];
        }
        bufView[bufferSize - 1] = this.crc8_dvb_s2_data(bufView, 3, bufferSize - 1);
        return bufferOut;
    },
    encode_message_cli(str: string): ArrayBuffer {
        const data = Array.from(str, (c) => c.codePointAt(0)!);
        const dataLength = data ? data.length : 0;
        const bufferSize = dataLength + 3; // 3 bytes for protocol overhead
        const bufferOut = new ArrayBuffer(bufferSize);
        const bufView = new Uint8Array(bufferOut);
        bufView[0] = this.symbols.START_OF_TEXT; // STX
        for (let ii = 0; ii < dataLength; ii++) {
            bufView[1 + ii] = data[ii];
        }
        bufView[bufferSize - 2] = this.symbols.LINE_FEED; // LF
        bufView[bufferSize - 1] = this.symbols.END_OF_TEXT; // ETX
        return bufferOut;
    },
    send_cli_command(
        str: string,
        callback?: CliCallback,
        {
            timeoutMs,
            onSent,
            onDelivery,
        }: { timeoutMs?: number; onSent?: () => void; onDelivery?: (delivered: boolean) => void } = {},
    ) {
        // Gyroflight hook (docs/gyrocore/UPSTREAM.md): a CLI write is refused while the craft's
        // state is uncertain; the caller gets the error, nothing is sent.
        const refused = cliCommandRefusal(str);
        if (refused) {
            if (callback) callback([], writeRefused(refused));
            else reportRefusedWrite(`CLI "${str.split(/\s/)[0]}"`, refused);
            return;
        }
        const entry: CliQueueEntry = { command: str, callback, timeoutMs, onSent, onDelivery };
        if (this.cli_session_uncertain) {
            this._refuse_uncertain_cli(entry);
            return;
        }
        this.cli_queue.push(entry);
        this._process_cli_queue();
    },
    /** Gyroflight: a CLI command the uncertain session will not send; its caller is told. */
    _refuse_uncertain_cli(entry: CliQueueEntry) {
        const error = new CliSessionUncertainError(entry.command);
        try {
            if (entry.callback) entry.callback([], error);
            else reportRefusedWrite(`CLI "${entry.command.split(/\s/)[0]}"`, [error.message]);
        } catch (callbackError) {
            console.error("CLI callback threw on an uncertain session:", callbackError);
        }
    },
    /**
     * Gyroflight: from now on no CLI command goes out until disconnect_cleanup; the queued ones end,
     * and so does one in flight (no reply can be told apart from an earlier command's now).
     */
    _cli_session_lost() {
        this.cli_session_uncertain = true;
        for (const entry of this.cli_queue.splice(0, this.cli_queue.length)) this._refuse_uncertain_cli(entry);
        const inFlight = this.cli_in_flight;
        if (inFlight) {
            // It may have gone out unless the transport never took it (stillWanted stopped it).
            const notSent = inFlight.delivery === "failed" && !!inFlight.refusedAtWire;
            this._finish_cli([], new CliSessionUncertainError(inFlight.command, notSent), false);
        }
    },
    /** The CLI text received so far for the command in flight (null when none is). */
    cliInFlightOutput(): string[] | null {
        return this.cli_in_flight ? [...this.cli_output, this.cli_buffer.join("")] : null;
    },
    _process_cli_queue() {
        if (this.cli_in_flight || this.cli_discarding || this.cli_queue.length === 0) {
            return;
        }
        if (this.cli_session_uncertain) {
            this._cli_session_lost();
            return;
        }

        const entry = this.cli_queue.shift()!;
        // Gyroflight hook (docs/gyrocore/UPSTREAM.md): checked again now that it would go out (the
        // state may have changed while it waited in the queue). Nothing is sent; the caller is told.
        const refused = cliCommandRefusal(entry.command);
        if (refused) {
            try {
                if (entry.callback) entry.callback([], writeRefused(refused));
                else reportRefusedWrite(`CLI "${entry.command.split(/\s/)[0]}"`, refused);
            } catch (callbackError) {
                console.error("CLI callback threw on a refused write:", callbackError);
            }
            this._process_cli_queue();
            return;
        }
        this.cli_in_flight = entry;
        this.cli_buffer.length = 0;
        this.cli_output.length = 0;

        this.cli_callback = (lines) => {
            this._cli_replied(entry, [...lines]);
        };

        if (entry.timeoutMs) {
            this.cli_timer = setTimeout(() => {
                // Gyroflight: with whether it went out whole and what came back so far (WP8-F01).
                const timedOut = Object.assign(
                    new Error(`Timed out after ${entry.timeoutMs}ms waiting for response to "${entry.command}"`),
                    { delivered: entry.delivery === "delivered", output: this.cliInFlightOutput() ?? [] },
                );
                this._finish_cli([], timedOut);
            }, entry.timeoutMs);
        }

        entry.onSent?.();
        entry.delivery = "pending";
        entry.generation = this.cli_generation;
        const frame = this.encode_message_cli(entry.command);
        // Gyroflight hook (docs/gyrocore/UPSTREAM.md, audit WP8-F01/F03/F09): checked once more right
        // before its bytes go out (the transport may have held it behind an earlier send), and
        // delivered only when the transport reports every byte.
        const stillWanted = () => {
            if (this.cli_in_flight !== entry || entry.generation !== this.cli_generation) return false;
            entry.refusedAtWire = this.cli_session_uncertain
                ? [new CliSessionUncertainError(entry.command).message]
                : (cliCommandRefusal(entry.command) ?? undefined);
            return !entry.refusedAtWire;
        };
        // The result is handled before the transport may take the next send (onResult), so a failed
        // send closes the session before a successor's stillWanted runs. A transport replaced by a
        // test double without onResult is handled when its promise settles.
        let handled = false;
        const onResult = (result: { bytesSent: number } | undefined) => {
            if (handled) return;
            handled = true;
            this._cli_delivered(entry, result?.bytesSent === frame.byteLength);
        };
        void Promise.resolve(serial.send(frame, undefined, { stillWanted, onResult })).then(onResult);
    },
    /** Gyroflight: the transport's result for a CLI command (see _process_cli_queue). */
    _cli_delivered(entry: CliQueueEntry, delivered: boolean) {
        // Sent on a link that was set up again since: nothing of it concerns this session.
        if (entry.generation !== this.cli_generation) return;
        entry.delivery = delivered ? "delivered" : "failed";
        try {
            entry.onDelivery?.(delivered);
        } catch (callbackError) {
            console.error("CLI delivery callback threw:", callbackError);
        }
        const inFlight = this.cli_in_flight === entry;
        if (delivered) {
            if (inFlight && entry.reply) this._finish_cli(entry.reply, null);
            return;
        }
        if (entry.refusedAtWire) {
            // Stopped before any byte went out: refused, nothing to drain.
            if (inFlight) this._finish_cli([], writeRefused(entry.refusedAtWire), false);
            return;
        }
        // Part of it may have reached the firmware: the session is uncertain.
        this.cli_session_uncertain = true;
        if (inFlight) this._finish_cli([], new CliDeliveryError(entry.command));
        else this._cli_session_lost();
    },
    /** Gyroflight: its reply (ETX) came; it succeeds only once its bytes are known to have gone out whole. */
    _cli_replied(entry: CliQueueEntry, lines: string[]) {
        if (this.cli_in_flight !== entry) return;
        if (entry.delivery === "delivered") {
            this._finish_cli(lines, null);
            return;
        }
        entry.reply = lines;
        this.cli_callback = null;
    },
    _finish_cli(lines: string[], error: Error | null, drain = true) {
        const entry = this.cli_in_flight;
        if (!entry) {
            return;
        }

        this.cli_in_flight = null;
        this.cli_callback = null;
        this.cli_buffer.length = 0;
        this.cli_output.length = 0;

        if (this.cli_timer) {
            clearTimeout(this.cli_timer);
            this.cli_timer = null;
        }

        // Drain any in-flight or soon-to-arrive response before sending the
        // next command; the decoder ends the drain on its ETX. Gyroflight: when
        // the grace timer expires first, the session is uncertain. Set before
        // the caller hears of it (audit WP8-F09), so a command it sends from its
        // callback waits behind the drain.
        if (error && drain && !this.cli_session_uncertain) {
            this.cli_discarding = true;
            if (this.cli_drain_timer) {
                clearTimeout(this.cli_drain_timer);
            }
            this.cli_drain_timer = setTimeout(() => this._cli_drain_expired(), this.cli_drain_grace_ms);
        }

        // A reply that came while the session turned uncertain may belong to another command.
        const outcome =
            !error && this.cli_session_uncertain ? new CliSessionUncertainError(entry.command, false) : error;
        try {
            entry.callback?.(outcome ? [] : lines, outcome);
        } catch (callbackError) {
            console.error("CLI callback threw:", callbackError);
        }

        if (this.cli_session_uncertain) {
            this._cli_session_lost();
            return;
        }
        this._process_cli_queue();
    },
    _end_cli_drain() {
        if (this.cli_drain_timer) {
            clearTimeout(this.cli_drain_timer);
            this.cli_drain_timer = null;
        }
        this.cli_discarding = false;
        this.cli_buffer.length = 0;
        this.cli_output.length = 0;
        this.state = this.decoder_states.IDLE;
        this._process_cli_queue();
    },
    _cli_drain_expired() {
        this.cli_drain_timer = null;
        this.cli_discarding = false;
        this.cli_buffer.length = 0;
        this.cli_output.length = 0;
        // A late reply's text would otherwise swallow the MSP frames after it.
        if (this.state === this.decoder_states.CLI_COMMAND) this.state = this.decoder_states.IDLE;
        this._cli_session_lost();
    },
    _drain_cli_queue(error: Error) {
        if (this.cli_timer) {
            clearTimeout(this.cli_timer);
            this.cli_timer = null;
        }
        if (this.cli_drain_timer) {
            clearTimeout(this.cli_drain_timer);
            this.cli_drain_timer = null;
        }

        const pending = this.cli_queue.splice(0, this.cli_queue.length);
        const inFlight = this.cli_in_flight;
        const output = this.cliInFlightOutput() ?? [];
        this.cli_in_flight = null;
        this.cli_callback = null;
        this.cli_buffer.length = 0;
        this.cli_output.length = 0;
        this.cli_discarding = false;
        this.cli_session_uncertain = false;
        this.cli_generation++;

        // Gyroflight hook (docs/gyrocore/UPSTREAM.md, audit WP8-F01): only the command in flight
        // carries the caller's error, with whether all its bytes were sent and the text received for
        // it so far (a `save` prints its outcome and then resets the FC); the queued ones never left
        // the app.
        const outcomes: Array<[CliQueueEntry | null, Error]> = [
            [
                inFlight,
                Object.assign(new Error(error.message), error, {
                    delivered: inFlight?.delivery === "delivered",
                    output,
                }),
            ],
            ...pending.map((entry): [CliQueueEntry, Error] => [
                entry,
                Object.assign(new Error(`CLI "${entry.command.split(/\s/)[0]}" not sent: ${error.message}`), {
                    notSent: true,
                }),
            ]),
        ];
        for (const [entry, entryError] of outcomes) {
            if (!entry?.callback) {
                continue;
            }
            try {
                entry.callback([], entryError);
            } catch (callbackError) {
                console.error("CLI callback threw during drain:", callbackError);
            }
        }
    },
    send_message(
        code: number | undefined,
        data?: MspPayload,
        callback_sent?: (() => void) | false,
        callback_msp?: MspCallback | false,
    ): boolean {
        const connectionStore = useConnectionStore();
        if (code === undefined || !serial.connected || connectionStore.virtualMode) {
            if (callback_msp) {
                (callback_msp as () => void)();
            }
            return false;
        }

        return this._transmit(code, data, callback_sent, callback_msp, false);
    },
    _buffer_matches(entry: MspRequest, view: Uint8Array): boolean {
        if (entry.requestBuffer?.byteLength !== view.byteLength) {
            return false;
        }
        const entryView = new Uint8Array(entry.requestBuffer);
        for (let i = 0; i < view.byteLength; i++) {
            if (entryView[i] !== view[i]) {
                return false;
            }
        }
        return true;
    },
    /**
     * Transmit an MSP request and register its response callback.
     * @param {number} code MSP command code
     * @param {ArrayBuffer|Array<number>|false|undefined} data optional command payload
     * @param {Function|false|undefined} callback_sent callback invoked after the bytes are sent
     * @param {Function|false|undefined} callback_msp callback invoked with the MSP response
     * @param {boolean} errorAware whether timeout and cancellation errors settle the request
     * @param {boolean} [notifyTimeout=true] whether timeout exhaustion invokes MSP.onTimeout
     * @param {WritePermit} [permit] Gyroflight: a write transaction's authority for its own write
     * @returns {boolean} true when the request is queued
     */
    _transmit(
        code: number,
        data: MspPayload,
        callback_sent: (() => void) | false | undefined,
        callback_msp: MspCallback | false | undefined,
        errorAware: boolean,
        notifyTimeout = true,
        permit?: WritePermit,
    ): boolean {
        // Gyroflight hook (docs/gyrocore/UPSTREAM.md): a write is refused while the craft's state is
        // uncertain. An awaiter gets the error; a callback caller gets no callback (never "saved").
        const recheck = () => mspRequestRefusal(code, data, permit);
        const refused = recheck();
        const write = classifyMsp(code, data) === "write";
        const foreignWrite = !permit && write;
        if (refused) {
            if (errorAware && callback_msp) callback_msp(null, writeRefused(refused));
            else reportRefusedWrite(`MSP ${code}`, refused);
            return false;
        }
        const bufferOut = code <= 254 ? this.encode_message_v1(code, data) : this.encode_message_v2(code, data);
        const view = new Uint8Array(bufferOut);

        // Per-code serialisation: an errorAware request whose code matches an in-flight
        // errorAware entry with a DIFFERENT buffer parks behind it (identical buffers
        // dedup and attach instead). Same-code legacy entries never cause parking.
        if (errorAware) {
            const differentInFlight = this.callbacks.some(
                (i) => i.errorAware && i.code === code && !this._buffer_matches(i, view),
            );
            if (differentInFlight) {
                this._park(code, {
                    code,
                    requestBuffer: bufferOut,
                    callback: callback_msp,
                    callbackSent: callback_sent,
                    errorAware: true,
                    notifyTimeout,
                    recheck,
                    foreignWrite,
                    write,
                });
                return true;
            }
        }

        const same = this.callbacks.filter((i) => i.code === code && this._buffer_matches(i, view));
        const requestExists = same.length > 0;

        const obj: MspRequest = {
            code,
            requestBuffer: bufferOut,
            callback: callback_msp,
            callbackSent: callback_sent,
            errorAware,
            notifyTimeout,
            attempts: 1,
            start: performance.now(),
            recheck,
            foreignWrite,
            write,
            // Gyroflight (audit WP8 review round 3): an identical request already went out this often;
            // its answer, when it comes, may be to any of those, even after that request gave up.
            priorAttempts: Math.max(0, ...same.map((i) => (i.attempts ?? 1) + (i.priorAttempts ?? 0))),
        };

        // errorAware entries always arm their own timer (even when deduped) so an awaiter
        // that attached onto a stalled request still settles.
        if (errorAware || !requestExists) {
            this._arm_timer(obj);
        }

        this.callbacks.push(obj);

        // always send messages with data payload (even when there is a message already in the queue)
        // Gyroflight (audit WP8 integration review): a write always goes out itself; an answer to an
        // identical earlier one would not show what RAM held when this one was asked for.
        if (data || !requestExists || write) {
            obj.awaitingWire = write;
            void serial.send(
                bufferOut,
                (sendInfo: { bytesSent: number }) => {
                    if (sendInfo.bytesSent === bufferOut.byteLength && callback_sent) {
                        callback_sent();
                    }
                },
                { stillWanted: () => this._still_wanted(obj) },
            );
        }

        return true;
    },
    _arm_timer(obj: MspRequest) {
        obj.timer = setTimeout(() => this._on_timeout(obj), this.TIMEOUT);
    },
    /**
     * Retry/timeout handler for a single queued MSP request.
     *
     * While retries remain it re-sends the request buffer and re-arms the timer. On exhaustion it
     * clears the timer and, for errorAware requests, removes the queue entry, settles its awaiter
     * with an {@link MspTimeoutError}, and releases any same-code requests parked behind it. Legacy
     * (non-errorAware) requests are left queued so a late response can still resolve them.
     *
     * After an errorAware exhaustion it notifies {@link MSP.onTimeout}. The dead-versus-slow-link
     * decision is deliberately made by that hook from the FC's actual traffic (see
     * `handleConnectionTimeout` in serial_backend), not from this per-request failure — so a lone
     * timeout on a high-latency transport does not tear down a healthy connection.
     *
     * @param {object} obj - the queued request entry (`code`, `requestBuffer`, `attempts`, `errorAware`, `callback`, `timer`, …).
     * @returns {void}
     */
    _on_timeout(obj: MspRequest) {
        // Gyroflight hook (docs/gyrocore/UPSTREAM.md): a retry is a new transmission, checked again.
        // Refused, it is not resent and ends now; the first attempt may have run on the FC.
        const retryRefused = (obj.attempts ?? 1) < this.MAX_RETRIES ? obj.recheck?.() : null;
        if (retryRefused) {
            clearTimeout(obj.timer ?? undefined);
            obj.timer = null;
            if (!obj.errorAware) {
                obj.exhausted = true;
                reportRefusedWrite(`MSP ${obj.code} retry`, retryRefused);
                return;
            }
            const at = this.callbacks.indexOf(obj);
            if (at !== -1) this.callbacks.splice(at, 1);
            try {
                // Every attempt was stopped before its bytes reached the transport (stillWanted): not
                // sent. Otherwise, or when that is not known, the first attempt may have run.
                const error =
                    obj.wireSends === 0 ? writeRefused(retryRefused) : new WriteRetryRefusedError(retryRefused);
                errorAwareCallback(obj)?.(null, error);
            } catch (callbackError) {
                console.error("MSP callback threw on a refused retry:", callbackError);
            }
            this._release_parked(obj.code);
            return;
        }
        if ((obj.attempts ?? 1) < this.MAX_RETRIES) {
            obj.attempts = (obj.attempts ?? 1) + 1;
            console.warn(
                `MSP: data request timed-out: ${obj.code} ID: ${serial.connectionId} TAB: ${useNavigationStore().activeTab} QUEUE: ${this.callbacks.length} (${this.callbacks.map((e) => e.code)})`,
            );
            void serial.send(obj.requestBuffer, undefined, { stillWanted: () => this._still_wanted(obj) });
            this._arm_timer(obj);
            return;
        }

        clearTimeout(obj.timer ?? undefined);
        obj.timer = null;

        if (!obj.errorAware) {
            // Legacy path: stop retrying but keep the entry queued so a late response still resolves it.
            // Gyroflight: its bytes still held by the transport do not go out any more (WP8 review).
            obj.exhausted = true;
            return;
        }

        const index = this.callbacks.indexOf(obj);
        if (index !== -1) {
            this.callbacks.splice(index, 1);
        }
        try {
            errorAwareCallback(obj)?.(null, new MspTimeoutError(`MSP request timed out: ${obj.code}`, obj.code));
        } catch (callbackError) {
            console.error("MSP callback threw on timeout:", callbackError);
        }
        this._release_parked(obj.code);

        // Notify the liveness hook after a full errorAware exhaustion unless the caller expects
        // the FC to be temporarily silent (for example while erasing dataflash). The request still
        // rejects normally so that operation-specific retry or failure handling can proceed.
        if (obj.notifyTimeout) {
            this.onTimeout?.(obj.code);
        }
    },
    _park(code: number, entry: MspRequest) {
        let queue = this.parked.get(code);
        if (!queue) {
            queue = [];
            this.parked.set(code, queue);
        }
        queue.push(entry);
    },
    _release_parked(code: number) {
        const queue = this.parked.get(code);
        if (!queue || queue.length === 0) {
            return;
        }
        if (this.callbacks.some((i) => i.errorAware && i.code === code)) {
            return;
        }

        const entry = queue.shift()!;
        if (queue.length === 0) {
            this.parked.delete(code);
        }

        // Gyroflight hook (docs/gyrocore/UPSTREAM.md): checked again now that it would go out.
        const refused = entry.recheck?.();
        if (refused) {
            try {
                errorAwareCallback(entry)?.(null, writeRefused(refused));
            } catch (callbackError) {
                console.error("MSP callback threw on a refused write:", callbackError);
            }
            this._release_parked(code);
            return;
        }

        entry.attempts = 1;
        entry.start = performance.now();
        entry.awaitingWire = entry.write;
        this._arm_timer(entry);
        this.callbacks.push(entry);

        void serial.send(
            entry.requestBuffer,
            (sendInfo: { bytesSent: number }) => {
                if (sendInfo.bytesSent === entry.requestBuffer.byteLength && entry.callbackSent) {
                    entry.callbackSent();
                }
            },
            { stillWanted: () => this._still_wanted(entry) },
        );
    },
    /**
     * Gyroflight hook (docs/gyrocore/UPSTREAM.md, audit WP8-F03): asked right before a request's bytes
     * go to the transport, which may have held them behind an earlier send. A request that timed
     * out or was cleared meanwhile, or that the write check would now refuse, does not go out late.
     */
    _still_wanted(obj: MspRequest): boolean {
        if (obj.exhausted || !this.callbacks.includes(obj) || obj.recheck?.()) {
            obj.wireSends ??= 0;
            return false;
        }
        obj.wireSends = (obj.wireSends ?? 0) + 1;
        obj.awaitingWire = false;
        if (obj.write) this._note_transmission(obj);
        return true;
    },
    /** Gyroflight: a write's bytes go to the transport now (see write_transmissions). */
    _note_transmission(obj: MspRequest) {
        const now = Date.now();
        const list = (this.write_transmissions.get(obj.code) ?? []).filter((t) => now - t.at < this.ANSWER_WINDOW_MS);
        if (list.some((t) => t.owner !== obj)) obj.ambiguous = true;
        list.push({ owner: obj, at: now });
        this.write_transmissions.set(obj.code, list);
    },
    /** Gyroflight: an answer to `code` came; it is matched to the oldest open transmission. */
    _note_answer(code: number) {
        const list = this.write_transmissions.get(code);
        if (!list) return;
        const now = Date.now();
        const open = list.filter((t) => now - t.at < this.ANSWER_WINDOW_MS);
        open.shift();
        if (open.length) this.write_transmissions.set(code, open);
        else this.write_transmissions.delete(code);
    },
    /**
     * @param {number} code MSP command code
     * @param {ArrayBuffer|Array<number>|false} data optional command payload
     * @param {{notifyTimeout?: boolean, permit?: WritePermit}} options set notifyTimeout false when
     * request silence is expected and must not trigger the connection-liveness watchdog; permit
     * (Gyroflight) is a write transaction's authority for its own write
     * @returns {Promise<object|undefined>} resolves with {command, data, length}; rejects with
     * MspTimeoutError, MspCancelledError, MspCrcError or (Gyroflight) WriteRefusedError
     */
    async promise(
        code: number | undefined,
        data?: MspPayload,
        { notifyTimeout = true, permit }: { notifyTimeout?: boolean; permit?: WritePermit } = {},
    ): Promise<MspResponse | undefined> {
        const connectionStore = useConnectionStore();
        if (code === undefined || connectionStore.virtualMode) {
            return undefined;
        }

        if (!serial.connected) {
            throw new MspCancelledError("MSP request while disconnected", code, "disconnected");
        }

        return new Promise<MspResponse | undefined>((resolve, reject) => {
            this._transmit(
                code,
                data,
                false,
                (response, error) => {
                    if (error) {
                        reject(error);
                    } else {
                        resolve(response ?? undefined);
                    }
                },
                true,
                notifyTimeout,
                permit,
            );
        });
    },
    callbacks_cleanup(error: Error = new MspCancelledError("MSP queue cleared", undefined, "cleanup")) {
        const pending = this.callbacks;
        this.callbacks = [];
        this.write_transmissions.clear();

        const parked: MspRequest[] = [];
        for (const queue of this.parked.values()) {
            parked.push(...queue);
        }
        this.parked.clear();

        for (const entry of pending) {
            clearTimeout(entry.timer ?? undefined);
        }

        for (const entry of [...pending, ...parked]) {
            if (!entry.errorAware) {
                continue;
            }
            try {
                errorAwareCallback(entry)?.(null, error);
            } catch (callbackError) {
                console.error("MSP callback threw during cleanup:", callbackError);
            }
        }
    },
    disconnect_cleanup() {
        this.state = 0; // reset packet state for "clean" initial entry (this is only required if user hot-disconnects)
        this.packet_error = 0; // reset CRC packet error counter for next session

        this.callbacks_cleanup(new MspCancelledError("Serial connection closed", undefined, "disconnected"));
        // Tag the error so callers can distinguish an EXPECTED close-driven drain — a `save`/
        // `exit` reboots the FC, closing the port before it can reply — from a genuine command
        // failure. The save still succeeded; the board is just restarting.
        const closedError = Object.assign(new Error("Serial connection closed"), { connectionClosed: true });
        this._drain_cli_queue(closedError);
    },
};

// One handler per decoder state, fed a byte at a time by MSP.read().
const BYTE_HANDLERS: Partial<Record<number, (this: typeof MSP, chunk: number) => void>> = {
    [MSP.decoder_states.CLI_COMMAND](chunk) {
        switch (chunk) {
            case this.symbols.END_OF_TEXT:
                this.cli_output.push(this.cli_buffer.join(""));
                this.cli_buffer.length = 0;
                this.state = this.decoder_states.IDLE;
                if (this.cli_callback) {
                    const response = this.cli_output;
                    this.cli_callback(response);
                } else {
                    // A reply no command waits for (the late one being drained): it reaches no one.
                    this.cli_output.length = 0;
                    if (this.cli_discarding) this._end_cli_drain();
                }
                break;
            case this.symbols.LINE_FEED:
                this.cli_output.push(this.cli_buffer.join(""));
                this.cli_buffer.length = 0;
                break;
            case this.symbols.CARRIAGE_RETURN:
                // ignore CRs
                break;
            default:
                this.cli_buffer.push(String.fromCodePoint(chunk));
                break;
        }
    },

    [MSP.decoder_states.IDLE](chunk) {
        // sync char 1
        switch (chunk) {
            case this.symbols.BEGIN:
                this.state = this.decoder_states.PROTO_IDENTIFIER;
                break;
            case this.symbols.START_OF_TEXT:
                this.state = this.decoder_states.CLI_COMMAND;
                break;
        }
    },

    [MSP.decoder_states.PROTO_IDENTIFIER](chunk) {
        // sync char 2
        switch (chunk) {
            case this.symbols.PROTO_V1:
                this.state = this.decoder_states.DIRECTION_V1;
                break;
            case this.symbols.PROTO_V2:
                this.state = this.decoder_states.DIRECTION_V2;
                break;
            default:
                console.log(`Unknown protocol char ${String.fromCodePoint(chunk)}`);
                this.state = this.decoder_states.IDLE;
        }
    },

    // direction (should be >)
    [MSP.decoder_states.DIRECTION_V1](chunk) {
        this.unsupported = 0;
        switch (chunk) {
            case this.symbols.FROM_MWC:
                this.message_direction = 1;
                break;
            case this.symbols.TO_MWC:
                this.message_direction = 0;
                break;
            case this.symbols.UNSUPPORTED:
                // Gyroflight: the firmware's error answer (it does not keep an earlier '<').
                this.message_direction = 1;
                this.unsupported = 1;
                break;
            default:
                // Gyroflight: no direction the firmware sends (a corrupted header): not an answer.
                this.message_direction = 0;
                break;
        }
        this.state =
            this.state === this.decoder_states.DIRECTION_V1
                ? this.decoder_states.PAYLOAD_LENGTH_V1
                : this.decoder_states.FLAG_V2;
    },

    [MSP.decoder_states.FLAG_V2]() {
        // The flag byte is ignored for now
        this.state = this.decoder_states.CODE_V2_LOW;
    },

    [MSP.decoder_states.PAYLOAD_LENGTH_V1](chunk) {
        this.message_length_expected = chunk;

        if (this.message_length_expected === this.constants.JUMBO_FRAME_MIN_SIZE) {
            this.state = this.decoder_states.CODE_JUMBO_V1;
        } else {
            this._initialize_read_buffer();
            this.state = this.decoder_states.CODE_V1;
        }
    },

    [MSP.decoder_states.PAYLOAD_LENGTH_V2_LOW](chunk) {
        this.message_length_expected = chunk;
        this.state = this.decoder_states.PAYLOAD_LENGTH_V2_HIGH;
    },

    [MSP.decoder_states.PAYLOAD_LENGTH_V2_HIGH](chunk) {
        this.message_length_expected |= chunk << 8;
        this._initialize_read_buffer();
        this.state =
            this.message_length_expected > 0 ? this.decoder_states.PAYLOAD_V2 : this.decoder_states.CHECKSUM_V2;
    },

    [MSP.decoder_states.CODE_V1](chunk) {
        this.code = chunk;
        if (this.message_length_expected > 0) {
            // process payload
            if (this.state === this.decoder_states.CODE_JUMBO_V1) {
                this.state = this.decoder_states.PAYLOAD_LENGTH_JUMBO_LOW;
            } else {
                this.state = this.decoder_states.PAYLOAD_V1;
            }
        } else {
            // no payload
            this.state = this.decoder_states.CHECKSUM_V1;
        }
    },

    [MSP.decoder_states.CODE_V2_LOW](chunk) {
        this.code = chunk;
        this.state = this.decoder_states.CODE_V2_HIGH;
    },

    [MSP.decoder_states.CODE_V2_HIGH](chunk) {
        this.code |= chunk << 8;
        this.state = this.decoder_states.PAYLOAD_LENGTH_V2_LOW;
    },

    [MSP.decoder_states.PAYLOAD_LENGTH_JUMBO_LOW](chunk) {
        this.message_length_expected = chunk;
        this.state = this.decoder_states.PAYLOAD_LENGTH_JUMBO_HIGH;
    },

    [MSP.decoder_states.PAYLOAD_LENGTH_JUMBO_HIGH](chunk) {
        this.message_length_expected |= chunk << 8;
        this._initialize_read_buffer();
        this.state = this.decoder_states.PAYLOAD_V1;
    },

    [MSP.decoder_states.PAYLOAD_V1](chunk) {
        this.message_buffer_uint8_view[this.message_length_received] = chunk;
        this.message_length_received++;

        if (this.message_length_received >= this.message_length_expected) {
            this.state =
                this.state === this.decoder_states.PAYLOAD_V1
                    ? this.decoder_states.CHECKSUM_V1
                    : this.decoder_states.CHECKSUM_V2;
        }
    },

    [MSP.decoder_states.CHECKSUM_V1](chunk) {
        if (this.message_length_expected >= this.constants.JUMBO_FRAME_MIN_SIZE) {
            this.message_checksum = this.constants.JUMBO_FRAME_MIN_SIZE;
        } else {
            this.message_checksum = this.message_length_expected;
        }
        this.message_checksum ^= this.code;
        if (this.message_length_expected >= this.constants.JUMBO_FRAME_MIN_SIZE) {
            this.message_checksum ^= this.message_length_expected & 0xff;
            this.message_checksum ^= (this.message_length_expected & 0xff00) >> 8;
        }
        for (let ii = 0; ii < this.message_length_received; ii++) {
            this.message_checksum ^= this.message_buffer_uint8_view[ii];
        }
        this._dispatch_message(chunk);
    },

    [MSP.decoder_states.CHECKSUM_V2](chunk) {
        this.message_checksum = 0;
        this.message_checksum = this.crc8_dvb_s2(this.message_checksum, 0); // flag
        this.message_checksum = this.crc8_dvb_s2(this.message_checksum, this.code & 0xff);
        this.message_checksum = this.crc8_dvb_s2(this.message_checksum, (this.code & 0xff00) >> 8);
        this.message_checksum = this.crc8_dvb_s2(this.message_checksum, this.message_length_expected & 0xff);
        this.message_checksum = this.crc8_dvb_s2(this.message_checksum, (this.message_length_expected & 0xff00) >> 8);
        for (let ii = 0; ii < this.message_length_received; ii++) {
            this.message_checksum = this.crc8_dvb_s2(this.message_checksum, this.message_buffer_uint8_view[ii]);
        }
        this._dispatch_message(chunk);
    },
};

// The two protocol versions share these steps; each handler tells them apart by `this.state`.
BYTE_HANDLERS[MSP.decoder_states.DIRECTION_V2] = BYTE_HANDLERS[MSP.decoder_states.DIRECTION_V1];
BYTE_HANDLERS[MSP.decoder_states.CODE_JUMBO_V1] = BYTE_HANDLERS[MSP.decoder_states.CODE_V1];
BYTE_HANDLERS[MSP.decoder_states.PAYLOAD_V2] = BYTE_HANDLERS[MSP.decoder_states.PAYLOAD_V1];

declare global {
    interface Window {
        // Read by the dev-only MSP debug tools in src/js/msp/debug/.
        MSP: typeof MSP;
    }
}

window.MSP = MSP;

// Gyroflight hook (docs/gyrocore/UPSTREAM.md, audit WP8-F02): this page yields the write lease to
// another page's transaction only while nothing it sent is still with the transport (any send,
// raw CLI text included, also one whose request gave up), none of its writes still awaits an
// answer (a retry is pending), and no CLI command is in flight or queued.
writeLease.setBusyProbe(
    () =>
        serial.pendingSends > 0 ||
        MSP.callbacks.some((e) => e.foreignWrite && e.timer) ||
        [...MSP.parked.values()].some((q) => q.some((e) => e.foreignWrite)) ||
        MSP.cli_in_flight !== null ||
        MSP.cli_queue.length > 0,
);

export default MSP;
