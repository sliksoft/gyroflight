**VERDICT=REQUEST_CHANGES.** HEAD is exactly `20242d2cd94d3d492ba0d12f390e1bd5d001ff74`. No P0 defect was established by this inspection, but material P1/P2 issues remain OPEN.

This was static inspection of production source and existing tests. No tests, mutations, hardware actions, network research, agents, or writes were executed. Git reported only untracked `.serena/` and audit files. The six reviews were treated as leads, with findings independently checked against current source. **CLOSED below means a bounded source-level claim, not runtime acceptance.**

**Material findings**

1. **P1 — OPEN: AutoRestore reports success without successful save transmission.**

   **Evidence:** `src/js/msp.ts:398` invokes `onSent` before `serial.send`. `src/js/utils/AutoRestore.ts:279` sets `_saving=true`; line 289 reports success after the flush delay. Its disconnect handler also reports success whenever `_saving` is true (`:100`).

   **Scenario:** Restore reaches `save`; the transport returns zero bytes, throws, or leaves transmission pending beyond the flush delay. AutoRestore still reports success. The flasher then marks restoration complete and hides the restore action (`src/components/tabs/FirmwareFlasherTab.vue:1677`).

   **Safety effect:** Configuration persistence remains unproven while the UI reports completion. This does not establish that Gyroflight transaction uncertainty was cleared.

   **Coverage:** `test/gyrocore/wp8_final_acceptance_transport.test.ts:110` makes the transport return zero bytes; its success control at line 345 nevertheless expects success. Immediate refusal, deferred refusal and pre-dispatch disconnect are covered separately, but failed/short/pending delivery is not.

2. **P1 — OPEN: ordinary cross-tab writes do not participate in transaction locking.**

   **Evidence:** `src/composables/fcWriteGuard.ts:365` acquires the Web Lock for Gyroflight transactions. Ordinary admission at line 277 instead checks page-local activity and stored entries through `src/gyrocore/stores/fcTransactionState.ts:366`. The pending entry is created only at `src/composables/useTuneApply.ts:512`, after live reads and backup preparation.

   **Scenario:** Tab A holds the transaction lock and is reading the craft before persisting its entry. Tab B has no local transaction and sees no pending entry, so an ordinary SET, profile switch or save is admitted. It can change state between A’s individual reads or after an already-consumed read.

   **Safety effect:** The transaction’s snapshot and verification assumptions lack cross-tab exclusion; an EEPROM save can include configuration outside the verified scope.

   **Coverage:** `test/gyrocore/wp8_p0_closure_routes.test.ts:539` covers another write on the **same page** before entry persistence. Line 497 covers another transaction honoring the lock. Neither covers an ordinary writer in another real tab during that window.

   **Classification:** The software exclusion gap is confirmed. Simultaneous access to the same physical craft over Bluetooth/TCP is **NOT_VALIDATED**. This is not a demonstrated Web Serial dual-open bypass. Storage visibility adds uncertainty even after persistence.

3. **P1 — OPEN: WebSerial batching does not serialize whole sends.**

   **Evidence:** `src/js/protocols/WebSerial.ts:559` splits each send into 63-byte chunks and awaits each chunk at line 571. Concurrent `send()` calls independently enter that loop (`:590`); `src/js/serial.ts:347` adds no whole-send queue. This mode is selected for AT32 on macOS (`WebSerial.ts:553`).

   **Scenario:** Send A exceeds 63 bytes. Before its first chunk resolves, send B starts. The stream can receive A’s first chunk, B’s bytes, then A’s remaining chunks.

   **Safety effect:** MSP frames or guarded CLI clearing/text can interleave. Therefore the header’s general claim that admission order equals craft order (`src/composables/fcWriteGuard.ts:55`) is not established across transports.

   **Coverage:** The Bluetooth ordering test at `test/gyrocore/wp8_final_acceptance_transport.test.ts:419` exercises a different adapter. The inspected WebSerial tests do not cover concurrent batched sends. Actual firmware consequences are **NOT_VALIDATED**.

4. **P2 — OPEN: refused RXFAIL retries can leave Failsafe Save pending indefinitely.**

   **Evidence:** `src/js/msp/MSPHelper.ts:746` uses legacy callback MSP. Its refusal handler at line 750 only observes initial admission. On retry refusal, `src/js/msp.ts:617` returns without notifying that callback. `src/composables/failsafe/useFailsafeSave.ts:48` remains awaiting it.

   **Scenario:** Admit an RXFAIL write, lose its response, then introduce uncertainty before retransmission. The retry is correctly blocked, but the save promise never settles.

   **Safety effect:** Saving remains active while the original write may already have changed RAM. Its outcome must remain unknown.

   **Coverage:** Final-acceptance tests at lines 363 and 374 cover initial refusal. The “every RXFAIL entry” control at line 392 supplies no acknowledgement and asserts only the first frame. The retry test in `wp8_p0_closure_transport.test.ts:207` checks absence of retransmission, not caller termination.

