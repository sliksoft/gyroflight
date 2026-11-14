# Autotune Engine v2: integrale overnight-ronde (WP1–WP8)

**Datum:** 24 oktober 2026
**Branch:** `feat/gyroflight-autotune-engine-v2`
**HEAD vóór:** `4ef4b5bfaaca3f5b3ee04868bcad21e4a067d0f5`
**HEAD na:** `6aa4fa7a1940e762c11a938cde8cef8a015f3fd3`
**Remote vóór:** `origin/feat/gyroflight-autotune-engine-v2` = `d50756215f73cfa23747ddd9a4bf7ed7e3caf7b9`

Uitvoering: Claude Code implementeerde en valideerde; er was steeds één implementer op deze worktree actief. Codex (`codex-cli 0.164.0`, sandbox `read-only`) deed de onafhankelijke review in drie rondes. Statuswoorden: PASS, FAIL, NOT_VALIDATED, NOT_EXECUTED.

Er is geen firmware geflasht, geen drone aangestuurd en geen echte MSP-write gedaan. Alle schrijfpaden zijn alleen getest tegen de byte-level firmware-simulator (`test/gyrocore/harness/mspFirmware.ts`) en de slider-craft-simulator (`test/gyrocore/harness/mspCraft.ts`).

Dit rapport is niet gecommit: het staat, net als de eerdere auditrapporten, in de ongetrackte map `docs/gyrocore/audit/autotune-v2/`. Het bevat geen ruwe Codex-uitvoer. De Codex-bevindingen staan hieronder in eigen woorden, met paden relatief aan de repository.

---

## 0. Samenvatting

| Onderdeel | Status | Reden |
|---|---|---|
| WP1–WP7 | PASS | Zie §2. WP3: modelafhankelijke delen NOT_VALIDATED. WP5: informatief, niet aangesloten. |
| WP8 (Codex-review) | **FAIL** | Ronde 3 vond nog 3 P0 en 1 P1. Alle vier zijn bevestigd, opgelost en getest in `241e1f05` (plus id-botsingsguard `6aa4fa7a`), maar niet meer onafhankelijk herbeoordeeld. Er is geen ronde 4: de opdracht verbiedt een eindeloze lus. Of er geen P0 meer over is, is daardoor NOT_VALIDATED. |
| Absolute Apply | **BLOCKED** | `ABSOLUTE_SAFETY_POLICY.hardwareValidated = false`; SAFETY_LOCK actief. Geen bypass. |
| Tests | PASS | 5443 ontdekt: 5429 PASS, 0 FAIL, 14 SKIP. |
| Typecheck, lint, build | PASS | Alle drie exit 0. |
| AIR65 echte logs | Gedraaid | 7 PASS, 1 FAIL (bestond al op `4ef4b5bf`), 1 SKIP (lokale schrijftool). |
| Hardwarevalidatie | NOT_EXECUTED | Verboden door de opdracht. |

Kort: de software-keten is compleet en op simulatoren getest. Absolute Apply blijft geblokkeerd tot de hardwarevalidatie. De laatste reparatieronde is niet onafhankelijk herbeoordeeld.

---

## 1. HEADs, commits en gewijzigde bestanden

