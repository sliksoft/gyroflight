# Autotune Engine v2: herstel, validatie en architectuuraudit

**Datum:** 23 oktober 2026
**Uitvoering:** Claude Code (fasen A–C, E). De onafhankelijke review in fase D is gedaan door Codex (`codex-cli 0.164.0`, model `gpt-6.1-sol`, sandbox `read-only`).
**Statuswoorden:** alleen PASS, FAIL, NOT_VALIDATED en NOT_EXECUTED, steeds met reden.

Dit rapport is niet gecommit. Er is geen broncode, test of dependency gewijzigd. Er is niets gemerged, er is geen PR geopend en er is geen hardware verbonden.

---

## 0. Samenvatting

| Onderdeel | Status | Reden |
|---|---|---|
| Branch / HEAD | PASS | `feat/gyroflight-autotune-engine-v2` @ `d50756215f73cfa23747ddd9a4bf7ed7e3caf7b9`, precies zoals verwacht |
| Remote back-up | PASS | `origin` (`git@github.com:sliksoft/gyroflight.git`) wijst naar `d5075621…` volgens `git ls-remote` |
| GitNexus-index | PASS | Actueel op `d5075621` onder Node v24.21.0 |
| GitNexus-impact | NOT_VALIDATED | De index mist alle function-nodes van de v2-bestanden. Impact is daarom alleen via text search bepaald |
| Lint / typecheck / build | PASS | Exit 0 |
| Prettier (formatting) | FAIL | 1 bestand. Niet in CI-scope (P2) |
| Volledige testsuite | PASS | 5240 ontdekt: 5226 PASS, 0 FAIL, 14 SKIP |
| Tests op echte vluchtdata (AIR65) | NOT_EXECUTED | De 14 skips zijn lokale BBL-fixtures die op dit systeem ontbreken |
| F-01 | FAIL | Codex P1-1: een niet-gedetecteerde overlap telt als onafhankelijk |
| F-02 | FAIL | Codex P1-2: een kwalificatie over dezelfde band begrenst het gedrag buiten de band niet |
| F-03 | FAIL | Codex P1-6 (CRC → "niets opgeslagen") en P1-5 (afgewezen referentie valideert) |
| Gate-volgorde / safety lock | FAIL | **P0-1**: `applyAbsoluteTune` slaat Composite, Safety en productLock over. Dit is nu latent, omdat P1-3 de release altijd blokkeert |
| Architectuur (adaptieve meetanalyse) | FAIL | 6 van de 7 criteria FAIL, 1 PASS |
| `modelClassQualification` | FAIL | Geen producer in de app. De release faalt veilig (fail-closed), dus Apply is onbereikbaar |
| Hardwarevalidatie | NOT_EXECUTED | Verboden door de opdracht. De procedure staat als "not yet executed" in `docs/gyrocore/AUTOTUNE_V2_HARDWARE_PROCEDURE.md:1` |

---

## 1. Fase A: preflight en back-up

| Controle | Resultaat |
|---|---|
| Worktree | `<home>/Gyroflight-worktrees/autotune-engine-v2` (git-common-dir `<home>/Gyroflight/.git`) |
| Branch | `feat/gyroflight-autotune-engine-v2` |
| HEAD | `d50756215f73cfa23747ddd9a4bf7ed7e3caf7b9` |
| Referentie | `gyroflight/main` = `origin/gyroflight/main` = `c67f92b1d1723c8b647671fc8632d815c5075245` |
| Merge-base | `c67f92b1`. Is een ancestor van HEAD |
| Commits t.o.v. referentie | 27 vooruit, 0 achter, 0 merge-commits. Alle 27 hebben auteur en committer `sliksoft` |
| `git status --porcelain` bij start | Leeg |
| Hoofdrepository | Staat op `gyrocore/wu6-chirp-quality-diagnostics` @ `4561f26c`. Niet aangeraakt |
| Remotes | `origin` = `sliksoft/gyroflight` (**publiek**). Push naar `upstream` = `DISABLED_NO_UPSTREAM_PUSH` |
| Processen in de worktree | Alleen deze sessie en de MCP-servers die zij startte (gitnexus, serena, context7, playwright). Geen vitest, vite of eslint van andere sessies |

### Publicatie-inhoud (alle 27 commits, 70 bestanden, +14 653 / −42)

