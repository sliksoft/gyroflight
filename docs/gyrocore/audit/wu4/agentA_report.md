# Agent A — GyroCore absolute tune / firmware mapping audit (WU4)

GyroCore is at d2e60f7 and was treated as read-only. The target is Gyroflight `gyroflight/wu4-safety` @ 1e4dc1ee.
Betaflight master is `4fc1520c5a5decddc8ef07ad57c0e766ea8747ba`. Tag 2026.6.2 is `e0b7bb01b17b21351057e9ead2d1ab39dd44fa16` (from `git ls-remote`).

Process note: the first scratch dir (`agentA_1791555745`) disappeared during the session. One probe, `probe6.py`, was briefly written to the GyroCore root by mistake and then moved here, so the repo tree is clean again. All probe results quoted below were captured in-session.

## Files (real locations)
- `core/gyrocore/autotune/absolute.py`: 639 lines (WU9 proposal).
- `core/gyrocore/autotune/current_tune.py`: 369 lines (WU8 current tune).
- `core/gyrocore/autotune/merge.py`: GyroCore global slider merge.
- `core/gyrocore/betaflight/simplified_tuning.py`: 474 lines (firmware port).
- `core/gyrocore/safety/safe_tune.py`: 291 lines (WU10 clamps, config<->AbsoluteTune).
- `core/gyrocore/safety/output.py:25-37`: TOS block constants.
- `core/gyrocore/chirp/sysconfig.py:203` `header_pairs`, `:73` `js_parse_int`.
- `core/gyrocore/parse/firmware_metadata.py:112` `_normalize_field_key`: lowercase, strip leading `_`, spaces -> `_`.
- `third_party/betaflight/firmware/`: vendored 2026.6.2 extract (`simplified_tuning.c/.h`, `flight/pid.h`, `sensors/gyro.h`, `common/maths.h`, `fc/parameter_names.h`, `msp/msp_simplified_tuning.c`).
- `tools/simplified_tuning_reference/{build.py,harness.c,include/*}`: C oracle harness. It compiles the vendored `.c` with gcc `-std=c11 -O0 -DUSE_SIMPLIFIED_TUNING -DUSE_D_MAX -DUSE_DYN_LPF`.
- `docs/upstream/SIMPLIFIED_TUNING_PARITY.md`, `AUTOTUNE_GLOBAL_SLIDER_POLICY.md`.

## 1. simplified_tuning.py: constants, formulas, semantics

Provenance (`simplified_tuning.py:52-67`) is `FIRMWARE_PROVENANCE = {repository: https://github.com/betaflight/betaflight, version: "2026.6.2", commit: "e0b7bb01b17b21351057e9ead2d1ab39dd44fa16", functions: [...]}`.

Constants (`:20-50`) match the vendored headers and Betaflight master:
- `SIMPLIFIED_TUNING_PIDS_MIN=0`, `SIMPLIFIED_TUNING_FILTERS_MIN=10`, `SIMPLIFIED_TUNING_MAX=200`, `SIMPLIFIED_TUNING_DEFAULT=100`, `SIMPLIFIED_TUNING_D_DEFAULT=100`
- `PID_SIMPLIFIED_TUNING_OFF/RP/RPY = 0/1/2`
- `PID_GAIN_MAX=250`, `F_GAIN_MAX=1000`
- `PID_ROLL_DEFAULT=(45,80,30,120,0)`, `PID_PITCH_DEFAULT=(47,84,34,125,0)`, `PID_YAW_DEFAULT=(45,80,0,120,0)`, `D_MAX_DEFAULT=(40,46,0)`
- `DTERM_LPF1_DYN_MIN_HZ_DEFAULT=75`, `DTERM_LPF1_DYN_MAX_HZ_DEFAULT=150`, `DTERM_LPF2_HZ_DEFAULT=150`
- `LPF_MAX_HZ=1000`, `DYN_LPF_MAX_HZ=1000`, `GYRO_LPF1_DYN_MIN_HZ_DEFAULT=250`, `GYRO_LPF1_DYN_MAX_HZ_DEFAULT=500`, `GYRO_LPF2_HZ_DEFAULT=500`
- `AUTOTUNE_SLIDER_MIN=25`, `AUTOTUNE_SLIDER_MAX=250`

Numeric primitives:
- `c_float(x)` (`:73`): float32 round-trip via `struct.pack("f")`.
- `_fadd/_fsub/_fmul/_fdiv` round every step to float32.
- `c_constrain(amt, lo, hi)` (`:94`): `int()` truncates toward 0, then clamps. This is C `constrain(int,int,int)` after implicit float->int conversion.
- `c_scale_hz(default, mult, max)` (`:104`): `constrain((default*mult)//100, 0, max)`, integer arithmetic.
- `_ratio(s)` = `_fdiv(c_float(s), 100.0f)`, matching C `uint8 / 100.0f`.

