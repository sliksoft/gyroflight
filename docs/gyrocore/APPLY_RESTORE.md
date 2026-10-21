# Tune workflow: Apply, Verify and Restore

Gyroflight is a browser app. It writes a tune to a stock Betaflight flight controller only through
Betaflight's own MSP handlers, only after the user has seen and confirmed the complete change, and it
saves to EEPROM only what it has read back and verified.

## Workflow (Autotune tab, "Tune workflow" panel)

| Step      | What it shows / does                                                                                                                                                                                                          | Source                                         |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Analyze   | CHIRP qualification of the imported log; M4/M4.2 flight metrics if a BBL was opened for them                                                                                                                                  | `chirpQualification`, `m4FlightMetrics` stores |
| Calculate | per tuning part: status, proposed change, measured evidence, what blocks it                                                                                                                                                   | `tuning/tuneWorkflow.ts` `tuneParts`           |
| Compare   | logged value against proposed, per slider, per-axis PID and filter                                                                                                                                                            | `compareRows`                                  |
| Apply     | release checklist; "Read from flight controller" runs the read-only preview (also while Apply is blocked); "Review and apply…" reads a fresh preview and opens the full comparison with the absolute values the FC calculated | `useTuneWorkflow.preview` / `confirmAndApply`  |
| Verify    | expected (firmware-calculated) against read-back, or the failure with its stage and what was saved                                                                                                                            | `tuneWorkflow` store                           |
| Restore   | backups taken from the connected craft (same UID); the dialog shows every value Restore would change (read-only preview); download                                                                                            | `useTuneWorkflow.confirmAndRestore`            |

The Autotune panel's own Apply button uses the same `confirmAndApply`.

## What each tuning part has today

Nothing is computed for the workflow; it aggregates existing outputs. A part is `VALIDATED` only when
every gate that guards it passes.

| Part                            | Status                                                                      | Why                                                                                                                                                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PID (simplified-tuning sliders) | calculation IMPLEMENTED (GyroCore global composite); recommendation BLOCKED | GF-1 holds every proposal at the logged sliders and `phase_margin_not_validated` blocks (`qualification.ts` marks the open-loop model unvalidated); GyroCore Safety blocks `missing_required_analysis`; release conditions open |
| Feedforward                     | BLOCKED                                                                     | M4 never emits an optimal feedforward (`optimalFeedforward: null`); needs ≥ 3 s CHIRP-free acro stick data                                                                                                                      |
| Gyro / D-term filters           | PARTIAL                                                                     | measured (configured Hz, segmented Welch spectrum, M5-B dynamic D path offline); no automatic filter recommendation exists                                                                                                      |
| RPM filter / dynamic notch      | BLOCKED                                                                     | dyn-notch centres and RPM schedule unknown (needs an FFT_FREQ flight)                                                                                                                                                           |
| Blackbox FFT / resonances       | IMPLEMENTED (measurement)                                                   | peaks listed at medium/high reliability; cause not identified, no filter advice from peaks                                                                                                                                      |

## Release procedure (`productLock/productApply.ts`)

Replaces the constant lock. Apply needs both:

- `full_safety_engine_pending` cleared: GyroCore Safety ran with analysis evidence
  (`SafetyResult.analysisEvidence === "available"`). Today Safety has none and blocks every tune itself.
- `independent_pid_validation_missing` cleared: an independent validation (a Verified Tune: a flight that
  confirmed a prediction across a known gain change). Nothing produces one yet.

These come on top of the composite gate (including the M2 phase-margin block) and Safety. In production
every tune therefore stays blocked, with these reasons shown in the checklist.

## Apply route (`src/composables/useTuneApply.ts`)

1. Composite gate, Safety, release procedure: no MSP before these pass.
2. The user's single-use confirmation token for exactly this composite and these sliders
   (`tuning/applyConfirmation.ts`; 2-minute expiry). The interface issues it only after the dialog.
3. Virtual Mode is refused.
4. Fresh identity read: `MSP_API_VERSION`, `MSP_FC_VARIANT`, `MSP_FC_VERSION`, `MSP_BOARD_INFO`, `MSP_UID`,
   `MSP_STATUS_EX`. Compared with the log header (`tuning/fcIdentity.ts`): `DeviceUID` (the three `MSP_UID`
   words), `Board information`, the version in `Firmware revision`; Betaflight (`BTFL`), API ≥ 1.44, disarmed.
