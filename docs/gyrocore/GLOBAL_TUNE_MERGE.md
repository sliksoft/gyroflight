# Global tune merge and Apply authorization (WU3)

Betaflight's simplified-tuning sliders are global. Every key Autotune proposes affects every axis the
slider mode covers: master multiplier, PI gain, I gain, D gain, feed-forward and the D-term filter
multiplier. WU2 authorized Apply from one selected axis's measurement, which would write that axis's
sliders to all axes.

WU3 changes this. Apply now writes one **composite (global) recommendation**, merged by GyroCore's
existing merge from the qualified per-axis Betaflight recommendations of one log. Per-axis
recommendations are evidence and can no longer be applied.

Branch `gyroflight/wu3-global-slider` from `gyroflight/main` (`ebd73798`). GyroCore reference:
`~/GyroCore` at `d2e60f7`, read only.

## Authority chain

```
Betaflight Viewer parser            decode every embedded log                 src/blackbox-viewer (unmodified)
→ GyroCore measurement qualification valid for tuning? (WU2)                   src/gyrocore/chirp/
→ Betaflight tuning math            per-axis recommendGains (evidence)        spectral_analysis.ts (unmodified)
→ GyroCore global merge             one slider set, or review                 src/gyrocore/tuning/merge.ts
→ GyroCore safety authorization     composite gate + live FC recheck          src/gyrocore/tuning/{composite,authorize}.ts
→ FC Apply                          MSP_SET_SIMPLIFIED_TUNING + EEPROM        useAutotune.applyGains
```

## The reference merge (ported unchanged)

The merge is `core/gyrocore/autotune/merge.py` `merge_autotune_sliders`, policy
`gyrocore.autotune.global_slider.merge.v1`. It is ported line for line to
`src/gyrocore/tuning/merge.ts`, and its output keeps the same keys as `GlobalSliderMerge.to_dict()`.

| Aspect                | GyroCore contract (and the port)                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Inputs                | per-axis recommendations of **one** log: axis, blocked, proposed slider integers (`int()`)                                                                                                       |
| Participation         | every axis that is not blocked and has a proposal; blocked axes are ignored                                                                                                                      |
| Required axes         | **none**: one, two or three axes may take part; zero gives `MERGE_REQUIRES_REVIEW` / `no_participating_axes`                                                                                     |
| Merge rule            | per slider: all participating integers equal → that value; any difference → `slider_disagreement:<key>` and review                                                                               |
| Weighting / averaging | none: no mean, min, max, tolerance, weighting or axis priority                                                                                                                                   |
| Rounding / clamping   | none in the merge; Betaflight's `buildProposedSliders` already rounded (`Math.round`) and clamped (25–250)                                                                                       |
| Roll/pitch, yaw       | no special treatment; yaw takes part like any axis, unless the engine blocked it (`yaw_not_under_slider_control`, RP)                                                                            |
| Untouched sliders     | `pids_mode`, `d_max_gain`, `pitch_d_gain`, `pitch_pi_gain`, `dterm_filter`, `gyro_filter*` keep the current values                                                                               |
| Single axis           | merges as `single_axis_matches_upstream_apply`                                                                                                                                                   |
| Repeated measurements | **no rule** (one log, at most one per axis)                                                                                                                                                      |
| Output                | `status` `merged` / `MERGE_REQUIRES_REVIEW`, `fields` per slider (`values_by_axis`, `agreed`, `chosen`, `constrained_by`, `reason`), `proposed_sliders`, `simplified`, `review_reasons`, `notes` |

`AUTOTUNE_TO_SLIDER` and `UNTOUCHED_BY_AUTOTUNE` exist in merge.py but are unused there, so they are not
ported.

## Composite recommendation

`buildComposite()` in `src/gyrocore/tuning/composite.ts` works on one log, because every recommendation
scales that log's current sliders. It produces a `CompositeRecommendation` with:

- **`id`**: `composite-log<N>-<hash>`. The hash covers the analysis token, log, target margin, the sources
  and their proposals, the final sliders and the blocks. Any change makes an earlier id stale.
