# Gyroflight v2 — WP8 Independent Codex Final Review

Datum: 24 oktober 2026. Reviewer: OpenAI Codex. Flow: Research Build, onafhankelijke veiligheidsreview.

**Onafhankelijke conclusie: REQUEST_CHANGES; WP8 = FAIL.** Alle zes commitreviews en de integratiereview zijn daadwerkelijk afgerond. Er zijn geen bevestigde open P0's, maar wel **vier open P1's en zes open P2's** in de hieronder afgebakende web-/app-scope. Absolute Apply blijft **BLOCKED**. Dit oordeel is geen hardware-, vlucht- of firmwarekwalificatie.

## 1. Herkomst en werkwijze

- Werkdirectory: `<home>/Gyroflight-worktrees/autotune-engine-v2`.
- Branch vóór en na: `feat/gyroflight-autotune-engine-v2`.
- Exacte HEAD vóór en na: `20242d2cd94d3d492ba0d12f390e1bd5d001ff74`.
- Exacte basis: `17fd4b0aa7b2351549464874158100f9e4c09395`.
- Git rapporteerde precies zes commits in `17fd4b0a..20242d2c`. Hun parent-relaties zijn gecontroleerd; de volgorde hieronder komt uit Git.
- Bij aanvang waren `.serena/` en de auditmap ongetrackt. Deze bestanden zijn behouden. Er is geen checkout gewisseld. Staged en unstaged tracked diffs waren vóór en na leeg.
- Achtereenvolgens zijn zeven afzonderlijke processen uitgevoerd met `codex exec -s read-only --ephemeral --color never -o <nieuw-reviewbestand> -`: eerst één per commit, daarna integratie op HEAD. CLI 0.164.0; de sessielogs vermelden provider `openai`, model `gpt-6.1-sol`, reasoning `medium` en sandbox `read-only`.
- Alle zeven processen eindigden met exitcode 0 en `REVIEW_COMPLETED=YES`. Geen provider- of contentfilterafbreking in deze ronde. Een afgerond proces betekent geen veiligheids-PASS.
- Deelreviews gebruikten de betreffende historische diff en omliggende productiecode/tests. Historische problemen zijn hieronder onderscheiden van resterende HEAD-problemen. De hoofdsessie heeft materiële bevindingen opnieuw aan HEAD-broncode getoetst; F04 is een aanvullende bevinding van die broninspectie.
- Geen tests, mutaties, builds, hardwarehandelingen, MSP-writes, flashes, bronwijzigingen, commits, pushes of merges uitgevoerd. Alleen dit rapport en nieuwe reviewbewijsbestanden zijn toegevoegd.
- GitNexus meldde een index op `17fd4b0a`, zes commits achter HEAD. Die is niet vernieuwd binnen deze read-only opdracht. Er wordt geen actuele graph-/PDG-/taintvalidatie geclaimd; de conclusies berusten op diffs en broninspectie.

Bewijsdirectory: [codex-final-evidence-220928](codex-final-evidence-220928/). Deze bevat prompts, sessielogs, exitcodes, zeven zelfstandige beoordelingen en een SHA-256-manifest. Bestaande auditrapporten zijn alleen historische claims, geen vervanging voor huidige broncodebeoordeling.

**Betekenis van statuswoorden:** `CLOSED` betekent uitsluitend dat de genoemde, begrensde softwareclaim door broninspectie wordt ondersteund. Het betekent geen nieuw uitgevoerde regressietest of hardwarebewijs. `OPEN` is een resterend defect of een expliciet benoemde onvolledigheid. `NOT_VALIDATED` betekent dat het benodigde bewijs ontbreekt. De scenario's bij bevindingen zijn afleidbaar uit productiecode; zij zijn in deze review niet uitgevoerd.

## 2. Oordeel per commit

