# Autotune v2 — cloud handoff (F1–F8 + residual repair)

Date: 2026-10-30  
Branch: `feat/gyroflight-autotune-engine-v2`  
Draft PR: https://github.com/sliksoft/gyroflight/pull/16  

This document is the sanitized in-repo handoff for cloud continuation. Private audit receipts and real Blackbox logs are **not** in this repository. Totals below are **prior local verification results** (not a new CI run).

## Published repair commits (ancestors of branch tip after sync)

| SHA (short) | Subject |
|-------------|---------|
| `3f7fd27f7438be12112886790ebda270123fd1cf` | Grokbot F1–F8: Welch support, multi-recording, worker cancel, browser scripts, panel coarse margins |
| `5373670490b38215943eafb085785944990660e7` | Reject bit-identical closed-loop FRFs as duplicate measurements |
| `d98015068a8c3b0621b183c921ba18c03853bea7` | Restore identity-fixture geometry after F2 synthetic changes |

Plus this documentation commit (cloud handoff).

## Grokbot F1–F8 register (from local repair scorecard)

Original full Grokbot report file was **not** on disk at repair time; findings were taken from the owner mission brief and confirmed against code. Local scorecard: outside-repo `GYROFLIGHT_F1_F8_REPAIR_RESULT` (2026-10-30). F1 supplemental: outside-repo `F1_RELEASE_EVIDENCE_SUPPLEMENT.md`.

| ID | Verdict | Notes |
|----|---------|--------|
| F1 | Process gap; supplement only | Historical gate counts not rewritten |
| F2 | **FIXED** | `SUB_SEGMENT_DWELL.primary` and `.qualification` are both `UNKNOWN`; no invent `n=1`; unknown uncertainty fail-closed |
| F3 | **FIXED** | `collectMultiRecordingAverages` wired; identity fail-closed; no discontinuous concat |
| F4 | **FIXED** | Worker abort peers requeued on fresh worker; crash fail-closed |
| F5 | **LIMITATION retained** | Practical QUAL→`VALIDATED` on real AIR65 CHIRP not a software “fix”; thresholds not relaxed |
| F6 | **FIXED** | Panel coarsens margin display when evidence ≠ `VALIDATED` |
| F7 | **FIXED** | `npm run test:browser` + CI browser job |
| F8 | Closed by residual repair | Six fixture failures after F2 fixed; full gyrocore green |

## Residual six failures (fixed)

Reproduced at `3f7fd27f7` with:

```bash
npx vitest run test/gyrocore/b3_candidate_end_to_end.test.ts \
  test/gyrocore/final_review_duplicate_flights.test.ts \
  test/gyrocore/wp2_flight_independence.test.ts
# → 6 failed | 28 passed
```

| Failure | Cause class | Fix |
|---------|-------------|-----|
| b3 planned flight (7″ / 5″) | Test expectation | Gate candidate-move asserts on `MODEL_CONDITIONAL`; `MEASURED`/`BLOCKED` may leave no move under F2 |
| final_review non-overlapping sub-ranges (`sharedWindows` 490≠0) | Fixture | Default synthetic channel length back to 11 s (identity arithmetic) |
| final_review re-identified copy released | Production | Bit-identical declared FRF → `cross_log_identical_measurement` (also blocks multi-recording extras) |
| wp2 multi-CHIRP export (`chirp` keys `[]`) | Fixture | Restore staggered per-axis CHIRP slice indices |
| wp2 few shared samples (`SAME` not `UNKNOWN`) | Fixture | Same 11 s geometry (< `minShared` windows from 600-sample splice) |

## Bit-identical FRF protection

`transferFunctionValuesIdentical` (`src/gyrocore/engine/multiRecording.ts`):

- Cross-log plant path rejects a reference whose declared CHIRP FRF equals the primary (same object or equal frequency / `hReal` / `hImag` bins) before plant compare; keeps the existing `meanAbsGRel === 0` plant check.
- Multi-recording does not stack averages from an identical measurement under another hash.

Intent: a gyro-rescaled / clock-restarted copy that flight windows miss must not count as independent plant evidence or extra Welch averages.

## F2 independent-segment / UNKNOWN contract (unchanged by residual sync)

