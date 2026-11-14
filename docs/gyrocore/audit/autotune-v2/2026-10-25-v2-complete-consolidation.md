# Gyroflight v2: consolidatie, hardwaregereedheid en stand van Autotune

**Datum:** 2026-10-25
**Branch:** `feat/gyroflight-autotune-engine-v2`
**HEAD vóór deze opdracht:** `6aee384edf5c050375273995ec8d61733ba3b965`
**HEAD na deze opdracht:** de commit die §16 invult (zie `git log`); beoordeelde inhoud `71af5bc5`

## 0. Samenvatting

Gyroflight v2 is softwarematig geconsolideerd en staat op GitHub, maar is geen afgerond Autotune-product.

- **WP8 blijft intact.** De baseline staat vast op `6aee384e`.
- **Absolute Apply blijft BLOCKED.**
- **Hardware is NOT_EXECUTED.** Er is geen enkele fysieke handeling verricht.
- **De keten werkt van Blackbox-bytes tot de Apply-gate en stopt veilig.**
  - Elke stap levert een benoemde reden.
  - Er wordt niets gevalideerd op basis van één vlucht.
  - Op de echte AIR65-logs wordt niets vrijgegeven.
- **Nieuw in deze opdracht** (dekking en één tekstfout, geen nieuwe analysefuncties):
  - een end-to-end-test die twee craft-klassen elk tegen hun eigen analytische waarheid toetst;
  - tests voor eerder ongeteste veiligheidscontroles (fase-unwrapping, filterstatussen);
  - een ontbrekende gebruikerstekst voor een meetverzoek;
  - een volledig herschreven hardwareprocedure.

**De belangrijkste inhoudelijke bevinding: de meetresolutie past zich niet aan de craft aan.**
- De analyse kiest het Welch-segment alleen op samplerate. Dat geeft ongeveer 1,95 Hz per bin, voor elke craft.
- Een 7-inch-achtige craft met een crossover rond 7 Hz komt daardoor niet verder dan `MEASURED`.
- Die craft krijgt een meetplan met een sweep van ongeveer 235 s.
- De software zegt dit eerlijk. De oplossing is echter een aparte wijziging in het releasepad (§6).

## 1. Werkwijze en grenzen

- **Werkomgeving.** Gewerkt in `/…/Gyroflight-worktrees/autotune-engine-v2`, met maximaal één implementer.
- **Leesagenten.** Drie read-only agenten deden de inventarisatie (§5). Daarbij is niets gewijzigd.
- **Codex** is alleen gebruikt als read-only reviewer: `codex exec -s read-only --ephemeral`, CLI 0.164.0, op een losse detached worktree.
- **Niet gedaan:**
  - geen hardware aangestuurd, geen firmware geflasht, geen MSP-write, geen motorcommando;
  - geen merge, geen PR, geen force-push, geen rebase;
  - geen wijziging in VliegAI of in andere worktrees;
  - geen dependency-upgrade.
- **Alleen gelezen.** Echte AIR65-logs buiten de repository (§9.2) zijn alleen gelezen. Er is niets naar die mappen geschreven.
- **Ongemoeid gelaten:** `.serena/`, de ongetrackte ruwe auditbestanden en `AGENTS.md`. `AGENTS.md` heeft GitNexus deze keer niet gewijzigd; dat is na elke `analyze` gecontroleerd.

### GitNexus

| Moment | Resultaat |
|---|---|
| `analyze --index-only` | twee keer gedraaid; `AGENTS.md` bleef ongewijzigd |
| `detect-changes`, docs-commit `d3f39ee2` | risk low |
| `detect-changes`, `22efe859` | risk low |
| `detect-changes`, `416341b5` | "no indexed symbols overlap those hunks — not a clean tree": de index liep één commit achter. Na een nieuwe `analyze` is het bereik opnieuw gecontroleerd (zie hieronder) |
| `detect-changes`, `d10c3433` | **risk CRITICAL**, 290 processen. De diff bestaat alleen uit twee nieuwe testbestanden. Het risico komt doordat namen in de tests (`FILTER_PARTS`, de properties `chirp` en `channels`) op naam aan productieflows gekoppeld worden. Met een tekstzoekopdracht bevestigd: `FILTER_PARTS` komt in `src/` niet voor. Er is geen productiecode geraakt |
| `detect-changes`, `a4555b5f` | alleen documentsecties; geen processen |

`impact` is niet gedraaid: de enige gewijzigde productieregel is een JSON-locale-sleutel, en daar maakt GitNexus geen
symbool van. Er is geen functie, klasse of methode gewijzigd.

## 2. Fase A — repository en GitHub-back-up

### Preflight vóór de push

| Controle | Resultaat |
|---|---|
| Branch en HEAD | `feat/gyroflight-autotune-engine-v2` op `6aee384e…`, zoals verwacht |
| Remote | `origin/feat/gyroflight-autotune-engine-v2` op `6aa4fa7a`. Dat is een voorouder van HEAD: 50 commits vooruit, 0 achter. Geen onverwachte remote-commits |
| Werkboom | alleen `?? .serena/` en `?? docs/gyrocore/audit/autotune-v2/` |
| Andere sessies | één andere Claude-sessie, in `VliegAI/training`. Geen overlap |
| Secrets in de 50 unpushte commits | geen sleutels, tokens, e-mailadressen of `/home/`-paden. "token" komt alleen voor als de bevestigingstokens in de tests |
| Binaire bestanden | geen, in de commits noch in de 262 auditbestanden (`file --mime-type`: JSON, tekst en één shellscript) |