Dataclasses:
- `AxisPid(p,i,d,f,d_max)`
- `FilterSet(lpf1_dyn_min_hz, lpf1_dyn_max_hz, lpf1_static_hz, lpf2_static_hz)`
- `SimplifiedSliders(pids_mode=2, master_multiplier=100, i_gain=100, d_gain=100, pi_gain=100, d_max_gain=100, feedforward_gain=100, pitch_d_gain=100, pitch_pi_gain=100, dterm_filter=1, dterm_filter_multiplier=100, gyro_filter=1, gyro_filter_multiplier=100)`. `None` means not supplied. Field-group helpers:
  - `missing_for_pids()` covers the 9 PID fields (pids_mode .. pitch_pi_gain).
  - `missing_for_dterm()` covers `(dterm_filter, dterm_filter_multiplier)`.
  - `missing_for_gyro()` covers `(gyro_filter, gyro_filter_multiplier)`.
- `PidProfileState(roll,pitch,yaw,dterm:FilterSet,sliders)`, `GyroConfigState(filters,sliders)`
- `FieldMismatch(field,current,expected_from_sliders)`
- `SliderValidity(pids_valid,gyro_valid,dterm_valid,pid_mismatches,gyro_mismatches,dterm_mismatches,skipped_reasons)`. Its `to_dict` keys are `slider_pids_valid, slider_gyro_valid, slider_dterm_valid, pid_mismatches, gyro_mismatches, dterm_mismatches, skipped_reasons`.

Functions:
- `firmware_default_pid_profile()` (`:208`): firmware defaults, with dterm FilterSet(75,150,75,150).
- `firmware_default_gyro()` (`:225`): FilterSet(250,500,250,500).
- `calculate_new_pid_values(profile)` (`:241`). For `axis in 0..2`, an axis with `axis > mode` is kept unchanged, which mirrors the C loop `axis <= simplified_pids_mode`. Otherwise, with `pitchD`/`pitchPi` equal to the slider ratio on pitch and 1.0f elsewhere:
  - `P = constrain(def.P*master*pi*pitchPi, 0, 250)`
  - `I = constrain(def.I*master*pi*i*pitchPi, 0, 250)`
  - `D = constrain(def.D*master*d*pitchD, 0, 250)`
  - `F = constrain(def.F*master*pitchPi*ff, 0, 1000)`
  - `dMaxGain = dmax>0 ? s/100 + ((1 - s/100)*def.D)/dmaxDef : 1.0`. The C evaluation order is `*` then `/`.
  - `d_max = constrain(dmaxDef*master*d*pitchD*dMaxGain, 0, 250)`
  - Each product is evaluated left to right in float32.
  - **PIDs are derived from firmware defaults x sliders, never from the current PID values.**
- `apply_simplified_tuning_pids` (`:280`) returns the profile unchanged if `pids_mode in (None, 0)`.
- `calculate_new_dterm_filter_values` (`:286`) is skip-if-zero:
  - If `dyn_min != 0`: `dyn_min = scale(75, m, 1000)` and `dyn_max = scale(150, m, 1000)`.
  - If `static1 != 0`: `static1 = scale(75, m, 1000)`. This uses the dyn-min default and DYN_LPF_MAX_HZ, exactly as in C.
  - If `static2 != 0`: `static2 = scale(150, m, 1000)`.
- `apply_simplified_tuning_dterm_filters` (`:301`) does nothing unless `dterm_filter` is truthy.
- The gyro equivalents (`:307`, `:321`) use 250/500/250/500 with the same structure.
- `apply_simplified_tuning(profile, gyro)` (`:327`) runs pids, then dterm, then gyro.
- `validate_simplified_tuning(profile, gyro)` (`:385`) is MSP_VALIDATE_SIMPLIFIED_TUNING. It recomputes and compares field by field. If a slider group is incomplete, that group is invalid and a skipped reason is appended.
- `sliders_outside_cli_range(sliders)` (`:418`) returns names outside the CLI minmax:
  - PID ratios [0,200]
  - `d_max_gain`, `feedforward_gain` [0,200]
  - filter multipliers [10,200]

These ranges were checked against tag/master `cli/settings.c`.

## 1b. absolute.py: public API and semantics

Module constants:
- `PROPOSAL_KIND="gyrocore_absolute_tune_proposal"` (`:55`)
- `NON_ACTIONABLE_NOTICE` (`:56`)
- `_ON_OFF`, `_PIDS_MODE` (`:61-62`)

Key tables:
- `_EXTRA_SLIDER_KEYS` (`:65`):
  - `d_max_gain` <- `simplified_d_max_gain|simplified_dmax_gain`
  - `pitch_pi_gain` <- `simplified_pitch_pi_gain`
  - `pitch_d_gain` <- `simplified_pitch_d_gain|simplified_roll_pitch_ratio`
  - `gyro_filter_multiplier` <- `simplified_gyro_filter_multiplier`
- `_GYRO_FILTER_ON=("simplified_gyro_filter",)`, `_DTERM_FILTER_ON=("simplified_dterm_filter",)`
- `_PID_KEYS` (`:74`): `p_roll|roll_p`, etc.
- `_FF_KEYS` (`:91`): `f_roll|ff_roll|roll_ff|roll_f`, etc.
- `_DMAX_KEYS` (`:96`): `d_max_roll|d_min_roll`, etc.
- `_DTERM_KEYS` (`:101`): `dterm_lpf1_dyn_min_hz`, `dterm_lpf1_dyn_max_hz`, `dterm_lpf1_static_hz`, `dterm_lpf2_static_hz`.
- `_GYRO_KEYS` (`:107`): the same four names with the `gyro_` prefix.

