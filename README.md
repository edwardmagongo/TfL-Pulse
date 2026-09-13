# tfl-pulse

[![Poll](https://github.com/edwardmagongo/TFL-Pulse/actions/workflows/poll.yml/badge.svg?branch=main)](https://github.com/edwardmagongo/TFL-Pulse/actions/workflows/poll.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178C6?logo=typescript&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)
![Tests](https://img.shields.io/badge/tests-36%20passing-brightgreen)

A scheduled ingestion pipeline over TfL's (Transport for London) live public Arrivals API — turns
a noisy stream of repeated, expiring predictions into clean, deduplicated arrival records in
Postgres.

The interesting part is not the polling loop — it is that TfL's feed returns *predictions*, not
events, and sometimes hands back the same `id` for two different trains at once. There's a
deterministic, tested rule for turning that into a clean lifecycle table without silently
guessing wrong, and automated tests that pin it down against real captured API data.

## Highlights

- **An identity rule verified against real captured API data, not assumed.** Two live snapshots
  of the same station, 15 seconds apart, showed TfL's `id` field is *not* always unique within a
  single poll. The matching rule that resolves that is deterministic, documented as a best-effort
  heuristic (not a ground-truth claim), and tested against the real ambiguous case in the
  captured data. See [Prediction identity](#prediction-identity).
- **No arrival-confirmation event exists in TfL's public API**, so "resolved" is defined
  precisely — feed silence on a *successful* poll, never asserted from a failed one. See
  [Resolution semantics](#resolution-semantics).
- **A failed poll can never resolve or modify anything.** One retry, then the station's open rows
  are left completely untouched — a transient network blip can never look like a wave of trains
  arriving. See [Error handling](#error-handling).
- **46 automated tests** — unit tests for the matching/resolution logic, plus an integration test
  against a real ephemeral Postgres (Testcontainers) run against the two real captured TfL
  fixtures, no live network calls anywhere in the suite. See [Tests](#tests).
- **Runs on a real schedule, not just locally** — GitHub Actions cron every ~5 minutes, with a
  concurrency guard so overlapping runs queue instead of racing the same database. See
  [Deployment](#deployment).

## Table of Contents

- [Stack](#stack)
- [Running it](#running-it)
- [Architecture](#architecture)
- [Prediction identity](#prediction-identity)
- [Resolution semantics](#resolution-semantics)
- [Error handling](#error-handling)
- [Schema](#schema)
- [Tests](#tests)
- [Operational metrics](#operational-metrics)
- [Design decisions and limits](#design-decisions-and-limits)
- [Configuration](#configuration)
- [Deployment](#deployment)
- [License](#license)

## Stack

TypeScript · Node.js · PostgreSQL (Neon) · Jest · Testcontainers · GitHub Actions

## Running it

Requires Node.js 20+ and Docker (Testcontainers starts its own throwaway Postgres for the tests).

```bash
npm install
npm test              # 36 tests, real Postgres via Testcontainers, no live TfL calls
npm run type-check
```

To run a real poll against a live database:

```bash
export DATABASE_URL=postgres://...
psql "$DATABASE_URL" -f src/schema.sql   # apply the schema (once, against a fresh database)
npm run poll           # polls all 6 stations once, hits the live TfL API
npm run report          # prints the operational metrics below, computed from real ingested data
```

## Architecture

```
TfL Arrivals API → tfl-client.ts → normalize.ts → matcher.ts → db.ts → PostgreSQL
                    (fetch,         (validate,     (identity    (one transaction
                     1 retry)        skip bad)      diff)        per station)
```

| File | Role |
|---|---|
| [`src/tfl-client.ts`](src/tfl-client.ts) | Typed fetch wrapper, one call per station, one retry on failure |
| [`src/normalize.ts`](src/normalize.ts) | Raw TfL JSON → validated typed shape; malformed predictions logged and skipped |
| [`src/matcher.ts`](src/matcher.ts) | The identity-matching/diff algorithm — see below |
| [`src/ingest.ts`](src/ingest.ts) | Orchestrates one station's poll: fetch → diff → one DB transaction |
| [`src/db.ts`](src/db.ts) | Thin Postgres access — raw `pg`, parameterized SQL, no ORM |
| [`src/schema.sql`](src/schema.sql) | Table definitions |
| [`scripts/poll.ts`](scripts/poll.ts) | Entry point the GitHub Actions cron runs — polls all 6 stations once |
| [`scripts/report.ts`](scripts/report.ts) | Runs the real SQL queries behind [Operational metrics](#operational-metrics) |

Six curated stations, not all of London — a deliberate scope choice — polled independently every
run:

| Station | StopPoint ID | Predictions/poll (verified live) |
|---|---|---|
| King's Cross St Pancras | `940GZZLUKSX` | 63 |
| Oxford Circus | `940GZZLUOXC` | 39 |
| Liverpool Street | `940GZZLULVT` | 39 |
| Waterloo | `940GZZLUWLO` | 35 |
| Victoria | `940GZZLUVIC` | 34 |
| Stratford | `940GZZLUSTD` | 38 |

## Prediction identity

### The problem

TfL's `/StopPoint/{id}/Arrivals` endpoint returns predictions, not events. The same upcoming
train appears across many consecutive polls with a shrinking ETA, until it either falls off the
feed or a prediction that never recurs turns out to have been wrong. There's no
arrival-confirmation event anywhere in the public API — the pipeline has to define "resolved"
itself. And TfL's own `id` field, which looks like it should be a stable primary key, isn't
reliably unique within a single poll.

### Verified against real data, not assumed

Two real responses were captured from the live API
(`/StopPoint/940GZZLUKSX/Arrivals`, King's Cross St Pancras), 15 seconds apart, 73 predictions
each — committed as
[`fixtures/kings-cross-arrivals-poll-1.json`](fixtures/kings-cross-arrivals-poll-1.json) and
[`fixtures/kings-cross-arrivals-poll-2.json`](fixtures/kings-cross-arrivals-poll-2.json).

- **`id` is stable across polls in the common case** — all 67 unique ids in poll 1 reappear in
  poll 2 with the same occurrence count.
- **`id` is not guaranteed unique within a single poll.** 5 groups (11 of the 73 predictions in
  each response) share an `id` with another prediction in that same response — same `vehicleId`,
  `naptanId`, `lineId`, and `destinationNaptanId`, differing only in `expectedArrival` (8–13
  minutes apart). This happens on looping lines (the sample was the Circle line), where the same
  vehicle is predicted to pass the same stop twice within the prediction horizon.

### The rule

1. Group both the currently-open DB rows and this poll's fetched predictions, per station, by
   `tfl_prediction_id`.
2. Within a group of size > 1, sort both sides by `expectedArrival` ascending and pair them off
   positionally.
3. Any fetched prediction left unpaired becomes a new open row; any open row left unpaired is
   resolved.
4. A `tfl_prediction_id` present only in the fetched set → all inserted new. Present only in open
   rows → all resolved.

Implemented in [`src/matcher.ts`](src/matcher.ts): fully deterministic, and tested against both a
synthetic ambiguous case and the real ambiguous case in the fixtures above.

### What the rule does and doesn't prove

When TfL shares one `id` across multiple predictions, none of the available fields distinguish
which specific approach is which — positional pairing by `expectedArrival` is a reasonable,
deterministic guess, not a verified ground-truth correspondence. Concretely: if the previous poll
had `id=A` at 12:05 and 12:25, and this poll has `id=A` at 12:20 and 12:40, the rule pairs
12:05→12:20 and 12:25→12:40 — the true mapping could in principle be reversed, and the pipeline
has no way to tell from the fields TfL exposes. Full derivation in
[`docs/design.md`](docs/design.md#prediction-identity--empirically-verified-not-assumed).

## Resolution semantics

Resolved means feed silence, not a confirmed arrival — TfL's public API doesn't expose an
arrival-confirmation event. Every prediction row carries `first_seen_at`, `last_seen_at` (last
successful sighting, left untouched at resolution time so resolution stays auditable against real
evidence), `last_seen_eta`, `status`, and `resolved_at` (set only on the transition, always
strictly after `last_seen_at`).

A previously-resolved `tfl_prediction_id` reappearing later is treated as a new open row, never a
reopening of the old one.

## Error handling

- **TfL fetch failure:** one retry after a 2-second delay
  ([`src/tfl-client.ts`](src/tfl-client.ts)), then the station is recorded as a failed poll and
  every open row for that station is left completely untouched.
- **Malformed prediction shape:** validated in [`src/normalize.ts`](src/normalize.ts) — a
  prediction that doesn't parse is logged and skipped, the rest of the station's batch still
  processes.
- **Database error mid-transaction:** the station's transaction rolls back entirely and is
  recorded as a failure, no partial state — and stations never block each other, since each runs
  its own independent transaction.
- **Dropped database connection:** handled in two places, because `pg` routes the two cases
  differently and an unhandled `error` event on an `EventEmitter` takes the process down.
  A client dropped while *idle* in the pool surfaces as an `error` event on the pool
  ([`attachPoolErrorHandler`](src/db.ts)). A client dropped while *checked out* does not: pg-pool
  removes that client's own `error` listener for as long as it is held, so if the socket dies with
  no query in flight to reject — between statements of the transaction, or during `computeDiff` —
  nothing is listening. [`acquireClient`](src/db.ts) keeps a listener attached for that window and
  discards the dead client on release instead of returning it to the pool. Either way the drop is
  logged, the next query fails normally, and the station takes the ordinary failure path above.
- **Run exit status:** the run exits non-zero only when *every* station failed, which indicates
  the pipeline itself is broken. One station failing (a transient TfL 503, say) is recorded in
  `poll_runs` and printed as `[fail]`, but doesn't fail the run — the other stations committed
  normally, and the failure rate is already visible in the report.

## Schema

Two tables, defined in [`src/schema.sql`](src/schema.sql):

```sql
CREATE TABLE arrival_predictions (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tfl_prediction_id         TEXT NOT NULL,        -- TfL's `id`; not unique alone, see identity rule
  station_naptan_id         TEXT NOT NULL,
  line_id                   TEXT NOT NULL,
  vehicle_id                TEXT,
  destination_naptan_id     TEXT,
  destination_name          TEXT,
  first_seen_at             TIMESTAMPTZ NOT NULL,
  last_seen_at              TIMESTAMPTZ NOT NULL, -- last successful sighting; untouched at resolution
  last_seen_eta             TIMESTAMPTZ NOT NULL,
  last_seen_time_to_station INTEGER,
  observation_count         INTEGER NOT NULL DEFAULT 1,
  status                    TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolved_at               TIMESTAMPTZ
);
CREATE INDEX idx_predictions_open_lookup
  ON arrival_predictions (station_naptan_id, tfl_prediction_id) WHERE status = 'open';

CREATE TABLE poll_runs (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  station_naptan_id          TEXT NOT NULL,
  polled_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  outcome                    TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
  error_message              TEXT,
  predictions_seen           INTEGER,
  duplicate_id_groups        INTEGER,
  ambiguous_prediction_pairs INTEGER
);
```

`idx_predictions_open_lookup` is a partial index — the matching algorithm only ever needs a
station's open rows, and resolved rows accumulate indefinitely, so indexing only the open subset
keeps the lookup cheap as the table grows.

## Tests

46 automated tests, 0 failures:

```bash
npm test
```

- **Unit** (no network, no database): `normalize()` against valid and deliberately malformed
  fixtures; the full open → refined → resolved lifecycle over synthetic polls; a failed station
  poll leaves every open row byte-for-byte unchanged; the same poll snapshot fed twice doesn't
  grow row count; a previously-resolved id reappearing becomes a new row; the ambiguous-shared-id
  case pairs positionally, never many-to-one.
- **Integration** ([`src/ingest.spec.ts`](src/ingest.spec.ts), real ephemeral Postgres via
  Testcontainers): `ingest()` run against the two real captured TfL fixtures, asserting the
  transaction commits atomically and the real ambiguous-id case in the fixtures resolves
  correctly.
- No live TfL calls in any test — deterministic and fixture-driven.

## Operational metrics

Computed from real ingested data, not estimated:

```bash
npm run report
```

Not filled in here yet — nothing has run in production long enough to report real numbers. Once
the pipeline has run on schedule for a couple of weeks, `npm run report` prints: stations, poll
success rate, predictions ingested, mean observations per prediction lifecycle, and how often the
ambiguous-identity case actually fires (`duplicate_id_groups` / `ambiguous_prediction_pairs`,
computed by the matcher itself at diff time, not reconstructed after the fact from final table
state).

## Design decisions and limits

- Covers 6 curated stations, not all of London — a deliberate, stated scope choice.
- No alerting or dashboard — the queryable proof is real SQL queries plus a report script, not a
  UI.
- Line-status/disruption ingestion (TfL's other relevant endpoint) is not built — a natural v2,
  kept out of v1 to stay small and focused.
- No ORM — the schema is one table pair; raw `pg` with parameterized queries is simpler for this
  scope than adding Prisma or TypeORM.
- Full design spec, including the identity rule's derivation and every correctness invariant the
  test suite targets against: [`docs/design.md`](docs/design.md).

## Configuration

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Postgres connection string. Required by `npm run poll` and `npm run report`; not required for `npm test` (Testcontainers starts its own). |

## Deployment

[`.github/workflows/poll.yml`](.github/workflows/poll.yml) runs `npm run poll`, triggered every
~5 minutes by an external cron service ([cron-job.org](https://cron-job.org)) calling GitHub's
`workflow_dispatch` REST API — not GitHub Actions' own `schedule:` trigger. GitHub was observed
silently deprioritizing `schedule`-triggered runs on this repo as pushes became less frequent
(real cadence degraded from ~40 minutes to several hours between polls, despite a `*/5 * * * *`
cron expression); `workflow_dispatch` isn't subject to that throttling. A concurrency guard still
means an overlapping run queues instead of racing the same database. This is periodic, idempotent
ingestion, not real-time. The proof it's actually running is the repo's public
[Actions run history](https://github.com/edwardmagongo/TFL-Pulse/actions/workflows/poll.yml), not
a claim here.

## License

[MIT](LICENSE)
