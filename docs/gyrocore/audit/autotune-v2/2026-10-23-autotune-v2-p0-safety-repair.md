# Autotune v2: reparatie P0-veiligheidsfout (Apply-bypass)

**Datum:** 23 oktober 2026
**Branch:** `feat/gyroflight-autotune-engine-v2`
**HEAD vóór de reparatie:** `d50756215f73cfa23747ddd9a4bf7ed7e3caf7b9`
**HEAD na de reparatie:** `4ef4b5bfaaca3f5b3ee04868bcad21e4a067d0f5`

De reparatie bestaat uit drie commits: `63a7e2df`, `28ff17ea` en `4ef4b5bf`. Er is niet gepusht en niet gemerged. Dit rapport is niet gecommit.

Uitvoering: Claude Code implementeerde en valideerde. Codex (`codex-cli 0.164.0`, sandbox `read-only`) deed drie onafhankelijke reviewrondes.

Statuswoorden in dit rapport: PASS, FAIL, NOT_VALIDATED en NOT_EXECUTED.

---

## 0. Samenvatting

| Onderdeel | Status | Reden |
|---|---|---|
| P0 (absolute Apply-bypass) | **PASS** | Beide Apply-routes lopen via één write authority. Codex ronde 3 vond geen resterende P0 (`P0_REMAINING=PASS`). |
| Centrale Apply-gate | PASS | `src/gyrocore/releaseGate/writeAuthority.ts` wordt aangeroepen vóór elke MSP-aanroep, opnieuw na de live-reads, en nog eens vlak vóór de eerste SET. |
| Tests | PASS | 5306 ontdekt: 5292 PASS, 0 FAIL, 14 SKIP. De skips zijn de bekende AIR65-tests op echte logs. |
| Typecheck, lint, build | PASS | Alle drie exit 0. |
| Hardwarevalidatie | NOT_EXECUTED | Verboden door de opdracht. Alle resultaten komen uit de MSP-simulator en mocks. |
| Blokkade van de modelkwalificatie | Ongewijzigd, nog actief | Er is geen producer toegevoegd. Daarnaast blokkeert GyroCore Safety de absolute route nu altijd. |

**Gedragswijziging die gebruikers merken:** de slider-Preview draait niet meer zolang Apply geweigerd wordt. Dat is vandaag altijd het geval, omdat GyroCore Safety blokkeert (zie §2, F1).

---

## 1. Root cause

`applyAbsoluteTune` (`src/composables/useTuneApply.ts:860` op `d5075621`) riep alleen `assertAbsoluteReleased(proposal)` aan. Dat is het v2-release-contract, en het beoordeelt alleen het bewijs dat het voorstel zelf meedraagt.

De verplichte keten Composite → Safety → product lock (AGENTS.md) ontbrak volledig:
- `releaseContract.ts` importeerde geen van die drie gates;
- de Safety-voorwaarde controleerde alleen `safetyAnalysisEvidence === "available"`, een veld dat het voorstel zelf invult.

Het ontwerpdocument noemde dit destijds bewust "the satisfiable contract". In de app was de fout latent: zonder producer voor `modelClassQualification` gaf `evaluateRelease` nooit vrij.

## 2. Gevonden routes naar de FC

Een route schrijft naar de FC als hij een van deze MSP-codes verstuurt: `MSP_SET_PID`, `MSP_SET_PID_ADVANCED`, `MSP_SET_FILTER_CONFIG`, `MSP_SET_SIMPLIFIED_TUNING`, `MSP_EEPROM_WRITE` of `MSP_SELECT_SETTING`.

