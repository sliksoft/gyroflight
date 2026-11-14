# Gyroflight v2 — WP8 final repair & acceptance

Datum: 25 oktober 2026. Implementatie: Claude Code. Onafhankelijke reviewer: OpenAI Codex (read-only). Bronrapport: [2026-10-24-wp8-independent-codex-final-review.md](2026-10-24-wp8-independent-codex-final-review.md).

**Samenvatting**
- Alle tien bevindingen F01–F10 zijn hersteld in productiecode.
- Elk herstel heeft regressietests die vóór de reparatie aantoonbaar faalden.
- Codex beoordeelde elk werkpakket in drie rondes, gevolgd door twee volledige integratiereviews en gerichte hercontroles. Alle bevindingen zijn in afzonderlijke commits verwerkt.
- De laatste volledige integratiereview van de definitieve productiecode (`be798ce4`) beoordeelt **F01–F10 als CLOSED** en vindt **P0 = 0 en P1 = 0**.
- Er blijft één nieuwe **P2-beschikbaarheidsbevinding** over. Die faalt veilig dicht (fail-closed). Codex geeft daarom formeel `REQUEST_CHANGES`.
- Twee pogingen om die P2 op te lossen veroorzaakten volgens Codex nieuwe P1's. Ze zijn teruggedraaid (§11).
- Volledige suite: 5684 PASS / 0 FAIL / 14 SKIP. Lint, typecheck en build slagen. De echte browsertest scoort 20/20. Van de 60 mutanten zijn er 59 gedood.

**Eindstatus: `FAIL`.** Het acceptatiecriterium "Codex heeft de definitieve implementatie goedgekeurd" is niet gehaald. Dat is de enige reden: er staat geen enkele P0 of P1 open.

Absolute Apply blijft **BLOCKED**. Er is geen hardware gebruikt: geen FC-write, geen flash, geen drone.

---

## 1. Werkomgeving en begin-/eindtoestand

| Onderdeel | Waarde |
|---|---|
| Repository | `Gyroflight-worktrees/autotune-engine-v2` (git worktree) |
| Branch | `feat/gyroflight-autotune-engine-v2` (ongewijzigd) |
| HEAD_BEFORE | `20242d2cd94d3d492ba0d12f390e1bd5d001ff74` (zoals verwacht) |
| HEAD_AFTER | `6d295c31554b9240955ac6b125d6e95a17022a54` (productiecode identiek aan `be798ce4`) |
| Remote | `origin` 8 commits voor bij aanvang, nu 43. Niet gepusht, niet gemerged, niet gerebased. |
| Node | v24.21.0 voor tests, build en GitNexus. |
| GitNexus | Index stond op `17fd4b0` en is opnieuw geanalyseerd op `20242d2c` (33.541 symbolen). |

**Kanttekeningen bij de omgeving**
- GitNexus is gebruikt voor oriëntatie (aanroepers, flows). De impactanalyse van de wijzigingen is gedaan door de broncode te lezen. Er wordt **geen graaf- of PDG-validatie** geclaimd.
- `gitnexus analyze` voegde een sectie toe aan `AGENTS.md`. Die is direct teruggezet. `AGENTS.md` is ongewijzigd ten opzichte van de begin-HEAD.
- `.serena/` en de bestaande auditdocumenten zijn behouden.
- Er liepen geen conflicterende processen. Er waren geen onverwachte wijzigingen aan dezelfde bestanden.

**Baseline op 20242d2c (opnieuw uitgevoerd)**
- 5512 PASS / 0 FAIL / 14 SKIP.
- Log: `codex-repair-evidence-wp8/baseline-20242d2c-tests.log`.

## 2. Architectuur: de schrijf-, herstel- en bewijsketen

Elke opdracht doorloopt nu de volgende keten. Per stap staat wat die stap wel en niet bewijst.

| # | Stap | Waar | Wat het bewijst |
|---|---|---|---|
| 1 | **Geaccepteerd** door de software | UI → `useSaving.runSave`, de Gyroflight-routes (`useTuneApply`) of de CLI → `fcWriteGuard`: `mspRequestRefusal`, `cliCommandRefusal`, `interactiveCliText` | De schrijfcheck liet het toe. Bij foreign writes eist die nu ook de **write lease** (F02); bij transactiewrites een `WritePermit` plus de exclusieve lease. |
| 2 | **In de transportwachtrij** | `msp.ts` (MSP-callbacks, CLI-queue) → `serial.send` (facade-wachtrij per verbinding) | De opdracht staat in een FIFO-wachtrij. Er is nog niets verzonden. |
| 3 | **Door de transportadapter verzonden** | De facade vraagt `stillWanted` vlak vóór de overdracht (F03-review). Daarna volgen `WebSerial.send` (hele frames, FIFO, gedeeltelijk = korter), `WebBluetooth` of `WebSocket`. | `bytesSent === framelengte`: de adapter heeft alle bytes aangenomen. **Dit is geen ontvangst door de FC.** Een OS-, USB- of netwerkbuffer daarna valt buiten zicht; voor WebSocket wordt `bufferedAmount` meegeteld (zie §8). |
| 4 | **Door de FC bevestigd** | MSP: het antwoord van de firmware in antwoordrichting (`>`). Een `!`-antwoord op een write wordt verworpen (`MspFirmwareRefusedError`). `<`-frames en onbekende richtingen tellen niet mee. Een write wordt pas afgehandeld nadat de eigen bytes aan de adapter zijn overgedragen. Een write die vertrok terwijl een eerdere transmissie van dezelfde code nog onbeantwoord was (binnen 4 s), krijgt geen antwoord als bewijs (`MspAmbiguousAnswerError`); MSP heeft geen request-id. CLI: het ETX-antwoord bij een opdracht die geheel is afgeleverd. | De firmware heeft de opdracht verwerkt en geaccepteerd. |
| 5 | **Door readback geverifieerd** | Alleen de Gyroflight-transacties (`useTuneApply`: readback, vergelijken, opslaan, opnieuw lezen) | De RAM-waarden komen overeen met de verwachting. |
| 6 | **Aantoonbaar persistent** | MSP: de ACK van `MSP_EEPROM_WRITE` (`eepromSave.ts`). CLI: `# saving`/`Rebooting` in de uitvoer van dezelfde `save`. Transacties: daarnaast een readback na het opslaan (firmware `readEEPROM`). | Op basis van **firmwarebroncode** (§9): de firmware antwoordt pas na `writeEEPROM()`, en `writeEEPROM()` verifieert of keert nooit terug. **Geen hardwareresultaat en geen config-readback** bij de tab-saves. |

