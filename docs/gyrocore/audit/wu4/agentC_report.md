# Agent C — Betaflight firmware + app simplified-tuning audit (READ-ONLY)

Scratch: `/tmp/claude-1000/-home-sliksoft-GyroCore/65e2f2cc-86d2-47a5-94f2-8e96a4ead677/scratchpad/agentC_1791555744/`
(`fw_src/` = firmware sources at pinned SHA + SHA256SUMS; `h/` = harnesses, disassembly, sweep output; `bf_matrix.json`).
No repo file was modified; no git writes.

## 0. Pinned revisions

| Item | Value |
|---|---|
| Betaflight firmware `master` (git ls-remote, 2026-10-09) | `4fc1520c5a5decddc8ef07ad57c0e766ea8747ba` |
| App upstream | `https://github.com/betaflight/betaflight-configurator.git` (remote `upstream` of /home/sliksoft/Gyroflight; origin = git@github.com:sliksoft/gyroflight.git) |
| Upstream app `master` (ls-remote) | `d85e797e8674e3059cc3172e38df831e46a5250c` |
| Fork local `master` | `d85e797e...` — **equals current upstream master** ("chore(gitignore): also ignore a node_modules symlink (#5636)", 2026-10-06) |
| Fork audited branch | `gyroflight/wu4-safety` @ `1e4dc1ee233be5870ed6830a979fe5bdc28653b4` |

Line refs below are at firmware SHA 4fc1520c (files in `fw_src/`). Note: app files are `.ts` (`src/js/msp/MSPHelper.ts`, `src/js/fc.ts`, `src/stores/fc.ts`), not `.js`.

## 1. Slider -> PID formula (firmware)

`src/main/config/simplified_tuning.c:31-63` (`calculateNewPidValues`), called only via `applySimplifiedTuningPids` (:97-102) when `simplified_pids_mode != OFF`.

```
masterMultiplier = master/100.0f; piGain = pi/100.0f; dGain = d/100.0f; ffGain = ff/100.0f; iGain = i/100.0f   (:42-46)
for axis = ROLL .. simplified_pids_mode:                         (:48)  RP(1)=roll,pitch; RPY(2)=+yaw
  pitchDGain  = axis==PITCH ? simplified_roll_pitch_ratio/100.0f : 1   (:49)  [CLI name simplified_pitch_d_gain]
  pitchPiGain = axis==PITCH ? simplified_pitch_pi_gain/100.0f   : 1   (:50)
  P = constrain(Pdef*master*pi*pitchPi,               0, 250)          (:51)
  I = constrain(Idef*master*pi*i*pitchPi,             0, 250)          (:52)
  D = constrain(Ddef*master*d*pitchD,                 0, 250)          (:53)
  F = constrain(Fdef*master*pitchPi*ff,               0, 1000)         (:54)
  dMaxGain = dMaxDef>0 ? g + (1-g)*Ddef/dMaxDef : 1   (g = d_max_gain/100.0f)  (:57-59)
  d_max = constrain(dMaxDef*master*d*pitchD*dMaxGain, 0, 250)          (:60)
```
- `constrain(int,int,int)` (`common/maths.h:175`) — the float argument is implicitly converted to int, i.e. **truncated toward zero**, then clamped.
- Constants (`flight/pid.h`): `PID_GAIN_MAX 250` (:42), `F_GAIN_MAX 1000` (:43), `PID_ROLL_DEFAULT {45,80,30,120,0}` (:64), `PID_PITCH_DEFAULT {47,84,34,125,0}` (:65), `PID_YAW_DEFAULT {45,80,0,120,0}` (:66) (fields P,I,D,F,S; `pidf_t` :145-151 P/I/D uint8, F uint16), `D_MAX_DEFAULT {40,46,0}` (:67).
- Profile defaults (`flight/pid.c` resetPidProfile :130+): pid[] = the defaults above (:133-141), `d_max = D_MAX_DEFAULT` (:193), `d_max_gain 0` (:194), `d_max_advance 35` (:195), `feedforward_transition 0` (:151), `simplified_pids_mode = RPY` (:212), all simplified PID sliders = 100 (:213-220), `simplified_dterm_filter = true`, multiplier 100 (:221-222).
- Slider constants (`config/simplified_tuning.h`): `SIMPLIFIED_TUNING_PIDS_MIN 0`, `SIMPLIFIED_TUNING_FILTERS_MIN 10`, `SIMPLIFIED_TUNING_MAX 200`, `SIMPLIFIED_TUNING_DEFAULT 100`, `SIMPLIFIED_TUNING_D_DEFAULT 100`; mode enum OFF=0, RP=1, RPY=2.
- RP mode: yaw P/I/D/F/d_max are **left untouched** (not reset). OFF: nothing recomputed.