- **`sources`**: each measurement of the log, with id, log, axis, its per-axis Betaflight proposal, the
  requested (unclamped) value per slider, and a role:
    - `participating`;
    - `excluded_by_axis_gate`: GyroCore's engine blocks the axis, e.g. yaw in RP mode or slider mode OFF;
    - `not_selected`: another sweep of the axis was chosen;
    - `rejected`: failed measurement qualification.
- **`current`**: the logged firmware sliders, all 13; null where not logged.
- **`merge`**: the ported merge output.
- **`final`**: the global slider set Apply would write, or null.
- **`sliders`**: per slider, current, per-axis proposal, per-axis request, final value, final direction,
  and the block reason.
- **`blocked`**, **`warnings`**, **`authorized`**; plus firmware revision and target phase margin.

### Selecting sources (the repeated-measurement contract)

GyroCore defines no rule for several sweeps of one axis. WU2 keeps every sweep, and WU3 neither averages
nor picks the latest or first. Per axis:

| Measurements on the axis | Result                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| none                     | the axis does not take part (no axis is required)                                                          |
| all fail qualification   | **block** `system_id_unusable`, `system_id_unusable:<id>` + the measurement's codes                        |
| exactly one qualified    | that one; rejected repeats are reported (`rejected_repeat_not_used:<id>`)                                  |
| two or more qualified    | **block** `repeated_axis_requires_selection:<axis>` until the user explicitly picks one in the CHIRP table |

"Qualified" means: no measurement-gate block, no sample-rate-contract block, and a Betaflight
recommendation exists. The default display selection never counts as an explicit choice; only a click in
the qualification table does (`selectMeasurement(id, true)`).

### Checks around the merge

1. **Axis gates (GyroCore engine):** a source blocked by `_tune_gates` is passed to the merge as blocked:
   `simplified_pids_mode_off` or `_unknown`, `yaw_not_under_slider_control`, `current_tune_*`. Yaw under
   RP is therefore left out, and roll and pitch still merge.
2. **Merge review:** `unresolved_merge_requires_review` (safety/output.py `BLOCK_MERGE_REVIEW`) plus the
   merge's review reasons.
3. **After a resolved merge (absolute.py):**
    - block `simplified_pids_mode_off`;
    - block `proposed_pid_sliders_incomplete:<names>` / `proposed_dterm_sliders_incomplete:<names>` when a
      logged slider the firmware needs is missing;
    - warn `proposed_sliders_outside_cli_minmax:<names>`, and `dterm_filter_off_multiplier_has_no_effect`.
4. **Source recommendation safety (WU2):** the WU2 blocks on a participating source carry into the
   composite: slider-clamp guard, `autotune_sensitivity_bound_unreachable`.
5. **Final clamp guard:** on each global value, against every participating axis's request (current ×
   scale × 100, before Betaflight's clamp):
    - block `composite_clamp_changes_direction:<key>` if the direction differs;
    - block `composite_clamp_material:<key>` if the value is more than 0.5 (rounding) away.
    - Requested and applied values are kept in `sliders[]`.

### Consequence of the ported contract: one-axis composites

GyroCore's merge requires no axis, so a log with only a roll sweep yields an authorized one-source
composite (`single_axis_matches_upstream_apply`; the `single_roll` end-to-end case). Under slider mode
RPY, applying it changes pitch and yaw from a roll measurement alone. That is what upstream Autotune
does, and what WU2 did. Gyroflight keeps the reference contract here instead of inventing a stricter
one. The smallest adaptation, if the owner wants it, is to require a participating source for every axis
the logged slider mode covers (roll + pitch for RP; roll + pitch + yaw for RPY).

### Deliberate adaptations (documented, tested)

| Topic                                   | Python engine                                       | Gyroflight                                   | Why                                                                                                                                            |
| --------------------------------------- | --------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| an axis with only rejected measurements | merge ignores it; proposal `proposed_with_warnings` | composite **blocked** (`system_id_unusable`) | GyroCore's own safety-pipeline test (`test_system_id_unusable`) blocks this; its helper lifts axis blocks to the proposal, the engine does not |
| slider clamped by 25–250                | warning `slider_clamped`                            | block on direction change or > rounding      | WU2 §6 / WU3 §6 (FF floor)                                                                                                                     |
| `simplified_pids_mode` unknown          | warning; axis takes part                            | axis gated (WU2); composite blocked          | a slider proposal cannot be shown to reach the PIDs                                                                                            |
| several qualified sweeps of one axis    | not defined (one per axis)                          | explicit user selection required             | no rule exists; no averaging or recency invented                                                                                               |
| multi-log                               | one log per run                                     | one composite per log (selected log)         | each log has its own current tune                                                                                                              |