**Uitkomst per fase**
- Elke fase heeft nu een eigen uitkomst: `not_saved`, `unknown`, `not_verified` of `confirmed`.
- Een latere fase wordt nooit geclaimd zonder het bewijs van die fase.
- Er is één autorisatiesysteem. De lease is een voorwaarde binnen `fcWriteGuard`, geen tweede, concurrerend mechanisme.

## 3. Commits (35, `20242d2c..6d295c31`)

| # | Commit | Inhoud |
|---|---|---|
| 1 | `35b2b278` | F03 WebSerial: één logisch frame tegelijk, gedeeltelijke verzending gerapporteerd |
| 2 | `8bfa33b6` | F09 CLI-drain behoudt MSP-antwoorden; onzekere sessie wordt gesloten; afleverstatus |
| 3 | `8f46fac0` | F01 CLI-`save` alleen als bewaard op bewijs van de firmware |
| 4 | `3dce3954` | F10 CLI-tab reboot alleen na een volledig verzonden `exit` |
| 5 | `62349ae3` | F04 EEPROM-save alleen gemeld na ACK van de firmware (gedeeld contract) |
| 6 | `1b8b89ff` | F05/F06 Failsafe-save eindigt altijd en blijft dirty tot EEPROM bevestigt |
| 7 | `30e0158f` | F08 backupretentie leest transactierecords met dezelfde definitie als de store |
| 8 | `2f413fc3` | F02 write lease: elke write van elke tab doet mee |
| 9 | `af441af9` | Review ronde 1, F03/F09: niets gaat te laat weg; geen antwoord naar het verkeerde commando |
| 10 | `b2a31a44` | Review ronde 1, F10: geen tweede `exit`; tabwissel blokkeert niet |
| 11 | `26893703` | Review ronde 1, F01: Presets/Backups melden alleen bevestigde saves |
| 12 | `4d4f1b8c` | Review ronde 1, F04: alleen het eigen antwoord van de firmware bevestigt EEPROM |
| 13 | `82e3f512` | Review ronde 1, F05/F06: weigering beëindigt de save; baseline = wat verzonden is |
| 14 | `f9faa2db` | Review ronde 1, F08: migratie van de oude lijst overschrijft nooit een entry |
| 15 | `b1317bf8` | F07 read-only diagnose van onzekere entries; blokkade blijft |
| 16 | `6500908c` | F02 test met echte browsertabs (Playwright) |
| 17 | `5c22d2ad` | Docs: 256×DEL tegen firmwarebron; BackupsTab-hook |
| 18 | `65208a75` | Review ronde 2: `!` op een write wordt verworpen; niets te laat; geen hervat frame |
| 19 | `f10fb606` | Review ronde 2, F02: lease blijft vast zolang er nog iets bij het transport ligt; yield wordt herhaald |
| 20 | `616b7675` | Review ronde 2, F10: de deadline geldt alleen voor de eigen verbinding |
| 21 | `3682fcb9` | Review ronde 2, F06: velden vergrendeld tijdens het opslaan |
| 22 | `5ca1b943` | Review ronde 2, F08: de check leest de opslag opnieuw na de reads |
| 23 | `e03cbc48` | Review ronde 2, F07: diagnose biedt alleen wat de routes accepteren; alleen lezen |
| 24 | `3474be2b` | Browsertest stuurt de eigen module-instanties van de app aan |
| 25 | `3b33733d` | Review ronde 3: Ports-keten stopt bij weigering; WebSocket-buffer en gekoppelde verzoeken geteld |
| 26 | `2f92a305` | Review ronde 3, F06: velden `inert` tijdens het opslaan |
| 27 | `00eb8488` | Review ronde 3, F07: geen herstel aangeboden zolang de unreadable-latch staat |
| 28 | `decc6c24` | Integratiereview R1/R3: geen antwoord bewijst een write waar het misschien niet bij hoort; CLI-resultaat vóór de opvolger |
| 29 | `3b9495f4` | Integratiereview R2: een mislukte AutoRestore stopt zijn commandolus |
| 30 | `be798ce4` | Hercontrole: antwoordhistorie overleeft een tabwissel; restore-wachttijd eindigt altijd |
| 31 | `8ccea0ee` | Test: AutoRestore dat tussen twee regels eindigt, verstuurt niets meer (gevonden via de mutatierun) |
| 32 | `b3ca2c6a` | Poging voor de P2: pending sends per generatie. **Teruggedraaid**: volgens de hercontrole een nieuwe P1. |
| 33 | `d0f94598` | Tweede poging: tellen tot de verbinding gesloten is. **Teruggedraaid**: volgens de hercontrole twee nieuwe P1's. |
| 34 | `302e7f5b` | Revert van 33 |
| 35 | `6d295c31` | Revert van 32. De productiecode is weer gelijk aan `be798ce4`. |

De twee revert-commits (34, 35) hebben het standaardbericht van git en geen `Co-Authored-By`-regel. Ze zijn niet herschreven: dat zou een rebase vergen, en die is in deze opdracht niet toegestaan. De reden voor de revert staat in §11.

**Omvang:** 54 bestanden, +6412/−807 regels (inclusief de teruggedraaide pogingen; netto gelijk aan `be798ce4` plus één test). Elke nieuwe upstream-hook staat in `docs/gyrocore/UPSTREAM.md`.

## 4. Root causes F01–F10 en reparatie

### F01 — AutoRestore (P1) — CLOSED (begrensd)

**Root cause**
- `onSent` liep vóór `serial.send`. Het resultaat van het transport werd genegeerd.
- Na een vaste vertraging van 500 ms volgde "succes".
- Elke disconnect telde als de reboot van de save.
- `saveAndReconnect` (Presets/Backups) behandelde elke gesloten poort als een geaccepteerde save.