### Float semantics actually shipped (important)
Betaflight builds every TU with `-flto -ffast-math` (Makefile:255) and `simplified_tuning.c` is in `SIZE_OPTIMISED_SRC` (mk/source.mk:530) => `-Os -ffast-math`; LTO link uses `-Ofast` (Makefile:260). I compiled the verbatim function with `arm-none-eabi-gcc 13.2.1 -mcpu=cortex-m4 -mfpu=fpv4-sp-d16 -mfloat-abi=hard -Os -ffast-math` and also through a Betaflight-style LTO link (`-Os` TU + `-O2` caller + `-Ofast -flto` link): the function is NOT inlined and the FP op sequence is **identical** to plain -Os (`h/lto_calc.dis` vs `h/m4_Os.dis`). Cortex-M7 (fpv5-sp-d16) has the same arithmetic (only scheduling differs). Codegen:
- `x/100.0f` -> `x * 0.01f` (0x3c23d70a) — reciprocal math;
- products reassociated: `PM=(pi*c)*M`, `IPM=(i*c)*PM`, `DM=(d*c)*M`, `FM=(ff*c)*M`; `P=(Pdef*PM)*pitchPi`, `I=(Idef*IPM)*pitchPi`, `D=(Ddef*DM)*pitchD`, `F=(Fdef*FM)*pitchPi`;
- dMaxGain via fused ops: `t=fma(-g,c,1)`, `q=(Ddef*t)/dMaxDef`, `gain=fma(g,c,q)`; `d_max=((DM*dMaxDef)*pitchD)*gain`;
- `vcvt.s32.f32` truncation.
This differs from strict-C float32 results by 1 unit at many exact-integer points (e.g. master=pi=125, i=80 -> exact I = 100.0: shipped firmware **99**, strict C / app **100**; master 50, ff 60 roll F: firmware **35**, strict/app 36).

**Confirmed on a real firmware build.** I fetched the pinned SHA (`bf/`, shallow, HEAD=4fc1520c), and built `make STM32F405` with the toolchain Betaflight requires: Arm GNU Toolchain 13.3.Rel1, 13.3.1 20240614, downloaded to `tc/`. The build log (`build_f405_gcc1331.log`) shows `simplified_tuning.c` as "size optimised".

The elf contains a single non-inlined copy, `calculateNewPidValues.lto_priv.0` @0x08014574 (`real_f405_calc.dis`). It is reached by a tail-call from `applySimplifiedTuningPids` and by one direct `bl` @0x0802c062. Its FP op sequence is **identical** to the harness (`h/m4_Os.dis`).

I then **executed the real function from the elf under unicorn 2.1.4** (`emu_real.py`, FPSCR=0; real pidProfile_t offsets: mode 138, master 139, roll_pitch_ratio 140, i 141, d 142, pi 143, d_max_gain 144, ff 145, pitch_pi 148, pid[] at 8 with 8-byte stride, d_max at 106):
- defaults → 45/80/30/120/40, 47/84/34/125/46, 45/80/0/120/0;
- master 50 ff 60 → roll F = **35**;
- master 125 pi 125 i 80 → roll I = **99**.

Across 1,001,681 slider configs × 3 axes (`real_emu_check_1M.json`), real vs x86 replay (`fw_arm_emul`) = **0 mismatches**, real vs strict C = 243,867, and real vs app TS = 255,831 axis tuples. Cortex-M7 harness codegen has the same arithmetic. I did not build other MCU families: H7/AT32/APM32/PICO/SITL may differ, SITL on x86 most likely.

## 2. Filter slider formulas (firmware)

`simplified_tuning.c:65-95`; gated by `simplified_dterm_filter` (:104-109) / `simplified_gyro_filter` (:111-116). Pure **integer** arithmetic (`DEFAULT * uint8 / 100`, C int division) — no float issues.

