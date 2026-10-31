# Autotune v2 — local repair wrap handoff (sanitized)

Date: 2026-10-31  
Branch: `feat/gyroflight-autotune-engine-v2`  
Draft PR: https://github.com/sliksoft/gyroflight/pull/16  

Private audit receipts, personal paths, and real Blackbox logs are **not** in this repository.

## Reviewed software SHA

| Role | Full SHA |
|------|----------|
| Independent software review (Grok round 2, accepted) | `9a811ff63180e1082cf1889860353b0a71a993bf` |
| Prior rejected round-1 SHA | `34e57a2333815bff1e886ca3a1b2f3d8e797a3cb` |
| Sync tip before this wrap (remote at wrap start) | `7249661e829971a212f99898502b778455edecd9` |

`SOFTWARE_REVIEW_ACCEPTED=yes` applies to **code** at `9a811ff63`. Any later documentation-only commit on this branch is not a new software review target unless production code changes.

## Local repair commits since `7249661e8`

| SHA (short) | Subject |
|-------------|---------|
| `6cc66148f` | dedupe peer flights in multi-recording averages (P1) |
| `e7b5da271` | align synthetic Welch windows with channel samples (P2) |
| `ee599f5a3` | expose worker execution path and margin parity checks (P3) |
| `0683db34d` | restore honest 120s full-chain dwell for MODEL_CONDITIONAL |
| `34e57a233` | use short fixtures where 120s dwell is not required |
| `56e919125` | treat float32-equal FRFs as duplicate multi-recording support (P1b) |
| `9a811ff63` | use identity fixtures for import race and byte-dedupe paths |

## Findings closed in this wrap (software)

| ID | Verdict | Notes |
|----|---------|--------|
| P1 | **FIXED** | Peer sameFlight / identical TF; A+B+B′ extras stay single count (229 not 458) |
| P1b | **FIXED** | Float32-equal H bins refuse sub-ulp rescale copies; not a plant-similarity tolerance |
| P2 | **FIXED** | Fixture `windowSamples` ≤ chirp end−start ≤ channel length; identity helper for short paths |
| P3 | **FIXED** (gates) | No-sweep stays MEASURED; `execution` path labeled; browser numeric margin parity |
| F1 | **PARTIAL** | Evidence chain reconstructed from local receipts; original Grokbot register **not on disk** |
| F5 | **OPEN** | Scientific; longer flight alone not shown sufficient — see practical analysis outside repo |

## Final local verification (Node v24.21.0, SHA `9a811ff63`)

| Gate | Command | Result |
|------|---------|--------|
| Full repository | `npx vitest run` with AIR65 BBL env set session-only | **5942 passed / 3 skipped**, exit 0 |
| Lint + typecheck | `npm run lint` | exit 0 |
| Build | `npm run build` | exit 0 |
| Browser | `npm run test:browser` | lease **27/27**, worker **18/18** |
| Privacy + Absolute Apply | privacy + `wp6_absolute_safety` | **10/10**; `hardwareValidated=false` |
| AIR65 locals | `air65_autotune_v2` + identity + blackbox + qualification | **7 passed** |

Skips: env/local-only cases (including missing `GYROFLIGHT_AIR65_REF_DIR` golden comparisons). Not failures.

AIR65 engine outcome (Oct-18/19): all axes **MEASURED** / `NOT_VALIDATED`; PID **BLOCKED**; no releasable proposal. Coherence / dwell / band-support limits — not reinterpreted as VALIDATED.

## Safety invariants

- `hardwareValidated === false`
- Absolute Apply **BLOCKED**
- No privacy / analytics enablement
- No MSP write authorization from this wrap

## Status labels

```
SOFTWARE_REVIEW_ACCEPTED=yes   # code SHA 9a811ff63
SCIENTIFIC_QUALIFICATION_DEMONSTRATED=no
HARDWARE_VALIDATED=NO
RELEASE_READY=NO
ABSOLUTE_APPLY=BLOCKED
MERGED=NO
```

## Cloud limitations

Stock clones lack private audit folders and real AIR65 `.BBL` files; `*.local.test.ts` skip without session-only env. Golden `GYROFLIGHT_AIR65_REF_DIR` remains optional.