**Reparatie**
- De CLI-queue rapporteert aflevering: alle bytes van het frame, via `onDelivery`.
- Een `save` geldt alleen als *confirmed* wanneer de firmware zelf `# saving` of `Rebooting` print. Volgens de broncode gebeurt dat pas na `writeEEPROM()` (§9).
- Overige uitkomsten zijn expliciet:
  - `not_verified`: volledig verzonden, geen bevestiging. Eigen melding; de flasher houdt Restore beschikbaar.
  - `not_saved`: geweigerd, nooit verzonden, of beantwoord zonder op te slaan.
  - `unknown`: niet volledig verzonden, of het transport rapporteerde niets.
- `saveAndReconnect` geeft `ok` alleen bij *confirmed* en waarschuwt de gebruiker zelf. Backups meldt succes pas daarna.
- Na een mislukking stopt de commandolus van AutoRestore. Er gaat niets meer weg, ook niet over een nieuwe verbinding, en niets blijft hangen (integratiereview R2).

**Grenzen**
- Bewijs = firmwareuitvoer op basis van broninspectie, geen config-readback.
- MINIMAL_CLI-builds printen alleen `Rebooting`.
- Op het STX-pad (vanaf 4.5.4) is AutoRestore vereist.
- `PERSISTENCE` zonder deze tekst = `PERSISTENCE_NOT_VERIFIED`, nooit PASS.

### F02 — Cross-tab-isolatie (P1) — CLOSED binnen dezelfde browser-origin

**Root cause**
- Alleen Gyroflight-transacties namen de Web Lock.
- Gewone SET's, profielwissels, saves en CLI-writes van een andere tab zagen een transactie pas zodra die zijn pending entry had opgeslagen. Dat was na de reads en de backup.

**Reparatie (`fcWriteLease.ts`, één beleid binnen `fcWriteGuard`)**
- Elke pagina houdt de Web Lock `gyroflight.fcWrite.lease` in *shared*-modus vast. De vlag wordt gezet bij de grant en gewist vóór het loslaten.
- `fcWriteGuard` laat een foreign write alleen toe zolang de pagina de lease vasthoudt (synchrone check).
- Een transactie of read-only check neemt de lease *exclusive*, binnen `FC_WRITE_LOCK` en vóór de eerste read. Volgorde:
  1. Eigen shared-hold en lopend verzoek opgeven (anders deadlock op zichzelf).
  2. Het exclusieve verzoek in de wachtrij zetten.
  3. Via `BroadcastChannel` om een yield vragen, elke 250 ms herhaald.
- Een pagina geeft de lease pas op als ze stil is:
  - niets meer bij het transport (`serial.pendingSends`, inclusief WebSocket-buffer);
  - geen write meer die op antwoord wacht;
  - geen CLI-opdracht onderweg;
  - geen `runSave` actief;
  - 300 ms geen toegelaten write.
- Na 8 s zonder exclusive wordt de transactie geweigerd (`fc:write_lease_timeout`). Zonder Web Locks wordt niets geschreven (fail-closed).
- Eigen transactiewrites eisen de exclusieve lease.
- De autorisatie (gates, token, live readback, `notCoveredByRestore`) draait ná het verkrijgen van het slot.

**Bewezen scope**
- vitest: lease-pagina's over een spec-getrouwe shim met een echt `BroadcastChannel`, plus een tweede productie-module-instantie als "andere tab" met een echte transactie.
- **Echte Chromium-tabs** in één browsercontext (Playwright, headless): 20/20. Vóór de reparatie liet tab B zijn SET toe tijdens de transactie van tab A.

**Expliciet geen claim** voor:
- andere browsers en browserprofielen (aangetoond: een tweede context wordt niet tegengehouden);
- andere origins (bijvoorbeeld `localhost` versus `127.0.0.1`) en andere apparaten;
- externe programma's.

Ook runtimeverzoeken (RTC, arming-flag, motortest, reboot) worden niet door de lease tegengehouden. Achtergrond-throttling is niet gemeten. Een bevroren tab leidt aantoonbaar tot weigering (fail-closed).

**Open P2, beschikbaarheid (§8, §11).** Een verzending die vastloopt op een gesloten verbinding, of een gesloten WebSocket met buffer, houdt de pagina "bezig". Andere tabs worden dan geweigerd tot een pagina-reload. Dit faalt veilig dicht.

### F03 — WebSerial-batching (P1) — CLOSED

**Root cause**
- `batchWrite` verstuurde 63-byte-chunks met een await per chunk, zonder serialisatie van de hele verzending.
- Een tweede `send` kwam tussen de chunks terecht.

**Reparatie**
- `WebSerial.send` werkt met een privé FIFO-wachtrij van hele logische verzendingen. Elke verzending in de wachtrij controleert de poort opnieuw.
- Een gedeeltelijke verzending meldt het werkelijke aantal bytes.
- Een frame is gebonden aan zijn writer en verbinding. Na een disconnect gaat het nooit verder op de volgende verbinding.
- De serial-facade serialiseert per verbinding (generatie). `stillWanted` vlak vóór de overdracht laat een verlopen, opgeruimd, opgebrand of nu geweigerd verzoek niet meer vertrekken. Een verzoek waarvan geen enkele poging vertrok, telt als *niet verzonden*.
- Bluetooth en WebSocket zijn niet functioneel gewijzigd. Wel loopt de facade-serialisatie nu ook voor die transporten, en WebSocket meldt `bufferedAmount`.

**Grens:** de autorisatie vindt plaats bij toelating en opnieuw vlak vóór de overdracht aan de adapter, niet op het moment dat de bytes op de draad gaan.

### F04 — EEPROM Save-and-Reboot (P1) — CLOSED

**Root cause**
- `writeConfiguration` stuurde `MSP_EEPROM_WRITE` met een legacy-callback.
- `send_message` roept die callback ook aan **zonder te verzenden** wanneer de verbinding weg is. Gevolg: "EEPROM saved" plus een reboot.
- `saveToEeprom` meldde "saved" op een foutantwoord van de firmware.
- `useSaving` slikte een geannuleerde EEPROM-save stil in.

**Reparatie: één contract, `eepromSave.ts`**

