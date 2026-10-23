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
  The stages tell five states apart: `prepare` (a check or fresh read failed before the first SET: this attempt sent no
  SET and wrote no EEPROM; the craft was not read back afterwards, so its current state is not verified, and a profile
  switch seen there is named as the now active profile; the backup and its profile stay available; a failure outside the
  tracked stages says that a sent SET is not recorded), `write` with an unreadable craft (a SET was sent, its result is unknown), `write` with
  differing fields (a partial write the craft kept), `verify` (written, not verified) and `eeprom` / `eeprom_verify`
  (saved state unknown). The panel shows the phase, the cause, the saved state and that current state.
- Profile switch after a SET: the firmware has no profile-bound atomic write, so a switch between the last MSP_STATUS_EX
  check and the SET puts that block into the other profile's RAM. The route catches it at the next check (stage `verify`
  or `write`, `fc:pid_profile_changed:a->b`); the panel then names the profile that may hold the write, states that
  EEPROM was not written, says not to save, and gives the recovery: reboot so RAM reloads from EEPROM, check that profile,
  select the original profile and Restore if it differs.
- Restore: only into the PID profile the backup was read from (a backup without a profile index is refused); slider
  modes and sliders first, then all three blocks exactly, verify, save, read again.

## Release contract (`gyrocore/releaseGate/`)

