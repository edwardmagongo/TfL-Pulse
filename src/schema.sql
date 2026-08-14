CREATE TABLE arrival_predictions (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tfl_prediction_id         TEXT NOT NULL,
  station_naptan_id         TEXT NOT NULL,
  line_id                   TEXT NOT NULL,
  vehicle_id                TEXT,
  destination_naptan_id     TEXT,
  destination_name          TEXT,
  first_seen_at             TIMESTAMPTZ NOT NULL,
  last_seen_at              TIMESTAMPTZ NOT NULL,
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
