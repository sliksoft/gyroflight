# File and Flight identity

This is the identity a Tune Session uses to name a blackbox file and the Flights in it. Code: `src/gyrocore/flight/`. Tests: `test/gyrocore/flight_identity.test.ts`.

## What is a Flight

A Flight is one log section of a BBL file, exactly as the Blackbox Viewer splits it. `FlightLogIndex` finds the sections at each `H Product:Blackbox flight data recorder by Nicholas Sherlock` start marker. A section runs from its marker to the next marker, or to the end of the file. Betaflight starts a new section each time it starts logging, so one file can hold several Flights:

```
session.bbl
  Flight 1 (logIndex 0)  → Flight A
  Flight 2 (logIndex 1)  → an ordinary flight
  Flight 3 (logIndex 2)  → Flight B
```

The Viewer is the only decoder. This module hashes bytes at the Viewer's offsets and asks the Viewer (`FlightLog.getLogError`, `getMinTime`, `getMaxTime`) whether each section opens. It decodes no frames itself.

Several CHIRPs inside one Flight are measurements of that one Flight. They carry its `logIndex` (`ChirpMeasurement.logIndex`), so `flightForLog()` gives them the same `FlightRef`.

## Identity

`catalogBbl(bytes)` returns a `BblCatalog` with the file's SHA-256, its length and one `FlightRef` per section.

| Field               | Meaning                                                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `file.sha256`       | SHA-256 of the whole file. The file name is not part of the identity.                                                                           |
| `locationId`        | `<file sha256>#<logIndex>`. Where the Flight was read. Two copies of one flight have different location ids.                                    |
| `section`           | SHA-256 and byte range of the section. **Equal section hash means the same recorded flight**, even across two files or two positions in a file. |
| `header`            | SHA-256 of the contiguous `H` lines, plus selected lines kept verbatim. An absent line is `null`, never a default.                              |
| `bodyPrefix`        | SHA-256 of the first 4096 bytes of frame data after the header (fewer if the section is shorter).                                               |
| `status`, `reasons` | FLIGHT VALID: `valid` when the Viewer opens the section, otherwise `invalid` with `log_unreadable:<Viewer error>`.                              |
| `timeRangeUs`       | The Viewer's first and last frame time, or `null`.                                                                                              |

The header lines kept are `Firmware type`, `Firmware revision`, `Firmware date`, `Board information`, `Craft name` and `Log start datetime`. They are metadata for the user and for the later configuration comparison (MATCH / MISMATCH / UNKNOWN). They are not used to decide whether two Flights are the same.

SHA-256 comes from Web Crypto (`crypto.subtle`). Without it, `sha256Hex` throws `Sha256UnavailableError`. There is no fallback hash.

The result is plain JSON without file bytes. A Tune Session can store it and still recognise the file and its Flights after the BBL is gone. With the BBL present again, `catalogBbl` on the same bytes gives the same result, which is how stored results are re-verified against their source.

## Validity levels

| Level        | Rule                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------- |
| BBL VALID    | at least one log section (`no_log_sections` otherwise). An empty or foreign file is invalid; it is not an exception. |
| FLIGHT VALID | the Viewer opens the section.                                                                                        |

CHIRP content never affects these levels. A Flight with no CHIRP, with the wrong debug mode or with a rejected CHIRP is still a valid Flight, and an unreadable Flight leaves the file and the other Flights valid. BLACKBOX DATA USABLE, CHIRP DETECTED, CHIRP QUALIFIED and TUNING AUTHORIZED come from the CHIRP qualification (`src/gyrocore/chirp/`) and later work units.

## Flight A and Flight B

`checkIndependentFlights(a, b)` decides whether two Flights may count as two independent recordings. It is fail-closed. It returns `independent: false` with reasons when:

| Reason                                                          | When                                                                                         |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `flight_a_identity_incomplete` / `flight_b_identity_incomplete` | a reference is missing, has another schema, or lacks a lowercase hex SHA-256 hash            |
| `flight_a_invalid` / `flight_b_invalid`                         | the Flight is not FLIGHT VALID (status `valid` with no reasons)                              |
| `same_flight_section`                                           | the section hashes are equal (the same Flight chosen twice, or the same flight in two files) |
| `same_flight_content`                                           | the header and the first frame data are equal, but the sections differ                       |

`same_flight_content` catches a copy of a flight with extra or missing bytes at its end, for example one copy cut short. The first frame data holds the first I-frame (time since boot, loop iteration, sensor values), which no other recording repeats. Two different flights with identical headers, which is normal for two flights on one configuration, stay `distinct`.

Known limit: a copy that is cut short inside its first 4096 bytes of frame data is not matched. Such a section holds well under a second of data and cannot carry a CHIRP measurement.

Independence says only that the two Flights are different recordings. Whether they are comparable (same physical system and configuration) is the cross-flight work, not this check.

## Tests

`flight_identity.test.ts` uses only synthetic data. Its multi-flight files are the committed, sha-pinned single-log fixtures concatenated in memory. It proves:

- each section's hash equals the published hash of the fixture it came from (`cases.json`);
- the sections tile the file;
- the Viewer decodes each Flight of a multi-flight file exactly as the standalone file;
- the CHIRP qualification gives the same measurements per Flight;
- every independence case above.

`flight_identity_adversarial.test.ts` was written against this document without reading the implementation. It checks every catalog against the Viewer's offsets and `node:crypto`, and covers boundary cases: junk before the first marker, a marker inside frame data, CRLF headers, header-only and short sections, Latin-1 header bytes, and malformed stored references. It found three gaps in the independence check, all fixed: non-hex hashes, upper-cased hashes, and a `valid` reference that carries reasons.

`flight_identity_air65.local.test.ts` runs on the real AIR65 file when `GYROFLIGHT_AIR65_BBL` is set. It checks the file hash, the three Flights and their pairwise independence.
