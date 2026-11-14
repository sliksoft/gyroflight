F02 remains open: a page can surrender its lease while an admitted write is still being transmitted.

1. **P1 — Busy tracking ends before transmission necessarily ends.**  
   **Location:** `src/js/msp.ts:1194`; adjacent raw CLI route: `src/composables/useCli.ts:356`.

   **Reproducible schedule:** Page B admits an ordinary legacy SET while holding its shared lease. Its transport starts sending, but completion stalls beyond the three MSP attempts. At timeout exhaustion, `_on_timeout()` clears `obj.timer` and retains the legacy callback (`src/js/msp.ts:822–827`). The new busy probe ignores that callback because its timer is null. With no `useSaving` operation active, B can now yield to page A’s transaction, although B’s transport operation remains outstanding. Let B’s send finish after A has begun its snapshot reads.

   **Safety effect:** An already-admitted ordinary write can reach the FC during another page’s exclusive transaction. The transaction’s snapshot and subsequent write decisions therefore need not describe one isolated configuration state.

   The HEAD facade queue does **not** close this gap: `src/js/serial.ts:366` checks `stillWanted` before calling the transport, then awaits that transport at line 370. It neither cancels nor rechecks an operation already handed over. Queue ordering within B does not order A’s separate connection.

   **Adjacent occurrence:** Raw interactive CLI sends call `serial.send()` directly, without populating `MSP.cli_in_flight` or `MSP.cli_queue`. Consequently, an outstanding raw CLI transmission can become “quiet” after only 300 ms. The probe’s CLI protection covers the MSP CLI queue, not this production route.

   **Would existing tests catch it?** The reviewed tests would not. Their integration setup replaces `serial.send` with an immediately completing mock (`test/gyrocore/wp8_repair_write_lease.test.ts:256`; `wp8_repair_cross_page.test.ts:52`). The busy test supplies a synthetic Boolean probe (`wp8_repair_write_lease.test.ts:142`), bypassing the production lifetime calculation. Its CLI test exercises `MSP.send_cli_command`, not raw interactive CLI.

   The required invariant is transmission lifetime, including unresolved sends after request timeout—not merely the existence of an MSP retry timer.

2. **P2 — Yield can be consumed before the exclusive request is queued, causing avoidable timeout/starvation.**  
   **Location:** `src/composables/fcWriteLease.ts:236–238`, with release/reacquisition at lines 168–171.

   **Reproducible schedule:** A posts the yield message, then is descheduled before calling `locks.request`. Quiet page B receives the message, clears `yieldWanted`, releases its shared lease, and immediately requests it again. Because A has not yet submitted its exclusive request, B reacquires shared. Resume A: its exclusive request waits behind B, but B has already consumed the only yield message. A eventually refuses with `fc:write_lease_timeout`.

   This schedule can be forced by pausing A between lines 236 and 238 while B runs independently. A page that starts and acquires shared in that interval can similarly miss the broadcast entirely.

   **Safety effect:** This fails closed, but unnecessarily blocks Apply, Restore, and transaction-state checks even with quiet cooperating pages. Repeated adverse scheduling can repeatedly deny those operations.

   **Would existing tests catch it?** No. The shim registers requests synchronously (`test/gyrocore/harness/webLocks.ts:90–100`), while the tests’ BroadcastChannel delivery occurs after the initiating synchronous call stack. That arrangement does not exercise another page consuming the broadcast before A submits its exclusive request. The comment claiming reacquisition is necessarily “queued behind the exclusive request” is therefore unsupported.

   Submit the exclusive request before notifying peers, or retain/retry the yield protocol until acquisition or cancellation.

I inspected commit `2f413fc3` and the necessary HEAD production paths and named tests at `b1317bf8`, including the later facade queue interaction. These findings are source-derived schedules; **no tests or reproduction probes were executed**. The browser test referenced by the shim, `test/browser/crossTabWriteLease.browser.mjs`, is absent from this checkout.

No source changes, network access, hardware actions, or delegation occurred. Background throttling and frozen-page behavior have no execution evidence here. Tauri remains **NOT_VALIDATED**. These conclusions concern cooperating pages of this origin only.

REVIEW_COMPLETED=YES
VERDICT=REQUEST_CHANGES