Pre-write conditions, each computed from evidence the proposal carries: `measurement`, `model_quality`, `phase_margin`
(validated, ≥ 40°), `robustness` (GM ≥ 6 dB, |S| ≤ 6 dB; both conditions require the same margin evidence to be
VALIDATED, see "Margin evidence" below, and fail closed on missing or malformed evidence), `independent_validation` (a Verified Tune for this craft and
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
| `loopModel.ts`            | chain validation against logged gyroADC; L = G · H_cand/H_cur · C_fb,cand on identified bins; PM, GM,                                                                                             | S   | , delay margin |
| `pidOptimizer.ts`         | bounded search for bandwidth under PM ≥ 45°, GM ≥ 6 dB, \|S\| ≤ 6 dB; ±30 % without a record (shown, never released), only the Verified Tune's measured segment with one; I:P and d_max:D kept    |
| `filterOptimizer.ts`      | RPM, dynamic notch, gyro LPF, D-term LPF candidates re-simulated on the logged data                                                                                                               |
| `feedforwardOptimizer.ts` | blocked without acro stick data (2026.6.2: no PID FF in ANGLE); calibrated model otherwise                                                                                                        |
| `safetyEvidence.ts`       | absolute-route Safety evidence contract                                                                                                                                                           |
| `autotuneV2.ts`           | orchestration, part statuses, `required_measurement:*`, full and releasable proposal                                                                                                              |

Status rules: a measurement rejected by qualification is diagnostic only (margins, never a proposal); filter decisions use
qualified axes only; the chain is validated only when every control band (2–20, 20–80 Hz) is coherent and matches;
margins are VALIDATED only with a validated chain, a steady chain at the crossover, a crossover inside 2–80 Hz, a single
unity crossing (an upward re-entry or a loop still above unity at the band end blocks; PM and GM are the worst over all
crossings; a band-limited |S| peak is unknown), a bounded band end (`loopModel.ts` `BAND_END`: over the top 10 % of the
identified band |L| may not rise by more than 1 dB and at the last bin it may not exceed −6 dB, the release gain-margin
target; otherwise GM and |S| are unknown and the margins are NOT_VALIDATED, since a resonance just above the band could
take the loop back above unity; with a bounded band end GM never exceeds the gain headroom at the band end), a band
the bins resolve (`loopModel.ts` `LOOP_RESOLUTION`: no step between adjacent bins larger than 25° / 2 dB, or than
300°/neper / 80 dB/decade of its log-span; no gap wider than 3× the neighbouring steps; no step wider than half its
frequency from half the crossover up; otherwise GM and |S| are unknown, the evidence level is `MEASURED` and the margins
are NOT_VALIDATED, and the PID search asks for `chirp_with_finer_frequency_resolution`), a Verified Tune bound to
this configuration, and evidence level `VALIDATED` (below). Every margin result reports PM, GM and |S| read on the
bins (`measured`) and, when the bins resolve the loop, PM, GM and |S| as bounds: the bins plus the between-bin allowance
`BIN_SAGITTA` (≈ 0.11 × the chord between adjacent L points, from the 25° step limit).

Margin evidence (`loopModel.ts` `MarginEvidence`, Codex final acceptance F-02). Bounds read on discrete bins hold only
for a model class: a loop without features narrower than `RESOLVED_FEATURE_BINS` (≈ 4.5) × the resolution. A finite set
of bins cannot exclude an arbitrarily narrow resonance between two bins (a pole/zero pair with ζ = 5e-5 at 70.25 Hz on
0.5 Hz bins leaves < 0.1 dB on the bins, while |L(70.25 Hz)| ≈ 2). Each result therefore carries one evidence level
with its resolution (`resolutionHz`, the largest bin step), validity band (`bandHz`), the narrowest feature the bounds
account for (`minFeatureWidthHz`), the assumptions as codes, and the qualification:

| Level               | Meaning                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------ |
| `MEASURED`          | read on the bins only; GM and \|S\| bounds unknown. A research result, never a bound.            |
| `MODEL_CONDITIONAL` | bounds under the stated assumptions, not independently qualified. Shown, never release evidence. |
| `VALIDATED`         | those bounds with the model class qualified by a finer, independent CHIRP log (below).           |
| `INSUFFICIENT`      | no margins could be read.                                                                        |

`status` is VALIDATED only with level `VALIDATED` and no other reason, and `marginEvidenceIssues` is the one check
that promotes bounds to VALIDATED; the release contract runs it again on what reaches it, for `phase_margin` and
`robustness` alike, and also refuses a qualification from the proposal's own log or bounds better than the
qualification measured. Qualification (`MODEL_CLASS_QUALIFICATION`, engine input `modelClassQualification`): a CHIRP log
of another flight with the same craft, firmware and configuration (the cross-log identity rules), identified at a
resolution with `RESOLVED_FEATURE_BINS` × its step ≤ the primary's step, over the same band. With the candidate
controller its loop must be resolved with a bounded band end and no unity re-entry, and its PM / GM / |S| may not be
worse than the primary's bounds by more than 5° / 1.5 dB (the M5-A scatter): otherwise `FAIL`, the bounds are void
(`MEASURED`, the worse PM). Too coarse, too short or no margins: `INSUFFICIENT`, the margins stay `MODEL_CONDITIONAL`.
`PASS`: the reported margins are the worse of both logs. The remaining limit is the finer log's own class (features
narrower than `RESOLVED_FEATURE_BINS` × its step); no margin is an absolute stability guarantee. No producer of a
qualification log exists in the app yet (the CHIRP analysis picks its Welch segment length from the sample rate
alone, `chirp/qualification.ts` `chooseSegmentSize`), so the app shows the requirement
`chirp_finer_resolution_model_class_qualification` instead of releasing. Cross-log
reproducibility counts only an independent flight of the same craft,
firmware and configuration: not the same file, not the same samples, and not the same flight trimmed, re-exported or
time-shifted (`logInput.ts` `FLIGHT_WINDOW`: flights are identified by content-anchored 256-sample gyroADC windows,
constant stretches excluded; four shared windows make one flight; overlapping fragments form one flight transitively,
`flightGroups`, so a fragment B overlapping both A and C makes A and C one flight although they share no sample; the
file kept for a group carries the identity of every file in it, `flightGroup`, and the engine groups its own inputs
too), and not a reference whose plant comes out bit-identical
(`cross_log_identical_measurement`); a candidate that misses a target is shown, never recommended; a Verified Tune whose
gain-change flight also moved feedforward yields no PID candidate and says so
(`verified_tune_segment_moves_feedforward`); filter and feedforward results stay PARTIAL until a flight with them confirms
them.

## Tests

`absolute_msp_parity`, `absolute_apply_route`, `release_contract`, `engine_gyro_chain`, `engine_loop_pid_ff`,
`autotune_v2_end_to_end`, `autotune_v2_panel`, the `codex_review_*` counterexamples, and the local
`air65_autotune_v2.local`. The firmware simulation (`test/gyrocore/harness/mspFirmware.ts`) is written from `msp.c`, with
four PID profiles; its replies go through the real MSPHelper decoders. Its simplified tuning is checked against
`simplified_tuning.c` itself, compiled on the host (`harness/simplified_tuning_c/`).