- **Credentials en tokens.** Gescand op AWS-, GitHub-, OpenAI- en Slack-tokens, private keys, password-/api_key-literals en Bearer-tokens. Geen treffers.
- **Persoonsgegevens.** Er zijn geen e-mailadressen of IP-adressen toegevoegd. Eén persoonlijk pad komt voor: `<windows-home>/Downloads/drone/BTFL_BLACKBOX_LOG_AIR65_…BBL` in `test/js/air65_yaw_open_loop_offline.test.ts:47`. Die regel stond al op de publieke `origin/gyroflight/main`. De branch heeft hem alleen op één regel gezet. De push heeft dus niets nieuws openbaar gemaakt (zie P2-3).
- **Binaire en grote bestanden.** Geen binaire bestanden. Geen blob groter dan 200 KB.
- **Meetgegevens.** Er zijn geen echte vluchtdata toegevoegd. De fixtures zijn synthetisch (`syntheticLog.ts`), en `simplified_tuning_c/firmware_c_output.json` (2,8 KB) is uitvoer van de firmwareformule op synthetische `cases.txt`.
- **Onbedoelde artefacten.** Geen. `src/dist/` (een build-uitvoer van 12:10, vóór deze sessie) staat in `.gitignore`, is niet getrackt en is niet gepusht.

### Push

```
git push -u origin feat/gyroflight-autotune-engine-v2   → * [new branch] (exit 0)
git ls-remote origin refs/heads/feat/gyroflight-autotune-engine-v2
d50756215f73cfa23747ddd9a4bf7ed7e3caf7b9   refs/heads/feat/gyroflight-autotune-engine-v2
```

**REMOTE_BACKUP: PASS.** De remote HEAD is gelijk aan de lokale HEAD. Er is geen PR aangemaakt en niet gemerged.

> Let op: `.github/workflows/gyroflight-ci.yml` draait bij een push alleen voor `gyroflight/**` en `gyrocore/**`. Een `feat/…`-branch krijgt dus geen CI-run op de push. Pas een PR naar `master`, `gyroflight/**` of `gyrocore/**` start die.

---

## 2. Fase B: GitNexus

| Item | Waarde |
|---|---|
| Beschikbare Node-versies (nvm) | v20.20.2, v22.22.2 (shell-default), **v24.21.0** (gebruikt; gelijk aan `.nvmrc` en `engines`) |
| GitNexus CLI | 1.6.12. Twee aparte globale installaties: onder v22 en onder v24 |
| Indexlocatie | `<worktree>/.gitnexus` (per worktree). Er is geen gedeelde index met WU6 of andere worktrees, dus geen risico op overschrijven |
| `gitnexus status` (Node 24) | Indexed commit `d507562` = current commit. "Index content: matches all 1109 covered file(s)". **✅ up-to-date** |
| `gitnexus status` (Node 22) | **⚠️ stale** |
| Rebuild | **Niet uitgevoerd.** Niet nodig: de index is actueel |

**Oorzaak van "stale".** Het is een mismatch in runner-identiteit, geen inhoudelijke achterstand. De installatie onder Node 22 verschilt van de indexeerder in `runtime.modulesAbi` (127 tegenover 137), `runtime.version`, `invokedArtifact.path`, `build.rootPath` en `dependencyRuntime.digest` (252 tegenover 253 packages). De GitNexus MCP-server van deze sessie draait via `npx` op `<home>/.nvm/versions/node/v22.22.2/bin/node` (vastgesteld met `readlink /proc/<pid>/exe`). Dat de MCP-tools de index daardoor ook als stale zien, is waarschijnlijk maar niet via MCP geverifieerd. Oplossing: start GitNexus (CLI en MCP) onder Node 24.

**detect-changes** (`-s compare -b c67f92b1`): 70 bestanden, 199 symbolen, "701 affected processes, risk critical". Dat getal is **niet betrouwbaar**. Alle getoonde flows (RequestBuild, RunFlashWorkflow, LoadConfigBackup, Erase_page_next, …) zijn gekoppeld via de generieke symboolnaam `constructor` en niet via echte v2-code.

**impact: NOT_VALIDATED.** De index bevat 7384 Function-nodes, waarvan maar 127 onder `src/` liggen. Voor 20 gewijzigde `src`-bestanden heeft de index **geen enkele Function-node**: alle `src/gyrocore/engine/*.ts`, `releaseGate/*`, `productLock/productApply.ts`, `useTuneApply.ts`, `useAutotuneV2.ts` en `useAutotune.ts`. Er zijn alleen Interface-, Const- en TypeAlias-nodes. Daardoor geeft `gitnexus impact applyAbsoluteTune` (en elke andere export van `useTuneApply.ts`) "Target not found". Een rebuild met dezelfde analyzer en parse-cache lost dit naar verwachting niet op. Het is een extractiegat in de analyzer, geen staleness.

