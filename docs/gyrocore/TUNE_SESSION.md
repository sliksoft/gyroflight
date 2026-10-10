# Tune Session storage

A Tune Session is the local record of CHIRP results and where they came from. It holds several Flights, from one BBL
file or from several, and each Flight holds its CHIRP measurements with their Quality V2 reports. It is the storage
foundation for the later Flight A/B selector (WU4) and cross-flight comparison (WU5); it selects and compares nothing
itself.

Code: `src/gyrocore/session/` (`contract.ts`, `build.ts`, `validate.ts`, `shape.ts`, `storage.ts`). Tests:
`test/gyrocore/tune_session.test.ts` and `tune_session_adversarial.test.ts`.

## What is stored, and what never is

Stored per Flight:

- the WU1 `FlightRef` ([FLIGHT_IDENTITY.md](FLIGHT_IDENTITY.md)): the file SHA-256, the log index and the section,
  header and frame-prefix hashes;
- the file name at import, as a label only (never part of the identity);
- the firmware identity: `Firmware type`, `Firmware revision`, `Firmware date`, `Board information` and `Craft name`
  from the log header, and the API version. A field that was not logged is `null` and named in `firmware.unknown`;
  nothing is guessed;
- the log's decoded `H key:value` header lines, for the later configuration comparison (`null` when unavailable);
- the analysis provenance: decoder, analysis time and the phase-margin target;
- each CHIRP: its id, log index, axis, timing, the existing qualification outcome (state, failed and warning gates)
  and its Quality V2 report ([CHIRP_QUALITY_V2.md](CHIRP_QUALITY_V2.md)), including its `analysisVersion`.

Never stored:

- **file bytes.** A session is plain JSON. Validation rejects typed arrays, `ArrayBuffer`s and `Blob`s anywhere
  (`binary_data`), non-finite numbers, and any field the contract does not define (`unknown_field`), and it caps
  the size of a session (16 MiB of JSON), a CHIRP (1 MiB) and a `FlightRef` (16 KiB). `addFlights` checks for binary
  data before it copies anything, because a JSON copy would turn bytes into an object of numbers;
- **authorization.** A stored Quality V2 report has `levels.tuningAuthorized` replaced by `UNKNOWN` with
  `authorization_unknown:not_persisted` (and the measurement-only scope code). The session itself carries
  `authorization: { status: "NOT_STORED", reasons: ["authorization_not_persisted", "live_fc_recheck_required"] }`.
  Validation rejects a stored report that claims anything else (`stored_authorization`), and a session whose
  `authorization` block differs. A stored session can therefore never be read as tuning or Apply permission. Before
  any future Apply the physical FC configuration is read again; the product Apply lock
  (`full_safety_engine_pending`) is unaffected;
- the live analysis: building a session copies the report; the analysis in memory keeps its own levels.

Storage is local only (IndexedDB in the browser). Nothing is uploaded.

## Data contract

`TuneSession`, schema `gyrocore.tune-session`, `schemaVersion` 1:

| Field                    | Meaning                                                  |
| ------------------------ | -------------------------------------------------------- |
| `id`                     | session id (`crypto.randomUUID()` by default)            |
| `name`                   | user label, up to 256 characters                         |
| `createdAt`, `updatedAt` | ISO 8601 UTC                                             |
| `flights`                | `StoredFlight[]`, one per `FlightRef.locationId` (`key`) |
| `authorization`          | always the `NOT_STORED` block above                      |

`StoredFlight`: `key`, `ref`, `fileName`, `addedAt`, `firmware`, `logHeaders`, `analysis`, `chirps`.
`StoredChirp`: `measurementId`, `logIndex`, `segmentIndex`, `axis`, `axisName`, `axisOccurrence`, `startTimeUs`,
`endTimeUs`, `durationS`, `sampleCount`, `qualification`, `qualityV2`.

## Building a session

- `flightsFromReport(report, { fileName, analyzedAt })` turns a qualification report into one `StoredFlight` per log
  that has CHIRPs. It needs the WU1 identity attached (`attachChirpFlightIdentity`, which the Autotune import already
  runs). A log without an identity, or with a `FlightRef` that fails `flightRefProblems`, is skipped with
  `flight_identity_unknown` or `flight_identity_invalid`, never stored under a made-up identity.
- `newTuneSession`, `addFlights`, `removeFlight` edit a copy of a session.
- `addFlights` treats the same location (file and log index) as one Flight: adding it again replaces the earlier
  analysis (`replaced`). A Flight that `checkIndependentFlights` finds to be the same recording as one already in the
  session (a copy in another file, or a repackaged copy) is stored, and reported in `notIndependent`.

Several CHIRPs of one Flight are stored under that one Flight; they are never two flights.

## Flight A/B evidence

`flightPairEvidence(session, keyA, keyB)` collects what the WU4 selector will need. It decides nothing beyond
fail-closed blockers:

- `independence`: WU1 `checkIndependentFlights` on the stored references (so the same Flight twice is
  `same_flight_section`, a repackaged copy `same_flight_content`, a damaged reference `flight_X_identity_incomplete`);