**Publicatie.**
- `origin` is publiek. Daarom zijn alleen rapporten en reviewteksten gepubliceerd waarin geen enkel lokaal pad, e-mailadres of sleutel voorkomt.
- Vier rapporten met een lokaal pad zijn als `redacted/`-kopie gepubliceerd. De originelen blijven ongetrackt; hun SHA-256 staat in `README.md`.
- **Correctie na de integrale review.** De scan vóór de push zocht alleen naar `/home/`. In de gepubliceerde kopie `redacted/2026-10-23-autotune-v2-recovery-validation-audit.md` (regels 51 en 273) stond daardoor nog een Windows-pad met een gebruikersnaam (`/mnt/c/Users/<naam>/…`); dat zit in de gepushte commit `d3f39ee2`.
  - In de volgende commit is het vervangen door `<windows-home>`.
  - Uit de geschiedenis gaat het niet weg: geen force-push of rebase, conform de opdracht.
  - Hetzelfde pad stond al vóór deze opdracht publiek in de getrackte testfile `test/js/air65_yaw_open_loop_offline.test.ts:47` (sinds `b9f7fe03`; eerder als P2-3 gemeld). Die regel is niet gewijzigd. Op deze machine bestaat het bestand en draait die test echt op de AIR65-log, dus het pad weghalen zou die real-log-dekking stil in een SKIP veranderen. Dit blijft een open privacypunt (§13).
  - De bredere scan van alle gepubliceerde auditbestanden toont verder alleen scratchpaden in de oudere, al getrackte `docs/gyrocore/audit/wu4/agentC_report.md` en `agentD_report.md` (niet door deze opdracht toegevoegd).
- Ruwe sessielogs, prompts, exit-bestanden, manifests en testlogs zijn lokaal gebleven.
- De pre-commit-hook (prettier) herformatteerde zes JSON-bewijsbestanden. Die zijn teruggezet naar hun originele bytes en daarna gecommit. Alle 70 bestanden zijn gecontroleerd byte-gelijk aan het origineel.

**Push.**
- `d3f39ee2` is als fast-forward gepusht (`6aa4fa7a..d3f39ee2`, zonder force).
- `git ls-remote` gaf daarna exact `d3f39ee2`.
- De latere completion-commits zijn gepusht volgens §15.

## 3. Fase B — WP8 definitief

Baselinedocument: `2026-10-25-wp8-software-baseline.md`, met code-checkpoint `6aee384e`.

| Controle | Bevinding |
|---|---|
| F01–F10 | CLOSED: Codex-integratiereview APPROVE op `af372bfb`; geen latere wijziging aan die code |
| Laatste transport-P2 | CLOSED: Codex APPROVE 0/0/0 op `6aee384e` |
| Centrale write-guard | ongewijzigd: `withFcWriteLock` (`src/composables/fcWriteGuard.ts`), `fcWriteLease` |
| WebSerial | sluiten is bewezen per verbinding (`TransportLink`: CLOSED_CONFIRMED pas na `port.close()`) |
| WebBluetooth | faalt dicht: gesloten pas als GATT down is én alle writes zijn afgerond, anders `false` en bezet |
| WebSocket | telt mee als bezet tot CLOSED |
| Cross-tab | alleen samenwerkende tabs van dezelfde origin in hetzelfde profiel |
| Absolute Apply | BLOCKED (`absoluteEvaluate.ts:64`, `:180`) |
| Hardwareclaim | geen |

**Hervalidatie op `6aee384e`.**
- Volledige suite: 5719 PASS / 3 FAIL / 14 SKIP. De 3 fouten zijn time-outs onder parallelle belasting door drie agenten. Apart gedraaid: 17/17 PASS.
- Lint, typecheck en build: exit 0.
- Browsertest: 27/27 PASS.

**Beperkingen die blijven:**
- geen MSP-request-id: na een verloren antwoord meldt elke latere save "unknown" tot er opnieuw verbonden wordt;
- een BLE-write die nooit afrondt, houdt de pagina bezet;
- Apply of Check kan bij live BLE-polling vertragen of op `fc:write_lease_timeout` uitkomen (NOT_VALIDATED);
- Web Bluetooth is niet in een browser getest;
- de herverbinding over de open gehouden BLE-verbinding is niet end-to-end getest;
- Tauri en Capacitor vallen buiten WP8.

## 4. Fase C — hardwaregereedheid

`docs/gyrocore/AUTOTUNE_V2_HARDWARE_PROCEDURE.md` is herschreven en is niet uitgevoerd.

**Opbouw.**
- **Klasse R (read-only):** tien tests, H-R1–H-R10. Ze dekken:
  - boardidentificatie (AIR65, `BETAFPVG473`, UID tegen de logheader);
  - firmwareversie (Betaflight 2026.6.2, API 1.48);
  - logcompatibiliteit (`PLANT_CONFIG_KEYS`, CHIRP-headers, SHA-256);
  - WebSerial verbinden en verbreken;
  - MSP-readback tegen `diff all`;
  - identiteitsbinding;
  - backup-download;
  - statuspolling met de write-lease (Check neemt de lease, de preview niet);
  - de melding over onzekere toestand;
  - Web Bluetooth, alleen met een BLE-bridge en anders N/A.
- **Klasse W (vereist per test aparte toestemming):** elf tests, H-W1–H-W11. Ze dekken:
  - EEPROM-bevestiging en terugdraaien;
  - reboot en reconnect;
  - CLI-modus;
  - write-lease tussen tabs;
  - geweigerde of vertraagde retry;
  - onderbroken verbinding;
  - verloren antwoord (N/A zonder MSP-proxy);
  - kept-link-reboot over BLE;
  - Gyroflight-Restore;
  - herstel uit onzekere toestand.
