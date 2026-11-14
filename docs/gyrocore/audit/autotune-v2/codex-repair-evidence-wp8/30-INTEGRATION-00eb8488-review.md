**REQUEST_CHANGES.** At `00eb8488bc5f042a2aa04a2848ef992e83ae4e51`, I found **two P1 issues and one P2 issue** in the integrated result.

I inspected the repair range `20242d2c..HEAD`, production callers, and regression-test source. **No tests, hardware actions, network access, agents, or modifications were used.** The checkout is detached; the pre-existing untracked `.serena/` directory remains unchanged. All findings below are source-derived, not reproduced execution results.

**R1 — P1: an earlier MSP ACK can acknowledge a later write, including an unsent EEPROM request.**

`src/js/msp/MSPHelper.ts:444` settles every waiter matching the response’s command code. It does not establish which transmission produced the answer or whether the current waiter’s bytes reached the transport. Requests become eligible for replies before delivery (`src/js/msp.ts:773`), while `stillWanted` subsequently drops their bytes once their callback entry has disappeared (`src/js/msp.ts:927`).

Concrete scenario:

1. An EEPROM request is retried.
2. One ACK completes that save; another ACK remains delayed.
3. Configuration changes, and a subsequent EEPROM request waits behind another send.
4. The delayed ACK settles the new request before it is transmitted.
5. `eepromReplyState()` reports `"saved"` (`src/js/msp/eepromSave.ts:48`), and the queued request is dropped.

The same command-code ambiguity affects consecutive RXFAIL channel writes (`src/js/msp/MSPHelper.ts:750`). The EEPROM contract checks CRC, direction, firmware refusal, and retry history, but those checks do not correlate an ACK with the configuration being saved.

Post-save RAM comparison does not close this gap: `src/composables/useTuneApply.ts:369` can read the newly edited RAM even when the supposed EEPROM request never ran.

The inspected tests cover missing replies, refusals, echoes, retries, and attached waiters, but not a duplicate ACK crossing into a later operation. Required repair: preserve uncertainty across ambiguous response histories and prevent an earlier answer from proving a later save. Add an adversarial delayed-duplicate-ACK case through the real queue.

**R2 — P1: AutoRestore continues issuing commands after reporting failure and cleaning up.**

`src/js/utils/AutoRestore.ts:211` converts command errors—including cancellation on disconnect—into `null`. The loop continues at line 223, with no operation-generation, cancellation, or connection-identity check before the next command or final save.

Meanwhile, `_cleanup()` nulls the callback and disconnects (`src/js/utils/AutoRestore.ts:336`), but does not cancel that loop. FirmwareFlasher releases its connection lock when the callback reports failure (`src/components/tabs/FirmwareFlasherTab.vue:1672`).

A long restore interrupted early can therefore keep traversing its remaining commands after the failure dialog. If a successor connection becomes available while it continues, newly submitted old commands belong to that connection’s queue. The serial generation check only rejects sends already queued on the old connection; it cannot identify fresh submissions from an obsolete restore.

There is also a newly introduced unresolved-wait path: the abandoned loop reaches `_finishWithSave()`, installs `_whenCleanedUp`, and awaits it (`src/js/utils/AutoRestore.ts:279`); subsequent `_cleanup()` returns immediately because `_callback` is already null.

The save-evidence tests invoke `_finishWithSave()` directly (`test/gyrocore/wp8_repair_save_evidence.test.ts:106`). They do not exercise interruption of the complete command loop followed by reconnection. Required repair: bind every continuation and callback to one restore generation, terminate on cancellation, and settle its completion independently of the UI callback.

**R3 — P2: the send queue releases a successor before CLI delivery failure invalidates the session.**

`src/js/serial.ts:381` advances the queue from the transport result. CLI interpretation of that result happens later, through the returned promise’s handler (`src/js/msp.ts:509`).