| # | Commit | Werkpakket | Inhoud |
|---|---|---|---|
| 1 | `002b0847` | WP1 | Elke bevestiging (alle vier routes) vereist de hash van de read-only preview; geen voorstelwaarden meer in de gedeelde FC-store vóór de recheck; `analysisChanged` vergelijkt per index; misvormde voorstellen geweigerd; de slider-Preview hangt aan `canApply`. |
| 2 | `99477868` | WP4 | Wat een EEPROM-antwoord bewijst (`no` alleen bij een weigering van de firmware, anders `unknown`); de slider-route controleert het EEPROM-antwoord (echte bug: een weigering werd als succes gemeld); duurzame onzekere FC-toestand (`fcTransactionState.ts`) met read-only controle; alleen bruikbare en onderling consistente referenties; herhaling moet de identiteitsregels halen; bronrevisie-guard tegen verouderde runs. |
| 3 | `067950f1` | WP2 | `flightRelation`: SAME / INDEPENDENT / UNKNOWN; onafhankelijk alleen op positief sessiebewijs (`loopIteration` van het eerste frame, `Log start datetime`). |
| 4 | `4a621fe6` | WP2/WP4 | Verified Tune v3; v2-records worden met naam geweigerd. |
| 5 | `789dda1b` | WP3 | Meetonzekerheid (Bendat & Piersol), fasecontroles, kwalificatie buiten de band (×1,5), herkomst van de resolutie, meetplanner. |
| 6 | `0d2cb42a` | WP5 | Producer van de modelklasse-kwalificatie (`engine/modelQualification.ts`); informatief, niet aan Apply gekoppeld. |
| 7 | `4a4d2003` | WP6 | `safety/absoluteEvaluate.ts`: GyroCore Safety beoordeelt absolute voorstellen check voor check; autoriseert nooit zonder hardwarevalidatie. |
| 8 | `10ea58b7` | WP7 | End-to-end van Blackbox-bytes tot de write authority (14 tests). |
| 9 | `c87a5448` | WP8 | Codex ronde 1: 4 P0 + 4 P1 opgelost. |
| 10 | `83598323` | WP8 | Codex ronde 2, deel 1: Restore-scope, multi-tab, onleesbare opslag, upstream-saves. |
| 11 | `334735bc` | WP8 | Codex ronde 2, deel 2: D-pad van de kwalificatievlucht, TPA-low-sleutels, uitvoerbare planner. |
| 12 | `d3545281` | WP8 | Codex ronde 2, deel 3: PM-, GM- en staartgrenzen over de toegelaten krommen tussen bins. |
| 13 | `241e1f05` | WP8 | Codex ronde 3: één opslagsleutel per transactie, slider-profielen onbekend, herkomst van back-ups, uitvoerbaar meetplan. |
| 14 | `6aa4fa7a` | WP8 | Een pending transactie neemt nooit de sleutel van een opgeslagen entry over (id-botsing → geen SET). |

Omvang `4ef4b5bf..HEAD`: 64 bestanden, +6807 / −359 regels.

Upstream-bestanden met een kleine Gyroflight-hook (allemaal vermeld in `docs/gyrocore/UPSTREAM.md`): `src/composables/useReboot.ts`, `src/composables/pidTuning/usePidTuningMsp.ts`, `src/stores/osd.ts`, `src/composables/motors/useMotorsSave.ts`, `src/js/msp/MSPHelper.ts`.

---

## 2. Werkpakketten

| WP | Status | Kern |
|---|---|---|
| WP1 Safety hardening | PASS | Zie commit 1. Test `wp1_safety_hardening.test.ts`. |
| WP2 Vluchtonafhankelijkheid | PASS | Zie commit 3–4. Op de echte AIR65-logs: alle paren INDEPENDENT op sessiebewijs (eerste frame `loopIteration` 0, gecontroleerd tegen Betaflight `blackbox.c`). |
| WP3 Meetmethode | PASS (modelafhankelijke delen NOT_VALIDATED) | Zie §5. |
| WP4 Bewijsintegriteit | PASS | Zie commit 2 en de WP8-rondes. |
| WP5 Modelkwalificatie | PASS (informatief, niet aangesloten) | Zie §6. |
| WP6 Absolute Safety | PASS (evaluator); absolute Apply BLOCKED | Zie §7. |
| WP7 End-to-end | PASS | 14 tests vanaf gedecodeerde BBL-bytes. |
| WP8 Review | FAIL (ronde-3-reparaties niet herbeoordeeld) | Zie §3 en §9. |

---

## 3. Opgeloste problemen

