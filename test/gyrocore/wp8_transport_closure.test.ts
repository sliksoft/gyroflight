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
 * Audit WP8 transport closure: a send stuck on a connection keeps this page from yielding the write
 * lease until that connection's own transport proves it closed, and not a moment earlier. The
 * production WebSerial, WebBluetooth and WebSocket adapters sit in the facade's real slots and are
 * connected through serial.connect(); only the browser objects under them are fakes (a SerialPort
 * whose writes and close the test settles by hand, a GATT device, a WebSocket). This page's lease
 * is the app's own (fcWriteGuard starts it, msp.ts gives it serial.pendingSends as its busy probe);
 * the other tab is a second lease on the same lock manager and channel.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/js/protocols/devices", () => ({
    webSerialDevices: [],
    vendorIdNames: {},
    bluetoothDevices: [
        {
            name: "CC2541",
            serviceUuid: "0000ffe0-0000-1000-8000-00805f9b34fb",
            writeCharacteristic: "0000ffe1-0000-1000-8000-00805f9b34fb",
            readCharacteristic: "0000ffe2-0000-1000-8000-00805f9b34fb",
        },
    ],
}));
vi.mock("../../src/stores/appInfo", () => ({ useAppInfoStore: () => ({ operatingSystem: "Linux" }) }));
vi.mock("../../src/js/localization", () => ({ i18n: { getMessage: (key: string) => key } }));
vi.mock("../../src/js/gui_log", () => ({ gui_log: vi.fn() }));

import MSP from "../../src/js/msp";
import { serial, type SerialProtocol } from "../../src/js/serial";
import WebSerial from "../../src/js/protocols/WebSerial";
import WebBluetooth, { type BleDevice } from "../../src/js/protocols/WebBluetooth";
import Websocket from "../../src/js/protocols/WebSocket";
import "../../src/composables/fcWriteGuard"; // starts this page's lease
import {
    createWriteLease,
    FC_WRITE_LEASE_CHANNEL,
    WRITE_LEASE_TIMEOUT,
    writeLease,
    type WriteLease,
} from "../../src/composables/fcWriteLease";
import { ApplyBlockedError } from "../../src/gyrocore/chirp/applyGate";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
};

async function until(cond: () => boolean, ms = 2000) {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) throw new Error("condition not reached");
        await wait(5);
    }
}

interface Deferred<T = void> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: Error) => void;
}

/** Every write a fake was handed; afterEach settles them, so no test's stuck send reaches the next. */
const handed: Deferred[] = [];

function deferred<T = void>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/** Tracks whether a promise has settled. */
function watch<T>(promise: Promise<T>) {
    const state = { settled: false, value: undefined as T | undefined };
    void promise.then((value) => {
        state.settled = true;
        state.value = value;
    });
    return state;
}

// ---------------------------------------------------------------------------------------------
// Fake browser objects under the production adapters.
// ---------------------------------------------------------------------------------------------

/**
 * A W3C SerialPort whose writes stay pending until the test settles them (a write that never
 * returns is the worst case: by the specification close() aborts it, here it may not), and whose
 * close() resolves, rejects or waits as the test says.
 */
function fakeSerialPort() {
    const writes: { bytes: number[]; done: Deferred }[] = [];
    let closeWith: () => Promise<void> = async () => undefined;
    const writer = {
        write: vi.fn((chunk: ArrayBuffer | Uint8Array) => {
            const done = deferred();
            handed.push(done);
            writes.push({ bytes: Array.from(new Uint8Array(chunk as ArrayBuffer)), done });
            return done.promise;
        }),
        releaseLock: vi.fn(),
    };
    const reader = { read: () => new Promise(() => {}), cancel: vi.fn(async () => undefined), releaseLock: vi.fn() };
    const port = {
        getInfo: () => ({ usbVendorId: 0x0483, usbProductId: 0x5740 }),
        open: vi.fn(async () => undefined),
        close: vi.fn(() => closeWith()),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        readable: { getReader: () => reader },
        writable: { getWriter: () => writer },
    };
    return {
        port,
        writer,
        reader,
        writes,
        closeResolves: () => (closeWith = async () => undefined),
        closeRejects: () => (closeWith = async () => Promise.reject(new Error("close failed"))),
        closeWaits: () => {
            const gate = deferred();
            closeWith = () => gate.promise;
            return gate;
        },
    };
}

