# Autotune engine v2: architecture and implementation plan

Status: **plan only**, written on `feat/gyroflight-autotune-engine-v2` from `gyroflight/main` `c67f92b1`. No tuning
algorithm, no new MSP code and no firmware change is part of this document.

Goal: Gyroflight computes absolute PID, feedforward and filter settings (gyro / D-term LPF, RPM filter, dynamic
notch) for a stock Betaflight flight controller from blackbox logs, shows them against the current settings, and
writes them only when the user clicks Apply. Everything is verified by read-back and can be restored.

Fixed constraints:

- web app / PWA only;
- the user always clicks Apply; no automatic configuration changes, no automatic test flights;
- reuse Betaflight and Gyroflight code;
- no desktop architecture and no firmware changes;
- no value is presented as validated without the evidence that validates it.

## 1. Baseline (what exists on `gyroflight/main`)

| Area              | Exists                                                                                                                                                                                          | Limit                                                                                                                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Write route       | `src/composables/useTuneApply.ts`: release gates, confirmation token bound to a read-only preview, FC identity vs log, backup, firmware-calculated verify, EEPROM only on a full match, Restore | writes only the six simplified-tuning sliders (`MSP_SET_SIMPLIFIED_TUNING`); Restore already writes `MSP_SET_PID` / `MSP_SET_PID_ADVANCED`   |
| Snapshot / backup | `tuning/tuneSnapshot.ts`, `stores/tuneBackup.ts`                                                                                                                                                | sliders, 8 LPF Hz, PIDs, FF and d_max only; no notch, RPM or dyn-notch keys                                                                  |
| Absolute tune     | `safety/absolute.ts` `extractAbsoluteTune` (header values with provenance), `absoluteTuneToConfig`, `validityFor`, `valuesWithinFirmware`, `DEFAULT_MAX_DELTA`                                  | `proposeAbsoluteTune` maps sliders only; no notch / RPM fields                                                                               |
| Safety            | `safety/pipeline.ts`                                                                                                                                                                            | blocks every tune with `missing_required_analysis`; evidence stages not ported (GyroCore's are unstable, see `SAFETY_ENGINE.md`)             |
| Plant / what-if   | `betaflight_open_loop.ts` `extractPlantFromClosedLoop`, `plantFixedWhatIf` (P/I/D only), `evaluateStructureAwarePhaseMargin`                                                                    | PM `NOT_VALIDATED` while `AIR65_EXTERNAL_BLOCKERS` (dyn-notch centres, RPM schedule) apply; `INDEPENDENT_GAIN_CHANGE_VALIDATION = "BLOCKED"` |
| Controller model  | `betaflight_digital_controller.ts` (PT1 gyro / D-term LPF, yaw-P LPF), `betaflight_dterm_dynamic.ts` (throttle-scheduled D LPF1, D_max, TPA)                                                    | no notches, no RPM filter, no dyn notch, no dynamic gyro LPF                                                                                 |
| Flight metrics    | `flight_metrics_analysis.ts` (M4 / M4.2): FF tracking, D effectiveness, segmented Welch spectrum, eRPM fundamental                                                                              | `optimalFeedforward: null`; filter advice `measurement_only` / `blocked`                                                                     |
| Sessions          | `gyrocore/session/*` (IndexedDB Tune Sessions), `compare/*` (A/B selection, cross-flight comparison)                                                                                            | explicitly "not a Verified Tune"                                                                                                             |
| Simulated FC      | `test/gyrocore/harness/mspCraft.ts`                                                                                                                                                             | no `MSP_FILTER_CONFIG` / `MSP_SET_FILTER_CONFIG` / `MSP_ADVANCED_CONFIG`; `SET_PID_ADVANCED` not decoded                                     |

### MSP facts the plan relies on (checked in `MSPHelper.ts` and the 2026.6.2 firmware)

- Absolute values travel in three read/write pairs: `MSP_PID` / `MSP_SET_PID` (P, I, D per row),
  `MSP_PID_ADVANCED` / `MSP_SET_PID_ADVANCED` (FF per axis, d_max, D_max gain/advance, TPA, iterm relax, FF
  smoothing/boost/jitter, anti-gravity, …), and `MSP_FILTER_CONFIG` / `MSP_SET_FILTER_CONFIG` (gyro / D-term LPF types
  and Hz, dynamic LPF min/max and expo, static notches, **dyn notch count / Q / min / max**, **RPM harmonics / min Hz,
  and from API 1.48 fade range / Q / weights**).
- The layouts are symmetric enough to write a fresh read back. Exceptions: the legacy U8 `dterm_setpoint_weight`
  slot is clamped to 254; `absoluteControlGain` is written as 0 on API ≥ 1.48; the RPM fade / Q / weights block is
  read when bytes remain but written only on API ≥ 1.48.
- `MSP_SET_ADVANCED_CONFIG` truncates `motorIdle` (`push16(motorIdle*100)` without rounding, `mspBytes.ts:39`):
  v2 must not round-trip `ADVANCED_CONFIG`, and does not need to.
- Firmware `applySimplifiedTuning` runs only on `MSP_SET_SIMPLIFIED_TUNING`, the CMS and the CLI command, never at
  boot (`msp.c:3912`, `cms_menu_imu.c:330`, `cli.c:3821`). With the modes off it applies nothing
  (`simplified_tuning.c:99/106`).
- Upstream's PID tab writes `SET_PID`, `SET_PID_ADVANCED`, `SET_RC_TUNING`, `SET_FILTER_CONFIG`, then
  `SET_SIMPLIFIED_TUNING` last, so sliders that are still on recompute what was just written. An absolute write
  must therefore switch the slider modes off **first** and must not send them on again.

## 2. Architecture

```
BBL(s) ──► analysis (existing: qualification, M3 plant, M4/M4.2, M5-B; new: notch-aware model, FF, filters)
          │
          ▼
   TuneProposal v2 (absolute values per field, each with evidence, uncertainty, status)
          │  gates: per-field validity · firmware limits · max-delta · Safety evidence · PM · independent validation
          ▼
   Compare (current FC values ↔ proposed, per axis / filter, with the reasons)
          │  user: "Review and apply…"
          ▼
   Preview (read-only: identity, live values, expected after write) ──► confirmation token (bound to preview hash)
          │
          ▼
   Write route v2 (useTuneApply): backup ► sliders off ► SET_PID ► SET_PID_ADVANCED ► SET_FILTER_CONFIG
                                  ► read back all three ► exact match ► EEPROM ► Verify / Restore
```

Principles:

- **One change set, two kinds.** `TuneChangeSet = { kind: "sliders", … } | { kind: "absolute", fields }`. The
  existing slider route stays as it is; the absolute route reuses identity, preview, token, backup, verify, EEPROM
  and Restore.
- **Expected values for absolute writes are the written values themselves.** No firmware calculation is involved.
  Verification compares the read-back of `PID`, `PID_ADVANCED` and `FILTER_CONFIG` field by field, including every
  field the change set does not touch, which must equal the backup.
- **Proposals carry provenance.** Each proposed field records which analysis produced it, its measured basis, its
  uncertainty and its status (`VALIDATED | PARTIAL | BLOCKED`). The release procedure reads these.

## 3. Workstreams

Each workstream lists what to build, where, how it is tested, and what must hold before it is used for a real
write. "Flight" means a blackbox log the user records; Gyroflight never triggers one.

### V2-A. Absolute tune snapshot and MSP layer (no algorithm)

- Extend `TuneSnapshot` with every field the absolute route can change: the full `advancedTuning` subset (FF per
  axis, d_max, D_max gain/advance, TPA mode/rate/breakpoint, iterm relax, FF smoothing/boost/jitter/max-rate,
  anti-gravity) and `filterConfig` (LPF types and Hz, dyn LPF, static notches, dyn notch, RPM fields).
- `readAbsoluteSnapshot()`: fresh `MSP_PID`, `MSP_PID_ADVANCED`, `MSP_FILTER_CONFIG` through `readOk` (no reply, CRC
  error or refusal blocks).
- `writeAbsolute(changeSet)` in `useTuneApply.ts`:
    1. backup;
    2. if any slider mode is on: `MSP_SET_SIMPLIFIED_TUNING` with `slider_pids_mode`, `slider_dterm_filter` and
       `slider_gyro_filter` at 0, read back to confirm;
    3. `SET_PID`, then `SET_PID_ADVANCED` and `SET_FILTER_CONFIG`, each built from a fresh read with only the proposed
       fields replaced;
    4. read back all three and compare everything;
    5. EEPROM only on a full match.
- Restore gains `FILTER_CONFIG` and the slider modes (today it restores sliders, PIDs and FF/d_max only).
- New confirmation subject `{ kind: "absolute", fields, preview }`; Compare and preview generalised from sliders to fields.
- Harness: `mspCraft` gains `FILTER_CONFIG` / `SET_FILTER_CONFIG` (decoded payloads, API-gated RPM block),
  decoded `SET_PID_ADVANCED`, and slider-off semantics; new fault cases: firmware rejects a field (clamps it), partial
  write between the three SETs, API 1.47 vs 1.48 layouts.
- Tests: exact payloads, round-trip of an unchanged read, every fault path, mutations as for v1.
- **Before real use:** read-only hardware check (V2-H step 1) shows a fresh read written back as-is reads back
  identical on the user's FC (on a write-free dry run, the comparison is done on the encoded payload).

### V2-B. Safety evidence for absolute proposals

- Define a Gyroflight analysis-evidence contract from measurements Gyroflight already qualifies (M4.2 spectrum
  reliability, noise floor, peak prominence, motor saturation counts, CHIRP Quality V2, coherence), requiring every
  field and blocking when one is missing (`SAFETY_ENGINE.md`: no fail-open defaults).
- Port the GyroCore evidence stages only where their inputs are qualified; keep `missing_required_analysis` otherwise.
- Reuse `valuesWithinFirmware`, `DEFAULT_MAX_DELTA` / `scaleMaxDelta` for every absolute field (filters included).
- Stability tests: the evidence must not flip under row removal / segment changes (GyroCore's resonance and noise
  fields did).
- **Before real use:** evidence is stable on the AIR65 logs and on synthetic perturbations; `analysisEvidence` becomes
  `"available"` only through this contract.

### V2-C. Notch-aware controller model and phase-margin validation

- Extend the M1 model with the filters that today keep PM `NOT_VALIDATED`:
    - **RPM notches:** per motor and harmonic, centred on the logged `eRPM[0-3]` (times `motor_poles` / 2), with the
      logged harmonics, min Hz, Q, fade and weights (headers `rpm_filter_*` / `gyro_rpm_notch_*`, already parsed by the
      Viewer);
    - **dynamic notch:** centres from a `debug_mode = FFT_FREQ` log (debug channels are notch centres), count / Q / min
      / max from the header;
    - **dynamic gyro LPF1:** throttle-scheduled like the D-term path in `betaflight_dterm_dynamic.ts`;
    - time-varying filters enter the loop as an LTI stand-in per sweep window (median centres, spread reported), as
      M5-B does for the D-term LPF.
- Validate the extended model the way M5-B validated the D path: simulate `gyroUnfilt → gyroADC` with the logged
  schedule and compare with the logged `gyroADC` (M5-A measured 2.0–2.4 ms extra delay that the current model misses).
- `evaluateStructureAwarePhaseMargin`: drop an external blocker only when its filter is modelled **and** validated for
  that flight. Attestation (`attestValidated`) comes from V2-E, never from the model alone.
- Robustness: report gain margin, |S| peak and delay margin next to PM, with bands from log-to-log reproducibility.
- **Flights:** one `FFT_FREQ` flight (hover / cruise), eRPM logged (bidirectional DShot).

### V2-D. Absolute PID calculation

- A constrained search over absolute P, I, D (and d_max) per axis on the identified plant `G` (M3), scoring targets
  such as PM ≥ target, |S| peak ≤ limit and bandwidth, using the V2-C model. `plantFixedWhatIf` already predicts `T`
  for a candidate.
- Limits: plant validity band (roll ≤ 51 Hz, pitch ≤ 37 Hz, yaw ≤ 88 Hz on AIR65); no candidate whose crossover is
  outside the coherent band; max-delta per step.
- Output: a proposal with predicted `T`, PM and |S| and their uncertainty. Status stays `BLOCKED` until V2-E has
  validated the prediction model on this craft.
- **No algorithm is written in this phase.**

### V2-E. Independent validation of PID predictions ("Verified Tune")

- Protocol, using the existing Tune Session and cross-flight comparison:
    1. baseline CHIRP flight;
    2. Gyroflight predicts `T` for a candidate (V2-D);
    3. the user applies the candidate;
    4. CHIRP flight with the candidate **plus a baseline repeat in the same session**, same battery state band;
    5. compare predicted against measured `T` inside the reproducibility bands (M5-A: < 20 Hz within ±0.12 dB; 20–40 Hz
       wider);
    6. store a `VerifiedTune` record (hashes of logs, prediction, comparison) in the session.
- That record is the producer the release procedure waits for (`independent_pid_validation_missing`).
- A detectability check first (M5-A §3.3): a candidate whose predicted change is not resolvable above
  log-to-log scatter cannot validate anything.
- **Flights:** baseline + candidate + baseline repeat (after the protocol-B safety review).

### V2-F. Feedforward optimisation

- Input: CHIRP-free acro stick segments (M4.2 segmentation, ≥ 3 s), optional `debug_mode = FEEDFORWARD`.
- Metric: per-axis setpoint → gyro latency, overshoot and tracking error (M4 `analyzeAxisTracking`), against FF weight.
- Proposal: FF weight (and smoothing / boost only if measured) that reduces latency without overshoot; status
  `PARTIAL` until an A/B flight confirms it.
- **Flights:** acro stick flight (rolls, flips, steps), then an A/B flight with the proposal.

### V2-G. Gyro / D-term filter, RPM and dynamic-notch optimisation

- Gyro and D-term LPF: noise spectrum before and after the filters (`gyroUnfilt` and `gyroADC`, not only `gyroADC` as
  in M4.2) against the phase-delay budget from V2-C; the D path from M5-B.
- RPM filter: compare `gyroUnfilt` peaks with eRPM harmonics (count, min Hz, Q, weights).
- Dynamic notch: residual peaks after RPM against notch count / Q / min / max (from the `FFT_FREQ` flight).
- Every filter proposal carries its delay cost and the PM effect from V2-C; none is applied without V2-B evidence.
- **Flights:** `FFT_FREQ` flight (shared with V2-C), a normal flight logging `gyroUnfilt` and eRPM.

### V2-H. Backup, Apply, Verify and Restore on a real FC (hardware acceptance, user-started)

Each step needs the user's explicit go; none changes configuration until step 3.

1. **Read-only:** connect, run the preview (v1 slider route and V2-A absolute read), check identity, check that
   `MSP_CALCULATE_SIMPLIFIED_*` equals what the FC holds for unchanged sliders, and check an unchanged absolute read
   encodes back to identical payloads.
2. **Backup only:** take and download a backup; compare it with the CLI `diff all` the user takes with upstream.
3. **No-op write:** write the unchanged values through each route; read back, verify, EEPROM; confirm nothing changed.
4. **One small change** (e.g. one D-term LPF Hz step) and **Restore** right after, with the props off.
5. Only after V2-B / V2-C / V2-E: a real proposal.

## 4. Order and milestones

| Milestone | Content                                                            | Needs flights                    | Unblocks                             |
| --------- | ------------------------------------------------------------------ | -------------------------------- | ------------------------------------ |
| V2-M0     | This plan, reviewed                                                | no                               | everything                           |
| V2-M1     | V2-A snapshot + absolute write route + harness (software only)     | no                               | absolute Compare / Apply plumbing    |
| V2-M2     | V2-H steps 1–3 on the user's FC                                    | no (bench, props off)            | trust in the write route             |
| V2-M3     | V2-C model: RPM + dyn notch + dyn gyro LPF, validated against logs | `FFT_FREQ` flight                | PM validation path                   |
| V2-M4     | V2-B evidence contract + stability tests                           | existing logs                    | Safety `analysisEvidence`            |
| V2-M5     | V2-D PID search (proposal only)                                    | no                               | V2-E                                 |
| V2-M6     | V2-E Verified Tune protocol + record                               | candidate + baseline repeat      | `independent_pid_validation_missing` |
| V2-M7     | V2-F FF, V2-G filters (proposals)                                  | acro stick, `gyroUnfilt` flights | FF / filter proposals                |
| V2-M8     | V2-H steps 4–5                                                     | after M3/M4/M6                   | first real absolute Apply            |

## 5. Risks and open questions

- Fast-math firmware builds: `MSP_CALCULATE_SIMPLIFIED_*` vs actual (`SAFETY_ENGINE.md`); the absolute route avoids
  this by verifying written values directly.
- The AIR65 currently logs with simplified PIDs **off** and in ANGLE mode: the v1 slider route cannot tune it;
  the absolute route can, but FF and D effectiveness need acro data.
- Time-varying filters (RPM, dyn notch, dyn LPF) are approximated as LTI per sweep; the spread must stay small or the
  PM stays unvalidated.
- Plant validity ends at 37–88 Hz on AIR65; crossovers near that edge cannot be validated.
- API differences (1.44–1.49) in `PID_ADVANCED` and `FILTER_CONFIG`; the harness must cover at least 1.47 and 1.48.

## 6. Out of scope

No firmware changes, no new MSP messages, no desktop shell, no automatic flights or writes, no use of upstream's
`ADVANCED_CONFIG` round-trip, and no claim of validation from simulation alone.
