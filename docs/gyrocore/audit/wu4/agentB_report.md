# Agent B — GyroCore safety audit (reference d2e60f7, READ-ONLY)

All paths are relative to /home/sliksoft/GyroCore. Line numbers are from the files as they were read during this audit.

Verification run (scratch cwd, `-B`, `-p no:cacheprovider`): `tests/core/safety`, `tests/core/cli` and `tests/core/test_legacy_frozen_regression.py` gave **113 passed, 0 skipped**, EXIT=0. The AeroTuner donor is at /home/sliksoft/aerotuner, so the donor-parity tests really ran. `git status` was unchanged afterwards.

---

## 0. Headline findings

1. **The reference fails open on partial analysis.**
   - `analysis_is_usable` (`safety/analysis_adapter.py:55-60`) rejects only two cases: a non-Mapping, or `ok is False`.
   - Every field that is missing then defaults to "clean":
     - noise cleanliness defaults to 100 (`mechanical.py:421`).
     - confidence defaults to 1.0 (`mechanical.py:430`, `output.py:46-51`).
     - resonance severity defaults to "low".
   - Probed with the clean tune plus pi_gain 108:
     - `analysis={}` gives final **PASS** and authorized CLI.
     - `{"ok": True}` gives **PASS** and authorized.
     - `{"ok": True, "metrics": {"noise": {}}}` gives **PASS** and authorized.
     - `analysis=None` with `require_analysis=False` gives **PASS** and authorized.
   - Only `analysis=None` or `ok:False` with `require_analysis=True` (the default) gives BLOCK `missing_required_analysis`.
2. **Confidence edge bugs.**
   - `output.py:46` `float(conf.get("score", 1.0) or 1.0)`: a score of 0 becomes 1.0, so no warning is raised. NaN is not `< 0.4`, so it also passes. Both probes ended PASS and authorized.
   - `safe_tune.py:132-143` has no `or 1.0`, so a score of 0 *does* trigger the 50% blend. The two stages are inconsistent.
   - Three different thresholds are in use:
     - 0.45 in the mechanical low-confidence check (`mechanical.py:430`).
     - 0.4 for the blend (`clamps.py:88`).
     - 0.4 for the output warning (`output.py:21`).
3. **The firmware gate is stale.**
   - `authorize_cli` classifies `proposal.provenance["firmware"]["version"]` (`cli/authorize.py:44-49,128-132`).
   - That value is always the hard-coded `FIRMWARE_PROVENANCE["version"] = "2026.6.2"` (`autotune/absolute.py:517`, `betaflight/simplified_tuning.py:52-55`). It never comes from the user's BBL header or CLI dump.
   - So `unsupported_betaflight_state` cannot fire on real inputs. The only test that covers it (`test_unsupported_betaflight_version_blocked`) hand-mutates the provenance.
   - None of the WU10 safety stages read the firmware version, board, target, motor, battery or frame.
4. **No temperature is ever measured.**
   - `measured_temperature_available` is hard-coded `False` (`mechanical.py:650`).
   - "Thermal" risk is inferred only from the severity of `problems[type=motor_issue]` and from a motor "health" field. WU4 evidence never emits that health field at the path thermal reads (see §6), so in practice it is driven only by motor_issue severity.
5. **The hardware input is dead on the production path.**
   - `run_safety_pipeline(..., hardware=None)` is how it is called from `apps/desktop/worker/demo_scenarios.py:255`.
   - So the `weight > 800 → D×0.9` rule (`clamps.py:481-502`) never fires there. The constant is named `HARDWARE_WEIGHT_D_SCALE_KG = 800.0`, which is unit-ambiguous: almost certainly grams.
6. **`dterm_lpf1_static_hz` is frozen at baseline.**
   - The key is absent from `DEFAULT_MAX_DELTA["filters"]`, so its step cap defaults to 0 (`clamps.py:97-107,183`).
   - Probe with the dterm multiplier at 50: proposed 37, clamped 75 (the current value).
   - Any proposal that moves it records a clamp, which forces WARN, which gives preview only.
7. **The order of non-PASS IDs is nondeterministic.**
   - `record_numeric_clamps` iterates `set(bf) | set(af)` (`clamps.py:565`).
   - Filter clamp_ids order changes with PYTHONHASHSEED; verified with seeds 1, 2 and 3. The order leaks into `candidate.clamp_ids`, `final.warnings`, TOS `warning_reasons` and preview `reasons`.
8. **Python rounds half to even.**
   - `int(round(x))` is used in `safe_tune.py:75` `_clamped_tv`, and `round()` in `clamps.py:187` for `dyn_notch_count`.
   - Exact .5 values occur:
     - D step 6 × scale 0.75 = 4.5.
     - The blend `b + 0.5*(c-b)` with `c-b` odd.
     - D × 0.9.
   - JS `Math.round` will differ on these values.
9. **No TS safety port and no parity tests exist.**
   - The browser workspace sets `safety: null` (`apps/desktop/gyrocore-app/src/chirp/workspace.ts:177`), with `cli.authorized: false`.
   - `src/runtime/capabilities.ts:26-27,65,82` marks safety as `"unavailable"` in the browser and `"tauri-worker"` in desktop.
   - `src/pages/SafetyPage.tsx` and `src/components/SafetyStage.tsx` only render the Python worker payload. `bridge/types.ts:12,75,99` holds the types for that payload.
10. **The real worker falls back to a synthetic recommendation.**
    - On any exception from `recommend_autotune_from_bbl`, `apps/desktop/worker/analyze_local.py:390-396` substitutes the demo `_recommendation(cli=cli_text)` (all sliders 100, `provenance={"demo": True}`).
    - That proposal can then flow through safety to an "AUTHORIZED SAFE OUTPUT" no-op bundle. This is reference behavior that should not be ported.
11. **The goldens are weak discriminators.**
    - gl001_clean, gl001_with_cli and gl002_noisy all project to the identical `motor_correction_demand_caution` mechanical result.
    - Running the real gl001 and gl002 evidence through the full pipeline gives WARN, then preview, for both.

---

## 1. Input contract

### `run_safety_pipeline` (`safety/pipeline.py:53-66`)

```python
def run_safety_pipeline(proposal: AbsoluteTuneProposal, *, analysis: Mapping[str, Any] | None,
                        hardware: Mapping[str, Any] | None = None, require_analysis: bool = True) -> FinalSafeTuneResult
```

The stages run in fixed order with no skip path:

1. `evaluate_mechanical_safety(analysis, require_analysis=...)` (`mechanical_eval.py:16-96`). It accepts `analysis` plus optional `**gate_kwargs` that override the adapter mapping through `setdefault` (L64-66).
2. `clamp_safe_tune(proposal, mechanical, analysis=, hardware=)` (`safe_tune.py:146-284`):
   - It raises `StageBypassError` unless `mechanical` is a `MechanicalSafetyResult`.
   - It raises `TypeError` unless `proposal` is an `AbsoluteTuneProposal`.
3. `evaluate_tuning_output_safety(candidate, analysis=, require_analysis=)` (`output.py:116-294`). It raises `StageBypassError` unless `candidate` is a `SafeTuneCandidate`.
4. `finalize_safe_tune(tos)` (`pipeline.py:28-50`). It raises unless `tos` is a `TuningOutputSafetyResult`.

Stage tokens: `types.py:18-21`, with `_require_token` at `types.py:34-38`. Each result's `__post_init__` refuses construction without the private token (`results.py:55-57,182-187,228-233,288-294`).

### What `proposal` must contain (`autotune/absolute.py:453-472`)

- **`status`** (str): `"proposed" | "proposed_with_warnings" | "blocked" | "MERGE_REQUIRES_REVIEW"`.
- **`current: AbsoluteTune`**: the baseline, parsed from the CLI dump or headers.
  - `roll`, `pitch` and `yaw` each carry `p`, `i`, `d`, `f` and `d_max` as `TuneValue`.
  - `dterm` and `gyro` each carry `lpf1_dyn_min_hz`, `lpf1_dyn_max_hz`, `lpf1_static_hz` and `lpf2_static_hz`.
  - Also `active_pid_profile` and `sliders`.
