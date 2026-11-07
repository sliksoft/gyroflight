**REQUEST_CHANGES — one P1 false-success defect remains in the repair range.** I cannot confirm that all F01–F10 remain closed.

Reviewed HEAD `5ef42d3b6806636efeceee66531296b7a97e0a9c` and `git log --oneline 20242d2c..HEAD`. The two reverted attempts were treated as historical changes; conclusions use final production code. Tracked staged/unstaged diffs were empty. No tests, network, hardware, mutations, or agents were used.

**P1 — R1: expired transmission history permits a stale ACK to confirm a later EEPROM save**

Production anchors:

- `src/js/msp.ts:224`: `ANSWER_WINDOW_MS = 4000`.
- `src/js/msp.ts:975`: unanswered earlier transmissions are discarded by age when admitting a new transmission.
- `src/js/msp.ts:968`: `awaitingWire` becomes false before the transport finishes sending.
- `src/js/msp/MSPHelper.ts:471`: response settlement then permits that request to complete.
- `src/js/msp/eepromSave.ts:51`: an unambiguous, non-error reply becomes `"saved"`.

Reproducible scenario, derived from source:

1. On one continuously open connection, send EEPROM save A. Allow one retry.
2. Deliver one ACK. A completes, leaving another transmission of A unanswered.
3. Wait more than four seconds after that remaining transmission, keeping the connection open.
4. Change configuration in RAM and request save B. Let its transport write remain pending.
5. Deliver A’s delayed second ACK before B’s request timeout.

B’s admission discarded A’s history, so B is not marked ambiguous. Although B’s send remains pending, `awaitingWire` is already false. A’s ACK consequently resolves B, and `saveEeprom()` reports success.

**Safety effect:** current RAM settings can be reported persisted without evidence that B reached the FC or saved them. Callers can log EEPROM success, commit the Failsafe clean baseline, and start reboot handling. An application timeout or four-second interval does not prove an earlier ACK cannot arrive.

**Test coverage:** `test/gyrocore/wp8_repair_integration.test.ts:139` and `:154` cover an unanswered earlier transmission and history surviving a tab switch, but submit B without crossing the four-second expiry. They would not catch this scenario. No execution was performed.

**Attribution:** introduced by the answer-tracking repair in `decc6c24`, retained at final HEAD; not newly introduced by `5ef42d3b`. This also exposes a limitation missed by the earlier closure judgment. Retain uncertainty until a justified connection boundary, or otherwise prevent an expired unanswered transmission from authenticating a successor.

The F01–F10 integration assessment follows. **CLOSED means the specific repair is supported by inspected source, not executed validation.**

| Finding | Status at HEAD | Production anchors and assessment |
|---|---|---|
| F01 — CLI save/restore false success | CLOSED | `src/js/utils/AutoRestore.ts:314`, `:334`; `src/composables/useMspCliSession.ts:286`. Delivery alone is insufficient; firmware save output is required. A stuck save ends unknown rather than not-saved. |
| F02 — cross-tab lease | CLOSED within stated scope | `src/composables/fcWriteGuard.ts:282`, `:400`; `src/composables/fcWriteLease.ts:148`; `src/js/msp.ts:1280`; `src/js/serial.ts:450`. Shared write admission and exclusive transactions remain connected to transport-busy accounting. |
| F03 — batch interleaving/cut-frame continuation | CLOSED | `src/js/protocols/WebSerial.ts:623`, `:650`; `src/js/serial.ts:401`. Complete-send queues, captured writer and generation checks prevent batch interleaving and continuation on a new connection. |
| F04 — EEPROM false success | **OPEN — R1, P1** | `src/js/msp.ts:975`; `src/js/msp/MSPHelper.ts:471`; `src/js/msp/eepromSave.ts:51`. Disconnect/refusal handling is repaired, but expired ACK history permits false confirmation. |
| F05 — refused RXFAIL retry hangs Save | CLOSED for original defect | `src/js/msp/MSPHelper.ts:765`; `src/composables/failsafe/useFailsafeSave.ts:59`. Error-aware sequential writes terminate the save on rejection. Shared ACK correctness remains subject to R1. |
| F06 — premature clean baseline | CLOSED for original defect | `src/composables/failsafe/useFailsafeSave.ts:47`, `:69`; `src/components/tabs/FailsafeTab.vue:8`. Payload/baseline capture and inert fields remain; baseline commitment follows save confirmation. R1 can falsely supply that confirmation. |
| F07 — recovery availability/diagnosis | CLOSED for bounded diagnosis repair | `src/gyrocore/recovery/transactionDiagnosis.ts:82`, `:128`; `src/gyrocore/components/UncertainStateNotice.vue:113`. Unsupported recovery is identified and uncertainty retained. Orphaned/unknown-scope entries still have no verified in-app recovery; closure does not mean universal recoverability. |
| F08 — retention/parser disagreement | CLOSED | `src/gyrocore/stores/tuneBackup.ts:98`; `src/gyrocore/stores/transactionRecords.ts:104`; `src/composables/useTuneApply.ts:1421`. Shared parsing, collision checks, conservative retention and post-read storage checks remain. |
| F09 — CLI drain/reply attribution | CLOSED | `src/js/msp.ts:476`, `:536`, `:568`, `:633`. Delivery results precede successor dispatch; drain expiry closes the CLI session to further commands. |
| F10 — failed CLI exit/reboot handoff | CLOSED | `src/composables/useCli.ts:918`, `:939`; `src/js/serial_backend.ts:432`. Handoff requires complete transport delivery; timeout/failure drops the uncertain session, and generation checks protect a later connection. |

For `5ef42d3b` specifically, I found no additional concrete P0/P1/P2 defect in the inspected transport changes:

- `src/js/serial.ts:460` stops counting a handed send only after **its own** link is `CLOSED_CONFIRMED`; this does not settle the send as zero bytes.
- WebSerial joins teardown and retains failed-close ports (`WebSerial.ts:444`, `:507`). BLE captures its original characteristic/link and rejects old queued writes on a replacement connection (`WebBluetooth.ts:640`, `:676`).
- WebSocket buffering includes superseded sockets until CLOSED (`WebSocket.ts:256`).
- Normal reconnect, reboot reconnect, BLE keep-link reboot and flasher callers were inspected. Their real browser/FC behavior remains **NOT_VALIDATED**. The transport tests use fake browser objects; they do not establish physical delivery or complete reboot/flasher operation.

No separate confirmed availability regression or guard/lease bypass was found. There are no separately counted P2 findings.

**Absolute Apply remains BLOCKED:** `src/gyrocore/safety/absoluteEvaluate.ts:64` keeps `hardwareValidated: false`; `:180` unconditionally adds the hardware-validation block.

Tauri and Capacitor remain separate **NOT_VALIDATED** scopes. No protection is claimed against external programs, other browsers or devices. Graph/PDG validation was not performed.

P0_OPEN=0
P1_OPEN=1
P2_OPEN=0
REVIEW_COMPLETED=YES
VERDICT=REQUEST_CHANGES