**WP8 ronde 1 (commit `c87a5448`)**
- P0: een Restore van één profiel wiste de onzekere toestand van elk profiel → entries dragen `id` en `profiles`.
- P0: het slot dekte de upstream-saves van de gedeelde FC-store niet → hooks in de PID-tab-save, `saveToEeprom`, `saveAndReboot` en de OSD-save.
- P0: vier hoekpunten waren geen grens over de onzekerheidsverzameling → rigoureuze intervalgrenzen.
- P0: de plant van een kwalificatievlucht kon op een niet-gevalideerd D-pad rusten → D-pad-acceptatie vereist.
- P1: bins met grote onzekerheid verdwenen in de band; de onzekere toestand werd te laat vastgelegd; modelinvoer ontbrak in de configuratievergelijking; de planner vroeg om herhalingen die de analyse niet combineert.

**WP8 ronde 2 (commits `83598323`, `334735bc`, `d3545281`)** — alle twaalf bevindingen nagelopen tegen de code; de drie grenzen-tegenvoorbeelden eerst als falende test gereproduceerd.
1. P0: Restore wiste elke pending entry van de craft en slider-entries zonder profielbinding → een Restore dekt alleen entries van dezelfde route waarvan de profielen bekend zijn en precies het herstelde profiel zijn; de slider-route legt het profiel vast waarop hij begon (vervangen in ronde 3, zie hieronder).
2. P0: een Restore schreef via EEPROM ook het onzekere RAM van andere profielen weg → Restore wordt geweigerd zolang de craft een entry heeft die hij niet dekt (`restore:uncertain_state_not_covered:...`).
3. P0: de back-up die een herstel-Restore van de onzekere toestand maakt, bleef een Restore-doel → gemarkeerd `unverified`, door beide routes geweigerd (`restore:backup_unverified`), niet meer in de panelen.
4. P0: een ander tabblad kon het duurzame slot omzeilen of overschrijven → elke controle en wijziging leest eerst de opslag; een `storage`-event ververst de panelen.
5. P0: een Restore kon onleesbare opslag overschrijven → onleesbare opslag wordt nooit overschreven en weigert ook Restore.
6. P0: de Motors-save stuurde het filterblok vóór elke guard; de vertraagde EEPROM-write van `saveAndReboot` keek niet opnieuw → guard vóór de eerste SET van de Motors-save, en opnieuw vlak vóór `MSP_EEPROM_WRITE`.
7. P0: PM was een interpolatie, geen ondergrens (√2/(jω(1+jω)) op bins 0,9 / 1,1 gaf 45,047° bij een echte 45°) → laagste PM van elk punt op de eenheidscirkel binnen de tussen-bin-toelage van een koorde (`capsulePmBound`).
8. P0: GM kon een toegelaten fasekruising missen (0,65∠−179° / 0,55∠−179°) → een stap telt als kruising zodra zijn toegelaten krommen de negatieve reële as kunnen raken.
9. P0: de staartstijging werd alleen nominaal getoetst (vlakke −12 dB-staart met ±10 % steeg 1,74 dB) → worst-case kleinste-kwadratenstijging over de gain-intervallen per bin.
10. P0: ontbrekende D-headers omzeilden de D-padcontrole van de kwalificatie → bij D > 0 alleen met gereconstrueerd én gevalideerd D-pad.
11. P1: `tpa_low_rate` / `tpa_low_breakpoint` / `tpa_low_always` ontbraken in de configuratievergelijking → toegevoegd, plus een test die elke header wijzigt die de controller- en D-reconstructie lezen.
12. P1: de planner vroeg om een primair FFT-segment dat de analyse niet kan maken → begrensd tot het segment van de standaardanalyse; een fijnere behoefte wordt een diagnose en gaat naar de kwalificatie.