| Route | Bestaat | Status na reparatie |
|---|---|---|
| **Absolute route**: PID, FF en filters (`applyAbsoluteTune` ← `useAutotuneV2.confirmAndApply`, `useTuneApply()`) | ja | PASS: volledige write authority, opnieuw gecontroleerd vóór backup en vóór de eerste SET. Weigert vandaag altijd, op GyroCore Safety. |
| **Relatieve route / sliders** (`applyTune` ← `useAutotune.applyGains` ← `useTuneWorkflow.confirmAndApply`) | ja | PASS: dezelfde drie bestaande gates in dezelfde volgorde, plus een hercontrole vlak vóór de SET. |
| **Filterroute** | nee, geen aparte route | PASS: filterwijzigingen lopen via de absolute route. De slider-SET draagt ook de filtersliders, via de relatieve route. |
| **Feedforwardroute** | nee, geen aparte route | PASS: loopt via de absolute route. |
| **Opgeslagen voorstellen** | nee, niet persistent | PASS: voorstellen bestaan alleen in het geheugen (`shallowRef`). Hergebruik wordt afgevangen door de binding (gelijk aan de huidige analyse, bij Apply herberekend), de pin en de eenmalige confirmation-token. |
| **Slider-Preview** (`previewTune`), indirect | ja, review F1 | PASS: vereist nu dezelfde write authority. Een niet-geautoriseerd voorstel komt dus nooit in de gedeelde FC-store, waar de PID-tab-Save het zou kunnen wegschrijven. De `finally` zet de store ook na een mislukte berekening terug. |
| **Absolute Preview** (`previewAbsoluteTune`) | ja | Leest alleen. Schrijft niets naar de FC en zet geen voorstel in de store. |
| **Restore** (`restoreTune`, `restoreAbsoluteTune`) | ja | Bewust buiten de authority, als herstelroute. Heeft een eigen confirmation, controleert UID/firmware/disarmed, maakt eerst een backup, en bindt nu ook het *doel* via de preview-hash. Restsignalen staan in §8. |
| **Upstream handmatige writes** (PID-tab, sliders, CLI, presets, motors, OSD, config) | ja | Buiten scope: dit is handmatige configuratie, geen voorstelroute. Codex vond geen route meer die er een niet-geautoriseerd GyroCore-voorstel in voedt. |

**GitNexus:** niet gebruikt voor impact. De index bevat geen function-nodes voor de v2-bestanden (zie de audit van vandaag). De routes zijn daarom geïnventariseerd met grep op MSP-write-codes en callers, en daarna gecontroleerd in drie Codex-rondes.

## 3. Het nieuwe centrale autorisatiecontract

Het contract staat in `src/gyrocore/releaseGate/writeAuthority.ts`. Het volgt de volgorde van AGENTS.md. Elke stap wordt bij elke aanroep opnieuw uit de stores berekend; niets uit het voorstel telt als autorisatie op zichzelf.

| Stap | Slider-route | Absolute route |
|---|---|---|
| Composite | `assertCompositeApplyAuthorized` (bestaand) | `analysis_binding` (`analysisBinding.ts`): het voorstel is veld voor veld gelijk aan het releasable voorstel van de huidige analyse, en de analyse heeft status `done`. Bij Apply draait de engine opnieuw op de gedecodeerde inputs en de Verified Tune-store en moet hij het voorstel reproduceren. Hercontroles vereisen dezelfde analyse: inputs en result als dezelfde objecten, en elke input als hetzelfde object en log, behalve een verwijderd element (gat, zie §8-1). |
| Release-contract | n.v.t. | `evaluateRelease` (bestaand). Dekt modelkwalificatie, marges, items_validated en Verified Tune. |
| Safety | `assertSafetyAuthorized` (bestaand) | `absoluteSafetyAuthorization` (`safety/authorize.ts`), gebonden aan voorstel-id en change. GyroCore Safety kan absolute waarden niet beoordelen, dus deze stap geeft altijd `BLOCK missing_required_analysis` + `safety_not_evaluated:absolute_values`. |
| Product lock | `assertProductApplyReleased` (bestaand) | `productApplyBlocks` met het Safety-bewijs en de Verified Tune die de browser *nu* heeft. Een meegedragen record dat daarvan afwijkt geeft `independent_pid_validation_not_current`. |

