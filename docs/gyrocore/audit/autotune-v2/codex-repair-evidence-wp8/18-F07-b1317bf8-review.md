Reviewed only **b1317bf8**, its four changed files, and the surrounding recovery, storage, and lock code at that HEAD. **Four P2 findings; no P0/P1 established.** These are source-derived scenarios; no tests or probes were run.

1. **P2 — Restore is offered without a backup for the affected profile.**  
   **`src/gyrocore/recovery/transactionDiagnosis.ts:101–104`**

   Reproduce with one ended `absolute_apply` entry affecting profile `[1]`, and only a trusted absolute backup for profile `0`. `trustedTarget` checks provenance and route, but never compares `b.absolute.pidProfile` with the entry’s profile. `diagnoseCraft` therefore reports `verified_restore` and tells the user to restore a trusted backup “of that profile,” although none exists.

   Production refuses either choice: with profile `1` active, `readAbsoluteRestoreTarget` rejects the profile-0 backup (`useTuneApply.ts:1303`); with profile `0` active, `notCoveredByRestore` rejects the profile-1 entry through `coveredBy` (`fcTransactionState.ts:283`).

   **Safety effect:** false recovery availability and an impossible next step; the production block remains. The same predicate also accepts structurally invalid backups because `restoreTargetIssue` checks only provenance, while production separately validates snapshot contents.

   **Existing tests:** would not catch this. The positive fixture uses matching profile `0`; the two-profile test checks entry-to-entry consistency, not backup-to-entry compatibility. Its `absolute: { pidProfile: 0 }` fixture is also insufficient for production snapshot validation.

2. **P2 — A read-only check is offered when no single active profile can cover the craft.**  
   **`src/gyrocore/recovery/transactionDiagnosis.ts:125`**

   Reproduce with two ended entries for the same craft, both `saved: "no"`, with profiles `[0]` and `[1]`, no switch recorded, and each referencing its corresponding stored absolute backup. Both individually qualify, so `checkForAll` becomes true.

   However, `checkTransactionStateLocked` reads one identity and active profile, then requires that profile to match each entry’s backup (`useTuneApply.ts:1397–1404`). Whichever profile is active, one entry fails. The function returns before resolving **any** entries at line 1419. Repeating the check after switching profiles cannot progressively clear them.

   **Safety effect:** the advertised craft-wide recovery cannot succeed; instructions to power-cycle, reconnect, and check omit the actual incompatibility. Blocks remain.

   **Existing tests:** would not catch this. The two-profile case asserts only that Restore is unavailable. There is no equivalent case with `saved: "no"` asserting that the check must also be unavailable.

3. **P2 — The diagnosis action can write and remove transaction storage.**  
   **`src/gyrocore/components/UncertainStateNotice.vue:90`**

   `onDiagnose` calls `states.sync()`. That calls `readStorage`, whose legacy migration writes individual entries and removes `TRANSACTION_STORAGE_KEY` (`fcTransactionState.ts:123–127`).

   Reproduce after the store is initialized: retain a current entry so Diagnose is enabled, then have a legacy-format transaction list appear before the next synchronization. Clicking Diagnose can migrate that list, assign missing IDs, and delete its original storage key. A migration write failure can also latch `states.unreadable`.

   **Safety effect:** the explicitly read-only action changes persisted transaction representation and can change blocking state. This is not an established unlock, but contradicts “clears/changes nothing.”

   **Existing tests:** would not catch this. The storage-immutability test seeds only the current per-entry format before mounting; it never exercises a legacy list encountered by the diagnosis handler.

4. **P2 — Diagnosis survives craft changes and transaction changes without invalidation.**  
   **`src/gyrocore/components/UncertainStateNotice.vue:84–94`**

   Reproduce by diagnosing craft A with a recoverable entry, then connecting craft B with an unrecoverable entry while the panel remains mounted. `open` updates from the current UID, but `diagnosis` remains the array saved for A. The alert can therefore list B’s open transaction above A’s recovery instructions. A new blocking entry for the same craft likewise leaves the earlier recovery availability displayed.

   There is also an asynchronous inconsistency: entries and backups are evaluated before awaiting the lock query, with no revalidation afterward. Concurrent Diagnose requests can overwrite newer results with older snapshots.

   **Safety effect:** recovery guidance can describe the wrong craft or obsolete transaction set. Production authorization still applies, but the claimed “applied per craft” diagnosis is unreliable.

   **Existing tests:** would not catch this. The mounted test covers one craft, one click, and unchanged storage.

The lock query uses the same `FC_WRITE_LOCK` held around production transactions. I found no source-supported case where that query, at its snapshot instant, misses a continuously held lock of an app writer. It establishes only that **some** same-origin transaction/check holds the lock, not ownership of a particular entry. Its result can become stale; it is not continuing proof of orphanhood.

No new MSP-send or authorization-bypass path was established. The outside-recovery text explicitly acknowledges that Gyroflight cannot verify the manual step; diagnosis itself supplies no recovery evidence. Tauri remains **NOT_VALIDATED**. No protection against external programs, other browsers, or devices is claimed.

REVIEW_COMPLETED=YES
VERDICT=REQUEST_CHANGES