Value helpers:
- `TuneValue` (current_tune.py:72) has fields `name, value, source: ValueSource{parsed,defaulted,inferred,missing}, origin, raw, note`. `present` is true iff the source is PARSED or INFERRED. `to_dict` returns `{name,value,source,origin,raw,note}`.
- `_missing(name, note)` (`:115`) returns `TuneValue(name, None, MISSING, "none", None, note)`.
- `_int_tv` (`:119`): `None` gives missing with note "absent". bool/int pass through as parsed. Otherwise `js_parse_int`, and a failure gives MISSING with note "unparseable".
- `_enum_tv` (`:133`) maps ON/OFF/RP/RPY names (case-insensitive) or ints.
- `_first_present(cfg, keys)` (`:150`) is a case-insensitive key lookup.
- `_tv_or_missing(tv, name, comp)` (`:244`) takes P/I/D from a CurrentTune pid tuple `(P,I,D)` as `int(raw[idx])`. If the tuple is too short, the result is missing with note `"not in BBL header or CLI"`.
- `_pick_header_or_cli(header_cfg, cli_cfg, keys, name, enum=None)` (`:254`): a present header value wins, then a present CLI value. If neither is present, it returns the non-present header tv, else the CLI tv, else `_missing(name)`.

Dataclasses:
- `AbsoluteAxis(p,i,d,f,d_max)` provides `to_dict`, `missing_fields`.
- `AbsoluteFilters(lpf1_dyn_min_hz, lpf1_dyn_max_hz, lpf1_static_hz, lpf2_static_hz)` provides `as_filter_set_or_none`, which returns None if any field is missing.
- `AbsoluteTune(sliders, roll, pitch, yaw, dterm, gyro, active_pid_profile, current_tune, warnings, sources_used)`:
  - `to_pid_profile()` returns None if any axis field or any dterm field is missing.
  - `to_gyro()` returns None if any gyro field is missing.
  - `to_dict()` has keys `sliders, roll, pitch, yaw, dterm, gyro, active_pid_profile, warnings, sources_used`.

`extract_absolute_tune(*, headers=None, cli_dump=None, log_index=0, current_tune=None) -> AbsoluteTune` (`:274`):
1. `tune = current_tune or extract_current_tune(headers, cli_dump, log_index)`.
2. `header_cfg = dict(header_pairs(headers))`. Keys are normalized to lowercase.
3. If a CLI dump is given, `cli_cfg = parse_cli_profile_blocks(cli)["active_profile_config"]`, and `active_rateprofile_config` is merged in with setdefault. Block warnings containing "ambiguous" are added as `cli:{w}`.
4. Extra sliders come from `_pick_header_or_cli`. `dterm_filter` prefers `tune.simplified_dterm_filter`.
5. `SimplifiedSliders` takes:
   - `pids_mode` and `dterm_filter` from `tune`
   - `master_multiplier, i_gain, d_gain, pi_gain, feedforward_gain, dterm_filter_multiplier` from `tune.sliders`
   - `d_max_gain, pitch_d_gain, pitch_pi_gain, gyro_filter, gyro_filter_multiplier` from the extra lookups
6. Axes:
   - P/I/D come from `tune.pids[axis]` (header `rollPID` CSV wins, then CLI `p_roll`...). If the pid tv is not present, `_PID_KEYS` are used.
   - F comes from `_FF_KEYS`. d_max comes from `_DMAX_KEYS`.
7. Filters are looked up by exact CLI names.
8. A warning `slider_missing:{n}` is added for each missing pids/dterm/gyro slider.
9. Warnings are deduped in order.

`propose_absolute_tune(recommendation, *, headers=None, cli_dump=None) -> AbsoluteTuneProposal` (`:499`):
1. `current = extract_absolute_tune(headers, cli_dump, current_tune=recommendation.current_tune)`.
2. `merge = merge_autotune_sliders(recommendation.axes, current.sliders)`.
3. `per_axis = {axis_name: proposed_sliders_unvalidated}`. These are Autotune keys such as `slider_master_multiplier`.
4. `warnings = current.warnings + recommendation.warnings`; `blocked = recommendation.blocked_reasons`; `current_validity = _validity_for(current)`.
5. `provenance = {firmware: FIRMWARE_PROVENANCE, autotune: rec.provenance, merge_policy, merge_kind}`.
6. If the merge status is MERGE_REQUIRES_REVIEW, return status `"MERGE_REQUIRES_REVIEW"`, `proposed=None`, `deltas={}`, `review_reasons=merge.review_reasons`.
7. Mapping blocks:
   - `"simplified_pids_mode_off"` if `pids_mode == 0`
   - `"proposed_pid_sliders_incomplete:" + ",".join(missing_for_pids())`
   - `"proposed_dterm_sliders_incomplete:" + ",".join(missing_for_dterm())`
