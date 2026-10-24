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
- Gates before any MSP: the write authority (`gyrocore/releaseGate/writeAuthority.ts`, below), then the single-use
  confirmation bound to the preview hash. The authority runs again after the live reads (before the backup) and right
  before the first SET; a step that no longer holds there stops the Apply at stage `prepare` with nothing sent.
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
- Saved state of MSP_EEPROM_WRITE (both routes, audit F-03): `no` only on the firmware's own refusal (MSP_RESULT_ERROR,
  e.g. armed); a timeout, no answer or a CRC-corrupt answer is `unknown`, since the firmware may have saved before the
  answer was lost. The slider route reads the tune again after the save, as the absolute route does (`eeprom_verify`:
  `unknown` when unreadable, `yes_adjusted` when the firmware changed a value on reload).
- Uncertain state (`gyrocore/stores/fcTransactionState.ts`): every failure after the first SET (any stage but `prepare`)
  of an Apply or a Restore is recorded per craft UID in this browser, with stage, saved state and the backup taken
  before it. Every Apply on that craft is refused (`fc:transaction_state_uncertain:<backup>:<stage>:<saved>`, checked
  before any MSP against the logged UID and again against the live UID) until its state is known: a verified Restore
  (written, read back, saved, read again) clears it; so does the read-only check `checkTransactionState` when EEPROM was
  not written (saved `no`), no profile switch was seen, and a full read-back equals that backup (after a power cycle
  RAM reloads the EEPROM this write never touched). With saved `unknown` / `yes_adjusted` only a Restore clears it.
  Unreadable storage of this record refuses every Apply (`fc:transaction_state_unreadable`). Both panels show the
  record and the check (`UncertainStateNotice.vue`).
- Profile switch after a SET: the firmware has no profile-bound atomic write, so a switch between the last MSP_STATUS_EX
  check and the SET puts that block into the other profile's RAM. The route catches it at the next check (stage `verify`
  or `write`, `fc:pid_profile_changed:a->b`); the panel then names the profile that may hold the write, states that
  EEPROM was not written, says not to save, and gives the recovery: reboot so RAM reloads from EEPROM, check that profile,
  select the original profile and Restore if it differs.
- Restore: only into the PID profile the backup was read from (a backup without a profile index is refused); slider
  modes and sliders first, then all three blocks exactly, verify, save, read again.

## Write authority (`gyrocore/releaseGate/writeAuthority.ts`)

One authority for both Apply routes, in the project's gate order (composite → Safety → product lock, then the route's
live readback and recheck). Each step is recomputed from the stores on every call; nothing a proposal carries counts as
authorization by itself. Any missing, malformed or unevaluable evidence is `APPLY_DENIED` with the step's reasons.

| Step             | Slider route (`applyTune`)                  | Absolute route (`applyAbsoluteTune`)                                                                                                                                                                                                                            |
| ---------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| composite        | `assertCompositeApplyAuthorized`            | `analysis_binding` (`analysisBinding.ts`): the proposal equals, field for field, the current analysis's releasable proposal (analysis `done`); at the write point the engine runs again on the decoded inputs and the Verified Tune store and must reproduce it |
| release contract | (none: the slider route has no v2 contract) | `evaluateRelease` (below)                                                                                                                                                                                                                                       |
| Safety           | `assertSafetyAuthorized`                    | `absoluteSafetyAuthorization` (`safety/authorize.ts`), bound to the proposal id and change. GyroCore Safety has no evaluation of absolute values: always BLOCK `missing_required_analysis`                                                                      |
| product lock     | `assertProductApplyReleased`                | `productApplyBlocks` with Safety's evidence and the Verified Tune this browser holds now; the record the proposal carries must be that one (`independent_pid_validation_not_current`)                                                                           |

