# Autotune engine v2

Implementation of `AUTOTUNE_ENGINE_V2_PLAN.md`. Web app only; the user always clicks Apply; no firmware change, no new
MSP message.

## Flow

| Step      | Code                                                                                    | Writes to the FC |
| --------- | --------------------------------------------------------------------------------------- | ---------------- |
| Analyze   | CHIRP qualification, M4, Blackbox Viewer decode (`gyrocore/engine/logInput.ts`)         | no               |
| Calculate | `gyrocore/engine/autotuneV2.ts`                                                         | no               |
| Compare   | `AutotuneV2Panel.vue`: every proposed value with its status                             | no               |
| Preview   | `previewAbsoluteTune` (identity, live values, change set)                               | no               |
| Apply     | `applyAbsoluteTune`, only for the released, VALIDATED part, after a confirmation dialog | yes              |
| Verify    | read-back of every firmware-held value, EEPROM, read-back after the save, reboot flag   | read only        |
| Restore   | `restoreAbsoluteTune` from the stored backup                                            | yes              |

## Absolute route (`composables/useTuneApply.ts`, `gyrocore/tuning/absoluteTune.ts`)

- Fields: every firmware-held value of `MSP_PID` (all rows), `MSP_PID_ADVANCED` and `MSP_FILTER_CONFIG`, by CLI name, in
  firmware order (Betaflight 2026.6.2 `msp.c`), with `settings.c` ranges. Deprecated slots MSPHelper decodes but the
  firmware ignores are not fields. `tpa_rate` is the raw U8. RPM fade / Q / weights need API 1.48; the route needs 1.45.
- Gates before any MSP: release contract, single-use confirmation bound to the preview hash.
- Live checks: UID, board, firmware, Betaflight, disarmed, API; every logged profile- and filter-scoped value equals the
  live one (the blackbox header has no PID profile index, so the logged profile is identified by its values); change-set
  checks (range, read-only, API, `d_max ≥ D` or 0, dynamic min ≤ max — what `validateAndFixConfig` would undo).
- Reads: every tuning reply must be complete for the MSP API (PID 15, PID_ADVANCED 61, FILTER_CONFIG 49 / 56 from 1.48,
  SIMPLIFIED_TUNING 53 bytes); a CRC-valid shorter reply or a missing value blocks, never reads as 0.
- PID profile: the active profile (MSP_STATUS_EX) is part of the backup, the expected snapshot and the preview hash.
  MSP_STATUS_EX is read again after every snapshot read, before every SET and before MSP_EEPROM_WRITE; a profile switch or
  arming stops the transaction. Each field has a scope: PID, PID_ADVANCED, D-term / yaw filter fields and the PID / D-term
  sliders are per profile, gyro / dynamic notch / RPM filters and the gyro sliders are global (shown in the dialogs).
- Write: backup of every value; slider modes off first (`MSP_SET_SIMPLIFIED_TUNING` from a fresh read, modes 0 — it also
  stores the LPF values it carries, so they are the live ones); then only the changed blocks, each from a fresh read.
- Verify: full read-back against the expected values (untouched fields must equal the backup); EEPROM only on a full
  match; a second read-back after the save (the firmware reloads and validates); `configStateFlag` reboot request.
- Failures: `TuneWriteError` with stage, saved state (`no` / `unknown` / `yes_adjusted`), mismatches and the fields that
  now differ from the backup (a partial write), or null when the craft could not be read (or another profile is active).
  The panel shows the phase, the cause, the saved state and that current state (unknown / as backup / differing values).
- Restore: only into the PID profile the backup was read from (a backup without a profile index is refused); slider
  modes and sliders first, then all three blocks exactly, verify, save, read again.

## Release contract (`gyrocore/releaseGate/`)

