Review of **`d14f2cecb8a26c4fad1bae7b32b7e5a2a7d12fdd` only**, using `git show` and narrowly relevant historical production source/tests. HEAD matches **`20242d2cd94d3d492ba0d12f390e1bd5d001ff74`**. Untracked audit reports were not read or treated as evidence.

All line references below refer to **d14f2cec**, not current HEAD. Findings are source-derived scenarios; none were executed.

1. **P1 — OPEN: `onSent` does not establish successful transmission.**  
   **`src/js/msp.ts:398`**, **`src/js/utils/AutoRestore.ts:279`**, **`:289`**.

   `_process_cli_queue()` invokes `onSent` **before** calling `serial.send()`. AutoRestore consequently sets `_saving=true` and starts its 500 ms success timer without checking transmission completion or byte count.

   **Reproducible scenario:** restore reaches `save`; WebSerial has lost its writer, or `writer.write()` fails. Production WebSerial returns `{ bytesSent: 0 }` (`src/js/protocols/WebSerial.ts:580–607`). MSP ignores that result. With no disconnect event, AutoRestore reports success after 500 ms; with a disconnect while `_saving` is true, it also reports success.

   **Safety effect:** persistence remains unconfirmed, but the flasher logs successful restoration and hides its retry button (`src/components/tabs/FirmwareFlasherTab.vue:1677–1683`). Queue dispatch must not be treated as verified save/reboot evidence.

   **Regression coverage:** the new tests exercise real AutoRestore/MSP/guard code, but their common serial mock returns **zero bytes** (`test/gyrocore/wp8_final_acceptance_transport.test.ts:106`). The success control nevertheless expects success (`:341–347`). Thus the existing test encodes this gap rather than detecting it. Missing cases include failed/short/pending transmission and unrelated disconnect after dispatch. Complete transport transmission would still not independently prove EEPROM persistence.

2. **P2 — OPEN, pre-existing surrounding code; not introduced by this commit: Failsafe can remain “Saving” after a refused RXFAIL write.**  
   **`src/composables/failsafe/useFailsafeSave.ts:47`**, **`src/js/msp/MSPHelper.ts:742`**.

   **Reproducible scenario:** configure at least one RXFAIL entry; acknowledge the first two Failsafe SETs, then introduce an uncertain transaction before RXFAIL dispatch. `sendRxFailConfig()` uses callback-based `MSP.send_message()`. The guard refuses the write without invoking its callback (`src/js/msp.ts:529–532`), leaving the promise at line 47 unresolved.

   **Safety effect:** saving remains active indefinitely; earlier writes may already have changed RAM, while persistence and completion remain unresolved. This must retain an uncertain recovery interpretation.

   **Regression coverage:** `test/js/composables/failsafe/useFailsafeSave.test.ts:12–14` mocks MSP, MSPHelper and reboot. Its write-failure test rejects `MSP.promise`; it does not exercise production RXFAIL refusal. This commit does not change or close that path.

The commit’s narrow refusal/deferred-save correction is **CLOSED by source inspection only**: immediate refusal, refusal at eventual dispatch, and disconnect while save remains queued now reach failure rather than premature success. The four added tests at `test/gyrocore/wp8_final_acceptance_transport.test.ts:292–349` cover those branches and a success control using production queue/restore code. They bypass connection setup by assigning `_callback` and calling `_finishWithSave()` directly. Serial send/disconnect are mocked and time is simulated. **Execution validation: NOT_VALIDATED.**

Relevant surrounding checks and limits:

- **Unicode/ASCII wire bytes — inspected; runtime NOT_VALIDATED.** The MSP CLI encoder truncates code points into bytes (`src/js/msp.ts:332–343`). Under refusal conditions, the guard rejects non-ASCII/edit controls before enqueue and again at dispatch (`src/composables/fcWriteGuard.ts:287–308`). Existing Unicode-smuggling tests exercise production encoding/guard logic against captured mock-send arguments, not firmware receipt.
- **Delayed echo, 256 DEL and exit — inspected; firmware behavior NOT_VALIDATED.** The interactive path prepends 256 DEL bytes and sends the complete command under refusal conditions (`fcWriteGuard.ts:315–331`; `src/composables/useCli.ts:330–348`). Existing delayed-echo tests use a handwritten `firmwareRuns()` line-editor model (`test/gyrocore/wp8_final_acceptance_transport.test.ts:208`), not production firmware. Reboot scheduling is mocked; test wording describing a “real” reboot is not execution evidence.
- **Backup retention/evidence — limited inspection.** AutoRestore cleanup does not delete the captured backup; the flasher failure branch does not mark restoration complete. The captured backup is an in-memory ref (`src/js/utils/AutoBackup.ts:43–54`). Durable retention, backup provenance and broader tune-backup evidence guarantees are **NOT_VALIDATED** by this commit review.
- **CLI/MSP queue isolation — NOT_VALIDATED.** CLI requests serialize through `cli_in_flight`, while MSP dispatch uses a separate callback/parking mechanism (`src/js/msp.ts:362`, `:516–586`). The added tests do not establish mutual exclusion between these paths or safe mixed-response handling.
- No protection is established against external programs, other browsers or devices. **Tauri: separate NOT_VALIDATED.**

No P0 finding identified within this inspection. No tests, hardware actions, network research, agents, source changes or Git mutations were performed. No execution or flight-safety PASS is claimed.

**REVIEW_COMPLETED=YES**  
**VERDICT=REQUEST_CHANGES — P1 false-success path remains OPEN.**