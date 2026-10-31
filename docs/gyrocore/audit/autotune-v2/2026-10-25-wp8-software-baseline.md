# WP8 softwarebaseline

**Datum:** 2026-10-25
**Branch:** `feat/gyroflight-autotune-engine-v2`
**Code-checkpoint:** `6aee384edf5c050375273995ec8d61733ba3b965`

Dit document legt de softwarestand van WP8 vast. Latere commits die alleen documentatie toevoegen, veranderen dit
checkpoint niet. Het onderbouwende rapport is `redacted/2026-10-25-wp8-transport-closure.md`.

## Status

| Onderdeel | Status |
|---|---|
| WP8 software | PASS_SOFTWARE |
| WP8 hardware | NOT_EXECUTED |
| Absolute Apply | BLOCKED (`ABSOLUTE_SAFETY_POLICY.hardwareValidated = false`, `src/gyrocore/safety/absoluteEvaluate.ts:64`; reden `absolute_safety:not_hardware_validated`, `:180`) |
| F01–F10 | CLOSED: Codex-integratiereview APPROVE op `af372bfb` |
| Laatste transport-P2 | CLOSED: Codex APPROVE 0/0/0 op `6aee384e` (`ORIGINAL_P2=CLOSED`) |

## Hervalidatie op `6aee384e` (deze sessie)

Uitgevoerd op Node 22.22.2 (WSL2 Linux), met de werkboom gelijk aan `6aee384e` voor `src/` en `test/`.

| Controle | Resultaat |
|---|---|
| Volledige suite (`npx vitest run`) | 5719 PASS, 3 FAIL, 14 SKIP. De 3 fouten zijn time-outs (`Test timed out in 5000ms` en vergelijkbaar) onder parallelle belasting door drie leesagenten: `bundled_icons`, `msp_boundaries` en `web_only_fixes` |
| Die 3 bestanden apart | 3/3 bestanden, 17/17 tests PASS |
| Vorige volledige run zonder belasting (vorige sessie) | 5722 PASS / 0 FAIL / 14 SKIP |
| Lint en typecheck (`npm run lint`) | exit 0 |
| Build (`npm run build`) | exit 0 |
| Browsertest (`test/browser/crossTabWriteLease.browser.mjs`) | 27/27 PASS, Chromium headless via playwright-core, Vite op poort 5299 |

De 14 skips zijn de lokale AIR65-tests op echte logs (`test/gyrocore/*.local.test.ts`). Ze draaien alleen als een
omgevingsvariabele naar de logs wijst. De logs staan niet in de repository en zijn in deze sessie niet beschikbaar.

## Wat de baseline bewijst

- De centrale write-guard (`withFcWriteLock`, `fcWriteLease`) en de schrijfautorisatie zijn ongewijzigd.
- WebSerial en WebBluetooth melden een verbinding pas als gesloten op bewijs per verbinding (`TransportLink`).
  - WebSerial: `port.close()` is geresolved.
  - WebBluetooth: GATT is down én elke `writeValue()` van die verbinding is afgerond. Anders `false` en blijft de
    verbinding bezet.
- Een WebSocket telt mee als bezet tot hij CLOSED is. Dat geldt ook voor een vervangen socket.
- Cross-tab-exclusiviteit geldt alleen voor samenwerkende tabs van dezelfde origin in hetzelfde browserprofiel.

## Wat de baseline niet bewijst

- Hardware: niets is op een echte FC uitgevoerd.
- Web Bluetooth is niet in een browser getest.
- De herverbinding na een reboot via de open gehouden BLE-verbinding is niet end-to-end getest via `serial_backend`.
- Andere browsers, profielen, origins, apparaten en externe programma's vallen buiten de bescherming.
- Tauri- en Capacitor-transporten vallen buiten WP8. Tauri heeft geen `TransportLink`: zijn sends blijven
  `DELIVERY_UNKNOWN`.
- Buffers buiten de browser (OS, USB, native) vallen buiten de bescherming.

## Bekende beperkingen (fail-closed)

- MSP heeft geen request-id. Na één verloren antwoord melden latere saves van dezelfde code op dezelfde verbinding
  "unknown", tot er opnieuw verbonden wordt.
- Een BLE-write die nooit afrondt, houdt de pagina bezet.
- Een transactie wacht tot de eigen pagina stil is. Bij live polling over BLE kan Apply of Check daardoor vertraagd
  worden, of na 8 s geweigerd met `fc:write_lease_timeout`. Dit is NOT_VALIDATED.
