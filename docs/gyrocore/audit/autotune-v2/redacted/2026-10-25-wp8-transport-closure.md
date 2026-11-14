# Gyroflight v2 — WP8 transport closure & final acceptance

Datum: 25 oktober 2026. Implementatie: Claude Code. Onafhankelijke reviewer: OpenAI Codex (read-only, `codex exec -s read-only --ephemeral`, CLI 0.164.0). Vorig rapport: [2026-10-25-wp8-final-repair-acceptance.md](2026-10-25-wp8-final-repair-acceptance.md).

**Samenvatting**
- De open P2 uit de WP8-acceptatie is opgelost. Een verzending die vastloopt op een gesloten verbinding hield het schrijfslot voorgoed vast. Hetzelfde gold voor een gesloten WebSocket met `bufferedAmount`.
- De oplossing werkt per verbinding, niet per generatie of met een watermerk.
  - Elke WebSerial- en WebBluetooth-verbinding is een eigen `TransportLink`.
  - Alleen het transport zelf mag die op `CLOSED_CONFIRMED` zetten, en alleen op bewijs.
  - De facade onthoudt per verzending aan welke link die is overgedragen. Een onafgemaakte verzending telt pas niet meer mee als juist die link bewezen gesloten is.
- Een vastgelopen verzending wordt nooit als "niet verzonden" gemeld. De afleverstatus blijft onbekend.
- Vijf Codex-rondes (9 reviews) vonden samen 6 P1's en 5 P2's (dubbele meldingen één keer geteld).
  - Twee P1's zaten in de nieuwe code (ronde 1). Vier P1's waren al ouder en zijn nu pas zichtbaar geworden.
  - Van de P2's waren er drie nieuw (ingevoerd door een reparatieronde zelf) en twee ouder.
  - Alles is in afzonderlijke commits gerepareerd, met regressietests die vóór de reparatie faalden.
