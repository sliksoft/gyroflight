# Protocol session_v1.1 — AutoTune-sessie in de gewone GyroFlight-app tegen Betaflight SITL (blok 14, 2026-11-12)

Vastgelegd vóór elke definitieve run, in dezelfde commit als de sessiecode; machineleesbaar in `session_protocol_v1.json`
(dossierkopie byte-gelijk, gecontroleerd door `run_session_demo.sh`). Alleen SITL en bestaande logs; geen flightcontroller,
geen vlucht, geen push; PR #16 blijft draft. Pilotseed 4 is verbruikt (fase 0 en pilot); sessieseed 5 en eindseed 6 zijn ongebruikt.

## Versie 1.1 (vóór elk definitief resultaat)
Na het starten van de definitieve runs bleek bij een review dat G3–G6 alleen tegen de laatst geaccepteerde meting golden. De eindcontrole
vergelijkt de beste tune echter met de begintune, met dezelfde drempels. Over meerdere geaccepteerde stappen zouden de toleranties per
stap optellen, bijvoorbeeld fc −8 % en daarna −5 % = −13 % tegenover de begintune. Dat is een ontwerpfout van het protocol, geen
eigenschap van de tuner.

De run is gestopt toen de startmeting van sessie A op seed 5 net liep. Er is niets van gelezen; de data staan ongeopend in
`aborted_v1_unread/`. Daarna is v1.1 vastgelegd:
- G2–G6 gelden ook tegenover de startmeting, net als G1 (regelnamen `…_vs_start`);
- de selectie toetst de voorspelbare bewakingsregels ook tegenover de start, met de voorspelde verandering toegepast op de geaccepteerde
  meting.

Seeds 5 en 6 blijven, omdat niets van de afgebroken run is gebruikt.

## Vraag
Vindt één complete sessie in de gewone app zelf een gemeten verbetering en houdt ze die vast? Herstelt ze een stap die een
geldige hermeting afwijst? Leest ze elke instelling en elk herstel exact terug via MSP? Eindigt ze met de beste gemeten tune?

## Bewijs dat meegenomen is
- **v3 INSUFFICIENT:** de coherentiedrempel 0,99 maakt GM onder ruis onbeoordeelbaar. Hier geldt daarom GM-regel v4 met σ.
- **v4 FAIL:** de eis "een volle tolerantie verbetering" wees een nipt gemist doel af. Hier geldt V2 (zie Beslisregel). Dit is de keuze
  die de gebruiker met het plan heeft goedgekeurd.
- **Correctie blok 12:** de enige ruismaat is het motorbandvermogen per motor in hover, met het gecorrigeerde P-teken in het model en
  buiten elke CHIRP ± 0,5 s én buiten het stappenblok ± 0,5 s.
- **Nieuw uit fase 0** (stopt voor geen enkele eerdere conclusie, maar verandert het meetontwerp):
  - In de runs met twee sweeps van blok 13 zakte de craft na ~39 s op de grond (z = 0) en liep hij tegen de positieklem van ±100 m
    van de plant (`plant.py:122`); alle v3/v4-runs droegen de markering `envelope` en die is daar niet als ongeldig gewogen. Hier houdt
    een trage harnesspiloot hoogte en positie vast (gas en roll/pitch-sticks, alleen in ANGLE; bandbreedte ≪ 2 Hz).
  - ANGLE en CHIRP hebben in de firmware voorrang op de body-rate-commando's en trekken de pilot grant in (`io/vliegai.c:504–545`):
    het stappenblok vliegt daarom in acro, met één grant-UIT-tick vooraf.
  - Betaflight zet `d_max` op 0 als `d_max < D` (`config.c:275`); het MSP-teruglezen ving dat in de pilot. Kandidaten houden
    d_max = 0 of ≥ D (`scaledPid`).

## Opzet
- **Bank** (`scripts/sim/session/`): persistent EEPROM per sessie. Instellen gaat met Betaflight's eigen CLI (`--config`, set + save),
  alleen voor roll/pitch/yaw p/i/d/d_max; filters staan vast per scenario. Teruglezen gaat via MSP (MSP_PID 112, MSP_PID_ADVANCED 94,
  MSP_STATUS_EX 150) uit een geboote SITL. De read-only allowlist van de bridge krijgt in het proces alleen deze leescommando's
  (lege payload). Een meetrun leest MSP vóór het armen.
- **Meetrun** (6000 ticks = 60 s, 1 kHz, hi-res Blackbox, ANGLE, gyroruis 2 °/s met HP 150 Hz 2e orde):
  - hover;
  - roll-CHIRP [s, s+2100) en pitch-CHIRP [s+2200, s+4300);
  - acro-stappenblok vanaf s+4400: doublets ±100 °/s van 10 + 10 ticks met 60 ticks rust, roll+, roll−, pitch+, pitch−;
  - hover.

  Een meting is 3 runs: sessie s = 400/450/500 met seed 5; eindmeting s = 420/470/520 met seed 6.
