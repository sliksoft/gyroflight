# Protocol v3 — gezamenlijke PID+filterzoeker met motorregel over alle assen, Betaflight SITL (2026-11-11)

Vastgelegd vóór de formele runs en vóór Calculate, in dezelfde commit als de code (`scripts/sim/e2e/protocols/`); de dossierkopieën
`PROTOCOL.md`/`protocol.json` zijn byte-gelijk en hun sha256 staat in `provenance.json`. Alleen SITL en bestaande logs; geen
flightcontroller, geen vlucht, geen push, PR #16 blijft draft.

## Vraag
Kan GyroFlight uit de Blackbox-logs van de begintune (roll én pitch geswept) zelf een PID+filterkandidaat kiezen die bij een
onafhankelijke hermeting op beide assen PM ≥ 45°, GM ≥ 6 dB en |S| ≤ 6 dB haalt, de gemiste doelen per as verbetert en het
ruisbandvermogen van **elke motor** in hover binnen 1,10 × de begintune houdt — terwijl de v2-kandidaat (70/55/27/36 met gyro-LPF ×1,5
en D-LPF ×1,25, "1,45× motorband" in het v2-venster) wordt afgewezen?

## Wat er sinds v2 veranderd is (vooraf, met reden)
- **Engine (blok 13):** ruis van álle drie assen (huidige PID op assen zonder sweep) en per motor via de QUAD X-mixer; eis hoogste
  motorratio ≤ 1,10 (`JOINT_SEARCH.maxMotorNoiseRatio`); reproductiecontrole per as (model −Kp·gP + d tegen gelogde axisP + axisD,
  ±1 dB; niet gereproduceerd: alleen toegestaan onder 5 % aandeel, anders motorregel niet beoordeelbaar); ruis gelezen in vlucht
  buiten elke CHIRP; per as in de app welke effecten beoordeeld zijn en welke gegevens ontbreken.
- **Gevonden fout (v2):** het ruismodel nam de P-term als +Kp·gyro; de firmware rekent P op de fout (−gyro) en D op −Δgyro. Daardoor
  had de kruisterm P·D het verkeerde teken. Gerepareerd; kalibratie op de v2-logs (`pilot/calibration_*`): voorspeld per motor
  2,52–2,55, gemeten 2,50–2,54 (hover); roll-as voorspeld 1,70 tegen 1,59 gemeten. De v2-referentie "ctrlBand 0,92" kwam uit een venster
  vanaf 2 s met stilstand, opstijgen en chirp; in hover buiten de chirp is de roll-regelaarruis van de v2-kandidaat ×1,6 en de
  motorband ×2,5 (v2-venster: ×1,45).
- **Meting:** per motor in hover (zie motorregel); twee sweeps per run (roll, dan pitch: de firmware schuift de CHIRP-as door bij elke
  nieuwe activering), referentie per as (`reference_loop.py --axis`).

## Opstelling
VliegAI lockstep-SITL (HEAD `20f6af5a7ebd`), CHIRP-ELF `6db21d7e…`, ANGLE, hi-res Blackbox, gyroUnfilt gelogd; CHIRP 2–100 Hz / 20 s,
amplitude 230 op roll en pitch; vensters [s, s+2100) en [s+2200, s+4300) outer ticks, 5300 ticks per run; ruisproef v2 ongewijzigd
(2 °/s Gauss, seed 1, 2× RC-hoogdoorlaat 150 Hz).
- **Begintune T (ontworpen met de engine op pilotlogs, "ruisig en traag"):** roll 88/55/45/60, pitch 71/82/84/0, yaw 56/79/0; gyro-LPF
  150/150–300/300, D-LPF 60/60–120/120. Pilot (`pilot/runT`): roll PM 38,4°, |S| 6,30; pitch PM 32,3°, |S| 8,0 dB (missen PM en |S|).
- **Positieve controle (niet in de app, andere ticks 420/470/520):** roll 62/44/41/54, pitch 50/57/67/0, gyro-LPF ×0,8 (120/240),
  D-LPF ×1,5 (90/180) — een rasterpunt dat op het pilotlog elke engine-regel haalt (voorspeld PM 53,3°/49,3°, motor max 0,934), en
  niet de keuze van de engine op dat log (gyro ×0,8, D ×1,25, 62/39/54/72 + 50/57/67).
- **Bekend vooraf:** de engine kiest op het pilotlog 62/39/54/72 + 50/57/67 met gyro ×0,8 / D ×1,25 (voorspeld PM 46,4°/45,6°, motor 0,79);
  ook de PID-only-zoeker haalt op dat log beide assen (62/39/52/69, 50/57/63), de gezamenlijke kandidaat wint daar op crossover. Het
  enige onafhankelijke element is de hermeting.

## Motorregel (vast)
Per motor m: Welch-bandvermogen 100–500 Hz (nperseg 1024, Hann, 50 %) van de gelogde motor[m] over de hover-samples (alle motoren
> 1001 sinds ≥ 1 s, buiten elke actieve CHIRP ± 0,5 s), per aaneengesloten stuk gewogen naar segmenten; ratio = mediaan van drie
kandidaatruns / mediaan van drie begintuneruns. **Eis: hoogste motorratio ≤ 1,10.** Geldig alleen zonder clipping, met ≥ 3072
hover-samples per run en een spreiding (max − min)/mediaan ≤ 0,15 per motor in beide tunes; anders INSUFFICIENT.

## Oordeel
- **Regressie (eerst):** nieuwe engine op de drie v2-begintunelogs kiest de v2-kandidaat niet, voorspelt voor die kandidaat een hoogste
  motorratio > 1,10, en de gemeten hover-motorratio van de v2-hermeting is > 1,10. Anders FAIL `regression_case_not_rejected`.
- **INSUFFICIENT:** begintune niet geldig op beide assen (3/3, GM beoordeelbaar, PM-spreiding < 1°) of mist op geen as een doel;
  controle niet geldig, mist een doel, verbetert niet, of overschrijdt de motorgrens (buiten de zoekruimte → FAIL
  `candidate_missing_in_grid`); een tune niet gemeten.
- **FAIL:** `candidate_missing_in_grid`; `candidate_rejected` (geen PID+filtervoorstel: PID-items bron `joint_search` en filteritems,
  Apply-route aanwezig, geen blokkade over de kandidaat; FC/bevestiging/board van het SITL-log tellen niet); `remeasurement_does_not_confirm`
  (een as mist een doel of verbetert niet, of motorregel faalt).
- **PASS:** de app kiest zelf een PID+filterkandidaat; hermeting haalt op roll en pitch alle doelen (GM beoordeelbaar), verbetert per as
  elk gemist doel met de tolerantie zonder verlies, en elke motor blijft ≤ 1,10.
- Apart: voorspelling − hermeting per as (fc 10 %, PM 5°, GM 1,5 dB, |S| 1 dB) en per motor (±15 % relatief).

## Eén commando
```
cd ~/Gyroflight-worktrees/autotune-engine-v2
scripts/sim/e2e/run_e2e_joint3.sh ~/Gyroflight-audits/autotune-v2-sitl-e2e-joint-motor-2026-11-11
```
