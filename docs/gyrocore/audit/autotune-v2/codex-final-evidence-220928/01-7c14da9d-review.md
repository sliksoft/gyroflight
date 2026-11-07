Reviewed **only `7c14da9db9515cc7e3d1cd5d84613ee7b26b947c`**, using `git show` and minimally necessary production source/tests at that commit. Checkout HEAD matched **`20242d2cd94d3d492ba0d12f390e1bd5d001ff74`** before and after inspection. Untracked reports were excluded.

**No new P0/P1 defect established in the two changed guard expressions. The broader “final acceptance” claim remains unsupported because the following surrounding safety gaps remain OPEN.** These are residual defects at the reviewed commit, not changes introduced by its two expressions. All line numbers below refer to **7c14da9**, not current HEAD.

1. **P1 — OPEN: delayed CLI echo can invalidate the checked pending command.**  
   `src/composables/useCli.ts:332`, `:498`; `src/composables/fcWriteGuard.ts:284`.

   **Scenario:** With native autocomplete enabled, submit `save #` through Tab while writes are allowed. This sends an unterminated command plus Tab. Delay its echo, then introduce an uncertain transaction entry. Submit `get` before the echo arrives. The guard checks an empty/stale `cliBuffer` and permits `get\n`; the firmware can already hold `save #`, producing `save #get\n`.

   **Safety effect:** An apparently permitted read can terminate a pending save and persist uncertain configuration. The send path does not independently track transmitted pending bytes; it trusts received display text.

   **Coverage:** The new tests construct `useCli()` and call `sendLine()` with an initially empty buffer. They do not exercise native Tab, delayed echo, or the transition into uncertainty. Firmware interpretation and physical reproduction remain **NOT_VALIDATED**.

2. **P1 — OPEN: AutoRestore can report success before a queued save is transmitted or refused.**  
   `src/js/utils/AutoRestore.ts:265`, `:269`, `:272`, `:279`; `src/js/msp.ts:357`.

   **Scenario:** Keep another MSP CLI command in flight, invoke `_finishWithSave()`, and leave `save` queued for more than 500 ms. AutoRestore sets `_saving=true`, waits 500 ms, then calls `_cleanup(true, null)` regardless of whether the queued save reached the port. An uncertain state appearing before queue release can also cause a refusal after the success deadline. A disconnect during this interval is separately treated as success at `AutoRestore.ts:100`.

   **Safety effect:** Restore reports success without establishing even transmission of the save, let alone persistence.

   **Coverage:** `test/gyrocore/wp8_p0_closure_transport.test.ts:365` exercises the real AutoRestore method with immediate refusal and mocked disconnect. It does not cover deferred save, late refusal, or disconnect before transmission. These cases remain **NOT_VALIDATED**.

3. **P1 — OPEN: retention can delete the known recovery target while recovery remains uncertain.**  
   `src/gyrocore/stores/tuneBackup.ts:95`; `src/composables/useTuneApply.ts:1353`.

   **Scenario:** Start with the known backup needed for recovery. Repeatedly restore it, failing after each new `before_restore` backup is stored and before verified completion. Each attempt prepends another snapshot. On the twentieth insertion, the original target can be removed by the unconditional per-craft limit of 20.

   **Safety effect:** Unverified recovery snapshots can displace the known restore target and evidence referenced by open transaction entries. A later restore fails with `backup_not_found`; the read-only check also preserves the unresolved entry (`useTuneApply.ts:1389`). This loses recovery availability; it does **not** prove the state safe.

   **Coverage:** Inspected route tests cover provenance rejection and uncertain-entry preservation, but not retention during repeated failed recovery. Retention is not pinned to open entries. Execution **NOT_VALIDATED**.

4. **P1 — OPEN: Failsafe clears its dirty baseline before persistence succeeds.**  
   `src/composables/failsafe/useFailsafeSave.ts:57`; `src/components/tabs/FailsafeTab.vue:446`, `:380`.

   **Scenario:** Acknowledge all section SETs, then refuse or fail the EEPROM/save step. `initializeDefaults()` has already cleared `configChanges` before `saveAndReboot()` settles.

   **Safety effect:** The save button becomes disabled although persistence failed or remains unknown. The failure log does not restore the dirty baseline, potentially leaving the user with RAM-only failsafe settings.

   **Coverage:** `test/js/composables/failsafe/useFailsafeSave.test.ts:118` rejects the **first** mocked MSP write. MSP, `sendRxFailConfig`, and `saveAndReboot` are mocked. It does not cover the real final persistence failure.

   An additional failure path remains at `useFailsafeSave.ts:47` / `src/js/msp/MSPHelper.ts:742`: refusal or cancellation of callback-only RXFAIL writes can leave the wrapping promise pending indefinitely. Neither failure is exercised through production transport in that suite.

5. **P2 — OPEN: conservative DEL rejection can prevent normal CLI exit.**  
   `src/composables/fcWriteGuard.ts:293`; `src/composables/useCli.ts:125`, `:877`.

   **Scenario:** While uncertain, leave echoed partial input differing from `exit`. Cleanup generates DEL bytes through `getCliCommand()`. The guard rejects them and never calls the send callback, so `reinitializeConnection()` is skipped. Cleanup nevertheless clears CLI flags and returns `rebooting=true`.

   **Safety effect:** The application can claim a reboot handoff while the controller remains in CLI. A proposed 256-DEL buffer clear would also be refused by this guard; it is not an established recovery mechanism.

   **Coverage:** Existing tests verify that edit bytes are rejected and that `sendLine("exit")` is permitted with an empty buffer. They do not establish cleanup with pending input or successful recovery. Execution **NOT_VALIDATED**.

6. **P2 — OPEN: CLI timeout draining is not isolated from MSP replies.**  
   `src/js/msp.ts:204`, `:357`, `:420`.

   **Scenario:** Timeout a CLI command, then receive an ordinary MSP response during the drain interval. `read()` discards every byte while `cli_discarding`, including MSP frames; any `0x03` ends draining without establishing CLI framing. Also, `_process_cli_queue()` does not check `cli_discarding`, so a newly submitted CLI command can start during that interval.

   **Safety effect:** Unrelated MSP responses can be lost, and CLI responses can be discarded or associated with the wrong request. This undermines reliable readback/error handling.

   **Coverage:** The new tests advance timers to obtain queued refusals; they do not feed interleaved CLI/MSP response bytes. Execution **NOT_VALIDATED**.

The commit’s narrow fixes are **CLOSED by source inspection only**: non-ASCII/control CLI text is rejected while writes are blocked, and `MSP2_CLI_SETTING` classifies `0x13d` as encoded `=`. The new tests exercise production guard, MSP encoder/queue, transaction state and CLI composables through a mocked `serial.send`; reconnect is mocked too. Despite its test name, the “plain ASCII reads … both routes” case exercises only MSP CLI.

**Execution evidence:** None collected. No tests, probes, hardware actions, network research, agents, or mutations were performed. Commit-message claims about failing tests and mutation detection were not independently verified. Route tests using mocked MSP and a firmware harness do not establish real firmware behavior. Unknown EEPROM, pending/crashed transactions and unknown profile scope remain uncertain. No protection against external programs or other browsers is claimed. **Tauri: NOT_VALIDATED.**

**REVIEW_COMPLETED=YES**  
**VERDICT=REQUEST_CHANGES — narrow byte fix supported by inspection; broader safety acceptance remains OPEN.**

