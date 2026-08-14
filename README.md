# tfl-pulse

A scheduled ingestion pipeline over TfL's (Transport for London) live public Arrivals API — turns
a noisy stream of repeated, expiring predictions into clean, deduplicated arrival records in
Postgres.

36 automated tests, 0 failures — unit tests for the matching/resolution logic, integration tests
against a real ephemeral Postgres (Testcontainers) and two real captured TfL API responses, no
live network calls in the test suite.

## The problem

TfL's `/StopPoint/{id}/Arrivals` endpoint returns *predictions*, not events — the same upcoming
train appears across many consecutive polls with a shrinking ETA, until it either falls off the
feed or a wrong prediction never recurs. There's no arrival-confirmation event anywhere in the
public API. This pipeline turns that into a clean table of "prediction opened → refined N times →
resolved (feed silence)" records — see
[`docs/design.md`](docs/design.md)
for the full design, including the empirically-verified identity-matching rule and its explicitly
acknowledged limits (it's a best-effort heuristic, not a claim of ground-truth vehicle identity —
see the spec's "Prediction identity" section for a real counterexample pulled from live API data).

## Running it

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
npm run report         # prints the operational metrics below, computed from real ingested data
```

In production this runs on a GitHub Actions cron
([`.github/workflows/poll.yml`](.github/workflows/poll.yml)) every ~5 minutes — GitHub Actions
cron isn't sub-minute-precise, so this is periodic, idempotent ingestion, not real-time. The proof
it's actually running is the repo's public Actions history, not a claim here.

## Operational metrics

Not filled in yet — nothing has run in production long enough to report real numbers, and this
project doesn't put estimated ones here. Once the pipeline has run on schedule for a couple of
weeks, `npm run report` produces the real figures (stations, poll success rate, predictions
ingested, mean observations per prediction lifecycle, and how often the ambiguous-identity case
actually fires) to go here.

## Honest limitations

- "Resolved" is inferred from feed silence, not a confirmed vehicle-arrived event — TfL's public
  API doesn't expose one.
- Covers 6 curated stations, not all of London — a deliberate, stated scope choice.
- No alerting or dashboard — the "queryable" proof is real SQL queries plus a report script, not a
  UI.
- The identity-matching rule for a `tfl_prediction_id` shared by more than one prediction in the
  same poll is a documented best-effort heuristic (positional pairing by expected arrival time),
  not a verified ground-truth correspondence — see the design spec for why this can't be resolved
  from the fields TfL exposes.
- Line-status/disruption ingestion (TfL's other relevant endpoint) is not built — a natural v2,
  not attempted here to keep v1 small and focused.

## License

[MIT](LICENSE)
