**REQUEST_CHANGES: one new P2 availability defect blocks acceptance.** F01–F10 remain closed for their bounded software contracts by source inspection; this is not an execution PASS.

Reviewed detached HEAD `d070d344b0ce53113e3d8e0bcd605740f194e74a` against `20242d2c`, including the requested commit log and final transport changes. The reverted implementations were not treated as active protection. No tests, hardware actions, network access, agents, or mutations were performed. Tracked files remained clean; existing untracked files were preserved.

**New finding — P2: BLE keep-link reboot reconnect is rejected**

**Production anchor:** `src/js/protocols/WebBluetooth.ts:379` (`d070d344`), with callers at `src/js/serial_backend.ts:414`, `:1627`, `:1708`, and `:525`.

**Reproducible scenario, derived from source:**

1. Connect through Web Bluetooth with Auto-Connect enabled, using a BLE bridge whose GATT link survives the FC reboot.
2. Perform Save-and-Reboot.
3. The reboot fallback calls `softResetForReboot()`. This deliberately resets application state while leaving the transport connected.
4. The reconnect loop calls `beginConnect()`, which invokes `serial.connect()`.
5. The new `WebBluetooth.connect()` check sees `this.connected === true`, emits `connect: false`, and returns. Consequently, `onOpen()` receives failure instead of starting the MSP handshake.

Further attempts encounter the same still-open transport until the reconnect window ends or the link drops. The intended handshake over the retained GATT connection cannot run.

**Effect:** an ordinary BLE reboot workflow loses automatic recovery despite retaining a usable transport. This is an **availability defect that blocks acceptance**, not evidence of false EEPROM success, a write-guard bypass, or uncertainty being cleared.

**Would tests catch it?** The inspected tests do not cover the integrated failure:

- `test/js/serial_backend.test.ts:700` tests the keep-link path, but mocks `serial.connect` (`:70`) and only checks that it was called (`:725`).
- `test/gyrocore/wp8_transport_closure.test.ts:627` exercises the real adapter’s already-connected rejection, but does not combine it with the backend’s intentional keep-link reboot flow.

An integrated backend → serial facade → WebBluetooth reboot test is needed. No scenario was executed in this review.

| Finding | HEAD status | Production anchors and retained protection |
|---|---|---|
| F01 — restore/save success without evidence | **CLOSED, source** | `src/js/utils/AutoRestore.ts:295,334`; `src/composables/useMspCliSession.ts:281`; `src/components/tabs/BackupsTab.vue:534`. Success requires firmware save evidence; a stuck send ends unknown. |
| F02 — ordinary cross-tab writes bypass transaction exclusion | **CLOSED, source; same-origin scope** | `src/composables/fcWriteGuard.ts:263,290,408`; `src/composables/fcWriteLease.ts:157,230`; `src/js/msp.ts:1277`. Shared/exclusive lease participation includes transport-busy accounting. |
| F03 — batch interleaving / cut frame resumes on new connection | **CLOSED, source** | `src/js/protocols/WebSerial.ts:623,650`; `src/js/serial.ts:403,433`; `src/js/protocols/WebBluetooth.ts:697,733`. Whole-send queues, captured writer/characteristic, and generation/link checks prevent continuation onto a replacement connection. |
| F04 — EEPROM falsely reported saved | **CLOSED, source** | `src/js/msp/eepromSave.ts:45,81,95`; `src/js/msp/MSPHelper.ts:862`; `src/js/msp.ts:974,1031`. Firmware ACK required; ambiguous answers remain unknown. |
| F05 — refused RXFAIL retry hangs Failsafe Save | **CLOSED, source** | `src/js/msp/MSPHelper.ts:765`; `src/composables/failsafe/useFailsafeSave.ts:59`; `src/js/msp.ts:844`. Error-aware channel writes propagate refusal/timeout and end the chain. |
| F06 — dirty baseline cleared before persistence | **CLOSED, source** | `src/composables/failsafe/useFailsafeSave.ts:47,69`; `src/composables/useReboot.ts:103`; `src/components/tabs/FailsafeTab.vue:8,474`. Payload/baseline captured before writes; baseline committed after confirmed save; fields disabled and inert during saving. |
| F07 — unusable recovery guidance | **CLOSED for diagnosis/fail-closed contract** | `src/gyrocore/recovery/transactionDiagnosis.ts:82,128`; `src/gyrocore/components/UncertainStateNotice.vue:106`; `src/gyrocore/stores/fcTransactionState.ts:275`. Unsupported recovery remains unavailable; orphaned/unknown-profile entries are not automatically recovered or cleared. |
| F08 — inconsistent retention parsing | **CLOSED, source** | `src/gyrocore/stores/transactionRecords.ts:104`; `src/gyrocore/stores/tuneBackup.ts:98,125`; `src/composables/useTuneApply.ts:1372`. Shared parsing, collision checks, conservative retention and storage rechecks remain present. |
| F09 — CLI drain corrupts reply attribution | **CLOSED, source** | `src/js/msp.ts:477,537,570,600,634`. Drain blocks successor dispatch; delivery failure/grace expiry makes the CLI session uncertain rather than assigning arbitrary late output to a successor. |
| F10 — failed CLI exit reports reboot | **CLOSED, source** | `src/composables/useCli.ts:917`; `src/js/serial_backend.ts:432`. Full delivery gates reboot handoff; timeout/failure drops the uncertain CLI connection; generation checks protect a later connection. |

The transport closure integration does **not** turn a stuck send into “not sent”: `src/js/serial.ts:450–472` retains handed sends until their own link is `CLOSED_CONFIRMED`. Failed closes retain uncertainty. BLE additionally requires outstanding `writeValue()` calls to settle (`WebBluetooth.ts:41,663`). WebSocket accounting includes superseded, nonclosed sockets (`WebSocket.ts:256`).

Removing the four-second answer window preserves unanswered-write history across silence and callback cleanup. The inspected tests at `test/gyrocore/wp8_repair_integration.test.ts:169,191` target late answers after 60 seconds; they were **not run**.

I found no additional concrete integration defect in the inspected ordinary disconnect/reconnect, flasher/AutoRestore, delivery-classification, or authorization paths. That statement is source-review evidence only.

**Absolute Apply remains BLOCKED:** `src/gyrocore/safety/absoluteEvaluate.ts:64` fixes `hardwareValidated: false`, and `:180` adds the blocking reason.

Tauri and Capacitor remain **NOT_VALIDATED** separate scopes. No protection is claimed against external programs, other browsers, origins, or devices.

P0_OPEN=0
P1_OPEN=0
P2_OPEN=1
REVIEW_COMPLETED=YES
VERDICT=REQUEST_CHANGES

