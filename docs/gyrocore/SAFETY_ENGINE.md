# GyroCore Safety engine in Gyroflight (WU4)

Status: **WU4A (deterministic Safety foundation) complete. The full Safety pipeline is blocked by analysis**: it needs analysis evidence that Gyroflight does not have and that GyroCore itself
has not qualified as stable. The product Apply lock stays `full_safety_engine_pending`.

- Reference: `~/GyroCore` at `d2e60f7`, read only.
- Betaflight firmware master: `4fc1520c5a5decddc8ef07ad57c0e766ea8747ba`.
- Betaflight app upstream (`betaflight-configurator`) master: `d85e797e8674e3059cc3172e38df831e46a5250c`. This
  equals the fork's `master`.
- Start: `gyroflight/main` `1e4dc1ee`, branch `gyroflight/wu4-safety`.

The four read-only audit reports are kept verbatim under [`audit/wu4/`](audit/wu4/):

| Report | Covers                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------ |
| A      | `absolute.py`, `current_tune.py`, `simplified_tuning.py`                                         |
| B      | `safety/*`, `cli/authorize.py`, and the dependency map                                           |
| C      | Betaflight firmware and app apply model, with the compiled F405 firmware executed in an emulator |
| D      | parity strategy and GyroCore's analysis-stability findings                                       |

They are model-written audits: evidence with file:line references, not specifications.

## Reference pipeline

```
AbsoluteTuneProposal (autotune/absolute.py: propose_absolute_tune)
→ evaluate_mechanical_safety(analysis, require_analysis=True)   safety/mechanical_eval.py
→ clamp_safe_tune(proposal, mechanical, analysis, hardware)      safety/safe_tune.py, clamps.py, thermal.py
→ evaluate_tuning_output_safety(candidate, analysis)             safety/output.py
→ finalize_safe_tune                                             safety/pipeline.py  (actionable = False)
→ authorize_cli (CLI bundle; WU11)                               cli/authorize.py
```

Safety works on the **absolute** tune: current and proposed P, I, D, F and d_max per axis, plus eight
filter Hz values. Sliders matter only through:

- the proposal's status and review reasons;
- its blocked reasons;
- the slider-consistency validity of the proposal.

## Analysis evidence: what Safety actually reads

Safety does **not** need the complete analysis object. It reads these fields of `build_analysis_evidence`
(`analysis/evidence.py`), and nothing else:

| Field                                                               | Read by                                                                         | Producer                                          |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------- |
| `ok`, `message`                                                     | missing-analysis block (M18, O11)                                               | `analysis/evidence.py`                            |
| `problems.problems[*]` {type, severity, confidence, text}           | mechanical M1–M5, M14; thermal cap S12                                          | `analysis/problem_detection_engine.py`            |
| `motors.diagnostics.motors[*]` {status, confidence, health, issues} | mechanical M6–M8, M14, M16                                                      | `analysis/motor_diagnostics.py`                   |
| `metrics.noise.value`, `metrics.noise.hf_ratio`                     | adapter noise level, mechanical high-noise                                      | `analysis/metrics_engine.py` (`_noise_block`)     |
| `metrics.resonance.severity`                                        | mechanical resonance context                                                    | `analysis/metrics_engine.py` (`_resonance_block`) |
| `resonance.primary.{type,bandwidth}`, `resonance.spread`            | mechanical broad/persistent resonance (M9–M12)                                  | `analysis/resonance.py`                           |
| `confidence.score`                                                  | mechanical low confidence (< 0.45), clamp blend (< 0.4), output warning (< 0.4) | `analysis/confidence_unified.py`                  |
| `quality.status`                                                    | mechanical low confidence, output block `quality_status_low_quality`            | `analysis/quality_engine_v2.py`                   |

Safety also reads some keys that **no producer emits**, so their defaults always apply:

- `metrics.noise.level`;
- `motors.diagnostics.health`;
- `has_desync_risk`;
- `rpm_dshot_health`;
- `filter_intelligence` and the RPM confidence keys.

Some evidence is **not consumed at all**: motor saturation, clipping, propwash, step response, D-term
effectiveness, eRPM, and the FFT/spectral and segment data. Saturation and propwash reach Safety only
indirectly, as `problems` rows: a "saturat*" text or a propwash row can trigger M4.

