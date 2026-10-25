# Autotune v2: hardware test procedure (not yet executed)

Status: **NOT_EXECUTED**. `ABSOLUTE_SAFETY_POLICY.hardwareValidated` (`src/gyrocore/safety/absoluteEvaluate.ts`) stays
`false` until this procedure has been executed and its results reviewed; changing it is a separate, reviewed change and
never part of running a test. Software baseline: WP8 at `6aee384e` (see
`audit/autotune-v2/2026-10-25-wp8-software-baseline.md`).

## Rules for every test

- Every test needs the owner's explicit go-ahead for that test. A go-ahead for one test does not cover the next.
- Class **R** (read-only) sends no `MSP_SET_*`, no `MSP_EEPROM_WRITE`, no CLI `set` / `save`, no reboot request.
  Class **W** writes to the FC (RAM, EEPROM or a reboot) and needs a separate go-ahead naming the test. Class **F**
  (flight) is out of scope for this procedure until every R and W test passed.
- Props off and battery disconnected (USB power only) unless a test says otherwise. No motor test, no Motors tab
  slider, no firmware flash, no automatic write.
- Before the first test, take a CLI `diff all` with the upstream Betaflight App and keep it (independent backup, not
  made by Gyroflight). Repeat it after every W test.
- Record for every test: the Gyroflight build (commit), browser and version, OS, the transport, the MSP log (Show Log /
  MSP debug: codes in order), screenshots of the result, `diff all` before / after where named, and every deviation.
- **Abort** at the first unexpected result: stop, do not retry, keep the FC as it is (no reboot, no save), keep the page
  open, export the MSP log, and report. A failed or blocked test is a result, not something to work around.
- A refusal with a named reason (`fc:…`, `apply:…`, `restore:…`) where the procedure expects one is a PASS of that check.

## Hardware and preconditions

| Item | Requirement |
| --- | --- |
| Craft | the FC that flew the analysed logs: BETAFPV AIR65, target `BETAFPVG473` |
| Firmware | Betaflight 2026.6.2, MSP API 1.48 (the absolute route needs ≥ 1.45; RPM fade / Q / weights need 1.48) |
| Host | Windows or Linux desktop with a Chromium-based browser that has Web Serial (Chrome or Edge); record its version |
| Link | USB data cable; Web Bluetooth only with a BLE–UART bridge on the FC (none on a stock AIR65: B-tests are N/A then) |
| Gyroflight | production web build (`npm run build`, served over HTTPS or `localhost`) from the commit under test |
| Logs | the CHIRP logs the analysis used, on the host, with their SHA-256 |
| Second tab | for H-W5 / H-W6: a second tab of the same origin, same browser profile |

## Read-only tests (class R)

| ID | Test | Preconditions | Expected | PASS evidence | Abort when |
| --- | --- | --- | --- | --- | --- |
| H-R1 | Board identification | USB connected, Gyroflight connected | Board `BETAFPVG473`, target and UID shown; UID equal to the UID in the log header | screenshot of the board info and the log header UID | board, target or UID differ |
| H-R2 | Firmware version | as H-R1 | Betaflight 2026.6.2, API 1.48; no "unsupported" banner | screenshot; MSP log with `MSP_API_VERSION`, `MSP_FC_VERSION`, `MSP_BUILD_INFO` | another version: stop, the analysis does not apply |
| H-R3 | Blackbox log compatibility | the logs on the host | every log decodes; header firmware equals H-R2; `PLANT_CONFIG_KEYS` (`engine/logInput.ts`) present; CHIRP headers `chirp_lag_freq_hz` / `chirp_lead_freq_hz` present; the qualification states per axis `usable` / warnings / rejected with reasons | panel screenshot per log; the SHA-256 the panel shows equals the host's | a log fails to decode, or its SHA-256 differs |
| H-R4 | WebSerial connect / disconnect | as H-R1 | connect, disconnect, connect again without a page reload; no "port busy" error; after unplugging USB the app shows disconnected and offers no write | screenshots; console without uncaught errors | the port stays busy after disconnect (do not force it; report) |
| H-R5 | MSP readback | connected | _Read from flight controller (read-only preview)_ lists the live values; "Now" equals `diff all` for every field shown; the MSP log has no `MSP_SET_*` / `MSP_EEPROM_WRITE` | MSP log; preview screenshot; `diff all` | any `MSP_SET_*` or `MSP_EEPROM_WRITE` in the log |
| H-R6 | Identity and live-config binding | connected, CHIRP log imported, Calculate done | preview accepts identity, or names the block (`fc:live_differs_from_log:<field>`); Apply stays disabled with `absolute_safety:not_hardware_validated` | screenshot of the gate list | Apply is enabled |
| H-R7 | Backup download | a backup exists from an earlier session (none is taken without a write) | the backup's values equal `diff all` of the time it was taken | downloaded file, diff | values differ |
| H-R8 | Status polling and write lease (read side) | connected; Status tab open (live polling); a Gyroflight transaction record exists only if an earlier test left one | polling runs; the read-only preview completes (it takes no write lease); _Check_ (`checkTransactionState`, read-only, takes the write lease) completes or ends with `fc:write_lease_timeout` after 8 s, never hangs; no write | MSP log; screenshot of each outcome and the time it took | either hangs > 15 s, or a write appears |
| H-R9 | Uncertain-state notice | none open | the panel shows no uncertain transaction for this craft (`UncertainStateNotice`) | screenshot | an entry is shown that no test created |
| H-R10 | Web Bluetooth (only with a BLE bridge) | bridge paired | connect, readback as H-R5, disconnect; after switching the bridge off the app shows disconnected; reconnect works | MSP log, screenshots | otherwise N/A (record N/A, not PASS) |