- Less than one whole Welch segment of dwell → averages **UNKNOWN** on both primary and qualification paths (`SUB_SEGMENT_DWELL`).
- No automatic promotion to `n=1`.
- Unknown uncertainty blocks qualification and releasable tuning.
- Without a declared sweep, classical Welch `n = floor((K+1)/2)` only.

## Synthetic fixture geometry (SIMULATION — open review note)

Default `syntheticLogInput` (`test/gyrocore/harness/syntheticLog.ts`):

- **~11 s** of channel samples — chain/D validation and flight-identity windows only.
- **Staggered CHIRP slice indices** per axis (≈1–4 s, 4.3–7.3 s, …) inside that short buffer — identity / multi-segment export tests.
- **Declared** Welch `windowS: 120` (and matching sweep header duration where set) — provenance for synthetic TF dwell counting under F2.

This is **not** a claim of 120 s of physically observed Blackbox support. The long window is declared analysis metadata on a synthetic transfer function. Whether that dual representation remains the preferred CI harness design is an **open review question**; this sync does not change scientific production thresholds.

## Prior local verification (receipts 2026-10-30 residual repair)

Environment noted in receipts: Node v24.22.1. Commands and totals as recorded locally (not re-run by this sync task):

| Gate | Command | Result |
|------|---------|--------|
| Focused residual + multi_recording | vitest on b3 / duplicate / wp2 / multi_recording | PASS (37/37 in combined focused run) |
| F2 focused | `wp3_measurement_uncertainty`, `uncertainty_coverage_mc`, `t3_frequency_support`, `wp3_measurement_plan`, `multi_recording` | **78/78** |
| Gyrocore | `npx vitest run test/gyrocore` | **2620 passed / 2 skipped** (2622) |
| Full repository | `npx vitest run` | **5935 passed / 3 skipped** (5938) |
| Lint + typecheck | `npm run lint` | PASS |
| Build | `npm run build` | PASS |
| Browser | `npm run test:browser` | lease **27/27**, worker **16/16** |
| WP8 Absolute Apply | `test/gyrocore/wp6_absolute_safety.test.ts` | PASS; `hardwareValidated=false` |
| Privacy | `test/gyroflight/privacy.test.ts` | PASS |
| AIR65 Oct 18/19 | local-only env + `air65_autotune_v2.local.test.ts` | PASS — all axes **MEASURED** / `NOT_VALIDATED`, PID **BLOCKED**, no releasable |

**Count honesty:** an earlier F1–F8 local run (before residual fixture repair) recorded gyrocore **2605 pass / 6 fail / 10 skipped**. The residual scorecard’s **2620 / 2 skip** is the post-repair figure. An older draft PR description cited full-suite **5918** and worker **15/15** from a prior gate; current residual receipts are **5935** and worker **16/16**. Prefer the residual receipts for post-repair state.

## Safety invariants (must hold)

- `ABSOLUTE_SAFETY_POLICY.hardwareValidated === false`
- Absolute Apply **BLOCKED** (no authorized automatic MSP PID/filter write)
- F5: green software tests ≠ scientific QUAL feasibility fixed
- No personal paths, secrets, or raw `.BBL` files in the repository

## How cloud can run software tests

```bash
npm ci
npm run lint          # eslint + vue-tsc
npm run build
npx vitest run test/gyrocore
npx vitest run
npx playwright-core install chromium   # once per runner if needed
npm run test:browser                   # lease + worker
```

CI: Gyroflight workflows on this branch (typecheck/lint/test/build; browser-autotune when configured).

## What cloud will **not** have by default

| Asset | Effect |
|-------|--------|
| Private audit folders under `~/Gyroflight-audits/…` | Receipts not in git; use this handoff |
| Real AIR65 `.BBL` (Oct 18/19 and related) | `*.local.test.ts` **skip** unless `GYROFLIGHT_AIR65_BBL18` / `BBL19` (and related) are set outside the repo |
| GyroCore golden `GYROFLIGHT_AIR65_REF_DIR` | Some parity locals remain skipped |

`CLOUD_AIR65_EVIDENCE_AVAILABLE=NO` for a stock cloud clone.

## Out of scope for this sync

- No Grokbot auto-start, no merge, no release, no MSP/hardware, no threshold changes, no new development phase.