Consider timed-out command A whose late ETX releases command B while A’s transport result is still pending. When A finally reports a short send, B’s serial-queue continuation can run before `_cli_delivered(A)` sets `cli_session_uncertain`. B can consequently pass `stillWanted` and reach the transport.

The subsequent session-loss path labels in-flight B with `CliSessionUncertainError`, whose `notSent` property is always true (`src/js/msp.ts:112`, `src/js/msp.ts:443`). If B is `save`, `saveOnce()` can report `"not_saved"` despite possible transmission (`src/composables/useMspCliSession.ts:303`).

The nearby regression deliberately inserts another blocked send between A and B (`test/gyrocore/wp8_repair_review_transport.test.ts:296`); it misses the immediate-successor ordering. Required repair: invalidate the CLI session before releasing the next send, and distinguish unsent queued commands from possibly transmitted in-flight commands.

The requested F01–F10 disposition follows. **CLOSED means bounded source-level closure of the stated defect, not executed validation.** “Revert-sensitive” means the identified assertions are expected to fail if the original repair is reverted; I performed no mutation testing.

| Finding | Status and production evidence | Revert-sensitive tests, by inspection |
|---|---|---|
| **F01 AutoRestore false success** | **OPEN, integrated scope.** Disconnect/time alone no longer prove success: `src/js/utils/AutoRestore.ts:322`; CLI save result handling: `src/composables/useMspCliSession.ts:286`. The complete restore lifecycle remains unsafe under R2. | **Expected yes** for the original false-success repair: `test/gyrocore/wp8_repair_save_evidence.test.ts:139`, `:156`, `:178`. Full-loop cancellation/reconnection is missing. |
| **F02 cross-tab transaction exclusion** | **CLOSED, bounded to cooperating pages of this origin.** Exclusive lease surrounds the transaction: `src/composables/fcWriteGuard.ts:400`; foreign-write admission checks shared ownership: `:263`; yielding waits for transport activity and saves: `src/composables/fcWriteLease.ts:157`, `src/js/msp.ts:1222`. | **Expected yes:** `test/gyrocore/wp8_repair_cross_page.test.ts:86`; browser test uses the app’s module instances at `test/browser/crossTabWriteLease.browser.mjs:64`. Neither suite was run. |
| **F03 WebSerial batch interleaving** | **CLOSED for whole-send FIFO and connection-bound batches.** `src/js/protocols/WebSerial.ts:575`, `:602`; facade queue and admission recheck: `src/js/serial.ts:368`. R3 concerns outcome ordering, not interleaving frame chunks. | **Expected yes:** `test/js/webserial_send_queue.test.ts:118`, `:137`, `:174`; late-send suppression at `test/gyrocore/wp8_repair_review_transport.test.ts:126`. |
| **F04 EEPROM false success** | **OPEN.** Original disconnect handling is repaired through `src/js/msp/eepromSave.ts:92` and `src/js/msp/MSPHelper.ts:847`, but ACK attribution remains unsafe under R1. | **Expected yes** for original repair: `test/gyrocore/wp8_repair_eeprom_save.test.ts:129`, `:142`, `:265`. Duplicate-ACK crossover is missing. |
| **F05 refused RXFAIL retry hangs** | **CLOSED for termination.** RXFAIL uses error-aware sequential writes (`src/js/msp/MSPHelper.ts:750`); refused retries reject (`src/js/msp.ts:813`); Failsafe propagates failure (`src/composables/failsafe/useFailsafeSave.ts:61`). | **Expected yes:** `test/gyrocore/wp8_repair_failsafe_save.test.ts:165`, `:177`, `:192`. |
| **F06 premature Failsafe clean state** | **CLOSED for baseline timing and edit exclusion**, subject to R1’s ACK correctness. Payloads and baseline are captured at save start; baseline commits through `onSaved` (`src/composables/failsafe/useFailsafeSave.ts:47`, `:69`). Fields are disabled and inert (`src/components/tabs/FailsafeTab.vue:7`). | **Expected yes:** `test/gyrocore/wp8_repair_failsafe_save.test.ts:260`; `test/components/FailsafeTab.test.ts:108`, `:129`. |
| **F07 orphan/unknown-scope recovery** | **CLOSED as diagnosis and guidance only.** Orphans and unsupported scope remain blocked; no in-app recovery is invented (`src/gyrocore/recovery/transactionDiagnosis.ts:82`, `:128`). Unreadable-store latch suppresses recovery offers (`src/gyrocore/components/UncertainStateNotice.vue:112`). | **Expected yes:** `test/gyrocore/wp8_repair_recovery_diagnosis.test.ts:99`, `:163`, `:255`. This does not establish recovery availability for every entry. |
| **F08 invalid-record retention** | **CLOSED for consistent parsing and retention.** Both consumers use `readTransactionRecords()` (`src/gyrocore/stores/transactionRecords.ts:104`); unreadable records prevent pruning (`src/gyrocore/stores/tuneBackup.ts:98`, `:125`). Migration rejects conflicting IDs. | **Expected yes:** malformed-record matrix at `test/gyrocore/wp8_repair_backup_retention.test.ts:98`, assertions at `:129`, collision cases at `:212`. |
| **F09 CLI drain isolation** | **OPEN, integrated scope.** MSP frames survive drain and missing ETX makes the session uncertain (`src/js/msp.ts:602`, `:1016`), but R3 permits a successor to precede failure invalidation. | **Expected yes** for original isolation repair: `test/js/msp_cli_drain_isolation.test.ts:95`, `:109`, `:135`. Immediate-successor ordering is missing. |
| **F10 CLI exit failure** | **CLOSED for the inspected handoff.** Only whole delivery starts reboot; timeout/short delivery drops the link, prevents a second exit, and checks connection generation (`src/composables/useCli.ts:910`, `:919`). | **Expected yes:** `test/gyrocore/wp8_repair_cli_exit.test.ts:124`, `:148`, `:164`, `:184`. |