**Known unstable** (GyroCore's own `docs/analysis-input-stability.md`, `tools/analysis_stability/`,
`ANALYSIS_STABILITY_GATE=WARN`):

- **Resonance** type, bandwidth, spread and severity. On the AIR65 log 1, a 481 Hz cluster sits at a threshold
  ratio of 1.0211 and disappears when 0.05 % of rows are removed.
- **Noise** value and hf_ratio. They come from the same capped FFT, and real values sit at the
  cleanliness-45 edge.
- **Confidence score**: 0.613 → 0.650 under perturbation.
- **Problem severity**: oscillation flips between medium and high.
- **Smaller drift**: quality and motor diagnostics share the capped rows.

None of these fields is qualified for Gyroflight.

## The reference fails open on partial evidence

`analysis_is_usable` rejects only a non-mapping or `ok: false`. Every missing field then defaults to "clean":

- noise cleanliness 100;
- confidence 1.0;
- resonance "low".

`{}`, `{"ok": true}` and `require_analysis=False` all end at PASS and an **authorized** CLI. Output safety also
reads `score or 1.0`, so a score of 0 counts as 1.0, and a NaN confidence never triggers. Gyroflight will not
port these paths. A future evidence contract must require every field and block when any is absent.

## Dependency map and classification

Classes:

| Class | Name                               |
| ----- | ---------------------------------- |
| A     | PORT_NOW_DETERMINISTIC             |
| B     | PORT_NOW_BUT_NOT_AUTHORITATIVE_YET |
| C     | BLOCKED_BY_ANALYSIS                |
| D     | REFERENCE_STALE_OR_UNSAFE          |
| E     | NEEDS_INVESTIGATION                |

Dependency letters: T = tune only, F = firmware/config, H = static hardware, E = analysis evidence. Each
component is counted once, by its dominant class; secondary flags are noted.

### Group 1: absolute mapping (`absolute.py`, `current_tune.py`, `simplified_tuning.py`): 22 components

The WU3 merge codes and the per-axis current-tune gates are already ported (WU2/WU3) and are not counted here.

| #   | Component / code                                                                                                       | Dep. | Class                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------- |
| 1   | `simplified_pids_mode_off` (block)                                                                                     | T    | A                                                                          |
| 2   | `proposed_pid_sliders_incomplete:<n>` (block)                                                                          | T    | A                                                                          |
| 3   | `proposed_dterm_sliders_incomplete:<n>` (block)                                                                        | T    | A                                                                          |
| 4   | `proposed_sliders_outside_cli_minmax:<n>` (warn)                                                                       | T+F  | A                                                                          |
| 5   | `slider_missing:<n>` (warn)                                                                                            | T    | A                                                                          |
| 6   | current validity skips `current_pid_or_dterm_incomplete`, `current_gyro_incomplete`                                    | T    | A                                                                          |
| 7   | validity skips `pids_/gyro_/dterm_sliders_incomplete:<n>`                                                              | T    | A                                                                          |
| 8   | slider-consistency field mismatches (validity evidence)                                                                | T+F  | A                                                                          |
| 9   | missing-value notes (`absent`, `unparseable`, `not in BBL header or CLI`)                                              | T    | A                                                                          |
| 10  | `absolute_tune_to_config`                                                                                              | T    | A                                                                          |
| 11  | `config_to_absolute_tune` (Python `round`: half to even)                                                               | T    | A                                                                          |
| 12  | pass-through of the recommendation's blocks/warnings (in Gyroflight: the composite's, from qualified WU2/WU3 evidence) | T    | A                                                                          |
| 13  | slider → absolute PID numeric prediction                                                                               | T+F  | **B**: see below                                                           |
| 14  | `cli:*ambiguous*`                                                                                                      | CLI  | B (needs a CLI dump and a CLI parser)                                      |
| 15  | `cli_active_profile_<conf>`                                                                                            | CLI  | B                                                                          |
| 16  | `bbl_cli_mismatch:<key>`                                                                                               | CLI  | B                                                                          |
| 17  | `proposed_{dterm,gyro}_hz_from_present_or_zero_missing_not_defaulted`                                                  | T    | D (on header-only input it proposes dyn LPF 0/0 with valid validity)       |
| 18  | `d_min_*` read as d_max (`_DMAX_KEYS`)                                                                                 | F    | D (Betaflight ≥ 2025.12 has only `d_max_*`; on 4.5 `d_min` is the lower D) |
| 19  | header-only path ignores the BBL `d_max`, `ff_weight`, `*_lpf1_dyn_hz` CSV lines                                       | T    | D                                                                          |
| 20  | RP mode proposes yaw P/I/F = 0 (seed profile zeroed; firmware leaves yaw untouched)                                    | T    | D                                                                          |
| 21  | non-numeric `rollPID` element crashes (`int(nan)`)                                                                     | T    | E                                                                          |
| 22  | gyro filter ON with gyro multiplier missing crashes (`TypeError`)                                                      | T    | E                                                                          |