Pre-write conditions, each computed from evidence the proposal carries: `measurement`, `model_quality`, `phase_margin`
(validated, ≥ 40°), `robustness` (GM ≥ 6 dB, |S| ≤ 6 dB), `independent_validation` (a Verified Tune for this craft and
firmware, measured from exactly this log's configuration, whose measured segment covers the change: see below), `safety_evidence` (absolute-route evidence contract) and
`items_validated` (every value to write is VALIDATED). Checked on the click: `fc_identity`, `current_config`, `readback`.
The v1 slider route takes the same Verified Tune for its `independent_pid_validation_missing` condition.

Verified Tune (`verifiedTune.ts`): plant from a baseline CHIRP log, plant-fixed prediction for the candidate PIDs, compared
with a second CHIRP log flown with them — closed-loop T up to 40 Hz and the loop L = G·C_fb near the crossover (at high
loop gain T ≈ C_ref/C_fb hides plant errors). Tolerance: twice the baseline-repeat scatter, or the M5-A floors. The change
must be resolvable; baseline, candidate and repeat distinct flights; the record has an integrity hash. Only passing
records are stored (per craft, localStorage; record kind `gyroflight.verified_tune.v2`, v1 records are refused).

What a record covers (`validatedRegionIssues`): a change from exactly the baseline's logged absolute configuration, lying
on the measured segment baseline → candidate with one common fraction per axis for P, I, D, F and d_max (integer
rounding allowed). Not covered: a reverse step, a step past the candidate, another combination of terms, any filter value,
and any step from another starting point — the candidate tune itself included. A further step needs a new gain-change
flight from the current tune.

In the app (`engine/verifiedTuneFromLogs.ts`, panel button _Create Verified Tune from these logs_): the imported logs are
grouped by logged tune; the tune imported last is the candidate, the one before it the baseline, a second baseline log the
repeat (a flight imported twice is one flight). The engine attests only when the record's baseline is the primary log's
configuration, and then searches PID candidates only on the record's segment (the contract's own predicate).

The v1 slider route reads the same record but stays blocked: GyroCore Safety's slider path is unchanged (it still returns
`missing_required_analysis`) and the composite phase-margin hold remains. The satisfiable contract is the absolute
route's; this was deliberate.

## Engine (`gyrocore/engine/`)

| Module                    | Content                                                                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gyroChain.ts`            | gyro chain in firmware order: lpf2, RPM notches from eRPM (SVF/TPT, weights, fade, round-robin), dynamic lpf1, dynamic-notch SDFT replica; exact FRFs; mean LTI response over a sweep with spread |
| `loopModel.ts`            | chain validation against logged gyroADC; L = G · H_cand/H_cur · C_fb,cand on identified bins; PM, GM,                                                                                             | S   | , delay margin                      |
| `pidOptimizer.ts`         | bounded search for bandwidth under PM ≥ 45°, GM ≥ 6 dB, \|S\| ≤ 6 dB; ±30 % without a record (shown, never released), only the Verified Tune's measured segment with one; I:P and d_max:D kept |
| `filterOptimizer.ts`      | RPM, dynamic notch, gyro LPF, D-term LPF candidates re-simulated on the logged data                                                                                                               |
| `feedforwardOptimizer.ts` | blocked without acro stick data (2026.6.2: no PID FF in ANGLE); calibrated model otherwise                                                                                                        |
| `safetyEvidence.ts`       | absolute-route Safety evidence contract                                                                                                                                                           |
| `autotuneV2.ts`           | orchestration, part statuses, `required_measurement:*`, full and releasable proposal                                                                                                              |

Status rules: a measurement rejected by qualification is diagnostic only (margins, never a proposal); filter decisions use
qualified axes only; the chain is validated only when every control band (2–20, 20–80 Hz) is coherent and matches;
margins are VALIDATED only with a validated chain, a steady chain at the crossover, a crossover inside 2–80 Hz, a single
unity crossing (an upward re-entry or a loop still above unity at the band end blocks; PM and GM are the worst over all
crossings; a band-limited |S| peak is unknown) and a Verified Tune bound to this configuration; cross-log reproducibility
counts only an independent flight (not the same file or the same samples) of the same craft, firmware and configuration; a candidate that misses a target is shown, never recommended; filter and feedforward results stay PARTIAL until a
flight with them confirms them.

## Tests

`absolute_msp_parity`, `absolute_apply_route`, `release_contract`, `engine_gyro_chain`, `engine_loop_pid_ff`,
`autotune_v2_end_to_end`, `autotune_v2_panel`, the `codex_review_*` counterexamples, and the local
`air65_autotune_v2.local`. The firmware simulation (`test/gyrocore/harness/mspFirmware.ts`) is written from `msp.c`, with
four PID profiles; its replies go through the real MSPHelper decoders. Its simplified tuning is checked against
`simplified_tuning.c` itself, compiled on the host (`harness/simplified_tuning_c/`).