- **`proposed: AbsoluteTune | None`**: the absolute PIDs and filters derived by firmware simplified tuning from the merged sliders (`absolute.py:574-594`).
- **`proposed_validity: SliderValidity | None`**, plus `blocked_reasons`, `review_reasons`, `warnings` and `provenance`.

**Safety consumes absolute values, not sliders.**
- Clamps operate on the `{"pid": {...}, "filters": {...}}` dicts built by `absolute_tune_to_config` (`safe_tune.py:50-71`).
- Sliders affect safety only indirectly:
  - through `proposed_validity` (the slider-consistency block, O9 and O10);
  - through the proposal status and blocked reasons.
- `clamped_tune` keeps the merged `sliders` while its values are clamped (`safe_tune.py:118-129`). After clamping, the tune is no longer slider-consistent, and nothing re-validates it.
- `authorize_cli` emits PID and filter `set` lines only, never `simplified_*` (see `cli/settings.py:CANONICAL_SET_ORDER`).

### `analysis`

This is the WU4 `build_analysis_evidence` dict (`analysis/evidence.py:59-273`), or None. See §6 for each field.

### `hardware`

An optional Mapping. Only `hardware["weight"]` is read (`clamps.py:484`). Never supplied in production.

### Firmware and config context

- Safety stages: none.
- `authorize_cli`:
  - The firmware label comes from the static provenance (stale, finding 3).
  - The PID profile comes from `current.active_pid_profile` and must be in 0..3 (`cli/emit.py:66-72`, `PID_PROFILE_MAX=3`).
  - The CLI ranges come from firmware constants: `PID_GAIN_MAX=250`, `F_GAIN_MAX=1000`, `LPF_MAX_HZ=1000`, `DYN_LPF_MAX_HZ=1000` (`betaflight/simplified_tuning.py:31-43`).

---

## 2–3. Rules, reason codes, semantics, thresholds, tests

Status semantics: `SafetyVerdict` has `PASS="pass"`, `WARN="warn"` and `BLOCK="block"` (`types.py:24-27`).
- A mechanical gate result maps to BLOCK if `mechanical_block`, to WARN if `mechanical_limited` or `mechanical_caution`, and to PASS otherwise (`types.py:63-68`).
- Any clamp makes the candidate WARN. WARN at the final stage means **preview only** in `authorize_cli`.

### 2a. Mechanical gate — `safety/mechanical.py:build_mechanical_safety_gate` (L403-654)

Kwargs: `pipeline_problems`, `motor_diagnostics`, `engine_metrics`, `resonance_module`, `confidence_eval`, `quality_status`, `noise_level`, `flight_context`. All are optional, and calling with no kwargs gives PASS `mechanical_clear` (test `test_empty_inputs_match_donor_pass`).

Derived flags:
- **high_noise** (L423-427): `noise_level.upper()=="HIGH"`, or `metrics.noise.value <= 45.0` (default 100.0), or `metrics.noise.hf_ratio >= 0.35` (default 0.0).
- **low_conf** (L428-431): `quality_status.lower()=="low_quality"`, or `confidence_eval.score < 0.45` (default 1.0).
  - WU4 quality can be `"low_confidence"`, which does **not** count; only `"low_quality"` counts.
- **Problem severity** `_severity_score` (L70-72): high 1.0, medium 0.6, low 0.25, anything else 0. Problem confidence defaults to 0.5.
- **Danger text** `_has_danger_text` (L95-116):
  - Regexes: desync, saturat*, failsafe, crash, arming, flyaway, motor stop, motor stall, loss of control.
  - Negations are skipped: no, not, without, never, none and free of, within 0-3 words before the match, or a `-free` suffix.
  - Inferred phrases are stripped first (L82-92): "desync-like risk indicator(s)/symptom(s)", "desync risk", "sync-like correction demand", "saturation risk".
- **Motor counting** `_motor_counts` (L151-199), per row of `motor_diagnostics.motors[*]`:
  - `confidence` defaults to 0.5 and `health` to 100. "Confident" means confidence >= 0.35.
  - **hard_bad** if either:
    - `health < 52` and confident, and (the row has an absolute health basis, or its issues are not only `{noise, imbalance}`); or
    - it is a confirmed bad motor (L123-136): `confirmed_bad_motor` or `confirmed` or `evidence_class in {confirmed, measured}`, or status bad with a spectral issue in `{broadband_noise, abnormal_harmonics, motor_gyro_mismatch}`.
  - **relative_bad** if status is bad and confident. **warnings** if status is warning and confident.
  - Absolute health basis means `health_basis | health_source | health_evidence` is in `{absolute, measured, confirmed}`, or `absolute_health is True`.
- **Resonance** `_resonance_context` (L202-218):
  - `severity` = `engine_metrics.resonance.severity` (anything other than low/medium/high becomes "low").
  - `broad` = `resonance_module.primary.type=="noise"` or `primary.bandwidth>=60` or `resonance_module.spread>=75`.
  - `persistent` = severity "high" or `spread>=90`.

| ID | Reason code | Kind | Condition (file:line) | Test |
|---|---|---|---|---|
| M1 | `motor_issue_high_severity_danger` | BLOCK | type motor_issue, sev>=1.0, conf>=0.55, danger text (L441-442) | `test_motor_desync_danger_blocks` (parity), `test_blocked_mechanical_condition` (pipeline) |
| M2 | `motor_issue_high_severity` | LIMITED | type motor_issue, sev>=1.0, not M1 (L443-444) | `test_motor_issue_limited_without_danger`; also in the gl goldens |
| M3 | `motor_issue_medium_severity` | LIMITED | type motor_issue, sev>=0.6 (L445-446); no confidence floor | probe only |
| M4 | `dangerous_flight_event` | BLOCK | any type, danger text, sev>=0.6, conf>=0.55 (L447-448) | `test_saturation_issue` (parity, does not assert the code) |
| M5 | `mechanical_problem_indicator` | LIMITED | text contains "bent shaft", "bad bearings", "frame resonance" or "mechanical", with sev>=0.6 and conf>=0.25 (L449-451) | gl goldens |
| M6 | `bad_motor_diagnostic` | BLOCK | hard_bad>0 (L456-457) | `test_bad_motor_high_noise_blocks` (parity) |
| M7 | `warning_motor_diagnostic` | LIMITED | relative_bad>0 or warnings>0 (L458-459) | `test_warning_only_motor`, gl goldens |
| M8 | `per_motor_noise_anomaly` | BLOCK if hard_bad>0, else LIMITED | any motor issue in the spectral set (L460-464) | not tested |
| M9 | `broad_frame_resonance_noise` | LIMITED | high_noise and broad (L470-471) | `test_resonance_issue` (parity; no code assert) |
| M10 | `persistent_resonance_with_motor_or_noise_risk` | BLOCK | persistent and hard_bad>0 (L472-474) | not tested |
| M11 | `persistent_resonance_with_noise_risk` | LIMITED | persistent, high_noise, hard_bad==0 (L475-476) | `test_resonance_issue` (parity) |
| M12 | `medium_broad_resonance` | LIMITED | severity medium and broad, not persistent+risk (L477-478) | not tested |
| M13 | `mechanical_noise_low_confidence` | LIMITED | low_conf and (high_noise, or warnings>0, or resonance medium/high) (L480-481) | `test_noisy_log_limited_or_caution` (parity) |
| M14 | correction-demand downgrade | BLOCK becomes CAUTION (WARN) | blocking == exactly `["bad_motor_diagnostic"]` with a clean global-noise context, no confirmed motor, no low-health basis, no confirmed danger in problems (`_is_correction_demand_only_block` L321-362; applied L499-503, L548-556). Clears the block; adds limited `motor_correction_demand_uncertain` and possibly `warning_motor_diagnostic`; caution `motor_correction_demand_caution`; outcome `motor_correction_demand_caution`; downgrade_reason `clean_noise_correction_demand`; scale 1.0. The limited_reasons list is **not** cleared, but `mechanical_limited=False`. | gl goldens (`test_legacy_frozen_regression`) |
| M15 | `noise_low_confidence_capped` | CAUTION (WARN) | `fault.noise_only_low_confidence_should_caution_not_limit` (`fault.py:271-290`): low_conf and high_noise, no fault, limited reasons ⊆ the noise-only set, motors healthy (health>=75, `HEALTHY_MOTOR_HEALTH_MIN`). Removes M13 from limited (L532-541). | `test_noisy_log_limited_or_caution` (parity) |
| M16 | `motor_warning_caution` | CAUTION (WARN) | limited == {`warning_motor_diagnostic`} only, no bad motors, warnings>0, not high_noise, hf<0.35, cleanliness>45, level not HIGH, resonance low, no spectral issue (L365-400, L557-578). Clears limited; outcome `motor_warning_caution`; downgrade_reason `clean_warning_only`; scale 1.0. | `test_warning_only_motor`, `test_warning_only_mechanical_condition` |
| M17 | tier / max_delta_scale | scale | Blocked: 0.0. Caution (M14/M16): 1.0. Otherwise (L579-607): **strong 0.5** if relative_bad>0 or warnings>1, or limited contains any of {motor_issue_high_severity, motor_issue_medium_severity, per_motor_noise_anomaly, broad_frame_resonance_noise, persistent_resonance_with_noise_risk}; **mild 0.75** if warnings==1; **moderate 0.65** if otherwise limited; **none 1.0** | `test_mechanical_scale_zero_freezes_baseline` (scale 0 only) |
| M18 | `mechanical.missing_required_analysis` / `missing_required_analysis` | BLOCK, scale 0 | `require_analysis` and (analysis None, or not usable, i.e. not a Mapping or `ok is False`) (`mechanical_eval.py:36-63` and `67-93`) | `test_missing_required_analysis_fails_closed`, `test_missing_analysis_fails_closed` |

