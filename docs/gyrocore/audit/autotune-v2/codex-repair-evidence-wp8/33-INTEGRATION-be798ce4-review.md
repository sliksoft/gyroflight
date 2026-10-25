**REQUEST_CHANGES: one new P2 availability defect.** No remaining P0/P1 defect identified within the reviewed scope.

Reviewed detached HEAD `be798ce48239c1e0e1235b1eb3519b4cc6fa7a18` and repairs in `20242d2c..HEAD`. Evidence is source/history inspection only: no tests, hardware operations, network access, changes, or agents. The untracked `.serena/` directory was left untouched.

**Remaining finding**

**P2 — A stalled send from a closed connection can indefinitely prevent other tabs’ transactions.**

Anchors: `src/js/serial.ts:395`, `src/js/serial.ts:410`, `src/js/serial.ts:419`, `src/js/msp.ts:1282`, `src/composables/fcWriteLease.ts:157`.

Concrete sequence:

1. Tab A hands a send to an adapter whose promise never settles.
2. A disconnects, then reconnects successfully. `#newSendQueue()` changes the generation and replaces the queue, allowing new sends.
3. However, `#pendingSends` still includes the old send. Its decrement exists only in that send’s `finally`.
4. Tab B requests the exclusive write lease. A’s busy probe remains true, so A never yields its shared lease. B times out after eight seconds; subsequent attempts repeat indefinitely while A remains open.

This combines the reconnect repair with the lease-retention repair. It affects exclusive transactions and read-only recovery checks in other tabs, even after the old link has closed. It fails closed; I found no resulting unauthorized write or automatic uncertainty release.

The existing stalled-connection test verifies that new sends proceed (`test/gyrocore/wp8_repair_review_transport.test.ts:166`). The lease test verifies retention while a send remains pending (`test/gyrocore/wp8_repair_write_lease.test.ts:358`). Neither checks lease acquisition **after disconnect/reconnect with the old promise permanently unresolved**.

Required repair: distinguish sends belonging to a conclusively closed connection from current transport activity, without allowing old completions to corrupt current accounting. Add the combined regression scenario above. Simply zeroing the cumulative counter would be insufficient because old `finally` handlers can still decrement it.

**F01–F10 disposition**

“CLOSED” below means the original defect is closed by inspected software logic, within the documented limits. It does not mean execution or hardware validation. Revert sensitivity is an assessment of inspected assertions; no tests or mutation runs were performed.

