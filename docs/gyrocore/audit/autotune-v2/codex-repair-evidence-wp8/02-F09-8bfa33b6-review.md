The F09 closure claim remains incomplete. These are source-derived failure scenarios, not execution results; no tests were run.

1. **P2 — Timeout callbacks can dispatch a command before the drain starts.**  
   **Location:** `src/js/msp.ts:482`, `:493`, `:506`.

   `_finish_cli` clears `cli_in_flight`, invokes the caller’s callback, and only afterward sets `cli_discarding`.

   **Reproduction:** Submit command A with a timeout. In A’s error callback, synchronously submit B. B passes `_process_cli_queue` because neither an in-flight command nor a drain exists yet. After the callback returns, A’s timeout starts the drain. Feed A’s late `STX…ETX` reply: the decoder sees B’s installed `cli_callback` and reports A’s output as B’s successful response.

   **Safety effect:** The original reply-attribution defect survives through callback reentrancy. B can be dispatched before A’s response has been consumed and receive false success.

   **Existing tests:** Would not catch this. Timeout callbacks only record results; the new-command test submits B after the timeout handler has returned. This is a retained ordering defect within the repair’s claimed queue isolation.

2. **P2 — A reply can complete a command successfully before its delivery result reports failure.**  
   **Location:** `src/js/msp.ts:441`, `:462`, `:470–473`, `:908–910`.

   Reply completion and transport completion are independent. Receiving ETX calls `_finish_cli(..., null)` without checking `entry.delivery`. That clears the command, calls its success callback and advances the queue. A subsequent short-send result cannot turn that completed success into an error; it only marks the session uncertain.

   **Reproduction:** Hold A’s transport-result promise pending. Feed a complete CLI response for A. Observe A’s successful callback and dispatch of queued B. Then resolve A’s transport result with fewer bytes than its frame length. A has already succeeded, contrary to the explicit claim that a short send ends the command with an error. B remains in flight because `_cli_session_lost()` only rejects queued entries.

   **Safety effect:** Transport failure can be reported after callers have already advanced a configuration sequence. The implementation lacks a coordinated terminal outcome for reply and delivery completion. Browser transport writes await asynchronous completion (`src/js/protocols/WebSerial.ts:609`); receive processing is not gated on that completion.

   **Existing tests:** Would not catch this. Short-send tests settle delivery before exercising subsequent operations. The queue test even feeds replies synchronously before delivery microtasks settle, but never combines that ordering with a failed delivery result. The scenario requires delayed/ambiguous transport completion; its hardware frequency is unvalidated.

3. **P2 — An old delivery completion can invalidate a freshly reset CLI session.**  
   **Location:** `src/js/msp.ts:462–473`, `:554`; `test/js/msp_cli_drain_isolation.test.ts:219–234`.

   The delivery continuation has no connection-generation check. `disconnect_cleanup()` resets uncertainty, but an outstanding send continuation still mutates the shared MSP object afterward.

   **Reproduction:** Leave A’s transport result pending. Call `disconnect_cleanup()`, establish the next connection and submit B. Resolve A’s old result with zero bytes. Since A is no longer the in-flight entry, its continuation calls `_cli_session_lost()`: queued commands belonging to the new session receive `CliSessionUncertainError`, and subsequent commands are refused until another cleanup.

   **Safety effect:** A failed write from the previous connection contaminates the recovered connection, unnecessarily blocking configuration/recovery operations.

   **Existing tests:** The final new test contains the first half of this scenario: it releases a zero-byte result after cleanup. However, it neither awaits that continuation nor asserts the resulting session state or successful operation on a new connection. Its assertions therefore miss the regression.

The two `wp8_*_transport.test.ts` harness changes preserve the earlier authorization assertions: they still require `ApplyBlockedError` and verify that only the initial read reached the transport. Injecting the late framed reply makes the queued command reach its dispatch authorization check. Changing the default send result to the full frame length is consistent with the new delivery contract. These changes do not themselves weaken those assertions.

The new tests exercise production MSP queue/decoder code rather than mocking the function under review, but omit the callback-reentrancy and asynchronous-completion combinations above. I found no additional concrete authorization bypass in the minimally inspected callers.

Scope: commit `8bfa33b6`, with surrounding production code and tests inspected at verified HEAD `30e0158f`. Later HEAD changes add timeout/disconnect output metadata; they do not remove these ordering problems. No runtime, hardware, external-program, other-browser or other-device protection is established. Tauri remains **NOT_VALIDATED**.

REVIEW_COMPLETED=YES
VERDICT=REQUEST_CHANGES