- **Per test** staan erbij: benodigde hardware, voorwaarden, verwachte uitkomst, veiligheidsvoorwaarden, wat als PASS-bewijs telt, en wanneer direct afgebroken moet worden.
- **Klasse A (Absolute Apply):** vier tests, H-A1–H-A4. Ze staan als BLOCKED vermeld, zodat de acceptatie die de blokkade zou opheffen vooraf vastligt.
- **De bekende WP8-beperkingen** zijn als expliciete testgevallen opgenomen: H-R8, H-W8 en H-W9.

**Correcties tijdens het schrijven.**
- H-R8 noemde eerst de preview als route die op `fc:write_lease_timeout` kan uitkomen. `previewAbsoluteTune` neemt de lease echter niet; `checkTransactionState` wel (`useTuneApply.ts:1368`). De test is daarop aangepast.
- De browsereis "Chromium ≥ 120" is vervangen door "Chromium met Web Serial, versie vastleggen", omdat het versienummer niet onderbouwd was.

## 5. Fase D — gap analysis (20 onderdelen)

Legenda voor de kolom "Tests":
- **echt:** echte AIR65-logs, alleen lokaal;
- **synth:** synthetische fixtures of bytes;
- **sim:** byte-level firmwaresimulator;
- **mock:** gemockte transport- of gate-laag.

| # | Onderdeel | Bestaat | In UI | Tests | Bewezen | Ontbreekt / beperking |
|---|---|---|---|---|---|---|
| 1 | Blackbox-decoder | ja: Blackbox Viewer (`src/blackbox-viewer/flightlog*.js`), `logInput.ts:106`, `chirp/headers.ts` | `AutotuneImport.vue`, `AutotuneV2Panel.vue` | synth (bit-exact) en echt (§9.2) | decode bit-exact op synthetische logs; op echte AIR65-logs gelijk aan GyroCore's eigen decode | alleen één craft en firmware (AIR65, 2026.6.2, 4 kHz); debug-mode-tabellen tot API 1.49 |
| 2 | CHIRP-extractie | ja: `chirp/extraction.ts:309`, `qualification.ts:367` | `ChirpQualificationPanel.vue` | synth (20 WU7-fixtures, golden) en echt | segmenten gelijk aan GyroCore; herhaalde assen behouden; faalt dicht bij een verkeerde debug-mode | qualityV2-semantiek niet op AIR65 gecontroleerd; geen contaminatiedetector |
| 3 | FFT / Welch | ja: `spectral_analysis.ts:102` (H1, Hann); `chooseSegmentSize` (`useAutotune.ts:203`); `finestWelchSegment` (`logInput.ts:100`) | ja | synth (upstream-parity), echt | numerieke parity met upstream en GyroCore | segment hangt alleen van samplerate af (§6) |
| 4 | Frequentieresolutie | ja: `LOOP_RESOLUTION`, `RESOLVED_FEATURE_BINS`, `BAND_END` (`loopModel.ts:141–227`) | resolutie en feature-breedte getoond | synth | te grove of gatenrijke banden worden geweigerd; smalle pole/zero-paren nooit VALIDATED | resolutie past zich niet aan (§6); 25° / 4,5× / −6 dB alleen op AIR65 / M5-A gecalibreerd |
| 5 | Coherentie | ja: in de Welch-H1; grenzen 0,5 / 0,6 / 0,8 / 0,9 | ja | synth | lage coherentie wordt geweigerd en vergroot de onzekerheid | grenzen niet over craft-klassen gecalibreerd; op AIR65 coherentie 0,17–0,59 en alle sweeps afgewezen |
| 6 | Fase-unwrapping | ja: `PHASE_CHECKS`, `phaseIssues` (`loopModel.ts:263`, `:827`) | als redencode | synth; **nieuw:** `v2_phase_unwrap` | verkeerde tak blokkeert; minder dan 3 bins per octaaf blokkeert; **nieuw:** een stap > 90° geeft `phase_unwrap_ambiguous` en geen grenzen | 90° is een ontwerpparameter |
| 7 | Plantmodel | ja: `extractPlantFromClosedLoop`, `buildAxisLoop`, cross-log (`betaflight_open_loop.ts:876`, `autotuneV2.ts:515`) | onderdeel `plant_identification` | synth, echt (lokaal) | onafhankelijkheid, configuratiegelijkheid, worst case, onenigheid geeft FAIL; **nieuw:** crossover binnen de gerapporteerde resolutie van de analytische waarheid, voor twee klassen | herkomst van de tolerantie 0,35 niet gedocumenteerd; de lokale v2-test vereist een tweede log (BBL19) die op deze machine ontbreekt |
| 8 | Modelkwalificatie | ja: `modelQualification.ts:175`, `qualifyModelClass` (`loopModel.ts:1254`) | onder de marges, informatief (`connectedToApply: false`) | synth | een onafhankelijke, fijnere vlucht verheft MODEL_CONDITIONAL tot VALIDATED; elke onjuiste bron wordt geweigerd | VALIDATED alleen met synthetische logs bereikt; op AIR65 kan geen vlucht dienen; `model_structure` altijd NOT_VALIDATED |
| 9 | Gain margin | ja (`loopModel.ts:959–990`) | margetabel | synth | GM alleen bij een begrensd bandeinde; GM ≤ de headroom aan het bandeinde | geen echte-vluchtvalidatie |
| 10 | Phase margin | ja (`loopModel.ts:904–928`, capsule-grens) | margetabel | synth, echt (alleen MEASURED) | PM binnen 0,3° van de analytische waarde; negatieve PM gedetecteerd; **nieuw:** AIR65-achtig binnen 3° van de waarheid | dyn-notch- en RPM-fase niet begrensbaar uit de headers; D_max en iterm_relax niet-lineair |
| 11 | Sensitiviteit \|S\| | ja (`loopModel.ts:992–1019`) | margetabel | synth | een bandbegrensde piek geeft "unknown", geen grens | idem |
| 12 | PID-berekening | ja: `pidOptimizer.ts` (PM 45°, GM 6 dB, \|S\| 6 dB, ±30 %, Verified-Tune-segment) | PID-tabel en Apply | synth en sim (gates gemockt als vrijgegeven) | verandering alleen VALIDATED met VALIDATED marges; met een record alleen punten op het segment | in de product-UI nooit vrijgeefbaar (Safety blokkeert); `SCALES` en `MAX_STEP` vast |
| 13 | Filteraanbevelingen | ja: `filterOptimizer.ts` | onderdelen en items | **nieuw:** `v2_filter_status` (er bestond geen directe test) | nooit VALIDATED; nooit vrijgeefbaar; afgewezen roll/pitch blokkeert D-term; een niet-gevalideerde keten blokkeert de gyrogroepen | ruisband 100–1000 Hz vast; nooit een A/B-vlucht |
| 14 | Feedforward | ja: `feedforwardOptimizer.ts` | onderdelen en items | synth, echt (BLOCKED) | BLOCKED zonder ≥ 3 s acro-stickdata | nooit VALIDATED; jitter-boost niet gemodelleerd |
| 15 | Before/after | ja: Verified Tune (`verifiedTune.ts`, `verifiedTuneFromLogs.ts`); cross-flight (`compare/compare.ts:621`) | knop Verified Tune; `CrossFlightComparison.vue` | synth | voorspelling geaccepteerd binnen tolerantie; duplicaten nooit als herhaling; vergelijking autoriseert nooit | tolerantiefactor niet over craft-klassen gecalibreerd; compare: `no_validated_acceptance_criteria` |
| 16 | Safety-gates | ja: `absoluteEvaluate.ts`, `writeAuthority.ts`, `productLock` | gatelijst in het paneel | sim en mock | fail-closed; gebonden aan proposal-id en change | absolute route altijd geweigerd; sliderroute ook (`analysisEvidence` = `"not_available"`) |
| 17 | Preview | ja: `previewAbsoluteTune` (`useTuneApply.ts:1190`), `previewTune` | ja | sim | read-only; hash gaat in het bevestigingstoken | firmware-`MSP_CALCULATE_SIMPLIFIED_*` niet op echte hardware gezien |
| 18 | Apply-autorisatie | ja: `applyAbsoluteTune` (`:1210`), tokens (`applyConfirmation.ts`) | bevestigingsdialoog | sim (gates vrijgegeven via harness) | gates vóór elke MSP en opnieuw vlak voor de SET; token single-use en gebonden aan de preview | alleen in tests bereikbaar; nooit op een echte FC |
| 19 | Backup en Restore | ja: `tuneBackup.ts`, `restoreAbsoluteTune` (`:1326`), AutoBackup/AutoRestore | Restore-lijst; flasher | sim; AutoRestore alleen met gemockte serial | exact terugschrijven naar hetzelfde profiel, verify, save | `rollback` NOT_VALIDATED (alleen simulator); een tune-backup is geen volledige configbackup |
| 20 | Windows/Linux | zie §10 | — | — | — | — |

