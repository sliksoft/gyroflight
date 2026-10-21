# GF-1 M2 — Structure-aware open-loop and phase margin (offline)

**Depends on:** M1 digital controller (`PR #13`).  
**Not wired** into `recommendGains` / Apply. Product path remains `openLoopModel: "unvalidated"`.

## Formula

With Blackbox `T(z) = gyroADCf / setpoint` (setpoint **already** includes chirp `phaseComp`):

\[
L(z) = \frac{C_\mathrm{feedback}(z)\, T(z)}{C_\mathrm{reference}(z) - T(z)\, C_\mathrm{feedback}(z)}
\]

| Symbol | Source |
|--------|--------|
| `C_reference` | M1 `Ce` (P+I; yaw P lowpass on P). **No** second `phaseComp`. |
| `C_feedback` | M1 `Ce + Cd` (D-on-gyro path when D>0). |
| `T` | Welch TF from qualification (`hReal`/`hImag`). |

When `C_reference ≡ C_feedback` (e.g. AIR65 yaw, D=0), this collapses to `L = T/(1−T)`.

## Numerical guards

- Coherence bin floor **0.50** (unchanged).
- Skip f < 2 Hz.
- Skip singular denominators: `|C_ref − T·C_fb| / max(|C_ref|,|T·C_fb|,ε) < 1e−4`.
- Phase unwrapped upward from the first accepted bin.

## Independent validation (synthetic)

A priori tolerances (declared before runs):

| Case | \|Δfc\| | \|ΔPM\| |
|------|--------|--------|
| Clean dense grid | ≤ 0.5 Hz | ≤ 2.0° |
| Coarse / degraded | ≤ 1.5 Hz | ≤ 5.0° |

Ground truth: `L_true = C_feedback · G` with known continuous plant FRF; `T` from `C_ref·G/(1+C_fb·G)`; reconstruct and compare.

## AIR65 Oct-18 yaw (offline probe)

| Item | Value |
|------|-------|
| BBL sha256 | `dfe82bca…eed7efcb` |
| Firmware | `43875a55a` |
| Duration | ≈ 19.94 s |
| Mean coherence 5–100 Hz | ≈ 0.830 |
| Unity-feedback equivalent | **yes** (D=0, Ce cancels) |
| Reconstructed fc (informational) | ≈ 16.8 Hz |
| Reconstructed PM (informational) | ≈ 51.1° |
| Bracket coherence | ≈ 0.987 |
| **Status** | **`NOT_VALIDATED`** |

### Why still NOT_VALIDATED

`dyn_notch` centres and `rpm_filter` schedule are time-varying and **not** reconstructible from headers alone. Their phase contribution around crossover cannot be bounded from this log → do not promote VALIDATED.

Agreement of yaw with `T/(1−T)` proves structure cancellation, **not** that the numerical PM is flight-truth under unknown notches.

## Roll / pitch applicability

| Factor | Effect |
|--------|--------|
| D-on-gyro | Structure-aware formula **required** (`L ≠ T/(1−T)`). |
| D_max (roll) | State-dependent Kd → LTI model invalid when boosting. |
| iterm_relax (RP) | Nonlinear when setpoint HPF large (CHIRP). |
| dyn_notch / rpm | Same unknown as yaw. |
| Quality gates | Oct-18 roll segment **rejected** by existing gates — no product use. |

Method runs offline; status remains `NOT_VALIDATED` with explicit blockers.

## Fail-closed policy (M2)

- `evaluateStructureAwarePhaseMargin()` defaults to **`NOT_VALIDATED`** (`validation_not_attested`) even when math finds a clean single crossover.
- **`VALIDATED` only** with explicit `policy.attestValidated: true` and no blockers.
- Multiple downward `|L|=1` crossings → `ambiguous_multiple` / `ambiguous_multiple_gain_crossovers` (diagnostic list retained).
- Phase unwrap **resets** across non-ok bins; interrupted unwrap blocks promotion (`phase_unwrap_interrupted_by_bin_gaps`).
- AIR65 practical tests report **`EXECUTED`** vs **`SKIPPED`** when the known BBL is absent.

## Implementation

| Path | Role |
|------|------|
| `src/js/blackbox/betaflight_open_loop.ts` | Reconstruct L, crossover, policy |
| `test/js/betaflight_open_loop_reference.test.ts` | Synthetic independent suite |
| `test/js/air65_yaw_open_loop_offline.test.ts` | Local BBL probe |

## M3 / product gate (do not start without ack)

1. Bound or freeze dyn_notch/rpm contribution, **or** accept a documented uncertainty band.
2. Only then consider a new `openLoopModel` (e.g. `betaflight_structure`) in `recommendGains`.
3. Keep coherence 0.50/0.60 and Apply lock until that ack.
