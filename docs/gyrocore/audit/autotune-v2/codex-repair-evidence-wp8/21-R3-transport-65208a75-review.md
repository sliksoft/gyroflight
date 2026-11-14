Two findings remain. These are source-derived reproduction scenarios; I ran no tests.

1. **P1 — Legacy Ports saves still treat refused SETs as success.**  
   Anchors: `src/js/msp/MSPHelper.ts:219`, `src/composables/ports/usePortsConfiguration.ts:165`.

   The new rejection applies only to error-aware requests. Legacy callbacks still receive `callback(response)` for a firmware `!` answer. The reachable Ports save chain ignores that response: `sendSerialConfig()` invokes the next SET, whose callback invokes `saveAndReboot()`.

   **Reproduce:** On firmware below API 1.49, change a port assignment and click Save. Return a valid `!` answer to `MSP2_COMMON_SET_SERIAL_CONFIG`; acknowledge the subsequent feature SET and EEPROM write. Alternatively, refuse the feature SET after acknowledging the serial SET. The chain still saves, logs `portsEepromSave`, and starts rebooting.

   **Safety effect:** A refused receiver/GPS/port configuration can be presented as saved, potentially persisting a partial combination of serial and feature settings. EEPROM acknowledgement proves persistence of the configuration the FC accepted, not acceptance of the requested SETs.

   **Tests:** The new refusal test uses `MSP.promise(MSP_SET_OSD_CONFIG)`, so it exercises the repaired error-aware branch. It would pass while this adjacent false-success route remains. This is an existing adjacent defect left open, not a newly introduced regression. Closing it requires error-aware handling through the Ports SET chain, with a production-path refusal test.

2. **P2 — Retry history disappears when the older EEPROM waiter expires.**  
   Anchors: `src/js/msp/MSPHelper.ts:448`, `src/js/msp.ts:849`, `src/js/msp/eepromSave.ts:52`.

   `settleCallbacks()` now calculates the maximum attempts over currently queued waiters. It does not retain the history of an older waiter removed by timeout.

   **Reproduce:** With the configured one-second timeout and three attempts:
   - Start EEPROM waiter A at t=0; let it transmit and retry at t=1 and t=2.
   - Attach identical waiter B at t=2.5. It starts with `attempts=1` and sends nothing initially.
   - At t=3, A exhausts and is removed. Keep the connection alive with other traffic.
   - Deliver a valid EEPROM `!` answer at t=3.1, before B’s first timeout.

   Only B remains, so the computed maximum is one. B rejects with `persistence="not_saved"`, although A’s first attempt may already have saved successfully and lost its acknowledgement.

   **Safety effect:** The repair still permits a false definite persistence result where the correct result is `unknown`.

   **Tests:** The new second-waiter test delivers the refusal while the older waiter remains queued. Its assertions would detect reverting the maximum calculation, but it misses this expiry boundary. Retry history must survive removal of the original waiter.

For the remaining changed claims, source tracing supports the intended protections:

- Write-class `!` answers reject `MSP.promise`; read-class refusals continue resolving.
- Unknown direction bytes become non-answers before callback dispatch.
- Exhausted legacy requests fail `_still_wanted()`.
- CLI session loss ends an in-flight successor; wire admission and successful completion also check session uncertainty.
- WebSerial batch chunks retain their original writer and generation, preventing continuation on the next connection.

The added decoder/transport tests exercise production code over mocked transports; they do not merely mock the repaired functions. By inspection, reverting the corresponding repairs would invalidate their relevant assertions or completion expectations. That is not an executed mutation-test result.

I found no additional rejection-compatibility defect in the inspected callers. `setSetting()` already promises to throw on refusal, and its DroneCAN caller propagates failures. `useTuneApply` catches SET/EEPROM rejection; at HEAD it maps firmware EEPROM refusal through `eepromSendErrorState()`. Presets’ MSP CLI route uses separate CLI error handling. `MSP2_CLI_SETTING` classification consistently treats a payload containing the encoded `=` byte as a write; plain reads and setting-info probes remain reads. Existing named-setting unit tests mock `MSP.promise`, so they do not independently verify that transport classification.

Scope: commit `65208a75`, with necessary production callers and tests at verified HEAD `e03cbc48`. No tests, hardware, network, modifications, or agents. Graph analysis was not performed. Tauri remains **NOT_VALIDATED**. No protection against external programs, other browsers, or devices is asserted.

REVIEW_COMPLETED=YES
VERDICT=REQUEST_CHANGES