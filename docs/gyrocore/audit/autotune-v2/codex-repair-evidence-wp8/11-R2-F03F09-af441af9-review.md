Reviewed only `af441af9` and necessary surrounding production code/tests at HEAD `b1317bf855140966c1bbc6304f13b78b4373452f`. **Three P1 findings remain.** These are source-derived reproduction scenarios; I ran no tests, hardware actions, or network operations.

1. **P1 — Legacy MSP writes can still leave after retry exhaustion.**  
   **Locations:** `src/js/msp.ts:825`, `src/js/msp.ts:902`; production caller: `src/composables/setup/useSetupData.ts:79`.

   **Reproduce:** Stall an earlier transport send. Invoke `MSP.send_message(MSPCodes.MSP_RESET_CONF, false, false, callback)` while writes are allowed. Wait beyond all three request timeouts, then release the stalled send without providing a response for the reset request.

   The legacy timeout branch stops retrying but deliberately retains the request in `callbacks`. Consequently, the new `_still_wanted()` check still accepts it: membership remains true and current authorization still passes. The original reset and queued retries remain eligible to reach the transport after timeout exhaustion.

   **Safety effect:** A stale destructive configuration operation can execute several seconds after its retry window ended. This is an adjacent production route retaining the round-1 F03 late-write pattern.

   **Tests:** `test/gyrocore/wp8_repair_review_transport.test.ts:125` uses `MSP.promise()`, whose error-aware timeout removes its entry. It cannot expose the retained legacy entry. The new test’s expected result is compatible with this defect remaining.

2. **P1 — A late failed delivery can mark CLI uncertain while leaving its successor authorized to send and succeed.**  
   **Locations:** `src/js/msp.ts:491`, `src/js/msp.ts:520`, `src/js/msp.ts:434`, `src/js/msp.ts:564`.

   **Reproduce using the existing controlled-transport approach:**
   
   - Start CLI command A with a short response timeout; hold its transport result.
   - Queue another serial send C behind A and CLI write B behind A.
   - Let A time out. Feed A’s late reply, including ETX, during the drain grace period. The drain ends and B becomes `cli_in_flight`, with its serial send waiting behind C.
   - Resolve A’s transport result as a short send; keep C pending.
   - A’s `_cli_delivered()` sets `cli_session_uncertain` and calls `_cli_session_lost()`. That function rejects only `cli_queue`; B has already left that queue.
   - Release C. B’s `stillWanted` checks entry identity, generation, and `cliCommandRefusal()`, **but not `cli_session_uncertain`**. With ordinary write authorization still available, B goes out.

   **Safety effect:** A CLI write proceeds after the session has explicitly become uncertain. If B subsequently receives successful delivery and a reply, `_finish_cli()` invokes its success callback before checking session uncertainty, allowing false success as well.

   **Tests:** The timeout/drain test at `test/gyrocore/wp8_repair_review_transport.test.ts:197` and failed-delivery test at line 217 test these events separately. Neither combines timeout, completed drain, successor admission, and late failed delivery. The old-generation test also does not cover this same-generation race.

3. **P1 — An active WebSerial batch can resume onto the next connection, bypassing the new generation guard.**  
   **Locations:** `src/js/protocols/WebSerial.ts:597`, `src/js/protocols/WebSerial.ts:571`, `src/js/protocols/WebSerial.ts:321`.

   **Reproduce:** In AT32/macOS batch mode, start a payload longer than 63 bytes and hold its first `writer.write()` promise. Disconnect and reconnect the same WebSerial instance to another port while that promise remains pending. Allow the new connection to send, then resolve the old write successfully.

   Generation is checked only before entering `#sendNow()`. The already-running `batchWrite()` neither captures nor rechecks it. Its next iteration reads the **current** `this.connected` and `this.writer`, so the remaining old payload is written to the new connection.

   **Safety effect:** Previous-session bytes can enter or interleave with the new session without another `stillWanted` authorization check. For an interactive CLI payload whose remaining chunks contain line endings and write commands, this permits previous-session commands to execute in the new CLI session.

   **Tests:** The new reconnect tests replace WebSerial with a single-promise fake transport. `test/js/webserial_send_queue.test.ts:147` rejects the pending chunk during disconnect and never reconnects before resolving it successfully. Neither exercises an active old batch resuming with a new writer.

The isolated drain-before-callback, reply-before-delivery, and old-generation delivery-result cases have corresponding production changes and meaningful regression assertions. That supports those individual mechanisms by inspection; it does not establish the combined safety claims above. Revert sensitivity was inspected, not executed.

Tauri remains **NOT_VALIDATED**. This review makes no claims about protection from external programs, other browsers, or devices.


REVIEW_COMPLETED=YES
VERDICT=REQUEST_CHANGES