`flight_context` (L274-291) only sets `evidence.aggressive_flight_context`. It has no effect on the verdict.

Gate output keys (L616-654):
- Top level: `mechanical_block`, `mechanical_limited`, `mechanical_caution`, `mechanical_outcome` (one of `mechanical_clear | mechanical_limited | mechanical_block | motor_correction_demand_caution | motor_warning_caution`), `severity` (`blocked | caution | info`), `reasons` (= blocking + limited + caution), `blocking_reasons`, `limited_reasons`, `caution_reasons`, `downgrade_reason`, `recommended_action` (`guidance_only | limited_tune | caution | none`), `user_message`, `evidence{...}`, `limited_tier`, `max_delta_scale`.
- Message constants: L18-37.

`MechanicalSafetyResult.from_gate` (`results.py:59-135`):
- Forces scale to 0.0 on BLOCK (L80-81).
- Check IDs: `mechanical.block.<code>` (BLOCK), `mechanical.limited.<code>` (WARN), `mechanical.caution.<code>` (WARN), and `mechanical.pass` when the result is clean.

### 2b. Fault helpers — `safety/fault.py`

- `MechanicalFaultEvidence.has_fault` (L81-99). It is true on any of:
  - blocking reasons or independent evidence;
  - bad or relative-bad motors;
  - desync;
  - a high-severity motor issue;
  - resonance high;
  - persistent resonance together with (a bad motor or broad resonance);
  - `motor_health < 52`.
- `motors_healthy` (L101-110) requires health >= 75, resonance in {low, none, ""} and no persistence.
- `collect_mechanical_fault_evidence` (L162-219):
  - Health comes from `motor_diagnostics.health`, else `aggregate_motor_health`, else 100. A value <= 1 is treated as a fraction ×100.
  - It applies the `mechanical_clear` semantic guard (L143-159).
- These helpers are used only for M15.

### 2c. Safe-tune clamp stage — `safety/safe_tune.py:clamp_safe_tune` (L146-284) and `safety/clamps.py`

Blocking steps (all BLOCK, which skips clamping and gives `clamped_tune=None`):

| ID | Code | Line | Input | Test |
|---|---|---|---|---|
| S1 | `missing_required_pid_or_filter_baseline:<axis.comp,...>` | `safe_tune.py:177-183`. A missing `d_max` is **excluded** (only fails later in authorize, as rollback_incomplete) | current tune | `test_invalid_baseline` |
| S2 | `malformed_or_empty_proposal` | L186-189 (`proposed is None`) | proposal | `test_unresolved_multi_axis_merge` (indirect) |
| S3 | `unresolved_merge_requires_review` | L191-192 | proposal.status / review_reasons | `test_unresolved_multi_axis_merge`, `test_unresolved_merge_blocked` |
| S4 | each `proposal.blocked_reasons` entry, plus `proposal_blocked` | L193-197 | proposal | `test_system_id_unusable`, `test_unsupported_config_simplified_off` (`simplified_pids_mode_off`) |
| S5 | `mechanical_hard_block` | L199-200 | mechanical | `test_blocked_mechanical_condition` |
| S6 | check `safe_tune.max_delta_scale` (BLOCK if scale<=0 and mechanical BLOCK, else PASS; before 1.0, after scale) | L202-212 | mechanical | `test_trace_answers_why` (presence) |

**Clamp sequence (all WARN):**

**S7. Step clamp.**
- `max_delta = scale_max_delta(DEFAULT_MAX_DELTA, mechanical.max_delta_scale)` (`clamps.py:131-157`). The scale is clamped to [0,1], and a non-finite scale becomes 1.0.
- `apply_to_baseline(current, proposed, max_delta)` (`clamps.py:160-216`). It is absolute: `delta = clamp(target - current, ±md)`.
- Check IDs: `safe_tune.step:<axis>.<comp>` and `safe_tune.step:filter.<key>`.
- **Is the step clamp analysis-dependent? Yes.** The scale comes from the mechanical result, which comes from the analysis.
- `DEFAULT_MAX_DELTA` (`clamps.py:33-72`):
  - PID per axis (roll, pitch and yaw are identical): `p:4, i:8, d:6, ff:8, d_max:6`.
  - A missing `d_max` cap falls back to the D cap; this is a GyroCore bridge (L211).
  - Filters: `gyro_lpf1_static_hz:44, gyro_lpf1_dyn_min_hz:50, gyro_lpf1_dyn_max_hz:60, gyro_lpf2_static_hz:40, dterm_lpf1_dyn_min_hz:20, dterm_lpf1_dyn_max_hz:30, dterm_lpf2_static_hz:30`.
  - There are also these non-Autotune keys, which the Autotune path never uses: dyn_notch_count 1, dyn_notch_min 40, dyn_notch_max 80, dyn_notch_width 5, rpm_filter_harmonics 1, rpm_min 20, rpm_max 100, rpm_fade 20, ff_boost 5, ff_smooth 5, ff_jitter 5, ff_transition 5, rc_smoothing 1, rc_smoothing_ff 5, dyn_idle_min_rpm 10, anti_gravity_gain 1000, anti_gravity_cutoff 2, anti_gravity_p_gain 10, iterm_relax 1, iterm_rotation 1, tpa_rate 5, tpa_breakpoint 50, throttle_boost 5, motor_output_limit 5.
  - **`dterm_lpf1_static_hz` has no cap**, so the default is 0 and the value is frozen (finding 6).
- Tests: `test_p_clamp`, `test_i_clamp`, `test_d_clamp`, `test_ff_clamp`, `test_filter_clamp`, `test_multiple_simultaneous_clamps`, `test_p_i_d_ff_filter_step_caps`, `test_d_max_uses_d_step_gyrocore_bridge`, `test_apply_to_baseline_matches_donor_without_d_max`.