| # | Volledig commit-ID | Beoordeelde claim en oordeel | Zelfstandig reviewresultaat |
|---|---|---|---|
| 1 | `7c14da9db9515cc7e3d1cd5d84613ee7b26b947c` | Unicode/control-rejectie en classificatie van de lage byte van `=`: CLOSED op bronniveau. Omliggende problemen op deze historische revisie tellen niet automatisch als nieuwe regressies van deze commit. | [REQUEST_CHANGES](codex-final-evidence-220928/01-7c14da9d-review.md), afgerond |
| 2 | `c8a37e0ef726d6ca7964827b7dae76af49c71cd2` | Volledig commando plus DEL-prefix verhelpt afhankelijkheid van vertraagde echo onder de gemodelleerde editoraannames. Universele firmwarewerking: NOT_VALIDATED. Transportfout bij exit blijft F10. | [NOT_VALIDATED](codex-final-evidence-220928/02-c8a37e0e-review.md), afgerond |
| 3 | `d14f2cecb8a26c4fad1bae7b32b7e5a2a7d12fdd` | Directe weigering, uitgestelde weigering en disconnect vóór dispatch worden als mislukking behandeld: CLOSED op bronniveau. Werkelijke verzending/save is niet bewezen door `onSent`: F01 OPEN. | [REQUEST_CHANGES](codex-final-evidence-220928/03-d14f2cec-review.md), afgerond |
| 4 | `5b7ca2b6d1437f44916db5dab5217ed7867003c9` | Gescheiden retentiequota en bescherming van geldige referenties: CLOSED op bronniveau. Parsebare ongeldige transactierecords vallen niet volledig onder de conservatieve fallback: F08 OPEN op store-grens. | [OPEN](codex-final-evidence-220928/04-5b7ca2b6-review.md), afgerond |
| 5 | `bee7b8b1239bb3137b400ca29d2e902db3d8bd55` | Directe RXFAIL-weigering bereikt de Failsafe-save: CLOSED op bronniveau. Weigering van een latere retry beëindigt de legacy-aanroeper niet: F05 OPEN. | [PARTIAL](codex-final-evidence-220928/05-bee7b8b1-review.md), afgerond |
| 6 | `20242d2cd94d3d492ba0d12f390e1bd5d001ff74` | CLI-sessiecontrole staat vóór MSP-read/runtime/permitclassificatie en geldt ook voor MSP-CLI: CLOSED voor de gecontroleerde paginaflag. Firmwaremodus, alle combinaties en transportlevering: NOT_VALIDATED. | [NEEDS_VALIDATION](codex-final-evidence-220928/06-20242d2c-review.md), afgerond |

De [integratiereview](codex-final-evidence-220928/07-integration-review.md) is eveneens afgerond: **REQUEST_CHANGES**. Bevindingen uit vroege deelreviews over nog niet toegepaste latere reparaties zijn niet dubbel als open HEAD-defect geteld. Ernstverschillen tussen ruwe reviews zijn hieronder geconsolideerd op basis van HEAD-code en gevolg.

## 3. Open P1-bevindingen op HEAD

### F01 — P1 — AutoRestore rapporteert succes zonder geslaagde verzending

- **Bestand/regel:** `src/js/msp.ts:398`; `src/js/utils/AutoRestore.ts:279`, `:289`, `:100`; UI: `src/components/tabs/FirmwareFlasherTab.vue:1677`.
- **Scenario:** AutoRestore bereikt `save`. Het transport retourneert nul/te weinig bytes, faalt, of blijft langer dan 500 ms geblokkeerd. MSP roept `onSent` vóór `serial.send` aan. AutoRestore zet `_saving=true` en meldt na de flushdelay succes, of behandelt een disconnect als geslaagde save-reboot.
- **Veiligheidseffect:** EEPROM-persistentie blijft onbewezen, terwijl de UI restore voltooid meldt en de herstelactie verbergt. Dit bewijst niet dat een Gyroflight-onzekerheidsentry is gewist; het defect betreft de succesclaim.
- **Regressietest:** `test/gyrocore/wp8_final_acceptance_transport.test.ts:110` retourneert standaard `{ bytesSent: 0 }`; de positieve AutoRestore-test op `:345` verwacht toch succes. De tests voor geweigerde/uitgestelde dispatch sluiten deze leveringsfout niet.
- **Oordeel: OPEN.** De reparatie sluit het oude CLI-queueprobleem, niet het transport-/persistentieprobleem. Bestaand gedrag, onvolledig gesloten door de reparatie; geen nieuwe hardwarewaarneming.

### F02 — P1 — Gewone cross-tab-writes vallen buiten het transactieslot

