**REQUEST_CHANGES.** Class R includes operations that send `MSP_SET_*`. Two write tests also promise protection their selected routes do not provide. The document consistently says hardware acceptance is **NOT_EXECUTED**; it makes no hardware-validation claim.

1. **P1 — Class R reconnects violate its stated write prohibition.**  
   [Procedure:43](docs/gyrocore/AUTOTUNE_V2_HARDWARE_PROCEDURE.md:43) requires disconnect/reconnect under the “no `MSP_SET_*`” rule at line 11. A normal connection calls `disableArming()` and sends `MSP_SET_RTC` (`src/js/serial_backend.ts:1200–1205`); disabling arming sends `MSP_SET_ARMING_DISABLED` (`src/js/msp/MSPHelper.ts:819`). H-R10 has the same problem. An operator authorizing these as read-only necessarily permits prohibited commands. Reclassify the connection operations or explicitly define and authorize these runtime changes.

2. **P1 — H-W5 does not exercise exclusive transaction locking.**  
   [Procedure:62](docs/gyrocore/AUTOTUNE_V2_HARDWARE_PROCEDURE.md:62) promises serialization or `fc:write_lock_busy` / `fc:write_lease_timeout` when two tabs perform PID saves. Both pages hold **shared** leases (`src/composables/fcWriteLease.ts:125–141`). PID Save runs `writePidTuningConfig()` then `saveToEeprom()` without `withFcWriteLock` (`src/components/tabs/PidTuningTab.vue:441–463`). Consequently, two connected pages can admit interleaved writes; ordinary USB port exclusivity can instead prevent the second connection without testing the lease. Use a Gyroflight Restore or Check as the exclusive participant, with an explicitly supported connection arrangement.

3. **P1 — Opening CLI does not unconditionally refuse writes.**  
   [Procedure:61](docs/gyrocore/AUTOTUNE_V2_HARDWARE_PROCEDURE.md:61) promises writes are refused throughout a CLI session, including attempts from another tab. `cliSessionRefusal()` refuses only when `foreignWriteIssues()` already reports a problem (`src/composables/fcWriteGuard.ts:275–278`). With known state and a held shared lease, CLI being open adds no refusal. Moreover, `cliActive` is page-local. Specify the actual uncertain-state or exclusive-lease condition and expected reason; CLI entry alone does not establish this protection.

4. **P2 — H-W7 requires an outcome the upstream save path need not report.**  
   [Procedure:64](docs/gyrocore/AUTOTUNE_V2_HARDWARE_PROCEDURE.md:64) requires “unknown” after unplugging between SET and EEPROM. Disconnect during an awaited PID SET can raise `MspCancelledError`, which `useSaving` silently swallows (`src/composables/useSaving.ts:101–102`). If disconnect is recognized before EEPROM submission, `saveEeprom()` instead reports `not_saved` (`src/js/msp/eepromSave.ts:98–99`). Upstream PID saves also create no Gyroflight transaction entry. Separate interrupted RAM writes from an EEPROM request whose answer was lost, and specify the route and interruption point.

Other checks: preview takes no write lease; Apply, Restore and Check take the exclusive lease. The **8 s** limit governs lease acquisition/quiescence, not the complete operation. The documented API minima and CHIRP keys match the source. Absolute Apply remains blocked by `hardwareValidated: false`. Restore’s profile reason exists, and uncertain-state recovery requires the additional profile, firmware, API and storage checks in `checkTransactionState`.

**P3, non-blocking:** H-A3 inherits the earlier unconditional `apply:preview_changed` expectation; switching to a profile with different logged values can instead produce `fc:live_differs_from_log:<field>` before the preview-hash comparison.

Reviewed only `a4555b5f`. No tests, writes or network access were performed.

P0_OPEN=0
P1_OPEN=3
P2_OPEN=1
VERDICT=REQUEST_CHANGES