**S8. Confidence blend.**
- Condition: `analysis.confidence.score < CONFIDENCE_BLEND_THRESHOLD = 0.4` and a baseline is present. Effect: `out = b + 0.5*(c-b)` for every pid and filter key. Code `confidence_blend_50pct_toward_baseline` (`clamps.py:468-479`; `_confidence_score` in `safe_tune.py:132-143`).
- A non-finite score means no blend.
- Test: `test_apply_safety_confidence_blend_and_weight` (donor parity, direct call).

**S9. Hardware weight.**
- Condition: `hardware.weight > HARDWARE_WEIGHT_D_SCALE_KG=800.0`. Effect: `d` and `d_max` × `HARDWARE_WEIGHT_D_FACTOR=0.9`. Code `hardware_weight_d_scaled_90pct` (`clamps.py:481-502`).
- Same test as S8.

**S10. Hard (absolute) ranges** `_apply_hard_clamp_ranges_to_config` (`clamps.py:266-452`), called from `apply_safety_autotune` (L515-531) with `skip_zero_hz_min=True`, `preserve_firmware_zeros=True` and `apply_donor_pid_advisory=True`.
- Codes are `"{key}_clamped_min_{lo}"` and `"{key}_clamped_max_{hi}"`, emitted as check `safe_tune.hard.<code>` (WARN, before=after=None). The numeric diff is emitted as `safe_tune.hard:<axis>.<comp>` or `safe_tune.hard:filter.<key>`.

  | Field | Range | Note |
  |---|---|---|
  | `gyro_lpf1_static_hz` | 120..300 | 0 is preserved as OFF |
  | `gyro_lpf1_dyn_min_hz`, `gyro_lpf1_dyn_max_hz` | 0..min(600, DYN_LPF_MAX_HZ=1000)=600 | 0 preserved |
  | `gyro_lpf2_static_hz` | 80..min(500, LPF_MAX_HZ)=500 | <=0 forced to 0 |
  | `dterm_lpf1_dyn_min_hz` | 70..150 | 0 preserved |
  | `dterm_lpf1_dyn_max_hz` | 80..300 | 0 preserved |
  | `dterm_lpf2_static_hz` | 80..250 | <=0 forced to 0 |
  | `dterm_lpf1_static_hz` | **no hard range** | |
  | scalar ranges (L367-388) | | not on the Autotune path |

- Donor PID advisory ranges (L421-440, `DONOR_PID_HARD_RANGES`): `p 10..100`, `d 5..85`, `ff 0..220`.
  - A firmware-legal 0 (yaw D) is kept, because `preserve_firmware_zeros` with `lo>0` and value≈0 skips the check (L432-433).
  - **`i` and `d_max` have no advisory range.**
- Firmware PID ranges (L441-451, `FIRMWARE_PID_HARD_RANGES`): `p, i, d, d_max: 0..250`, `ff: 0..1000`. Codes `"{axis}_{comp}_firmware_clamped_min_{lo}"` and `..._max_{hi}`.
- Tests: `test_apply_safety_matches_donor`, `test_zero_hz_filter_not_raised_on_autotune_path`, `test_filter_clamp` (min 70).

**S11. Cross-field consistency** (`clamps.py:401-413`):
- If `gyro_lpf1_dyn_min > 1e-6` and `dyn_max < dyn_min`, then `dyn_max := dyn_min`. Code `gyro_lpf1_dyn_max_hz_raised_to_dyn_min`.
- If `dterm_lpf1_dyn_min > 1e-6` and `dyn_max < dyn_min + 10`, then `dyn_max := dyn_min + 10`. Code `dterm_lpf1_dyn_max_hz_raised_to_dyn_min_plus_10`.
- Not directly tested.

**S12. Thermal / motor envelope.**
- `apply_thermal_if_needed` (`clamps.py:585-595`) runs when `should_enforce_baseline_envelope(analysis)` is true (`thermal.py:309-319`) and calls `clamp_targets_to_baseline_thermal` (`thermal.py:322-382`).
- Effect: `d` and `d_max` cannot exceed the baseline. Filter Hz cannot exceed the baseline (no filter opening) for gyro lpf1 static/dyn_min/dyn_max, gyro lpf2 static, dterm lpf1 dyn_max/dyn_min, and dterm lpf2 static. A gyro baseline that is non-binding (≈0 or non-finite) is skipped.
- Codes: `safety_cap:{ax}_d_to_baseline`, `safety_cap:{ax}_d_max_to_baseline`, `safety_cap:filter_{key}_to_baseline`, emitted as checks `safe_tune.thermal.<code>` plus numeric `safe_tune.thermal:<...>`.
- Trigger (any one is enough):
  - `classify_thermal_motor_risk` (L119-139):
    - `sev` = the maximum `problems[type==motor_issue].severity`, coerced as critical/high 1.0, medium 0.5, low 0.0, or numeric.
    - `health` = `motor_diagnostics.health`, else `motors.diagnostics.health`, normalized to 0..1, default 1.0.
    - `stress = max(sev, 1-health)`. Tiers: critical >= 0.82, high >= 0.65, medium >= 0.42.
    - `motor_issue_active = sev > 0.05`.
    - `hot_motors` = tier high/critical, or health < 0.52, or sev > 0.38, or (active and health < 0.62).
    - `thermal_risk` = hot, or (active and sev > 0.22).
    - **Enforcement fires if thermal_risk or motor_issue_active.** That means any motor_issue with medium or high severity triggers it; low (0.0) does not.
  - `desync_risk_active` (L142-159): `analysis.has_desync_risk`, `motor_diagnostics.has_desync_risk`, `motors.diagnostics.has_desync_risk`, or any problem type containing "desync".
  - `rpm_dshot_health_gate(analysis, unknown_is_unsafe=False)` (L237-306).
    - If none of these keys is present, the status is unknown and **nothing is enforced**: `rpm_dshot_health`, `filter_intelligence`, `rpm_filter_confidence`, `rpm_harmonic_confidence`, `rpm_frequency_alignment_uncertain`.
    - If any one is present, even `filter_intelligence: {}`, it enforces unless all of the following hold: rpm_filter True, dshot_bidir True, telemetry True, motor poles known, confidence "high", harmonic confidence high-or-empty, no alignment uncertainty, spectral quality not low.
    - Reason codes: `rpm_dshot_status_<status>`, `rpm_filter_missing_or_disabled`, `bidirectional_dshot_missing_or_disabled`, `rpm_telemetry_missing_or_weak`, `motor_poles_unknown`, `rpm_filter_confidence_not_high`, `rpm_harmonic_confidence_not_high`, `rpm_frequency_alignment_uncertain`, `rpm_spectral_quality_low`, `rpm_dshot_health_unknown`. These are internal only and are not surfaced as safety codes.
- Test: `test_thermal_envelope_blocks_d_up_and_filter_opening` (direct call, donor parity). Probe: motor_issue medium or high gives thermal clamps; low gives none.

**S13. Candidate status** (`safe_tune.py:263-269`):
- `clamp_ids` = checks whose verdict is not PASS and whose `before != after`. So the textual `safe_tune.hard.<code>` and `safe_tune.thermal.<code>` IDs are **excluded**; only the numeric diffs are included.
- The status is WARN if there are clamp_ids or the mechanical result is WARN, and PASS otherwise.
- Warning `mechanical_warning_scale_applied` is added when the mechanical result is WARN.
- `proposal.warnings` are passed through into `candidate.warnings` (L161), and from there into the final warnings.

**S14. Back-conversion** `config_to_absolute_tune` (L86-129):
- Every clamped value becomes `TuneValue(name, int(round(v)), ValueSource.INFERRED, "safe_tune_clamp", raw, note)`. This applies to *every* key present in the config, even when it is unchanged.
- `sources_used` gets `"safe_tune_clamp"` appended.

### 2d. Tuning output safety — `safety/output.py:evaluate_tuning_output_safety` (L116-294)

