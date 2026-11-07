No P0/P1/P2 findings remain for these two claims. Inspected HEAD `be798ce48239c1e0e1235b1eb3519b4cc6fa7a18` against its parent `3b9495f4`. This is source-inspection evidence; no tests were run.

1. **Transmission history survives ordinary tab cleanup.**  
   `src/js/msp.ts:1031` now cancels queued callbacks without clearing `write_transmissions`; clearing occurs at `disconnect_cleanup()` (`:1059`). The ordinary tab-switch route calls `callbacks_cleanup()` (`src/js/tab_adapters.ts:45`).

   Reproduction considered: save A retries; one ACK completes A, leaving another transmission unanswered; switch tabs; send save B; receive the delayed ACK. B is marked ambiguous when transmitted (`src/js/msp.ts:975`), and the response handler rejects it (`src/js/msp/MSPHelper.ts:225`). `saveEeprom()` consequently reports persistence **unknown**, rather than saved.

   **Ordinary-operation consequence:** yes, retaining history can cause a subsequent save after a tab switch to report unknown even when its own write succeeded. An unanswered same-code transmission remains relevant for its 4-second window. This is fail-closed: the write can occur, but its persistence is not falsely confirmed. A request already marked ambiguous stays ambiguous; repeated saves can prolong uncertainty by leaving further unanswered transmissions. A fresh request after those transmissions expire is not marked ambiguous by them. A normal, fully answered save leaves no history to cause this effect. I found no new authorization bypass or additional unbounded wait in this change.

2. **A throwing result callback releases the restore save wait.**  
   `src/js/utils/AutoRestore.ts:351` captures and removes the pending resolver before callback invocation. The new `finally` at `:384` invokes that captured resolver even when the callback throws. The callback exception can still propagate to its caller; it no longer strands `_finishWithSave()` awaiting cleanup. The persistence decision and write authorization are unchanged.

**Would the integration tests fail on the old production code?** By inspection, **both added regressions would fail if the production changes were reverted while retaining the tests**:

- `test/gyrocore/wp8_repair_integration.test.ts:154`: old cleanup erases A’s history, so B resolves successfully on the injected ACK instead of producing the expected `EepromSaveError`.
- `test/gyrocore/wp8_repair_integration.test.ts:207`: the throwing callback skips the old resolver invocation, leaving `finished` false at `:233`.

These tests exercise the production functions over a fake transport; they do not mock the functions under review. The restore test directly enters the save phase and stubs disconnect, so it is not evidence of actual transport teardown or hardware behavior. A literal whole-commit revert also removes these added tests.

Approval is limited to these two repair claims. Tauri remains **NOT_VALIDATED**.

P0_OPEN=0
P1_OPEN=0
P2_OPEN=0
REVIEW_COMPLETED=YES
VERDICT=APPROVE