- **Bestand/regel:** `src/composables/fcWriteGuard.ts:365`, `:277`; `src/gyrocore/stores/fcTransactionState.ts:366`; `src/composables/useTuneApply.ts:512`.
- **Scenario:** Tab A houdt het Web Lock en leest de craft vóór opslag van zijn pending entry. Tab B doet een gewone upstream-SET, profielwissel of save. B neemt geen Web Lock, heeft geen lokale transactie en ziet nog geen entry. Die write wordt toegelaten tussen A's reads of na een al gebruikte read.
- **Veiligheidseffect:** de software waarborgt geen uitsluiting rond de complete transactie; snapshot en verificatiescope kunnen worden doorkruist. Een save kan waarden buiten de geverifieerde wijziging meenemen.
- **Regressietest:** `test/gyrocore/wp8_p0_closure_routes.test.ts:539` controleert een vreemde write op dezelfde pagina vóór entry-opslag. `:497` controleert een andere transactie die het lock wél respecteert. Geen van beide bewijst uitsluiting van een gewone schrijver in een tweede echte tab.
- **Oordeel: OPEN voor software-uitsluiting.** Bereikbaarheid van dezelfde fysieke craft vanuit twee tabs via Bluetooth/TCP: NOT_VALIDATED. Dit is geen aangetoonde Web Serial dual-open-bypass. De bron documenteert deze beperking al; documentatie maakt de ontbrekende uitsluiting niet CLOSED.

### F03 — P1 — WebSerial kan complete sends mengen in de AT32/macOS-batchmodus

- **Bestand/regel:** `src/js/protocols/WebSerial.ts:334`, `:553`, `:559`, `:571`, `:590`; `src/js/serial.ts:347`; ordeningsclaim: `src/composables/fcWriteGuard.ts:55`.
- **Scenario:** Send A bevat meer dan 63 bytes. Terwijl A op voltooiing van zijn eerste chunk wacht, start send B. B plaatst zijn bytes vóór de volgende chunk van A in de writable stream. Er is geen serialisatie van de volledige send rond `batchWrite`.
- **Veiligheidseffect:** MSP-frames of CLI-prefix/tekst kunnen door andere sends worden onderbroken. De algemene claim dat de toegelaten complete sends in dezelfde volgorde de craft bereiken, geldt hiermee niet voor alle webtransporten. Exacte firmwaregevolgen zijn NOT_VALIDATED; een concrete ongeautoriseerde firmwareactie wordt niet geclaimd.
- **Regressietest:** de ordeningstest op `test/gyrocore/wp8_final_acceptance_transport.test.ts:419` gebruikt WebBluetooth. Zij test geen gelijktijdige WebSerial-batches.
- **Oordeel: OPEN.** Bestaande adapterbeperking, vastgesteld in de integratie; geen regressie die door commit 6 is geïntroduceerd.

### F04 — P1 — Gedeelde EEPROM-route meldt opgeslagen bij een verbroken verbinding

- **Bestand/regel:** `src/js/msp.ts:484`; `src/js/msp/MSPHelper.ts:818`, `:827`, `:828`; aanroeper: `src/composables/useReboot.ts:85`.
- **Scenario:** een gewone Save-and-Reboot heeft de sectie-SETs afgerond, maar de verbinding verbreekt vóór de 100-ms EEPROM-dispatch. Er is geen onzekere Gyroflight-entry. De hercontrole in `writeConfiguration` slaagt dan nog; `send_message` ziet `!serial.connected`, roept de legacy-responsecallback aan en retourneert `false` zonder verzending. `writeConfiguration` negeert die return en logt `configurationEepromSaved`, waarna zijn succescallback kan doorlopen.
- **Veiligheidseffect:** de UI kan EEPROM-opslag melden terwijl deze save niet is verstuurd. RAM-wijzigingen en persistentie mogen daardoor niet als bevestigd worden beschouwd.
- **Regressietest:** `test/js/msp_promise.test.ts:194` controleert afwijzing van de promise-API bij disconnect, niet deze legacy-callbackketen. De Failsafe-tests vervangen `saveAndReboot`; de gerichte zoekcontrole vond geen test voor deze productiecombinatie.
- **Oordeel: OPEN.** Aanvullende bronbevinding van de Codex-hoofdsessie, bestaand vóór deze commitrange. Het reproduceerscenario is statisch vastgesteld en niet uitgevoerd. Dit is een andere root cause dan F01.

## 4. Open P2-bevindingen en herstelbeperkingen

### F05 — P2 — Geweigerde RXFAIL-retry laat Failsafe Save wachten