5. **P2 — OPEN: Failsafe clears its dirty state before persistence succeeds.**

   **Evidence:** `src/composables/failsafe/useFailsafeSave.ts:58` calls `initializeDefaults()` before awaiting `saveAndReboot()`. That clears `configChanges` (`src/components/tabs/FailsafeTab.vue:453`), disabling Save through line 380.

   **Scenario:** All section writes are acknowledged, then EEPROM saving is refused or fails.

   **Safety effect:** The UI becomes clean although persistence failed or remains uncertain. Failure logging does not restore the dirty baseline.

   **Coverage:** `test/js/composables/failsafe/useFailsafeSave.test.ts:118` fails the first mocked write; it does not fail final persistence after baseline reset.

6. **P2 — OPEN: orphaned and unknown-scope transactions lack an in-app recovery path.**

   **Evidence:** `src/gyrocore/stores/fcTransactionState.ts:316` excludes `in_progress` entries from Restore coverage; line 319 requires exactly one known profile. `src/composables/useTuneApply.ts:1392` preserves unknown EEPROM state; line 1397 preserves unknown/multiple profile scope. Slider transactions deliberately record unknown scope (`:581`, `:732`, `:842`).

   **Scenario:** Close the page after pending persistence, or interrupt a slider write after transmission. Restart with the entry intact.

   **Safety effect:** Apply, ordinary writes and Restore remain blocked. This conservatively preserves uncertainty, but recovery availability is incomplete. Reboot or matching one profile must not be presented as recovery.

   **Coverage:** `test/gyrocore/wp8_p0_closure_routes.test.ts:351` and line 665 explicitly expect these states to remain unresolved. They demonstrate the limitation in the harness rather than close it.

7. **P2 — OPEN: backup retention’s unreadable-state fallback accepts structurally invalid records.**

   **Evidence:** `src/gyrocore/stores/tuneBackup.ts:98` accepts any parsed object containing a string `backupId`; pruning continues at line 129. The transaction reader rejects additional malformed shapes and mismatched identities (`src/gyrocore/stores/fcTransactionState.ts:156`, `:166`).

   **Scenario:** Fill the unverified backup quota, store `{"backupId":"b-0"}` under a transaction-entry key, then save another unverified backup. Retention protects only `b-0` and can evict another backup, although transaction state is unreadable.

   **Safety effect:** Evidence can be deleted while the affected transaction scope is unknown. The transaction guard still blocks writes; this is an evidence-retention defect.

   **Coverage:** `test/gyrocore/wp8_final_acceptance_evidence.test.ts:108` tests invalid JSON, not parseable invalid entries, identity mismatches or invalid legacy-list shapes.

8. **P2 — OPEN: CLI timeout draining does not isolate responses reliably.**

   **Evidence:** `src/js/msp.ts:206` discards all received bytes during draining, including MSP replies. `_process_cli_queue()` at line 362 does not check `cli_discarding`. The grace timer forcibly resets decoding and releases the next command (`:431`, `:437`).

   **Scenario:** Timeout a CLI request, then receive an MSP reply during draining; it is discarded. Alternatively, submit a fresh CLI command during draining, or deliver the old CLI reply after the grace period has released its successor.

   **Safety effect:** Replies can be lost or attributed to the wrong CLI request, weakening readback and completion/error reporting.

   **Coverage:** `test/js/msp_cli_queue.test.js:90` covers an old reply arriving within the drain period. Line 113 verifies forced progress, without checking attribution of a subsequently late reply or interleaved MSP traffic.

**Thirteen integration claims**