| Finding | Status and production evidence | Would existing tests fail on reverting the repair? |
|---|---|---|
| **F01 AutoRestore false success** | **CLOSED.** Firmware save output governs confirmation: `src/composables/useMspCliSession.ts:70`, `:286`; AutoRestore distinguishes confirmed, unverified and unknown outcomes at `src/js/utils/AutoRestore.ts:334`. Cleanup invalidates the command loop and releases its save wait at `:348`. Backups success is conditional at `src/components/tabs/BackupsTab.vue:534`. | **Expected yes.** `test/gyrocore/wp8_repair_save_evidence.test.ts:140`, `:157`, `:179`, `:250` reject disconnect/delivery-only success. Integration cases at `wp8_repair_integration.test.ts:187` and `:207` cover loop termination and throwing result callbacks. |
| **F02 cross-tab writes outside transaction lock** | **CLOSED for authorization isolation.** Ordinary writes require the shared lease; transaction writes require exclusive ownership: `src/composables/fcWriteGuard.ts:263`, `:282`, `:400`; exclusive acquisition precedes the transaction callback at `src/composables/fcWriteLease.ts:230`. **The new availability defect above remains.** | **Expected yes.** `test/gyrocore/wp8_repair_cross_page.test.ts:87`, `:105` assert refusal before any pending record exists. Browser coverage drives the app’s module instances at `test/browser/crossTabWriteLease.browser.mjs:55`, `:123`; not executed here. |
| **F03 WebSerial batch interleaving** | **CLOSED.** Whole logical sends are queued; chunks retain writer/generation identity and report partial delivery: `src/js/protocols/WebSerial.ts:575`, `:602`. Facade generation and `stillWanted` checks occur at `src/js/serial.ts:374`; stale MSP requests stop at `src/js/msp.ts:962`. | **Expected yes.** `test/js/webserial_send_queue.test.ts:118`, `:137`, `:174` cover interleaving, partial writes and reconnect boundaries. `wp8_repair_review_transport.test.ts:127` covers expired queued writes. |
| **F04 EEPROM success on disconnect** | **CLOSED.** The shared contract rejects missing, corrupt or ambiguous replies and distinguishes retry refusal: `src/js/msp/eepromSave.ts:45`, `:81`, `:95`. Save/reboot success is downstream of this contract: `src/js/msp/MSPHelper.ts:862`, `src/composables/useReboot.ts:103`. | **Expected yes.** `test/gyrocore/wp8_repair_eeprom_save.test.ts:132`, `:155`, `:207`, `:268` assert failure without saved/reboot outcomes. Integration tests at `wp8_repair_integration.test.ts:117`, `:139`, `:154` cover duplicate-answer attribution and tab cleanup. |
| **F05 refused RXFAIL retry hangs save** | **CLOSED.** Each channel uses the error-aware confirmed-write path; rejection ends the chain: `src/js/msp/MSPHelper.ts:765`. Failsafe connects both completion and rejection at `src/composables/failsafe/useFailsafeSave.ts:61`. | **Expected yes.** `test/gyrocore/wp8_repair_failsafe_save.test.ts:168`, `:180`, `:195` assert settlement, no following writes and no EEPROM save. |
| **F06 premature Failsafe clean state** | **CLOSED.** Payloads and baseline are captured at save start; baseline commits only after EEPROM confirmation: `src/composables/failsafe/useFailsafeSave.ts:47`, `:69`; `src/composables/useReboot.ts:105`. Fields are disabled and inert at `src/components/tabs/FailsafeTab.vue:7`; baseline comparison uses captured values at `:468`. | **Expected yes.** `test/components/FailsafeTab.test.ts:78`, `:108`, `:129` cover intervening edits, field locking and failed persistence. EEPROM failure cases also exist at `wp8_repair_failsafe_save.test.ts:263`. |
| **F07 orphaned/unknown-scope recovery** | **CLOSED as diagnosis and actionable guidance, not an automatic unlock.** Orphans and unknown scope receive explicit findings; unsupported recovery remains unavailable: `src/gyrocore/recovery/transactionDiagnosis.ts:82`, `:128`, `:148`. The UI preserves the unreadable latch at `src/gyrocore/components/UncertainStateNotice.vue:112`. | **Expected yes.** `test/gyrocore/wp8_repair_recovery_diagnosis.test.ts:99`, `:163`, `:255`, `:293` cover orphan handling, whole-craft coverage, unreadability and unchanged blocking/storage. |
| **F08 retention accepts invalid records** | **CLOSED.** Store and retention share the canonical reader: `src/gyrocore/stores/transactionRecords.ts:69`, `:104`; `src/gyrocore/stores/tuneBackup.ts:98`. Unreadable records prevent pruning at `:125`; migration rejects conflicting identifiers/content. | **Expected yes.** Invalid-record retention assertions at `test/gyrocore/wp8_repair_backup_retention.test.ts:98`, `:130`; migration collision cases at `:212`, `:223`. |
| **F09 CLI drain isolation** | **CLOSED.** Timeout installs draining before invoking the caller; expired draining closes the session: `src/js/msp.ts:578`, `:633`. Reply completion waits for delivery at `:569`; adapter results run before the successor send at `:535`. | **Expected yes.** `test/js/msp_cli_drain_isolation.test.ts:95`, `:109`, `:135` cover MSP preservation and late replies. `wp8_repair_integration.test.ts:238` covers the immediate successor after a cut send. |
| **F10 CLI exit transport failure** | **CLOSED.** Reboot handoff requires whole adapter delivery; failure/deadline drops the link without a second exit. Old results are connection-scoped: `src/composables/useCli.ts:910`, `:919`, `:941`; `src/js/serial_backend.ts:432`. | **Expected yes.** `test/gyrocore/wp8_repair_cli_exit.test.ts:109`, `:148`, `:164`, `:184` cover failure, recursive cleanup, missing result and replacement connections. Backend teardown is mocked there, limiting integration evidence. |

**Integrated safety assessment**

Within the inspected configuration-write routes, authorization remains enforced at admission and immediately before adapter handoff. Transaction permits check pending-record ownership and competing uncertainty (`src/composables/useTuneApply.ts:463`). No additional authorization bypass was identified.

The R1 repair retains unanswered write transmissions across ordinary callback cleanup (`src/js/msp.ts:1031`); queued writes cannot consume replies before handoff (`src/js/msp/MSPHelper.ts:471`), and ambiguous answers reject error-aware writes (`:225`). The documented four-second heuristic remains a boundary of this conclusion.

The R2 loop invalidation and save-wait cleanup are present. R3 handles CLI delivery failure inside the serial queue’s `onResult`, before a successor can pass `stillWanted`. I found no further false-success path in those inspected interactions.

Uncertain transaction records remain persistent evidence. Restore coverage requires an ended entry with one known profile (`src/gyrocore/stores/fcTransactionState.ts:275`). Read-only resolution requires the applicable complete backup comparison and rechecks storage afterward (`src/composables/useTuneApply.ts:1384`, `:1421`). Reboot, reconnect, elapsed time and diagnosis do not themselves clear those records.

**Absolute Apply remains BLOCKED:** `hardwareValidated` is false at `src/gyrocore/safety/absoluteEvaluate.ts:64`, producing an explicit block at `:180`; write authority enforces the Safety result at `src/gyrocore/releaseGate/writeAuthority.ts:123`, `:159`.

**Tauri remains NOT_VALIDATED.** Ordinary web runtime selection uses WebSerial/WebBluetooth/WebSocket, rather than Tauri adapters (`src/js/serial.ts:179`, `:195`). No execution evidence was obtained for either platform.

These conclusions cover cooperating pages of the same browser origin only. They do not establish protection against external programs, other browsers, browser profiles or devices. Adapter delivery is not proof of FC receipt. Hardware qualification remains unvalidated.

P0_OPEN=0
P1_OPEN=0
P2_OPEN=1
REVIEW_COMPLETED=YES
VERDICT=REQUEST_CHANGES