**Vervangende impact via text search** (imports in `src/`, zonder tests):
- `useTuneApply` ← `useTuneWorkflow.ts`, `useAutotune.ts`, `useAutotuneV2.ts`
- `useAutotune` ← `stores/autotune.ts`, `gyrocore/stores/chirpQualification.ts`, `useTuneWorkflow.ts`, `useTuneApply.ts` en 4 componenten in `components/tabs/autotune/`
- `useAutotuneV2` ← alleen `gyrocore/components/AutotuneV2Panel.vue`
- `AutotuneTab.vue` ← `src/js/vue_tab_registry.ts`
- MSP-boundary: geen enkele import van `js/msp` vanuit `src/gyrocore` of `src/gyroflight` (CI-ESLint `boundaries/dependencies` PASS)

---

## 3. Fase C: testvalidatie

**Omgeving:** Linux 6.6.87.2-microsoft-standard-WSL2 x86_64, AMD Ryzen 7 5800X (16 threads), 47 GB RAM. Load ~2,3 bij de start. Node v24.21.0, npm 11.19.0, vitest 5.0.0.
**Dependencies:** `npm ls --depth=0` geeft geen fouten. `package.json` en `package-lock.json` zijn niet gewijzigd door de branch. Er is geen `npm ci`/`install` gedraaid.
**Officiële commando's:** uit `.github/workflows/gyroflight-ci.yml`, met daarnaast `test.yml` en `package.json`.

| # | Commando | Resultaat | Tijd |
|---|---|---|---|
| 1 | `npm run typecheck` (`vue-tsc --noEmit`) | PASS (exit 0) | 21,7 s |
| 2 | `npx eslint src scripts *.mjs` (CI-scope) | PASS (exit 0) | 15,8 s |
| 2b | `npx eslint <gewijzigde test/*.ts>` (extra, buiten CI) | PASS (exit 0) | – |
| 3 | `npx prettier --check <70 gewijzigde bestanden>` (extra; CI heeft geen Prettier-stap) | **FAIL**: `test/js/air65_yaw_open_loop_offline.test.ts` | – |
| 4 | `npx vitest run` (volledig, JSON-reporter) | PASS (exit 0) | 3 m 41 s wall, 33 m CPU |
| 5 | `npx vite build --outDir <scratchpad>` (= `npm run build` met de uitvoer buiten de worktree) | PASS (exit 0). Alleen waarschuwingen over chunkgrootte | 17,5 s |

### Volledige suite (stap 4)

| | Aantal |
|---|---|
| Testbestanden | 343 (335 passed, 8 skipped) |
| Suites | 1288 (alle passed) |
| **Tests ontdekt** | **5240** |
| **PASS** | **5226** |
| **FAIL** | **0** |
| **SKIP** | **14** |
| TODO | 0 |

**Afwijking van de eerdere claim.** Eerder werden 5143 tests genoemd. Vastgesteld zijn er 5240 ontdekt, dus +97. Het eerdere getal is niet reproduceerbaar of verifieerbaar. Waarschijnlijk is het gemeten op een eerdere commit, maar dat is niet vastgesteld.

**De 14 skips** zijn allemaal NOT_EXECUTED. Ze hebben lokale echte AIR65-BBL-bestanden nodig die op dit systeem ontbreken:
`air65_autotune.local` (2), `air65_autotune_v2.local` (1), `air65_blackbox.local` (2), `air65_qualification.local` (2), `flight_identity_air65.local` (1), `write_merge_e2e_logs.local` (1), `air65_dterm_dynamic.local` (2), `air65_m4_bbl.local` (2) en `air65_yaw_open_loop_offline` (1).
Er is dus **geen enkele test op echte vluchtdata** uitgevoerd. Ook `air65_autotune_v2.local.test.ts` ("analyses both CHIRP flights, validates the gyro chain…") is niet gedraaid.

### Gerichte subsets, los gedraaid (overlappen gedeeltelijk, dus niet optellen)