**Eerder ongedekt, nu gedekt:**
- `phase_unwrap_ambiguous`: geen enkele test raakte de 90°-grens;
- `filterOptimizer`: geen directe test;
- `gyroflightV2Need_gain_change_flight_with_feedforward_unchanged`: het paneel toonde de ruwe code. Hersteld, met een guardtest over alle codes.

**Bewust niet gewijzigd.**
- De planner vraagt altijd om de kwalificatievlucht (`measurementPlan.ts:275`).
- Een bestaande test legt dat als ontwerpbesluit vast: "always asks for the model-class qualification flight".
- Gevolg: ook een VALIDATED onderdeel noemt die vlucht nog. Dat is een UX-kwestie (P3), geen fout.

**Observatie (P3).**
- Op een afgewezen pitch-sweep van de echte AIR65-log (logIndex 1) toont de diagnostiek een crossover van 204 Hz met PM 318°.
- Dit is alleen diagnostiek (status NOT_VALIDATED, er wordt niets voorgesteld).
- Een fysiek onmogelijke waarde zou het paneel beter kunnen onderdrukken of markeren.

## 6. Fase E — adaptieve meetarchitectuur

**Wat zich wel aanpast aan de gemeten crossover fc** (alleen in de planner, informatief):
- de band, van fc/4 tot |L| ≤ −12 dB;
- de vereiste resolutie, uit de fasehelling, 0,5·fc/2 en de octaafregel;
- het aantal benodigde middelingen bij fc;
- de sweepduur T = n·Ts²·fc·ln(f1/f0).

In de gates schalen een aantal regels relatief met fc: de staplimiet vanaf fc/2, de bins per octaaf rond fc, de
\|S\|-band tot 1,5× de crossover, en de Verified-Tune-band (|L| 0,25–4).