5. Fresh `MSP_SIMPLIFIED_TUNING` (no reply, CRC error or refusal blocks) and the live slider recheck; the
   live PIDs must equal the logged `rollPID` / `pitchPID` / `yawPID`.
6. Backup of the craft's own values (sliders, filter Hz, all PID rows, feedforward, d_max) into this
   browser, read back before going on (`stores/tuneBackup.ts`, 20 per craft, by UID).
7. `MSP_CALCULATE_SIMPLIFIED_PID` / `_DTERM` / `_GYRO`: what the firmware says the write produces (the
   SET also applies the gyro filter sliders). The firmware works on a temporary copy (`msp.c`), nothing
   changes on the craft. Steps 3–7 without the backup are `previewTune`: read-only, what the user confirms.
   The confirmation token carries the preview's hash; Apply recomputes it and blocks with
   `apply:preview_changed` if the craft would now produce anything else.
8. `MSP_SET_SIMPLIFIED_TUNING`, `MSP_VALIDATE_SIMPLIFIED_TUNING`.
9. Read back `MSP_SIMPLIFIED_TUNING`, `MSP_PID`, `MSP_PID_ADVANCED` and compare with step 7 (driven axes)
   and the backup (everything else).
10. `MSP_EEPROM_WRITE` only on a full match.

Any problem after the write is a `TuneWriteError` with its stage (`write`, `validate`, `verify`, `eeprom`)
and `saved` (`no`: EEPROM untouched, the saved tune is the previous one; `unknown`: the save itself failed).
It is never shown as success.

## Restore

Accepts only backups in the store (no import), and only a sound one: every value a finite integer in its MSP
range, three PID rows (`restore:backup_invalid` otherwise). Needs its own confirmation, the same UID
(`restore:different_craft`), the same firmware version as when the backup was taken (`restore:firmware_changed`),
Betaflight with API ≥ 1.44, and a disarmed craft. The dialog shows the read-only diff (current against backup);
the token carries the current state's hash (`restore:preview_changed` if the craft changed meanwhile). It backs up the current state first, writes the backed-up sliders, writes the exact PID
rows (`MSP_SET_PID`) and feedforward / d_max (`MSP_SET_PID_ADVANCED`, from a fresh read) when the sliders
alone do not reproduce them, verifies everything against the backup and saves only on a full match.

## What Apply can and cannot change

Apply writes only the six simplified-tuning sliders (master, P/I, I, D, feedforward, D-term filter
multiplier) through `MSP_SET_SIMPLIFIED_TUNING`; the firmware derives PIDs, feedforward, d_max and D-term
filter Hz from them. Nothing writes absolute PIDs, feedforward weights, gyro or D-term filter Hz directly,
nor RPM-filter or dynamic-notch settings. The backup covers exactly the values Apply (and the firmware's
slider recalculation) can change; it is not a full configuration backup (use upstream's backup / CLI `diff all`
for that).

## Unproven on hardware

The simulated FC makes `MSP_CALCULATE_SIMPLIFIED_*` and the values read back after SET agree. On a real
Betaflight binary (built with `-ffast-math`) they come from the same firmware functions, but this has not
been observed. If they differed, every Apply would fail verification (safe, but unusable). The read-only
preview is the first hardware check: it shows the calculated values without writing.

## Tests

- `test/gyrocore/tune_apply_route.test.ts`: the route against a simulated Betaflight FC
  (`test/gyrocore/harness/mspCraft.ts`): confirmation, identity, Virtual Mode, logged PIDs, backup,
  verified write, ignored / partial writes, CRC, timeouts, disconnects, validation failure, EEPROM failure,
  Restore (incl. non-slider PIDs, other craft, armed).
- `test/gyrocore/tune_apply_units.test.ts`, `tune_workflow_panel.test.ts`, `chirp_apply_gate.test.ts`,
  `product_apply_lock*.test.ts`.

No test talks to a real flight controller. A hardware acceptance (connect, read, Apply on a craft where
every gate passes, Restore) is a separate step the user starts.
