# Protocol v4 — gezamenlijke PID+filterzoeker met motorregel over alle assen, Betaflight SITL (2026-11-11)

Vastgelegd vóór de v4-runs en vóór Calculate, in dezelfde commit als de GM-regel (`scripts/sim/e2e/protocols/`); dossierkopieën
byte-gelijk, sha256 in `provenance.json`. Alleen SITL en bestaande logs; geen flightcontroller, geen vlucht, geen push, PR #16 draft.

## Waarom een v4 (eerlijk)
Protocol v3 (dossier `autotune-v2-sitl-e2e-joint-motor-2026-11-11`) eindigde **INSUFFICIENT** bij de positieve controle: de GM was niet
beoordeelbaar, omdat de ingespoten ruis de referentiecoherentie op de fasekruising (70–77 Hz bij lichtere filters) onder de drempel 0,99
uit v1/v2 drukt. Dat is een ontwerpfout van het protocol (de drempel stamt uit de ruisloze referentietest), geen eigenschap van de
kandidaat. v4 is een **nieuw experiment, ontworpen met kennis van de v3-data** (v3 is zijn pilot): nieuwe ruisseed (2), nieuwe
start-ticks, en een GM-regel die de meetonzekerheid zelf meeneemt. Begintune, controle, zoekruimte, motorregel en doelen zijn
ongewijzigd. Het v3-oordeel blijft INSUFFICIENT en wordt niet herzien.

## GM-regel v4 (vast)
Per run: σ_GM = 20·log10(1 + ε), ε = √(1 − γ²)/(γ·√(2·n_d)) met γ² de referentiecoherentie van de plant-H1 op de fasekruising en
n_d = 1 (de sweep passeert de kruisfrequentie één keer: geen middelingskrediet; Bendat–Piersol). **Beoordeelbaar** als in elke run de
kruising in 5–85 Hz ligt en σ_GM ≤ 1,5 dB (de voorspellingstolerantie voor GM). **Gehaald** als mediaan GM − 2 × de grootste σ_GM ≥ 6 dB;
verbetering en "geen verlies" gebruiken dezelfde ondergrens voor begintune en kandidaat. De oude regel (γ² ≥ 0,99) wordt per tune ernaast
gerapporteerd. Voorbeeld: γ² 0,946 → σ 1,36 dB; 0,99 → 0,60 dB.

## Ongewijzigd t.o.v. v3
Vraag (met GM als ondergrens), opstelling (twee sweeps roll→pitch, 5300 ticks, hi-res, gyroUnfilt, ruis 2 °/s, 2× RC-HP 150 Hz),
begintune 88/55/45/60 + 71/82/84/0 met gyro 150/300 en D-LPF 60/120, positieve controle 62/44/41/54 + 50/57/67/0 met gyro ×0,8 en
D-LPF ×1,5 (ticks 430/480/530, nooit in de app), motorregel (hoogste motorratio ≤ 1,10 in hover buiten elke CHIRP; spreiding ≤ 0,15,
≥ 3072 samples, geen clipping), regressie (v2-kandidaat moet worden afgewezen), oordeelstappen en toleranties. Start-ticks begintune en
kandidaat 410/460/510.

## Bekend vooraf (uit v3)
Op de v3-data koos de app 62/39/54/72 + 50/57/67 met gyro ×0,8 / D ×1,25 (voorspeld PM 46,4°/45,6°, motor 0,79); de hermeting gaf
PM 46,6°/46,4°, |S| 5,65/5,99 dB, GM 9,9/9,0 dB bij γ² 0,97–0,99, motor ×0,78; de controle PM 53,9°/50,1°, motor ×0,93. Met een andere
seed kunnen de app-keuze en de getallen verschillen; het enige onafhankelijke element blijft de hermeting.

## Bekend vooraf: verwachte uitkomst van de verbeteringseis
Na het schrijven van dit protocol is het v4-oordeelpad als codecontrole gedraaid op een kopie van de v3-data (geen v4-run). Onder de
**ongewijzigde** verbeteringseis (elk gemist doel moet met ten minste de referentietolerantie verbeteren: |S| ≥ 1 dB) verbetert roll |S|
daar slechts +0,63 dB (6,28 → 5,65; het doel wordt wel gehaald). De plant is deterministisch en een andere seed verschuift dit nauwelijks:
de **verwachte v4-uitkomst is FAIL `remeasurement_does_not_confirm` op die stap**. Dit staat hier vooraf; de eis wordt niet aangepast,
omdat er geen protocolfout is aan te wijzen, alleen een onwelgevallige uitkomst.

## Eén commando
```
cd ~/Gyroflight-worktrees/autotune-engine-v2
scripts/sim/e2e/run_e2e_joint3.sh ~/Gyroflight-audits/autotune-v2-sitl-e2e-joint-motor-v4-2026-11-11
```