- **Bestand/regel:** `src/js/msp/MSPHelper.ts:746`, `:750`; `src/js/msp.ts:613`, `:617`; `src/composables/failsafe/useFailsafeSave.ts:48`.
- **Scenario:** de eerste RXFAIL-send is toegelaten, het antwoord ontbreekt, en onzekerheid ontstaat vóór de retry. De retry wordt terecht geweigerd, maar de legacy-callback krijgt geen fout. `onRefused` controleert alleen de eerdere synchrone return, die al `true` was.
- **Veiligheidseffect:** `isSaving` blijft actief; de eerste write kan RAM hebben gewijzigd. De uitkomst blijft onbekend, zonder verdere EEPROM-save of bewezen succes.
- **Regressietest:** final-acceptance `:363` en `:374` testen directe weigering. De test met twee RXFAIL-kanalen op `:392` levert geen ACK en controleert alleen het eerste frame. Die dekt geen kanaalprogressie, weigering tussen kanalen, eindcallback of retry-afhandeling. `wp8_p0_closure_transport.test.ts:207` controleert alleen uitblijven van retransmissie.
- **Oordeel: OPEN.** De ontbrekende multikanaal-/retrydekking is bij deze bevinding opgenomen en niet nogmaals geteld.

### F06 — P2 — Failsafe wist dirty state vóór geslaagde persistentie

- **Bestand/regel:** `src/composables/failsafe/useFailsafeSave.ts:58`, `:60`; `src/components/tabs/FailsafeTab.vue:453`, `:380`.
- **Scenario:** alle sectiewrites slagen, `initializeDefaults()` maakt de huidige waarden de schone baseline, en daarna wordt EEPROM-save geweigerd of mislukt die.
- **Veiligheidseffect:** de saveknop wordt uitgeschakeld hoewel persistentie onbekend/mislukt is. De foutlog herstelt de dirty baseline niet.
- **Regressietest:** `test/js/composables/failsafe/useFailsafeSave.test.ts:118` laat de eerste gemockte write falen, niet de laatste opslag ná baseline-reset.
- **Oordeel: OPEN.** Eén vroege deelreview noemde dit P1; geconsolideerd P2 omdat de foutafhandeling wel een fout logt en hiermee op zichzelf geen writegate wordt omzeild. De afzonderlijke valse EEPROM-succesmelding staat onder F04.

### F07 — P2 — Verweesde of onbekend gescopeerde transacties hebben geen herstelpad in de app

- **Bestand/regel:** `src/gyrocore/stores/fcTransactionState.ts:316`, `:319`; `src/composables/useTuneApply.ts:581`, `:732`, `:842`, `:1392`, `:1397`.
- **Scenario:** sluit de pagina na opslag van pending, of onderbreek een slider-write na verzending. Start opnieuw met de entry intact. `in_progress`, onbekende of meerdere profielen worden niet door één Restore of read-only check gedekt.
- **Veiligheidseffect:** Apply, normale writes en Restore blijven geblokkeerd. Dit bewaart onzekerheid correct, maar herstelbaarheid is onvolledig. Handmatig opslag wissen buiten de app is geen geverifieerde herstelprocedure.
- **Regressietest:** `test/gyrocore/wp8_p0_closure_routes.test.ts:351` en `:665` verwachten bewust dat deze toestanden open blijven.
- **Oordeel: OPEN als herstelbeschikbaarheid; CLOSED voor de begrensde claim dat zulke entries niet onterecht worden vrijgegeven.** Geen automatische unlock voorstellen of uitvoeren.

### F08 — P2 — Retentiescanner hanteert een zwakkere definitie van leesbare entries

- **Bestand/regel:** `src/gyrocore/stores/tuneBackup.ts:98`, `:101`, `:129`; vergelijk `src/gyrocore/stores/fcTransactionState.ts:156`, `:166`.
- **Scenario op de store-grens:** bewaar 20 overige backups `b-0..b-19`, plaats `{"backupId":"b-0"}` onder een v2-transactiesleutel en roep de productie-backupstore met twee nieuwe overige backups aan. De transactiestore verwerpt de entry, maar de retentiescanner accepteert de stringreferentie en kan `b-1` wegprunen. `b-0` blijft gepind.
- **Precisering van ruwe reviews:** bij precies 20 bestaande backups waarvan één gepind is, volstaat één nieuwe backup nog niet om een andere te verwijderen; gepinde backups tellen niet mee in het quota. Het scenario hierboven gebruikt daarom twee nieuwe saves. Er is geen runtimeprobe uitgevoerd.
- **Veiligheidseffect:** de brede claim “niets wordt verwijderd bij onleesbare transactiestatus” klopt niet op deze store-grens. Er is geen aangetoonde MSP-bypass: de transactiestore blokkeert de ongeldige status. De enige gevonden productieaanroeper is `storeBackup` (`useTuneApply.ts:323`); bereikbaarheid door een normale volledige Restore bij al onleesbare status is NOT_VALIDATED en kan door eerdere checks worden tegengehouden.
- **Regressietest:** `test/gyrocore/wp8_final_acceptance_evidence.test.ts:108` gebruikt ongeldige JSON; geen parsebare ongeldige entry, verkeerde identiteit of ongeldige legacyvorm.
- **Oordeel: OPEN als retentiecontractverschil; workflow-impact NOT_VALIDATED.** Niet opgewaardeerd naar een bewezen verlies van de gerefereerde herstelbackup.