Consequence: the absolute route is denied in every case today, whatever the release contract says, until GyroCore
Safety gains an evaluation of absolute values. Write-path tests release the steps they do not test through the harnesses
in `test/gyrocore/harness/` (`analysisBindingRelease`, `safetyRelease`, `productRelease`). Restore is not a proposal and
stays outside the authority (own confirmation, same UID / firmware / profile, backup first).

Binding details: `applyAbsoluteTune` authorizes, confirms and writes a plain-data copy of the proposal taken on entry
(a getter, a function or a class instance is refused: `apply:proposal_not_plain_data`; Vue proxies are read through),
and the rechecks require the store's decoded inputs and result to still be the objects the authorization recomputed
against, each input the same object and log, compared by index so a deleted entry counts as a change
(`binding:analysis_changed_since_authorization`). Calculate publishes the inputs frozen (the array, each log and its
channel object); an edit of the samples themselves is not detected without the recomputation. The comparison
(`canonicalText`) serializes plain data only, without `toJSON`.

Confirmation: every token (slider Apply, absolute Apply, both Restores) must carry the hash of the read-only preview the
user saw; a token without one is refused (`apply:confirmation_without_preview`) and every route compares the hash with
the one it recomputes (Restore: the current tune and the backup's target, `restoreHash`).

Shared FC store: the absolute route puts target values into the store only after the last check and right before the
SET that sends them. If the check refuses there, the craft's values go back into the store; if a SET fails and the craft
cannot be read afterwards, the backup's values do; otherwise the store holds what was last read from the craft. So the
PID tab's Save never finds a proposal value the route did not get verified onto the craft. The absolute Preview
computes its expected values in memory (it only reads the craft into the store).

The slider Preview (`previewTune`) runs the firmware calculation through the shared FC store, where MSPHelper decodes its
replies and the PID tab's Save would write them. It therefore needs the slider route's whole write authority, so an
unauthorized proposal never enters that store (today: Preview is refused while Apply is, since GyroCore Safety blocks),
and it puts the live values back even when a calculation fails. Its button is offered exactly when Apply is, with a line
saying why otherwise.

Open risks: MSP has no atomic check-and-write. The last check runs synchronously before the first SET is handed to
`MSP.promise`, and `MSP_STATUS_EX` is re-read before every SET, but a change on the craft between that read and the SET
(a profile switch, arming) is caught only afterwards (stage `write` / `verify`); the transport may queue or retry a
request after the check, and a calculation reply arriving after its timeout is still decoded into the FC store
(authorized Previews only). Separate Apply / Restore calls with distinct tokens, and upstream saves, are not serialized
against each other.
The binding proves that the proposal follows from the decoded inputs in the store; that those are the currently
imported files rests on the source revision (a calculation still running when the files changed publishes nothing).

## Release contract (`gyrocore/releaseGate/`)

Pre-write conditions, each computed from evidence the proposal carries: `measurement`, `model_quality`, `phase_margin`
(validated, ≥ 40°), `robustness` (GM ≥ 6 dB, |S| ≤ 6 dB; both conditions require the same margin evidence to be
VALIDATED, see "Margin evidence" below, and fail closed on missing or malformed evidence), `independent_validation` (a Verified Tune for this craft and
firmware, measured from exactly this log's configuration, whose measured segment covers the change: see below), `safety_evidence` (absolute-route evidence contract) and
`items_validated` (every value to write is VALIDATED). Checked on the click: `fc_identity`, `current_config`, `readback`.
The v1 slider route takes the same Verified Tune for its `independent_pid_validation_missing` condition.

Verified Tune (`verifiedTune.ts`): plant from a baseline CHIRP log, plant-fixed prediction for the candidate PIDs, compared
with a second CHIRP log flown with them — closed-loop T up to 40 Hz and the loop L = G·C_fb near the crossover (at high
loop gain T ≈ C_ref/C_fb hides plant errors). Tolerance: twice the baseline-repeat scatter, or the M5-A floors; never
more than `MAX_REPEAT_TOLERANCE_FACTOR` (3) × the floor: a bin where the repeat scatters more is not compared against a
wider band, and an axis with more than 20 % such bins is `INSUFFICIENT` (audit P1-4). The change
must be resolvable; baseline, candidate and repeat distinct flights; the record has an integrity hash. Only passing
records are stored (per craft, localStorage; record kind `gyroflight.verified_tune.v2`, v1 records are refused).

What a record covers (`validatedRegionIssues`): a change from exactly the baseline's logged absolute configuration, lying
on the measured segment baseline → candidate with one common fraction per axis for P, I, D, F and d_max (integer
rounding allowed). Not covered: a reverse step, a step past the candidate, another combination of terms, any filter value,
and any step from another starting point — the candidate tune itself included. A further step needs a new gain-change
flight from the current tune.

In the app (`engine/verifiedTuneFromLogs.ts`, panel button _Create Verified Tune from these logs_): the imported logs are
grouped by logged tune; the tune imported last is the candidate, the one before it the baseline, a second baseline log the
repeat (a flight imported twice is one flight). The repeat must pass the cross-log reference rules against the baseline
(independent flight, same craft, firmware and whole logged configuration, not only the same P/I/D/F; audit P1-4),
otherwise none is used and the reasons name why. The engine attests only when the record's baseline is the primary log's
configuration, and then searches PID candidates only on the record's segment (the contract's own predicate).

The v1 slider route reads the same record but stays blocked: GyroCore Safety's slider path is unchanged (it still returns
`missing_required_analysis`) and the composite phase-margin hold remains. The release contract is one step of the
absolute route's write authority, not the whole of it: GyroCore Safety blocks that route too (see "Write authority").

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