**WP8 ronde 3 (commit `241e1f05`)** — alleen de delta van ronde 2 beoordeeld. Bevestigd en opgelost, maar niet meer door Codex herbeoordeeld.
1. P0: de slider-route legde het beginprofiel vast als het enige getroffen profiel, maar controleert het profiel tijdens het schrijven niet opnieuw. Een wissel tijdens zijn reads kon de SET in een ander profiel zetten; een Restore van het beginprofiel zou dan het RAM van het andere profiel wegschrijven. → Slider-entries noemen geen profiel; geen Restore dekt ze.
2. P0: twee tabbladen die allebei een lege lijst lazen, konden elkaars pending entry overschrijven. → Elke entry heeft een eigen sleutel (`gyroflight.fcTransactionState.v2.<id>`). Een pagina schrijft en verwijdert alleen de sleutels van zijn eigen transacties. Oplossen verwijdert een sleutel alleen zolang die nog de gedekte waarde bevat. Het oude lijstformaat wordt bij het lezen overgezet.
3. P0: `before_restore`-back-ups van vóór de nieuwe vlag konden nog onzekere waarden bevatten en bleven Restore-doel. → Back-ups leggen `stateKnown` vast; een `before_restore` zonder die vastlegging wordt geweigerd (`restore:backup_provenance_unknown`).
4. P1: de planner koos een kleiner primair segment dan de import gebruikt (verblijftijd tot 16× te kort berekend). → De primaire verblijftijd wordt gepland op het segment van de standaardanalyse.
5. Restrisico "id-botsing NOT_VALIDATED" van ronde 2: ids zijn een tijdstempel in milliseconden plus 32 willekeurige bits (`crypto.getRandomValues`). `recordPending` weigert bovendien een id dat al is opgeslagen: dan geen SET (`6aa4fa7a`, test plus mutatie M62).
6. Restrisico van Codex, ook opgelost: `checkTransactionState` meldde "bekend" terwijl een ander tabblad tijdens de reads een entry toevoegde. Het meldt die nu (`changed_during_check`).

Ronde 3 gaf PASS op: de PM-capsule-scan, de afstand tot de halve as, de tekenlogica van de staart, het D-pad, `tpa_low_*`, de Motors-guard en de vertraagde EEPROM-guard, en de onleesbaar-latch.

Mutatiecontroles M56–M61: allemaal gevangen, behalve M60. M60 vervangt het geheugenbeeld na een eigen schrijfactie. Dat is equivalent voor de routes, omdat elke route eerst opnieuw leest; het paneel ziet het pas bij de volgende synchronisatie.

Elke reparatie kreeg mutatiecontroles: M1–M38 (WP1–WP8 ronde 1) en M39–M55 (ronde 2). Alle gevangen, op twee na:
- M11 vond een overbodige controle; die is verwijderd.
- M49 (één sleutel uit `PLANT_CONFIG_KEYS`) is een equivalente mutant: die sleutel wordt ook via de absolute waarden vergeleken.

Bovendien liet M45 eerst een gat zien: de upstream-save las de opslag niet zelf. Daar is een test voor toegevoegd; daarna werd M45 gevangen.

---

## 4. Open problemen

**P0:** geen bekend. Codex ronde 3 vond 3 P0; alle drie zijn opgelost in `241e1f05`, met tests en mutatiecontroles. Een onafhankelijke herbeoordeling van die reparaties ontbreekt (NOT_VALIDATED). Absolute Apply is ongeacht dit punt geblokkeerd.

**P1**
- Slider-route-entries noemen geen profiel (ronde 3). Een onzekere slider-write heeft daardoor geen Restore-herstel; alleen de read-only controle na een power cycle helpt, en alleen bij saved `no`. De slider-Apply wordt vandaag al door Safety geweigerd.
- Entries waarvan de profielen onbekend zijn, of die een profielwissel over twee profielen kan hebben verspreid, dekt geen enkele Restore. Zolang zo'n entry open is, weigert Restore. Er is dus geen software-herstelpad: fail-closed, herstel via reflash of handmatig buiten Gyroflight.
- Oudere `before_apply`-back-ups (van vóór `stateKnown`) blijven Restore-doel. Met de code van toen kon zo'n back-up na een mislukte write zijn genomen.
- De CLI-opdracht `save` en presets lopen niet langs het slot.
- De slotopslag zit per browser. Een ander apparaat of een andere browser ziet het slot niet.

