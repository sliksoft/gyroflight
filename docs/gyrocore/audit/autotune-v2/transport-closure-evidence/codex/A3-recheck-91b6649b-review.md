**REQUEST_CHANGES.** One P1 safety defect and two P2 availability defects remain.

Reviewed detached HEAD `91b6649b417095679ab514a1af05a487cf4e46ff`. The requested log contains `5ef42d3b`, `2fd5983e`, `d070d344`, and `91b6649b`. Evidence is source, diff, and test inspection only. No tests, network access, hardware operations, modifications, or agents were used.

1. **P1 — Kept-link reboot cleanup forgets unanswered writes without closing their connection.**

   **Locations:** `src/js/msp.ts:1056`; restored reuse at `src/js/protocols/WebBluetooth.ts:381`; callers at `src/js/serial_backend.ts:385`, `:626`, and `:1703`.

   **Reproducer:** Save A transmits EEPROM twice because of a retry; receive one ACK and retain the other unanswered transmission. Enter the BLE kept-link reboot flow. `softResetForReboot()` calls `resetAppConnectionState()` → `teardownConnectionUi()` → `MSP.disconnect_cleanup()`, which clears the transmission history although GATT remains open. The reconnect loop clears it again before reusing that connection. After the handshake, transmit save B and deliver A’s delayed EEPROM ACK before B’s actual answer.

   B encounters no retained older transmission, so `_note_transmission()` does not mark it ambiguous. The delayed ACK can therefore resolve B as saved.

   **Safety effect:** Persistence can be reported confirmed without an answer attributable to the current save. Restoring the kept-link reconnect makes this path usable again; the claimed “retain until link closure” invariant is incomplete.

   **Tests:** Not caught by the inspected additions. The BLE reuse test at `test/gyrocore/wp8_transport_closure.test.ts:696` does not exercise backend cleanup or EEPROM history. The control at `test/gyrocore/wp8_repair_integration.test.ts:228` directly calls `disconnect_cleanup()` and assumes that means closure, without establishing transport closure. A regression test must retain a delayed ACK across the actual kept-link reset/reconnect path.

2. **P2 — A cancelled open that rejects leaves cancellation armed for the next connection.**

   **Locations:** `src/js/protocols/WebSerial.ts:448`, `:466`, and `:397`.

   **Reproducer:** Hold `port.open()` pending, call `disconnect()`, then reject the open. The caught opening promise settles and teardown returns `true` through the no-port branch at line 466. That return bypasses the `finally` which clears `openCanceled`.

   Attempt another connection and let its open succeed. `connect()` does not reset `openCanceled`, so it takes the cancelled branch, reports `connect:false`, and retains the opened port and stream locks. That branch now relies on a cancelling disconnect to close it, but the previous disconnect has already completed.

   **Effect:** A valid retry is rejected and leaves a port open behind a disconnected state until further cleanup. This is an **availability defect that blocks acceptance**, because recovery after a failed cancelled open is part of the repair’s lifecycle contract.

   **Tests:** Not caught. Both new pending-open tests (`wp8_transport_closure.test.ts:493` and `:517`) resolve the open successfully; neither rejects it and then reconnects. The `forceClose()` pending-open branch shares the stale-flag problem.

3. **P2 — Pending-open cancellation is not serialized against a new connect.**

   **Locations:** `src/js/protocols/WebSerial.ts:330`, `:357`, and `:450`.

   **Reproducer:** Start opening port A, cancel it with `disconnect()`, and start opening port B before A settles. Cancellation has not populated `#closing`, so B passes the connect guard and overwrites `#opening`.

   Resolve B first: it installs B’s port, link, reader, and writer, then returns cancelled. Resolve A next: it overwrites those instance references with A’s. The original disconnect subsequently closes A and returns `true`, while B remains open with its stream locks and no retained transport reference.

   The cancellation promise also leaves a 150-ms interval after open completion before publishing a teardown. Another disconnect/reconnect can enter during that interval, allowing the delayed close to target a successor connection.

   **Effect:** Cancellation can orphan an open port or tear down a replacement connection. This is an **availability defect that blocks acceptance**. This reproducer does not establish an unsafe write.

   **Tests:** Not caught. The new tests await the cancelled connection’s teardown before attempting subsequent use. Existing reconnect tests begin from an established connection, where `#closing` already provides serialization.

The four original reproducers have these inspection results:

- **CRC-invalid frame consuming history:** Closed by the guard at `MSPHelper.ts:456`. CRC-invalid frames still reject applicable waiters, but no longer consume unanswered transmission history. Reverting that guard would make the new CRC regression test fail: B could become saved after the injected late ACK.
- **Own transaction starting over its outstanding send:** Closed by `fcWriteLease.ts:248`. The transaction waits for the registered busy probe before invoking its callback. With an advancing clock and scheduled timers, it refuses after the remaining eight-second lease budget; a permanently outstanding send cannot make this pre-transaction wait indefinite. I found no circular dependency in the inspected production callers. Reverting the loop would fail both the new timeout test and the acceptance test’s early `ran === false` assertion.
- **BLE kept-link reconnect refusal:** The normal reproducer is closed: same-path reuse emits success without creating a new GATT connection or replacing its link. A different requested device path is still refused. The inspected stable-connection path does not select a different live link. The backend history-reset defect above nevertheless prevents accepting the restored flow as safe. Reverting the reuse branch would fail the new success-event assertion.
- **WebSerial open resurrection after disconnect/forceClose:** Closed for the isolated, successfully resolving open covered by the new tests. Reverting the respective pending-open branches would fail those tests. Rejected opens and overlapping reconnects remain defective as described above.

The changed test in `test/gyrocore/wp8_final_acceptance_transport.test.ts:447` is **stricter on the safety behavior**: it now requires the transaction to wait, rejects another foreign write during that wait, and requires the queued SET never to reach the transport. Replacing the exact wire-array assertion permits read retries, but retains the relevant read ordering and strengthens SET exclusion. These are mutation predictions from inspection, not observed test results.

The additional range review covered send accounting, transport-specific closure evidence, BLE write settlement and characteristic capture, WebSerial teardown, WebSocket buffering across superseded sockets, and MSP answer retention. No additional concrete P0 was established.

Runtime and physical behavior remain unvalidated. **Tauri and Capacitor: NOT_VALIDATED, separate scope.** This review makes no protection claim concerning external programs, other browsers, or other devices.

P0_OPEN=0
P1_OPEN=1
P2_OPEN=2
REVIEW_COMPLETED=YES
VERDICT=REQUEST_CHANGES