- `analysisVersions`: `CURRENT`, `OUTDATED` (a known older Quality V2 version, e.g. 2.0.0) or `UNKNOWN_VERSION`, per
  Flight, and whether both Flights use one version (a missing version is never the same as another missing one);
- `firmware`: per field `MATCH`, `MISMATCH` or `UNKNOWN` (`null` on either side is `UNKNOWN`, never `MATCH`);
- `blockers`: every independence reason, `analysis_version_outdated:<a|b>`, `analysis_version_unknown:<a|b>`,
  `analysis_version_differs`, `firmware_mismatch:<field>`, `firmware_unknown:<field>` and `flight_not_in_session:<a|b>`.

A new firmware or analysis version is therefore never silently comparable. The full configuration comparison
(MATCH / MISMATCH / UNKNOWN per setting) and repeatability are WU5.

## Storage

`openTuneSessionStore({ indexedDB?, now?, newId?, migrations? })` opens database `gyroflight-gyrocore` (version 1),
object store `tuneSessions` (key path `id`):

| Call                     | Behaviour                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| `create(name, flights?)` | new session; `already_exists` if the id is taken                                                 |
| `load(id)`               | `ok` (with `rejected` parts and `migratedFrom`), `corrupt`, `unsupported_version` or `not_found` |
| `list()`                 | a summary per record, including damaged ones (`corrupt`, `unsupported_version`)                  |
| `save(session, opts?)`   | full write after validation; `not_found` for an unknown id                                       |
| `remove(id)`             | delete                                                                                           |

Every write is validated whole: an invalid session is refused (`invalid_session` with the problems) and nothing is
written. Errors are `TuneSessionStorageError` with a `code`: `unavailable` (no IndexedDB, or opening it failed, as in
some private modes), `blocked`, `quota_exceeded`, `io`, `invalid_session`, `already_exists`, `not_found`,
`damaged_record`.

## Validation and damaged data

Every record read is first checked for binary or non-JSON data, then migrated, then validated field by field.
Nothing is repaired.

- **Session-level damage** (schema, version, id, name, timestamps, `authorization`, unknown fields, binary data,
  non-finite numbers, size) makes the record `corrupt`, with the problem codes.
- **A damaged Flight** (its `FlightRef` fails `flightRefProblems`, reported as `identity:<problem>`; key not equal to
  `locationId`; bad firmware, headers, analysis block; duplicate key) is left out of the loaded session and listed in
  `rejected` by path (`flights[i]`).
- **A damaged CHIRP** (Quality V2 schema or shape, identity or Flight link wrong, stored authorization,
  qualification block, duplicate id, unknown field, size) is left out the same way (`flights[i].chirps[j]`).

The `FlightRef` and the Quality V2 report are checked against exact shapes (`shape.ts`): every object is closed,
every string is at most 1024 characters, hashes are 64 hex characters and the per-bin arrays are equally long. A
field the contract does not define, at any depth, is rejected (`identity:shape`, `quality_v2_shape`), so file bytes
cannot be stashed in a stored record as JSON numbers or text. Values in a defined numeric field cannot be told apart
from measurements; the size caps bound them.

A CHIRP's report must agree with the CHIRP and its Flight: axis, timing, ids and sample count equal the CHIRP's, its
file hash and length equal the Flight's `FlightRef`, and its `FlightRef` equals the Flight's.

Each Quality V2 analysis version has a frozen stored shape (`STORED_QUALITY_V2_SHAPES`, now only 2.1.0). A new
analysis version adds its shape and keeps the old ones, so stored results stay readable and are then reported as
`OUTDATED`. A report of a version without a stored shape cannot be checked and is rejected
(`quality_v2_version_not_storable`). Version 2.0.0 predates session storage and was never stored.

Timestamps must be real UTC instants: `2026-02-30T00:00:00Z` is rejected rather than rolled over to March.

`save` refuses to overwrite a record that is corrupt, of an unsupported version, or that loaded with rejected parts
(`damaged_record`), because that would silently drop data. `save(session, { replaceDamaged: true })` overwrites it on
request.

## Schema migrations

`schemaVersion` is an integer. `migrateTuneSession(raw, migrations, target)` runs one registered step per version
(`migrations[n]` turns version n into n + 1) and checks that each step advanced the version. A step that throws or returns no object makes the record
`corrupt` (`migration_failed:<version>`); it never breaks `load` or `list` for other records. A version above the
current one, a non-integer version, or a version without a migration path is `unsupported_version`: it is reported
and never rewritten. `TUNE_SESSION_MIGRATIONS` is empty while version 1 is the only stored shape; the mechanism is
tested with a synthetic version 0. A migrated session is written in the current shape on the next `save`.

IndexedDB's own database version (1) only creates the object store; record shapes are versioned by `schemaVersion`.

## Not in WU3

No UI, no automatic saving of imports, no A/B selector, no comparison, no new tuning, Safety or Apply logic. Nothing
in the qualification, tuning, Safety, product lock or composables reads a stored session (checked by a test).

## Real data

All tests use synthetic logs. The real AIR65 validation of Quality V2 (see CHIRP_QUALITY_V2.md) is still open and
remains a release condition before Quality V2 results may serve as automated Verified Tuning evidence.
