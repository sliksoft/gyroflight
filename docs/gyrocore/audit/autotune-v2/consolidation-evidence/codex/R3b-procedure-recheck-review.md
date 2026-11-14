No open P0–P2 findings in `b38e2ee3`. Findings 1–4 are closed:

1. **Class R:** the document explicitly permits the two runtime SET codes (`docs/gyrocore/AUTOTUNE_V2_HARDWARE_PROCEDURE.md:11`). The connect sequence matches (`src/js/serial_backend.ts:1200`; `src/js/msp/MSPHelper.ts:791`). Disconnect also sends `MSP_SET_ARMING_DISABLED` through `enableArming`, which falls within the named allowance (`src/js/serial_backend.ts:366`).

2. **H-W5:** it correctly describes shared upstream leases without mutual serialization, and exclusive leases for Gyroflight transactions/Check (`docs/gyrocore/AUTOTUNE_V2_HARDWARE_PROCEDURE.md:66`; `src/composables/fcWriteLease.ts:131`, `:242`).

3. **H-W4:** the conditional MSP refusal matches `cliSessionRefusal` (`src/composables/fcWriteGuard.ts:275`). The managed exit waits for complete transport delivery before reboot/reconnect; failure or timeout drops the connection (`src/composables/useCli.ts:920`).

4. **H-W7:** Restore interruption after a SET produces a write-stage failure and uncertain transaction (`src/composables/useTuneApply.ts:1063`, `:534`). Upstream cancellation can end silently (`src/composables/useSaving.ts:101`); EEPROM handling distinguishes `not_saved` from `unknown` (`src/js/msp/eepromSave.ts:95`). Upstream saves create no Gyroflight transaction entry. The revised procedure accurately separates these cases (`docs/gyrocore/AUTOTUNE_V2_HARDWARE_PROCEDURE.md:68`).

H-A3 also correctly accepts the earlier live/log mismatch refusal: `readLiveAbsolute` checks it before the preview hash comparison (`src/composables/useTuneApply.ts:1165`, `:1243`).

I found no newly incorrect claim or revised class-R instruction that writes beyond its named allowance. Preview and Check issue reads; Check’s lease and transaction-record updates do not write FC configuration.

The single-port exclusivity expectation is reasonable as an observation to record for the specified browser/OS setup. H-W5 appropriately separates that observation from lease evidence using fake transports.

P3: none raised. This was source inspection only; no tests, hardware actions, modifications, or network access.

P0_OPEN=0
P1_OPEN=0
P2_OPEN=0
VERDICT=APPROVE