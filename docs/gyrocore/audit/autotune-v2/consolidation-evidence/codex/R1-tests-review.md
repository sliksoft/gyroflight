**P1 — The craft-class header promises a phase-margin check that is absent for sevenInch.**  
In `22efe859`, `test/gyrocore/v2_craft_class_truth.test.ts:28` says crossover **and phase margin** must match analytic truth for both classes. Only the AIR65 branch compares phase margin (`:134`); the sevenInch branch (`:138–144`) checks evidence level, gaps and planning diagnostics.

Concrete scenario: sevenInch’s measured phase margin becomes incorrect or null while its crossover and diagnostics remain unchanged. Every assertion still passes despite the stated correctness claim. Add a justified sevenInch phase-margin comparison, or explicitly narrow the header’s claim.

The analytic truth itself is consistent with the harness:

- Both reconstruct the roll controller from the same controller-relevant headers, with `looptime=125` and `pid_process_denom=8`.
- The harness generates `T = G*C_ref/(1 + G*C_fb)`; the oracle correctly compares the recovered loop against `L = G*C_fb`.
- Sweep-header differences do not affect `controllerConfigFromHeaders`. This is software consistency evidence using a shared controller model.

**P3 — Non-blocking limitations**

- In `d10c3433`, `test/gyrocore/v2_phase_unwrap.test.ts:71–74` genuinely checks the exact ambiguity diagnostic. However, its null gain-margin and `MEASURED` assertions do not independently establish that the unwrap guard suppresses bounds: the approximately 180° jump also violates the separate resolution limit (`loopModel.ts:555–558`). The no-resonance control only checks diagnostic absence. This is masked coverage, not a demonstrated always-true assertion.
- The filter release assertion (`test/gyrocore/v2_filter_status.test.ts:56–57`) accepts a null proposal as an empty list. That correctly checks absence for this input, but provides limited evidence about exclusion when an otherwise releasable proposal exists.

Otherwise, `v2_filter_status` exercises the claimed production branches: all four groups and their `PARTIAL` statuses, exact rejection reasons for D-term filtering, and gyro-side blocking after scaling the unfiltered channels. “Validate by construction” accurately describes the synthetic chain/D-path fit; the header explicitly labels the evidence as simulation.

No literal always-true assertion was established. Neither commit changes production code or demonstrates an FC-write bypass. Reviewed using `git show` at detached HEAD `a4555b5f`; tests were not run, files were not modified, and no network was used. Existing untracked `.serena/` was left untouched.

P0_OPEN=0
P1_OPEN=1
P2_OPEN=0
VERDICT=REQUEST_CHANGES