| # | Claim | Status and current source evidence |
|---|---|---|
| 1 | Central write classification defaults safely | **CLOSED, source only.** Unknown codes become writes at `src/composables/fcWriteGuard.ts:227`; uncertainty, unreadable storage and unknown connected UID are checked at `src/gyrocore/stores/fcTransactionState.ts:366`. Firmware semantics of every allowlisted read/runtime command remain **NOT_VALIDATED**. |
| 2 | All MSP admission, parked release and retries reauthorize | **CLOSED for inspected MSP dispatch.** `src/js/msp.ts:527`, `:613`, `:690`. Retry refusal uses a distinct error for promise callers, preserving possible first-attempt execution. Legacy caller settlement remains **OPEN**, finding 4. |
| 3 | MSP CLI rechecks queued commands and encoded-byte hazards | **CLOSED, source only.** Admission/release at `src/js/msp.ts:353`, `:370`; non-ASCII/control rejection at `src/composables/fcWriteGuard.ts:309`; low-byte `=` classification at `:229`. Tests inspect production encoding with mocked transmission. |
| 4 | Interactive raw CLI and AutoBackup command writes are guarded | **CLOSED for inspected command paths, with limits.** `src/composables/useCli.ts:333`; `src/js/utils/AutoBackup.ts:388`. Raw `#` entry bypasses classification (`useCli.ts:830`, `AutoBackup.ts:364`). `serial.send` itself is unguarded (`src/js/serial.ts:342`). Bootloader flashing also bypasses it (`src/js/protocols/webstm32.ts:602`); this is not an all-port write boundary. |
| 5 | Interactive CLI excludes framed MSP/MSP CLI during refusal | **CLOSED for the page-local `cliActive` condition.** `src/composables/fcWriteGuard.ts:262`, `:274`, `:330`. Initial-admission tests are at `test/gyrocore/wp8_final_acceptance_transport.test.ts:403`. Actual firmware mode synchronization and every retry/permit combination are **NOT_VALIDATED**. |
| 6 | Transport queues preserve safe order across Bluetooth and TCP | **OPEN / NOT_VALIDATED.** Bluetooth serializes calls at `src/js/protocols/WebBluetooth.ts:613`. Browser “TCP” selects WebSocket (`src/js/serial.ts:174`), whose send is at `src/js/protocols/WebSocket.ts:216`; Android TCP delegates to native code at `CapacitorTcp.ts:230`. Physical delivery/native ordering are unvalidated; WebSerial has finding 3. |
| 7 | Apply and Restore retain transaction ownership and uncertain outcomes | **CLOSED for inspected bookkeeping.** Pending persistence, per-write permit and settlement are at `src/composables/useTuneApply.ts:472`, `:512`, `:537`. EEPROM reply/readback handling is at `:1117`, `:1133`. Route tests use a firmware simulator and substitute MSP; physical transaction validity is **NOT_VALIDATED**. |
| 8 | AutoRestore success proves completion | **OPEN.** Queue refusal handling improved, but dispatch precedes delivery and no persistence readback establishes success: `src/js/msp.ts:398`, `src/js/utils/AutoRestore.ts:289`. Finding 1. AutoRestore is not the `useTuneApply` transaction protocol. |
| 9 | Web Locks protect against cross-tab interference before pending persistence | **OPEN.** Only transaction/check routes acquire the lock (`src/composables/fcWriteGuard.ts:365`); ordinary writes inspect storage/page-local activity (`fcTransactionState.ts:366`). Finding 2. |
| 10 | Restore clears only covered uncertainty | **CLOSED, source only.** `src/gyrocore/stores/fcTransactionState.ts:313`, `:339`; Restore permits recheck coverage at `src/composables/useTuneApply.ts:480`. Unknown profiles and orphaned pending entries remain unresolved. |
| 11 | Recovery is available and evidence is retained | **OPEN.** Missing backups remain unresolved (`src/composables/useTuneApply.ts:1389`); orphan/unknown scope has finding 6. Retention protects valid references and separates quotas, but malformed-state retention has finding 7. No recovery acceptance is established. |
| 12 | Denied saves terminate and UI never implies success | **OPEN.** Immediate RXFAIL refusal reaches rejection (`src/js/msp/MSPHelper.ts:750`), but findings 1, 4 and 5 remain. CLI cleanup’s boolean records accepted dispatch (`src/composables/useCli.ts:884`), not confirmed reboot. |
| 13 | Absolute Apply stays BLOCKED; test success does not release production | **CLOSED, source only.** `hardwareValidated:false` is fixed at `src/gyrocore/safety/absoluteEvaluate.ts:64` and adds a block at line 180; authority rejects at `src/gyrocore/releaseGate/writeAuthority.ts:164`. Successful route tests replace Safety/product/binding gates (`test/gyrocore/absolute_apply_route.test.ts:43`). These are transaction tests, not production release evidence. |

**Firmware and execution evidence limits**

The 256-DEL defense is **NOT_VALIDATED across supported CLI implementations**. Production assumes DEL deletes one character and clears a buffer no larger than 255 characters (`src/composables/fcWriteGuard.ts:333`). The test’s `firmwareRuns()` at `test/gyrocore/wp8_final_acceptance_transport.test.ts:212` implements those same assumptions in a handwritten editor model. It cannot establish firmware-version coverage, mode correctness, loss-free delivery, or actual reboot. This remains a material qualification gap rather than a demonstrated firmware bypass.

**M87–M93:** I inspected the corresponding regression-test code, not mutation execution. The untracked acceptance document reports M87/M88 for byte checks, M89/M90 for interactive-line handling, M91 for retention, and M92/M93 for CLI isolation (`docs/gyrocore/audit/autotune-v2/2026-10-24-wp8-final-acceptance.md:43`, `:49`, `:60`, `:70`). Those identifiers do not independently establish the exact mutant changes or their execution results. All seven mutation-kill claims remain **NOT_VALIDATED** in this review.

The earlier **5512 PASS, 0 FAIL, 14 SKIP** is reported history only, not independently rerun or confirmed here. Mocked serial calls, synthetic responses, Web Lock shims and simulator outcomes are not physical FC evidence.

**Tauri: separate NOT_VALIDATED.** Its serial adapter contains an internal resend (`src/js/protocols/TauriSerial.ts:769`) without central reauthorization. No protection is claimed against external programs, other browsers, other origins or devices.

**REVIEW_COMPLETED=YES**  
**VERDICT=REQUEST_CHANGES — source review completed; integration safety acceptance remains OPEN and runtime qualification NOT_VALIDATED.**