Gedrag bij ontbrekend of slecht bewijs:
- Elke stap die niet geëvalueerd kan worden (een exceptie of een malformed voorstel) geeft `APPLY_DENIED` (`<stap>:evaluation_failed`); dat wordt nooit PASS.
- `applyAbsoluteTune` werkt vanaf de start met een plain-data-kopie van het voorstel (`plainCopy`). Vue-proxies worden daarbij uitgelezen. Getters, functies, klasse-instanties en `toJSON` worden geweigerd met `apply:proposal_not_plain_data`.
- Waarden worden vergeleken met `canonicalText`. Die vergelijking werkt met getypte tags en sleutels in vaste volgorde, zodat er geen botsingen tussen typen mogelijk zijn.

Er is **geen nieuwe PASS-voorwaarde** bijgekomen. Alle toevoegingen zijn weigerredenen.

**Let op bij de Composite-stap van de absolute route.** Daar draait niet de bestaande `assertCompositeApplyAuthorized`, want die beoordeelt slider-composites en geen absolute waarden. In de plaats daarvan staat `analysis_binding`. Of die semantisch gelijkwaardig is aan de bestaande composite-gate, is **NOT_VALIDATED** (Codex ronde 1). Safety en de product lock zijn wel de bestaande contracten.

## 4. Gewijzigde bestanden en functies

**Broncode:**

| Bestand | Wijziging |
|---|---|
| `src/gyrocore/releaseGate/writeAuthority.ts` (nieuw) | `assertSliderWriteAuthorized`, `absoluteWriteDecision`, `assertAbsoluteWriteAuthorized` |
| `src/gyrocore/releaseGate/analysisBinding.ts` (nieuw) | `currentAnalysisInput`, `analysisBindingIssues`, `pinAnalysis`, `canonicalText`, `plainCopy` |
| `src/gyrocore/safety/authorize.ts` | `absoluteSafetyAuthorization`, `SAFETY_NOT_EVALUATED_ABSOLUTE` |
| `src/gyrocore/productLock/productApply.ts` | `carriedPidValidation`, `RELEASE_INDEPENDENT_VALIDATION_NOT_CURRENT` |
| `src/composables/useTuneApply.ts` | Zie de lijst hieronder. |
| `src/composables/useAutotuneV2.ts` | `calculate` gebruikt `currentAnalysisInput`; `releasedProposal` gebruikt de authority. |
| `src/gyrocore/components/AutotuneV2Panel.vue` | Toont de stappen van de authority. |
| `src/gyroflight/locales/en.json` | Drie labels voor de condities. |

Wijzigingen in `src/composables/useTuneApply.ts`:
- `applyTune`: authority vooraf en opnieuw vóór de SET;
- `previewTune`: vereist de authority;
- `firmwareCalculation`: zet de store terug in een `finally`;
- `applyAbsoluteTune`: werkt met de kopie, de pin en de recheck;
- `writeAbsoluteBlocks`: krijgt een `beforeFirstSet`-hook;
- `restoreTune` en `restoreAbsoluteTune`: binden het doel via `restoreHash`.

**Documentatie:** `docs/gyrocore/AUTOTUNE_ENGINE_V2.md` heeft een nieuwe sectie "Write authority" en een lijst van open risico's. Het oude "satisfiable contract" is gecorrigeerd.

**Tests met aangepaste mocks** (geen enkele assertion gewijzigd):
- `absolute_apply_route`, `codex_review_msp_payloads`, `codex_review_pid_profile` en `codex_review_simplified_sim`: de mock van het release-contract is omgezet van `assertAbsoluteReleased` naar `evaluateRelease`, dezelfde semantiek.
- Die vier plus `autotune_v2_end_to_end`, `autotune_v2_panel`, `autotune_v2_user_flow`, `codex_review_failure_display`, `final_review_prepare_message` en `final_review_write_stages` geven de nieuwe stappen vrij via harnesses: binding, absolute Safety en product lock. Dit zijn write-path-tests; ze bewijzen het gedrag *achter* de gates, niet de productie-autorisatie.
- `tune_apply_route`: krijgt een `onCall`-hook voor de recheck-test en twee nieuwe describes.

