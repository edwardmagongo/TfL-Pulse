# tfl-pulse — design spec

## What it is

A scheduled ingestion pipeline that polls TfL's (Transport for London) live public Arrivals API,
turns a noisy stream of repeated predictions into clean, deduplicated arrival records, and stores
them in Postgres for querying. Chosen over a static/batch dataset because the interesting
engineering problem — idempotent, resumable ingestion of a live feed with duplicate and
disappearing data — is a common real-world pattern that a one-shot batch ETL script doesn't
exercise.

**Scope for v1: arrivals ingestion only.** TfL also exposes a Line Status endpoint
(service disruptions), which is a natural v2 extension (see Limitations) but is deliberately out
of scope here — building both at once risks turning a small, focused project into a much larger
one.

## The problem, precisely

TfL's `/StopPoint/{id}/Arrivals` endpoint returns *predictions*, not events. The same upcoming
train appears across many consecutive polls with a shrinking `timeToStation`/`expectedArrival`,
until it either falls off the feed (the vehicle presumably arrived, or TfL stopped predicting it)
or a prediction that never recurs turns out to have been wrong. There is no arrival-confirmation
event anywhere in the public API. The pipeline's job is to turn this into a clean table of
"prediction opened → refined N times → resolved (feed silence)" records, without losing or
double-counting anything, and without pretending "resolved" means "confirmed arrived."

## Prediction identity — empirically verified, not assumed

This is the hardest part of the project and is specified explicitly here rather than left as an
implementation detail, so it's specified explicitly here rather than left as an
implementation detail.

I captured two real responses from the live TfL API (`/StopPoint/940GZZLUKSX/Arrivals`, King's
Cross St Pancras), 15 seconds apart, 73 predictions each — committed as
[`fixtures/kings-cross-arrivals-poll-1.json`](../../../fixtures/kings-cross-arrivals-poll-1.json)
and [`fixtures/kings-cross-arrivals-poll-2.json`](../../../fixtures/kings-cross-arrivals-poll-2.json).
Findings:

- **TfL's `id` field is stable across polls in the common case.** 67 of 73 predictions in poll 1
  had an exact `id` match in poll 2 (the other 6 had arrived/expired/were new in the interim).
  This is empirical, not a documented TfL guarantee — the spec and code treat it as a best-effort
  signal, not a hard invariant.
- **`id` is not guaranteed unique within a single poll.** 5 of 73 predictions in one response
  shared an `id` with another prediction in that *same* response — same `vehicleId`, `naptanId`,
  `lineId`, and `destinationNaptanId` too, differing only in `expectedArrival` (about 10 minutes
  apart). This happens on looping lines (the sample was the Circle line) where the same vehicle
  is predicted to pass the same stop twice within the prediction horizon.

**Identity rule:**

1. Group both the currently-open DB rows and this poll's fetched predictions, per station, by
   `(tfl_prediction_id)`.
2. Within a group of size > 1 (the ambiguous case), sort both the open rows and the fetched
   predictions by `expectedArrival` ascending and pair them off positionally (soonest open row
   matches soonest fetched prediction, and so on).
3. Any fetched prediction left unpaired after that (group grew) becomes a new open row.
4. Any open DB row left unpaired (group shrank) is resolved.
5. A `tfl_prediction_id` present only in the fetched set (no open rows at all) → all inserted as
   new. Present only in open rows (nothing fetched this poll with that id) → all resolved.

This is fully deterministic and testable against the two real captured fixtures, which already
contain a real instance of the ambiguous case.

## Resolution semantics

**Resolved means feed silence, not a confirmed arrival.** TfL's public API does not expose an
"arrived" event. A prediction is resolved when a *successful* poll for its station no longer
returns it.

Every prediction row carries:

- `first_seen_at` — first poll where this prediction was observed.
- `last_seen_at` — most recent poll where it was observed. **Not updated at resolution time** —
  it reflects the last successful sighting, so resolution is auditable against real evidence
  rather than asserted.
- `last_seen_eta` — the `expectedArrival` value as of `last_seen_at`, same reasoning.
- `last_seen_time_to_station` — the `timeToStation` as of `last_seen_at` (minor extra audit
  trail, cheap to keep).
- `status` — `open` or `resolved`.
- `resolved_at` — set only when a row transitions to resolved; the timestamp of the poll that
  noticed the absence (necessarily after `last_seen_at`, never the same poll).

**A failed poll must never resolve anything.** Resolution only happens by diffing against a
*successful* fetch for that station. If a station's TfL call fails, its open predictions are left
completely untouched — not resolved, not updated — otherwise a transient network failure would
look identical to a wave of trains arriving. This is the reason error handling and resolution
logic can't be designed independently of each other.

## Architecture

```
tfl-pulse/
  src/
    tfl-client.ts     # typed fetch wrapper around TfL's Arrivals endpoint, one call per station
    normalize.ts      # raw TfL JSON -> validated typed shape; malformed fields logged + skipped
    ingest.ts         # the matching/resolution algorithm above, per-station transactional
    db.ts             # thin Postgres access: raw `pg`, parameterized SQL, no ORM
    schema.sql         # table definition + migration
  scripts/
    report.ts          # runs real SQL queries, prints output
  fixtures/
    kings-cross-arrivals-poll-1.json   # real captured API response
    kings-cross-arrivals-poll-2.json   # real captured API response, 15s later
  .github/workflows/poll.yml           # cron trigger
```

- **Stack:** TypeScript/Node, a natural fit for a small, scheduled, I/O-bound service; no need
  to introduce a new language for this scope.
