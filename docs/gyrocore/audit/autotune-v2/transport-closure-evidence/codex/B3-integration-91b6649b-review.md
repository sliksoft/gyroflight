**REQUEST_CHANGES:** F01–F10 remain closed for their bounded software contracts, but the final WebSerial cancellation repair introduces one P2 availability regression that blocks connect/reconnect acceptance.

Reviewed detached HEAD `91b6649b417095679ab514a1af05a487cf4e46ff` against `20242d2c`, including the requested commit log and the effective changes after both reverts. Tracked files remained clean; `.serena/` and the audit directory were untracked. Evidence below is source and test-code inspection only: **no tests, hardware actions, network access, or agents were used.**

**New finding — P2: cancelled, rejected WebSerial open poisons the next connection**

**Anchors:** `src/js/protocols/WebSerial.ts:447`, `:466`, `:397`, `:542`.

Reproducible sequence, inferred from source:

1. Start `connect()` with `port.open()` pending.
2. Call `disconnect()`. It sets `openCanceled=true` and waits for opening to settle.
3. Reject `port.open()`, for example following device removal. Since `this.port` is assigned only after successful opening (`:364`), it remains null.
4. The deferred teardown reaches `if (!port) return true` at `:466`. This returns before the `finally` that clears `openCanceled` at `:542`.
5. Reconnect after the device becomes available. A successful `port.open()` now enters the stale cancellation branch at `:397`, reports connection failure, and returns without closing the newly opened port. Its comment assumes an outstanding cancelling disconnect owns closure, but that disconnect already completed in step 4.

**Effect:** a valid connection is rejected and its port remains open with reader/writer acquired. Ordinary `onOpen(false)` calls `abortConnection()` and `resetConnection()` (`src/js/serial_backend.ts:969`, `:814`), which do not close that transport. Another connect attempt can recover through the retained-port cleanup, but the first otherwise-valid reconnect fails unnecessarily.

This is an **availability defect, not an established unsafe-write or false-save defect**. It **blocks acceptance** of the requested connect/disconnect/reconnect repair.

**Would tests catch it?** The inspected cancellation tests at `test/gyrocore/wp8_transport_closure.test.ts:493` and `:517` resolve the pending open successfully. They do not reject a cancelled open and then reconnect; they would not catch this sequence. Nothing was executed.

| Finding | HEAD status from source inspection | Production anchors and retained protection |
|---|---|---|
| F01 — CLI restore/save success | CLOSED | `src/js/utils/AutoRestore.ts:294`, `:334`; `src/composables/useMspCliSession.ts:286`. Success requires firmware save evidence. A dispatched send that never settles remains unknown rather than “not saved.” |
| F02 — cross-tab lease | CLOSED within the participating browser origin | `src/composables/fcWriteGuard.ts:287`, `:398`; `src/composables/fcWriteLease.ts:230`; `src/js/msp.ts:1277`. Ordinary writes require the shared lease; transactions require exclusive ownership and now wait for their own page’s earlier sends too. |
| F03 — batch interleaving / connection rollover | CLOSED | `src/js/protocols/WebSerial.ts:640`, `:667`; `src/js/serial.ts:403`; `src/js/protocols/WebBluetooth.ts:699`. Whole-send queues, captured writers/characteristics and connection generations prevent queued frame continuations from migrating to a new connection. |
| F04 — EEPROM false success / outcome classification | CLOSED | `src/js/msp/eepromSave.ts:45`, `:81`, `:95`; `src/js/msp/MSPHelper.ts:453`, `:866`; `src/js/msp.ts:974`. Missing, corrupt or ambiguous answers do not establish persistence. CRC failures no longer consume unanswered transmission history. |
| F05 — RXFAIL retry/refusal hang | CLOSED | `src/js/msp/MSPHelper.ts:769`; `src/composables/failsafe/useFailsafeSave.ts:56`. Sequential confirmed writes reject and terminate the save chain on failure. |
| F06 — premature clean baseline / concurrent edits | CLOSED | `src/components/tabs/FailsafeTab.vue:7`, `:474`; `src/composables/failsafe/useFailsafeSave.ts:47`; `src/composables/useReboot.ts:103`. Fields are disabled/inert, payloads and baseline are captured, and baseline commit follows confirmed EEPROM save. |
| F07 — recovery handling | CLOSED for the repaired diagnosis contract | `src/gyrocore/recovery/transactionDiagnosis.ts:82`, `:128`; `src/gyrocore/components/UncertainStateNotice.vue:106`. Unsupported recovery states are explicitly diagnosed without clearing uncertainty. This does **not** mean every orphan or unknown-profile entry has an in-app recovery. |
| F08 — retention/parser disagreement | CLOSED | `src/gyrocore/stores/transactionRecords.ts:104`; `src/gyrocore/stores/tuneBackup.ts:98`, `:124`; `src/composables/useTuneApply.ts:1372`. Retention shares the transaction parser, preserves backups on unreadability, and checks reread storage. |
| F09 — CLI drain / delivery isolation | CLOSED | `src/js/msp.ts:477`, `:545`, `:579`, `:634`. Drain blocks successor dispatch, MSP decoding remains separate, incomplete delivery makes the session uncertain, and replies await full transport delivery. |
| F10 — failed CLI exit handoff | CLOSED | `src/composables/useCli.ts:919`; `src/js/serial_backend.ts:432`. Handoff requires full delivery; timeout/failure drops the connection without a second exit or MSP reboot. The deadline checks its connection generation. |

The last three production commits do not reopen the inspected F01–F10 contracts. In particular:

- Removing the four-second answer window preserves ambiguity after long silence; it cannot turn an old ACK into proof of a later save. This deliberately may require reconnecting after an unanswered write.
- `serial.pendingSends` stops counting a stuck send only after its captured link reports `CLOSED_CONFIRMED`; it does not manufacture a zero-byte result (`src/js/serial.ts:450`).
- BLE closure also waits for outstanding `writeValue()` operations to settle (`src/js/protocols/WebBluetooth.ts:40`, `:672`). The kept-link reboot branch reuses the matching OPEN connection (`:380`) without replacing its characteristics or queue.
- WebSocket buffering includes superseded sockets until CLOSED (`src/js/protocols/WebSocket.ts:256`).

Beyond the P2 above, I found no additional concrete integration defect establishing false success, guard/lease bypass, or a normal flasher/reboot-path regression. That is an inspection result, **not execution evidence**. The flasher’s raw bootloader writes remain outside the MSP write-guard contract; no physical flash or reboot qualification is claimed.

**Absolute Apply remains BLOCKED:** `src/gyrocore/safety/absoluteEvaluate.ts:64` keeps `hardwareValidated:false`, and `:180` adds the blocking reason.

Tauri and Capacitor are separately **NOT_VALIDATED**. No protection is claimed against external programs, other browsers, or other devices.

P0_OPEN=0
P1_OPEN=0
P2_OPEN=1
REVIEW_COMPLETED=YES
VERDICT=REQUEST_CHANGES