- **App** (`?sitlBench=ws://127.0.0.1:5299`, paneel *AutoTune session (SITL)* onder Tuning and apply):
  - per run de engine op dat ene log (huidige marges) plus de stap- en motormaten van `metrics.ts`;
  - de stapzoeker van de engine (`sessionSearch.ts`, vaste filters) op alle runs van de laatst geaccepteerde meting.

## Begintunes en scenario's (na de pilot vastgelegd)
| id | roll | pitch | filters | pilot (seed 4, met harnesspiloot) |
|---|---|---|---|---|
| A | 100/79/30/40 | 82/117/61/0 | basis (gyro 150/300, D-LPF firmware) | roll PM 39,7°; pitch PM 42,0°, \|S\| 6,07 dB |
| B | 88/55/45/60 | 71/82/84/0 | D-LPF 60/120 (v4-start) | roll PM 38,5°, \|S\| 6,28; pitch PM 32,4°, \|S\| 8,04, oscillatie 0,128 |
| F | 120/79/30/40 | 82/117/61/0 | basis | roll PM 33,1°, \|S\| 6,64, overshoot 17 % |

Yaw is altijd 56/79/0/0 en verandert niet (geen yaw-sweep; het yaw-P-pad wordt niet gereproduceerd).

Afgevallen in de pilot:
- **C** (roll 45/45/20/27, pitch 45/60/35/0) haalt alle doelen al.
- **E** (roll 56/79/30/40, pitch 105/117/50/0): de engine kan de roll-marges niet in band lezen, dus de begintune zou ongeldig zijn.

Deze selectie is een keuze op pilotdata en wordt zo gerapporteerd.

## Beslisregel (decision.ts; onafhankelijk herschreven in e2e_session_verdict.py)
- **Geldigheid** (anders INVALID):
  - MSP vóór het armen gelijk aan de tune; 3 runs; envelope |attitude| ≤ 45° en z ≥ 0,3 m vanaf de eerste CHIRP;
  - ≥ 3072 hoversamples per run en geen motorclip;
  - spreiding PM ≤ 1°, |S| ≤ 0,3 dB, fc ≤ 2 %, motor ≤ 15 %, tracking ≤ 5 %;
  - marges en stapmaten lezen op beide assen.
- **Onzekerheid:** u = max(spreiding basis, spreiding kandidaat). GM-ondergrens = mediaan − 2·max σ (regel v4; een onbekende σ telt als
  1,5 dB).
- **Bewakingsregels** op beide assen, elk tegenover de laatst geaccepteerde meting én tegenover de startmeting (v1.1); elke regel moet
  gelden, anders RESTORE:
  - **G1:** elke motor ≤ 1,10× tegenover de geaccepteerde tune en ≤ 1,10× tegenover de begintune.
  - **G2:** een gehaald doel blijft gehaald; PM niet meer dan 5° slechter, GM-ondergrens niet meer dan 1,5 dB, |S| niet meer dan +1 dB.
  - **G3:** overshoot ≤ basis + 0,02 + u.
  - **G4:** tracking ≤ 1,05·basis + u.
  - **G5:** r90 ≤ 1,15·basis + 2 ms + u, en fc ≥ 0,9·basis − u.
  - **G6:** oscillatie ≤ max(0,08; basis + u); |S| ≤ max(10 dB; basis + u); GM blijft beoordeelbaar als dat in de basis zo was.

  Wijziging na de pilot: begintune B oscilleert op pitch al met 0,128. Een harde grens van 0,08 zou elke stap op roll afwijzen.
- **Verbetering** op de gewijzigde as:
  - het tekort is D = max(0, 45 − PM)/5 + max(0, 6 − GM-ondergrens)/1,5 + max(0, |S| − 6)/1;
  - **V1:** D daalt ≥ 0,5 en meer dan u_PM/5 + u_GM/1,5 + u_S;
  - **V2:** een gemist doel wordt gehaald met een marge ≥ 2u.

  ACCEPT als de meting geldig is, G1–G6 gelden en V1 of V2 geldt.

## Stapbeleid (stepPolicy.ts)
- **Per stap één as.** Assen met een gemeten tekort, de grootste eerst. Na een afwijzing komt eerst een volgende kandidaat op dezelfde as,
  daarna de andere as. Pas als geen as met een tekort een toelaatbare kandidaat heeft, volgt `no_eligible_candidate`.
- **Kandidaten:** elk van P, I en D binnen ±ρ van de geaccepteerde waarde (raster 0,05). ρ begint op 0,20, halveert na een afwijzing op
  die as en verdubbelt na een ACCEPT (maximaal 0,20). Onder 0,05 volgt `step_floor`.
