Reviewed **only commit `5b7ca2b6d1437f44916db5dab5217ed7867003c9`**, using `git show` and necessary surrounding production source and existing tests. HEAD matches `20242d2cd94d3d492ba0d12f390e1bd5d001ff74`. Historical versions were used where HEAD differs.

No tests, hardware operations, network research, agents, or mutations were executed. Untracked audit reports were excluded. All conclusions below are **source inspection**, not execution evidence.

1. **P2 — OPEN: retention’s unreadable-entry fallback does not match the transaction store’s definition.**  
   **Location:** `src/gyrocore/stores/tuneBackup.ts:98–102`, `:129–132`; compare `src/gyrocore/stores/fcTransactionState.ts:150–166`.

   **Reproducible scenario:** Store 20 unverified backups, then put `{"backupId":"b-0"}` under a transaction-entry key. Save another unverified backup. The transaction store rejects that record because required fields and matching entry identity are missing. The new retention scanner accepts its string `backupId`, protects only `b-0`, and allows another old backup to be deleted.

   **Safety effect:** The commit’s promise that nothing is dropped while an entry cannot be read is incomplete for structurally invalid but parseable entries. This permits evidence deletion rather than conservative retention. It does **not** establish an MSP-write bypass: normal transaction checks reject unreadable state. Reachability through the complete write workflow was not executed.

   **Regression coverage:** `test/gyrocore/wp8_final_acceptance_evidence.test.ts:108` covers invalid JSON only. Missing coverage: parseable invalid entry, wrong entry identity, and invalid legacy-list shape.

2. **P1 — OPEN at the target revision, inherited surrounding limitation: AutoRestore can report success without sending the save.**  
   **Location:** `src/js/msp.ts:398–399`; `src/js/utils/AutoRestore.ts:279–289`; `src/js/serial.ts:342–353`.

   **Reproducible scenario:** With writes allowed, let the underlying transport return `{bytesSent: 0}` or throw while sending `save`. MSP calls `onSent` **before** calling `serial.send`; AutoRestore marks `_saving=true`, waits 500 ms, then reports success. The serial wrapper converts transport exceptions into `{bytesSent: 0}`, which this path ignores.

   **Safety effect:** The UI can claim a successful restore although EEPROM persistence was not established. “Dispatched to serial” is insufficient evidence of saving.

   **Regression coverage:** At this commit, `test/gyrocore/wp8_final_acceptance_transport.test.ts:106` stubs `serial.send` to return zero bytes; its success control at `:341` nevertheless expects success. It exercises production AutoRestore/MSP logic, but does not validate actual transmission or EEPROM contents. This issue is **not introduced by the retention change**.

3. **P2 — OPEN at the target revision, inherited surrounding limitation: refused RXFAIL write leaves Failsafe Save pending.**  
   **Location, target revision:** `src/composables/failsafe/useFailsafeSave.ts:47–49`; `src/js/msp/MSPHelper.ts:719–742`; `src/js/msp.ts:529–532`.

   **Reproducible scenario:** Acknowledge the initial RX and Failsafe writes, then introduce an uncertain transaction before `MSP_SET_RXFAIL_CONFIG`. The guard refuses the legacy `send_message` call and deliberately omits its completion callback. `sendRxFailConfig` ignores the return value, so the surrounding promise never settles.

   **Safety effect:** Save remains busy without reaching failure handling; earlier acknowledged RAM changes may remain. This is not proof of an EEPROM save or a safe recovery.

   **Regression coverage:** `test/js/composables/failsafe/useFailsafeSave.test.ts:12–14` mocks MSP, `sendRxFailConfig`, and reboot. Its failure case rejects `MSP.promise`; it cannot catch refusal inside the real callback helper. **Not introduced by this commit.**

The central retention repair is supported by inspection: unverified recovery snapshots no longer consume the trusted-target quota; referenced backups bypass eviction in both entry formats. The six added tests call the **real production backup store** over test localStorage, with manually constructed backups and transaction records. They do not drive real Restore attempts or firmware. **Runtime closure: NOT_VALIDATED.**

The requested adjacent checks have these limits:

- **Unicode/ASCII wire bytes:** The guard rejects non-ASCII/control characters during uncertainty, matching the MSP encoder’s low-byte hazard. Existing transport tests use real guard/MSP/CLI code with serial transmission stubbed. **NOT_VALIDATED on firmware.**
- **Delayed echo / 256 DEL / exit:** Production code prepends 256 DEL bytes before permitted interactive input during uncertainty. Existing delayed-echo tests interpret those bytes through their own `firmwareRuns` model, not production firmware. Exit does not establish saved configuration or resolve uncertainty. **NOT_VALIDATED on firmware.**
- **AutoRestore refused/deferred save:** Existing tests exercise production queue refusal and delayed dispatch; the premature-success limitation above remains.
- **CLI/MSP queue isolation:** Separate queues do not prove isolation. CLI draining discards all incoming bytes (`src/js/msp.ts:205–210`), including concurrent MSP replies; after its grace timeout, a late CLI response can reach the next command’s callback. Existing queue tests cover draining within the grace period and forced progress, not safe response attribution afterward. **NOT_VALIDATED.**

No protection is claimed against external programs or other browsers. Browser persistence, physical recovery, EEPROM outcomes, and Tauri remain **NOT_VALIDATED**. Uncertain recovery states remain uncertain.

**REVIEW_COMPLETED=YES**  
**VERDICT=OPEN — retention repair is supported but its conservative fallback is incomplete; end-to-end safety acceptance is not established.**