- **Codex eindoordeel: APPROVE** op de definitieve HEAD `6aee384e` (P0 = 0, P1 = 0, P2 = 0, `ORIGINAL_P2=CLOSED`). De integratiereview van F01–F10 gaf APPROVE op `af372bfb`; de delta naar `6aee384e` raakt F01–F10 niet (Codex ronde 5).
- Volledige suite: **5722 PASS / 0 FAIL / 14 SKIP** (baseline 5684 / 0 / 14). Typecheck, lint en build slagen. Echte Chromium-tabs: **27/27** (20 bestaande en 7 nieuwe scenario's). Mutanten: **19/19 gedood**, plus 3/4 in ronde 2 (de vierde is een redundante laag, §6).
- Absolute Apply blijft **BLOCKED**. Er is geen hardware gebruikt.

---

## 1. Werkomgeving

| Onderdeel | Waarde |
|---|---|
| Worktree | `<home>/Gyroflight-worktrees/autotune-engine-v2` |
| Branch | `feat/gyroflight-autotune-engine-v2` |
| HEAD_BEFORE | `6d295c31554b9240955ac6b125d6e95a17022a54` (zoals verwacht) |
| HEAD_AFTER | zie eindblok |
| Node | v22.22.2 |
| GitNexus | Index op `6d295c31` bij aanvang (vers). Later één keer opnieuw met `node .gitnexus/run.cjs analyze --index-only`. `AGENTS.md` bleef byte-gelijk (md5 voor en na). |

**Begintoestand van de werkboom**
- `AGENTS.md` was al gewijzigd: alleen een toegevoegd GitNexus-blok (`<!-- gitnexus:start -->…end`, 0 regels verwijderd) uit een eerdere sessie. Het is nooit gecommit. Aan het einde is het met `git checkout -- AGENTS.md` **teruggezet**; de twee herindexeringen in deze sessie (`--index-only`) lieten het byte-gelijk.
- `.serena/` en de bestaande auditrapporten zijn ongemoeid gelaten. Alles is per pad gestaged.

**Gebruik van GitNexus**
- `detect_changes` is gedraaid vóór elke commit (nooit `partial` of `truncated`).
- Graafanalyse met `impact` vóór de bewerking: `Serial.send`, `pendingSends`, `WebSerial.disconnect` en `connect`, `WebBluetooth._performTeardown`, `send` en `connect`, `Websocket.bufferedAmount`, `MSP._note_transmission`, `_note_answer`, `MspHelper.settleCallbacks`, `withFcWriteLock`, `createWriteLease`, `AutoBackup.sendCommand`.
- **Alleen tekstzoekopdracht vóór de bewerking**: `MSP.disconnect_cleanup` (ronde 4), `WebSerial.forceClose` en `#teardown`, en `Websocket.connect`. Achteraf zijn ook deze met `impact` bevraagd. De uitkomst is UNKNOWN: de MCP-server meldde de index 7 commits achter, ook na `analyze --index-only`. Ze zijn dus bevestigd met een tekstzoekopdracht en niet als veilig volgens de graaf aangemerkt:
  - `disconnect_cleanup`: 10 aanroepplaatsen;
  - `forceClose`: alleen de facade, vanuit `pagehide` in `serial_backend`;
  - `Websocket.connect`: alleen via `serial.connect`.
- Risico's:
  - `Serial.send`: CRITICAL op diepte 1 (9 directe aanroepers).
  - `withFcWriteLock`: HIGH (transacties, `UncertainStateNotice.onCheck`).
  - De laatste `detect_changes` gaven HIGH: 10 tot 12 BLE-connectflows.
- Elke HIGH/CRITICAL-waarschuwing is gemeld en niet weggeredeneerd. De dekking bestaat uit de volledige suite, de browsertest, mutanten en een nieuwe Codex-ronde per stap.
- UNKNOWN-resultaten (dynamische dispatch via `_protocol.*`) zijn met een tekstzoekopdracht bevestigd.

**Commits (`6d295c31..HEAD`)**

| # | Commit | Inhoud |
|---|---|---|
| 1 | `5ef42d3b` | `TransportLink`, per-verzending-accounting in de facade, sluitbewijs in WebSerial, WebBluetooth en WebSocket |
| 2 | `2fd5983e` | Tests voor de twee overlevende mutanten (T03, T14) |
| 3 | `d070d344` | Codex ronde 1: BLE pas gesloten als ook de writes klaar zijn; geen connect over een open verbinding; MSP vergeet onbeantwoorde writes niet meer na 4 s |
| 4 | `91b6649b` | Codex ronde 2: eigen transactie wacht op eigen verzendingen; CRC-frame is geen antwoord; kept BLE link; geannuleerde WebSerial-open |
| 5 | `02eef1f3` | Codex ronde 3: kept link behoudt de antwoordhistorie; een geannuleerde open is de lopende teardown |
| 6 | `af372bfb` | Melding "EEPROM niet bevestigd" noemt de remedie (opnieuw verbinden) |
| 7 | `6aee384e` | Codex ronde 4: een callback van een AutoBackup-commando werkt alleen op de eigen verbinding |

Geen rebase, push, merge of PR. De twee revert-commits uit de vorige sessie zijn niet herschreven.

## 2. Root cause

**De open P2**
- `serial.pendingSends` telde onafgemaakte verzendingen met één globale teller.
- De teller daalde alleen in de `finally` van de verzending zelf. Een belofte die nooit afloopt, bleef dus voorgoed meetellen, ook na sluiting en herverbinding.
- `bufferedAmount` van een WebSocket telde ook nog mee nadat de socket gesloten was.
- Gevolg: de pagina gaf de lease nooit op, en elke transactie in een andere tab werd na 8 s geweigerd. Dat faalt veilig dicht, maar de beschikbaarheid ging verloren tot een reload.

**Waarom de twee eerdere pogingen faalden**
De transports leverden geen bewijs van sluiting:
- WebSerial gaf `true` terug bij een tweede `disconnect()` (want `connected` stond al op false) en slikte `port.close()`-fouten in.
- WebBluetooth gaf `true` terug zodra `closeRequested` stond.
- De facade verhoogde de generatie al aan het begin van de teardown (`b3ca2c6a`) of gebruikte een globaal watermerk (`d0f94598`).

Zo werd een generatiewissel, een vroege `true` of de sluiting van een *ander* transport als bewijs genomen. Dat opent een venster waarin writes van twee tabs kunnen overlappen.

## 3. Verbindings- en afsluitcontract

`src/js/protocols/TransportLink.ts` beschrijft per verbinding wat bewezen is. Alleen het transport dat de verbinding opende, verandert de staat. `CLOSED_CONFIRMED` is definitief.

| Staat | Betekenis | Telt een onafgemaakte verzending op deze link mee? |
|---|---|---|
| `OPEN` | De verbinding is op; bytes kunnen vertrekken | ja |
| `CLOSING` | Teardown loopt; een eerdere write kan nog vertrekken | ja |
| `CLOSED_CONFIRMED` | Het transport heeft bewezen dat er niets meer uit kan | nee (de aflevering blijft onbekend) |
| `CLOSE_FAILED` | Sluiten mislukt; de verbinding kan nog zenden | ja |
| `DELIVERY_UNKNOWN` (facade, `SendLinkState`) | Transport zonder link (Tauri, Capacitor, virtual) | ja, tot het transport de verzending afrondt (ongewijzigd gedrag) |

**Bewijs per transport**

**WebSerial**
- Bewijs = `port.close()` is geresolved.
- Volgens de WICG-specificatie (fragment met SHA-256 in `transport-closure-evidence/webserial-spec-close.md`):
  - `close()` aborteert de writable;
  - de abort-signaal-stap laat een lopende OS-write "as soon as possible" terugkeren;
  - `abortAlgorithm` gooit de zend-buffers van software en hardware weg;
  - daarna sluit het besturingssysteem de poort.
- `close()` weigert een gelockte stream. De reader-lock wordt daarom expliciet vrijgegeven vóór `close()`.
- Een mislukte `close()` geeft `false`, `CLOSE_FAILED`, en de poort blijft vastgehouden voor een nieuwe poging. Een nieuwe poort opent pas als de oude bewezen dicht is.

**WebBluetooth (`GattLink`)**
- Bewijs = `gatt.connected === false` na `gatt.disconnect()` **én** elke `writeValue()` van die verbinding is afgerond.
- Codex ronde 1 terecht: "GATT down" alleen bewijst niet dat een reeds overgedragen write niet meer aankomt.
- De teardown wacht maximaal 2 s op die writes. Lukt dat niet, dan:
  - geeft `disconnect()` `false`;
  - blijft de verzending meetellen (fail-closed);
  - sluit de link zodra de write alsnog afloopt.
- `stopNotifications()` is begrensd op 2 s, zodat een vastgelopen stack de sluiting niet tegenhoudt.

**WebSocket**
- `bufferedAmount` telt over elke socket van het transport die niet `CLOSED` is, dus ook een socket die door een reconnect vervangen is.
  - `OPEN` met buffer: bezig.
  - `CLOSING` met buffer: bezig. Bytes vóór het close-frame kunnen nog vertrekken.
  - `CLOSED`: de verbinding is weg. De resterende buffer kan nooit meer vertrekken en telt dus niet mee. Of die bytes aankwamen, is onbekend; er wordt niets over beweerd.
  - Een `readyState` die de code niet kent: telt mee (fail-closed).
- De facade leest de buffer van **elk** geregistreerd transport, niet alleen van het huidige.

**Overige regels**
- **Herhaalde disconnect.** Elke aanroep tijdens een teardown wacht op dezelfde teardown en krijgt dezelfde uitkomst (WebSerial `#closing`, WebBluetooth `_teardown`). Een mislukte teardown wordt bij de volgende aanroep opnieuw uitgevoerd.
- **Overdracht.** De facade geeft bytes alleen aan een transport met een `OPEN` link. Dus niet tijdens een teardown, een mislukte close of een connect.
  - Volgorde: de generatiecheck, dan de linkcheck, dan `stillWanted`, dan de overdracht. Dat alles in één synchrone stap.
  - Een verzending die nog niet was overgedragen terwijl haar generatie voorbij is, kan nooit meer vertrekken en telt niet mee.
- **Oude writes.** Een write hoort bij zijn eigen link en karakteristiek (BLE) of writer en generatie (WebSerial). Een write die in de wachtrij achter een vastgelopen write stond, gaat nooit uit op een latere verbinding. BLE heeft per verbinding een eigen write-queue.
- **Connect.**
  - Er komt geen tweede verbinding over een open verbinding. Uitzondering: dezelfde BLE-verbinding (zelfde pad, link `OPEN`). Die wordt hergebruikt voor de reboot-reconnect via de bewust vastgehouden link (`softResetForReboot`).
  - Een connect wacht op een lopende teardown en op een lopende open.
  - Een disconnect of `forceClose` tijdens `port.open()` annuleert de open, wacht erop en sluit de geopende poort. Er wordt niets als gesloten gemeld vóór dat moment.
- **Eigen transactie** (`fcWriteLease.exclusive`). De transactie start pas als ook deze pagina stil is. Daarvoor geldt dezelfde busy-probe als voor het afstaan aan een andere tab. Lukt dat niet binnen 8 s, dan volgt `fc:write_lease_timeout` en draait de transactie nooit.
- **MSP-antwoordtoewijzing.**
  - Een onbeantwoorde write-transmissie blijft bewaard tot ze beantwoord is of de link echt dicht is (`disconnect_cleanup` terwijl `serial.connected` false is).
  - Er is geen tijdsgrens meer (de oude 4 s). Een cleanup op een link die open blijft (kept BLE link, CLI-drain) wist de historie niet.
  - Een frame met CRC-fout verbruikt geen transmissie.

**Een browserlock bewijst geen craftbrede exclusiviteit.**
- De lease geldt voor samenwerkende tabs van één browser-origin.
- Andere browsers, profielen, origins, apparaten en externe programma's vallen erbuiten.

## 4. Exacte codewijzigingen (productie)

| Bestand | Wijziging |
|---|---|
| `src/js/protocols/TransportLink.ts` (nieuw) | Linkstaat met eenrichtingsovergangen |
| `src/js/serial.ts` | `SerialProtocol.link`, `SendLinkState`, `sendLinkState()`. `send` registreert `PendingSend {generation, handed, link}`, geeft bytes alleen aan een `OPEN` link en de facade-wachtrij blijft per verbinding. `pendingSends` telt per verzending (`#mayStillSend`) plus de buffer van elk transport |
| `src/js/protocols/WebSerial.ts` | `link`, `#closing`, `#opening`; `disconnect` → `#close` → `#teardown` met vastgelegde poort, reader en writer; reader-lock vrij vóór `close()`; close-fout niet ingeslikt; `connect` wacht en weigert bij een niet-gesloten poort; geannuleerde open; `forceClose` alleen gesloten op een geresolvede close |
| `src/js/protocols/WebBluetooth.ts` | `GattLink` (writes, gattDown, quiet), `link`; disconnect wacht op de teardown; begrensde `stopNotifications`; post-check `gatt.connected`; device en link per teardown vastgelegd; connect over open geweigerd behalve de kept link; send gebonden aan link en karakteristiek; write-queue per verbinding |
| `src/js/protocols/WebSocket.ts` | `#sockets`; `bufferedAmount` over niet-`CLOSED` sockets |
| `src/js/msp.ts` | Geen `ANSWER_WINDOW_MS`; historie alleen gewist als het transport niet verbonden is |
| `src/js/msp/MSPHelper.ts` | `settleCallbacks`: CRC-frame verbruikt geen transmissie |
| `src/composables/fcWriteLease.ts` | `exclusive`: wacht (met het exclusieve slot) tot de eigen pagina stil is, anders `fc:write_lease_timeout` |
| `src/gyroflight/locales/en.json` | `gyroflightEepromNotConfirmed` noemt "Disconnect, reconnect and save again" |
| `src/js/utils/AutoBackup.ts` | `sendCommand`: de callback hoort bij `serial.connectionGeneration` op het moment van verzenden; op een latere verbinding doet hij niets |
| `docs/gyrocore/UPSTREAM.md` | Hook-regel voor alle bovenstaande upstream-wijzigingen |

## 5. Bewijs van veilige lock-release

De lease gaat alleen naar een andere tab als `quiet()` waar is. Hetzelfde geldt vanaf nu voor de eigen transactie. Voor de transport-term van `quiet()` geldt:

1. Een verzending die is overgedragen, telt tot haar **eigen** link `CLOSED_CONFIRMED` is.
   - Die staat zet alleen het transport, na bewijs (§3). Een event, een timeout, een fout of een generatiewissel zet hem niet.
   - De sluiting van een ander transport of een andere verbinding raakt deze link niet. Er is geen watermerk.
2. Een verzending die nog niet is overgedragen, kan alleen in haar eigen generatie en alleen naar een `OPEN` link vertrekken.
   - Een link die niet meer open is, opent nooit opnieuw. Een nieuwe link komt alleen met een connect, en die start een nieuwe generatie.
   - De check en de overdracht zijn één synchrone stap.
3. Na de vrijgave gaat geen nieuwe write meer uit van deze pagina:
   - `fcWriteGuard` weigert synchroon zonder lease;
   - `stillWanted` controleert vlak vóór de overdracht opnieuw;
   - MSP-retries lopen langs dezelfde check;
   - oude adapterqueues weigeren op linkidentiteit.
4. Onzekere transactiegegevens blijven bewaard. De diagnose en de blokkade van F07 zijn onaangeroerd; er is geen automatische vrijgave.

**Grens:** "kan niets meer verzenden" geldt voor de browseradapter. Bytes die een USB-driver of OS-buffer al had, kunnen nog wegdruppelen. Die grens gold al voor elke voltooide verzending en is ongewijzigd.

## 6. Negatieve regressietests en discriminatie

Nieuwe testfile: `test/gyrocore/wp8_transport_closure.test.ts` (33 tests).

**Opzet**
- De echte productieadapters `WebSerial`, `WebBluetooth` en `Websocket` zitten in de echte slots van de facade en worden via `serial.connect()` verbonden.
- Nep zijn alleen de browserobjecten eronder: een SerialPort waarvan de test writes, open en close afhandelt, een GATT-device en een WebSocket.
- "Deze tab" is de echte lease van de app (`fcWriteGuard` start die; `msp.ts` levert `serial.pendingSends` als busy-probe). De andere tab is een tweede lease op dezelfde lockmanager en hetzelfde `BroadcastChannel`.
- De BLE-fake weigert lopende writes bij `gatt.disconnect()`, zoals de specificatie voorschrijft. De expliciete worst case (`writesOutliveDisconnect`) laat ze bestaan.

Daarnaast zijn er 5 nieuwe gevallen in `test/gyrocore/wp8_repair_integration.test.ts` (MSP-antwoordhistorie: twee na 60 s stilte, CRC-frame, kept-link cleanup, controle na een echte sluiting).

**Verplichte scenario's (opdracht §5)**

| # | Scenario | Test |
|---|---|---|
| 1 | Write hangt, verbinding sluit definitief | WebSerial (1); BLE "(3) a second disconnect …" |
| 2 | Write hangt, afsluiten mislukt | WebSerial (2); BLE "GATT stays connected …"; BLE "GATT down is no proof while a write … has not ended" |
| 3 | Twee gelijktijdige disconnects | WebSerial (3); BLE (3) |
| 4 | Disconnect terwijl een retry wacht | (4) verzending in de wachtrij; (4b) MSP-retry tijdens de teardown |
| 5 | Reconnect vóór oude callbacks aflopen | (5) |
| 6 | Oude write-callback na een nieuwe verbinding | BLE (6); WebSerial (4); "a late AutoBackup exit callback from an old connection does not disconnect the new one" (met controle) |
| 7 | Gesloten WebSocket met `bufferedAmount > 0` | (7) |
| 8 | WebSocket in `CLOSING` met buffer, ook na vervanging | (8) |
| 9 | Twee tabs met concurrerende writes | (9) |
| 10 | Transactiehoudende tab sluit tijdens een write | (10), (10b) `forceClose` bij pagehide; browser scenario 4 (tab sluit tijdens een transactie) |
| 11 | Tweede tab schrijft vóór bewezen quiescence | (11), (11b); "this tab's own transaction does not start while a send …" |
| 12 | Een foute vroege lock-release wordt gedetecteerd | Discriminatiematrix en mutanten hieronder |

**Discriminatiematrix**
- De eerste 21 tests van de nieuwe file draaiden **elk in een eigen proces** op de oude productiecode. Bewijs: `transport-closure-evidence/before-fix/isolated-*.txt`.
- Per test is gecontroleerd dat de faalregel een gedragsassertie is.

| Productiecode | Falend | Wat het laat zien |
|---|---|---|
| `6d295c31` (onbehandeld) | 18/21 | De beschikbaarheids-P2 en de valse sluiting |
| `b3ca2c6a` (poging 1) | 15/21 | De vroege release tijdens `CLOSING` wordt gevangen: (11) faalt op "refused while closing" |
| `d0f94598` (poging 2) | 14/21 | Dubbele disconnect (beide (3)), ingeslikte close-fout (2), GATT-post-check |
| Positieve controles | 3 | (4b), "an OPEN socket …" en (9) slagen overal |

Latere rondes, telkens op de commit vóór de reparatie:
- 5 nieuwe tests falen op `d070d344` (`before-fix/round3-on-d070d344.txt`).
- 3 nieuwe tests falen op `91b6649b` (`before-fix/round4-on-91b6649b.txt`).
- 1 nieuwe test faalt op `af372bfb` (`before-fix/round5-on-af372bfb.txt`).
- De R1-tests na 60 s stilte falen op `5ef42d3b`.

**Mutanten**
- Elke mutant draaide in een eigen scratch-worktree. Resultaten: `transport-closure-evidence/mutations/`.
- **Ronde 1 (T01–T20, 19 mutanten op `5ef42d3b`): 17 gedood.**
  - Gedood zijn onder andere: CLOSING als gesloten tellen, de logica van `b3ca2c6a`, een ingeslikte `close()`, geen join bij een tweede disconnect, link gesloten bij de start van de teardown, een BLE-post-check zonder `gatt.connected`, een oude BLE-write na een reconnect, de CLOSING-buffer niet tellen, een vervangen socket niet volgen, en geen release van de reader-lock.
  - **Overleefd:**
    - T03 (de linkcheck van de facade);
    - T14 (de BLE "open"-check vooraf).
  - Beide zijn een tweede laag achter een adaptercheck. Met twee nieuwe tests in `2fd5983e` zijn ook die gedood: **19/19**.
- **Ronde 2 (U1–U4 op de BLE-fixes): 3 gedood.**
  - U3 (teardown sluit een link die niet bij het device hoort) overleeft.
  - Dat geval is onbereikbaar sinds connect geen device meer vervangt onder een vastgehouden link (U2, gedood). Het is een redundante laag.
- De reparaties van rondes 3 en 4 zijn indirect als mutant aangetoond: de tests falen op de commit zonder die reparatie (zie hierboven).

**Gewijzigde bestaande tests (allemaal gelijk of strenger)**

1. `test/js/webbluetooth.test.ts`: de fake `gatt.disconnect()` zet `connected` op false, zoals de specificatie voorschrijft. Er is geen assertie verwijderd.
2. `test/js/serial_send_callback.test.ts` en `test/gyrocore/wp8_final_acceptance_transport.test.ts`: een handgebouwde open BLE-verbinding krijgt een `GattLink`. Er is geen assertie verwijderd.
3. `wp8_final_acceptance_transport.test.ts`, de volgordetest. Codex beoordeelde deze wijziging als strenger.
   - Eerst: de toegelaten SET bereikte de craft vóór de eerste read van de transactie.
   - Nu: de transactie wacht tot de eigen verzendingen klaar zijn; een SET die nog niet was overgedragen, gaat **nooit** uit; de read-volgorde blijft bewaakt.
4. `wp8_repair_integration.test.ts`, controle "closed link". Die sluit nu eerst echt de link (`connected = false`) en neemt niet meer aan dat een cleanup gelijk staat aan een sluiting.

## 7. Browserintegratie

**Uitvoering**
- `npx vite --port 5299 --strictPort --host 127.0.0.1` met `node test/browser/crossTabWriteLease.browser.mjs`.
- `PLAYWRIGHT_CORE`: de bestaande playwright-core 1.64.0 (npx-cache).
- **Browser: Chromium 156.0.8078.4, headless.** Echte, afzonderlijke tabs in één browsercontext, dus één origin met echte Web Locks en een echt `BroadcastChannel`.

**Adapters**
- Scenario's 1–6 (20 checks): een nep-transport achter de facade, zoals voorheen.
- Nieuw, scenario 7: de **echte WebSerial-adapter** van de tab, over een SerialPort-object in de pagina.
  - Een vastgelopen write.
  - Tijdens `CLOSING` wacht de transactie van tab A.
  - Na een mislukte close is de uitkomst `false`, blijft de verzending meetellen, en wordt A geweigerd en draait nooit.
  - Een tweede, wél bewezen close: daarna krijgt A de lease.
- Nieuw, scenario 8: de **echte WebSocket-adapter** van de tab, over een nep-WebSocket.
  - `CLOSING` met 64 bytes buffer: A wacht.
  - `CLOSED` met nog steeds 64 bytes: A krijgt de lease.
- Web Bluetooth is in de browser **niet** getest (geen nep-GATT in Chromium).

**Resultaat**
- **27/27 PASS** op de definitieve productiecode (`final/browser-crosstab-final.log`, `6aee384e`).
- Op `6d295c31` faalden 4 van de nieuwe checks: de ingeslikte close (`failed: true`), geen release na een bewezen close (twee checks) en de buffer van een gesloten socket (`transport-closure-evidence/browser-before-6d295c31.log`).
- Geen regressie in de 20 bestaande checks.

## 8. Volledige validatie

| Controle | Resultaat |
|---|---|
| Gerichte transport-, lease-, integratie- en EEPROM-tests | groen na elke commit |
| `npx vitest run` (volledig, op de productiecode van `6aee384e`) | **5722 PASS / 0 FAIL / 14 SKIP**, 366 bestanden (8 overgeslagen) |
| Typecheck (`vue-tsc --noEmit`) | exit 0 |
| `npm run lint` (eslint + typecheck) | exit 0 |
| `npm run build` | exit 0 |
| Browser cross-tab | 27/27 |

**Opmerkingen**
- Eén volledige run (ronde 3) gaf een fout in `test/js/capacitor_dfu_transport.test.ts`. Die test slaagde drie keer los. Het is een timing-afhankelijke test onder belasting, zonder raakvlak met deze wijziging. De run daarna was groen.
- Logs staan in `transport-closure-evidence/final/` (`*-final.log` = definitieve stand).

## 9. Codex-bevindingen

Elke review draaide op een eigen detached worktree, met een prompt zonder mijn conclusie en met de eerdere reproducers. Prompts, beoordelingen, exitcodes en sessielogs staan in `transport-closure-evidence/codex/`.

| Ronde | HEAD | Review | Bevindingen | Herkomst | Verwerkt in |
|---|---|---|---|---|---|
| 1A | `5ef42d3b` | commit, R1–R5 | P1 BLE "GATT down" geen bewijs bij een lopende write; P1 connect naar device B onder de link van A | beide nieuw (5ef42d3b) | `d070d344` |
| 1B | `5ef42d3b` | integratie F01–F10 | P1 venster van 4 s vergeet een onbeantwoorde EEPROM-transmissie; F04 OPEN | eerder (`decc6c24`) | `d070d344` |
| 2A | `d070d344` | hercontrole | P1 CRC-frame verbruikt historie; P1 eigen `exclusive()` negeert eigen busy-probe; P2 kept-link reboot geweigerd; P2 WebSerial-open herrijst na disconnect | eerder, eerder, nieuw (d070d344), eerder | `91b6649b` |
| 2B | `d070d344` | integratie | P2 kept-link reboot (zelfde als 2A); F01–F10 CLOSED | nieuw | `91b6649b` |
| 3A | `91b6649b` | hercontrole | P1 kept-link `disconnect_cleanup` wist historie op een open link; P2 geannuleerde, mislukte open vergiftigt de volgende connect; P2 annulering niet geserialiseerd met connect | eerder (`decc6c24`, via kept link), nieuw, nieuw | `02eef1f3` |
| 3B | `91b6649b` | integratie | P2 vergiftigde connect (zelfde als 3A); F01–F10 CLOSED | nieuw | `02eef1f3` |
| 4A | `af372bfb` | hercontrole, `ORIGINAL_P2`-regel | `ORIGINAL_P2=CLOSED`; P2 een late AutoBackup-`exit`-callback verbreekt de nieuwe verbinding (fail-open voor de beschikbaarheid) | eerder (`6d295c31`) | `6aee384e` |
| 4B | `af372bfb` | integratie F01–F10 | **APPROVE**, 0/0/0; F01–F10 CLOSED; Absolute Apply BLOCKED | | |
| 5 | `6aee384e` | eindhercontrole en delta-integratie | **APPROVE**, 0/0/0; `ORIGINAL_P2=CLOSED`; de delta raakt F01–F10 niet | | |

**Grenzen van de eindgoedkeuring (ronde 5)**
- Ronde 5 is een gerichte hercontrole van `6aee384e` plus de delta naar `af372bfb`, geen volledige review van de hele HEAD. De volledige integratiereview van F01–F10 is die van ronde 4B (`af372bfb`).
- De AutoBackup-test gebruikt een spy voor `onClose()`. De complete keten "exit, dan disconnect" is dus niet end-to-end gedemonstreerd.
- Codex voerde in geen enkele ronde tests uit: het is broninspectie. De uitvoering staat in §6–§8.

**Status van de reproducers uit de vorige sessie (Codex, ronde 1A)**

| Reproducer | Status |
|---|---|
| R1: generatiewissel tijdens de BLE-teardown | gesloten voor de accounting; end-to-end pas na `d070d344` |
| R2: vroege `true` bij een tweede disconnect | gesloten |
| R3: ingeslikte WebSerial-close | gesloten |
| R4: BLE-fout, daarna een WebSocket-close wist de telling | gesloten |
| R5: buffer van een gesloten WebSocket, en een stuck send na een reconnect | gesloten |

## 10. Beslisregel voor P2's en resterende beperkingen

**Beslisregel (vastgelegd vóór de uitslag van ronde 4)**
- **P0/P1:** altijd repareren, gevolgd door een onafhankelijke hercontrole.
- **P2 ingevoerd door `5ef42d3b..HEAD`:** repareren. Dat is een regressie in eigen code.
- **Al bestaande P2 die dicht faalt en buiten de sluitingsinvariant ligt:** begrensd documenteren als beperking. Die blokkeert de acceptatie niet; de redenering staat hieronder.
  - Een herschrijving van levenscycluscode voor zo'n bevinding wordt niet meer gedaan. Ronde 2→3 liet zien dat dat nieuwe P2's oplevert.
- Als Codex daarna alleen nog op die laatste klasse `REQUEST_CHANGES` geeft, is `WP8_STATUS=FAIL`, met de lijst van wat resteert. Er komt dan geen vijfde herschrijving.

**Toepassing**
- De enige P2 uit ronde 4 bestond al eerder. Ze faalde echter *open* (een oude callback verbreekt een nieuwe verbinding) en viel binnen de invariant "geen callback na vrijgave". Ze is dus gerepareerd, met een lokale wijziging van drie regels zonder herschrijving van de levenscyclus.
- Ronde 5 vond niets meer.

**Bewust aanvaarde beperkingen (alle fail-closed)**

| Beperking | Gevolg | Waarom acceptabel |
|---|---|---|
| Geen request-id in MSP; de historie wordt niet geleegd op een open link | Na één verloren antwoord blijft elke latere save van die code op dezelfde verbinding `unknown`, tot een reconnect | Nooit vals "saved". De melding zegt nu "Disconnect, reconnect and save again" |
| Een BLE-write die de browser nooit afrondt | De pagina blijft bezig; transacties in andere tabs worden geweigerd | Volgens de specificatie weigert `disconnect()` lopende operaties; bij uitblijven daarvan is er geen bewijs |
| Een mislukte WebSerial-close | `false`; geen nieuwe poort tot een gelukte close | Er is geen bewijs dat de poort dicht is |
| Eigen transactie na eigen writes | Wacht maximaal 8 s, anders `fc:write_lease_timeout` | Een eerdere write mag niet midden in de transactie landen |
| OS-, USB- en native-TCP-buffers | Niet zichtbaar voor de browser | Ongewijzigde, gedocumenteerde grens |
| Tauri en Capacitor | Geen links: `DELIVERY_UNKNOWN`, gedrag ongewijzigd | NOT_VALIDATED, aparte scope |
| Kept-link reboot | De adapter levert het `connect`-event op de open link; de backendlus is niet geïntegreerd getest | Er is een adaptertest; `serial_backend.test.ts` mockt `serial.connect` |
| Web Bluetooth in de browser | Niet in Chromium getest | Alleen vitest met een nep-GATT |
| Eigen transactie bij live polling (NOT_VALIDATED) | `exclusive()` wacht tot de pagina stil is, en `pendingSends` telt ook reads die nog worden overgedragen. Op een trage link (BLE) met actieve statuspolling kan Apply/Check daardoor vertragen of `fc:write_lease_timeout` geven | Fail-closed. In geen enkele test liep polling, de browsertabs waren niet met een craft verbonden. Te valideren op hardware |

## 11. Softwareacceptatie versus hardwareacceptatie

**Software:** broncode, 5722 tests, mutanten, echte Chromium-tabs en een onafhankelijke review (§9).

**Hardware:** **niets uitgevoerd.**
- Geen FC, geen MSP-write op een fysieke craft, geen flash, geen motor.
- Het bewijs van sluiting rust op de Web Serial-specificatie en de Web Bluetooth-specificatie zoals gelezen, plus nep-browserobjecten.
- `HARDWARE_VALIDATION=NOT_EXECUTED`.
- `ABSOLUTE_SAFETY_POLICY.hardwareValidated` blijft `false` (`src/gyrocore/safety/absoluteEvaluate.ts:64`). Daarmee is **Absolute Apply BLOCKED**, ook volgens Codex 1B, 2B en 3B.

## 12. Eindstatus

**Softwarematig PASS**, binnen de begrenzingen van §10. Aan elk acceptatiecriterium uit de opdracht is voldaan:
- Geen hangende gesloten verbinding houdt het slot nog vast (`ORIGINAL_P2=CLOSED`).
- Geen write, callback of retry gaat door na de vrijgave.
- Een mislukte afsluiting wordt niet als succes gemeld.
- Er is geen nieuwe P0/P1 open.
- F01–F10 blijven CLOSED.
- Alle tests slagen.
- Codex heeft de definitieve implementatie onafhankelijk goedgekeurd.

**Hardware: niet gevalideerd.** Absolute Apply blijft BLOCKED.

```text
GYROFLIGHT_WP8_TRANSPORT_CLOSURE
BRANCH=feat/gyroflight-autotune-engine-v2
HEAD_BEFORE=6d295c31554b9240955ac6b125d6e95a17022a54
HEAD_AFTER=6aee384edf5c050375273995ec8d61733ba3b965
WEBSERIAL_CLOSE=PROVEN_PER_CONNECTION (CLOSED_CONFIRMED only after port.close() resolved; failed close = false + CLOSE_FAILED + port kept, no new port; double disconnect joins one teardown; cancelled open closed before reporting)
WEBBLUETOOTH_CLOSE=PROVEN_PER_CONNECTION (GATT down after gatt.disconnect() AND every writeValue() of the link settled; otherwise false and busy, fail-closed; double disconnect joins; failed teardown retried; no connect over an open link except the kept link itself)
SERIAL_GENERATION=PER_SEND_LINK (each handed send records its own TransportLink; bytes only to an OPEN link; no watermark; unhanded sends of an ended generation can never go out; transports without links = DELIVERY_UNKNOWN, unchanged)
WEBSOCKET_BUFFER=COUNTED_UNTIL_CLOSED (OPEN and CLOSING, including superseded sockets, count; CLOSED leftover does not; unknown readyState counts; every transport read)
WRITE_QUIESCENCE=PASS_BOUNDED (lease yielded and own transaction started only when quiet; OS/USB/native buffers outside the browser not covered)
CROSS_TAB_LOCK=PASS_SAME_ORIGIN_COOPERATING_TABS (Chromium 156 real tabs; other browsers/profiles/origins/devices/external programs not covered)
REGRESSION_TESTS=PASS (33 in wp8_transport_closure + 5 MSP-history cases; 18/21 fail on 6d295c31, 15 on b3ca2c6a, 14 on d0f94598; each later round's tests fail on its predecessor; mutants 19/19 + 3/4, the survivor a redundant layer)
BROWSER_TESTS=PASS (27/27, Chromium 156.0.8078.4 headless, playwright-core 1.64.0; real WebSerial and WebSocket adapters over in-page fakes; Web Bluetooth not browser-tested; 4 new checks fail on 6d295c31)
CODEX_REVIEW=APPROVE (final 6aee384e: P0=0 P1=0 P2=0, ORIGINAL_P2=CLOSED; integration F01-F10 APPROVE at af372bfb, delta to 6aee384e confirmed outside F01-F10; 9 completed reviews in this task)
P0_OPEN=0
P1_OPEN=0
P2_OPEN=0
TESTS_PASS=5722
TESTS_FAIL=0
TESTS_SKIP=14
TYPECHECK=PASS
LINT=PASS
BUILD=PASS
ABSOLUTE_APPLY=BLOCKED
HARDWARE_VALIDATION=NOT_EXECUTED
PUSHED=NO
MERGED=NO
WP8_STATUS=PASS_SOFTWARE (hardware NOT_EXECUTED; Absolute Apply BLOCKED)
REPORT_PATH=docs/gyrocore/audit/autotune-v2/2026-10-25-wp8-transport-closure.md
```
