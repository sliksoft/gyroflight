# Autotune v2 — WP8 Final Acceptance

**Datum:** 24 oktober 2026 · **Branch:** `feat/gyroflight-autotune-engine-v2`
**HEAD vóór:** `17fd4b0a` · **HEAD na:** `20242d2c` · niet gepusht, niet gemerged.
Geen FC-write, geen flash, geen hardware. Absolute Apply blijft BLOCKED.

## Eindoordeel: NOT_VALIDATED

- **`17fd4b0a`: FAIL.** De onafhankelijke Codex-review van `c7072275..17fd4b0a` vond P0's en P1's. Een eigen probe bevestigde onafhankelijk de Unicode-P0.
- **Na de reparaties:** de tests zijn groen.
- **Twee pogingen tot de verplichte eindreview van `17fd4b0a..20242d2c` gaven geen oordeel.** De contentfilter van de Codex-provider ("flagged for possible cybersecurity risk") brak beide halverwege af. HEAD en werkboom bleven ongewijzigd.
- **Gevolg:** de reparaties zijn niet onafhankelijk bevestigd. Dat is de reden voor NOT_VALIDATED in plaats van PASS.

## Review 1 (Codex, read-only, `c7072275..17fd4b0a`): FAIL

Ruwe uitvoer: `2026-10-24-wp8-final-codex-review1-raw.md` (ongetrackt).

**Procesafwijking:** tijdens deze review stond kort een probe-testbestand van de hoofdsessie in de werkboom. Het is verwijderd en is nooit gecommit.

| # | Bevinding | Ernst | Reparatie |
|---|---|---|---|
| 1 | MSP-CLI-encoder houdt alleen de lage byte. Daardoor werd `get p_rollĊsave` tijdens onzekerheid verstuurd als `get…\nsave\n` (ook lokaal gereproduceerd) | P0 | `7c14da9d` |
| 2 | Het CLI-tabblad vertrouwde de echo. Een completion-echo kon onderweg zijn (`sa\t`, gevolgd door onzekerheid, gevolgd door `exit`); de firmware voerde dan `save exit` uit | P0 | `c8a37e0e` en `20242d2c` |
| 3 | Web Bluetooth-wachtrij verzendt "na de blokkade" | P0-claim | Getest; geen bypass binnen één pagina (zie hieronder) |
| 4 | AutoRestore: weigering plus disconnect binnen 500 ms gaf `success: true`; een save in de wachtrij werd als geslaagd gemeld vóór verzending | P1 | `d14f2cec` |
| 5 | Backup-retentie (20 per craft) duwde na 20 mislukte herstelpogingen de vertrouwde target en de bewijs-backup weg | P1 | `5b7ca2b6` |
| 6 | Geweigerde CLI-exit meldde toch een reboot | P2 | `c8a37e0e` |
| 7 | Failsafe Save bleef op "Saving…" staan | P2 | `bee7b8b1` |
| 8 | De Tauri-adapter doet een retry zonder guard | P2 | Niet gerepareerd: de adapter is in de webbuild niet geselecteerd |

Codex beoordeelde de eerdere reparaties als volgt:
- retries: CLOSED;
- CLI-wachtrij: CLOSED;
- BS/DEL: CLOSED;
- BEEPER/sensor_hardware: CLOSED;
- AutoRestore: NOT CLOSED (bevinding 4).

## Commits

**`7c14da9d` — CLI-tekst alleen printbare ASCII tijdens onzekerheid.**
- Bij onzekerheid mag CLI-tekst alleen printbare ASCII en regeleinden bevatten.
- `MSP2_CLI_SETTING` wordt beoordeeld op de gecodeerde bytes.
- Getest: 8 tests rood op de oude code; mutaties M87 en M88 gevangen.

**`c8a37e0e` — CLI-tabblad en AutoBackup sturen alleen na een lege regel.**
- Tijdens onzekerheid gaat er eerst 256× DEL uit: in interactieve modus maakt dat de regelbuffer leeg, ongeacht de inhoud.
- Daarna volgt het hele commando; `'?'` (completion) wordt geweigerd.
- `cleanup()` meldt alleen een reboot als `exit` echt verzonden is.
- Getest: 4 tests rood, tegen een model van de regel-editor uit cli.c; mutaties M89 en M90 gevangen.

