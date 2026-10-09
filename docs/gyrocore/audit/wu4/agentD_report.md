# Agent D: Safety engine Python-reference parity strategy (WU4)

GyroCore reference: `d2e60f7` (read-only; git status unchanged, 21 entries before and after).
Scratch: `/tmp/claude-1000/-home-sliksoft-GyroCore/65e2f2cc-86d2-47a5-94f2-8e96a4ead677/scratchpad/agentD2_1791558155/`

- Generator: `gc_safety_reference.py` (sha256 `170058a5…06d`)
- Output: `safety_reference.json` (PYTHONHASHSEED=0, about 1.6 MB, sha256 `c4ede230…7e18`)
- Seed check: `ref_seed0.json` and `ref_seed1.json`

Run command (from the scratch dir):

```
PYTHONHASHSEED=0 PYTHONDONTWRITEBYTECODE=1 TMPDIR=$PWD/tmp \
  PYTHONPATH=/home/sliksoft/GyroCore:/home/sliksoft/GyroCore/core \
  python3 -B gc_safety_reference.py > safety_reference.json
```

## 1. Scope correction applied

`run_safety_pipeline` fails closed without analysis evidence. The fixture is therefore split into three sections:

| Section | What | Analysis evidence |
| --- | --- | --- |
| `foundation.absolute` (17) | `extract_current_tune` → `extract_absolute_tune` → `propose_absolute_tune`. Records status, merge, blocked, review and warnings, current absolutes with value source, proposed integers, current/proposed `SliderValidity`, and deltas. | none |
| `foundation.simplified_tuning` (12) | `apply_simplified_tuning`, `validate_simplified_tuning` and `sliders_outside_cli_range` on firmware defaults with slider overrides. | none |
| `foundation.safe_tune_output` (58) | `clamp_safe_tune` → `evaluate_tuning_output_safety` → `finalize_safe_tune`. Uses `mechanical = evaluate_mechanical_safety(None, require_analysis=False)` (donor default: PASS, `mechanical_clear`, scale 1.0), `analysis=None`, `require_analysis=False`. This is clamp and deterministic-check parity only. | none |
| `foundation.construct_only` (5) | TOS branches that `propose_absolute_tune` cannot produce: `slider_inconsistency`, `invalid_simplified_tuning_state`, `resulting_values_invalid`, `missing_current_tune`, and a malformed/sysid blocked proposal. Built with `dataclasses.replace` / `make_safe_tune_candidate`. | none |
| `foundation.stages` | Pure functions: `scale_max_delta` (9 cases), `apply_to_baseline` (7), `apply_safety_autotune`/`apply_safety` (17, including every `scalar_ranges` key and every Hz edge), `record_numeric_clamps`, `_values_within_firmware` (7), `clamp_targets_to_baseline_thermal` (4). | none |
| `product_path` (5) | `run_safety_pipeline(proposal, analysis=None or {"ok":False}, require_analysis=True)`. This is the only honest full-pipeline product verdict available today. | none |
| `harness` | Labelled `TEST_HARNESS_ONLY_NOT_PRODUCT_EVIDENCE`. Contains: the reference-test `clean_analysis` (identical in `tests/core/safety/test_pipeline.py::_clean_analysis` and `tests/core/cli/helpers.py::clean_analysis`) and 18 full-pipeline runs using it or variants; 28 `build_mechanical_safety_gate` kwarg cases; and 16 thermal/RPM envelope cases. | test-harness dicts only |

### How inputs are built

Each case records its raw inputs:

- CLI text or BBL `H` header text
- per-axis stub `AxisRecommendation` slider dicts, using the same `_StubGains` pattern as `tests/core/cli/helpers.py`
- hardware
- analysis

The generator copies those helpers rather than importing `tests.*`, so it is self-contained when moved to `Gyroflight/test/gyrocore/tools/`.

### Baselines

