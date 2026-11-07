**One P1 remains: generation changes can hide a send before its transport connection closes.** The original P2 is addressed for an actually closed connection, but the change reopens the F02 exclusion boundary during teardown.

**P1 — Disconnect entry prematurely removes an outstanding transport send from the busy count.**  
Anchor: `src/js/serial.ts:419`, together with `src/js/serial.ts:355–359`.

`disconnect()` increments `#sendGeneration` **before awaiting transport disconnection**. The changed getter immediately ignores every send belonging to the preceding generation, even while that transport can still deliver bytes.

Reproducible scenario from inspected production code:

1. Page A has a write pending inside WebBluetooth’s `writeCharacteristic.writeValue()` (`src/js/protocols/WebBluetooth.ts:618`).
2. A disconnect begins. The facade changes generation; `pendingSends` becomes zero.
3. Bluetooth teardown awaits `stopNotifications()` **before** calling `gatt.disconnect()` (`src/js/protocols/WebBluetooth.ts:539–547`). Delay that notification operation: the physical connection remains open and the outstanding write remains with the transport.
4. Disconnect UI cleanup clears MSP/CLI waiters (`src/js/serial_backend.ts:626`, called at `:692`). With no save active and the 300-ms quiet interval satisfied, another same-origin tab’s yield request sees no busy condition (`src/js/msp.ts:1280–1286`).
5. The shared lease is released (`src/composables/fcWriteLease.ts:157–175`), allowing the other tab’s exclusive transaction while A’s transport write can still complete.

**Safety effect:** a previously authorized write can overlap another participating tab’s transaction, invalidating its exclusive read/check/write assumptions. Changing a generation number does not establish transport closure. WebSerial has the same early-discount window: disconnection waits 50 ms and cancels its reader before releasing the writer and closing the port (`src/js/protocols/WebSerial.ts:438–467`).

**Existing tests do not catch this.** The new test’s fake transport has **no `disconnect()` method** (`test/gyrocore/wp8_repair_round3.test.ts:162–165`). The facade catches that failure, yet the test proceeds and expects zero. Its subsequent `connect("x")` selects a registered transport rather than the assigned fake, and successful connection is never asserted. Consequently, the test passes without establishing either closure or a successful replacement connection. It exercises the counter change while missing the safety prerequisite.

The repair needs to distinguish invalidating queued work from proving that an in-flight transport write can no longer arrive. Add independent coverage for delayed/failed teardown while a write remains outstanding.

Other requested conclusions:

- **Original closed-link P2:** addressed by inspection. After genuine closure and reconnect, an unfinished old send no longer contributes to the current count.
- **Late old completion:** cannot decrement the current generation’s count. Increment and `finally` both use the captured generation (`src/js/serial.ts:378,399–403`).
- **Stable current connection:** queued and in-flight sends remain counted until their transport promise settles. WebSocket buffering remains included. The defect above concerns advancing generation before closure.
- **Revert sensitivity:** retaining the new test while reverting the production fix would make its final assertion fail: the never-settling send leaves the old global counter at one. This is a source-derived conclusion, **not an executed mutation result**.
- **8ccea0ee is test-only:** its complete diff adds 24 lines solely to `test/gyrocore/wp8_repair_integration.test.ts`.

Reviewed HEAD `b3ca2c6a` and both commits after `be798ce4`. No tests, network, hardware actions, edits, or agents were used. Tauri: **NOT_VALIDATED**. No protection against external programs, other browsers, or devices is claimed.

P0_OPEN=0
P1_OPEN=1
P2_OPEN=0
REVIEW_COMPLETED=YES
VERDICT=REQUEST_CHANGES