**P2**
- Tests die de positieve schrijfpaden oefenen (WP4, WP7), vervangen bewust binding, release, Safety en product lock door een harness. Codex markeerde dit als TESTS_MATCH_PRODUCTION = FAIL. Het is geen bypass in productie, maar deze tests bewijzen het samenspel met de echte gates niet.
- De CRC-simulator geeft een antwoord met foutvorm, terwijl de echte `MSP.promise` verwerpt.
- Twee testbestanden (`bundled_icons.test.ts`, `web_only_fixes.test.ts`) faalden één keer onder belasting; los en bij herhaling slagen ze.
- De bekende AIR65-test `air65_autotune.local` "records what Betaflight Autotune shows…" faalt al op `4ef4b5bf` (TypeError, `numericsOnViewerSamples` is null). Niet door deze branch veroorzaakt; niet opgelost.

**Eerste vervolgstap:** een Codex-review alleen van `241e1f05..6aa4fa7a`. Dat is de grootste hoeveelheid slotcode die nog geen enkele review heeft gezien.

**Methodisch (geen code-fout)**
- Met één exponentiële sweep is de kwalificatie praktisch niet haalbaar: in de gedecodeerde simulatie is de fijne analyse maar in ±62 % van de bins coherent (eis 80 %).
- Drempels (stapgrenzen, `BIN_SAGITTA`, `PLAN`, `MAX_REPEAT_TOLERANCE_FACTOR`) zijn niet gekalibreerd tegen herhaalde echte vluchten.
- Met één middeling per bin rond de crossover (AIR65) is de tussen-bin-toelage na ronde 2 breed: PM-grenzen zakken flink of verdwijnen (synthetisch voorbeeld: γ² = 0,998 geeft een PM-grens van 33° bij een aflezing van 86,7°). Dat is eerlijker, maar de echte vlucht moet langer meten (planner: 7–16 middelingen).
- Hardware: NOT_EXECUTED.

---

## 5. Meetarchitectuur: waarom zo

- **Eén bron van waarheid voor de schrijfbeslissing.** Elke Apply- en Restore-route gaat door dezelfde write authority. De volgorde blijft Composite → Safety → product lock → live readback → live recheck. Het meetwerk kan Apply dus nooit openzetten, alleen bewijs aanleveren.
- **Onafhankelijkheid alleen op positief bewijs.** Twee logs zonder gedeeld sample zijn daarom nog geen twee vluchten. Pas het eerste frame van een opnamesessie (`loopIteration` 0) of een starttijd bewijst een nieuwe sessie. UNKNOWN telt nooit als referentie, kwalificatie of herhaling.
- **Grenzen in plaats van aflezingen.** PM, GM en |S| worden als grens berekend over elke lus die het bewijs toelaat:
  - per bin de Bendat & Piersol-fout van de H1-schatting, doorgegeven naar L, met dekking k = 2;
  - tussen de bins elke kromme binnen de toelage van de koorde (`BIN_SAGITTA`).

  Na ronde 2 geldt dat ook voor PM, de GM-kruisingskeuze en de staart. Zonder dat bewijs blijft het oordeel `MEASURED`.
- **Kwalificatie buiten de eigen meting.** Of de modelklasse klopt (geen smallere features dan de bins kunnen tonen), kan de vlucht zelf niet laten zien. Daarvoor is een tweede, onafhankelijke vlucht nodig die fijner is (×`RESOLVED_FEATURE_BINS`) en verder reikt (×1,5 band) en dezelfde configuratie heeft.
- **Planner.** Hij zet de bewijsgaten om in getallen die de piloot kan instellen: band, resolutie, segment, sweepduur en middelingen. Hij vraagt nooit om iets wat de analyse niet doet, zoals herhaalde sweeps poolen of een groter primair segment.

---

## 6. Status modelkwalificatie

- **Producer:** `engine/modelQualification.ts`, negen criteria. Het resultaat staat in `store.qualification` met `connectedToApply: false`.
- **Simulatie:** een fijnere onafhankelijke vlucht kwalificeert de grenzen (PASS per criterium). `model_structure` blijft NOT_VALIDATED: een aanname wordt versmald, nooit weggenomen.
- **Echte AIR65-logs:**
  - de fijne analyse kan (0,244 Hz bij K = 8), maar geen as is bruikbaar als bron;
  - roll en pitch zijn afgekeurd;
  - yaw is `usable_with_warnings`, maar `MEASURED` door de onzekerheid.

  Resultaat: geen kwalificatie (NOT_VALIDATED).