Cross-log plant reproducibility (`plant_identification`): only a reference sweep the qualification passed in full
(`usable`) counts; a rejected one, or one with warnings, is named (`cross_log_reference_not_qualified`) and never
validates the plant (audit P1-5). Every qualified reference is compared: the worst decides, and references that disagree
with each other make it FAIL (`cross_log_references_disagree`), so one agreeing reference never outvotes another.

Stale calculations (audit P1-7): the store's source revision moves on with every import or reset; Calculate and _Create
Verified Tune_ publish only for the revision they started on (a record from files no longer imported is not stored).

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
`chirp_finer_resolution_model_class_qualification` instead of releasing.

Qualification band (audit P1-2, `QUALIFICATION_BAND_EXTENSION` 1.5): a qualification must reach 1.5 × the primary's
band end (BAND_END's own figures: a resonance from about 1.5 × f_end shows < 0.5 dB in the primary's tail), otherwise
`qualification_band_not_extended` and the margins stay `MODEL_CONDITIONAL`; after a PASS the remaining tail assumption
names the qualification's band end. Its resolution must come from its own samples (`AnalysisProvenance`: bins no denser
than fs / segment samples, a window that holds its segments, ≥ 8 Welch segments; `qualification_resolution_not_shown`
otherwise), so padded or interpolated bins never qualify.

Measurement uncertainty (`UNCERTAINTY`, WP3): per bin the random error of the H1 estimate (Bendat & Piersol, eq. 9.90 /
9.91) from coherence and independent averages, carried to L with |C_ref / (C_ref − T·C_fb)|. Averages for the
exponential Betaflight sweep (`sweepAverages`, from the log's chirp headers): T / (Ts² f ln(f1/f0)), at least 1 (near
an AIR65 crossover: 1, whatever the Welch segment count). Fewer than 8 Welch segments: uncertainty unknown, no bounds. A
bin whose ±2 ε reaches half its value is left out as not identified (counted in the evidence). The bounds are the worst
of the nominal loop and four corners with every bin moved by the same ±2 ε in gain and phase; a corner that changes the
crossings leaves no bounds. `measured` keeps the values on the bins; the release contract requires the uncertainty with
VALIDATED evidence (`margin_evidence_uncertainty_missing`). Phase checks (`PHASE_CHECKS`): an unwrap step that, with
±2 σ at both bins, exceeds 90° is ambiguous; the absolute branch must be the rate plant's (phase in (−180°, 0°] at the
lowest bin) plus the controller's; at least three bins in the octave around the crossover. Each failure leaves the
margins unbounded (`MEASURED`). These are the model's assumptions, carried in `MarginEvidence.assumptions`.