**Wat zich niet aanpast:**
- **Het analysesegment.** `chooseSegmentSize` kiest het segment op samplerate: ongeveer 1,95 Hz bij 1, 2, 4 en 8 kHz. De planner meldt `primary_resolution_needs_finer_analysis`, maar de volgende vlucht krijgt toch hetzelfde segment.
- **De vaste banden:** `CHAIN_VALIDATED_BAND_HZ` 2–80 Hz, de filterruisband 100–1000 Hz, de FF-banden 2–8 en 2–20 Hz, en `VALIDATION_MAX_HZ` 40.
- **De plantvertraging.** Die wordt alleen gerapporteerd (`delayMarginMs`) en niet gebruikt.

**Nieuw bewijs (`v2_craft_class_truth`, SIMULATION).**

| | AIR65-achtig (K 60, motor 40 Hz, 2 ms) | 7-inch-achtig (K 30, motor 15 Hz, 4 ms) |
|---|---|---|
| Crossover gemeten tegenover waarheid | binnen 5 % | 7,45 tegenover ongeveer 6,8 Hz: binnen de gerapporteerde resolutie (7,8 Hz), niet binnen 5 % |
| PM tegenover waarheid | binnen 3° | niet getoetst: te grof |
| Evidence-niveau | MEASURED (geen tweede vlucht en geen kwalificatie) | MEASURED, `identified_band_has_gaps`, `primary_resolution_needs_finer_analysis:512<1024` |
| Plan | sweep van ongeveer 34 s | sweep van ongeveer 235 s, kortere band |
| Sweep die onder fc stopt | — | geen marges; vraagt om een sweep over de crossover |

**Conclusie: `ADAPTIVE_MEASUREMENT=PARTIAL`.**
- De planner past zich aan, en eerlijk.
- Het analysepad doet dat niet, en een craft met een lage crossover blijft dus `MEASURED`.
- Het analysepad hier aanpassen is bewust niet gedaan:
  - `chooseSegmentSize` voedt de upstream-parityfixtures en de gekwalificeerde TF waarop analysebinding en releasecontract opnieuw rekenen.
  - Voor een exponentiële sweep is de trade-off fysiek. Een twee keer zo lang segment geeft een kwart van de middelingen, dus resolutie kost sweepduur.
  - Er is geen echte 7-inch-data om een wijziging te valideren.
- De 4,5×-factor en de 25°-grens blijven NOT_VALIDATED over craft-klassen, zoals `AUTOTUNE_ENGINE_V2.md` al stelt.
- Er is één bronconflict. De code (`loopModel.ts:150–163`) leidt 25° af uit resonantiegeometrie en gebruikt AIR65 alleen als controle. De documentatie noemt het "calibrated on AIR65 / M5-A". Ik houd de strengste lezing aan: niet gevalideerd over klassen.

## 7. Fase F — functionele afronding

Toegevoegd of gewijzigd: alleen de locale-tekst en tests. Ongewijzigd: gates, write-authority, `absoluteEvaluate` en de
producers.

| Prioriteit | Stand |
|---|---|
| 1. Meetkwalificatie | bestaat (CHIRP-gate en qualityV2); gates NOT_VALIDATED over craft-klassen |
| 2. Plantmodel | bestaat; nu tegen analytische waarheid getoetst voor twee klassen |
| 3. modelClassQualification | bestaat; informatief en niet verbonden met Apply; producer kwalificeert zichzelf niet (verdicts van `loopModel` en het releasecontract) |
| 4. PID | bestaat; nooit vrijgegeven zonder VALIDATED marges en een Verified Tune |
| 5. Filter / FF | bestaan; nooit VALIDATED; filterstatussen nu direct getest |
| 6. Stabiliteit / onzekerheid | bestaat (capsule-grenzen, Bendat & Piersol); niet tegen herhaalde vluchten gevalideerd |
| 7. Transparante voorstelweergave | bestaat; nu een tekst voor elk meetverzoek, met guardtest |
| 8. Binding analyse ↔ voorstel ↔ FC | bestaat (`analysisBinding`, preview-hash, live recheck) |

**Absolute Apply blijft BLOCKED.**

## 8. Fase G — end-to-end

**De keten:** Blackbox-bytes → Viewer-decode → CHIRP-kwalificatie → `buildLogInputs` → engine (plant, marges,
onzekerheid, plan) → kwalificatieproducer → Safety → write-authority.
- Deze keten is gedekt door `wp7_end_to_end`: AIR65-achtig, 7-inch-achtig, instabiel, resonant, incoherent, ruis.
- Nieuw is `v2_craft_class_truth`, die elk van de twee klassen tegen zijn eigen waarheid toetst.

**Negatieve gevallen**, die allemaal stoppen met een benoemde reden:
- instabiel;
- resonantie met heroverschrijding;
- incoherent;
- te grove resolutie bij een lage crossover;
- een sweep onder fc;
- een niet-reproducerende gyroketen;
- afgewezen roll/pitch;
- een dubbelzinnige fase-unwrap.

**Positief pad tot schrijven.** Dit is alleen bereikbaar met harnasvrijgaven (`safetyRelease` en vergelijkbare). In het product blokkeert
Safety elk absoluut Apply (`safety:absolute_safety:not_hardware_validated`).

**Echte logs** (lokaal, alleen-lezend, niet in Git):
- **Lokale AIR65-tests.** Met `GYROFLIGHT_AIR65_BBL`, `GYROFLIGHT_AIR65_BBL18` en `GYROFLIGHT_AIR65_REF_DIR` slagen er 7 van de 9.
  - Geslaagd: decoder-parity met GyroCore, CHIRP-gate, flight identity, en de vergelijking met Betaflight Autotune.
  - Overgeslagen (2): `air65_autotune_v2.local`, omdat de tweede log `4dd55164…` (BBL19) op deze machine niet te vinden is; en `write_merge_e2e`, een toolexport.
  - Een eerste run zonder `REF_DIR` liep vast op een `TypeError` in `air65_autotune.local.test.ts:281` (de referentie is daar niet optioneel). Dat is een P3 in de testharnas.