- **Aansluiting op Apply:** niet aangesloten, conform de opdracht. De veiligheidsketen kan dat nog niet dragen: zie §7.

---

## 7. Status absolute Apply-veiligheid

| Check (`safety/absoluteEvaluate.ts`) | Status |
|---|---|
| validated_starting_configuration, absolute_values_in_range, plausible_step, dynamic_margins, fc_identity_binding | Geïmplementeerd en getest; uitkomst per voorstel |
| live_recheck, human_confirmation | PASS (route-eigenschap, simulator) |
| rollback | NOT_VALIDATED (alleen simulator) |
| hardware_validation | NOT_EXECUTED |

- `ABSOLUTE_SAFETY_POLICY.hardwareValidated = false`. Daardoor geeft elke evaluatie `absolute_safety:not_hardware_validated`.
- **ABSOLUTE_APPLY = BLOCKED. SAFETY_LOCK actief.** De product lock blokkeert daarnaast.
- Er is geen bypass of demo-uitzondering toegevoegd.
- Een gecontroleerde test met Safety vrijgegeven via harness (WP7, deel 2) laat zien dat de rest van de keten dan werkt. Die vrijgave bestaat alleen in de test.

---

## 8. Tests en skips

| Controle | Resultaat |
|---|---|
| Volledige suite (`npx vitest run`, op `6aa4fa7a`) | 356 bestanden (348 PASS, 8 overgeslagen); 5443 tests: 5429 PASS, 0 FAIL, 14 SKIP |
| Skips | De AIR65-tests op echte logs en lokale tools; zonder lokale data slaan ze over |
| `npm run typecheck` / `npm run lint` / `npm run build` | PASS / PASS (exit 0) / PASS (exit 0) |
| Prettier, ESLint, typecheck in de pre-commit-hook | PASS bij elke commit |

Aangepaste testverwachtingen in ronde 2. Niets is verwijderd of versoepeld om groen te worden; elk geval staat in de commitboodschap van `d3545281`.
- Vier tests gingen ervan uit dat een grens zonder meetfout gelijk is aan de aflezing. Ze vergelijken nu de nominale waarden en eisen dat de grens niet beter is dan de aflezing of de referentie.
- Eén tolerantie (het verschil met de referentie op het grofste raster) ging van 1° naar 2°. Er kwam een eis bij dat de grens nooit boven de referentie ligt.
- Een test met γ² = 0,99 verwacht nu terecht geen grenzen (`MEASURED`). Het tellen van de weggelaten bins wordt rechtstreeks getest via `binsDroppedForUncertainty`.

Aangepaste testverwachtingen in ronde 3:
- De herstel-Restore van de slider-route wordt nu geweigerd.
- De planner-test eist het segment van de standaardanalyse.

AIR65 (echte logs): de data waren lokaal aanwezig en de hashes zijn gecontroleerd (drie bestanden). De lokale AIR65-tests zijn werkelijk gedraaid: op `241e1f05`: 9 tests, 7 PASS, 1 FAIL, 1 SKIP.
- FAIL: `air65_autotune.local` "records what Betaflight Autotune shows…" (TypeError, `numericsOnViewerSamples` is null). Faalde al op een schone export van `4ef4b5bf`; niet door deze branch.
- SKIP: `write_merge_e2e_logs.local` is een lokale schrijftool zonder doelmap, geen datatest.

Het end-to-end-resultaat op de echte logs (`air65_autotune_v2.local`) is PASS: beide CHIRP-vluchten zijn geanalyseerd, de gyroketen is gevalideerd en elk onbewezen deel blijft geblokkeerd.

---

## 9. Codex

| Ronde | Op | Uitkomst | Afhandeling |
|---|---|---|---|
| 1 | `10ea58b7` | FAIL: 4 P0, 4 P1 | Alles bevestigd en opgelost in `c87a5448` |
| 2 | `c87a5448` | FAIL: 10 P0, 2 P1 | Alles bevestigd en opgelost in `83598323`, `334735bc`, `d3545281` |
| 3 | `d3545281` (alleen de ronde-2-delta) | FAIL: 3 P0, 1 P1 | Alles bevestigd en opgelost in `241e1f05`; niet herbeoordeeld (geen ronde 4) |

