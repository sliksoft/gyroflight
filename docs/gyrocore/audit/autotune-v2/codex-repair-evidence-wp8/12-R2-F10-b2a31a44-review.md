Reviewed `b2a31a44` against production code and tests at HEAD `b1317bf8`. No tests, hardware actions, network access, or modifications performed. Tauri: **NOT_VALIDATED**.

**P2 — An old CLI exit deadline can disconnect a replacement connection.**  
Location: `src/composables/useCli.ts:918–941`, especially the unconditional `disconnectCliModeUnknown()` at line 929.

Reproducible sequence from inspected code:

1. Leave CLI while the transport’s exit send remains unresolved. Cleanup sets `exitPending` and starts the two-second timeout.
2. Before that deadline, the original link disconnects unexpectedly. `onClosed()` resets connection state and tears down the CLI (`src/js/serial_backend.ts:1367–1377`).
3. Start another connection in the same application before the deadline.
4. The old CLI instance’s timer fires. Its `exitPending` is still true, so it calls `disconnectCliModeUnknown()`, which tears down the **current** connection through `finishClose()` (`src/js/serial_backend.ts:432–437,660–670`).

The timer is local to that cleanup invocation and is cleared only when `exitResult()` runs. Re-entering cleanup during unmount returns immediately while pending (`useCli.ts:910–912`); it neither invalidates the operation nor cancels the timer. The application’s `killAllTimeouts()` cannot cancel this raw, unregistered timeout (`src/js/timers.ts:168–174`). There is no connection-generation check before the destructive action.

**Safety effect:** obsolete CLI cleanup can abort a subsequent connection attempt or connected session, clear its application state, and misleadingly report that its CLI exit failed. This is a new lifecycle race introduced by the deadline. No EEPROM write or authorization bypass is established by this scenario.

**Existing tests:** the new deadline test (`test/gyrocore/wp8_repair_cli_exit.test.ts:164–181`) would miss it. It keeps one CLI instance/session throughout and mocks `disconnectCliModeUnknown`; it never disconnects the original session, unmounts CLI, or starts a replacement connection. Its assertions remain compatible with this defect. The operation needs cancellation/invalidation when its owning session ends, plus a session identity check before disconnecting.

The two original round-1 cases are addressed in the ordinary, unchanged-session flow:

- **Repeated exit after failure:** `exitFailed` is set before entering backend disconnect. Re-entered cleanup returns false, allowing `prepareDisconnect()` → `tabSwitchCleanup()` to release the navigation lock without another exit. The new re-entry test exercises production `useCli`, although it reconstructs the tab callback and mocks the backend. From inspection, reverting the latch would cause its one-send/one-disconnect assertions to fail.
- **Unreported exit result:** the two-second deadline invokes the failure path; the latch permits the real tab-cleanup callback to continue. A later result is ignored because `exitPending` is false. From inspection, reverting the deadline would fail the new timeout test’s disconnect assertion.

Neither new test merely mocks `useCli.cleanup()` itself. They provide targeted regression coverage, but no execution evidence was obtained and backend lifecycle integration remains untested here. No additional P0/P1 was identified within this commit’s narrow claims; the new P2 race warrants correction.


REVIEW_COMPLETED=YES
VERDICT=REQUEST_CHANGES