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
  live one (the blackbox header has no PID profile index, so the active profile is identified by its values); change-set
  checks (range, read-only, API, `d_max ≥ D` or 0, dynamic min ≤ max — what `validateAndFixConfig` would undo).
- Write: backup of every value; slider modes off first (`MSP_SET_SIMPLIFIED_TUNING` from a fresh read, modes 0 — it also
  stores the LPF values it carries, so they are the live ones); then only the changed blocks, each from a fresh read.
- Verify: full read-back against the expected values (untouched fields must equal the backup); EEPROM only on a full
  match; a second read-back after the save (the firmware reloads and validates); `configStateFlag` reboot request.
- Failures: `TuneWriteError` with stage, saved state (`no` / `unknown` / `yes_adjusted`), mismatches and the fields that
  now differ from the backup (a partial write).
- Restore: slider modes and sliders first, then all three blocks exactly, verify, save, read again.

## Release contract (`gyrocore/releaseGate/`)

Pre-write conditions, each computed from evidence the proposal carries: `measurement`, `model_quality`, `phase_margin`
(validated, ≥ 40°), `robustness` (GM ≥ 6 dB, |S| ≤ 6 dB), `independent_validation` (a Verified Tune for this craft and
firmware whose confirmed PID change covers the proposal), `safety_evidence` (absolute-route evidence contract) and
`items_validated` (every value to write is VALIDATED). Checked on the click: `fc_identity`, `current_config`, `readback`.
The v1 slider route takes the same Verified Tune for its `independent_pid_validation_missing` condition.

Verified Tune (`verifiedTune.ts`): plant from a baseline CHIRP log, plant-fixed prediction for the candidate PIDs, compared
with a second CHIRP log flown with them — closed-loop T up to 40 Hz and the loop L = G·C_fb near the crossover (at high
loop gain T ≈ C_ref/C_fb hides plant errors). Tolerance: twice the baseline-repeat scatter, or the M5-A floors. The change
must be resolvable; both logs distinct; the record has an integrity hash. Only passing records are stored (per craft,
localStorage).

## Engine (`gyrocore/engine/`)

| Module                    | Content                                                                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gyroChain.ts`            | gyro chain in firmware order: lpf2, RPM notches from eRPM (SVF/TPT, weights, fade, round-robin), dynamic lpf1, dynamic-notch SDFT replica; exact FRFs; mean LTI response over a sweep with spread |
| `loopModel.ts`            | chain validation against logged gyroADC; L = G · H_cand/H_cur · C_fb,cand on identified bins; PM, GM,                                                                                             | S   | , delay margin                      |
| `pidOptimizer.ts`         | bounded search for bandwidth under PM ≥ 45°, GM ≥ 6 dB,                                                                                                                                           | S   | ≤ 6 dB; ±30 %; I:P and d_max:D kept |
| `filterOptimizer.ts`      | RPM, dynamic notch, gyro LPF, D-term LPF candidates re-simulated on the logged data                                                                                                               |
| `feedforwardOptimizer.ts` | blocked without acro stick data (2026.6.2: no PID FF in ANGLE); calibrated model otherwise                                                                                                        |
| `safetyEvidence.ts`       | absolute-route Safety evidence contract                                                                                                                                                           |
| `autotuneV2.ts`           | orchestration, part statuses, `required_measurement:*`, full and releasable proposal                                                                                                              |

Status rules: a measurement rejected by qualification is diagnostic only (margins, never a proposal); filter decisions use
qualified axes only; margins are VALIDATED only with a validated chain, a steady chain at the crossover and a Verified
Tune; a candidate that misses a target is shown, never recommended; filter and feedforward results stay PARTIAL until a
flight with them confirms them.

## Tests

`absolute_msp_parity`, `absolute_apply_route`, `release_contract`, `engine_gyro_chain`, `engine_loop_pid_ff`,
`autotune_v2_end_to_end`, `autotune_v2_panel`, and the local `air65_autotune_v2.local`. The firmware simulation
(`test/gyrocore/harness/mspFirmware.ts`) is written from `msp.c`; its replies go through the real MSPHelper decoders.