- **BBL18 en de GyroCore-log door de volledige v2-engine** (een tijdelijke probe, verwijderd):
  - roll en pitch afgewezen, yaw "usable_with_warnings";
  - alle marges MEASURED;
  - geen vrijgeefbaar voorstel.

## 9. Bewezen versus niet gevalideerd

### 9.1 Bewezen (software, simulatie)
- Fail-closed gedrag van elke gate.
- Bit-exacte decode van synthetische logs.
- Numerieke parity met upstream.
- Marges op synthetische bins gelijk aan de analytische waarheid.
- Onzekerheidsgrenzen geometrisch correct.
- Write, verify, save en Restore op de byte-level firmwaresimulator.
- WP8-transportafsluiting.

### 9.2 Bewezen op echte data (AIR65, lokaal)
- Decoder-parity met GyroCore.
- Segmentatie.
- Flight identity.
- Op de echte logs wordt niets VALIDATED en niets vrijgegeven.

### 9.3 Niet gevalideerd
- Alle hardware.
- Elke andere craft dan AIR65.
- Elke andere firmware dan 2026.6.2.
- Het gyrochainmodel op echte logs met `gyroUnfilt` buiten AIR65.
- De gate-drempels over craft-klassen (25°, 4,5×, −6 dB, de coherentiegrenzen, 0,35).
- Onzekerheid tegen herhaalde vluchten.
- Filter- en FF-voorstellen in de vlucht.
- De Verified Tune in de vlucht.
- Web Bluetooth in de browser.
- De Tauri-transporten.
- Offline gebruik van de PWA.

## 10. Fase H — desktop (Windows / Linux)

**Bevinding: er is geen native desktopapp, en dat is een eerder genomen besluit.**
- `AGENTS.md` en `UPSTREAM.md` (§ "Web-only product") melden dat het volgende is verwijderd:
  - `src-tauri/`;
  - de Tauri-scripts;
  - `@tauri-apps/cli`;
  - de Tauri-workflows;
  - de `modern_release`-job.
- `src/js/protocols/Tauri*.ts` en de `isTauri()`-takken zijn bewaard, maar worden in de browser nooit gekozen (`serial.ts:206–221`).
- **TauriSerial wijkt af.** Het slikt sluitfouten in (`TauriSerial.ts:831–849`), meldt `disconnect` true en heeft geen `TransportLink`. Zijn sends blijven daardoor `DELIVERY_UNKNOWN`.
- **Niet gedaan, met opzet:**
  - geen tweede desktoparchitectuur gebouwd;
  - geen Tauri-write-autorisatie toegevoegd.

| Onderdeel | Windows | Linux |
|---|---|---|
| Uitvoering | browser (Chrome / Edge) | browser (Chrome / Chromium) |
| WebSerial | ondersteund door de browser | ondersteund; vereist toegang tot `/dev/ttyACM*` (groep `dialout` of een udev-regel) |
| Web Bluetooth | browserafhankelijk; niet getest | browserafhankelijk (vaak achter een vlag); niet getest |
| Bestandsimport `.bbl`/`.bfl` | ja (`FileSystem.pickOpenFile`, `showOpenFilePicker` of een `<input>`-fallback) | idem |
| Offline-analyse | PWA met precache (`vite.config.js:223–249`); niet offline getest | idem |
| Build | `npm run build` → `src/dist/` (statische site); exit 0 | idem |
| Packaging / installer | geen (alleen web en Android via Capacitor) | geen |
| Upgrade / migratie | PWA-update met een prompt (`registerType: "prompt"`); localStorage-sleutels geversioneerd (`.v1`, `.v2`) | idem |

**Status:**
- `WINDOWS_DESKTOP=BROWSER_ONLY_NO_NATIVE_PACKAGE`
- `LINUX_DESKTOP=BROWSER_ONLY_NO_NATIVE_PACKAGE`

**Ontbreekt voor een native release:**
- een gekozen shell (Tauri opnieuw, of de PWA als installeerbare app);
- een installer en code signing;
- een update-kanaal;
- per transport het bewijs van afsluiten zoals WP8 dat voor WebSerial levert.

## 11. Tests

Eindrun op `b38e2ee3` (de laatste code- en testcommit; daarna alleen documentatie), zonder parallelle agenten:

| Controle | Resultaat |
|---|---|
| Volledige suite (`npx vitest run`) | 370 bestanden PASS, 8 skipped; **5763 PASS / 0 FAIL / 14 SKIP** (baseline 5722 + 41 nieuw) |
| Lint en typecheck (`npm run lint`) | exit 0 |
| Build (`npm run build`) | exit 0 |
| Browsertest (`crossTabWriteLease.browser.mjs`) | 27/27 PASS (Chromium headless, playwright-core 1.64.0, Vite op 5299) |
| Lokale real-log-tests (AIR65, alleen lokaal) | 7 PASS / 2 SKIP (§8) |
| Desktopbuild | geen desktopbuild in deze branch (§10); de webbuild hierboven is de enige build |

De 14 skips in de suite zijn de lokale real-log-tests zonder omgevingsvariabelen.


| Nieuw bestand | Tests | Wat het bewijst |
|---|---|---|
| `test/gyrocore/v2_craft_class_truth.test.ts` | 10 | twee klassen, elk tegen de analytische waarheid; plan uit fc; stop onder fc |
| `test/gyrocore/v2_measurement_need_texts.test.ts` | 23 | elke uitgegeven meetcode heeft een zin |
| `test/gyrocore/v2_phase_unwrap.test.ts` | 3 | een unwrap-stap > 90° geeft geen grenzen |
| `test/gyrocore/v2_filter_status.test.ts` | 5 | filterstatussen en blokkades |

