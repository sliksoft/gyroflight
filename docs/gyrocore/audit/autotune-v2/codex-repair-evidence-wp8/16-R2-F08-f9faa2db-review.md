**P2 — F08’s unreadable-storage false success remains possible after the new guard.**  
`src/composables/useTuneApply.ts:1380–1381,1418`

The new check at lines 1373–1375 covers storage that is already unreadable. It does not cover storage becoming unreadable during `await readIdentity()`.

Reproducible fault-injection scenario, derived from source inspection:

1. Initialize the production transaction store with readable, empty storage.
2. Start `checkTransactionState()` with valid FC identity responses.
3. During an awaited identity response, make transaction-storage reads throw, representing storage access becoming unavailable.
4. Let identity reading finish.

The second `states.sync()` encounters the failure. `fcTransactionState.ts:157–160` latches `unreadable = true` and retains the previous empty entries. The caller does not inspect that latch again: `forUid()` returns an empty list, and line 1418 returns `{ resolved: true, reasons: [] }` **while the store is unreadable**.

**Safety effect:** the state-check API still gives false assurance that uncertainty is resolved. The separate write guard continues blocking on `unreadable`; this scenario does **not** demonstrate write authorization bypass or deletion of evidence. That keeps the finding at P2.

**Test coverage:** the new test at `test/gyrocore/wp8_repair_backup_retention.test.ts:242–247` supplies malformed storage before calling the check. It exercises only the initial guard and would remain satisfied with the above defect present. The existing late-entry test at `test/gyrocore/wp4_evidence_integrity_write.test.ts:728–747` injects a readable entry during snapshot reading, rather than a storage failure during identity reading. Neither covers this scenario. A regression test should exercise the real check and store, inject the failure during identity reading, and require `resolved: false`.

The collision repair addresses the supplied round-1 scenarios **by source inspection**:

- `transactionRecords.ts:111–112` rejects duplicate resolved IDs, including collisions between explicit IDs and generated legacy IDs.
- Lines 113–115 reject destinations containing different serialized content before migration writes begin.
- `fcTransactionState.ts:124` uses the same ID resolver during migration.
- Backup retention consumes the same parser; rejection makes it retain backups (`tuneBackup.ts:98–101,125`).

The two new negative collision tests exercise the production store and storage. From the parent implementation, reverting the collision guards would invalidate their assertions: migration would overwrite entries instead of reporting unreadable storage. This is a static assessment, not an executed mutation test. The same-content test is a compatibility control and also matches the parent’s behavior.

I found no additional concrete P0/P1 defect or newly introduced hang, deadlock, or authorization bypass in the inspected scope. The remaining P2 means the claimed unreadable-storage fix is incomplete.

Reviewed `git show f9faa2db` and necessary surrounding production code/tests at confirmed HEAD `b1317bf855140966c1bbc6304f13b78b4373452f`. The four scoped files have no subsequent differences from the reviewed commit. No tests, network access, hardware actions, source changes, or agents were used. Tauri: **NOT_VALIDATED**.

REVIEW_COMPLETED=YES
VERDICT=REQUEST_CHANGES