8. Warning `"proposed_sliders_outside_cli_minmax:" + ",".join(names)`.
9. If any mapping block is set, return status `"blocked"`, `proposed=None`, `blocked_reasons = rec.blocked + mapping_block`.
10. Seed filters come from `_placeholder_filters(current.dterm/gyro)`, where a missing Hz becomes 0. When a seed set is incomplete, add warning `"proposed_dterm_hz_from_present_or_zero_missing_not_defaulted"` or `"proposed_gyro_hz_from_present_or_zero_missing_not_defaulted"`.
11. The seed profile has all-zero axes plus the seed dterm and merged sliders. Run `apply_simplified_tuning`. The proposed values are `TuneValue(..., INFERRED, "firmware:applySimplifiedTuning", ..., "mapped from sliders")`, and `sources_used=("firmware_simplified_tuning",)+current.sources_used`.
    - **Caveat:** under RP mode the yaw axis stays at the seed value 0 (P=I=D=F=0) rather than the current yaw (probe-confirmed). See D3.
12. `proposed_validity = validate_simplified_tuning(mapped)`.
13. `deltas[f"{axis}.{comp}"]` and `deltas[f"{dterm|gyro}.{field}"]` are set via `_delta(cur, prop)`. `_delta` returns `{"current","proposed","delta": proposed-current}` only when both values are present.
14. Status is `"blocked"` if `rec.blocked_reasons`. Otherwise it is `"proposed_with_warnings"` if there are any warnings or `rec.status is PROPOSED_WITH_WARNINGS`, else `"proposed"`.

`_validity_for(tune)` (`:395`) handles a partial current state:
- If `to_pid_profile()` is None, add skipped `current_pid_or_dterm_incomplete`.
- If `to_gyro()` is None, add `current_gyro_incomplete`.
- If one part is present, validate it against a dummy for the other part, and force the dummy's validity flags to False.

## 4. AbsoluteTuneProposal.to_dict schema (`:474`)

Keys:
- `kind`, `status`
- `actionable` (always False). It is a field with `init=False` and default False.
- `non_actionable_notice`
- `required_downstream_stages`: `["mechanical_safety","safe_tune_clamps","tuning_output_safety","actionable_cli_or_apply"]`, from engine.py:53.
- `current_global_sliders` (SimplifiedSliders dict)
- `per_axis_wu8_recommendations`: `{roll|pitch|yaw: {slider_*: int} | None}`
- `merged_global_sliders` (merge.proposed_sliders in Autotune key space, or None)
- `merge` (GlobalSliderMerge.to_dict). Its keys are `status, policy_id="gyrocore.autotune.global_slider.merge.v1", policy_kind="gyrocore", upstream_or_gyrocore, participating_axes, fields{key:{key,values_by_axis,agreed,chosen,constrained_by,reason}}, proposed_sliders, simplified, review_reasons, notes`.
- `current_absolute` and `proposed_absolute` (AbsoluteTune.to_dict, or None)
- `deltas`
- `slider_validity: {current, proposed}`
- `warnings`, `blocked_reasons`, `review_reasons`, `provenance`

## 2. Codes emitted and classification

Classes: A = PORT_NOW_DETERMINISTIC, B = PORT_NOW_BUT_NOT_AUTHORITATIVE_YET, C = BLOCKED_BY_ANALYSIS, D = REFERENCE_STALE_OR_UNSAFE, E = NEEDS_INVESTIGATION.

