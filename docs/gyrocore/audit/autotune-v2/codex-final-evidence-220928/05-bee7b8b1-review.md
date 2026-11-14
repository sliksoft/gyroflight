Reviewed **only `bee7b8b1239bb3137b400ca29d2e902db3d8bd55`**, using `git show` and minimally necessary historical production source and existing tests.

Checkout HEAD matched **`20242d2cd94d3d492ba0d12f390e1bd5d001ff74`**. Untracked `.serena/` and audit reports were excluded. No tests, hardware, network research, agents, or mutations were performed. All line references below refer to **the reviewed commit**, not current HEAD.

**No newly introduced P0/P1 production defect was established. The direct-refusal fix is supported by source inspection, with the following remaining gaps.**

- **P2 — OPEN: RXFAIL retry refusal can still leave Failsafe saving indefinitely.**  
  `src/js/msp/MSPHelper.ts:746–750`; supporting path `src/js/msp.ts:613–619`.

  **Scenario:** Start Failsafe saving while writes are allowed. An RXFAIL request is queued and transmitted, but its response never arrives. The craft becomes uncertain before the retry timeout. `_on_timeout()` refuses retransmission, clears the timer, and returns without notifying the legacy callback. The newly added `onRefused` only checks the synchronous `send_message()` return; that return was already `true`.

  **Safety effect:** Retransmission is blocked, but the save remains pending and `isSaving` remains true. The original write may have executed; its outcome must remain unknown. No later EEPROM write or success is established.

  **Coverage:** Added tests cover refusal before the first RXFAIL transmission, not refusal of an already transmitted request’s retry. A missing regression scenario should drive real MSP handling through the timeout and verify termination without claiming that the first attempt did not execute.

  **Attribution:** This is an inherited limitation left unresolved by this commit, not a newly introduced regression.

- **P2 — OPEN: The added “every RXFAIL entry” test never exercises chain progression.**  
  `test/gyrocore/wp8_final_acceptance_transport.test.ts:390–395`.

  **Scenario:** Configure two RXFAIL entries and never deliver an acknowledgement. The test expects exactly one transmitted RXFAIL frame and finishes.

  **Safety effect:** The test cannot detect broken second-channel dispatch, failure to notify refusal between RXFAIL channels, or premature/missing completion. Those are relevant to the changed callback wrapper.

  **Coverage:** Missing assertions include first acknowledgement → second payload, uncertainty before second dispatch → refusal without completion, and final acknowledgement → exactly one completion. The unchanged upstream suite mocks `sendRxFailConfig` entirely (`test/js/composables/failsafe/useFailsafeSave.test.ts:12–14`), so it does not fill this gap.

**Direct-refusal claim — CLOSED by source inspection only; execution NOT_VALIDATED.**

At `src/js/msp/MSPHelper.ts:744–750`, a synchronous guard refusal returns `false` without invoking the response callback, causing `onRefused` to run. `useFailsafeSave.ts:48–50` bridges that into rejection. `useSaving.ts:103–107` reports failure and releases `isSaving`. Subsequent feature writes, baseline reset, and save/reboot are skipped.

This does **not** establish rollback of earlier acknowledged writes or resolve an existing uncertain transaction.

The surrounding checks establish these narrower observations:

| Area | Inspected production behavior and existing coverage | Status |
|---|---|---|
| CLI Unicode/ASCII bytes | `fcWriteGuard.ts:282–308` rejects non-ASCII/control text while writes are refused. This addresses low-byte truncation in `msp.ts:332–343`. Existing transport tests inspect encoded bytes with `serial.send` mocked. | Source-supported; execution **NOT_VALIDATED** |
| Delayed echo / 256 DEL / exit | `fcWriteGuard.ts:315–331` prefixes accepted interactive text with 256 DEL bytes. `useCli.ts:330–348` sends the complete checked command rather than an echoed-buffer suffix. Tests use a handwritten firmware line-editor model, not firmware execution. | Firmware behavior **NOT_VALIDATED** |
| AutoRestore refused/deferred save | `AutoRestore.ts:269–286` waits for queue dispatch and fails refused or drained saves before dispatch. Existing tests call the real `_finishWithSave`, but mock transport/disconnect. `onSent` runs **before** `serial.send` (`msp.ts:398–399`), so it proves dispatch intent, not successful delivery or persistence. | Refusal handling source-supported; actual save **NOT_VALIDATED** |
| Backup retention/evidence | `tuneBackup.ts:91–108,125–145` protects referenced backups, separates trusted/other retention quotas, and disables pruning when transaction entries cannot be read. Existing evidence tests exercise the production store over jsdom storage. | Source-supported; durable recovery **NOT_VALIDATED** |
| CLI/MSP isolation | At this historical commit, `mspRequestRefusal` classifies requests without checking interactive CLI state (`fcWriteGuard.ts:249–256`); MSP CLI admission likewise lacks that session check (`:308`). Therefore the raw CLI protection alone does not establish isolation from framed traffic sharing an interactive CLI session. This is unchanged context, not a regression introduced here. | **OPEN** boundary; firmware consequences **NOT_VALIDATED** |

The new Failsafe failure test exercises real `useFailsafeSave`, `useSaving`, `sendRxFailConfig`, and immediate MSP guard refusal. However, it mocks **all `MSP.promise` calls**, including the writes preceding RXFAIL (`wp8_final_acceptance_transport.test.ts:374–378`). It therefore does not demonstrate a complete production save exchange. No test results were independently reproduced.

Scope excludes a full autotune/write-gate audit, physical persistence, reconnect/readback qualification, and protection from external programs or other browsers. **Tauri is separate: NOT_VALIDATED.** Later HEAD changes receive no credit for this historical commit.

**REVIEW_COMPLETED=YES**  
**VERDICT=PARTIAL — direct-refusal fix supported by inspection; full Failsafe failure closure remains OPEN, runtime safety NOT_VALIDATED.**