| Subset | Bestanden | Tests | PASS | FAIL | SKIP |
|---|---|---|---|---|---|
| Autotune (`autotune_*`, `air65_autotune*`, `codex_review_*`, `final_review_*`, `tune_apply*`, `absolute_apply*`) | 24 | 271 | 268 | 0 | 3 |
| F-01 (`final_review_duplicate_flights`, `final_review_flight_groups`, `codex_review_duplicate_logs`) | 3 | 35 | 35 | 0 | 0 |
| F-02 (`final_review_f02_evidence`, `final_review_loop_resolution`, `final_review_band_edge`, `codex_review_loop_model`) | 4 | 76 | 76 | 0 | 0 |
| F-03 (`final_review_prepare_message`, `final_review_write_stages`, `codex_review_failure_display`) | 3 | 18 | 18 | 0 | 0 |
| Safety / fail-closed (`safety_*`, `product_apply_lock*`, `chirp_apply_gate`, `chirp_gates`, `release_contract`, `composite_reasons_text`, `autotune_apply_blocked_ui`, `tune_apply_route`, `absolute_apply_route`, `codex_review_verified_tune`, `codex_review_msp_payloads`, `codex_review_pid_profile`) | 14 | 347 | 347 | 0 | 0 |

**Interpretatie.** Groene tests betekenen hier "het code-gedrag komt overeen met de verwachtingen die samen met de fixes zijn geschreven". Ze bewijzen niet dat F-01, F-02 en F-03 correct zijn opgelost. De Codex-review (§4) vond in alle drie de gebieden scenario's die de tests niet afdekken. In één geval legt een test het bekritiseerde beleid zelfs vast: `final_review_flight_groups.test.ts:206` verwacht dat A en C zonder B als onafhankelijk tellen.

---

## 4. Fase D: onafhankelijke Codex-review

**Uitvoering:** `codex exec -s read-only -C <worktree> -o …` met een prompt die alleen de onderzoeksvragen bevatte, zonder conclusies of testresultaten van Claude. Codex heeft geen tests gedraaid. HEAD en `git status` waren voor en na de review identiek. Codex gebruikte 240 204 tokens. De ruwe uitvoer staat ongewijzigd in `2026-10-23-codex-review-raw.md` naast dit rapport.

**Verificatie door Claude** (gescheiden van het oordeel van Codex): P0-1, P1-3, P1-5 en P1-6 zijn op de geciteerde regels in de broncode nagelezen en kloppen (PASS in de tabel). De overige bevindingen zijn niet apart nagelezen (NOT_VALIDATED).

### Statustabel volgens Codex

| Item | Status | Reden (Codex) |
|---|---|---|
| F01 | FAIL | Gedetecteerde overlap wordt transitief gegroepeerd, maar het niet detecteren van overlap wordt behandeld als onafhankelijkheid |
| F02 | FAIL | Evidence-niveaus worden afgedwongen, maar een fijnere meting over dezelfde band kwalificeert het aangenomen gedrag boven die band niet |
| F03 | FAIL | De prepare-tekst is voorzichtig, maar een CRC-fout op EEPROM meldt ten onrechte "niets opgeslagen", en afgewezen referenties kunnen validatie opleveren |
| GATES | FAIL | Absolute Apply slaat Composite, Safety-autorisatie en `productLock/` over |
| ARCH 1: relevante frequentiegebieden | FAIL | Grotendeels vaste banden. Geen adaptief beleid om gebieden te kiezen |
| ARCH 2: resolutie, duur en methode | FAIL | Welch-segmentgrootte hangt alleen af van de samplerate. Meetverzoeken bevatten geen berekende duur, resolutie of excitatie |
| ARCH 3: aanvullende metingen | PASS | De engine geeft expliciete verzoeken voor ontbrekende CHIRP-, hogere-frequentie-, fijnere-resolutie-, eRPM- en A–B-metingen |
| ARCH 4: onzekerheid | FAIL | Spreiding tussen herhalingen en chain spread bestaan, maar er is geen gekalibreerde propagatie naar betrouwbaarheidsgrenzen |
| ARCH 5: betrouwbare identificatie | FAIL | Afgewezen referenties en onvolledig gecontroleerde baseline-herhalingen tellen mee |
| ARCH 6: verantwoorde PID- en filteradviezen | FAIL | De PID-kwalificatie heeft open beperkingen. Filter- en FF-aanbevelingen worden nooit van A–B-evidence naar VALIDATED gepromoveerd |
| ARCH 7: Apply pas na gevalideerde safety | FAIL | Het release-contract controleert statussen, maar slaat de Safety- en productautorisatieketen over |
| FIXED_FACTORS | NOT_VALIDATED | Definities en lokale onderbouwing bestaan. Algemene toepasbaarheid en kalibratie over craft- en modelklassen zijn niet aangetoond |
| MODEL_CLASS_QUALIFICATION | FAIL | De rekenkundige producer bestaat, maar de UI levert nooit een kwalificatie-input |