| Code (exact) | Where | Block/Warn | Depends on | Class |
|---|---|---|---|---|
| `simplified_pids_mode_off` | absolute.py:543 (also engine.py:240 per-axis) | block | merged sliders (current pids_mode) | A |
| `proposed_pid_sliders_incomplete:<names>` | absolute.py:545 | block | merged sliders | A |
| `proposed_dterm_sliders_incomplete:<names>` | absolute.py:547 | block | merged sliders | A |
| `proposed_sliders_outside_cli_minmax:<names>` | absolute.py:550 | warn | merged sliders vs CLI minmax | A |
| `proposed_dterm_hz_from_present_or_zero_missing_not_defaulted` | absolute.py:570 | warn | current filters | A in code, D in effect (see D2) |
| `proposed_gyro_hz_from_present_or_zero_missing_not_defaulted` | absolute.py:572 | warn | current filters | A / D |
| `slider_missing:<name>` | absolute.py:351, current_tune.py:329 | warn | tune sources | A |
| `cli:<...ambiguous...>` | absolute.py:294 | warn | CLI parser | B (needs the WU2 CLI parser in TS) |
| `current_pid_or_dterm_incomplete`, `current_gyro_incomplete` | absolute.py:400/402 (validity skipped_reasons, current only) | evidence only | current tune | A |
| `pids_sliders_incomplete:<n>`, `gyro_sliders_incomplete:<n>`, `dterm_sliders_incomplete:<n>` | simplified_tuning.py:389/398/407 | validity skipped. On `proposed_validity`, any skipped reason triggers TOS block `invalid_simplified_tuning_state` (output.py:194-196) | sliders | A |
| FieldMismatch `{field,current,expected_from_sliders}`; on proposed it triggers TOS `slider_inconsistency` | simplified_tuning.py:365-382 | evidence/block | tune + sliders | A |
| status `MERGE_REQUIRES_REVIEW`; review `no_participating_axes`, `slider_disagreement:<slider_key>` | merge.py | review/block | per-axis slider proposals | A (already ported in Gyroflight `src/gyrocore/tuning/merge.ts`) |
| pass-through `recommendation.blocked_reasons` / `.warnings`; `proposed_with_warnings` when rec status is PROPOSED_WITH_WARNINGS | absolute.py:513-514, 611 | block/warn | **CHIRP/system-ID analysis** | C |
| `cli_active_profile_<confidence>` (`unknown`/...) | current_tune.py:254 | warn | CLI only | B |
| `bbl_cli_mismatch:<key>` and `conflicts[]` | current_tune.py:315 | warn | header vs CLI | B (A once CLI parsing exists) |
| TuneValue notes `not an integer (upstream NaN -> 100)`, `unrecognized value`, `unparseable`, `absent`, `not in BBL header or CLI` | current_tune/absolute | evidence | tune | A |
| engine `current_tune_{missing,unparseable,zero}:<slider>`, `simplified_pids_mode_unknown`, `yaw_not_under_slider_control`, `simplified_dterm_filter_unknown`, `simplified_dterm_filter_off` | engine.py:230-245 (per-axis) | block/warn | tune only | A (Gyroflight already has `currentTuneGates`) |
| safe_tune `missing_required_pid_or_filter_baseline:<list>` (d_max excluded) | safe_tune.py:183 | block | current tune | A |
| `malformed_or_empty_proposal`, `unresolved_merge_requires_review`, `proposal_blocked` (+ proposal blocked_reasons copied) | safe_tune.py:189-197 | block | proposal | A |
| `mechanical_hard_block`, `mechanical_warning_scale_applied`, `safe_tune.max_delta_scale`, `safe_tune.step.*` (max_delta scaled by mechanical result), `safe_tune.hard.*` (confidence/hardware), `safe_tune.thermal.*` | safe_tune.py:199-269 | block/warn/clamp | **analysis/mechanical evidence** | C |
| `absolute_tune_to_config` (pure: `{pid:{axis:{p,i,d,ff,d_max}}, filters:{dterm_lpf1_dyn_min_hz..gyro_lpf2_static_hz}}`, missing list `"{axis}.{comp}"`/`"{prefix}.{field}"`) | safe_tune.py:50 | — | tune | A |
| `config_to_absolute_tune` (overlay numeric values; `_clamped_tv` uses Python `int(round(x))` = **banker's rounding**, origin `safe_tune_clamp`, source INFERRED) | safe_tune.py:74-129 | — | config | A (port with round-half-even, not `Math.round`) |
| `_DMAX_KEYS` alias `d_min_*` -> d_max; CLI emit writes `d_min_roll/pitch/yaw` (cli/settings.py:32-42; goldens `tests/fixtures/cli_wu11/*.cli`) | absolute.py:96 | — | — | **D** |
| Header-only path ignores `d_max`, `ff_weight`, `*_lpf1_dyn_hz` CSV headers | absolute.py:91-112 | — | — | **D** |
| RP-mode proposal sets yaw to 0 (status `proposed`, validity true; probe-confirmed) | absolute.py:574-586 | — | — | **D** |
| crash: `rollPID` with non-numeric element gives `ValueError: cannot convert float NaN to integer` (`_tv_or_missing` int(nan)) | absolute.py:250 | crash | — | E |
| crash: `gyro_filter=ON` with gyro multiplier missing gives `TypeError` in `calculate_new_gyro_filter_values` (gyro sliders not checked in mapping_block) | absolute.py:541-582, simplified_tuning.py:308 | crash | — | E |

Verified by probe:
- `simplified_pids_mode = OFF` gives `blocked ('simplified_pids_mode_off',)`.
- With the `simplified_d_max_gain` line removed, the result is `blocked ('proposed_pid_sliders_incomplete:d_max_gain',)` plus warning `slider_missing:d_max_gain`.
- Master 250 gives `proposed_with_warnings ('proposed_sliders_outside_cli_minmax:master_multiplier',)`.

## D/E findings in detail

**D1. d_max CLI naming is stale/unsafe.**
- In Betaflight 2025.12+ and in the 2026.6.2 tag `cli/settings.c:1303-1305` (and master :1423-1425), the only names are `d_max_roll`, `d_max_pitch`, `d_max_yaw`. Neither file contains a `"d_min` string (grep count 0).
- In 4.3–4.5 (for example the private CLI dump fixture), `d_roll` is the upper D and `d_min_roll` is the lower D. absolute.py reads `d_min_*` as d_max. On that dump it reported the lower D as `roll.d_max`, below `roll.d`, which is semantically inverted.
- GyroCore emit (`cli/settings.py` PID_CLI_KEYS) writes `set d_min_roll = ...`, which 2026.6.2 would reject as an unknown name.
- The `d_max -> d_min` alias came from the blackbox-viewer `flightlog_parser.js:506` translation. That is a viewer-internal label, not a CLI name.
- Do **not** port the `d_min_*` alias. Port only `d_max_*`, and treat pre-2025.12 firmware as unsupported.

**D2. Header-only (no CLI) path leaves values missing even though the BBL header has them.** On 2026.6.2 the firmware's `blackbox.c` writes these header lines:
- `rollPID/pitchPID/yawPID: P,I,D` (`:1589`)
- `d_max: r,p,y` (`:1603`)
- `ff_weight: r,p,y` (`:1637`)
- `dterm_lpf1_static_hz`, `dterm_lpf1_dyn_hz: min,max` (`:1612`), `dterm_lpf2_static_hz`
- `gyro_lpf1_static_hz`, `gyro_lpf1_dyn_hz: min,max` (`:1688`), `gyro_lpf2_static_hz`
- all 13 `simplified_*` (`:1795-1808`; `simplified_pitch_d_gain` holds `simplified_roll_pitch_ratio`)

absolute.py only reads CLI-style per-axis names (`f_roll`, `d_max_roll`, `dterm_lpf1_dyn_min_hz`), so from a header these come back MISSING: F, d_max, and the dyn min/max on both dterm and gyro. Probe on the real Air65 BBL (2026.6.2):
- F, d_max and dyn min/max were missing on all axes.
- Present: P/I/D, the static Hz values, and all 13 sliders.
- `to_pid_profile()` and `to_gyro()` were both `None`.

With `pids_mode` forced to 2, the proposal was:
- status `proposed_with_warnings` with both `*_missing_not_defaulted` warnings.
- **proposed dterm/gyro `lpf1_dyn_min_hz = lpf1_dyn_max_hz = 0`**. The actual config is 75/150 and 150/300, so the proposal looks like "disable dynamic LPF".
- `proposed_validity` was all-valid, and `deltas` omitted those fields.

Downstream, `clamp_safe_tune` blocks on `missing_required_pid_or_filter_baseline:...` and TOS blocks on `missing_required_pid_or_filter_baseline` (missing F). So the chain fails closed, but the proposal object itself is misleading.

**Gyroflight CHIRP log:** pass the header CSVs explicitly. The viewer's `flightlog_parser.js` handlers:
- `d_max`, `d_min` and `ff_weight` go through `pidArrayPushHandler`, which pushes values onto the `rollPID/pitchPID/yawPID` arrays. That makes them order-dependent: `[P,I,D,d_max,F]`.
- `dterm_lpf1_dyn_hz` becomes `dterm_lpf_dyn_hz`, `gyro_lpf1_dyn_hz` becomes `gyro_lowpass_dyn_hz`, `*_lpf1_static_hz` become `dterm_lpf_hz`/`gyro_lowpass_hz`, and `*_lpf2_static_hz` become `dterm_lpf2_hz`/`gyro_lowpass2_hz`.
- `feedforward_weight` maps to `dtermSetpointWeight`. That is a legacy name, not F; F is `ff_weight`.

Recommendation: parse raw `H` pairs the way GyroCore does, not the viewer sysConfig. Read `d_max` and `ff_weight` as 3-element CSVs and `*_lpf1_dyn_hz` as `min,max`. This is a deliberate improvement over the reference, so record it as a GyroCore divergence, and also emit the reference-equivalent output for parity.

**When the CLI dump is absent:**
- `active_pid_profile` is MISSING ("Betaflight BBL headers do not log the PID profile index").
- `cli_cfg` is empty, so `d_max_gain`, `pitch_*` and `gyro_*` sliders come from the header only.
- F, d_max and dyn Hz are missing as described in D2.
- Current validity is skipped on both parts.
- The GyroCore worker refuses tune/safety/CLI stages without a CLI baseline (`apps/desktop/worker/analyze_local.py:~355`, `missing_cli_baseline`).

Separately: when `propose_absolute_tune` is called with `cli_dump` but without `headers` (the worker does this), P/I/D and the 6 sliders come from the BBL header (current_tune wins), while F, d_max, filters and the extra sliders come from the CLI. That mixes sources, with only `bbl_cli_mismatch` warnings for the 6 sliders and P/I/D.

**D3. RP mode yields yaw = 0 in the proposal.** The seed profile axes are `AxisPid(0,0,0,0,0)`, and firmware leaves yaw untouched when `pids_mode=RP`. So proposed yaw P/I/F are 0, and the delta reports, for example, `yaw.p: current 45, proposed 0`. A faithful port should seed axes from the current values (as the firmware does with the in-memory profile) or mark yaw as "unchanged/not mapped".

**Confirmed by probe:** NOMINAL_CLI with `RP` and sliders 100 gives status `proposed`, `proposed.yaw.p = 0`, `deltas["yaw.p"] = {current:45, proposed:0, delta:-45}`, and `proposed_validity.pids_valid=True`. Class D.

**E1.** `_tv_or_missing` crashes on NaN elements in `rollPID`. Probe: `ValueError cannot convert float NaN to integer`.
**E2.** A missing gyro multiplier with the gyro filter ON gives a TypeError. Probe confirmed.
**E3.** Doc staleness: `SIMPLIFIED_TUNING_PARITY.md` says "Python float64 vs C float accepted if truncated integer matches", but the code emulates float32 step by step (`c_float`). The code is correct. The doc is stale.

## 5. Tests and fixtures exercising this

`tests/core/autotune/test_autotune_wu9_units.py`:
- `NOMINAL_CLI`: 2026.6.2 profile 0, all defaults and sliders 100. `INCONSISTENT_CLI` is the same with p_roll=60.
- `test_nominal_cli_is_slider_consistent`: roll p=45, f=120, d_max=40; `d_max_gain=100`; `active_pid_profile=0`; all three validity flags true.
- `test_inconsistent_cli_records_pid_mismatch_evidence`: mismatch `roll.p` current=60, expected=45.
- `test_missing_values_stay_missing`: f and d_max missing; `d_max_gain` and `gyro_filter_multiplier` None; `to_pid_profile()` None.
- `test_does_not_invent_another_cli_parser`: source inspection.
- Merge tests:
  - `test_single_axis_matches_upstream_apply_one_axis`
  - `test_roll_pitch_agreement_merges`
  - `test_roll_pitch_disagreement_requires_review` (`slider_disagreement:slider_d_gain`)
  - `test_three_axis_agreement_and_conflict`
  - `test_no_participating_axes_requires_review` (`no_participating_axes`)
  - `test_blocked_axis_is_ignored_when_another_participates`
- `test_proposal_from_unanimous_axes_maps_firmware_pids`: master 200 gives roll.p 90, pitch.p 94, delta roll.p +45; validity true; JSON-serializable.
- `test_proposal_disagreement_does_not_invent_merge`
- `test_proposal_one_axis_only`: master 150 gives roll.p 67.
- `test_inconsistent_current_is_flagged_not_reconstructed`: proposed roll.p 45, current 60.
- `test_proposal_structurally_non_actionable`
- `test_autotune_package_still_has_no_apply_path`

`tests/core/betaflight/test_simplified_tuning_wu9_math_parity.py` (Python vs the compiled C harness):
- `test_harness_stub_defaults_match_vendored_headers`
- `test_pid_mapping_matches_c_harness`: cases are the 4 modes; 8 sliders x bounds (0,10,25,50,99,100,111,150,199,200,250); all-25/200/250; and the product (111,133,187)x(100,111)x(100,147)x(100,113).
- `test_all_sliders_100_are_firmware_defaults`
- `test_mode_rp_leaves_yaw_untouched`
- `test_mode_off_is_identity`
- `test_yaw_d_and_dmax_stay_zero`
- `test_pid_gain_clamp_250`: pitch.p=250, roll.p=180.
- `test_truncation_toward_zero`: master 111 gives 49.
- `test_dterm_filter_mapping_matches_c`: on x 10 multipliers x 5 currents.
- `test_gyro_filter_mapping_matches_c`
- `test_validate_pids_consistent_and_inconsistent`
- `test_validate_filters_match_c`: expected outputs `["1","0","1","1","1","0","1"]`.
- `test_vendored_simplified_tuning_c_hash_stable`

`tests/core/safety/test_pipeline.py`:
- `test_absolute_tune_config_roundtrip_keys`
- `test_invalid_baseline`
- `test_unsupported_config_simplified_off`
- `test_slider_inconsistency_blocks`
- `test_unresolved_multi_axis_merge`
- `test_system_id_unusable`
- p/i/d/ff/filter clamp tests (step cap +4)

`tests/core/cli/helpers.py` and `test_authorize.py`:
- `proposal()`, `pipeline()`, `pass_with_delta()`, `proposal_with_dmax_delta()`
- authorize tests: `test_dmax_emitted_when_target_differs`, `test_yaw_d_zero_preserved`, `test_zero_off_filter_preserved`, `test_missing_baseline_blocks`, `test_unresolved_merge_blocked`, `test_unsupported_betaflight_version_blocked`, ...
- CLI goldens are in `tests/fixtures/cli_wu11/*.apply.cli`/`*.rollback.cli`. They contain `set d_min_roll` (see D1).

Other:
- `tests/core/cli/test_roundtrip.py`
- `tests/desktop/test_worker_bridge.py` (asserts the worker does not reimplement `apply_simplified_tuning`)

**There is no golden JSON for AbsoluteTuneProposal.** `tests/golden/*` covers legacy safety only. The `tests/fixtures/autotune/wu8/bbl/*.bbl.gz` + `bbl_cases.json` (19 logs, including `pids_mode_off`, `pids_mode_rp_yaw`, `missing_tune_headers`, `zero_slider`, `unusual_pids`, `slider_*_clamp`) are WU8 inputs that could drive proposal goldens.

## 6. Upstream drift and the Gyroflight app helper

- The vendored `simplified_tuning.c/.h` are byte-identical to the 2026.6.2 tag and to master `4fc1520c`.
- `sensors/gyro.h` is identical.
- `flight/pid.h` differs only in unrelated fields (integrated yaw removed, chirp repeat added). The defaults and GAIN_MAX are unchanged.
- **The firmware math is current. No drift.**

Gyroflight `src/js/simplifiedTuning.ts` (285 lines; upstream configurator, `b0b5a922 refactor(utils): convert simplifiedTuning to TS`) exports:
- interfaces `SliderFactors{pidsMode, masterMultiplier, rollPitchRatio, iGain, dGain, piGain, dMaxGain, feedforwardGain, pitchPIGain (ratios /100), gyroFilterMultiplier, dtermFilterMultiplier (ints), gyroFilterEnabled, dtermFilterEnabled}`, `AxisPidValues{P,I,D,F,dMax}`, `GyroFilterValues{gyro_lowpass_dyn_min_hz?, gyro_lowpass_dyn_max_hz?, gyro_lowpass_hz?, gyro_lowpass2_hz?}`, `DtermFilterValues{dterm_lowpass_*?}`
- `calculateSimplifiedPidValues(factors): AxisPidValues[]`. It returns `[]` when pidsMode is 0, else axes `0..pidsMode`.
- `calculateSimplifiedGyroFilterValues(multiplier)` and `calculateSimplifiedDtermFilterValues(multiplier)`. **Both read the global `FC.FILTER_CONFIG` for skip-if-zero**, so they are not pure.
- `applySimplifiedPids`, `applySimplifiedGyroFilters`, `applySimplifiedDtermFilters` mutate `FC`.
- `validateVirtualSimplifiedTuning()` mutates `FC.TUNING_SLIDERS`.
- `sliderFactorsFromTuningSliders` is not exported.
- Its constants are identical to the firmware.

**It is not authoritative.** It computes in JS float64 (`s/100`, then left-to-right double products, `Math.trunc`). It also groups the d_max term as `(1-g)*(D/dMax)`, where C uses `((1-g)*D)/dMax`.

Probe against GyroCore's float32 port, which was confirmed against the compiled C harness:
- 2306 of 273,728 slider combinations differ.
- Divergences with a single slider changed, within the CLI range:
  - `master_multiplier` 105 → F 126 vs firmware 125
  - `master_multiplier` 140 → P 62 vs 63
  - `pi_gain` 140
  - `feedforward_gain` 105
  - `d_max_gain` 190 and 200 → pitch d_max 58 vs firmware 57
- C harness confirmation for master=105: `47 84 31 125 42 ...`; for d_max_gain=200: pitch d_max 57.

FMA note: the target ARM gcc build uses `-ffp-contract=fast`, but no multiply feeds an add directly in these expressions (there is a division in between), so float32 C on x86 SSE equals Cortex-M FPU here.

The app helper's filter math is exact, because integers are exact in double. Its validity logic is equivalent to MSP for the supported modes.

## 7. Recommendation for a minimal faithful TS port

1. **Port simplified_tuning.py fully and purely** as `src/gyrocore/tuning/simplifiedTuning.ts` (or similar).
   - Use `Math.fround` after every `+ - * /` (`f(a)*f(b)` then `fround`).
   - `ratio = fround(fround(s)/100)`.
   - Implement `constrain` as `Math.trunc` then clamp.
   - Filters use integer `Math.trunc(def*m/100)`.
   - Port the dataclasses as plain interfaces, plus `validateSimplifiedTuning` with `FieldMismatch` evidence and skipped reasons, and `slidersOutsideCliRange`. Note that `composite.ts` already has `outsideCliRange`, so reuse or move it.
   - **Do not delegate to `src/js/simplifiedTuning.ts`.** It is float64 (proven divergences), coupled to the global FC, and drops the evidence. At most, add a test documenting the known divergences.
2. **Port absolute.py:**
   - `extractAbsoluteTune` (header path + optional CLI-derived config map), `proposeAbsoluteTune`, `_validityFor`, `_delta`, and the `to_dict` schema with the same keys and code strings.
   - Reuse Gyroflight `merge.ts` (`mergeAutotuneSliders`, already ported) and `chirp/headers.ts` (`readHeaderPairs`, `normalizeFieldKey`, `jsParseInt`).
   - Mark all output non-actionable.
3. **Fixes / divergences to decide explicitly:**
   - (a) Add header CSV parsing for `d_max`, `ff_weight`, `dterm_lpf1_dyn_hz`, `gyro_lpf1_dyn_hz`. This is class D in the reference. Gate it behind a flag, or emit a `reference_parity` view.
   - (b) Do not port the `d_min_*` alias.
   - (c) Fail closed instead of crashing on NaN PIDs and on a missing gyro multiplier with the filter ON. Add a block `proposed_gyro_sliders_incomplete:<n>` (new code; document it).
   - (d) Seed RP-mode yaw from current, or block it.
   - (e) Port `config_to_absolute_tune` rounding as round-half-even.
4. **Leave analysis-dependent stages out** (class C): mechanical safety, step/hard/thermal clamps, recommendation pass-through. Keep the slots in the schema.
5. **Golden fixtures to generate from Python** (in a scratch/worktree; do not write into GyroCore):
   - (i) A firmware-mapping vector file. Dump `apply_simplified_tuning_pids/dterm/gyro` outputs and `validate_simplified_tuning` for the test_simplified_tuning parity matrix, plus the 2306 TS-divergent combos and a dense sweep of each slider over 0..255. The C harness is the oracle (`tools/simplified_tuning_reference/build.py` with `build(dest)` into scratch).
   - (ii) `propose_absolute_tune(...).to_dict()` JSON for: NOMINAL_CLI with sliders 100; master 150/200; master 250 (outside_cli_minmax); merge disagreement; pids_mode OFF; d_max_gain missing; INCONSISTENT_CLI; header-only Air65 with RPY forced (documents the D2 behaviour); RP mode (documents D3).
   - (iii) `extract_absolute_tune(...).to_dict()` for NOMINAL_CLI, header-only Air65 BBL, and a private CLI dump fixture (documents D1).
   - (iv) `absolute_tune_to_config` / `config_to_absolute_tune` round trips, including .5 rounding cases.
