**REQUEST_CHANGES — two P2 findings in the F10 repair.** Inspected `git show 3dce3954` and necessary production callers/tests at HEAD `30e0158f`. Findings are source-derived; no tests or runtime probes were run. No files were changed. Tauri is **NOT_VALIDATED**.

1. **P2 — Failed exit re-enters cleanup and submits another exit during disconnect.**  
   **Location:** `src/composables/useCli.ts:899`, `src/js/serial_backend.ts:434`.

   **Reproducible scenario:** With the CLI tab mounted and all three connection/CLI flags true, switch tabs and have the exit send return zero, a short count, or an error. The callback clears `exitPending` at line 899, then invokes `disconnectCliModeUnknown()`. Its `prepareDisconnect()` calls `tabSwitchCleanup()` (`serial_backend.ts:350`), which invokes the mounted `TABS.cli.cleanup` again (`CliTab.vue:181`). The CLI flags are still true and `exitPending` is now false, so this second cleanup submits another exit before `finishClose()` starts closing the transport.

   This is an actual production call cycle, rather than the harmless “second cleanup while pending” covered by the test.

   **Safety effect:** The failure path continues sending after deciding that CLI state is unknown. On Web Bluetooth, that additional send can reach the characteristic while disconnect awaits `stopNotifications()` (`WebBluetooth.ts:539`); the send path checks GATT connectivity rather than the protocol’s `connected` flag. Its eventual callback can also invoke the reboot handoff after teardown has begun. The new helper therefore does not provide a terminal, isolated failure handoff.

   **Would existing tests catch it?** No. `wp8_repair_cli_exit.test.ts:34` replaces the entire backend with spies. Consequently, its failure tests never execute `prepareDisconnect()` or the re-entrant tab cleanup. The assertion that only one attempt occurs at line 120 can pass while production submits another attempt.

2. **P2 — An unsettled send permanently blocks the destination tab without reporting exit failure.**  
   **Location:** `src/composables/useCli.ts:898`, `src/composables/useCli.ts:910`; lifecycle dependency at `src/components/tabs/CliTab.vue:184`.

   **Reproducible scenario:** Leave a valid CLI tab while its exit write—or an earlier write ahead of it in the transport queue—remains pending indefinitely. Web Serial awaits its send queue and `writer.write()` without a deadline (`WebSerial.ts:590,609`); `serial.send()` likewise awaits the protocol without a deadline (`serial.ts:347`).

   Cleanup immediately returns true and sets `exitPending`. The CLI tab adapter therefore suppresses the navigation callback. `switchTab()` has already set `tabSwitchInProgress = true` (`tab_switch.ts:142`), so subsequent tab switches are rejected at line 121. No transport callback arrives to initiate either disconnect or reconnect.

   **Safety effect:** The requested destination never mounts, the link remains open with uncertain CLI state, and the promised failure message/drop never occurs. Repeating cleanup returns true indefinitely. This is a new lifecycle dependency on transport settlement, without a bounded failure path.

   **Would existing tests catch it?** No. The pending-send test at `wp8_repair_cli_exit.test.ts:133` manually resolves the promise at line 141. It neither leaves the promise unsettled nor mounts the actual CLI tab and drives `switchTab()`, so it cannot detect the navigation lock.

The tests exercise the real `useCli` and serial facade, but their backend mocks exclude the critical teardown interaction. These findings do not establish a persisted-write authorization bypass; they do establish incomplete failure handling for this commit’s CLI-exit claim.

REVIEW_COMPLETED=YES
VERDICT=REQUEST_CHANGES