- **`NOMINAL_CLI`** is the firmware default tune: the GyroCore `simplified_tuning.py` constants, equal to Betaflight 2025.12+/2026.x defaults.
  - Roll 45/80/30/120, d_max 40. Pitch 47/84/34/125, d_max 46. Yaw 45/80/0/120, d_max 0.
  - Dterm 75/150/75/150. Gyro 250/500/250/500.
  - All sliders 100, RPY, filters ON.
- **`BF45_CLI`** uses Betaflight 4.5 names and defaults: `d_roll=40` is D-max, `d_min_roll=30`, and `simplified_dmin_ratio`. These 4.5 values are my assumption from 4.5 defaults; they were not checked against a dump.
- **`GYROFLIGHT_FULL_TUNE_HEADERS`** is the header set from Gyroflight `harness/chirpSim.ts`.

## 2. WU3 safe positive fixture: reference verdicts

Input: current sliders all 100, `pids_mode` 2. Proposed sliders: master 100, PI 138, I 100, D 100, FF 138, dterm 100, on all three axes.

| Run | Final | Codes |
| --- | --- | --- |
| Product path: firmware-default absolutes, `analysis=None`, `require_analysis=True` | **BLOCK** | mechanical `missing_required_analysis` → candidate `mechanical_hard_block` → TOS `mechanical_hard_block, missing_required_analysis, safe_tune_candidate_blocked`; `clamped_tune=None` |
| Product path: Gyroflight FULL_TUNE_HEADERS, `analysis=None` | **BLOCK** | the above plus `missing_required_pid_or_filter_baseline:roll.f,pitch.f,yaw.f,dterm.*(4),gyro.*(4)` and `missing_required_pid_or_filter_baseline` |
| Product path: BF 4.5-named CLI, `analysis=None` | **BLOCK** | the above plus `malformed_or_empty_proposal`, `proposed_pid_sliders_incomplete:d_max_gain`, `proposal_blocked`, `malformed_proposal`. GyroCore does not read 4.5's `simplified_dmin_ratio`. |
| Harness clean analysis: firmware defaults | **WARN** (never PASS) | 9 step clamps: `safe_tune.step:{roll,pitch,yaw}.{p,i,ff}` plus `safe_tune_clamps_applied` |
| Harness clean analysis: Gyroflight headers | **BLOCK** | `safe_tune_candidate_blocked` and missing-baseline codes, as above |
| Foundation (no analysis, mechanical clear) | WARN | same 9 step clamps |

Clamp detail for the harness run on firmware defaults, as proposed → clamped:

| Axis | P | I | FF |
| --- | --- | --- | --- |
| Roll | 62 → 49 | 110 → 88 | 165 → 128 |
| Pitch | 64 → 51 | 115 → 92 | 172 → 133 |
| Yaw | 62 → 49 | 110 → 88 | 165 → 128 |

D and filters are unchanged.

So the WU3 "safe positive" is not a PASS anywhere in the Python reference:

- With no analysis it is BLOCK.
- With test-harness analysis it is WARN, because P +17/I +30/FF +45 exceed the step caps P 4, I 8, FF 8.
- WU11 `authorize_cli` gives a non-actionable preview on WARN.

Gyroflight's product Apply lock (`full_safety_engine_pending`) is therefore consistent with the reference. A WU3 merge "authorized" must not be treated as safety PASS. The largest per-component PASS moves on the default tune are:

| Slider | Up | Down |
| --- | --- | --- |
| PI | 110 | 92 |
| I | 110 | 91 |
| D | 115 | 87 |
| FF | 107 | 94 |
| Master | 107 | — |

## 3. Branch coverage, with the case that reaches each

### absolute.py / current_tune

