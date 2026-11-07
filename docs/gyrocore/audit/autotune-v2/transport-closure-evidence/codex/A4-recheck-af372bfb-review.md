ORIGINAL_P2=CLOSED — By code inspection, the original availability defect is closed for WebSerial, WebBluetooth and WebSocket in the web build, subject to the documented unsettled-BLE-write boundary.

**P2 — A stale send callback can disconnect a successor connection.**

- **Locations:** `src/js/serial.ts:436`; `src/js/utils/AutoBackup.ts:382`; `src/js/utils/AutoBackup.ts:190`.
- **Reproducer:** Hold a WebSerial send unresolved and queue AutoBackup’s `exit` behind it. Close that port successfully, reconnect, then settle the old send—the same late-settlement model exercised by the new closure tests. The queued exit is rejected by the facade’s generation check and sends zero bytes, but its callback still runs unconditionally. AutoBackup’s callback ignores the result and calls `serial.disconnect()`, closing the successor connection.
- **Effect:** **Availability defect that blocks acceptance.** Old work can act on a new connection after closure proof and lease release. This violates the requested callback invariant and can interrupt a subsequent operation.
- **Failure mode:** **Open:** stale callback dispatch after release; successor connection disconnected.
- **Introduction:** **Pre-existing since `6d295c31`**, where the unconditional callback already exists. `5ef42d3b` permits proven-closed sends to stop blocking the lease before their eventual callback completes; it does not invalidate that callback.
- **Tests:** The inspected tests would **not catch this**. `test/gyrocore/wp8_transport_closure.test.ts:471` reconnects and settles an old send, but supplies no callback and checks only send counts/results. Add the AutoBackup callback to that sequence and assert that the successor remains connected.

The three previously reported defects are closed for their stated reproducers **by source inspection**:

- **Kept BLE link loses unanswered-write history:** `src/js/msp.ts:1059` now retains history while `serial.connected` remains true. The regression at `test/gyrocore/wp8_repair_integration.test.ts:230` performs cleanup twice on the kept connection, delivers the earlier ACK during the later save, and requires an unknown outcome. Reverting the production guard would let that ACK confirm the later save, contradicting the assertion.
- **Rejected cancelled WebSerial open poisons the next connect:** `src/js/protocols/WebSerial.ts:346` resets cancellation for a new attempt, and the no-port teardown clears it. The regression at `test/gyrocore/wp8_transport_closure.test.ts:517` rejects the cancelled open and requires the next connection to succeed. Reverting the repair restores the poisoned-next-open path.
- **Cancelled WebSerial open overlaps a successor:** `src/js/protocols/WebSerial.ts:331` waits for opening/closing work; cancellation publishes its teardown before returning. The regression at `test/gyrocore/wp8_transport_closure.test.ts:537` requires the successor not to open until cancellation finishes and checks which port remains held. Reverting the repair violates those assertions. The `forceClose` cancellation path uses the same ownership approach, although this new concurrent-successor regression exercises `disconnect()`.

These are predicted revert failures from tracing the code and assertions; **I ran no tests or revert experiments**.

The final adversarial pass found that pending facade sends retain their own link, failed closure remains busy, queued sends have generation checks, BLE closure requires both GATT-down and settled writes, and WebSocket buffering includes superseded sockets until CLOSED. Own-transaction admission waits for its sends. The apparent competing-transaction race is prevented by the outer `FC_WRITE_LOCK` in `src/composables/fcWriteGuard.ts:404`. Those protections do not close the callback finding above.

`git log --oneline 6d295c31..HEAD` confirmed the six requested commits: `5ef42d3b`, `2fd5983e`, `d070d344`, `91b6649b`, `02eef1f3`, `af372bfb`. HEAD is detached at `af372bfb`; that last commit changes only the EEPROM message.

This is a source/history review, with no execution or hardware evidence. Tauri and Capacitor remain **NOT_VALIDATED**. Conclusions cover cooperating tabs of one browser origin only.

P0_OPEN=0
P1_OPEN=0
P2_OPEN=1
REVIEW_COMPLETED=YES
VERDICT=REQUEST_CHANGES

