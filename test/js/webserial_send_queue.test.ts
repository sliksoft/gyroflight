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
 * Audit WP8-F03: the production WebSerial adapter in its AT32/macOS batch mode (63-byte chunks)
 * against a writable stream whose writes this test completes by hand. A logical send is one MSP
 * frame or one CLI line; another send must never land between its chunks, sends reach the port in
 * the order they were made, and a send that only partly went out says so (bytesSent).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/js/protocols/devices", () => ({
    webSerialDevices: [],
    vendorIdNames: { 0x2e3c: "AT32", 0x10c4: "CP210" },
}));
vi.mock("../../src/stores/appInfo", () => ({
    useAppInfoStore: () => ({ operatingSystem: "MacOS" }),
}));

interface PendingWrite {
    bytes: number[];
    resolve: () => void;
    reject: (e: Error) => void;
}

function fakePort(vendorId: number) {
    const writes: PendingWrite[] = [];
    const writer = {
        write: vi.fn(
            (chunk: Uint8Array | ArrayBuffer) =>
                new Promise<void>((resolve, reject) => {
                    writes.push({ bytes: Array.from(new Uint8Array(chunk as ArrayBuffer)), resolve, reject });
                }),
        ),
        releaseLock: vi.fn(),
    };
    const port = {
        getInfo: () => ({ usbVendorId: vendorId, usbProductId: 0x5740 }),
        open: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        readable: {
            getReader: () => ({ read: () => new Promise(() => {}), cancel: vi.fn(), releaseLock: vi.fn() }),
        },
        writable: { getWriter: () => writer },
    };
    return { port, writer, writes };
}

const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
};

/** Completes every write the port has been handed, in order, until nothing is pending. */
async function drain(writes: PendingWrite[], done: Set<PendingWrite>) {
    for (let guard = 0; guard < 50; guard++) {
        await flush();
        const next = writes.find((w) => !done.has(w));
        if (!next) return;
        done.add(next);
        next.resolve();
    }
}

const frame = (fill: number, length: number) => new Uint8Array(length).fill(fill);

beforeEach(() => {
    Object.defineProperty(globalThis.navigator, "serial", {
        configurable: true,
        value: {
            getPorts: vi.fn(async () => []),
            requestPort: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        },
    });
});

afterEach(() => {
    vi.resetModules();
});

async function connected(vendorId = 0x2e3c) {
    const WebSerial = (await import("../../src/js/protocols/WebSerial")).default;
    const ws = new WebSerial();
    const fake = fakePort(vendorId);
    ws.ports = [{ path: "serial_1", displayName: "AT32", port: fake.port } as never];
    expect(await ws.connect("serial_1", { baudRate: 115200 })).toBe(true);
    return { ws, ...fake };
}

describe("WP8-F03 WebSerial: whole logical sends", () => {
    it("selects batch mode for AT32 on macOS (the mode under test)", async () => {
        const { ws } = await connected();
        expect(ws.isNeedBatchWrite).toBe(true);
    });

    it("never puts another send between the chunks of a frame longer than 63 bytes, and keeps FIFO order", async () => {
        const { ws, writes } = await connected();
        const done = new Set<PendingWrite>();
        const a = ws.send(frame(0xaa, 100));
        const b = ws.send(frame(0xbb, 10));
        const c = ws.send(frame(0xcc, 70));
        await drain(writes, done);
        expect(await a).toEqual({ bytesSent: 100 });
        expect(await b).toEqual({ bytesSent: 10 });
        expect(await c).toEqual({ bytesSent: 70 });
        const wire = writes.flatMap((w) => w.bytes);
        expect(wire).toEqual([...frame(0xaa, 100), ...frame(0xbb, 10), ...frame(0xcc, 70)]);
        // Chunks of one send are contiguous: each chunk holds one fill byte only and the sequence of
        // fills never returns to an earlier send.
        const fills = writes.map((w) => w.bytes[0]);
        expect(fills).toEqual([0xaa, 0xaa, 0xbb, 0xcc, 0xcc]);
        expect(writes.every((w) => w.bytes.length <= 63)).toBe(true);
    });

    it("reports the bytes that went out when the port fails in the middle of a frame (partial send)", async () => {
        const { ws, writes } = await connected();
        const a = ws.send(frame(0xaa, 100));
        await flush();
        writes[0].resolve();
        await flush();
        writes[1].reject(new Error("device lost"));
        expect(await a).toEqual({ bytesSent: 63 });
    });

    it("sends nothing for a queued send once the port was disconnected, and reports 0 bytes", async () => {
        const { ws, writes } = await connected();
        const a = ws.send(frame(0xaa, 100));
        const b = ws.send(frame(0xbb, 10));
        await flush();
        expect(writes).toHaveLength(1);
        const closing = ws.disconnect();
        writes[0].reject(new Error("released"));
        await closing;
        expect((await a).bytesSent).toBeLessThan(100);
        expect(await b).toEqual({ bytesSent: 0 });
        expect(writes.flatMap((w) => w.bytes).includes(0xbb)).toBe(false);
    });

    it("keeps FIFO order outside batch mode too", async () => {
        const { ws, writes } = await connected(0x10c4);
        expect(ws.isNeedBatchWrite).toBe(false);
        const done = new Set<PendingWrite>();
        const a = ws.send(frame(0x11, 200));
        const b = ws.send(frame(0x22, 5));
        await drain(writes, done);
        expect(await a).toEqual({ bytesSent: 200 });
        expect(await b).toEqual({ bytesSent: 5 });
        expect(writes.map((w) => w.bytes[0])).toEqual([0x11, 0x22]);
    });
});