**`d14f2cec` — AutoRestore meldt pas "saving" na verzending.**
- "Saving" begint pas bij `onSent`, dus als `save` de CLI-wachtrij echt verlaat.
- Een weigering of drop vóór dat moment is meteen een mislukte restore.
- Getest: 3 tests rood.

**`5b7ca2b6` — Retentie raakt geen bewijs meer kwijt.**
- Per craft blijven 20 vertrouwde en 20 overige backups bewaard.
- Backups waarnaar een open entry verwijst blijven altijd staan.
- Is een entry onleesbaar, dan wordt er niets verwijderd.
- Getest: 4 tests rood; mutatie M91 gevangen.

**`bee7b8b1` — RXFAIL-weigering bereikt de Failsafe-save.**
- `sendRxFailConfig` krijgt `onRefused`; de Failsafe-save rejecteert dan.
- Getest: 2 tests rood.

**`20242d2c` — Geen ander verkeer tijdens een open CLI-sessie.**
- Zolang de interactieve CLI-sessie openstaat en schrijven geweigerd wordt, gaat er niets anders uit: geen MSP-frame en geen MSP-CLI.
- De reden: hun payload of CRC kan een regeleinde bevatten.
- Header van `fcWriteGuard` gecorrigeerd: wat geldt per tab, origin en transport.
- Getest: mutaties M92 en M93 gevangen.

**Gewijzigde bestaande test:** in `wp8_p0_closure_transport` stond een test op de exacte wire-bytes van het CLI-tabblad. Die verwacht nu de DEL-prefix. Dat is een strengere controle, geen versoepeling.

## Bluetooth en ordening

- **Wat getest is:**
  - de echte `WebBluetooth.send`, `serial.send` en MSP, met de GATT-write handmatig vrijgegeven;
  - de SET die vóór de lock is toegelaten, bereikt de craft vóór de eerste read van de transactie;
  - zijn retry wordt geweigerd zodra de toestand onzeker is.
- **Conclusie:** binnen één pagina is de volgorde op de lijn gelijk aan de volgorde waarin de check toelaat.
- **Niet gesloten (rest-risico):**
  - Writes buiten een transactie vragen geen Web Lock aan.
  - Een tweede tab ziet de transactie van een andere tab pas wanneer diens pending entry is opgeslagen, en dat gebeurt na de backup-read.
  - Of een tweede tab dezelfde craft kan bereiken, hangt van het transport af:
    - Web Serial: nee;
    - Bluetooth en TCP: niet geverifieerd.
  - Andere browsers, origins en externe programma's vallen buiten de bescherming.
  - Er wordt geen craftbrede claim gedaan.

## Herstel

- **Wat werkt:**
  - Herstel verwijdert alleen entries die een geverifieerde Restore dekt.
  - Bewijs-backups worden niet meer weggedrukt.
  - Er is geen route in de app die de transactiesleutels wist: `ConfigStorage.clear` heeft geen callers en de first-run cleanup raakt `gyroflight.*` niet.
- **Wat niet werkt (PARTIAL):** een verweesde `in_progress`-entry of een entry met onbekende profielscope heeft geen software-herstelpad. Dat is fail-closed: herstel kan alleen handmatig, buiten de app.
- **Bewust gedocumenteerd en niet gerepareerd:**
  - de Tauri-retry;
  - een geweigerde legacy-retry die zijn callback-entry houdt (zoals upstream);
  - firmwareflash, die buiten de guard valt;
  - browseropslag die buiten de app wordt gewist.

## Verificatie op `20242d2c`

- **`npx vitest run`:** 360 bestanden; 5512 PASS, 0 FAIL, 14 SKIP. De skips zijn de AIR65-tests op lokale data.
- **`npm run lint`** (eslint + vue-tsc): PASS.
- **`npm run build`:** PASS. Alleen de bestaande chunk-size-melding; geen waarschuwingen over circulaire imports.

## Eerste vervolgstap

Een onafhankelijke review van `17fd4b0a..20242d2c`. Bijvoorbeeld een Codex-run met een kleinere, gerichte opdracht per commit, of een menselijke reviewer.