| Branch | Case |
| --- | --- |
| proposed | `nominal_noop` |
| `proposed_with_warnings` | `sliders_outside_cli_range` (`proposed_sliders_outside_cli_minmax:pi_gain`); `missing_filter_hz` (`proposed_*_hz_from_present_or_zero_missing_not_defaulted`) |
| blocked by sysid | `sysid_axis_blocked` |
| `MERGE_REQUIRES_REVIEW` | `merge_review` |
| `simplified_pids_mode_off` | `pids_mode_off` |
| `proposed_pid_sliders_incomplete` | `missing_d_max_gain`, `bf45_names_noop` |
| `proposed_dterm_sliders_incomplete` | `missing_pids` |
| RP mode | `pids_mode_rp` |
| dterm filter OFF | `dterm_filter_off` |
| current slider missing | `missing_dterm_filter_multiplier_current` |
| current inconsistent with sliders | `current_inconsistent_with_sliders`: `slider_pids_valid=False` but status still proposed, because current validity is not gated |
| unparseable value stays missing | `unparseable_value` |
| NaN slider | `nan_slider_proposal` → `ValueError`, recorded as `error` |

### safe_tune / clamps

- **Step caps:** at-cap and cap+1 cases for P, I, D, d_max (which uses the D cap), FF and master, in both directions.
- **Dterm filter steps:**
  - `dterm_101_no_static_change`: PASS.
  - `dterm_102_static_frozen`: `dterm_lpf1_static_hz` has no `DEFAULT_MAX_DELTA` entry, so its cap is 0 and the value is frozen. Any change gives WARN.
  - Also covered: hard min 70 (`dterm_93_hard_min_70`), step plus hard (`dterm_50_*`), and `dterm_200_step`.
- **Donor advisory PID limits, inside and outside:** P 10/100, D ≤ 85, FF ≤ 220.
- **Firmware ceiling:** I 250.
- **Yaw D 0 preserved.**
- **Gyro limits:** static 120/300, 0 = OFF preserved; lpf2 0 preserved and 80 minimum; dyn_max raised to dyn_min.
- **Dterm limits:** dyn_max raised to dyn_min+10; lpf2 ≤ 250.
- **Weight:** 800 (no scale), 801 (×0.9), NaN (ignored), `weight_801_half_even`.
- **Missing baseline:** `missing_pids_baseline`, `missing_one_filter`.
- **Missing d_max only:** not critical. **Finding:** the proposed d_max (55/63 vs proposed D 36/40) passes unclamped, because `apply_to_baseline` skips keys absent from the baseline.
- **Proposal blocks:** pids_mode OFF, BF 4.5 names, merge review, sysid.

### output.py

- Mechanical BLOCK and WARN, candidate BLOCK, merge review, sysid codes, malformed.
- `missing_required_pid_or_filter_baseline`, `missing_current_tune` (construct-only).
- `invalid_simplified_tuning_state` and `slider_inconsistency` (construct-only).
- `missing_required_analysis` (product_path).
- `quality_status_low_quality`, `analysis_confidence_low` (0.39 vs 0.40), `noise_level_high` (harness).
- `resulting_values_invalid` (construct-only, including NaN).
- `safe_tune_clamps_applied`.

### mechanical gate and thermal (harness only)

**Mechanical gate:**

- Every reason code: `motor_issue_high_severity_danger`, `dangerous_flight_event`, `motor_issue_high/medium_severity`, `mechanical_problem_indicator`, `bad_motor_diagnostic`, `warning_motor_diagnostic`, `per_motor_noise_anomaly` (block form), `broad_frame_resonance_noise`, `persistent_resonance_with_noise_risk`, `medium_broad_resonance`, `mechanical_noise_low_confidence`.
- Every outcome: block, limited with tiers strong/moderate/mild, `motor_warning_caution`, `motor_correction_demand_caution`, `noise_low_confidence_capped`.
- Danger-text negation and inferred-phrase stripping.
- Thresholds: confidence 0.54/0.55, 0.24/0.25, motor conf 0.34/0.35, health 51.9/52, cleanliness 45/45.01, hf 0.35, bandwidth 59.99/60, spread 75/90, confidence score 0.44/0.45.
- NaN/Inf inputs.