D-term (pidProfile), mult = `simplified_dterm_filter_multiplier`:
- if `dterm_lpf1_dyn_min_hz != 0`: dyn_min = constrain(75*mult/100, 0, 1000); dyn_max = constrain(150*mult/100, 0, 1000) (:67-70)
- if `dterm_lpf1_static_hz != 0`: static = constrain(**75**(DYN_MIN default)*mult/100, 0, DYN_LPF_MAX_HZ) (:72-74)
- if `dterm_lpf2_static_hz != 0`: lpf2 = constrain(150*mult/100, 0, LPF_MAX_HZ) (:76-78)

Gyro (gyroConfig), mult = `simplified_gyro_filter_multiplier`:
- if `gyro_lpf1_dyn_min_hz != 0`: min = constrain(250*mult/100,0,1000), max = constrain(500*mult/100,0,1000) (:83-86)
- if `gyro_lpf1_static_hz != 0`: static = constrain(**250***mult/100, 0, 1000) (:88-90)
- if `gyro_lpf2_static_hz != 0`: lpf2 = constrain(500*mult/100, 0, 1000) (:92-94)

Constants: `DTERM_LPF1_DYN_MIN_HZ_DEFAULT 75`, `DTERM_LPF1_DYN_MAX_HZ_DEFAULT 150`, `DTERM_LPF2_HZ_DEFAULT 150` (pid.h:69-71); `LPF_MAX_HZ 1000`, `DYN_LPF_MAX_HZ 1000`, `GYRO_LPF1_DYN_MIN_HZ_DEFAULT 250`, `GYRO_LPF1_DYN_MAX_HZ_DEFAULT 500`, `GYRO_LPF2_HZ_DEFAULT 500` (sensors/gyro.h:40-46). Defaults: dterm static1=75 (pid.c:177), lpf2=150 (:182), dyn 75/150 (:185-186); gyro (gyro.c:126-148) lpf1 static 250, lpf2 500, dyn 250/500, `simplified_gyro_filter=true`, mult 100.
- Zero latches off: a multiplier < 2 (dterm/75) or 0 gives Hz 0, after which that filter is never re-enabled by the slider (enable test is "field nonzero").

## 3. Legal ranges (cli/settings.c)

| Setting | Range | Ref |
|---|---|---|
| simplified_pids_mode | OFF/RP/RPY (lookup :552-554) | :1466 |
| simplified_master_multiplier, _i_gain, _d_gain, _pi_gain, _pitch_d_gain (= field simplified_roll_pitch_ratio), _pitch_pi_gain | 0..200 | :1467-1470, :1473-1474 |
| simplified_d_max_gain, simplified_feedforward_gain | 0..200 | :1471-1472 |
| simplified_dterm_filter, simplified_gyro_filter | OFF/ON | :1476, :1479 |
| simplified_dterm_filter_multiplier, simplified_gyro_filter_multiplier | 10..200 | :1477, :1480 |
| p/i/d_roll/pitch/yaw | 0..250 (uint8) | :1379-1389 |
| f_roll/pitch/yaw | 0..1000 (uint16) | :1382,1386,1390 |
| d_max_roll/pitch/yaw | 0..250 | :1423-1425 |
| d_max_gain 0..100, d_max_advance 0..200 | | :1426-1427 |
| feedforward_transition 0..100 | | :1446 |
| gyro_lpf1_static_hz, gyro_lpf2_static_hz | 0..1000 (uint16) | :793, :796 |
| gyro_lpf1_dyn_min_hz / _max_hz | 0..1000 | :845-846 |
| dterm_lpf1_dyn_min_hz / _max_hz | 0..1000 | :1327-1328 |
| dterm_lpf1_static_hz, dterm_lpf2_static_hz | 0..1000 declared **VAR_INT16** (field is uint16) | :1332, :1334 |

Gyro sliders are MASTER_VALUE (global); PID/dterm sliders are PROFILE_VALUE. Ranges are enforced **only by the CLI** (and the CMS menu / adjustment ranges own bounds). A full-tree grep at 4fc1520c shows `simplified_` only in blackbox.c, cli.c, settings.c, cms.c, cms_menu_imu.c, simplified_tuning.c, parameter_names.h, rc_adjustments.c, pid.c/h, msp.c, gyro.c/h. There is no config-load validation (config.c has no reference).