| Situatie | Uitkomst |
|---|---|
| ACK van de firmware | saved |
| Foutantwoord, of verbinding weg vóór verzending | `not_saved` |
| Verloren of corrupt antwoord, geleegde wachtrij, geweigerde retry | `unknown` |

Dit contract wordt gebruikt door `writeConfiguration`, `saveToEeprom`, de OSD-store en `useTuneApply`.

Aanvullende reparaties (review ronde 1–3):
- Het echo-frame `$M<` en een onbekende richtingsbyte zijn geen antwoord.
- Een weigering na een retry blijft `unknown`, ook voor gekoppelde wachtenden en nadat de eerste wachtende is opgegeven.
- **Een `!`-antwoord op een write verwerpt nu `MSP.promise` voor alle tabs.** Zie §8, gedragswijziging.
- OSD-Save-and-Reboot reboot alleen na een bevestigde save.
- De legacy-Ports-keten controleert elk antwoord.
- **Antwoordtoewijzing (integratiereview R1).** MSP-antwoorden hebben geen request-id. Daarom geldt:
  - een antwoord handelt een write pas af nadat de eigen bytes zijn overgedragen;
  - een write die vertrok terwijl een eerdere transmissie van dezelfde code nog onbeantwoord was (binnen 4 s), is ambigu, en de EEPROM-uitkomst wordt dan `unknown`;
  - identieke writes delen nooit één transmissie;
  - de historie blijft bewaard bij een tabwissel en wordt pas gewist bij de disconnect.
- RAM- en EEPROM-toestand worden gescheiden gemeld (`gyroflightEepromNotConfirmed`).

### F05 — Failsafe RXFAIL-retry (P2) — CLOSED

**Root cause**
- Legacy RXFAIL-callbacks liepen nooit bij een geweigerde retry of na opgebruikte retries. `isSaving` bleef dan voor altijd actief.

**Reparatie**
- De kanalen gaan via `confirmedWrite`, met `MSP.promise` per kanaal.
- Een check-weigering, uitblijvend antwoord, geweigerde retry (`WriteRetryRefusedError`: "kan uitgevoerd zijn"), geleegde wachtrij of foutantwoord van de firmware beëindigt de save met een melding. Er volgt geen EEPROM-save.
- Een onderbroken save na een verzonden write wordt gemeld (`gyroflightSaveInterrupted`).

### F06 — Failsafe dirty-state (P2) — CLOSED

**Root cause**
- `initializeDefaults()` liep vóór `saveAndReboot()`.

**Reparatie**
- Payloads, RXFAIL-kanalen en baseline worden samen vastgelegd bij de start van de save.
- De baseline wordt pas toegepast in `onSaved`, na de EEPROM-ACK.
- Bij een mislukte of onbevestigde save blijft de tab dirty en blijft Save actief.
- De velden zijn `disabled` en `inert` tijdens het opslaan. Een wijziging tijdens het opslaan zou anders door de reboot verloren gaan.

### F07 — Herstel van verweesde transacties (P2) — CLOSED als diagnose; herstel FAIL_CLOSED

**Uitgangspunt**
- Volledig herstel is voor deze klassen niet te bewijzen.
- Een verweesde schrijfactie kan overal gestopt zijn en heeft een eventuele profielwissel nooit vastgelegd.
- Een onbekende EEPROM-inhoud is niet terug te lezen.

**Reparatie: alleen een read-only diagnose (`transactionDiagnosis.ts`, Diagnose-knop)**
- Per entry toont de diagnose wat onbekend is:
  - verweesd (geen pagina van de origin houdt `FC_WRITE_LOCK`, gelezen via `locks.query`);
  - backup ontbreekt;
  - EEPROM onbekend of aangepast;
  - profielen onbekend of meerdere;
  - profielwissel gezien;
  - onderbroken Restore.
- Ze toont alleen herstel dat de routes ook accepteren:
  - **Restore**, alleen bij een absolute route met een geldige, vertrouwde backup van precies dat profiel;
  - **check**, alleen bij EEPROM niet geschreven, één gemeenschappelijk profiel en geen wissel;
  - beide **per craft**: één herstelactie moet alle entries dekken.
  - Anders: `none`, met concrete vervolgstappen.
- De diagnose wijzigt, wist en verzendt niets. Ze leest zonder migratie, respecteert de unreadable-latch en vervalt bij een andere craft of andere entries. Ze meldt zelf dat ze geen bewijs is.

**Herstelbeschikbaarheid**

| Klasse | Herstel |
|---|---|
| Verweesd `in_progress` | **NONE (FAIL_CLOSED)** |
| Onbekende of meerdere profielen | **NONE** |
| Ontbrekende backup | **NONE** |
| EEPROM `unknown` | Alleen via Restore als die dekt, anders **NONE** |
| Afgeronde entry, één profiel, absolute route, vertrouwde backup | Restore beschikbaar |
| EEPROM `no`, één profiel, backup aanwezig | Check beschikbaar |

Er is geen automatische vrijgave door reboot, reconnect, tijdsverloop of een gedeeltelijke readback.

### F08 — Backup-retentie (P2) — CLOSED

**Root cause**
- De retentiescanner accepteerde elk geparsed object met een string `backupId`. De transactiestore was strenger.

**Reparatie**
- Er is één afhankelijkheidsvrije canonieke parser, `transactionRecords.ts`, voor beide stores.
- Alles wat de transactiestore niet kan lezen, betekent: retentie laat niets vallen.
- Retentie leest alleen en migreert niet. Een oude lijst met dubbele of botsende id's is onleesbaar; er wordt niets overschreven.
- Een onleesbare backuplijst wordt niet overschreven.
- De read-only check meldt nooit "resolved" bij onleesbare opslag, ook niet als die onleesbaar wordt tijdens de reads.

**Getest:** ongeldige JSON, parsebare maar ongeldige records, verkeerde identiteit, ontbrekende UID of tijd, onbekende actie of profielen, oude legacyvormen, meerdere gelijktijdige referenties, quotagrenzen, botsende migratie.

### F09 — CLI-timeout en antwoordisolatie (P2) — CLOSED