Constants (L21-37): `CONFIDENCE_PID_THRESHOLD=0.4` and the `BLOCK_*` set:
- `mechanical_hard_block`
- `missing_mechanical_safety_stage` (**unused**)
- `missing_safe_tune_stage` (**unused**)
- `missing_required_analysis`
- `missing_required_pid_or_filter_baseline`
- `missing_current_tune` (**effectively unreachable**: it needs `"missing_current_tune"` in `proposal.blocked_reasons`, and that string is produced nowhere in `core/`)
- `unresolved_merge_requires_review`
- `system_id_unusable`
- `invalid_simplified_tuning_state`
- `slider_inconsistency`
- `malformed_proposal`
- `unsupported_betaflight_state` (**unused in output.py**; the equivalent is `DENY_UNSUPPORTED` in authorize)
- `resulting_values_invalid`
- `safe_tune_candidate_blocked`

| ID | Code(s) | Kind | Line | Input | Test |
|---|---|---|---|---|---|
| O1 | `mechanical_hard_block` plus mechanical blocking_reasons | BLOCK | L150-155 | mechanical | `test_blocked_mechanical_condition` |
| O2 | `mechanical_limited_or_caution` plus limited and caution reasons | WARN | L156-159 | mechanical | probe only (no test asserts the string) |
| O3 | `safe_tune_candidate_blocked` plus candidate.blocked_reasons | BLOCK | L161-163 | candidate | probe (`analysis None` gives it) |
| O4 | `unresolved_merge_requires_review` plus review_reasons | BLOCK | L165-167 | proposal | `test_unresolved_multi_axis_merge` |
| O5 | `system_id_unusable` plus codes | BLOCK | L169-174. **Substring heuristic**: `"system" in r.lower()` or `r.startswith("sysid")` | proposal.blocked_reasons | `test_system_id_unusable` |
| O6 | `malformed_proposal` | BLOCK | L176-178 (proposed None and status "blocked") | proposal | `test_unsupported_config_simplified_off` (indirect) |
| O7 | `missing_required_pid_or_filter_baseline` | BLOCK | L180-187 (p, i, d, f present in current; **filters and d_max not checked here**) | current tune | `test_invalid_baseline` |
| O8 | `missing_current_tune` | BLOCK | L189-190 | unreachable | none |
| O9 | `invalid_simplified_tuning_state` plus skipped_reasons | BLOCK | L192-196 | proposed_validity | none |
| O10 | `slider_inconsistency` | BLOCK | L197-198 (any pid, gyro or dterm mismatch) | proposed_validity | `test_slider_inconsistency_blocks` |
| O11 | `missing_required_analysis` (check `tos.required_analysis`) | BLOCK | L200-209 (require_analysis and (not a Mapping, or ok is False)) | analysis.ok | `test_missing_analysis_fails_closed` |
| O12 | `quality_status_low_quality` | BLOCK | L211-213. `analysis.quality.status`, else `analysis.quality_status`, must equal `"low_quality"` | analysis | probe only (the string appears only in donor goldens, which are not compared) |
| O13 | `analysis_confidence_low` (check `tos.analysis_confidence`) | WARN | L215-225 (score < 0.4; missing gives 1.0; **0 gives 1.0**; non-numeric gives 0.0) | analysis.confidence.score | probe only |
| O14 | `noise_level_high` | WARN | L227-228 (`analysis.metrics.noise.level` or `analysis.noise_level` == "HIGH") | analysis | probe only. **Never fires on WU4 evidence**, because `metrics.noise` has keys `grade`, `hf_ratio`, `source` and `value` but no `level`. The adapter's derived `noise_level` is not used here. |
| O15 | `resulting_values_invalid` plus `<axis>.<comp>_out_of_firmware_range`, `<axis>.<comp>_non_numeric`, `<key>_out_of_firmware_range`, `<key>_non_numeric`, `clamped_config_missing` | BLOCK | L76-113, L230-233 (NaN, <0, > PID 250, F 1000, LPF or DYN 1000). Applies only if `clamped_config` is not None | clamped config | none |
| O16 | `safe_tune_clamps_applied` plus clamp_ids | WARN | L235-237 | candidate | `test_p_clamp` and others (indirectly) |

The final status (L239-250) is BLOCK if any blocking reason exists, else WARN if any warning exists, else PASS. The donor status is `blocked`, `limited` or `actionable`. Duplicates are removed in order, and warnings that are also blocking reasons are dropped. Fixed checks: `tos.mechanical_stage_present`, `tos.safe_tune_stage_present`, `tos.mechanical_not_blocked`, `tos.cli_actionable_frozen_false`, `tos.final_verdict`.

### 2e. Finalize — `pipeline.py:28-50`

- `warnings` = TOS warning_reasons + candidate.warnings, deduplicated in order.
- `blocked_reasons` = TOS blocking_reasons.
- Provenance: `{"stages": [mechanical_safety, safe_tune_clamps, tuning_output_safety, final_safe_tune], "actionable": False, "next_wu": "WU11_cli_apply"}`.

### 2f. CLI authorization — `cli/authorize.py:authorize_cli` (L99-235)

Codes are defined at L30-41. The function only accepts a `FinalSafeTuneResult`; anything else raises `StageBypassError`.

| ID | Code | Line | Notes |
|---|---|---|---|
| A1 | final BLOCK: deny with `final.blocked_reasons`, or `final_safety_not_pass` | L112-114 | |
| A2 | `unresolved_merge_requires_review` plus review_reasons | L117-119 | |
| A3 | `blocked_or_review_reasons_present` plus blocked reasons | L120-122 | |
| A4 | `missing_final_target` | L123-124, L141-144 (+`missing_target:<key>`) | |
| A5 | `malformed_final_safe_tune` | L125-126 | also roundtrip failures at L197-202: `apply_roundtrip_mismatch:<k>`, `rollback_roundtrip_mismatch:<k>` |
| A6 | `unsupported_betaflight_state` plus `support.reason` (e.g. `betaflight_firmware_unknown`, `betaflight_firmware_malformed`, `betaflight_version_unsupported_legacy`) | L128-132 | **stale firmware source** (finding 3) |
| A7 | `missing_required_pid_or_filter_baseline` plus `missing_baseline:<k>` | L134-140 | required = all PID keys except d_min, plus the 8 filter keys (`emit.py:60-63`) |
| A8 | `pid_profile_unknown_or_invalid` | L146-149 | source profile must equal target profile, each in 0..3 |
| A9 | `target_values_outside_firmware_range` plus `unsupported_setting:<k>` / `<k>_out_of_range` | L151-154, `_values_in_range` L52-62, `CLI_RANGES` in `cli/settings.py:255-266` | |
| A10 | `rollback_baseline_incomplete` plus `missing_baseline:<k>` | L156-159 | catches a target d_max with no baseline d_max |
| A11 | WARN with no other reason: **preview** (banner `PREVIEW_BANNER`, no `save`), reasons = final.warnings + `warn_is_not_actionable`. WARN with other reasons: deny including `warn_is_not_actionable` | L161-180 | |
| A12 | not PASS: `final_safety_not_pass` | L182-184 | |
| A13 | PASS: `ActionableTuneBundle` | L186-235 | apply CLI is `profile N` + `set k = v` in `CANONICAL_SET_ORDER` + `save` (only if something changed); rollback likewise; `bundle_id` = sha256 of `apply + "\n--rollback--\n" + rollback` |

`DENY_STAGES = "required_safety_stage_missing"` is **unused**.

Tests: `tests/core/cli/test_authorize.py`, including `test_clean_pass_actionable_cli`, `test_warn_not_actionable`, `test_block_not_actionable`, `test_unresolved_merge_blocked`, `test_missing_baseline_blocks`, `test_unsupported_betaflight_version_blocked` (mutated provenance), `test_unknown_profile_blocks`, `test_noop_tune_authorized_without_save`, `test_dmax_emitted_when_target_differs`, `test_deterministic_output`, `test_save_command_policy` and `test_safety_provenance_preserved`. Also `test_invariants.py` (9 tests), `test_roundtrip.py` (6) and `test_goldens.py` (golden files in `tests/fixtures/cli_wu11/*.apply.cli` and `*.rollback.cli`).