All apply paths (full-tree grep):
- MSP SET (msp.c:4058).
- MSP CALCULATE/VALIDATE on temporary copies (:2634-2688).
- CLI `simplified_tuning apply` and `defaults` (cli.c:3924, :5207).
- CMS OSD menu exit (cms/cms_menu_imu.c:330, `applySimplifiedTuning`).
- **In-flight RC adjustment `ADJUSTMENT_SIMPLIFIED_MASTER_MULTIPLIER`** (fc/rc_adjustments.c:612-637). This changes `simplified_master_multiplier` within 20..200 from an aux pot and immediately calls `applySimplifiedTuningPids` + `pidInitConfig`, so the PIDs are live mid-flight and a blackbox event is logged. WU4 relevance: the header-logged master multiplier may not be the one in effect during the CHIRP segment, and the live slider read before apply may reflect a pot position. CLI `simplified_tuning apply|disable` (cli.c:3928-3940, applies to all profiles :3921-3926); CLI `defaults` re-applies simplified tuning (cli.c:5207).

## 4. MSP handlers & payloads (msp/msp.c, codes msp_protocol.h:209-214)

Codes: MSP_SIMPLIFIED_TUNING 140, MSP_SET_SIMPLIFIED_TUNING 141, MSP_CALCULATE_SIMPLIFIED_PID 142, _GYRO 143, _DTERM 144, MSP_VALIDATE_SIMPLIFIED_TUNING 145.

Payload blocks (read :2355-2464 / write mirrors):
- PID block (17 B): U8 mode, master, roll_pitch_ratio, i, d, pi, d_max_gain, ff, pitch_pi; **U32 reserved, U32 reserved** (:2355-2372).
- D-term block (18 B): U8 simplified_dterm_filter, U8 multiplier, U16 dterm_lpf1_static_hz, U16 dterm_lpf2_static_hz, U16 dterm_lpf1_dyn_min_hz, U16 dterm_lpf1_dyn_max_hz, U32, U32 (:2395-2410).
- Gyro block (18 B): same shape with gyro_lpf1_static, gyro_lpf2_static, gyro_lpf1_dyn_min, gyro_lpf1_dyn_max (:2431-2446).
- Total SET/GET = 17+18+18 = **53 bytes** (confirmed; the "reserved" is two U32 per block).

- MSP_SIMPLIFIED_TUNING (out, :2622-2628): PID+Dterm+Gyro blocks of current profile.
- MSP_SET_SIMPLIFIED_TUNING (in, `mspProcessInCommand`, :4052-4060): reads all three blocks into currentPidProfile/gyroConfigMutable — **including the Hz fields, which overwrite the FC's filter values before apply** — then `applySimplifiedTuning(...)` => **yes, it recomputes PIDs/filters**. It does **not** call `pidInitConfig`, `pidInitFilters`, `gyroInitFilters` or `validateAndFixGyroConfig` (compare MSP_SET_PID :3094-3101 -> pidInitConfig; MSP_SET_FILTER_CONFIG :3557-3561 -> validateAndFixGyroConfig+gyroInitFilters+pidInitFilters). New PIDs become live only after MSP_EEPROM_WRITE -> writeReadEeprom -> readEEPROM -> activateConfig -> pidInit (config.c:757-768, :167-177; msp.c:3755-3773, refused when armed). **Gyro filter changes are not reinitialised by activateConfig** (gyroInitFilters only at init and msp.c:3559) => live after reboot. No arming check on SET itself; no range check on any byte.
- MSP_CALCULATE_SIMPLIFIED_PID (:2630-2637): copies currentPidProfile, reads PID block, applies, replies `writePidfs` (:2467-2476): for 3 axes always: U8 P, U8 I, U8 D, U8 d_max, U16 F = 18 B.
- MSP_CALCULATE_SIMPLIFIED_DTERM/GYRO (:2639-2655): read block (incl. Hz fields) into temp copy, apply, reply block (18 B).
- MSP_VALIDATE_SIMPLIFIED_TUNING (:2657-2702): 3 U8 booleans [pids, gyro, dterm]; each = "re-applying sliders to a copy of current config changes nothing" (P,I,D,d_max,F all 3 axes; gyro static1/2 + dyn min/max; dterm static1/2 + dyn min/max). OFF => true. It reads current state only (no request payload).
- **Out-of-bounds**: loop `axis <= simplified_pids_mode` (simplified_tuning.c:48) with mode from MSP (any U8). mode>=3 reads `pidDefaults[3+]`/`dMaxDefaults[3+]` (3-element stack arrays: OOB read), writes `pid[3]`(LEVEL), `pid[4]`(MAG) (pid[] has PID_ITEM_COUNT=5, pid.h:118-125,198), beyond for mode>4, and `d_max[3+]` (3 elements, pid.h:244: OOB write into following profile fields). Reachable via MSP_SET (live profile) and MSP_CALCULATE (stack copy).