**Root cause**
- De drain gooide alle bytes weg, ook MSP-antwoorden.
- Een nieuwe CLI-aanvraag kon tijdens de drain starten.
- Na de grace-periode kon een laat antwoord bij de volgende aanvraag terechtkomen.

**Reparatie**
- MSP-frames worden tijdens de drain gewoon gedecodeerd.
- De drain eindigt alleen op de ETX van het late CLI-antwoord.
- Tijdens de drain gaat er geen CLI-opdracht weg. De drain wordt gezet vóór de callback van de aanroeper.
- Een antwoord telt pas na volledige aflevering.
- Grace zonder ETX, of een gedeeltelijke verzending, maakt de sessie onzeker. Alle CLI-opdrachten worden dan geweigerd, inclusief de lopende, tot `disconnect_cleanup` (herinitialisatie).
- Resultaten van een oude verbinding worden genegeerd.
- Een timeout geeft een terminale fout, met afleverstatus en de ontvangen uitvoer.
- Het resultaat van het transport bereikt de CLI-queue (`onResult`) voordat de volgende verzending mag starten. Een gedeeltelijke verzending sluit de sessie dus vóór de check van de opvolger. Een lopende opdracht die mogelijk is verzonden, heet niet langer "niet verzonden" (integratiereview R3).

### F10 — CLI-exit en transportfalen (P2) — CLOSED

**Root cause**
- `cleanup` meldde een reboot, wiste de CLI-flags en startte een reconnect, wat het transport ook deed (0 bytes, gedeeltelijk, fout).

**Reparatie**
- Een reboot pas na volledige aflevering van `exit`, inclusief het DEL-voorvoegsel.
- Anders:
  - de flags blijven staan (de firmwaremodus is onbekend);
  - de gebruiker krijgt een melding en het advies om de FC uit en aan te zetten;
  - de verbinding wordt verbroken via `disconnectCliModeUnknown()`, zonder MSP-verzoek.
- Er is een latch tegen een tweede `exit` en een deadline van 2 s.
- Het effect geldt alleen voor de eigen verbinding (generatie).

## 5. Bewijs dat de tests vóór de reparatie faalden

Alle regressietests zijn eerst tegen de ongerepareerde code gedraaid. Voor latere rondes gebeurde dat in een tijdelijke worktree op de commit van vóór de fix; de main tree bleef onaangeroerd.

**Werkwijze bij afwijkingen**
- Positieve controles slaagden vóór én na de fix.
- Twee tests slaagden vóór de reparatie om een verkeerde reden. Ze zijn strikter gemaakt en daarna opnieuw tegen de oude code gedraaid:
  - doorlekkende decoderrichting;
  - de notice verdween in de tweede craft-test.

Logs staan in `codex-repair-evidence-wp8/before-fix/`.

| Onderdeel | Commit vóór de fix | Falend vóór (de rest zijn positieve controles) |
|---|---|---|
| F03 | 20242d2c | 3/5 |
| F09 | 35b2b278 | 9/10 |
| F01 | 8bfa33b6 | 14/14 |
| F10 | 8f46fac0 | 6/7 |
| F04 | 3dce3954 | 8/11 |
| F05/F06 | 62349ae3 | 5/7 |
| F08 | 1b8b89ff | 13/20 |
| F02 (vitest, tweede module-instantie) | 30e0158f | 2/2 |
| F02 (echte Chromium-tabs) | 30e0158f | B's SET toegelaten tijdens A's transactie |
| Review ronde 1 | | F03/F09 6/9, F10 2/9, F01 2/18, F04 2/13, F05/F06 5 van de nieuwe gevallen, F08 3/24 |
| Review ronde 2 | 5c22d2ad | 16 nieuwe gevallen, alle 16 falend |
| Review ronde 3 | 3474be2b | 7 nieuwe gevallen, alle 7 falend |
| Integratiereview (R1–R3) | 00eb8488 | 4 van de 5 falend (de rest is een positieve controle) |
| Hercontrole | 3b9495f4 | 2 van de 7 falend: tabwissel-historie en een gooiende callback |
| Teruggedraaide P2-poging | b3ca2c6a | 3 van de 9 falend. De productiecode is daarna teruggedraaid; de tests in de suite zijn weer de versie van be798ce4. |

## 6. Mutatietests: werkelijk uitgevoerd

Elke mutant is toegepast in een aparte worktree. Daarna zijn de relevante suites gedraaid en is het bestand teruggezet. Resultaten in JSON: `codex-repair-evidence-wp8/mutations/`.

**Ronde 1 (M101–M128): 28/28 gedood.** Dit dekt elk F01–F10-herstel en de fixes uit review ronde 1, bijvoorbeeld:
- WebSerial zonder wachtrij;
- `stillWanted` genegeerd;
- drain-check verwijderd;
- aflevering altijd waar;
- `cliSaveConfirmed` altijd waar;
- `not_verified` als succes;
- reboot ongeacht aflevering;
- latch verwijderd;
- `unsupported` genegeerd;
- `confirmedWrite` zonder controle;
- baseline vóór de save;
- retentie zonder fallback;
- lease altijd vastgehouden;
- transactie zonder exclusive;
- diagnose met `in_progress`-herstel.

**De eerder niet uitgevoerde M87–M93: nu uitgevoerd en gedood**

| Mutant | Wijziging | Uitkomst |
|---|---|---|
| M87 | Masker op de lage byte | Gedood |
| M88 | Non-ASCII | Gedood |
| M89 | 4 DEL | Gedood |
| M92 | CLI-sessiecheck | Gedood |
| M93 | Retry-hercontrole | Gedood |

- **M90 is niet uitgevoerd.**
- **M91** is alleen indirect gedekt, via M119 (retentie zonder unreadable-fallback, gedood).

**Ronde 2 (M129–M143): 14/15 gedood.**
- M133 overleeft: de extra wire-check voor de onzekere sessie in `stillWanted`.
- Die check is redundant, omdat `_cli_session_lost` de lopende opdracht al beëindigt. Het is een defense-in-depth-laag die de tests niet afzonderlijk kunnen bereiken. Er is dus geen dekkingsgat in de eigenschap zelf.

**Ronde 3 (M144–M148): 5/5 gedood.**