### F09 — P2 — CLI-timeoutdrain is niet geïsoleerd van andere antwoorden

- **Bestand/regel:** `src/js/msp.ts:206`, `:362`, `:431`, `:437`.
- **Scenario:** na CLI-timeout komt een MSP-antwoord binnen tijdens drain: alle bytes worden weggegooid. Een nieuwe CLI-aanvraag kan tijdens drain starten omdat `_process_cli_queue` de drainflag niet controleert. Een oud CLI-antwoord na de graceperiode kan bij een opvolgende aanvraag terechtkomen.
- **Veiligheidseffect:** verloren of verkeerd toegeschreven antwoorden ondermijnen readback en fout-/voltooiingsmeldingen. Dit is geen bewijs dat de transactiegate onterecht vrijgeeft.
- **Regressietest:** `test/js/msp_cli_queue.test.js:90` test een laat antwoord binnen drain; `:113` test geforceerde voortgang. Zij controleren niet de genoemde interleaving of antwoordtoeschrijving na de graceperiode.
- **Oordeel: OPEN.** Bestaande gedeelde queuebeperking.

### F10 — P2 — CLI-exit rapporteert reboot bij een mislukte transport-send

- **Bestand/regel:** `src/composables/useCli.ts:340`, `:341`, `:884`, `:888`, `:892`; `src/js/serial.ts:347`, `:352`.
- **Scenario:** de verbindingsflags staan nog geldig, maar de transport-send van `exit` faalt of meldt nul bytes. `send` retourneert direct `true`; de serial-facade roept ook bij nul bytes de callback aan. Cleanup meldt reboot, kan reconnect starten en wist CLI-flags zonder bevestigde aflevering.
- **Veiligheidseffect:** app en firmware kunnen het oneens zijn over CLI-modus/reboot. De eerdere guard-weigering is wel gecorrigeerd, transportfalen niet.
- **Regressietest:** `test/gyrocore/wp8_final_acceptance_transport.test.ts:110` retourneert nul bytes; `:265` verwacht toch een rebootboolean via een nagebootste firmware-editor. Reconnect is gemockt.
- **Oordeel: OPEN.** Geen bewezen echte reboot of herstelvrijgave.

## 5. Integrale veiligheidsclaims