Measurement planner (`engine/measurementPlan.ts`, informative, shown under the margins): per axis the band (to
|L| ≤ −12 dB, extrapolated along the tail; a qualification 1.5 × further), the bin step the measured phase slope needs
and the qualification's (÷ RESOLVED_FEATURE_BINS), the power-of-two Welch segment for both, the averages needed at the
crossover for 2 σ ≤ 2.5° and the sweep duration or repeats that give them, and what the data show (coherence dips,
possible narrow features, noise near the crossover, a poorly resolved crossover). It changes no analysis and
releases nothing; `chooseSegmentSize` and the qualified primary transfer function are unchanged.

Fixed factors: 25° / 4.5× (`LOOP_RESOLUTION`, `RESOLVED_FEATURE_BINS`), 5° / 1.5 dB, −6 dB and the coherence limits are
calibrated on AIR65 / M5-A logs only (NOT_VALIDATED across craft classes); the new ones (1.5×, 8 segments, 90°,
3 bins, k = 2, ε limit 0.5, the planner's −12 dB and 2.5°) are design parameters derived in the code comments, not
calibrated. Cross-log
reproducibility counts only an independent flight of the same craft,
firmware and configuration: not the same file, not the same samples, and not the same flight trimmed, re-exported or
time-shifted (`logInput.ts` `FLIGHT_WINDOW`: flights are identified by content-anchored 256-sample gyroADC windows,
constant stretches excluded; four shared windows make one flight; overlapping fragments form one flight transitively,
`flightGroups`, so a fragment B overlapping both A and C makes A and C one flight although they share no sample; the
file kept for a group carries the identity of every file in it, `flightGroup`, and the engine groups its own inputs
too), and not a reference whose plant comes out bit-identical
(`cross_log_identical_measurement`). Independence itself needs positive evidence (`flightRelation`, audit F-01):
`SAME` (one log, one sample set, or ≥ 4 shared active windows), `INDEPENDENT` only for two recording sessions shown
as such (no shared active window, enough movement in each for an overlap to show, each flight holding its session's
first frame, loopIteration 0, where the firmware starts every log, and no equal session start time or real
`Log start datetime`), and `UNKNOWN` otherwise (a few shared windows, an export from inside a session, missing session
data, a quiet log). A flight's session start may come from any of its linked fragments. `UNKNOWN` is never a
reference, a model-class qualification or a Verified Tune repeat, and is not merged; the panel then asks for
`complete_log_of_an_independent_flight`. Several CHIRP sweeps of one flight, exported as separate files, are therefore
not independent, whatever band each covers. A candidate that misses a target is shown, never recommended; a Verified Tune whose
gain-change flight also moved feedforward yields no PID candidate and says so
(`verified_tune_segment_moves_feedforward`); filter and feedforward results stay PARTIAL until a flight with them confirms
them.

## Tests

`absolute_msp_parity`, `absolute_apply_route`, `release_contract`, `engine_gyro_chain`, `engine_loop_pid_ff`,
`autotune_v2_end_to_end`, `autotune_v2_panel`, the `codex_review_*` counterexamples, and the local
`air65_autotune_v2.local`. The firmware simulation (`test/gyrocore/harness/mspFirmware.ts`) is written from `msp.c`, with
four PID profiles; its replies go through the real MSPHelper decoders. Its simplified tuning is checked against
`simplified_tuning.c` itself, compiled on the host (`harness/simplified_tuning_c/`).