**Integratiefixes (M149–M155): 7/7 gedood.**
- M153 (run-check van AutoRestore) overleefde eerst. De test dekte alleen een einde tijdens een lopende opdracht. Een nieuwe test (`8ccea0ee`, einde tussen twee regels) doodt hem nu.
- De eerste versie van M155 was ongeldig: de syntax brak, en er liep 0 tests. Hij is vervangen door een geldige mutant, die gedood is.

**Totaal: 59/60 gedood.** De enige overlevende is M133, een redundante laag.

## 7. Testresultaten op HEAD_AFTER (6d295c31), opnieuw uitgevoerd

| Controle | Resultaat |
|---|---|
| `npx vitest run` (volledige suite) | **365 bestanden geslaagd / 8 overgeslagen; 5684 PASS / 0 FAIL / 14 SKIP** |
| `npm run lint` (eslint + `vue-tsc`) | exit 0 |
| `npm run build` | exit 0 |
| Browser cross-tab (Playwright, Chromium headless, echte tabs) | **20/20 PASS** (los van vitest) |

**Opmerkingen bij de resultaten**
- Eerdere baseline: 5512 / 0 / 14. Het verschil komt door 172 nieuwe tests; geen enkele bestaande test is verwijderd.
- `npm test` draait eerst `pretest` (lint). De suite is daarom apart met vitest gedraaid; lint is apart uitgevoerd.
- Logs: `codex-repair-evidence-wp8/final/` en `.../browser/`.

### Gewijzigde eerdere tests (allemaal strenger, geen enkele zwakker)

1. **Harness-standaard transport.** Was `{ bytesSent: 0 }`, nu het volledige frame. Een verzending van 0 bytes is nu een mislukking, en wordt expliciet getest.
2. **`msp_cli_queue`.** De forced-progress-test is vervangen door de test "sessie gesloten na grace". De test is omgezet naar TypeScript. Twee tests wachten nu op aflevering vóór succes.
3. **Positieve AutoRestore-test.** Die accepteerde 0 bytes als succes. Nu is de bevestiging van de firmware vereist, plus een test voor `not_verified`.
4. **`saveAndReconnect`-test.** Een gesloten poort zonder `delivered` en uitvoer is geen succes meer.
5. **RXFAIL-test.** Async gemaakt (promise-pad).
6. **Failsafe-tests.** Nieuwe handtekening met `captureBaseline`. De baseline-commit gebeurt alleen bij de EEPROM-ACK.
7. **Verwachting in de routes-test.** Die bevat nu ook `fc:write_lease_not_held`.
8. **Verwachtingen over CLI-refusal in de wachtrij.** Het late antwoord eindigt via ETX, zodat de dispatch-check echt bereikt wordt.
9. **`msp_promise`, drie upstream-dedup-tests.** Ze gebruikten `MSP_EEPROM_WRITE` als voorbeeldcode. Ze gebruiken nu een leescode, `MSP_SERVO_MIX_RULES`, met dezelfde mechaniekasserties. Voor writes is dedup bewust uitgeschakeld; dat is nieuw en wordt expliciet getest.
10. **Spies op `serial.send`** (`msp_promise`, `eeprom_save`, `failsafe_save`). Ze vragen nu `stillWanted` zoals de facade doet. De harnassen wissen de nieuwe transmissieadministratie tussen tests.

## 8. Gedragswijzigingen met bredere impact en restgrenzen

**Fail-closed lease**
- Zonder `navigator.locks` (bijvoorbeeld HTTP zonder secure context op een LAN-IP) worden **alle** foreign writes geweigerd. Dat geldt dus voor alle tab-saves, niet alleen voor transacties.
- Capacitor 8 draait standaard op `https://localhost` (een secure context), en Android System WebView ondersteunt Web Locks. **Android is NOT_VALIDATED.** Op een WebView zonder Web Locks worden alle writes geweigerd.

**`!` verwerpt writes**
- Voor elke tab die een SET afwacht via `MSP.promise` (onder andere OSD, Receiver, Motors, PID, VTX, GPS, LED, Servos, Auxiliary, Adjustments, Configuration, Power, Sensors, CLI-settings) faalt een save nu bij een weigering door de firmware. Voorheen werd die stil als geslaagd gemeld.
- Op oudere firmware die een SET-code niet ondersteunt, faalt zo'n save nu zichtbaar. Dat is bedoeld.

**Facade-serialisatie**
- Sends gaan per verbinding één voor één, ook voor BLE, TCP en de STM32-serial-flasher. **De flasher is niet opnieuw gevalideerd.**

**Restgrenzen (bewust buiten scope, niet stilgezet)**

| Onderwerp | Grens |
|---|---|
| Motors-tab | Zet de baseline na de save uit de actuele waarden: hetzelfde patroon als F06. Gerapporteerd, niet gerepareerd. |
| Overige legacy `send_message`-ketens buiten Failsafe en Ports | Kunnen bij een geweigerde retry blijven hangen. Er is geen valse succesclaim gevonden. De LED-configwaarden zijn een fire-and-forget live-preview. |
| Raw `#` (CLI-tab, AutoBackup) en webstm32-bootloaderflash | Gaan buiten de schrijfcheck om, zoals voorheen. |
| `exit` van AutoBackup | Heeft geen aflevercheck en claimt niets. |
| Tauri | Interne resend omzeilt `stillWanted` en de centrale guard: **NOT_VALIDATED**. De webbuild kiest `TauriSerial` alleen bij `isTauri()` (`serial.ts`) en gebruikt die route dus niet. |
| Transportlevering | "Bytes overgedragen aan de adapter" is niet "ontvangen door de FC". OS-, USB- en native-TCP-buffers zijn niet zichtbaar; WebSocket-`bufferedAmount` wordt wél meegeteld. |
| **Open P2, beschikbaarheid (Codex, integratiereview be798ce4)** | Een verzending die vastloopt op een verbinding die inmiddels gesloten is, blijft als "bezig" tellen. De pagina geeft de lease dan niet meer op en transacties of checks in andere tabs worden geweigerd, tot een pagina-reload. Dit faalt veilig dicht; er is geen write-bypass. |
| **Open P2, beschikbaarheid (Codex, hercontrole d0f94598, geldt ook voor be798ce4)** | Een gesloten WebSocket met resterend `bufferedAmount` blijft als "bezig" tellen tot de socket wordt vervangen. Ook dit faalt veilig dicht. |
| Antwoordvenster van 4 s | Dit is een heuristiek, geen request-correlatie. Een antwoord dat later komt dan 4 s na een onbeantwoorde transmissie, of een sprong van de wandklok, kan een nieuwere write ten onrechte bevestigen. Na een tabwissel kan een volgende save tot 4 s lang `unknown` melden: dat is fail-closed. |
| Achtergrond-throttling | Niet gemeten. De deadline van 8 s hangt af van de timerplanning; altijd fail-closed. |

