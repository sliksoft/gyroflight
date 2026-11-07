**P2 — Diagnose can offer recoveries that the transaction store permanently refuses after a storage failure.** `src/gyrocore/components/UncertainStateNotice.vue:110–120`

The new code treats a successful `readTransactionRecords()` as sufficient to offer recoveries, without checking `states.unreadable`. That flag is deliberately latched: subsequent successful storage reads do not clear it (`src/gyrocore/stores/fcTransactionState.ts:150–160`).

Reproducible scenario, derived from source:

1. Start with an ended absolute transaction, `saved: "no"`, one profile, and a complete trusted backup matching that profile.
2. A transient storage read failure during `states.sync()` sets `states.unreadable = true`.
3. Storage becomes readable again, retaining the same transaction and backup.
4. Click Diagnose.

The raw read succeeds, so Diagnose advertises `verified_restore` and `read_only_check`. However, Restore rejects the latched unreadable state in `src/composables/useTuneApply.ts:593`, and Check returns unresolved for that same state at line 1375. The advertised recovery is unavailable in this page.

The related stale-display case also remains: if the diagnosis already exists when `unreadable` becomes true without changing entries, the new watcher does not invalidate it because its dependencies exclude `states.unreadable` (`UncertainStateNotice.vue:94`).

**Safety effect:** misleading recovery instructions during a storage-integrity failure. The inspected routes continue to block recovery; this is not evidence of a write-authorization bypass.

**Tests:** the added tests would not catch either scenario. They never latch the transaction store unreadable and then restore readable storage, or transition that flag after displaying a diagnosis. The diagnosis should respect that latch and invalidate when it changes.

The other round-2 repairs are supported by the inspected code:

- **Restore profile/completeness:** the predicate now requires an absolute entry and a trusted absolute backup matching its profile and passing `absoluteSnapshotIssues`. This matches the relevant target-validation checks in `readAbsoluteRestoreTarget`. The new wrong-profile and incomplete-backup tests exercise the real diagnosis function; reverting those guards would contradict their assertions.
- **Check across two profiles:** `diagnoseCraft` now requires one common profile. The added two-profile test would detect removal of that condition.
- **Legacy migration:** Diagnose now calls the non-mutating reader, and backup reload only reads storage. The new component test introduces legacy data after mounting and checks that Diagnose leaves storage unchanged; restoring the former `states.sync()` call would migrate that data and violate the assertion.
- **Craft changes and concurrent runs:** the watcher clears the diagnosis when the observed UID or entries change, and the run token prevents an older asynchronous invocation from publishing after a newer one. The craft-change test checks completed-result invalidation. **No added test exercises entry-change invalidation, a pending run during a craft change, or out-of-order concurrent completions.** Removing the run-token protection would therefore not be detected by these tests.

I found no concrete new deadlock, unresolved-promise path, false transaction success, or write-authorization bypass in the reviewed change. This conclusion is source inspection only: no tests, hardware actions, network access, modifications, or agents were used. HEAD was verified as `e03cbc48a05e7359976bf175db622388634afb7b`; review covered that commit and the necessary surrounding production code and tests. Tauri remains **NOT_VALIDATED**.

REVIEW_COMPLETED=YES
VERDICT=REQUEST_CHANGES