Read-back codes used for absolute values:
- MSP_PID 112 (:1477-1483): PID_ITEM_COUNT x (U8 P, I, D). App -> `FC.PIDS[i][0..2]`, `FC.PIDS_ACTIVE` (MSPHelper.ts:1130-1139).
- MSP_PID_ADVANCED 94 (:2043+): F per axis U16 and d_max per axis U8, d_max_gain, d_max_advance, feedforward_transition. App -> `FC.ADVANCED_TUNING.feedforwardRoll/Pitch/Yaw`, `dMaxRoll/Pitch/Yaw`, `dMaxGain`, `dMaxAdvance`, `feedforwardTransition` (MSPHelper.ts:1887-1957).
- MSP_FILTER_CONFIG 92 (:1960+): first byte U8 gyro_lpf1_static_hz (legacy, truncated), later U16 gyro_lpf1_static_hz, gyro_lpf2_static_hz, dterm_lpf1_static_hz, dterm_lpf2_static_hz, gyro_lpf1_dyn_min/max, dterm_lpf1_dyn_min/max. App -> `FC.FILTER_CONFIG.gyro_lowpass_hz` (overwritten by the U16), `gyro_lowpass2_hz`, `dterm_lowpass_hz`, `dterm_lowpass2_hz`, `gyro_lowpass_dyn_min_hz/max_hz`, `dterm_lowpass_dyn_min_hz/max_hz` (MSPHelper.ts:1834-1880). The MSP_SIMPLIFIED_TUNING / CALCULATE_*_FILTER readers write these same FILTER_CONFIG fields (MSPHelper.ts:336-367).
- Slider fields: `FC.TUNING_SLIDERS.slider_pids_mode, slider_master_multiplier, slider_roll_pitch_ratio, slider_i_gain, slider_d_gain, slider_pi_gain, slider_dmax_gain, slider_feedforward_gain, slider_pitch_pi_gain, slider_dterm_filter, slider_dterm_filter_multiplier, slider_gyro_filter, slider_gyro_filter_multiplier, slider_pids_valid/gyro_valid/dterm_valid` (MSPHelper.ts:307-379, 2234-2238; store src/stores/fc.ts:634+).

## 5. App side (Gyroflight wu4-safety)

