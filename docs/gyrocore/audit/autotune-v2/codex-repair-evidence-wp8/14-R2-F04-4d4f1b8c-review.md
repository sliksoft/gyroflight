Reviewed `4d4f1b8c` and the necessary surrounding production code/tests at verified HEAD `b1317bf8`. **Three residual defects remain.** These are source-derived scenarios; I ran no tests or probes.

1. **P1 — A malformed echoed request can still acknowledge EEPROM without a firmware reply.**  
   **Locations:** `src/js/msp.ts:276`, `src/js/msp.ts:1047`.

   The new guard rejects frames whose stored direction is `0`, but the direction parser has no default rejection. An invalid direction byte retains the preceding `message_direction`, initially `1`.

   **Reproduction:** Start `saveAndReboot()`. Instead of a firmware response, deliver the echoed EEPROM request with its direction byte corrupted from `<` (`0x3c`) to `=` (`0x3d`):
   ```
   24 4d 3d 00 fa fa
   ```
   With direction state `1`, this passes the new guard. The MSP v1 checksum excludes the direction byte, so the checksum remains valid. The callback receives `unsupported: 0`, and `eepromReplyState()` reports `saved`.

   **Safety effect:** A malformed request echo still produces a saved notification and reboot handoff without an EEPROM acknowledgement. The exact `$M<` case is blocked, but an equivalent false-success path remains.

   **Tests:** The added test at `test/gyrocore/wp8_repair_eeprom_save.test.ts:203` covers only literal `<`. It would miss this scenario. Reject unrecognized direction bytes and test malformed headers through `MSP.read()`.

2. **P1 — OSD still reports success and reboots after a refused configuration write.**  
   **Locations:** `src/components/tabs/OsdTab.vue:1582`, `src/components/tabs/OsdTab.vue:1602`; supporting path `src/stores/osd.ts:524`.

   The new boolean becomes `true` whenever `saveAllConfig()` resolves. However, that action awaits `MSP.promise()` for OSD writes without checking `reply.unsupported` (`src/stores/osd.ts:524–538`). Firmware error replies resolve that promise; they do not reject it.

   **Reproduction:** Trigger OSD Save-and-Reboot with a port change pending. Return a firmware `!` response for one `MSP_SET_OSD_CONFIG`, then acknowledge subsequent operations and `MSP_EEPROM_WRITE`. The refused OSD operation does not stop persistence. `saveAllConfig()` captures its clean snapshot, `saved` becomes `true`, the tab announces success, and reboot runs.

   **Safety effect:** A partially applied configuration is persisted and presented as fully saved, including potentially unchanged OSD warnings/layout. The new reboot predicate does not establish its comment’s claim that every write was confirmed.

   **Tests:** The F04 suite never invokes `OsdTab` or `saveAllConfig()`. Both added tests can pass with this defect intact. This is an adjacent, pre-existing false-success route left open by the OSD repair, rather than a newly introduced regression. A production-path test must refuse an OSD SET and require no EEPROM write, success baseline, or reboot.

3. **P2 — Retry history is lost for a second EEPROM waiter attached to an existing request.**  
   **Locations:** `src/js/msp/eepromSave.ts:50`, `src/js/msp/MSPHelper.ts:438`; supporting bookkeeping `src/js/msp.ts:730–754`.

   Responses now carry each callback entry’s `attempts`, but identical requests can attach to an existing transmission. Every new entry starts with `attempts: 1`, irrespective of the existing request’s history.

   **Reproduction:** Start save A, let its first EEPROM operation execute but lose its ACK, and allow its retry to go out. Before the response arrives, start save B through `saveToEeprom()`. B attaches without another initial transmission. Deliver a firmware refusal. Callback settlement gives A `attempts: 2` and B `attempts: 1`: A reports `unknown`, while B incorrectly reports `not_saved`, although the earlier transmission may have persisted the configuration.

   **Safety effect:** Persistence uncertainty is understated for a caller sharing the outstanding save. The legacy Ports button also lacks a running-save guard (`src/components/tabs/ports/PortsLegacyView.vue:175`), allowing overlapping save chains.

   **Tests:** The new retry test at `test/gyrocore/wp8_repair_eeprom_save.test.ts:215` uses only one waiter. It misses this case. Retry history needs to describe the shared outstanding operation, not merely an individual callback entry.

The literal request-echo rejection, ordinary single-waiter refused-retry classification, EEPROM-error OSD reboot guard, and legacy Ports rejection handler are present in production source. Static inspection indicates the two new tests would detect reverting the corresponding literal-echo and single-waiter retry fixes; they do not cover the residual cases above. They exercise production save/decoder functions with mocked transport and reboot endpoints, rather than mocking the functions under test.

Dropping complete `<` frames leaves the inspected `>` and `!` response paths intact, including the shared MSP v2 direction handler. I found no legitimate reply path in the inspected code requiring `<`; hardware compatibility was not established. No additional introduced hang or deadlock was identified in this scope.

No network, hardware, tests, source changes, Git mutations, or agents were used. No protection against external programs, other browsers, or devices is claimed. **Tauri: NOT_VALIDATED.**

REVIEW_COMPLETED=YES
VERDICT=REQUEST_CHANGES