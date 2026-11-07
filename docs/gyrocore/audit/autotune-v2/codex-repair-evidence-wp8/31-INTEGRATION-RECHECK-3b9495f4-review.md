**REQUEST_CHANGES — R1 remains open; R2 retains a cleanup hang.** Reviewed production source and tests at HEAD `3b9495f469916b6dac0c0198afc292a86f06a49c`, including both requested commits against `00eb8488`. No tests, hardware, network access, modifications, or agents were used.

1. **P1 — R1: live queue cleanup erases the evidence needed to reject an ambiguous ACK.**  
   **Anchor:** `src/js/msp.ts:1034`; production caller: `src/js/tab_adapters.ts:45`.

   Reproducible sequence, entirely within four seconds:

   - Save A transmits twice after a retry. One ACK arrives and resolves A; its other transmission remains unanswered.
   - A tab switch invokes `callbacks_cleanup()`. This clears `write_transmissions` while retaining the live connection.
   - Change RAM settings and initiate save B. B reaches the transport, but its frame is lost or cut before the FC executes it.
   - Deliver A’s delayed second ACK.

   B is no longer `awaitingWire`, and the erased history means `_note_transmission()` never marked it ambiguous. `settleCallbacks()` therefore resolves B; `saveEeprom()` reports success although B’s settings were not persisted.

   **Safety effect:** the original false-success defect remains reachable through an ordinary production cleanup route. The same bookkeeping loss affects consecutive RXFAIL writes across cleanup.

   **Tests:** the new integration tests preserve transmission history throughout each R1 scenario. Neither exercises live `callbacks_cleanup()` between A and B, so their assertions can pass while this bypass remains. Retain unanswered-transmission history across callback cancellation; reset it only at an appropriate connection boundary.

2. **P2 — R2: cleanup still does not always release `_finishWithSave()`.**  
   **Anchor:** `src/js/utils/AutoRestore.ts:382–383`.

   `_cleanup()` captures and clears `_whenCleanedUp`, but calls the result callback before invoking the captured resolver.

   **Reproduction:** start a restore with a callback that throws, reach `_finishWithSave()`, and deliver a confirmed save response. `_cleanup()` invokes the callback; its exception skips `released?.()`. The CLI machinery catches callback exceptions, leaving `await cleanedUp` pending permanently. Subsequent cleanup cannot recover the resolver because `_whenCleanedUp` is already null.

   **Safety effect:** an otherwise confirmed save can leave the restore command-loop promise unsettled. This is a lifecycle hang, not evidence that EEPROM persistence failed.

   **Tests:** the new R2 test uses a nonthrowing callback and disconnects during a regular command. It never reaches the save wait. Release the resolver in `finally`, independently of callback behavior.

**Other inspected claim paths**

- **R1’s direct repair works structurally for the supplied scenarios:** queued writes are skipped by response settlement; a later transmitted write becomes ambiguous while earlier same-code transmissions remain recorded; identical writes receive separate transmissions. I found no concrete false failure for a single ordinary, unretried, ACK-confirmed save, or sequential writes whose preceding ACK has consumed its record.
- **R2’s run checks stop the inspected command-loop continuation after disconnect cleanup.** Refused and connection-closed commands propagate failure. The unconditional save-wait release claim remains false as described above.
- **R3’s ordering repair is supported by inspection:** `serial.ts:386–397` invokes `onResult` before completing the queue node, so CLI invalidation precedes the successor’s transport check. The possibly-sent in-flight error now carries `notSent=false`. No additional concrete R3 race or authorization bypass was established.

**Test strength and reversion sensitivity**

The integration suite drives production MSP, MSPHelper, EEPROM, serial-queue, and restore code through a manually controlled fake transport. It does not merely mock the functions under review, although it mocks disconnect and seeds private restore state.

By source inspection, reverting the relevant production repairs would break the integration assertions for R1’s queued/ambiguous saves, R2’s stopped loop, and R3’s blocked successor/error metadata. The added `msp_promise` assertions likewise distinguish separate identical writes and queued-write settlement. However, wholesale reversion also makes that suite’s unconditional `write_transmissions.clear()` fail during setup; that failure alone would not demonstrate behavioral regression coverage. No reversion or test execution was performed.

**Residual limits**

The four-second window is a heuristic, not request correlation. Once an unanswered transmission expires, its later ACK can falsely confirm a newer transmitted write. `Date.now()` also makes expiration sensitive to forward wall-clock changes. These are residual limitations beyond the within-window cleanup bypass above.

Tauri is **NOT_VALIDATED**. This review establishes no protection against external programs, other browsers, or devices. Graph/index validation was not performed.

P0_OPEN=0  
P1_OPEN=1  
P2_OPEN=1  
REVIEW_COMPLETED=YES  
VERDICT=REQUEST_CHANGES