## 9. CLI-firmwareaannames (256× DEL)

Volledige samenvatting: `codex-repair-evidence-wp8/firmware/betaflight-firmware-source-review.md`, met SHA-256 van de bronnen.

**Gelezen bronnen**
- Betaflight 4.3-, 4.4-, 4.5- en 2025.12-maintenance, en master, gelezen op 25 oktober 2026.
- De hoofdsessie heeft de kernregels zelf nagelezen.

**Bevindingen**
- In interactieve modus verwijdert `0x7F` precies één teken. Op een lege buffer doet het niets.
- De buffer bevat hoogstens 256 tekens (master: 255; STM32F1-builds van 4.3: 128).
- 256× DEL maakt de regel daarom leeg op alle onderzochte branches.
- `\t`, `?` en CTRL-D zijn speciaal. Gyroflight weigert ze in onzekere toestand, net als niet-ASCII.
- Een volle regel wordt afgekapt uitgevoerd. In 4.3–2025.12 schrijft dat bovendien één byte buiten de buffer (een firmwarebug). De afgekapte regel begint met het gecontroleerde commando.

**Status:** de werking is **NOT_VALIDATED op hardware en voor andere firmware** (INAV, Emuflight, builds met een afwijkende buffer). Op het STX-pad doet DEL niets; daar wordt het ook niet gebruikt.

## 10. Status van Absolute Apply

`ABSOLUTE_SAFETY_POLICY.hardwareValidated` blijft `false` (`absoluteEvaluate.ts:64`), dus **ABSOLUTE_APPLY=BLOCKED**.

- Er zijn geen wijzigingen in `src/gyrocore/safety`, `releaseGate` of `productLock`.
- `UPSTREAM_ANALYTICS_ENABLED` en `BETAFLIGHT_ACCOUNTS_ENABLED` blijven `false`.
- Er zijn geen nieuwe netwerkverbindingen; `BroadcastChannel` en Web Locks zijn lokaal in de browser.

## 11. Onafhankelijke Codex-reviews

**Uitvoering**
- `codex exec -s read-only --ephemeral` (CLI 0.164.0).
- Steeds op een eigen detached worktree van de te beoordelen HEAD.
- Prompts, beoordelingen, exitcodes en sessielogs (lokaal, niet gecommit): `codex-repair-evidence-wp8/`.

**Werkwijze per review**
- Elke prompt vroeg expliciet om scenario's waarin de nieuwe tests slagen terwijl het defect blijft, en om races, deadlocks, hangs, false success en bypasses.
- `APPROVE` betekende, zoals in de prompt vastgelegd: geen P0/P1 meer binnen de claim van de commit.

| Ronde | Review | Oordeel | Verwerkt in |
|---|---|---|---|
| 1 | F03 / F09 / F01 / F10 / F04 / F05+F06 / F08 | allemaal REQUEST_CHANGES (P1: F03, F01, F04 ×2, F05/F06 ×2, F08; overige P2) | `af441af9`–`f9faa2db` |
| 2 | Hercontrole F03/F09, F10, F01, F04, F05/F06, F08; eerste review F02, F07 | F01 **APPROVE**; overige REQUEST_CHANGES (P1: transport ×3, F04 ×2, F02 ×1; overige P2) | `65208a75`–`e03cbc48` |
| 3 | Hercontrole van de rondes-2-fixes | F10 **APPROVE**, F08 **APPROVE**; transport (P1 Ports-keten; P2 retry-historie), F02 (P1 WebSocket-buffer), F06 (P2 inert), F07 (P2 latch) | `3b33733d`–`00eb8488` |
| Integratie | Hele range, twee keer (00eb8488 en be798ce4), met hercontroles | Zie de tabel hieronder | `decc6c24`–`be798ce4`; twee teruggedraaide pogingen |

**Stopregel.** Elke ronde vond nieuwe randgevallen, steeds op het gebied van concurrency. Daarom is vooraf een stopregel vastgesteld:
- Na ronde 3 alleen P0/P1 en goedkope P2's repareren.
- Daarna één integratiereview van de definitieve HEAD.
- Een P1 daaruit eenmaal repareren en hercontroleren.
- Resterende P2's worden begrensd gerapporteerd.

**Integratiereviews.** De eerste poging op 00eb8488 stopte na 20 s op een gebruikslimiet van de provider, zonder beoordeling. Dit staat bewaard als `30a-...-usage-limit`. Na het verlopen van de limiet is de review opnieuw gestart.

| Review | HEAD | Uitkomst |
|---|---|---|
| Integratie 1 | 00eb8488 | REQUEST_CHANGES: R1 P1 (antwoordtoewijzing), R2 P1 (AutoRestore-lus), R3 P2 (volgorde CLI-opvolger). Verwerkt in `decc6c24` en `3b9495f4`. |
| Hercontrole | 3b9495f4 | P1 (tabwissel wist de historie) en P2 (gooiende callback). Verwerkt in `be798ce4`. |
| Hercontrole | be798ce4 | **APPROVE** (0/0/0) voor die twee claims |
| **Integratie 2** | **be798ce4** | **P0 = 0, P1 = 0, P2 = 1. F01–F10 allemaal CLOSED.** De P2: een verzending die vastloopt op een gesloten verbinding houdt de pagina "bezig" na een reconnect. Dat is beschikbaarheid en faalt veilig dicht. Oordeel: `REQUEST_CHANGES`. |
| Hercontrole | b3ca2c6a | Reparatiepoging voor die P2 (tellen per generatie): **nieuwe P1**. De generatie wisselt al aan het begin van de disconnect, terwijl er tijdens de teardown nog een write kan uitgaan. |
| Hercontrole | d0f94598 | Tweede poging (tellen tot de verbinding gesloten is): **twee nieuwe P1's** (een dubbele disconnect of een ingeslikte close-fout geldt als bewijs van sluiting; sluiting van een andere verbinding wist de telling) en één P2 (WebSocket-buffer na sluiting). |

