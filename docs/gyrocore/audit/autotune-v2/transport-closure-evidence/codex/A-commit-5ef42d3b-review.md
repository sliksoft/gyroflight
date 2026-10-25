**REQUEST_CHANGES: two P1 safety defects remain.** Inspected HEAD `5ef42d3b6806636efeceee66531296b7a97e0a9c` against parent `6d295c31554b9240955ac6b125d6e95a17022a54`, including the changed tests and lease/MSP/CLI callers. Findings below are source-derived reproducers; I ran no tests, hardware operations, or network requests.

1. **P1 — Bluetooth’s synchronous disconnect flag is insufficient closure proof.**  
   `src/js/protocols/WebBluetooth.ts:590–596`, `:614`; consumed by `src/js/serial.ts:461`.

   **Scenario:** A write remains pending in `writeValue()`. Its MSP request has exhausted, leaving the transport send as the remaining busy reason. Disconnect finishes—or times out—`stopNotifications()`, calls `gatt.disconnect()`, sees `gatt.connected === false`, and marks the link `CLOSED_CONFIRMED`. `pendingSends` then ignores the unfinished write, allowing the lease to yield.

   **Safety effect:** As I understand the Web Bluetooth specification, `disconnect()` clears the script-visible connection state synchronously while disconnect work proceeds asynchronously. That flag is not an acknowledgement that an already submitted platform write has been flushed or prevented from reaching the peripheral. Aborting/rejecting an outstanding API operation also does not undo bytes already submitted. The code therefore substitutes a logical state change for the invariant’s required transport-quiescence proof.

   This concerns this page’s pending operation; it does not depend on another program or device keeping the connection alive.

   **Would tests catch it?** No. `test/gyrocore/wp8_transport_closure.test.ts:190–192` models disconnect by clearing the flag, without a separately controlled platform-disconnection/write-completion phase. Lines `520–524` then expect the pending send to disappear. Browser scenarios 7/8 do not exercise Bluetooth. The specification assessment was not refreshed online, respecting the network prohibition.

2. **P1 — A half-completed Bluetooth reconnect can close the wrong link record.**  
   `src/js/protocols/WebBluetooth.ts:355`, `:368`, `:556`, `:561–614`.

   **Scenario:**

   - Connect Bluetooth device A and leave an admitted write pending in A’s `writeValue()`.
   - Start `serial.connect()` to Bluetooth device B; hold B’s `gatt.connect()` pending.
   - `connect()` has already assigned `this.device = B`, but `this.link`, characteristics, and `this.connected` still describe A. There is no established-connection rejection in Bluetooth `connect()` or the facade.
   - Call `serial.disconnect()`. Because `this.connected` remains true, it bypasses the cancel-in-flight-open branch.
   - Teardown captures A’s link, but checks B’s disconnected GATT server. It never disconnects A and nevertheless calls `link.closed()`.

   **Safety effect:** A’s pending send stops counting while A’s GATT connection remains connected and its write can still complete. Once the other busy reasons are absent, another same-origin tab can obtain the exclusive lease. This reproducer does not require any disputed specification interpretation: the adapter inspects one device and closes another device’s link record.

   **Would tests catch it?** No. The added tests await each connection before continuing and do not interleave a second Bluetooth connection attempt with an established connection’s pending write and teardown. Connection identity must bind the device, characteristics, queue, and closure evidence throughout setup and teardown.

The earlier reproducers assess as follows:

| Reproducer | Source-review result |
|---|---|
| **R1: generation advance during Bluetooth teardown** | The specific generation-accounting bug is addressed: handed sends retain their original link and count during `stopNotifications()`. **The end-to-end safety requirement remains open**, because finding 1 permits release immediately afterward without sufficient closure proof. |
| **R2: second disconnect returns early true** | Addressed for established-connection teardown: WebSerial joins `#closing`; Bluetooth joins `_teardown`. Bluetooth’s in-flight-open branch still returns true for cancellation acceptance, but that return alone no longer marks a link closed. |
| **R3: swallowed WebSerial close rejection** | Addressed: `WebSerial.ts:507–529` retains the port, marks `CLOSE_FAILED`, and returns false. Reconnect retries closure before opening another port. |
| **R4: another transport’s close erases Bluetooth pending work** | The exact Bluetooth→WebSocket reproducer is addressed: pending sends retain their own link; a socket close cannot close that record. Finding 2 is a separate same-adapter identity failure. |
| **R5: closed WebSocket buffer / stuck send after reconnect** | The exact accounting failures are addressed: CLOSED sockets are excluded, CLOSING and superseded sockets remain counted, and unfinished sends on confirmed-closed links are excluded. Bluetooth’s confirmation remains defective as described above. |

Additional inspection conclusions:

- **WebSerial closure:** Unlike Bluetooth’s Boolean check, successful `port.close()` provides an asynchronous completion boundary under the Web Serial abort/close contract as I understand it. Normal teardown and `forceClose()` mark closure only after that promise resolves; failed closure remains unconfirmed. This is source/specification reasoning, not observed browser evidence.
- **Queues and retries:** WebSerial generations and captured batch writers prevent ordinary old batches from continuing on a later connection. Bluetooth captures the characteristic and checks link identity before dispatching queued writes. The facade’s link check precedes `stillWanted`, so refusing a closing link does not increment MSP’s wire-send accounting. I found no additional concrete retry defect in those inspected paths.
- **Uncertainty:** Excluding a pending send from the busy count does not itself settle its promise or declare it “not sent.” The changed accounting does not itself clear transaction uncertainty.

**Test assessment:** `wp8_transport_closure.test.ts` uses production adapters and the facade over fake browser objects, with a second lease instance. Browser scenario 7 drives production WebSerial/facade code over a fake port; scenario 8 drives production WebSocket/facade code over a fake socket. These are meaningful adapter integration tests, but not validation of actual browser transport cancellation.

By source comparison, browser scenario 7 would detect the parent’s swallowed close failure and persistent pending count after successful close; scenario 8 would detect its persistent CLOSED-socket buffer count. I did not reproduce those failures or verify the commit message’s numerical test claims.

The changes to `webbluetooth.test.ts`, `serial_send_callback.test.ts`, and `wp8_final_acceptance_transport.test.ts` remove no assertions; they update fixtures for the new connection/link requirements. However, making the Bluetooth fake clear `connected` supplies logical-state behavior, not evidence that physical writes have become quiescent.

No additional concrete P0 or P2 is reported; there are consequently no P2 acceptance blockers to classify. Tauri and Capacitor remain separate **NOT_VALIDATED** scopes. This review establishes no protection against external programs, other browsers, or devices.

P0_OPEN=0
P1_OPEN=2
P2_OPEN=0
REVIEW_COMPLETED=YES
VERDICT=REQUEST_CHANGES