- **Toelaatbaar:**
  - niet binnen de helft van de afgewezen stapgrootte van een afgewezen punt;
  - voorspelde motorratio ≤ 1,10 tegenover de geaccepteerde tune én (via de gemeten verhouding geaccepteerd/begin) tegenover de
    begintune;
  - de bewakingsregels die de engine kan voorspellen gelden op de voorspelde marges tegenover de voorspelde huidige: een gehaald doel blijft
    gehaald, PM niet meer dan 5° lager, GM niet meer dan 1,5 dB lager, |S| niet meer dan 1 dB hoger en ≤ max(10 dB; huidig), en
    fc ≥ 0,92 × huidig (G5 zelf is 0,9; de marge dekt de fc-voorspelfout van de engine van 1–2 %). De stapresponsregels worden niet
    voorspeld; die beslist de hermeting. Ingevoerd na de pilot: in de rooksessie met seed 4 koos het beleid op A een stap met voorspeld
    fc 25,84 Hz (grens 25,77). Gemeten was dat 25,73 Hz bij een gemeten grens van 25,74, en G5 herstelde de stap;
  - én (a) een voorspelde daling van D ≥ 0,5, of (b) een voorspelde overgang van een gemist naar een gehaald doel. Voor (b) geldt
    geen eis aan de grootte van de daling; de gemeten V2 en de bewakingsregels beslissen.
- **Rangorde:** (a) gaat vóór (b); binnen (a) de grootste daling, dan de kleinste stap; binnen (b) de kleinste stap.
- **Stoppen:** `targets_met`, `no_eligible_candidate`, `step_floor`, budget van 5 proefstappen of 18 runs, twee INVALID na elkaar, of
  Stop.
- **Herstel en commit:** na een ACCEPT legt de bank de nieuwe hersteltune vast (`commitAccepted`, met echo-controle) vóór de volgende
  stap. Na RESTORE of INVALID volgt herstel van de geaccepteerde tune met MSP-teruglezing; een afwijkende teruglezing is een fout.

## Sessies (volgorde = uitvoering)
| id | soort | begin | test |
|---|---|---|---|
| A, B, F | gewone sessie | A, B, F | zelfstandig zoeken |
| R1 | hersteltest | A | stap 1 vooraf vastgelegd: roll D ×1,6 (d_max zelfde verhouding); budget 2 stappen |
| R2 | hersteltest na ACCEPT | A | stap 1 door de engine; stap 2 vooraf vastgelegd: roll D ×1,6 van de dan geaccepteerde tune; budget 3 |
| S1 / S2 | Stop | A | Stop tijdens run 2 van de kandidaat van stap 1 / van stap 2 (na een ACCEPT) |
| D1 / D2 | verbinding weg | A | pagina sluiten tijdens run 2 van de kandidaat van stap 1 / van stap 2 (na een ACCEPT) |

Verwachting R1/R2 (op pilot A): de motormodelvoorspelling voor D ×1,3 was ×1,11. Bij ×1,6 wordt G1 verwacht. De hermeting beslist;
een andere bewakingsregel telt ook.

## Eindmeting en verdict (e2e_session_verdict.py)
Per gewone sessie met een ACCEPT: begintune en beste tune, elk 3 runs met seed 6 en starts 420/470/520, gemeten door
`measure_tune.py`: `reference_loop.py`, `noise_metrics.py` en `step_metrics.py`. Geen GyroFlight-code.
- **C1:** elke sessie eindigt met een stopreden zonder fout. Elke set- en herstelteruglezing via MSP is gelijk aan de tune, en elke run
  leest vóór het armen de gemeten tune.
- **C2:** ≥ 1 gewone sessie met een ACCEPT die de eindmeting bevestigt: beste tegenover begin haalt G1–G6 en V1 of V2 op een gewijzigde
  as.
- **C3:** R1 en R2:
  - de vastgelegde stap is geldig gemeten en RESTORE met een G-regel als reden;
  - herstel exact teruggelezen;
  - de vastgelegde én de volgende stap rusten op de laatst geaccepteerde meting;
  - R2 heeft vóór de vastgelegde stap een ACCEPT.
- **C4:** geen gewone sessie waarvan de eindmeting de beste tune op een bewakingsregel slechter toont dan de begintune.
- **C5:** S1/S2/D1/D2:
  - één abort, helper gestopt (geen SITL meer), herstel exact;
  - de onafhankelijke MSP-lezing achteraf is gelijk aan de geaccepteerde tune (begin, of de tune van de ACCEPT vóór de onderbreking);
  - S2/D2 hebben vóór de onderbreking een ACCEPT.

PASS als C1–C5 gelden; anders FAIL, met de criteria genoemd. Of een gewone sessie spontaan een RESTORE had, wordt apart gemeld en is
geen voorwaarde. Na de definitieve runs wordt niets aangepast.