**Thermal and RPM:**

- Severities 0.05/0.06/0.23/0.39.
- Health 0.51/0.52 and 61 with an active issue.
- Stress tiers 0.82/0.65/0.42.
- Desync by problem type.
- RPM gate: healthy, partial, and the `filter_intelligence` path.

### Not reached, and why

- **`StageBypassError` paths** (and `missing_mechanical_safety_stage` / `missing_safe_tune_stage`): these codes are defined but never emitted. TS should enforce them with types and throw tests, not fixture data.
- **`unsupported_betaflight_state`:** defined in output.py but never emitted at d2e60f7. It exists only in WU11 `authorize_cli`.
- **`slider_inconsistency`, `invalid_simplified_tuning_state`, `missing_current_tune`, `resulting_values_invalid`:** not reachable from real `propose_absolute_tune` inputs. Proposed values come from the firmware mapping, so they are always valid and within firmware range after the clamps. These are construct-only.
- **`per_motor_noise_anomaly` in limited form without bad motors:** not attempted. A row with spectral issues needs `status != "bad"`; this is easy to add (warning status plus `broadband_noise`).
- **`desync_risk` in fault evidence from `motor_diagnostics`:** reached only indirectly. There is no dedicated gate case.

## 4. Determinism and tolerance findings

1. **Set iteration order.** `record_numeric_clamps` iterates `set(bf) | set(af)`, so filter check order depends on `PYTHONHASHSEED`. Seed 0 vs seed 1 differs in 114 lines, all filter `clamp_ids`, `checks` and `warnings` order in dterm-filter cases. Generate with `PYTHONHASHSEED=0`. TS must compare these as multisets: `candidate.clamp_ids`, `candidate.checks`, `tuning_output_safety.warning_reasons`, `final.warnings`. PID entries keep a fixed order (roll/pitch/yaw × p,i,d,ff,d_max), so tests can sort only the `filter.` entries, or simply sort all. Values and statuses are identical across seeds.
2. **Rounding.** `config_to_absolute_tune` uses Python `round()`, which rounds half to even. In `weight_801_half_even` the config holds 22.5, the clamped tune holds 22, and JS `Math.round` would give 23. The TS port needs a half-even helper.
3. **Floats.** `max_delta_used` (e.g. 0.65×4 = 2.6 inexact), `clamped_config` (×0.9, 0.5 blends) and `checks.before/after` need about 1e-9 tolerance. Integer `clamped_tune`, proposed and current absolutes, and all status/codes are exact.
4. **Non-finite values** are encoded as strings `"NaN"`, `"Infinity"` and `"-Infinity"`. The file is written with `allow_nan=False`, matching the merge precedent's `enc`.
5. **Quirks the TS port must copy:**
   - Confidence 0.0: output.py's `score or 1.0` produces no `analysis_confidence_low`, but safe_tune's confidence 0.0 < 0.4 still triggers the 50% blend toward baseline. The result is WARN through hard ids (`conf_0_quirk`).
   - NaN confidence: no warning and no blend.
   - Plain numeric confidence is accepted.
   - Mechanical WARN gives candidate WARN and `safe_tune_clamps_applied` with zero clamp ids.
   - Gyro Hz proposals come from the firmware mapping of defaults × multiplier, not from the current value. In `gyro_static_below_120`, current 100 → proposed 250 → stepped 144.

## 5. Gyroflight consumption

**Generator:** `test/gyrocore/tools/gc_safety_reference.py`, with the same header style as `gc_merge_reference.py`. Add `PYTHONHASHSEED=0` to the documented run line.

**Fixtures** under `test/gyrocore/fixtures/safety/`. Split the 1.6 MB file:

| File | Contents |
| --- | --- |
| `safety_foundation_reference.json` | absolute + simplified_tuning + safe_tune_output + construct_only + stages |
| `safety_product_path_reference.json` | product_path |
| `safety_harness_reference.json` | harness; keep the `label` field |

Record each in `PROVENANCE.md` with generator, commit and sha256. Size can be cut by dropping `checks` from cases that are not about checks.

**Tests:**

| Test file | Covers |
| --- | --- |
| `safety_absolute_parity.test.ts` | extraction, proposal and validity, exact |
| `safety_clamps_parity.test.ts` | stages plus safe_tune_output: clamp ids/checks as multisets, floats ±1e-9, integers exact |
| `safety_output_parity.test.ts` | construct-only and output codes |
| `safety_product_path.test.ts` | asserts BLOCK with `missing_required_analysis` for every product input, including WU3 |
| `safety_harness_parity.test.ts` | named and commented as test-harness evidence; never imported by product code |

Each test pins `gyrocore_commit === "d2e60f7"`. Every case runs the TS port on the recorded raw inputs; the Python stub `AxisRecommendation` maps to TS `MergeAxisInput`. Compare the projections, and for errors compare only the presence of `error`.

**WU3 test:** feed `MERGE_E2E_CASES.three_axis_agree` composite `current` and `final` into the TS safety port. Assert:

- product verdict BLOCK, plus the missing-baseline codes, because the generated BBL headers have no f/d_max/Hz
- harness verdict WARN on firmware defaults with the exact 9 step clamp ids and clamped integers above

## 6. Analysis-stability findings relevant to safety

Sources: `docs/analysis-input-stability.md` and `tools/analysis_stability/` (run.py, policies.py, summarize.py, benchmark.py, qualified.py). The overall gate is `ANALYSIS_STABILITY_GATE=WARN`; no candidate is qualified.

**Unstable or legacy inputs consumed by safety:**

- **Resonance inputs to `safety/mechanical.py`:** `resonance_module.primary.type/bandwidth`, `resonance_module.spread`, `metrics.resonance.severity`. "broad" and "persistent" are derived from bandwidth ≥ 60, spread ≥ 75/90 or severity high. The doc says these "are not measurements of temporal persistence", and a weak distant cluster can trigger both. On the real AIR65 log 1, a 481 Hz cluster sits at threshold ratio 1.0211; removing 26 tail rows (0.05%) removes it and both warnings. Root cause: SAMPLING_SELECTION (20k-row cap with non-uniform time), THRESHOLD_EDGE, rectangular FFT leakage, CLUSTERING. The noisy 1200-row fixture varies between 1 and 5 clusters under small perturbations.
- **`metrics.noise.value` / `hf_ratio` / `level`** (high_noise, the clean-context checks, the adapter's LOW/MEDIUM/HIGH bands) come from the same capped main FFT. Real-log noise values vary, e.g. log 2 43.7–44.2, which straddles the 45 cleanliness edge.
- **`confidence.score`** (unified confidence: low_conf < 0.45 in the gate, < 0.4 in TOS and blend) consumes primary resonance confidence. It moved from .613 to .650 under tail removal on log 1.
- **`quality.status`/score** varies slightly (57.80–57.97 on log 1); it is less threshold-critical.
- **Motor diagnostics and saturation** use the same capped normalized rows.
- **Oscillation problems** (`problems`): log 1 varies between medium and high severity, which feeds `motor_issue`/danger text and thermal severity.
- **Stable by contrast:** the tune proposal and CHIRP path use full decoded data and are unchanged by these perturbations. All real cases stayed final BLOCK, with an unchanged proposal digest.
- **The WU2 spectral candidate** must keep its temporal fields separate from the legacy `persistent_resonance` safety boolean.

**Implication:** port `build_mechanical_safety_gate`, thermal and RPM as pure functions with harness parity. Product verdicts must remain BLOCK (`missing_required_analysis`) until a qualified analysis contract exists. Do not synthesize analysis dicts in the product path.
