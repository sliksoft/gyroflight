# Betaflight-firmwarebronnen: CLI, `save` en `MSP_EEPROM_WRITE`

Op 25 oktober 2026 zijn de bronbestanden read-only opgehaald via `raw.githubusercontent.com/betaflight/betaflight/<branch>/...`. Het onderzoek is gedaan door een subagent. De hoofdsessie heeft de drie kernclaims daarna zelf in de opgehaalde bestanden nagelezen (zie het einde van dit document). De SHA-256-hashes van de opgehaalde bestanden staan in `fetched-sources.sha256`. Dit is uitsluitend broninspectie: er is niets op hardware uitgevoerd.

## Onderzochte branches

| Branch | HEAD | Datum |
|---|---|---|
| 4.3-maintenance | 59207272 | 28-02-2023 |
| 4.4-maintenance | 3f62795f | 14-11-2023 |
| 4.5-maintenance | 0455ec94 | 23-07-2026 |
| 2025.12-maintenance | 5b882017 | 23-10-2026 |
| master | d593400a | 24-10-2026 |

Steekproefsgewijs zijn ook tags 4.5.0 tot en met 4.5.4 bekeken.

## Interactieve CLI-regeleditor (de grondslag voor 256× DEL)

**Buffergrootte**
- `CLI_IN_BUFFER_SIZE` is 256.
- Uitzondering: STM32F1-builds van 4.3 gebruiken 128.

**Werking van `processCharacterInteractive()`**
- De functie is op alle branches inhoudelijk gelijk.
- `0x7F` verwijdert precies één teken: `if (bufferIndex) cliBuffer[--bufferIndex] = 0`.
- Op een lege buffer doet `0x7F` niets.

**Overige tekens**
- `0x08` verwijdert niets. Het teken valt buiten 32–126 en wordt genegeerd.
- `\t` en `?` starten tab-completion, wat de buffer kan wijzigen.
- CTRL-D op een lege buffer start `exit` met een reboot.
- ESC wordt genegeerd. De printbare tekens die erop volgen komen gewoon in de buffer.
- CR/LF op een lege buffer wordt genegeerd. Op een niet-lege buffer wordt de regel uitgevoerd tot de eerste `#`.

**Volle buffer**
- 4.3 tot en met 2025.12 gebruiken de grens `bufferIndex < sizeof(cliBuffer)`. De buffer vult zich dan tot 256 tekens zonder afsluitende NUL. Een volgende CR/LF voert de afgekapte regel uit en schrijft één byte voorbij de array.
- master gebruikt `sizeof(cliBuffer) - 1`, dus maximaal 255 tekens.

**Gevolg voor Gyroflight**
- 256× DEL maakt de interactieve regel op alle onderzochte branches leeg.
- Gyroflight stuurt daarna alleen gecontroleerde ASCII. Tab-completion, `?` en stuurtekens worden geweigerd.
- Een afgekapte regel begint nog steeds met het gecontroleerde commando.
- Op het non-interactieve STX-pad doet DEL niets. Daar gebruikt Gyroflight het ook niet.

## `save` (cliSave)

**Volgorde**
- `writeEEPROM()` wordt eerst voltooid.
- Daarna volgt `cliPrintHashLine("saving")`, met de uitvoer `\r\n# saving\r\n`.
- Daarna volgt `cliReboot()`, met de uitvoer `\r\nRebooting`, een flush en vervolgens `systemReset()`.
- Vanaf 4.5.4 bestaat ook `save noreboot`.

**Als het schrijven mislukt**
- `writeEEPROM()` roept via `writeConfigToEEPROM()` bij een fout `failureMode()` aan.
- `failureMode()` keert niet terug: het reset naar de ROM-bootloader.
- De firmware verifieert vóór het terugkeren `isEEPROMVersionValid()` en `isEEPROMStructureValid()`.

**Uitzonderingen**
- MINIMAL_CLI-builds printen geen `# saving`, maar wel `Rebooting`.
- Als `prepareSave()` faalt door een batchfout, wordt niets geschreven en volgt geen reboot.

## `MSP_EEPROM_WRITE`

**Normaal**
- Gewapend antwoordt de firmware met `MSP_RESULT_ERROR` (het `!`-frame) en schrijft niets.
- Anders roept het `writeReadEeprom()` aan. Het antwoord wordt pas verstuurd nadat `writeEEPROM()` en `readEEPROM()` zijn afgerond (`msp_serial.c`).

**Uitzonderingen**
- Bij USE_MSP_OVER_TELEMETRY met FEATURE_RX_SPI, en alleen voor verzoeken via de telemetriedescriptor, komt de ACK vóór een uitgestelde schrijfactie.
- Bij een schrijffout volgt `failureMode()`, en er komt geen ACK.

## MSP-CLI (STX/ETX)

**Beschikbaarheid**
- Aanwezig vanaf 4.5.4, op 4.5-maintenance, 2025.12 en master.
- Niet aanwezig op 4.3, 4.4 en 4.5.0 tot en met 4.5.3.

**Framing**
- Elke STX-sessie eindigt met één ETX. Die ontstaat door de ETX van de host, of door een byte die meer dan 2 s na de start binnenkomt.
- Bij `save` en `exit` (met reboot) komt nooit een ETX: de firmware reset eerst.

## Zelf nagelezen door de hoofdsessie

| Claim | 4.3 | 4.5 | master |
|---|---|---|---|
| `writeEEPROM()` staat vóór `cliPrintHashLine("saving")` en `cliReboot()` | cli.c:4263–4266 | cli.c:4245–4251 | cli.c:5178–5184 |
| `c == 127` verwijdert één teken als `bufferIndex` > 0 | cli.c:6795 | cli.c:6771 | cli.c:8995 |
| Buffergrens | `< sizeof` | `< sizeof` | `< sizeof − 1` |

Voor `MSP_EEPROM_WRITE` in `4.5-maintenance/msp.c:3299–3313`: gewapend `MSP_RESULT_ERROR`, en de RX_SPI-telemetrie-uitzondering.

## Niet gevalideerd

- Uitvoering op hardware.
- Andere firmware dan Betaflight, zoals INAV en Emuflight.
- De implementaties van `failureMode` voor PICO en ESP32.
- Builds met afwijkende `CLI_IN_BUFFER_SIZE`.
