# Flight A/B Selector (WU4)

The Flight A/B Selector opens a locally stored Tune Session (WU3) and lets the user
choose two of its Flights: Flight A (baseline) and Flight B (verification). It shows
whether the pair may be handed to a later cross-flight comparison (WU5). It selects
and checks; it compares no tuning results.

An A/B selection is **not** a Verified Tune. It does not qualify CHIRPs, show that A
and B perform the same, prove cross-flight repeatability, approve PID settings,
release Safety or allow physical Apply. The product lock `full_safety_engine_pending`
stays; the selector adds no Apply route, no MSP write and no tuning authorization.

## Where

| File                                              | Role                                                                       |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| `src/gyrocore/session/selection.ts`               | Pure decision logic: selectable Flights, selection state, A/B status       |
| `src/gyrocore/composables/useFlightAbSelector.ts` | IndexedDB sequencing: list, open, reload, select, explicit save            |
| `src/gyrocore/components/FlightAbSelector.vue`    | Presentation, in the Autotune tab (Expert Mode only)                       |
| `src/components/tabs/AutotuneTab.vue`             | Upstream file: one import and one `<FlightAbSelector />` (see UPSTREAM.md) |

## Which Flights can be chosen

`sessionFlights(loadResult)` lists every Flight of an `ok` load with: BBL file name,
Flight number (1-based log index of its file), `H Log start datetime` (verbatim, or
unknown), firmware identity, CHIRP count, measured axes and Quality V2 analysis
version(s). A Flight is **not selectable** when:

- its stored record failed WU3 validation (it is listed from `rejected`, `flight_record_rejected`);
- its FlightRef status is not `valid` (`flight_unreadable` plus the WU1 reasons);
- none of its CHIRPs survived validation (`flight_no_valid_chirps`).

A Flight whose CHIRPs were partly rejected stays selectable; the number of left-out
CHIRPs is shown. A `corrupt`, `unsupported_version` or `not_found` session has no
selectable Flights, and nothing is repaired or removed.

## Selection state

`AbSelection = { sessionId, a, b, cleared }`; `a` and `b` are FlightRef `locationId`s
of that session, never list indexes. The state is UI state only; the Tune Session
schema is unchanged.

- `selectFlight` changes only the requested side, and refuses a key that is not a
  selectable Flight of the selection's own session (state unchanged).
- Choosing the same Flight for A and B is allowed as a choice and blocked as a pair
  (`ab_same_flight_selected`, plus WU1 `same_flight_section`).
- Opening another session clears both sides (`selection_session_changed`).
- Reloading the same session keeps a side only while its Flight is still present and
  selectable; otherwise it is cleared with `selection_flight_not_in_session:<side>` or
  `selection_flight_not_selectable:<side>`.

Every list and load carries a request token. A result that arrives after a newer
request (or after the component is unmounted) is dropped, so a slow load of an earlier
session can never replace the session opened since.

## A/B Verification Status

`abVerification(session, selection)` reads WU3 `flightPairEvidence` (which uses WU1
`checkIndependentFlights`) and groups it; it adds no rule that makes a pair pass.

| Row                    | Values                                           | Source                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Flight independence    | `INDEPENDENT` / `NOT_INDEPENDENT` / `UNKNOWN`    | `independent` → INDEPENDENT; relation `same_section` / `same_flight_content` → NOT_INDEPENDENT; anything else (incomplete, contradictory or invalid identity) → UNKNOWN |
| Analysis version       | `MATCH` / `MISMATCH` / `UNKNOWN`                 | `analysisVersions.same` → MATCH; both Flights carry string versions that differ → MISMATCH; else UNKNOWN                                                                |
| Firmware compatibility | `MATCH` / `MISMATCH` / `UNKNOWN` (and per field) | `evidence.firmware`: any MISMATCH → MISMATCH, else any UNKNOWN → UNKNOWN                                                                                                |
| Missing evidence       | reason codes                                     | blockers about unknown or unprovable data (identity, analysis version, firmware unknown/inconsistent)                                                                   |
| Blocking reasons       | reason codes                                     | `evidence.blockers` (plus `ab_same_flight_selected`)                                                                                                                    |

The pair status is `INCOMPLETE` until A and B are chosen, `ELIGIBLE` only when there
is no blocker **and** independence is INDEPENDENT **and** both match rows are MATCH,
and `BLOCKED` otherwise. UNKNOWN is never turned into a pass. A missing logged API
version stays UNKNOWN (WU3: `provenance.apiVersion` is an assumed fallback, never
firmware identity). The result always carries
`authorization: { status: "NOT_AUTHORIZED", reasons: ["ab_selection_is_not_a_verified_tune", "full_safety_engine_pending"] }`
and the raw `evidence` for WU5 to re-check.

## Saving

The selector writes to the store only when the user clicks **Save analysis as new
session** or **Add analysis to open session**. Both use WU3 `flightsFromReport`,
`addFlights`, `create` and `save`: no BBL bytes, no authorization, no schema change.
Adding to a session that loaded with rejected parts is disabled, and the store itself
refuses to overwrite a damaged record. Nothing is uploaded.
