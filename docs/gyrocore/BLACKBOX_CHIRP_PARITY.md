# Blackbox and CHIRP parity: Betaflight App vs GyroCore (migration WU1)

Can Betaflight's own browser stack (Blackbox Viewer parser, Autotune CHIRP parser, Autotune
analysis) replace GyroCore's browser decoder and CHIRP implementation without losing correctness?

**Short answer.**

- **Blackbox parsing:** yes. Betaflight's Blackbox Viewer parser is bit-exact with GyroCore's
  canonical decode on all three real AIR65 logs, and it handles mode and disarm events correctly.
- **CHIRP mathematics:** yes. Transfer function, magnitude, phase, coherence, sensitivity, step
  response, spectrogram and the gain recommendation are the same algorithm, equal to float64 noise.
- **Autotune's own log decoder:** no. `chirp_bbl_parser.ts` mis-decodes AVERAGE_2-predicted
  fields (gyro, debug, motors) after every I-frame but the first. Every AIR65 transfer function it
  produces is wrong.
- **Measurement qualification:** no. Betaflight Autotune has no quality gate. It recommends gains
  from every AIR65 segment, and GyroCore rejects every one of them.

GyroCore's qualification and safety layers therefore stay. GyroCore's decoder and duplicated
CHIRP mathematics do not.

## What was compared

| Item                    | Value                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Gyroflight branch       | `gyrocore/migration-log-chirp-parity`, from `fc304c2c`                                                                 |
| Betaflight App upstream | `d85e797e8674e3059cc3172e38df831e46a5250c` (fork base; `upstream/master` unchanged on 2026-10-09)                      |
| GyroCore reference      | `/home/sliksoft/GyroCore` at `d2e60f7` (read-only; not modified, not re-indexed)                                       |
| Firmware encoder        | betaflight/betaflight `src/main/blackbox/blackbox.c` on `master` (last changed in `fd0569d2`; read via the GitHub API) |
| Toolchain               | Node 24.21.0; GyroCore Python 3.12.3 / NumPy 1.26.4 for the reference outputs                                          |

The upstream CHIRP sources are **byte-identical** to the ones GyroCore qualified against
(betaflight-configurator `a38c4a79`): `chirp_bbl_parser.ts`, `spectral_analysis.ts`, `fft.ts`,
`datastream.js`, `decoders.js`, `useAutotune.ts`, `debugModes.ts` and the debug tables. Their sha256
match GyroCore's `upstream_reference.json` provenance.

### Fixtures

| Fixture                                                                            | sha256                                                                                       | Type                                                                   | Committed                                   |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------- |
| `BTFL_BLACKBOX_LOG_AIR65_C_20261005_224215_BETAFPVG473.BBL` (13,563,904 B, 3 logs) | `97245445111bbfead8e2f3864dac92e24e70986ef2dce82e0fbf8679bda7b072`                           | real flight, Betaflight 2026.6.2, debug_mode 96 (CHIRP), 4 kHz logging | **no** (private; untracked in GyroCore too) |
| `test/gyrocore/fixtures/decode/mode_events.bbl.gz`                                 | `ff9046947bbede89065090fc458e12fab9586e09b5194376c8fe6b2858427d66` (raw log `c38ba1ae…f797`) | synthetic, GyroCore                                                    | yes                                         |
| `test/gyrocore/fixtures/chirp/bbl/*.bbl.gz` (20 logs)                              | listed in `test/gyrocore/fixtures/PROVENANCE.md`                                             | synthetic WU7, GyroCore                                                | yes                                         |
| `test/gyrocore/fixtures/chirp/upstream_reference.json`                             | `7474a0be…4d8`                                                                               | upstream Autotune output at `a38c4a79` (GyroCore record)               | yes                                         |
| `test/gyrocore/fixtures/chirp/bbl_golden.json.gz`                                  | `96470953…e049`                                                                              | GyroCore `identify_chirp_system_from_bbl`                              | yes                                         |

All committed fixtures are synthetic and copied unchanged from GyroCore `d2e60f7`
(see `PROVENANCE.md`, which has the full hashes).

## Method

There is no new parser and no copy of upstream code. The tests drive the unmodified upstream
modules headlessly under Vitest.