### Bevindingen

| ID | Ernst | Kern | Plaats | Nagelezen door Claude |
|---|---|---|---|---|
| P0-1 | **P0** | De absolute Apply-route slaat de verplichte gate-keten over | `src/composables/useTuneApply.ts:860-883` (tegenover `:415-424`), `src/gyrocore/releaseGate/releaseContract.ts:273` | PASS |
| P1-1 | P1 | Een onbekende relatie tussen vluchten wordt als onafhankelijk geaccepteerd (F-01) | `src/gyrocore/engine/logInput.ts:196-210, 284`, `test/gyrocore/final_review_flight_groups.test.ts:206` | NOT_VALIDATED (alleen de constanten `minShared: 4` en `samples: 256` nagelezen) |
| P1-2 | P1 | Een kwalificatie over dezelfde band bewijst de robuustheidsgrens buiten de band niet (F-02) | `src/gyrocore/engine/loopModel.ts:650, 694, 750, 843` | NOT_VALIDATED |
| P1-3 | P1 | De productiecode levert de kwalificatie niet die het release-contract eist | `src/composables/useAutotuneV2.ts:181`, `src/gyrocore/engine/logInput.ts:409`, `src/gyrocore/engine/autotuneV2.ts:353` | PASS |
| P1-4 | P1 | Baseline-herhalingen worden niet tegen de volledige configuratie en identiteit gecontroleerd. Spreiding verbreedt de tolerantie zonder bovengrens | `src/gyrocore/engine/verifiedTuneFromLogs.ts:77`, `logInput.ts:384`, `src/gyrocore/releaseGate/verifiedTune.ts:240` | NOT_VALIDATED |
| P1-5 | P1 | Een afgewezen referentie-CHIRP kan de plant-identificatie VALIDATED maken | `src/gyrocore/engine/autotuneV2.ts:470-485` (geen `oc.state`-check), `:661-664` | PASS |
| P1-6 | P1 | Een CRC-corrupt EEPROM-antwoord meldt "Nothing was saved" | `src/composables/useTuneApply.ts:773-775`, `src/gyroflight/locales/en.json:843` | PASS |
| P1-7 | P1 | Een lopende berekening kan resultaten publiceren voor bronnen die inmiddels vervangen zijn | `src/composables/useAutotuneV2.ts:149, 172`, `src/gyrocore/stores/autotuneV2.ts:104` | NOT_VALIDATED |

**P0-1 in detail (geverifieerd).** `applyTune()` (sliderroute) roept vóór elke MSP-aanroep `assertCompositeApplyAuthorized` → `assertSafetyAuthorized` → `assertProductApplyReleased` aan (`useTuneApply.ts:415-424`). `applyAbsoluteTune()` roept alleen `assertAbsoluteReleased(proposal)` aan (`:866`). Die functie draait `evaluateRelease` (`releaseContract.ts:273-278`), en `releaseContract.ts` importeert niets uit Composite, Safety of productLock (`:48-52`). De Safety-voorwaarde in het contract controleert alleen dat `safetyAnalysisEvidence === "available"` is. Het ontwerpdocument (`docs/gyrocore/AUTOTUNE_ENGINE_V2.md:23`) noemt "release contract + confirmation" als de gates van deze route. De afwijking is dus een ontwerpkeuze, maar ze is in strijd met de projectregel in `AGENTS.md`: *"Composite → Safety → product lock → live readback → live recheck. Never bypass or reorder a gate."*
**Huidig risico: latent** (nagelezen door Claude). Elke niet-lege wijziging vereist marges op niveau VALIDATED voor minstens één as. PID- en FF-sleutels gaan via `changedAxes`, en een filterwijziging vereist alle drie de assen (`releaseContract.ts:180-224`). VALIDATED vereist een kwalificatie-object (`loopModel.ts:279-300, 850-862`), dat de app nooit levert (P1-3). Voorstellen komen alleen uit `store.result`, een niet-persistente `shallowRef` (`src/gyrocore/stores/autotuneV2.ts:82`, `useAutotuneV2.ts:222-225`). Er is geen tweede ingang. `assertAbsoluteReleased` blokkeert dus nu altijd. Zodra P1-3 is opgelost, wordt P0-1 direct bereikbaar. **Daarom moet P0-1 worden opgelost vóór of samen met P1-3.**

### Vaste factoren en de 4,5×-factor

*Eigen analyse van Claude (niet van Codex):*