- MSPHelper.ts serialisation (:307-379, :3101-3117) matches firmware byte-for-byte (9xU8 + 2xU32; 2xU8 + 4xU16 + 2xU32 per filter block; 53 B SET). Codes in MSPCodes.ts:150-157 match.
- MSP_CALCULATE_SIMPLIFIED_PID parser (:2202-2224) reads roll+pitch if mode>0 and yaw only if mode>1 (firmware always sends 3 axes; extra bytes ignored — fine).
- **Real-FC mode does not compute absolute PIDs locally**: `useTuningSliders.calculateNewPids/GyroFilters/DTermFilters` send MSP_CALCULATE_* and take the FC's answer (:123-199); `validateTuningSliders` sends MSP_VALIDATE (:206-233). The local port `src/js/simplifiedTuning.ts` (calculateSimplifiedPidValues :148, filter funcs :164-210, `validateVirtualSimplifiedTuning` :240) is used **only when `CONFIGURATOR.virtualMode`** (useTuningSliders.ts:137,162,187,221). Its constants equal firmware exactly (:71-90: 250, 1000, 1000, 1000, 250/500/500, 75/150/150, PID defaults, D_MAX {40,46,0}) and its formula order equals the C source, but it computes in **double** with `Math.trunc` (:98-100), and groups dMax as `g + (1-g)*(D/dMax)` (:137) vs firmware `(1-g)*D / dMax`.
- `useAutotune.applyGains` (useAutotune.ts:257-288): authorization gates -> MSP_SIMPLIFIED_TUNING read -> `liveCompositeBlocks` (src/gyrocore/tuning/authorize.ts:140-177: mode must be 1/2 and equal logged, yaw needs RPY, all 12 sliders must equal logged) -> overwrites proposed slider keys in FC.TUNING_SLIDERS -> MSP_SET_SIMPLIFIED_TUNING (Hz fields = values just read back by MSP_SIMPLIFIED_TUNING, so filter gating uses fresh FC values) -> MSP_VALIDATE -> requires pids_valid && dterm_valid -> MSP_EEPROM_WRITE. It never computes absolute PIDs and never reads MSP_PID / MSP_PID_ADVANCED / MSP_FILTER_CONFIG afterwards.
- Proposed sliders (`src/js/blackbox/spectral_analysis.ts:897-910`) are clamped to **25..250**, i.e. outside CLI 0..200 above 200; composite.ts:165-183/324-327 only **warns** (`proposed_sliders_outside_cli_minmax`), it does not block (recommendationGuard.ts:36-37 SLIDER_MIN 25 / SLIDER_MAX 250).
- `extractCurrentSliders` (useAutotune.ts:210-219) uses `|| 100`, so a logged legal 0 (e.g. feedforward_gain 0, d_gain 0) is treated as 1.0 for the recommendation. **Trace (code reading, not executed):**
  - qualification.ts:476-489 feeds this substituted value into `recommendGains` and `guardRecommendation`. The guard's `current` is therefore 100, its `requested` is 100×scale, and `proposed` is built from 1.0 (spectral_analysis.ts:905), giving at least 25.
  - `composite.current` = `loggedSimplifiedSliders(headers)` (qualification.ts:88-105, 451) holds the **raw** 0.
  - composite.ts:341-372 checks only that the per-axis `requested` (from the substituted value) and `final` move in the same direction relative to raw 0 (both "increase"), and that they are within 0.5 of each other, so nothing blocks.
  - `liveCompositeBlocks` compares live 0 with logged 0, which passes.
  - Result: on a craft with `simplified_feedforward_gain = 0` (FF off), an authorised composite would write FF ≈ 100×ffScale (≥25), i.e. it would switch feed-forward on from 0. The same applies to d_gain 0. I found no zero-specific guard. This should be confirmed with a unit test.
- `FC.DEFAULT_PIDS` (src/stores/fc.ts:632: 42/85/35/20/90...) is stale vs firmware defaults but unused outside types.

## 6. Discrepancies / safety observations

1. **Post-SET VALIDATE is tautological** (useAutotune.ts:282-286). SET has just applied the sliders, so re-applying them is a no-op and VALIDATE returns 1/1/1 for every input, including bad ones. It cannot detect anything. A non-tautological sequence would be:
   - (a) MSP_VALIDATE **before** SET. This catches PIDs or filters hand-edited while the sliders stayed on, which SET would silently overwrite. The current pre-check compares slider values only.
   - (b) After SET, re-read MSP_SIMPLIFIED_TUNING and confirm the sliders equal what was sent.
   - (c) Ask MSP_CALCULATE_SIMPLIFIED_PID for the proposed sliders, before SET, and after SET (or after EEPROM write) read MSP_PID + MSP_PID_ADVANCED and compare P/I/D/F/d_max per axis. Optionally also MSP_FILTER_CONFIG against MSP_CALCULATE_SIMPLIFIED_DTERM.
2. **SET does not take effect live**. PIDs only change after EEPROM write -> activateConfig. Gyro filters only change after a reboot. The app's FC.PIDS / ADVANCED_TUNING / FILTER_CONFIG caches are stale after applyGains (they are not re-read).
3. **No firmware validation of MSP input**: sliders 0..255 are accepted. Mode >=3 causes OOB reads and writes. A filter multiplier of 0..1 zeroes the filters, and they then stay disabled. The app proposes up to 250 (warn-only), and the CLI would later reject the `set` lines in a diff/restore.
4. **Local TS port ≠ shipped firmware** at truncation boundaries (it is only used in virtual mode, but must not be used as a firmware-exact oracle). Exhaustive sweep over CLI range 0..200 (`h/sweep_0_200.txt`):
   - roll I: ARM vs app 3665/8.12M, strict vs app 710.
   - pitch I: ARM vs app 8607/1.63G.
   - pitch F: ARM vs app 31697/8.12M.
   - pitch d_max: ARM vs app 8534/1.63G.
   - roll P/D/F: 77/125/280 of 40401.
   - Even strict float32 C ≠ app double (e.g. roll F 48, pitch F 2005).
   - On a realistic 5-step grid (master, pi, i, d, ff in 50..150), **18.8 %** of roll/pitch axis tuples differ ARM vs app in at least one term (`h/grid5.txt`).
   - Filters: 0 mismatches (integer math, m = 0..255).
   - Any GyroCore "firmware-exact" absolute-gain prediction must come from MSP_CALCULATE_SIMPLIFIED_PID / MSP_PID+MSP_PID_ADVANCED readback, or from an emulation of the ARM sequence, not from strict-C or the TS port.