**Besluit.** De twee P2-pogingen zijn teruggedraaid (`302e7f5b`, `6d295c31`). De reden: ze ruilden een fail-closed beschikbaarheidsprobleem in voor een mogelijke overlap van writes tussen tabs. Een betrouwbaar bewijs dat een transport gesloten is, vraagt wijzigingen in het contract van WebSerial en WebBluetooth (`disconnect` mag niet vroeg `true` geven en geen close-fout inslikken) en een nieuwe reviewronde. Dat valt buiten deze stopregel.

De definitieve productiecode is gelijk aan `be798ce4`.

**Definitief oordeel van Codex: `REQUEST_CHANGES` (P0 = 0, P1 = 0, P2 = 1, fail-closed beschikbaarheid).**

**Concreet vervolg voor de open P2**
- WebSerial en WebBluetooth: `disconnect` laat een lopende teardown afwachten en geeft `false` bij een mislukte `port.close`/`gatt`-sluiting.
- De facade registreert per generatie of die gesloten is (geen watermerk).
- `bufferedAmount` telt alleen mee bij een open socket.

**Overzicht van alle reviews**
- 27 voltooide Codex-runs, plus 1 afgebroken op de gebruikslimiet van de provider en daarna opnieuw uitgevoerd.
- Prompts, beoordelingen, exitcodes en lokale sessielogs: `codex-repair-evidence-wp8/`.

## 12. Software- versus fysieke acceptatie

**Software**
- Broncode, tests, mutaties, de echte browsertest en de onafhankelijke review hierboven.

**Fysiek**
- **Niets uitgevoerd.** Geen FC, geen write, geen flash, geen drone.
- Alle uitspraken over firmwaregedrag rusten op broninspectie.
- De persistentie bij tab-saves rust op ACK-semantiek uit de firmwarebron. Een config-readback na de reboot is niet onderzocht.
- `HARDWARE_VALIDATION=NOT_EXECUTED`.

## 13. Eindstatus

**De software haalt de inhoudelijke acceptatie**
- Alle vier P1's zijn gesloten.
- Alle zes P2's (F05–F10) zijn gesloten: F07 als diagnose, met herstel FAIL_CLOSED.
- Geen P0/P1 open.
- Geen bekende write-bypass binnen de begrensde scope.
- Geen onbewezen verzending of persistentie gemeld als succes, binnen de gedocumenteerde grens van het antwoordvenster van 4 s.
- Alle tests, lint, typecheck en build slagen.
- Absolute Apply blijft geblokkeerd.
- Geen hardwareclaims.

**Formele goedkeuring ontbreekt**
- Het laatste oordeel van Codex is `REQUEST_CHANGES`, voor één nieuwe fail-closed P2 (beschikbaarheid).
- Een tweede P2 van dezelfde soort is gevonden in een hercontrole.
- Het criterium "Codex heeft de definitieve implementatie onafhankelijk goedgekeurd" is daarmee **niet gehaald**. De eindstatus is daarom `FAIL`, niet PASS.
- Hardware is niet gevalideerd.

```text
GYROFLIGHT_WP8_FINAL_REPAIR_ACCEPTANCE
BRANCH=feat/gyroflight-autotune-engine-v2
HEAD_BEFORE=20242d2cd94d3d492ba0d12f390e1bd5d001ff74
HEAD_AFTER=6d295c31554b9240955ac6b125d6e95a17022a54
F01_AUTORESTORE=CLOSED (confirmed only on firmware output after writeEEPROM; otherwise PERSISTENCE_NOT_VERIFIED / not_saved / unknown)
F02_CROSS_TAB=CLOSED_SAME_ORIGIN_COOPERATING_TABS (browser 20/20 Chromium; other browsers/profiles/origins/devices not covered; availability P2 open, fail-closed)
F03_WEBSERIAL_BATCH=CLOSED
F04_EEPROM_SAVE=CLOSED (shared ACK contract; 4 s answer-window heuristic documented)
F05_FAILSAFE_RETRY=CLOSED
F06_FAILSAFE_DIRTY=CLOSED
F07_RECOVERY=CLOSED_DIAGNOSTIC_ONLY (recovery for orphaned/unknown-scope/missing-backup entries: NONE, FAIL_CLOSED)
F08_BACKUP_RETENTION=CLOSED
F09_CLI_QUEUE=CLOSED
F10_CLI_EXIT=CLOSED
WRITE_GUARD=PASS_BOUNDED (same browser origin; runtime codes, raw '#', webstm32 bootloader excepted; Tauri NOT_VALIDATED)
RESTORE_SAFETY=PASS_BOUNDED_FAIL_CLOSED (no automatic release; recovery availability limited)
TRANSPORT_DELIVERY=ADAPTER_ACCEPTANCE_ONLY (not FC receipt; stale-send availability P2 open)
EEPROM_PERSISTENCE=FIRMWARE_ACK_OR_OUTPUT_SOURCE_BASED (hardware NOT_VALIDATED; RX_SPI telemetry and MINIMAL_CLI exceptions)
CODEX_REVIEWS=27_COMPLETED (+1 provider-limit abort, rerun)
CODEX_FINAL_VERDICT=REQUEST_CHANGES (P0=0, P1=0, P2=1 fail-closed availability; F01-F10 all CLOSED)
P0_OPEN=0
P1_OPEN=0
P2_OPEN=2
TESTS_PASS=5684
TESTS_FAIL=0
TESTS_SKIP=14
TYPECHECK=PASS
LINT=PASS
BUILD=PASS
ABSOLUTE_APPLY=BLOCKED
HARDWARE_VALIDATION=NOT_EXECUTED
PUSHED=NO
MERGED=NO
OVERALL_STATUS=FAIL
REPORT_PATH=docs/gyrocore/audit/autotune-v2/2026-10-25-wp8-final-repair-acceptance.md
```