**Harnesses:**
- `test/gyrocore/harness/analysisBindingRelease.ts` (nieuw);
- `test/gyrocore/harness/safetyRelease.ts` geeft nu ook `absoluteSafetyAuthorization` vrij.

Let op: `test/gyrocore/tune_workflow_panel.test.ts:367` ("preview offered while Apply is blocked") mockt `previewTune` en slaagt nog. In productie komt die situatie door de Preview-gating niet meer voor.

## 5. Negatieve regressietests

Er zijn vier testbestanden: `p0_write_authority.test.ts` (50 tests), `p0_write_authority_engine.test.ts` (8, met de echte engine en het echte contract), `p0_slider_preview_gate.test.ts` (4) en `tune_apply_route.test.ts` (+4).

In elke weigertest is precies één stap echt en zijn alle andere vrijgegeven. Een controle-test met alle stappen vrijgegeven laat zien dat er dan wél geschreven wordt. Bij weigeringen vóór MSP wordt gecontroleerd op **nul MSP-aanroepen** en **geen backup**.

| Vereiste uit de brief | Test(s) | Status |
|---|---|---|
| Ontbrekende Composite-validatie | binding: `analysis_not_done:idle`; slider: `sliders_differ_from_composite` (Preview en Apply) | PASS |
| Ontbrekende Safety-validatie | absolute Safety echt; Safety gebonden aan een ander voorstel; slider-Safety echt (Preview) | PASS |
| ProductLock actief | product lock echt (absoluut en Preview); de store-record telt, niet de meegedragen | PASS |
| Ontbrekende modelkwalificatie | engine-test: kwalificatie verwijderd → `model_class_qualification_missing` | PASS |
| Ongeldige of verlopen modelkwalificatie | verdict FAIL / INSUFFICIENT, eigen log, niet fijner; na de berekening gewijzigd → binding | PASS (verlopen: het begrip "expiry" bestaat niet in de code, dus getest als "gewijzigd of verwijderd na de berekening") |
| Verouderde voorstellen | voorstel van een eerdere berekening; analyse loopt of is mislukt; result tijdens Apply vervangen | PASS |
| PID-waarden gewijzigd na validatie | `p_roll` en een extra `i_roll` → `proposal_differs_from_analysis` | PASS |
| Filter- of FF-waarden gewijzigd | `dterm_lpf1_static_hz`, `f_pitch` | PASS |
| Opgeslagen voorstel met oude autorisatie | token van een eerdere berekening; Verified Tune vervangen; gedeeld voorstel ná de confirmation gewijzigd | PASS |
| Configuratie- of apparaatmismatch | andere UID, armed, live PID ≠ log (alle gates vrijgegeven, niets geschreven) | PASS |
| Directe aanroep zonder geldige gates | handgemaakt voorstel met verzonnen "available"-bewijs → alle 4 stappen weigeren; malformed; `useTuneApply()`-object; getter/functie; toJSON-imitatie | PASS |
| Geen write-call bij weigering | in elke weigertest: `codes()==[]` of `writes()==[]`, en backups leeg | PASS (simulator) |
| Gedeeltelijke transactie niet als succes | SET faalt na een eerdere SET → `TuneWriteError` stage `write`, geen EEPROM | PASS |
| Hercontrole vóór het schrijven | stap sluit tijdens de reads (vóór backup), na de backup (stage `prepare`, `saved: no`), slider-composite wijzigt | PASS |

**Mutatiecontrole.** Elke wijziging is één voor één teruggedraaid of verzwakt; de bijbehorende tests moeten dan falen.