**Mutatiecontrole** (`consolidation-evidence/mutations.json`): 9 mutanten in de veiligheidsrelevante code, alle 9 gedood.
- 8 mutanten worden gedood door de nieuwe tests:
  - unwrap-grens 90 → 1000;
  - unwrap-check verwijderd;
  - filterstatus PARTIAL → VALIDATED;
  - chain-check verwijderd;
  - D-term-blokkade verwijderd;
  - de gaps-reden verwijderd;
  - de sweepduur Ts² → Ts;
  - de meettekst verwijderd.
- M8 (de bandondergrens fc/4 → fc/8) is op de craft-class-data equivalent, omdat de eerste bin boven fc/4 ligt. De bestaande `wp3_measurement_plan` doodt hem wel.

## 12. Codex-review

Een P2-beslisregel is vóór de eerste review vastgelegd: `consolidation-evidence/codex/rule.txt`.
- **P0:** een write zonder gates.
- **P1:** een valse veiligheids- of correctheidsclaim waarop gehandeld wordt.
- **P2:** een concreet, reproduceerbaar defect in de gewijzigde regels, met een geciteerde regel.
- **P3:** de rest; dit blokkeert niet.

### 12.1 Resultaten

| Review | Commit(s) | Uitkomst | Gevolg |
|---|---|---|---|
| R1 tests | `22efe859`, `d10c3433` | REQUEST_CHANGES: 1 P1. De kop van de craft-test beloofde een PM-vergelijking voor beide klassen; alleen AIR65 vergelijkt PM. P3: in de unwrap-test vallen de grens-asserts samen met de resolutiecheck; de filter-assert accepteert een leeg voorstel | kop versmald in `d59abc44` |
| R1b herbeoordeling | `d59abc44` | **APPROVE** 0/0/0, P1 gesloten | — |
| R2 meettekst | `416341b5` | **APPROVE** 0/0/0. P3: de guard controleert locale-sleutels, niet de uitvoering van `measurementText` | — |
| R3 procedure | `a4555b5f` | REQUEST_CHANGES: 3 P1 en 1 P2 (zie hieronder). P3: H-A3 | gerepareerd in `b38e2ee3` |
| R3b herbeoordeling | `b38e2ee3` | **APPROVE** 0/0/0, bevindingen 1–4 gesloten | — |
| Integraal | definitieve HEAD | zie §12.2 | — |

De bevindingen van R3:
- **P1:** bij verbinden gaan `MSP_SET_ARMING_DISABLED` en `MSP_SET_RTC` naar de FC, terwijl klasse R "geen SET" beloofde.
- **P1:** PID-saves in twee tabs worden niet geserialiseerd (gedeelde lease).
- **P1:** de CLI-sessie weigert writes alleen wanneer een write sowieso geweigerd zou worden.
- **P2:** H-W7 verwachtte "unknown" waar het upstream-pad stil kan eindigen of `not_saved` kan melden.

Bewaard in `consolidation-evidence/codex/`: prompts, reviewteksten en de severity-regel. `R3-procedure-review.md` bevat
lokale paden en is als `redacted/R3-procedure-review.md` gepubliceerd. Het origineel blijft lokaal, met SHA-256
`6de07c8f2b858504768300b462a7fea378dd69a8ca0ef41639b4fafd7480fdc2`. Sessielogs en exit-bestanden blijven lokaal.

### 12.2 Integrale review

| Review | HEAD | Uitkomst |
|---|---|---|
| I1 integraal: alles sinds `6aee384e`, productiecode, tests, publicatiescan en rapportclaims | `af9ab0d4` | REQUEST_CHANGES: 1 P2 (Windows-pad met gebruikersnaam in een gepubliceerde `redacted/`-kopie, §2). P3: dezelfde twee testbeperkingen als R1 |
| I1b herbeoordeling, met een nieuwe scan van alle 83 toegevoegde of gewijzigde auditbestanden | `71af5bc5` | **APPROVE** 0/0/0 |

Na `71af5bc5` volgt alleen de commit die dit statusblok invult (§12.2 en §16). Codex heeft die commit niet apart
beoordeeld.

## 13. Resterende P0/P1/P2

Geen open P0, P1 of P2 in de wijzigingen van deze opdracht (zie §12). Bestaande punten buiten die wijzigingen, die niet
blokkeren maar wel moeten gebeuren:
- **Privacy, al bestaand:** het Windows-pad met gebruikersnaam in `test/js/air65_yaw_open_loop_offline.test.ts:47`, en de scratchpaden in `docs/gyrocore/audit/wu4/agent{C,D}_report.md`.
  - Advies: vervang het standaardpad door alleen de omgevingsvariabele (`GYROFLIGHT_AIR65_OCT18_BBL`).
  - Neem de vervangen real-log-test dan op in de lokale run.
  - De geschiedenis behoudt het pad.
- **P3 uit de reviews:** zie §12.1 (onder andere de testharnas van `air65_autotune.local.test.ts` zonder `REF_DIR`, en de diagnostische PM van 318° op een afgewezen sweep).

## 14. Acceptatiecriteria

### 14.1 Hardwareacceptatie
Die staat in `AUTOTUNE_V2_HARDWARE_PROCEDURE.md`, § "Hardware acceptance criteria":
- H-R1–H-R9 PASS, en H-R10 PASS of N/A;
- H-W1–H-W7, H-W10 en H-W11 PASS, en H-W8 en H-W9 PASS of N/A;
- alle bewijs bijgevoegd en gecontroleerd door een tweede persoon;
- N/A telt nooit als PASS.