**Absolute prediction (row 13) is not authoritative.** GyroCore's float32 port reproduces the plain C source
of `simplified_tuning.c`, which is byte-identical to master `4fc1520c`. The shipped firmware is built with
`-flto -ffast-math -Os`. Executed in an emulator, the compiled STM32F405 binary differs from the plain C
source in **243,867** of 1,001,681 × 3 axis results; the app's own `simplifiedTuning.ts` differs in 255,831.
For example:

| Sliders                  | Shipped F405 binary | Plain C source and app |
| ------------------------ | ------------------- | ---------------------- |
| master 50, ff 60         | roll F 35           | 36                     |
| master 125, pi 125, i 80 | roll I 99           | 100                    |

Classification: **CONTRACT_DIFFERENCE / UNRESOLVED**. This was measured on the F405 build only; other MCU families
are untested. The authoritative absolute values come from the flight controller itself, through
`MSP_CALCULATE_SIMPLIFIED_PID`. Gyroflight will not emulate the ARM fast-math arithmetic.

Evidence: `test/gyrocore/fixtures/betaflight_sim/bf_matrix.json` (`fw_real_f405`) and
`wu4_harness/real_emu_check_1M.json`.

### Group 2: safety stages and authorization (`safety/*`, `cli/authorize.py`): 32 components (61 rule IDs)

The rule IDs are:

- M1–M18 mechanical;
- S1–S14 safe-tune;
- O1–O16 output;
- A1–A13 authorize.

