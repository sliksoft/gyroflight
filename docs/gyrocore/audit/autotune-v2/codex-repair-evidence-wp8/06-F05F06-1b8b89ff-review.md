Request changes: two P1 false-success paths remain, plus a P2 cancellation-reporting gap.

Reviewed `git show 1b8b89ff` and necessary production callers/tests at HEAD `30e0158f`. The six named files have no subsequent differences between this commit and HEAD. Findings below are source-derived scenarios; no tests or execution probes were run.

1. **P1 — RXFAIL firmware refusal is treated as acknowledgment.**  
   **Location:** `src/js/msp/MSPHelper.ts:734`.

   `sendRxFailConfig` awaits `MSP.promise` but discards its response. A valid MSP error frame resolves that promise with `unsupported: 1`: `deliverResponse` rejects CRC errors but otherwise delivers the response (`MSPHelper.ts:214–217`).

   **Reproducible scenario:** In the new transport suite, make `answers` return `"error"` for `MSP_SET_RXFAIL_CONFIG` and `"ack"` otherwise. The RXFAIL loop continues, EEPROM is written, `initializeDefaults` runs, and reboot begins despite the channel write being refused.

   **Safety effect:** The UI declares the edited failsafe configuration saved while EEPROM retains the previous value for the refused channel. This is an equivalent false-success path surviving the repair, rather than a newly introduced protocol behavior.

   **Existing tests:** Would not catch this. `test/gyrocore/wp8_repair_failsafe_save.test.ts:164–203` covers silence and application write-check refusals, but firmware error replies are tested only for EEPROM (`:207`). The component and composable tests stub RXFAIL completion. Require an explicit successful-response check for each channel and a firmware-refusal regression.

2. **P1 — The post-ACK baseline includes edits that were never transmitted.**  
   **Location:** `src/composables/failsafe/useFailsafeSave.ts:60`; `src/components/tabs/FailsafeTab.vue:446`.

   Moving `initializeDefaults` behind the EEPROM ACK establishes persistence ordering, but the callback snapshots the **current editable store**, rather than the values transmitted by this save.

   **Reproducible scenario:** Start saving failsafe delay A. After `MSP_SET_FAILSAFE_CONFIG` has been transmitted, change the delay to B while a later RXFAIL response or EEPROM ACK is delayed. The input remains editable (`FailsafeTab.vue:96`), and the tab does not consume `isSaving` (`:747`). Let the remaining requests succeed. EEPROM contains A, but `initializeDefaults` snapshots B and empties `configChanges` (`:449–453`).

   **Safety effect:** An unsent failsafe edit is marked clean; Save becomes disabled before reboot, and the edit is lost when configuration reloads. The commit also creates an additional exposure window between the former baseline-reset point and the EEPROM ACK.

   **Existing tests:** Would not catch this. The component tests edit only before saving (`test/components/FailsafeTab.test.ts:59,79`); the transport suite uses a spy for `initializeDefaults` and checks invocation, not snapshot correctness. Preserve the transmitted snapshot or prevent edits throughout the save.

3. **P2 — Cancellation ends RXFAIL saving silently despite potentially changed FC RAM.**  
   **Location:** `src/js/msp/MSPHelper.ts:737–739`; `src/composables/failsafe/useFailsafeSave.ts:50`; `src/composables/useSaving.ts:97`.

   **Reproducible scenario:** Let the FC receive one RXFAIL write, withhold its reply, then switch tabs. `tabSwitchCleanup` clears pending requests (`src/js/tab_adapters.ts:45`), producing `MspCancelledError`. The new chain passes that error unchanged through `onRefused`; `useSaving` then returns without logging, notifying, or invoking failure follow-up.

   **Safety effect:** `isSaving` becomes false and EEPROM is skipped, but the user receives no save-failure warning even though earlier writes may have changed RAM. This does **not** establish that EEPROM was saved, and I found no explicit success toast on this cancellation path. It contradicts the commit’s documented cleared-queue behavior of ending with an error shown.

   **Existing tests:** Would not catch this. The new Failsafe suite has no in-flight cancellation case. Moreover, `test/js/useSaving.test.ts:103–113` explicitly requires cancellations to remain silent, without distinguishing cancellation before a write from cancellation after possible execution. The RXFAIL save needs operation-specific cancellation reporting.

For the requested adjacent-route check, I found no reset-before-persistence ordering in the inspected Configuration, Receiver, GPS, Sensors, Onboard Logging, Motors, PID Tuning, or Auxiliary save paths at HEAD. Configuration, Receiver, GPS, Sensors, Onboard Logging, PID Tuning, and Auxiliary also retain a save snapshot. Motors still resets its baseline from current values after persistence (`src/composables/motors/useMotorsSave.ts:134`), an adjacent instance of the mutable-baseline pattern in finding 2.

The component/composable tests mock collaborators rather than their own function under test; their limitation is that the mocked reboot function supplies the ACK-to-baseline contract being asserted. The transport suite exercises more production code, but omits firmware RXFAIL refusal, cancellation, and concurrent editing.

No additional concrete deadlock or authorization bypass was established within this scope. This is code-inspection evidence only. No hardware, external-program/browser/device protection, or runtime qualification is claimed. Tauri: **NOT_VALIDATED**.

REVIEW_COMPLETED=YES
VERDICT=REQUEST_CHANGES