### 14.2 Releasecriteria (alle nodig, geen enkele nu vervuld)
1. Hardwareacceptatie volgens 14.1, op de release-commit.
2. Een aparte, gereviewde wijziging die `hardwareValidated` zet, met dat bewijs.
3. Een AIR65-CHIRP-vlucht die door de kwalificatie komt (roll en pitch `usable`).
4. Een onafhankelijke, fijnere kwalificatievlucht: `modelClassQualification` PASS op elke as die verandert.
5. Een Verified Tune uit een gain-change-vlucht met een baseline-herhaling.
6. Marges VALIDATED (PM ≥ 40°, GM ≥ 6 dB, |S| ≤ 6 dB) met onzekerheid.
7. H-A1–H-A3 PASS, daarna H-A4 met de eigen veiligheidsprocedure van de eigenaar.
8. Voor een andere craft-klasse: dezelfde reeks op die klasse. AIR65-bewijs geldt daar niet.
9. Adaptieve primaire analyse (aparte WP):
   - een segment uit de df van de planner, met ≥ 8 segmenten en een coherentie-gate;
   - de upstream-parity blijft behouden;
   - getoetst op echte data van een craft met een lage crossover.
10. Volledige suite, lint, build en browsertest groen, en Codex APPROVE op de release-HEAD.

## 15. GitHub

Gepusht volgens §12 van de opdracht. Voorwaarden:
- de remote komt overeen met de gecontroleerde geschiedenis;
- er zijn geen onverwachte tracked wijzigingen;
- de validatie is groen;
- er gaan geen gevoelige bestanden mee;
- er staat geen open P0/P1.

Geen merge, geen PR. Zie het statusblok voor de exacte stand.

## 16. Status

```text
GYROFLIGHT_V2_COMPLETE_CONSOLIDATION
BRANCH=feat/gyroflight-autotune-engine-v2
HEAD_BEFORE=6aee384edf5c050375273995ec8d61733ba3b965
HEAD_AFTER=the commit recording this block, child of 71af5bc5 (reviewed content HEAD 71af5bc5; last code/test commit b38e2ee3)
REMOTE_BACKUP=YES (origin/feat/gyroflight-autotune-engine-v2, fast-forward, no force; WP8 baseline pushed as d3f39ee2)
WP8_SOFTWARE=PASS_SOFTWARE (baseline 6aee384e; F01-F10 CLOSED; transport P2 CLOSED)
WP8_HARDWARE=NOT_EXECUTED
BLACKBOX_DECODER=PASS (bit-exact on synthetic logs; parity with GyroCore on real AIR65 logs, local only; one craft and firmware)
CHIRP_ANALYSIS=PASS_SOFTWARE (extraction and Welch parity; gate thresholds NOT_VALIDATED across craft classes; all AIR65 roll/pitch sweeps rejected)
ADAPTIVE_MEASUREMENT=PARTIAL (planner adapts to the measured crossover; analysis segment fixed by sample rate; low-crossover craft stays MEASURED)
PLANT_IDENTIFICATION=PASS_SOFTWARE (crossover within reported resolution of analytic truth for two classes; real-flight NOT_VALIDATED)
MODEL_QUALIFICATION=MODEL_CONDITIONAL (VALIDATED reached only on synthetic logs; informative, not connected to Apply)
PID_ENGINE=PASS_SOFTWARE_BLOCKED (proposals computed; never released without VALIDATED margins and a Verified Tune)
FILTER_ENGINE=PARTIAL (simulation on logged data only; never VALIDATED)
FEEDFORWARD_ENGINE=PARTIAL (BLOCKED without acro stick data; never VALIDATED)
STABILITY_ANALYSIS=MODEL_CONDITIONAL (PM/GM/|S| with uncertainty bounds; fixed factors NOT_VALIDATED across craft classes)
BEFORE_AFTER=PASS_SOFTWARE (Verified Tune and cross-flight comparison; NOT_VALIDATED in flight)
SAFETY_GATES=PASS (fail-closed; unchanged)
ABSOLUTE_APPLY=BLOCKED
HARDWARE_READINESS=PROCEDURE_READY (docs/gyrocore/AUTOTUNE_V2_HARDWARE_PROCEDURE.md, Codex APPROVE; NOT_EXECUTED)
WINDOWS_DESKTOP=BROWSER_ONLY_NO_NATIVE_PACKAGE
LINUX_DESKTOP=BROWSER_ONLY_NO_NATIVE_PACKAGE
END_TO_END=PASS_SOFTWARE (bytes to Apply gate; stops with a named reason; write path only with test harness releases)
TESTS_PASS=5763
TESTS_FAIL=0
TESTS_SKIP=14
TYPECHECK=PASS
LINT=PASS
BUILD=PASS
BROWSER_TESTS=PASS (27/27)
CODEX_REVIEW=APPROVE (integral I1b at 71af5bc5: P0=0 P1=0 P2=0; per-part R1b, R2, R3b APPROVE)
P0_OPEN=0
P1_OPEN=0
P2_OPEN=0
PUSHED=YES
MERGED=NO
PR_CREATED=NO
OVERALL_STATUS=CHECKPOINT_SOFTWARE_CONSOLIDATED (Autotune completion NOT reached: hardware, adaptive analysis and real-flight validation outstanding, §14)
REPORT_PATH=docs/gyrocore/audit/autotune-v2/2026-10-25-v2-complete-consolidation.md
```
