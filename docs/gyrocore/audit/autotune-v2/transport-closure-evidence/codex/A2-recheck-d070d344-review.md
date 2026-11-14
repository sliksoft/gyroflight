**REQUEST_CHANGES.** HEAD is `d070d344b0ce53113e3d8e0bcd605740f194e74a`; inspected range: `6d295c31..d070d344`. This is source and test inspection only. I ran no tests, hardware actions, network operations, or agents.

The three original reproducers are addressed locally, but the broader safety invariant still has two gaps. I also found one new BLE availability regression and one pre-existing cancellation defect.

1. **P1 — A CRC-invalid frame can erase unanswered-write history and restore false “saved”.**

   **Anchors:** `src/js/msp/MSPHelper.ts:425`, `src/js/msp/MSPHelper.ts:454`, `src/js/msp.ts:984`.

   `decodeFrame()` returns `true` for CRC errors, so `settleCallbacks()` still calls `_note_answer(code)`. That consumes the oldest unanswered transmission even though the corrupted frame’s code cannot be trusted.

   **Reproducer:** Extend `saveAWithRetryOneAnswered()` from the integration tests:
   - A transmits twice; acknowledge its first transmission, leaving its retry unanswered.
   - While no EEPROM callback remains, feed a CRC-invalid frame identifying code `MSP_EEPROM_WRITE`, for example bytes `24 4d 3e 00 fa 00`.
   - Start save B and hold its transport write pending.
   - Deliver A’s genuine delayed retry ACK.

   The invalid frame removed A’s remaining history. B therefore starts without `ambiguous`, and A’s late ACK can resolve B as saved while B’s write remains pending.

   **Safety effect:** False EEPROM persistence confirmation.

   **Tests:** The new long-silence tests omit invalid intervening frames and would not catch this scenario. Add an independent malformed-frame/history-retention case. This is an inherited integration defect that the retention repair leaves open, not a new regression introduced by `d070d344`.

2. **P1 — Starting a transaction bypasses this page’s own transport busy probe.**

   **Anchors:** `src/composables/fcWriteLease.ts:237`, `src/composables/fcWriteGuard.ts:408`, `src/js/msp.ts:1277`.

   Incoming yield requests use `quiet()`, which consults `serial.pendingSends`. However, `exclusive()` unconditionally releases this page’s shared lease before requesting exclusive ownership; it never checks its own busy probe.

   **Reproducer:** In one page, hand an ordinary write to BLE and leave `writeValue()` pending. Make teardown fail with GATT still connected. Switch the facade to a WebSocket connection to the same craft. The old BLE send correctly remains counted. Now invoke that page’s `withFcWriteLock()` through a Gyroflight transaction or read-only transaction check.

   The page releases its shared lease and can enter the exclusive callback while the old BLE write remains capable of reaching the craft. WebSocket reads and writes use the new facade queue, so they need not wait for that old BLE operation.

   **Safety effect:** A prior write can land during the transaction’s read/check/write sequence despite exclusive ownership.

   **Tests:** The closure tests request exclusivity from `otherTab()`. They do not request it from the busy page itself. They therefore miss this bypass. This is a pre-existing lease dependency defect left outside the transport repair.

3. **P2 — The new BLE connection refusal breaks the deliberate keep-link reboot path.**

   **Anchors:** `src/js/protocols/WebBluetooth.ts:379`, `src/js/serial_backend.ts:414`, `src/js/serial_backend.ts:1708`.

   **Reproducer:** Connect over BLE, enable Auto-Connect, then Save and Reboot while GATT survives the MCU reboot. `softResetForReboot()` deliberately keeps the adapter connected and resets application state. The retry loop calls `serial.connect()` to re-handshake. The new `this.connected` guard emits `connect:false`, so the backend aborts instead of starting the handshake over the retained link.

   **Effect:** Automatic recovery over the intentionally retained BLE link fails. The code may subsequently drop that link, defeating the existing recovery strategy.

   **Classification:** **Availability defect; blocks acceptance** of the required BLE keep-link reboot behavior. Introduced by `d070d344`.

   **Tests:** The new connection-refusal test expects refusal over an established connection without exercising retained-link recovery. The backend reboot test at `test/js/serial_backend.test.ts:700` mocks `serial.connect()` and merely checks that it was called; it cannot detect the adapter’s new refusal.

4. **P2 — WebSerial can report successful disconnect during an open, then resurrect the cancelled connection.**

   **Anchors:** `src/js/protocols/WebSerial.ts:354`, `src/js/protocols/WebSerial.ts:368`, `src/js/protocols/WebSerial.ts:456`.

   **Reproducer:** Hold `port.open()` pending. Call and await `serial.disconnect()`. Because `this.port` is assigned only after `open()` resolves, teardown sees no port and returns `true`. It neither sets `openCanceled` nor invalidates the connect coroutine. Resolve `open()` afterward: the coroutine installs the port, marks itself connected, and emits a successful connection event.

   `forceClose()` also returns early when the pending open has not yet installed a port.

   **Effect:** Cancellation or pagehide cleanup does not prevent a late open from establishing a session.

   **Classification:** **Availability/lifecycle defect; blocks acceptance** of cancel-in-flight-open behavior. Pre-existing behavior, still present in the reviewed transport path.

   **Tests:** The new closure suite starts WebSerial from completed connections. Its fake `open()` resolves immediately, so it misses this ordering.

**Original repair checks**

- **P1-A:** The established-link reproducer is closed in inspected code: `GattLink` requires GATT-down **and** zero outstanding `writeValue()` calls. Timeout returns `false`; the old facade send remains busy. The new test at `wp8_transport_closure.test.ts:604` should fail if that behavioral fix is reverted.
- **P1-B:** Connecting B over an already established A is refused before replacing A’s device/link. The test at line 627 should fail if that guard is reverted. The guard also causes finding 3.
- **Four-second MSP expiry:** Removed. The two 60-second tests at `wp8_repair_integration.test.ts:169` and `:191` should fail if expiry is restored. Finding 1 demonstrates another way to lose the history.

These are static mutation predictions, not executed revert-test results.

**Remaining coverage**

WebSerial’s normal teardown retains failed closes and confirms closure only after `port.close()` resolves. Its `forceClose()` follows the same confirmation rule for an installed port. BLE queues capture their characteristic/link and reject continuation on a replaced or closing link. WebSocket accounting includes superseded CLOSING sockets and stops counting CLOSED sockets. Those local mechanisms do not cure finding 2.

Unsolicited disconnect handlers route through teardown; BLE cancellation during setup returns acceptance before closure completes. The added tests use fake platform objects, and the browser additions also substitute transport objects. None establishes physical closure behavior.

Tauri and Capacitor: **NOT_VALIDATED**, separate scope. No protection is claimed against external programs, other browsers, or other devices.

P0_OPEN=0
P1_OPEN=2
P2_OPEN=2
REVIEW_COMPLETED=YES
VERDICT=REQUEST_CHANGES