| Test                                         | CI    | What it does                                                                                                                                                                               |
| -------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test/gyrocore/blackbox_mode_events.test.ts` | yes   | GyroCore's mode-event fixture through both Betaflight decoders                                                                                                                             |
| `test/gyrocore/chirp_parity.test.ts`         | yes   | (1) live Autotune reproduces GyroCore's recorded upstream output for the 20 WU7 logs exactly; (2) live Autotune vs GyroCore reference pipeline: extraction, numerics, accept/reject matrix |
| `test/gyrocore/chirp_parser_history.test.ts` | yes   | characterises the Autotune-parser I-frame bug on a firmware-encoded synthetic log                                                                                                          |
| `test/gyrocore/air65_blackbox.local.test.ts` | local | Blackbox Viewer and Autotune parsers on AIR65 vs GyroCore's patched native decode, row by row and column by column                                                                         |
| `test/gyrocore/air65_autotune.local.test.ts` | local | real `useAutotune().importAndAnalyze()` (only the file picker mocked), every segment, three comparisons (below)                                                                            |

The harness lives in `test/gyrocore/harness/`:

- `viewerDecode.ts`: `FlightLogParser.onFrameReady` raw frames plus the `FlightLog` view.
- `betaflightAutotune.ts`: per-segment Autotune using the exported upstream functions. The two private
  helpers from `useAutotune.ts` are mirrored verbatim, and the mirror is checked against the real
  composable.
- `chirpCompare.ts`, `nativeCsv.ts`, `bblWriter.ts` (firmware-format encoder for synthetic logs).

**GyroCore reference outputs** are written outside both repositories. For the AIR65 runs this
was the scratchpad; the GyroCore tree was confirmed unchanged afterwards.

```bash
REF=/some/scratch/dir; cp ~/GyroCore/BTFL_BLACKBOX_LOG_AIR65_C_*.BBL $REF/air65.bbl   # verify sha256
cd $REF
for i in 1 2 3; do blackbox_decode --stdout --unit-vbat raw --unit-amperage raw --unit-flags raw \
    --index $i air65.bbl > native_log$i.csv; done           # GyroCore-patched blackbox_decode
export TMPDIR=$REF PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=~/GyroCore:~/GyroCore/core
for i in 0 1 2; do python3 -B ~/GyroCore/tools/chirp_reference/make_browser_golden.py \
    --local air65.bbl --log-index $i --out $REF/golden_log$i.json.gz; done
python3 -B ~/GyroCore/tools/chirp_reference/diagnose_chirp.py air65.bbl > diagnose.json
# gc_recommend.json: recommend_autotune_from_bbl(air65.bbl, log_index=i) per log, plus
# recommend_gains() on the same transfer function with GyroCore's gates bypassed (parity only)

cd ~/Gyroflight
GYROFLIGHT_AIR65_BBL=$REF/air65.bbl GYROFLIGHT_AIR65_REF_DIR=$REF GYROFLIGHT_QUAL_OUT=$REF/report \
  NODE_OPTIONS=--max-old-space-size=8192 npx vitest run test/gyrocore/air65_*.local.test.ts