- **De 4,5× is een afgeleide grootheid, geen gemeten universele constante.** `RESOLVED_FEATURE_BINS = 1/tan(12.5°) ≈ 4.51` (`loopModel.ts:186`) volgt uit de gekozen grens van 25° faseverandering per bin (`LOOP_RESOLUTION.maxPhaseStepDeg`, `loopModel.ts:150-155`), met als argument een resonantie met de vorm van een tweede-orde-systeem.
- **De 25° zelf is empirisch.** De motivering in het commentaar is één dataset: "De AIR65 CHIRP-logs (1,95 Hz bins) springen maximaal 23° boven de crossover".
- **Het wordt wel als universele eis gebruikt.** `qualifyModelClass` (`loopModel.ts:745`) eist voor elke craft dat de kwalificatielog een resolutie heeft die minstens 4,51× fijner is.
- **Oordeel:** **NOT_VALIDATED** als universele eis. De factor is intern consistent afgeleid, maar de drempel waaruit hij volgt is maar op één craft gekalibreerd.

*Codex (FIXED_FACTORS = NOT_VALIDATED)* vond hetzelfde voor alle vaste drempels (de volledige tabel staat in het ruwe bestand, §"Fixed factors"):
- chord allowance 0,111
- `LOOP_RESOLUTION` (25°, 2 dB, 300°/neper, 80 dB/dec, gap ×3)
- `BAND_END` (staart 10 %, ≥4 bins, ≤−6 dB)
- `CHAIN_ACCEPT` (5 %, 3°, coherentie 0,9)
- kwalificatietekorten 5° / 1,5 dB (`loopModel.ts:217`)
- Verified Tune (≥80 % binnen tolerantie)
- CHIRP-kwaliteitsdrempels

Al deze drempels hebben een lokale onderbouwing (vaak AIR65 of M5-A), maar geen algemene kalibratie of begrensde kans op een onterechte acceptatie.

---

## 5. Status per aandachtsgebied

### F-01: één vlucht over overlappende fragmenten: **FAIL**
De transitieve groepering (union-find over A–B–C) werkt voor overlap die gedetecteerd wordt. Maar `sameFragment()` geeft `false` zodra er geen bestandsidentiteit, geen stream-fingerprint en geen 4 gedeelde actieve vensters van 256 samples zijn. Die `false` wordt vervolgens behandeld als "onafhankelijk". Er is geen toestand `UNKNOWN`.
Scenario's waarin dit misgaat:
- overlap korter dan 256 samples;
- gedeelde data met weinig beweging;
- twee disjuncte fragmenten van dezelfde vlucht waarvan het overbruggende fragment ontbreekt.

### F-02: meetresolutie en stabiliteitsmarges: **FAIL**
Positief:
- het `MODEL_CONDITIONAL`/`VALIDATED`-contract wordt afgedwongen;
- meervoudige unity-crossings, gaten en te grote stappen tussen bins, en ontbrekende chain-banden worden geblokkeerd.

Negatief:
- GM en |S| boven het einde van de meetband steunen op de aanname `loop_above_band_end_bounded_by_tail`. Een fijnere meting over **dezelfde** band test die aanname niet, maar promoveert de marges toch naar VALIDATED zodra er een kwalificatie wordt aangeleverd.
- Of phase-unwrapping in absolute zin correct is, is niet vastgesteld (NOT_VALIDATED volgens Codex): het unwrappen start vanuit de principale fase zonder een onafhankelijk vastgestelde tak.

### F-03: prepare-stage en foutafhandeling: **FAIL**
De prepare-tekst claimt alleen wat bekend is. Twee foutpaden doen echter ongefundeerde claims:
- **P1-6:** een CRC-fout op een EEPROM-ACK geeft "Nothing was saved". De firmware kan het opslaan echter wél hebben uitgevoerd. Dit moet `unknown` zijn.
- **P1-5:** een afgewezen referentiemeting kan plant-VALIDATED opleveren.

Daarnaast kan door **P1-7** een verouderde berekening resultaten tonen onder een nieuwe bronlijst.

### Safety lock / gate-keten: **FAIL**
- De **sliderroute (v1)** volgt de volledige keten en de safety-tests slagen offline: 347 van 347 tegen de firmware-simulator.
- De **absolute route (v2)** slaat Composite, Safety en productLock over (P0-1). Dat is nu latent.
- De live readback en recheck op een echte FC zijn **NOT_EXECUTED**: er is geen hardware gebruikt.
- `UPSTREAM_ANALYTICS_ENABLED` en `BETAFLIGHT_ACCOUNTS_ENABLED` staan op `false` (`src/gyroflight/policy.ts:30, 37`): **PASS**.