| Mutatie | Falende tests |
|---|---|
| Oorspronkelijke P0-code (alleen release-contract) | 25 |
| Geen recheck | 3 |
| Geen herberekening | 4 (+1 engine) |
| Meegedragen record in de product lock | 1 |
| Safety-binding genegeerd | 1 |
| Geen slider-recheck | 1 |
| Geen `finally` in de Preview | 3 |
| Restore-hash zonder doel | 1 |
| Alleen identiteits-pin | 2 |
| Geen plain-data-kopie | 3 |
| Oude JSON-`canonicalText` | 3 |
| Alleen een telling als array-controle | 1 |
| Restore leest de backup opnieuw | 1 |
| Preview alleen met composite-controle | 3 |

Een eerdere mutatie (de clone van het Restore-doel) overleefde, omdat `tuneBackup.get()` altijd een nieuwe kopie parseert. Die redundante clone is daarom verwijderd in plaats van te blijven staan als schijnverdediging.

## 6. Volledige testresultaten

**Omgeving:** Node v24.21.0, npm 11.19.0, vitest 5.0.0, WSL2 Linux 6.6.87.2, Ryzen 7 5800X.

De commando's draaiden in deze volgorde, op de eindcode. De laatste wijziging was test-only; typecheck en die testfile zijn daarna opnieuw gedraaid.

| # | Commando | Resultaat |
|---|---|---|
| 1 | `npx vitest run p0_write_authority p0_slider_preview_gate tune_apply_route` | 100 / 100 PASS |
| 2 | Apply-, authority- en safety-set: 34 bestanden (`tune_apply*`, `absolute_apply_route`, `codex_review_*`, `final_review_*`, `autotune_v2_*`, `autotune_apply_blocked_ui`, `product_apply_lock*`, `chirp_apply_gate`, `chirp_gates`, `safety_*`, `release_contract`, `composite_reasons*`, `p0_*`, `tune_workflow*`) | 588 / 588 PASS |
| 3 | `npx vitest run` (volledig) | **5306 ontdekt, 5292 PASS, 0 FAIL, 14 SKIP**, in 3 m 31 s |
| 4 | `npm run typecheck` | PASS (na een fix van een type-fout in de nieuwe testfile) |
| 5 | `npx eslint src scripts *.mjs`, plus de gewijzigde tests | PASS |
| 5b | `npx prettier --check` op alle gewijzigde bestanden | PASS |
| 6 | `npx vite build --outDir <scratchpad>` | PASS |

De 14 skips zijn de AIR65-tests op echte logs. Ze zijn NOT_EXECUTED, omdat de fixtures niet lokaal aanwezig zijn. Ten opzichte van de baseline (5240) zijn er 66 tests bijgekomen.

## 7. Onafhankelijke Codex-bevindingen

Ruwe uitvoer: `2026-10-23-p0-codex-review-round{1,2,3}-raw.md`. Deze drie bestanden en dit rapport zijn nieuw in de bestaande auditmap, ongetrackt en niet gecommit. Ze bevatten lokale absolute paden. De twee eerdere auditbestanden zijn niet gewijzigd. In alle drie de rondes waren HEAD en de worktree vóór en na de review gelijk.

| Ronde | Op commit | Belangrijkste uitkomst | Actie |
|---|---|---|---|
| 1 | `63a7e2df` | Directe bypass gesloten. P0 F1: Preview-staging (bestond al). P0 F2: Restore-doel niet gebonden. P1 F3: de pin. P1 F4: `canonicalText`/`toJSON`. P1 F5: legacy Restore zonder profiel. | F1–F4 opgelost in `28ff17ea`. Codex' negatieve cases zijn als tests toegevoegd. |
| 2 | `28ff17ea` | P0 F1 bleef open (late replies en gelijktijdige Save tijdens de Preview). P1: F2 zonder hash, F3 bij wijziging in-place. P2: F4 met een opgevulde hole. | Preview gated, pin per input en exacte indices in `4ef4b5bf`. F2 zonder hash bewust als restpunt. |
| 3 | `4ef4b5bf` | **P0: geen.** F1, F4, PREVIEW_GATED en NO_GATE_WEAKENED: PASS. Resterend: P1 F3 (een *verwijderde* input maakt een gat dat `some()` overslaat), P1 F2 (Restore-token zonder hash), P2 (de Preview-knop blijft actief terwijl Preview geweigerd wordt). | Niet meer gewijzigd, zodat de laatste review over de eind-HEAD gaat. Zie §9. |