### 2g. `models/safety.py` (legacy views)

- `TuningOutputSafetyStatus` values: `actionable`, `limited`, `blocked`, `diagnostic`, `unknown`, `snapshot_partial` (L19-44). `from_legacy` maps `diagnostic_only` to DIAGNOSTIC and `actionable_warning` to ACTIONABLE.
- Views: `MechanicalSafetyView` (L47-80) and `TuningOutputSafetyView` (L83-127).
- `actionable_cli_allowed` (L130-152) requires `present`, `cli_actionable is True`, and a status not in {blocked, diagnostic, unknown}. It fails closed on missing input.
- These are views for the donor and golden projection. The WU10 pipeline never uses them.

---

## 4. Result model and serialization

- **`SafetyCheck.to_dict`** (`types.py:52-60`): `rule_id`, `verdict` (pass/warn/block), `message`, `before`, `after`, `evidence`.
- **`MechanicalSafetyResult.to_dict`** (`results.py:140-157`): `stage` ("mechanical_safety"), `status`, `mechanical_block`, `mechanical_limited`, `mechanical_caution`, `mechanical_outcome`, `recommended_action`, `reasons`, `blocking_reasons`, `limited_reasons`, `caution_reasons`, `max_delta_scale`, `evidence`, `checks`, `provenance`.
  - `to_legacy_dict()` returns the raw gate dict.
  - Evidence keys: `high_noise`, `low_confidence`, `resonance_severity`, `broad_resonance`, `persistent_resonance`, `bad_motor_count`, `relative_bad_motor_count`, `warning_motor_count`, `limited_tier`, `max_delta_scale`, `mechanical_outcome`, `downgrade_reason`, `motor_correction_demand_uncertain`, `mechanical_evidence_strength` (independent/correction_demand/none), `independent_mechanical_evidence`, `aggressive_flight_context`, `measured_temperature_available`.
- **`SafeTuneCandidate.to_dict`** (L189-205): `stage` ("safe_tune_clamps"), `status`, `actionable` (always False), `clamp_ids`, `blocked_reasons`, `warnings`, `max_delta_used`, `current_config`, `proposed_config`, `clamped_config`, `clamped_tune` (`AbsoluteTune.to_dict`), `checks`, `mechanical`, `provenance` (donor list and `gyrocore_bridges`: `d_max_uses_d_step_cap`, `zero_hz_filter_off_preserved`, `zero_pid_yaw_d_preserved`, `firmware_pid_gain_ceilings`).
- **`TuningOutputSafetyResult.to_dict`** (L255-266): `stage` ("tuning_output_safety"), `status`, `donor_status`, `cli_actionable` (always False), `blocking_reasons`, `warning_reasons`, `checks`, `candidate`, `provenance`.
  - `to_legacy_dict` (L235-253): `present`, `status` (actionable/limited/blocked), `cli_actionable` False, `cli_availability` "unavailable", `blocking_reasons`, `hard_block_reasons`, `diagnostic_reasons`, `reasons`, `warnings`, `mechanical`, `snapshot_partial` False.
- **`FinalSafeTuneResult.to_dict`** (L320-336): `kind` ("gyrocore_final_safe_tune"), `stage` ("final_safe_tune"), `status`, `actionable` (False), `non_actionable_notice`, `warnings`, `blocked_reasons`, `current_tune`, `original_proposal`, `clamped_tune`, `mechanical_safety`, `clamp_evidence`, `tuning_output_safety`, `provenance`.
- **CLI results** (`cli/results.py`):
  - `ActionableTuneBundle.to_dict` (L55-75), with kind `gyrocore_actionable_tune_bundle`.
  - `TuneCliPreview` (L100-111): `gyrocore_tune_cli_preview`.
  - `TuneCliDenial` (L133-142): `gyrocore_tune_cli_denial`.
  - `CliAuthorizationResult.to_dict` (L156-163): `status` (authorized/preview/denied), `authorized`, `bundle`, `preview`, `denial`.

---

## 5. Connection to the autotune and merge path

```
AutotuneRecommendationResult (WU8, per-axis sliders)
  → propose_absolute_tune (absolute.py:499-627):
      extract current AbsoluteTune
      → merge_autotune_sliders
      → firmware applySimplifiedTuning
      → proposed AbsoluteTune + validate_simplified_tuning
  → run_safety_pipeline
  → authorize_cli
```

- Safety consumes the **absolute tune**: the current and proposed PIDs and filters.
- From the slider and merge path it uses only:
  - `status == "MERGE_REQUIRES_REVIEW"` or `review_reasons`;
  - `blocked_reasons` (e.g. `simplified_pids_mode_off`, `proposed_pid_sliders_incomplete:*`, `sysid_unusable`);
  - `proposed_validity` mismatches.
- Production callers:
  - `apps/desktop/worker/demo_scenarios.py:255-256`;
  - `apps/desktop/worker/analyze_local.py:397-403` (real BBL, with the demo fallback, finding 10).
- The CSV path has no chirp and does not run safety when no CLI is loaded (`analyze_local.py:347-386`, returning `error_state: missing_cli_baseline`).

---

## 6. Safety dependency map

### 6a. Where each consumed analysis field comes from

Trace through `build_analysis_evidence` (`analysis/evidence.py:59-273`).

| Evidence path read by safety | Read by | Producer module | Present in WU4 output? |
|---|---|---|---|
| `evidence.ok` | mechanical_eval (via `analysis_is_usable`), output O11 | `evidence.py:81` (False) / L244 (True) | yes |
| `evidence.message` | mechanical_eval M18 message | `evidence.py:82` | yes, on failure |
| `evidence.problems.problems[*].{type,severity,confidence,description,suggestion,message}` | mechanical M1-M5, M14; thermal S12 (`type`, `severity`; `"desync"` in type) | `analysis/problem_detection_engine.py:detect_problems`. Types: propwash, oscillation, noise, low_tracking, motor_issue, etc. Severity labels: low, medium, high. | yes |
| `evidence.motors.diagnostics.motors[*].{status,confidence,health,issues,health_basis/health_source/health_evidence,absolute_health,confirmed,confirmed_bad_motor,evidence_class}` | mechanical M6-M8, M14, M16 | `analysis/motor_diagnostics.py:compute_per_motor_diagnostics`. Emits `id`, `health`, `noise`, `status`, `issues`, `confidence`. **No** health_basis or confirmed flags, so the absolute and confirmed paths need spectral issues. | yes (`motors: []` when there is no motor data) |
| `evidence.motors.diagnostics.health` and `.has_desync_risk` | thermal `_motor_health`, `desync_risk_active`; fault `collect_mechanical_fault_evidence` (`md.health`) | **not emitted** by compute_per_motor_diagnostics (keys are `motors` and `worst_motor_id`), so the defaults apply: health 1.0 or 100, no desync | **no** |
| `evidence.motor_diagnostics.*` (top level) | thermal | not emitted at the top level (only inside the internal `analysis_for_metrics`) | no |
| `evidence.has_desync_risk` | thermal | not emitted | no |
| `evidence.metrics.noise.{value,hf_ratio}` | adapter (computes noise_level from cleanliness bands: >=75 LOW, >=50 MEDIUM, else HIGH; missing value is treated as 0, i.e. HIGH); mechanical high_noise | `analysis/metrics_engine.py:build_metrics` → `_noise_block` (L780; noise_model from `signal_composition.build_signal_analysis` / `analysis/noise_model.py`) | yes (keys `grade`, `hf_ratio`, `source`, `value`) |
| `evidence.metrics.noise.level` | adapter (preferred if present), output O14 | not emitted by `metrics_engine` (`noise_model.py` has a `level` key, but it is not projected into `metrics.noise`) | **no**, so O14 is dead |
| `evidence.metrics.resonance.severity` | mechanical `_resonance_context` | `metrics_engine.py:_resonance_block` (L781) | yes |
| `evidence.resonance.{primary.type, primary.bandwidth, spread}` | mechanical broad/persistent | `analysis/resonance.py:analyze_resonance` (`primary` L458-472, `spread` L573); `{"ok": False}` on exception | yes |
| `evidence.confidence.score` | mechanical low_conf (<0.45); safe_tune blend (<0.4); output O13 (<0.4) | `analysis/confidence_unified.py:compute_unified_confidence` (score rounded to 3 dp) | yes |
| `evidence.quality.status` | mechanical low_conf (`== "low_quality"`); output O12 | `analysis/quality_engine_v2.py:evaluate_quality_v2`. Statuses include `low_quality` and `low_confidence`; the fallback is `selection_quality` from `preprocess/flight_selection.py` | yes |
| `evidence.quality_status`, `evidence.noise_level` (top level) | output fallbacks | not emitted | no |
| `evidence.rpm_dshot_health`, `evidence.filter_intelligence`, `evidence.rpm_filter_confidence`, `evidence.rpm_harmonic_confidence`, `evidence.rpm_frequency_alignment_uncertain` | thermal RPM gate | **not emitted** (filter intelligence lives in `analysis/betaflight_filter_model.py` / `filter_evidence`, and is not attached to the evidence) | no, so the gate is "unknown" and not enforced |