- Elke ronde draaide read-only.
- HEAD en `git status` waren vóór en na elke ronde gelijk.
- De eerste start van ronde 2 draaide niet: Codex wachtte op invoer tot de time-out. Die is herstart.
- Ronde 2 bevestigde als PASS:
  - de geometrie van de sector (hoekomslag, projectie, `cos(span/2)`);
  - dat PM/GM-`min` en |S|-`max` nooit beter zijn dan nominaal;
  - het opruimen in de prepare-fase.
- Ruwe Codex-uitvoer is niet gecommit.

---

## 10. GitHub-back-up

- Vóór de push: `git fetch` bevestigde `origin/feat/gyroflight-autotune-engine-v2` = `d5075621` (het verwachte uitgangspunt; fast-forward).
- De hele gepubliceerde reeks `d5075621..HEAD` (diff en commitboodschappen) is gescand op lokale paden, sleutels en ruwe Codex-uitvoer: niets gevonden.
- `git push origin feat/gyroflight-autotune-engine-v2`: `d5075621..6aa4fa7a`.
- `git ls-remote` daarna: `6aa4fa7a1940e762c11a938cde8cef8a015f3fd3`. **PUSHED.**

Geen merge, geen PR, geen force-push, geen rebase.

---

## 11. Software- versus hardwaregereedheid

| Laag | Status |
|---|---|
| Software-keten (analyse → bewijs → release → Safety → product lock → route) | Compleet en getest op simulatoren; de laatste reparatieronde is niet onafhankelijk herbeoordeeld |
| Absolute Apply | BLOCKED: wacht op hardwarevalidatie (`AUTOTUNE_V2_HARDWARE_PROCEDURE.md`) |
| Hardwarevalidatie | NOT_EXECUTED (verboden in deze opdracht) |
| Meetbewijs op echte AIR65-data | NOT_VALIDATED: roll/pitch afgekeurd, yaw `MEASURED`; een langere sweep is nodig |

---

## 12. Acceptatiecriteria

| Criterium | Status |
|---|---|
| Absolute Apply niet vrijgegeven zonder een geteste, geschikte Safety-validator | PASS: de validator is geïmplementeerd en getest; hij geeft nooit vrij zonder hardwarevalidatie |
| Producer niet op Apply aangesloten zonder bewezen volledige keten | PASS: `connectedToApply: false` |
| Geen bypass of kunstmatige PASS | PASS |
| Gate-volgorde Composite → Safety → product lock → live readback → live recheck | PASS (ongewijzigd, getest) |
| Geen tests verwijderd of versoepeld om groen te worden | PASS: aanpassingen staan in §8, met reden |
| AIR65 alleen PASS genoemd waar data en tests echt draaiden | PASS |
| Onafhankelijke review zonder resterende P0 | NOT_VALIDATED: ronde 3 vond P0's; opgelost, niet herbeoordeeld |
| Hardwarevalidatie | NOT_EXECUTED |
| Geen merge, geen PR | PASS |

---

## 13. Overige

- GitNexus: de index van deze worktree is hersteld. Oorzaak was een verouderde parse-cache; herindexeren met `--force --no-parse-cache` loste het op. Daarna werkt `impact` weer, maar enkele symbolen worden nog niet opgelost: `applyAbsoluteTune`, `analysisBindingIssues`. Alleen de registry-entry van deze worktree is gewijzigd. Op `6aa4fa7a` opnieuw geïndexeerd (`--index-only`). `AGENTS.md` is ongewijzigd en alleen de registry-entry van deze worktree is aangepast. `impact` werkt voor `uncertainBounds` en `restoreTargetIssue`; `resolveByRestore` heeft twee kandidaten (UNKNOWN).
- `.serena/` en de ongetrackte auditdocumenten zijn niet aangeraakt. De hoofdrepository, de WU6-branch en andere worktrees zijn niet aangeraakt.