| Claim | Bronbewijs en onafhankelijke status |
|---|---|
| Centrale `fcWriteGuard.ts` | Onbekende MSP-codes zijn writes (`:227`); onzekerheid, onleesbare opslag en onbekende UID worden gecontroleerd (`fcTransactionState.ts:366`). CLOSED voor deze bronlogica. Firmwaresemantiek van iedere read/runtime-allowlistentry over alle versies: NOT_VALIDATED. |
| Alle MSP-/CLI-routes | MSP-admission, parked release, retries en MSP-CLI lopen door de guard (`msp.ts:527`, `:690`, `:613`, `:353`, `:370`). Raw CLI/AutoBackup-commando's lopen via `interactiveCliText` (`useCli.ts:333`, `AutoBackup.ts:388`). `serial.send` zelf is geen algemene guardgrens. |
| Raw uitzonderingen | Het CLI-startbyte `#` (`useCli.ts:830`, `AutoBackup.ts:364`) en bootloaderflash (`webstm32.ts:602`) vallen buiten commandoclassificatie. Flash is buiten de beoordeelde write-autorisatie en niet uitgevoerd. |
| Autorisatie vóór verzending/retries | CLOSED voor de geïnspecteerde MSP-admission/release/retrypunten. Een geweigerde retry van een eerder verzonden promise-write houdt de eerste uitkomst onzeker via `WriteRetryRefusedError`. Geen nieuwe controle bij ieder downstream transportbyte; F03 en Tauri beperken bredere claims. |
| CLI-sessie versus framed verkeer | `cliSessionRefusal` staat vóór read/runtime/permitclassificatie (`fcWriteGuard.ts:262`, `:274`, `:330`). CLOSED onder correcte `cliActive`-flag. Firmwaremodussynchronisatie en alle retry-/permitcombinaties: NOT_VALIDATED; queue-antwoordisolatie blijft F09. |
| Apply-/Restore-transacties | Web Lock, persistent pending, permit-eigenaarschap en dekking vóór eigen writes (`useTuneApply.ts:448`, `:472`, `:512`); onzekere uitkomst blijft bewaard (`:537`). CLOSED voor geïnspecteerde bookkeeping; geen fysieke transactiekwalificatie. |
| AutoRestore | Ander protocol dan `useTuneApply`: CLI-batch met save-/disconnectheuristiek, zonder gelijkwaardig geverifieerd transactieherstel. Queueweigering is gecorrigeerd; succes/persistentie blijft OPEN, F01. |
| Web Locks en pending | Transacties/checks nemen het originlock, ontbreken ervan blokkeert (`fcWriteGuard.ts:365`). UUID-botsing wordt binnen het lock gecontroleerd. Andere gewone tab-writers doen niet mee; F02 OPEN. |
| Cross-tab vóór entry-opslag | Pending volgt ná live reads/backup. Lokale `localWrites` beschermt dezelfde pagina, niet een andere gewone schrijver. Storagezichtbaarheid biedt evenmin een craftbreed slot. F02 OPEN. |
| Transport | WebBluetooth serialiseert JS-writes (`WebBluetooth.ts:613`); test gebruikt echte adapter met nagebootste GATT-write. Browser-“TCP” is WebSocket (`serial.ts:174`, `WebSocket.ts:216`); Android TCP delegeert aan native code (`CapacitorTcp.ts:230`). Geen fysieke leverings-/gelijktijdigheidskwalificatie. WebSerial-batching: F03 OPEN. |
| Onbekende profielscope en orphan entries | Geen vrijgave door reboot of slechts één passende readback. `coveredBy` sluit `in_progress` uit en vereist één bekend profiel (`fcTransactionState.ts:313`). CLOSED voor behoud van onzekerheid; herstelpad ontbreekt, F07. |
| Geweigerde saves en UI | Directe RXFAIL-weigering eindigt nu correct. F01, F04, F05, F06 en F10 verhinderen een algemene claim van correcte save-/succesafhandeling. OPEN. |
| Absolute Apply | `ABSOLUTE_SAFETY_POLICY.hardwareValidated` blijft `false` (`absoluteEvaluate.ts:64`) en voegt een block toe (`:180`); `writeAuthority.ts:164` weigert. CLOSED voor behoud van de blokkade. **ABSOLUTE_APPLY=BLOCKED**. |

## 6. Tests, mutaties en firmwareaannames

**Eerder gerapporteerd resultaat: 5.512 PASS, 0 FAIL en 14 SKIP. Dit is in deze review niet opnieuw uitgevoerd of onafhankelijk bevestigd.** Ook eerdere lint-/buildresultaten zijn geen nieuwe verificatie van deze review.

De tests bereiken deels echte productiecode:

- `wp8_final_acceptance_transport.test.ts`: echte MSP, guard, stores, CLI en AutoRestore; meestal vervangt een spy `serial.send`. De Failsafe-flow vervangt de voorafgaande `MSP.promise`-writes. De tests roepen AutoRestore deels rechtstreeks intern aan en doorlopen niet de hele verbinding/UI.
- De Bluetooth-test herstelt de echte `serial.send` en gebruikt echte `WebBluetooth.send`, maar `writeValue` en GATT-device zijn nagebootst. Vastgelegde adaptercalls zijn geen FC-ontvangst, ACK of EEPROM-bewijs.
- `wp8_final_acceptance_evidence.test.ts`: echte backupstore met jsdom-localStorage en handmatig geconstrueerde records. Geen echte mislukte Restore-keten of browserpersistentiekwalificatie.
- `wp8_p0_closure_routes.test.ts`: echte transactie-/Restore-/checklogica, maar MSP, firmwaregedrag, Web Locks en verscheidene releasegates zijn vervangen. Succes achter testgates is geen vrijgave van productie-Absolute Apply.
- De queue-tests gebruiken echte decoderlogica met synthetische antwoorden. Dat sluit de ontbrekende scenario's F05/F09 niet.

### M87–M93