**Not consumed by safety:**
- `motors.saturation`, `saturation`, `step_response`, `d_effectiveness`, `erpm`, `spectral`, `fft`, `signal` (propwash, noise_model, fft_peaks), `segments`, `sample_rate_metadata`, `resonance_peaks` and `samples`.
- Motor saturation, clipping and propwash reach safety **only indirectly**, through `detect_problems` rows: a `problems` row of type `propwash`, or with "saturat" in its text, can trigger M4 `dangerous_flight_event`. A `motor_issue` row triggers M1-M3 and the thermal envelope.

**Answer: safety needs specific sub-evidence, not the complete analysis object.** The minimal set is:
1. `ok`
2. `problems.problems[*]` (type, severity, confidence, description/suggestion/message)
3. `motors.diagnostics.motors[*]` (status, confidence, health, issues, plus the optional basis/confirmed flags)
4. `metrics.noise.value` and `metrics.noise.hf_ratio` (and `level` if available)
5. `metrics.resonance.severity`
6. `resonance.primary.type`, `resonance.primary.bandwidth`, `resonance.spread`
7. `confidence.score`
8. `quality.status`
9. Optional and currently absent: `motors.diagnostics.health`, `has_desync_risk`, `rpm_dshot_health` / `filter_intelligence`.

### 6b. Per-rule dependency, missing-evidence behavior and classification

Dependency classes:
- **T**: absolute or current tune only.
- **F**: firmware or config constants.
- **H**: static hardware kwargs.
- **E**: analysis evidence.

Port classes:
- **A**: PORT_NOW_DETERMINISTIC.
- **B**: PORT_NOW_BUT_NOT_AUTHORITATIVE_YET.
- **C**: BLOCKED_BY_ANALYSIS.
- **D**: REFERENCE_STALE_OR_UNSAFE.
- **E**: NEEDS_INVESTIGATION.

| Rule | Depends | Evidence paths | Missing evidence: require_analysis=True (default) | Missing evidence: present but empty Mapping / require=False | Class |
|---|---|---|---|---|---|
| M18 missing_required_analysis (`mechanical_eval.py:36-93`) | E | `ok` | analysis None / ok False: **BLOCK** `missing_required_analysis` | `{}` or `{"ok": True}`: **passes through** to the gate | A (logic) + **D** (fail-open on empty Mapping) |
| Adapter (`analysis_adapter.py:9-51`) | E | see 6a | n/a | empty: all kwargs empty, noise_level None | B |
| M1-M5 problems rules | E | `problems.problems[*]` | BLOCK via M18 | no rows: no reason, PASS | C (logic portable, B) |
| M6-M8, M14, M16 motor rules | E | `motors.diagnostics.motors[*]` | BLOCK via M18 | none: PASS | C |
| M9-M12 resonance rules | E | `metrics.resonance.severity`, `resonance.primary.*`, `resonance.spread` | BLOCK via M18 | defaults: low, not broad, not persistent, PASS | C |
| high_noise flag | E | `metrics.noise.value`/`hf_ratio`, derived `noise_level` | BLOCK via M18 | value missing but the noise dict present: adapter says HIGH, so high_noise; with no other evidence still PASS (probe). No metrics: cleanliness 100, clean | C |
| M13, M15 low-confidence rules | E | `quality.status`, `confidence.score` | BLOCK via M18 | defaults: not low_conf | C |
| M17 scale tiers | E (via the gate) | — | BLOCK gives 0.0 | 1.0 | C |
| fault.py helpers | E (via the gate) | `motors.diagnostics.health` (never emitted) | — | health 100 | B / E (the health field is never produced) |
| S1-S5 structural blocks | T + proposal | — | n/a | n/a | **A** |
| S6 max_delta_scale check | E (via mechanical) | — | BLOCK | PASS | B |
| S7 step clamp `apply_to_baseline` + `DEFAULT_MAX_DELTA` | T, and **scaled by mechanical (E)** | — | blocked earlier | scale 1.0 | **A** for the pure function; the effective caps depend on analysis, so **B** in the pipeline. The `dterm_lpf1_static_hz` freeze is **D/E** |
| S8 confidence blend | E | `confidence.score` | — | none means no blend | C, with the inconsistency in **D** |
| S9 hardware weight | H | `hardware.weight` | — | never applied | **E** (dead input, ambiguous unit) |
| S10 hard ranges and firmware PID ranges | T + F | — | — | — | **A** |
| S11 cross-field dyn min/max | T | — | — | — | **A** |
| S12 thermal envelope | E | `problems[type=motor_issue].severity`, `*.has_desync_risk`, `motor(s).diagnostics.health`, RPM keys | — | absent: not enforced (PASS) | C; the RPM sub-gate is **E** (no producer; a partial `filter_intelligence` makes it enforce); "thermal" naming is **D** (no temperatures) |
| S13 status and clamp_ids | T | — | — | — | A, but the **ordering is D** (hash-seed dependent) |
| S14 rounding to int | T | — | — | — | A (must replicate round-half-even) |
| O1-O3 | from earlier stages | — | — | — | A |
| O4-O7, O9, O10 | T + proposal | — | — | — | **A** |
| O8 `missing_current_tune` | — | — | — | — | **D** (unreachable) |
| O11 missing_required_analysis | E | `ok` | BLOCK | `{}`: no block | A + **D** (fail-open) |
| O12 quality_status_low_quality | E | `quality.status` | — | absent: no block | C |
| O13 analysis_confidence_low | E | `confidence.score` | — | absent or 0 gives 1.0: no warning | C + **D** (`or 1.0`, NaN) |
| O14 noise_level_high | E | `metrics.noise.level` | — | never emitted | **D** (dead on WU4 evidence) |
| O15 resulting_values_invalid | T + F | — | — | — | **A** |
| O16 safe_tune_clamps_applied | T | — | — | — | A |
| Unused constants: `BLOCK_MISSING_MECHANICAL`, `BLOCK_MISSING_SAFE_TUNE`, `BLOCK_UNSUPPORTED`, `DENY_STAGES` | — | — | — | — | D (do not port as live rules; stage bypass raises `StageBypassError` instead) |
| A1-A5, A7-A13 authorize | T + F (CLI ranges, profile) | — | — | — | **A** |
| A6 firmware support | F | static `FIRMWARE_PROVENANCE` | — | — | **D** (must take the real version from the CLI dump or BBL header) |
| Worker demo fallback (`analyze_local.py:390-396`) | — | — | — | — | **D** |

