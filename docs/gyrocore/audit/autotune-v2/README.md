# Autotune v2: auditrapporten en bewijs

Overzicht van wat in deze map in Git staat en wat bewust lokaal blijft. De repository `origin` is publiek. Daarom staan
ruwe Codex-sessielogs, prompts, exit-bestanden en testlogs met lokale paden niet in Git. Niets hiervan is verwijderd of
overschreven: het origineel blijft lokaal staan, en van elk origineel met een lokaal pad staat hieronder de SHA-256.

## Gepubliceerde rapporten

| Rapport | Inhoud |
|---|---|
| `2026-10-23-autotune-v2-p0-safety-repair.md` | P0-veiligheidsreparatie |
| `2026-10-24-autotune-v2-overnight-completion.md` | stand van de engine na de nachtelijke afronding |
| `2026-10-24-wp8-final-acceptance.md` | WP8 eindacceptatie (eerste ronde) |
| `2026-10-25-wp8-final-repair-acceptance.md` | WP8 F01–F10-reparatie |
| `redacted/2026-10-23-autotune-v2-recovery-validation-audit.md` | herstel- en validatieaudit |
| `redacted/2026-10-24-wp8-independent-codex-final-review.md` | onafhankelijke Codex-eindreview |
| `redacted/2026-10-24-wp8-p0-closure.md` | WP8 P0-afsluiting |
| `redacted/2026-10-25-wp8-transport-closure.md` | WP8 transportafsluiting, laatste P2 (softwarebaseline `6aee384e`) |
| `2026-10-25-wp8-software-baseline.md` | definitieve WP8-softwarebaseline |
| `2026-10-25-v2-complete-consolidation.md` | consolidatie, hardwaregereedheid, gap analysis en stand van Autotune v2 |

Een `redacted/`-kopie verschilt van het origineel alleen doordat `/home/<gebruiker>` is vervangen door `<home>` en
`/mnt/c/Users/<gebruiker>` door `<windows-home>`.

| Origineel (lokaal, niet in Git) | SHA-256 |
|---|---|
| `2026-10-23-autotune-v2-recovery-validation-audit.md` | `2b852844f93522387d290191d2e796110e9450bf53241e4fcfd0b53ecccd0ba8` |
| `2026-10-24-wp8-independent-codex-final-review.md` | `c3f7083b2dd6a697c323e95518b14b31e301ea7854456a9ec158c6aae26fee94` |
| `2026-10-24-wp8-p0-closure.md` | `ed61b8bfba513359f6365cdc962c0b79c0d08bf3661102828a1f6ec2a635b6bd` |
| `2026-10-25-wp8-transport-closure.md` | `6b08f9b843793b3e8205aec9c6a770f79ae4bb476f3afa5d475250ccff85532e` |

## Gepubliceerd bewijs

| Pad | Inhoud |
|---|---|
| `codex-final-evidence-220928/*-review.md` | Codex-reviewteksten, eindacceptatie WP8 (HEAD `20242d2c`) |
| `codex-repair-evidence-wp8/*-review.md` | Codex-reviewteksten, F01–F10-reparatie |
| `codex-repair-evidence-wp8/firmware/` | Betaflight-firmwarebronreview met SHA-256 van de opgehaalde bronnen |
| `codex-repair-evidence-wp8/mutations/` | mutatieresultaten F01–F10 |
| `transport-closure-evidence/codex/*-review.md` | de negen Codex-reviews van de transportafsluiting |
| `transport-closure-evidence/webserial-spec-close.md` | WICG Web Serial-specificatie-uittreksel met SHA-256 |
| `transport-closure-evidence/mutations/` | mutatieresultaten transportafsluiting |
| `transport-closure-evidence/before-fix/isolated-*.txt`, `round*.txt` | welke nieuwe tests falen op de commit vóór de reparatie |
| `consolidation-evidence/mutations.json` | mutatieresultaten consolidatie |
| `consolidation-evidence/codex/` | severity-regel, prompts en reviewteksten van de consolidatie (`redacted/R3-procedure-review.md`: origineel met lokale paden blijft lokaal, SHA-256 `6de07c8f2b858504768300b462a7fea378dd69a8ca0ef41639b4fafd7480fdc2`) |

## Lokaal, niet in Git

- `2026-10-23-codex-review-raw.md`, `2026-10-23-p0-codex-review-round{1,2,3}-raw.md`,
  `2026-10-24-wp8-final-codex-review1-raw.md`, `2026-10-24-wp8-p0-closure-codex-review-raw.md`: ruwe Codex-uitvoer
  met absolute lokale paden.
- Alle `*-session.log`, `*-exit.json` en `manifest.json`, en de `*-prompt.txt` van vóór de consolidatie: ruwe sessielogs en prompts.
- Test-, lint-, build- en browserlogs onder `*/final/`, `*/browser/`, `*/before-fix/*.log`, `baseline-*.log` en
  `browser-before-*.log`: bevatten lokale paden of zijn reproduceerbaar met de commando's in de rapporten.
- `transport-closure-evidence/before-fix/{isolated.sh,mutants.py,runmut.py}`: lokale hulpscripts.