De mutatiebeschrijvingen zijn teruggevonden in Git-committeksten en het eerdere acceptance-rapport. De bijbehorende regressietestcode is geïnspecteerd. Er zijn geen afzonderlijke exacte mutantpatches met uitvoerreceipts in de onderzochte tests/scripts aangetroffen. Er is niets gemuteerd of opnieuw uitgevoerd.

| Mutatie | Gerapporteerde wijziging | Verwachte gevoeligheid uit testinspectie | Uitvoeringsbewijs in deze review |
|---|---|---|---|
| M87 | Lage-byte-masker bij `=` verwijderd | Payload met `0x13d` moet zonder writeclassificatie worden doorgelaten; de no-send/refusal-assertie hoort te falen (`transport.test.ts:188`). | NOT_VALIDATED |
| M88 | BMP-non-ASCII toegestaan | Unicodecases inclusief gecodeerde LF/CR/DEL/space horen de weigering/no-wire-asserties te breken (`:138`). | NOT_VALIDATED |
| M89 | Slechts vier DEL-bytes | De vertraagde-completion-/exitmodeltests horen een afwijkende uitgevoerde regel te zien (`:236`). | NOT_VALIDATED |
| M90 | Echo-diff behouden tijdens clearing | De tests verlangen het complete commando na clearing, geen echo-afgeleid suffix (`:265`). | NOT_VALIDATED |
| M91 | Onleesbare entries beschermen niets | De invalid-JSON-retentietest verlangt behoud van alle backups (`evidence.test.ts:108`). Parsebare ongeldige records ontbreken. | NOT_VALIDATED |
| M92 | CLI-sessieregel verwijderd | Framed reads/MSP-CLI mogen niet naar serial tijdens geblokkeerde interactieve CLI (`transport.test.ts:403`). | NOT_VALIDATED |
| M93 | Retry-hercontrole verwijderd | De Bluetooth-test en bestaande retrytests verlangen geen nieuwe SET na onzekerheid (`:419`; `wp8_p0_closure_transport.test.ts:207`). | NOT_VALIDATED |

Hier staan verwachte testeffecten uit broninspectie, geen geobserveerde mutantkills. De tests bevatten concrete no-send/no-success/no-release-asserties en positieve controles, maar de geconstateerde gaten betekenen dat niet alle daadwerkelijke write-/transport-/errorpaden adversarieel zijn afgedekt. Met name de positieve AutoRestore-test accepteert een nul-byte-send.

### 256× DEL

`fcWriteGuard.ts:333` veronderstelt een interactieve editor waarin `0x7f` precies één teken verwijdert, op lege invoer niets doet en de invoerbuffer hoogstens 255 tekens bevat. Onder die aannames is 256 DEL gevolgd door het volledige gecontroleerde commando een begrijpelijke oplossing voor achterlopende echo.

`firmwareRuns()` (`wp8_final_acceptance_transport.test.ts:212`) implementeert dezelfde aannames zelf, met een beperkte commandotabel. Het voert geen productie-`cli.c` uit. In deze worktree/review ontbreekt versiegebonden bewijs voor alle ondersteunde CLI-implementaties, bufferlengtes, editor-modi, verliesvrije prefixlevering en echte exit/reboot. **De universele 256× DEL-claim is NOT_VALIDATED.** Dit is een kwalificatiegat; er wordt geen concrete firmwarebypass verzonnen.

## 7. Status eerdere problemen op de uiteindelijke HEAD