The broader safety claims need these bounds:

- **Authorization:** the inspected MSP and CLI configuration routes reach the guard, and Gyroflight transactions require exclusive ownership plus their permit (`src/composables/fcWriteGuard.ts:282`). R2 nevertheless allows obsolete restore work to submit fresh writes. An unconditional authorization claim is therefore unsupported. RTC, arming-state, motor-test, and reboot requests are explicit runtime exceptions (`:223`).
- **Persistence:** disconnect, elapsed time, request echoes, and firmware error replies are no longer sufficient for success. **R1 still permits unproven persistence to be reported as saved.**
- **Uncertainty:** ordinary reconnect/reboot/time does not clear transaction records. Restore coverage rejects in-progress and unknown/multiple-profile entries (`src/gyrocore/stores/fcTransactionState.ts:275`). Read-only resolution requires saved `"no"` and matching scoped readback (`src/composables/useTuneApply.ts:1386`). These checks do not repair incorrect persistence evidence entering the system.
- **Absolute Apply remains BLOCKED:** `hardwareValidated: false` at `src/gyrocore/safety/absoluteEvaluate.ts:64` contributes an unconditional block at `:180`; `src/gyrocore/releaseGate/writeAuthority.ts:123` consumes Safety authorization.
- **Tauri remains NOT_VALIDATED.** Its native resend exists at `src/js/protocols/TauriSerial.ts:756`. Ordinary web transport selection uses WebSerial/WebBluetooth/WebSocket (`src/js/serial.ts:189`), outside that native retry route.
- The lease covers cooperating pages within the same browser-origin lock/storage scope. This review claims no protection against external programs, other browsers, other browser profiles, or devices.

P0_OPEN=0
P1_OPEN=2
P2_OPEN=1
REVIEW_COMPLETED=YES
VERDICT=REQUEST_CHANGES