## Apply hard gate v2

`useAutotune().applyGains(sliders, compositeId)` calls `assertCompositeApplyAuthorized()`
(`src/gyrocore/tuning/authorize.ts`) before any flight-controller access. The gate rebuilds the composite
from the current state, never from a cached copy, and throws `ApplyBlockedError` for:

| Code                                         | When                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| `apply:no_qualified_analysis`                | nothing analysed                                                               |
| `apply:missing_composite_id`                 | no composite named, including the pre-WU3 call without one                     |
| `apply:single_measurement_apply_not_allowed` | a measurement id (the WU2 single-axis apply)                                   |
| `apply:stale_composite`                      | another analysis, log, selection or target, or a changed source recommendation |
| the composite's own blocks                   | any block above (merge review, rejected source, axis gates, clamp guards, …)   |
| `apply:sliders_differ_from_composite`        | sliders not exactly the composite's final values (tampering)                   |

Only then does the action read the craft (`MSP_SIMPLIFIED_TUNING`; a read). `liveCompositeBlocks()` then
refuses before any write when:

- the live slider mode is OFF or unknown (`fc:simplified_pids_mode_off` / `_unknown`);
- the live mode differs from the analysed log's (`fc:simplified_pids_mode_changed`);
- the live mode is RP while yaw contributed to the composite (`fc:yaw_not_under_slider_control`);
- any of the 13 written slider fields differs live from the logged value
  (`fc:current_slider_changed:<key>`):
    - the six proposed sliders, because every recommendation is a scaling of the logged values;
    - the D-term and gyro filter switches, the gyro filter multiplier, D-max, pitch D
      (`slider_roll_pitch_ratio`, logged as `simplified_pitch_d_gain`) and pitch PI. These are written back
      with their live values, so they must equal the logged ones that `merge.simplified` and the pitch
      baseline assume.

The write then sets the six composite keys on top of the live slider state and sends
`MSP_SET_SIMPLIFIED_TUNING`. `validateTuningSliders()` runs next, and `MSP_EEPROM_WRITE` comes last. The
safe positive fixture asserts the exact 53-byte payload.

## UI

- The CHIRP qualification panel (WU2) is unchanged, except that clicking a measurement is now an explicit
  selection.
- **Global tune (GyroCore composite recommendation)**, a new box above Betaflight's gain table, shows:
    - a VALID / NO VALID GLOBAL RECOMMENDATION badge, the log, the firmware and the merge policy;
    - per slider: the logged current value, each participating axis's proposal labelled "per-axis
      evidence" with its unclamped request, and the global value "(would be applied)";
    - every source measurement and its role, with reasons;
    - blocks and warnings in plain language.
- Betaflight's gain table keeps its per-axis rows, under a note that they are evidence. The "apply from
  axis" selector is removed. Apply sends the composite and is disabled, with the reasons listed,
  whenever the composite is not authorized.

## Results

### Python parity

| Layer                            | Fixture                                   | Result                                                                                                      |
| -------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| merge function (20 cases)        | `fixtures/merge/merge_reference.json`     | **exact** deep equality of `to_dict()`, and the same exceptions on invalid input (`KeyError`, `ValueError`) |
| end to end (7 generated flights) | `fixtures/merge/merge_e2e_reference.json` | **exact**: participating axes, every per-axis slider integer, the full merge output                         |

The merge cases cover:

- **nominal:** 1-, 2- and 3-axis agreement, the desktop "pass" fixture;
- **partial axes:** one participating axis, a blocked axis ignored, no participating axes, all axes
  blocked, yaw only;
- **conflicts:** one-slider and all-slider disagreements, a 1-point disagreement, the desktop
  "merge_review" fixture;
