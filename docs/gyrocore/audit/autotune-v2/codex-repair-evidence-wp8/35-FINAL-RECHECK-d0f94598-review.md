**REQUEST_CHANGES.** At verified HEAD `d0f94598a61736c04c3eafbff2d8c81ffcf847b6`, the ordinary single-teardown window is guarded, but production transports can still provide premature or false closure evidence.

1. **P1 — A second disconnect can clear accounting before teardown finishes.**  
   **Anchors:** `src/js/serial.ts:369`; `src/js/protocols/WebSerial.ts:416`; `src/js/protocols/WebBluetooth.ts:508`.

   **Reproducer:** Start a send and hold its transport write pending. Call `serial.disconnect()`. While WebSerial is awaiting its 50-ms delay or reader cancellation, or Bluetooth is awaiting `stopNotifications()`, call `serial.disconnect()` again. WebSerial returns `true` because its first teardown already set `connected=false`; Bluetooth returns `true` because `closeRequested=true`. The facade treats that second return as completed closure and advances `#closedThrough`, excluding the original pending send.

   **Safety effect:** The page can yield its write lease while the first connection remains capable of delivering the in-flight write. This reproduces the teardown-window P1 through transport short-circuit behaviour.

   There is another false-proof route in WebSerial: `port.close()` rejection is swallowed at `WebSerial.ts:468`, followed by `disconnect(detail:true)` and `return true` at lines 483–484. A failed close therefore also clears accounting without proving closure.

   **Existing tests:** Would not catch these scenarios. The test at `test/gyrocore/wp8_repair_round3.test.ts:168` substitutes a transport whose disconnect promise correctly represents completed closure. The failure test substitutes a rejecting disconnect; it never exercises WebSerial’s swallowed failure or either transport’s early-success return.

2. **P1 — Closing one connection also erases unresolved sends belonging to other connections.**  
   **Anchor:** `src/js/serial.ts:443`, together with event handling at `src/js/serial.ts:244`.

   **Reproducer:** Leave a Bluetooth write pending and make teardown fail before `gatt.disconnect()`—for example, while removing a characteristic listener. Bluetooth reports failure, so the old send initially remains counted. Connect through WebSocket, then close that WebSocket. Its disconnect event passes the *current facade generation* to `#connectionClosed()`. The global `#closedThrough` watermark now excludes every older generation, including the Bluetooth write whose connection was never proven closed.

   **Safety effect:** A successful close of another transport converts the intended fail-closed state into permission to yield the lease. `serial.connect()` neither requires successful closure of the previous transport nor records closure ownership.

   **Existing tests:** Would not catch this. More concerningly, the event test explicitly tolerates a previous failed teardown’s pending send (`wp8_repair_round3.test.ts:202`) and then expects a later transport event to reduce the entire count to zero (line 210). That expectation encodes the unsupported assumption that closing the active connection proves all earlier connections closed.

3. **P2 — A closed WebSocket can retain a permanent busy contribution.**  
   **Anchors:** `src/js/serial.ts:433`; `src/js/protocols/WebSocket.ts:245`.

   **Reproducer:** Send while the socket has buffered bytes, then lose the connection before those bytes drain. A WebSocket’s `bufferedAmount` can remain nonzero after closure. The transport retains `this.ws`; the facade unconditionally adds one whenever its `bufferedAmount` is positive, even after the disconnect event has marked the generation closed.

   **Effect:** The page continues refusing lease handoff despite the socket being closed. This preserves an equivalent form of the original availability defect, at least until the socket is replaced.

   **Existing tests:** Would not catch it. The buffering test manually changes the fake transport’s amount from 12 to zero (`wp8_repair_round3.test.ts:152–155`); it never closes a socket while its amount remains positive.

**Other conclusions from inspection**

- The per-generation map safely isolates ordinary old promise completions: each `finally` decrements its captured generation (`serial.ts:410–413`), without decrementing a newer generation.
- For a genuinely completed close, an unfinished send’s map entry stops contributing. Thus the original synthetic stuck-send case is addressed, but closure attribution and transport return contracts prevent general closure of the claim.
- By source inspection, reverting to `b3ca2c6a` would fail the new “still closing” assertion and failed-teardown assertion: that implementation immediately excludes earlier generations. This is an inspection-based prediction, **not an executed reversion test**.
- No tests, hardware operations, network access, agents, or modifications were performed. This review covers the requested accounting change and WebSerial, WebBluetooth, and WebSocket paths. **Tauri: NOT_VALIDATED.** No protection against external programs, other browsers, or devices is claimed.

P0_OPEN=0  
P1_OPEN=2  
P2_OPEN=1  
REVIEW_COMPLETED=YES  
VERDICT=REQUEST_CHANGES