## 8. Resterende risico's

1. **P1 (F3-rest, in de nieuwe code):** `analysisChanged` ziet een `delete inputs[i]` niet, omdat `some()` gaten overslaat. Gemaskeerd door Safety. De oplossing is klein: alle indices aflopen en eisen dat elk element echt aanwezig is.
2. **P1 (F2-rest, bestond al):** een Restore-token zonder preview-hash bindt alleen het backup-id. De UI stuurt de hash altijd mee. De hash verplicht maken zou bestaande assertions in Restore-tests veranderen.
3. **P1 (F5, bestond al):** legacy Restore (`restoreTune`) is niet gebonden aan het PID-profiel.
4. **P2:** de slider-Preview-knop blijft actief terwijl Preview gegarandeerd geweigerd wordt. De weigering wordt wel netjes getoond.
5. **Transport:** MSP kent geen atomaire check-and-write. Het verzoek kan na de check in de wachtrij komen of opnieuw verstuurd worden (`src/js/msp.ts`). Een profielwissel of arming tussen de laatste `MSP_STATUS_EX` en de SET wordt pas achteraf gezien. Bescherming tegen die tussentijd is **niet** bewezen.
6. **Concurrency:** losse Apply- en Restore-aanroepen met verschillende tokens, en upstream saves, worden niet tegen elkaar geserialiseerd. Geautoriseerde Previews gebruiken nog steeds de gedeelde store; late replies na een timeout worden daar nog gedecodeerd.
7. **Herkomst:** de binding bewijst consistentie met de gedecodeerde inputs, niet met de huidige bestanden. Een verouderde berekening die opnieuw publiceert (audit P1-7) is niet opgelost. Een wijziging diep in een gedecodeerde log (de samples) wordt niet gezien.
8. **Hashes:** de Restore-hashes zijn 32-bit FNV en dus niet botsingsbestendig.
9. **Hardware:** alle conclusies komen uit de simulator, mocks en broncode-review. NOT_EXECUTED op hardware.

## 9. Status van de modelkwalificatie-blokkade en volgende stap

- **`modelClassQualification`:** er is nog steeds geen producer (`MODEL_QUALIFICATION_PRODUCER=NOT_IMPLEMENTED`). In de app blijven marges `MODEL_CONDITIONAL`, en het release-contract blokkeert `phase_margin` en `robustness`. Dat is ongewijzigd en niet kunstmatig opengezet.
- **Extra blokkade:** onafhankelijk daarvan weigert GyroCore Safety de absolute route nu altijd. Ook een toekomstige kwalificatie-producer geeft Apply dus niet vrij, totdat GyroCore Safety absolute waarden kan beoordelen. Dat is een bewuste productbeslissing voor later.
- **Volgende stappen, in volgorde:**
  1. F3-rest (de indexcontrole) met een test, en de beschrijving van de pin in `AUTOTUNE_ENGINE_V2.md` daarop aanpassen.
  2. Restore-token alleen met doel-hash, en daarbij de betreffende Restore-tests bijwerken.
  3. De Preview-knop laten volgen wat de authority toestaat.
  4. Een transactie-mutex voor Apply en Restore.
  5. Daarna pas het Safety-pad voor absolute waarden ontwerpen, en dan de kwalificatie-producer.