### Adaptieve meetanalyse (architectuur 1–7): **FAIL**
Alleen criterium 3 (aangeven wanneer er extra metingen nodig zijn) is PASS. De engine bepaalt niet zelf welke frequentiegebieden relevant zijn, en ook niet welke resolutie, duur of methode een meting nodig heeft. Onzekerheid wordt niet gekalibreerd gepropageerd. Filter- en FF-adviezen blijven PARTIAL.

### `modelClassQualification`: **FAIL**
Er zijn drie losse begrippen:
- `MODEL_CLASS_QUALIFICATION`: de tolerantieconstanten (`loopModel.ts:217`);
- `ModelClassQualification`: het resultaattype (`:239`);
- `qualifyModelClass()`: de producer van het resultaat (`:736`).

Wat ontbreekt is de **input-producer en -selector in de app**. `pickPrimary()` (`logInput.ts:409`) geeft alleen `{primary, others}` terug, en de enige productie-aanroep van `runAutotuneV2` (`useAutotuneV2.ts:181`) geeft `modelClassQualification` nooit mee. Alleen tests leveren hem aan (12 testbestanden via `simulatedQualificationLog()`).

Gevolgen:
- In de app blijven de marges altijd MODEL_CONDITIONAL, dus de voorwaarden `phase_margin` en `robustness` falen. **Dat is fail-closed**: er wordt niets stil als gekwalificeerd behandeld. Maar een v2-PID-voorstel kan in de app nooit vrijgegeven worden.
- Daarnaast kiest `chooseSegmentSize()` de FFT-grootte alleen op basis van de samplerate, met een maximum van 4096. Langer opnemen levert de gevraagde fijnere resolutie dus niet automatisch op.

### Hardwarevalidatie: **NOT_EXECUTED**
De opdracht verbood hardware, en de procedure is nog niet uitgevoerd (`AUTOTUNE_V2_HARDWARE_PROCEDURE.md:1`). Ook de lokale tests op echte AIR65-logs zijn niet gedraaid (14 skips).

---

## 6. P0/P1/P2-overzicht

**P0**
- **P0-1:** de absolute Apply-route slaat Composite, Safety en productLock over (latent zolang P1-3 bestaat).

**P1**
- **P1-1:** onbekende relatie tussen fragmenten telt als onafhankelijk (F-01).
- **P1-2:** marges buiten de meetband worden VALIDATED op basis van een aanname over de staart (F-02).
- **P1-3:** de app heeft geen producer voor `modelClassQualification`. Apply is daardoor onbereikbaar.
- **P1-4:** de configuratie en identiteit van baseline-herhalingen worden niet volledig gecontroleerd, en spreiding verbreedt de tolerantie zonder grens.
- **P1-5:** een afgewezen referentie-CHIRP kan VALIDATED opleveren.
- **P1-6:** een EEPROM-CRC-fout geeft de onjuiste melding "Nothing was saved".
- **P1-7:** een verouderde berekening kan resultaten publiceren voor een nieuwe bronlijst.

**P2**
- **P2-1:** de GitNexus-index mist de function-nodes van alle v2-bestanden, dus impactanalyse is onmogelijk. Daarnaast draaien de MCP-server en de standaardshell onder Node 22, waardoor de index als stale wordt gemeld (eigen bevinding).
- **P2-2:** Prettier faalt op `test/js/air65_yaw_open_loop_offline.test.ts`. Op de regels 68, 145 en 201 zijn de weggehaalde `eslint-disable`-commentaren vervangen door regels met alleen spaties. CI heeft geen Prettier-stap (eigen bevinding).
- **P2-3:** een persoonlijk Windows-pad (`<windows-home>/…`) staat in `test/js/air65_yaw_open_loop_offline.test.ts:47`. Het was al publiek op `gyroflight/main`. Advies: vervangen door een env-variabele (eigen bevinding).
- **P2-4:** `gyroflight-ci.yml` draait niet op een push naar een `feat/**`-branch (eigen bevinding).
- **P2-5:** het eerdere testaantal (5143) is niet reproduceerbaar. Vastgesteld is 5240 (eigen bevinding).

---

## 7. Ontbrekende acceptatiecriteria

