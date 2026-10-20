# GF-1 M1 — Digital Betaflight rate-controller model

**Status:** offline model + independent reference tests only.  
**Not wired** into `recommendGains`, phase-margin product path, or Apply.  
**Product lock:** `openLoopModel: "unvalidated"` / `phaseMarginStatus: NOT_VALIDATED` from PR #12 remains.

## Firmware pin

| Item | Value |
|------|-------|
| Repo | `sliksoft/VliegAI-Betaflight` |
| Commit | `43875a55a513fa640f0417561a0ff8847c9889e7` |
| AIR65 board | `BEFH BETAFPVG473` |
| BBL | `BTFL_BLACKBOX_LOG_AIR65_C_20261018_231421_BETAFPVG473.BBL` |
| Logged revision | `Betaflight 2026.6.2 (43875a55a) STM32G474` |

## Loop timing (AIR65)

| Quantity | Source | Value |
|----------|--------|-------|
| `looptime` | BBL header | 125 µs → **8 kHz** gyro |
| `pid_process_denom` | BBL header | 2 → PID every 2nd gyro sample |
| PID `dT` | `pid_init.c` `pidSetTargetLooptime` | **250 µs → 4 kHz** |
| Scales | `flight/pid.h` | `PTERM_SCALE`, `ITERM_SCALE`, `DTERM_SCALE`, `FEEDFORWARD_SCALE` |

## Signal definitions

```
exc          = chirp cosine (DEBUG_CHIRP debug[3] / 1000)     // before phaseComp
r_chirp      = chirp_amplitude_axis * phaseComp(exc)          // added to PID setpoint
y            = gyroADCf                                      // after gyro software LPFs
e            = r_chirp - y
P            = Kp * e   [yaw: then PT1 yaw_lowpass]
I            = I + Ki * dT * e_iterm                         // forward Euler; windup limits exist
D            = Kd * (−(g_d[n] − g_d[n−1]) * pidFrequency)    // g_d = D-term-filtered y
F_rc         = Kf * getFeedforward(axis)                     // RC route in rc.c — NOT chirp
u            = P + I + D + F_rc (+ S / spa; out of M1 scope)
```

### Transfer operators (LTI core)

| Symbol | Definition |
|--------|------------|
| `C_reference(z)` | `Ce(z)` = P+I on the **shaped** chirp setpoint (`u/r_chirp` at `y=0`) |
| `C_feedback(z)` | `Ce(z) + Cd(z)` with `u = Ce·r − (Ce+Cd)·y` |
| `H_phase(z)` | `phaseComp` lead/lag on `exc` (excitation shaping only) |
| `T_chirp(z)` | measured `y / r_chirp` from CHIRP (product Quality V2) |
| `L_stability(z)` | `C_feedback · G` with `G = T / (C_reference − T·C_feedback)` — **M2** |

Blackbox setpoint already includes `phaseComp`. **Do not** fold `H_phase` into `C_reference` when reconstructing `G`/`L` from measured `T` (that would double-count). `evaluateControllerFrf` returns `cExcitationShaping` separately.

When `Cd = 0` and `C_reference = C_feedback`, this collapses to `L = T/(1−T)`. That identity is **not** valid for roll/pitch with D-on-gyro.

### CHIRP vs feedforward (verified in firmware)

In `pid.c` (@43875a55):

1. `currentChirp` is added to `currentPidSetpoint` **after** `getSetpointRate()`.
2. Feedforward uses `getFeedforward(axis)` from **rc.c**, not `Δ` of the chirp-augmented setpoint.
3. Therefore **do not** model FF as part of `C_reference` for CHIRP identification.

## AIR65 axis notes

| Axis | PID (P,I,D) | FF weight | LTI remarks |
|------|-------------|-----------|-------------|
| Roll | 56, 79, 30 | 22 | D-on-gyro; **D_max=40**; iterm_relax RP; dyn_notch + rpm_filter |
| Pitch | 82, 117, 61 | 32 | D-on-gyro; D_max=0; iterm_relax RP; dyn_notch + rpm_filter |
| Yaw | 56, 79, **0** | 22 | No D; **yaw Ki × 2.5**; yaw P PT1 100 Hz; iterm_relax does **not** apply (RP); best LTI practice reference |

`simplified_pids_mode: 0` → logged absolute PIDs are authoritative (no slider remapping at analysis time).

## Linear vs nonlinear inventory

### Exact LTI (modelled in M1)

- P, I (forward Euler), D discrete derivative with PT1 D-term LPFs
- Gyro PT1 LPF1/LPF2 (at gyro rate)
- Yaw P PT1
- Chirp `phaseComp` (at PID rate)

### Conditionally LTI

- **TPA** — constant gain if throttle fixed during sweep
- **iterm_relax** — ≈ inactive when setpoint HPF ≪ 40 °/s; nonlinear otherwise (RP only)
- **D_max** — inactive when multiplier≈1; state-dependent Kd otherwise (roll)

### Not LTI / insufficient for validated PM (M1)

- dyn_notch (moving centres)
- rpm_filter (RPM-scheduled)
- anti_gravity (throttle derivative)
- RC feedforward jitter/boost/averaging (packet-timed; not on CHIRP path)
- Mixer / motor / ESC plant delay (plant — needed for M2 interpretation of `G`, not for `C_*` parity)

## Implementation

| Path | Role |
|------|------|
| `src/js/blackbox/betaflight_digital_controller.ts` | Scales, filters, `evaluateControllerFrf`, TD simulator, AIR65 constants |
| `test/js/betaflight_digital_controller_reference.test.ts` | Independent analytic ↔ TD reference suite |

## M2 requirements (do not start without ack)

1. Form `L_stability = C_feedback * T / (C_reference − T * C_feedback)` on coherent bins only.
2. Decide how to treat dyn_notch/rpm (exclude band, freeze, or keep `NOT_VALIDATED`).
3. Validate against independent closed-loop simulation with known `G` before enabling PM.
4. Keep coherence gates 0.50 / 0.60 and Apply lock unchanged until PM is validated.
5. Only then consider relaxing `openLoopModel: "unvalidated"`.
