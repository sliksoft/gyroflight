**P1 — The transport-busy repair remains incomplete for browser WebSocket sends.** `src/js/protocols/WebSocket.ts:216` queues bytes with `this.ws.send(data)` and returns success at line 238 without checking the browser’s outgoing buffer. Consequently, `src/js/serial.ts:379` decrements `pendingSends` while those bytes can still await transmission. The busy probe at `src/js/msp.ts:1218` then sees zero.

Reproducible scenario, derived from source:

1. Page A uses the supported browser WebSocket transport (`src/js/serial.ts:188–192`).
2. A submits a raw CLI write through `useCli` (`src/composables/useCli.ts:356`). Backpressure leaves its bytes in the browser’s outgoing WebSocket buffer for longer than `QUIET_MS`.
3. The transport’s promise has already resolved; raw CLI text has no MSP retry entry.
4. Page B requests the exclusive lease. A’s busy probe reports idle and A yields.
5. A’s buffered write transmits after B has acquired exclusivity.

**Safety effect:** exclusive ownership does not establish that another participating page has finished transmitting its admitted writes. This is the same premature-release pattern identified in round 2, remaining in an adjacent production transport. The scenario concerns bytes still buffered by this browser; it assumes no protection against other programs or devices.

**Existing tests:** the new transport test (`test/gyrocore/wp8_repair_write_lease.test.ts:357`) restores real `serial.send`, which is useful, but replaces `_protocol.send` with a promise that remains unresolved until explicitly released. It cannot detect a real adapter that resolves before its outgoing buffer drains. That test can pass while this defect remains. This is an unresolved repair claim, not a newly introduced WebSocket defect.

The repeated-yield change appears sound within the inspected locking model. `src/composables/fcWriteLease.ts:241` submits the exclusive request before broadcasting; lines 254–255 repeat the request until grant or failure. Each repeated message calls `tryYield()`, which checks quietness immediately. It does **not** update `lastAdmitted`, so the 250-ms interval being shorter than `QUIET_MS=300` does not itself prevent quietness. Requeued shared requests remain behind an already queued exclusive request. I found no concrete new starvation, livelock, authorization bypass, or indefinitely unsettled acquisition caused by the repeat.

Background throttling or a frozen holder can still delay yielding and cause refusal. The 8-second deadline depends on timer scheduling; it is not a strict wall-clock bound during suspension. That does not authorize the transaction without a grant.

For an **actually unresolved send promise**, `pendingSends` remains positive: increment occurs before enqueue, decrement only on settlement (`src/js/serial.ts:378–379`). Connection changes do not reset the counter (`:399–402`). Through the inspected yield path, this fails closed: the holder retains its shared lease and another page’s exclusive acquisition times out once its abort timer executes. It can cause persistent unavailability, including after reconnect, but the counter itself does not permit premature yielding.

Test sensitivity, assessed without execution:

- The delayed-request test (`test/gyrocore/wp8_repair_write_lease.test.ts:225`) exercises real lease logic against a delayed lock-manager wrapper. Removing repeated broadcasts should recreate its lost-yield timeout.
- Removing the `pendingSends` busy condition should defeat the stalled-send test’s expected refusal.
- Reverting **only `f10fb606`’s production changes** would leave that busy condition intact: it already exists in the commit’s parent. Thus the stalled-send test does not distinguish this commit from its parent.
- Neither new test models background throttling or WebSocket buffering.

Reviewed `git show f10fb606` and the necessary surrounding production code/tests at confirmed HEAD `e03cbc48a05e7359976bf175db622388634afb7b`. Findings are source-derived; no tests, network, hardware, modifications, or agents were used. **Tauri: NOT_VALIDATED.** Approval is withheld because the first round-2 safety claim remains incomplete.


REVIEW_COMPLETED=YES
VERDICT=REQUEST_CHANGES