| Component                                                                                                                                   | Dep.                      | Missing analysis (default `require_analysis=True`) | Class                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------- |
| M18 `missing_required_analysis`                                                                                                             | E (`ok`)                  | BLOCK                                              | A (secondary D: `{}` / `{"ok":true}` pass through)                            |
| adapter (`analysis_adapter.py`)                                                                                                             | E                         | n/a                                                | B                                                                             |
| M1–M5 problem rules                                                                                                                         | E                         | BLOCK via M18                                      | C                                                                             |
| M6–M8, M14, M16 motor rules                                                                                                                 | E                         | BLOCK via M18                                      | C                                                                             |
| M9–M12 resonance rules                                                                                                                      | E                         | BLOCK via M18                                      | C                                                                             |
| high-noise flag                                                                                                                             | E                         | BLOCK via M18                                      | C                                                                             |
| M13, M15 low-confidence rules                                                                                                               | E                         | BLOCK via M18                                      | C                                                                             |
| M17 scale tiers (0 / 0.5 / 0.65 / 0.75 / 1.0)                                                                                               | E                         | scale 0                                            | C                                                                             |
| fault helpers (`fault.py`)                                                                                                                  | E                         | n/a                                                | B (secondary E: `health` never produced)                                      |
| S1–S5 structural blocks (missing baseline, malformed, merge review, proposal blocked, mechanical block)                                     | T                         | n/a                                                | A                                                                             |
| S6 max-delta-scale check                                                                                                                    | E (via mechanical)        | BLOCK                                              | B                                                                             |
| S7 step clamp (`DEFAULT_MAX_DELTA`, scaled by mechanical)                                                                                   | T × E                     | blocked earlier                                    | B (secondary E: `dterm_lpf1_static_hz` has no cap entry, so it is frozen)     |
| S8 confidence blend 50 % toward baseline                                                                                                    | E                         | none                                               | C                                                                             |
| S9 hardware weight > 800 → D, d_max × 0.9                                                                                                   | H                         | n/a                                                | E (no caller passes `hardware`; unit ambiguous)                               |
| S10 hard ranges (filter advisory, donor PID advisory, firmware ceilings)                                                                    | T+F                       | n/a                                                | A                                                                             |
| S11 cross-field dyn min/max                                                                                                                 | T                         | n/a                                                | A                                                                             |
| S12 thermal envelope (motor_issue, desync, RPM gate)                                                                                        | E                         | not enforced                                       | C (secondary E: RPM gate has no producer; D: no temperature is ever measured) |
| S13 status and clamp ids                                                                                                                    | T                         | n/a                                                | A (secondary D: order depends on PYTHONHASHSEED)                              |
| S14 integer rounding (half to even)                                                                                                         | T                         | n/a                                                | A                                                                             |
| O1–O3 stage results                                                                                                                         | from stages               | n/a                                                | A                                                                             |
| O4–O7, O9, O10 (merge review, sysid, malformed, missing baseline, invalid simplified state, slider inconsistency)                           | T                         | n/a                                                | A                                                                             |
| O8 `missing_current_tune`                                                                                                                   | —                         | —                                                  | D (unreachable)                                                               |
| O11 `missing_required_analysis`                                                                                                             | E (`ok`)                  | BLOCK                                              | A (secondary D: fails open on `{}`)                                           |
| O12 `quality_status_low_quality`                                                                                                            | E                         | no block                                           | C                                                                             |
| O13 `analysis_confidence_low`                                                                                                               | E                         | no warning                                         | C (secondary D: `score or 1.0`, NaN ignored)                                  |
| O14 `noise_level_high`                                                                                                                      | E (`metrics.noise.level`) | never fires                                        | D (field never emitted)                                                       |
| O15 `resulting_values_invalid` (firmware range)                                                                                             | T+F                       | n/a                                                | A                                                                             |
| O16 `safe_tune_clamps_applied`                                                                                                              | T                         | n/a                                                | A                                                                             |
| unused constants (`missing_mechanical_safety_stage`, `missing_safe_tune_stage`, `unsupported_betaflight_state` in output.py, `DENY_STAGES`) | —                         | —                                                  | D                                                                             |
| A1–A5, A7–A13 CLI authorization                                                                                                             | T+F                       | n/a                                                | A (CLI bundle; Gyroflight writes sliders over MSP)                            |
| A6 firmware support                                                                                                                         | F                         | n/a                                                | D (classifies the hard-coded `FIRMWARE_PROVENANCE`, never the log's version)  |
| worker demo fallback (`analyze_local.py:390`)                                                                                               | —                         | —                                                  | D (substitutes a demo recommendation on failure)                              |

### Totals

| Class                                | Group 1 | Group 2 | Total  |
| ------------------------------------ | ------- | ------- | ------ |
| A PORT_NOW_DETERMINISTIC             | 12      | 12      | **24** |
| B PORT_NOW_BUT_NOT_AUTHORITATIVE_YET | 4       | 4       | **8**  |
| C BLOCKED_BY_ANALYSIS                | 0       | 10      | **10** |
| D REFERENCE_STALE_OR_UNSAFE          | 4       | 5       | **9**  |
| E NEEDS_INVESTIGATION                | 2       | 1       | **3**  |
| total                                | 22      | 32      | **54** |

The deterministic clamp stage is **not** analysis-free in the pipeline. Three things depend on analysis:

- the step caps are multiplied by the mechanical scale;
- the confidence blend reads the confidence score;
- the thermal cap reads the problem list.

The pure functions are deterministic and could be ported, but in the pipeline they only run after the
analysis-scaled step clamp:

- `apply_to_baseline`;
- `scale_max_delta`;
- the hard-range and cross-field clamps;
- the thermal clamp, given a boolean.

WU4A ports `scale_max_delta` only (see below).

## Consequences

- **Full Safety cannot be completed without analysis evidence.** Migrating Analysis wholesale is not the
  prerequisite. The prerequisite is a **Safety-evidence contract** WU:
    - provide exactly the eight fields above;
    - give each one its own stability qualification (GyroCore rates resonance, noise, confidence and problem
      severity as unstable);
    - require every field, with no fail-open defaults.
- **WU3's safe positive fixture through the reference:**

    | Input                           | Verdict   | Codes                                                                               |
    | ------------------------------- | --------- | ----------------------------------------------------------------------------------- |
    | Product path (no analysis)      | **BLOCK** | `mechanical_hard_block`, `missing_required_analysis`, `safe_tune_candidate_blocked` |
    | Reference tests' clean analysis | **WARN**  | 9 step clamps (`safe_tune.step:{roll,pitch,yaw}.{p,i,ff}`)                          |

    WARN means preview only, never actionable. Gyroflight writes sliders, so a clamped absolute tune cannot be
    written at all.

- **The product lock stays `full_safety_engine_pending`.**

## WU4A: what is implemented

All of it lives in `src/gyrocore/safety/`.

| File                  | Port of                                                                 | Notes                                                                                                                                                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `simplifiedTuning.ts` | `betaflight/simplified_tuning.py`                                       | binary32 at every step, truncate then clamp, integer filter Hz, validity with mismatch evidence, CLI range. Not authoritative on a real craft (above).                                                                                                  |
| `absolute.ts`         | `autotune/absolute.py` + `current_tune.py`, BBL-header path             | current absolute tune, absolute proposal from the composite's merge, validity, deltas, `absolute_tune_to_config`. Reference-compatible options plus the adaptations below.                                                                              |
| `pipeline.ts`         | `safety/pipeline.py`, `mechanical_eval.py`, `safe_tune.py`, `output.py` | Mechanical: missing-analysis branch only. Candidate: structural blocks only. Output safety: every check that reads no analysis field, in the reference's order. Finalize. `scale_max_delta` and `_values_within_firmware` are ported as pure functions. |
| `evaluate.ts`         | product entry                                                           | `evaluateSafety(composite, log)` gives one `SafetyResult`.                                                                                                                                                                                              |
| `authorize.ts`        | Apply step                                                              | `safetyForComposite`, `assertSafetyAuthorized`.                                                                                                                                                                                                         |
| `reasons.ts`          | text                                                                    | `gyrocoreSafety_*` messages.                                                                                                                                                                                                                            |

### Adaptations of the reference (explicit, each tested against the reference behaviour)

| Id  | Reference behaviour                                                                                    | Gyroflight                                                                                                                                                  | Classification                                  |
| --- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| D1  | reads `d_min_roll/pitch/yaw` as d_max                                                                  | not ported. Gyroflight reads BBL headers only, and a pre-2025.12 `d_min` line is never d_max                                                                | REFERENCE_STALE                                 |
| D2  | header-only: F, d_max and dynamic LPF min/max are read only under CLI names, so they come back missing | also reads the Betaflight CSV lines `ff_weight`, `d_max`, `dterm_lpf1_dyn_hz`, `gyro_lpf1_dyn_hz` (blackbox.c); never overrides a value the reference finds | CONTRACT_DIFFERENCE (no CLI dump in Gyroflight) |
| D3  | RP mode: the zeroed seed profile proposes yaw P/I/F = 0                                                | yaw keeps its logged values, or is missing if not logged; the firmware leaves an undriven axis untouched                                                    | PORT_BUG in the reference                       |
| E1  | a non-numeric `rollPID` element crashes (`ValueError`)                                                 | that value is missing (`unparseable`), so the baseline is incomplete and Safety blocks                                                                      | NEEDS_INVESTIGATION resolved fail-closed        |
| E2  | gyro filter ON with its multiplier missing crashes (`TypeError`)                                       | blocks with `proposed_gyro_sliders_incomplete:<names>`                                                                                                      | NEEDS_INVESTIGATION resolved fail-closed        |

The sysid substring heuristic of `output.py` (`"system" in reason`, class D) is ported only for parity. It
can only add a block, and an authorized composite has no blocked reasons.

### Class A but not ported in WU4A, and why

Of the 24 class-A components, WU4A ports 19: group 1 rows 1–12, and group 2 M18, S1–S5, S13 (status),
O1–O3, O4–O7/O9/O10, O11 and O15. These five are not ported (S10 and S11 share a row):

| Component                                                    | Why not now                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S10 hard ranges, S11 cross-field (`apply_safety_autotune`)   | They run only after the step clamp, whose caps the mechanical result (analysis) scales, together with S8 (confidence blend) and S9 (hardware weight). They are unreachable in a pipeline that blocks without analysis. Port them with the clamp stage in WU4B. |
| S14 rounding (`config_to_absolute_tune`, round half to even) | Only builds the clamped tune, which exists only after the clamps.                                                                                                                                                                                              |
| O16 `safe_tune_clamps_applied`                               | Needs a WARN candidate (clamps applied), so it is unreachable without analysis.                                                                                                                                                                                |
| A1–A13 CLI authorization (`cli/authorize.py`)                | Authorizes a CLI bundle (apply and rollback text). Gyroflight writes sliders over MSP and produces no CLI bundle. The equivalent checks belong to the hardware-write WU.                                                                                       |

Committed reference sections and their consumers:

| Consumed by TS tests            | Committed for WU4B, not consumed yet                  |
| ------------------------------- | ----------------------------------------------------- |
| `foundation.simplified_tuning`  | `foundation.safe_tune_output`                         |
| `foundation.mapping_sweep`      | `foundation.construct_only`                           |
| `foundation.absolute`           | `stages.apply_to_baseline`                            |
| `stages.scale_max_delta`        | `stages.apply_safety_autotune`                        |
| `stages.values_within_firmware` | `stages.record_numeric_clamps`                        |
| `product_path`                  | `stages.clamp_targets_to_baseline_thermal`            |
|                                 | all of `safety_harness_reference.json` (harness only) |

### Gyroflight input contract

`evaluate.ts` adds input-contract checks. These are not GyroCore rules; they only make sure Safety sees
exactly what the composite used:

| Code                                            | When                                                                                                                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `safety_not_evaluated:no_global_recommendation` | no composite                                                                                                                                                      |
| `safety_not_evaluated:blocked_upstream`         | the composite is not authorized (measurement, merge, coverage or clamp guard blocked it). Status NOT_EVALUATED; no Safety verdict is made from unqualified input. |
| `safety_input_missing:log_headers`              | the log's raw header lines are unavailable                                                                                                                        |
| `safety_input_inconsistent:current_sliders`     | the sliders read for the absolute tune differ from the composite's logged baseline. Nothing is reconstructed.                                                     |

### Result model (`SafetyResult`)

| Field              | Contents                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `status`           | PASS, WARN, BLOCK or NOT_EVALUATED. Only PASS authorizes; WARN is preview only, as in the reference.                             |
| binding            | `compositeId`, `sliders` (the exact payload), `reportToken`, `logIndex`, `firmwareRevision`                                      |
| verdict            | `blocks`, `warnings` (machine-readable codes with `gyrocoreSafety_*` text), `checks`                                             |
| tune               | `currentSliders`, `proposedSliders`, `current` and `proposed` absolute tunes (each value with source, origin and note), `deltas` |
| `analysisEvidence` | `"not_available"`                                                                                                                |
| `pipeline`         | every stage result: mechanical, candidate, output safety, final                                                                  |

### Authority chain at Apply (`useAutotune.applyGains`)

1. **Composite gate (WU3/WU3.1).**
2. **`assertSafetyAuthorized`.** It recomputes Safety from the current state for exactly this composite id
   and slider payload, and throws `safety:<code>` unless the result is PASS.
3. **Product lock (`full_safety_engine_pending`).**
4. **One MSP read and the live recheck (WU3/WU3.1).**
5. **SET, then EEPROM.**

Safety recomputes on every call and is bound to the composite id, which changes with selection, target,
per-axis recommendation, merge or final sliders. An old or edited Safety result is therefore never reused.

Safety does not yet need live FC values beyond the WU3.1 recheck, because it never passes. Once it can,
the hardware-write WU must read `MSP_PID`, `MSP_PID_ADVANCED` and `MSP_FILTER_CONFIG` before SET and
compare them with the logged absolute baseline Safety used.

### UI

Under the Global tune box, a **GyroCore Safety** box shows:

- the status badge;
- why Safety cannot authorize: no analysis evidence, or blocked upstream;
- current versus proposed absolute values with deltas;
- the blocks and warnings with their explanations.

The Apply notice shows a Safety block separately from both a composite rejection and the product lock.

### Results

| Fixture                                                                             | Measurement | Merge                 | Coverage               | Safety                                                                                         | Software authorization |
| ----------------------------------------------------------------------------------- | ----------- | --------------------- | ---------------------- | ---------------------------------------------------------------------------------------------- | ---------------------- |
| WU3 safe positive (RPY, sliders 100 → PI 138, FF 138), real Betaflight header lines | 3 × usable  | merged                | roll/pitch/yaw covered | **BLOCK**: `mechanical_hard_block`, `missing_required_analysis`, `safe_tune_candidate_blocked` | **false**              |
| same, WU3 synthetic log (no `ff_weight`/filter lines)                               | 3 × usable  | merged                | covered                | **BLOCK**, as above, plus `missing_required_pid_or_filter_baseline:...`                        | false                  |
| reference tests' clean analysis (harness only, Python)                              | —           | —                     | —                      | WARN: 9 step clamps, preview only                                                              | false                  |
| AIR65 (local)                                                                       | 0 usable    | MERGE_REQUIRES_REVIEW | —                      | **NOT_EVALUATED** in all 3 logs                                                                | false; 0 MSP calls     |

On the safe fixture the current and proposed absolute values are:

- roll P 45 → 62, I 80 → 110, F 120 → 165;
- pitch P 47 → 64, F 125 → 172.

These come from the firmware-mapping port and are not authoritative on a real craft.

## Parity fixtures

- **Generator:** `test/gyrocore/tools/gc_safety_reference.py`. It imports GyroCore read-only. Run it with
  `PYTHONHASHSEED=0`; its run line is in the file.
- **Fixtures** in `test/gyrocore/fixtures/safety/`, generated from GyroCore `d2e60f7`:

    | File                                 | Contents                                                                                                                                                                                      |
    | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
    | `safety_foundation_reference.json`   | parity input only. Its full-stage cases run the mechanical stage as `evaluate_mechanical_safety(None, require_analysis=False)` (donor default PASS, scale 1.0); that is not product evidence. |
    | `safety_product_path_reference.json` | `run_safety_pipeline(analysis=None or {"ok": false})`. Every case is BLOCK.                                                                                                                   |
    | `safety_harness_reference.json`      | labelled `TEST_HARNESS_ONLY_NOT_PRODUCT_EVIDENCE`: the reference tests' clean analysis, the full-pipeline runs, and mechanical and thermal gate cases.                                        |

- **Conventions** (from the reference):
    - filter clamp ids, checks and warnings are compared order-insensitively (hash-seed order);
    - integer rounding is half to even;
    - float fields compare within 1e-9;
    - non-finite numbers are encoded as strings.
- **Betaflight matrix:** `test/gyrocore/fixtures/betaflight_sim/bf_matrix.json`, with the harness sources in
  `wu4_harness/`.

## Other findings reported, not acted on

- `MSP_VALIDATE_SIMPLIFIED_TUNING` after `MSP_SET_SIMPLIFIED_TUNING` is tautological: it re-applies the sliders
  just written. A meaningful check:
    - validates **before** SET, to catch hand-edited PIDs that SET overwrites;
    - before SET, gets `MSP_CALCULATE_SIMPLIFIED_PID` for the proposal;
    - after SET, compares that against `MSP_PID` + `MSP_PID_ADVANCED`.

    That belongs to the hardware-write WU.

- An in-flight adjustment (`ADJUSTMENT_SIMPLIFIED_MASTER_MULTIPLIER`) can change the master multiplier during a
  flight. The header-logged slider may then not be the one in effect during the CHIRP.
- Gyro filter changes take effect only after a reboot. The app's cached PIDs and filters are stale after apply.