## Write tests (class W, separate go-ahead per test)

Every W test starts from a fresh `diff all` and ends with one. Absolute Apply is BLOCKED in software, so the W tests
use upstream paths that already write (PID tab Save, CLI tab) or Restore, and check Gyroflight's guards around them.

| ID | Test | Preconditions | Expected | Safety | PASS evidence | Abort when |
| --- | --- | --- | --- | --- | --- | --- |
| H-W1 | MSP save and EEPROM confirmation | H-R1–H-R5 PASS; owner go-ahead | change one harmless field (e.g. `dterm_lpf2_static_hz` −5 Hz) in the PID tab and Save; `MSP_EEPROM_WRITE` answered with an ACK; the app reports saved only after the ACK; `diff all` shows exactly that field | props off, USB power | MSP log with the SET, `MSP_EEPROM_WRITE` and its answer; `diff all` | any other field changed |
| H-W2 | Revert H-W1 | H-W1 PASS | set the field back and Save; `diff all` equals the starting one | as H-W1 | `diff all` | not equal |
| H-W3 | Reboot and reconnect (USB) | H-W2 PASS | Save-and-Reboot from the upstream path; the app reconnects; identity H-R1 again; `diff all` equal | as H-W1 | MSP log across the reboot; screenshots | no reconnect within 30 s (do not power-cycle before reporting) |
| H-W4 | CLI mode | H-W3 PASS | enter the CLI tab, `diff all`, `exit` without `save`; the app reconnects only after the exit went out whole; no Gyroflight write during the CLI session (writes refused while it is open) | as H-W1 | CLI output; MSP log; refusal reason when a write is tried from another tab | the FC reboots before `exit` was sent, or a write went out during the session |
| H-W5 | Write lease between tabs | second tab, same origin | tab A starts a PID-tab Save while tab B starts one: one waits or is refused (`fc:write_lock_busy` / `fc:write_lease_timeout`), never interleaved; the MSP log shows one SET block after the other | as H-W1 | both tabs' logs with timestamps | SETs of both tabs interleave |
| H-W6 | Delayed / refused retry | H-W5 PASS | while the Status tab polls, start a save: it completes or ends with a named refusal; a refused RXFAIL/Failsafe write ends the save (Failsafe tab stays dirty) | as H-W1 | MSP log; screenshot | the save hangs, or reports saved without the ACK |
| H-W7 | Interrupted connection | owner go-ahead to unplug USB during a save | unplug USB between SET and `MSP_EEPROM_WRITE`: the app reports the save as unknown (never "saved", never "not sent"); after reconnect the panel shows the uncertain state if a Gyroflight transaction was running; `diff all` decides the real state | USB unplug only, no battery | screenshots; `diff all` after reconnect | the app reports "saved" |
| H-W8 | Lost answer, same connection | not inducible without tooling: N/A unless a USB analyser or MSP proxy drops one answer | later saves of the same MSP code on that connection report unknown until reconnect (no MSP request id; fail-closed) | — | MSP log | a later save reports saved without a reconnect |
| H-W9 | Kept-link reboot (BLE only) | BLE bridge whose GATT link survives the FC reboot | Save-and-Reboot over BLE: the app runs the MSP handshake again over the kept link and reconnects (not tested end-to-end in software: the `serial_backend` test mocks `serial.connect`) | as H-W1 | MSP log across the reboot | no reconnect; N/A without a bridge |
| H-W10 | Gyroflight Restore | a Gyroflight backup of this craft and profile with `stateKnown: true` | Restore writes, reads back, saves, reads again; `diff all` equals the backup; switching the PID profile first refuses it (`restore:pid_profile_changed:<a>-><b>`) with no `MSP_SET_*` | as H-W1 | MSP log; `diff all` | any field differs after Restore |
| H-W11 | Uncertain transaction recovery | H-W7 left an entry | `checkTransactionState` (read-only) clears it only when EEPROM was not written and the read-back equals the backup; otherwise only a covering Restore clears it | as H-W1 | screenshots before / after | an entry is cleared without that evidence |

## Absolute Apply (blocked)

The tests below cannot run today: Safety refuses every absolute Apply (`absolute_safety:not_hardware_validated`).
They are listed so the acceptance that would lift the block is fixed in advance. Lifting it is a separate change,
reviewed on its own, after H-R1–H-R9 and H-W1–H-W7, H-W10, H-W11 passed.

| ID | Test | Needs |
| --- | --- | --- |
| H-A1 | No-op absolute Apply: a released proposal equal to the FC; Verify reads every value back and saved; `diff all` unchanged | a released proposal (none on the AIR65 logs today) |
| H-A2 | One-field absolute Apply and Restore: only that field changes; Restore returns `diff all` to the start | as H-A1 |
| H-A3 | Profile binding: preview in one profile, switch, confirm → `apply:preview_changed`, nothing written | as H-A1 |
| H-A4 | Real proposal (class F): hover test with the owner's own safety procedure, then a CHIRP flight compared with the prediction (Verified Tune) | lifted PM / independent-validation / Safety blockers on real flights |

## Hardware acceptance criteria

The hardware validation counts as executed only when, on the same Gyroflight commit: H-R1–H-R9 PASS (H-R10 PASS or
N/A), H-W1–H-W7, H-W10 and H-W11 PASS (H-W8, H-W9 PASS or N/A, recorded as such), every PASS has its evidence
attached, and a reviewer other than the operator checked the evidence. N/A is never counted as PASS, and BLE is
validated only by H-R10 and H-W9 actually run.