- **Storage:** Postgres, free-tier hosted (Neon). No ORM — the schema is one table, raw `pg` with
  parameterized queries is simpler and more honest than adding Prisma/TypeORM for this scope.
- **Scheduling:** GitHub Actions cron, polling a small curated set of 6 stations (not all of
  London — a deliberate, documented scope choice) every ~5 minutes: King's Cross St Pancras,
  Oxford Circus, Liverpool Street, Waterloo, Victoria, and Stratford — chosen for a mix of lines
  and genuinely high prediction volume (King's Cross alone returned 73 predictions per poll in
  testing), so the dedup/resolution logic gets real exercise. Configurable via a station-ID list
  in `src/tfl-client.ts`, not hardcoded assumptions scattered through the codebase. GitHub Actions
  cron isn't
  sub-minute-precise, so this is *periodic, idempotent ingestion*, not real-time — a completely
  normal real-world pattern, most operational pipelines are scheduled rather than literally
  streaming. The proof that it actually runs is the repo's public Actions run history, not a
  claim in the README.
- **Query/consumption:** a handful of real SQL queries against the ingested data (e.g.
  "longest-open predictions today," "prediction volume by hour"), run and printed by
  `scripts/report.ts` — a small standalone script, not a dashboard or UI.

## Schema

Two tables, defined in `src/schema.sql`:

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
  last_seen_eta             TIMESTAMPTZ NOT NULL, -- expectedArrival as of last_seen_at
  last_seen_time_to_station INTEGER,              -- seconds, as of last_seen_at
  status                    TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolved_at               TIMESTAMPTZ           -- set only on transition to resolved
);
CREATE INDEX idx_predictions_open_lookup
  ON arrival_predictions (station_naptan_id, tfl_prediction_id) WHERE status = 'open';

CREATE TABLE poll_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  station_naptan_id TEXT NOT NULL,
  polled_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  outcome       TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
  error_message TEXT,                             -- populated only when outcome = 'failure'
  predictions_seen INTEGER                         -- populated only when outcome = 'success'
);
```

`idx_predictions_open_lookup` is a partial index — the matching algorithm only ever needs to load
*open* rows for a station, and resolved rows accumulate indefinitely, so indexing only the open
subset keeps the lookup cheap as the table grows.

## Data flow, per poll run

For each curated station, independently:

1. Fetch arrivals for the station from TfL, with one retry (backoff) on transient failure.
2. **If the fetch fails after retry:** record a failure entry for this station in a
   `poll_runs` log table (timestamp, station, error) and move to the next station. Nothing in
   the DB for this station is touched.
3. **If the fetch succeeds:** validate/normalize the response (`normalize.ts` — malformed
   individual predictions are logged and skipped, not fatal to the whole station). Load this
   station's currently-open rows from the DB. Run the identity-matching algorithm above to produce
   a diff (inserts / updates / resolutions).
4. Apply that station's entire diff inside **one database transaction** — insert, update, and
   resolve statements all commit together, or none do. Record success in `poll_runs`.

**Atomicity boundary, explicitly:** stations are independent of each other — station B failing
(fetch or DB error) never blocks or rolls back station A's already-committed work. Within one
station, the insert/update/resolve set is all-or-nothing, so a mid-write DB error can never leave
that station's predictions in a half-applied state (e.g. some rows resolved but their replacements
not yet inserted).

## Error handling

- **TfL fetch failure:** one retry after a 2-second delay, then treated as a failed poll for that
  station only (see above — never resolves anything). Deliberately not a bounded/jittered
  multi-attempt retry loop — a station that's still failing after one retry is far more
  likely a real TfL outage than transient contention, and the next scheduled poll in ~5 minutes is
  a better recovery mechanism than hammering TfL harder in the same run.
- **Malformed prediction shape:** validated with a schema check in `normalize.ts`; a prediction
  that doesn't parse is logged and skipped, the rest of the station's predictions still process
  normally. TfL has been observed to occasionally change field shapes; this keeps one bad field
  from taking down an entire poll.
- **Database error mid-transaction:** the station's transaction rolls back entirely, logged as a
  failure in `poll_runs`, no partial state. This fails loud rather than fail-open — that was a security-availability tradeoff; this is data correctness, where
  silently dropping a write is worse than a visibly failed run that retries next poll.

## Testing

- **Unit tests, no network:**
  - `normalize()` against valid and deliberately malformed fixture predictions.
  - The identity-matching/resolution algorithm, driven by synthetic sequences of poll snapshots
    (new → refined → resolved; the ambiguous-shared-`id` case; a station whose poll fails
    entirely, asserting nothing resolves).
- **Integration test:** `ingest()` against a real ephemeral Postgres via Testcontainers — run against the two real captured TfL fixtures (not
  synthetic data) so the ambiguous-id disambiguation is verified against an actual instance of the
  problem, not a hypothetical one.
- No live TfL calls in any test. Deterministic, fixture-driven.

## Honest limitations (for the README)

- "Resolved" is inferred from feed silence, not a confirmed vehicle-arrived event — TfL's public
  API doesn't expose one.
- GitHub Actions cron scheduling isn't sub-minute-precise; effective polling interval is "every
  ~5 minutes," described as such, not framed as real-time.
- Covers a small curated set of stations, not all of London — deliberate, stated scope, not a
  hidden limitation.
- No alerting or dashboard. The "queryable" proof is real SQL queries plus a report script, not a
  UI.
- Line-status/disruption ingestion (TfL's other relevant endpoint) is not built — noted as a
  natural v2, not attempted here to keep v1 small and focused.