- **yaw:** a yaw conflict, yaw blocked under RP;
- **slider values:** clamp boundary values 25/250, Python `int()` truncation of non-integer input;
- **current tune:** non-default and missing current values;
- **input handling:** input order, a missing key, NaN.

There are no floating-point internals in the merge, so no tolerance is used. The end-to-end flights use
Betaflight's math in Gyroflight and GyroCore's port in Python; their integers agree exactly.

The final authorization matches Python's proposal except in two cases, where Gyroflight is stricter as
documented above: `roll_ok_pitch_rejected` (`system_id_unusable`) and `ff_floor_three_axis` (FF floor
reversal).

### Safe positive fixture

The fixture is three identical roll, pitch and yaw sweeps (40 Hz loop, 2-sample delay) with a complete
logged slider tune at 100 and slider mode RPY.

| What                    | Value                                                                                                                                                           |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| measurement gates       | 3 × USABLE                                                                                                                                                      |
| per-axis proposals      | 3 × master 100, PI 138, I 100, D 100, FF 138, D-term filter 100                                                                                                 |
| merge                   | `merged`, unanimous, participating roll, pitch, yaw                                                                                                             |
| expected / actual final | {100, 138, 100, 100, 138, 100} / identical                                                                                                                      |
| MSP sequence (mocked)   | `MSP_SIMPLIFIED_TUNING` (read), `MSP_SET_SIMPLIFIED_TUNING`, `MSP_EEPROM_WRITE`                                                                                 |
| SET payload             | 53 bytes, exactly: mode 2, master 100, ratio 100, I 100, D 100, PI 138, D-max 100, FF 138, pitch-PI 100, reserved, D-term 1/100 + live Hz, gyro 1/100 + live Hz |

No test connects to a flight controller.

### AIR65 (local)

Every measurement fails WU2's gates, so no axis takes part in any of the three logs. Each composite is
`MERGE_REQUIRES_REVIEW` / `no_participating_axes`, with `system_id_unusable` for every measurement.

- Global composites: **0**.
- Apply by composite id or by measurement id: blocked.
- MSP calls: **0**.

Nothing in the code or tests names AIR65.

## Tests

| File                                                 | Covers                                                                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `test/gyrocore/global_merge_parity.test.ts`          | merge port vs Python, 20 cases                                                                                      |
| `test/gyrocore/global_merge_e2e_parity.test.ts`      | generated flights vs Python engine + merge                                                                          |
| `test/gyrocore/chirp_apply_gate.test.ts`             | safe positive payload, RP case, every v2 rejection, live FC recheck, final clamp guard, repeated sweeps, WU2 blocks |
| `test/gyrocore/chirp_qualification_pipeline.test.ts` | Global tune panel rendering (valid and conflict)                                                                    |
| `test/gyrocore/autotune_apply_blocked_ui.test.ts`    | Apply button disabled with composite reasons; a click cannot reach the action                                       |
| `test/gyrocore/air65_qualification.local.test.ts`    | AIR65: 0 composites, Apply blocked, 0 MSP calls                                                                     |

To regenerate the references (only GyroCore's Python is imported; nothing is written to GyroCore):

```bash
D=$(mktemp -d) && cd "$D"
TMPDIR=$PWD PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=~/GyroCore:~/GyroCore/core \
  python3 -B ~/Gyroflight/test/gyrocore/tools/gc_merge_reference.py > merge_reference.json
(cd ~/Gyroflight && GYROFLIGHT_WRITE_E2E_DIR="$D" npx vitest run test/gyrocore/write_merge_e2e_logs.local.test.ts)
TMPDIR=$PWD PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=~/GyroCore:~/GyroCore/core \
  python3 -B ~/Gyroflight/test/gyrocore/tools/gc_merge_e2e.py *.bbl > merge_e2e_reference.json
```

## Not done here

- The full Safety engine (mechanical safety, safe-tune clamps, absolute PID mapping and validity):
  `absolute.py` firmware mapping and `safety/` are not ported.
- Filter autotuning, Analysis, Compare, AI and the legacy tuner.
- Live-PID verification after the write beyond Betaflight's own `validateTuningSliders`.