1. **Eén afgedwongen autorisatieketen voor alle schrijfroutes**: Composite → Safety → product lock → live readback → live recheck, gebonden aan het exacte voorstel. Met een test die aantoont dat de absolute route blokkeert wanneer één gate blokkeert.
2. **Positief bewijs van onafhankelijkheid.** Drie toestanden: `SAME`, `INDEPENDENT` en `UNKNOWN`, waarbij `UNKNOWN` nooit als herhaling telt. Met testgevallen voor korte overlap, disjuncte fragmenten en een ontbrekende brug.
3. **Een gedefinieerde modelklasse.** Toegestane delay, demping en resonanties, plus het gedrag buiten de meetband. Daartegen gekwalificeerde interpolatie- en staartgrenzen.
4. **Een kwantitatieve meetplanner.** Berekent het frequentiebereik, de effectieve resolutie (inclusief de FFT-grootte, nu maximaal 4096), de duur, de excitatie, het aantal herhalingen en de methode (CHIRP of Blackbox).
5. **Gekalibreerde onzekerheid.** Gepropageerd naar conservatieve grenzen voor PM, GM en |S| en voor de aanbevelingen.
6. **Gekwalificeerde referenties.** Elke referentie moet de meet-, identiteits-, configuratie- en stationariteitschecks halen. Tegenstrijdige referenties blokkeren de validatie.
7. **De kwalificatie-workflow in de app.** Fijnere identificaties selecteren of produceren, en A–B-evidence voor filters en FF naar VALIDATED kunnen promoveren.
8. **Volledige semantiek van foutstatussen.** Een corrupte ACK na geslaagde uitvoering, verouderde berekeningen en gelijktijdige imports.
9. **Kalibratie van de vaste drempels** (25°, 4,5×, 5°/1,5 dB, −6 dB, coherentie) op meerdere craft- en configuratieklassen, met een begrensde kans op onterechte acceptatie.
10. **Fysieke acceptatie.** Uitvoering van `AUTOTUNE_V2_HARDWARE_PROCEDURE.md` met vastgelegd MSP-verkeer, de configuratie voor en na, en de gemeten voorspelfouten. Daarnaast de AIR65-tests op echte logs.

---

## 8. Aanbevelingen voor de volgende ontwikkelstap

Volgorde op risico, telkens één concern per PR:

1. **P0-1 eerst.** Laat `applyAbsoluteTune` dezelfde Composite-, Safety- en productLock-keten doorlopen als `applyTune`, opnieuw berekend voor de absolute wijziging. Voeg een adversariële test toe waarin het release-contract slaagt maar Composite of Safety blokkeert. **Doe dit vóór P1-3**, anders wordt de bypass bereikbaar.
2. **P1-6:** zet een CRC-fout op de EEPROM-ACK op `unknown`, met een test voor de situatie "save uitgevoerd, ACK corrupt".
3. **P1-5:** sluit referentiemetingen met `state === "rejected"` uit vóór de plant-vergelijking. Leg ook vast wat er gebeurt bij tegenstrijdige referenties.
4. **P1-7:** koppel elke berekening aan een revisie van de bronlijst en gooi verouderde resultaten weg.
5. **P1-1:** introduceer de toestand `UNKNOWN` voor de relatie tussen vluchten. Herzie `final_review_flight_groups.test.ts:206`.
6. **P1-4:** controleer baseline-herhalingen met het volledige cross-log-contract en zet een bovengrens op de spreiding.
7. **P1-3 en P1-2, als ontwerpwerk.** Ontwerp eerst de modelklasse en de meetplanner, en pas daarna de input-producer voor de kwalificatie. Een kwalificatie over dezelfde band mag de marges buiten de band niet promoveren.
8. **Tooling:** draai GitNexus onder Node 24. Onderzoek of meld bij GitNexus waarom function-nodes in TypeScript niet worden geëxtraheerd. Voeg een Prettier-check toe aan `gyroflight-ci.yml` en laat CI ook draaien op `feat/**`.
9. **Validatie:** draai de AIR65-tests op echte logs lokaal met de fixtures, en daarna de hardwareprocedure. Pas dan kunnen statussen boven NOT_EXECUTED uitkomen.

---

## Bijlagen

- De ruwe Codex-review staat in `docs/gyrocore/audit/autotune-v2/2026-10-23-codex-review-raw.md`. Dat bestand bevat absolute lokale paden (`<home>/…`) en mag niet ongewijzigd gecommit of gepubliceerd worden.
- De worktree is niet schoon: `.serena/` (untracked) is om 16:59:46 aangemaakt door de Serena MCP-server die de sessie om 16:59:08 startte. Die map is niet aangeraakt. Daarnaast is deze audit-directory nieuw, untracked en niet gecommit.
- Er zijn geen getrackte bestanden gewijzigd.