const UUID = {
    service: "0000ffe0-0000-1000-8000-00805f9b34fb",
    write: "0000ffe1-0000-1000-8000-00805f9b34fb",
    read: "0000ffe2-0000-1000-8000-00805f9b34fb",
};

/**
 * A Web Bluetooth device. Every GATT connection gets its own characteristic objects, as the
 * specification has it, so a test sees which connection a write went to.
 */
function fakeBleDevice(id = "ble-1") {
    const writes: { connection: number; bytes: number[]; done: Deferred }[] = [];
    let connection = 0;
    let stopNotifications: () => Promise<unknown> = async () => undefined;
    let disconnectWorks = true;
    const characteristic = (uuid: string, n: number) => ({
        uuid,
        properties: { notify: true },
        writeValue: vi.fn((value: Uint8Array) => {
            const done = deferred();
            handed.push(done);
            writes.push({ connection: n, bytes: Array.from(value), done });
            return done.promise;
        }),
        startNotifications: vi.fn(async () => undefined),
        stopNotifications: vi.fn(() => stopNotifications()),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    });
    const gatt = {
        connected: false,
        connect: vi.fn(async () => {
            gatt.connected = true;
            const n = ++connection;
            const chars = [characteristic(UUID.write, n), characteristic(UUID.read, n)];
            return { getPrimaryServices: async () => [{ uuid: UUID.service, getCharacteristics: async () => chars }] };
        }),
        disconnect: vi.fn(() => {
            if (disconnectWorks) gatt.connected = false;
        }),
    };
    const device = { id, name: "FC", gatt, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    return {
        device: device as unknown as BleDevice,
        gatt,
        writes,
        stopWaits: () => {
            const gate = deferred();
            stopNotifications = () => gate.promise;
            return gate;
        },
        stopNeverAnswers: () => (stopNotifications = () => new Promise(() => {})),
        disconnectFails: () => (disconnectWorks = false),
        disconnectWorks: () => (disconnectWorks = true),
    };
}

/** The browser WebSocket: the test sets readyState and bufferedAmount as the platform would. */
class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static made: FakeWebSocket[] = [];
    readyState = FakeWebSocket.CONNECTING;
    bufferedAmount = 0;
    onopen: ((e: Event) => void) | null = null;
    onclose: ((e: CloseEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    send = vi.fn();
    close = vi.fn(() => {
        if (this.readyState !== FakeWebSocket.CLOSED) this.readyState = FakeWebSocket.CLOSING;
    });
    constructor() {
        FakeWebSocket.made.push(this);
    }
    open() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.(new Event("open"));
    }
}

// ---------------------------------------------------------------------------------------------
// The facade's real slots.
// ---------------------------------------------------------------------------------------------

type Slot = { name: string; instance: SerialProtocol };
const slots = () => (serial as unknown as { _protocols: Slot[] })._protocols;
let saved: Slot[];

function install(name: string, instance: unknown) {
    const slot = slots().find((s) => s.name === name)!;
    slot.instance = instance as SerialProtocol;
}

async function connectSerial(port: ReturnType<typeof fakeSerialPort>["port"], path = "serial_t") {
    const ws = new WebSerial();
    ws.ports = [{ path, displayName: "t", vendorId: 0x0483, productId: 0x5740, port: port as never }];
    install("serial", ws);
    expect(await serial.connect(path)).toBe(true);
    expect(ws.connected).toBe(true);
    return ws;
}

async function connectBle(bt: WebBluetooth, device: BleDevice) {
    bt.devices = [bt.createPort(device)];
    install("bluetooth", bt);
    await serial.connect(`bluetooth_${device.id}`, { baudRate: 115200 });
    expect(bt.connected).toBe(true);
}

const frame = (byte: number) => new Uint8Array([0x24, 0x4d, 0x3c, 0, byte, byte]).buffer;

// ---------------------------------------------------------------------------------------------
// The other tab.
// ---------------------------------------------------------------------------------------------

let otherPages: WriteLease[];

function otherTab(waitMs = 900) {
    const p = createWriteLease(
        {
            locks: () => (navigator as unknown as { locks: never }).locks,
            channel: () => new BroadcastChannel(FC_WRITE_LEASE_CHANNEL) as never,
            now: () => Date.now(),
        },
        { waitMs },
    );
    p.start();
    otherPages.push(p);
    return p;
}

/** The other tab's transaction: "ran" when it got the lease, otherwise its refusal. */
async function otherTransaction(tab: WriteLease): Promise<string[] | "ran"> {
    try {
        return await tab.exclusive(
            async () => "ran" as const,
            (r) => new ApplyBlockedError(r),
        );
    } catch (e) {
        return e instanceof ApplyBlockedError ? e.reasons : [String(e)];
    }
}

beforeEach(async () => {
    saved = slots().map((s) => ({ ...s }));
    otherPages = [];
    FakeWebSocket.made = [];
    MSP.callbacks = [];
    MSP.parked.clear();
    Object.defineProperty(globalThis.navigator, "serial", {
        configurable: true,
        value: { getPorts: async () => [], requestPort: vi.fn(), addEventListener: vi.fn() },
    });
    Object.defineProperty(globalThis.navigator, "bluetooth", {
        configurable: true,
        value: { getAvailability: vi.fn(async () => true), requestDevice: vi.fn(), addEventListener: vi.fn() },
    });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await until(() => writeLease.issues().length === 0);
});

afterEach(async () => {
    vi.useRealTimers();
    for (const socket of FakeWebSocket.made) socket.readyState = FakeWebSocket.CLOSED;
    for (let round = 0; round < 10 && handed.length > 0; round++) {
        for (const done of handed.splice(0)) done.resolve();
        await flush();
    }
    expect(serial.pendingSends).toBe(0);
    for (const p of otherPages) p.stop();
    const live = slots();
    saved.forEach((s, i) => (live[i] = s));
    (serial as unknown as { _protocol: unknown })._protocol = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------

describe("WebSerial: a stuck write counts until its own port's close is proven", () => {
    it("(1) the write hangs and the port closes: the send no longer counts, and the other tab gets the lease", async () => {
        const fake = fakeSerialPort();
        await connectSerial(fake.port);
        const sent = watch(serial.send(frame(1)));
        await flush();
        expect(fake.writes).toHaveLength(1);
        expect(serial.pendingSends).toBe(1);

        expect(await serial.disconnect()).toBe(true);
        expect(fake.port.close).toHaveBeenCalledTimes(1);
        expect(serial.pendingSends).toBe(0);
        // Its delivery stays unknown: it is not reported as "not sent".
        expect(sent.settled).toBe(false);

        expect(await otherTransaction(otherTab())).toBe("ran");
        expect(fake.reader.releaseLock).toHaveBeenCalled(); // close() refuses a locked stream
    });

    it("(2) the write hangs and the close fails: false, the send still counts, the other tab is refused; a later close releases it", async () => {
        const fake = fakeSerialPort();
        await connectSerial(fake.port);
        void serial.send(frame(1));
        await flush();
        fake.closeRejects();

        expect(await serial.disconnect()).toBe(false);
        expect(serial.pendingSends).toBe(1);
        expect(await otherTransaction(otherTab(700))).toEqual([WRITE_LEASE_TIMEOUT]);

        // No new port opens while this one may still send.
        const other = fakeSerialPort();
        (slots().find((s) => s.name === "serial")!.instance as unknown as WebSerial).ports.push({
            path: "serial_u",
            displayName: "u",
            vendorId: 1,
            productId: 1,
            port: other.port as never,
        });
        expect(await serial.connect("serial_u")).toBe(false);
        expect(other.port.open).not.toHaveBeenCalled();
        expect(serial.pendingSends).toBe(1);

        // Closing it again succeeds: now it is proven closed.
        fake.closeResolves();
        expect(await serial.disconnect()).toBe(true);
        expect(serial.pendingSends).toBe(0);
        expect(await otherTransaction(otherTab())).toBe("ran");
    });

    it("(3) two disconnects at once both wait for the one close and get its outcome", async () => {
        const fake = fakeSerialPort();
        await connectSerial(fake.port);
        void serial.send(frame(1));
        await flush();
        const gate = fake.closeWaits();

        const first = watch(serial.disconnect());
        const second = watch(serial.disconnect());
        await wait(120); // well past the teardown's own delay
        expect(fake.port.close).toHaveBeenCalledTimes(1);
        expect(first.settled).toBe(false);
        expect(second.settled).toBe(false);
        expect(serial.pendingSends).toBe(1);

        gate.reject(new Error("close failed"));
        await until(() => first.settled && second.settled);
        expect(first.value).toBe(false);
        expect(second.value).toBe(false);
        expect(serial.pendingSends).toBe(1);
    });

    it("(4) a send waiting behind the stuck one when the link closes never reaches a port, not even the next one", async () => {
        const fake = fakeSerialPort();
        await connectSerial(fake.port);
        void serial.send(frame(1));
        const queued = serial.send(frame(2)); // waits its turn behind the stuck write
        await flush();
        expect(serial.pendingSends).toBe(2);

        expect(await serial.disconnect()).toBe(true);
        expect(serial.pendingSends).toBe(0);
        const next = fakeSerialPort();
        await connectSerial(next.port, "serial_n");

        fake.writes[0].done.resolve(); // the old write returns after all
        expect(await queued).toEqual({ bytesSent: 0 });
        expect(fake.writes).toHaveLength(1);
        expect(next.writes).toHaveLength(0);
    });

    it("(4b) an MSP retry that falls due during the teardown is not handed to the closing port", async () => {
        const fake = fakeSerialPort();
        await connectSerial(fake.port);
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
        try {
            void MSP.promise(105 /* MSP_RC, a read: no lease involved */).catch(() => undefined);
            await vi.advanceTimersByTimeAsync(0);
            expect(fake.writes).toHaveLength(1);
            fake.writes[0].done.resolve();
            await vi.advanceTimersByTimeAsync(0);
            fake.closeWaits();
            void serial.disconnect();
            await vi.advanceTimersByTimeAsync(MSP.TIMEOUT * (MSP.MAX_RETRIES + 1));
            expect(fake.writes).toHaveLength(1);
        } finally {
            MSP.callbacks_cleanup();
            vi.useRealTimers();
        }
    });

    it("(5) a reconnect before the old write returns: the old send's late end changes nothing on the new link", async () => {
        const fake = fakeSerialPort();
        await connectSerial(fake.port);
        const old = serial.send(frame(1));
        await flush();
        expect(await serial.disconnect()).toBe(true);

        const next = fakeSerialPort();
        await connectSerial(next.port, "serial_n");
        void serial.send(frame(3));
        await flush();
        expect(next.writes).toHaveLength(1);
        expect(serial.pendingSends).toBe(1); // only the new link's write

        fake.writes[0].done.resolve();
        expect(await old).toEqual({ bytesSent: 6 });
        expect(serial.pendingSends).toBe(1);
        expect(next.writes).toHaveLength(1);
        next.writes[0].done.resolve();
        await until(() => serial.pendingSends === 0);
    });

    it("(10) the page closes during a write (pagehide → forceClose): the write counts until the close is proven", async () => {
        const fake = fakeSerialPort();
        await connectSerial(fake.port);
        void serial.send(frame(1));
        await flush();
        const gate = fake.closeWaits();

        serial.forceClose();
        await flush();
        expect(serial.pendingSends).toBe(1);
        // A disconnect meanwhile waits for that close and does not claim more.
        const later = watch(serial.disconnect());
        await wait(80);
        expect(later.settled).toBe(false);

        gate.reject(new Error("close failed"));
        await until(() => later.settled);
        expect(later.value).toBe(false);
        expect(serial.pendingSends).toBe(1);
    });

    it("(10b) forceClose whose close succeeds proves the link closed", async () => {
        const fake = fakeSerialPort();
        await connectSerial(fake.port);
        void serial.send(frame(1));
        await flush();
        serial.forceClose();
        await until(() => serial.pendingSends === 0);
        expect(fake.port.close).toHaveBeenCalledTimes(1);
    });
});

describe("WebBluetooth: a write belongs to its own connection; closing is proven by GATT", () => {
    it("(3) a second disconnect waits for the first teardown; nothing is reported closed before GATT is", async () => {
        const fake = fakeBleDevice();
        const bt = new WebBluetooth();
        await connectBle(bt, fake.device);
        void serial.send(frame(1));
        await flush();
        expect(fake.writes).toHaveLength(1);
        const gate = fake.stopWaits();

        const first = watch(serial.disconnect());
        const second = watch(serial.disconnect());
        await flush();
        expect(second.settled).toBe(false);
        expect(fake.gatt.disconnect).not.toHaveBeenCalled();
        expect(serial.pendingSends).toBe(1);

        gate.resolve();
        await until(() => first.settled && second.settled);
        expect([first.value, second.value]).toEqual([true, true]);
        expect(fake.gatt.connected).toBe(false);
        expect(serial.pendingSends).toBe(0);
    });

    it("a write made while the teardown runs is refused (the link is still up during stopNotifications)", async () => {
        const fake = fakeBleDevice();
        const bt = new WebBluetooth();
        await connectBle(bt, fake.device);
        const gate = fake.stopWaits();
        void serial.disconnect();
        await flush();
        expect(fake.gatt.connected).toBe(true);

        const viaFacade = watch(serial.send(frame(7)));
        const direct = watch(bt.send(frame(8)));
        await flush();
        expect(fake.writes).toHaveLength(0);
        expect(viaFacade.value).toEqual({ bytesSent: 0 });
        expect(direct.value).toEqual({ bytesSent: 0 });
        gate.resolve();
    });

    it("(6) a write queued behind a stuck one never goes out on the next connection", async () => {
        const fake = fakeBleDevice();
        const bt = new WebBluetooth();
        await connectBle(bt, fake.device);
        void bt.send(frame(1)); // stuck in writeValue
        const queued = bt.send(frame(2)); // behind it in the adapter's queue
        await flush();
        expect(fake.writes).toHaveLength(1);

        expect(await serial.disconnect()).toBe(true);
        await connectBle(bt, fake.device);
        fake.writes[0].done.resolve(); // the old write returns late
        await flush();

        expect(fake.writes.filter((w) => w.connection === 2)).toHaveLength(0);
        expect(await queued).toEqual({ bytesSent: 0 });
        // The new connection is not blocked by the old stuck queue.
        const fresh = bt.send(frame(3));
        await flush();
        expect(fake.writes.at(-1)).toMatchObject({ connection: 2 });
        fake.writes.at(-1)!.done.resolve();
        expect(await fresh).toEqual({ bytesSent: 6 });
    });

    it("a teardown whose GATT stays connected is a failure, not proof; closing another transport does not clear it", async () => {
        const fake = fakeBleDevice();
        const bt = new WebBluetooth();
        await connectBle(bt, fake.device);
        void serial.send(frame(1));
        await flush();
        fake.disconnectFails();

        expect(await serial.disconnect()).toBe(false);
        expect(bt.link?.state).toBe("CLOSE_FAILED");
        expect(serial.pendingSends).toBe(1);

        // Codex re-check of d0f94598, P1 2: a WebSocket connected and closed afterwards.
        await serial.connect("ws://127.0.0.1:5761");
        FakeWebSocket.made[0].open();
        await serial.disconnect();
        FakeWebSocket.made[0].readyState = FakeWebSocket.CLOSED;
        expect(serial.pendingSends).toBe(1);
        expect(await otherTransaction(otherTab(700))).toEqual([WRITE_LEASE_TIMEOUT]);
    });

    it("a failed teardown is run again by the next disconnect, which then proves the close", async () => {
        const fake = fakeBleDevice();
        const bt = new WebBluetooth();
        await connectBle(bt, fake.device);
        void serial.send(frame(1));
        await flush();
        fake.disconnectFails();
        expect(await serial.disconnect()).toBe(false);
        fake.disconnectWorks();
        expect(await serial.disconnect()).toBe(true);
        expect(serial.pendingSends).toBe(0);
    });

    it("stopNotifications that never answers does not keep the link from closing", async () => {
        const fake = fakeBleDevice();
        const bt = new WebBluetooth();
        await connectBle(bt, fake.device);
        fake.stopNeverAnswers();
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
            const done = watch(serial.disconnect());
            await vi.advanceTimersByTimeAsync(2000);
            await flush();
            expect(done.settled).toBe(true);
            expect(done.value).toBe(true);
            expect(fake.gatt.connected).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("WebSocket: buffered bytes count while a socket can still send them", () => {
    async function connectSocket() {
        install("tcp", new Websocket());
        await serial.connect("ws://127.0.0.1:5761");
        const socket = FakeWebSocket.made.at(-1)!;
        socket.open();
        return socket;
    }

    it("(7) a CLOSED socket with bytes still reported buffered does not count", async () => {
        const socket = await connectSocket();
        socket.bufferedAmount = 12;
        expect(serial.pendingSends).toBe(1);
        socket.readyState = FakeWebSocket.CLOSED;
        expect(serial.pendingSends).toBe(0);
        expect(await otherTransaction(otherTab())).toBe("ran");
    });

    it("(8) a CLOSING socket with buffered bytes counts, also after a reconnect superseded it", async () => {
        const socket = await connectSocket();
        socket.bufferedAmount = 12;
        await serial.disconnect();
        expect(socket.readyState).toBe(FakeWebSocket.CLOSING);
        expect(serial.pendingSends).toBe(1);

        await serial.connect("ws://127.0.0.1:5761");
        FakeWebSocket.made.at(-1)!.open();
        expect(serial.pendingSends).toBe(1);
        expect(await otherTransaction(otherTab(700))).toEqual([WRITE_LEASE_TIMEOUT]);

        socket.readyState = FakeWebSocket.CLOSED;
        expect(serial.pendingSends).toBe(0);
    });

    it("an OPEN socket's buffer counts, and a socket in a state this code does not know counts too", async () => {
        const socket = await connectSocket();
        socket.bufferedAmount = 3;
        expect(serial.pendingSends).toBe(1);
        socket.readyState = 7;
        expect(serial.pendingSends).toBe(1);
        socket.bufferedAmount = 0;
        expect(serial.pendingSends).toBe(0);
    });

    it("a buffering WebSocket counts after the facade switched to another transport", async () => {
        const socket = await connectSocket();
        socket.bufferedAmount = 5;
        socket.readyState = FakeWebSocket.CLOSING;
        const fake = fakeSerialPort();
        await connectSerial(fake.port);
        expect(serial.pendingSends).toBe(1);
    });
});

describe("two tabs: the lease is yielded only after proven quiescence", () => {
    it("(9) while this tab's write is stuck on an open link the other tab's transaction is refused; once it ends, it runs", async () => {
        const fake = fakeSerialPort();
        await connectSerial(fake.port);
        void serial.send(frame(1));
        await flush();
        const tab = otherTab(700);
        expect(await otherTransaction(tab)).toEqual([WRITE_LEASE_TIMEOUT]);
        fake.writes[0].done.resolve();
        expect(await otherTransaction(tab)).toBe("ran");
    });

    it("(11) the other tab asks while the port is still closing: refused; after the close is proven: granted", async () => {
        const fake = fakeSerialPort();
        await connectSerial(fake.port);
        void serial.send(frame(1));
        await flush();
        const gate = fake.closeWaits();
        const closing = serial.disconnect();

        const tab = otherTab(700);
        expect(await otherTransaction(tab)).toEqual([WRITE_LEASE_TIMEOUT]);
        expect(serial.pendingSends).toBe(1);

        gate.resolve();
        expect(await closing).toBe(true);
        expect(await otherTransaction(tab)).toBe("ran");
    });

    it("(11b) while the other tab's transaction runs after the yield, this tab's stuck old write cannot be resumed", async () => {
        const fake = fakeSerialPort();
        await connectSerial(fake.port);
        void serial.send(frame(1));
        const behind = serial.send(frame(2));
        await flush();
        expect(await serial.disconnect()).toBe(true);
        const tab = otherTab();
        let during = -1;
        const result = await tab.exclusive(
            async () => {
                fake.writes[0].done.resolve();
                await behind;
                during = fake.writes.length;
                return "ran";
            },
            (r) => new ApplyBlockedError(r),
        );
        expect(result).toBe("ran");
        expect(during).toBe(1);
    });
});
