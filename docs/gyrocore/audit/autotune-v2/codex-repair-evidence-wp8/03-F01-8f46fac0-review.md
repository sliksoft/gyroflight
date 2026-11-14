**P1 — Unconfirmed saves still return success, and Presets/Backups discard the uncertainty.**

**Anchor:** `src/composables/useMspCliSession.ts:279`. Adjacent affected callers: `src/components/tabs/BackupsTab.vue:532`, `src/components/tabs/PresetsTab.vue:500`.

**Reproducible scenario, derived from source:**

1. Complete the configuration batch.
2. Let the transport report the entire `save` frame sent.
3. Disconnect before receiving any firmware save output, or keep the connection open without output until the five-second timeout.

`msp.ts` supplies `delivered: true` and empty output. `saveAndReconnect()` correctly computes `persistence: "not_verified"`, but then returns **`{ ok: true, error: null, persistence: "not_verified" }`**. Its only warning is `console.warn`.

The production callers do not inspect this result:

- Backups logs `userBackupRestoreSuccess` **before** calling `saveAndReconnect()` and ignores its result.
- Presets and both “save anyway” routes also ignore the result.

**Safety effect:** An interrupted, unconfirmed save still completes the product flow without a visible persistence warning; Backups explicitly reports restore success. The configuration may exist only in RAM or may not have persisted. This leaves F01’s equivalent false-success behavior open in the Presets/Backups portion of the claim. A complete transport write proves neither command execution nor EEPROM persistence.

**Would existing tests catch it?** No. `test/gyrocore/wp8_repair_save_evidence.test.ts:243` exercises this exact disconnect scenario but asserts only `persistence: "not_verified"`. It does not assert `ok: false`, a meaningful error, or a visible warning. Consequently, that test is compatible with the defective return value. The reconnect tests mock `MSP.send_cli_command`; their synthetic confirmation checks do not establish that production UI callers handle uncertainty.

The repair needs to propagate unconfirmed persistence into the visible Presets/Backups outcome and reserve save success for confirmed persistence. A regression test should check both the result contract and the caller’s displayed outcome.

I inspected `git show 8f46fac0` and the necessary production code and tests at HEAD `30e0158f`. The five specifically named review files have no subsequent changes between that commit and HEAD.

For output attribution, the inspected queue clears accumulated text when starting a command, captures output before timeout/disconnect cleanup, and blocks subsequent commands while draining a timed-out response. The literal `save` echo does not match either confirmation marker. I found no additional concrete stale-output or echo counterexample within the inspected routes. This is source inspection, not proof of firmware-output provenance: the tests inject the expected firmware bytes, and firmware implementation/hardware behavior was not independently validated here.

No tests, network, hardware actions, modifications, or agents were used. Tauri remains **NOT_VALIDATED**. F01’s full closure claim is rejected because the P1 above remains.

REVIEW_COMPLETED=YES
VERDICT=REQUEST_CHANGES