Reviewed **only `c8a37e0ef726d6ca7964827b7dae76af49c71cd2`**, using `git show` and historical production code/tests needed for its safety claim. HEAD matches **`20242d2cd94d3d492ba0d12f390e1bd5d001ff74`**. Untracked `.serena/` and audit reports were left unread.

All locations below refer to **the reviewed commit**, not current HEAD. No tests, hardware operations, mutations, network research, or agents were run.

**Findings**

1. **P1 — OPEN: deferred AutoRestore save can report success without being sent.**  
   `src/js/utils/AutoRestore.ts:265`, `:272`, `:279`; `src/js/msp.ts:357`.

   **Scenario:** keep an MSP CLI command in flight for more than 500 ms, then call `_finishWithSave([])`. Its `save` waits in `cli_queue`; `_finishWithSave` nevertheless reports success after 500 ms and disconnects, draining the queued command. A disconnect during this interval also becomes success solely because `_saving` is true (`AutoRestore.ts:100`).

   **Safety effect:** restore completion can be reported without persistence. Recovery must remain unverified.

   **Coverage:** `test/gyrocore/wp8_p0_closure_transport.test.ts:367` calls production AutoRestore and covers immediate refusal. It does not cover deferred save or disconnect before dispatch. This surrounding behavior is **unchanged by this commit**, not a newly introduced regression.

2. **P2 — OPEN: CLI cleanup still treats an attempted send as a reboot.**  
   `src/composables/useCli.ts:340`, `:341`, `:888`; `src/js/serial.ts:347`.

   **Scenario:** connection flags remain valid, but the transport rejects the `exit` write or returns zero bytes. `send()` immediately returns `true`; the serial facade subsequently invokes its callback even on failure. Cleanup therefore returns “rebooting” and invokes `reinitializeConnection()` without establishing delivery.

   **Safety effect:** the claimed reboot is unsupported; the FC may remain in CLI with its previous RAM state.

   **Coverage:** the new harness explicitly returns `{ bytesSent: 0 }` (`wp8_final_acceptance_transport.test.ts:105`), while tests expect cleanup to return `true`. The reconnect implementation is mocked. The patch closes **guard refusal → false reboot**, but does not close **transport failure → false reboot**. Transport-result handling was already absent.

3. **P2 — OPEN: backup retention does not protect recovery references or known-state targets.**  
   `src/gyrocore/stores/tuneBackup.ts:95`; `src/composables/useTuneApply.ts:1353`.

   **Scenario:** retain a known-state backup, then accumulate 20 newer backups for the same UID. Repeated Restore attempts that reach backup creation and fail afterward also contribute snapshots; during recovery these carry `stateKnown: false`. The oldest known-state backup is evicted regardless of transaction references or restore eligibility.

   **Safety effect:** recovery evidence or the usable restore target can disappear. A missing backup keeps the read-only recovery check unresolved (`useTuneApply.ts:1389`); this is recovery loss, not evidence of an unsafe automatic release.

   **Coverage:** inspected route tests cover provenance rejection and production Restore logic with mocked MSP. They do not establish retention under repeated failed recovery. **Unchanged surrounding limitation.**

4. **P2 — OPEN: Failsafe clears its dirty baseline before persistence succeeds.**  
   `src/composables/failsafe/useFailsafeSave.ts:57`; `src/components/tabs/FailsafeTab.vue:380`.

   **Scenario:** all configuration writes complete, `initializeDefaults()` runs, then `saveAndReboot()` rejects—for example because uncertainty appears before EEPROM dispatch. The save failure is logged, but the edited values already became the clean baseline, disabling Save until another edit.

   **Safety effect:** the UI can show no pending changes while persistence remains unverified.

   **Coverage:** `test/js/composables/failsafe/useFailsafeSave.test.ts:118` covers the first configuration write failing. MSP, MSPHelper, and reboot are mocked; failure after baseline reset is not covered there. **Unchanged surrounding limitation.**

**Assessment of the commit’s specific protection**

- **Delayed echo / 256 DEL / complete command — CLOSED at source level; execution NOT_VALIDATED.**  
  `fcWriteGuard.ts:315` generates exactly 256 `0x7f` characters. Under refusal, `interactiveCliText()` checks from an empty line and prefixes those bytes; `useCli.ts:347` selects the complete command instead of the echo-derived suffix. This addresses the described `sa<Tab>` → delayed echo → `save exit` construction, **conditional on the firmware editor and delivery assumptions**.

- **Unicode/ASCII wire agreement — CLOSED for the inspected guarded encoders; execution NOT_VALIDATED.**  
  `fcWriteGuard.ts:295` rejects completion and non-ASCII/control input while guarded. Raw CLI uses UTF-8; AutoBackup emits the ASCII prefix directly; MSP CLI truncates code points to bytes (`msp.ts:330`). Rejecting non-ASCII before guarded dispatch avoids the inspected Unicode-to-control-byte cases. Existing tests include queued Unicode rejection and low-byte `=` classification.

- **Immediate AutoRestore save refusal — CLOSED in inspected control flow; execution NOT_VALIDATED.**  
  A synchronous `WriteRefusedError` produces failure. This does not establish deferred-save completion, as finding 1 shows.

**Evidence and limits**

The new tests call production `useCli`, guard, transaction store, and MSP code. However, `serial.send` and reconnect behavior are replaced. `firmwareRuns()` (`wp8_final_acceptance_transport.test.ts:207`) is a handwritten editor model with a reduced command table—not production firmware. It cannot prove firmware buffer size, DEL handling, actual reboot, or transport delivery. AutoBackup’s existing tests inspect receive validation; they do not exercise its new guarded send route.

Queue tests call production MSP decoding with synthetic responses and mocked serial. They cover ordering, timeout, drain, and disconnect cleanup; they do not establish comprehensive CLI/MSP isolation or response attribution beyond the drain grace interval.

No confirmed new P0/P1 write bypass was identified in this commit’s diff. That is **not a runtime safety PASS**. Uncertain EEPROM, interrupted-write, and profile states remain uncertain. Protection against external programs or other browsers is not claimed. **Tauri: NOT_VALIDATED**, separately.

**REVIEW_COMPLETED=YES**  
**VERDICT=NOT_VALIDATED — the delayed-echo correction is supported by source inspection; execution proof is absent and the listed residual issues remain OPEN.**