**Answer to item 6** (what happens when the CHIRP path cannot supply analysis):
- The browser currently has `analysis: null`.
- In the reference, `analysis=None` with the default `require_analysis=True` gives:
  - mechanical **BLOCK** (`missing_required_analysis`, scale 0);
  - candidate **BLOCK** (`mechanical_hard_block`);
  - TOS **BLOCK** with `blocked_reasons = ["mechanical_hard_block", "missing_required_analysis", "safe_tune_candidate_blocked"]`;
  - authorize **denied** with the same reasons.
- With `require_analysis=False`, or with an empty Mapping, the reference gives PASS and authorized. That is fail-open and must not be ported.

**Answer to "is the deterministic clamp stage analysis-dependent?"** Yes, in three ways:
1. The step caps are multiplied by `mechanical.max_delta_scale`: 0, 0.5, 0.65, 0.75 or 1.0.
2. The confidence blend reads `confidence.score`.
3. The thermal envelope reads `problems`, motor health and desync.

The pure functions (`apply_to_baseline`, `scale_max_delta`, `_apply_hard_clamp_ranges_to_config`, `clamp_targets_to_baseline_thermal` given a boolean) are deterministic and portable.

---

## 7. Rule inventory (distinct live rules)

- Mechanical: M1-M18 = **18** (including the scale-tier rule M17 and the require-analysis rule M18).
- Safe-tune: S1-S14 = **14** (the 6 blocks/checks S1-S6 plus 8 clamp or semantic rules S7-S14).
  - S10 expands to 6 filter ranges, 3 donor PID ranges and 5 firmware PID comps.
- Thermal sub-triggers: thermal_risk, motor_issue_active, desync and the RPM gate = 4, counted inside S12.
- Output: O1-O16 = **16** (O8 unreachable, O14 dead on real evidence).
- Authorize: A1-A13 = **13**.
- **Total: 61 rule IDs.** Of these:
  - 2 are unreachable or dead on real evidence (O8, O14);
  - 4 constants are unused (`BLOCK_MISSING_MECHANICAL`, `BLOCK_MISSING_SAFE_TUNE`, `BLOCK_UNSUPPORTED`, `DENY_STAGES`).

Classification counts across the 6b rows (35 rows; each component is classified once by its dominant class):
- **A**: 14 (S1-S5, S10, S11, S13, S14, O1-O3, O4-O7/O9/O10 group, O15, O16, A1-A5/A7-A13 group, and M18 logic).
- **B**: 4 (adapter, S6, S7 in-pipeline, fault helpers).
- **C**: 9 (M1-M5, motor rules, resonance, high_noise, low-confidence, M17, S8, S12, O12/O13).
- **D**: 8 (empty-Mapping fail-open, O8, O13 `or 1.0`, O14, unused constants, A6 stale firmware, clamp-id ordering, demo fallback).
- **E**: 3 (S9 hardware weight, RPM gate, `dterm_lpf1_static_hz` frozen cap: intended or bug?).

---

## 8. Determinism

1. **Hash-seed ordering** (`clamps.py:565`): filter clamp_ids, warnings and preview reasons are reordered from run to run. Python tests only use `in` or `any(...)` membership checks, so they never notice. A port must sort or canonicalize, or compare as sets.
2. **Round half to even**: `int(round(x))` in `safe_tune.py:75` and `clamps.py:187`. A port must use banker's rounding to match.
3. **Float math**:
   - Clamps use float64 arithmetic (`cur + clamp(delta)`, `b + 0.5*(c-b)`, `×0.9`, `×scale`).
   - The `1e-9` and `1e-6` epsilons are at `clamps.py:404,411,553,572` and `thermal.py:346,352,379`.
   - Confidence is pre-rounded to 3 dp by the producer.
4. **Emitted CLI is deterministic**: integer values in `CANONICAL_SET_ORDER`, and `bundle_id` is sha256. `test_deterministic_output` compares two calls on the same object, and `test_goldens.py` compares byte-exact files in `tests/fixtures/cli_wu11/`.
5. **What the Python tests compare**:
   - Pipeline tests check status enums, integer clamped values (e.g. `clamped_p == current_p + 4`, dterm dyn_min `== 70`) and substring membership of codes.
   - Parity tests compare dict fields with `==` against the donor, and use `pytest.approx` for blend and weight.
   - Frozen regression compares `projected.mechanical_safety.*` against the donor golden, normalizing string lists with `normalize_string_list`.
   - `tuning_output_safety` in the goldens (which contains `quality_status_low_quality` and `analysis_confidence_low`) is **not compared**.

---

## 9. Fixtures and tests used

- `tests/core/safety/test_pipeline.py`: 25 tests. Inline `NOMINAL_CLI` and `_clean_analysis`.
- `tests/core/safety/test_clamps_parity.py`: 8 tests. Donor at `$AEROTUNER_ROOT` or `../aerotuner`; skipped if absent.
- `tests/core/safety/test_mechanical_parity.py`: 13 tests. Uses `tests/fixtures/legacy/gl001_clean/input/flight.csv` and `gl002_noisy/input/flight.csv`.
- `tests/core/safety/test_analysis_adapter.py`: 2 test functions (10 parametrized cases, WU17 noise bands).
- CLI test function counts: `test_authorize.py` 27, `test_goldens.py` 6, `test_invariants.py` 9, `test_roundtrip.py` 6.
- `tests/golden/safety.py`: `assert_safety_invariants` and `assert_wu11_cli_invariants`.
- `tests/core/test_legacy_frozen_regression.py` with `tests/golden/frozen_regression.py`: the **WU17** end-to-end path (CSV → analysis → adapter → gate), compared against `tests/fixtures/legacy/{gl001_clean,gl001_with_cli,gl002_noisy}/expected/legacy_domain_result.json`. All three expect the identical `motor_correction_demand_caution` result. "WU17 mechanical safety" means exactly this wiring: `analysis_adapter.py` plus `frozen_regression.py:85-86,138,211-216`.
- `tests/core/cli/{helpers,test_authorize,test_invariants,test_roundtrip,test_goldens}.py`, plus `tests/fixtures/cli_wu11/*.cli` (12 files).

---

## 10. Probe results

Scratch probes were run against the clean NOMINAL_CLI tune; the slider is 100 unless stated.

| Input | Final | Authorize |
|---|---|---|
| clean analysis | PASS | authorized (no-op) |
| None | BLOCK [mechanical_hard_block, missing_required_analysis, safe_tune_candidate_blocked] | denied |
| ok:False | same BLOCK | denied |
| `{}`, `{"ok": True}`, `{"ok": True, "metrics": {"noise": {}}}` | **PASS** | **authorized** |
| None with require_analysis=False, pi 108 | **PASS** | **authorized** |
| confidence 0 or NaN | **PASS** | authorized |
| confidence 0.3 | WARN [analysis_confidence_low] | preview |
| explicit metrics.noise.level HIGH | WARN [noise_level_high] | preview |
| quality low_quality | BLOCK [quality_status_low_quality] | denied |
| pi 108 | PASS | authorized {p_roll 48, i_roll 86, p_pitch 50, i_pitch 90, p_yaw 48, i_yaw 86} |
| pi 200 | WARN with step clamps | preview |
| dterm multiplier 50 | WARN; dyn_min 37→70 (hard), static 37→75 (frozen), dyn_max 75→120, lpf2 75→120 | preview |
| weight 900 | WARN with hard d/d_max clamps | preview |
| motor_issue medium (conf 0.3) | WARN, mechanical_limited, scale 0.5, thermal caps | preview |
| motor_issue high | same as medium | preview |
| motor_issue low | PASS | — |
| `filter_intelligence: {}` | WARN with thermal caps | preview |
| real gl001 / gl002 evidence, pi 108 | WARN motor_correction_demand_caution, scale 1.0 | preview |

The gl001 and gl002 evidence: `metrics.noise` = {grade, hf_ratio 0.0, source, value 99.9} with no `level`; confidence 0.58 / 0.569; quality `low_confidence`.