5. Virtual-mode validate skips a comparison when the expected value is 0 (`!expected.x ||`, simplifiedTuning.ts:262-279). The firmware compares all fields. This is a minor divergence.
6. Naming trap: the MSP/field `roll_pitch_ratio` corresponds to CLI `simplified_pitch_d_gain`.

## 7. Matrix

`bf_matrix.json` holds 17 PID slider configs × axes, each with:
- `fw_real_f405`: ground truth, the real STM32F405 elf function executed.
- `fw_arm_emul`: the x86 replay of that sequence.
- `fw_strict`: verbatim C, strict float32.
- `app_ts`: a C replica of the TS port.
- `app_ts_node`: the real TS code run under node; 0 mismatches with `app_ts`.

It also includes filter Hz for multipliers {0,1,5,10,25,50,75,90,100,110,120,138,150,175,200,250,255}, the sweep counts, and the toolchains. Consumers should use **`fw_real_f405`** (real elf executed; `fw_arm_emul` is identical). Selected `fw_real_f405` results (R / P / Y as P,I,D,F,dmax):

| Config | Roll | Pitch | Yaw |
|---|---|---|---|
| all 100 RPY | 45,80,30,120,40 | 47,84,34,125,46 | 45,80,0,120,0 |
| pi 138, ff 138 | 62,110,30,165,40 | 64,115,34,172,46 | 62,110,0,165,0 |
| master 50 | 22,40,15,60,20 | 23,42,17,62,23 | 22,40,0,60,0 |
| master 200 | 90,160,60,240,80 | 94,168,68,250,92 | 90,160,0,240,0 |
| d 150 | 45,80,45,120,60 | 47,84,51,125,69 | — |
| i 150 | 45,120,... | 47,126,... | 45,120,... |
| rpr 120, pp 110 | (roll defaults) | 51,92,40,137,55 | |
| rpr 80, pp 90 | | 42,75,27,112,36 | |
| d_max_gain 0 | dmax 30 | dmax 34 | |
| d_max_gain 200 | dmax 50 | dmax **58** (strict 57) | |
| master 110 | 49,88,33,132,44 | 51,92,37,137,50 | |
| m125 pi125 i80 d110 ff90 dg50 | 70,**99**,41,135,48 (strict/app I=100) | 73,**104**,46,140,55 (strict/app 105) | 70,**99**,0,135,0 |
| all 200 | 180,250,120,480,200 | 250,250,250,1000,250 | 180,250,0,480,0 |
| RP mode, master 150 | 67,120,45,180,60 | 70,126,51,187,69 | unchanged |
| OFF | unchanged | unchanged | unchanged |

Filters (mult -> dterm dynmin/dynmax/static1/lpf2; gyro dynmin/dynmax/static1/lpf2):
- 100 -> 75/150/75/150; 250/500/250/500
- 50 -> 37/75/37/75; 125/250/125/250
- 150 -> 112/225/112/225; 375/750/375/750
- 200 -> 150/300/150/300; 500/1000/500/1000
- 10 -> 7/15/7/15; 25/50/25/50

Artifacts: `bf/` (pinned source + `obj/main/betaflight_STM32F405.elf`), `real_f405_calc.dis`, `emu_real.py`, `cmp_real.py`, `cmp_real_1M.py`, `real_emu_check*.json`, `build_f405_gcc1331.log`, `tc/` (13.3.rel1 toolchain), `py/` (unicorn), `h/st_fw.c` (verbatim function), `h/m4_Os.dis`, `h/m4_Ofast.dis`, `h/m7_Os.dis`, `h/lto_calc.dis`, `h/sweep.c`, `h/gen.c`, `h/grid5.c`, `h/app_port.ts`.