| Eerder probleem | Huidige onafhankelijke status |
|---|---|
| Unicode wordt andere wire-bytes; MSP2-setting met lage-byte `=` | CLOSED voor geïnspecteerde softwareweigering tijdens blokkade. Geen nieuwe firmware-uitvoering. |
| Vertraagde echo beëindigt ongecontroleerde pending invoer | Prefix en volledig commando aanwezig; CLOSED onder gemodelleerde editoraannames. Alle firmwareversies/transportcondities: NOT_VALIDATED. |
| MSP/MSP-CLI bereikt interactieve CLI tijdens blokkade | Centrale sessiecheck aanwezig vóór classificatie/permit. CLOSED voor de paginaflag; fysieke modussynchronisatie niet bewezen. |
| Geparkeerde write of retry omzeilt hercontrole | CLOSED voor geïnspecteerde dispatchlogica. Legacy-caller kan blijven wachten, F05. |
| AutoRestore directe weigering / save nog in CLI-wachtrij | CLOSED op bronlogica. Transportlevering en valse succesclaim blijven F01 OPEN. |
| Retentie verdringt vertrouwde targets en gerefereerd bewijs | CLOSED voor geldige records en de geteste quota. Brede unreadable-state-fallback blijft F08 gedeeltelijk open. |
| Direct geweigerde RXFAIL laat Saving hangen | CLOSED op bronlogica. Reeds toegelaten send met geweigerde retry: F05 OPEN. |
| Oude backups zonder provenance worden hersteldoel | CLOSED: `restoreTargetIssue` vereist `stateKnown === true` (`tuneBackup.ts:71`). |
| Read-only check wist onbekende profielscope | CLOSED voor de onterechte vrijgave: `useTuneApply.ts:1397` houdt die entry open. Herstelbeschikbaarheid is F07. |
| Restore wist `in_progress` of schrijft zonder permit-hercontrole | CLOSED voor geïnspecteerde dekking/eigenaarschap/retrycontrole. Geen fysieke Restore-acceptatie. |
| Rebootmelding ondanks geweigerde CLI-exit | Guard-weigering gecorrigeerd; mislukte transportlevering blijft F10 OPEN. |
| Tauri retry onder de centrale guard door | Broncode bevat nog een interne resend (`TauriSerial.ts:769`). Afzonderlijke scope: NOT_VALIDATED; niet gesloten verklaard. |

## 8. Resterende grenzen en eindbesluit

Web Locks en transactieopslag gelden binnen één browser-origin. Andere browsers, origins, apparaten en externe programma's vallen buiten dit autorisatiesysteem. **Er wordt geen craftbrede bescherming geclaimd.** Gewone cross-tab-writers binnen dezelfde origin hebben bovendien F02; gelijktijdige fysieke toegang via Bluetooth/TCP is niet vastgesteld. De Bluetooth-FIFO-test bewijst geen algemene transportordening en sluit F03 niet.

De Tauri-adapter is afzonderlijk **NOT_VALIDATED**. Zijn interne retry heeft sessie-identiteitscontrole, maar geen nieuwe centrale autorisatie. Hij is in de normale webselectie niet actief (`serial.ts:170`). Dit is geen Tauri-veiligheidsgoedkeuring; deze scope is niet opgenomen in de vier P1-/zes P2-tellingen voor web-/app-integratie.

Herstelbaarheid is **PARTIAL / FAIL_CLOSED**: geldig, gedekt herstel wordt in broncode geverifieerd; ontbrekende backups, orphaned `in_progress`, onbekende profielen en onbekende EEPROM-status blijven onzeker. Geen reboot, reconnect, CLI-exit, testsucces of mockuitkomst wordt gebruikt om die onzekerheid weg te nemen. Een handmatige externe reset/wisactie is hier niet gevalideerd of uitgevoerd.

**Codex heeft de zes commits en de gevraagde geïntegreerde veiligheidsclaims beoordeeld. WP8 krijgt FAIL vanwege vier open P1's; daarnaast blijven zes P2's en expliciete NOT_VALIDATED-claims bestaan. De eerdere testuitslag kan deze bevindingen niet sluiten. Absolute Apply blijft BLOCKED. Er zijn geen reparaties uitgevoerd.**

```text
GYROFLIGHT_WP8_CODEX_FINAL_REVIEW
BRANCH=feat/gyroflight-autotune-engine-v2
HEAD=20242d2cd94d3d492ba0d12f390e1bd5d001ff74
COMMITS_REVIEWED=6
COMMIT_REVIEWS=6/6_COMPLETED_WITH_FINDINGS
INTEGRATION_REVIEW=COMPLETED_REQUEST_CHANGES
P0_OPEN=0
P1_OPEN=4
P2_OPEN=6
WRITE_GUARD=PARTIAL_SOURCE_REVIEWED
CLI_SAFETY=PARTIAL_FIRMWARE_ASSUMPTIONS_NOT_VALIDATED
RESTORE_SAFETY=FAIL_FALSE_SUCCESS_PATHS_OPEN
CROSS_TAB_SAFETY=PARTIAL_PRE_ENTRY_RACE_OPEN
RECOVERY_STATE=PARTIAL_FAIL_CLOSED
ABSOLUTE_APPLY=BLOCKED
CODEX_VERDICT=REQUEST_CHANGES
WP8_STATUS=FAIL
SOURCE_CHANGED=NO
PUSHED=NO
MERGED=NO
REPORT_PATH=docs/gyrocore/audit/autotune-v2/2026-10-24-wp8-independent-codex-final-review.md
```
