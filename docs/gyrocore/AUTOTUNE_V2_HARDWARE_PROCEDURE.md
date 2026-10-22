# Autotune v2: hardware test procedure (not yet executed)

Every step needs the owner's explicit go-ahead for that step. No firmware flash, no motor test, no automatic write. Props
off and battery disconnected unless a step says otherwise. Stop at the first unexpected result and keep the FC as it is.

## Preconditions

- Gyroflight from `feat/gyroflight-autotune-engine-v2` (production web build), Chromium with Web Serial.
- The FC that flew the analysed logs (AIR65, BETAFPVG473, Betaflight 2026.6.2, MSP API 1.48), USB only.
- Before step 1, take a CLI `diff all` with the upstream Betaflight App and keep it (independent backup).

## Steps

1. **Read-only.** Connect. Import the CHIRP log, Calculate, click _Read from flight controller (read-only preview)_.
   Expected: identity accepted (or a named block such as `fc:live_differs_from_log:<field>`), a list of changes, and no
   MSP_SET_* or MSP_EEPROM_WRITE in the log (Show Log / MSP debug). Compare the preview's "Now" column with the CLI
   `diff all`.
2. **Backup only.** No write path takes a backup without a write; a backup is checked indirectly in step 3. Download it
   (Restore list) and compare every value with `diff all`.
3. **No-op write** (needs a released proposal, so not possible on the AIR65 today; see blockers). With a released
   proposal whose values equal the FC's: Apply, check Verify shows every value read back and saved; `diff all` unchanged.
4. **One small change and Restore.** One field (e.g. `dterm_lpf2_static_hz` −5 Hz) through a released proposal: Apply,
   check Verify and `diff all` (only that field changed); then Restore and check `diff all` equals the original.
5. **PID profile binding.** With the backup from step 4: switch the FC to another PID profile (Betaflight App, PID
   Tuning tab), then open Restore in Gyroflight. Expected: blocked with `restore:pid_profile_changed:<a>-><b>` and no
   MSP_SET_* in the log; switch back and Restore succeeds; `diff all` shows the other profile unchanged. Also: preview in
   one profile, switch, confirm Apply → `apply:preview_changed`, nothing written.
6. **Real proposal.** Only after the PM / independent-validation / Safety blockers are lifted with real flights: apply,
   hover test with the owner's own safety procedure, then a CHIRP flight to compare with the prediction.

## What to report

For each step: the Gyroflight result screen, the MSP log (codes in order), `diff all` before / after, and anything that
differed from the expectation. A failed or blocked step is a result, not something to work around.