```

The local tests skip themselves when `GYROFLIGHT_AIR65_BBL` is unset, so CI never needs the
private log.

## Blackbox parser results

### AIR65, per embedded log

|                                                 | Log 1                       | Log 2                   | Log 3                     |
| ----------------------------------------------- | --------------------------- | ----------------------- | ------------------------- |
| Valid frames: Viewer parser (I + P)             | 51,669 (404 + 51,265)       | 36,657 (287 + 36,370)   | 246,358 (1,925 + 244,433) |
| `FlightLog` (what the Blackbox Viewer shows)    | 51,669                      | 36,657                  | 246,358                   |
| Autotune parser `totalFrames`                   | 51,669                      | 36,657                  | 246,358                   |
| GyroCore corrected count                        | 51,669                      | 36,657                  | 246,358                   |
| GyroCore patched native rows                    | 51,669                      | 36,657                  | 246,358                   |
| Corrupt / desync / invalid-delivered            | 0 / 0 / 0                   | 0 / 0 / 0               | 0 / 0 / 0                 |
| First / last time (µs)                          | 7,828,087 / 20,626,386      | 33,940,023 / 43,017,148 | 49,895,779 / 110,915,164  |
| Time or iteration resets                        | 0                           | 0                       | 0                         |
| Rows matched on (loopIteration, time) vs native | all; 0 extra on either side | all; 0 extra            | all; 0 extra              |
| Columns compared / bit-exact                    | 53 / 53                     | 53 / 53                 | 53 / 53                   |

The 53 columns are all 48 main fields (loopIteration, time, axisP/I/D/F, rcCommand[0–3],
setpoint[0–3], vbat, amperage, gyroADC, gyroUnfilt, accSmooth, debug[0–7], motor[0–3], eRPM[0–3])
and the 5 slow fields (flightModeFlags, stateFlags, failsafePhase, rxSignalReceived,
rxFlightChannelsValid). `energyCumulative` is excluded because blackbox_decode computes it rather
than decoding it. Maximum absolute error is **0** on every column. Timestamps match exactly, and
the sample rate both sides derive is identical (4 kHz from the headers; about 4032 Hz from the
timestamps).

Events (Viewer parser) are the same in every log: SYNC_BEEP, then FLIGHT_MODE CHIRP on
(flags 5→69, bit 6), then CHIRP off. In log 3 CHIRP switches on and off three times. Each log
ends with FLIGHT_MODE disarm (69→68), DISARM reason 4, and LOG_END. Payloads are read in full.

### Mode-event regression (Phase 3): **PASS, no change to Betaflight**

On GyroCore's `mode_events` fixture both Betaflight decoders behave correctly:

- **Blackbox Viewer parser:** keeps all 640 frames (iterations 0–639, no corrupt frames) across
  FLIGHT_MODE and DISARM events. Every payload is decoded: newFlags and lastFlags, reason, and the
  trailing DISARM(4). The unpatched native decoder lost 62 frames here (578 left).
- **Autotune parser:** with the same log marked CHIRP it reads 640 frames with 0 corrupt.

Both read FLIGHT_MODE as two unsigned VB values and DISARM as one
(`flightlog_parser.js:1750-1755`, `chirp_bbl_parser.ts:886-893`). The historical bug was in native
blackbox_decode only. Upstream's browser parsers never had it.

## CHIRP results

### Reproduction of the upstream record (CI)

For all 20 WU7 logs, live Gyroflight Autotune reproduces GyroCore's recording of upstream
`a38c4a79` **exactly**:

- log boundaries and sysConfig;
- sample, frame and corrupt counts;
- segments, and sha256 digests of the setpoint, gyro and debug arrays;
- sample rate and segment size;
- the full transfer function, sensitivity, step response and open loop;
- spectrogram rows and power sum;
- the two parser error messages.

This proves the harness drives the shipped code, and that nothing changed upstream between the two
commits.

### Extraction (Phase 4)

|                           | Betaflight                                                                     | GyroCore                                                   | Parity                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Log selection             | first log with any analysable segment (`tryParseLogs`)                         | every log, independently                                   | contract difference                                                                              |
| CHIRP detection           | `debug_mode` = CHIRP index (96 for API ≥ 1.48)                                 | same, plus checks on required fields                       | same verdicts on all 20 cases                                                                    |
| Axis                      | `debug[1]` (−1 = off, 0/1/2)                                                   | same                                                       | identical                                                                                        |
| Start/end                 | BOXCHIRP flag (bit 6 of S-frame `flightModeFlags`) and an axis change          | same                                                       | identical segments on all 20 cases and all 5 AIR65 segments                                      |
| Repeated axis             | last segment wins                                                              | last segment wins                                          | identical                                                                                        |
| Sample count, frame count | collects frames with debug[1] = −1 while BOXCHIRP is set                       | same                                                       | identical (e.g. 2005 / 2305 on `clean_single_axis`; 27,136 / 15,774 / 193,419 on AIR65)          |
| Sample rate               | header only: 1e6 / (looptime · pid_process_denom · P-denominator)              | header cross-checked against timestamps (5 % tolerance)    | same on 18/20 and AIR65 (4000 Hz); differs on `pnum_pdenom` and `malformed_missing_rate_headers` |
| Gaps/resets               | not detected: LOGGING_RESUME resets prediction only, no timestamps kept        | measures spacing; gates on gaps and non-uniformity         | quality-gate difference                                                                          |
| Frequency range reached   | not computed                                                                   | computed (AIR65: 3.0, 1.0, 60.1, 83.5 and 406.5 Hz of 600) | Betaflight lacks it                                                                              |
| Rejection                 | parse errors only; a segment shorter than one Welch window is dropped silently | 7 blocking gates (below)                                   | see judgment matrix                                                                              |
| **Decoded gyro values**   | **wrong after I-frames (bug, below)**                                          | correct                                                    | **BUG_IN_BETAFLIGHT**                                                                            |

### Numerical parity (Phase 5)

The mathematics is the same: symmetric Hann window, 50 % overlap, `H1 = Sxy/Sxx`,
`γ² = |Sxy|²/(Sxx·Syy)`, `S = 1 − T`, step response as IFFT then cumsum over 100 ms,
`recommendGains`. GyroCore's Python is a port of this code. Maximum differences, Betaflight vs
GyroCore, on the same samples:

| Quantity                        | 20 WU7 logs (CI tolerance)                                                                                     | AIR65, 5 segments, Viewer-decoded samples                                                                                | Classification                                                          |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Frequency bins                  | 0 (1e-9 Hz)                                                                                                    | 0                                                                                                                        | identical                                                               |
| Complex H, relative             | 5.7e-11 (1e-9)                                                                                                 | 1.6e-11                                                                                                                  | SAME_ALGORITHM_NUMERICAL_NOISE                                          |
| Magnitude                       | 2.3e-10 dB (1e-8)                                                                                              | 1.2e-10 dB                                                                                                               | SAME_ALGORITHM_NUMERICAL_NOISE                                          |
| Phase                           | 3.0e-9° (1e-6)                                                                                                 | 6.9e-10°                                                                                                                 | SAME_ALGORITHM_NUMERICAL_NOISE                                          |
| Coherence                       | 1.1e-12 (1e-10)                                                                                                | 6.4e-13                                                                                                                  | SAME_ALGORITHM_NUMERICAL_NOISE                                          |
| Sensitivity peak                | 1.3e-11 dB (1e-8)                                                                                              | 1.8e-15 dB                                                                                                               | SAME_ALGORITHM_NUMERICAL_NOISE                                          |
| Step response, metrics          | 3.7e-12, 1.5e-10 (1e-9)                                                                                        | 2.3e-13                                                                                                                  | SAME_ALGORITHM_NUMERICAL_NOISE                                          |
| Spectrogram                     | exact vs upstream record; GyroCore Python vs the same record 7.8e-14 dB (GyroCore `CHIRP_SYSTEM_ID_PARITY.md`) | not ported to the GyroCore browser                                                                                       | SAME_ALGORITHM_NUMERICAL_NOISE                                          |
| Proposed sliders                | n/a (WU7 has no recommendation golden)                                                                         | identical on all 5 segments                                                                                              | identical                                                               |
| `pnum_pdenom` frequency axis    | scaled by 666.7/1000 Hz, all else identical                                                                    | —                                                                                                                        | CONTRACT_DIFFERENCE (legacy `P interval:2/3`; GyroCore uses timestamps) |
| **Shipped Betaflight on AIR65** | —                                                                                                              | magnitude up to **41 dB**, phase 180°, coherence 0.85 apart; up to **5.8 dB / 0.28** in GyroCore-usable bins; sliders ±1 | **BUG_IN_BETAFLIGHT** (decoder, below)                                  |

### The Autotune parser bug (BUG_IN_BETAFLIGHT)

`src/js/blackbox/chirp_bbl_parser.ts:1237` (`handleIFrame`) does `state.previous2 = state.previous`.
That keeps the last P-frame as the "previous-previous" frame after an I-frame. The firmware encoder
sets both history slots to the I-frame:

- firmware `blackbox.c:822-825`: "since we have no other history, we also use it for the 'before,
  before' state";
- the Viewer parser does the same (`flightlog_parser.js:1280-1282`);
- so does blackbox-tools (`parser.c:1149-1151`).

Every AVERAGE_2- or STRAIGHT_LINE-predicted field is therefore decoded wrongly from the first
P-frame after each I-frame except the first one, until the next I-frame. In real logs these are
gyroADC, gyroUnfilt, accSmooth, debug[0–7], motor[0–3] (P predictor 3) and time (P predictor 2).
Setpoint (predictor 1) is unaffected. WU7's synthetic logs use predictor 1 for gyro, which is why
GyroCore's earlier comparison missed it.

On AIR65 the Autotune parser's gyro differs from the canonical decode in:

- log 1: 10,442 / 5,403 / 7,268 of 27,136 samples (max 9 °/s);
- log 2: 3,389 / 10,277 / 2,589 of 15,774 (max 49, 43, 78);
- log 3: 29,076 / 22,848 / 17,801 of 193,419 (max 19).

The first wrong sample is always at iteration ≡ 1 mod 128 (I interval 128). Fed the correctly
decoded samples, Betaflight's own spectral code matches GyroCore to 1e-10 dB, so the bug fully
explains the real-data divergence.

The bug is pinned by `chirp_parser_history.test.ts` (CI). That test will fail, and say so, once
upstream fixes it. `upstream/master` still had the bug on 2026-10-09. **Gyroflight has not patched
it**: this WU qualifies upstream as it is (see "Next migration").

## Real AIR65 qualification (Phase 6)

Betaflight's output comes from the real `importAndAnalyze()`.

| Segment     | Captured            | Sweep reached | Betaflight Autotune                                                                                                                                                                                                              | GyroCore                                                               |
| ----------- | ------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Log 1 roll  | 6.78 s of 20 (34 %) | 3.0 Hz        | **shown to the user** (first log). Proposes PI 100→50, I 80→40, FF 15→25, D-term filter 100→50; mean coherence 35 %; notes "cannot reach 60° (limit about 41°)" and "no gain keeps peak sensitivity inside the robustness bound" | rejected: `low_coherence` (0.354 < 0.6)                                |
| Log 2 pitch | 3.94 s (20 %)       | 1.0 Hz        | recommends PI 71, I 48, FF 25, filter 50 (only reachable if this log is the first log analysed); shows phase margin **373.5°**                                                                                                   | rejected: `low_coherence` (0.409)                                      |
| Log 3 yaw   | 14.25 s (71 %)      | 60.1 Hz       | recommends PI 71, I 80, FF 25, filter 50; **no warning**                                                                                                                                                                         | rejected: `low_coherence` (0.534)                                      |
| Log 3 roll  | 15.08 s (75 %)      | 83.5 Hz       | recommends PI 71, I 80, FF 25, filter 50; **no warning**                                                                                                                                                                         | rejected: `low_coherence` (0.590, just below 0.6)                      |
| Log 3 pitch | 19.03 s (94 %)      | 406.5 Hz      | recommends PI 55, I 80, FF 25, filter 50; **no warning**                                                                                                                                                                         | rejected: `low_coherence` (0.169), `unusable_frequency_range` (5 bins) |

(Sliders are shown as current→proposed. The current values are pi_gain 100, i_gain 80,
feedforward 15, dterm_filter_multiplier 100, master 125.)

**Betaflight's judgment.** It accepts all five measurements. It has no coherence, sweep-completeness,
saturation, excitation or gap check. Its notes are about control margins, not about whether the
measurement can be trusted. For log 3 it raises none at all. The Apply button is enabled whenever
an FC is connected, behind a generic confirmation dialog.

**GyroCore's judgment.** It rejects all five on low coherence. `recommend_autotune_from_bbl` returns
BLOCKED on every axis and adds a second reason: `simplified_pids_mode_off`.

- The AIR65 logs record `simplified_pids_mode:0`. Firmware 2026.6.2 does not recompute PIDs from
  sliders in that mode (`simplified_tuning.c:97-101`).
- It _does_ apply the D-term filter multiplier, because `simplified_dterm_filter:1`
  (`simplified_tuning.c:104-109`).
- So Betaflight's Apply would leave the PIDs it recommends changing untouched, and would halve the
  D-term filter cutoffs.

The earlier GyroCore diagnosis (`docs/upstream/CHIRP_REAL_FLIGHT_AIR65.md`) was reproduced from the
data, not assumed. The per-segment durations, sweep end points and coherence above are this run's
values.

**WOULD BETAFLIGHT ACCEPT A MEASUREMENT GYROCORE CONSIDERS UNSAFE? Yes, all five on AIR65.** On the
synthetic set it also accepts `poor_coherence`, `weak_excitation`, `dropped_timestamps` and
`pnum_pdenom`, which GyroCore rejects.

**WOULD IT REJECT ONE GYROCORE CONSIDERS USABLE? Yes, one:** `malformed_missing_rate_headers`.
Betaflight assumes 8 kHz, so its Welch window is longer than the data and it silently drops the
segment ("No chirp data found"). This fails safe.

Synthetic accept/reject matrix, as asserted in CI:

|                            | GyroCore usable                                                                                                                                                                                                                     | GyroCore rejects                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Betaflight recommends      | 12 (`clean_single_axis`, `known_gain`, `known_phase_delay`, `low_noise`, `noisy`, `log_rate_below_pid`, `high_resolution`, `chirp_at_log_end`, `chirp_near_nyquist`, `corrupt_axis_frames`, `repeated_axis`, `three_axis_sequence`) | **4** (`poor_coherence`, `weak_excitation`, `dropped_timestamps`, `pnum_pdenom`)          |
| Betaflight gives no result | 1 (`malformed_missing_rate_headers`)                                                                                                                                                                                                | 3 (`insufficient_samples`, `malformed_wrong_debug_mode`, `malformed_missing_debug_field`) |

**SAFETY_SIGNIFICANT_DIFFERENCE = YES.**

## Gain recommendation (Phase 7)

Betaflight never marks a measurement invalid, so the comparison was run on every AIR65 segment.
GyroCore's `autotune/recommend.py` is a port of upstream `recommendGains`. With GyroCore's gates
bypassed (parity only), it proposes **exactly** the sliders Betaflight proposes from the same
correctly decoded samples, on all 5 segments. From its own mis-decoded samples, shipped Betaflight
differs by ±1 slider point on 3 of 5 segments.

GyroCore with its gates in place proposes nothing for AIR65. No FC writes were made and Apply Gains
was not enabled or exercised.

| Old GyroCore tuning logic                                                                                | Classification                          | Evidence                                                                                                  |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `autotune/recommend.py` (recommendGains port), `chirp/system_id.py`, browser `src/chirp/systemId.ts`     | **REPLACE_WITH_BETAFLIGHT**             | identical outputs (above)                                                                                 |
| CHIRP quality gates (`chirp/quality.py` / `src/chirp/quality.ts`)                                        | **KEEP_UNIQUE_SAFETY_LOGIC**            | the only thing that rejects AIR65 and the four synthetic unsafe cases                                     |
| Sample-rate resolution with timestamp cross-check (`sample_rate.py` / `sampleRate.ts`)                   | **KEEP_UNIQUE_SAFETY_LOGIC**            | `pnum_pdenom`, `malformed_missing_rate_headers`                                                           |
| Current-tune gates (`simplified_pids_mode_off`, yaw not under slider control, …) in `autotune/engine.py` | **KEEP_UNIQUE_SAFETY_LOGIC**            | AIR65: Betaflight's proposal would not reach the PIDs it changes                                          |
| Global-slider merge (`autotune/merge.py`, `MERGE_REQUIRES_REVIEW`)                                       | **KEEP_UNIQUE_SAFETY_LOGIC**            | AIR65 log 3 proposes PI 71 / 71 / 55 on three axes; Betaflight applies one chosen axis's sliders globally |
| Diagnosis (`diagnose_chirp.py`: completion %, sweep reached, end cause, saturation, coherence by band)   | **KEEP_UNIQUE_SAFETY_LOGIC** (evidence) | Betaflight computes none of it                                                                            |
| Safety pipeline (`safety/`: clamps, mechanical, thermal, fault, output)                                  | **NEEDS_FURTHER_EVIDENCE**              | not exercised here: no Betaflight-accepted measurement was also GyroCore-usable on real data              |
| Legacy AeroTuner tuner, frozen goldens                                                                   | **KEEP_AS_REFERENCE**                   | not a CHIRP tuner; unchanged policy (TUNING_ARCHITECTURE.md)                                              |

## Authority going forward

| Capability              | Betaflight current                                                 | GyroCore old                               | Parity                                                    | Authoritative going forward                                 | Action                                                                  |
| ----------------------- | ------------------------------------------------------------------ | ------------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| BBL parsing             | Viewer `FlightLogParser`                                           | vendored Viewer parser plus patched native | bit-exact, 334,684 frames × 53 columns                    | **Betaflight Viewer parser**                                | retire GyroCore's browser decoder; keep native only as a reference tool |
| Embedded-log selection  | Viewer: all logs; Autotune: first log with a result                | every log                                  | Viewer equal; Autotune contract differs                   | Betaflight Viewer index; GyroCore chooses the log for CHIRP | GyroCore layer evaluates every log                                      |
| Event parsing           | full payloads, both parsers                                        | full payloads                              | equal                                                     | **Betaflight**                                              | none                                                                    |
| Decoded field access    | Viewer: exact; Autotune parser: **wrong** for predictor 2/3 fields | exact                                      | Viewer equal; Autotune parser BUG                         | **Betaflight Viewer parser**                                | feed CHIRP from Viewer frames; fix or bypass `chirp_bbl_parser`         |
| Effective sample rate   | header only                                                        | header plus timestamp cross-check          | equal on modern logs; differs on legacy / missing headers | **GyroCore** (check) over Betaflight (value)                | keep GyroCore sample-rate check as a layer                              |
| CHIRP segment detection | BOXCHIRP + debug[1]                                                | same                                       | identical                                                 | **Betaflight**                                              | none                                                                    |
| CHIRP quality gate      | none                                                               | 7 gates                                    | n/a                                                       | **GyroCore**                                                | migrate `quality.ts` as a gate on Autotune results                      |
| Transfer function       | Welch H1                                                           | same                                       | 1e-10                                                     | **Betaflight**                                              | delete GyroCore copy at migration                                       |
| Magnitude               | dB                                                                 | same                                       | 1e-10 dB                                                  | **Betaflight**                                              | —                                                                       |
| Phase                   | wrapped degrees                                                    | same                                       | 1e-9°                                                     | **Betaflight**                                              | —                                                                       |
| Coherence               | γ²                                                                 | same                                       | 1e-12                                                     | **Betaflight**                                              | —                                                                       |
| Sensitivity             | S = 1 − T                                                          | same                                       | 1e-11 dB                                                  | **Betaflight**                                              | —                                                                       |
| Step response           | IFFT-cumsum                                                        | same                                       | 1e-10                                                     | **Betaflight**                                              | —                                                                       |
| Spectrogram             | Hann 256 / 0.75                                                    | Python only                                | 1e-13 dB                                                  | **Betaflight**                                              | —                                                                       |
| Gain recommendation     | `recommendGains`                                                   | port                                       | identical sliders                                         | **Betaflight**, behind GyroCore gates                       | GyroCore Safety must allow it first                                     |

## Differences that matter for safety

1. **No measurement-quality gate in Betaflight Autotune.** It recommends, and allows applying, gains
   from incomplete, incoherent or gapped CHIRP data: all five AIR65 segments, plus four synthetic
   unsafe cases. GyroCore rejects all of them.
2. **Autotune decoder bug.** Gyro data feeding every real-log transfer function is corrupted after
   each I-frame. Its effect on AIR65 sliders is small (±1), but the Bode and coherence plots the user
   sees are wrong (up to 41 dB, and 5.8 dB in usable bins).
3. **Slider mode not checked.** Betaflight proposes and applies slider changes when
   `simplified_pids_mode` is OFF. The PIDs it means to change are not changed, and the D-term filter
   change is applied.
4. **Only the first log with chirp data is analysed**, and a later same-axis segment overwrites an
   earlier one. The user cannot see that log 3 exists or what it shows.
5. **Implausible figures are displayed as results**, for example a 373.5° phase margin (log 2 pitch).

## Next migration

1. **Gyroflight migration WU2: CHIRP qualification layer.**
    - Run GyroCore's quality gates, sample-rate check, diagnosis and current-tune gates as
      `src/gyrocore/` code on Autotune results.
    - Use Viewer-parser samples for this, not `chirp_bbl_parser`.
    - Surface the verdict in the Autotune view, and block Apply Gains while the verdict is not
      usable. That block is the one upstream-file hook needed.
    - Port the gates' TypeScript (`src/chirp/quality.ts`, `sampleRate.ts`, the relevant parts of
      `sysconfig.ts`) with their goldens. Do not port the duplicated mathematics.
2. **The Autotune-parser history bug.** Fix it with a one-line change in `handleIFrame` (the I-frame
   becomes `previous2` too). Either wait for upstream, or carry it as a recorded Gyroflight patch;
   this is the user's decision. Either way, `chirp_parser_history.test.ts` flips when it is fixed.
   No upstream PR may be filed from this fork.
3. Then retire GyroCore's browser decoder and CHIRP mathematics (React app) in favour of Betaflight's,
   and move the global-slider merge and the Safety pipeline in behind the gate.
